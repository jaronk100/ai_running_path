# The running custom model

`routing/custom_models/running.json` cannot carry comments — GraphHopper's
`CustomModel` rejects any key outside `priority`, `areas`, `speed`,
`distance_influence`, `heading_penalty` and `turn_penalty`, including a
`_comment`. So the rationale lives here.

## Statements compound

Consecutive `if` statements each apply, so the `max_speed` rules layer on top of
whichever `road_class` branch matched. A 45 mph secondary road gets
`0.3 * 0.5 * 0.2 = 0.03` — effectively excluded without being hard-banned.

The `else_if` chain in the middle is one branch: a way takes exactly one
road_class multiplier.

## Why sidewalk is not in here

GraphHopper cannot expose OSM `sidewalk=*` as an encoded value without patching
Java source ("It is not yet possible without modifying the source code"). It was
briefly fetched from Overpass instead, but in the Leander/Cedar Park extract
roadway sidewalk tags were effectively absent, so the feature was dropped.

What remains is the half of the requirement that has data everywhere: avoid
fast, busy roads. That is expressed here through `road_class` and `max_speed`,
and again in the traffic term of `api/src/scoring.ts`.

The `footway == SIDEWALK` boost stays. It is not a sidewalk feature — it just
keeps the router on a separately-drawn walkway rather than the carriageway
beside it, where such a walkway exists. It costs nothing where none does.

## Freeway exclusion runs three times

1. `import.osm.ignored_highways: motorway,trunk` drops them at import.
2. `multiply_by 0` here zeroes anything that survives.
3. `isDisqualified()` in `scoring.ts` rejects any candidate containing one.

Deliberate redundancy. It is the one hard constraint in the spec, and it should
not depend on a single mechanism holding.

## Speed block

`limit_to 6` pins everything to 6 km/h. Running routes are ranked on distance
and quality, never on predicted duration, so a uniform speed keeps
`distance_influence` behaving predictably across surfaces.
