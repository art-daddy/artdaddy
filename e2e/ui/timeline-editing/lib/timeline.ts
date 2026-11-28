// The timeline lane's rig: a real project open in a real browser (the agent lane's QA shell and fake
// server, e2e/ui/agent-and-models/lib), media imported through File > Import Media… and gestures made
// with the real mouse and keyboard. Every check reads what the app SAVED (internals/timeline.json on
// the shell's disk), never only what the screen shows.
//
// Setup that is not the thing under test (a clip at an exact frame, a zoom that makes one frame four
// pixels wide) goes through the editor's own commands, the dev seam the real-app sweep uses
// (src/main.tsx, scripts/uisweep/lib/setup.mjs), so each test starts from a stated timeline.
import path from "node:path";

import type { Locator, Page } from "@playwright/test";

import { startTimer, type Timer } from "../../../lib/timing";
import {
  expect,
  test as agentTest,
  type AgentRig,
  type SavedTimeline,
} from "../../agent-and-models/lib/qa";

export { expect, knownBug } from "../../agent-and-models/lib/qa";

export const MEDIA = path.resolve("e2e/ui/timeline-editing/fixtures/media");

/** Pixels per second the rig zooms to: four pixels a frame at 30 fps, so a pointer aimed at a frame
 *  lands on it whatever the rounding. */
export const ZOOM = 120;

export interface SavedClip {
  id: string;
  track: string;
  kind?: string;
  media_ref?: string;
  timeline_in: number;
  timeline_out: number;
  source_in?: number;
  source_out?: number;
  link_group?: string;
  disabled?: boolean;
  text?: string;
  transition_in?: unknown;
  fade?: { in?: number; out?: number };
  [k: string]: unknown;
}

export interface SavedTrack {
  id: string;
  kind?: string;
  z?: number;
  mute?: boolean;
  hidden?: boolean;
  locked?: boolean;
  solo?: boolean;
  sync_locked?: boolean;
  clips?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

export type Doc = Omit<SavedTimeline, "tracks"> & {
  tracks?: SavedTrack[];
  canvas?: { fps?: number; width?: number; height?: number };
};

export interface Seed {
  media: string;
  track: string;
  at: number;
  len?: number;
}

type Modifier = "Alt" | "Shift" | "Control";

/** Every clip of a saved document, with the track it sits on. */
export function clipsOf(doc: Doc | null): SavedClip[] {
  return (doc?.tracks ?? []).flatMap((t) =>
    (t.clips ?? []).map((c) => ({ ...(c as object), track: String(t.id) }) as SavedClip),
  );
}

/** The clips of one track, in timeline order. */
export function onTrack(doc: Doc | null, track: string): SavedClip[] {
  return clipsOf(doc)
    .filter((c) => c.track === track)
    .sort((a, b) => a.timeline_in - b.timeline_in);
}

/** [in, out) of each clip on a track, in order: the shape most checks are about. */
export function spans(doc: Doc | null, track: string): Array<[number, number]> {
  return onTrack(doc, track).map((c) => [c.timeline_in, c.timeline_out]);
}

/** A wait named the way the timing helper asks: "timeline: <what> [<browser>]". */
export function timelineWait(what: string): Timer {
  return startTimer(`timeline: ${what} [${test.info().project.name}]`);
}

/** Run a group only on the engine the desktop app ships on this system: WebView2 (Chromium) on
 *  Windows, WebKit on macOS (WKWebView) and Linux (WebKitGTK). The other engine is never a user's,
 *  and every run of this lane costs CI's scarce macOS minutes. QA_TIMELINE_ALL_ENGINES=1 runs both. */
export function onShippedEngineOnly(): void {
  const shipped = process.platform === "win32" ? "chromium" : "webkit";
  test.skip(
    ({ browserName }) => !process.env.QA_TIMELINE_ALL_ENGINES && browserName !== shipped,
    `the desktop app runs on ${shipped} here`,
  );
}

export class TimelineRig {
  projectId = "";
  /** Library ids by file name. */
  readonly refs: Record<string, string> = {};

  constructor(readonly qa: AgentRig) {}

  get page(): Page {
    return this.qa.page;
  }

  /** Start the app, make a fresh project, import `media` through the File menu, turn snapping off and
   *  zoom so a frame is four pixels wide. */
  async start(media: string[] = [], opts: { snapping?: boolean } = {}): Promise<void> {
    this.projectId = await this.qa.openProject("sweep_qa_timeline");
    await expect(this.page.getByText(/2 tracks · 0 clips/)).toBeVisible({ timeout: 20_000 });
    if (media.length) await this.importMedia(media);
    await this.setZoom(ZOOM);
    await this.setSnapping(opts.snapping ?? false);
  }

