import { config } from "./config.js";
import { MI_TO_M } from "./geo.js";
import * as gh from "./graphhopper.js";
import type { GHPath, LatLng } from "./types.js";

/**
 * Loop generation: GraphHopper round_trip, with a per-seed secant search on the
 * requested distance.
 *
 * History, because both simpler options were tried and measured on the
 * Leander/Cedar Park extract:
 *
 * 1. round_trip as-is. Real loops -- it penalises edges it has already used, so
 *    the return leg takes different streets -- but it returned 0.70x-8.59x the
 *    requested length and hit the +/-0.1 mi gate 1 time in 48.
 *
 * 2. Bisecting the radius of a polygon of via points. Hit the distance gate
 *    reliably, but the "loops" were out-and-backs: ~100% of their length ran on
 *    streets traversed twice, packed into a 0.2 x 0.3 mi footprint. In
 *    cul-de-sac suburbia each via point lands in a separate residential pod
 *    reachable only one way, so the router dips in and back out of every pod.
 *
 * This keeps round_trip's shapes and fixes its distance control. For a fixed
 * seed, the overshoot ratio is locally stable enough that rescaling the request
 * by how far the last probe missed often lands the next one. Measured over 1-6
 * mi targets: roughly 3-9% of calls land in tolerance, and the loops average
 * ~25% doubled-back (mostly the unavoidable stem out of a cul-de-sac) instead of
 * ~100%. Each call is ~7 ms, so sweeping many seeds is cheap.
 */

/** Median measured overshoot is ~2x, so start by asking for half. */
const FIRST_SCALE = 0.5;
const MAX_PROBES_PER_SEED = 6;

export async function loopForSeed(
  start: LatLng,
  targetMi: number,
  seed: number,
): Promise<GHPath | null> {
  const targetM = targetMi * MI_TO_M;
  const minReq = targetM * 0.15;
  const maxReq = targetM * 1.5;
  let request = targetM * FIRST_SCALE;

  for (let i = 0; i < MAX_PROBES_PER_SEED; i++) {
    const path = await gh.roundTrip(start, request, seed);
    if (!path || path.distance <= 0) return null;

    const errorMi = Math.abs(path.distance - targetM) / MI_TO_M;
    if (errorMi <= config.search.distanceToleranceMi) return path;

    request = Math.min(
      maxReq,
      Math.max(minReq, request * (targetM / path.distance)),
    );
  }
  return null;
}
