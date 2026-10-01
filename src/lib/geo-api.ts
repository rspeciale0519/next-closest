import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  buildDistanceMatrix,
  haversineMeters,
  orderOpenTour,
  type LatLng,
  type Place,
} from "./geo";

const UA = "NextClosest/1.0 (stop sequencer; https://grok.com)";

const latLngSchema = z.object({
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
});

const suggestInput = z.object({
  query: z.string().trim().min(2).max(200),
  bias: latLngSchema.optional(),
});

const reverseInput = latLngSchema;

const planInput = z.object({
  start: z.object({
    query: z.string().trim().min(1).max(300),
    coords: latLngSchema.optional(),
    label: z.string().trim().max(300).optional(),
  }),
  stops: z.array(z.string().trim().min(1).max(300)).min(1).max(25),
});

export type Suggestion = Place;
export type PlanFailure = { query: string; message: string };
export type OrderedStop = {
  place: Place;
  legMeters: number;
  legSeconds: number;
};
export type PlanResult = {
  start: Place;
  ordered: OrderedStop[];
  failures: PlanFailure[];
  polyline: Array<[number, number]>;
  totalMeters: number;
  totalSeconds: number;
  source: "road" | "straight";
};

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

type NominatimHit = {
  lat: string;
  lon: string;
  display_name?: string;
};

export const suggestPlaces = createServerFn({ method: "POST" })
  .validator((data) => suggestInput.parse(data))
  .handler(async ({ data }): Promise<Suggestion[]> => {
    return photonSuggest(data.query, data.bias);
  });

export const reverseGeocode = createServerFn({ method: "POST" })
  .validator((data) => reverseInput.parse(data))
  .handler(async ({ data }): Promise<Place> => {
    const nearest = await placeForCoords(data);
    if (nearest) return nearest;
    return {
      lat: data.lat,
      lng: data.lng,
      query: "Current location",
      label: "Current location",
    };
  });

