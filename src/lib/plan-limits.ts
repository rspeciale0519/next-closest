/**
 * Stop-count and batching limits for Next Closest.
 *
 * Why the old UI died at 25: the removed `planRoute` server function validated
 * `stops` with zod `.max(25)`. That number was an application cap from the
 * first commit (5e27e99), not an upstream API maximum.
 *
 * Real upstream limits this code respects:
 * - List geocoding is **US Census then ArcGIS only**, one address per HTTP
 *   request. Photon and Nominatim stay on typeahead / reverse, never on lists.
 * - Public OSRM table (`router.project-osrm.org`): 100 coordinates / 10,000
 *   cells. A 1,312-stop matrix cannot be requested there.
 * - Vercel serverless time: one `geocodeStops` call must finish inside
 *   `PLAN_FN_MAX_DURATION_SECONDS`. The client therefore drives many batches.
 *
 * Worst case for one `geocodeStops` call, all misses:
 *   20 addresses × 2 providers × 1 attempt × 4s timeout / 5 workers ≈ 32s.
 * Function `maxDuration` is 60s, so that batch returns instead of being killed.
 *
 * The hard stop cap matches the spreadsheet importer (`SPREADSHEET_LIMITS.maxRows`).
 */
export const MAX_PLAN_STOPS = 2500;

/** Addresses per `geocodeStops` server call. Not an upstream batch max. */
export const GEOCODE_BATCH_SIZE = 20;

/** Parallel geocode lookups inside one server call. */
export const GEOCODE_CONCURRENCY = 5;

/** Vercel / Nitro function budget for plan RPCs. */
export const PLAN_FN_MAX_DURATION_SECONDS = 60;

/** List-path fetch: one attempt so a full miss batch stays under maxDuration. */
export const LIST_GEOCODE_TIMEOUT_MS = 4000;
export const LIST_GEOCODE_ATTEMPTS = 1;

/**
 * After a full-list haversine chain, this many leading stops (plus the
 * origin) go to one public OSRM table call. The rest stay straight-line.
 * Public OSRM allows 100 coordinates; 1 + 25 is well under that.
 */
export const ROAD_REFINE_MAX_STOPS = 25;

/** Public OSRM table timeout. One attempt, then fall back to straight-line. */
export const OSRM_TIMEOUT_MS = 8000;

/**
 * FOSSGIS public OSRM allows 1 request/second. We share 1 call / 2s across
 * every instance so there is headroom. If the slot is busy, wait up to
 * `OSRM_SLOT_WAIT_MS` then fall back to straight-line.
 */
export const OSRM_GLOBAL_INTERVAL_MS = 2000;
export const OSRM_SLOT_WAIT_MS = 4000;

/**
 * Shared Census/ArcGIS cap: 10 upstream HTTP calls / second across instances.
 * A 2,500-stop list (Census hits) is 2,500 calls ≈ 250s at the cap. Cache hits
 * do not consume a slot. If the slot is busy, wait up to this budget then
 * reject the lookup (production also fails closed when Redis is down).
 */
export const GEOCODE_UPSTREAM_INTERVAL_MS = 1000;
export const GEOCODE_SLOT_WAIT_MS = 4000;

export const STRAIGHT_LINE_FALLBACK_NOTE =
  "Ordered by straight-line distance (driving times unavailable).";
