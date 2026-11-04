import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  haversineMeters,
  normalizeGeocodeKey,
  type LatLng,
  type Place,
} from "./geo";
import { fetchJson, mapPool } from "./geo-http.ts";
import { geocodeWithCache } from "./geocode-cache.ts";
import { planFromOsrmTable } from "./osrm.ts";
import {
  GEOCODE_CONCURRENCY,
  LIST_GEOCODE_ATTEMPTS,
  LIST_GEOCODE_TIMEOUT_MS,
  ROAD_REFINE_MAX_STOPS,
} from "./plan-limits.ts";
import type { GeocodedStop, OrderedStop, PlanFailure, PlanResult } from "./plan-types.ts";

const latLngSchema = z.object({
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
});

const suggestInput = z.object({
  query: z.string().trim().min(2).max(200),
  bias: latLngSchema.optional(),
});

const reverseInput = latLngSchema;

const startInput = z.object({
  query: z.string().trim().min(1).max(300),
  coords: latLngSchema.optional(),
  label: z.string().trim().max(300).optional(),
});

const placeSchema = z.object({
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
  label: z.string().trim().min(1).max(300),
  query: z.string().trim().min(1).max(300),
});

const geocodeBatchInput = z.object({
  queries: z.array(z.string().trim().min(1).max(300)).min(1).max(20),
  bias: latLngSchema.optional(),
  region: z.string().trim().max(300).optional(),
});

const refineInput = z.object({
  start: placeSchema,
  stops: z.array(placeSchema).min(1).max(ROAD_REFINE_MAX_STOPS),
});

export type Suggestion = Place;
export type { GeocodedStop, OrderedStop, PlanFailure, PlanResult };

type PhotonFeature = {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    name?: string;
    street?: string;
    housenumber?: string;
    city?: string;
    town?: string;
    village?: string;
    locality?: string;
    state?: string;
    postcode?: string;
    country?: string;
  };
};

export const suggestPlaces = createServerFn({ method: "POST" })
  .validator((data) => suggestInput.parse(data))
  .handler(async ({ data }): Promise<Suggestion[]> => {
    const { enforcePlanLimit } = await import("./rate-limit.server.ts");
    await enforcePlanLimit({ kind: "interactive" });
    return photonSuggest(data.query, data.bias);
  });

export const reverseGeocode = createServerFn({ method: "POST" })
  .validator((data) => reverseInput.parse(data))
  .handler(async ({ data }): Promise<Place> => {
    const { enforcePlanLimit } = await import("./rate-limit.server.ts");
    await enforcePlanLimit({ kind: "interactive" });
    const nearest = await placeForCoords(data);
    if (nearest) return nearest;
    return {
      lat: data.lat,
      lng: data.lng,
      query: "Current location",
      label: "Current location",
    };
  });

export const resolveStartPlace = createServerFn({ method: "POST" })
  .validator((data) => startInput.parse(data))
  .handler(async ({ data }): Promise<Place> => {
    const { enforcePlanLimit } = await import("./rate-limit.server.ts");
    await enforcePlanLimit({ kind: "interactive", addresses: data.coords ? 0 : 1 });
    return resolveStart(data);
  });

export const geocodeStops = createServerFn({ method: "POST" })
  .validator((data) => geocodeBatchInput.parse(data))
  .handler(async ({ data }): Promise<GeocodedStop[]> => {
    const { enforcePlanLimit } = await import("./rate-limit.server.ts");
    const { getGeocodeCache } = await import("./geocode-cache.server.ts");
    const cache = getGeocodeCache();
    const unique: string[] = [];
    const firstIndex = new Map<string, number>();
    data.queries.forEach((query) => {
      const key = normalizeGeocodeKey(query);
      if (!firstIndex.has(key)) {
        firstIndex.set(key, unique.length);
        unique.push(query);
      }
    });

    const pending: string[] = [];
    for (const query of unique) {
      if ((await cache.get(query)) === undefined) pending.push(query);
    }
    await enforcePlanLimit({ kind: "geocode", addresses: pending.length });

    const found = await mapPool(unique, GEOCODE_CONCURRENCY, (query) =>
      geocodeWithCache(query, cache, (next) => geocodeListOne(next, data.bias)),
    );
    return data.queries.map((query) => {
      const key = normalizeGeocodeKey(query);
      const place = found[firstIndex.get(key) ?? 0] ?? null;
      return { query, place };
    });
  });

