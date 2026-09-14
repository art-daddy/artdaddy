// Exercise EVERY tool over MCP and report what actually works.
//
// "The tool is listed" is not "the tool works" — discovery only proves the catalog. This drives
// each one against a real project in dependency order (project -> media -> clips -> edits) and
// records the tool's own ok/error, so a broken tool shows up as a failing row rather than as a
// surprise the first time an external agent reaches for it.
//
//   node e2e/desktop/mcpAllTools.desktop.mjs
import { existsSync, mkdirSync, copyFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { appBinary, newSession, projectsRoot, sleep, startDriver, waitFor } from "./webdriver.mjs";

const URL = "http://127.0.0.1:19787/mcp";
const PROJECTS = projectsRoot();
const MEDIA_DIR = path.join(process.cwd(), "..", "_artdaddy-alltools");
const VIDEO = path.join(MEDIA_DIR, "clip.mp4");
const IMAGE = path.join(MEDIA_DIR, "still.png");
const SUBS = path.join(MEDIA_DIR, "cues.srt");
const NAME = `alltools${Date.now().toString().slice(-5)}`;

// Spend the signed-in user's credits through our proxy. Never called unattended.
const CREDIT_TOOLS = new Set([
  "generate_image",
  "generate_video",
  "generate_voiceover",
  "generate_music",
  "video_ask",
  "video_find_moment",
  "image_ask",
  "vision_describe",
  "find_content",
  "extract_style",
]);
// Free, but too slow or too heavy to belong in a sweep.
const HEAVY = new Map([
  ["get_transcript", "downloads a ~465 MB whisper model on first use"],
  ["download_video", "pulls a real video off the internet"],
]);

const results = [];
const record = (name, status, detail = "") => {
  results.push({ name, status, detail: String(detail).replace(/\s+/g, " ").slice(0, 110) });
  const mark = { ok: "ok  ", fail: "FAIL", skip: "skip" }[status];
  console.log(`  ${mark} ${name.padEnd(22)} ${results.at(-1).detail}`);
};

let rpcId = 0;
let sessionId = null;
async function rpc(method, params) {
  const headers = { "content-type": "application/json" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const assigned = res.headers.get("mcp-session-id");
  if (assigned) sessionId = assigned;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** Call a tool and classify the outcome from the tool's OWN result, not just transport success. */
async function call(name, args = {}) {
  const out = await rpc("tools/call", { name, arguments: args });
  const block = out?.result?.content?.[0]?.text ?? "";
  let payload;
  try {
    payload = JSON.parse(block);
  } catch {
    payload = block;
  }
  const failed =
    out?.result?.isError === true ||
    (payload && typeof payload === "object" && payload.ok === false);
  return { failed, payload, error: payload?.error ?? (failed ? String(block).slice(0, 120) : "") };
}

async function step(name, args, pick) {
  if (CREDIT_TOOLS.has(name)) return record(name, "skip", "spends credits — not run unattended");
  if (HEAVY.has(name)) return record(name, "skip", HEAVY.get(name));
  try {
    const r = await call(name, typeof args === "function" ? args() : args);
    if (r.failed) record(name, "fail", r.error);
    else record(name, "ok", pick ? pick(r.payload) : summarise(r.payload));
    return r.payload;
  } catch (e) {
    record(name, "fail", e.message);
    return null;
  }
}

const summarise = (p) => {
  if (p == null) return "";
  if (typeof p === "string") return p.slice(0, 80);
  const keys = ["count", "clip_id", "media_ref", "saved_to", "path", "id", "op", "ok"];
  const hit = keys.filter((k) => p[k] !== undefined).map((k) => `${k}=${JSON.stringify(p[k])}`);
  return hit.length ? hit.join(" ") : Object.keys(p).slice(0, 4).join(",");
};

mkdirSync(MEDIA_DIR, { recursive: true });
copyFileSync(path.join(process.cwd(), "public", "test-clip.mp4"), VIDEO);
copyFileSync(path.join(process.cwd(), "public", "parity-fg.png"), IMAGE);
writeFileSync(
  SUBS,
  "1\n00:00:00,000 --> 00:00:01,000\nfirst cue\n\n2\n00:00:01,500 --> 00:00:02,500\nsecond cue\n",
);

// ATTACH mode: drive an app that is ALREADY running instead of launching one. The driver stack
// (tauri-driver + msedgedriver) is Windows-only, but everything below the bootstrap is plain
// HTTP on loopback — so on macOS/Linux the sweep still runs against a real app the user started.
const ATTACH = process.env.ARTDADDY_MCP_ATTACH === "1" || process.platform !== "win32";

const driver = ATTACH ? null : await startDriver();
let s;
try {
  if (!ATTACH) {
    s = await newSession(appBinary());
    await waitFor(
      () =>
        s.exec(
          "return [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'File');",
        ),
      { label: "the app to boot" },
    );
  }
  await waitFor(async () => !!(await rpc("ping", {})), { label: "the MCP port" });
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "sweep", version: "1" },
  });

  const listed = (await rpc("tools/list", {}))?.result?.tools ?? [];
  console.log(`\n${listed.length} tools advertised\n`);

  // ---- projects ----
  await step("manage_project", { action: "list" });
  const made = await step("manage_project", { action: "create", name: NAME });
  const projectId = made?.created;
  const projectDir = path.join(PROJECTS, projectId);
  await step("list_projects", {});
  await step("get_project_state", {});
  await step("set_project_settings", { fps: 30 });
  await step("rename_project", { name: `${NAME}-renamed` });
  await step("new_project", { name: `${NAME}-second` });
  await step("open_project", { project: projectId });
  await step("duplicate_project", {});
  await step("open_project", { project: projectId });

  // ---- media ----
  const vid = await step("import_media", { source: { path: VIDEO } });
  const img = await step("import_media", { source: { path: IMAGE } });
  const videoRef = vid?.media_ref;
  const imageRef = img?.media_ref;
  await step("probe_media", { media_ref: videoRef });
  await step("inspect_media", { media_ref: videoRef });
  await step("library_op", { action: "list" });
  await step("clip_video", { media_ref: videoRef, start_s: 0, end_s: 1, output_name: "sub.mp4" });
  await step("crop_image", { media_ref: imageRef, bbox: { x: 0, y: 0, w: 50, h: 50 } });
  await step("run_ffmpeg", {
    inputs: [videoRef],
    args: ["-i", "{in0}", "-t", "1", "-c", "copy", "{out}"],
    output_name: "ff.mp4",
  });

  // ---- tracks ----
  await step("add_track", { kind: "video" });
  await step("set_track", { track_id: "v1", mute: false });
  await step("set_tracks", { tracks: [{ track_id: "v1", mute: false }] });

  // ---- clips ----
  const added = await step("add_clips", {
    entries: [
      { media_ref: videoRef, track_id: "v1", timeline_in: 0, source_span: [0, 1] },
      { media_ref: videoRef, track_id: "v1", timeline_in: 30, source_span: [0, 1] },
    ],
  });
  const clipIds = (added?.created ?? []).map((c) => c.clip_id);
  await step("get_timeline", {});
  await step("inspect_timeline", {});
  await step("insert_clips", {
    at: 60,
    entries: [{ media_ref: videoRef, track_id: "v1", source_span: [0, 1] }],
  });
  const titles = await step("add_text_clips", {
    entries: [{ content: "hello", timeline_in: 0, timeline_out: 30 }],
  });
  const titleId = titles?.created?.[0]?.clip_id;
  await step("update_text", { clip_ids: [titleId], content: "hello again", style: { size: "l" } });
  // The SRT door into add_captions: same tool, but no 465 MB whisper model to download.
  const sub = await step("import_media", { source: { path: SUBS } });
  await step("add_captions", { subtitle_media_ref: sub?.media_ref });
  await step("set_clip_properties", { clip_ids: [clipIds[0]], opacity: 0.8 });
  await step("set_keyframes", {
    clip_id: clipIds[0],
    property: "opacity",
    keyframes: [
      { t: 0, v: 0 },
      { t: 29, v: 1 },
    ],
  });
  await step("set_transition", {
    clip_id: clipIds[1],
    transition_in: { kind: "crossfade", duration: 10 },
  });
  await step("apply_color", { clip_ids: [clipIds[0]], saturation: 0.9 });
  await step("apply_effects", {
    clip_ids: [clipIds[0]],
    add: [{ type: "blur", params: { radius: 2 } }],
  });
  await step("link_clips", { clip_ids: clipIds.slice(0, 2) });
  await step("unlink_clips", { clip_ids: clipIds.slice(0, 2) });
  await step("move_clips", { moves: [{ clip_id: clipIds[1], to_timeline_in: 40 }] });
  await step("split_clips", { splits: [{ clip_id: clipIds[0], at: 15 }] });
  await step("inspect_color", { media_ref: imageRef });
  await step("ripple_delete", { track_id: "v1", ranges: [{ start: 0, end: 5 }] });
  await step("remove_clips", { clip_ids: [clipIds[1]] });
  await step("undo", {});
  await step("redo", {});
  const spare = await step("add_track", { kind: "video" });
  await step("remove_tracks", { track_ids: [spare?.track_id ?? spare?.created?.track_id ?? "v3"] });

  // ---- deliverables + misc ----
  await step("export", { format: "mp4", resolution: "720p" });
  await step("manage_exports", { action: "list" });
  await step("pack_project", {});
  await step("read_file", { path_or_key: "internals/timeline.json" });
  await step("list_models", {});

  // ---- network / server-backed ----
  await step("web_search", { query: "video editing" });
  await step("youtube_search", { query: "b-roll" });
  await step("get_page", { url: "https://example.com" });
  await step("video_get_metadata", { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
  await step("get_page_image", { url: "https://example.com" });

  // ---- credit tools: recorded as skipped so the report covers all 59 ----
  for (const t of CREDIT_TOOLS) record(t, "skip", "spends credits — not run unattended");
  for (const [t, why] of HEAVY) if (!results.some((r) => r.name === t)) record(t, "skip", why);

  // ---- coverage: every advertised tool must appear in the report ----
  const seen = new Set(results.map((r) => r.name));
  const missed = listed.map((t) => t.name).filter((n) => !seen.has(n));
  console.log(`\n--- summary ---`);
  const ok = results.filter((r) => r.status === "ok").length;
  const fail = results.filter((r) => r.status === "fail");
  const skip = results.filter((r) => r.status === "skip").length;
  console.log(
    `ok ${ok} | failed ${fail.length} | skipped ${skip} | advertised ${listed.length} | never exercised ${missed.length}`,
  );
  if (missed.length) console.log(`never exercised: ${missed.join(", ")}`);
  if (fail.length) {
    console.log(`\nfailures:`);
    for (const f of fail) console.log(`  ${f.name}: ${f.detail}`);
  }
  // A sweep that prints its problems and exits 0 is a report nobody is obliged to read. An
  // unexercised tool counts: the whole point is that a tool added later cannot quietly ship
  // untried, which is exactly how add_captions and update_text sat unrun.
  if (fail.length || missed.length) process.exitCode = 1;
} catch (e) {
  console.error("ERROR:", e.message);
  process.exitCode = 1;
} finally {
  await s?.quit();
  driver?.kill();
  await sleep(600);
  for (const d of readdirSync(PROJECTS).filter((n) => n.startsWith("alltools"))) {
    try {
      rmSync(path.join(PROJECTS, d), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  rmSync(MEDIA_DIR, { recursive: true, force: true });
  // USERPROFILE is Windows-only; on macOS/Linux it is undefined and the join threw, so the sweep
  // crashed in teardown and left its export artifacts behind in Downloads.
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const downloads = path.join(home, "Downloads");
  for (const f of (existsSync(downloads) ? readdirSync(downloads) : []).filter((n) =>
    n.startsWith("alltools"),
  )) {
    try {
      rmSync(path.join(downloads, f), { force: true });
    } catch {
      /* best effort */
    }
  }
}
