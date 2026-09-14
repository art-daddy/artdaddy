// The preview's audio scheduling — the module that has now silently emitted the wrong thing
// TWICE with a fully green suite: S7 (it honoured neither `disabled` nor `solo`) and the volume
// envelope (it played keyframe[0] flat for the whole clip). Both survived because nothing here
// was tested at all. These drive the real class through a fake AudioContext and assert what was
// SCHEDULED, not what the code says it does.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PreviewAudio, setPreviewAudioRunner } from "./audioEngine";
import { resolveSourceUrl } from "./resolve";
import { useProjectNotice } from "../store/projectNotice";
import type { Timeline } from "../timeline/model";

vi.mock("./resolve", () => ({ resolveSourceUrl: vi.fn(async () => "blob:fake") }));

interface Ramp {
  kind: "set" | "ramp";
  value: number;
  time: number;
}

class FakeParam {
  events: Ramp[] = [];
  value = 1;
  setValueAtTime(value: number, time: number) {
    this.events.push({ kind: "set", value, time });
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.events.push({ kind: "ramp", value, time });
  }
  cancelScheduledValues() {}
}

class FakeGain {
  gain = new FakeParam();
  connections: unknown[] = [];
  connect<T>(next: T): T {
    this.connections.push(next);
    return next;
  }
  disconnect() {
    this.connections = [];
  }
}

class FakeAnalyser {
  fftSize = 2048;
  /** The block the engine will read; tests set it to fake a signal. */
  block: number[] = [];
  getFloatTimeDomainData(out: Float32Array) {
    for (let i = 0; i < out.length; i++) out[i] = this.block[i] ?? 0;
  }
}

class FakeSplitter {
  outputs: Array<[unknown, number]> = [];
  connect(next: unknown, ch: number) {
    this.outputs.push([next, ch]);
  }
}

class FakeSource {
  playbackRate = { value: 1 };
  buffer: unknown = null;
  loop = false;
  onended: (() => void) | null = null;
  started: Array<[number, number, number | undefined]> = [];
  connect<T>(next: T): T {
    return next;
  }
  disconnect() {}
  start(when: number, offset: number, dur?: number) {
    this.started.push([when, offset, dur]);
  }
  stop() {}
}

class FakeCtx {
  currentTime = 0;
  destination = {};
  gains: FakeGain[] = [];
  sources: FakeSource[] = [];
  analysers: FakeAnalyser[] = [];
  splitters: FakeSplitter[] = [];
  /** Set false to model a browser (or a test env) with no analyser support. */
  meteringSupported = true;
  createGain() {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createAnalyser() {
    if (!this.meteringSupported) throw new Error("no analyser");
    const a = new FakeAnalyser();
    this.analysers.push(a);
    return a;
  }
  createChannelSplitter() {
    if (!this.meteringSupported) throw new Error("no splitter");
    const s = new FakeSplitter();
    this.splitters.push(s);
    return s;
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  decodeAudioData() {
    decoded = true;
    return Promise.resolve({ duration: 10, sampleRate: 48000 });
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}

let ctx: FakeCtx;
let decoded = false;

beforeEach(() => {
  ctx = new FakeCtx();
  decoded = false;
  useProjectNotice.getState().clear();
  // Default to "no ffmpeg": these suites test the decode/scheduling maths, and letting
  // platform detection pick the path would make them agree with whatever it returned.
  setPreviewAudioRunner(async () => null);
  vi.mocked(resolveSourceUrl).mockClear();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).AudioContext = function () {
    return ctx;
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) })),
  );
});

const timeline = (clip: Record<string, unknown>): Timeline =>
  ({
    units: "frames",
    canvas: { width: 1920, height: 1080, fps: 30 },
    tracks: [{ id: "a1", kind: "audio", z: 0, clips: [{ id: "c1", media_ref: "m.mp3", ...clip }] }],
  }) as unknown as Timeline;

async function load(clip: Record<string, unknown>) {
  const audio = new PreviewAudio();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  audio.setStore({ projectDir: "/p" } as any);
  audio.load(timeline(clip));
  return audio;
}

async function play(clip: Record<string, unknown>, fromSec = 0) {
  const audio = await load(clip);
  // decode() is fire-and-forget; the buffer has to land before play() can schedule anything.
  await vi.waitFor(() => expect(decoded).toBe(true));
  audio.play(fromSec);
  return audio;
}

/** Every gain schedule in the graph, newest first — the envelope node is created per clip. */
const schedules = () => ctx.gains.map((g) => g.gain.events).filter((e) => e.length > 0);

/** Fill an analyser's block with a steady tone so a read reports that peak. */
const feed = (a: FakeAnalyser, amplitude: number) => {
  a.block = Array.from({ length: a.fftSize }, (_, i) => (i % 2 ? amplitude : -amplitude));
};

