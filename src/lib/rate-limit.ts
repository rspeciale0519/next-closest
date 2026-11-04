import {
  GEOCODE_SLOT_WAIT_MS,
  OSRM_GLOBAL_INTERVAL_MS,
  OSRM_SLOT_WAIT_MS,
} from "./plan-limits.ts";

/** Per-IP burst cap for typeahead, reverse, start, and road refine. */
export const RATE_LIMIT_REQUESTS_PER_MINUTE = 10;

/**
 * List geocode is one RPC per 20 addresses. A 2,500-stop job is 125 batches.
 * The same 10 req/min interactive cap would reject that job after 200 addresses,
 * so list batches use this separate per-IP cap (one full list per minute).
 */
export const RATE_LIMIT_GEOCODE_BATCHES_PER_MINUTE = 125;

/**
 * Per-IP uncached address budget. “A few hundred / hour” would reject a
 * 2,500-stop list on the first Order. This is one full list (the hard cap).
 * Cache hits do not consume this.
 */
export const RATE_LIMIT_ADDRESSES_PER_HOUR = 2500;

/**
 * Shared cross-instance Census/ArcGIS cap. 10 upstream HTTP calls / second
 * lets a 2,500-stop list finish (2,500 Census hits ≈ 250s at the cap; typical
 * concurrency finishes faster). Cache hits do not consume a slot.
 */
export const RATE_LIMIT_GEOCODE_UPSTREAM_PER_SECOND = 10;
export const RATE_LIMIT_GEOCODE_UPSTREAM_WINDOW_MS = 1000;

/** One public OSRM table call per 2s, shared across instances. */
export const RATE_LIMIT_OSRM_PER_WINDOW = 1;
export { OSRM_GLOBAL_INTERVAL_MS as RATE_LIMIT_OSRM_WINDOW_MS, OSRM_SLOT_WAIT_MS, GEOCODE_SLOT_WAIT_MS };

export const LOOKUP_LIMIT_UNAVAILABLE =
  "Lookup limit service unavailable, try again shortly";

export type ConsumeResult =
  | { ok: true }
  | { ok: false; retryAfterSec: number; unavailable?: boolean };

export type RateLimiter = {
  consume(bucket: string, cost?: number): Promise<ConsumeResult>;
};

export class RateLimitError extends Error {
  readonly status = 429;
  readonly retryAfterSec: number;
  constructor(message = "Too many requests. Wait a minute and try again.", retryAfterSec = 60) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterSec = retryAfterSec;
  }
}

export class LimitServiceUnavailableError extends Error {
  readonly status = 503;
  constructor(message = LOOKUP_LIMIT_UNAVAILABLE) {
    super(message);
    this.name = "LimitServiceUnavailableError";
  }
}

export const UPSTASH_LIMIT_TIMEOUT_MS = 1500;

export function limitFailClosedFromEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (
    env.NODE_ENV === "production" ||
    env.VERCEL === "1" ||
    env.VERCEL_ENV === "production"
  );
}

/** Upstash `timeout` resolves `{ success: true, reason: "timeout" }` — allow. Production must deny. */
export function consumeUpstashResult(
  result: { success: boolean; reason?: string; reset?: number },
  failClosed: boolean,
  now = Date.now,
): ConsumeResult {
  if (result.reason === "timeout") {
    if (failClosed) {
      return {
        ok: false,
        retryAfterSec: Math.max(1, Math.ceil(UPSTASH_LIMIT_TIMEOUT_MS / 1000)),
        unavailable: true,
      };
    }
    return { ok: true };
  }
  if (result.success) return { ok: true };
  return {
    ok: false,
    retryAfterSec: Math.max(1, Math.ceil(((result.reset ?? now() + 1000) - now()) / 1000)),
  };
}

export function closedLimiter(): RateLimiter {
  return {
    async consume() {
      return { ok: false, retryAfterSec: 30, unavailable: true };
    },
  };
}

/**
 * Redis when configured. Production (or Vercel) with missing/erroring Redis
 * fails closed. In-memory fallback is only for local dev and tests.
 */
export function resolveLimiter(
  redis: RateLimiter | null,
  memory: RateLimiter,
  failClosed: boolean,
): RateLimiter {
  if (!redis) {
    return failClosed ? closedLimiter() : memory;
  }
  return {
    async consume(bucket, cost = 1) {
      try {
        return await redis.consume(bucket, cost);
      } catch {
        if (failClosed) return { ok: false, retryAfterSec: 30, unavailable: true };
        return memory.consume(bucket, cost);
      }
    },
  };
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

export type SlotWaitResult = "ok" | "busy" | "unavailable";

export async function waitForSharedSlot(
  consume: () => Promise<ConsumeResult>,
  options: {
    maxWaitMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    signal?: AbortSignal;
  } = {},
): Promise<SlotWaitResult> {
  const maxWaitMs = options.maxWaitMs ?? OSRM_SLOT_WAIT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const started = now();
  while (true) {
    if (options.signal?.aborted) {
      throw new DOMException("Stopped", "AbortError");
    }
    const result = await consume();
    if (result.ok) return "ok";
    if (result.unavailable) return "unavailable";
    const remaining = maxWaitMs - (now() - started);
    if (remaining <= 0) return "busy";
    const waitMs = Math.min(remaining, Math.max(1, result.retryAfterSec) * 1000);
    await sleep(waitMs);
  }
}

export async function waitForOsrmSlot(
  consume: () => Promise<ConsumeResult>,
  options: {
    maxWaitMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    signal?: AbortSignal;
  } = {},
): Promise<boolean> {
  return (await waitForSharedSlot(consume, options)) === "ok";
}

export function throwSharedSlotFailure(outcome: SlotWaitResult, retryAfterSec = 2): void {
  if (outcome === "ok") return;
  if (outcome === "unavailable") throw new LimitServiceUnavailableError();
  throw new RateLimitError("Too many address lookups right now. Try again shortly.", retryAfterSec);
}

export function clientIpFromHeaders(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const vercel = headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim();
  const real = headers.get("x-real-ip")?.trim();
  return forwarded || vercel || real || "local";
}

export function limitUnavailableResponse(): Response {
  return new Response(LOOKUP_LIMIT_UNAVAILABLE, {
    status: 503,
    statusText: "Service Unavailable",
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export function rateLimitResponse(err: RateLimitError): Response {
  const retryAfter = String(Math.max(1, Math.floor(err.retryAfterSec)));
  return new Response(`${err.message} Retry-After: ${retryAfter}`, {
    status: 429,
    statusText: "Too Many Requests",
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "Retry-After": retryAfter,
    },
  });
}

export function rethrowLimitError(err: unknown): never {
  if (err instanceof LimitServiceUnavailableError) {
    throw limitUnavailableResponse();
  }
  if (err instanceof RateLimitError) {
    throw rateLimitResponse(err);
  }
  throw err;
}

export function isLimitClosedError(err: unknown): boolean {
  return (
    err instanceof LimitServiceUnavailableError ||
    (typeof Response !== "undefined" && err instanceof Response && err.status === 503)
  );
}

export function isLimitBusyError(err: unknown): boolean {
  return (
    err instanceof RateLimitError ||
    (typeof Response !== "undefined" && err instanceof Response && err.status === 429)
  );
}

export function isLimitResponseError(err: unknown): boolean {
  return isLimitClosedError(err) || isLimitBusyError(err);
}
