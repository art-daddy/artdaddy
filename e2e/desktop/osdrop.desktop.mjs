// A REAL OS file drop onto the running app, asserted against the persisted library.
//
// `dragDropEnabled: true` decides whether a dropped file arrives as a PATH (Tauri owns the drop,
// so we can link it in place) or as an HTML5 File with no path (we would have to copy the bytes).
// No unit test can see a Tauri config flag, and no WebDriver session can perform a shell drag, so
// this drives an actual OLE drag from a helper process and then reads `internals/library.json`:
// `external: true` + the original absolute path is the proof that the drop carried a path.
//
// PREREQUISITES: as drag.desktop.mjs, plus a visible app window (the drag targets real screen
// coordinates). The helper aborts rather than dropping if that point is not the app's window.
//
//   node e2e/desktop/osdrop.desktop.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

import { appBinary, appProcessName, newSession, root, projectsRoot, sleep, startDriver, waitFor } from "./webdriver.mjs";

const NAME = `osdrop${Date.now().toString().slice(-6)}`;
const MEDIA_DIR = path.join(root, "..", "_artdaddy-osdrop-media");
const MEDIA = path.join(MEDIA_DIR, "dropped-clip.mp4");
const PROJECTS = projectsRoot();

const failures = [];
function check(label, cond, detail) {
  if (cond) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    failures.push(label);
  }
}

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
// The manifest is only written on the first import, so "not there yet" means an empty library.
function library() {
  const p = path.join(projectDir(), "internals", "library.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { clips: [] };
}

/** Put the app window on top at a known place and report its client-area origin (screen coords of
 *  the webview's 0,0). Without this the drop point can be covered by another window — the helper
 *  then aborts, which is correct but useless. */
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
    async () => (await s.exec("return document.querySelectorAll(\"[data-artdaddy-drop='library']\").length;")) > 0,
    { label: "the library drop zone" },
  );

  // Raise FIRST: this resizes the window, so any rect read before it would be stale.
  const origin = raiseAppWindow();
  check("the app window came to the foreground", origin.foreground, JSON.stringify(origin));
  await sleep(1200);

  const zone = await s.exec(
    "const el = document.querySelector(\"[data-artdaddy-drop='library']\"); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, dpr: window.devicePixelRatio };",
  );
  check("the library drop zone is on screen", !!zone && zone.x > 0, JSON.stringify(zone));
  if (!zone) throw new Error("no library zone");

  const screenX = Math.round(origin.x + zone.x * zone.dpr);
  const screenY = Math.round(origin.y + zone.y * zone.dpr);
  console.log(`  info zone css=(${zone.x.toFixed(0)},${zone.y.toFixed(0)}) dpr=${zone.dpr} -> screen=(${screenX},${screenY})`);

  const before = library().clips.length;
  const out = execFileSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "e2e", "desktop", "osDrop.ps1"),
      "-File", MEDIA, "-X", String(screenX), "-Y", String(screenY), "-Process", appProcessName()],
    { encoding: "utf8" },
  ).trim();
  console.log(`  info drag helper: ${out}`);
  check("the drag was not aborted by the safety guard", !out.includes("ABORT"), out);
  await sleep(6000);

  const clips = library().clips;
  check("the OS drop added the file to the library", clips.length === before + 1, `${clips.length} vs ${before}`);
  const dropped = clips.find((c) => c.filename === "dropped-clip.mp4");
  check("it is the file that was dropped", !!dropped, JSON.stringify(clips).slice(0, 300));
  if (dropped) {
    console.log(`  info clip: ${JSON.stringify(dropped)}`);
    // The whole point of dragDropEnabled: the drop carried a PATH, so the file is referenced
    // where it lies. Without it the webview only gets bytes and this would be a copy.
    check("the drop carried a real path, so it was LINKED not copied", dropped.external === true, `external=${dropped.external} path=${dropped.path}`);
    check("it points at the original file on disk", dropped.path?.replace(/\//g, "\\").toLowerCase() === MEDIA.toLowerCase(), dropped.path);
    // `library/` is scaffolded empty with every project, so its EXISTENCE proves nothing —
    // what matters is that no bytes were copied into it.
    const libDir = path.join(projectDir(), "library");
    const copied = existsSync(libDir) ? readdirSync(libDir) : [];
    check("no copy of the file was made inside the project", copied.length === 0, `library/ contains ${JSON.stringify(copied)}`);
  }
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
    /* may never have been created */
  }
  rmSync(MEDIA_DIR, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s): ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\nall checks passed");
