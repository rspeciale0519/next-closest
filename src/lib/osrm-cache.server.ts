import type { LatLng } from "./geo.ts";
import { createMemoryOsrmCache, OSRM_CACHE_TTL_SECONDS, type OsrmTableCache } from "./osrm-cache.ts";
import { osrmCacheKey, type OsrmTable } from "./osrm.ts";
import { getRedis } from "./upstash-redis.server.ts";

type CacheRecord = { v: 1; table: OsrmTable };

const PREFIX = "nc:osrm:";
const memory = createMemoryOsrmCache();

export function getOsrmCache(): OsrmTableCache {
  const redis = getRedis();
  if (!redis) return memory;
  return {
    async get(points: LatLng[]) {
      const local = await memory.get(points);
      if (local) return local;
      try {
        const row = await redis.get<CacheRecord>(PREFIX + osrmCacheKey(points));
        if (!row || row.v !== 1) return undefined;
        await memory.set(points, row.table);
        return row.table;
      } catch {
        return undefined;
      }
    },
    async set(points: LatLng[], table: OsrmTable) {
      await memory.set(points, table);
      try {
        await redis.set(PREFIX + osrmCacheKey(points), { v: 1, table } satisfies CacheRecord, {
          ex: OSRM_CACHE_TTL_SECONDS,
        });
      } catch {
        // keep the in-memory write
      }
    },
  };
}
