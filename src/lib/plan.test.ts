import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { orderNearestByHaversine } from "./geo.ts";
import { stitchRoadHeadToTail } from "./osrm.ts";
import {
  assembleStraightPlan,
  formatPlanProgress,
  GEOCODE_BATCH_SIZE,
  MAX_PLAN_STOPS,
  planProgressView,
  ROAD_REFINE_MAX_STOPS,
  retryAfterSecFromError,
  runPlan,
  STRAIGHT_LINE_FALLBACK_NOTE,
  tooManyStopsMessage,
  type PlanDeps,
} from "./plan.ts";
import { RateLimitError } from "./rate-limit.ts";
import type { PlanProgress } from "./plan-types.ts";
import type { Place } from "./geo.ts";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectColumns, extractAddresses } from "./spreadsheet.ts";
import { parseSpreadsheetFile } from "./spreadsheet-file.ts";

const REAL_CSV = "/home/ubuntu/.cursor/projects/agent-repos-next-closest/uploads/rob-addresses_5041.csv";

const startPlace: Place = {
  lat: 28.6984,
  lng: -81.3081,
  query: "Winter Springs City Hall",
  label: "Winter Springs City Hall, Winter Springs, FL",
};

function placeFor(query: string, index: number): Place {
  return {
    lat: 28.698 + (index % 40) * 0.0015,
    lng: -81.308 + Math.floor(index / 40) * 0.0015,
    query,
    label: query,
  };
}

describe("plan limits and progress copy", () => {
  it("caps lists at the importer's 2,500-row limit", () => {
    assert.equal(MAX_PLAN_STOPS, 2500);
    assert.match(tooManyStopsMessage(), /2,500/);
  });

  it("documents Photon typeahead and ArcGIS-only reverse, not Nominatim", () => {
    const limits = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "plan-limits.ts"), "utf8");
    assert.match(limits, /Photon stays on typeahead/);
    assert.match(limits, /Reverse geocoding is ArcGIS only/);
    assert.doesNotMatch(limits, /Nominatim/);
  });

  it("formats locating progress the way the owner asked for", () => {
    assert.equal(
      formatPlanProgress({ phase: "geocode", done: 400, total: 1312 }),
      "Locating addresses 400 of 1,312",
    );
  });

  it("shows count text and a partial fill that sorting does not snap to full", () => {
    const locating = planProgressView({ phase: "geocode", done: 400, total: 1312 });
    assert.equal(locating.label, "400 of 1,312 addresses");
    assert.equal(locating.now, 400);
    assert.equal(locating.max, 1312);
    assert.ok(Math.abs(locating.percent - (400 / 1312) * 100) < 1e-6);

    const sortingPartial = planProgressView({ phase: "order", done: 400, total: 1312 });
    assert.equal(sortingPartial.label, "Sorting 1,312 stops");
    assert.equal(sortingPartial.percent, locating.percent);

    const sortingDone = planProgressView({ phase: "order", done: 1312, total: 1312 });
    assert.equal(sortingDone.percent, 100);
    assert.equal(formatPlanProgress({ phase: "order", done: 1312, total: 1312 }), "Sorting 1,312 stops");
  });
});

