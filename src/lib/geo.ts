export type LatLng = { lat: number; lng: number };

export type Place = LatLng & {
  label: string;
  query: string;
};

export function parseAddressList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.replace(/^\s*(?:[•\-*]\s+|\d+[.)]\s+)/, "").trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export function haversineMeters(a: LatLng, b: LatLng): number {
  const r = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function buildDistanceMatrix(
  points: LatLng[],
  road?: { distances: Array<Array<number | null>>; durations: Array<Array<number | null>> },
): { meters: number[][]; seconds: number[][]; source: "road" | "straight" } {
  const n = points.length;
  const meters: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  const seconds: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  let roadLegs = 0;

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const straight = haversineMeters(points[i], points[j]);
      const roadM = road?.distances[i]?.[j];
      const roadS = road?.durations[i]?.[j];
      if (typeof roadM === "number" && typeof roadS === "number" && roadM >= 0 && roadS >= 0) {
        meters[i][j] = roadM;
        seconds[i][j] = roadS;
        roadLegs += 1;
      } else {
        meters[i][j] = straight;
        seconds[i][j] = straight / 15.65; // ~35 mph
      }
    }
  }

  return { meters, seconds, source: roadLegs > 0 ? "road" : "straight" };
}

/** Greedy nearest-next from index 0. Matches "drive to the next closest stop". */
export function orderNearestNext(matrix: number[][]): number[] {
  const n = matrix.length;
  if (n === 0) return [];
  const remaining = new Set(Array.from({ length: n - 1 }, (_, i) => i + 1));
  const order = [0];
  let current = 0;
  while (remaining.size > 0) {
    let best = -1;
    let bestD = Infinity;
    for (const i of remaining) {
      const d = matrix[current][i];
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    remaining.delete(best);
    order.push(best);
    current = best;
  }
  return order;
}

/** Open tour (start fixed). Exact for small lists; nearest-next + 2-opt otherwise. */
export function orderOpenTour(matrix: number[][]): number[] {
  const n = matrix.length;
  if (n <= 1) return Array.from({ length: n }, (_, i) => i);
  if (n <= 9) return exactOpenTour(matrix);
  return improve2Opt(orderNearestNext(matrix), matrix);
}

function pathCost(order: number[], matrix: number[][]): number {
  let cost = 0;
  for (let i = 0; i < order.length - 1; i++) cost += matrix[order[i]][order[i + 1]];
  return cost;
}

function exactOpenTour(matrix: number[][]): number[] {
  const rest = Array.from({ length: matrix.length - 1 }, (_, i) => i + 1);
  let bestOrder = [0, ...rest];
  let bestCost = pathCost(bestOrder, matrix);

  function permute(k: number) {
    if (k === rest.length) {
      const order = [0, ...rest];
      const cost = pathCost(order, matrix);
      if (cost < bestCost - 1e-6) {
        bestCost = cost;
        bestOrder = order;
      }
      return;
    }
    for (let i = k; i < rest.length; i++) {
      const tmp = rest[k];
      rest[k] = rest[i];
      rest[i] = tmp;
      permute(k + 1);
      rest[i] = rest[k];
      rest[k] = tmp;
    }
  }

  permute(0);
  return bestOrder;
}

function improve2Opt(order: number[], matrix: number[][]): number[] {
  const path = order.slice();
  let improved = true;
  while (improved) {
    improved = false;
    const current = pathCost(path, matrix);
    for (let i = 1; i < path.length - 1; i++) {
      for (let k = i + 1; k < path.length; k++) {
        const next = path.slice(0, i).concat(path.slice(i, k + 1).reverse(), path.slice(k + 1));
        if (pathCost(next, matrix) + 1e-6 < current) {
          path.splice(0, path.length, ...next);
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
  }
  return path;
}

export function formatMiles(meters: number): string {
  const miles = meters / 1609.344;
  if (miles < 0.1) return `${Math.round(meters * 3.28084)} ft`;
  if (miles < 10) return `${miles.toFixed(1)} mi`;
  return `${Math.round(miles)} mi`;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h <= 0) return m <= 0 ? "< 1 min" : `${m} min`;
  if (m === 0) return `${h} hr`;
  return `${h} hr ${m} min`;
}

function toRad(deg: number) {
  return (deg * Math.PI) / 180;
}
