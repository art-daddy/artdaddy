// Old projects still open: every project an older release saved opens in this build with what it held.
//
// Each folder under __fixtures__/goldenProjects/<release>/ was WRITTEN BY THAT RELEASE'S OWN CODE (its
// README says how): the app-data folder as the app left it on a Windows PC, two projects in it. The
// releases kept are the first of each format the app has written (generated for every release whose
// source was available to build; the rest wrote one of these, listed in each golden.json under
// sameFormatAs), plus the release people run today.
//
// The test does what this build does after an update, through the same calls the window makes: the
// data folder is already where the app's startup move put it (an Akaru-era folder under ArtDaddy, its
// registry still naming the old folder), the project list is refreshed, a project is opened by the
// projects store and loaded by the editor. It then checks what the person made, as the old release's
// own steps made it, and that opening wrote nothing over their files.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { stopHeartbeat } from "../api/appEvents";
import { setProjectStoreFactory, setRunnerFactory, useEditor } from "../store/editor";
import { useProjectNotice } from "../store/projectNotice";
import { useProjects } from "../store/projects";
import type { Clip, Timeline, Track } from "../timeline/model";
import { validateTimeline } from "../timeline/validate";
import { ProjectDisk } from "../test/projectDisk";
import { INTERNAL_DIR, joinPath, ProjectStoreAccess } from "./store";

const APPDATA = "C:/Users/golden/AppData/Roaming";
const DATA_ROOT = `${APPDATA}/ArtDaddy`;

const disk = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@tauri-apps/api/path", async (orig) => ({
  ...(await orig<typeof import("@tauri-apps/api/path")>()),
  dataDir: async () => "C:/Users/golden/AppData/Roaming",
}));
vi.mock("@tauri-apps/api/core", async (orig) => ({
  ...(await orig<typeof import("@tauri-apps/api/core")>()),
  invoke: async (cmd: string) => {
    if (cmd === "get_env") return null; // no ARTDADDY_DATA_DIR / _PROJECTS_DIR override
    throw new Error(`no desktop bridge in this test: ${cmd}`);
  },
}));
vi.mock("@tauri-apps/plugin-fs", async (orig) => ({
  ...(await orig<typeof import("@tauri-apps/plugin-fs")>()),
  readTextFile: (path: string) => (disk.current as ProjectDisk).readTextFile(path),
}));
vi.mock("./tauri", async (orig) => ({
  ...(await orig<typeof import("./tauri")>()),
  TauriFs: class {
    constructor() {
      return disk.current as ProjectDisk;
    }
  },
}));

