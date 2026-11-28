// The media and preview lane: what a person does with media and the preview in the REAL app, where the browser
// lane cannot reach: the native Open dialog of the library's + button and of Relink, and real playback in WebView2
// on this PC's graphics chip. Judged on the screen (the stage's pixels, read from a screenshot of the page) and on
// the saved project, with the waits a person feels timed.
//
//   node --experimental-websocket e2e/desktop/media-library/run.mjs
//
// It reuses the export lane's app (../export/app.mjs: the shell built from THIS worktree under the QA identity
// `com.artdaddy.qa.export`, its own link scheme, its web view's storage in the run folder, the page served by Vite),
// its stand-in server (../export/backend.mjs: answers the build check, refuses everything else, so nothing can reach a
// model or a vendor) and its native-dialog hands (../export/nativeDialog.ps1: UI Automation and window messages, no
// mouse, no keyboard, no focus change). Nothing here moves the PC's mouse: the page is driven over CDP. The drop
// from Explorer (a real OLE drag, which does move the mouse) stays with e2e/desktop/osdrop*.desktop.mjs and the
// by-hand script e2e/byhand/media-library/drop-and-relink.md.
//
// Run it inside the real-app slot (python <wiki>/scripts/dispatch.py slot real-app --item <item> -- <this command>).
// Projects are named `sweep_qa-media …` (the app shares the PC's projects folder) and removed through the app at the
// end; the footage is copied into the run folder and moved there, never anywhere else.
//
// Output: reports/qa/media/run-<stamp>/ (report.json with every check and time, the stage screenshots). Exit code 1
// when a check failed.
import { spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import { record } from "../../lib/timing.mjs";
import { App, buildShell, IDENTIFIER, otherAppsRunning, root, startPage } from "../export/app.mjs";
import { startBackend } from "../export/backend.mjs";
import { nativeDialog, openMenu, removeProjects, sleep } from "../export/journey.mjs";
import { projectsRoot } from "../webdriver.mjs";

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const runDir = path.join(root, "reports", "qa", "media", `run-${stamp}`);
const footage = path.join(runDir, "footage");
mkdirSync(footage, { recursive: true });
const FIXTURES = path.join(root, "e2e", "ui", "media-library", "fixtures", "media");
const PROJECT = "sweep_qa-media library";

const report = {
  lane: "e2e/desktop/media-library",
  started: new Date().toISOString(),
  build: {},
  checks: [],
  times: [],
};
let failed = 0;

function check(label, ok, detail = "") {
  report.checks.push({ label, ok: !!ok, detail: String(detail ?? "") });
  if (!ok) failed += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail !== "" ? ` — ${detail}` : ""}`);
  return !!ok;
}

function time(scenario, ms) {
  report.times.push({ scenario, ms: Math.round(ms) });
  record(scenario, ms);
  console.log(`  time ${scenario}: ${(ms / 1000).toFixed(2)} s`);
}

const git = (...args) =>
  spawnSync("git", ["-C", root, ...args], { encoding: "utf8" }).stdout.trim();

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

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
const projectDir = (id) => path.join(projectsRoot(), id);
const rows = (id) =>
  readJson(path.join(projectDir(id), "internals", "library.json"), { clips: [] }).clips ?? [];

function ffmpeg() {
  const exe = path.join(root, "src-tauri", "binaries", "ffmpeg-x86_64-pc-windows-msvc.exe");
  if (!existsSync(exe)) throw new Error("no staged ffmpeg in src-tauri/binaries");
  return exe;
}

/** The mean colour of the middle fifth of a PNG, decoded by the shipped ffmpeg. */
function meanColour(png) {
  const r = spawnSync(
    ffmpeg(),
    [
      "-v",
      "error",
      "-i",
      png,
      "-vf",
      "crop=iw/5:ih/5,scale=1:1:flags=area",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { maxBuffer: 1024 },
  );
  if (r.status !== 0 || r.stdout.length < 3) throw new Error(`could not read ${png}: ${r.stderr}`);
  return [r.stdout[0], r.stdout[1], r.stdout[2]];
}

function colourName([r, g, b]) {
  if (r < 40 && g < 40 && b < 40) return "black";
  if (r > 150 && g < 90 && b < 90) return "red";
  if (g > 150 && r < 90 && b < 90) return "green";
  if (b > 150 && r < 90 && g < 90) return "blue";
  return `other(${r},${g},${b})`;
}
/** The fixture's colour at `t` seconds: red, green, blue, one second each. */
const colourAt = (t) => (t < 1 ? "red" : t < 2 ? "green" : t < 3 ? "blue" : "black");

/** A copy of the MP4 `src` at `dst`, made `total` bytes long by a `free` box after it: every MP4 reader skips such a
 *  box, so the file still plays, but the app reads all of it to identify it. Written in chunks. Returns its size. */
function withFreeBox(src, dst, total) {
  copyFileSync(src, dst);
  const pad = total - statSync(dst).size;
  const head = Buffer.alloc(8);
  head.writeUInt32BE(pad, 0);
  head.write("free", 4, "ascii");
  const fd = openSync(dst, "a");
  try {
    writeSync(fd, head);
    const chunk = Buffer.alloc(64 * 1024 * 1024);
    for (let left = pad - 8; left > 0; left -= chunk.length)
      writeSync(fd, chunk, 0, Math.min(chunk.length, left));
  } finally {
    closeSync(fd);
  }
  return statSync(dst).size;
}

let shots = 0;
/** What the stage shows now: the colour of the middle of its canvas, from a screenshot of the page. */
async function stageColour(d) {
  const box =
    await d.eval(`(() => { const tabs = document.querySelector('[aria-label="preview tabs"]');
    const c = tabs && tabs.parentElement.querySelector('canvas'); if (!c) return null; const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  if (!box || box.width < 4) return "no canvas";
  const { data } = await d.cdp.send("Page.captureScreenshot", {
    format: "png",
    clip: { ...box, scale: 1 },
  });
  const file = path.join(runDir, `stage-${String(++shots).padStart(3, "0")}.png`);
  writeFileSync(file, Buffer.from(data, "base64"));
  return colourName(meanColour(file));
}

async function waitStage(d, colour, ms = 30_000) {
  const end = Date.now() + ms;
  let seen = "";
  while (Date.now() < end) {
    seen = await stageColour(d).catch((e) => `error ${e.message}`);
    if (seen === colour) return;
    await sleep(150);
  }
  throw new Error(`the stage never showed ${colour} (last: ${seen})`);
}

/** The transport's time, in seconds ("1.50s / 3.00s" -> 1.5), or null when there is none. */
const playhead = (d) =>
  d.eval(`(() => { const s = [...document.querySelectorAll('span')].map((e) => e.textContent.trim())
    .find((t) => /^\\d+\\.\\d\\ds \\/ \\d+\\.\\d\\ds$/.test(t)); return s ? Number(s.split('s')[0]) : null; })()`);

/** Click the transport at a fraction of its length (a click in the page, not the PC's mouse). */
async function clickTransport(d, fraction) {
  const box =
    await d.eval(`(() => { const r = document.querySelector('input[aria-label="preview time"]').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  await d.clickAtPoint(box.x + box.w * fraction, box.y + box.h / 2);
}

/** The centre of a library tile, by the name it shows. */
const tileCentre = (d, name) =>
  d.waitFor(
    `(() => { const lib = document.querySelector('[data-artdaddy-drop="library"]');
      const e = lib && [...lib.querySelectorAll('button[title]')].find((b) => b.title === ${JSON.stringify(name)});
      if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    30_000,
  );

async function newProject(d) {
  await d.key("Escape");
  if (await d.eval("location.pathname.startsWith('/p/')")) {
    await openMenu(d, "File", "Close Project");
    await d.waitFor("!location.pathname.startsWith('/p/')", 20_000);
  }
  await openMenu(d, "File", "New Project…");
  const box = 'input[placeholder="Project name…"]';
  await d.waitFor(`!!document.querySelector(${JSON.stringify(box)})`);
  await d.click(box);
  await d.type(PROJECT);
  await d.clickText("Create", { sel: "button" });
  const id = await d.waitFor(
    "location.pathname.startsWith('/p/') && decodeURIComponent(location.pathname.slice(3))",
    120_000,
  );
  await d.waitFor("!!document.querySelector('[data-track-id]')", 60_000);
  return id;
}

/** What the page said on its console and the errors it threw, from the driver's recent CDP events. */
function consoleLines(d) {
  return (d.events ?? [])
    .filter(
      (m) => m.method === "Runtime.consoleAPICalled" || m.method === "Runtime.exceptionThrown",
    )
    .map((m) =>
      m.method === "Runtime.exceptionThrown"
        ? `exception: ${m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text ?? ""}`
        : `${m.params?.type}: ${(m.params?.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ")}`,
    )
    .map((l) => l.slice(0, 400));
}

/** File > Open Project… and the project, from the start screen. Waits for the editor (its tracks) for up to three
 *  minutes and says how long the person looked at "Opening project…"; when it never opens, keeps the evidence. */
async function openFromPicker(d, id, label) {
  await openMenu(d, "File", "Open Project…");
  await d.waitFor(`document.body.innerText.includes(${JSON.stringify(PROJECT)})`, 20_000);
  const t0 = performance.now();
  await d.clickText(PROJECT, { sel: "button" });
  await d.waitFor(
    `decodeURIComponent(location.pathname.slice(3)) === ${JSON.stringify(id)}`,
    60_000,
  );
  const opened = await d
    .waitFor("!!document.querySelector('[data-track-id]')", 180_000, 200)
    .then(() => true)
    .catch(() => false);
  const ms = performance.now() - t0;
  report.times.push({ scenario: `${label}: Open Project to the editor`, ms: Math.round(ms) });
  console.log(`  time ${label}: Open Project to the editor: ${(ms / 1000).toFixed(2)} s`);
  if (!opened) {
    await d.screenshot(path.join(runDir, `${label}-still-opening.png`)).catch(() => {});
    writeFileSync(path.join(runDir, `${label}-console.txt`), consoleLines(d).join("\n"));
  }
  check(`${label}: the project opens within three minutes`, opened, `${(ms / 1000).toFixed(1)} s`);
  return { t0, opened };
}

/** File > Close Project, then open it again from the start screen. */
async function reopen(d, id, label) {
  await openMenu(d, "File", "Close Project");
  await d.waitFor("!location.pathname.startsWith('/p/')", 20_000);
  return openFromPicker(d, id, label);
}

async function main() {
  const modelVars = Object.keys(process.env).filter((k) => /AZURE|GOOGLE|OPENAI|VERTEX/i.test(k));
  if (modelVars.length)
    throw new Error(`refusing to run with model variables set: ${modelVars.join(", ")}`);
  if (process.platform !== "win32")
    throw new Error("this lane drives the Windows app and its native dialogs");
  report.mcpPortAtStart = mcpPortHolder();
  report.othersAtStart = otherAppsRunning();

  const shell = buildShell(path.join(runDir, "cargo.log"));
  const status = git("status", "--short").split(/\r?\n/).filter(Boolean);
  report.build = {
    worktree: root,
    head: git("rev-parse", "HEAD"),
    clean: status.length === 0,
    status,
    appSourceChanged: status.some(
      (l) => !/ e2e\/| reports\//.test(` ${l.slice(3).replaceAll("\\", "/")}`),
    ),
    exe: shell.exe,
    exeBuiltAt: shell.builtAt,
    shellBuildMs: shell.ms,
  };
  const backend = await startBackend(Number(process.env.ARTDADDY_QA_MEDIA_API_PORT || 8288));
  const page = await startPage(backend.url);
  const app = new App(runDir);
  const created = [];
  try {
    const boot = await app.launch("first launch");
    const d = app.d;
    report.build.version = await d.eval("window.__TAURI_INTERNALS__.invoke('plugin:app|version')");
    report.build.identifier = await d.eval(
      "window.__TAURI_INTERNALS__.invoke('plugin:app|identifier')",
    );
    report.build.pid = app.pid;
    if (report.build.identifier !== IDENTIFIER)
      throw new Error(`the app reports ${report.build.identifier}: stale or foreign build`);
    console.log(
      `build ${report.build.head.slice(0, 10)} · v${report.build.version} · ${shell.exe} · up in ${boot.ms} ms`,
    );

    // 1. The library's + button, answered in the real Open dialog.
    console.log("\n▶ import with + through the Open dialog");
    const id = await newProject(d);
    created.push(id);
    const shoot = path.join(footage, "shoot");
    mkdirSync(shoot, { recursive: true });
    const wide = path.join(shoot, "wide.mp4");
    copyFileSync(path.join(FIXTURES, "rgb_3s.mp4"), wide);
    await d.click('[data-artdaddy-drop="library"] button[aria-label="import media"]');
    const t0 = performance.now();
    const picked = nativeDialog(app.pid, [
      "-Kind",
      "save",
      "-Title",
      "Import media",
      "-Path",
      wide,
      "-TimeoutMs",
      "60000",
    ]);
    check(
      "the + button opens a Windows dialog titled 'Import media'",
      picked.ok,
      JSON.stringify(picked),
    );
    const tile = await tileCentre(d, "wide.mp4").catch(() => null);
    if (tile)
      time("import: one video linked through the Open dialog (dev build)", performance.now() - t0);
    check("the picked file shows in the library by its name", !!tile);
    const [row] = rows(id);
    check(
      "it is linked where it lies, not copied",
      row?.external === true && path.resolve(row.path) === path.resolve(wide),
      JSON.stringify(row),
    );

    // 1b. A large file: the import row counts up while the app reads it, then the tile arrives. The file is the clip
    // with a 1 GB `free` box after it (a box every MP4 reader skips), so it is large on disk and still plays.
    console.log("\n▶ a 1 GB file through the Open dialog");
    const bigDir = path.join(footage, "big");
    mkdirSync(bigDir, { recursive: true });
    const big = path.join(bigDir, "long take.mp4");
    const bigBytes = withFreeBox(path.join(FIXTURES, "rgb_3s.mp4"), big, 1_000_000_000);
    await d.click('[data-artdaddy-drop="library"] button[aria-label="import media"]');
    const b0 = performance.now();
    const bigPicked = nativeDialog(app.pid, [
      "-Kind",
      "save",
      "-Title",
      "Import media",
      "-Path",
      big,
      "-TimeoutMs",
      "60000",
    ]);
    check("the dialog takes the large file", bigPicked.ok, JSON.stringify(bigPicked));
    // From the moment the dialog closed: the part of the wait the app owns.
    const reading = performance.now();
    const percents = new Set();
    let rowSeen = false;
    let bigTile = null;
    const bigUntil = Date.now() + 300_000;
    while (!bigTile && Date.now() < bigUntil) {
      const shown = await d.eval(
        `[...document.querySelectorAll('[data-testid="import-pct"]')].map((e) => e.dataset.pct)`,
      );
      if (shown?.length) rowSeen = true;
      for (const p of shown ?? []) if (p) percents.add(Number(p));
      bigTile = await d.eval(
        `[...document.querySelectorAll('[data-artdaddy-drop="library"] button[title]')].some((b) => b.title === 'long take.mp4')`,
      );
      if (!bigTile) await sleep(100);
    }
    const readMs = performance.now() - reading;
    if (bigTile)
      time(
        "import: a 1 GB video linked through the Open dialog (dev build)",
        performance.now() - b0,
      );
    check("the large file shows in the library", !!bigTile, `${(bigBytes / 1e9).toFixed(2)} GB`);
    // A wait a person feels says how far it has got; one over before it is felt needs no row.
    const counted = [...percents].some((p) => p > 0 && p < 100);
    const bigSeen = `${rowSeen ? "a row" : "no row"}; ${[...percents].sort((a, b) => a - b).join(", ") || "no percent"}; ${(readMs / 1000).toFixed(1)} s after the dialog`;
    if (readMs > 3000)
      check(
        "a wait of over 3 s shows its import row counting up (0 < n < 100 %)",
        counted,
        bigSeen,
      );
    else {
      report.notes = [...(report.notes ?? []), `the 1 GB import took under 3 s (${bigSeen})`];
      console.log(`  note the 1 GB import took under 3 s (${bigSeen})`);
    }
    const bigRow = rows(id).find((r) => r.filename === "long take.mp4");
    check(
      "it is linked where it lies, not copied",
      bigRow?.external === true && Number(bigRow?.size_bytes) === bigBytes,
      JSON.stringify(bigRow),
    );

    // 2. Real playback: the picture follows the playhead.
    console.log("\n▶ playback");
    const placed = await d.eval(
      `window.__artdaddyTest.editor.getState().addClip(${JSON.stringify(row.id)}, 'v1', 0).then(() => 'ok', (e) => String(e))`,
    );
    check(
      "the clip is placed on v1 (setup, through the editor's own addClip)",
      placed === "ok",
      placed,
    );
    await waitStage(d, "red");
    check("the stage shows the clip's first second (red)", true);
    await d.clickText("play", { sel: "button" });
    const seen = [];
    const times = [];
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      times.push(await playhead(d));
      const c = await stageColour(d);
      if (seen[seen.length - 1] !== c) seen.push(c);
      if (times[times.length - 1] >= 3 && (await d.hasText("play", "button"))) break;
      await sleep(100);
    }
    const order = ["red", "green", "blue"].map((c) => seen.indexOf(c));
    check(
      "playing shows red, then green, then blue, in that order",
      order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])),
      seen.join(" → "),
    );
    check(
      "the playhead counts up while playing and stops at the end (3.00 s)",
      times.some((t) => t > 0.5 && t < 2.5) && times[times.length - 1] === 3,
      times.slice(-3).join(", "),
    );
    for (const fraction of [0.5, 0.15, 0.83]) {
      const s0 = performance.now();
      await clickTransport(d, fraction);
      const t = await playhead(d);
      await waitStage(d, colourAt(t)).then(
        () => time("preview: seek to a new picture (dev build)", performance.now() - s0),
        (e) => check(`after a seek to ${t} s the stage shows ${colourAt(t)}`, false, e.message),
      );
    }

    // 3. The folder moves while the project is closed; one Relink through the real dialog.
    console.log("\n▶ relink through the Open dialog");
    await openMenu(d, "File", "Close Project");
    await d.waitFor("!location.pathname.startsWith('/p/')", 20_000);
    const moved = path.join(footage, "shoot moved");
    renameSync(shoot, moved);
    const first = await openFromPicker(d, id, "open with the folder moved");
    if (!first.opened) throw new Error("the project never opened after its folder moved");
    const offline = await d
      .waitFor(
        `[...document.querySelectorAll('[role=status]')].map((e) => e.textContent).find((t) => /are offline|is offline/.test(t))`,
        30_000,
      )
      .catch(() => null);
    check(
      "reopening says the file is offline and where to relink it",
      /1 media file is offline/.test(offline ?? ""),
      offline,
    );
    // The stage names the clip whose file is gone when the playhead is over it.
    await clickTransport(d, 0.5);
    const stageSays = await d
      .waitFor(
        `[...document.querySelectorAll('[role=status]')].map((e) => e.textContent).find((t) => /^Media offline:/.test(t))`,
        10_000,
      )
      .catch(() => null);
    check(
      "the stage says which clip is offline",
      /Media offline: wide\.mp4/.test(stageSays ?? ""),
      stageSays,
    );
    const at = await tileCentre(d, "wide.mp4");
    for (const type of ["mousePressed", "mouseReleased"])
      await d.cdp.send("Input.dispatchMouseEvent", {
        type,
        x: at.x,
        y: at.y,
        button: "right",
        clickCount: 1,
      });
    await d.clickText("Relink…", { sel: "[role=menuitem]" });
    const r0 = performance.now();
    const located = nativeDialog(app.pid, [
      "-Kind",
      "save",
      "-Title",
      'Locate "wide.mp4"',
      "-Path",
      path.join(moved, "wide.mp4"),
      "-TimeoutMs",
      "60000",
    ]);
    check(
      `Relink opens a Windows dialog titled 'Locate "wide.mp4"'`,
      located.ok,
      JSON.stringify(located),
    );
    const relinked = await d
      .waitFor("document.body.innerText.includes('Relinked 1 file.')", 20_000)
      .catch(() => false);
    check("the library says Relinked 1 file.", relinked);
    const after = rows(id).find((r) => r.filename === "wide.mp4");
    check(
      "the row now names the moved file",
      path.resolve(after?.path ?? ".") === path.resolve(path.join(moved, "wide.mp4")),
      after?.path,
    );
    await waitStage(d, colourAt((await playhead(d)) ?? 0)).then(
      () => time("preview: relinked clip back on the stage (dev build)", performance.now() - r0),
      (e) => check("the picture is back after the relink", false, e.message),
    );

    // 4. Close and open again: the first picture of a project.
    console.log("\n▶ reopen to the first picture");
    const again = await reopen(d, id, "open again");
    if (!again.opened) throw new Error("the project never opened again");
    const at0 =
      (await d.waitFor(
        "(() => { const t = document.querySelector('input[aria-label=\"preview time\"]'); return t ? Number(t.value) + 1 : 0; })()",
        60_000,
      )) - 1;
    await waitStage(d, colourAt(at0), 60_000).then(
      () =>
        time(
          "preview: reopen a project to its first picture (dev build)",
          performance.now() - again.t0,
        ),
      (e) => check("the first picture after reopening", false, e.message),
    );
  } catch (e) {
    check("the run finished", false, e?.stack ?? e);
    await app.d?.screenshot(path.join(runDir, "error.png")).catch(() => {});
  } finally {
    try {
      if (app.running()) {
        await app.d.key("Escape");
        if (await app.d.eval("location.pathname.startsWith('/p/')")) {
          await openMenu(app.d, "File", "Close Project");
          await app.d.waitFor("!location.pathname.startsWith('/p/')", 20_000).catch(() => {});
        }
        report.projectsRemoved = await removeProjects(app.d, created);
      }
    } catch (e) {
      report.cleanupError = String(e?.message ?? e);
    }
    report.launches = app.launches;
    await app.stop();
    await page.close();
    report.standIn = backend.seen;
    await backend.close();
    // The 1 GB file is not evidence: it goes, and the web view's own storage with it.
    for (const leftover of [path.join(footage, "big"), path.join(runDir, "webview")]) {
      try {
        rmSync(leftover, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
      } catch (e) {
        report.notRemoved = [...(report.notRemoved ?? []), `${leftover}: ${e.message}`];
      }
    }
    report.finished = new Date().toISOString();
    writeFileSync(path.join(runDir, "report.json"), JSON.stringify(report, null, 2));
    console.log(
      `\n${failed ? `${failed} check(s) failed` : "all checks passed"}; report ${path.join(runDir, "report.json")}`,
    );
  }
}

await main().catch((e) => {
  console.error(e);
  failed += 1;
});
process.exit(failed ? 1 : 0);
