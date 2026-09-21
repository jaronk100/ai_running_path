import assert from "node:assert/strict";
import { test } from "node:test";
import { enrichPath, type EnrichedPath, type SegmentInfo } from "./enrich.js";
import { geometryOverlap, retraceShare } from "./geo.js";
import { simplifyByDistance, totalRunMiles } from "./export.js";
import {
  approachScore,
  isDisqualified,
  quietness,
  scoreRoute,
} from "./scoring.js";
import type { GHPath, RouteMetrics } from "./types.js";

function seg(over: Partial<SegmentInfo> = {}): SegmentInfo {
  return {
    lengthM: 100,
    roadClass: "residential",
    maxSpeed: 25,
    surface: "asphalt",
    isPath: false,
    isCrossing: false,
    crossing: "missing",
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
    retracePct: 0,
    pathPct: 0,
    highSpeedPct: 0,
    busyRoadPct: 0,
    crossingsOfMajorRoads: 0,
    totalCrossings: 0,
    ...over,
  };
}

function path(
  segments: SegmentInfo[],
  m: Partial<RouteMetrics> = {},
): EnrichedPath {
  return {
    coordinates: [
      [-97.74, 30.27],
      [-97.741, 30.271],
    ],
    distanceMi: 2,
    metrics: metrics(m),
    segments,
  };
}

const trail = () => seg({ roadClass: "path", maxSpeed: null, isPath: true });

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
  // An all-trail loop far away vs an ordinary residential loop at the door.
  const far = scoreRoute(path([trail()]), 0.9);
  const near = scoreRoute(path([seg()]), 0.05);
  assert.ok(
    near.score > far.score,
    `near residential (${near.score}) should beat far trail (${far.score})`,
  );
});

test("approach carries the largest weight of the three terms", () => {
  const best = scoreRoute(path([trail()]), 0);
  assert.ok(best.breakdown["approach"]! > best.breakdown["traffic"]!);
  assert.ok(best.breakdown["approach"]! > best.breakdown["shape"]!);
  assert.equal(best.score, 100);
});

test("quietness orders road types the way a runner would", () => {
  const q = (over: Partial<SegmentInfo>) => quietness(seg(over));

  const path_ = quietness(trail());
  const residential = q({ roadClass: "residential", maxSpeed: 25 });
  const tertiary = q({ roadClass: "tertiary", maxSpeed: 35 });
  const secondary = q({ roadClass: "secondary", maxSpeed: 45 });
  const primary = q({ roadClass: "primary", maxSpeed: 55 });

  assert.equal(path_, 1, "car-free path is the quietest possible");
  assert.ok(path_ > residential, "path beats residential street");
  assert.ok(residential > tertiary, "residential beats collector");
  assert.ok(tertiary > secondary, "collector beats arterial");
  assert.ok(secondary > primary, "arterial beats major arterial");
  assert.ok(primary < 0.01, "a fast major arterial is near worthless");
});

test("higher posted speed lowers quietness on the same road class", () => {
  const slow = quietness(seg({ roadClass: "tertiary", maxSpeed: 25 }));
  const fast = quietness(seg({ roadClass: "tertiary", maxSpeed: 45 }));
  assert.ok(fast < slow);
});

test("a path is not penalised for lacking a posted speed", () => {
  // Paths never carry max_speed; that must not drag them below a street.
  assert.equal(quietness(trail()), 1);
});

test("major-road crossings lower the traffic term", () => {
  const none = scoreRoute(path([seg()], { crossingsOfMajorRoads: 0 }), 0);
  const many = scoreRoute(path([seg()], { crossingsOfMajorRoads: 3 }), 0);
  assert.ok(many.breakdown["traffic"]! < none.breakdown["traffic"]!);
});

test("more trail and less arterial scores higher", () => {
  const trailHeavy = scoreRoute(path([trail(), trail(), seg()]), 0);
  const roadHeavy = scoreRoute(
    path([seg({ roadClass: "tertiary", maxSpeed: 40 }), seg(), seg()]),
    0,
  );
  assert.ok(trailHeavy.score > roadHeavy.score);
});

test("retrace share is 0 for a true loop and 1 for an out-and-back", () => {
  const square: [number, number][] = [
    [-97.8, 30.5], [-97.79, 30.5], [-97.79, 30.51], [-97.8, 30.51], [-97.8, 30.5],
  ];
  const outAndBack: [number, number][] = [
    [-97.8, 30.5], [-97.79, 30.5], [-97.78, 30.5], [-97.79, 30.5], [-97.8, 30.5],
  ];
  // Lollipop: a stem out and back, with a loop on the end of it.
  const lollipop: [number, number][] = [
    [-97.8, 30.5], [-97.79, 30.5],
    [-97.78, 30.5], [-97.78, 30.51], [-97.79, 30.51], [-97.79, 30.5],
    [-97.8, 30.5],
  ];
  assert.equal(retraceShare(square), 0);
  assert.equal(retraceShare(outAndBack), 1);
  const stem = retraceShare(lollipop);
  assert.ok(stem > 0.2 && stem < 0.5, `lollipop stem share ${stem}`);
});

test("doubling back lowers the shape term", () => {
  const clean = scoreRoute(path([seg()], { retracePct: 0 }), 0);
  const doubled = scoreRoute(path([seg()], { retracePct: 0.4 }), 0);
  assert.ok(doubled.breakdown["shape"]! < clean.breakdown["shape"]!);
  assert.ok(doubled.score < clean.score);
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

test("a signalised crossing counts as a busy crossing, once per intersection", () => {
  // 20 points ~30 m apart heading north along a collector road. The route never
  // steps onto the road it crosses -- only the crossing value records it.
  const coordinates = Array.from(
    { length: 20 },
    (_, i) => [-97.82, 30.52 + i * 0.00027] as [number, number],
  );
  const gh: GHPath = {
    distance: 0,
    time: 0,
    points: { coordinates },
    details: {
      road_class: [[0, 19, "tertiary"]],
      // Segments 3 and 4 are the two carriageways of one divided road; 15 is a
      // second intersection ~330 m further on.
      crossing: [
        [0, 3, "missing"],
        [3, 5, "traffic_signals"],
        [5, 15, "missing"],
        [15, 16, "traffic_signals"],
        [16, 19, "missing"],
      ],
    },
  };
  assert.equal(enrichPath(gh).metrics.crossingsOfMajorRoads, 2);
});
