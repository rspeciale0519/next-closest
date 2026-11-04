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
import { geocodeListFallback, LookupTimeoutError, mapPool } from "./geo-http.ts";

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
    const place = await geocodeWithCache("slow", cache, async () => {
      throw timeout;
    });
    assert.equal(place, null);
    assert.equal(await cache.get("slow"), undefined);
  });

  it("keeps a Census Stop as a hard stop and does not call ArcGIS", async () => {
    let arcgis = 0;
    await assert.rejects(
      () =>
        geocodeListFallback(
          async () => {
            throw new DOMException("Stopped", "AbortError");
          },
          async () => {
            arcgis += 1;
            return sample;
          },
        ),
      (err: unknown) => err instanceof DOMException && err.name === "AbortError",
    );
    assert.equal(arcgis, 0);
  });

  it("falls back to ArcGIS when Census times out and the batch still completes", async () => {
    const cache = createMemoryGeocodeCache();
    const queries = ["slow census", "fast"];
    const found = await mapPool(queries, 2, (query) =>
      geocodeWithCache(query, cache, (next) =>
        geocodeListFallback(
          async () => {
            if (next === "slow census") throw new LookupTimeoutError();
            return { ...sample, query: next, label: `Census ${next}` };
          },
          async () => ({ ...sample, query: next, label: `ArcGIS ${next}` }),
        ),
      ),
    );
    assert.equal(found[0]?.label, "ArcGIS slow census");
    assert.equal(found[1]?.label, "Census fast");
    assert.equal(found.length, 2);
  });

  it("treats a double timeout as an uncached miss and continues the batch", async () => {
    const cache = createMemoryGeocodeCache();
    const queries = ["both timeout", "ok"];
    const found = await mapPool(queries, 2, (query) =>
      geocodeWithCache(query, cache, (next) =>
        geocodeListFallback(
          async () => {
            if (next === "both timeout") throw new LookupTimeoutError();
            return { ...sample, query: next };
          },
          async () => {
            if (next === "both timeout") throw new LookupTimeoutError();
            return { ...sample, query: next };
          },
        ),
      ),
    );
    assert.equal(found[0], null);
    assert.ok(found[1]);
    assert.equal(await cache.get("both timeout"), undefined);
    assert.ok(await cache.get("ok"));
  });
});
