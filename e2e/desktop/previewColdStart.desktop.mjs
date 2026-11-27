// What the app's start and the preview's cold start actually cost INSIDE the app, timed for the budget check.
//
// The browser probe (preview-probe-coldstart.html) showed decode is 43-86ms, so the several
// seconds of black a user reported at the start of playback are spent somewhere else. That
// "somewhere else" only exists under Tauri -- resolving each source to an asset URL is an IPC
// round-trip per source, and none of it is reachable from a plain browser. So drive the REAL
// app and read the marks previewClient records.
//
// Two waits are recorded with the shared helper (e2e/lib/timing.mjs), each on the app's own clock, not the driver's:
//   "app start: launch to usable (dev build)": the process's age (`process_age_ms`, the clock of the launch marker's
//     start-up timing) when the start screen first takes input. Taken on the SECOND launch: the first one pays for
//     vite transforming the code on demand, a cost of the dev server that no installed app has.
//   "preview: open a project to its first picture (dev build)": on the page's clock, from the click on the project in
//     the start screen to the preview's `preview:first-frame` mark.
//
// It makes its own throwaway project over MCP (sweep_coldstart<n>, holding the test clip) and deletes it after:
// the dev app shares the real projects folder, so it never opens another one. Only one app can hold the MCP port, so
// it refuses to start while something else listens there (an installed ArtDaddy).
//
// PREREQUISITES: tauri-driver + msedgedriver on PATH (or MSEDGEDRIVER=<path>), a debug build under the lanes' own
// identity (`cargo build` in src-tauri with TAURI_CONFIG from e2e/desktop/timing/identity.mjs, never the shipped
// identity: qa skill rule 12; ARTDADDY_APP_BINARY=<exe> when CARGO_TARGET_DIR put it elsewhere) and vite serving the
// page where that identity's devUrl points, with VITE_E2E_AUTH_BYPASS=1 and VITE_API_BASE_URL at a service that
// answers the app's build check (a real local one, or scripts/qa/standInServer.mjs); without one the app stops on
// "Verifying ArtDaddy". scripts/qa/nightlyTiming.ps1 sets all of this up, inside the real-app slot.
//
//   node e2e/desktop/previewColdStart.desktop.mjs
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

import { record } from "../lib/timing.mjs";
import {
  MCP_PORT,
  appBinary,
  mcpPortTaken,
  newSession,
  projectsRoot,
  root,
  sleep,
  startDriver,
  waitFor,
  waitInApp,
} from "./webdriver.mjs";

const NAME = `sweep_coldstart${Date.now().toString().slice(-6)}`;
const MEDIA_DIR = path.join(root, "..", "_artdaddy-cold-media");
const MEDIA = path.join(MEDIA_DIR, "cold-clip.mp4");
const MCP = `http://127.0.0.1:${MCP_PORT}/mcp`;

// The start screen takes input (the menu bar and the prompt box are up); at that moment, the process's age.
const USABLE = `
  const up = [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'File') &&
    !!document.querySelector('#picker-prompt:not([disabled])');
  if (!up) return null;
  return window.__TAURI_INTERNALS__.invoke('process_age_ms')
    .then((age) => ({ age }), (error) => ({ error: String(error) }));`;

const readMarks = (s) =>
  s.exec(
    `const marks = performance.getEntriesByType('mark')
       .filter((m) => m.name.startsWith('preview:'))
       .map((m) => ({ name: m.name.replace('preview:', ''), at: Math.round(m.startTime) }));
     const measures = performance.getEntriesByType('measure')
       .filter((m) => m.name.startsWith('preview:'))
       .map((m) => ({ name: m.name.replace('preview:', ''), ms: Math.round(m.duration) }));
     const nav = performance.getEntriesByType('navigation')[0];
     return {
       marks,
       measures,
       loadMs: nav ? Math.round(nav.loadEventEnd) : null,
       resourceCount: performance.getEntriesByType('resource').length,
     };`,
    [],
  );

