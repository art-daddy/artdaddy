// Helpers for the media-library and preview QA specs. They build on the agent lane's rig
// (../../agent-and-models/lib/qa: a fake ArtDaddy server and a QA shell standing in for the desktop
// side), and add what a person does with media: the library's + button, the File menu, a file dropped
// from Explorer or Finder, moving a file behind the app's back, and reading what the stage shows.
//
// A drop from the OS is raised the way Tauri raises it: the shell sends `tauri://drag-enter`, `-over`
// and `-drop` with the file's path and the position in physical pixels, and the app's own router
// (src/lib/osDrop.ts) finds the zone under that point. The real OLE drag from Explorer is the desktop
// lane's (e2e/desktop/osdrop.desktop.mjs, osdropTimeline.desktop.mjs).
import { promises as fsp } from "node:fs";
import path from "node:path";

import type { Locator, Page, Route } from "@playwright/test";

import { expect, type AgentRig } from "../../agent-and-models/lib/qa";
import { decodePng } from "../../../../src/test/png";

export const MEDIA_DIR = path.resolve("e2e/ui/media-library/fixtures/media");

/** A fixture file by name (e2e/ui/media-library/fixtures/media/<name>). */
export const fixture = (name: string): string => path.join(MEDIA_DIR, name);

/** Copies of fixtures on the shell's disk, in `media/<folder>/`, the way a person keeps footage in a
 *  folder of their own. `files` maps the name on disk to the fixture it is a copy of. Returns page paths. */
export async function onDisk(
  qa: AgentRig,
  files: Record<string, string>,
  folder = "footage",
): Promise<string[]> {
  const dir = path.join(qa.shell.root, "media", folder);
  await fsp.mkdir(dir, { recursive: true });
  const out: string[] = [];
  for (const [name, source] of Object.entries(files)) {
    await fsp.copyFile(fixture(source), path.join(dir, name));
    out.push(qa.shell.virtual(`media/${folder}/${name}`));
  }
  return out;
}

/** Move a folder of the shell's disk behind the app's back (a person tidying their drive). Windows refuses to move a
 *  folder while any file in it is open, so a refusal is tried again for a few seconds. */
export async function moveFolder(qa: AgentRig, from: string, to: string): Promise<void> {
  const src = path.join(qa.shell.root, "media", from);
  const dst = path.join(qa.shell.root, "media", to);
  for (let i = 0; ; i++) {
    try {
      await fsp.rename(src, dst);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 40 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

/** Wait until every ffmpeg and ffprobe run the app started (probes, posters, sound) has ended. */
export async function sidecarsDone(qa: AgentRig, timeout = 60_000): Promise<void> {
  await expect.poll(() => qa.shell.sidecarRuns.filter((r) => !r.ended).length, { timeout }).toBe(0);
}

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
};

/** Serve the app's files (the asset protocol) the way Tauri does: a byte range is answered with 206 and at most about
 *  1 MB at a time, and the answer may be read from another origin (the preview reads it from its worker). The shell's
 *  own route sends the whole file for every request, and the preview's decoder reads a video by ranges
 *  (src/preview/videoSource.ts), so without this it reads the wrong bytes and the stage keeps showing the poster.
 *  Registered on the page after the shell's route, so it answers first, and on the browser context too, for the
 *  requests a worker makes (a page route does not see every one of them: see openProject). */
export async function serveAssetsLikeTauri(qa: AgentRig): Promise<void> {
  const CAP = 1 << 20;
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
  };
  const serve = async (route: Route): Promise<void> => {
    let bytes: Buffer;
    let file: string;
    try {
      file = qa.shell.real(decodeURIComponent(new URL(route.request().url()).pathname.slice(1)));
      bytes = await fsp.readFile(file);
    } catch {
      await route.fulfill({ status: 404, body: "", headers: cors });
      return;
    }
    const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    const m = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers()["range"] ?? "");
    if (!m) {
      await route.fulfill({
        status: 200,
        body: bytes,
        headers: { ...cors, "Content-Type": type, "Accept-Ranges": "bytes" },
      });
      return;
    }
    const start = Number(m[1]);
    if (start >= bytes.length) {
      await route.fulfill({
        status: 416,
        body: "",
        headers: { ...cors, "Content-Range": `bytes */${bytes.length}` },
      });
      return;
    }
    const end = Math.min(m[2] ? Number(m[2]) : bytes.length - 1, bytes.length - 1, start + CAP - 1);
    await route.fulfill({
      status: 206,
      body: bytes.subarray(start, end + 1),
      headers: {
        ...cors,
        "Content-Type": type,
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
      },
    });
  };
  await qa.page.context().route("http://asset.localhost/**", serve);
  await qa.page.route("http://asset.localhost/**", serve);
}

