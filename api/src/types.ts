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
    average_slope?: DetailInterval<number | null>[];
    osm_way_id?: DetailInterval<number>[];
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

  /** Dedicated footway/path/pedestrian — a sidewalk drawn as its own way. */
  dedicatedFootwayPct: number;
  /** Roadway carrying sidewalk=both|left|right in OSM. */
  taggedSidewalkPct: number;
  /** Roadway explicitly tagged sidewalk=no. */
  noSidewalkPct: number;
  /** Roadway with no sidewalk information at all. Not a failure — Austin OSM
   *  coverage is partial, and the spec says never to exclude on this. */
  unknownSidewalkPct: number;

  /** Share with lit=yes. Reported, never used to exclude. */
  litPct: number;
  litKnownPct: number;

  /** Share on roads posted above 35 mph — the real safety signal. */
  highSpeedPct: number;
  /** Share on primary/secondary. */
  busyRoadPct: number;

  /** Crossings of primary/secondary/tertiary roads. Drives the safety penalty. */
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
  /** Populated only when enrichment could reach Overpass. */
  sidewalkDataAvailable: boolean;
}