const GOLDEN = join(__dirname, "__fixtures__", "goldenProjects");
const RELEASES = readdirSync(GOLDEN, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort((a, b) => {
    const [x, y] = [a, b].map((v) => v.split(".").map(Number));
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });

interface GoldenProject {
  id: string;
  name: string;
  dir: string;
  clips: Record<string, string | string[]>;
  readBack: {
    project: { ok: boolean; data: Record<string, unknown> };
    timeline: Timeline;
    library: Array<Record<string, unknown>>;
  };
}
interface Golden {
  release: string;
  commit: string;
  sameFormatAs: string[];
  features: string[];
  dataFolder: string;
  linkedOutsideProject: string;
  media: Record<string, { id: string; kind: string; seconds: number }>;
  projects: [GoldenProject, GoldenProject];
  files: string[];
}

function goldenOf(release: string): Golden {
  return JSON.parse(readFileSync(join(GOLDEN, release, "golden.json"), "utf8")) as Golden;
}

/** The data folder as this build finds it after an update: the startup move has put an Akaru-era
 *  folder under ArtDaddy, and projects.json still names the folder it was written in. */
function mount(release: string, g: Golden): ProjectDisk {
  const d = new ProjectDisk();
  d.mount(join(GOLDEN, release, "appdata", g.dataFolder), DATA_ROOT);
  disk.current = d;
  return d;
}

/** Where a project of the golden lives now (the folder moved with the data root, the id did not). */
const nowDir = (p: GoldenProject) => `${DATA_ROOT}/projects/${p.id}`;

/** The project's own documents: what an open must never rewrite. */
const documents = (dir: string) =>
  ["project.json", "timeline.json", "library.json"].map((f) => joinPath(dir, INTERNAL_DIR, f));

function trackOf(tl: Timeline, clipId: string): Track {
  const t = tl.tracks.find((tr) => (tr.clips ?? []).some((c) => c.id === clipId));
  if (!t) throw new Error(`clip ${clipId} is not on the timeline`);
  return t;
}
function clipOf(tl: Timeline, clipId: string): Clip {
  return trackOf(tl, clipId).clips!.find((c) => c.id === clipId)!;
}

async function openInEditor(id: string): Promise<{ outcome: string; timeline: Timeline | null }> {
  const outcome = await useEditor.getState().load(id);
  return { outcome, timeline: useEditor.getState().timeline };
}

beforeEach(() => {
  setProjectStoreFactory((dir) => new ProjectStoreAccess(dir, disk.current as ProjectDisk));
  setRunnerFactory(() => ({
    run: async () => ({ code: 1, stdout: "", stderr: "no media tools in this test" }),
  }));
  useProjects.setState({ projects: [], activeId: null, active: null, loading: false, error: null });
  useProjectNotice.getState().clear();
});
afterEach(() => {
  useEditor.getState().dispose();
  stopHeartbeat();
});

describe("golden projects: what each release wrote is what was generated", () => {
  it("covers every format, oldest first, each folder written by the release it is named after", () => {
    expect(RELEASES[0]).toBe("0.2.0"); // the first build that could update itself
    for (const r of RELEASES) {
      const g = goldenOf(r);
      expect(g.release).toBe(r);
      expect(g.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(g.sameFormatAs[0]).toBe(r);
      // Every file the release wrote is in the folder, byte for byte as the generator saved it.
      for (const f of g.files)
        expect(() => readFileSync(join(GOLDEN, r, "appdata", ...f.split("/")))).not.toThrow();
    }
  });
});

describe.each(RELEASES)("a project saved by %s", (release) => {
  const g = goldenOf(release);
  const [main, titleOnly] = g.projects;
  const c = main.clips as Record<string, string> & { interview: string[] };
  const ids = Object.fromEntries(Object.entries(g.media).map(([name, m]) => [name, m.id]));

  it("is listed after the update, the one last open first, and the old data folder's paths are followed", async () => {
    mount(release, g);
    await useProjects.getState().refresh();
    const s = useProjects.getState();
    expect(s.error).toBeNull();
    expect(s.projects.map((p) => [p.id, p.name])).toEqual([
      [main.id, main.name],
      [titleOnly.id, titleOnly.name],
    ]);
    expect(s.activeId).toBe(main.id);
    // A registry written under the Akaru folder is re-pointed at the folder the project is in now.
    expect(s.projects.map((p) => p.path)).toEqual([nowDir(main), nowDir(titleOnly)]);
  });

  it("opens with its settings and the timeline it held, and nothing it wrote is rewritten", async () => {
    const d = mount(release, g);
    await useProjects.getState().refresh();
    const before = documents(nowDir(main)).map((p) => d.bytes(p));
    expect(before.every((b) => b !== undefined)).toBe(true);

    const summary = await useProjects.getState().open(main.id);
    expect(summary.name).toBe(main.name);
    expect(summary.path).toBe(nowDir(main));
    expect(summary.settings).toEqual(main.readBack.project.data.settings);
    expect(summary.settings.canvas).toEqual({ width: 1920, height: 1080, fps: 30 });

    const { outcome, timeline } = await openInEditor(main.id);
    expect(outcome).toBe("loaded");
    const tl = timeline!;
    // Everything the release itself read back when it reopened the project, and nothing else.
    expect(tl).toEqual(main.readBack.timeline);
    expect(validateTimeline(tl)).toEqual([]);

    // What the person made, step by step, as the generator asked the old release to make it.
    expect(tl.canvas).toEqual({ width: 1920, height: 1080, fps: 30 });
    const [firstHalf, firstAudio] = c.interview;
    const halves = trackOf(tl, firstHalf).clips!.filter(
      (x) => x.media_ref === ids["interview.mp4"],
    );
    expect(halves.map((x) => [x.timeline_in, x.timeline_out, x.source_in, x.source_out])).toEqual([
      [0, 60, 60, 120],
      [60, 150, 120, 210],
    ]);
    for (const h of halves) expect(h.color).toEqual({ brightness: 0.1, saturation: 1.2 });
    const voice = trackOf(tl, firstAudio).clips!.filter(
      (x) => x.media_ref === ids["interview.mp4"],
    );
    expect(voice.map((x) => [x.timeline_in, x.timeline_out, x.link_group])).toEqual(
      halves.map((h) => [h.timeline_in, h.timeline_out, h.link_group]),
    );
    const broll = clipOf(tl, c.broll);
    expect([broll.timeline_in, broll.timeline_out, broll.opacity]).toEqual([150, 240, 0.8]);
    expect(broll.transform).toEqual({ position: { x: 0.1, y: -0.1 }, scale: 1.2 });
    expect(broll.transition_in).toEqual({ kind: "crossfade", duration: 12 });
    expect(broll.effects).toEqual([{ type: "vignette", params: { vignette: 0.4 } }]);
    const logo = clipOf(tl, c.logo);
    expect(trackOf(tl, c.logo).id).toBe(c.overlayTrack);
    expect(logo.opacity).toEqual([
      { t: 0, v: 0 },
      { t: 20, v: 1, ease: "ease-out" },
    ]);
    if (g.features.includes("hold"))
      expect(logo.transform?.scale).toEqual([
        { t: 0, v: 1 },
        { t: 60, v: 1.1, ease: "hold" },
      ]);
    if (g.features.includes("stretch")) expect(logo.fit).toBe("stretch");
    const music = clipOf(tl, c.music);
    expect([music.timeline_in, music.timeline_out, music.volume]).toEqual([0, 240, 0.5]);
    expect(music.fade).toEqual({ in: 15, out: 30 });
    expect(trackOf(tl, c.music).mute).toBe(true);
    // Linked media whose file is not on this PC stays on the timeline (it is offline, not gone).
    const drone = clipOf(tl, c.drone);
    expect([
      drone.media_ref,
      drone.timeline_in,
      drone.timeline_out,
      drone.source_in,
      drone.source_out,
    ]).toEqual([ids["drone.mp4"], 240, 300, 30, 90]);
    expect(clipOf(tl, c.title).content).toEqual([{ text: `Golden ${release}` }]);
    // The empty starter lanes of the 4-track era are the person's tracks too: none is dropped.
    expect(tl.tracks.map((t) => t.id)).toEqual(main.readBack.timeline.tracks.map((t) => t.id));

    // The library: every row, and the owned files are the project's own copies.
    const store = useEditor.getState().store!;
    expect(await store.listClips()).toEqual(main.readBack.library);
    for (const name of ["interview.mp4", "broll.mov", "music.mp3", "logo.png"]) {
      const resolved = await store.resolveRef(ids[name]);
      expect(resolved).toBe(
        joinPath(nowDir(main), "library", `${ids[name]}${name.slice(name.lastIndexOf("."))}`),
      );
    }
    expect(
      await store.isOffline((await store.listClips()).find((r) => r.id === ids["drone.mp4"])!),
    ).toBe(true);

    // Opening wrote nothing over the person's files, and set nothing aside.
    expect(documents(nowDir(main)).map((p) => d.bytes(p))).toEqual(before);
    expect([...d.files.keys()].filter((k) => k.includes(".corrupt-"))).toEqual([]);
  });

  it("its other project, a title on an otherwise empty timeline, opens as it was", async () => {
    const d = mount(release, g);
    await useProjects.getState().refresh();
    const before = documents(nowDir(titleOnly)).map((p) => d.bytes(p));
    const summary = await useProjects.getState().open(titleOnly.id);
    expect(summary.settings).toEqual(titleOnly.readBack.project.data.settings);
    const { outcome, timeline } = await openInEditor(titleOnly.id);
    expect(outcome).toBe("loaded");
    expect(timeline).toEqual(titleOnly.readBack.timeline);
    expect(clipOf(timeline!, titleOnly.clips.title as string)).toMatchObject({
      timeline_in: 15,
      timeline_out: 60,
      content: [{ text: "Only words" }],
    });
    // "Auto": nobody chose the canvas yet, so the first video placed must still be allowed to.
    if (g.features.includes("auto")) expect(timeline!.canvas_auto).toBe(true);
    else expect(timeline!.canvas_auto).toBeUndefined();
    expect(documents(nowDir(titleOnly)).map((p) => d.bytes(p))).toEqual(before);
  });
});
