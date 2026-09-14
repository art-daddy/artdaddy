// Library -> timeline drag, in the REAL Tauri app, asserted against the PERSISTED document.
//
// This is the only lane that can see this path. The unit suite has no layout, so its
// `elementFromPoint` is a stub; the browser lane cannot open a project at all (projects resolve
// through Tauri's `dataDir()`); and neither one runs the app's own input pipeline. Here the drag
// is a W3C Actions pointer sequence delivered to the app window, and the assertion is the clip
// that ends up in `internals/timeline.json` on disk.
//
// PREREQUISITES:
//   cargo install tauri-driver --locked
//   msedgedriver matching the installed Edge, on PATH or at $env:MSEDGEDRIVER
//   a built app (npx tauri dev once) + `npm run dev` serving the frontend for a debug binary
//
//   node e2e/desktop/drag.desktop.mjs
import { existsSync, mkdirSync, copyFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

import { appBinary, newSession, root, projectsRoot, sleep, startDriver, waitFor } from "./webdriver.mjs";

const NAME = `dragspec${Date.now().toString().slice(-6)}`;
const MEDIA_DIR = path.join(root, "..", "_artdaddy-drag-media");
const MEDIA = path.join(MEDIA_DIR, "drag-clip.mp4");
const PROJECTS = projectsRoot();

const failures = [];
function check(label, cond, detail) {
  if (cond) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    failures.push(label);
  }
}

/** Click a button by its exact label. Setup only — the drag under test uses real pointer input. */
const clickText = (s, text) =>
  s.exec(
    "const t = arguments[0]; const b = [...document.querySelectorAll('button')].find((e) => e.textContent.trim() === t || e.textContent.trim().startsWith(t)); if (!b) throw new Error('no button: ' + t); b.click(); return true;",
    [text],
  );

function projectDir() {
  const hit = readdirSync(PROJECTS).filter((d) => d.startsWith(NAME));
  if (hit.length !== 1) throw new Error(`expected 1 project dir for ${NAME}, saw ${hit.length}`);
  return path.join(PROJECTS, hit[0]);
}

const timeline = () => JSON.parse(readFileSync(path.join(projectDir(), "internals", "timeline.json"), "utf8"));
const clipsOf = (t) => (t.tracks ?? []).flatMap((tr) => (tr.clips ?? []).map((c) => ({ ...c, track: tr.id ?? tr.name })));

mkdirSync(MEDIA_DIR, { recursive: true });
copyFileSync(path.join(root, "public", "test-clip.mp4"), MEDIA);

