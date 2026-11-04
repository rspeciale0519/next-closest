import { Ratelimit } from "@upstash/ratelimit";
import { getRequest } from "@tanstack/react-start/server";
import {
  clientIpFromHeaders,
  createMemoryLimiter,
  RATE_LIMIT_ADDRESSES_PER_HOUR,
  RATE_LIMIT_GEOCODE_BATCHES_PER_MINUTE,
  RATE_LIMIT_OSRM_PER_WINDOW,
  RATE_LIMIT_OSRM_WINDOW_MS,
  OSRM_SLOT_WAIT_MS,
  waitForOsrmSlot,
  RATE_LIMIT_REQUESTS_PER_MINUTE,
  RateLimitError,
  type RateLimiter,
} from "./rate-limit.ts";
import { getRedis } from "./upstash-redis.server.ts";

export type PlanLimitKind = "interactive" | "geocode";

type Limiters = {
  interactive: RateLimiter;
  geocode: RateLimiter;
  addresses: RateLimiter;
  osrm: RateLimiter;
};

let cached: Limiters | undefined;

function upstashLimiter(
  limit: number,
  window: Parameters<typeof Ratelimit.slidingWindow>[1],
  prefix: string,
): RateLimiter | null {
  const redis = getRedis();
  if (!redis) return null;
  const rl = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(limit, window),
    prefix,
    analytics: false,
    timeout: 1500,
  });
  return {
    async consume(bucket: string, cost = 1) {
      const result = await rl.limit(bucket, { rate: Math.max(1, Math.floor(cost)) });
      if (result.success) return { ok: true };
      return {
        ok: false,
        retryAfterSec: Math.max(1, Math.ceil((result.reset - Date.now()) / 1000)),
      };
    },
  };
}

export function getPlanLimiters(): Limiters {
  if (cached) return cached;
  cached = {
    interactive:
      upstashLimiter(RATE_LIMIT_REQUESTS_PER_MINUTE, "1 m", "nc:rl:req") ??
      createMemoryLimiter(RATE_LIMIT_REQUESTS_PER_MINUTE, 60_000),
    geocode:
      upstashLimiter(RATE_LIMIT_GEOCODE_BATCHES_PER_MINUTE, "1 m", "nc:rl:geo") ??
      createMemoryLimiter(RATE_LIMIT_GEOCODE_BATCHES_PER_MINUTE, 60_000),
    addresses:
      upstashLimiter(RATE_LIMIT_ADDRESSES_PER_HOUR, "1 h", "nc:rl:addr") ??
      createMemoryLimiter(RATE_LIMIT_ADDRESSES_PER_HOUR, 60 * 60_000),
    osrm:
      upstashLimiter(RATE_LIMIT_OSRM_PER_WINDOW, "2 s", "nc:rl:osrm") ??
      createMemoryLimiter(RATE_LIMIT_OSRM_PER_WINDOW, RATE_LIMIT_OSRM_WINDOW_MS),
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

export async function enforcePlanLimit(opts: {
  kind?: PlanLimitKind;
  addresses?: number;
} = {}): Promise<void> {
  const ip = requestIp();
  const limiters = getPlanLimiters();
  const kind = opts.kind ?? "interactive";
  const requests = kind === "geocode" ? limiters.geocode : limiters.interactive;
  const req = await requests.consume(ip, 1);
  if (!req.ok) {
    throw new RateLimitError("Too many requests. Wait a minute and try again.", req.retryAfterSec);
  }
  const addresses = Math.max(0, Math.floor(opts.addresses ?? 0));
  if (addresses === 0) return;
  const addr = await limiters.addresses.consume(ip, addresses);
  if (!addr.ok) {
    throw new RateLimitError(
      "Address lookup limit reached for this hour. Try again later.",
      addr.retryAfterSec,
    );
  }
}

/** Global 1 OSRM table call / 2s. Waits up to 4s, then returns false. */
export async function tryConsumeOsrmSlot(signal?: AbortSignal): Promise<boolean> {
  return waitForOsrmSlot(() => getPlanLimiters().osrm.consume("global", 1), {
    maxWaitMs: OSRM_SLOT_WAIT_MS,
    signal,
  });
}
