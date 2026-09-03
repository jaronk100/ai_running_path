import type { EnrichedPath, SegmentInfo } from "./enrich.js";

/**
 * Weights. Approach distance dominates by explicit instruction: results are
 * ranked "giving greatest weight to having the lowest possible distance from
 * starting point".
 *
 * Requested distance is NOT a weight — it is a hard gate applied before scoring
 * (+/- 0.1 mi), so everything that reaches this function is already the right
 * length and competes only on quality.
 *
 * Elevation is deliberately absent. The spec says report it, never rank on it.
 */
export const WEIGHTS = {
  approach: 45,
  sidewalk: 25,
  safety: 20,
  quality: 10,
} as const;

/** Freeway classes. Presence of any is disqualifying, not merely penalised. */
const FORBIDDEN = new Set([
  "motorway",
  "trunk",
  "motorway_link",
  "trunk_link",
]);

const CLASS_QUIETNESS: Record<string, number> = {
  footway: 1,
  pedestrian: 1,
  path: 1,
  track: 1,
  bridleway: 1,
  living_street: 1,
  residential: 1,
  service: 0.95,
  unclassified: 0.85,
  tertiary: 0.5,
  tertiary_link: 0.45,
  secondary: 0.2,
  secondary_link: 0.18,
  primary: 0.05,
  primary_link: 0.05,
};

function speedFactor(mph: number | null): number {
  if (mph === null) return 0.85; // unposted: usually residential in Austin
  if (mph <= 25) return 1;
  if (mph <= 30) return 0.9;
  if (mph <= 35) return 0.7;
  if (mph <= 40) return 0.4;
  if (mph <= 45) return 0.2;
  return 0.05;
}

/** 0 = hostile arterial, 1 = quiet neighbourhood street or dedicated path. */
function quietness(seg: SegmentInfo): number {
  const base = CLASS_QUIETNESS[seg.roadClass] ?? 0.7;
  return base * speedFactor(seg.maxSpeed);
}

/**
 * Per-segment sidewalk credit.
 *
 * This is where "prefer sidewalks, but sidewalk-less is fine on a quiet street
 * and not on a busy one" actually lives. Unknown coverage gets the benefit of
 * the doubt rather than being punished, because Austin OSM sidewalk tagging is
 * patchy and absent data is not the same as absent sidewalk.
 */
function sidewalkCredit(seg: SegmentInfo): number {
  if (seg.isDedicatedFootway) return 1;
  switch (seg.sidewalk) {
    case "both":
    case "yes":
    case "separate":
      return 1;
    case "left":
    case "right":
      return 0.8;
    // Bands below are deliberately capped under the 0.8 floor for a confirmed
    // sidewalk. Unknown coverage gets the benefit of the doubt, but it must
    // never outrank a street we know has one — otherwise absent data would beat
    // present sidewalk, which inverts the whole preference.
    case "no":
      return 0.1 + 0.45 * quietness(seg); // 0.10 .. 0.55
    default:
      return 0.3 + 0.45 * quietness(seg); // 0.30 .. 0.75
  }
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
 * 0.5 -> 0.26, 1.0 -> 0.11. Typical requests sit at 0.1-0.5 mi, which is the
 * steepest part of the curve, so small differences there separate results
 * strongly — which is the point.
 */
export function approachScore(approachMi: number): number {
  return 1 / (1 + Math.pow(Math.max(0, approachMi) / 0.25, 1.5));
}

export function isDisqualified(path: EnrichedPath): boolean {
  return path.segments.some((s) => FORBIDDEN.has(s.roadClass));
}

export interface ScoreResult {
  score: number;
  breakdown: Record<string, number>;
}

export function scoreRoute(
  path: EnrichedPath,
  approachMi: number,
): ScoreResult {
  const m = path.metrics;

  const approach = approachScore(approachMi);
  const sidewalk = lengthWeighted(path.segments, sidewalkCredit);

  const exposure = m.highSpeedPct * 0.7 + m.busyRoadPct * 0.5;
  const crossingPenalty = Math.min(0.2, m.crossingsOfMajorRoads * 0.04);
  const safety = clamp01(1 - exposure - crossingPenalty);

  // Lit is reported, not gated — weight it by how much of the route actually
  // has lighting data so a route with one lit segment cannot look fully lit.
  const litComponent = m.litPct * clamp01(m.litKnownPct * 1.5);
  const pavedPct =
    (m.surfaceMix["paved"] ?? 0) +
    (m.surfaceMix["asphalt"] ?? 0) +
    (m.surfaceMix["concrete"] ?? 0);
  // Dirt and gravel are acceptable, so this barely moves the needle.
  const surfaceComponent = 0.75 + 0.25 * pavedPct;
  const quality = clamp01(0.6 * litComponent + 0.4 * surfaceComponent);

  const breakdown = {
    approach: approach * WEIGHTS.approach,
    sidewalk: sidewalk * WEIGHTS.sidewalk,
    safety: safety * WEIGHTS.safety,
    quality: quality * WEIGHTS.quality,
  };

  const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { score: Math.round(score * 10) / 10, breakdown };
}
