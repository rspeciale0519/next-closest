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
 * Max stops sent to the public OSRM table (start + this many <= 100).
 * Lists larger than this are ordered with haversine nearest-neighbor.
 */
export const ROAD_REFINE_MAX_STOPS = 99;

/** OSRM route polylines stay on the original small-list path only. */
export const ROAD_POLYLINE_MAX_STOPS = 25;
