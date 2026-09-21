import assert from "node:assert/strict";
import { test } from "node:test";
import { doubledBackShare, roundness, splitLollipop } from "./shape.js";

// Near the Leander library. At this latitude 0.001 deg of latitude is ~111 m
// and 0.001 deg of longitude is ~96 m.
const LON = -97.88;
const LAT = 30.58;
type C = [number, number];

/** Square loop, ~385 x 400 m, clockwise from the south-west corner. */
const square: C[] = [
  [LON, LAT],
  [LON, LAT + 0.0036],
  [LON + 0.004, LAT + 0.0036],
  [LON + 0.004, LAT],
  [LON, LAT],
];

test("a clean loop does not double back", () => {
  assert.equal(doubledBackShare(square), 0);
  const split = splitLollipop(square);
  assert.ok(split);
  assert.equal(split.stemM, 0);
  assert.equal(split.internalDoubledM, 0);
});

test("an out-and-back doubles back along its whole length", () => {
  const outAndBack: C[] = [[LON, LAT], [LON + 0.004, LAT], [LON + 0.008, LAT], [LON + 0.004, LAT], [LON, LAT]];
  assert.ok(doubledBackShare(outAndBack) > 0.9);
  assert.equal(splitLollipop(outAndBack), null);
});

test("up one sidewalk and back down the other is still doubling back", () => {
  // East along one side, ~17 m across, west along the other: two different map
  // ways, the same road to a runner.
  const acrossRoad = 0.00015;
  const route: C[] = [
    [LON, LAT],
    [LON + 0.004, LAT],
    [LON + 0.004, LAT + acrossRoad],
    [LON, LAT + acrossRoad],
  ];
  assert.ok(doubledBackShare(route) > 0.9, `share ${doubledBackShare(route)}`);
  assert.equal(splitLollipop(route), null, "the 17 m crossover is not a loop");
});

test("parallel streets a block apart are a loop, not doubling back", () => {
  const blockApart = 0.00072; // ~80 m
  const narrowLoop: C[] = [
    [LON, LAT],
    [LON + 0.006, LAT],
    [LON + 0.006, LAT + blockApart],
    [LON, LAT + blockApart],
    [LON, LAT],
  ];
  assert.equal(doubledBackShare(narrowLoop), 0);
});

test("a lollipop splits into a stem and a clean loop", () => {
  const stemStart: C = [LON - 0.004, LAT]; // ~385 m west of the loop
  const lollipop: C[] = [stemStart, ...square, stemStart];
  const split = splitLollipop(lollipop);
  assert.ok(split);
  assert.ok(Math.abs(split.stemM - 385) < 20, `stem ${split.stemM}`);
  assert.equal(split.internalDoubledM, 0);
  assert.deepEqual(lollipop[split.startPoint], [LON, LAT]);
  assert.deepEqual(lollipop[split.endPoint], [LON, LAT]);
});

test("a dead-end spur partway round is reported as doubling back inside the loop", () => {
  // Square with a ~200 m out-and-back spur off its east side.
  const spurTip: C = [LON + 0.004 + 0.0021, LAT + 0.0018];
  const withSpur: C[] = [
    [LON, LAT],
    [LON, LAT + 0.0036],
    [LON + 0.004, LAT + 0.0036],
    [LON + 0.004, LAT + 0.0018],
    spurTip,
    [LON + 0.004, LAT + 0.0018],
    [LON + 0.004, LAT],
    [LON, LAT],
  ];
  const split = splitLollipop(withSpur);
  assert.ok(split, "no stem to cut, so it splits with the spur inside");
  assert.ok(split.internalDoubledM > 250, `internal ${split.internalDoubledM}`);
});

test("roundness separates a loop from a hairpin", () => {
  const sq = roundness(square);
  assert.ok(sq > 0.75 && sq < 0.8, `square ${sq}`);
  const hairpin: C[] = [
    [LON, LAT],
    [LON + 0.02, LAT],
    [LON + 0.02, LAT + 0.00072],
    [LON, LAT + 0.00072],
    [LON, LAT],
  ];
  assert.ok(roundness(hairpin) < 0.2, `hairpin ${roundness(hairpin)}`);
});
