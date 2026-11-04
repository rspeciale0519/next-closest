import {
  buildDistanceMatrix,
  haversineMeters,
  orderNearestByHaversine,
  orderNearestNext,
  STRAIGHT_LINE_MPS,
  type LatLng,
  type Place,
} from "./geo.ts";
import type { OrderedStop, PlanResult } from "./plan-types.ts";

export const OSRM_COORD_DECIMALS = 5;

export type OsrmTable = {
  distances: Array<Array<number | null>>;
  durations: Array<Array<number | null>>;
};

export function roundCoord(value: number): string {
  return value.toFixed(OSRM_COORD_DECIMALS);
}

/** Sorted rounded coordinate set — same points share a cache key. */
export function osrmCacheKey(points: LatLng[]): string {
  return points
    .map((point) => `${roundCoord(point.lat)},${roundCoord(point.lng)}`)
    .sort()
    .join("|");
}

export function planFromOsrmTable(start: Place, stops: Place[], table: OsrmTable): PlanResult | null {
  if (stops.length === 0) return null;
  const points: LatLng[] = [start, ...stops];
  const matrix = buildDistanceMatrix(points, table);
  if (matrix.source !== "road") return null;
  const order = orderNearestNext(matrix.seconds);
  const stopOrder = order.slice(1);
  if (stopOrder.length !== stops.length) return null;

  const ordered: OrderedStop[] = [];
  let totalMeters = 0;
  let totalSeconds = 0;
  let prev = 0;
  for (const idx of stopOrder) {
    const place = stops[idx - 1];
    if (!place) return null;
    const legMeters = matrix.meters[prev][idx];
    const legSeconds = matrix.seconds[prev][idx];
    totalMeters += legMeters;
    totalSeconds += legSeconds;
    ordered.push({ place, legMeters, legSeconds });
    prev = idx;
  }

  return {
    start,
    ordered,
    failures: [],
    polyline: [start, ...ordered.map((stop) => stop.place)].map((p) => [p.lat, p.lng]),
    totalMeters,
    totalSeconds,
    source: "road",
  };
}

export function stitchRoadHeadToTail(head: PlanResult, tail: Place[]): PlanResult {
  if (tail.length === 0) return head;
  const last = head.ordered.at(-1)?.place ?? head.start;
  const rest = orderNearestByHaversine(last, tail);
  const restOrdered: OrderedStop[] = [];
  let prev: LatLng = last;
  let extraMeters = 0;
  let extraSeconds = 0;
  for (const place of rest) {
    const legMeters = haversineMeters(prev, place);
    const legSeconds = legMeters / STRAIGHT_LINE_MPS;
    extraMeters += legMeters;
    extraSeconds += legSeconds;
    restOrdered.push({ place, legMeters, legSeconds });
    prev = place;
  }
  return {
    start: head.start,
    ordered: [...head.ordered, ...restOrdered],
    failures: [...head.failures],
    polyline: [head.start, ...head.ordered.map((s) => s.place), ...rest].map((p) => [p.lat, p.lng]),
    totalMeters: head.totalMeters + extraMeters,
    totalSeconds: head.totalSeconds + extraSeconds,
    source: "road",
  };
}
