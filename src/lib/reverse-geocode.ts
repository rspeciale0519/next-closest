import type { LatLng } from "./geo.ts";
import type { FetchJsonOptions } from "./geo-http.ts";

/** ArcGIS only — simpler than a shared Nominatim 1 req/s cap. */
export const REVERSE_GEOCODER = "arcgis" as const;

export function reverseGeocodeUrl(coords: LatLng, featureTypes?: string): string {
  const url = new URL("https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode");
  url.searchParams.set("f", "json");
  url.searchParams.set("location", `${coords.lng},${coords.lat}`);
  url.searchParams.set("outSR", "4326");
  if (featureTypes) url.searchParams.set("featureTypes", featureTypes);
  return url.toString();
}

export function reverseGeocodeFetchOpts(signal?: AbortSignal): FetchJsonOptions {
  return { signal, attempts: 1, timeoutMs: 8000 };
}

/** Shared 10/s Census/ArcGIS slot, then fetch with the same abort signal. */
export async function prepareReverseLookup(
  consumeSharedSlot: (signal?: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
): Promise<FetchJsonOptions> {
  await consumeSharedSlot(signal);
  return reverseGeocodeFetchOpts(signal);
}
