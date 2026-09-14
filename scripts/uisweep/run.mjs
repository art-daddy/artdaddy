// UI sweep runner.
//
// usage: node --experimental-websocket scripts/uisweep/run.mjs [nameFilter]
//
// Requires the app already running with CDP:
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'; npx tauri dev
import { mkdirSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { Ctx } from "./lib/ctx.mjs";
import { open } from "./lib/driver.mjs";
import { ensureFixtures } from "./lib/fixtures.mjs";
import { importMedia, newProject } from "./lib/setup.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT = path.join(ROOT, "reports", "uisweep");

const filter = process.argv[2] ?? "";

/** Delete fixture projects from previous runs. Only ever touches `sweep_*` — a user's
 *  real project must never be collateral of a test run. */
function purgeOldFixtures() {
  const root = path.join(process.env.APPDATA ?? "", "ArtDaddy", "projects");
  let n = 0;
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory() || !/^sweep_/.test(d.name)) continue;
    rmSync(path.join(root, d.name), { recursive: true, force: true });
    n++;
  }
  if (n) console.log(`removed ${n} fixture project(s) from earlier runs`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  purgeOldFixtures();
  const media = ensureFixtures();
  console.log(`fixtures: ${Object.keys(media).join(", ")}`);

  const d = await open();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const projectId = await newProject(d, `sweep-${stamp}`);
  console.log(`fixture project: ${projectId}`);
  await importMedia(d, projectId, Object.values(media));

  const dir = path.join(import.meta.dirname, "scenarios");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".mjs")).sort();

  const results = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(path.join(dir, f)).href);
    for (const s of mod.scenarios ?? []) {
      if (filter && !s.name.includes(filter) && !(s.area ?? "").includes(filter)) continue;
      const ctx = new Ctx(d, projectId, s.name);
      const t0 = Date.now();
      let error = null;
      try {
        await s.run(ctx, d, media);
      } catch (e) {
        error = String(e?.stack ?? e);
      }
      const passed = !error && ctx.passed;
      const diag = passed ? null : await ctx.diagnostics();
      results.push({
        file: f,
        name: s.name,
        area: s.area ?? f.replace(/\.mjs$/, ""),
        ms: Date.now() - t0,
        error,
        checks: ctx.checks,
        diag,
        passed,
      });
      console.log(`${passed ? "PASS" : "FAIL"}  ${s.name}`);
      for (const c of ctx.checks.filter((c) => !c.ok)) {
        console.log(`        ${c.message}${c.detail ? ` — ${c.detail}` : ""}`);
      }
      if (error) console.log(`        threw: ${error.split("\n")[0]}`);
      if (diag) console.log(`        ui: ${JSON.stringify(diag)}`);
    }
  }

  d.close();

  const report = { projectId, when: new Date().toISOString(), results };
  writeFileSync(path.join(OUT, "sweep.json"), JSON.stringify(report, null, 2));
  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
  if (failed.length) {
    console.log(`\nFAILURES:`);
    for (const r of failed) {
      console.log(`  ${r.area} > ${r.name}`);
      for (const c of r.checks.filter((c) => !c.ok))
        console.log(`      ${c.message}${c.detail ? ` — ${c.detail}` : ""}`);
      if (r.error) console.log(`      threw: ${r.error.split("\n")[0]}`);
    }
  }
  console.log(`\nreport: ${path.join(OUT, "sweep.json")}`);
  console.log(`fixture project left at: ${projectId} (delete when done)`);
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exit(1);
});
