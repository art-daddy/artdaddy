// QA for Phase 2 of the fix programme (UJ-012, "a look costs what it shows"; docs/
// USER_JOURNEY_ANALYSIS.md in the server repo). Drives the REAL dev app over CDP against a LOCAL
// server, one step at a time, so a person (or an agent) can replay a user's journey and read the
// evidence after every turn:
//
//   node --experimental-websocket scripts/qa/inspectLooks.mjs setup <name> [aspect]
//   node --experimental-websocket scripts/qa/inspectLooks.mjs place <projectId> <library filename> [track] [frame]
//   node --experimental-websocket scripts/qa/inspectLooks.mjs say <projectId> "<prompt>" [model]
//
// `say` sends the prompt through the composer, waits for the turn, and prints what the agent DID:
// every tool call with its arguments, how long the app took to run it (timed at the tool registry,
// the one door every call passes through), the parts of each result a look is judged on, and the
// final answer. Evidence comes from the persisted transcript (internals/transcript.json) and the
// registry timings, never from the DOM alone. Each turn is appended to reports/qa/phase2.jsonl.
//
// Big media is imported through the app's own import tool (MCP `import_media` with a path, which
// links it in place), not through the file input, which would read the whole file into the webview.
//
// Needs: server with ARTDADDY_AUTH_DISABLED=1 on the app's VITE_API_BASE_URL; app from
// `npx tauri dev` with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { projectDir } from "../uisweep/lib/doc.mjs";
import { open } from "../uisweep/lib/driver.mjs";
import { newProject, placeFromLibrary } from "../uisweep/lib/setup.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = path.resolve(import.meta.dirname, "../../reports/qa");
mkdirSync(OUT, { recursive: true });

/** The URL the APP loaded a module from. After a hot update Vite serves it as `<path>?t=<stamp>`,
 *  and importing the bare path then yields a SECOND instance: a hook installed on it times
 *  nothing (the first QA run of this script recorded no timings that way). */
const modUrl = (p) =>
  `(performance.getEntriesByType('resource').map(e => e.name).filter(n => new URL(n).pathname === ${JSON.stringify(p)}).pop() ?? ${JSON.stringify(p)})`;

/** The local server cannot refresh this machine's real desktop session, so the app marks itself
 *  offline and disables the composer. QA only: unlock the dev app's auth store. */
async function unlock(d) {
  const s = await d.eval(
    `import(${modUrl("/src/store/auth.ts")}).then(m => { if (m.useAuth.getState().status !== 'unlocked') m.useAuth.setState({ status: 'unlocked' }); return m.useAuth.getState().status; })`,
  );
  if (s !== "unlocked") throw new Error(`could not unlock the dev app (status ${s})`);
}

/** Time every tool call where the app runs it: the registry's `run`, which every call passes. */
async function timeTools(d) {
  return d.eval(`import(${modUrl("/src/tools/registry.ts")}).then(m => {
    const p = m.ClientToolRegistry.prototype;
    if (!p.__qaTimed) {
      const run = p.run;
      window.__qaTools = window.__qaTools ?? [];
      p.run = async function (name, args) {
        const t0 = performance.now();
        try { return await run.call(this, name, args); }
        finally { window.__qaTools.push({ name, ms: Math.round(performance.now() - t0) }); }
      };
      p.__qaTimed = true;
    }
    window.__qaTools = [];
    return true; })`);
}

async function selectModel(d, model) {
  const has = `[...document.querySelectorAll('select')].some(x => [...x.options].some(o => o.value === ${JSON.stringify(model)}))`;
  await d.waitFor(has, 30000).catch(() => null);
  const ok = await d.eval(`(() => {
    const s = [...document.querySelectorAll('select')].find(x => [...x.options].some(o => o.value === ${JSON.stringify(model)}));
    if (!s) return false;
    s.value = ${JSON.stringify(model)};
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true; })()`);
  if (!ok) throw new Error(`no model picker offers ${model}`);
}

const STOP = `[...document.querySelectorAll('button')].find(b => /^\\W*stop$/i.test((b.innerText||'').trim()))`;
const busy = async (d) => Boolean(await d.eval(`!!(${STOP})`));

async function waitTurn(d, ms = 1_800_000) {
  const t0 = Date.now();
  await sleep(1500);
  for (;;) {
    const cont = await d.eval(
      `(() => { const b = [...document.querySelectorAll('button')].find(b => /^continue$/i.test((b.innerText||'').trim())); if (b) { b.click(); return true } return false })()`,
    );
    if (cont) console.log("  (clicked Continue)");
    if (!(await busy(d))) {
      await sleep(1500);
      if (!(await busy(d))) return Date.now() - t0;
    }
    if (Date.now() - t0 > ms) throw new Error("turn did not settle");
    await sleep(1000);
  }
}

