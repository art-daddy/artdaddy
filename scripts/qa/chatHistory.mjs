// QA for Phase 1 of the fix programme (client-owned history; docs/USER_JOURNEY_ANALYSIS.md in the
// server repo). Drives the REAL dev app over CDP against a LOCAL server and replays the shapes of
// the journeys that broke:
//   J1 (UJ-019) look at every clip, three times over -- three users were refused past 50 images;
//   J2 (UJ-008/018) Stop in the middle of a batch, then a new message -- the next request was
//      refused, and after the recovery the agent had no memory of the request;
//   J3 (UJ-018) the server dies in the middle of a turn (a deploy / scale-to-zero restart), then a
//      new message -- the agent must still remember the conversation (this script restarts it);
//   J4 frames the history showed survive a project close and an app restart;
//   J5 Stop while the model is thinking: the server hangs up on Azure, reports no usage, and the
//      chat carries on (owner decision 2026-10-03: a stopped round costs what Azure charges).
// It asserts on ARTIFACTS: the persisted transcript (internals/transcript.json) and the server's
// per-round log lines (`client_history ...`, `round usage ...`), never on the DOM alone.
//
// Needs:
//   server: AKARU_LOG_LEVEL=INFO, ARTDADDY_AUTH_DISABLED=1, logs to $env:QA_SERVER_LOG
//   app:    VITE_API_BASE_URL=<server>, VITE_E2E_AUTH_BYPASS=1,
//           WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222; npx tauri dev
// usage: node --experimental-websocket scripts/qa/chatHistory.mjs [J1|J2] [model]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { projectDir } from "../uisweep/lib/doc.mjs";
import { open } from "../uisweep/lib/driver.mjs";
import { importMedia, newProject } from "../uisweep/lib/setup.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const only = process.argv[2] ?? "";
const MODEL = process.argv[3] ?? "gpt-5.4-mini";
const SERVER_LOG = process.env.QA_SERVER_LOG ?? path.join(os.tmpdir(), "qa_server_err.txt");
const OUT = path.resolve(import.meta.dirname, "../../reports/qa");
mkdirSync(OUT, { recursive: true });

// ── fixtures: six visibly different clips with a tone, made with ffmpeg ────────────────────
function fixtures() {
  const dir = path.join(os.tmpdir(), "qa_phase1_media");
  mkdirSync(dir, { recursive: true });
  const colors = ["red", "green", "blue", "yellow", "magenta", "cyan"];
  return colors.map((c, i) => {
    const f = path.join(dir, `clip${i + 1}_${c}.mp4`);
    if (!existsSync(f))
      execFileSync("ffmpeg", [
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", `color=c=${c}:s=1280x720:d=6:r=30`,
        "-f", "lavfi", "-i", `testsrc2=s=320x180:d=6:r=30`,
        "-f", "lavfi", "-i", `sine=frequency=${300 + i * 110}:duration=6`,
        "-filter_complex", "[0:v][1:v]overlay=x=(W-w)/2:y=(H-h)/2[v]",
        "-map", "[v]", "-map", "2:a", "-shortest", "-pix_fmt", "yuv420p", "-c:a", "aac", f,
      ]);
    return f;
  });
}

