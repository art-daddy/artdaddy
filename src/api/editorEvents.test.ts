// What a person does in the editor: held for a minute, sent as one flush, and never anything but words and numbers.
//
// The questions worth testing are not "does a POST happen". They are: is every action counted exactly once in exactly one
// flush however the actions fall across minutes (conservation); does a sign-out or a different account mean what was held is
// never sent (and never under the next account, even when the request was already on its way); can anything a person named,
// typed or showed reach the wire whatever a caller passes in; does a burst say that it outran the minute instead of hiding it;
// and are the app's words the server's (the server's tests read this file for that).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

const hoisted = vi.hoisted(() => ({
  gate: Promise.resolve() as Promise<void>,
  session: true,
}));

vi.mock("./config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config")>()),
  apiBase: () => "https://example.invalid",
}));
vi.mock("./auth", () => ({
  hasSession: async () => hoisted.session,
  authedFetch: async (
    url: string,
    init: RequestInit = {},
    send: (url: string, init: RequestInit) => Promise<Response> = (target, request) =>
      fetch(target, request),
  ) => {
    await hoisted.gate;
    return send(url, init);
  },
}));
vi.mock("../platform/host", () => ({
  hostInfo: () => ({ os: "windows", arch: "x86_64" }),
  resolveHostInfo: async () => undefined,
}));

import {
  __heldEditorItems,
  __resetEditorEvents,
  bandMegabytes,
  bandSeconds,
  codecName,
  EDIT_KINDS,
  EDITOR_EVENT_KINDS,
  flushEditorEvents,
  flushEditorEventsForExit,
  IMPORT_DOORS,
  IMPORT_REASONS,
  MAX_EDITOR_COUNT,
  MAX_EDITOR_ITEMS,
  MAX_EDITOR_MS,
  MEDIA_KINDS,
  PREVIEW_FAILURES,
  PREVIEW_WHATS,
  PROXY_STATES,
  recordEdit,
  recordImport,
  recordMedia,
  recordPreview,
  type EditKind,
} from "./editorEvents";
import { useAuth } from "../store/auth";

interface Posted {
  url: string;
  body: {
    events: Record<string, unknown>[];
    project_id: string;
    dropped?: number;
    os: string;
    arch: string;
    app_version: string;
    sent_at: number;
  };
}
const posted: Posted[] = [];

