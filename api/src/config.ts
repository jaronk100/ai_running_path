export const config = {
  port: Number(process.env.PORT ?? 8080),

  /** Self-hosted GraphHopper. Profile name must match routing/config.yml. */
  graphhopperUrl: process.env.GRAPHHOPPER_URL ?? "http://localhost:8989",
  profile: "running",

  /**
   * Overpass supplies the OSM sidewalk=* tags that GraphHopper cannot expose as
   * an encoded value. Enrichment degrades gracefully if this is unreachable —
   * see enrich.ts. Swap for a private instance before public launch; the public
   * endpoint is rate-limited and will not survive real traffic.
   */
  overpassUrl: process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter",
  overpassTimeoutMs: 12_000,

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
    /**
     * Ceiling on loop-generation attempts per search. Each attempt is a
     * bisection costing up to 9 GraphHopper calls and converges ~37% of the
     * time, so ~48 attempts yields roughly 15 usable loops. Taken
     * closest-start-first, so trimming drops what the scorer ranks lowest.
     */
    maxLoopAttempts: 48,
    /** Two candidates sharing more than this fraction of geometry are dupes. */
    maxGeometryOverlap: 0.6,
    resultsPerPage: 5,
  },
} as const;
