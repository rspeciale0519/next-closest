import type { Place } from "./geo.ts";
import { normalizeGeocodeKey } from "./geo.ts";
import {
  cacheTtlSeconds,
  createMemoryGeocodeCache,
  type GeocodeCache,
} from "./geocode-cache.ts";
import { getRedis } from "./upstash-redis.server.ts";

type CacheRecord = { v: 1; place: Place | null };

const PREFIX = "nc:geo:";
const memory = createMemoryGeocodeCache();

export function getGeocodeCache(): GeocodeCache {
  const redis = getRedis();
  if (!redis) return memory;
  return {
    async get(query: string) {
      const local = await memory.get(query);
      if (local !== undefined) return local;
      try {
        const row = await redis.get<CacheRecord>(PREFIX + normalizeGeocodeKey(query));
        if (!row || row.v !== 1) return undefined;
        await memory.set(query, row.place);
        return row.place;
      } catch {
        return undefined;
      }
    },
    async set(query: string, place: Place | null) {
      await memory.set(query, place);
      try {
        await redis.set(PREFIX + normalizeGeocodeKey(query), { v: 1, place } satisfies CacheRecord, {
          ex: cacheTtlSeconds(place),
        });
      } catch {
        // keep the in-memory write
      }
    },
  };
}
