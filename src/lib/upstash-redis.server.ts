import { Redis } from "@upstash/redis";
import { limitFailClosedFromEnv } from "./rate-limit.ts";

let warned = false;
let cached: Redis | null | undefined;

export function readRedisEnv(
  env: Record<string, string | undefined> = process.env,
): { url: string; token: string } | null {
  const url = (env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || "").trim();
  const token = (env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || "").trim();
  if (!url || !token) return null;
  return { url, token };
}

export function warnMissingRedisOnce(): void {
  if (warned) return;
  warned = true;
  if (limitFailClosedFromEnv()) {
    console.warn(
      "[next-closest] KV_REST_API_URL/TOKEN or UPSTASH_REDIS_REST_URL/TOKEN is unset. Production fails closed: geocoding is unavailable and OSRM is skipped.",
    );
    return;
  }
  console.warn(
    "[next-closest] KV_REST_API_URL/TOKEN or UPSTASH_REDIS_REST_URL/TOKEN is unset. Using in-memory rate limits and geocode cache (dev/test only).",
  );
}

export function getRedis(): Redis | null {
  if (cached !== undefined) return cached;
  const env = readRedisEnv();
  if (!env) {
    warnMissingRedisOnce();
    cached = null;
    return null;
  }
  cached = new Redis({ url: env.url, token: env.token });
  return cached;
}

export function resetRedisForTests(): void {
  cached = undefined;
  warned = false;
}
