import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { LimitServiceUnavailableError, LOOKUP_LIMIT_UNAVAILABLE } from "./rate-limit.ts";
import {
  consumeSharedGeocodeSlot,
  enforceGeocodeBudget,
  enforcePlanLimit,
  resetPlanLimitersForTests,
  setFailClosedForTests,
  tryConsumeOsrmSlot,
} from "./rate-limit.server.ts";
import { resetRedisForTests } from "./upstash-redis.server.ts";

function resetLimitState() {
  setFailClosedForTests(undefined);
  resetPlanLimitersForTests();
  resetRedisForTests();
}

afterEach(() => {
  resetLimitState();
});

describe("production fail closed", () => {
  it("geocoding throws 503 when Redis is unset so no upstream call is allowed", async () => {
    setFailClosedForTests(true);
    resetPlanLimitersForTests();
    resetRedisForTests();
    await assert.rejects(
      () => enforceGeocodeBudget(1),
      (err: unknown) =>
        err instanceof LimitServiceUnavailableError &&
        err.status === 503 &&
        err.message === LOOKUP_LIMIT_UNAVAILABLE,
    );
  });

  it("OSRM is skipped when Redis is unset", async () => {
    setFailClosedForTests(true);
    resetPlanLimitersForTests();
    resetRedisForTests();
    assert.equal(await tryConsumeOsrmSlot(), false);
  });

  it("shared Census/ArcGIS cap throws 503 when Redis is unset", async () => {
    setFailClosedForTests(true);
    resetPlanLimitersForTests();
    resetRedisForTests();
    await assert.rejects(
      () => consumeSharedGeocodeSlot(),
      (err: unknown) =>
        err instanceof LimitServiceUnavailableError &&
        err.message === LOOKUP_LIMIT_UNAVAILABLE,
    );
  });
});

describe("dev in-memory fallback", () => {
  it("allows then blocks after the per-IP burst", async () => {
    setFailClosedForTests(false);
    resetPlanLimitersForTests();
    resetRedisForTests();
    for (let i = 0; i < 10; i += 1) {
      await enforcePlanLimit({ kind: "interactive" });
    }
    await assert.rejects(() => enforcePlanLimit({ kind: "interactive" }), /Too many requests/);
  });

  it("does not count cached addresses against the hourly budget", async () => {
    setFailClosedForTests(false);
    resetPlanLimitersForTests();
    resetRedisForTests();
    await enforceGeocodeBudget(2500);
    await enforceGeocodeBudget(0);
    await assert.rejects(() => enforceGeocodeBudget(1), /Address lookup limit/);
  });
});