function transcript(pid) {
  const p = path.join(projectDir(pid), "internals", "transcript.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { requests: [] };
}

/** The parts of a tool result a look is judged on. */
function judge(name, r) {
  if (!r || typeof r !== "object") return r;
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
  const out = pick(r, ["ok", "error", "frames_attached", "frame_numbers", "out_of_range", "duration_frames", "timing", "window_s", "sharpness", "noise_sigma", "warnings", "reference_error", "subject"]);
  if (Array.isArray(r.frames))
    out.frames = r.frames.map((f) => pick(f, ["frame", "t", "time_s", "ok", "error", "visible_clips"]));
  if (r.overview) out.overview = r.overview.tile_times ?? r.overview.tile_frames ?? r.overview;
  if (r.loudness) out.loudness = r.loudness;
  if (r.transcript)
    out.transcript = r.transcript.status
      ? pick(r.transcript, ["status", "note"])
      : { segments: (r.transcript.segments ?? []).length, language: r.transcript.language, first: (r.transcript.segments ?? [])[0] };
  if (r.scopes) out.scopes = pick(r.scopes, ["mean_luma", "saturation", "warm_cool", "green_magenta"]);
  if (name === "inspect_media" && r.coordinate_grid) out.grid = true;
  if (name === "inspect_timeline" && r.coordinate_grid) out.grid = true;
  return out;
}

async function say(pid, prompt, model, stopAfterMs = null) {
  const d = await open();
  try {
    await unlock(d);
    if (!(await d.eval(`location.pathname.includes(${JSON.stringify(pid)})`)))
      throw new Error(`the app is not on project ${pid}`);
    await selectModel(d, model);
    await timeTools(d);
    const before = (transcript(pid).requests ?? []).length;
    await d.waitFor(`!!document.querySelector('textarea') && !document.querySelector('textarea').disabled`, 30000);
    await d.click("textarea");
    await d.type(prompt);
    await d.key("Enter");
    if (stopAfterMs !== null) {
      // Press Stop while a tool is RUNNING — once the turn's first tool call is on record, plus
      // `stopAfterMs` — the way a user gives up on a slow look.
      const t0 = Date.now();
      for (;;) {
        const fresh = (transcript(pid).requests ?? []).slice(before);
        if (fresh.some((q) => (q.response ?? []).some((p) => p.kind === "tool_call"))) break;
        if (Date.now() - t0 > 120000) throw new Error("no tool call started");
        await sleep(250);
      }
      await sleep(stopAfterMs);
      const clicked = await d.eval(`(() => { const b = ${STOP}; if (b) { b.click(); return true } return false })()`);
      console.log(`  (pressed Stop ${stopAfterMs} ms after the first tool call: ${clicked})`);
    }
    const ms = await waitTurn(d);
    const timings = (await d.eval(`JSON.stringify(window.__qaTools ?? [])`)) ?? "[]";
    const tools = JSON.parse(timings);
    const reqs = transcript(pid).requests ?? [];
    const fresh = reqs.slice(before);
    const parts = fresh.flatMap((q) => q.response ?? []);
    const calls = parts.filter((p) => p.kind === "tool_call");
    const results = new Map(parts.filter((p) => p.kind === "tool_result").map((p) => [p.call_id, p]));
    // Timings are recorded in completion order; match each call to the next unused one of its name.
    const used = new Set();
    const rows = calls.map((c) => {
      const i = tools.findIndex((t, k) => !used.has(k) && t.name === c.name);
      if (i >= 0) used.add(i);
      const res = results.get(c.call_id);
      return { round: c.round, name: c.name, args: c.args, ms: i >= 0 ? tools[i].ms : null, result: judge(c.name, res?.result ?? res) };
    });
    const answer = parts.filter((p) => p.kind === "text").map((p) => p.text).join("\n");
    const errors = parts.filter((p) => p.kind === "error").map((p) => String(p.error ?? ""));
    const record = { at: new Date().toISOString(), pid, model, prompt, turn_ms: ms, calls: rows, errors, answer };
    appendFileSync(path.join(OUT, "phase2.jsonl"), JSON.stringify(record) + "\n");
    console.log(`turn: ${Math.round(ms / 1000)} s, ${rows.length} tool calls, errors=${JSON.stringify(errors)}`);
    for (const r of rows) console.log(`- r${r.round} ${r.name} ${JSON.stringify(r.args)} -> ${r.ms} ms\n    ${JSON.stringify(r.result).slice(0, 1200)}`);
    console.log(`answer: ${answer}`);
  } finally {
    d.close();
  }
}

const [cmd, a1, a2, a3, a4] = process.argv.slice(2);
if (cmd === "setup") {
  const d = await open();
  await unlock(d);
  console.log(await newProject(d, a1, a2 ?? "16:9"));
  d.close();
} else if (cmd === "place") {
  const d = await open();
  const doc = await placeFromLibrary(d, a1, a2, a3 ?? "v1", Number(a4 ?? 0));
  console.log(JSON.stringify((doc?.tracks ?? []).map((t) => ({ id: t.id, clips: (t.clips ?? []).map((c) => [c.id, c.timeline_in, c.timeline_out]) }))));
  d.close();
} else if (cmd === "say") {
  await say(a1, a2, a3 ?? "gpt-5.4-mini");
} else if (cmd === "stop") {
  // stop <pid> "<prompt>" <ms>: send, press Stop after <ms>, report what the turn did.
  await say(a1, a2, "gpt-5.4-mini", Number(a3 ?? 5000));
} else {
  console.log("usage: setup <name> [aspect] | place <pid> <file> [track] [frame] | say <pid> <prompt> [model] | stop <pid> <prompt> <ms>");
}
process.exit(0);
