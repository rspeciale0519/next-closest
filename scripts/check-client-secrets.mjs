#!/usr/bin/env node
/**
 * Prove Upstash / Vercel KV URL and token names never land in the client
 * bundle. Call after `vite build` with `--require-bundle`.
 *
 * Looks in `dist/client` (documented grep path) and Nitro's
 * `.vercel/output/static`. Copies JS from the Nitro output into `dist/client`
 * so `grep dist/client` matches the review check.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./with-app-env.mjs";

export const SECRET_ENV_NAMES = [
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
];

export const VITE_SECRET_PREFIXES = ["VITE_KV_REST", "VITE_UPSTASH_REDIS"];

/** Quoted JWT-like or long Upstash REST token values. */
export const TOKEN_VALUE_PATTERN = /["'`](?:eyJ[A-Za-z0-9_-]{20,}|AX[A-Za-z0-9+/_-]{30,})["'`]/;

const CLIENT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".css", ".html", ".map"]);

export function isClientAsset(filePath) {
  return CLIENT_EXTENSIONS.has(extname(filePath));
}

export function listClientFiles(root) {
  if (!existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (isClientAsset(full)) out.push(full);
    }
  };
  const info = statSync(root);
  if (info.isFile()) {
    if (isClientAsset(root)) out.push(root);
    return out;
  }
  walk(root);
  return out;
}

export function findSecretLeaks(source, env = process.env) {
  const leaks = [];
  for (const name of SECRET_ENV_NAMES) {
    if (source.includes(name)) leaks.push(name);
  }
  for (const prefix of VITE_SECRET_PREFIXES) {
    if (source.includes(prefix)) leaks.push(prefix);
  }
  const token = source.match(TOKEN_VALUE_PATTERN);
  if (token) leaks.push(`token-value-pattern:${token[0].slice(0, 12)}…`);
  for (const name of SECRET_ENV_NAMES) {
    const value = env[name]?.trim();
    if (value && value.length >= 8 && source.includes(value)) {
      leaks.push(`env-value:${name}`);
    }
  }
  return leaks;
}

export function scanClientBundle(roots, env = process.env) {
  const files = roots.flatMap((root) => listClientFiles(root));
  const findings = [];
  for (const file of files) {
    const leaks = findSecretLeaks(readFileSync(file, "utf8"), env);
    if (leaks.length > 0) findings.push({ file, leaks });
  }
  return { files, findings };
}

function projectRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

export function clientBundleRoots(root = projectRoot()) {
  return [join(root, "dist", "client"), join(root, ".vercel", "output", "static")];
}

export function syncDistClientFromNitro(root = projectRoot()) {
  const nitro = join(root, ".vercel", "output", "static");
  const dest = join(root, "dist", "client");
  if (!existsSync(nitro)) return dest;
  mkdirSync(dest, { recursive: true });
  for (const file of listClientFiles(nitro)) {
    const rel = relative(nitro, file);
    const target = join(dest, rel);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(file, target);
  }
  return dest;
}

function main(argv = process.argv.slice(2)) {
  const root = projectRoot();
  syncDistClientFromNitro(root);
  const roots = clientBundleRoots(root);
  const existing = roots.filter((dir) => existsSync(dir));
  if (argv.includes("--require-bundle") && existing.length === 0) {
    console.error(
      "[client-secrets] no client bundle at dist/client or .vercel/output/static",
    );
    process.exit(2);
  }
  const { files, findings } = scanClientBundle(existing);
  if (findings.length > 0) {
    for (const hit of findings) {
      console.error(`[client-secrets] ${relative(root, hit.file)}: ${hit.leaks.join(", ")}`);
    }
    process.exit(1);
  }
  console.log(
    `[client-secrets] ok: ${files.length} client files, no KV/Upstash names or token-value pattern`,
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
