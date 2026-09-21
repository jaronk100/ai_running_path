import { haversineMeters, segmentLengths } from "./geo.js";

/**
 * Loop shape rules. A loop must never double back: no stretch of it may be
 * covered again in the opposite direction.
 *
 * "Again" is judged spatially rather than by map segment, because running north
 * up one sidewalk and south down the other is doubling back to a runner, yet
 * those are two different OSM ways. Matching exact segments missed exactly
 * that case (a Costco run that went up and back one collector scored 5%).
 */

/** Opposite-direction travel within this lateral distance is the same road.
 *  Spans the two sidewalks of a four-lane road (~20 m) without reaching the
 *  next parallel street, which in these subdivisions is a block (60 m+) away. */
const SAME_CORRIDOR_M = 25;
/** Samples closer than this along the route are one stretch, not a revisit. */
const MIN_SEPARATION_ALONG_M = 60;
const SAMPLE_SPACING_M = 10;
/** Headings within ~45 degrees of exactly opposite. */
const OPPOSITE_DOT = -0.7;

/** Stem out and stem back must match to within this, plus 25% of their length. */
const STEM_MISMATCH_M = 40;
/** The loop must close: where the stem ends out and begins back. */
const MAX_JUNCTION_GAP_M = 50;
/** Anything shorter is the turnaround of an out-and-back, not a loop. */
const MIN_LOOP_M = 200;

type XY = [number, number];

function project(coords: [number, number][]): XY[] {
  const [lon0, lat0] = coords[0] ?? [0, 0];
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110_574;
  return coords.map(([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky]);
}

/**
 * Per segment: is this stretch covered again, elsewhere on the route, heading
 * the opposite way? Samples every ~10 m and compares nearby samples through a
 * grid, so cost stays roughly linear in route length.
 */
export function doubledBackSegments(coords: [number, number][]): boolean[] {
  const segCount = Math.max(0, coords.length - 1);
  const flags = new Array<boolean>(segCount).fill(false);
  if (segCount === 0) return flags;

  const pts = project(coords);
  const samples: { x: number; y: number; hx: number; hy: number; s: number; seg: number }[] = [];
  const perSeg = new Array<number>(segCount).fill(0);

  let travelled = 0;
  for (let i = 0; i < segCount; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[i + 1]!;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 0.5) continue;
    const n = Math.max(1, Math.round(len / SAMPLE_SPACING_M));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      samples.push({
        x: x0 + dx * t,
        y: y0 + dy * t,
        hx: dx / len,
        hy: dy / len,
        s: travelled + t * len,
        seg: i,
      });
    }
    perSeg[i] = n;
    travelled += len;
  }

  const cell = (v: number) => Math.floor(v / SAME_CORRIDOR_M);
  const grid = new Map<string, number[]>();
  samples.forEach((p, idx) => {
    const key = `${cell(p.x)}:${cell(p.y)}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(idx);
    else grid.set(key, [idx]);
  });

  const flaggedPerSeg = new Array<number>(segCount).fill(0);
  const r2 = SAME_CORRIDOR_M * SAME_CORRIDOR_M;

  for (const a of samples) {
    const cx = cell(a.x);
    const cy = cell(a.y);
    let hit = false;
    for (let gx = cx - 1; gx <= cx + 1 && !hit; gx++) {
      for (let gy = cy - 1; gy <= cy + 1 && !hit; gy++) {
        for (const j of grid.get(`${gx}:${gy}`) ?? []) {
          const b = samples[j]!;
          if (Math.abs(a.s - b.s) < MIN_SEPARATION_ALONG_M) continue;
          if ((a.x - b.x) ** 2 + (a.y - b.y) ** 2 > r2) continue;
          if (a.hx * b.hx + a.hy * b.hy > OPPOSITE_DOT) continue;
          hit = true;
          break;
        }
      }
    }
    if (hit) flaggedPerSeg[a.seg]!++;
  }

  for (let i = 0; i < segCount; i++) {
    flags[i] = perSeg[i]! > 0 && flaggedPerSeg[i]! / perSeg[i]! >= 0.5;
  }
  return flags;
}

/** Share of the route's length that doubles back on itself: 0 = clean loop. */
export function doubledBackShare(coords: [number, number][]): number {
  const flags = doubledBackSegments(coords);
  const lens = segmentLengths(coords);
  let total = 0;
  let doubled = 0;
  lens.forEach((len, i) => {
    total += len;
    if (flags[i]) doubled += len;
  });
  return total > 0 ? doubled / total : 0;
}

export interface LoopSplit {
  /** Point index where the loop proper begins (end of the outbound stem). */
  startPoint: number;
  /** Point index where the loop proper ends (start of the return stem). */
  endPoint: number;
  /** One-way stem length. The stem is walked out and back, like an approach. */
  stemM: number;
  /** Doubling back inside the loop proper. The caller decides what to allow. */
  internalDoubledM: number;
}

/**
 * Split a route into stem + loop. round_trip from a cul-de-sac typically walks
 * out to a through street, loops, and walks back in the same way -- a lollipop.
 * The stem is doubling back, but under the 2A + N*L distance model it is simply
 * the approach: walked once out, once home, not part of the laps. Only the loop
 * proper has to be clean.
 *
 * Returns null when the doubling back is not a stem at both ends -- for example
 * a spur into a dead end halfway round -- since that cannot be cut away.
 */
export function splitLollipop(coords: [number, number][]): LoopSplit | null {
  const flags = doubledBackSegments(coords);
  const lens = segmentLengths(coords);
  const n = flags.length;

  let a = 0;
  while (a < n && flags[a]) a++;
  if (a === n) return null; // doubles back end to end: an out-and-back
  let b = n - 1;
  while (b > a && flags[b]) b--;

  const stemOut = lens.slice(0, a).reduce((x, y) => x + y, 0);
  const stemBack = lens.slice(b + 1).reduce((x, y) => x + y, 0);
  const mismatch = Math.abs(stemOut - stemBack);
  if (mismatch > STEM_MISMATCH_M + 0.25 * Math.max(stemOut, stemBack)) return null;

  const gap = haversineMeters(
    { lon: coords[a]![0], lat: coords[a]![1] },
    { lon: coords[b + 1]![0], lat: coords[b + 1]![1] },
  );
  if (gap > MAX_JUNCTION_GAP_M) return null;

  const loopM = lens.slice(a, b + 1).reduce((x, y) => x + y, 0);
  if (loopM < MIN_LOOP_M) return null;

  let internalDoubledM = 0;
  for (let i = a; i <= b; i++) if (flags[i]) internalDoubledM += lens[i]!;

  return {
    startPoint: a,
    endPoint: b + 1,
    stemM: (stemOut + stemBack) / 2,
    internalDoubledM,
  };
}

/**
 * How round a loop is: 4*pi*area / perimeter^2. A circle is 1, a square 0.79,
 * a 4:1 rectangle 0.5, and a sliver that runs up one street and back down the
 * next approaches 0. It separates "a loop as imagined" from a thin hairpin that
 * technically never doubles back.
 */
export function roundness(coords: [number, number][]): number {
  if (coords.length < 4) return 0;
  const pts = project(coords);
  let area2 = 0;
  let perimeter = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[(i + 1) % pts.length]!;
    area2 += x0 * y1 - x1 * y0;
    perimeter += Math.hypot(x1 - x0, y1 - y0);
  }
  if (perimeter === 0) return 0;
  return Math.min(1, (4 * Math.PI * Math.abs(area2 / 2)) / perimeter ** 2);
}
