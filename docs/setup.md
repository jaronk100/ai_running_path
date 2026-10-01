# Setup

## Quick start

Double-click **`start.cmd`** in the `runpath` folder. It:

1. starts GraphHopper in its own window (skipped if already running),
2. starts the API in another window (skipped if already running),
3. waits until both answer, then opens <http://localhost:8080/viewer>.

Close the two server windows to stop everything. Re-running `start.cmd` while
they are up just opens the viewer again.

The first start after swapping the map file takes a few minutes while
GraphHopper builds its graph. After that it starts in seconds.

## The route viewer

<http://localhost:8080/viewer> — enter an address, a distance and a path type,
and the top five routes are drawn on a map in different colours. Click a route
card (or a line) to highlight it and zoom in. Dashed lines are the walk from
the address to where a loop starts. "Next 5 routes" pages through the rest.

It is a development tool for judging route quality by eye — the thing no
metric replaces — not the app itself.

## Setting up on a new machine

The repo carries the code and config. Four things it deliberately does not,
because they are large, licensed elsewhere, or rebuildable in seconds:

| Missing piece | How to get it | Size |
|---|---|---|
| Java 17+ | `winget install EclipseAdoptium.Temurin.21.JDK` | ~200 MB |
| Node 20+ | `winget install OpenJS.NodeJS.LTS` | ~60 MB |
| GraphHopper jar | `graphhopper-web-11.0.jar` from the [releases page](https://github.com/graphhopper/graphhopper/releases), saved into `routing/` | 47 MB |
| Map extract | a BBBike extract saved as `routing/data/region.osm.pbf` | ~5 MB |
| `api/node_modules/` | `cd api && npm install` | — |
| `routing/graph-cache/` | built automatically on first start | — |

From nothing to routes on a map:

```bash
git clone https://github.com/jaronk100/ai_running_path
```

1. Install Java and Node with the commands above, then **open a new terminal** —
   PATH changes do not reach terminals that were already open.
2. Download the GraphHopper jar into `routing/`.
3. Get a map extract from <https://extract.bbbike.org/> (draw a box, format
   "Protocolbuffer (PBF)") and save it as `routing/data/region.osm.pbf`. The one
   used so far covers Leander/Cedar Park, 30.51-30.61 N, 97.77-97.96 W.
4. `cd api && npm install`
5. Double-click `start.cmd`.

The first start imports the extract and takes about 7 seconds for that area;
later starts reuse `routing/graph-cache/` and are instant.

## Changing the map area

Get a new extract from <https://extract.bbbike.org/> (draw a box, format
"Protocolbuffer (PBF)"), or a whole state from Geofabrik:

```bash
curl -L -o routing/data/region.osm.pbf https://download.geofabrik.de/north-america/us/texas-latest.osm.pbf
```

Save it as `routing/data/region.osm.pbf`, **delete `routing/graph-cache/`**,
and restart. Skipping the delete makes GraphHopper silently reuse the old graph.

The same delete-and-restart is needed after editing **either**
`graph.encoded_values` in `routing/config.yml` **or** the routing model
`routing/custom_models/running.json`. For the routing model GraphHopper is not
silent: it refuses to start with "Profiles do not match". The rebuild took
about 7 seconds for the Leander/Cedar Park extract.

## Running pieces by hand

```bash
cd routing && java -Xmx4g -jar graphhopper-web-11.0.jar server config.yml
```

```bash
cd api && npm install && npm run dev
```

```bash
curl -s -X POST http://localhost:8080/search -H "content-type: application/json" -d "{\"address\":\"550 Discovery Blvd, Cedar Park, TX 78613\",\"distanceMi\":2.0,\"pathType\":\"loop\",\"maxApproachMi\":0.4}"
```

## Tests

```bash
cd api && npm test
```

Twenty-nine tests covering the hard rules (doubling back, including the
opposite-sidewalk case; hairpins; parking lots; major roads), stem and spur
handling, re-starting a loop near the address, busy-crossing counting, ranking,
and the `2A + (N x L)` math. They run without GraphHopper.

## Known limits, honestly

- **Some distances have no loop.** Loops that follow every rule come in the
  sizes the street network allows. From the Leander library (start within
  0.4 mi): 1.5, 2 and 4 mi have loops; 2.5, 3, 4.5 and 5 mi have none — every
  right-length loop doubled back somewhere. The viewer reports how many
  right-length routes each rule excluded, so an empty result explains itself.
- **Searches take 4-8 s**, most of it trying seeds that turn out to double back.
  Quadrupling the attempts (to 12-19 s) found almost nothing more; past this
  point the limit is the streets, not the budget.
- **Parking lots are recognised only as service roads.** OSM tags parking
  aisles as `highway=service`, and GraphHopper has no value separating them
  from driveways and alleys. Loops over 10% service road are dropped, which also
  drops the occasional loop using a legitimate alley.
- **Busy-crossing counts are inferred.** A signalised crossing counts as busy
  (signals clustered within 60 m count once); elsewhere, a short hop onto a
  primary/secondary/tertiary road does. Unsignalised crossings of busy roads
  via a mapped crosswalk are still missed: the 4 mi Leander loop crosses San
  Gabriel Pkwy twice and reports 0.
- **Road class is not sidewalk.** A loop along a primary road ranks low even
  where that road has a good sidewalk, because sidewalk data was dropped.
- **The Google Maps link is approximate by construction.** Google's URL scheme
  caps at 9 waypoints, so it re-routes between a skeleton of the route. GPX is
  the faithful export.
- **Geocoding leans on Nominatim, whose usage policy allows 1 request/second.**
  Requests are queued and cached to respect that, which is fine for testing but
  will not carry real traffic. Before launch, self-host Nominatim or Photon, or
  pay for a geocoder; the swap is confined to `api/src/geocode.ts`.
- **Geocoders disagree, and are sometimes confidently wrong.** Answers are now
  checked against the query, so a bad one is reported as "could not find"
  rather than quietly moving the search 2 miles. The cost is that an unusual
  but correct answer can be rejected too.
