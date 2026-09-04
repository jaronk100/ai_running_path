import { config } from "./config.js";
import { MI_TO_M, destinationPoint } from "./geo.js";
import * as gh from "./graphhopper.js";
import type { GHPath, LatLng } from "./types.js";

/**
 * Loop generation by bisection on a fixed-shape polygon of via points.
 *
 * GraphHopper's built-in `algorithm=round_trip` is not usable here. Measured
 * against the Austin extract it returned 0.70x to 8.59x the requested distance
 * and landed inside the +/- 0.1 mi gate 1 time in 48. Iterative correction did
 * not rescue it (17.7%): seed and distance jointly determine the loop's shape,
 * so changing the requested distance changes the route entirely and there is no
 * gradient to follow.
 *
 * Here the shape is pinned by the bearings and only the radius varies, which
 * makes routed length monotonic in radius, so bisection actually converges.
 * Measured hit rate is ~37% at ~97 ms per attempt -- low per attempt, but cheap
 * enough that sweeping bearings and polygon sizes yields plenty of candidates.
 *
 * It stays a step function (a small radius change can jump the route to the next
 * street over), which is why the remaining ~63% cannot be squeezed out with more
 * iterations. More attempts, not more precision.
 */

const MAX_ITERATIONS = 9;

/** Regular n-gon inscribed in radius r has perimeter 2*n*r*sin(pi/n). */
function idealPerimeterFactor(sides: number): number {
  return 2 * sides * Math.sin(Math.PI / sides);
}

export interface LoopAttempt {
  path: GHPath;
  errorMi: number;
  radiusM: number;
  ghCalls: number;
}

export async function generateLoop(
  start: LatLng,
  targetMeters: number,
  bearingDeg: number,
  sides: number,
): Promise<LoopAttempt | null> {
  const factor = idealPerimeterFactor(sides);
  // Bracket generously: street detours inflate the ideal perimeter by an amount
  // that varies hugely with how gridded the local network is.
  let lo = (targetMeters / factor) * 0.15;
  let hi = (targetMeters / factor) * 2.5;

  let best: LoopAttempt | null = null;
  let ghCalls = 0;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const radiusM = (lo + hi) / 2;

    const points: LatLng[] = [start];
    for (let s = 0; s < sides; s++) {
      points.push(
        destinationPoint(start, bearingDeg + (360 / sides) * s, radiusM),
      );
    }
    points.push(start);

    const path = await gh.route(points);
    ghCalls++;
    if (!path) break;

    const errorMi = Math.abs(path.distance - targetMeters) / MI_TO_M;
    if (!best || errorMi < best.errorMi) {
      best = { path, errorMi, radiusM, ghCalls };
    }
    if (errorMi <= config.search.distanceToleranceMi) {
      return { path, errorMi, radiusM, ghCalls };
    }

    if (path.distance < targetMeters) lo = radiusM;
    else hi = radiusM;
  }

  // Only hand back a converged loop. A near miss is still the wrong distance,
  // and the spec's tolerance is a hard gate rather than a preference.
  if (best && best.errorMi <= config.search.distanceToleranceMi) return best;
  return null;
}

/** Bearing/shape combinations swept per start point, in priority order. */
export function loopVariants(): { bearing: number; sides: number }[] {
  const out: { bearing: number; sides: number }[] = [];
  for (const sides of [3, 4, 5]) {
    for (const bearing of [0, 45, 90, 135, 180, 225, 270, 315]) {
      out.push({ bearing, sides });
    }
  }
  return out;
}
