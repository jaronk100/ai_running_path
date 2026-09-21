import { config } from "./config.js";
import type { GHPath, LatLng } from "./types.js";

const DETAILS = [
  "road_class",
  "surface",
  "max_speed",
  "footway",
  "crossing",
];

class GraphHopperError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GraphHopperError";
  }
}

async function post(body: unknown): Promise<{ paths: GHPath[] }> {
  const res = await fetch(`${config.graphhopperUrl}/route`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GraphHopperError(
      `GraphHopper ${res.status}: ${text.slice(0, 400)}`,
      res.status,
    );
  }
  return (await res.json()) as { paths: GHPath[] };
}

const baseBody = {
  profile: config.profile,
  points_encoded: false,
  instructions: false,
  elevation: true,
  details: DETAILS,
  "ch.disable": true,
};

/**
 * One round_trip loop from `start`. Its length is only loosely related to
 * `distanceMeters` -- loops.ts searches the request value per seed to land the
 * tolerance. `seed` is the only lever for shape variety: the same seed and
 * distance always return the same loop.
 */
export async function roundTrip(
  start: LatLng,
  distanceMeters: number,
  seed: number,
): Promise<GHPath | null> {
  try {
    const { paths } = await post({
      ...baseBody,
      points: [[start.lon, start.lat]],
      algorithm: "round_trip",
      "round_trip.distance": Math.max(200, Math.round(distanceMeters)),
      "round_trip.seed": seed,
    });
    return paths[0] ?? null;
  } catch (err) {
    // A seed that lands in a dead end is normal, not exceptional. Only a
    // transport-level failure should stop the whole search.
    if (err instanceof GraphHopperError && err.status < 500) return null;
    throw err;
  }
}

/** Plain point-to-point route. Used for the approach leg and out-and-back legs. */
export async function route(points: LatLng[]): Promise<GHPath | null> {
  try {
    const { paths } = await post({
      ...baseBody,
      points: points.map((p) => [p.lon, p.lat]),
    });
    return paths[0] ?? null;
  } catch (err) {
    if (err instanceof GraphHopperError && err.status < 500) return null;
    throw err;
  }
}

export async function health(): Promise<boolean> {
  try {
    const res = await fetch(`${config.graphhopperUrl}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

export { GraphHopperError };
