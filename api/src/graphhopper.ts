import { config } from "./config.js";
import type { GHPath, LatLng } from "./types.js";

const DETAILS = [
  "road_class",
  "surface",
  "max_speed",
  "footway",
  "crossing",
  "average_slope",
  "osm_way_id",
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

// NOTE: GraphHopper's algorithm=round_trip was removed deliberately. Measured
// against the Austin extract it returned 0.70x-8.59x the requested distance and
// hit the +/-0.1 mi gate once in 48 tries. See loops.ts for what replaced it.

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

/** Distinct point-to-point alternatives, for out-and-back variety. */
export async function alternatives(
  from: LatLng,
  to: LatLng,
  maxPaths: number,
): Promise<GHPath[]> {
  try {
    const { paths } = await post({
      ...baseBody,
      points: [
        [from.lon, from.lat],
        [to.lon, to.lat],
      ],
      algorithm: "alternative_route",
      "alternative_route.max_paths": maxPaths,
      "alternative_route.max_share_factor": 0.5,
      "alternative_route.max_weight_factor": 1.6,
    });
    return paths;
  } catch (err) {
    if (err instanceof GraphHopperError && err.status < 500) return [];
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
