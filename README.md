# RunPath

Running-route generator. Finds loop and out-and-back footpaths near an address,
preferring sidewalks and quiet streets, hard-excluding freeways.

## Distance model

    Total run = 2A + (N x L)

- `A` — approach distance, house to loop start (walking distance, not crow-flies)
- `L` — the loop itself; this is what the user requests, and it excludes `A`
- `N` — laps, chosen after a route is selected

Out-and-back routes start at the door, so `A = 0` and the requested distance is
the full there-and-back.

## Stack

| Layer | Choice |
|---|---|
| Route data | OpenStreetMap (Geofabrik / BBBike extract) |
| Routing | Self-hosted GraphHopper, `foot` profile + custom model |
| Enrichment + scoring | This repo's `api/` service (TypeScript) |
| App | Expo / React Native -> Play Store |

## Why GraphHopper and not Valhalla

GraphHopper has native round-trip generation (`algorithm=round_trip`), which is
the hard part of this app. It cannot read OSM `sidewalk=*` as a routable value
without patching Java source, so sidewalk quality is applied in `api/src/enrich.ts`
as a ranking signal instead, joined via the `osm_way_id` encoded value.

Safety (the actual requirement) is handled natively in the custom model through
`road_class` and `max_speed`, which are built in.

## How the data actually flows

The map extract is **build-time input for the server**. No phone ever downloads
OSM data.

    Once, on the server:   Austin .pbf  ->  GraphHopper import  ->  routing graph
    Every search:          phone {address, distance, type}  ->  api  ->  GraphHopper  ->  coordinates

Three separate streams, easy to conflate:

| Stream | Lives where | Fetched when | Purpose |
|---|---|---|---|
| Routing graph | Server, in RAM | Built once at startup | Computing routes |
| Map tiles | Tile provider -> phone | Live, as the user pans | Displaying the map picture |
| Sidewalk tags | Overpass -> server cache | On demand, cached | Scoring routes |

Only map tiles are fetched by the phone, and they are unrelated to GraphHopper.

**OpenStreetMap** is the data. **BBBike** and **Geofabrik** are delivery
services that cut a geographic slice out of it — they add nothing. **GraphHopper**
is the engine that turns that slice into a graph and searches it.

The extract is a snapshot: new trails and closed streets will not appear until
you re-download and re-import. Refresh quarterly (swap the file, delete
`routing/graph-cache/`).

## Search radius

`maxApproachMi` is capped at 5 miles (`config.search.maxApproachCapMi`). Typical
requests sit at 0.1-0.5 mi. Because scoring punishes approach distance steeply,
start-point sampling is biased toward home rather than spread evenly, and the
per-search round_trip budget takes closest starts first.
