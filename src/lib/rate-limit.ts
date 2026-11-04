/** Per-IP burst cap for typeahead, reverse, start, and road refine. */
export const RATE_LIMIT_REQUESTS_PER_MINUTE = 10;

/**
 * List geocode is one HTTP call per 20 addresses. A 1,312-stop job is 66
 * batches; a 2,500-stop job is 125. 10 req/min would stall that mid-list, so
 * batches use this separate cap (enough for one full list in a couple of minutes).
 */
export const RATE_LIMIT_GEOCODE_BATCHES_PER_MINUTE = 80;

/**
 * Hourly unique-lookup budget. Review asked for “a few hundred”; that rejects
 * the owner’s 1,312-stop spreadsheet, so this is one full list (the hard cap).
 * Cache hits do not consume this.
 */
export const RATE_LIMIT_ADDRESSES_PER_HOUR = 2500;

/** One public OSRM table call per second, shared across instances. */
export const RATE_LIMIT_OSRM_PER_SECOND = 1;

export type ConsumeResult =
  | { ok: true }
  | { ok: false; retryAfterSec: number };

export type RateLimiter = {
  consume(bucket: string, cost?: number): Promise<ConsumeResult>;
};

export class RateLimitError extends Error {
  readonly retryAfterSec: number;
  constructor(message = "Too many requests. Wait a minute and try again.", retryAfterSec = 60) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterSec = retryAfterSec;
  }
}

export function createMemoryLimiter(limit: number, windowMs: number): RateLimiter {
  const hits = new Map<string, number[]>();
  return {
    async consume(bucket: string, cost = 1) {
      const amount = Math.max(0, Math.floor(cost));
      if (amount === 0) return { ok: true };
      const now = Date.now();
      const times = (hits.get(bucket) ?? []).filter((stamp) => now - stamp < windowMs);
      if (times.length + amount > limit) {
        const oldest = times[0] ?? now;
        return {
          ok: false,
          retryAfterSec: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
        };
      }
      for (let i = 0; i < amount; i += 1) times.push(now);
      hits.set(bucket, times);
      return { ok: true };
    },
  };
}

export function clientIpFromHeaders(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const vercel = headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim();
  const real = headers.get("x-real-ip")?.trim();
  return forwarded || vercel || real || "local";
}
