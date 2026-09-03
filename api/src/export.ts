import { segmentLengths } from "./geo.js";

/**
 * Google's Maps URL scheme accepts at most 9 intermediate waypoints. A running
 * loop has hundreds of points, so anything handed to Google is necessarily a
 * skeleton that Google then re-routes between using its own walking directions.
 * The drawn path may not match the scouted path. GPX is the faithful export;
 * this one is a convenience and the UI labels it as approximate.
 */
const GOOGLE_MAX_WAYPOINTS = 9;

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function toGpx(
  coordinates: [number, number][],
  name: string,
  elevations?: (number | undefined)[],
): string {
  const points = coordinates
    .map(([lon, lat], i) => {
      const ele = elevations?.[i];
      const eleTag = ele === undefined ? "" : `<ele>${ele.toFixed(1)}</ele>`;
      return `      <trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}">${eleTag}</trkpt>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="RunPath" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${escapeXml(name)}</name></metadata>
  <trk>
    <name>${escapeXml(name)}</name>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>
`;
}

/**
 * Pick `count` points spread evenly by distance along the path rather than by
 * array index. Index-spacing clusters samples wherever GraphHopper emitted
 * dense geometry (tight corners) and starves the long straight stretches.
 */
export function simplifyByDistance(
  coordinates: [number, number][],
  count: number,
): [number, number][] {
  if (coordinates.length <= count) return [...coordinates];
  if (count <= 0) return [];

  const lens = segmentLengths(coordinates);
  const total = lens.reduce((a, b) => a + b, 0);
  if (total === 0) return [coordinates[0]!];

  const picked: [number, number][] = [];
  const step = total / (count + 1);
  let target = step;
  let travelled = 0;

  for (let i = 0; i < lens.length && picked.length < count; i++) {
    travelled += lens[i]!;
    if (travelled >= target) {
      picked.push(coordinates[i + 1]!);
      target += step;
    }
  }
  return picked;
}

export function googleMapsUrl(
  coordinates: [number, number][],
  approach: [number, number][] = [],
): string | null {
  const full = [...approach, ...coordinates];
  const first = full[0];
  const last = full.at(-1);
  if (!first || !last) return null;

  const fmt = ([lon, lat]: [number, number]) =>
    `${lat.toFixed(6)},${lon.toFixed(6)}`;

  const middle = full.slice(1, -1);
  const waypoints = simplifyByDistance(middle, GOOGLE_MAX_WAYPOINTS);

  const url = new URL("https://www.google.com/maps/dir/");
  url.searchParams.set("api", "1");
  url.searchParams.set("origin", fmt(first));
  url.searchParams.set("destination", fmt(last));
  url.searchParams.set("travelmode", "walking");
  if (waypoints.length > 0) {
    url.searchParams.set("waypoints", waypoints.map(fmt).join("|"));
  }
  return url.toString();
}

/** Total distance for N laps: 2A + (N x L). */
export function totalRunMiles(
  approachMi: number,
  loopMi: number,
  laps: number,
): number {
  return 2 * approachMi + laps * loopMi;
}
