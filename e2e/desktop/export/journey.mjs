// What a person does in the export journeys, and what they can see or find on disk afterwards.
//
// Setup (a project, its media, clips on the timeline) goes through the app's own doors: File > New Project,
// the import input, and the editor's own addClip through the dev seam the timeline sweep uses
// (src/main.tsx). The journey under test (the Export dialog, Save As, Cancel, Hide, the queue, the chat
// card, quitting) is driven by clicks and keys only, and judged on the screen and on the delivered file.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { projectsRoot } from "../webdriver.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const DIALOG = '[aria-label="export video"]';

export function projectDir(id) {
  return path.join(projectsRoot(), id);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export async function openMenu(d, name, item) {
  await d.key("Escape");
  await d.clickText(name, { sel: "button" });
  await d.clickText(item, { sel: "button,[role=menuitem]" });
}

/** File > New Project, named `sweep_qa-export <label>` (the clean-up removes only `sweep_` projects).
 *  The canvas is Auto: the first video clip sets it. */
export async function newProject(d, label) {
  await d.key("Escape");
  if (await d.eval("location.pathname.startsWith('/p/')")) {
    await openMenu(d, "File", "Close Project");
    await d.waitFor("!location.pathname.startsWith('/p/')", 20_000);
    await sleep(400);
  }
  await openMenu(d, "File", "New Project…");
  const nameBox = 'input[placeholder="Project name…"]';
  await d.waitFor(`!!document.querySelector(${JSON.stringify(nameBox)})`);
  await d.click(nameBox);
  await d.type(`sweep_qa-export ${label}`);
  await d.clickText("Create", { sel: "button" });
  // Two minutes: on a busy PC creating the project has taken longer than 30 s.
  const id = await d.waitFor(
    "location.pathname.startsWith('/p/') && decodeURIComponent(location.pathname.slice(3))",
    120_000,
  );
  // The editor, not the start screen behind it: the start screen has its own file input, and a file handed
  // to it in the gap between the two is lost.
  await d.waitFor("!!document.querySelector('[data-track-id]')", 60_000);
  await sleep(800);
  return { id, dir: projectDir(id) };
}

/** Import files the way the library's input takes them (copied into the project). Resolves with the
 *  library entries, by the file name that was imported. */
export async function importFiles(d, project, files) {
  const libraryFile = path.join(project.dir, "internals", "library.json");
  const before = (readJson(libraryFile, { clips: [] }).clips ?? []).length;
  await d.setFiles('input[type=file][accept*="video"]', files);
  const end = Date.now() + 180_000;
  for (;;) {
    const clips = readJson(libraryFile, { clips: [] }).clips ?? [];
    if (clips.length >= before + files.length) {
      const byName = {};
      for (const c of clips) byName[c.filename] = c;
      return byName;
    }
    if (Date.now() > end) throw new Error(`import timed out: ${clips.length - before}/${files.length} in the library`);
    await sleep(300);
  }
}

/** File > Import Media: the desktop's own import, which LINKS the file where it is (nothing is copied), through
 *  the native Open dialog. Resolves with the new library entry. */
export async function linkMedia(d, pid, project, file) {
  const libraryFile = path.join(project.dir, "internals", "library.json");
  const before = (readJson(libraryFile, { clips: [] }).clips ?? []).length;
  await openMenu(d, "File", "Import Media…");
  // A minute: on a busy PC the Open dialog has taken longer than 20 s to appear.
  const answer = nativeDialog(pid, ["-Kind", "save", "-Title", "Link media*", "-Path", file, "-TimeoutMs", "60000"]);
  if (!answer.ok) throw new Error(`Import Media's dialog: ${answer.reason ?? JSON.stringify(answer)}`);
  const end = Date.now() + 120_000;
  for (;;) {
    const clips = readJson(libraryFile, { clips: [] }).clips ?? [];
    if (clips.length > before) return clips[clips.length - 1];
    if (Date.now() > end) throw new Error(`${path.basename(file)} never reached the library`);
    await sleep(300);
  }
}

/** The saved timeline (internals/timeline.json). */
export function savedTimeline(project) {
  return readJson(path.join(project.dir, "internals", "timeline.json"), null);
}

function clipCount(doc) {
  return (doc?.tracks ?? []).reduce((n, t) => n + (t.clips ?? []).length, 0);
}

/** Put a library entry on a track at a frame, with the editor's own addClip (setup, not the thing under test).
 *  A copied file goes by its library path; a linked one (its path is absolute) by its media reference, as the
 *  library's own drag does. */
export async function place(d, project, entry, track, atFrame) {
  const ref = path.isAbsolute(String(entry.path)) || /^[A-Za-z]:[\\/]/.test(String(entry.path)) ? entry.id : entry.path;
  const before = clipCount(savedTimeline(project));
  const r = await d.eval(
    `window.__artdaddyTest.editor.getState().addClip(${JSON.stringify(ref)}, ${JSON.stringify(track)}, ${Number(atFrame)})
       .then(() => 'ok', (e) => 'threw: ' + String(e))`,
  );
  if (r !== "ok") throw new Error(`addClip ${entry.filename}: ${r}`);
  const end = Date.now() + 20_000;
  while (clipCount(savedTimeline(project)) <= before) {
    if (Date.now() > end) throw new Error(`${entry.filename} never reached the saved timeline`);
    await sleep(150);
  }
  await sleep(400);
}

/** The project's canvas and length as the editor holds it. */
export function canvas(d) {
  return d.eval(`(() => { const tl = window.__artdaddyTest.editor.getState().timeline;
    const frames = Math.max(0, ...(tl?.tracks ?? []).flatMap((t) => (t.clips ?? []).map((c) => Number(c.timeline_out) || 0)));
    return { ...(tl?.canvas ?? {}), frames }; })()`);
}

/** File > Export Video. Resolves with how long the dialog took to appear. */
export async function openExportDialog(d) {
  const t0 = performance.now();
  await openMenu(d, "File", "Export Video (.mp4)…");
  await d.waitFor(`!!document.querySelector('${DIALOG}')`, 15_000);
  return Math.round(performance.now() - t0);
}

export async function pressInDialog(d, label) {
  await d.clickText(label, { sel: `${DIALOG} button, ${DIALOG} summary` });
}

/** Everything the Export dialog shows, read from the screen. */
export function dialogState(d) {
  return d.eval(`(() => {
    const dlg = document.querySelector('${DIALOG}');
    if (!dlg) return { open: false };
    const text = (sel) => dlg.querySelector(sel)?.innerText?.trim() ?? null;
    const bar = dlg.querySelector('[role=progressbar]');
    const buttons = [...dlg.querySelectorAll('button')].map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim());
    const saved = [...dlg.querySelectorAll('p')].map((p) => p.innerText.trim()).find((s) => /^Saved /.test(s)) ?? null;
    const queue = [...dlg.querySelectorAll('section[aria-label="export queue"] li')].map((li) => ({
      name: li.querySelector('.truncate')?.innerText?.trim() ?? '',
      text: li.innerText.replace(/\\s+/g, ' ').trim(),
    }));
    return {
      open: true,
      settings: !!dlg.querySelector('select[aria-label="resolution"]') || buttons.includes('Export'),
      status: text('[data-testid=export-status]'),
      pace: text('[data-testid=export-pace]'),
      bar: bar ? (bar.getAttribute('aria-valuenow') === null ? null : Number(bar.getAttribute('aria-valuenow'))) : undefined,
      saved,
      error: text('[data-testid=export-error]'),
      details: dlg.querySelector('[data-testid=export-error-details] pre')?.textContent ?? null,
      lower: text('[data-testid=export-lower]'),
      buttons,
      queue,
      all: dlg.innerText,
    };
  })()`);
}

/** Wait until the dialog says how the export ended, sampling what it shows on the way. */
export async function waitForEnd(d, { ms = 600_000, every = 250, onSample } = {}) {
  const end = Date.now() + ms;
  for (;;) {
    const s = await dialogState(d);
    onSample?.(s);
    if (s.open && ["Done", "Failed", "Cancelled"].includes(s.status)) return s;
    if (Date.now() > end) throw new Error(`the export did not end within ${ms} ms (last: ${JSON.stringify(s).slice(0, 300)})`);
    await sleep(every);
  }
}

/** Run the Save As script against the app's window (nativeDialog.ps1). */
export function nativeDialog(pid, args) {
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(here, "nativeDialog.ps1"), "-ProcessId", String(pid), ...args],
    { encoding: "utf8", windowsHide: true },
  );
  const line = (r.stdout || "").trim().split(/\r?\n/).pop() ?? "";
  try {
    return JSON.parse(line);
  } catch {
    return { ok: false, reason: `nativeDialog.ps1 printed: ${(r.stdout + r.stderr).slice(0, 400)}` };
  }
}

