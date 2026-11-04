import { Redis } from "@upstash/redis";

let warned = false;
let cached: Redis | null | undefined;

export function readRedisEnv(): { url: string; token: string } | null {
  const url = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").trim();
  const token = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
  if (!url || !token) return null;
  return { url, token };
}

export function warnMissingRedisOnce(): void {
  if (warned) return;
  warned = true;
  console.warn(
    "[next-closest] KV_REST_API_URL/TOKEN or UPSTASH_REDIS_REST_URL/TOKEN is unset. Using in-memory rate limits and geocode cache; they are not shared across Vercel instances.",
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
