import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { Turn } from "../store/chatTranscript";
import { ProjectStoreAccess, joinPath, type FsLike } from "../tools/store";
import {
  HISTORY_FRAMES_BATCH,
  HISTORY_FRAMES_MAX,
  HISTORY_FRAME_MAX_BYTES,
  historyAttachments,
  historyFrameRefs,
  keptFrames,
  type FrameRef,
} from "./historyFrames";

function turn(id: string, parts: Turn["parts"], undone = false): Turn {
  return { id, userText: id, attachments: [], parts, status: "done", undone };
}

function result(callId: string, n: number, extra: Record<string, unknown> = {}) {
  return {
    kind: "tool_result",
    call_id: callId,
    name: "inspect_media",
    model_result: { ok: true },
    frame_refs: Array.from({ length: n }, (_, i) => ({ path: `f/${callId}_${i}.jpg`, caption: `@${i}s` })),
    ...extra,
  };
}

function refs(n: number): FrameRef[] {
  return Array.from({ length: n }, (_, i) => ({ call_id: `c${i}`, index: 0, path: `f/${i}.jpg` }));
}

describe("historyFrameRefs", () => {
  it("lists every frame the applied history showed, oldest first, with its call and index", () => {
    const turns = [
      turn("t1", [{ kind: "tool_call", call_id: "a" }, result("a", 2)]),
      turn("t2", [{ kind: "tool_call", call_id: "b" }, result("b", 1)], true), // undone
      turn("t3", [{ kind: "tool_call", call_id: "c" }, result("c", 1), { kind: "text", text: "ok" }]),
    ];
    expect(historyFrameRefs(turns)).toEqual([
      { call_id: "a", index: 0, path: "f/a_0.jpg", caption: "@0s" },
      { call_id: "a", index: 1, path: "f/a_1.jpg", caption: "@1s" },
      { call_id: "c", index: 0, path: "f/c_0.jpg", caption: "@0s" },
    ]);
  });

  it("ignores legacy parts without frame_refs, and a partial part", () => {
    const turns = [
      turn("t1", [
        { kind: "tool_result", call_id: "a", frames: [{ path: "x.jpg" }] }, // a tool's own field
        { ...result("b", 1), partial: true },
      ]),
    ];
    expect(historyFrameRefs(turns)).toEqual([]);
  });

  it("takes frames only from results that name their call, and only well-formed references", () => {
    const turns = [
      turn("t1", [
        // Only a RESULT's frames are history frames.
        { kind: "tool_call", call_id: "a", frame_refs: [{ path: "f/call.jpg" }] },
        // A result that cannot say which call it answers cannot be placed.
        { kind: "tool_result", frame_refs: [{ path: "f/orphan.jpg" }] },
        {
          kind: "tool_result",
          call_id: "b",
          frame_refs: [null, { path: 7 }, { path: "" }, { path: "f/ok.jpg", caption: "" }, { path: "f/ok2.jpg", caption: 3 }],
        },
      ]),
    ];
    // Index is the position in the result's own list, so the server can match it.
    expect(historyFrameRefs(turns)).toEqual([
      { call_id: "b", index: 3, path: "f/ok.jpg" },
      { call_id: "b", index: 4, path: "f/ok2.jpg" },
    ]);
  });
});