export const refineRoadOrder = createServerFn({ method: "POST" })
  .validator((data) => refineInput.parse(data))
  .handler(async ({ data }): Promise<PlanResult | null> => {
    const { enforcePlanLimit } = await import("./rate-limit.server.ts");
    await enforcePlanLimit({ kind: "interactive" });
    const { lookupOsrmTable } = await import("./osrm.server.ts");
    const table = await lookupOsrmTable([data.start, ...data.stops]);
    if (!table) return null;
    return planFromOsrmTable(data.start, data.stops, table);
  });

async function resolveStart(start: z.infer<typeof startInput>): Promise<Place> {
  if (start.coords) {
    const nearest = start.label?.trim()
      ? {
          lat: start.coords.lat,
          lng: start.coords.lng,
          query: start.query,
          label: start.label.trim(),
        }
      : await placeForCoords(start.coords);
    if (nearest) return nearest;
    return {
      lat: start.coords.lat,
      lng: start.coords.lng,
      query: start.query,
      label: start.query,
    };
  }
  const found = await geocodeListOne(start.query);
  if (!found) {
    throw new Error(`Could not find starting address: ${start.query}`);
  }
  return found;
}

/** List + start geocode: Census, then ArcGIS. No Photon/Nominatim, no variant fan-out. */
async function geocodeListOne(query: string, bias?: LatLng): Promise<Place | null> {
  const census = await censusGeocode(query, {
    timeoutMs: LIST_GEOCODE_TIMEOUT_MS,
    attempts: LIST_GEOCODE_ATTEMPTS,
  });
  if (census) return { ...census, query };
  const arcgis = await arcgisGeocode(query, bias, {
    timeoutMs: LIST_GEOCODE_TIMEOUT_MS,
    attempts: LIST_GEOCODE_ATTEMPTS,
  });
  return arcgis ? { ...arcgis, query } : null;
}

async function photonSuggest(query: string, bias?: LatLng, limit = 6): Promise<Place[]> {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("lang", "en");
  if (bias) {
    url.searchParams.set("lat", String(bias.lat));
    url.searchParams.set("lon", String(bias.lng));
  }
  try {
    const json = await fetchJson<{ features?: PhotonFeature[] }>(url.toString());
    return (json.features ?? [])
      .map((f) => featureToPlace(f, query))
      .filter((p): p is Place => p !== null);
  } catch {
    return [];
  }
}

async function placeForCoords(coords: LatLng): Promise<Place | null> {
  const numbered = (place: Place | null) => (place && /^\d+\s+\S/.test(place.label) ? place : null);
  return (
    numbered(await arcgisReverse(coords, "PointAddress,Subaddress,StreetAddress")) ||
    numbered(await arcgisReverse(coords)) ||
    numbered(await nominatimReverse(coords)) ||
    numbered(await photonReverse(coords)) ||
    (await arcgisReverse(coords, "PointAddress,Subaddress,StreetAddress")) ||
    (await arcgisReverse(coords)) ||
    (await nominatimReverse(coords)) ||
    (await photonReverse(coords))
  );
}

type ArcgisAddress = {
  Match_addr?: string;
  LongLabel?: string;
  Addr_type?: string;
  AddNum?: string;
  Address?: string;
  City?: string;
  RegionAbbr?: string;
  Region?: string;
  Postal?: string;
};

async function arcgisReverse(coords: LatLng, featureTypes?: string): Promise<Place | null> {
  const url = new URL("https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode");
  url.searchParams.set("f", "json");
  url.searchParams.set("location", `${coords.lng},${coords.lat}`);
  url.searchParams.set("outSR", "4326");
  if (featureTypes) url.searchParams.set("featureTypes", featureTypes);
  try {
    const json = await fetchJson<{
      address?: ArcgisAddress;
      location?: { x?: number; y?: number };
    }>(url.toString());
    const label = formatArcgisStreet(json.address);
    const lat = json.location?.y;
    const lng = json.location?.x;
    if (!label || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat: lat as number, lng: lng as number, query: label, label };
  } catch {
    return null;
  }
}

function formatArcgisStreet(address?: ArcgisAddress): string | null {
  if (!address) return null;
  let street = (address.Address || "").trim();
  const num = (address.AddNum || "").trim();
  if (num && street && !street.toLowerCase().startsWith(num.toLowerCase())) {
    street = `${num} ${street}`;
  }
  if (!street) {
    const long = (address.LongLabel || address.Match_addr || "").replace(/,?\s*USA$/i, "");
    const part = long.split(",").map((s) => s.trim()).find((s) => /^\d+\s+\S/.test(s));
    street = part || "";
  }
  if (!street) return null;
  const city = (address.City || "").trim();
  const state = (address.RegionAbbr || stateAbbr(address.Region) || "").trim();
  const zip = (address.Postal || "").trim();
  const region = [state, zip].filter(Boolean).join(" ");
  return formatUsAddress([street, city, region].filter(Boolean).join(", "));
}

