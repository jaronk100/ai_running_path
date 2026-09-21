export const config = {
  port: Number(process.env.PORT ?? 8080),

  /** Self-hosted GraphHopper. Profile name must match routing/config.yml. */
  graphhopperUrl: process.env.GRAPHHOPPER_URL ?? "http://localhost:8989",
  profile: "running",

  /** US Census geocoder: free, no key, US-only, good on street addresses. */
  censusGeocodeUrl:
    "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress",

  search: {
    /** Hard gate from the spec: a route is only a match within this band. */
    distanceToleranceMi: 0.1,
    /** Furthest a loop start may sit from home. Most runners want far less. */
    maxApproachCapMi: 5,
    /** Candidate loop start points sampled around the home point. */
    approachSamples: 12,
    /** round_trip seeds tried per loop start point. Seed is the only source of
     *  shape variety, so this sets how many distinct loops each start offers. */
    seedsPerStart: 20,
    /**
     * Ceiling on seed searches per request. Each costs up to 6 GraphHopper
     * calls at ~7 ms, and about 1 in 5 lands a loop inside the tolerance.
     * Taken closest-start-first, so trimming drops what the scorer ranks lowest.
     */
    maxLoopSeeds: 160,
    /** A "loop" with more than this share of streets run twice is really an
     *  out-and-back, and is dropped from loop results. */
    maxLoopRetrace: 0.5,
    /** Two candidates sharing more than this fraction of geometry are dupes. */
    maxGeometryOverlap: 0.6,
    resultsPerPage: 5,
  },
} as const;
