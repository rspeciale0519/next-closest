import {
  chunkItems,
  haversineMeters,
  normalizeGeocodeKey,
  orderNearestByHaversine,
  STRAIGHT_LINE_MPS,
  type LatLng,
  type Place,
} from "./geo.ts";
import { stitchRoadHeadToTail } from "./osrm.ts";
import { sleep } from "./geo-http.ts";
import {
  GEOCODE_BATCH_SIZE,
  MAX_PLAN_STOPS,
  ROAD_REFINE_MAX_STOPS,
  STRAIGHT_LINE_FALLBACK_NOTE,
} from "./plan-limits.ts";
import { RateLimitError } from "./rate-limit.ts";
import type { GeocodedStop, PlanFailure, PlanProgress, PlanResult, PlanStart } from "./plan-types.ts";

export {
  MAX_PLAN_STOPS,
  GEOCODE_BATCH_SIZE,
  ROAD_REFINE_MAX_STOPS,
  STRAIGHT_LINE_FALLBACK_NOTE,
} from "./plan-limits.ts";
export type { GeocodedStop, PlanFailure, PlanProgress, PlanResult, PlanStart } from "./plan-types.ts";

export type PlanDeps = {
  resolveStart: (start: PlanStart) => Promise<Place>;
  geocodeBatch: (input: {
    queries: string[];
    bias?: LatLng;
    region?: string;
  }) => Promise<GeocodedStop[]>;
  refineRoad?: (start: Place, stops: Place[]) => Promise<PlanResult | null>;
};

export type RunPlanOptions = {
  onProgress?: (progress: PlanProgress) => void;
  batchSize?: number;
  cache?: Map<string, Place | null>;
  yieldFn?: () => Promise<void>;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
};

export function retryAfterSecFromError(err: unknown): number | null {
  if (err instanceof RateLimitError) return Math.max(1, err.retryAfterSec);
  if (typeof Response !== "undefined" && err instanceof Response && err.status === 429) {
    const header = Number(err.headers.get("Retry-After"));
    return Number.isFinite(header) && header > 0 ? header : 1;
  }
  if (err instanceof Error) {
    const named = /too many (requests|address lookups)|try again (shortly|later)/i.test(err.message);
    if (!named && !("status" in err && (err as { status?: number }).status === 429)) return null;
    const match = err.message.match(/retry-after:\s*(\d+)/i);
    if (match) return Number(match[1]);
    if ("status" in err && (err as { status?: number }).status === 429) return 1;
    if (named) return 2;
  }
  return null;
}

export async function withOne429Retry<T>(
  fn: () => Promise<T>,
  options: { sleep?: (ms: number) => Promise<void>; signal?: AbortSignal } = {},
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isAbortError(err)) throw err;
    const waitSec = retryAfterSecFromError(err);
    if (waitSec === null) throw err;
    throwIfAborted(options.signal);
    await (options.sleep ?? sleep)(Math.min(60, Math.max(1, waitSec)) * 1000);
    throwIfAborted(options.signal);
    return fn();
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException("Stopped", "AbortError");
}

export function tooManyStopsMessage(limit = MAX_PLAN_STOPS): string {
  return `Lists are limited to ${limit.toLocaleString()} addresses. Remove some stops or split the list.`;
}

export function formatPlanProgress(progress: PlanProgress): string {
  if (progress.phase === "geocode") {
    return `Locating addresses ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}`;
  }
  if (progress.phase === "start") return "Finding start address";
  if (progress.phase === "road") return "Calculating road distances";
  return `Sorting ${progress.total.toLocaleString()} stops`;
}

export type PlanProgressView = {
  now: number;
  max: number;
  percent: number;
  label: string;
};

/** Count + bar fill. Locate uses processed/total; sort/road keep that fill (no snap). */
export function planProgressView(progress: PlanProgress): PlanProgressView {
  const max = Math.max(0, progress.total);
  const now = Math.min(Math.max(0, progress.done), max);
  const percent = max === 0 ? 0 : (now / max) * 100;
  if (progress.phase === "order") {
    return { now, max, percent, label: `Sorting ${max.toLocaleString()} stops` };
  }
  if (progress.phase === "road") {
    return { now, max, percent, label: "Calculating road distances" };
  }
  return {
    now,
    max,
    percent,
    label: `${now.toLocaleString()} of ${max.toLocaleString()} addresses`,
  };
}

