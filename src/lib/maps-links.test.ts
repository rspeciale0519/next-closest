import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { orderNearestByHaversine, type Place } from "./geo.ts";
import {
  appleMapsDirUrl,
  copyableStopList,
  googleMapsDirUrl,
  MAPS_HANDOFF_MAX_STOPS,
  navAddress,
} from "./maps-links.ts";

function place(query: string, label = ""): Place {
  return { lat: 28.5, lng: -81.4, query, label };
}

function stop(index: number): Place {
  const n = 100 + index;
  const query = `${n} Ordered St, Winter Springs, FL`;
  return { lat: 28.7 + index * 0.001, lng: -81.3, query, label: query };
}

function googleStops(url: string): string[] {
  const parsed = new URL(url);
  const destination = parsed.searchParams.get("destination");
  const via = parsed.searchParams.get("waypoints");
  return [...(via ? via.split("|") : []), ...(destination ? [destination] : [])];
}

function appleStops(url: string): string[] {
  const parsed = new URL(url);
  const destination = parsed.searchParams.get("destination");
  return [...parsed.searchParams.getAll("waypoint"), ...(destination ? [destination] : [])];
}

describe("copyableStopList", () => {
  it("joins real addresses and keeps house-number stops", () => {
    assert.equal(
      copyableStopList([
        place("123 Main St, Orlando, FL"),
        place("\t400 S Orange Ave, Orlando, FL"),
        place("", "City Hall, 400 S Orange Ave, Orlando, FL"),
      ]),
      [
        "123 Main St, Orlando, FL",
        "400 S Orange Ave, Orlando, FL",
        "City Hall, 400 S Orange Ave, Orlando, FL",
      ].join("\n"),
    );
  });

  it("skips formula-like hand-typed addresses including + - tab and CR prefixes", () => {
    assert.equal(
      copyableStopList([
        place("=HYPERLINK(A1)"),
        place("@SUM(A1)"),
        place("+cmd|' /C calc'!A0"),
        place("-2+3+cmd|' /C calc'!A0"),
        place("\t=HYPERLINK(A1)"),
        place("\r@SUM(A1)"),
        place("123 Main St, Orlando, FL"),
        place("  =cmd  "),
      ]),
      "123 Main St, Orlando, FL",
    );
  });

  it("does not drop a real address that only has extra spaces", () => {
    assert.equal(
      copyableStopList([place("  200  S  Orange Ave, Orlando, FL  ")]),
      "200 S Orange Ave, Orlando, FL",
    );
  });
});

describe("maps handoff cap", () => {
  it("is a hard cap of 10", () => {
    assert.equal(MAPS_HANDOFF_MAX_STOPS, 10);
  });

  it("puts exactly the first 10 sorted stops in both links for a 2,500-stop list", () => {
    const places = Array.from({ length: 2500 }, (_, i) => stop(i));
    const firstTen = places.slice(0, 10).map(navAddress);
    const google = googleStops(googleMapsDirUrl(places));
    const apple = appleStops(appleMapsDirUrl(places));

    assert.deepEqual(google, firstTen);
    assert.deepEqual(apple, firstTen);
    assert.equal(google.length, 10);
    assert.equal(apple.length, 10);
    assert.equal(google[0], "100 Ordered St, Winter Springs, FL");
    assert.equal(google[9], "109 Ordered St, Winter Springs, FL");
    assert.equal(google.includes(navAddress(places[10])), false);
    assert.equal(apple.includes(navAddress(places[2499])), false);
    assert.equal(googleMapsDirUrl(places).includes("110 Ordered St"), false);
    assert.equal(appleMapsDirUrl(places).includes("2599 Ordered St"), false);
  });

  it("puts every stop in both links when there are fewer than 10", () => {
    const places = Array.from({ length: 4 }, (_, i) => stop(i));
    const all = places.map(navAddress);
    assert.deepEqual(googleStops(googleMapsDirUrl(places)), all);
    assert.deepEqual(appleStops(appleMapsDirUrl(places)), all);
  });

  it("orders all 2,500 stops while maps links keep only the first 10", () => {
    const start = { lat: 28.7, lng: -81.3 };
    const stops = Array.from({ length: 2500 }, (_, i) => stop(i));
    const ordered = orderNearestByHaversine(start, stops);
    assert.equal(ordered.length, 2500);
    assert.equal(new Set(ordered.map((place) => place.query)).size, 2500);
    assert.deepEqual(
      ordered.map((place) => place.query).sort(),
      stops.map((place) => place.query).sort(),
    );

    const firstTen = ordered.slice(0, 10).map(navAddress);
    assert.deepEqual(googleStops(googleMapsDirUrl(ordered)), firstTen);
    assert.deepEqual(appleStops(appleMapsDirUrl(ordered)), firstTen);
    assert.equal(copyableStopList(ordered).split("\n").length, 2500);
    assert.equal(copyableStopList(ordered).includes(ordered[2499].query), true);
  });
});
