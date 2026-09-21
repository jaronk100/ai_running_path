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

## Hard rules

A route breaking any of these is dropped, never merely ranked lower
(`gateFailure` in `api/src/scoring.ts`, thresholds in `config.gates`):

| Rule | Applies to | Detail |
|---|---|---|
| Distance within +/- 0.1 mi | both | For a loop, measured on the loop proper, excluding the walk to it. |
| No freeways | both | Motorway/trunk, excluded three separate ways. |
| No running along major roads | both | Primary/secondary at most 10% of the route: enough to cross or connect. |
| Never doubles back | loops | No stretch covered again in the opposite direction within 25 m, so the far sidewalk counts. 30 m allowed for junction noise. |
| No hairpins | loops | Roundness below 0.15 means out one way and back a parallel way just beyond 25 m. |
| No parking lots | loops | Service roads at most 10%. OSM tags parking aisles as service roads. |

## Ranking

Among routes that pass, three terms (`api/src/scoring.ts`):

| Term | Weight | Measures |
|---|---|---|
| Approach | 55 | How close the loop starts to the address. Dominant by spec. |
| Traffic | 30 | Road class and posted speed along the route, minus busy-road crossings. |
| Shape | 15 | Roundness — a loop as imagined, not a thin one. Out-and-backs score full. |

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

`api/src/loops.ts`, per random seed:

1. **GraphHopper `round_trip`** proposes a loop. It discourages reusing streets,
   so the way back usually differs from the way out, but its length control is
   poor (0.7x to 8.6x the request) — so the request is rescaled by how far each
   attempt missed, until one lands in tolerance.
2. **Spurs are cut out.** Where the route runs into a dead end and straight back
   out (to touch one of `round_trip`'s own turning points), that in-and-out is
   removed; the loop around it survives.
3. **The stem is split off.** A loop from a cul-de-sac is usually a lollipop.
   The stem is doubling back, but under `2A + N x L` it is simply the walk to
   the loop start, so it becomes the approach, and only the loop proper must be
   clean and on-distance.
4. **The loop is re-started nearest the address** (`startNearest`). A loop can
   be begun anywhere on itself; loops passing 20 m from the Leander library door
   were otherwise starting 0.1 mi away.

Tried and dropped, both measured: sizing a polygon of via points to hit the
distance (every via point landed in a separate cul-de-sac pod, so ~100% of each
"loop" doubled back), and building loops leg by leg with each leg avoiding the
corridor of the ones before (clean shapes, but the length jumped discontinuously
— 1.9 to 4.9 mi between neighbouring sizes — so almost none landed in tolerance).

### Loops come in the sizes the streets allow

From the Leander library, every clean loop found within 0.4 mi of the door was
one of: 1.25, 1.6, 1.9, 2.0-2.2, 2.5-3.0, 3.9-4.0, 4.5-4.6, 5.9 mi, then 6+.
Old-town Leander is boxed in by major roads with few links between
neighbourhoods; a loop inside one tops out near 3 mi, and a bigger one must run
along a major road or pass the same connector twice. So some requested
distances have no answer under the rules — the search then says how many
right-length routes each rule excluded.

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