async function nominatimReverse(coords: LatLng): Promise<Place | null> {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("lat", String(coords.lat));
  url.searchParams.set("lon", String(coords.lng));
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("zoom", "18");
  url.searchParams.set("addressdetails", "1");
  try {
    const json = await fetchJson<{
      lat?: string;
      lon?: string;
      address?: {
        house_number?: string;
        road?: string;
        pedestrian?: string;
        city?: string;
        town?: string;
        village?: string;
        hamlet?: string;
        state?: string;
        postcode?: string;
      };
    }>(url.toString());
    const addr = json.address;
    const lat = Number(json.lat);
    const lng = Number(json.lon);
    if (!addr || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const street = [addr.house_number, addr.road || addr.pedestrian].filter(Boolean).join(" ");
    if (!street) return null;
    const city = addr.city || addr.town || addr.village || addr.hamlet;
    const region = [stateAbbr(addr.state), addr.postcode].filter(Boolean).join(" ");
    const label = formatUsAddress([street, city, region].filter(Boolean).join(", "));
    return { lat, lng, query: label, label };
  } catch {
    return null;
  }
}

async function photonReverse(coords: LatLng): Promise<Place | null> {
  const url = new URL("https://photon.komoot.io/reverse");
  url.searchParams.set("lat", String(coords.lat));
  url.searchParams.set("lon", String(coords.lng));
  try {
    const json = await fetchJson<{ features?: PhotonFeature[] }>(url.toString());
    const place = streetFeatureToPlace(
      json.features?.[0],
      `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`,
    );
    if (!place) return null;
    return place;
  } catch {
    return null;
  }
}

type ArcgisResponse = {
  candidates?: Array<{
    address?: string;
    score?: number;
    location?: { x?: number; y?: number };
    attributes?: { Addr_type?: string; Match_addr?: string };
  }>;
};

async function arcgisGeocode(
  query: string,
  bias?: LatLng,
  fetchOpts?: { timeoutMs?: number; attempts?: number },
): Promise<Place | null> {
  const url = new URL("https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates");
  url.searchParams.set("f", "json");
  url.searchParams.set("singleLine", query);
  url.searchParams.set("maxLocations", "5");
  url.searchParams.set("outFields", "Addr_type,Match_addr");
  url.searchParams.set("countryCode", "USA");
  if (bias) url.searchParams.set("location", `${bias.lng},${bias.lat}`);
  try {
    const json = await fetchJson<ArcgisResponse>(url.toString(), undefined, {
      timeoutMs: fetchOpts?.timeoutMs ?? 12000,
      attempts: fetchOpts?.attempts,
    });
    const places: Place[] = [];
    for (const hit of json.candidates ?? []) {
      const lat = hit.location?.y;
      const lng = hit.location?.x;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const kind = hit.attributes?.Addr_type ?? "";
      const score = hit.score ?? 0;
      if (score < 80 && !/pointaddress|streetaddress|subaddress/i.test(kind)) continue;
      places.push({
        lat: lat as number,
        lng: lng as number,
        query,
        label: titleCaseAddress(hit.attributes?.Match_addr || hit.address || query),
      });
    }
    const matched = pickMatchingPlace(query, places, bias);
    if (matched) return matched;
    const top = json.candidates?.[0];
    if (!top || (top.score ?? 0) < 95) return null;
    const lat = top.location?.y;
    const lng = top.location?.x;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (bias && haversineMiles({ lat: lat as number, lng: lng as number }, bias) > 80) return null;
    return {
      lat: lat as number,
      lng: lng as number,
      query,
      label: titleCaseAddress(top.attributes?.Match_addr || top.address || query),
    };
  } catch {
    return null;
  }
}

type CensusResponse = {
  result?: {
    addressMatches?: Array<{
      matchedAddress?: string;
      coordinates?: { x?: number; y?: number };
    }>;
  };
};

async function censusGeocode(
  query: string,
  fetchOpts?: { timeoutMs?: number; attempts?: number },
): Promise<Place | null> {
  const url = new URL("https://geocoding.geo.census.gov/geocoder/locations/onelineaddress");
  url.searchParams.set("address", query);
  url.searchParams.set("benchmark", "Public_AR_Current");
  url.searchParams.set("format", "json");
  try {
    const json = await fetchJson<CensusResponse>(url.toString(), undefined, {
      timeoutMs: fetchOpts?.timeoutMs ?? 12000,
      attempts: fetchOpts?.attempts,
    });
    const match = json.result?.addressMatches?.[0];
    const lng = match?.coordinates?.x;
    const lat = match?.coordinates?.y;
    if (!match || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return {
      lat: lat as number,
      lng: lng as number,
      query,
      label: titleCaseAddress(match.matchedAddress || query),
    };
  } catch {
    return null;
  }
}

function looksLikeHouseNumber(query: string): boolean {
  return /^\d+\s+\S/.test(query.trim());
}

function pickMatchingPlace(query: string, places: Place[], bias?: LatLng): Place | null {
  if (places.length === 0) return null;
  const key = streetKey(query);
  const house = houseNumber(query);
  const ranked = places
    .map((place) => {
      const hitKey = streetKey(`${place.label} ${place.query}`);
      const hitHouse = houseNumber(place.label);
      const streetHit = Boolean(key && hitKey && (hitKey.includes(key) || key.includes(hitKey)));
      const houseHit = Boolean(house && hitHouse && house === hitHouse);
      const miles = bias ? haversineMiles(place, bias) : 0;
      let score = 0;
      if (streetHit) score += 8;
      if (houseHit) score += 4;
      if (miles > 0 && miles < 40) score += 2;
      if (miles > 80) score -= 6;
      return { place, score, streetHit };
    })
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (best && best.score >= 8) return best.place;
  if (best && best.streetHit) return best.place;
  if (best && looksLikeHouseNumber(query) && best.score >= 4) return best.place;
  if (!key) return places[0] ?? null;
  return null;
}

function houseNumber(value: string): string {
  return value.trim().match(/^(\d+[A-Za-z]?)/)?.[1] ?? "";
}

function streetKey(value: string): string {
  const street =
    value
      .toLowerCase()
      .split(",")[0]
      ?.replace(/^\d+[A-Za-z]?\s+/, "")
      .replace(
        /\b(street|st|drive|dr|avenue|ave|road|rd|lane|ln|court|ct|blvd|boulevard|way|circle|cir|place|pl|terrace|ter|trail|trl|parkway|pkwy|highway|hwy|loop|run|path|pass|ridge|point|pt|plaza|row)\b/g,
        "",
      ) ?? "";
  return street.replace(/[^a-z]/g, "");
}

function haversineMiles(a: LatLng, b: LatLng): number {
  return haversineMeters(a, b) / 1609.344;
}

function titleCaseAddress(value: string): string {
  return value
    .toLowerCase()
    .split(", ")
    .map((part) =>
      part
        .split(" ")
        .map((word) => (word.length <= 2 ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)))
        .join(" "),
    )
    .join(", ");
}

function formatUsAddress(value: string): string {
  return titleCaseAddress(value)
    .replace(/\bFlorida\b/gi, "FL")
    .replace(/, ([A-Z]{2}), (\d{5}(?:-\d{4})?)\b/, ", $1 $2");
}

function stateAbbr(value?: string): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  return US_STATE_ABBR[trimmed.toLowerCase()] || trimmed;
}

