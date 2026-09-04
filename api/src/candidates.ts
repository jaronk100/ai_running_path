import { createHash } from "node:crypto";
import { config } from "./config.js";
import { enrichPath, type EnrichedPath } from "./enrich.js";
import { MI_TO_M, destinationPoint, geometryOverlap } from "./geo.js";
import * as gh from "./graphhopper.js";
import { geocode } from "./geocode.js";
import { pMap } from "./pmap.js";
import { isDisqualified, scoreRoute } from "./scoring.js";
import type { LatLng, RouteCandidate, SearchRequest } from "./types.js";

const GH_CONCURRENCY = 6;

/**
 * round_trip only promises an "approximative" length, and in practice it
 * regularly lands several percent off. Asking for the target plus a low and a
 * high nudge widens the net so enough candidates survive the strict +/- 0.1 mi
 * gate. Cheap insurance: three requests where one would under-deliver.
 */
const DISTANCE_NUDGES = [1.0, 0.93, 1.07];

export interface SearchResult {
  home: LatLng;
  matchedAddress: string;
  candidates: RouteCandidate[];
  totalFound: number;
  /** True when Overpass answered for every route, so sidewalk figures are firm. */
  sidewalkDataComplete: boolean;
}

export async function findRoutes(req: SearchRequest): Promise<SearchResult> {
  const geo = await geocode(req.address);
  if (!geo) throw new Error(`Could not geocode address: ${req.address}`);

  const candidates =
    req.pathType === "loop"
      ? await findLoops(geo.point, req)
      : await findOutAndBacks(geo.point, req);

  const deduped = dedupe(candidates);
  deduped.sort((a, b) => b.score - a.score);

  const page = Math.max(1, req.page ?? 1);
  const size = config.search.resultsPerPage;

  return {
    home: geo.point,
    matchedAddress: geo.matchedAddress,
    candidates: deduped.slice((page - 1) * size, page * size),
    totalFound: deduped.length,
    sidewalkDataComplete: deduped.every((c) => c.sidewalkDataAvailable),
  };
}

// ---------------------------------------------------------------- loops

interface StartPoint {
  point: LatLng;
  approachMi: number;
  approachCoordinates: [number, number][];
}

async function findLoops(
  home: LatLng,
  req: SearchRequest,
): Promise<RouteCandidate[]> {
  const maxApproachMi = Math.min(
    req.maxApproachMi ?? 0.5,
    config.search.maxApproachCapMi,
  );
  const starts = await buildStartPoints(home, maxApproachMi);

  // Closest starts first, so trimming to the job budget below discards the
  // furthest ones — the same candidates the approach term would have ranked
  // last. Cheaper and better-aligned than sampling uniformly and truncating.
  starts.sort((a, b) => a.approachMi - b.approachMi);

  const jobs: { start: StartPoint; seed: number; nudge: number }[] = [];
  for (const start of starts) {
    for (let seed = 0; seed < config.search.seedsPerStart; seed++) {
      for (const nudge of DISTANCE_NUDGES) {
        jobs.push({ start, seed, nudge });
      }
    }
  }
  const budgeted = jobs.slice(0, config.search.maxRoundTripJobs);

  const paths = await pMap(budgeted, GH_CONCURRENCY, async (job) => {
    const path = await gh.roundTrip(
      job.start.point,
      req.distanceMi * job.nudge * MI_TO_M,
      job.seed,
    );
    return path ? { job, path } : null;
  });

  const out: RouteCandidate[] = [];
  for (const r of paths) {
    if (!r) continue;
    if (!withinTolerance(r.path.distance, req.distanceMi)) continue;

    const enriched = await enrichPath(r.path);
    if (isDisqualified(enriched)) continue;

    out.push(
      toCandidate(
        enriched,
        "loop",
        r.job.start.approachMi,
        r.job.start.approachCoordinates,
      ),
    );
  }
  return out;
}

/**
 * Loop start points: the door itself, plus a ring of sampled bearings. Each
 * sample is routed from home so approachMi is real walking distance on a
 * compliant path, not crow-flies. A creek or a freeway between the two makes
 * those numbers wildly different, and the ranking leans on this value hardest.
 */
