import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchJson, GEOCODE_USER_AGENT, listProviderFetchOpts, LookupTimeoutError, sleep } from "./geo-http.ts";
import { LIST_GEOCODE_ATTEMPTS, LIST_GEOCODE_TIMEOUT_MS, PLAN_FN_MAX_DURATION_SECONDS } from "./plan-limits.ts";

describe("list geocode budget", () => {
  it("identifies as nextclosest.vercel.app", () => {
    assert.equal(
      GEOCODE_USER_AGENT,
      "nextclosest.vercel.app (+https://github.com/rspeciale0519/next-closest)",
    );
  });

  it("keeps a full miss batch under the function maxDuration", () => {
    const worstMs = Math.ceil((20 * 2 * LIST_GEOCODE_ATTEMPTS * LIST_GEOCODE_TIMEOUT_MS) / 5);
    assert.ok(worstMs < PLAN_FN_MAX_DURATION_SECONDS * 1000);
    assert.equal(LIST_GEOCODE_ATTEMPTS, 1);
  });

  it("forwards the abort signal into Census/ArcGIS fetch options", () => {
    const ctrl = new AbortController();
    const opts = listProviderFetchOpts({ timeoutMs: LIST_GEOCODE_TIMEOUT_MS, attempts: 1 }, ctrl.signal);
    assert.equal(opts.signal, ctrl.signal);
    assert.equal(opts.timeoutMs, LIST_GEOCODE_TIMEOUT_MS);
    assert.equal(opts.attempts, 1);
  });

  it("cancels the upstream fetch when Stop aborts the signal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(
      () =>
        fetchJson("https://example.invalid/geocode", undefined, {
          signal: ctrl.signal,
          attempts: 1,
          timeoutMs: 5000,
        }),
      (err: unknown) => err instanceof DOMException && err.name === "AbortError",
    );
  });

  it("treats the timer abort as a timeout when Stop did not fire", async () => {
    const ctrl = new AbortController();
    const original = globalThis.fetch;
    globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    try {
      await assert.rejects(
        () =>
          fetchJson("https://example.invalid/geocode", undefined, {
            signal: ctrl.signal,
            attempts: 1,
            timeoutMs: 20,
          }),
        (err: unknown) => err instanceof LookupTimeoutError && err.name === "TimeoutError",
      );
      assert.equal(ctrl.signal.aborted, false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("rejects sleep when the abort signal fires during the wait", async () => {
    const ctrl = new AbortController();
    const started = Date.now();
    const pending = sleep(5000, ctrl.signal);
    setTimeout(() => ctrl.abort(), 10);
    await assert.rejects(
      () => pending,
      (err: unknown) => err instanceof DOMException && err.name === "AbortError",
    );
    assert.ok(Date.now() - started < 1000);
  });
});