const US_STATE_ABBR: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "district of columbia": "DC",
};

function streetFeatureToPlace(feature: PhotonFeature | undefined, query: string): Place | null {
  const coords = feature?.geometry?.coordinates;
  if (!coords || coords.length < 2) return null;
  const [lng, lat] = coords;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const props = feature?.properties;
  const street = [props?.housenumber, props?.street || (props?.name && !props?.housenumber ? props.name : "")]
    .filter(Boolean)
    .join(" ");
  const locality = props?.city || props?.town || props?.village || props?.locality;
  const bits = [street, locality, props?.state, props?.postcode].filter(Boolean);
  return {
    lat,
    lng,
    query,
    label: formatUsAddress(bits.join(", ") || query),
  };
}

function featureToPlace(feature: PhotonFeature | undefined, query: string): Place | null {
  const coords = feature?.geometry?.coordinates;
  if (!coords || coords.length < 2) return null;
  const [lng, lat] = coords;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    lat,
    lng,
    query,
    label: formatPhoton(feature?.properties, query),
  };
}

function formatPhoton(
  props: PhotonFeature["properties"] | undefined,
  fallback: string,
): string {
  if (!props) return fallback;
  const street = [props.housenumber, props.street].filter(Boolean).join(" ");
  const locality = props.city || props.town || props.village || props.locality;
  const name = props.name;
  const bits: string[] = [];
  if (name && name !== street && name !== locality) bits.push(name);
  if (street) bits.push(street);
  if (locality) bits.push(locality);
  if (props.state) bits.push(props.state);
  const label = bits.join(", ");
  return label || fallback;
}
