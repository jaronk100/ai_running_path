import { createHash } from "node:crypto";
import { config } from "./config.js";
import { enrichPath, type EnrichedPath } from "./enrich.js";
import { MI_TO_M, destinationPoint, geometryOverlap, haversineMeters } from "./geo.js";
import * as gh from "./graphhopper.js";
import { loopForSeed, startNearest } from "./loops.js";
import { geocode } from "./geocode.js";
import { pMap } from "./pmap.js";
import { gateFailure, scoreRoute } from "./scoring.js";
import type { GHPath, LatLng, RouteCandidate, SearchRequest } from "./types.js";

const GH_CONCURRENCY = 6;

/** A loop starting this close to the address starts at the door. */
const AT_THE_DOOR_M = 20;

export interface SearchResult {
  home: LatLng;
  matchedAddress: string;
  candidates: RouteCandidate[];
  totalFound: number;
  /**
   * Right-length routes dropped by a hard rule, by reason. Lets the UI say why
   * a search came back thin instead of leaving the user to guess.
   */
  rejected: Record<string, number>;
}

export async function findRoutes(req: SearchRequest): Promise<SearchResult> {
  const geo = await geocode(req.address);
  if (!geo) throw new Error(`Could not geocode address: ${req.address}`);

  const rejected: Record<string, number> = {};
  const reject = (reason: string) => {
    rejected[reason] = (rejected[reason] ?? 0) + 1;
  };

  const candidates =
    req.pathType === "loop"
      ? await findLoops(geo.point, req, reject)
      : await findOutAndBacks(geo.point, req, reject);

  const deduped = dedupe(candidates);
  deduped.sort((a, b) => b.score - a.score);

  const page = Math.max(1, req.page ?? 1);
  const size = config.search.resultsPerPage;

  return {
    home: geo.point,
    matchedAddress: geo.matchedAddress,
    candidates: deduped.slice((page - 1) * size, page * size),
    totalFound: deduped.length,
    rejected,
  };
}

// ---------------------------------------------------------------- loops

async function findLoops(
  home: LatLng,
  req: SearchRequest,
  reject: (reason: string) => void,
): Promise<RouteCandidate[]> {
  const maxApproachMi = Math.min(
    req.maxApproachMi ?? 0.5,
    config.search.maxApproachCapMi,
  );
  const seeds = await seedPoints(home, maxApproachMi);

  const jobs: { point: LatLng; seed: number }[] = [];
  for (const point of seeds) {
    for (let seed = 0; seed < config.search.seedsPerStart; seed++) {
      jobs.push({ point, seed });
    }
  }
  const budgeted = jobs.slice(0, config.search.maxLoopSeeds);

  const found = await pMap(budgeted, GH_CONCURRENCY, (job) =>
    loopForSeed(job.point, req.distanceMi, job.seed, (loop) => {
      const enriched = enrichPath(loop);
      const failure = gateFailure(enriched, "loop");
      if (failure) {
        reject(failure);
        return null;
      }
      return enriched;
    }),
  );

  // The walk to each loop's start is routed fresh from the address. Where the
  // loop came from round_trip at the door, this is its stem; elsewhere it is
  // the shortest compliant way there.
  const withApproach = await pMap(found, GH_CONCURRENCY, async (found) => {
    if (!found) return null;
    const f = restartNearHome(found, home);
    const gapM = haversineMeters(home, f.junction);
    if (gapM <= AT_THE_DOOR_M) return { f, approachMi: 0, approach: [] as [number, number][] };

    const leg = await gh.route([home, f.junction]);
    if (!leg) return null;
    const approachMi = leg.distance / MI_TO_M;
    if (approachMi > maxApproachMi) {
      reject("loop starts too far away");
      return null;
    }
    return {
      f,
      approachMi,
      approach: leg.points.coordinates.map(([lon, lat]) => [lon, lat] as [number, number]),
    };
  });

  const out: RouteCandidate[] = [];
  for (const r of withApproach) {
    if (!r) continue;
    out.push(toCandidate(r.f.judged, "loop", r.approachMi, r.approach));
  }
  return out;
}

/**
 * Begin the loop at its point nearest the address rather than wherever
 * round_trip happened to launch it. Kept only if the re-started loop still
 * passes every rule; the geometry is the same, but the seam moves.
 */
