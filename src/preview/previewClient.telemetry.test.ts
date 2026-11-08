// What the preview client says about itself: the first picture's time, a stretch where the picture stood still, and a video it
// could not show. The questions are whether each is said once and for the right project, whether the first-picture clock starts
// when video was first asked for (not at project open), whether an ordinary catch-up after a seek is left out, whether a stretch
// still going when the preview closes or the project changes is not lost, and whether a sink that throws can disturb the picture.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPreviewClient } from "./previewClient";
import { emptyTimeline, type Timeline } from "../timeline/model";
import type { PreviewFacts } from "../api/editorEvents";
import type { ProjectStoreAccess } from "../tools/store";

vi.mock("./fonts", () => ({ loadBundledFonts: vi.fn(async () => undefined) }));
vi.mock("./text", () => ({ rasterizeText: vi.fn(() => ({ close: () => undefined })) }));
const recorded = vi.hoisted(() => ({ calls: [] as [unknown, string][] }));
vi.mock("../api/editorEvents", async (orig) => ({
  ...(await orig<typeof import("../api/editorEvents")>()),
  recordPreview: (facts: unknown, projectId: string) => {
    recorded.calls.push([facts, projectId]);
  },
}));

type Msg = Record<string, unknown>;
class FakeWorker {
  posted: Msg[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage(msg: unknown): void {
    this.posted.push(msg as Msg);
    if ((msg as Msg).type === "probe") this.emit({ type: "capabilities", webgl2: true });
  }
  terminate(): void {}
  emit(data: unknown): void {
    this.onmessage?.({ data } as unknown as MessageEvent);
  }
}

const storeOf = (dir: string) =>
  ({
    projectDir: dir,
    resolveRef: async (src: string) => `C:/media/${src}`,
    byteSize: async () => 1024,
  }) as unknown as ProjectStoreAccess;

function timelineOf(...clips: Array<{ media_ref: string; kind: string }>): Timeline {
  return {
    ...emptyTimeline(),
    tracks: [
      {
        id: "t1",
        kind: "video",
        clips: clips.map((c, i) => ({ id: `c${i}`, timeline_in: 0, timeline_out: 10, ...c })),
      },
    ] as never,
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

let clockMs = 0;
function setup(
  options: {
    report?: (facts: PreviewFacts) => void;
    resolve?: (s: ProjectStoreAccess, src: string) => Promise<string | null>;
  } = {},
) {
  const worker = new FakeWorker();
  const canvas = { transferControlToOffscreen: () => ({}) } as unknown as HTMLCanvasElement;
  const onError = vi.fn();
  const client = createPreviewClient(canvas, {
    createWorker: () => worker as unknown as Worker,
    resolve: options.resolve ?? (async (_s, src) => `url:${src}`),
    now: () => clockMs,
    onError,
    ...(options.report ? { report: options.report } : {}),
  });
  return { worker, client, onError };
}

beforeEach(() => {
  clockMs = 1_000;
  recorded.calls = [];
});
afterEach(() => vi.restoreAllMocks());

describe("the first picture", () => {
  it("is timed from the moment video was first asked for, and said once, whatever follows", async () => {
    const said: PreviewFacts[] = [];
    const { worker, client } = setup({ report: (f) => said.push(f) });
    client.setStore(storeOf("C:/data/projects/p1"));
    client.render(timelineOf({ media_ref: "clipA", kind: "video" }), 0);
    await flush();
    clockMs += 433;
    worker.emit({ type: "firstFrame", source: "clipA" });
    worker.emit({ type: "firstFrame", source: "clipA" }); // the worker says it again whenever a source becomes visible again
    clockMs += 5_000;
    worker.emit({ type: "firstFrame", source: "clipB" });
    expect(said).toEqual([{ what: "first_frame", ms: 433 }]);
  });

  it("is not started by a timeline with no video in it: a project that gets its first clip later is timed from that clip", async () => {
    const said: PreviewFacts[] = [];
    const { worker, client } = setup({ report: (f) => said.push(f) });
    client.setStore(storeOf("C:/data/projects/p1"));
    client.render(timelineOf(), 0); // empty
    await flush();
    clockMs += 600_000; // ten minutes of hand work on nothing playable
    client.render(timelineOf({ media_ref: "clipA", kind: "video" }), 0);
    await flush();
    clockMs += 250;
    worker.emit({ type: "firstFrame", source: "clipA" });
    expect(said).toEqual([{ what: "first_frame", ms: 250 }]);
  });

  it("is not said for a picture, or for a still that is stored as video", async () => {
    const said: PreviewFacts[] = [];
    const { worker, client } = setup({
      report: (f) => said.push(f),
      resolve: async (_s, src) => `url:${src}`,
    });
    const store = storeOf("C:/data/projects/p1");
    (store as unknown as { resolveRef: (s: string) => Promise<string> }).resolveRef = async (src) =>
      `C:/media/${src}.png`;
    client.setStore(store);
    client.render(timelineOf({ media_ref: "shot", kind: "video" }), 0);
    await flush();
    clockMs += 100;
    worker.emit({ type: "firstFrame", source: "shot" });
    expect(said).toEqual([]);
  });

  it("each project has its own first picture, timed from its own first video", async () => {
    const said: PreviewFacts[] = [];
    const { worker, client } = setup({ report: (f) => said.push(f) });
    client.setStore(storeOf("C:/data/projects/p1"));
    client.render(timelineOf({ media_ref: "a", kind: "video" }), 0);
    await flush();
    clockMs += 300;
    worker.emit({ type: "firstFrame", source: "a" });
    client.setStore(storeOf("C:/data/projects/p2"));
    clockMs += 10_000;
    client.render(timelineOf({ media_ref: "b", kind: "video" }), 0);
    await flush();
    clockMs += 900;
    worker.emit({ type: "firstFrame", source: "b" });
    expect(said).toEqual([
      { what: "first_frame", ms: 300 },
      { what: "first_frame", ms: 900 },
    ]);
  });

  it("is recorded under the project it was for", async () => {
    const { worker, client } = setup();
    client.setStore(storeOf("C:/data/projects/p1"));
    client.render(timelineOf({ media_ref: "a", kind: "video" }), 0);
    await flush();
    clockMs += 120;
    worker.emit({ type: "firstFrame", source: "a" });
    expect(recorded.calls).toEqual([[{ what: "first_frame", ms: 120 }, "p1"]]);
  });
});

describe("a stretch where the picture stood still", () => {
  const withFirstPicture = async (said: PreviewFacts[]) => {
    const ctx = setup({ report: (f) => said.push(f) });
    ctx.client.setStore(storeOf("C:/data/projects/p1"));
    ctx.client.render(timelineOf({ media_ref: "a", kind: "video" }), 0);
    await flush();
    ctx.worker.emit({ type: "firstFrame", source: "a" });
    said.length = 0; // the first picture is not what is under test
    return ctx;
  };

  it("is said when it ends, with how long it was", async () => {
    const said: PreviewFacts[] = [];
    const { worker } = await withFirstPicture(said);
    worker.emit({ type: "stalled", stalled: true });
    clockMs += 2_500;
    worker.emit({ type: "stalled", stalled: false });
    expect(said).toEqual([{ what: "stall", ms: 2_500 }]);
  });

  it("is left out when it is the ordinary catching up after a seek", async () => {
    const said: PreviewFacts[] = [];
    const { worker } = await withFirstPicture(said);
    worker.emit({ type: "stalled", stalled: true });
    clockMs += 999;
    worker.emit({ type: "stalled", stalled: false });
    worker.emit({ type: "stalled", stalled: true });
    clockMs += 1_000;
    worker.emit({ type: "stalled", stalled: false });
    expect(said).toEqual([{ what: "stall", ms: 1_000 }]);
  });

  it("is not counted before the first picture: that wait is the first picture's own time", async () => {
    const said: PreviewFacts[] = [];
    const { worker, client } = setup({ report: (f) => said.push(f) });
    client.setStore(storeOf("C:/data/projects/p1"));
    client.render(timelineOf({ media_ref: "a", kind: "video" }), 0);
    await flush();
    worker.emit({ type: "stalled", stalled: true });
    clockMs += 3_000;
    worker.emit({ type: "stalled", stalled: false });
    expect(said).toEqual([]);
  });

  it("one still going when the preview closes is said then, not lost", async () => {
    const said: PreviewFacts[] = [];
    const { worker, client } = await withFirstPicture(said);
    worker.emit({ type: "stalled", stalled: true });
    clockMs += 7_000;
    client.dispose();
    expect(said).toEqual([{ what: "stall", ms: 7_000 }]);
  });

  it("one still going when the project changes belongs to the project it happened in", async () => {
    const { worker, client } = setup();
    client.setStore(storeOf("C:/data/projects/p1"));
    client.render(timelineOf({ media_ref: "a", kind: "video" }), 0);
    await flush();
    worker.emit({ type: "firstFrame", source: "a" });
    recorded.calls = [];
    worker.emit({ type: "stalled", stalled: true });
    clockMs += 4_000;
    client.setStore(storeOf("C:/data/projects/p2"));
    expect(recorded.calls).toEqual([[{ what: "stall", ms: 4_000 }, "p1"]]);
  });

  it("the playhead hold is unchanged: the owner of the stall signal still hears every edge", async () => {
    const worker = new FakeWorker();
    const onStalled = vi.fn();
    createPreviewClient(
      { transferControlToOffscreen: () => ({}) } as unknown as HTMLCanvasElement,
      {
        createWorker: () => worker as unknown as Worker,
        onStalled,
        report: () => undefined,
        now: () => clockMs,
      },
    );
    worker.emit({ type: "stalled", stalled: true });
    worker.emit({ type: "stalled", stalled: false });
    expect(onStalled.mock.calls).toEqual([[true], [false]]);
  });
});

describe("a video it could not show", () => {
  it("says why, once for a source and a reason however often the runtime repeats it", async () => {
    const said: PreviewFacts[] = [];
    const { worker } = setup({ report: (f) => said.push(f) });
    worker.emit({ type: "failure", source: "a", reason: "decoder_error", codec: "avc1" });
    worker.emit({ type: "failure", source: "a", reason: "decoder_error", codec: "avc1" });
    worker.emit({ type: "failure", source: "a", reason: "no_index", codec: "" });
    worker.emit({ type: "failure", source: "b", reason: "decoder_error", codec: "hev1" });
    expect(said).toEqual([
      { what: "failure", reason: "decoder_error", codec: "avc1" },
      { what: "failure", reason: "no_index", codec: "" },
      { what: "failure", reason: "decoder_error", codec: "hev1" },
    ]);
  });

  it("a source whose file is not there is `unresolved`, once however often it is asked again", async () => {
    const said: PreviewFacts[] = [];
    const { client } = setup({ report: (f) => said.push(f), resolve: async () => null });
    const store = storeOf("C:/data/projects/p1");
    (store as unknown as { resolveRef: (s: string) => Promise<string | null> }).resolveRef =
      async () => null; // the drive is gone
    client.setStore(store);
    client.render(timelineOf({ media_ref: "gone", kind: "video" }), 0);
    await flush();
    client.render(timelineOf({ media_ref: "gone", kind: "video" }), 1); // a second timeline object: asked again
    await flush();
    expect(said).toEqual([{ what: "failure", reason: "unresolved", codec: "" }]);
  });

  it("a source that is only waiting for its preview copy is not a failure: the file is there, and the wait is the first picture's own time", async () => {
    const said: PreviewFacts[] = [];
    let copyMade = false;
    const { worker, client } = setup({
      report: (f) => said.push(f),
      resolve: async (_s, src) => (copyMade ? `url:${src}` : null), // no URL until the smaller copy exists
    });
    client.setStore(storeOf("C:/data/projects/p1")); // its file resolves
    client.render(timelineOf({ media_ref: "phone", kind: "video" }), 0);
    await flush();
    clockMs += 4_000;
    copyMade = true;
    client.render(timelineOf({ media_ref: "phone", kind: "video" }), 0); // the copy landed and the timeline is drawn again
    await flush();
    clockMs += 300;
    worker.emit({ type: "firstFrame", source: "phone" });
    expect(said).toEqual([{ what: "first_frame", ms: 4_300 }]);
  });

  it("a file that cannot be looked for is not called gone", async () => {
    const said: PreviewFacts[] = [];
    const { client } = setup({ report: (f) => said.push(f), resolve: async () => null });
    const store = storeOf("C:/data/projects/p1");
    (store as unknown as { resolveRef: () => Promise<string | null> }).resolveRef = async () => {
      throw new Error("the filesystem did not answer");
    };
    client.setStore(store);
    client.render(timelineOf({ media_ref: "maybe", kind: "video" }), 0);
    await flush();
    expect(said).toEqual([]);
  });

  it("a project opened meanwhile is not told about another project's missing file", async () => {
    // No `report` here: this goes through the real attribution, which names the project that is open WHEN it is said.
    const { client } = setup({ resolve: async () => null });
    const waiting: Array<(path: string | null) => void> = [];
    const slow = storeOf("C:/data/projects/p1");
    (slow as unknown as { resolveRef: () => Promise<string | null> }).resolveRef = () =>
      new Promise((r) => waiting.push(r));
    client.setStore(slow);
    client.render(timelineOf({ media_ref: "gone", kind: "video" }), 0);
    await flush();
    client.setStore(storeOf("C:/data/projects/p2")); // the person moved on before the filesystem answered
    for (let round = 0; round < 3; round++) {
      for (const answer of waiting.splice(0)) answer(null);
      await flush();
    }
    expect(recorded.calls).toEqual([]);
  });

  it("a worker that fails is `worker_failed`, once, and the person is still told", async () => {
    const said: PreviewFacts[] = [];
    const { worker, onError } = setup({ report: (f) => said.push(f) });
    worker.emit({ type: "error", message: "WebGL context lost for C:/Users/me/holiday.mp4" });
    expect(said).toEqual([{ what: "failure", reason: "worker_failed", codec: "" }]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("starting over for another project lets the same trouble be said again", async () => {
    const said: PreviewFacts[] = [];
    const { worker, client } = setup({ report: (f) => said.push(f) });
    client.setStore(storeOf("C:/data/projects/p1"));
    worker.emit({ type: "failure", source: "a", reason: "decoder_error", codec: "avc1" });
    client.setStore(storeOf("C:/data/projects/p2"));
    worker.emit({ type: "failure", source: "a", reason: "decoder_error", codec: "avc1" });
    expect(said).toHaveLength(2);
  });
});

describe("a sink that throws", () => {
  it("never disturbs the picture or the person's note that the preview failed", async () => {
    const throwing = () => {
      throw new Error("the recorder is broken");
    };
    const { worker, client, onError } = setup({ report: throwing });
    client.setStore(storeOf("C:/data/projects/p1"));
    client.render(timelineOf({ media_ref: "a", kind: "video" }), 0);
    await flush();
    expect(worker.posted.some((m) => m.type === "render")).toBe(true);
    worker.emit({ type: "firstFrame", source: "a" });
    worker.emit({ type: "failure", source: "a", reason: "decoder_error", codec: "avc1" });
    worker.emit({ type: "error", message: "lost" });
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