  /** File > Import Media…, answering the OS dialog with copies of `files`, as a person picks them. */
  async importMedia(files: string[]): Promise<void> {
    const picks: string[] = [];
    for (const f of files) picks.push(await this.qa.shell.addMedia(path.join(MEDIA, f)));
    this.qa.shell.pickFiles(picks);
    await this.menu("File", "Import Media…");
    await expect
      .poll(async () => (await this.qa.savedAssets(this.projectId)).length, { timeout: 60_000 })
      .toBeGreaterThanOrEqual(files.length);
    for (const a of await this.qa.savedAssets(this.projectId))
      this.refs[String(a.filename)] = String(a.id);
  }

  /** Open a menu-bar menu and choose `item` by its label (the item's shortcut follows the label). */
  async menu(name: string, item: string): Promise<void> {
    const opener = this.page.getByRole("button", { name, exact: true });
    await opener.click();
    const label = new RegExp(`^${item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`);
    // The open menu is drawn beside its button, inside the same wrapper.
    await opener.locator("xpath=..").getByRole("button", { name: label }).click();
  }

  /** The saved timeline (internals/timeline.json). */
  async doc(): Promise<Doc> {
    const d = (await this.qa.savedTimeline(this.projectId)) as Doc | null;
    if (!d) throw new Error("the project has no saved timeline");
    return d;
  }

  /** Wait until the saved timeline passes `check`, and return it. */
  async saved(check: (d: Doc) => boolean, what: string, timeout = 15_000): Promise<Doc> {
    let last: Doc | null = null;
    await expect
      .poll(
        async () => {
          last = (await this.qa.savedTimeline(this.projectId)) as Doc | null;
          return !!last && check(last);
        },
        { timeout, message: what },
      )
      .toBe(true);
    return last as unknown as Doc;
  }

  /** Wait until the saved timeline is no longer `before`, and return the new one. */
  async changed(before: Doc, what = "the gesture reaches the saved timeline"): Promise<Doc> {
    const was = JSON.stringify(before);
    return this.saved((d) => JSON.stringify(d) !== was, what);
  }

  /** Wait until the saved timeline is exactly `doc` again (an undo, a refused edit). */
  async savedAs(doc: Doc, what: string, timeout?: number): Promise<Doc> {
    const want = JSON.stringify(doc);
    return this.saved((d) => JSON.stringify(d) === want, what, timeout);
  }

  /** The editor store, through the dev seam (setup only). */
  private async seam<T>(fn: string, args: unknown[] = []): Promise<T> {
    return this.page.evaluate(
      async ([name, a]) => {
        const ed = (
          window as unknown as {
            __artdaddyTest?: {
              editor: { getState(): Record<string, (...x: unknown[]) => unknown> };
            };
          }
        ).__artdaddyTest?.editor;
        if (!ed) throw new Error("the dev seam (__artdaddyTest) is not there");
        const out = await ed.getState()[name as string](...(a as unknown[]));
        return out === undefined ? null : JSON.parse(JSON.stringify(out));
      },
      [fn, args] as const,
    ) as Promise<T>;
  }

  /** UI-only state the document does not hold: the selection, the playhead, the zoom. */
  async ui(): Promise<{
    selection: string | null;
    selectedIds: string[];
    playhead: number;
    zoom: number;
  }> {
    return this.page.evaluate(() => {
      const s = (
        window as unknown as {
          __artdaddyTest: { editor: { getState(): Record<string, unknown> } };
        }
      ).__artdaddyTest.editor.getState();
      return {
        selection: (s.selection as string | null) ?? null,
        selectedIds: [...((s.selectedIds as string[]) ?? [])],
        playhead: Number(s.playhead) || 0,
        zoom: Number(s.zoom) || 0,
      };
    });
  }

  async setZoom(pxPerSec: number): Promise<void> {
    await this.seam("setZoom", [pxPerSec]);
    await expect.poll(async () => (await this.ui()).zoom).toBe(pxPerSec);
  }

  /** Put the playhead on a frame (setup). */
  async setPlayheadFrame(frame: number): Promise<void> {
    const fps = Number((await this.doc()).canvas?.fps) || 30;
    await this.seam("setPlayhead", [frame / fps]);
    await expect.poll(async () => Math.round((await this.ui()).playhead * fps)).toBe(frame);
  }

  /** The playhead's frame. */
  async playheadFrame(): Promise<number> {
    const fps = Number((await this.doc()).canvas?.fps) || 30;
    return Math.round((await this.ui()).playhead * fps);
  }