describe("runPlan", () => {
  it("orders a 1,300-stop job with mocked geocodes, no duplicates, and recorded call counts", async () => {
    const stops = Array.from({ length: 1300 }, (_, i) => `${100 + i} Test St, Winter Springs, FL`);
    let geocodeCalls = 0;
    let resolveCalls = 0;
    let refineCalls = 0;
    const queriesSeen: string[] = [];

    const deps: PlanDeps = {
      resolveStart: async () => {
        resolveCalls += 1;
        return startPlace;
      },
      geocodeBatch: async ({ queries }) => {
        geocodeCalls += 1;
        assert.ok(queries.length <= GEOCODE_BATCH_SIZE);
        queriesSeen.push(...queries);
        return queries.map((query, offset) => {
          const index = (geocodeCalls - 1) * GEOCODE_BATCH_SIZE + offset;
          return { query, place: placeFor(query, index) };
        });
      },
      refineRoad: async (_start, head) => {
        refineCalls += 1;
        assert.equal(head.length, ROAD_REFINE_MAX_STOPS);
        return { ...assembleStraightPlan(startPlace, head), source: "road" };
      },
    };

    const t0 = performance.now();
    const result = await runPlan({ start: { query: startPlace.query }, stops }, deps);
    const ms = performance.now() - t0;

    assert.equal(result.ordered.length, 1300);
    assert.equal(result.failures.length, 0);
    assert.equal(new Set(result.ordered.map((s) => s.place.query)).size, 1300);
    assert.deepEqual(
      result.ordered.map((s) => s.place.query).sort(),
      stops.slice().sort(),
    );
    assert.equal(result.source, "road");
    assert.equal(resolveCalls, 1);
    assert.equal(geocodeCalls, Math.ceil(1300 / GEOCODE_BATCH_SIZE));
    assert.equal(refineCalls, 1);
    assert.equal(queriesSeen.length, 1300);
    assert.ok(ms < 2000, `runPlan took ${ms.toFixed(1)}ms`);
    console.log(
      JSON.stringify({
        name: "1300-stop mocked runPlan",
        stops: 1300,
        ms: Number(ms.toFixed(1)),
        resolveCalls,
        geocodeCalls,
        refineCalls,
        failures: result.failures.length,
      }),
    );
  });

  it("keeps failed addresses in the result and still orders the rest", async () => {
    const stops = ["ok-1", "bad-1", "ok-2", "bad-2", "ok-3"];
    const deps: PlanDeps = {
      resolveStart: async () => startPlace,
      geocodeBatch: async ({ queries }) =>
        queries.map((query, i) => ({
          query,
          place: query.startsWith("bad") ? null : placeFor(query, i),
        })),
    };

    const result = await runPlan({ start: { query: startPlace.query }, stops }, deps);
    assert.equal(result.ordered.length, 3);
    assert.deepEqual(
      result.ordered.map((s) => s.place.query).sort(),
      ["ok-1", "ok-2", "ok-3"],
    );
    assert.deepEqual(
      result.failures.map((f) => f.query),
      ["bad-1", "bad-2"],
    );
    assert.equal(result.ordered.length + result.failures.length, stops.length);
  });

  it("reuses cached geocodes instead of calling the batch again", async () => {
    const cache = new Map<string, Place | null>([
      ["ok-1", placeFor("ok-1", 0)],
      ["bad-1", null],
    ]);
    let geocodeCalls = 0;
    const result = await runPlan(
      { start: { query: startPlace.query }, stops: ["ok-1", "bad-1", "ok-2"] },
      {
        resolveStart: async () => startPlace,
        geocodeBatch: async ({ queries }) => {
          geocodeCalls += 1;
          return queries.map((query) => ({ query, place: placeFor(query, 2) }));
        },
      },
      { cache },
    );
    assert.equal(geocodeCalls, 1);
    assert.equal(result.ordered.length, 2);
    assert.equal(result.failures.length, 1);
  });

  it("sends only the first 25 of the haversine chain to road refine and stitches the rest", async () => {
    const stops = Array.from({ length: 40 }, (_, i) => `Stop ${i}`);
    let refined: string[] = [];
    const locatedPlaces = stops.map((query, i) => placeFor(query, i));
    const result = await runPlan(
      { start: { query: startPlace.query }, stops },
      {
        resolveStart: async () => startPlace,
        geocodeBatch: async ({ queries }) =>
          queries.map((query) => ({
            query,
            place: locatedPlaces.find((place) => place.query === query) ?? null,
          })),
        refineRoad: async (origin, head) => {
          refined = head.map((place) => place.query);
          const chain = orderNearestByHaversine(origin, locatedPlaces);
          assert.deepEqual(
            head.map((place) => place.query),
            chain.slice(0, ROAD_REFINE_MAX_STOPS).map((place) => place.query),
          );
          const reversed = [...head].reverse();
          return { ...assembleStraightPlan(origin, reversed), source: "road" };
        },
      },
    );
    assert.equal(refined.length, 25);
    assert.equal(result.source, "road");
    assert.equal(result.note, undefined);
    const chain = orderNearestByHaversine(startPlace, locatedPlaces);
    const expected = stitchRoadHeadToTail(
      { ...assembleStraightPlan(startPlace, [...chain.slice(0, 25)].reverse()), source: "road" },
      chain.slice(25),
    );
    assert.deepEqual(
      result.ordered.map((item) => item.place.query),
      expected.ordered.map((item) => item.place.query),
    );
  });

  it("keeps the straight-line chain and shows the fallback note when OSRM fails", async () => {
    const stops = Array.from({ length: 8 }, (_, i) => `Stop ${i}`);
    const locatedPlaces = stops.map((query, i) => placeFor(query, i));
    const result = await runPlan(
      { start: { query: startPlace.query }, stops },
      {
        resolveStart: async () => startPlace,
        geocodeBatch: async ({ queries }) =>
          queries.map((query) => ({
            query,
            place: locatedPlaces.find((place) => place.query === query) ?? null,
          })),
        refineRoad: async () => null,
      },
    );
    const chain = orderNearestByHaversine(startPlace, locatedPlaces);
    assert.equal(result.source, "straight");
    assert.equal(result.note, STRAIGHT_LINE_FALLBACK_NOTE);
    assert.deepEqual(
      result.ordered.map((item) => item.place.query),
      chain.map((place) => place.query),
    );
  });

  it("emits monotonic locate progress and keeps that fill into the sorting phase", async () => {
    const stops = Array.from({ length: 40 }, (_, i) => `Stop ${i}`);
    const events: PlanProgress[] = [];
    await runPlan(
      { start: { query: startPlace.query }, stops },
      {
        resolveStart: async () => startPlace,
        geocodeBatch: async ({ queries }) =>
          queries.map((query, i) => ({
            query,
            place: query === "Stop 3" ? null : placeFor(query, i),
          })),
      },
      { onProgress: (event) => events.push({ ...event }) },
    );
    assert.ok(events.length >= 3);
    for (let i = 1; i < events.length; i += 1) {
      assert.ok(events[i].done >= events[i - 1].done, `progress moved backward at ${i}`);
    }
    const lastLocate = [...events].reverse().find((event) => event.phase === "geocode");
    const sorting = events.find((event) => event.phase === "order");
    assert.ok(lastLocate);
    assert.ok(sorting);
    assert.equal(lastLocate.done, 40);
    assert.equal(sorting.done, 40);
    assert.equal(planProgressView(sorting).percent, planProgressView(lastLocate).percent);
  });

  it("stops between batches when the abort signal fires", async () => {
    const stops = Array.from({ length: 40 }, (_, i) => `Stop ${i}`);
    const ctrl = new AbortController();
    let geocodeCalls = 0;
    await assert.rejects(
      () =>
        runPlan(
          { start: { query: startPlace.query }, stops },
          {
            resolveStart: async () => startPlace,
            geocodeBatch: async ({ queries }) => {
              geocodeCalls += 1;
              if (geocodeCalls === 1) ctrl.abort();
              return queries.map((query, i) => ({ query, place: placeFor(query, i) }));
            },
          },
          { signal: ctrl.signal },
        ),
      (err: unknown) => err instanceof Error && err.name === "AbortError",
    );
    assert.equal(geocodeCalls, 1);
  });

  it("waits once for Retry-After and retries a 429 geocode batch", async () => {
    const waits: number[] = [];
    let geocodeCalls = 0;
    const result = await runPlan(
      { start: { query: startPlace.query }, stops: ["606 TINA LN"] },
      {
        resolveStart: async () => startPlace,
        geocodeBatch: async ({ queries }) => {
          geocodeCalls += 1;
          if (geocodeCalls === 1) {
            throw new RateLimitError("Too many address lookups right now. Try again shortly.", 2);
          }
          return queries.map((query) => ({ query, place: placeFor(query, 0) }));
        },
      },
      { sleep: async (ms) => { waits.push(ms); } },
    );
    assert.equal(geocodeCalls, 2);
    assert.deepEqual(waits, [2000]);
    assert.equal(result.ordered.length, 1);
    assert.equal(retryAfterSecFromError(new Error("Too many address lookups right now. Try again shortly. Retry-After: 4")), 4);
  });

  it("does not retry a second 429", async () => {
    let geocodeCalls = 0;
    await assert.rejects(
      () =>
        runPlan(
          { start: { query: startPlace.query }, stops: ["606 TINA LN"] },
          {
            resolveStart: async () => startPlace,
            geocodeBatch: async () => {
              geocodeCalls += 1;
              throw new RateLimitError("Too many address lookups right now. Try again shortly.", 1);
            },
          },
          { sleep: async () => undefined },
        ),
      (err: unknown) => err instanceof RateLimitError,
    );
    assert.equal(geocodeCalls, 2);
  });

  it("rejects more than 2,500 stops before any geocoding", async () => {
    const stops = Array.from({ length: MAX_PLAN_STOPS + 1 }, (_, i) => `Stop ${i}`);
    let resolveCalls = 0;
    await assert.rejects(
      () =>
        runPlan(
          { start: { query: startPlace.query }, stops },
          {
            resolveStart: async () => {
              resolveCalls += 1;
              return startPlace;
            },
            geocodeBatch: async () => [],
          },
        ),
      /2,500/,
    );
    assert.equal(resolveCalls, 0);
  });
});

describe("owner Winter Springs spreadsheet", () => {
  it("imports all 1,312 rows with the existing default column mapping", async (t) => {
    if (!existsSync(REAL_CSV)) {
      t.skip("owner CSV is not in this environment");
      return;
    }
    const file = new File([readFileSync(REAL_CSV)], "rob-addresses.csv", { type: "text/csv" });
    const parsed = await parseSpreadsheetFile(file);
    assert.equal(parsed.hasHeaderRow, true);
    assert.equal(parsed.rows.length, 1312);
    assert.equal(parsed.headers.length, 26);
    const expected = detectColumns(parsed.headers);
    assert.deepEqual(parsed.mapping, expected);
    assert.equal(parsed.mapping.mode, "single");
    const result = extractAddresses(parsed, parsed.mapping);
    assert.equal(result.added.length, 1312);
    assert.equal(result.added[0], "606 TINA LN WINTER SPRINGS");
    assert.equal(
      result.added.some((line) => /winter springs,\s*winter springs/i.test(line)),
      false,
    );
  });
});
