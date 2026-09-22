export const config = {
  port: Number(process.env.PORT ?? 8080),

  /** Self-hosted GraphHopper. Profile name must match routing/config.yml. */
  graphhopperUrl: process.env.GRAPHHOPPER_URL ?? "http://localhost:8989",
  profile: "running",

  /** Sent to every third-party service. Overpass and Nominatim both require a
   *  real one; Node's default gets a 406 from Overpass and is against
   *  Nominatim's usage policy. */
  userAgent: "RunPath/0.1 (running route planner)",

  /** OSM geocoder: knows place names and newer addresses, and returns a
   *  structured address that can be checked against the query. Usage policy
   *  caps this at 1 request/second -- see geocode.ts. */
  nominatimUrl: "https://nominatim.openstreetmap.org/search",

  /** US Census geocoder, the fallback: street addresses only, and it will
   *  answer the wrong street rather than nothing, so its answers are checked. */
  censusGeocodeUrl:
    "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress",

  search: {
    /**
     * A route counts as the requested distance within this fraction of it:
     * +/-0.2 mi on a 2 mi loop, +/-0.5 mi on a 5 mi one. Being over is no worse
     * than being under -- the ranking simply prefers whichever is closest.
     */
    distanceTolerancePct: 0.1,
    /** Furthest a loop start may sit from home. Most runners want far less. */
    maxApproachCapMi: 5,
    /** Candidate loop start points sampled around the home point. */
    approachSamples: 12,
    /** round_trip seeds tried per loop start point. Seed is the only source of
     *  shape variety, so this sets how many distinct loops each start offers. */
    seedsPerStart: 40,
    /**
     * Ceiling on seed searches per request. Each costs up to 6 GraphHopper
     * calls at ~7 ms. Taken closest-start-first, so trimming drops what the
     * scorer ranks lowest. Measured from the Leander library: 160 -> 320 took
     * 4 mi loops from 2 to 3 at ~5 s a search; 640 added little more at 12-19 s.
     * Past this point the limit is the street network, not the budget.
     */
    maxLoopSeeds: 320,
    /** Two candidates sharing more than this fraction of geometry are dupes. */
    maxGeometryOverlap: 0.6,
    resultsPerPage: 5,
  },

  /**
   * Hard rules. A route breaking any of these is dropped, never merely ranked
   * lower -- each one is something the user has said they do not want to run.
   */
  gates: {
    /** A loop may not double back. This much is tolerated only for geometry
     *  noise, such as crossing a divided road at the loop's own junction. */
    maxLoopDoubleBackM: 30,
    /** Primary/secondary roads. Enough to cross or briefly connect, not to run
     *  along: 38% put an otherwise good loop out of contention. */
    maxMajorRoadShare: 0.1,
    /** Service roads, which is how OSM tags parking-lot aisles -- GraphHopper
     *  cannot tell the two apart. Loops only: an out-and-back from a library
     *  necessarily starts in its car park, and cannot circle one. */
    maxLoopServiceShare: 0.1,
    /** Roundness (4*pi*area / perimeter^2) below this is a hairpin: out along one
     *  way and back along a parallel one just beyond the 25 m same-road reach --
     *  a divided road, or a frontage road. Real loops here measure 0.3-0.55;
     *  the hairpin that prompted this measured 0.06. */
    minLoopRoundness: 0.15,
  },
} as const;
