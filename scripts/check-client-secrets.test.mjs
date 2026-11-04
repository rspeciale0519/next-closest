import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  findSecretLeaks,
  scanClientBundle,
  SECRET_ENV_NAMES,
  TOKEN_VALUE_PATTERN,
} from "./check-client-secrets.mjs";

test("env example lists the four names and no VITE_ Redis prefix", async () => {
  const { readFileSync } = await import("node:fs");
  const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  for (const name of SECRET_ENV_NAMES) {
    assert.match(example, new RegExp(`^${name}=$`, "m"));
  }
  assert.doesNotMatch(example, /VITE_KV_REST|VITE_UPSTASH_REDIS/);
});

test("clean client JS is not a leak", () => {
  assert.deepEqual(findSecretLeaks("const cap = 2500; export function order() {}"), []);
});

test("var names and token-value pattern fail the grep", () => {
  assert.deepEqual(findSecretLeaks('const url = process.env.KV_REST_API_URL'), [
    "KV_REST_API_URL",
  ]);
  assert.ok(findSecretLeaks('import.meta.env.VITE_UPSTASH_REDIS_REST_TOKEN').includes("VITE_UPSTASH_REDIS"));
  const token = `"${"AX"}${"a".repeat(32)}"`;
  assert.ok(TOKEN_VALUE_PATTERN.test(token));
  assert.ok(findSecretLeaks(`const t = ${token};`)[0].startsWith("token-value-pattern:"));
});

test("committed token values in the bundle fail even without the name", () => {
  const leaks = findSecretLeaks("const x = 'super-secret-token-value';", {
    KV_REST_API_TOKEN: "super-secret-token-value",
  });
  assert.ok(leaks.includes("env-value:KV_REST_API_TOKEN"));
});

test("scanClientBundle greps dist/client-style trees", () => {
  const root = mkdtempSync(join(tmpdir(), "client-secrets-"));
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "assets", "app.js"), "console.log('ok')");
  writeFileSync(join(root, "assets", "leak.js"), "KV_REST_API_TOKEN");
  const { files, findings } = scanClientBundle([root]);
  assert.equal(files.length, 2);
  assert.equal(findings.length, 1);
  assert.ok(findings[0].file.endsWith("leak.js"));
});
