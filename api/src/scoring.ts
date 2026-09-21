import { config } from "./config.js";
import type { EnrichedPath, SegmentInfo } from "./enrich.js";
import { MI_TO_M } from "./geo.js";
import type { PathType } from "./types.js";

/**
 * Hard rules live in gateFailure(); everything that passes them is ranked by
 * three terms.
 *
 * Approach distance dominates by explicit instruction: results are ranked
 * "giving greatest weight to having the lowest possible distance from starting
 * point".
 *
 * Traffic carries the "quiet streets are fine without sidewalks, busy ones are
 * not" rule using road class and posted speed, which OSM has everywhere.
 * Sidewalk and streetlight tags were dropped: in the Leander/Cedar Park extract
 * they were effectively absent.
 *
 * Shape is roundness. Doubling back is already gated out, so what separates the
 * survivors is whether they look like "a loop as imagined" or a thin hairpin up
 * one street and down the next. Out-and-backs take full marks here; they only
 * ever compete with each other.
 *
 * Requested distance is NOT a weight. It is a hard gate (+/- 0.1 mi) applied
 * during generation, so everything here is already the right length.
 *
 * Elevation is deliberately absent. The spec says report it, never rank on it.
 */
export const WEIGHTS = {
  approach: 55,
  traffic: 30,
  shape: 15,
} as const;

/** Roundness at or above this scores full marks: roughly a 3:1 rectangle, which
 *  street grids rarely beat once their zigzags inflate the perimeter. */
const FULL_ROUNDNESS = 0.6;

/** Freeway classes. Presence of any is disqualifying, not merely penalised. */
const FORBIDDEN = new Set([
  "motorway",
  "trunk",
  "motorway_link",
  "trunk_link",
]);

const MAJOR_ROADS = ["primary", "secondary", "primary_link", "secondary_link"];

/**
 * 1 = no traffic at all, 0 = hostile arterial. Car-free paths sit at the top;
 * residential streets just below, since they do carry some cars. Service roads
 * rank low because in OSM that class is mostly parking-lot aisles.
 */
const CLASS_QUIETNESS: Record<string, number> = {
  living_street: 0.95,
  residential: 0.9,
  unclassified: 0.75,
  road: 0.7,
  service: 0.45,
  tertiary: 0.45,
  tertiary_link: 0.4,
  secondary: 0.2,
  secondary_link: 0.18,
  primary: 0.05,
  primary_link: 0.05,
};

function speedFactor(mph: number | null): number {
  if (mph === null) return 0.95; // unposted: nearly always a neighbourhood street
  if (mph <= 25) return 1;
  if (mph <= 30) return 0.9;
  if (mph <= 35) return 0.7;
  if (mph <= 40) return 0.4;
  if (mph <= 45) return 0.2;
  return 0.05;
}

export function quietness(seg: SegmentInfo): number {
  if (seg.isPath) return 1;
  const base = CLASS_QUIETNESS[seg.roadClass] ?? 0.6;
  return base * speedFactor(seg.maxSpeed);
}

function lengthWeighted(
  segments: SegmentInfo[],
  f: (s: SegmentInfo) => number,
): number {
  let num = 0;
  let den = 0;
  for (const s of segments) {
    num += f(s) * s.lengthM;
    den += s.lengthM;
  }
  return den > 0 ? num / den : 0;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Decays with approach distance, uncapped. 0 mi -> 1.00, 0.25 -> 0.50,
 * 0.5 -> 0.26, 1.0 -> 0.11. Typical requests sit at 0.1-0.5 mi, the steepest
 * part of the curve, so small differences there separate results strongly.
 */
export function approachScore(approachMi: number): number {
  return 1 / (1 + Math.pow(Math.max(0, approachMi) / 0.25, 1.5));
}

export function isDisqualified(path: EnrichedPath): boolean {
  return path.segments.some((s) => FORBIDDEN.has(s.roadClass));
}

export function majorRoadShare(path: EnrichedPath): number {
  return MAJOR_ROADS.reduce((sum, k) => sum + (path.metrics.roadClassMix[k] ?? 0), 0);
}

/**
 * The first hard rule a route breaks, or null if it may be shown. For a loop,
 * `path` is the loop proper -- the stem has already been cut away as approach.
 */
export function gateFailure(path: EnrichedPath, pathType: PathType): string | null {
  const g = config.gates;
  if (isDisqualified(path)) return "freeway";
  if (majorRoadShare(path) > g.maxMajorRoadShare) return "major roads";
  if (pathType === "loop") {
    const doubledM = path.metrics.retracePct * path.metrics.distanceMi * MI_TO_M;
    if (doubledM > g.maxLoopDoubleBackM) return "doubles back";
    if ((path.metrics.roadClassMix["service"] ?? 0) > g.maxLoopServiceShare) {
      return "parking lots";
    }
    if (path.metrics.roundness < g.minLoopRoundness) return "hairpin";
  }
  return null;
}

export interface ScoreResult {
  score: number;
  breakdown: Record<string, number>;
}

export function scoreRoute(
  path: EnrichedPath,
  approachMi: number,
  pathType: PathType,
): ScoreResult {
  const approach = approachScore(approachMi);

  const crossingPenalty = Math.min(
    0.2,
    path.metrics.crossingsOfMajorRoads * 0.04,
  );
  const traffic = clamp01(
    lengthWeighted(path.segments, quietness) - crossingPenalty,
  );

  const shape =
    pathType === "loop" ? clamp01(path.metrics.roundness / FULL_ROUNDNESS) : 1;

  const breakdown = {
    approach: approach * WEIGHTS.approach,
    traffic: traffic * WEIGHTS.traffic,
    shape: shape * WEIGHTS.shape,
  };

  const score = breakdown.approach + breakdown.traffic + breakdown.shape;
  return { score: Math.round(score * 10) / 10, breakdown };
}
