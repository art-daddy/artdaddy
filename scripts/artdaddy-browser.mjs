#!/usr/bin/env node
// artdaddy-browser — the desktop browser sidecar behind the client web tools
// (web_search / get_page / get_page_image). It drives a bundled Playwright
// headless-chromium so requests come from the user's real IP (anti-bot), then
// prints a small JSON result on stdout. Bundled with the Tauri app as a sidecar
// and invoked via the shell plugin (see src/tools/web.ts).
//
//   artdaddy-browser search --query "<q>" --n 5
//   artdaddy-browser page   --url "<u>" --viewport 1280x800 --dsf 3 --mobile 0
//   artdaddy-browser shot   --url "<u>" --viewport 1280x800 --dsf 3 --mobile 0 --out shot.png
//
// `--viewport` is CSS pixels and `--dsf` the device pixel ratio, so the captured
// PNG is viewport*dsf — the client passes the pair that reproduces the SOURCE
// pixel size its contract promises, while the site still sees a real breakpoint.
//
// Deployment: requires `playwright-core` + a chromium headless-shell. Bundle both
// as resources next to this script (see scripts/bundle-browser.mjs).
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ddgBlocked } from "./ddgBlock.mjs";

// Point Playwright at the bundled chromium headless-shell (a resource next to
// this script) unless the host already set a browsers path. Must be set BEFORE
// playwright-core loads; the import below is lazy so this ordering holds.
process.env.PLAYWRIGHT_BROWSERS_PATH ||= join(
  dirname(fileURLToPath(import.meta.url)),
  "ms-playwright",
);

let _chromium;
async function getChromium() {
  if (!_chromium) ({ chromium: _chromium } = await import("playwright-core"));
  return _chromium;
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i]?.startsWith("--")) opts[rest[i].slice(2)] = rest[i + 1];
  }
  return { cmd, opts };
}

function viewport(spec) {
  const m = /^(\d+)x(\d+)$/.exec(String(spec || "1280x800"));
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1280, height: 800 };
}

// --- Anti-bot identity -------------------------------------------------------
// Ported from the retired Python research.py. The bundled chromium is the
// headless SHELL build, whose default UA carries a `HeadlessChrome` token and no
// Sec-CH-UA brands. DuckDuckGo (and others) reject that outright — the html
// endpoint answers with a "bots use DuckDuckGo too" CAPTCHA and zero results.
// Python solved it with channel="chromium" (the full Chrome for Testing binary,
// +412 MB); measured here, overriding the UA *and* the headers clears the
// challenge on the shell build, so we keep the small binary.
// Both must be present: a Chrome UA with no Sec-CH-UA/Accept-Language is
// incoherent and gets blocked harder (empty 147-byte body) than no override.
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/** Desktop UA derived from the ACTUAL browser build, minus the Headless token,
 *  so it can never drift from the binary we ship. */
function desktopUa(browser) {
  const ver = browser.version() || "131.0.0.0";
  return (
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
    `(KHTML, like Gecko) Chrome/${ver} Safari/537.36`
  );
}

function headers(browser, mobile) {
  const major = (browser.version() || "131").split(".")[0];
  return {
    "Accept-Language": "en-US,en;q=0.9",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Upgrade-Insecure-Requests": "1",
    "sec-ch-ua": `"Google Chrome";v="${major}", "Chromium";v="${major}", "Not_A Brand";v="24"`,
    "sec-ch-ua-mobile": mobile ? "?1" : "?0",
    "sec-ch-ua-platform": mobile ? '"Android"' : '"Windows"',
  };
}

const LAUNCH_ARGS = ["--disable-blink-features=AutomationControlled"];

// CSS-pixel ceiling for a full-page screenshot. At dsf=2 this is 16k device pixels,
// well inside what ffmpeg will decode, while still capturing far more than a fold.
const SHOT_MAX_CSS_HEIGHT = 8000;

/** Persistent profile root: cookies accumulate across calls, which slows the
 *  rate-limit clock versus a cold browser every time.
 *
 *  The folder must match `identity.dataFolder` in src/brand.json (brand.drift.test.ts
 *  checks it). This file is esbuild-bundled into a standalone resource, so it cannot
 *  read that JSON at runtime. On macOS/Linux this sits INSIDE the migrated data folder
 *  and moves with it; on Windows it lives under LOCALAPPDATA, so a rename just starts a
 *  fresh profile — it is a cookie cache, not user work. */
function profileDir(name) {
  const env = process.env.ARTDADDY_BROWSER_PROFILE_DIR;
  const base =
    env ||
    (process.platform === "win32"
      ? join(process.env.LOCALAPPDATA || homedir(), "ArtDaddy", "browser-profiles")
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support", "ArtDaddy", "browser-profiles")
        : join(homedir(), ".local", "share", "ArtDaddy", "browser-profiles"));
  return join(base, name);
}

/** Launch a hardened context. The sidecar is spawned per call, so a concurrent
 *  invocation may already hold the profile's Chromium lock — fall back to a
 *  throwaway profile instead of failing the whole tool. */
