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
