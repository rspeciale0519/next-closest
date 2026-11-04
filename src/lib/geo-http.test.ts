import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GEOCODE_USER_AGENT } from "./geo-http.ts";
import { LIST_GEOCODE_ATTEMPTS, LIST_GEOCODE_TIMEOUT_MS, PLAN_FN_MAX_DURATION_SECONDS } from "./plan-limits.ts";

describe("list geocode budget", () => {
  it("identifies as nextclosest.vercel.app", () => {
    assert.equal(
      GEOCODE_USER_AGENT,
      "nextclosest.vercel.app (+https://github.com/rspeciale0519/next-closest)",
    );
  });

  it("keeps a full miss batch under the function maxDuration", () => {
    const worstMs = Math.ceil((20 * 2 * LIST_GEOCODE_ATTEMPTS * LIST_GEOCODE_TIMEOUT_MS) / 5);
    assert.ok(worstMs < PLAN_FN_MAX_DURATION_SECONDS * 1000);
    assert.equal(LIST_GEOCODE_ATTEMPTS, 1);
  });
});
