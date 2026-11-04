import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { orderNearestByHaversine, type Place } from "./geo.ts";
import { createMemoryOsrmCache, osrmTableWithCache } from "./osrm-cache.ts";
import { osrmCacheKey, planFromOsrmTable, stitchRoadHeadToTail } from "./osrm.ts";
import { assembleStraightPlan } from "./plan.ts";
import { createMemoryLimiter, RATE_LIMIT_OSRM_PER_WINDOW, RATE_LIMIT_OSRM_WINDOW_MS } from "./rate-limit.ts";

const start: Place = {
  lat: 0,
  lng: 0,
  query: "Start",
  label: "Start",
};

function stop(query: string, lat: number, lng: number): Place {
  return { lat, lng, query, label: query };
}

describe("straight-line nearest-neighbor chain", () => {
  it("walks origin to the closest remaining stop each time", () => {
    const stops = [
      stop("far", 0, 3),
      stop("near", 0, 1),
      stop("mid", 0, 2),
    ];
    assert.deepEqual(
      orderNearestByHaversine(start, stops).map((place) => place.query),
      ["near", "mid", "far"],
    );
  });
});

describe("25-stop road refine joined to the straight-line rest", () => {
  it("keeps the refined head and continues the tail from the last refined stop", () => {
    const chain = Array.from({ length: 40 }, (_, i) => stop(`S${i}`, 0, i + 1));
    const head = chain.slice(0, 25);
    const tail = chain.slice(25);
    const refinedHead = [...head].reverse();
    const headPlan = assembleStraightPlan(start, refinedHead);
    const joined = stitchRoadHeadToTail({ ...headPlan, source: "road" }, tail);

    assert.equal(joined.source, "road");
    assert.equal(joined.ordered.length, 40);
    assert.deepEqual(
      joined.ordered.slice(0, 25).map((item) => item.place.query),
      refinedHead.map((place) => place.query),
    );
    const lastRefined = refinedHead[refinedHead.length - 1];
    const expectedTail = orderNearestByHaversine(lastRefined, tail);
    assert.deepEqual(
      joined.ordered.slice(25).map((item) => item.place.query),
      expectedTail.map((place) => place.query),
    );
    assert.deepEqual(
      joined.ordered.map((item) => item.place.query).sort(),
      chain.map((place) => place.query).sort(),
    );
  });
});

describe("OSRM table plan", () => {
  it("re-orders the head by driving time and returns null when the table is unusable", () => {
    const stops = [stop("A", 0, 1), stop("B", 0, 2)];
    const durations = [
      [0, 90, 10],
      [90, 0, 10],
      [10, 10, 0],
    ];
    const distances = [
      [0, 9000, 1000],
      [9000, 0, 1000],
      [1000, 1000, 0],
    ];
    const planned = planFromOsrmTable(start, stops, { distances, durations });
    assert.ok(planned);
    assert.equal(planned?.source, "road");
    assert.deepEqual(
      planned?.ordered.map((item) => item.place.query),
      ["B", "A"],
    );

    assert.equal(
      planFromOsrmTable(start, stops, {
        distances: [
          [null, null, null],
          [null, null, null],
          [null, null, null],
        ],
        durations: [
          [null, null, null],
          [null, null, null],
          [null, null, null],
        ],
      }),
      null,
    );
  });
});

describe("OSRM cache", () => {
  it("skips the upstream table on the second lookup of the same rounded coordinates", async () => {
    const cache = createMemoryOsrmCache();
    const points = [start, stop("A", 28.6984111, -81.3081222)];
    const table = {
      distances: [
        [0, 100],
        [100, 0],
      ],
      durations: [
        [0, 10],
        [10, 0],
      ],
    };
    let upstream = 0;
    const first = await osrmTableWithCache(points, cache, async () => {
      upstream += 1;
      return table;
    });
    const shifted = [start, stop("A", 28.6984144, -81.3081244)];
    const second = await osrmTableWithCache(shifted, cache, async () => {
      upstream += 1;
      return table;
    });
    assert.equal(upstream, 1);
    assert.equal(first, table);
    assert.equal(second, table);
    assert.equal(osrmCacheKey(points), osrmCacheKey(shifted));
  });
});

describe("OSRM global cap", () => {
  it("allows one call every two seconds and blocks the next", async () => {
    const limiter = createMemoryLimiter(RATE_LIMIT_OSRM_PER_WINDOW, RATE_LIMIT_OSRM_WINDOW_MS);
    assert.equal((await limiter.consume("global")).ok, true);
    const blocked = await limiter.consume("global");
    assert.equal(blocked.ok, false);
  });
});