  /** Place clips at exact frames through the editor's own commands, each trimmed to `len`, and wait
   *  until they are saved and drawn. Placement overwrites, so each is trimmed before the next lands. */
  async seed(specs: Seed[]): Promise<Doc> {
    let d = await this.doc();
    for (const s of specs) {
      const ref = this.refs[s.media];
      if (!ref) throw new Error(`seed: ${s.media} was not imported`);
      await this.seam("addClip", [ref, s.track, s.at]);
      d = await this.saved(
        (x) => onTrack(x, s.track).some((c) => c.timeline_in === s.at && c.media_ref === ref),
        `seed: ${s.media} saved on ${s.track} at ${s.at}`,
      );
      if (typeof s.len !== "number") continue;
      const end = s.at + s.len;
      const c = onTrack(d, s.track).find((x) => x.timeline_in === s.at && x.media_ref === ref)!;
      if (c.timeline_out === end) continue;
      await this.seam("trimClip", [c.id, { timeline_out: end }]);
      d = await this.saved(
        (x) => onTrack(x, s.track).some((y) => y.id === c.id && y.timeline_out === end),
        `seed: ${s.media} trimmed to ${s.len} frames`,
      );
    }
    await expect(this.clips).toHaveCount(clipsOf(d).length);
    await this.seam("select", [null]);
    return d;
  }

  /** Snapping is a mode; set it with the toolbar toggle and prove it took. */
  async setSnapping(on: boolean): Promise<void> {
    const toggle = this.page.getByRole("button", { name: "snapping", exact: true });
    if ((await toggle.getAttribute("aria-pressed")) !== String(on)) await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", String(on));
  }

  /** A clip as the timeline draws it (the preview's selection box carries the same id). */
  clip(id: string): Locator {
    return this.page.locator(`[data-track-id] [data-clip-id="${id}"]`);
  }

  /** Every clip the timeline draws. */
  get clips(): Locator {
    return this.page.locator("[data-track-id] [data-clip-id]");
  }

  lane(track: string): Locator {
    return this.page.locator(`[data-track-id="${track}"]`);
  }

  async box(l: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
    const b = await l.boundingBox();
    if (!b) throw new Error("not on screen");
    return b;
  }

  /** Screen x of a timeline frame, calibrated from a drawn clip against its saved frames, so a test
   *  states frames without copying the app's own pixel arithmetic. */
  async xOf(frame: number): Promise<number> {
    const d = await this.doc();
    for (const c of clipsOf(d)) {
      const b = await this.clip(c.id).boundingBox();
      if (!b || c.timeline_out - c.timeline_in < 4) continue;
      const ppf = b.width / (c.timeline_out - c.timeline_in);
      return b.x + (frame - c.timeline_in) * ppf;
    }
    // An empty timeline: the lane starts at frame 0.
    const lane = await this.box(this.page.locator("[data-track-id]").first());
    const { zoom } = await this.ui();
    return lane.x + (frame * zoom) / (Number(d.canvas?.fps) || 30);
  }

  /** Vertical middle of a track's lane. */
  async laneY(track: string): Promise<number> {
    const b = await this.box(this.lane(track));
    return b.y + b.height / 2;
  }

  /** Press at `from`, move to `to` in small steps, release: a person's drag. */
  async drag(
    from: { x: number; y: number },
    to: { x: number; y: number },
    modifiers: Modifier[] = [],
  ): Promise<void> {
    const m = this.page.mouse;
    await m.move(from.x, from.y);
    for (const k of modifiers) await this.page.keyboard.down(k);
    await m.down();
    await m.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
    await m.move(to.x, to.y, { steps: 6 });
    await m.up();
    for (const k of modifiers) await this.page.keyboard.up(k);
  }

  /** Drag clip `id` by `frames` along its lane, or onto `toTrack`, grabbing its middle. */
  async dragClip(
    id: string,
    frames: number,
    opts: { toTrack?: string; modifiers?: Modifier[] } = {},
  ): Promise<void> {
    const c = clipsOf(await this.doc()).find((x) => x.id === id);
    if (!c) throw new Error(`no clip ${id}`);
    const mid = Math.round((c.timeline_in + c.timeline_out) / 2);
    const x0 = await this.xOf(mid);
    const y0 = await this.laneY(c.track);
    const x1 = await this.xOf(mid + frames);
    const y1 = opts.toTrack ? await this.laneY(opts.toTrack) : y0;
    await this.drag({ x: x0, y: y0 }, { x: x1, y: y1 }, opts.modifiers);
  }

  /** Grab a trim handle of clip `id` and release it at frame `to`. */
  async trimEdge(id: string, edge: "start" | "end", to: number, modifiers: Modifier[] = []) {
    const handle = this.clip(id).getByRole("separator", { name: `trim ${edge}` });
    const b = await this.box(handle);
    const y = b.y + b.height / 2;
    await this.drag({ x: b.x + b.width / 2, y }, { x: await this.xOf(to), y }, modifiers);
  }

