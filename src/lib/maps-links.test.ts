import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Place } from "./geo.ts";
import { copyableStopList } from "./maps-links.ts";

function place(query: string, label = ""): Place {
  return { lat: 28.5, lng: -81.4, query, label };
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
