#!/usr/bin/env node
// Bundle the browser Playwright script into a single CJS that the Tauri
// app ships as a resource and runs with the bundled Node sidecar. Playwright is
// left EXTERNAL (installed alongside the app as a resource at release time), so
// this bundle step needs no browser/native deps and runs anywhere Node does.
// Invoked by setup-sidecars.mjs (or `npm run build:sidecar`).
import { build } from "esbuild";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Same source of truth the app reads, so the staged filename cannot drift from the
// externalBin entry that has to find it.
const { identity } = JSON.parse(readFileSync(join(here, "..", "src", "brand.json"), "utf8"));
const name = `${identity.sidecarPrefix}-browser`;
const outDir = join(here, "..", "src-tauri", "resources");
mkdirSync(outDir, { recursive: true });
const outfile = join(outDir, `${name}.mjs`);

await build({
  entryPoints: [join(here, `${name}.mjs`)],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["playwright", "playwright-core"],
});

console.log(`[build-sidecar] bundled ${name} -> ${outfile} (playwright-core external)`);
console.log("[build-sidecar] release: ship node_modules/playwright-core + a chromium");
console.log("[build-sidecar]          headless-shell as resources next to it");
console.log("[build-sidecar]          (npm run bundle:browser).");