/** Let every promise the flush chains through settle (the timers are fake, the microtasks are not). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const START = new Date("2026-11-08T10:00:00Z").getTime();
const editsOf = (p: Posted): Record<string, number> =>
  Object.assign({}, ...p.body.events.filter((e) => e.kind === "edits").map((e) => e.counts));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  __resetEditorEvents();
  hoisted.gate = Promise.resolve();
  hoisted.session = true;
  useAuth.setState({ status: "unlocked", profile: null, hasStoredSession: true });
  posted.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: string }) => {
      posted.push({ url, body: JSON.parse(init.body) });
      return { ok: true } as Response;
    }),
  );
});

afterEach(() => {
  __resetEditorEvents();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a window of hand edits", () => {
  it("is sent once, a minute after its first action, as counts by kind", async () => {
    recordEdit("move", "p1");
    await vi.advanceTimersByTimeAsync(20_000);
    recordEdit("move", "p1");
    recordEdit("trim", "p1");
    await vi.advanceTimersByTimeAsync(39_000);
    expect(posted).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(posted).toHaveLength(1);
    const [only] = posted;
    expect(only.url).toBe("https://example.invalid/telemetry/editor");
    expect(only.body.project_id).toBe("p1");
    expect(only.body.events).toEqual([
      { kind: "edits", at: START / 1000, window_s: 60, counts: { move: 2, trim: 1 } },
    ]);
    expect(only.body).toMatchObject({ os: "windows", arch: "x86_64" });
    expect(typeof only.body.sent_at).toBe("number");
  });

  it("says when it began, so a session's story has real times in it", async () => {
    vi.setSystemTime(START + 5_000);
    recordEdit("split", "p1");
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(posted[0].body.events[0].at).toBe((START + 5_000) / 1000);
  });

  it("a person who does nothing sends nothing, however long the app stays open", async () => {
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await settle();
    expect(posted).toHaveLength(0);
  });

  it("keeps projects apart: each is its own request with its own counts", async () => {
    recordEdit("move", "p1");
    recordEdit("delete", "p2");
    recordEdit("delete", "p2");
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    const byProject = Object.fromEntries(posted.map((p) => [p.body.project_id, editsOf(p)]));
    expect(byProject).toEqual({ p1: { move: 1 }, p2: { delete: 2 } });
  });

  it("an action with no project open still counts, under no project", async () => {
    recordEdit("undo");
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(posted[0].body.project_id).toBe("");
    expect(editsOf(posted[0])).toEqual({ undo: 1 });
  });

  it("is never sent more than once a minute per project however busy the person is", async () => {
    for (let second = 0; second < 5 * 60; second++) {
      recordEdit("move", "p1");
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await settle();
    // Five minutes of an action a second: a window opens with an action and closes a minute later.
    expect(posted.length).toBeLessThanOrEqual(5);
    expect(posted.length).toBeGreaterThanOrEqual(4);
    const counted = posted.reduce((sum, p) => sum + (editsOf(p).move ?? 0), 0);
    const stillHeld = __heldEditorItems().reduce((sum, h) => sum + (h.item.counts?.move ?? 0), 0);
    expect(counted + stillHeld).toBe(300);
  });

  it("counts every action exactly once, however the actions fall across minutes and projects", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            gapMs: fc.integer({ min: 0, max: 150_000 }),
            kind: fc.constantFrom(...EDIT_KINDS),
            project: fc.constantFrom("p1", "p2", ""),
          }),
          { minLength: 1, maxLength: 60 },
        ),
        async (actions) => {
          __resetEditorEvents();
          posted.length = 0;
          vi.setSystemTime(START);
          const expected = new Map<string, number>();
          for (const action of actions) {
            await vi.advanceTimersByTimeAsync(action.gapMs);
            recordEdit(action.kind, action.project);
            const key = `${action.project}|${action.kind}`;
            expected.set(key, (expected.get(key) ?? 0) + 1);
          }
          await flushEditorEvents();
          await settle();
          const got = new Map<string, number>();
          for (const p of posted)
            for (const [kind, n] of Object.entries(editsOf(p))) {
              const key = `${p.body.project_id}|${kind}`;
              got.set(key, (got.get(key) ?? 0) + n);
            }
          expect(Object.fromEntries(got)).toEqual(Object.fromEntries(expected));
          for (const p of posted) expect(p.body.events.length).toBeLessThanOrEqual(MAX_EDITOR_ITEMS);
        },
      ),
      { numRuns: 40 },
    );
  });

  it("keeps a count within what the server accepts however many actions pile up", async () => {
    for (let i = 0; i < 25; i++) recordEdit("move", "p1");
    const held = __heldEditorItems()[0].item;
    expect(held.counts?.move).toBe(25);
    expect(MAX_EDITOR_COUNT).toBe(100_000);
  });

  it("an app that is closed sends what it holds at once, not a minute later", async () => {
    recordEdit("add", "p1");
    recordEdit("add", "p1");
    await flushEditorEventsForExit();
    expect(posted).toHaveLength(1);
    expect(editsOf(posted[0])).toEqual({ add: 2 });
    expect(__heldEditorItems()).toEqual([]);
  });

  it("an exit never waits longer than two seconds for a network that is not answering", async () => {
    let release: () => void = () => undefined;
    hoisted.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    recordEdit("add", "p1");
    let done = false;
    void flushEditorEventsForExit().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1_900);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(done).toBe(true);
    release();
  });
});

describe("what is held when the account goes away", () => {
  it("is never sent after the person signs out", async () => {
    recordEdit("move", "p1");
    recordImport({ ok: true, media: "video", via: "copy" }, "p1");
    useAuth.setState({ status: "locked", hasStoredSession: false });
    await vi.advanceTimersByTimeAsync(60_000);
    await flushEditorEvents();
    await settle();
    expect(posted).toEqual([]);
    expect(__heldEditorItems()).toEqual([]);
  });

  it("is never sent under a different account that signs in afterwards", async () => {
    useAuth.setState({ status: "unlocked", profile: { user_id: "alice" } as never, hasStoredSession: true });
    recordEdit("move", "p1");
    recordPreview({ what: "first_frame", ms: 900 }, "p1");
    useAuth.setState({ profile: { user_id: "bob" } as never });
    recordEdit("trim", "p9");
    await flushEditorEvents();
    await settle();
    // Whatever Bob did afterwards is Bob's; what Alice did is gone.
    expect(posted.map((p) => [p.body.project_id, editsOf(p)])).toEqual([["p9", { trim: 1 }]]);
  });

  it("a request already on its way when the account changes is stopped before it leaves", async () => {
    useAuth.setState({ status: "unlocked", profile: { user_id: "alice" } as never, hasStoredSession: true });
    let release: () => void = () => undefined;
    hoisted.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    recordEdit("move", "p1");
    const flushing = flushEditorEvents();
    await settle();
    useAuth.setState({ profile: { user_id: "bob" } as never });
    release();
    await flushing;
    await settle();
    expect(posted).toEqual([]);
  });

  it("records nothing at all while nobody is signed in", async () => {
    useAuth.setState({ status: "locked", hasStoredSession: false });
    recordEdit("move", "p1");
    recordImport({ ok: false, reason: "disk_full" }, "p1");
    expect(__heldEditorItems()).toEqual([]);
    await flushEditorEvents();
    expect(posted).toEqual([]);
  });

  it("sends nothing when the session cannot be found, instead of a request that is bound to be refused", async () => {
    hoisted.session = false;
    recordEdit("move", "p1");
    await flushEditorEvents();
    await settle();
    expect(posted).toEqual([]);
  });
});

describe("a file brought in", () => {
  it("keeps what happened and says nothing of what the file was called", async () => {
    recordImport(
      {
        ok: false,
        reason: "'Holiday 2026 final.mp4' can't be used as media: it has no index",
        media: "video",
        via: "C:\\Users\\me\\Videos",
        bytes: 3 * 1024 * 1024 * 1024,
        ms: 412,
      },
      "p1",
    );
    await flushEditorEvents();
    await settle();
    const [item] = posted[0].body.events;
    expect(item).toMatchObject({
      kind: "import",
      ok: false,
      reason: "other",
      media: "video",
      via: "other",
      size_mb: 4096,
      ms: 412,
    });
    expect(JSON.stringify(posted)).not.toMatch(/Holiday|Users|Videos|mp4|index/);
  });

  it.each(IMPORT_DOORS)("every door the app names (%s) reaches the wire as itself", async (via) => {
    recordImport({ ok: true, media: "video", via }, "p1");
    await flushEditorEvents();
    await settle();
    expect(posted[0].body.events[0].via).toBe(via);
  });

  it("a file that came in carries no reason even when one was passed", async () => {
    recordImport({ ok: true, reason: "disk_full", media: "image", via: "reference" }, "p1");
    await flushEditorEvents();
    await settle();
    expect(posted[0].body.events[0]).toMatchObject({ ok: true, media: "image", via: "reference" });
    expect(posted[0].body.events[0]).not.toHaveProperty("reason");
  });

  it.each(IMPORT_REASONS)("every reason the app names (%s) reaches the wire as itself", async (reason) => {
    recordImport({ ok: false, reason, media: "video" }, "p1");
    await flushEditorEvents();
    await settle();
    expect(posted[0].body.events[0].reason).toBe(reason);
  });

  it("a size and a length are bands, never the figure", async () => {
    recordMedia(
      { media: "video", codec: "hevc", width: 3840, height: 2160, seconds: 613.4, bytes: 1_234_567_890, proxy: "built", ms: 41_234 },
      "p1",
    );
    await flushEditorEvents();
    await settle();
    expect(posted[0].body.events[0]).toEqual({
      kind: "media",
      at: START / 1000,
      media: "video",
      codec: "hevc",
      width: 3840,
      height: 2160,
      dur_s: 1800,
      size_mb: 4096,
      proxy: "built",
      ms: 41_234,
    });
  });

  it("a media item whose preview state is not one of the three is dropped, not invented", async () => {
    recordMedia({ media: "video", proxy: "maybe" as never }, "p1");
    expect(__heldEditorItems()).toEqual([]);
  });
});

describe("how the preview behaved", () => {
  it("a first picture and a stall carry a time and nothing else", async () => {
    recordPreview({ what: "first_frame", ms: 1_234, reason: "no_index", codec: "avc1" }, "p1");
    recordPreview({ what: "stall", ms: 4_321 }, "p1");
    await flushEditorEvents();
    await settle();
    expect(posted[0].body.events).toEqual([
      { kind: "preview", at: START / 1000, what: "first_frame", ms: 1_234 },
      { kind: "preview", at: START / 1000, what: "stall", ms: 4_321 },
    ]);
  });

  it("a failure carries a word and a codec family", async () => {
    recordPreview({ what: "failure", reason: "decoder_error", codec: "hev1", ms: 0 }, "p1");
    await flushEditorEvents();
    await settle();
    expect(posted[0].body.events[0]).toEqual({
      kind: "preview",
      at: START / 1000,
      what: "failure",
      ms: 0,
      reason: "decoder_error",
      codec: "hev1",
    });
  });

  it("a failure whose reason is not one of the words is `other`, and its codec is cut to a label", async () => {
    recordPreview({ what: "failure", reason: "my private reason", codec: "hev1.1.6.L93.B0.EXTRA/long" }, "p1");
    await flushEditorEvents();
    await settle();
    expect(posted[0].body.events[0]).toMatchObject({ reason: "other" });
    expect(String(posted[0].body.events[0].codec)).toMatch(/^[A-Za-z0-9_.:-]{0,12}$/);
  });

  it("a word that is not one of the three is dropped, not turned into a failure", () => {
    recordPreview({ what: "telepathy" as never, ms: 5 }, "p1");
    expect(__heldEditorItems()).toEqual([]);
  });
});

describe("nothing a person named, typed or showed can reach the wire", () => {
  const hostile = fc.oneof(
    fc.string({ maxLength: 120 }),
    fc.constantFrom(
      "C:\\Users\\me\\Videos\\holiday.mp4",
      "/home/me/secret project/final cut.mov",
      "my prompt: make it blue",
      "\u202e\u0000 bidi",
    ),
  );
  const VOCAB = new Set<string>([
    ...EDITOR_EVENT_KINDS,
    ...IMPORT_REASONS,
    ...IMPORT_DOORS,
    ...MEDIA_KINDS,
    ...PROXY_STATES,
    ...PREVIEW_WHATS,
    ...PREVIEW_FAILURES,
  ]);

  it("whatever text is passed in, every string that leaves is a word of a list or a codec name", async () => {
    await fc.assert(
      fc.asyncProperty(hostile, hostile, hostile, hostile, async (a, b, c, d) => {
        __resetEditorEvents();
        posted.length = 0;
        recordImport({ ok: false, reason: a, media: b, via: c }, "p1");
        recordImport({ ok: true, media: d, via: a }, "p1");
        recordMedia({ media: b, codec: c, proxy: "none" }, "p1");
        recordPreview({ what: "failure", reason: a, codec: d }, "p1");
        await flushEditorEvents();
        await settle();
        for (const request of posted)
          for (const item of request.body.events)
            for (const [field, value] of Object.entries(item)) {
              if (typeof value !== "string") continue;
              if (field === "codec") expect(value).toMatch(/^([a-z0-9][a-z0-9_.-]*)?$/);
              else expect(VOCAB.has(value), `${field}=${JSON.stringify(value)}`).toBe(true);
            }
      }),
      { numRuns: 120 },
    );
  });

  it("and every legitimate word survives, as sent", async () => {
    for (const reason of IMPORT_REASONS) recordImport({ ok: false, reason, media: "video" }, "p1");
    for (const failure of PREVIEW_FAILURES) recordPreview({ what: "failure", reason: failure }, "p2");
    await flushEditorEvents();
    await settle();
    const reasons = posted.flatMap((p) => p.body.events.map((e) => e.reason));
    for (const word of [...IMPORT_REASONS, ...PREVIEW_FAILURES]) expect(reasons).toContain(word);
  });

  it("a codec name is kept as ffmpeg spells it, and anything that is not a name is dropped whole", () => {
    expect(codecName("hevc", 20)).toBe("hevc");
    expect(codecName("HEVC", 20)).toBe("hevc");
    expect(codecName("pcm_s16le", 20)).toBe("pcm_s16le");
    expect(codecName("hev1.1.6.L93.B0", 20)).toBe("hev1.1.6.l93.b0");
    expect(codecName("hev1.1.6.L93.B0", 12)).toBe("");
    expect(codecName("hev1", 12)).toBe("hev1");
    expect(codecName("C:\\Users\\me\\Videos", 20)).toBe("");
    expect(codecName("a sentence about my holiday", 20)).toBe("");
    expect(codecName("x".repeat(30), 20)).toBe("");
    expect(codecName(42, 20)).toBe("");
  });
});

describe("a burst", () => {
  it("is sent in flushes of at most fifty items", async () => {
    for (let i = 0; i < 120; i++) recordImport({ ok: true, media: "video", via: "reference", ms: i }, "p1");
    await flushEditorEvents();
    await settle();
    expect(posted.length).toBeGreaterThanOrEqual(3);
    for (const p of posted) expect(p.body.events.length).toBeLessThanOrEqual(MAX_EDITOR_ITEMS);
    expect(posted.reduce((n, p) => n + p.body.events.length, 0)).toBe(120);
  });

  it("past what a minute may carry is counted and said, never silently lost", async () => {
    for (let i = 0; i < 620; i++) recordImport({ ok: true, media: "video", via: "reference" }, "p1");
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    const sent = posted.reduce((n, p) => n + p.body.events.length, 0);
    const said = posted.reduce((n, p) => n + (p.body.dropped ?? 0), 0);
    expect(sent).toBe(500);
    expect(said).toBe(120);
    expect(sent + said).toBe(620);
  });

  it("a minute later the budget is fresh again", async () => {
    for (let i = 0; i < 520; i++) recordImport({ ok: true, media: "video" }, "p1");
    await vi.advanceTimersByTimeAsync(61_000);
    posted.length = 0;
    for (let i = 0; i < 10; i++) recordImport({ ok: true, media: "video" }, "p1");
    await flushEditorEvents();
    await settle();
    expect(posted.reduce((n, p) => n + p.body.events.length, 0)).toBe(10);
  });
});

describe("the bands", () => {
  const MB = 1_048_576;
  it("round a size up to the next step of the ladder and never report the figure", () => {
    expect(bandMegabytes(0)).toBe(0);
    expect(bandMegabytes(1)).toBe(1);
    expect(bandMegabytes(MB)).toBe(1);
    expect(bandMegabytes(MB + 1)).toBe(4);
    expect(bandMegabytes(100 * MB)).toBe(256);
    expect(bandMegabytes(4096 * MB)).toBe(4096);
    expect(bandMegabytes(10 ** 15)).toBe(262_144);
    expect(bandMegabytes(Number.NaN)).toBe(0);
    expect(bandMegabytes(-5)).toBe(0);
  });

  it("round a length up the same way", () => {
    expect(bandSeconds(0)).toBe(0);
    expect(bandSeconds(0.2)).toBe(10);
    expect(bandSeconds(61)).toBe(300);
    expect(bandSeconds(3600)).toBe(3600);
    expect(bandSeconds(10 ** 9)).toBe(86_400);
  });

  it("are monotone, never below the figure (up to the top step), and never more than a step above it", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 5 * 10 ** 5, noNaN: true }), fc.double({ min: 0, max: 5 * 10 ** 5, noNaN: true }), (a, b) => {
        const [low, high] = a <= b ? [a, b] : [b, a];
        expect(bandSeconds(low)).toBeLessThanOrEqual(bandSeconds(high));
        expect(bandMegabytes(low * MB)).toBeLessThanOrEqual(bandMegabytes(high * MB));
        if (low > 0 && low <= 86_400) expect(bandSeconds(low)).toBeGreaterThanOrEqual(low);
        if (low > 0 && low <= 262_144) expect(bandMegabytes(low * MB)).toBeGreaterThanOrEqual(low);
      }),
      { numRuns: 300 },
    );
  });

  it("a time on the wire never passes what the server accepts", async () => {
    recordImport({ ok: true, media: "video", ms: 10 ** 15 }, "p1");
    await flushEditorEvents();
    await settle();
    expect(posted[0].body.events[0].ms).toBe(MAX_EDITOR_MS);
  });
});

describe("the vocabulary", () => {
  it("has no word twice and nothing empty, in any list", () => {
    for (const list of [EDIT_KINDS, IMPORT_REASONS, IMPORT_DOORS, MEDIA_KINDS, PROXY_STATES, PREVIEW_WHATS, PREVIEW_FAILURES, EDITOR_EVENT_KINDS]) {
      expect(new Set(list).size).toBe(list.length);
      for (const word of list) expect(word).toMatch(/^[a-z_]+$/);
    }
  });

  it("every kind of action can be counted", async () => {
    for (const kind of EDIT_KINDS as readonly EditKind[]) recordEdit(kind, "p1");
    await flushEditorEvents();
    await settle();
    expect(Object.keys(editsOf(posted[0])).sort()).toEqual([...EDIT_KINDS].sort());
  });
});