function restartNearHome(
  f: { loop: GHPath; junction: LatLng; judged: EnrichedPath },
  home: LatLng,
): { loop: GHPath; junction: LatLng; judged: EnrichedPath } {
  const loop = startNearest(f.loop, home);
  if (loop === f.loop) return f;
  const judged = enrichPath(loop);
  if (gateFailure(judged, "loop")) return f;
  const [lon, lat] = loop.points.coordinates[0]!;
  return { loop, junction: { lon, lat }, judged };
}

/**
 * Where round_trip is launched from: the door, plus points sampled on rings
 * around it, closest first so the seed budget goes where the ranking will look.
 * These only seed variety -- a loop's real start is wherever its stem ends, and
 * its approach is routed separately.
 */
async function seedPoints(home: LatLng, maxApproachMi: number): Promise<LatLng[]> {
  const points: { point: LatLng; walkMi: number }[] = [{ point: home, walkMi: 0 }];
  if (maxApproachMi <= 0) return [home];

  const samples: LatLng[] = [];
  const bearings = config.search.approachSamples;
  // Rings are biased toward home rather than spread evenly: scoring punishes
  // approach distance steeply, so far samples mostly seed loops that lose.
  for (const ratio of [0.25, 0.5, 0.8]) {
    for (let i = 0; i < bearings; i++) {
      samples.push(
        destinationPoint(home, (360 / bearings) * i, maxApproachMi * ratio * MI_TO_M),
      );
    }
  }

  const legs = await pMap(samples, GH_CONCURRENCY, (s) => gh.route([home, s]));

  const seen = new Set<string>();
  for (const leg of legs) {
    if (!leg) continue;
    const walkMi = leg.distance / MI_TO_M;
    if (walkMi > maxApproachMi) continue;
    const end = leg.points.coordinates.at(-1);
    if (!end) continue;
    // Several bearings often snap to the same corner; keep one.
    const key = `${end[1].toFixed(4)}:${end[0].toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    points.push({ point: { lon: end[0], lat: end[1] }, walkMi });
  }

  points.sort((a, b) => a.walkMi - b.walkMi);
  return points.map((p) => p.point);
}

// -------------------------------------------------------- out and back

/**
 * Out-and-back starts at the door, so there is no approach leg and every
 * candidate scores identically on the approach term. The requested distance is
 * the full there-and-back, so each leg targets half of it.
 */
async function findOutAndBacks(
  home: LatLng,
  req: SearchRequest,
  reject: (reason: string) => void,
): Promise<RouteCandidate[]> {
  const bearings = config.search.approachSamples * 2;
  const legs = await pMap(
    Array.from({ length: bearings }, (_, i) => (360 / bearings) * i),
    GH_CONCURRENCY,
    (bearing) => outAndBackLeg(home, req.distanceMi, bearing),
  );

  const out: RouteCandidate[] = [];
  for (const leg of legs) {
    if (!leg) continue;
    const enriched = enrichPath(leg);
    const failure = gateFailure(enriched, "out_and_back");
    if (failure) {
      reject(failure);
      continue;
    }

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
        totalCrossings: enriched.metrics.totalCrossings * 2,
      },
    };

    out.push(toCandidate(doubled, "out_and_back", 0, []));
  }
  return out;
}

/**
 * The outbound leg of an out-and-back heading roughly along `bearing`, whose
 * doubled length lands inside the tolerance. Bisects how far out the turnaround
 * sits. Unlike a loop, a single point-to-point route grows fairly steadily with
 * that distance, so bisection converges. The tolerance applies to the doubled
 * total, so each leg effectively has to land within half of it.
 */
async function outAndBackLeg(
  home: LatLng,
  totalMi: number,
  bearing: number,
): Promise<GHPath | null> {
  const legM = (totalMi / 2) * MI_TO_M;
  let lo = legM * 0.2;
  let hi = legM * 1.2;

  for (let i = 0; i < 10; i++) {
    const crowM = (lo + hi) / 2;
    const leg = await gh.route([home, destinationPoint(home, bearing, crowM)]);
    if (!leg) {
      // Turnaround snapped somewhere unroutable; pull it in and retry.
      hi = crowM;
      continue;
    }
    const errMi = Math.abs(leg.distance * 2 - totalMi * MI_TO_M) / MI_TO_M;
    if (errMi <= config.search.distanceToleranceMi) return leg;
    if (leg.distance < legM) lo = crowM;
    else hi = crowM;
  }
  return null;
}

// ------------------------------------------------------------- helpers

function toCandidate(
  enriched: EnrichedPath,
  pathType: RouteCandidate["pathType"],
  approachMi: number,
  approachCoordinates: [number, number][],
): RouteCandidate {
  const { score, breakdown } = scoreRoute(enriched, approachMi, pathType);
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
