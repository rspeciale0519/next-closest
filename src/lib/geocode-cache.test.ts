import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Place } from "./geo.ts";
import {
  cacheTtlSeconds,
  createMemoryGeocodeCache,
  GEOCODE_CACHE_TTL_SECONDS,
  GEOCODE_MEMORY_CACHE_MAX,
  GEOCODE_MISS_TTL_SECONDS,
  geocodeWithCache,
} from "./geocode-cache.ts";

const sample: Place = {
  lat: 28.698,
  lng: -81.308,
  query: "606 TINA LN WINTER SPRINGS",
  label: "606 Tina Ln, Winter Springs, FL",
};

describe("geocode cache", () => {
  it("skips the upstream lookup on the second call for the same address", async () => {
    const cache = createMemoryGeocodeCache();
    let upstream = 0;
    const lookup = async (query: string): Promise<Place | null> => {
      upstream += 1;
      return { ...sample, query };
    };

    const first = await geocodeWithCache("  606   TINA LN WINTER SPRINGS ", cache, lookup);
    const second = await geocodeWithCache("606 TINA LN WINTER SPRINGS", cache, lookup);

    assert.equal(upstream, 1);
    assert.deepEqual(first, { ...sample, query: "  606   TINA LN WINTER SPRINGS " });
    assert.deepEqual(second, { ...sample, query: "606 TINA LN WINTER SPRINGS" });
  });

  it("caches a miss so a second lookup still skips upstream", async () => {
    const cache = createMemoryGeocodeCache();
    let upstream = 0;
    const first = await geocodeWithCache("nowhere", cache, async () => {
      upstream += 1;
      return null;
    });
    const second = await geocodeWithCache("nowhere", cache, async () => {
      upstream += 1;
      return sample;
    });
    assert.equal(first, null);
    assert.equal(second, null);
    assert.equal(upstream, 1);
  });

  it("uses a one-day TTL for not-found and evicts the oldest memory entry", async () => {
    assert.equal(cacheTtlSeconds(sample), GEOCODE_CACHE_TTL_SECONDS);
    assert.equal(cacheTtlSeconds(null), GEOCODE_MISS_TTL_SECONDS);
    assert.equal(GEOCODE_MISS_TTL_SECONDS, 24 * 60 * 60);
    assert.ok(GEOCODE_MEMORY_CACHE_MAX >= 2500);

    const store = new Map();
    let now = 1_000;
    const cache = createMemoryGeocodeCache({
      store,
      maxEntries: 2,
      now: () => now,
    });
    await cache.set("a", sample);
    await cache.set("b", null);
    const miss = store.get("b");
    assert.ok(miss);
    assert.equal(miss.exp - now, GEOCODE_MISS_TTL_SECONDS * 1000);
    const hit = store.get("a");
    assert.ok(hit);
    assert.equal(hit.exp - now, GEOCODE_CACHE_TTL_SECONDS * 1000);

    await cache.set("c", sample);
    assert.equal(await cache.get("a"), undefined);
    assert.ok(await cache.get("b") === null);
    assert.ok(await cache.get("c"));
  });

  it("does not cache an aborted lookup as not-found", async () => {
    const cache = createMemoryGeocodeCache();
    await assert.rejects(
      () =>
        geocodeWithCache("stopped", cache, async () => {
          throw new DOMException("Stopped", "AbortError");
        }),
      (err: unknown) => err instanceof DOMException && err.name === "AbortError",
    );
    assert.equal(await cache.get("stopped"), undefined);
  });

  it("does not cache a timed-out lookup as not-found", async () => {
    const cache = createMemoryGeocodeCache();
    const timeout = Object.assign(new Error("Lookup timed out"), { name: "TimeoutError" });
    await assert.rejects(
      () => geocodeWithCache("slow", cache, async () => {
        throw timeout;
      }),
      (err: unknown) => err instanceof Error && err.name === "TimeoutError",
    );
    assert.equal(await cache.get("slow"), undefined);
  });
});