  /** Click inside clip `id` (its middle) with a real mouse. */
  async clickClip(id: string, modifiers: Modifier[] = []): Promise<void> {
    const b = await this.box(this.clip(id));
    await this.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    for (const k of modifiers) await this.page.keyboard.down(k);
    await this.page.mouse.down();
    await this.page.mouse.up();
    for (const k of modifiers) await this.page.keyboard.up(k);
  }

  /** Right-click clip `id` and choose `item` from its menu. */
  async clipMenu(id: string, item: string): Promise<void> {
    await this.clip(id).click({ button: "right" });
    await this.page.getByRole("menuitem", { name: item, exact: true }).click();
  }

  /** Click an empty spot of a lane at a frame (a gap between clips, or past the last one). */
  async clickLane(track: string, frame: number): Promise<void> {
    await this.page.mouse.click(await this.xOf(frame), await this.laneY(track));
  }

  /** Click +V, +A or +T and return the id of the track it made. */
  async addTrack(kind: "video" | "audio" | "text"): Promise<string> {
    const had = new Set(((await this.doc()).tracks ?? []).map((t) => String(t.id)));
    await this.page.getByTitle(`Add ${kind} track`).click();
    const d = await this.saved(
      (x) => (x.tracks ?? []).some((t) => !had.has(String(t.id)) && t.kind === kind),
      `a new ${kind} track is saved`,
    );
    return String((d.tracks ?? []).find((t) => !had.has(String(t.id)))!.id);
  }

  /** The name a track shows in its header (v1, a2, ...), which its buttons are named after. */
  async label(track: string): Promise<string> {
    return this.page.evaluate((id) => {
      const lane = document.querySelector(`[data-track-id="${id}"]`);
      const del = lane?.parentElement?.querySelector('[aria-label^="delete "]');
      return (del?.getAttribute("aria-label") ?? "").replace(/^delete /, "");
    }, track);
  }

  /** A track header's button: "hide", "mute", "lock", "solo", "sync lock" or "delete". */
  async trackButton(track: string, what: string): Promise<Locator> {
    return this.page.getByRole("button", {
      name: `${what} ${await this.label(track)}`,
      exact: true,
    });
  }

  /** Press a shortcut. `Mod` is Ctrl, or Cmd on macOS. */
  async press(keys: string): Promise<void> {
    await this.page.keyboard.press(keys.replace(/\bMod\b/g, "ControlOrMeta"));
  }

  /** The next confirmation the app asks (the dialog plugin's message command) answers with the button
   *  labelled `label`; null answers as a closed dialog. */
  async answerNextDialog(label: string | null): Promise<void> {
    await this.page.evaluate((l) => {
      (window as unknown as { __qaDialogs: { answers: unknown[] } }).__qaDialogs.answers.push(l);
    }, label);
  }

  /** The confirmations the app asked so far: message and title. */
  async dialogsAsked(): Promise<Array<{ message: string; title?: string }>> {
    return this.page.evaluate(
      () =>
        (window as unknown as { __qaDialogs: { seen: Array<{ message: string; title?: string }> } })
          .__qaDialogs.seen,
    );
  }
}

/** Answers the app's confirmations (`confirm`/`ask` from the dialog plugin go through its `message`
 *  command) from a queue the test fills; with nothing queued the shell answers as a closed dialog. */
function dialogAnswers(): void {
  const w = window as unknown as {
    __TAURI_INTERNALS__?: {
      invoke: (cmd: string, args?: unknown, o?: unknown) => Promise<unknown>;
    };
    __qaDialogs?: unknown;
  };
  const inner = w.__TAURI_INTERNALS__;
  if (!inner) return;
  const original = inner.invoke;
  const answers: unknown[] = [];
  const seen: Array<{ message: string; title?: string }> = [];
  w.__qaDialogs = { answers, seen };
  inner.invoke = async (cmd, args, o) => {
    if (cmd === "plugin:dialog|message") {
      const a = (args ?? {}) as { message?: unknown; title?: unknown };
      seen.push({ message: String(a.message ?? ""), title: a.title ? String(a.title) : undefined });
      if (answers.length) return answers.shift();
    }
    return original(cmd, args, o);
  };
}

export const test = agentTest.extend<{ tl: TimelineRig }>({
  tl: async ({ qa }, use) => {
    // After the shell's own init script (registered first by the qa fixture), before the app loads.
    await qa.page.addInitScript(dialogAnswers);
    // No test here needs the internet. Importing media with sound starts the speech model's
    // download (465 MB), and on 28 Nov CI's runs fetched it although the shell routes https away
    // (`https://**`): a RegExp route, tried before the shell's, refuses every https request.
    await qa.page.route(/^https:\/\//, (route) => route.abort("internetdisconnected"));
    await use(new TimelineRig(qa));
  },
});
