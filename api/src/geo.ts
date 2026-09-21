import type { LatLng } from "./types.js";

export const MI_TO_M = 1609.344;
export const M_TO_MI = 1 / MI_TO_M;
export const M_TO_FT = 3.28084;

const R_EARTH_M = 6_371_008.8;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.sqrt(h));
}

/** Per-segment lengths in metres. Result length is coords.length - 1. */
export function segmentLengths(coords: [number, number][]): number[] {
  const out: number[] = [];
  for (let i = 1; i < coords.length; i++) {
    const p = coords[i - 1]!;
    const q = coords[i]!;
    out.push(
      haversineMeters({ lon: p[0], lat: p[1] }, { lon: q[0], lat: q[1] }),
    );
  }
  return out;
}

export function pathLengthMeters(coords: [number, number][]): number {
  return segmentLengths(coords).reduce((a, b) => a + b, 0);
}

/** Point `distanceM` away from `from` along `bearingDeg` (0 = north). */
export function destinationPoint(
  from: LatLng,
  bearingDeg: number,
  distanceM: number,
): LatLng {
  const d = distanceM / R_EARTH_M;
  const br = toRad(bearingDeg);
  const lat1 = toRad(from.lat);
  const lon1 = toRad(from.lon);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(br) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );

  return { lat: toDeg(lat2), lon: ((toDeg(lon2) + 540) % 360) - 180 };
}

/**
 * Fraction of `a` that also appears in `b`, by snapping both to a ~25 m grid.
 * Used to drop near-duplicate candidates so the five results are genuinely
 * different runs rather than five variations of one street.
 */
export function geometryOverlap(
  a: [number, number][],
  b: [number, number][],
): number {
  if (a.length === 0 || b.length === 0) return 0;
  const cellsB = new Set(b.map(gridKey));
  let hit = 0;
  const cellsA = new Set(a.map(gridKey));
  for (const c of cellsA) if (cellsB.has(c)) hit++;
  return cellsA.size === 0 ? 0 : hit / cellsA.size;
}

// ~25 m at Austin's latitude. Longitude is scaled by cos(lat) so cells stay
// roughly square rather than stretching east-west.
function gridKey([lon, lat]: [number, number]): string {
  const latStep = 25 / 111_320;
  const lonStep = latStep / Math.max(0.2, Math.cos(toRad(lat)));
  return `${Math.round(lat / latStep)}:${Math.round(lon / lonStep)}`;
}

/**
 * Share of a path's length spent on street segments it traverses more than
 * once: 0 is a true loop, 1 is a pure out-and-back. GraphHopper emits identical
 * coordinates each time a route passes the same node, so a retraced segment
 * has exactly matching endpoints in either direction.
 */
export function retraceShare(coords: [number, number][]): number {
  const edgeKey = (a: [number, number], b: [number, number]) => {
    const ka = `${a[0].toFixed(6)},${a[1].toFixed(6)}`;
    const kb = `${b[0].toFixed(6)},${b[1].toFixed(6)}`;
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };

  const passes = new Map<string, number>();
  for (let i = 1; i < coords.length; i++) {
    const k = edgeKey(coords[i - 1]!, coords[i]!);
    passes.set(k, (passes.get(k) ?? 0) + 1);
  }

  const lens = segmentLengths(coords);
  let total = 0;
  let repeated = 0;
  for (let i = 1; i < coords.length; i++) {
    const len = lens[i - 1]!;
    total += len;
    if ((passes.get(edgeKey(coords[i - 1]!, coords[i]!)) ?? 0) > 1) repeated += len;
  }
  return total > 0 ? repeated / total : 0;
}
