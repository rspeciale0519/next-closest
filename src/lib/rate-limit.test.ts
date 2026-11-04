import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clientIpFromHeaders,
  closedLimiter,
  consumeUpstashResult,
  createMemoryLimiter,
  LimitServiceUnavailableError,
  LOOKUP_LIMIT_UNAVAILABLE,
  limitFailClosedFromEnv,
  RATE_LIMIT_ADDRESSES_PER_HOUR,
  RATE_LIMIT_GEOCODE_BATCHES_PER_MINUTE,
  RATE_LIMIT_GEOCODE_UPSTREAM_PER_SECOND,
  RATE_LIMIT_OSRM_PER_WINDOW,
  RATE_LIMIT_OSRM_WINDOW_MS,
  RateLimitError,
  rateLimitResponse,
  resolveLimiter,
  throwSharedSlotFailure,
  UPSTASH_LIMIT_TIMEOUT_MS,
  waitForOsrmSlot,
  waitForSharedSlot,
  RATE_LIMIT_REQUESTS_PER_MINUTE,
} from "./rate-limit.ts";
import { MAX_PLAN_STOPS } from "./plan-limits.ts";

describe("memory rate limiter", () => {
  it("allows the configured burst then blocks the next request", async () => {
    const limiter = createMemoryLimiter(RATE_LIMIT_REQUESTS_PER_MINUTE, 60_000);
    for (let i = 0; i < RATE_LIMIT_REQUESTS_PER_MINUTE; i += 1) {
      const result = await limiter.consume("1.1.1.1");
      assert.equal(result.ok, true, `request ${i + 1} should pass`);
    }
    const blocked = await limiter.consume("1.1.1.1");
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.ok(blocked.retryAfterSec >= 1);
  });

  it("allows the hourly address budget then blocks the next lookup", async () => {
    const limiter = createMemoryLimiter(RATE_LIMIT_ADDRESSES_PER_HOUR, 60 * 60_000);
    const first = await limiter.consume("2.2.2.2", RATE_LIMIT_ADDRESSES_PER_HOUR);
    assert.equal(first.ok, true);
    const blocked = await limiter.consume("2.2.2.2", 1);
    assert.equal(blocked.ok, false);
  });

  it("allows one OSRM table call every two seconds then blocks", async () => {
    const limiter = createMemoryLimiter(RATE_LIMIT_OSRM_PER_WINDOW, RATE_LIMIT_OSRM_WINDOW_MS);
    assert.equal((await limiter.consume("global")).ok, true);
    assert.equal((await limiter.consume("global")).ok, false);
  });

  it("waits up to 4 seconds for a free OSRM slot then falls back", async () => {
    let calls = 0;
    const waits: number[] = [];
    const ok = await waitForOsrmSlot(
      async () => {
        calls += 1;
        if (calls === 1) return { ok: false, retryAfterSec: 2 };
        return { ok: true };
      },
      { sleep: async (ms) => { waits.push(ms); } },
    );
    assert.equal(ok, true);
    assert.deepEqual(waits, [2000]);

    let now = 0;
    const gaveUp = await waitForOsrmSlot(
      async () => ({ ok: false, retryAfterSec: 2 }),
      {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    );
    assert.equal(gaveUp, false);
    assert.equal(now, 4000);
  });

  it("keeps IPs independent", async () => {
    const limiter = createMemoryLimiter(1, 60_000);
    assert.equal((await limiter.consume("a")).ok, true);
    assert.equal((await limiter.consume("a")).ok, false);
    assert.equal((await limiter.consume("b")).ok, true);
  });
});

describe("clientIpFromHeaders", () => {
  it("prefers the first x-forwarded-for hop", () => {
    const headers = new Headers({
      "x-forwarded-for": "203.0.113.9, 10.0.0.1",
      "x-real-ip": "10.0.0.2",
    });
    assert.equal(clientIpFromHeaders(headers), "203.0.113.9");
  });
});

describe("fail-closed vs in-memory fallback", () => {
  it("treats NODE_ENV=production, VERCEL=1, or VERCEL_ENV=production as fail closed", () => {
    assert.equal(limitFailClosedFromEnv({ NODE_ENV: "production" }), true);
    assert.equal(limitFailClosedFromEnv({ VERCEL: "1" }), true);
    assert.equal(limitFailClosedFromEnv({ VERCEL_ENV: "production" }), true);
    assert.equal(limitFailClosedFromEnv({ VERCEL_ENV: "preview" }), false);
    assert.equal(limitFailClosedFromEnv({ NODE_ENV: "test" }), false);
    assert.equal(limitFailClosedFromEnv({ NODE_ENV: "development" }), false);
  });

  it("treats an Upstash 1500ms timeout as a deny when fail-closed is on", () => {
    const timeout = { success: true, reason: "timeout" as const, reset: 0 };
    const denied = consumeUpstashResult(timeout, true);
    assert.equal(denied.ok, false);
    if (!denied.ok) {
      assert.equal(denied.unavailable, true);
      assert.equal(denied.retryAfterSec, Math.ceil(UPSTASH_LIMIT_TIMEOUT_MS / 1000));
    }
    assert.equal(consumeUpstashResult(timeout, false).ok, true);
    assert.equal(UPSTASH_LIMIT_TIMEOUT_MS, 1500);
  });

  it("production missing Redis counts the limit as hit", async () => {
    const limiter = resolveLimiter(null, createMemoryLimiter(10, 60_000), true);
    const result = await limiter.consume("1.1.1.1");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.unavailable, true);
  });

  it("production Redis errors count the limit as hit", async () => {
    const redis = {
      async consume() {
        throw new Error("ECONNREFUSED");
      },
    };
    const limiter = resolveLimiter(redis, createMemoryLimiter(10, 60_000), true);
    const result = await limiter.consume("1.1.1.1");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.unavailable, true);
  });

  it("dev missing Redis uses the in-memory limiter", async () => {
    const memory = createMemoryLimiter(2, 60_000);
    const limiter = resolveLimiter(null, memory, false);
    assert.equal((await limiter.consume("1.1.1.1")).ok, true);
    assert.equal((await limiter.consume("1.1.1.1")).ok, true);
    const blocked = await limiter.consume("1.1.1.1");
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.unavailable, undefined);
  });

  it("dev Redis errors fall back to in-memory", async () => {
    const redis = {
      async consume() {
        throw new Error("ECONNREFUSED");
      },
    };
    const memory = createMemoryLimiter(1, 60_000);
    const limiter = resolveLimiter(redis, memory, false);
    assert.equal((await limiter.consume("1.1.1.1")).ok, true);
    assert.equal((await limiter.consume("1.1.1.1")).ok, false);
  });

  it("skips waiting when the limiter is unavailable", async () => {
    let now = 0;
    const ok = await waitForOsrmSlot(() => closedLimiter().consume("global"), {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    assert.equal(ok, false);
    assert.equal(now, 0);
  });
});