describe("preview audio — metering", () => {
  const twoTracks = (): Timeline =>
    ({
      units: "frames",
      canvas: { width: 1920, height: 1080, fps: 30 },
      tracks: [
        {
          id: "a1",
          kind: "audio",
          z: 0,
          clips: [
            {
              id: "c1",
              media_ref: "m.mp3",
              kind: "audio",
              timeline_in: 0,
              timeline_out: 60,
              source_in: 0,
              source_out: 60,
            },
          ],
        },
        {
          id: "a2",
          kind: "audio",
          z: 1,
          clips: [
            {
              id: "c2",
              media_ref: "m.mp3",
              kind: "audio",
              timeline_in: 0,
              timeline_out: 60,
              source_in: 0,
              source_out: 60,
            },
          ],
        },
      ],
    }) as unknown as Timeline;

  const playTracks = async () => {
    const audio = new PreviewAudio();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    audio.setStore({ projectDir: "/p" } as any);
    audio.load(twoTracks());
    await vi.waitFor(() => expect(decoded).toBe(true));
    audio.play(0);
    return audio;
  };

  it("reports a level for EVERY sounding track, keyed by track id", async () => {
    const audio = await playTracks();
    const lv = audio.levels();
    expect(Object.keys(lv.tracks).sort()).toEqual(["a1", "a2"]);
  });

  it("reads each track's OWN level, not a shared one", async () => {
    // The failure this guards: one analyser reused for every lane, so all meters move together.
    const audio = await playTracks();
    // Analysers are created master-first, then one pair per track in play order.
    const [, , a1L, , a2L] = ctx.analysers;
    feed(a1L, 0.5);
    feed(a2L, 0.1);
    const lv = audio.levels();
    expect(lv.tracks.a1[0]).toBeCloseTo(0.5, 6);
    expect(lv.tracks.a2[0]).toBeCloseTo(0.1, 6);
  });

  it("meters left and right separately, so a hard-panned signal is not averaged away", async () => {
    const audio = await playTracks();
    const [mL, mR] = ctx.analysers;
    feed(mL, 0.8);
    feed(mR, 0);
    const lv = audio.levels();
    expect(lv.master[0]).toBeCloseTo(0.8, 6);
    expect(lv.master[1]).toBe(0);
  });

  it("falls silent when paused instead of freezing at the last reading", async () => {
    const audio = await playTracks();
    feed(ctx.analysers[0], 0.9);
    expect(audio.levels().master[0]).toBeCloseTo(0.9, 6);
    audio.pause();
    expect(audio.levels()).toEqual({ master: [0, 0], tracks: {} });
  });

  it("drops track buses on reset, so meters do not survive a project switch", async () => {
    const audio = await playTracks();
    expect(Object.keys(audio.levels().tracks)).toHaveLength(2);
    audio.reset();
    audio.play(0);
    expect(audio.levels().tracks).toEqual({});
  });

  // The failure direction: metering is a branch off the audio path, never in series.
  it("still plays audio when the browser gives us no analyser at all", async () => {
    ctx.meteringSupported = false;
    const audio = await playTracks();
    expect(ctx.sources.length).toBeGreaterThan(0);
    expect(ctx.sources.every((s) => s.started.length > 0)).toBe(true);
    expect(audio.levels().master).toEqual([0, 0]);
  });
});

describe("preview audio — volume envelope", () => {
  it("schedules a RAMP for a keyframed volume, not one flat level", async () => {
    // The bug: `sampleVolume` returned keyframe[0].v and the whole clip played at it, so a
    // duck-under-the-voice curve was audible as a constant. Assert the curve's LATER value
    // appears as a scheduled ramp — a flat level cannot satisfy this.
    await play({
      kind: "audio",
      timeline_in: 0,
      timeline_out: 60,
      source_in: 0,
      source_out: 60,
      volume: [
        { t: 0, v: 1 },
        { t: 30, v: 0.25 },
      ],
    });
    const ramps = schedules()
      .flat()
      .filter((e) => e.kind === "ramp");
    expect(ramps.some((r) => Math.abs(r.value - 0.25) < 1e-6)).toBe(true);
  });

  it("the ramp lands at the keyframe's TIME, not the clip's start", async () => {
    // A schedule that fires every ramp at t=0 would satisfy the test above while being
    // audibly wrong. 30 frames at 30fps = 1s after the clip begins.
    await play({
      kind: "audio",
      timeline_in: 0,
      timeline_out: 60,
      source_in: 0,
      source_out: 60,
      volume: [
        { t: 0, v: 1 },
        { t: 30, v: 0.25 },
      ],
    });
    const ramp = schedules()
      .flat()
      .find((e) => e.kind === "ramp" && Math.abs(e.value - 0.25) < 1e-6);
    const start = schedules().flat()[0].time;
    expect(ramp && ramp.time - start).toBeCloseTo(1, 3);
  });

  it("a CONSTANT volume still schedules that constant, and no envelope ramp", async () => {
    // The failure direction: the envelope path must not hijack the ordinary case.
    await play({
      kind: "audio",
      timeline_in: 0,
      timeline_out: 60,
      source_in: 0,
      source_out: 60,
      volume: 0.4,
    });
    const all = schedules().flat();
    expect(all.some((e) => Math.abs(e.value - 0.4) < 1e-6)).toBe(true);
  });

  it("starting mid-clip seeds the level the curve has already reached", async () => {
    // Scrubbing into the middle of a duck must not restart at the first keyframe's value.
    await play(
      {
        kind: "audio",
        timeline_in: 0,
        timeline_out: 60,
        source_in: 0,
        source_out: 60,
        volume: [
          { t: 0, v: 1 },
          { t: 60, v: 0 },
        ],
      },
      1, // one second in: halfway down the ramp
    );
    const first = schedules().flat()[0];
    expect(first.value).toBeCloseTo(0.5, 2);
  });
});

