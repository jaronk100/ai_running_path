import assert from "node:assert/strict";
import { test } from "node:test";
import type { EnrichedPath, SegmentInfo } from "./enrich.js";
import { geometryOverlap } from "./geo.js";
import { simplifyByDistance, totalRunMiles } from "./export.js";
import { approachScore, isDisqualified, scoreRoute } from "./scoring.js";
import type { RouteMetrics } from "./types.js";

function seg(over: Partial<SegmentInfo> = {}): SegmentInfo {
  return {
    lengthM: 100,
    roadClass: "residential",
    maxSpeed: 25,
    lit: null,
    surface: "asphalt",
    sidewalk: "unknown",
    isDedicatedFootway: false,
    ...over,
  };
}

function metrics(over: Partial<RouteMetrics> = {}): RouteMetrics {
  return {
    distanceMi: 2,
    elevationGainFt: 50,
    elevationLossFt: 50,
    roadClassMix: {},
    surfaceMix: { asphalt: 1 },
    dedicatedFootwayPct: 0,
    taggedSidewalkPct: 0,
    noSidewalkPct: 0,
    unknownSidewalkPct: 1,
    litPct: 0,
    litKnownPct: 0,
    highSpeedPct: 0,
    busyRoadPct: 0,
    crossingsOfMajorRoads: 0,
    ...over,
  };
}

function path(segments: SegmentInfo[], m: Partial<RouteMetrics> = {}): EnrichedPath {
  return {
    coordinates: [
      [-97.74, 30.27],
      [-97.741, 30.271],
    ],
    distanceMi: 2,
    metrics: metrics(m),
    sidewalkDataAvailable: true,
    segments,
  };
}

test("approach score decays monotonically and is uncapped", () => {
  const samples = [0, 0.1, 0.25, 0.5, 1, 3, 10].map(approachScore);
  for (let i = 1; i < samples.length; i++) {
    assert.ok(samples[i]! < samples[i - 1]!, `not decreasing at index ${i}`);
  }
  assert.equal(approachScore(0), 1);
  assert.ok(approachScore(0.25) > 0.49 && approachScore(0.25) < 0.51);
  assert.ok(approachScore(10) > 0, "must stay positive, never a hard cutoff");
});

test("approach dominates ranking, per the spec", () => {
  // A pristine route far away vs a mediocre route close by.
  const pristine = path(
    [seg({ isDedicatedFootway: true, roadClass: "footway" })],
    { dedicatedFootwayPct: 1, unknownSidewalkPct: 0 },
  );
  const mediocre = path([seg({ sidewalk: "no", roadClass: "residential" })], {
    noSidewalkPct: 1,
    unknownSidewalkPct: 0,
  });

  const far = scoreRoute(pristine, 0.9);
  const near = scoreRoute(mediocre, 0.05);

  assert.ok(
    near.score > far.score,
    `near/mediocre (${near.score}) should beat far/pristine (${far.score})`,
  );
});

test("sidewalk credit ordering matches the stated preference rules", () => {
  const at = (s: SegmentInfo) => scoreRoute(path([s]), 0).breakdown["sidewalk"]!;

  const dedicated = at(seg({ isDedicatedFootway: true, roadClass: "footway" }));
  const both = at(seg({ sidewalk: "both" }));
  const oneSide = at(seg({ sidewalk: "left" }));
  const unknownQuiet = at(seg({ sidewalk: "unknown", roadClass: "residential", maxSpeed: 25 }));
  const unknownBusy = at(seg({ sidewalk: "unknown", roadClass: "secondary", maxSpeed: 45 }));
  const noneQuiet = at(seg({ sidewalk: "no", roadClass: "residential", maxSpeed: 25 }));
  const noneBusy = at(seg({ sidewalk: "no", roadClass: "primary", maxSpeed: 50 }));

  assert.ok(dedicated >= both, "dedicated footway at least matches sidewalk=both");
  assert.ok(both > oneSide, "both sides beats one side");
  assert.ok(oneSide > unknownQuiet, "known sidewalk beats unknown");
  assert.ok(unknownQuiet > unknownBusy, "unknown on a quiet street beats unknown on an arterial");
  assert.ok(unknownQuiet > noneQuiet, "unknown beats a confirmed absence");
  assert.ok(noneQuiet > noneBusy, "no sidewalk is tolerable when quiet, not when busy");
  assert.ok(noneBusy < dedicated * 0.35, "no sidewalk on an arterial is heavily punished");
});

test("no-sidewalk on a quiet street stays acceptable", () => {
  // The spec explicitly allows this case, so it must not be near-zero.
  const quiet = scoreRoute(
    path([seg({ sidewalk: "no", roadClass: "residential", maxSpeed: 25 })]),
    0,
  );
  assert.ok(
    quiet.breakdown["sidewalk"]! > 25 * 0.5,
    `quiet sidewalk-less street scored ${quiet.breakdown["sidewalk"]}, expected > 12.5`,
  );
});

test("freeway segments disqualify outright", () => {
  for (const rc of ["motorway", "trunk", "motorway_link", "trunk_link"]) {
    assert.equal(isDisqualified(path([seg(), seg({ roadClass: rc })])), true, rc);
  }
  assert.equal(isDisqualified(path([seg(), seg({ roadClass: "residential" })])), false);
});

test("elevation never influences the score", () => {
  const flat = scoreRoute(path([seg()], { elevationGainFt: 0 }), 0.2);
  const hilly = scoreRoute(path([seg()], { elevationGainFt: 900 }), 0.2);
  assert.equal(flat.score, hilly.score);
});

test("high-speed and busy-road exposure lowers the safety term", () => {
  const calm = scoreRoute(path([seg()], { highSpeedPct: 0, busyRoadPct: 0 }), 0);
  const exposed = scoreRoute(path([seg()], { highSpeedPct: 0.6, busyRoadPct: 0.4 }), 0);
  assert.ok(exposed.breakdown["safety"]! < calm.breakdown["safety"]!);
});

test("total run math is 2A + (N x L)", () => {
  assert.equal(totalRunMiles(0.3, 2.0, 3), 6.6);
  assert.equal(totalRunMiles(0, 3.1, 1), 3.1);
  assert.equal(totalRunMiles(0.5, 1.5, 4), 7);
});

test("geometry overlap detects duplicates and separates distinct routes", () => {
  const a: [number, number][] = [
    [-97.74, 30.27],
    [-97.7401, 30.2701],
    [-97.7402, 30.2702],
  ];
  const far: [number, number][] = [
    [-97.8, 30.35],
    [-97.8001, 30.3501],
  ];
  assert.equal(geometryOverlap(a, a), 1);
  assert.equal(geometryOverlap(a, far), 0);
});

test("google maps waypoint simplification respects the 9-point cap", () => {
  const many: [number, number][] = Array.from(
    { length: 400 },
    (_, i) => [-97.74 + i * 0.0001, 30.27 + i * 0.0001],
  );
  assert.equal(simplifyByDistance(many, 9).length, 9);
  assert.equal(simplifyByDistance(many.slice(0, 3), 9).length, 3);
});