describe("shared geocoding cap vs a 2,500-stop list", () => {
  it("lets one full list finish and does not count a zero-cost consume", async () => {
    assert.ok(RATE_LIMIT_GEOCODE_BATCHES_PER_MINUTE * 20 >= MAX_PLAN_STOPS);
    assert.equal(RATE_LIMIT_ADDRESSES_PER_HOUR, MAX_PLAN_STOPS);
    assert.ok(RATE_LIMIT_GEOCODE_UPSTREAM_PER_SECOND * 250 >= MAX_PLAN_STOPS);
    const limiter = createMemoryLimiter(RATE_LIMIT_ADDRESSES_PER_HOUR, 60 * 60_000);
    assert.equal((await limiter.consume("ip", 0)).ok, true);
    assert.equal((await limiter.consume("ip", RATE_LIMIT_ADDRESSES_PER_HOUR)).ok, true);
    assert.equal((await limiter.consume("ip", 1)).ok, false);
  });
});

describe("limit unavailable error", () => {
  it("is a 503 with the public geocoding message", () => {
    const err = new LimitServiceUnavailableError();
    assert.equal(err.status, 503);
    assert.equal(err.message, LOOKUP_LIMIT_UNAVAILABLE);
    assert.equal(LOOKUP_LIMIT_UNAVAILABLE, "Lookup limit service unavailable, try again shortly");
  });
});

describe("shared slot busy vs unavailable", () => {
  it("returns busy when the slot never frees and unavailable without waiting", async () => {
    let now = 0;
    const busy = await waitForSharedSlot(async () => ({ ok: false, retryAfterSec: 2 }), {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    assert.equal(busy, "busy");
    assert.equal(now, 4000);

    now = 0;
    const unavailable = await waitForSharedSlot(() => closedLimiter().consume("global"), {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    assert.equal(unavailable, "unavailable");
    assert.equal(now, 0);
  });

  it("throws 429 with Retry-After when the shared slot is only busy", () => {
    assert.throws(
      () => throwSharedSlotFailure("busy", 3),
      (err: unknown) => err instanceof RateLimitError && err.status === 429 && err.retryAfterSec === 3,
    );
    const response = rateLimitResponse(new RateLimitError("Too many address lookups right now. Try again shortly.", 3));
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "3");
  });

  it("throws 503 when Redis is unavailable", () => {
    assert.throws(
      () => throwSharedSlotFailure("unavailable"),
      (err: unknown) => err instanceof LimitServiceUnavailableError && err.status === 503,
    );
  });
});

