import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chunkItems,
  normalizeGeocodeKey,
  orderNearestByHaversine,
  orderNearestNext,
  type Place,
} from "./geo.ts";

describe("chunkItems", () => {
  it("splits a list into fixed-size batches with a short tail", () => {
    assert.deepEqual(chunkItems([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  });

  it("returns one chunk when the list fits", () => {
    assert.deepEqual(chunkItems(["a", "b"], 20), [["a", "b"]]);
  });

  it("returns an empty list for no items", () => {
    assert.deepEqual(chunkItems([], 20), []);
  });

  it("keeps an exact multiple as full chunks", () => {
    assert.deepEqual(chunkItems([1, 2, 3, 4], 2), [
      [1, 2],
      [3, 4],
    ]);
  });

  it("rejects a non-positive chunk size", () => {
    assert.throws(() => chunkItems([1], 0), /positive/);
  });
});

describe("normalizeGeocodeKey", () => {
  it("trims and collapses space so duplicates share a cache key", () => {
    assert.equal(normalizeGeocodeKey("  123   Main St  "), normalizeGeocodeKey("123 Main St"));
  });
});

function gridStops(count: number): Place[] {
  return Array.from({ length: count }, (_, i) => ({
    lat: 28.698 + (i % 40) * 0.0015,
    lng: -81.308 + Math.floor(i / 40) * 0.0015,
    label: `Stop ${i}`,
    query: `${100 + i} Test St, Winter Springs, FL`,
  }));
}

describe("orderNearestByHaversine", () => {
  it("orders a generated 1,300-stop set without dropping or duplicating stops", () => {
    const start = { lat: 28.698, lng: -81.308 };
    const stops = gridStops(1300);
    const t0 = performance.now();
    const ordered = orderNearestByHaversine(start, stops);
    const ms = performance.now() - t0;

    assert.equal(ordered.length, 1300);
    assert.equal(new Set(ordered.map((stop) => stop.query)).size, 1300);
    for (const stop of stops) {
      assert.ok(ordered.includes(stop), `missing ${stop.query}`);
    }
    assert.ok(ms < 2000, `nearest-neighbor took ${ms.toFixed(1)}ms`);
  });

  it("matches matrix nearest-next on a small set", () => {
    const start = { lat: 0, lng: 0, label: "S", query: "S" };
    const stops: Place[] = [
      { lat: 0, lng: 2, label: "B", query: "B" },
      { lat: 0, lng: 1, label: "A", query: "A" },
      { lat: 0, lng: 3, label: "C", query: "C" },
    ];
    const ordered = orderNearestByHaversine(start, stops);
    assert.deepEqual(
      ordered.map((s) => s.query),
      ["A", "B", "C"],
    );
    const points = [start, ...stops];
    const matrix = points.map((a) =>
      points.map((b) => Math.hypot(a.lat - b.lat, a.lng - b.lng)),
    );
    const idx = orderNearestNext(matrix).slice(1);
    assert.deepEqual(
      idx.map((i) => stops[i - 1].query),
      ["A", "B", "C"],
    );
  });
});
