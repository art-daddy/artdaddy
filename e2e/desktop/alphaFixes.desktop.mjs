// The three alpha-user bugs, re-verified in the REAL app against real files.
//
// Each one shipped green: the whisper fix had a test asserting the CRASH was correct, the
// import OOM was invisible to a suite with no real 400 MB file, and Save As is new. So this
// lane uses the actual desktop binary, real media off disk, and asserts the artifact —
// transcript WORDS, the project's own bytes on disk, memory actually not spent.
//
//   $env:MSEDGEDRIVER="...\msedgedriver.exe"; node e2e/desktop/alphaFixes.desktop.mjs
import { existsSync, mkdirSync, copyFileSync, readFileSync, statSync, rmSync } from "node:fs";
import path from "node:path";

import { appBinary, newSession, projectsRoot, sleep, startDriver, waitFor } from "./webdriver.mjs";

const NAME = `alpha${Date.now().toString().slice(-6)}`;
const PROJECTS = projectsRoot();
const DL = path.join(process.env.USERPROFILE, "Downloads");
const WORK = path.join(process.env.USERPROFILE, "_artdaddy-alpha-verify");
const SAVED_AS = path.join(WORK, "Saved Elsewhere");
const URL_MCP = "http://127.0.0.1:19787/mcp";

// Real user media, not a synthetic fixture: the bugs were about SIZE and about SPEECH.
const SPEECH = path.join(DL, "new-recording-20_GWa1I2ht.mp3");
// 1.75 GB. Under the old bug this was read whole into the webview to test EISDIR, at a
// measured 8.3x amplification — roughly 14 GB of heap, i.e. a certain crash.
const BIG = path.join(DL, "Screen-Recording (2).mp4");

const failures = [];
const check = (label, cond, detail = "") => {
  if (cond) console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    failures.push(label);
  }
};
const info = (label, detail) => console.log(`  info ${label} — ${detail}`);

