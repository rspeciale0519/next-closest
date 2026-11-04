import type { Place } from "./geo.ts";

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
  note?: string;
};

export type PlanProgress = {
  phase: "start" | "geocode" | "order" | "road";
  done: number;
  total: number;
};

export type PlanStart = {
  query: string;
  coords?: { lat: number; lng: number };
  label?: string;
};

export type GeocodedStop = {
  query: string;
  place: Place | null;
};