export function saveAs(pid, file, { overwrite = false, cancel = false, timeoutMs = 60_000 } = {}) {
  return nativeDialog(pid, [
    "-Kind", "save", "-Title", "Export video", "-TimeoutMs", String(timeoutMs),
    ...(cancel ? ["-Button", "Cancel"] : ["-Path", file]),
    ...(overwrite ? ["-Overwrite"] : []),
  ]);
}

/** Press Export in the dialog, answer Save As with `file`, and resolve once Save is pressed (the moment the
 *  person's wait for the file begins). */
export async function startExport(d, pid, file, { overwrite = false } = {}) {
  await pressInDialog(d, "Export");
  const answer = saveAs(pid, file, { overwrite });
  if (!answer.ok) throw new Error(`Save As: ${answer.reason ?? JSON.stringify(answer)}`);
  return { answer, savedAt: performance.now() };
}

/** The app's export encodes running now: its shipped ffmpeg writing an export (an export's encoder hands its
 *  file to the app's own output broker, `ftp://export:…@127.0.0.1`, so its command line never names the
 *  destination). Previews, loudness reads and transcription audio are other ffmpeg runs and are not counted.
 *  Each has `streams`: how many outputs it writes (one per export on the single engine). */
export function exportProcesses() {
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='artdaddy-ffmpeg.exe'\" | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; parent = $_.ParentProcessId; cmd = $_.CommandLine } } | ConvertTo-Json -Compress"],
    { encoding: "utf8", windowsHide: true },
  );
  let list = [];
  try {
    const parsed = JSON.parse(r.stdout || "[]");
    list = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    list = [];
  }
  return list
    .filter((p) => /ftp:\/\/export:/.test(String(p.cmd ?? "")))
    .map((p) => ({ ...p, output: /ftp:\/\/export:[^@\s"]+@[\d.]+:\d+/.exec(String(p.cmd))?.[0] ?? null }));
}

/** How many exports are encoding right now (one output each, however many processes feed it). */
export function exportsEncoding() {
  return new Set(exportProcesses().map((p) => p.output)).size;
}

/** Hold a file open with no sharing, as another program (a player, a sync client) can. */
export async function lockFile(file) {
  const child = spawn(
    "powershell",
    ["-NoProfile", "-Command",
      `$f = [System.IO.File]::Open('${file.replaceAll("'", "''")}', 'OpenOrCreate', 'ReadWrite', 'None'); 'LOCKED'; [Console]::Out.Flush(); Start-Sleep -Seconds 900`],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the lock holder did not start")), 15_000);
    child.stdout.on("data", (b) => {
      if (String(b).includes("LOCKED")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => reject(new Error(`the lock holder exited ${code}`)));
  });
  return {
    release: () => {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    },
  };
}

export function fileState(file) {
  if (!existsSync(file)) return null;
  const s = statSync(file);
  return { size: s.size, mtimeMs: s.mtimeMs };
}

/** The rows of the card above the chat box (ExportCard): what a person sees there about the exports. */
export function cardState(d) {
  return d.eval(`(() => {
    const card = document.querySelector('[aria-label="exports"]');
    if (!card) return null;
    return {
      text: card.innerText.replace(/\\s+/g, ' ').trim(),
      status: [...card.querySelectorAll('[data-testid=export-card-status]')].map((e) => e.innerText.trim()),
      tryAgain: [...card.querySelectorAll('button[aria-label^="try again "]')].map((b) => b.getAttribute('aria-label')),
      elsewhere: [...card.querySelectorAll('button[aria-label$=" somewhere else"]')].map((b) => b.getAttribute('aria-label')),
      cancel: [...card.querySelectorAll('button[aria-label^="cancel "]')].map((b) => b.getAttribute('aria-label')),
    };
  })()`);
}

/** The PC's own figures for an export (free memory, free space), as the page's IPC sees them, can be made
 *  to say something else for a while: the app has no test hook for a full disk or a short memory, so the
 *  one native answer that carries them (`jobs_export_resources`) is rewritten on its way to the page, over
 *  CDP's Fetch domain. Everything else (the question, the answers, the export) is the app's own. */
export async function pcSays(d, figures) {
  const { cdp } = d;
  const listener = async (m) => {
    if (m.method !== "Fetch.requestPaused") return;
    const { requestId, request, responseStatusCode, responseHeaders } = m.params;
    try {
      if (request.method !== "POST" || responseStatusCode === undefined) {
        await cdp.send("Fetch.continueRequest", { requestId });
        return;
      }
      const body = await cdp.send("Fetch.getResponseBody", { requestId });
      const json = JSON.parse(body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body);
      Object.assign(json, figures);
      await cdp.send("Fetch.fulfillRequest", {
        requestId,
        responseCode: responseStatusCode,
        responseHeaders,
        body: Buffer.from(JSON.stringify(json)).toString("base64"),
      });
      d.rewritten = (d.rewritten ?? 0) + 1;
    } catch {
      await cdp.send("Fetch.continueRequest", { requestId }).catch(() => {});
    }
  };
  d.onEvent = listener;
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*ipc.localhost/jobs_export_resources*", requestStage: "Response" }] });
  return async () => {
    await cdp.send("Fetch.disable").catch(() => {});
    d.onEvent = null;
  };
}

/** Remove the `sweep_` projects this run made, through the app's own project removal (folder and registry entry). */
export async function removeProjects(d, ids) {
  const out = [];
  for (const id of ids) {
    if (!/^sweep_/.test(id)) continue;
    const r = await d.eval(`import('/src/store/projects.ts').then(async ({ useProjects }) => {
        await useProjects.getState().refresh();
        await useProjects.getState().removePermanently(${JSON.stringify(id)});
        return 'ok';
      }, (e) => 'threw: ' + String(e))`).catch((e) => `threw: ${e.message}`);
    out.push({ id, result: r, gone: !existsSync(projectDir(id)) });
  }
  return out;
}

export { sleep };