const driver = await startDriver();
let s;
try {
  s = await newSession(appBinary());
  const hasFile = () => s.exec("return [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'File');");
  await waitFor(hasFile, { label: "the app to boot" });

  // --- setup: a real project, and a real library item via the app's own file input ---
  await clickText(s, "File");
  await sleep(400);
  await clickText(s, "New Project");
  await sleep(700);
  const nameBox = await waitFor(() => s.find("input[placeholder*='roject']"), { label: "the new-project dialog" });
  await s.type(nameBox, NAME);
  await sleep(300);
  await clickText(s, "Create");

  const lanesReady = await waitFor(
    async () => {
      const n = await s.exec("return document.querySelectorAll(\"[data-artdaddy-drop='track']\").length;");
      return n > 0 ? n : null;
    },
    { label: "the timeline lanes" },
  );
  check("the timeline renders drop-target lanes", lanesReady > 0, `saw ${lanesReady}`);

  const fileInput = await s.find("input[type='file']");
  await s.type(fileInput, MEDIA);

  // The tile is titled with the file as STORED (media_<id>.mp4), not the name it was imported
  // under, so match on the extension rather than the source filename.
  const tile = "aside button[title$='.mp4']";
  const tileBox = await waitFor(() => s.box(tile), { label: "the imported clip in the library" }).catch(() => null);
  check("the imported clip appears in the library", !!tileBox, JSON.stringify(tileBox));
  if (!tileBox) throw new Error("no library tile — cannot drag");

  const before = clipsOf(timeline());
  check("the timeline starts empty", before.length === 0, `${before.length} clips`);

  // --- the thing under test: a real pointer drag onto a lane that is NOT the first one ---
  // A project now starts with ONE video lane, so the drop lane and lane 0 would be the same
  // track and "it landed where I released it" could not fail. Add a second video lane through
  // the app's own button — that is the only arrangement in which this test proves anything.
  await s.click(await s.find("button[title='Add video track']"));
  await waitFor(
    async () =>
      (await s.exec(
        "return [...document.querySelectorAll(\"[data-artdaddy-drop='track'][data-track-kind='video']\")].length;",
      )) >= 2,
    { label: "a second video lane" },
  );
  const lanes = await s.exec(
    "return [...document.querySelectorAll(\"[data-artdaddy-drop='track']\")].map((el) => { const r = el.getBoundingClientRect(); return { id: el.dataset.trackId, kind: el.dataset.trackKind, x: r.x, y: r.y + r.height / 2, w: r.width, h: r.height }; });",
  );
  console.log(`  info lanes: ${JSON.stringify(lanes)}`);
  // Not the FIRST lane — a drag that ignored the cursor would land on lane 0 at frame 0 — and
  // well right of the lane's left edge so the drop frame cannot be 0 either. It must still be a
  // VIDEO lane: a video refused by an audio track would look identical to a drag that did nothing.
  // Kind comes from the lane itself; inferring it from an "v" id prefix missed every track the
  // UI creates, which are named track_<uuid>.
  const videoLanes = lanes.filter((l) => l.kind === "video");
  const lane = videoLanes[videoLanes.length - 1];
  check("there is a video lane that is not the first lane", lane && lane.id !== lanes[0].id, `lane=${lane?.id} first=${lanes[0]?.id}`);
  const target = { x: lane.x + Math.min(260, lane.w * 0.45), y: lane.y };

  await s.drag(tileBox, target);
  await sleep(4000);

  const after = clipsOf(timeline());
  check("the drag added exactly one clip to the persisted timeline", after.length === 1, `${after.length} clips: ${JSON.stringify(after).slice(0, 300)}`);
  if (after.length === 1) {
    const clip = after[0];
    console.log(`  info clip: ${JSON.stringify(clip).slice(0, 300)}`);
    check("it landed on the lane it was released over, not the first one", String(clip.track) === String(lane.id), `track=${clip.track} expected=${lane.id}`);
    check("it landed at the drop position, not frame 0", clip.timeline_in > 0, `timeline_in=${clip.timeline_in}`);
  }

  // Failure direction: a video released over an AUDIO lane must not be placed there.
  const audioLane = lanes.find((l) => l.kind === "audio");
  if (audioLane) {
    const beforeAudio = clipsOf(timeline()).length;
    const tileAgain = await s.box(tile);
    await s.drag(tileAgain, { x: audioLane.x + 120, y: audioLane.y });
    await sleep(3000);
    const afterAudio = clipsOf(timeline());
    check(
      "a video released over an audio lane is not placed",
      afterAudio.length === beforeAudio,
      `${afterAudio.length} vs ${beforeAudio}: ${JSON.stringify(afterAudio.map((c) => c.track))}`,
    );
  }

  // --- failure direction: a plain click must not place anything ---
  const beforeClick = clipsOf(timeline()).length;
  const box2 = await s.box(tile);
  await s.drag(box2, box2, 1); // press and release without moving
  await sleep(2500);
  check("a click on a library tile places no clip", clipsOf(timeline()).length === beforeClick, `${clipsOf(timeline()).length} vs ${beforeClick}`);
} catch (e) {
  console.error("ERROR:", e.message);
  failures.push(e.message);
} finally {
  await s?.quit();
  driver.kill();
  await sleep(600);
  try {
    rmSync(projectDir(), { recursive: true, force: true });
  } catch {
    /* project may never have been created */
  }
  rmSync(MEDIA_DIR, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s): ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\nall checks passed");