export function assembleStraightPlan(start: Place, ordered: Place[]): PlanResult {
  const stops: PlanResult["ordered"] = [];
  let prev: LatLng = start;
  let totalMeters = 0;
  let totalSeconds = 0;
  for (const place of ordered) {
    const legMeters = haversineMeters(prev, place);
    const legSeconds = legMeters / STRAIGHT_LINE_MPS;
    totalMeters += legMeters;
    totalSeconds += legSeconds;
    stops.push({ place, legMeters, legSeconds });
    prev = place;
  }
  return {
    start,
    ordered: stops,
    failures: [],
    polyline: [start, ...ordered].map((p) => [p.lat, p.lng]),
    totalMeters,
    totalSeconds,
    source: "straight",
  };
}

export function regionHintFromPlace(place: Place): string {
  const text = place.label || place.query;
  return text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(1)
    .filter((part) => !/^(usa|united states|us)$/i.test(part))
    .filter((part) => !/^\d{5}(?:-\d{4})?$/.test(part))
    .join(", ");
}

export async function runPlan(
  input: { start: PlanStart; stops: string[] },
  deps: PlanDeps,
  options: RunPlanOptions = {},
): Promise<PlanResult> {
  const stops = input.stops.map((line) => line.trim()).filter(Boolean);
  if (stops.length === 0) throw new Error("Add at least one stop.");
  if (stops.length > MAX_PLAN_STOPS) throw new Error(tooManyStopsMessage());

  const notify = options.onProgress ?? (() => undefined);
  const batchSize = options.batchSize ?? GEOCODE_BATCH_SIZE;
  const cache = options.cache ?? new Map<string, Place | null>();
  const yieldFn = options.yieldFn ?? (async () => undefined);
  const signal = options.signal;
  const retry = <T>(fn: () => Promise<T>) =>
    withOne429Retry(fn, { sleep: options.sleep, signal });

  throwIfAborted(signal);
  notify({ phase: "geocode", done: 0, total: stops.length });
  const start = await retry(() => deps.resolveStart(input.start));
  throwIfAborted(signal);
  const region = regionHintFromPlace(start);
  const bias = { lat: start.lat, lng: start.lng };

  const located: Place[] = [];
  const failures: PlanFailure[] = [];
  const pending: string[] = [];

  for (const query of stops) {
    const key = normalizeGeocodeKey(query);
    if (!cache.has(key)) {
      pending.push(query);
      continue;
    }
    const cached = cache.get(key) ?? null;
    if (cached) located.push({ ...cached, query });
    else failures.push({ query, message: "Could not find this address" });
  }

  let done = stops.length - pending.length;
  notify({ phase: "geocode", done, total: stops.length });

  for (const batch of chunkItems(pending, batchSize)) {
    throwIfAborted(signal);
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const query of batch) {
      const key = normalizeGeocodeKey(query);
      if (seen.has(key) || cache.has(key)) continue;
      seen.add(key);
      unique.push(query);
    }
    if (unique.length > 0) {
      const found = await retry(() => deps.geocodeBatch({ queries: unique, bias, region }));
      for (const item of found) {
        cache.set(normalizeGeocodeKey(item.query), item.place);
      }
    }
    for (const query of batch) {
      const place = cache.get(normalizeGeocodeKey(query)) ?? null;
      if (place) located.push({ ...place, query });
      else failures.push({ query, message: "Could not find this address" });
      done += 1;
    }
    notify({ phase: "geocode", done, total: stops.length });
    await yieldFn();
  }

  if (located.length === 0) {
    return {
      start,
      ordered: [],
      failures,
      polyline: [],
      totalMeters: 0,
      totalSeconds: 0,
      source: "straight",
    };
  }

  throwIfAborted(signal);
  notify({ phase: "order", done, total: stops.length });
  await yieldFn();
  const chain = orderNearestByHaversine(start, located);
  const head = chain.slice(0, ROAD_REFINE_MAX_STOPS);
  const tail = chain.slice(ROAD_REFINE_MAX_STOPS);

  if (deps.refineRoad && head.length > 0) {
    throwIfAborted(signal);
    notify({ phase: "road", done, total: stops.length });
    await yieldFn();
    try {
      const refined = await retry(() => deps.refineRoad!(start, head));
      if (refined?.source === "road" && refined.ordered.length === head.length) {
        const stitched = stitchRoadHeadToTail(refined, tail);
        return { ...stitched, failures: [...refined.failures, ...failures] };
      }
    } catch (err) {
      if (isAbortError(err)) throw err;
    }
    return {
      ...assembleStraightPlan(start, chain),
      failures,
      note: STRAIGHT_LINE_FALLBACK_NOTE,
    };
  }

  return { ...assembleStraightPlan(start, chain), failures };
}
