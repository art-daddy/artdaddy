// What the preview's cold start actually costs INSIDE the app.
//
// The browser probe (preview-probe-coldstart.html) showed decode is 43-86ms, so the several
// seconds of black a user reported at the start of playback are spent somewhere else. That
// "somewhere else" only exists under Tauri -- resolving each source to an asset URL is an IPC
// round-trip per source, and none of it is reachable from a plain browser. So drive the REAL
// app and read the marks previewClient records.
//
// PREREQUISITES: tauri-driver + msedgedriver on PATH (or MSEDGEDRIVER=<path>), a debug build
// (`cargo build` in src-tauri) and `npx vite --port 5173` running.
//
//   node e2e/desktop/previewColdStart.desktop.mjs
import { appBinary, newSession, sleep, startDriver, waitFor } from "./webdriver.mjs";

const PROJECT = process.env.COLD_PROJECT ?? "t001";

async function main() {
  const driver = await startDriver();
  let s;
  try {
    s = await newSession(appBinary());
    await waitFor(async () => (await s.exec("return document.readyState;", [])) === "complete", {
      label: "webview ready",
      timeout: 120_000,
    });

    // Open a project that HAS video on its timeline; the picker lists them by name.
    const opened = await waitFor(
      async () =>
        s.exec(
          `const t = arguments[0];
           const el = [...document.querySelectorAll('button,[role=button],a')]
             .find((e) => (e.textContent || '').trim().toLowerCase().includes(t.toLowerCase()));
           if (!el) return null;
           el.click();
           return (el.textContent || '').trim();`,
          [PROJECT],
        ),
      { label: `project button containing "${PROJECT}"`, timeout: 60_000 },
    );
    console.log(`opened project: ${opened}`);

    // Give the preview time to resolve, decode and paint.
    await sleep(12_000);

    const read = () =>
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

    console.log("--- pass 1 (cold: vite transforming on demand) ---");
    console.log(JSON.stringify(await read(), null, 2));

    // Pass 2 isolates the ONE-TIME cost. A reload re-runs the whole app with every module already
    // fetched and the OS file cache warm, which is the closest a dev build gets to a release boot.
    await s.exec("location.reload(); return 1;", []);
    await waitFor(async () => (await s.exec("return document.readyState;", [])) === "complete", {
      label: "webview reloaded",
      timeout: 120_000,
    });
    await sleep(12_000);
    console.log("--- pass 2 (warm reload) ---");
    console.log(JSON.stringify(await read(), null, 2));
  } finally {
    await s?.quit();
    driver.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
