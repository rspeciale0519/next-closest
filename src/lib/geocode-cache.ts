import type { Place } from "./geo.ts";
import { normalizeGeocodeKey } from "./geo.ts";

export const GEOCODE_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
export const GEOCODE_MISS_TTL_SECONDS = 24 * 60 * 60;
/** One 2,500-stop list plus headroom for the start address and repeats. */
export const GEOCODE_MEMORY_CACHE_MAX = 5000;

export type CacheLookup = Place | null | undefined;

export type GeocodeCache = {
  get(query: string): Promise<CacheLookup>;
  set(query: string, place: Place | null): Promise<void>;
};

type Entry = { value: Place | null; exp: number };

export type MemoryGeocodeCacheOptions = {
  ttlMs?: number;
  missTtlMs?: number;
  maxEntries?: number;
  now?: () => number;
  store?: Map<string, Entry>;
};

export function cacheTtlSeconds(place: Place | null): number {
  return place === null ? GEOCODE_MISS_TTL_SECONDS : GEOCODE_CACHE_TTL_SECONDS;
}

export function createMemoryGeocodeCache(options: MemoryGeocodeCacheOptions = {}): GeocodeCache {
  const ttlMs = options.ttlMs ?? GEOCODE_CACHE_TTL_SECONDS * 1000;
  const missTtlMs = options.missTtlMs ?? GEOCODE_MISS_TTL_SECONDS * 1000;
  const maxEntries = options.maxEntries ?? GEOCODE_MEMORY_CACHE_MAX;
  const store = options.store ?? new Map<string, Entry>();
  const now = options.now ?? Date.now;

  const evict = () => {
    while (store.size > maxEntries) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      store.delete(oldest);
    }
  };

  return {
    async get(query: string) {
      const key = normalizeGeocodeKey(query);
      const row = store.get(key);
      if (!row) return undefined;
      if (row.exp <= now()) {
        store.delete(key);
        return undefined;
      }
      store.delete(key);
      store.set(key, row);
      return row.value;
    },
    async set(query: string, place: Place | null) {
      const key = normalizeGeocodeKey(query);
      const ttl = place === null ? missTtlMs : ttlMs;
      store.delete(key);
      store.set(key, { value: place, exp: now() + ttl });
      evict();
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

export function isUncacheableLookupError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"))
  );
}
