import { GEOCODE_CACHE_TTL_SECONDS } from "./geocode-cache.ts";
import { osrmCacheKey, type OsrmTable } from "./osrm.ts";
import type { LatLng } from "./geo.ts";

export const OSRM_CACHE_TTL_SECONDS = GEOCODE_CACHE_TTL_SECONDS;

type Entry = { value: OsrmTable; exp: number };

export type OsrmTableCache = {
  get(points: LatLng[]): Promise<OsrmTable | undefined>;
  set(points: LatLng[], table: OsrmTable): Promise<void>;
};

export function createMemoryOsrmCache(
  ttlMs = OSRM_CACHE_TTL_SECONDS * 1000,
  store: Map<string, Entry> = new Map(),
): OsrmTableCache {
  return {
    async get(points: LatLng[]) {
      const key = osrmCacheKey(points);
      const row = store.get(key);
      if (!row) return undefined;
      if (row.exp <= Date.now()) {
        store.delete(key);
        return undefined;
      }
      return row.value;
    },
    async set(points: LatLng[], table: OsrmTable) {
      store.set(osrmCacheKey(points), { value: table, exp: Date.now() + ttlMs });
    },
  };
}

export async function osrmTableWithCache(
  points: LatLng[],
  cache: OsrmTableCache,
  lookup: (points: LatLng[]) => Promise<OsrmTable | null>,
): Promise<OsrmTable | null> {
  const hit = await cache.get(points);
  if (hit) return hit;
  const table = await lookup(points);
  if (table) await cache.set(points, table);
  return table;
}
