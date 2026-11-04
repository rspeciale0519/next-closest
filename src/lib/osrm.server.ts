import { getRequest } from "@tanstack/react-start/server";
import type { LatLng } from "./geo.ts";
import { fetchJson } from "./geo-http.ts";
import { getOsrmCache } from "./osrm-cache.server.ts";
import { osrmTableWithCache, type OsrmTableCache } from "./osrm-cache.ts";
import type { OsrmTable } from "./osrm.ts";
import { OSRM_TIMEOUT_MS } from "./plan-limits.ts";
import { tryConsumeOsrmSlot } from "./rate-limit.server.ts";

function inboundSignal(explicit?: AbortSignal): AbortSignal | undefined {
  if (explicit) return explicit;
  try {
    return getRequest()?.signal;
  } catch {
    return undefined;
  }
}

export async function lookupOsrmTable(
  points: LatLng[],
  signal?: AbortSignal,
  cache: OsrmTableCache = getOsrmCache(),
): Promise<OsrmTable | null> {
  if (points.length < 2) return null;
  const abort = inboundSignal(signal);
  return osrmTableWithCache(points, cache, async (next) => {
    const allowed = await tryConsumeOsrmSlot();
    if (!allowed) return null;
    return fetchOsrmTable(next, abort);
  });
}

export async function fetchOsrmTable(points: LatLng[], signal?: AbortSignal): Promise<OsrmTable | null> {
  if (points.length < 2) return null;
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");
  const url = `https://router.project-osrm.org/table/v1/driving/${coords}?annotations=duration,distance`;
  try {
    const json = await fetchJson<{
      code?: string;
      distances?: Array<Array<number | null>>;
      durations?: Array<Array<number | null>>;
    }>(url, undefined, {
      timeoutMs: OSRM_TIMEOUT_MS,
      attempts: 1,
      signal,
    });
    if (json.code !== "Ok" || !json.distances || !json.durations) return null;
    return { distances: json.distances, durations: json.durations };
  } catch {
    return null;
  }
}
