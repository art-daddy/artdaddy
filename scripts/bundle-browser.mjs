#!/usr/bin/env node
// Stage playwright-core + a chromium headless-shell as resources next to the
// bundled artdaddy-browser script, so the browser tools (web_search / get_page /
// get_page_image) work in the SHIPPED app. Heavy (downloads chromium ~150 MB);
// run on the release/build machine. Run: `npm run bundle:browser`.
//
// After it runs, add these to tauri.conf.json "bundle.resources" for release:
//   "resources/ms-playwright/**", "resources/node_modules/**"
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const resources = join(root, "src-tauri", "resources");
const browsersDir = join(resources, "ms-playwright");
mkdirSync(resources, { recursive: true });

// 1. The full `playwright` package provides the browser-install CLI (playwright-core
//    does not). Install it transiently; only playwright-core ships at runtime.
console.log("[bundle-browser] ensuring the playwright install CLI…");
execSync("npm install --no-save playwright", { cwd: root, stdio: "inherit" });

// 2. Download ONLY the chromium headless-shell into the bundled browsers dir.
console.log("[bundle-browser] installing chromium headless-shell…");
execSync("npx playwright install --only-shell chromium", {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersDir },
});

// 3. Ship playwright-core so `import("playwright-core")` resolves from a node_modules
//    sibling of the bundled artdaddy-browser script at runtime.
const pcSrc = join(root, "node_modules", "playwright-core");
if (!existsSync(pcSrc)) throw new Error("playwright-core not found after install");
const pcDst = join(resources, "node_modules", "playwright-core");
mkdirSync(dirname(pcDst), { recursive: true });
cpSync(pcSrc, pcDst, { recursive: true });

console.log(`[bundle-browser] staged chromium -> ${browsersDir}`);
console.log(`[bundle-browser] staged playwright-core -> ${pcDst}`);
console.log('[bundle-browser] add to tauri.conf resources: "resources/ms-playwright/**", "resources/node_modules/**"');