export const planRoute = createServerFn({ method: "POST" })
  .validator((data) => planInput.parse(data))
  .handler(async ({ data }): Promise<PlanResult> => {
    const start = await resolveStart(data.start);
    const region = regionFromPlace(start);
    const located = await Promise.all(
      data.stops.map(async (query) => ({
        query,
        place: await geocodeOne(query, start, region),
      })),
    );
    const failures: PlanFailure[] = [];
    const stops: Place[] = [];
    for (const item of located) {
      if (item.place) stops.push(item.place);
      else failures.push({ query: item.query, message: "Could not find this address" });
    }

    if (stops.length === 0) {
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

    const points: LatLng[] = [start, ...stops];
    const road = await osrmTable(points);
    const matrix = buildDistanceMatrix(points, road ?? undefined);
    const geographic = buildDistanceMatrix(points);
    const order = orderOpenTour(geographic.meters);
    const stopOrder = order.slice(1);

    const ordered: OrderedStop[] = [];
    let totalMeters = 0;
    let totalSeconds = 0;
    let prev = 0;
    for (const idx of stopOrder) {
      const legMeters = matrix.meters[prev][idx];
      const legSeconds = matrix.seconds[prev][idx];
      totalMeters += legMeters;
      totalSeconds += legSeconds;
      ordered.push({
        place: stops[idx - 1],
        legMeters,
        legSeconds,
      });
      prev = idx;
    }

    const orderedPoints: LatLng[] = [start, ...ordered.map((s) => s.place)];
    const polyline =
      (await osrmRoute(orderedPoints)) ??
      orderedPoints.map((p) => [p.lat, p.lng] as [number, number]);

    return {
      start,
      ordered,
      failures,
      polyline,
      totalMeters,
      totalSeconds,
      source: matrix.source,
    };
  });

async function resolveStart(start: z.infer<typeof planInput>["start"]): Promise<Place> {
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
  const found = await geocodeOne(start.query);
  if (!found) {
    throw new Error(`Could not find starting address: ${start.query}`);
  }
  return found;
}

async function geocodeOne(query: string, bias?: LatLng, region = ""): Promise<Place | null> {
  const variants = addressVariants(query, region);
  for (const candidate of variants) {
    const census = await censusGeocode(candidate);
    if (census) return { ...census, query };
  }
  for (const candidate of variants) {
    const arcgis = await arcgisGeocode(candidate, bias);
    if (arcgis) return { ...arcgis, query };
  }
  for (const candidate of variants) {
    const photon = await photonSearch(candidate, bias);
    if (photon) return { ...photon, query };
  }
  for (const candidate of variants) {
    const nominatim = await nominatimSearch(candidate, bias);
    if (nominatim) return { ...nominatim, query };
  }
  return null;
}

async function photonSearch(query: string, bias?: LatLng): Promise<Place | null> {
  const hits = await photonSuggest(query, bias, 5);
  return pickMatchingPlace(query, hits, bias);
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

async function nominatimSearch(query: string, bias?: LatLng): Promise<Place | null> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "5");
  url.searchParams.set("addressdetails", "0");
  url.searchParams.set("countrycodes", "us");
  try {
    const hits = await fetchJson<NominatimHit[]>(url.toString());
    const places: Place[] = [];
    for (const hit of hits) {
      const lat = Number(hit.lat);
      const lng = Number(hit.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      places.push({
        lat,
        lng,
        query,
        label: hit.display_name || query,
      });
    }
    return pickMatchingPlace(query, places, bias);
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

async function arcgisGeocode(query: string, bias?: LatLng): Promise<Place | null> {
  const url = new URL("https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates");
  url.searchParams.set("f", "json");
  url.searchParams.set("singleLine", query);
  url.searchParams.set("maxLocations", "5");
  url.searchParams.set("outFields", "Addr_type,Match_addr");
  url.searchParams.set("countryCode", "USA");
  if (bias) url.searchParams.set("location", `${bias.lng},${bias.lat}`);
  try {
    const json = await fetchJson<ArcgisResponse>(url.toString(), undefined, 12000);
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

async function censusGeocode(query: string): Promise<Place | null> {
  const url = new URL("https://geocoding.geo.census.gov/geocoder/locations/onelineaddress");
  url.searchParams.set("address", query);
  url.searchParams.set("benchmark", "Public_AR_Current");
  url.searchParams.set("format", "json");
  try {
    const json = await fetchJson<CensusResponse>(url.toString(), undefined, 12000);
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

function regionFromPlace(place: Place): string {
  const text = place.label || place.query;
  const parts = text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(1)
    .filter((part) => !/^(usa|united states|us)$/i.test(part))
    .filter((part) => !/^\d{5}(?:-\d{4})?$/.test(part));
  return parts.join(", ");
}

function addressVariants(query: string, region: string): string[] {
  const cleaned = query
    .replace(/\s+/g, " ")
    .replace(/\b(apt|apartment|unit|ste|suite|#)\s*[a-z0-9-]+\b/gi, "")
    .replace(/[.,\s]+$/g, "")
    .replace(/,\s*,/g, ",")
    .trim();
  const withRegion = applyRegion(cleaned, region);
  const out: string[] = [];
  for (const value of [cleaned, withRegion, expandSuffixes(cleaned), expandSuffixes(withRegion), collapseSuffixes(cleaned), collapseSuffixes(withRegion)]) {
    if (value && !out.some((item) => item.toLowerCase() === value.toLowerCase())) out.push(value);
  }
  return out;
}

function applyRegion(query: string, region: string): string {
  if (!region) return query;
  const missing = region
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !query.toLowerCase().includes(part.toLowerCase()));
  if (missing.length === 0) return query;
  return `${query}, ${missing.join(", ")}`;
}

const LONG_SUFFIX: Array<[RegExp, string]> = [
  [/\bstreets?\b/gi, "St"],
  [/\bdrives?\b/gi, "Dr"],
  [/\bavenues?\b/gi, "Ave"],
  [/\broads?\b/gi, "Rd"],
  [/\blanes?\b/gi, "Ln"],
  [/\bcourts?\b/gi, "Ct"],
  [/\bboulevards?\b/gi, "Blvd"],
  [/\bcircles?\b/gi, "Cir"],
  [/\bplaces?\b/gi, "Pl"],
  [/\bterraces?\b/gi, "Ter"],
  [/\btrails?\b/gi, "Trl"],
  [/\bparkways?\b/gi, "Pkwy"],
  [/\bhighways?\b/gi, "Hwy"],
];

const SHORT_SUFFIX: Array<[RegExp, string]> = [
  [/\bst\b/gi, "Street"],
  [/\bdr\b/gi, "Drive"],
  [/\bave\b/gi, "Avenue"],
  [/\brd\b/gi, "Road"],
  [/\bln\b/gi, "Lane"],
  [/\bct\b/gi, "Court"],
  [/\bblvd\b/gi, "Boulevard"],
  [/\bcir\b/gi, "Circle"],
  [/\bpl\b/gi, "Place"],
  [/\bter\b/gi, "Terrace"],
  [/\btrl\b/gi, "Trail"],
  [/\bpkwy\b/gi, "Parkway"],
  [/\bhwy\b/gi, "Highway"],
];

function expandSuffixes(value: string): string {
  return transformStreet(value, (street) =>
    SHORT_SUFFIX.reduce((text, [pattern, repl]) => text.replace(pattern, repl), street),
  );
}

function collapseSuffixes(value: string): string {
  return transformStreet(value, (street) =>
    LONG_SUFFIX.reduce((text, [pattern, repl]) => text.replace(pattern, repl), street),
  );
}

function transformStreet(value: string, fn: (street: string) => string): string {
  const comma = value.indexOf(",");
  if (comma === -1) return fn(value);
  return `${fn(value.slice(0, comma))}${value.slice(comma)}`;
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

async function osrmTable(points: LatLng[]) {
  if (points.length < 2) return null;
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");
  const url = `https://router.project-osrm.org/table/v1/driving/${coords}?annotations=duration,distance`;
  try {
    const json = await fetchJson<{
      code?: string;
      distances?: Array<Array<number | null>>;
      durations?: Array<Array<number | null>>;
    }>(url, undefined, 15000);
    if (json.code !== "Ok" || !json.distances || !json.durations) return null;
    return { distances: json.distances, durations: json.durations };
  } catch {
    return null;
  }
}

async function osrmRoute(points: LatLng[]): Promise<Array<[number, number]> | null> {
  if (points.length < 2) return null;
  const legs = await Promise.all(
    points.slice(0, -1).map((from, i) => osrmLeg(from, points[i + 1])),
  );
  const line: Array<[number, number]> = [];
  for (let i = 0; i < legs.length; i++) {
    const from = points[i];
    const to = points[i + 1];
    const piece = clipLineToDestination(legs[i] ?? [[from.lat, from.lng], [to.lat, to.lng]], to);
    if (line.length > 0) piece.shift();
    line.push(...piece);
  }
  return line.length > 1 ? line : null;
}

async function osrmLeg(from: LatLng, to: LatLng): Promise<Array<[number, number]> | null> {
  const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;
  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&continue_straight=false`;
  try {
    const json = await fetchJson<{
      code?: string;
      routes?: Array<{ geometry?: { coordinates?: Array<[number, number]> } }>;
    }>(url, undefined, 12000);
    const raw = json.routes?.[0]?.geometry?.coordinates;
    if (json.code !== "Ok" || !raw || raw.length === 0) return null;
    return raw.map(([lng, lat]) => [lat, lng] as [number, number]);
  } catch {
    return null;
  }
}

function clipLineToDestination(
  line: Array<[number, number]>,
  dest: LatLng,
): Array<[number, number]> {
  if (line.length === 0) return [[dest.lat, dest.lng]];
  let bestI = line.length - 1;
  let bestD = Infinity;
  for (let i = 0; i < line.length; i++) {
    const d = haversineMeters({ lat: line[i][0], lng: line[i][1] }, dest);
    if (d <= bestD) {
      bestD = d;
      bestI = i;
    }
  }
  const clipped = line.slice(0, bestI + 1);
  const last = clipped[clipped.length - 1];
  if (!last || haversineMeters({ lat: last[0], lng: last[1] }, dest) > 8) {
    clipped.push([dest.lat, dest.lng]);
  }
  return clipped;
}

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

async function fetchJson<T>(url: string, init?: RequestInit, timeoutMs = 10000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": UA,
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}
