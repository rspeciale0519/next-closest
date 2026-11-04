/**
 * Stop-count and batching limits for Next Closest.
 *
 * Why the old UI died at 25: `planRoute` validated `stops` with zod `.max(25)`.
 * That number was chosen in the first commit (5e27e99) as an application cap,
 * not because an upstream API rejects 26 addresses.
 *
 * Real upstream limits this code respects:
 * - US Census / ArcGIS / Photon / Nominatim geocoders: one address per HTTP
 *   request (Census also has a 10,000-row file-upload batch API; we keep the
 *   existing one-line fallback chain instead).
 * - Public OSRM table (`router.project-osrm.org`): 100 coordinates / 10,000
 *   cells. A 1,312-stop matrix cannot be requested there.
 * - Nominatim usage policy: about 1 request/second (last-resort geocoder).
 * - Vercel serverless time budget: geocoding 1,312 addresses in one function
 *   would time out, so the client drives many small `geocodeStops` calls.
 *
 * The hard stop cap matches the spreadsheet importer (`SPREADSHEET_LIMITS.maxRows`).
 */
export const MAX_PLAN_STOPS = 2500;

/** Addresses per `geocodeStops` server call. Not an upstream batch max. */
export const GEOCODE_BATCH_SIZE = 20;

/** Parallel geocode lookups inside one server call. */
export const GEOCODE_CONCURRENCY = 5;

/**
 * Max stops sent to the public OSRM table (start + this many <= 100).
 * Lists larger than this are ordered with haversine nearest-neighbor.
 */
export const ROAD_REFINE_MAX_STOPS = 99;

/** OSRM route polylines stay on the original small-list path only. */
export const ROAD_POLYLINE_MAX_STOPS = 25;