// ── artifacts ────────────────────────────────────────────────────────────────────────────
function transcript(pid) {
  const p = path.join(projectDir(pid), "internals", "transcript.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { requests: [] };
}
const logSize = () => (existsSync(SERVER_LOG) ? statSync(SERVER_LOG).size : 0);
function logSince(offset) {
  if (!existsSync(SERVER_LOG)) return [];
  return readFileSync(SERVER_LOG, "utf8").slice(offset).split(/\r?\n/);
}
function rounds(lines) {
  const hist = lines
    .filter((l) => l.includes("client_history items="))
    .map((l) => Object.fromEntries([...l.matchAll(/(\w+)=(\d+)/g)].map((m) => [m[1], Number(m[2])])));
  const usage = lines
    .filter((l) => l.includes("round usage"))
    .map((l) => ({
      mode: /mode=(\w+)/.exec(l)?.[1],
      input: Number(/input=(\d+)/.exec(l)?.[1]),
      cached: Number(/cached=(\d+)/.exec(l)?.[1]),
    }));
  return { hist, usage };
}

// ── the chat panel, through real input ───────────────────────────────────────────────────
async function selectModel(d, model) {
  await unlock(d);
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

const COMPOSER = `textarea`;

/** The local server runs with auth disabled for loopback, but this machine holds a real
 *  desktop session, whose refresh the local server cannot serve (503), so the app marks itself
 *  offline and disables the composer. QA only: mark the dev app's auth store unlocked through
 *  Vite's module URL (the same instance the app uses while nothing has hot-reloaded). */
async function unlock(d) {
  const s = await d.eval(
    `import('/src/store/auth.ts').then(m => { if (m.useAuth.getState().status !== 'unlocked') m.useAuth.setState({ status: 'unlocked' }); return m.useAuth.getState().status; })`,
  );
  if (s !== "unlocked") throw new Error(`could not unlock the dev app (status ${s})`);
}

async function say(d, text) {
  await unlock(d);
  await d.waitFor(`!!document.querySelector(${JSON.stringify(COMPOSER)}) && !document.querySelector(${JSON.stringify(COMPOSER)}).disabled`, 30000);
  await d.click(COMPOSER);
  await d.type(text);
  await d.key("Enter");
}

// The chat's Stop button reads "⏹ Stop" while a turn runs.
const STOP = `[...document.querySelectorAll('button')].find(b => /^\\W*stop$/i.test((b.innerText||'').trim()))`;
async function busy(d) {
  return Boolean(await d.eval(`!!(${STOP})`));
}

/** Wait for the turn to settle; click Continue if the agent checks in. */
async function waitTurn(d, ms = 600000) {
  const t0 = Date.now();
  await sleep(1500);
  for (;;) {
    const cont = await d.eval(
      `(() => { const b = [...document.querySelectorAll('button')].find(b => /^\\W*continue$/i.test((b.innerText||'').trim())); if (b) { b.click(); return true } return false })()`,
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

function lastRequest(pid) {
  const reqs = transcript(pid).requests ?? [];
  return reqs[reqs.length - 1] ?? { response: [] };
}
const kinds = (req) => (req.response ?? []).map((p) => p.kind);
const errors = (req) => (req.response ?? []).filter((p) => p.kind === "error").map((p) => String(p.error ?? ""));
const finalText = (req) => (req.response ?? []).filter((p) => p.kind === "text").map((p) => p.text).join("\n");

const report = [];
function check(name, ok, detail) {
  report.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
}

// ── journeys ─────────────────────────────────────────────────────────────────────────────
async function j1(d, pid) {
  console.log("J1: look at every clip, three times over (UJ-019)");
  const prompts = [
    "Look at every clip in the library with inspect_media, 6 frames each, and tell me in one short line per clip what you see.",
    "Look at all of them again, 6 frames each, and rank them from most to least colourful. One line.",
    "One more pass: inspect each clip again with 6 frames and tell me which two clips look most alike. One line.",
  ];
  for (const [i, p] of prompts.entries()) {
    const off = logSize();
    await say(d, p);
    const ms = await waitTurn(d);
    const req = lastRequest(pid);
    const r = rounds(logSince(off));
    const inspects = kinds(req).filter((k) => k === "tool_call").length;
    const maxImages = Math.max(0, ...r.hist.map((h) => h.images));
    const omitted = Math.max(0, ...r.hist.map((h) => h.frames_omitted));
    check(
      `J1 pass ${i + 1}: answered, never refused`,
      finalText(req) && errors(req).length === 0,
      `${Math.round(ms / 1000)} s, ${inspects} calls, errors=${JSON.stringify(errors(req))}`,
    );
    check(`J1 pass ${i + 1}: every round in client-history mode`, r.usage.length > 0 && r.usage.every((u) => u.mode === "client_history"), JSON.stringify(r.usage.map((u) => u.mode)));
    check(`J1 pass ${i + 1}: images per request <= 50`, maxImages <= 50, `max images=${maxImages}, max frames omitted=${omitted}`);
    console.log(`  usage: ${r.usage.map((u) => `${u.cached}/${u.input}`).join(", ")}  answer: ${finalText(req).slice(0, 160).replace(/\n/g, " ")}`);
  }
  // Frames shown across the whole conversation, and what the transcript kept to re-send.
  const reqs = transcript(pid).requests ?? [];
  const shown = reqs.flatMap((q) => (q.response ?? []).filter((p) => p.kind === "tool_result")).reduce((n, p) => n + (p.frame_refs?.length ?? 0), 0);
  check("J1: the conversation showed more than 50 frames in total", shown > 50, `${shown} frames referenced in the transcript`);
}

async function j2(d, pid) {
  console.log("J2: Stop in the middle of a batch, then a new message (UJ-008/018)");
  const off = logSize();
  await say(d, "Put all six clips on the timeline one after another, then add a 0.5 second crossfade between each pair. Do it one tool call at a time.");
  // Stop as soon as the first result is in: a batch is in progress.
  const t0 = Date.now();
  for (;;) {
    const req = lastRequest(pid);
    if (kinds(req).includes("tool_result")) break;
    if (Date.now() - t0 > 180000) throw new Error("no tool ran");
    await sleep(500);
  }
  await d.eval(`(${STOP})?.click()`);
  await waitTurn(d);
  const stopped = lastRequest(pid);
  const calls = kinds(stopped).filter((k) => k === "tool_call").length;
  const results = kinds(stopped).filter((k) => k === "tool_result").length;
  console.log(`  stopped after ${calls} calls, ${results} results`);
  await say(d, "What were you in the middle of when I stopped you, and what did you already finish? Answer from memory in two short lines, without calling any tool.");
  await waitTurn(d);
  const next = lastRequest(pid);
  const r = rounds(logSince(off));
  check("J2: the message after Stop is answered, not refused", finalText(next) && errors(next).length === 0, `errors=${JSON.stringify(errors(next))}`);
  check(
    "J2: the agent remembers the request (mentions the timeline or the crossfades)",
    /crossfade|timeline|clip|transition/i.test(finalText(next)),
    finalText(next).slice(0, 200).replace(/\n/g, " "),
  );
  console.log(`  rounds: ${JSON.stringify(r.hist)}`);
}

// ── frames survive closing and reopening the project ────────────────────────────────────
function frameFiles(pid) {
  return (transcript(pid).requests ?? [])
    .flatMap((q) => q.response ?? [])
    .flatMap((p) => (p.kind === "tool_result" ? (p.frame_refs ?? []) : []))
    .map((f) => f.path);
}

async function j4(d, pid, name) {
  console.log("J4: frames the history showed survive a close and reopen");
  await say(d, "Inspect the library files clip1_red.mp4 and clip2_green.mp4 with inspect_media (media_ref = the file name), 3 frames each, then name each clip's colour in one line.");
  await waitTurn(d);
  const frames = frameFiles(pid);
  check("J4: the looks produced frames", frames.length >= 6 && frames.every((f) => existsSync(f)), `${frames.length} frames`);
  // An unreferenced file beside them proves the sweep really ran at close.
  const stale = path.join(projectDir(pid), "internals", "cache", "inspect", "qa_stale_unreferenced.jpg");
  writeFileSync(stale, "x");
  await d.clickText("File", "button");
  await d.clickText("Close Project", "button");
  await d.waitFor(`!location.pathname.startsWith('/p/')`, 30000);
  await sleep(3000);
  const kept = frames.filter((f) => existsSync(f)).length;
  check("J4: the close-time sweep ran (an unreferenced cache file is gone)", !existsSync(stale), stale);
  check("J4: every frame the history references survived the close", kept === frames.length, `${kept}/${frames.length} on disk`);
  // A full reload stands in for an app restart: everything the app learned in memory is gone,
  // including which models the server rebuilds history for.
  await d.eval(`location.href = '/'`);
  await sleep(5000);
  await d.waitFor(`[...document.querySelectorAll('button')].some(b => (b.innerText ?? '').trim() === 'File')`, 60000);
  // The start screen lists projects once it has read them from disk.
  await d.waitFor(`[...document.querySelectorAll('button')].some(b => (b.innerText ?? '').includes(${JSON.stringify(name)}))`, 60000);
  await d.clickText(name);
  await d.waitFor(`location.pathname === ${JSON.stringify(`/p/${pid}`)}`, 30000);
  await sleep(1500);
  await selectModel(d, MODEL);
  const off = logSize();
  await say(d, "Without calling any tool, look again at the frames you saw before: which clip was greener? One line.");
  await waitTurn(d);
  const next = lastRequest(pid);
  const r = rounds(logSince(off));
  // The FIRST round after the restart: the app does not know yet that this server rebuilds history.
  const h = r.hist[0] ?? {};
  check("J4: the first round after a restart re-sent the frames, none omitted", h.images >= frames.length && h.frames_omitted === 0, JSON.stringify(h));
  check("J4: answered without a refusal", finalText(next) && errors(next).length === 0, finalText(next).slice(0, 200).replace(/\n/g, " "));
}

// ── Stop while the model is thinking: the server must hang up on Azure (2026-10-03) ──────
async function j5(d, pid) {
  console.log("J5: Stop while the model is thinking hangs up on Azure, and the chat goes on");
  const off = logSize();
  await say(
    d,
    "Without calling any tool, think very carefully and work out how many positive integers below 10^7 have digits " +
      "that sum to 37 and are divisible by 11. Check every step twice, then answer with the number only.",
  );
  // Wait until the round is under way on the server, then give the model a few seconds to think.
  const t0 = Date.now();
  while (!logSince(off).some((l) => l.includes("client_history items="))) {
    if (Date.now() - t0 > 60000) throw new Error("the round never reached the server");
    await sleep(200);
  }
  await sleep(4000);
  const stoppedAt = Date.now();
  await d.eval(`(${STOP})?.click()`);
  let lines = [];
  for (;;) {
    lines = logSince(off);
    if (lines.some((l) => l.includes("round cancelled")) || Date.now() - stoppedAt > 20000) break;
    await sleep(200);
  }
  const cancelled = lines.find((l) => l.includes("round cancelled"));
  const usage = lines.filter((l) => l.includes("round usage"));
  check("J5: the server hung up on Azure after the Stop", Boolean(cancelled), cancelled ?? "no 'round cancelled' line within 20 s");
  check("J5: no usage was reported for the stopped round", usage.length === 0, usage.join(" | ") || "none");
  console.log(`  noticed ${((Date.now() - stoppedAt) / 1000).toFixed(1)} s after the Stop; stopped at ${new Date(stoppedAt).toISOString()}`);
  await waitTurn(d, 30000);
  await say(d, "What is 2 + 2? Answer with the number only.");
  await waitTurn(d);
  const next = lastRequest(pid);
  check("J5: the next message is answered normally", /4/.test(finalText(next)) && errors(next).length === 0, finalText(next).slice(0, 80));
}

// ── the server dies mid-turn (UJ-018) ────────────────────────────────────────────────────
const AKARU = path.resolve(import.meta.dirname, "../../../Akaru");
const SERVER_ENV = {
  ...process.env,
  AZURE_COSMOS_ENDPOINT: " ",
  AZURE_COSMOS_KEY: " ",
  ARTDADDY_AUTH_DISABLED: "1",
  HOST: "127.0.0.1",
  PORT: "8787",
  AKARU_LOG_LEVEL: process.env.AKARU_LOG_LEVEL ?? "DEBUG",
  CLERK_AUTHORIZED_PARTIES: "http://localhost:5173,http://tauri.localhost,tauri://localhost",
};
function killServer() {
  execFileSync("powershell", [
    "-NoProfile",
    "-Command",
    "Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }",
  ]);
}
async function startServer() {
  const { spawn } = await import("node:child_process");
  const { openSync } = await import("node:fs");
  const err = openSync(SERVER_LOG, "a");
  const out = openSync(path.join(os.tmpdir(), "qa_server_out.txt"), "a");
  const p = spawn(path.join(AKARU, ".venv", "Scripts", "python.exe"), ["-m", "src.akaru.server"], {
    cwd: AKARU,
    env: SERVER_ENV,
    detached: true,
    stdio: ["ignore", out, err],
    windowsHide: true,
  });
  p.unref();
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch("http://127.0.0.1:8787/auth/verify")).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  throw new Error("the server did not come back");
}

async function j3(d, pid) {
  console.log("J3: the server dies in the middle of a turn, then a new message (UJ-018)");
  await say(d, "Inspect clip1 and clip2 with inspect_media (4 frames each), then put both on the timeline one after the other.");
  const t0 = Date.now();
  for (;;) {
    if (kinds(lastRequest(pid)).includes("tool_result")) break;
    if (Date.now() - t0 > 180000) throw new Error("no tool ran");
    await sleep(300);
  }
  killServer();
  console.log("  killed the server after the first result");
  await waitTurn(d, 120000);
  const died = lastRequest(pid);
  console.log(`  the turn ended with: ${JSON.stringify(errors(died)).slice(0, 200)}`);
  await startServer();
  const off = logSize();
  await say(d, "The server restarted. Without calling any tool: what did I ask you to do in my previous message, and what had you already done? Two short lines.");
  await waitTurn(d);
  const next = lastRequest(pid);
  const r = rounds(logSince(off));
  check("J3: the message after the restart is answered, not refused", finalText(next) && errors(next).length === 0, `errors=${JSON.stringify(errors(next))}`);
  check("J3: it ran in client-history mode", r.usage.length > 0 && r.usage.every((u) => u.mode === "client_history"), JSON.stringify(r.usage.map((u) => u.mode)));
  check(
    "J3: the agent remembers the request (clip1/clip2, inspecting, the timeline)",
    /clip ?1|clip ?2|inspect|timeline/i.test(finalText(next)),
    finalText(next).slice(0, 240).replace(/\n/g, " "),
  );
  console.log(`  rounds: ${JSON.stringify(r.hist)}`);
}

// ── main ─────────────────────────────────────────────────────────────────────────────────
const d = await open();
if (process.argv.includes("--reload")) {
  // Code changed since the dev app loaded: start from a full reload, not a hot-patched graph.
  await d.eval(`location.href = '/'`);
  await sleep(5000);
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const name = `qa-phase1-${stamp}`;
const pid = await newProject(d, name, "16:9");
console.log(`project ${pid}, model ${MODEL}`);
await importMedia(d, pid, fixtures());
await selectModel(d, MODEL);
if (!only || only === "J1") await j1(d, pid);
if (!only || only === "J2") await j2(d, pid);
if (!only || only === "J3") await j3(d, pid);
if (!only || only === "J4") await j4(d, pid, name);
if (!only || only === "J5") await j5(d, pid);
writeFileSync(path.join(OUT, `chatHistory-${stamp}.json`), JSON.stringify({ pid, model: MODEL, report }, null, 2));
const failed = report.filter((r) => !r.ok).length;
console.log(`\n${report.length - failed}/${report.length} checks passed`);
d.close();
process.exit(failed ? 1 : 0);
