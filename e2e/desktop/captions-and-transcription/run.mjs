// Captions in the REAL app with the REAL speech engine and the speech model already on this PC: a person
// imports a spoken clip (the app transcribes it in the background), puts it on the timeline, and an assistant
// over MCP asks for captions and for the words. Judged on the transcript the app kept, the captions it SAVED
// (internals/timeline.json) and the words it answered, with every wait timed.
//
//   node --experimental-websocket e2e/desktop/captions-and-transcription/run.mjs
//
// Not a `*.desktop.mjs` on purpose: it needs the speech model on the PC and a free MCP port, so it is run when
// asked for, not by the nightly timing run or CI (scripts/qa/timingBudgets.mjs runs every timed `*.desktop.mjs`).
//
// One real-app run at a time on a shared PC: run it inside the PC's real-app slot or lock, never beside another
// ArtDaddy (it refuses to start while one runs).
//
// What it needs and does:
// - Windows, this worktree's node_modules and generated Tauri folders (src-tauri/binaries: ffmpeg, ffprobe,
//   whisper-cli; src-tauri/resources/whisper). The shell is built from this worktree under the export lane's own
//   identity (../export/app.mjs: never the installed app's), and the page talks to that lane's stand-in server
//   (../export/backend.mjs), which answers the build check and refuses everything else: no model, no vendor.
// - The speech model must already be in the app's data folder (%APPDATA%\ArtDaddy\models). The run never
//   downloads it and never changes it: a missing model is reported "not run". The first download is the by-hand
//   script e2e/byhand/captions-and-transcription/first-run.md.
// - MCP: only when the port is free, so that THIS app holds it (no other program's tools are ever called). Only
//   local tools (add_captions, get_transcript and the free looks); a paid tool is refused before anything is sent.
//   With the port held by another program the MCP scenarios are reported "not run"; the background
//   transcription still runs.
// - Projects are named `sweep_qa-export captions …`; at the end the open one is closed and every project of
//   this lane is removed through the app.
//
// Output: reports/qa/captions/run-<stamp>/report.json (checks, known bugs, times, the build), and one timing line
// per wait (e2e/lib/timing.mjs). Exit code 1 when a check failed that is not a known bug.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { record } from "../../lib/timing.mjs";
import { App, buildShell, IDENTIFIER, otherAppsRunning, root, startPage } from "../export/app.mjs";
import { startBackend } from "../export/backend.mjs";
import {
  importFiles,
  newProject,
  openMenu,
  removeProjects,
  savedTimeline,
  sleep,
} from "../export/journey.mjs";

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const runDir = path.join(root, "reports", "qa", "captions", `run-${stamp}`);
mkdirSync(runDir, { recursive: true });
const CLIP = path.join(root, "e2e/ui/captions-and-transcription/fixtures/media/spoken_scenes.mp4");
const WORDS = JSON.parse(
  readFileSync(path.join(root, "src/tools/__fixtures__/speech/spoken.words.json"), "utf8"),
);
const MODEL = path.join(process.env.APPDATA ?? "", "ArtDaddy", "models", "ggml-small.bin");
const CACHE = path.join(process.env.LOCALAPPDATA ?? "", IDENTIFIER, "cache", "transcripts");

const report = {
  lane: "e2e/desktop/captions-and-transcription",
  started: new Date().toISOString(),
  build: {},
  checks: [],
  knownBugs: [],
  notRun: [],
  times: {},
};
/** A check. With `bug`, a failure is that known bug still being there: reported, not a failed run. */
const check = (name, ok, detail = "", bug = null) => {
  report.checks.push({ name, ok: !!ok, detail, ...(bug ? { bug } : {}) });
  if (!ok && bug) report.knownBugs.push({ bug, name, detail });
  console.log(
    `${ok ? "PASS" : bug ? "KNOWN BUG" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}${!ok && bug ? ` (${bug})` : ""}`,
  );
};
const time = (scenario, ms) => {
  report.times[scenario] = ms;
  record(scenario, ms);
};
const git = (...a) => spawnSync("git", ["-C", root, ...a], { encoding: "utf8" }).stdout.trim();
const said = (text) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
const captionText = (c) =>
  Array.isArray(c.content) ? c.content.map((x) => x.text).join(" ") : String(c.content ?? "");