async function withPage(profile, vp, fn, { mobile = false, dsf = 1 } = {}) {
  const chromium = await getChromium();
  const probe = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  const ctxOpts = {
    userAgent: mobile ? MOBILE_UA : desktopUa(probe),
    viewport: vp,
    deviceScaleFactor: dsf,
    isMobile: mobile,
    hasTouch: mobile,
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    colorScheme: "light",
    reducedMotion: "no-preference",
    extraHTTPHeaders: headers(probe, mobile),
  };
  await probe.close();

  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir(profile), {
      headless: true,
      args: LAUNCH_ARGS,
      ...ctxOpts,
    });
  } catch {
    context = await chromium.launchPersistentContext(
      mkdtempSync(join(tmpdir(), `artdaddy-${profile}-`)),
      { headless: true, args: LAUNCH_ARGS, ...ctxOpts },
    );
  }
  try {
    const page = await context.newPage();
    return await fn(page);
  } finally {
    await context.close();
  }
}

/** DDG's block signatures — see ddgBlock.mjs for what counts and why. */
async function ddgBlockState(page) {
  return page.evaluate(() => ({
    results: document.querySelectorAll(".result").length,
    bodyLen: (document.body?.innerText || "").length,
    title: document.title || "",
    challenge: !!document.querySelector("[data-testid='anomaly-modal'], .anomaly-modal__modal"),
  }));
}

async function search(opts) {
  const query = opts.query || "";
  const n = Math.max(1, Number(opts.n || 5));
  return withPage("search", { width: 1280, height: 900 }, async (page) => {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    let state = { results: 0, bodyLen: 0, title: "", challenge: false };
    // One retry: the soft rate-limit decays in a second or two.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await page.waitForTimeout(1000 + Math.floor(Math.random() * 1500));
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      state = await ddgBlockState(page);
      if (state.results > 0) break;
      if (!ddgBlocked(state)) break; // a normal page with 0 hits = genuinely nothing
    }
    if (!state.results && ddgBlocked(state)) {
      return {
        ok: false,
        engine: "ddg",
        blocked: true,
        error:
          "the search engine served an anti-bot challenge instead of results — " +
          "this is a tool failure, NOT an absence of matches",
      };
    }
    const rows = await page.$$eval(".result", (els) =>
      els.slice(0, 25).map((el) => {
        const a = el.querySelector(".result__a") || el.querySelector(".result__title a");
        const snip = el.querySelector(".result__snippet");
        return {
          title: a?.textContent?.trim() || "",
          url: a?.getAttribute("href") || "",
          snippet: snip?.textContent?.trim() || "",
        };
      }),
    );
    const results = rows
      .filter((r) => r.title && r.url)
      .map((r) => ({ ...r, url: unwrapDdg(r.url) }))
      .slice(0, n);
    return { ok: true, engine: "ddg", results };
  });
}

async function page(opts) {
  const mobile = String(opts.mobile || "0") === "1";
  const dsf = Math.max(1, Number(opts.dsf || 1));
  return withPage(
    "page",
    viewport(opts.viewport),
    async (pg) => {
      await pg.goto(opts.url, { waitUntil: "networkidle", timeout: 30000 });
      const title = await pg.title();
      const html = await pg.content();
      return { ok: true, title, final_url: pg.url(), html };
    },
    { mobile, dsf },
  );
}

async function shot(opts) {
  const mobile = String(opts.mobile || "0") === "1";
  const dsf = Math.max(1, Number(opts.dsf || 1));
  return withPage(
    "page",
    viewport(opts.viewport),
    async (pg) => {
      await pg.goto(opts.url, { waitUntil: "networkidle", timeout: 30000 });
      const title = await pg.title();
      // A full-page shot of a long page is UNBOUNDED: a docs page produced 6864x41754,
      // which ffmpeg refuses to decode ("Picture size ... is invalid"). That image can be
      // imported and placed on the timeline, and then every render involving it fails —
      // with `-loop 1` ffmpeg spins instead of erroring. Clamp the capture instead.
      const full = await pg.evaluate(
        () => document.documentElement?.scrollHeight ?? window.innerHeight,
      );
      const height = Math.min(full, SHOT_MAX_CSS_HEIGHT);
      const clipped = height < full;
      await pg.screenshot(
        clipped
          ? { path: opts.out, clip: { x: 0, y: 0, width: pg.viewportSize().width, height } }
          : { path: opts.out, fullPage: true },
      );
      return {
        ok: true,
        title,
        final_url: pg.url(),
        ...(clipped ? { truncated_height: full } : {}),
      };
    },
    { mobile, dsf },
  );
}

function unwrapDdg(href) {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const target = u.searchParams.get("uddg");
    return target ? decodeURIComponent(target) : href;
  } catch {
    return href;
  }
}

function print(obj) {
  process.stdout.write(JSON.stringify(obj));
}

async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  const handlers = { search, page, shot };
  const handler = handlers[cmd];
  if (!handler) {
    print({ ok: false, error: `unknown command: ${cmd}` });
    process.exit(2);
  }
  try {
    print(await handler(opts));
  } catch (e) {
    print({ ok: false, error: String(e && e.message ? e.message : e) });
    process.exit(1);
  }
}

main();