describe("keptFrames", () => {
  it("keeps everything up to the limit", () => {
    expect(keptFrames(refs(HISTORY_FRAMES_MAX))).toHaveLength(HISTORY_FRAMES_MAX);
  });

  it("over the limit, keeps the NEWEST, dropping the oldest a whole batch at a time", () => {
    const all = refs(HISTORY_FRAMES_MAX + 1);
    const kept = keptFrames(all);
    expect(kept).toEqual(all.slice(HISTORY_FRAMES_BATCH));
  });

  it("never keeps more than the limit; the kept frames are always the newest run", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 400 }), (n) => {
        const all = refs(n);
        const kept = keptFrames(all);
        expect(kept.length).toBeLessThanOrEqual(HISTORY_FRAMES_MAX);
        expect(kept).toEqual(all.slice(all.length - kept.length));
        if (n > HISTORY_FRAMES_MAX) expect(kept.length).toBeGreaterThan(HISTORY_FRAMES_MAX - HISTORY_FRAMES_BATCH);
      }),
    );
  });

  it("one more frame moves the oldest kept frame only when a batch boundary is crossed", () => {
    // Cache stability: the first kept frame is where the re-sent history starts to differ.
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 400 }), (n) => {
        const firstKept = (k: number) => {
          const kept = keptFrames(refs(k));
          return kept.length ? kept[0].path : null;
        };
        const before = firstKept(n);
        const after = firstKept(n + 1);
        const crossed = n + 1 > HISTORY_FRAMES_MAX && (n + 1 - HISTORY_FRAMES_MAX - 1) % HISTORY_FRAMES_BATCH === 0;
        if (n > 0 && !crossed) expect(after).toBe(before);
      }),
    );
  });
});

class MemFs implements FsLike {
  bytes = new Map<string, Uint8Array>();
  async exists(p: string): Promise<boolean> {
    return this.bytes.has(joinPath(p));
  }
  async readTextFile(): Promise<string> {
    throw new Error("ENOENT");
  }
  async writeTextFile(): Promise<void> {}
  async readBytes(p: string): Promise<Uint8Array> {
    const v = this.bytes.get(joinPath(p));
    if (!v) throw new Error("ENOENT");
    return v;
  }
  async mkdir(): Promise<void> {}
}

describe("historyAttachments", () => {
  it("re-sends the kept frames' bytes, tagged with their call and index; skips missing and oversized ones", async () => {
    const fs = new MemFs();
    const DIR = "C:/proj";
    fs.bytes.set(joinPath(DIR, "f/a_0.jpg"), new Uint8Array([0xff, 0xd8, 1]));
    // f/a_1.jpg is missing (cache trimmed)
    fs.bytes.set(joinPath(DIR, "f/c_0.jpg"), new Uint8Array(HISTORY_FRAME_MAX_BYTES + 1));
    const store = new ProjectStoreAccess(DIR, fs);
    const turns = [
      turn("t1", [{ kind: "tool_call", call_id: "a" }, result("a", 2)]),
      turn("t2", [{ kind: "tool_call", call_id: "c" }, result("c", 1)]),
    ];
    const atts = await historyAttachments(turns, store);
    expect(atts).toEqual([
      { kind: "image", b64: btoa(String.fromCharCode(0xff, 0xd8, 1)), caption: "@0s", ext: ".jpg", call_id: "a", index: 0 },
    ]);
  });

  it("names the file type from the extension, case-insensitively, and only from the file name", async () => {
    const fs = new MemFs();
    const DIR = "C:/proj";
    fs.bytes.set(joinPath(DIR, "f/UP.JPG"), new Uint8Array([1]));
    fs.bytes.set(joinPath(DIR, "f.dir/noext"), new Uint8Array([2]));
    const store = new ProjectStoreAccess(DIR, fs);
    const turns = [
      turn("t1", [{ kind: "tool_result", call_id: "a", frame_refs: [{ path: "f/UP.JPG" }, { path: "f.dir/noext" }] }]),
    ];
    const atts = await historyAttachments(turns, store);
    expect(atts.map((a) => a.ext)).toEqual([".jpg", undefined]);
    expect(atts.map((a) => "caption" in a)).toEqual([false, false]);
  });

  it("sends nothing without a project store", async () => {
    expect(await historyAttachments([turn("t1", [result("a", 1)])], null)).toEqual([]);
  });

  it("a frame exactly at the size limit is still re-sent", async () => {
    const fs = new MemFs();
    const DIR = "C:/proj";
    fs.bytes.set(joinPath(DIR, "f/a_0.jpg"), new Uint8Array(HISTORY_FRAME_MAX_BYTES));
    const atts = await historyAttachments([turn("t1", [result("a", 1)])], new ProjectStoreAccess(DIR, fs));
    expect(atts).toHaveLength(1);
  });
});
