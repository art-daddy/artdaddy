// OS drop onto the TIMELINE. Reported by an alpha user: a file dragged from Explorer onto a
// track lands in the library but NO clip appears on the timeline.
//
// osdrop.desktop.mjs drops on the LIBRARY zone and asserts it lands in the library, so it is
// structurally blind to this: the whole point here is the second half, the placement. The
// assertion is the clip in the PERSISTED timeline, not the library row.
import { existsSync, mkdirSync, copyFileSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { appBinary, appProcessName, newSession, root, projectsRoot, sleep, startDriver, waitFor } from "./webdriver.mjs";

const NAME = `tldrop${Date.now().toString().slice(-6)}`;
const MEDIA_DIR = path.join(root, "..", "_artdaddy-tldrop-media");
const MEDIA = path.join(MEDIA_DIR, "onto-timeline.mp4");
const PROJECTS = projectsRoot();

const failures = [];
const check = (label, cond, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures.push(label);
};

const clickText = (s, text) =>
  s.exec(
    "const t = arguments[0]; const b = [...document.querySelectorAll('button')].find((e) => e.textContent.trim() === t || e.textContent.trim().startsWith(t)); if (!b) throw new Error('no button: ' + t); b.click(); return true;",
    [text],
  );

function projectDir() {
  // Match the WHOLE name. A six-character prefix ("tldrop") matched every previous run's
  // project too, and taking the last of those read a stale timeline: the drop under test was
  // landing correctly while this reported the leftovers from days ago.
  const dirs = readdirSync(PROJECTS).filter((d) => d.startsWith(`${NAME.toLowerCase()}_`));
  return dirs.length ? path.join(PROJECTS, dirs[dirs.length - 1]) : null;
}
function timeline() {
  const dir = projectDir();
  const f = dir && path.join(dir, "internals", "timeline.json");
  return f && existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
}
function library() {
  const dir = projectDir();
  const f = dir && path.join(dir, "internals", "library.json");
  return f && existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : { clips: [] };
}
const clipCount = (tl) => (tl?.tracks ?? []).reduce((n, t) => n + (t.clips?.length ?? 0), 0);

/** Raise the app window and return its client-area origin in PHYSICAL pixels. */
function raiseAppWindow() {
  const out = execFileSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "e2e", "desktop", "raise.ps1"), "-Process", appProcessName()],
    { encoding: "utf8" },
  ).trim();
  const [x, y, state] = out.split(",");
  if (!Number.isFinite(Number(x))) throw new Error(`bad client origin: ${out}`);
  return { x: Number(x), y: Number(y), foreground: state === "fg" };
}

mkdirSync(MEDIA_DIR, { recursive: true });
copyFileSync(path.join(root, "public", "test-clip.mp4"), MEDIA);

const driver = await startDriver();
let s;
try {
  s = await newSession(appBinary());
  await waitFor(
    () => s.exec("return [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'File');"),
    { label: "the app to boot" },
  );
  await clickText(s, "File");
  await sleep(400);
  await clickText(s, "New Project");
  await sleep(700);
  const nameBox = await waitFor(() => s.find("input[placeholder*='roject']"), { label: "the new-project dialog" });
  await s.type(nameBox, NAME);
  await sleep(300);
  await clickText(s, "Create");
  await waitFor(
    async () => (await s.exec("return document.querySelectorAll(\"[data-artdaddy-drop='track']\").length;")) > 0,
    { label: "the timeline lanes" },
  );

  const origin = raiseAppWindow();
  check("the app window came to the foreground", origin.foreground, JSON.stringify(origin));
  await sleep(1200);

  // Target a VIDEO lane, a little way along it so a placement at frame 0 is distinguishable
  // from one that honoured the drop position.
  const lane = await s.exec(
    "const els=[...document.querySelectorAll(\"[data-artdaddy-drop='track']\")];" +
      "const el=els.find(e=>/^v/.test(e.dataset.trackId||''))||els[0];" +
      "if(!el) return null; const r=el.getBoundingClientRect();" +
      "return { id: el.dataset.trackId, x: r.x + r.width*0.45, y: r.y + r.height/2, dpr: window.devicePixelRatio };",
  );
  check("a video lane is on screen", !!lane && lane.x > 0, JSON.stringify(lane));
  if (!lane) throw new Error("no track zone");

  const screenX = Math.round(origin.x + lane.x * lane.dpr);
  const screenY = Math.round(origin.y + lane.y * lane.dpr);
  console.log(`  info lane ${lane.id} css=(${lane.x.toFixed(0)},${lane.y.toFixed(0)}) dpr=${lane.dpr} -> screen=(${screenX},${screenY})`);

  const before = clipCount(timeline());
  // Record what the router actually decided, so a failure says WHERE it went wrong rather
  // than just "no clip appeared".
  await s.exec(
    "window.__drops = [];" +
      "window.addEventListener('artdaddy:os-drop', (e) => window.__drops.push({ target: e.detail.target, x: e.detail.x, y: e.detail.y, trackId: e.detail.element && e.detail.element.dataset ? e.detail.element.dataset.trackId : null }));" +
      "return true;",
  );
  const out = execFileSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "e2e", "desktop", "osDrop.ps1"),
      "-File", MEDIA, "-X", String(screenX), "-Y", String(screenY), "-Process", appProcessName()],
    { encoding: "utf8" },
  ).trim();
  console.log(`  info drag helper: ${out}`);
  check("the drag was not aborted by the safety guard", !out.includes("ABORT"), out);
  await sleep(9000);

  const routed = await s.exec("return JSON.stringify(window.__drops || []);");
  console.log(`  info routed: ${routed}`);

  const lib = library().clips;
  check("the file reached the library", lib.some((c) => c.filename === "onto-timeline.mp4"), `${lib.length} clip(s)`);

  const tl = timeline();
  const after = clipCount(tl);
  check("A CLIP WAS PLACED ON THE TIMELINE", after === before + 1, `${before} -> ${after}`);
  const placed = (tl?.tracks ?? []).flatMap((t) => (t.clips ?? []).map((c) => ({ ...c, track: t.id })))[0];
  if (placed) {
    console.log(`  info clip: ${JSON.stringify(placed)}`);
    check("it landed on the lane it was dropped over", placed.track === lane.id, `${placed.track} vs ${lane.id}`);
    check("it landed at the drop position, not frame 0", placed.timeline_in > 0, String(placed.timeline_in));
  }

  console.log(failures.length ? `\n${failures.length} failure(s): ${failures.join(", ")}` : "\nall checks passed");
} finally {
  try {
    await s?.quit();
  } catch {
    /* gone */
  }
  driver.kill();
  await sleep(300);
}
process.exit(failures.length ? 1 : 0);