/** Start the app and make a fresh project, with the app's files served as Tauri serves them and the internet shut for
 *  the whole browser context. The shell shuts https for the page, yet the speech model's download (the app asks for it
 *  when a video comes in) still reached huggingface.co from this lane: a test's disk held 100 MB of `ggml-small.bin`. */
export async function openProject(qa: AgentRig, name: string): Promise<string> {
  await qa.page.context().route(/^https:\/\//, async (route) => {
    qa.shell.blocked.add(new URL(route.request().url()).origin);
    await route.abort("internetdisconnected");
  });
  await serveAssetsLikeTauri(qa);
  return qa.openProject(name);
}

/** Close the project the way a person does (File > Close Project), start the app again and open the project. */
export async function restart(qa: AgentRig, name: string): Promise<string> {
  await fileMenu(qa, /^Close Project$/);
  await qa.page.waitForURL((u) => !u.pathname.startsWith("/p/"), { timeout: 20_000 });
  return qa.reopen(name);
}

/** The files the project holds in its own `library/` folder (copies), by name. */
export async function ownedFiles(qa: AgentRig, id = qa.projectId()): Promise<string[]> {
  const dir = path.join(qa.shell.projectDir(id), "library");
  try {
    return (await fsp.readdir(dir)).filter((n) => !n.startsWith("."));
  } catch {
    return [];
  }
}

export interface LibraryRow {
  id: string;
  path: string;
  filename?: string;
  kind?: string;
  external?: boolean;
  tags?: string[];
  folder?: string;
  [k: string]: unknown;
}

/** The library's rows as saved (`internals/library.json`). */
export async function savedRows(qa: AgentRig, id = qa.projectId()): Promise<LibraryRow[]> {
  return (await qa.savedAssets(id)) as LibraryRow[];
}

/** The library pane (the drop zone the app declares for it). */
export const libraryPane = (page: Page): Locator => page.locator('[data-artdaddy-drop="library"]');

/** A library tile or list row, by the name it shows. */
export const libraryItem = (page: Page, name: string): Locator =>
  libraryPane(page).getByText(name, { exact: true });

/** Click the library's + ("Import media"); the OS dialog answers `paths` (null = Cancel). */
export async function importWithPlus(qa: AgentRig, paths: string[] | null): Promise<void> {
  qa.shell.pickFiles(paths);
  await libraryPane(qa.page).getByRole("button", { name: "import media" }).click();
}

/** Open the File menu and click `item`. */
export async function fileMenu(qa: AgentRig, item: RegExp): Promise<void> {
  await qa.page.getByRole("button", { name: "File", exact: true }).click();
  await qa.page.getByRole("button", { name: item }).first().click();
}

/** Right-click a library item and choose `action` from its menu. */
export async function itemMenu(page: Page, name: string, action: string | RegExp): Promise<void> {
  await libraryItem(page, name).click({ button: "right" });
  await page.getByRole("menuitem", { name: action }).click();
}

