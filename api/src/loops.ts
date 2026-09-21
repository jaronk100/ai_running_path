import { config } from "./config.js";
import { perSegment } from "./enrich.js";
import { MI_TO_M, haversineMeters, segmentLengths } from "./geo.js";
import * as gh from "./graphhopper.js";
import { splitLollipop } from "./shape.js";
import type { DetailInterval, GHPath, LatLng } from "./types.js";

/**
 * Loop generation: GraphHopper round_trip, with a per-seed secant search on the
 * requested distance, then the stem cut away so only the loop proper is kept.
 *
 * History, because simpler options were tried and measured on the
 * Leander/Cedar Park extract:
 *
 * 1. round_trip as-is. Real loops -- it penalises edges it has already used --
 *    but 0.70x-8.59x the requested length; 1 in 48 inside +/-0.1 mi.
 * 2. Bisecting the radius of a polygon of via points. Hit the distance, but in
 *    cul-de-sac suburbia every via point landed in a separate pod reachable one
 *    way, so the "loops" doubled back along ~100% of their length.
 *
 * This keeps round_trip's shapes and fixes its length. For a fixed seed the
 * overshoot ratio is locally stable enough that rescaling the request by how far
 * the last probe missed often lands the next one. Each call is ~7 ms.
 *
 * round_trip from a cul-de-sac is usually a lollipop: out to a through street,
 * round, and back in the same way. That stem breaks the no-doubling-back rule,
 * but under the 2A + N*L model it is just the approach, so it is cut off here
 * and the length that must land in tolerance is the loop proper's.
 */

/** Median measured overshoot is ~2x, so start by asking for half. */
const FIRST_SCALE = 0.5;
const MAX_PROBES_PER_SEED = 6;

/**
 * Cut points [from, to] (inclusive) out of a GraphHopper path, re-indexing its
 * interval details and recomputing distance and climb for just that part.
 */
export function slicePath(path: GHPath, from: number, to: number): GHPath {
  const coordinates = path.points.coordinates.slice(from, to + 1);

  const details: Record<string, DetailInterval<unknown>[]> = {};
  for (const [key, intervals] of Object.entries(path.details ?? {})) {
    details[key] = (intervals as DetailInterval<unknown>[]).flatMap(([a, b, v]) => {
      const a2 = Math.max(a, from) - from;
      const b2 = Math.min(b, to) - from;
      return b2 > a2 ? [[a2, b2, v] as DetailInterval<unknown>] : [];
    });
  }

  let ascend = 0;
  let descend = 0;
  for (let i = 1; i < coordinates.length; i++) {
    const e0 = coordinates[i - 1]![2];
    const e1 = coordinates[i]![2];
    if (e0 === undefined || e1 === undefined) continue;
    if (e1 > e0) ascend += e1 - e0;
    else descend += e0 - e1;
  }

  const flat = coordinates.map(([lon, lat]) => [lon, lat] as [number, number]);
  return {
    distance: segmentLengths(flat).reduce((x, y) => x + y, 0),
    time: 0,
    ascend,
    descend,
    points: { coordinates },
    details: details as GHPath["details"],
  };
}

/**
 * Remove every place the route immediately reverses over the segment it just
 * covered: the in-and-out of a dead-end street that round_trip only entered to
 * touch one of its own via points. Nobody asked to run it, and it would fail
 * the no-doubling-back rule, but the loop around it is fine -- just shorter,
 * which the distance search then makes up.
 *
 * Works on segments with a stack: a segment that exactly reverses the one on
 * top cancels it. GraphHopper repeats identical node coordinates on a revisit,
 * so reversal is an exact match. Doubling back along a *different* way (the
 * other sidewalk) is not cancelled here -- that is not a spur, and the shape
 * rules reject it.
 */
export function cancelBacktracks(path: GHPath): GHPath {
  const pts = path.points.coordinates;
  const segCount = pts.length - 1;
  if (segCount < 2) return path;

  const key = (i: number) => `${pts[i]![0].toFixed(7)},${pts[i]![1].toFixed(7)}`;
  const stack: number[] = []; // segment i runs from point i to point i+1
  for (let i = 0; i < segCount; i++) {
    if (key(i) === key(i + 1)) continue;
    const top = stack.at(-1);
    if (top !== undefined && key(top) === key(i + 1)) {
      stack.pop();
      continue;
    }
    stack.push(i);
  }
  if (stack.length === segCount) return path;
  if (stack.length === 0) {
    return { ...path, distance: 0, points: { coordinates: [pts[0]!] }, details: {} };
  }

  const coordinates = [pts[stack[0]!]!, ...stack.map((i) => pts[i + 1]!)];

  const details: Record<string, DetailInterval<unknown>[]> = {};
  for (const [name, intervals] of Object.entries(path.details ?? {})) {
    const values = perSegment(intervals as DetailInterval<unknown>[], segCount);
    const out: DetailInterval<unknown>[] = [];
    stack.forEach((segIdx, pos) => {
      const v = values[segIdx];
      if (v === undefined) return;
      const last = out.at(-1);
      if (last && last[1] === pos && last[2] === v) last[1] = pos + 1;
      else out.push([pos, pos + 1, v]);
    });
    details[name] = out;
  }

  return slicePath(
    { ...path, points: { coordinates }, details: details as GHPath["details"] },
    0,
    coordinates.length - 1,
  );
}

