# RunPath

Running-route generator. Finds loop and out-and-back routes near an address,
preferring quiet streets and trails, hard-excluding freeways.

**To see it working:** double-click `start.cmd`, then use the route viewer it
opens at <http://localhost:8080/viewer>. Details in [docs/setup.md](docs/setup.md).

## Distance model

    Total run = 2A + (N x L)

- `A` — approach distance, house to loop start (walking distance, not crow-flies)
- `L` — the loop itself; this is what the user requests, and it excludes `A`
- `N` — laps, chosen after a route is selected

Out-and-back routes start at the door, so `A = 0` and the requested distance is
the full there-and-back.

## Ranking

Every result is already within +/- 0.1 mi of the requested distance — that is a
hard gate, not a score. Among those, three terms (`api/src/scoring.ts`):

| Term | Weight | Measures |
|---|---|---|
| Approach | 55 | How close the loop starts to the address. Dominant by spec. |
| Traffic | 30 | Road class and posted speed along the route, minus busy-road crossings. |
| Shape | 15 | How much of a loop repeats streets. 0% is a true loop. |

Elevation is reported, never ranked. Sidewalk and streetlight data were dropped:
in the Leander/Cedar Park extract they were effectively absent, so the traffic
term carries the "quiet streets are fine without sidewalks, busy ones are not"
rule using road class and speed, which OSM has everywhere.

## Stack

| Layer | Choice |
|---|---|
| Route data | OpenStreetMap (BBBike / Geofabrik extract) |
| Routing | Self-hosted GraphHopper 11, `running` profile + custom model |
| Loop generation, scoring | This repo's `api/` service (TypeScript) |
| App | Expo / React Native -> Play Store (not started) |

## How loops are generated

GraphHopper's `round_trip` makes genuine loops — it penalises streets it has
already used, so the way back differs from the way out — but its length control
is poor (0.7x to 8.6x the requested distance). `api/src/loops.ts` keeps its
shapes and fixes the length: for each random seed it rescales the requested
distance by how far the last attempt missed, until one lands in tolerance.

A simpler approach was tried first and dropped: placing via points on a polygon
around the start and sizing the polygon to hit the distance. It hit the
distance reliably, but in cul-de-sac suburbia every via point landed in a
separate residential pod reachable only one way, so the "loops" were ~100%
out-and-back. Only drawing them on a map showed it.

## How the data actually flows

The map extract is **build-time input for the server**. No phone ever downloads
OSM data.

    Once, on the server:   .pbf extract  ->  GraphHopper import  ->  routing graph
    Every search:          phone {address, distance, type}  ->  api  ->  GraphHopper  ->  coordinates

| Stream | Lives where | Fetched when | Purpose |
|---|---|---|---|
| Routing graph | Server, in RAM | Built once at startup | Computing routes |
| Map tiles | Tile provider -> phone | Live, as the user pans | Displaying the map picture |

**OpenStreetMap** is the data. **BBBike** and **Geofabrik** are delivery
services that cut a geographic slice out of it — they add nothing. **GraphHopper**
is the engine that turns that slice into a graph and searches it.

The extract is a snapshot: new trails and closed streets will not appear until
you re-download and re-import. Refresh quarterly (swap the file, delete
`routing/graph-cache/`).

## Search radius

`maxApproachMi` is capped at 5 miles (`config.search.maxApproachCapMi`). Typical
requests sit at 0.1-0.5 mi. Start points are sampled biased toward home, and the
per-search seed budget is spent closest-start-first, matching the ranking.
