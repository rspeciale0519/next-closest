import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Place } from "./geo.ts";
import { createMemoryGeocodeCache, geocodeWithCache } from "./geocode-cache.ts";

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
});
