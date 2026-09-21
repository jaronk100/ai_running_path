import assert from "node:assert/strict";
import { test } from "node:test";
import { cancelBacktracks, slicePath, startNearest } from "./loops.js";
import { doubledBackShare } from "./shape.js";
import type { GHPath } from "./types.js";

const LON = -97.88;
const LAT = 30.58;

test("a dead-end spur is cut out and the loop around it kept", () => {
  const eastMid: [number, number, number] = [LON + 0.004, LAT + 0.0018, 250];
  const path: GHPath = {
    distance: 0,
    time: 0,
    points: {
      coordinates: [
        [LON, LAT, 250],
        [LON, LAT + 0.0036, 252],
        [LON + 0.004, LAT + 0.0036, 255],
        eastMid,
        [LON + 0.0061, LAT + 0.0018, 260], // spur tip: a cul-de-sac
        eastMid,
        [LON + 0.004, LAT, 251],
        [LON, LAT, 250],
      ],
    },
    details: {
      road_class: [
        [0, 3, "residential"],
        [3, 5, "service"],
        [5, 7, "residential"],
      ],
    },
  };

  const cleaned = cancelBacktracks(path);
  const coords = cleaned.points.coordinates.map(([lon, lat]) => [lon, lat] as [number, number]);

  assert.equal(coords.length, 6, "spur tip and its duplicate junction removed");
  assert.equal(doubledBackShare(coords), 0);
  assert.deepEqual(cleaned.details?.road_class, [[0, 5, "residential"]], "the spur's class went with it");
  assert.ok(cleaned.distance > 1400 && cleaned.distance < 1650, `perimeter ${cleaned.distance}`);
});

test("a route with nothing to cancel comes back unchanged", () => {
  const path: GHPath = {
    distance: 1,
    time: 0,
    points: { coordinates: [[LON, LAT], [LON, LAT + 0.001], [LON + 0.001, LAT + 0.001], [LON, LAT]] },
  };
  assert.equal(cancelBacktracks(path), path);
});

test("slicing keeps only the requested points and re-indexes details", () => {
  const path: GHPath = {
    distance: 0,
    time: 0,
    points: { coordinates: [[LON, LAT], [LON, LAT + 0.001], [LON, LAT + 0.002], [LON, LAT + 0.003]] },
    details: { road_class: [[0, 1, "service"], [1, 3, "residential"]] },
  };
  const part = slicePath(path, 1, 3);
  assert.equal(part.points.coordinates.length, 3);
  assert.deepEqual(part.details?.road_class, [[0, 2, "residential"]]);
});

test("a loop re-starts at its point nearest the address, unchanged otherwise", () => {
  const loop: GHPath = {
    distance: 0,
    time: 0,
    points: {
      coordinates: [
        [LON, LAT],
        [LON, LAT + 0.0036],
        [LON + 0.004, LAT + 0.0036],
        [LON + 0.004, LAT],
        [LON, LAT],
      ],
    },
    details: { road_class: [[0, 2, "residential"], [2, 4, "path"]] },
  };
  const before = slicePath(loop, 0, 4);
  // The runner lives just outside the north-east corner.
  const after = startNearest(before, { lon: LON + 0.0041, lat: LAT + 0.0037 });

  assert.deepEqual(after.points.coordinates[0], [LON + 0.004, LAT + 0.0036]);
  assert.deepEqual(after.points.coordinates.at(-1), [LON + 0.004, LAT + 0.0036]);
  assert.ok(Math.abs(after.distance - before.distance) < 0.01, "same loop, same length");
  // The segment classes travel with their segments.
  assert.deepEqual(after.details?.road_class, [[0, 2, "path"], [2, 4, "residential"]]);
});

test("a loop that does not close exactly is left where it starts", () => {
  const open: GHPath = {
    distance: 0,
    time: 0,
    points: { coordinates: [[LON, LAT], [LON, LAT + 0.0036], [LON + 0.004, LAT + 0.0036], [LON + 0.004, LAT], [LON, LAT + 0.0003]] },
  };
  assert.equal(startNearest(open, { lon: LON + 0.004, lat: LAT + 0.0036 }), open);
});