let rpcId = 0;
let sessionId = null;
async function rpc(method, params) {
  const headers = { "content-type": "application/json" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(URL_MCP, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const assigned = res.headers.get("mcp-session-id");
  if (assigned) sessionId = assigned;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
async function call(name, args = {}) {
  const out = await rpc("tools/call", { name, arguments: args });
  const block = out?.result?.content?.[0]?.text ?? "";
  try {
    return JSON.parse(block);
  } catch {
    return block;
  }
}

mkdirSync(WORK, { recursive: true });
rmSync(SAVED_AS, { recursive: true, force: true });

const driver = await startDriver();
let s;
try {
  s = await newSession(appBinary());
  await waitFor(
    () =>
      s.exec(
        "return [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'File');",
      ),
    { label: "the app to boot" },
  );
  await waitFor(async () => !!(await rpc("ping", {})), { label: "the MCP port" });
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "alpha-verify", version: "1" },
  });

  const made = await call("manage_project", { action: "create", name: NAME });
  const projectId = made?.created;
  const projectDir = path.join(PROJECTS, projectId);
  check("a project was created", !!projectId, projectId);

  // ── ALPHA BUG 1: whisper-cli transcription returned nothing ────────────────────────
  console.log("\n[1] whisper transcription");
  if (!existsSync(SPEECH)) {
    check("speech fixture present", false, SPEECH);
  } else {
    const imported = await call("import_media", { source: { path: SPEECH } });
    check("the speech file imported", imported?.ok !== false, imported?.media_ref ?? imported?.error);
    const placed = await call("add_clips", {
      entries: [{ media_ref: imported.media_ref, timeline_in: 0 }],
    });
    check("it was placed on the timeline", placed?.ok !== false, placed?.error ?? "");
    const t0 = Date.now();
    const tr = await call("get_transcript", {});
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    // The OUTCOME is WORDS. The shipped bug was a 27 KB deprecation stub that "ran"
    // fine and returned nothing — indistinguishable from silent footage unless you
    // read the payload. Shape is { clips: [{ words: [[index, text, startFrame], ...] }] };
    // asserting an invented `segments[].text` here reported a false failure once already.
    const clips = Array.isArray(tr?.clips) ? tr.clips : [];
    const words = clips.flatMap((c) => (c.words ?? []).map((w) => w[1])).join(" ").trim();
    check("get_transcript succeeded", tr?.ok !== false, tr?.error ?? "");
    check("it returned real words, not silence", words.split(/\s+/).length > 5, `${words.split(/\s+/).length} words in ${secs}s`);
    info("transcript", words.slice(0, 160));
    check(
      "every word carries a frame position",
      clips.every((c) => (c.words ?? []).every((w) => Number.isFinite(w[2]))),
      `word_format=${JSON.stringify(tr?.word_format)}`,
    );
    check(
      "the times are project FRAMES, per the contract",
      tr?.timing === "project_frames",
      String(tr?.timing),
    );
  }

  // ── ALPHA BUG 2: importing a large file exhausted the webview heap ─────────────────
  console.log("\n[2] large file import");
  if (!existsSync(BIG)) {
    check("large fixture present", false, BIG);
  } else {
    const mb = (statSync(BIG).size / 1e6).toFixed(0);
    const heapBefore = await s.exec("return performance.memory ? performance.memory.usedJSHeapSize : 0;");
    const t0 = Date.now();
    const big = await call("import_media", { source: { path: BIG } });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const heapAfter = await s.exec("return performance.memory ? performance.memory.usedJSHeapSize : 0;");
    const grewMb = (heapAfter - heapBefore) / 1e6;
    check("the large file imported", big?.ok !== false, `${mb} MB in ${secs}s — ${big?.media_ref ?? big?.error}`);
    // The REGRESSION, measured: it used to read the whole file into the webview to test
    // EISDIR (8.3x amplification). A linked import must not pull the file into the heap.
    info("webview heap", `${(heapBefore / 1e6).toFixed(0)} MB -> ${(heapAfter / 1e6).toFixed(0)} MB (+${grewMb.toFixed(0)} MB)`);
    check(
      "it did NOT read the file into the webview heap",
      grewMb < Number(mb) * 0.5,
      `+${grewMb.toFixed(0)} MB for a ${mb} MB file`,
    );
    const cat = JSON.parse(readFileSync(path.join(projectDir, "internals", "library.json"), "utf8"));
    const entry = (cat.clips ?? []).find((c) => c.id === big?.media_ref);
    check("it was LINKED in place, not copied", entry?.external === true, entry?.path);
  }

  // ── The Save As path, driven through the same store action the menu calls ──────────
  console.log("\n[3] project Save As");
  const before = await s.exec(
    "const s = window.__ARTDADDY_TEST__; return null;",
  ).catch(() => null);
  const saved = await s.exec(
    `const dest = arguments[0];
     const m = await import("/src/store/projects.ts");
     await m.useProjects.getState().saveAs(arguments[1], dest);
     return "ok";`,
    [SAVED_AS.replace(/\\/g, "/"), projectId],
  ).catch((e) => `ERR ${e.message}`);
  info("saveAs", String(saved));
  check("the project was copied to the chosen folder", existsSync(path.join(SAVED_AS, "internals", "project.json")));
  check("its timeline came with it", existsSync(path.join(SAVED_AS, "internals", "timeline.json")));
  check("the original is still on disk (Premiere leaves it)", existsSync(path.join(projectDir, "internals", "project.json")));
  check("the derived cache was not copied", !existsSync(path.join(SAVED_AS, "internals", "cache")));

  console.log(failures.length ? `\n${failures.length} failure(s): ${failures.join(", ")}` : "\nall checks passed");
} finally {
  try {
    await s?.quit();
  } catch {
    /* session already gone */
  }
  driver.kill();
  await sleep(300);
}
process.exit(failures.length ? 1 : 0);