function mcpPortHolder() {
  const r = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "(Get-NetTCPConnection -LocalPort 19787 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess",
    ],
    { encoding: "utf8" },
  );
  const pid = Number(r.stdout.trim());
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/** Of the script's words, how many the captions hold in order (a longest common subsequence). */
function inOrder(expected, got) {
  const dp = Array.from({ length: expected.length + 1 }, () => new Array(got.length + 1).fill(0));
  for (let i = 1; i <= expected.length; i++)
    for (let j = 1; j <= got.length; j++)
      dp[i][j] =
        expected[i - 1] === got[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return dp[expected.length][got.length];
}

/** For each caption, how far its start is from when its first word is said (seconds; + is late). */
function offsets(captions, fps) {
  const out = [];
  let at = 0;
  for (const c of captions) {
    const first = said(captionText(c))[0];
    const i = WORDS.words.findIndex((w, k) => k >= at && w.word.toLowerCase() === first);
    if (i < 0) continue;
    out.push(Number((c.timeline_in / fps - WORDS.words[i].start).toFixed(2)));
    at = i + 1;
  }
  return out;
}

function transcriptsNow() {
  if (!existsSync(CACHE)) return new Map();
  return new Map(readdirSync(CACHE).map((n) => [n, statSync(path.join(CACHE, n)).mtimeMs]));
}

/** The captions of `group` once the app has saved them (it saves a moment after it answers). */
async function savedCaptions(project, group) {
  let found = [];
  for (const end = Date.now() + 15_000; Date.now() < end; await sleep(250)) {
    found = (savedTimeline(project)?.tracks ?? [])
      .flatMap((t) => t.clips ?? [])
      .filter((c) => c.caption_group && (!group || c.caption_group === group))
      .sort((a, b) => a.timeline_in - b.timeline_in);
    if (found.length) break;
  }
  return found;
}

/** An outside assistant on the app's MCP door (port 19787), as ../export/mcp.mjs, but keeping the whole answer:
 *  the JSON and every picture. Only local tools: a paid one is refused before anything is sent. */
async function mcpSession() {
  const URL_MCP = "http://127.0.0.1:19787/mcp";
  const PAID = /^(generate_|video_ask$|video_find_moment$|web_search$)/;
  let id = 0;
  let session = null;
  async function rpc(method, params) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (session) headers["mcp-session-id"] = session;
    const res = await fetch(URL_MCP, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    session = res.headers.get("mcp-session-id") ?? session;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "qa-captions", version: "1" },
  });
  return {
    async call(name, args = {}) {
      if (PAID.test(name)) throw new Error(`refusing a paid tool: ${name}`);
      const out = await rpc("tools/call", { name, arguments: args });
      const content = out?.result?.content ?? [];
      const text = content.find((c) => c.type === "text")?.text ?? "";
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text, error: out?.error };
      }
      return { json, images: content.filter((c) => c.type === "image").map((c) => c.data) };
    },
  };
}

