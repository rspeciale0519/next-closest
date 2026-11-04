import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clientIpFromHeaders,
  createMemoryLimiter,
  RATE_LIMIT_ADDRESSES_PER_HOUR,
  RATE_LIMIT_REQUESTS_PER_MINUTE,
} from "./rate-limit.ts";

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
