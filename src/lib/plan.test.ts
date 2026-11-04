import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assembleStraightPlan,
  formatPlanProgress,
  GEOCODE_BATCH_SIZE,
  MAX_PLAN_STOPS,
  runPlan,
  tooManyStopsMessage,
  type PlanDeps,
} from "./plan.ts";
import type { Place } from "./geo.ts";
import { existsSync, readFileSync } from "node:fs";
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

  it("formats locating progress the way the owner asked for", () => {
    assert.equal(
      formatPlanProgress({ phase: "geocode", done: 400, total: 1312 }),
      "Locating addresses 400 of 1,312",
    );
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
      refineRoad: async () => {
        refineCalls += 1;
        throw new Error("should not refine a 1,300-stop list");
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
    assert.equal(result.source, "straight");
    assert.equal(resolveCalls, 1);
    assert.equal(geocodeCalls, Math.ceil(1300 / GEOCODE_BATCH_SIZE));
    assert.equal(refineCalls, 0);
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

  it("refines with road distances when the list is small enough", async () => {
    const stops = ["a", "b"];
    const result = await runPlan(
      { start: { query: startPlace.query }, stops },
      {
        resolveStart: async () => startPlace,
        geocodeBatch: async ({ queries }) =>
          queries.map((query, i) => ({ query, place: placeFor(query, i) })),
        refineRoad: async (start, located) => ({
          ...assembleStraightPlan(start, located.reverse()),
          source: "road",
        }),
      },
    );
    assert.equal(result.source, "road");
    assert.deepEqual(
      result.ordered.map((s) => s.place.query),
      ["b", "a"],
    );
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