describe("preview audio — what plays at all", () => {
  it("a DISABLED clip is never even decoded, let alone scheduled (S7)", async () => {
    const audio = await load({
      kind: "audio",
      timeline_in: 0,
      timeline_out: 60,
      source_in: 0,
      source_out: 60,
      disabled: true,
    });
    audio.play(0);
    expect(decoded).toBe(false);
    expect(ctx.sources.length).toBe(0);
  });

  it("...and an enabled one does — the guard is not just refusing everything", async () => {
    await play({ kind: "audio", timeline_in: 0, timeline_out: 60, source_in: 0, source_out: 60 });
    expect(ctx.sources.length).toBeGreaterThan(0);
  });
});

// The bug the user hit: the schedule was built and then thrown away by a teardown that
// ran for the project that had just been LOADED. The rule that makes that unrepresentable
// is that the teardown is keyed on the project, so announcing the current project again —
// in any order, any number of times — cannot cost you your audio.
describe("preview audio — binding to a project", () => {
  const anAudioClip = {
    kind: "audio",
    timeline_in: 0,
    timeline_out: 60,
    source_in: 0,
    source_out: 60,
  };

  /** Bind, feed, load — the order StagePanel uses when a project opens. */
  async function opened(projectId: string) {
    const audio = new PreviewAudio();
    audio.setProject(projectId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    audio.setStore({ projectDir: "/p" } as any);
    audio.load(timeline(anAudioClip));
    await vi.waitFor(() => expect(decoded).toBe(true));
    return audio;
  }

  it("re-announcing the SAME project keeps the schedule, whenever it arrives", async () => {
    const audio = await opened("p1");
    audio.setProject("p1");
    audio.setProject("p1"); // late, duplicated — still must not disarm the engine
    audio.play(0);
    expect(ctx.sources.length).toBeGreaterThan(0);
  });

  it("but a DIFFERENT project does drop it — the binding is not just ignoring resets", async () => {
    const audio = await opened("p1");
    audio.play(0);
    expect(ctx.sources.length).toBeGreaterThan(0);
    ctx.sources.length = 0;
    audio.setProject("p2");
    audio.play(0);
    expect(ctx.sources.length).toBe(0);
    expect(audio.levels().tracks).toEqual({});
  });
});

// The invariant: preview audio costs the CLIP'S WINDOW, never the source file. ffmpeg
// extracts just that span, so a multi-GB recording is playable rather than refused.
describe("preview audio — conformed to the clip window", () => {
  const clip = { kind: "audio", timeline_in: 30, timeline_out: 90, source_in: 60, source_out: 120 };
  let ran: string[][] = [];

  /** A store whose files all exist once ffmpeg "wrote" them, over a multi-GB source. */
  const bigStore = () => {
    const written = new Set<string>();
    return {
      store: {
        projectDir: "/p",
        resolveRef: async (r: string) => (r.startsWith("/p/") ? r : `C:/Downloads/${r}`),
        byteSize: async () => 1_840_198_666,
        prepareArtifact: async (rel: string) => `/p/internals/cache/${rel}`,
        exists: async (p: string) => written.has(p),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      written,
    };
  };

  beforeEach(() => {
    ran = [];
  });

  it("extracts ONLY the clip's span and plays that, for a source far too big to load", async () => {
    const { store, written } = bigStore();
    setPreviewAudioRunner(
      async () =>
        ({
          run: async (_p: string, args: string[]) => {
            ran.push(args);
            written.add(args[args.length - 1]); // ffmpeg produced the wav
            return { code: 0, stdout: "", stderr: "" };
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
    );
    const audio = new PreviewAudio();
    audio.setStore(store);
    audio.load(timeline(clip));
    await vi.waitFor(() => expect(decoded).toBe(true));
    audio.play(0);

    // The OUTCOME: it played, and the multi-GB source was never fetched — only the extract.
    expect(ctx.sources.length).toBeGreaterThan(0);
    expect(useProjectNotice.getState().message).toBeNull();
    const refs = vi.mocked(resolveSourceUrl).mock.calls.map((c) => String(c[1]));
    expect(refs).toHaveLength(1);
    expect(refs[0]).toContain("/internals/cache/preview/audio_");
    expect(refs[0]).not.toContain("m.mp3");
    // ...and it asked ffmpeg for the clip's 2s window (source 60..120 frames @30fps), not the file.
    expect(ran).toHaveLength(1);
    expect(ran[0][ran[0].indexOf("-ss") + 1]).toBe("2.000");
    expect(ran[0][ran[0].indexOf("-t") + 1]).toBe("2.000");
  });

  it("reuses one extract for two clips on the same window, and re-extracts for a different one", async () => {
    const { store, written } = bigStore();
    setPreviewAudioRunner(
      async () =>
        ({
          run: async (_p: string, args: string[]) => {
            ran.push(args);
            written.add(args[args.length - 1]);
            return { code: 0, stdout: "", stderr: "" };
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
    );
    const audio = new PreviewAudio();
    audio.setStore(store);
    audio.load(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {
        units: "frames",
        canvas: { width: 1920, height: 1080, fps: 30 },
        tracks: [
          {
            id: "a1",
            kind: "audio",
            z: 0,
            clips: [
              { id: "c1", media_ref: "m.mp3", ...clip },
              { id: "c2", media_ref: "m.mp3", ...clip, timeline_in: 200, timeline_out: 260 },
              { id: "c3", media_ref: "m.mp3", ...clip, source_in: 300, source_out: 360 },
            ],
          },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    );
    await vi.waitFor(() => expect(ran.length).toBe(2)); // two DISTINCT windows, not three clips
  });

  it("a span with no audio is silent, not a retry loop", async () => {
    const { store } = bigStore();
    setPreviewAudioRunner(
      async () =>
        ({
          // ffmpeg fails / writes nothing: the source has no audio track.
          run: async (_p: string, args: string[]) => {
            ran.push(args);
            return { code: 1, stdout: "", stderr: "no audio" };
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
    );
    const audio = new PreviewAudio();
    audio.setStore(store);
    audio.load(timeline(clip));
    await vi.waitFor(() => expect(ran.length).toBe(1));
    audio.play(0);
    expect(ctx.sources.length).toBe(0);
    expect(decoded).toBe(false);
  });
});

// The web build has no ffmpeg to conform with, so it still decodes the source whole and the
// size ceiling is what stops an oversized one taking the tab down.
describe("preview audio — no ffmpeg to conform with", () => {
  beforeEach(() => setPreviewAudioRunner(async () => null));

  const huge = { kind: "audio", timeline_in: 0, timeline_out: 60, source_in: 0, source_out: 60 };
  const storeWith = (size: number | null) =>
    ({
      projectDir: "/p",
      resolveRef: async () => "C:/Users/me/Downloads/Screen-Recording (2).mp4",
      byteSize: async () => size,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

  it("never fetches a source too large to hold in memory", async () => {
    const audio = new PreviewAudio();
    audio.setStore(storeWith(1_840_198_666));
    audio.load(timeline(huge));
    await vi.waitFor(() => expect(useProjectNotice.getState().message).toBeTruthy());
    // The OUTCOME: the bytes were never requested, so nothing could blow up allocating them.
    expect(fetch).not.toHaveBeenCalled();
    expect(decoded).toBe(false);
    audio.play(0);
    expect(ctx.sources.length).toBe(0);
    // ...and the user is TOLD, because unexplained silence is the worse failure.
    expect(useProjectNotice.getState().message).toContain("Screen-Recording (2).mp4");
    expect(useProjectNotice.getState().message).toContain("exports normally");
  });

  it("...and an ordinary file is still fetched and played — the ceiling is not refusing everything", async () => {
    const audio = new PreviewAudio();
    audio.setStore(storeWith(12_000_000));
    audio.load(timeline(huge));
    await vi.waitFor(() => expect(decoded).toBe(true));
    audio.play(0);
    expect(ctx.sources.length).toBeGreaterThan(0);
    expect(useProjectNotice.getState().message).toBeNull();
  });

  // A store that cannot answer must not be read as "small" — but it must not block preview
  // for every platform without stat either. Unknown proceeds, deliberately.
  it("an unknown size still plays, so a platform without stat is not silenced", async () => {
    const audio = new PreviewAudio();
    audio.setStore(storeWith(null));
    audio.load(timeline(huge));
    await vi.waitFor(() => expect(decoded).toBe(true));
    audio.play(0);
    expect(ctx.sources.length).toBeGreaterThan(0);
  });
});
