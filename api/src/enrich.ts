import { M_TO_FT, M_TO_MI, retraceShare, segmentLengths } from "./geo.js";
import type { DetailInterval, GHPath, RouteMetrics } from "./types.js";

/** GraphHopper reports max_speed in km/h. Everything downstream is mph. */
const KMH_TO_MPH = 0.621371;

/** Car-free ways. The spec explicitly allows dirt and gravel, so trails count. */
const PATH_CLASSES = new Set([
  "footway",
  "pedestrian",
  "path",
  "steps",
  "track",
  "bridleway",
  "cycleway",
]);
const BUSY = new Set(["primary", "secondary", "primary_link", "secondary_link"]);

/** crossing=* values that mean this segment is a real pedestrian crossing. */
const REAL_CROSSING = new Set([
  "traffic_signals",
  "marked",
  "uncontrolled",
  "unmarked",
  "railway",
  "railway_barrier",
]);

const HIGH_SPEED_MPH = 35;

/**
 * Roads worth counting a crossing of. The `crossing` encoded value marks every
 * crossing way including quiet residential corners -- a 2 mi suburb loop scores
 * 17 of those, which would max the penalty for every candidate and therefore
 * discriminate nothing. Crossings that matter are inferred separately, from
 * short hops onto busy classes.
 */
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

/**
 * Signals closer together than this along the route are one crossing. A
 * divided road puts a signal node on each carriageway, and one intersection
 * should not count twice.
 */
const SIGNAL_CLUSTER_M = 60;

export interface EnrichedPath {
  coordinates: [number, number][];
  distanceMi: number;
  metrics: RouteMetrics;
  /** Per-segment classification, kept for the scorer. */
  segments: SegmentInfo[];
}

export interface SegmentInfo {
  lengthM: number;
  roadClass: string;
  /** Converted to mph on the way in. */
  maxSpeed: number | null;
  surface: string | null;
  /** Car-free: no traffic to weigh, whatever the adjacent road is doing. */
  isPath: boolean;
  isCrossing: boolean;
  /** Raw OSM crossing=* value, e.g. traffic_signals, marked, missing. */
  crossing: string;
}

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

/**
 * Two ways a route crosses a busy road, and each counter catches one:
 *
 * - At a signalised intersection. The route stays on the road it is running
 *   along and passes over the busy road at a single node, so the busy road never
 *   appears in road_class at all -- only crossing=traffic_signals does. Verified
 *   on the Whitestone Blvd (RM 1431) crossing north of the Cedar Park library,
 *   which the hop counter alone scored as zero.
 * - Where no signal is mapped, as a short hop onto a busy road class.
 */
function countMajorRoadCrossings(segments: SegmentInfo[]): number {
  return countSignalCrossings(segments) + countShortHopCrossings(segments);
}

function countSignalCrossings(segments: SegmentInfo[]): number {
  let count = 0;
  let travelled = 0;
  let lastSignalAt = -Infinity;
  for (const s of segments) {
    if (s.crossing === "traffic_signals") {
      if (travelled - lastSignalAt > SIGNAL_CLUSTER_M) count++;
      lastSignalAt = travelled;
    }
    travelled += s.lengthM;
  }
  return count;
}

function countShortHopCrossings(segments: SegmentInfo[]): number {
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

export function enrichPath(path: GHPath): EnrichedPath {
  const coordinates = path.points.coordinates.map(
    ([lon, lat]) => [lon, lat] as [number, number],
  );
  const segLens = segmentLengths(coordinates);
  const segCount = segLens.length;
  const totalM = segLens.reduce((a, b) => a + b, 0);

  const roadClasses = perSegment(path.details?.road_class, segCount);
  const surfaces = perSegment(path.details?.surface, segCount);
  const speeds = perSegment(path.details?.max_speed, segCount);
  const footways = perSegment(path.details?.footway, segCount);
  const crossings = perSegment(path.details?.crossing, segCount);

  const segments: SegmentInfo[] = [];
  const roadClassMix: Record<string, number> = {};
  const surfaceMix: Record<string, number> = {};

  let pathM = 0;
  let highSpeedM = 0;
  let busyM = 0;
  let crossingCount = 0;
  let prevWasCrossing = false;

  for (let i = 0; i < segCount; i++) {
    const lengthM = segLens[i]!;
    const roadClass = (roadClasses[i] ?? "other").toLowerCase();
    const surface = surfaces[i] ?? null;
    const rawSpeed = speeds[i];
    const maxSpeed =
      rawSpeed === undefined || rawSpeed === null
        ? null
        : rawSpeed * KMH_TO_MPH;
    const footway = (footways[i] ?? "missing").toLowerCase();
    const crossing = (crossings[i] ?? "missing").toLowerCase();

    // A crossing way is technically a footway, but it runs across traffic, so
    // it must not count toward car-free distance.
    const isCrossing = REAL_CROSSING.has(crossing) || footway === "crossing";
    const isPath = PATH_CLASSES.has(roadClass) && !isCrossing;

    if (isCrossing && !prevWasCrossing) crossingCount++;
    prevWasCrossing = isCrossing;

    segments.push({
      lengthM,
      roadClass,
      maxSpeed,
      surface,
      isPath,
      isCrossing,
      crossing,
    });

    addTo(roadClassMix, roadClass, lengthM);
    addTo(surfaceMix, surface ?? "unknown", lengthM);

    if (isPath) pathM += lengthM;
    if (maxSpeed !== null && maxSpeed > HIGH_SPEED_MPH) highSpeedM += lengthM;
    if (BUSY.has(roadClass)) busyM += lengthM;
  }

  const frac = (m: number) => (totalM > 0 ? m / totalM : 0);
  for (const k of Object.keys(roadClassMix)) {
    roadClassMix[k] = frac(roadClassMix[k]!);
  }
  for (const k of Object.keys(surfaceMix)) {
    surfaceMix[k] = frac(surfaceMix[k]!);
  }

  return {
    coordinates,
    distanceMi: totalM * M_TO_MI,
    segments,
    metrics: {
      distanceMi: totalM * M_TO_MI,
      elevationGainFt: (path.ascend ?? 0) * M_TO_FT,
      elevationLossFt: (path.descend ?? 0) * M_TO_FT,
      roadClassMix,
      surfaceMix,
      retracePct: retraceShare(coordinates),
      pathPct: frac(pathM),
      highSpeedPct: frac(highSpeedM),
      busyRoadPct: frac(busyM),
      crossingsOfMajorRoads: countMajorRoadCrossings(segments),
      totalCrossings: crossingCount,
    },
  };
}
