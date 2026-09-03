import { M_TO_FT, M_TO_MI, segmentLengths } from "./geo.js";
import { lookupSidewalks, type SidewalkSide } from "./sidewalks.js";
import type { DetailInterval, GHPath, RouteMetrics } from "./types.js";

/** A sidewalk drawn as its own OSM way arrives as one of these road classes. */
const DEDICATED_FOOTWAY = new Set(["footway", "pedestrian", "path", "steps"]);
/** Unpaved-but-pleasant. The spec explicitly allows dirt and gravel. */
const TRAIL_LIKE = new Set(["track", "bridleway"]);
const BUSY = new Set(["primary", "secondary", "primary_link", "secondary_link"]);
const CROSSABLE_BUT_NOT_RUNNABLE = new Set([
  "primary",
  "secondary",
  "tertiary",
  "primary_link",
  "secondary_link",
  "tertiary_link",
]);

/** A short hop onto a busy road is a crossing; a long one is running along it. */
const CROSSING_MAX_M = 40;
const HIGH_SPEED_MPH = 35;

/**
 * Expand GraphHopper's interval-encoded `details` into one value per segment.
 * Intervals are [fromPointIdx, toPointIdx, value] and segment i spans points
 * i..i+1, so an interval covers segments [from, to).
 */
function perSegment<T>(
  intervals: DetailInterval<T>[] | undefined,
  segCount: number,
): (T | undefined)[] {
  const out = new Array<T | undefined>(segCount).fill(undefined);
  if (!intervals) return out;
  for (const [from, to, value] of intervals) {
    for (let i = Math.max(0, from); i < Math.min(segCount, to); i++) {
      out[i] = value;
    }
  }
  return out;
}

function addTo(mix: Record<string, number>, key: string, weight: number): void {
  mix[key] = (mix[key] ?? 0) + weight;
}

export interface EnrichedPath {
  coordinates: [number, number][];
  distanceMi: number;
  metrics: RouteMetrics;
  sidewalkDataAvailable: boolean;
  /** Per-segment classification, kept for the scorer's nuanced rules. */
  segments: SegmentInfo[];
}

export interface SegmentInfo {
  lengthM: number;
  roadClass: string;
  maxSpeed: number | null;
  lit: boolean | null;
  surface: string | null;
  sidewalk: SidewalkSide;
  isDedicatedFootway: boolean;
}

export async function enrichPath(path: GHPath): Promise<EnrichedPath> {
  const coordinates = path.points.coordinates.map(
    ([lon, lat]) => [lon, lat] as [number, number],
  );
  const segLens = segmentLengths(coordinates);
  const segCount = segLens.length;
  const totalM = segLens.reduce((a, b) => a + b, 0);

  const roadClasses = perSegment(path.details?.road_class, segCount);
  const surfaces = perSegment(path.details?.surface, segCount);
  const speeds = perSegment(path.details?.max_speed, segCount);
  const lits = perSegment(path.details?.lit, segCount);
  const wayIds = perSegment(path.details?.osm_way_id, segCount);

  // Only roadways need a sidewalk lookup — a dedicated footway already answers
  // the question, so we keep the Overpass query as small as possible.
  const needSidewalk = new Set<number>();
  for (let i = 0; i < segCount; i++) {
    const rc = (roadClasses[i] ?? "other").toLowerCase();
    const id = wayIds[i];
    if (id !== undefined && !DEDICATED_FOOTWAY.has(rc)) needSidewalk.add(id);
  }
  const { tags, complete } = await lookupSidewalks(needSidewalk);

  const segments: SegmentInfo[] = [];
  const roadClassMix: Record<string, number> = {};
  const surfaceMix: Record<string, number> = {};

  let dedicatedM = 0;
  let taggedSidewalkM = 0;
  let noSidewalkM = 0;
  let unknownSidewalkM = 0;
  let litM = 0;
  let litKnownM = 0;
  let highSpeedM = 0;
  let busyM = 0;

  for (let i = 0; i < segCount; i++) {
    const lengthM = segLens[i]!;
    const roadClass = (roadClasses[i] ?? "other").toLowerCase();
    const surface = surfaces[i] ?? null;
    const maxSpeed = speeds[i] ?? null;
    const lit = lits[i] ?? null;
    const wayId = wayIds[i];

    const isDedicatedFootway =
      DEDICATED_FOOTWAY.has(roadClass) || TRAIL_LIKE.has(roadClass);

    const sidewalk: SidewalkSide = isDedicatedFootway
      ? "both"
      : wayId !== undefined
        ? (tags.get(wayId) ?? "unknown")
        : "unknown";

    segments.push({
      lengthM,
      roadClass,
      maxSpeed,
      lit,
      surface,
      sidewalk,
      isDedicatedFootway,
    });

    addTo(roadClassMix, roadClass, lengthM);
    addTo(surfaceMix, surface ?? "unknown", lengthM);

    if (isDedicatedFootway) dedicatedM += lengthM;
    else if (sidewalk === "both" || sidewalk === "yes" || sidewalk === "separate")
      taggedSidewalkM += lengthM;
    else if (sidewalk === "left" || sidewalk === "right")
      taggedSidewalkM += lengthM * 0.7;
    else if (sidewalk === "no") noSidewalkM += lengthM;
    else unknownSidewalkM += lengthM;

    if (lit !== null) {
      litKnownM += lengthM;
      if (lit) litM += lengthM;
    }
    if (maxSpeed !== null && maxSpeed > HIGH_SPEED_MPH) highSpeedM += lengthM;
    if (BUSY.has(roadClass)) busyM += lengthM;
  }

  const frac = (m: number) => (totalM > 0 ? m / totalM : 0);
  for (const k of Object.keys(roadClassMix)) roadClassMix[k] = frac(roadClassMix[k]!);
  for (const k of Object.keys(surfaceMix)) surfaceMix[k] = frac(surfaceMix[k]!);

  return {
    coordinates,
    distanceMi: totalM * M_TO_MI,
    sidewalkDataAvailable: complete,
    segments,
    metrics: {
      distanceMi: totalM * M_TO_MI,
      elevationGainFt: (path.ascend ?? 0) * M_TO_FT,
      elevationLossFt: (path.descend ?? 0) * M_TO_FT,
      roadClassMix,
      surfaceMix,
      dedicatedFootwayPct: frac(dedicatedM),
      taggedSidewalkPct: frac(taggedSidewalkM),
      noSidewalkPct: frac(noSidewalkM),
      unknownSidewalkPct: frac(unknownSidewalkM),
      litPct: litKnownM > 0 ? litM / litKnownM : 0,
      litKnownPct: frac(litKnownM),
      highSpeedPct: frac(highSpeedM),
      busyRoadPct: frac(busyM),
      crossingsOfMajorRoads: countCrossings(segments),
    },
  };
}

/**
 * Count runs of busy road short enough to be a crossing rather than a stretch
 * of running alongside traffic. Approximate — GraphHopper does not surface OSM
 * crossing nodes — but it separates "crosses Lamar twice" from "runs up Lamar".
 */
function countCrossings(segments: SegmentInfo[]): number {
  let crossings = 0;
  let runM = 0;
  let inRun = false;

  for (const s of segments) {
    if (CROSSABLE_BUT_NOT_RUNNABLE.has(s.roadClass)) {
      runM += s.lengthM;
      inRun = true;
    } else if (inRun) {
      if (runM <= CROSSING_MAX_M) crossings++;
      runM = 0;
      inRun = false;
    }
  }
  if (inRun && runM <= CROSSING_MAX_M) crossings++;
  return crossings;
}
