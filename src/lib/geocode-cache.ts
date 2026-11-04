import type { Place } from "./geo.ts";
import { normalizeGeocodeKey } from "./geo.ts";

export const GEOCODE_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

export type CacheLookup = Place | null | undefined;

export type GeocodeCache = {
  get(query: string): Promise<CacheLookup>;
  set(query: string, place: Place | null): Promise<void>;
};

type Entry = { value: Place | null; exp: number };

export function createMemoryGeocodeCache(
  ttlMs = GEOCODE_CACHE_TTL_SECONDS * 1000,
  store: Map<string, Entry> = new Map(),
): GeocodeCache {
  return {
    async get(query: string) {
      const row = store.get(normalizeGeocodeKey(query));
      if (!row) return undefined;
      if (row.exp <= Date.now()) {
        store.delete(normalizeGeocodeKey(query));
        return undefined;
      }
      return row.value;
    },
    async set(query: string, place: Place | null) {
      store.set(normalizeGeocodeKey(query), { value: place, exp: Date.now() + ttlMs });
    },
  };
}

export async function geocodeWithCache(
  query: string,
  cache: GeocodeCache,
  lookup: (query: string) => Promise<Place | null>,
): Promise<Place | null> {
  const hit = await cache.get(query);
  if (hit !== undefined) {
    return hit ? { ...hit, query } : null;
  }
  const place = await lookup(query);
  await cache.set(query, place);
  return place ? { ...place, query } : null;
}