/** A picture's mean colour, decoded by the shipped ffmpeg. */
function meanColour(ffmpeg, picture) {
  const r = spawnSync(
    ffmpeg,
    [
      "-v",
      "error",
      "-i",
      "pipe:0",
      "-vf",
      "scale=1:1:flags=area",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    {
      input: picture,
      maxBuffer: 1 << 20,
    },
  );
  return r.status === 0 && r.stdout.length >= 3
    ? [r.stdout[0], r.stdout[1], r.stdout[2]]
    : [0, 0, 0];
}

function colourName([r, g, b]) {
  if (Math.max(r, g, b) - Math.min(r, g, b) < 24) return "grey";
  if (r >= g && r >= b) return "red";
  return g >= b ? "green" : "blue";
}

async function main() {
  const modelVars = Object.keys(process.env).filter((k) => /AZURE|GOOGLE|OPENAI|VERTEX/i.test(k));
  if (modelVars.length)
    throw new Error(`refusing to run with model variables set: ${modelVars.join(", ")}`);
  if (process.platform !== "win32") throw new Error("this lane drives the Windows app");
  const others = otherAppsRunning();
  if (others.length)
    throw new Error(
      `another ArtDaddy is running (${others.map((o) => o.pid).join(", ")}): this run waits for it to close`,
    );
  if (!existsSync(MODEL)) {
    report.notRun.push(
      "the speech model is not in the app's data folder: this run never downloads it",
    );
    return;
  }
  report.model = { file: path.basename(MODEL), bytes: statSync(MODEL).size };
  report.build = {
    worktree: root,
    head: git("rev-parse", "HEAD"),
    clean: git("status", "--short", "--untracked-files=no") === "",
  };

  const shell = buildShell(path.join(runDir, "cargo.log"));
  report.build.exe = shell.exe;
  report.build.builtAt = shell.builtAt;
  report.times["cargo build (not a user wait)"] = shell.ms;
  const backend = await startBackend();
  const page = await startPage(backend.url);
  const app = new App(runDir);
  let project = null;
  try {
    const { d, ms } = await app.launch("first start");
    time("captions: app start to the menu bar (dev build)", ms);
    report.build.pid = app.pid;
    report.build.commandLine = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${app.pid}").CommandLine`,
      ],
      { encoding: "utf8" },
    ).stdout.trim();
    report.build.version = await d.eval(
      "window.__TAURI_INTERNALS__.invoke('plugin:app|version').then(String, (e) => 'unknown: ' + String(e))",
    );
    project = await newProject(d, "captions first-run");

    // ── a person imports a spoken clip: the app transcribes it in the background ──
    // A copy with this run's stamp in its metadata: its own identity, so no transcript an earlier run kept
    // answers for it, and this run times a real transcription.
    const copy = path.join(runDir, "spoken_scenes.mp4");
    const ffmpeg = ["artdaddy-ffmpeg", "ffmpeg"]
      .map((n) => path.join(root, "src-tauri", "binaries", `${n}-x86_64-pc-windows-msvc.exe`))
      .find((p) => existsSync(p));
    if (!ffmpeg) throw new Error("the shipped ffmpeg is not staged in src-tauri/binaries");
    const stamped = spawnSync(ffmpeg, [
      "-y",
      "-v",
      "error",
      "-i",
      CLIP,
      "-c",
      "copy",
      "-metadata",
      `comment=qa ${stamp}`,
      copy,
    ]);
    if (stamped.status !== 0) copyFileSync(CLIP, copy);
    const before = transcriptsNow();
    const t0 = Date.now();
    const lib = await importFiles(d, project, [copy]);
    const entry = lib["spoken_scenes.mp4"];
    check("the clip reached the library", !!entry);
    let kept = null;
    for (const end = Date.now() + 600_000; Date.now() < end && !kept; await sleep(500)) {
      for (const [name, mtime] of transcriptsNow())
        if (!before.has(name) || before.get(name) !== mtime) kept = name;
    }
    check("the background transcription kept a transcript", !!kept, kept ?? "none within 10 min");
    if (kept)
      time(
        "captions: import a 12 s spoken clip to its transcript kept, real engine (dev build)",
        Date.now() - t0,
      );
    const failure = await d.eval(
      "document.querySelector('[data-testid=speech-failure]')?.innerText ?? ''",
    );
    check("no transcription failure in the status bar", !failure, failure);

    // ── the clip on the timeline, with the editor's own addClip (setup, not the thing under test) ──
    const videoTrack = (savedTimeline(project)?.tracks ?? []).find((t) => t.kind === "video")?.id;
    const r = await d.eval(
      `window.__artdaddyTest.editor.getState().addClip(${JSON.stringify(entry.path)}, ${JSON.stringify(videoTrack)}, 0).then(() => 'ok', (e) => 'threw: ' + String(e))`,
    );
    check("the clip was placed", r === "ok", r);
    for (const end = Date.now() + 20_000; Date.now() < end; await sleep(200))
      if (
        (savedTimeline(project)?.tracks ?? []).some(
          (t) => t.kind === "audio" && (t.clips ?? []).length,
        )
      )
        break;

    // ── an assistant over MCP asks for captions and for the words ──
    await sleep(1500);
    const holder = mcpPortHolder();
    if (holder !== app.pid) {
      report.notRun.push(
        `MCP scenarios: port 19787 is held by ${holder ?? "nobody"}, not this app (${app.pid})`,
      );
    } else {
      const mcp = await mcpSession();
      const fps = Number(savedTimeline(project)?.canvas?.fps) || 30;
      // As a person usually asks: no language named. The background already transcribed the clip.
      const c0 = Date.now();
      const made = (await mcp.call("add_captions", {})).json;
      const tAuto = Date.now() - c0;
      time(
        "captions: add_captions over MCP, clip already transcribed in the background (dev build)",
        tAuto,
      );
      check("add_captions answered ok", made?.ok !== false, JSON.stringify(made).slice(0, 300));
      const captions = await savedCaptions(project, made?.caption_group);
      const text = captions.map(captionText).join(" ");
      const script = said(WORDS.text);
      const hit = inOrder(script, said(text));
      check(
        "the captions hold at least 85% of the spoken words, in order",
        hit >= Math.ceil(0.85 * script.length),
        `${hit} of ${script.length}: "${text}"`,
      );
      const off = offsets(captions, fps);
      check(
        "every caption starts within 2.5 s of its first word",
        off.length > 0 && off.every((s) => Math.abs(s) <= 2.5),
        JSON.stringify(off),
      );
      check(
        "captions of a clip the background already transcribed come at once (under 5 s)",
        tAuto < 5000,
        `${tAuto} ms`,
      );
      // The same, naming the language the background heard (English), on a track of their own.
      const c1 = Date.now();
      const madeEn = (
        await mcp.call("add_captions", { language: "en", text_track_id: "captions_en" })
      ).json;
      const tEn = Date.now() - c1;
      time(
        "captions: add_captions over MCP naming English, clip already transcribed in the background (dev build)",
        tEn,
      );
      check(
        "add_captions naming English answered ok",
        madeEn?.ok !== false,
        JSON.stringify(madeEn).slice(0, 300),
      );
      check(
        "naming the language the background heard also answers at once (under 5 s)",
        tEn < 5000,
        `${tEn} ms`,
        "Captions asked for in a named language transcribe the clip again although the background already transcribed it",
      );
      const t1 = Date.now();
      const tr = (await mcp.call("get_transcript", {})).json;
      time(
        "captions: get_transcript over MCP, transcript already kept (dev build)",
        Date.now() - t1,
      );
      const rows = (tr?.clips ?? []).flatMap((c) => c.words ?? []);
      check(
        "get_transcript answers the words in project frames",
        tr?.timing === "project_frames" && rows.length >= 15,
        `${rows.length} words`,
      );
      writeFileSync(
        path.join(runDir, "captions.json"),
        JSON.stringify({ made, madeEn, captions, transcript: tr }, null, 2),
      );

      // ── the free looks, as an outside assistant uses them: what it is shown, and how long it waits ──
      const video = (savedTimeline(project)?.tracks ?? [])
        .filter((t) => t.kind === "video")
        .flatMap((t) => t.clips ?? [])[0];
      const looks = [
        [
          "inspect_media",
          { clip_id: video?.id, max_frames: 6 },
          ["red", "green", "blue"],
          "inspect_media sends the assistant grey frames of a colour video",
        ],
        ["inspect_timeline", { start_frame: Math.round(6 * fps) }, ["green"], null],
        ["inspect_color", { clip_id: video?.id, at_frame: Math.round(2 * fps) }, ["red"], null],
      ];
      for (const [tool, args, colours, bug] of looks) {
        const l0 = Date.now();
        const out = await mcp.call(tool, args);
        time(`vision: ${tool} over MCP, 12 s clip (dev build)`, Date.now() - l0);
        check(
          `${tool} answered ok`,
          out.json?.ok !== false,
          JSON.stringify(out.json).slice(0, 200),
        );
        const seen = out.images.map((b64) =>
          colourName(meanColour(ffmpeg, Buffer.from(b64, "base64"))),
        );
        check(`${tool} sent pictures`, seen.length > 0, `${seen.length}`);
        check(
          `${tool}: the pictures show ${colours.join(", ")}`,
          colours.every((c) => seen.includes(c)),
          `seen: ${seen.join(", ")}`,
          bug,
        );
      }
    }
  } finally {
    if (app.d) {
      // An open project cannot be removed: close it first, then remove every project this lane left.
      try {
        await app.d.key("Escape");
        if (await app.d.eval("location.pathname.startsWith('/p/')")) {
          await openMenu(app.d, "File", "Close Project");
          await app.d.waitFor("!location.pathname.startsWith('/p/')", 20_000).catch(() => {});
        }
        const mine =
          (await app.d
            .eval(
              `import('/src/store/projects.ts').then(async ({ useProjects }) => {
            await useProjects.getState().refresh();
            return useProjects.getState().projects.map((p) => p.id).filter((id) => /^sweep_qa_export_captions/.test(id));
          }, () => [])`,
            )
            .catch(() => [])) ?? [];
        report.projectsRemoved = await removeProjects(app.d, mine);
      } catch (e) {
        report.cleanupError = String(e?.message ?? e);
      }
    }
    await app.stop();
    await page.close();
    await backend.close();
    report.standIn = backend.seen;
  }
}

main()
  .catch((e) => {
    report.error = String(e?.stack ?? e);
    console.error(e);
  })
  .finally(() => {
    report.ended = new Date().toISOString();
    writeFileSync(path.join(runDir, "report.json"), JSON.stringify(report, null, 2));
    console.log(`report: ${path.join(runDir, "report.json")}`);
    const failed = report.error || report.checks.some((c) => !c.ok && !c.bug);
    process.exit(failed ? 1 : 0);
  });
