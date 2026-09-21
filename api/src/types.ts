export type LatLng = { lat: number; lon: number };

export type PathType = "loop" | "out_and_back";

export interface SearchRequest {
  address: string;
  /** For a loop this is L (the loop alone, excluding approach). For an
   *  out-and-back it is the full there-and-back distance. */
  distanceMi: number;
  pathType: PathType;
  /** Max walking distance from home to the loop start. Ignored for
   *  out-and-back, which always starts at the door. */
  maxApproachMi?: number;
  page?: number;
}

/** One `details` interval from GraphHopper: [fromPointIdx, toPointIdx, value]. */
export type DetailInterval<T> = [number, number, T];

export interface GHPath {
  distance: number;
  time: number;
  ascend?: number;
  descend?: number;
  points: { coordinates: [number, number, number?][] };
  details?: {
    road_class?: DetailInterval<string>[];
    surface?: DetailInterval<string>[];
    max_speed?: DetailInterval<number | null>[];
    footway?: DetailInterval<string>[];
    crossing?: DetailInterval<string>[];
  };
}

/** Fraction-of-length breakdowns. Values sum to ~1 within each map. */
export interface RouteMetrics {
  distanceMi: number;
  elevationGainFt: number;
  elevationLossFt: number;

  /** Length-weighted share of the route on each road_class. */
  roadClassMix: Record<string, number>;
  surfaceMix: Record<string, number>;

  /** Share of length covered again in the opposite direction, judged by
   *  geometry so opposite sidewalks of one road count. 0 = never doubles back. */
  retracePct: number;
  /** 4*pi*area / perimeter^2 of the route. 1 = circle, ~0 = hairpin. */
  roundness: number;
  /** Share on car-free ways: footpaths, trails, separately-drawn walkways. */
  pathPct: number;
  /** Share on roads posted above 35 mph. */
  highSpeedPct: number;
  /** Share on primary/secondary. */
  busyRoadPct: number;

  /** Crossings of primary/secondary/tertiary roads. Penalised in scoring. */
  crossingsOfMajorRoads: number;
  /** Every pedestrian crossing including quiet corners. Informational only. */
  totalCrossings: number;
}

export interface RouteCandidate {
  id: string;
  pathType: PathType;
  /** Loop geometry (or the outbound+return line for out-and-back). */
  coordinates: [number, number][];
  /** Home -> loop start. Empty for out-and-back. */
  approachCoordinates: [number, number][];
  approachDistanceMi: number;
  loopDistanceMi: number;
  metrics: RouteMetrics;
  score: number;
  scoreBreakdown: Record<string, number>;
}