/** Concatenate paths that each begin where the previous one ended. */
function joinPaths(parts: GHPath[]): GHPath {
  const coordinates: GHPath["points"]["coordinates"] = [];
  const details: Record<string, DetailInterval<unknown>[]> = {};
  for (const part of parts) {
    const offset = Math.max(0, coordinates.length - 1);
    coordinates.push(...(coordinates.length ? part.points.coordinates.slice(1) : part.points.coordinates));
    for (const [name, intervals] of Object.entries(part.details ?? {})) {
      (details[name] ??= []).push(
        ...(intervals as DetailInterval<unknown>[]).map(
          ([a, b, v]) => [a + offset, b + offset, v] as DetailInterval<unknown>,
        ),
      );
    }
  }
  return slicePath(
    { distance: 0, time: 0, points: { coordinates }, details: details as GHPath["details"] },
    0,
    coordinates.length - 1,
  );
}

/**
 * Re-start a closed loop at its point nearest `target`. A loop can be begun
 * anywhere on itself, and where round_trip happened to launch it is arbitrary:
 * from the Leander library, loops passing 20 m from the door were starting
 * 0.1 mi away. Starting nearest the address shortens the walk to the loop,
 * which the ranking weighs most.
 */
export function startNearest(loop: GHPath, target: LatLng): GHPath {
  const pts = loop.points.coordinates;
  const n = pts.length;
  if (n < 4) return loop;

  const at = (i: number) => ({ lon: pts[i]![0], lat: pts[i]![1] });
  // Only an exactly closed loop rotates without inventing a segment across the
  // gap -- a stem split across a road can leave its ends a few metres apart.
  if (haversineMeters(at(0), at(n - 1)) > 5) return loop;

  let best = 0;
  let bestM = Infinity;
  for (let i = 0; i < n - 1; i++) {
    const d = haversineMeters(target, at(i));
    if (d < bestM) {
      bestM = d;
      best = i;
    }
  }
  if (best === 0) return loop;
  return joinPaths([slicePath(loop, best, n - 1), slicePath(loop, 0, best)]);
}

export interface FoundLoop<T> {
  /** The loop proper: stem removed, starts and ends at `junction`. */
  loop: GHPath;
  /** Where the loop begins and ends -- the loop start the runner walks to. */
  junction: LatLng;
  /** Whatever `judge` returned for it. */
  judged: T;
}

/**
 * One loop for this seed whose loop proper lands in the distance tolerance and
 * that `judge` accepts, or null. `judge` returns null to reject.
 *
 * A loop of the right length that `judge` rejects ends the seed: rescaling by
 * ~1.0 would only reproduce it, and other seeds are the source of other shapes.
 */
export async function loopForSeed<T>(
  start: LatLng,
  targetMi: number,
  seed: number,
  judge: (loop: GHPath) => T | null,
): Promise<FoundLoop<T> | null> {
  const targetM = targetMi * MI_TO_M;
  const minReq = targetM * 0.15;
  const maxReq = targetM * 1.8;
  let request = targetM * FIRST_SCALE;

  for (let i = 0; i < MAX_PROBES_PER_SEED; i++) {
    const raw = await gh.roundTrip(start, request, seed);
    if (!raw || raw.distance <= 0) return null;
    const path = cancelBacktracks(raw);
    if (path.distance <= 0) return null;

    const coords = path.points.coordinates.map(
      ([lon, lat]) => [lon, lat] as [number, number],
    );
    const split = splitLollipop(coords);

    // Steer on the part that will actually be lapped. Without a clean split,
    // the whole route is the best available estimate.
    let measuredM = path.distance;
    if (split) {
      const loop = slicePath(path, split.startPoint, split.endPoint);
      measuredM = loop.distance;
      if (Math.abs(loop.distance - targetM) / MI_TO_M <= config.search.distanceToleranceMi) {
        const judged = judge(loop);
        if (judged === null) return null;
        const [lon, lat] = coords[split.startPoint]!;
        return { loop, junction: { lon, lat }, judged };
      }
    }

    request = Math.min(maxReq, Math.max(minReq, request * (targetM / measuredM)));
  }
  return null;
}