/** A video track's lane on the timeline (the drop zone the app declares for each track). */
export const trackLane = (page: Page, trackId = "v1"): Locator =>
  page.locator(`[data-artdaddy-drop="track"][data-track-id="${trackId}"]`);

/** Drop `paths` from the OS onto `target`, at `at` (CSS pixels inside it; its centre by default). */
export async function osDrop(
  page: Page,
  paths: string[],
  target: Locator,
  at?: { x: number; y: number },
): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error("the drop target is not on screen");
  const x = box.x + (at?.x ?? box.width / 2);
  const y = box.y + (at?.y ?? box.height / 2);
  await page.evaluate(
    ({ paths, x, y }) => {
      const shell = (window as unknown as { __qaShell: { emit(e: string, p: unknown): void } })
        .__qaShell;
      const dpr = window.devicePixelRatio || 1;
      const position = { x: x * dpr, y: y * dpr };
      shell.emit("tauri://drag-enter", { paths, position });
      shell.emit("tauri://drag-over", { position });
      shell.emit("tauri://drag-drop", { paths, position });
    },
    { paths, x, y },
  );
}

/** The notice the app raises for the project (bottom centre, with Dismiss). */
export const notice = (page: Page): Locator =>
  page.getByRole("status").filter({ has: page.getByRole("button", { name: "Dismiss" }) });

/** The stage: the preview pane under its tab strip. */
export const stage = (page: Page): Locator =>
  page.getByRole("tablist", { name: "preview tabs" }).locator("xpath=..");

/** The live preview's canvas. */
export const stageCanvas = (page: Page): Locator => stage(page).locator("canvas").first();

/** The preview transport's time readout, in seconds ("1.50s / 3.00s" -> 1.5). */
export async function playheadSeconds(page: Page): Promise<number> {
  const text = await stage(page)
    .getByText(/^\d+\.\d\ds \/ \d+\.\d\ds$/)
    .innerText();
  return Number(text.split("s")[0]);
}

export type Rgb = [number, number, number];

/** The mean colour of the middle of the stage, as the screen shows it. The middle fifth of the
 *  canvas is read, away from its rounded corners and any letterbox band. */
export async function stageColour(page: Page): Promise<Rgb> {
  const pic = decodePng(await stageCanvas(page).screenshot());
  const x0 = Math.floor(pic.w * 0.4);
  const x1 = Math.ceil(pic.w * 0.6);
  const y0 = Math.floor(pic.h * 0.4);
  const y1 = Math.ceil(pic.h * 0.6);
  const sum: Rgb = [0, 0, 0];
  let n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = (y * pic.w + x) * 3;
      sum[0] += pic.rgb[i];
      sum[1] += pic.rgb[i + 1];
      sum[2] += pic.rgb[i + 2];
      n += 1;
    }
  return sum.map((v) => Math.round(v / Math.max(1, n))) as Rgb;
}

/** Which of the fixtures' colours a pixel is: "red", "green", "blue", "orange", "black" or "other". */
export function colourName([r, g, b]: Rgb): string {
  if (r < 40 && g < 40 && b < 40) return "black";
  if (r > 150 && g < 90 && b < 90) return "red";
  if (g > 150 && r < 90 && b < 90) return "green";
  if (b > 150 && r < 90 && g < 90) return "blue";
  if (r > 180 && g > 100 && g < 200 && b < 90) return "orange";
  return "other";
}

/** Wait until the stage shows `colour`; returns it. */
export async function expectStage(page: Page, colour: string, timeout = 20_000): Promise<void> {
  await expect
    .poll(async () => colourName(await stageColour(page)), {
      timeout,
      message: `the stage never showed ${colour}`,
    })
    .toBe(colour);
}

/** WebKit on Windows has no WebGL2 and no WebCodecs: the preview cannot draw there (the config's
 *  ignore list says the same for the older pixel specs). */
export function previewCannotDrawHere(browserName: string): boolean {
  return browserName === "webkit" && process.platform === "win32";
}
