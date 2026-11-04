import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REVERSE_GEOCODER, reverseGeocodeUrl } from "./reverse-geocode.ts";

describe("reverse geocode", () => {
  it("uses ArcGIS reverseGeocode only, not Nominatim", () => {
    assert.equal(REVERSE_GEOCODER, "arcgis");
    const url = reverseGeocodeUrl({ lat: 28.698, lng: -81.308 }, "PointAddress");
    assert.match(url, /geocode\.arcgis\.com\/.*\/reverseGeocode/);
    assert.doesNotMatch(url, /nominatim|photon/i);
  });
});
