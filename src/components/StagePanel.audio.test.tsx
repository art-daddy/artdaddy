// Reported 2026-08-10: "sound is off when we re-open a project, until I click on the
// voice-over, then also it works sometimes only."
//
// The cause was NOT in the audio engine — every engine test passed. It was the ORDER of
// StagePanel's effects: React runs passive setups in DECLARATION order, and `reset()`
// (deps [projectId]) was declared AFTER `load()` (deps [timeline, showRendered, store]).
// On any commit where projectId + store + timeline change together — mount, and every
// project open — the sequence was setStore -> load -> reset, so reset() threw away the
// schedule load() had just built and play() had nothing to schedule. Touching the
// timeline (clicking/editing the voice-over) re-ran load() and the sound came back.
//
// An engine-level test cannot see this: the engine is correct in isolation. So this drives
// the REAL component and asserts the OUTCOME — that audio sources actually get scheduled.
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  session: null as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  active: { name: "My Reel" } as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  timeline: null as any,
  playhead: 0,
  setPlayhead: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store: { projectDir: "/p" } as any,
}));

vi.mock("./PreviewCanvas", () => ({ default: () => <div>preview</div> }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock("../store/chat", () => ({ useChat: (sel: any) => sel({ session: h.session }) }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock("../store/projects", () => ({ useProjects: (sel: any) => sel({ active: h.active }) }));
vi.mock("../store/editor", () => ({
  useEditor: Object.assign(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sel: any) =>
      sel({
        timeline: h.timeline,
        playhead: h.playhead,
        setPlayhead: h.setPlayhead,
        store: h.store,
        mediaTabs: [],
        activeMediaTab: null,
        mediaNames: {},
        setActiveMediaTab: vi.fn(),
        openMediaTab: vi.fn(),
        closeMediaTab: vi.fn(),
      }),
    { getState: () => ({ playhead: h.playhead }) },
  ),
}));
vi.mock("../preview/resolve", () => ({ resolveSourceUrl: vi.fn(async () => "blob:fake") }));

import StagePanel from "./StagePanel";
import { previewAudio } from "../preview/audioEngine";

class FakeParam {
  value = 1;
  setValueAtTime() {}
  linearRampToValueAtTime() {}
  cancelScheduledValues() {}
}
class FakeGain {
  gain = new FakeParam();
  connect<T>(next: T): T {
    return next;
  }
  disconnect() {}
}
class FakeAnalyser {
  fftSize = 2048;
  getFloatTimeDomainData(out: Float32Array) {
    out.fill(0);
  }
}
class FakeSplitter {
  connect() {}
}
class FakeSource {
  playbackRate = { value: 1 };
  buffer: unknown = null;
  loop = false;
  onended: (() => void) | null = null;
  connect<T>(next: T): T {
    return next;
  }
  disconnect() {}
  start() {}
  stop() {}
}
class FakeCtx {
  currentTime = 0;
  destination = {};
  sources: FakeSource[] = [];
  createGain() {
    return new FakeGain();
  }
  createAnalyser() {
    return new FakeAnalyser();
  }
  createChannelSplitter() {
    return new FakeSplitter();
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

/** A project whose timeline is one voice-over on an audio track. */
const withVoiceOver = {
  units: "frames",
  canvas: { width: 1080, height: 1920, fps: 30 },
  tracks: [
    {
      id: "a1",
      kind: "audio",
      z: 0,
      clips: [
        {
          id: "vo",
          kind: "audio",
          media_ref: "vo.mp3",
          timeline_in: 0,
          timeline_out: 90,
          source_in: 0,
        },
      ],
    },
  ],
};

beforeEach(() => {
  ctx = new FakeCtx();
  decoded = false;
  h.session = null;
  h.active = { name: "My Reel" };
  h.timeline = null;
  h.store = { projectDir: "/p" };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).AudioContext = function () {
    return ctx;
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) })),
  );
});

describe("StagePanel — audio survives opening a project", () => {
  it("schedules the voice-over on the FIRST play after a project opens, with nothing clicked", async () => {
    h.timeline = withVoiceOver;
    render(<StagePanel projectId="p1" />);

    const audio = previewAudio();
    expect(audio).toBeTruthy();
    // decode() is fire-and-forget; the buffer has to land before play() can schedule.
    await vi.waitFor(() => expect(decoded).toBe(true));

    audio!.play(0);
    // The OUTCOME: a real source node was created and started. Zero sources means the
    // user pressed play and heard silence.
    expect(ctx.sources.length).toBeGreaterThan(0);
  });

  it("still drops the previous project's audio when the project actually changes", async () => {
    h.timeline = withVoiceOver;
    const view = render(<StagePanel projectId="p1" />);
    await vi.waitFor(() => expect(decoded).toBe(true));

    // Project 2 has no audio at all. Nothing from project 1 may survive the switch.
    h.timeline = { units: "frames", canvas: { width: 1080, height: 1920, fps: 30 }, tracks: [] };
    h.store = { projectDir: "/p2" };
    view.rerender(<StagePanel projectId="p2" />);

    const audio = previewAudio();
    ctx.sources.length = 0;
    audio!.play(0);
    expect(ctx.sources.length).toBe(0);
  });
});