let rpcId = 0;
let mcpSession = null;
async function rpc(method, params) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (mcpSession) headers["mcp-session-id"] = mcpSession;
  const res = await fetch(MCP, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  mcpSession = res.headers.get("mcp-session-id") ?? mcpSession;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
async function tool(name, args) {
  const out = await rpc("tools/call", { name, arguments: args });
  const text = out?.result?.content?.[0]?.text ?? JSON.stringify(out);
  if (out?.result?.isError) throw new Error(`${name} failed: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function main() {
  if (await mcpPortTaken()) {
    throw new Error(
      `MCP port ${MCP_PORT} is already taken: another ArtDaddy is running. This lane drives only the app it starts; ` +
        "close the other one and run it again.",
    );
  }
  const driver = await startDriver();
  let s;
  try {
    mkdirSync(MEDIA_DIR, { recursive: true });
    copyFileSync(path.join(root, "public", "test-clip.mp4"), MEDIA);
    // Launch 1, not timed: vite transforms the code on first request, and the project to open is made here.
    s = await newSession(appBinary());
    await waitInApp(s, USABLE, {
      label: "the start screen (first launch)",
      timeout: 240_000,
      interval: 250,
    });
    await waitFor(async () => !!(await rpc("ping", {}).catch(() => null)), {
      label: "the MCP server",
    });
    await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "previewColdStart", version: "1" },
    });
    const created = await tool("manage_project", {
      action: "create",
      name: NAME,
      aspect: "16:9",
      fps: 30,
    });
    if (created?.ready !== true)
      throw new Error(`the project did not open: ${JSON.stringify(created)}`);
    const media = await tool("import_media", { source: { path: MEDIA } });
    if (!media?.media_ref)
      throw new Error(`the import gave no media_ref: ${JSON.stringify(media)}`);
    await tool("add_clips", {
      entries: [{ media_ref: media.media_ref, timeline_in: 0, timeline_out: 30 }],
    });
    // Its first picture once here, so the timed launch finds the project as a person's would be: imported, with its
    // preview copy already made.
    await waitFor(
      () => s.exec("return performance.getEntriesByName('preview:first-frame').length > 0;"),
      {
        label: "the project's first picture (first launch)",
        timeout: 120_000,
      },
    );
    console.log("--- launch 1 (cold: vite transforming on demand) ---");
    console.log(JSON.stringify(await readMarks(s), null, 2));
    await s.quit();
    s = undefined;
    // The app is single-instance: a launch while the old process is still closing would be handed to it.
    await waitFor(async () => !(await mcpPortTaken()), {
      label: "the first launch to exit",
      timeout: 60_000,
    });

    // Launch 2, timed.
    s = await newSession(appBinary());
    const usable = await waitInApp(s, USABLE, {
      label: "the start screen",
      timeout: 120_000,
      interval: 50,
    });
    if (usable.error)
      throw new Error(`the app could not say how old its process is: ${usable.error}`);
    record("app start: launch to usable (dev build)", usable.age);

    // Open the project the way a person does, by clicking it in the start screen; the page's clock times the rest.
    const clickedAt = await waitFor(
      () =>
        s.exec(
          `const button = [...document.querySelectorAll('button')]
             .find((b) => (b.textContent || '').includes(arguments[0]));
           if (!button) return null;
           const at = performance.now();
           button.click();
           return at;`,
          [NAME],
        ),
      { label: `the project "${NAME}" in the start screen` },
    );
    const firstPicture = await waitFor(
      () =>
        s.exec(
          `const m = performance.getEntriesByName('preview:first-frame').find((e) => e.startTime >= arguments[0]);
           return m ? m.startTime : null;`,
          [clickedAt],
        ),
      { label: "the project's first picture", timeout: 60_000, interval: 100 },
    );
    record("preview: open a project to its first picture (dev build)", firstPicture - clickedAt);
    console.log("--- launch 2 (timed) ---");
    console.log(JSON.stringify(await readMarks(s), null, 2));
  } finally {
    await s?.quit();
    driver.kill();
    await sleep(600);
    // The app may still be letting go of its files for a moment after it closes.
    const gone = { recursive: true, force: true, maxRetries: 10, retryDelay: 300 };
    try {
      for (const dir of readdirSync(projectsRoot()).filter((d) => d.startsWith(NAME))) {
        rmSync(path.join(projectsRoot(), dir), gone);
      }
    } catch (e) {
      console.error(`could not remove the project ${NAME}: ${e.message}`);
    }
    rmSync(MEDIA_DIR, gone);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