async function buildStartPoints(
  home: LatLng,
  maxApproachMi: number,
): Promise<StartPoint[]> {
  const starts: StartPoint[] = [
    { point: home, approachMi: 0, approachCoordinates: [] },
  ];
  if (maxApproachMi <= 0) return starts;

  const samples: LatLng[] = [];
  const bearings = config.search.approachSamples;
  // Rings are biased toward home rather than spread evenly. Scoring punishes
  // approach distance steeply, so an even spread would spend most of its
  // samples on starts that can never win — at a 5 mi cap, even spacing would
  // leave nothing at all between the door and 2.75 mi out.
  for (const ratio of [0.25, 0.5, 0.8]) {
    for (let i = 0; i < bearings; i++) {
      samples.push(
        destinationPoint(
          home,
          (360 / bearings) * i,
          maxApproachMi * ratio * MI_TO_M,
        ),
      );
    }
  }

  const legs = await pMap(samples, GH_CONCURRENCY, (s) => gh.route([home, s]));

  const seen = new Set<string>();
  for (const leg of legs) {
    if (!leg) continue;
    const approachMi = leg.distance / MI_TO_M;
    if (approachMi > maxApproachMi) continue;

    const coords = leg.points.coordinates.map(
      ([lon, lat]) => [lon, lat] as [number, number],
    );
    const end = coords.at(-1);
    if (!end) continue;

    // Several bearings often snap to the same corner; keep one.
    const key = `${end[1].toFixed(4)}:${end[0].toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    starts.push({
      point: { lon: end[0], lat: end[1] },
      approachMi,
      approachCoordinates: coords,
    });
  }
  return starts;
}

// -------------------------------------------------------- out and back

/**
 * Out-and-back starts at the door, so there is no approach leg and every
 * candidate scores identically on the approach term. Ranking falls entirely to
 * sidewalks, safety and quality. The requested distance is the full there-and-
 * back, so each leg targets half of it.
 */
async function findOutAndBacks(
  home: LatLng,
  req: SearchRequest,
): Promise<RouteCandidate[]> {
  const legTargetMi = req.distanceMi / 2;
  const bearings = config.search.approachSamples * 2;

  // Crow-flies under-shoots real walking distance; 0.72 is a reasonable street-
  // grid detour factor for turnaround sampling.
  const turnarounds = Array.from({ length: bearings }, (_, i) =>
    destinationPoint(home, (360 / bearings) * i, legTargetMi * 0.72 * MI_TO_M),
  );

  const legSets = await pMap(turnarounds, GH_CONCURRENCY, (t) =>
    gh.alternatives(home, t, 3),
  );

  const out: RouteCandidate[] = [];
  for (const legs of legSets) {
    for (const leg of legs) {
      const totalM = leg.distance * 2;
      if (!withinTolerance(totalM, req.distanceMi)) continue;

      const enriched = await enrichPath(leg);
      if (isDisqualified(enriched)) continue;

      // Metrics are length-weighted fractions, so retracing the same leg leaves
      // every ratio unchanged; only the absolute distances double.
      const climb =
        enriched.metrics.elevationGainFt + enriched.metrics.elevationLossFt;
      const doubled: EnrichedPath = {
        ...enriched,
        distanceMi: enriched.distanceMi * 2,
        metrics: {
          ...enriched.metrics,
          distanceMi: enriched.metrics.distanceMi * 2,
          // Out and back reverses the profile: every climb is also a descent.
          elevationGainFt: climb,
          elevationLossFt: climb,
          crossingsOfMajorRoads: enriched.metrics.crossingsOfMajorRoads * 2,
        },
      };

      out.push(toCandidate(doubled, "out_and_back", 0, []));
    }
  }
  return out;
}

// ------------------------------------------------------------- helpers

function withinTolerance(actualMeters: number, targetMi: number): boolean {
  const actualMi = actualMeters / MI_TO_M;
  return Math.abs(actualMi - targetMi) <= config.search.distanceToleranceMi;
}

function toCandidate(
  enriched: EnrichedPath,
  pathType: RouteCandidate["pathType"],
  approachMi: number,
  approachCoordinates: [number, number][],
): RouteCandidate {
  const { score, breakdown } = scoreRoute(enriched, approachMi);
  return {
    id: routeId(enriched.coordinates),
    pathType,
    coordinates: enriched.coordinates,
    approachCoordinates,
    approachDistanceMi: Number(approachMi.toFixed(3)),
    loopDistanceMi: Number(enriched.distanceMi.toFixed(3)),
    metrics: enriched.metrics,
    score,
    scoreBreakdown: breakdown,
    sidewalkDataAvailable: enriched.sidewalkDataAvailable,
  };
}

function routeId(coords: [number, number][]): string {
  const h = createHash("sha1");
  for (const [lon, lat] of coords) {
    h.update(`${lon.toFixed(5)},${lat.toFixed(5)};`);
  }
  return h.digest("hex").slice(0, 16);
}

/**
 * Drop near-duplicates so five results are five genuinely different runs.
 * Highest-scoring candidate wins any collision.
 */
function dedupe(candidates: RouteCandidate[]): RouteCandidate[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const kept: RouteCandidate[] = [];

  for (const c of sorted) {
    const isDupe = kept.some(
      (k) =>
        geometryOverlap(c.coordinates, k.coordinates) >
        config.search.maxGeometryOverlap,
    );
    if (!isDupe) kept.push(c);
  }
  return kept;
}
