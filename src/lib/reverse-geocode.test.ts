import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prepareReverseLookup, REVERSE_GEOCODER, reverseGeocodeUrl } from "./reverse-geocode.ts";

describe("reverse geocode", () => {
  it("uses ArcGIS reverseGeocode only, not Nominatim", () => {
    assert.equal(REVERSE_GEOCODER, "arcgis");
    const url = reverseGeocodeUrl({ lat: 28.698, lng: -81.308 }, "PointAddress");
    assert.match(url, /geocode\.arcgis\.com\/.*\/reverseGeocode/);
    assert.doesNotMatch(url, /nominatim|photon/i);
  });

  it("takes the shared geocode slot and forwards the abort signal", async () => {
    const ctrl = new AbortController();
    const slots: Array<AbortSignal | undefined> = [];
    const opts = await prepareReverseLookup(async (signal) => {
      slots.push(signal);
    }, ctrl.signal);
    assert.deepEqual(slots, [ctrl.signal]);
    assert.equal(opts.signal, ctrl.signal);
    assert.equal(opts.attempts, 1);
  });
});
