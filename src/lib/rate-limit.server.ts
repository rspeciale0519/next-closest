import { Ratelimit } from "@upstash/ratelimit";
import { getRequest } from "@tanstack/react-start/server";
import {
  clientIpFromHeaders,
  createMemoryLimiter,
  GEOCODE_SLOT_WAIT_MS,
  LimitServiceUnavailableError,
  RATE_LIMIT_ADDRESSES_PER_HOUR,
  RATE_LIMIT_GEOCODE_BATCHES_PER_MINUTE,
  RATE_LIMIT_GEOCODE_UPSTREAM_PER_SECOND,
  RATE_LIMIT_GEOCODE_UPSTREAM_WINDOW_MS,
  RATE_LIMIT_OSRM_PER_WINDOW,
  RATE_LIMIT_OSRM_WINDOW_MS,
  OSRM_SLOT_WAIT_MS,
  waitForOsrmSlot,
  RATE_LIMIT_REQUESTS_PER_MINUTE,
  RateLimitError,
  UPSTASH_LIMIT_TIMEOUT_MS,
  consumeUpstashResult,
  limitFailClosedFromEnv,
  resolveLimiter,
  throwSharedSlotFailure,
  waitForSharedSlot,
  type RateLimiter,
} from "./rate-limit.ts";
import { getRedis } from "./upstash-redis.server.ts";

export type PlanLimitKind = "interactive" | "geocode";

type Limiters = {
  interactive: RateLimiter;
  geocode: RateLimiter;
  addresses: RateLimiter;
  osrm: RateLimiter;
  geocodeUpstream: RateLimiter;
};

let cached: Limiters | undefined;
let failClosedOverride: boolean | undefined;

export function setFailClosedForTests(value?: boolean): void {
  failClosedOverride = value;
}

export function limitFailClosed(): boolean {
  if (failClosedOverride !== undefined) return failClosedOverride;
  return limitFailClosedFromEnv();
}

function upstashLimiter(
  limit: number,
  window: Parameters<typeof Ratelimit.slidingWindow>[1],
  prefix: string,
): RateLimiter | null {
  const redis = getRedis();
  if (!redis) return null;
  const failClosed = limitFailClosed();
  const rl = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(limit, window),
    prefix,
    analytics: false,
    timeout: UPSTASH_LIMIT_TIMEOUT_MS,
  });
  return {
    async consume(bucket: string, cost = 1) {
      const result = await rl.limit(bucket, { rate: Math.max(1, Math.floor(cost)) });
      return consumeUpstashResult(result, failClosed);
    },
  };
}

export function getPlanLimiters(): Limiters {
  if (cached) return cached;
  const failClosed = limitFailClosed();
  cached = {
    interactive: resolveLimiter(
      upstashLimiter(RATE_LIMIT_REQUESTS_PER_MINUTE, "1 m", "nc:rl:req"),
      createMemoryLimiter(RATE_LIMIT_REQUESTS_PER_MINUTE, 60_000),
      failClosed,
    ),
    geocode: resolveLimiter(
      upstashLimiter(RATE_LIMIT_GEOCODE_BATCHES_PER_MINUTE, "1 m", "nc:rl:geo"),
      createMemoryLimiter(RATE_LIMIT_GEOCODE_BATCHES_PER_MINUTE, 60_000),
      failClosed,
    ),
    addresses: resolveLimiter(
      upstashLimiter(RATE_LIMIT_ADDRESSES_PER_HOUR, "1 h", "nc:rl:addr"),
      createMemoryLimiter(RATE_LIMIT_ADDRESSES_PER_HOUR, 60 * 60_000),
      failClosed,
    ),
    osrm: resolveLimiter(
      upstashLimiter(RATE_LIMIT_OSRM_PER_WINDOW, "2 s", "nc:rl:osrm"),
      createMemoryLimiter(RATE_LIMIT_OSRM_PER_WINDOW, RATE_LIMIT_OSRM_WINDOW_MS),
      failClosed,
    ),
    geocodeUpstream: resolveLimiter(
      upstashLimiter(RATE_LIMIT_GEOCODE_UPSTREAM_PER_SECOND, "1 s", "nc:rl:geocode-up"),
      createMemoryLimiter(RATE_LIMIT_GEOCODE_UPSTREAM_PER_SECOND, RATE_LIMIT_GEOCODE_UPSTREAM_WINDOW_MS),
      failClosed,
    ),
  };
  return cached;
}

export function resetPlanLimitersForTests(): void {
  cached = undefined;
}

function requestIp(): string {
  try {
    const request = getRequest();
    if (request) return clientIpFromHeaders(request.headers);
  } catch {
    // build / tests
  }
  return "local";
}

function throwIfLimited(result: Awaited<ReturnType<RateLimiter["consume"]>>, overMessage: string): void {
  if (result.ok) return;
  if (result.unavailable) throw new LimitServiceUnavailableError();
  throw new RateLimitError(overMessage, result.retryAfterSec);
}

export async function enforcePlanLimit(opts: {
  kind?: PlanLimitKind;
  addresses?: number;
} = {}): Promise<void> {
  const ip = requestIp();
  const limiters = getPlanLimiters();
  const kind = opts.kind ?? "interactive";
  const requests = kind === "geocode" ? limiters.geocode : limiters.interactive;
  throwIfLimited(
    await requests.consume(ip, 1),
    "Too many requests. Wait a minute and try again.",
  );
  const addresses = Math.max(0, Math.floor(opts.addresses ?? 0));
  if (addresses === 0) return;
  throwIfLimited(
    await limiters.addresses.consume(ip, addresses),
    "Address lookup limit reached for this hour. Try again later.",
  );
}

/** Cached addresses do not consume per-IP or shared lookup budgets. */
export async function enforceGeocodeBudget(uncachedCount: number): Promise<void> {
  if (uncachedCount <= 0) return;
  await enforcePlanLimit({ kind: "geocode", addresses: uncachedCount });
}

/** Global 1 OSRM table call / 2s. Waits up to 4s, then returns false. Fail-closed skips immediately. */
export async function tryConsumeOsrmSlot(signal?: AbortSignal): Promise<boolean> {
  return waitForOsrmSlot(() => getPlanLimiters().osrm.consume("global", 1), {
    maxWaitMs: OSRM_SLOT_WAIT_MS,
    signal,
  });
}

/** Shared Census/ArcGIS slot. Cache hits must not call this. Busy → 429; Redis down → 503. */
export async function consumeSharedGeocodeSlot(signal?: AbortSignal): Promise<void> {
  const outcome = await waitForSharedSlot(() => getPlanLimiters().geocodeUpstream.consume("global", 1), {
    maxWaitMs: GEOCODE_SLOT_WAIT_MS,
    signal,
  });
  throwSharedSlotFailure(outcome, 2);
}
