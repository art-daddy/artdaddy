import { describe, expect, it } from "vitest";

import { toolNames } from "../contract/views";
import { trackLabels } from "./timeline/labels";
import {
  buildRows,
  PHRASED_TOOLS,
  rowSummary,
  summarizeCall,
  type SummaryContext,
  type ToolCallView,
} from "./toolSummary";

const ctx: SummaryContext = { trackLabel: (id) => ({ trk_a: "v1", trk_b: "a1" })[id] ?? id };

const call = (name: string, args = {}, result?: Record<string, unknown>): ToolCallView => {
  const { text, running, ok, error } = summarizeCall(name, args, result, ctx);
  return { name, args, result, text, running, ok, error };
};

const TOOLS = toolNames();

// ── the guard that keeps this true as tools are added ────────────────────────

describe("every tool the model can call has a sentence", () => {
  it("phrases every tool in the contract", () => {
    const missing = TOOLS.filter((t) => !PHRASED_TOOLS.has(t));
    expect(missing, `these tools would render as a bare identifier: ${missing.join(", ")}`).toEqual(
      [],
    );
  });

  it("never leaks the tool's own name into the summary, for ANY tool", () => {
    // The whole point: `set_clip_properties` is our vocabulary, not the user's. Walking all
    // 58 catches the one entry someone adds later by pasting the identifier in.
    //
    // Only identifier-SHAPED names are forbidden. `export`, `undo` and `redo` are ordinary
    // English verbs, and "Couldn't export the video" is the sentence we want.
    for (const name of TOOLS) {
      for (const result of [undefined, { ok: true }, { ok: false, error: "boom" }]) {
        const { text } = summarizeCall(name, {}, result, ctx);
        if (name.includes("_")) expect(text, `${name} -> ${text}`).not.toContain(name);
        expect(text, `${name} -> ${text}`).not.toMatch(/_/);
        expect(text.trim().length, `${name} produced an empty summary`).toBeGreaterThan(0);
      }
    }
  });

  it("never renders a payload into the summary line, for ANY tool", () => {
    // A phrase that interpolated an object would print "[object Object]" or JSON at the
    // user; that is the thing we are removing.
    const args = { clips: [{ a: 1 }], prompt: "x", nested: { deep: true } };
    const result = { ok: true, count: 2, created: [{ clip_id: "c1" }], blob: { k: "v" } };
    for (const name of TOOLS) {
      const { text } = summarizeCall(name, args, result, ctx);
      expect(text, `${name} -> ${text}`).not.toContain("[object");
      expect(text, `${name} -> ${text}`).not.toContain("{");
    }
  });

  it("survives a malformed result rather than blanking the transcript", () => {
    for (const name of TOOLS) {
      const { text } = summarizeCall(
        name,
        { clip_ids: "not-an-array" },
        { ok: true, count: null },
        ctx,
      );
      expect(text.trim().length).toBeGreaterThan(0);
    }
  });
});

// ── tense ────────────────────────────────────────────────────────────────────

describe("tense", () => {
  it("reads as in-progress while the call has no result yet", () => {
    const c = call("add_clips", { entries: [{}, {}] });
    expect(c.running).toBe(true);
    expect(c.text).toBe("Adding clips");
  });

  it("settles to what actually happened once the result lands", () => {
    const c = call("add_clips", { entries: [{}, {}] }, { ok: true, count: 3, track_id: "trk_a" });
    expect(c.running).toBe(false);
    expect(c.text).toBe("Added 3 clips to v1");
  });
});

// ── the result is the truth, not the request ─────────────────────────────────

describe("what the line counts", () => {
  it("reports what the tool DID, not what it was asked to do", () => {
    // The args asked for 5; the tool applied 3 (clamped/partially applied). Reporting the
    // args would tell the user something that did not happen.
    const c = call("add_clips", { entries: [1, 2, 3, 4, 5] }, { ok: true, count: 3 });
    expect(c.text).toBe("Added 3 clips");
  });

  it("falls back to the request only when the result carries no count", () => {
    const c = call("add_clips", { entries: [1, 2] }, { ok: true });
    expect(c.text).toBe("Added 2 clips");
  });

  it("says '1 clip', not '1 clips'", () => {
    expect(call("remove_clips", {}, { ok: true, removed: 1 }).text).toBe("Removed 1 clip");
    expect(call("remove_clips", {}, { ok: true, removed: 4 }).text).toBe("Removed 4 clips");
  });

  it("reads each edit tool's own result field", () => {
    expect(call("split_clips", {}, { ok: true, new_clip_ids: ["a", "b"] }).text).toBe(
      "Split 2 clips",
    );
    expect(call("move_clips", {}, { ok: true, moved: 2 }).text).toBe("Moved 2 clips");
    expect(call("set_clip_properties", {}, { ok: true, updated: 7 }).text).toBe("Updated 7 clips");
    expect(call("link_clips", {}, { ok: true, linked: 2 }).text).toBe("Linked 2 clips");
  });

  it("names the exported file rather than the path it sits at", () => {
    // Present tense on purpose: the export is queued, so the file is not there yet.
    const c = call(
      "export",
      {},
      { ok: true, status: "exporting", saved_to: "C:/Users/me/Downloads/reel.mp4" },
    );
    expect(c.text).toBe("Exporting reel.mp4");
    const q = call(
      "export",
      {},
      { ok: true, status: "queued", saved_to: "C:/Users/me/Downloads/reel.mp4" },
    );
    expect(q.text).toBe("Queued reel.mp4 for export");
  });

  it("says what manage_exports actually did", () => {
    expect(call("manage_exports", { action: "list" }, { ok: true, exports: [] }).text).toBe(
      "No exports running",
    );
    expect(call("manage_exports", { action: "cancel" }, { ok: true, cancelled: true }).text).toBe(
      "Cancelled the export",
    );
    // A cancel that arrived too late is not a failure to report.
    expect(call("manage_exports", { action: "cancel" }, { ok: true, cancelled: false }).text).toBe(
      "That export had already finished",
    );
  });

  it("names the site rather than the whole URL", () => {
    const c = call("get_page", { url: "https://www.example.com/a/b?c=d" }, { ok: true });
    expect(c.text).toBe("Read example.com");
  });

  it("quotes a search the way the user typed it", () => {
    expect(call("web_search", { query: "b roll of rain" }, { ok: true }).text).toBe(
      "Searched the web for “b roll of rain”",
    );
  });
});

// ── tracks are named the way the ruler names them ────────────────────────────

describe("track naming", () => {
  it("uses the SAME label the timeline ruler shows", () => {
    // Not a second vocabulary: the summary must agree with what the user is looking at.
    const tracks = [
      { id: "trk_a", kind: "video" },
      { id: "trk_b", kind: "audio" },
    ] as Any[];
    const labels = trackLabels(tracks);
    const c = call("add_clips", {}, { ok: true, count: 1, track_id: "trk_a" });
    expect(c.text).toBe(`Added 1 clip to ${labels[0]}`);
  });

  it("keeps the raw id when the track is gone, rather than inventing a name", () => {
    const gone: SummaryContext = { trackLabel: (id) => id };
    const { text } = summarizeCall(
      "add_clips",
      {},
      { ok: true, count: 1, track_id: "trk_zz" },
      gone,
    );
    expect(text).toBe("Added 1 clip to trk_zz");
  });

  it("omits the track entirely when the call did not name one", () => {
    expect(call("add_clips", {}, { ok: true, count: 2 }).text).toBe("Added 2 clips");
  });
});

// ── failure ──────────────────────────────────────────────────────────────────

describe("failure", () => {
  it("says what could not be done, and keeps the real error for the detail view", () => {
    const c = call("export", {}, { ok: false, error: "ffmpeg exited 1: no such encoder" });
    expect(c.ok).toBe(false);
    expect(c.text).toBe("Couldn't export the video");
    expect(c.error).toBe("ffmpeg exited 1: no such encoder");
  });

  it("treats an error field as a failure even when ok was not set", () => {
    const c = call("add_clips", {}, { error: "nope" });
    expect(c.ok).toBe(false);
    expect(c.text).toBe("Couldn't add clips");
  });

  it("never claims a count for a call that failed", () => {
    const c = call("remove_clips", { clip_ids: ["a", "b"] }, { ok: false, error: "locked" });
    expect(c.text).not.toMatch(/\d/);
  });
});

// ── folding consecutive calls ────────────────────────────────────────────────

describe("folding a run of calls", () => {
  it("merges repeats of ONE tool into a single action with the counts summed", () => {
    const calls = [
      call("add_clips", {}, { ok: true, count: 2, track_id: "trk_a" }),
      call("add_clips", {}, { ok: true, count: 3, track_id: "trk_a" }),
    ];
    expect(rowSummary(calls, ctx)).toBe("Added 5 clips to v1");
  });

  it("does not invent a combined sentence for different tools", () => {
    const calls = [
      call("get_timeline", {}, { ok: true }),
      call("add_clips", {}, { ok: true, count: 2 }),
      call("export", {}, { ok: true, saved_to: "a.mp4" }),
    ];
    expect(rowSummary(calls, ctx)).toBe("Read the timeline and 2 more");
  });

  it("surfaces that something failed inside a fold instead of hiding it", () => {
    const calls = [
      call("add_clips", {}, { ok: true, count: 1 }),
      call("export", {}, { ok: false, error: "boom" }),
    ];
    expect(rowSummary(calls, ctx)).toBe("Added 1 clip and 1 more (1 failed)");
  });

  it("shows the in-flight call while a run is still running", () => {
    const calls = [call("add_clips", {}, { ok: true, count: 1 }), call("export", {})];
    expect(rowSummary(calls, ctx)).toBe("Exporting");
  });

  it("does not sum tools whose phrase carries no count", () => {
    const calls = [call("undo", {}, { ok: true }), call("undo", {}, { ok: true })];
    expect(rowSummary(calls, ctx)).toBe("Undid the last change and 1 more");
  });
});

// ── rows ─────────────────────────────────────────────────────────────────────

describe("buildRows", () => {
  it("folds a call and its result into ONE entry", () => {
    const rows = buildRows(
      [
        { kind: "tool_call", call_id: "c1", name: "add_clips", args: {} },
        { kind: "tool_result", call_id: "c1", name: "add_clips", result: { ok: true, count: 2 } },
      ],
      ctx,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("tools");
    const [row] = rows as Any[];
    expect(row.calls).toHaveLength(1);
    expect(row.calls[0].text).toBe("Added 2 clips");
  });

  it("keeps reasoning and prose as their own rows, and lets them break a run", () => {
    const rows = buildRows(
      [
        { kind: "tool_call", call_id: "c1", name: "get_timeline", args: {} },
        { kind: "tool_result", call_id: "c1", result: { ok: true } },
        { kind: "reasoning", text: "now I'll add them" },
        { kind: "tool_call", call_id: "c2", name: "add_clips", args: {} },
        { kind: "tool_result", call_id: "c2", result: { ok: true, count: 1 } },
        { kind: "text", text: "done" },
      ],
      ctx,
    );
    expect(rows.map((r) => r.kind)).toEqual(["tools", "part", "tools", "part"]);
  });

  it("shows a call whose result has not arrived as still running", () => {
    const rows = buildRows([{ kind: "tool_call", call_id: "c1", name: "export", args: {} }], ctx);
    const [row] = rows as Any[];
    expect(row.calls[0].running).toBe(true);
    expect(row.calls[0].text).toBe("Exporting");
  });

  it("keeps the raw arguments available for the detail view", () => {
    // Hidden by default, not discarded -- the payload is still how you debug a bad edit.
    const args = { entries: [{ media_ref: "media_abc" }], track_id: "trk_a" };
    const rows = buildRows([{ kind: "tool_call", call_id: "c1", name: "add_clips", args }], ctx);
    const [row] = rows as Any[];
    expect(row.calls[0].args).toEqual(args);
  });

  it("reads a tool it has never heard of without crashing or showing an identifier", () => {
    const rows = buildRows(
      [
        { kind: "tool_call", call_id: "c1", name: "brand_new_tool", args: {} },
        { kind: "tool_result", call_id: "c1", result: { ok: true } },
      ],
      ctx,
    );
    const [row] = rows as Any[];
    expect(row.calls[0].text).toBe("Brand new tool");
  });
});

// These three came out of reading a realistic turn rather than from an assertion: the
// first version folded a whole turn into "Added 2 clips to v2 and 5 more (1 failed)",
// which buried the only thing the user needed to see.
describe("a long turn stays readable", () => {
  const seq = (...names: string[]) =>
    names.flatMap((n, i) => [
      { kind: "tool_call", call_id: `c${i}`, name: n, args: {} },
      { kind: "tool_result", call_id: `c${i}`, result: { ok: true, count: 1 } },
    ]);

  it("gives a failure its own line instead of a parenthetical", () => {
    const rows = buildRows(
      [
        ...seq("get_timeline", "add_clips"),
        { kind: "tool_call", call_id: "cx", name: "export", args: {} },
        { kind: "tool_result", call_id: "cx", result: { ok: false, error: "no encoder" } },
        ...seq("undo"),
      ],
      ctx,
    );

    const failing = (rows as Any[]).filter(
      (r) => r.kind === "tools" && r.calls.some((c: Any) => !c.ok),
    );
    expect(failing).toHaveLength(1);
    expect(failing[0].calls).toHaveLength(1);
    expect(rowSummary(failing[0].calls, ctx)).toBe("Couldn't export the video");
  });

  it("breaks a long mixed sequence into several rows rather than one sentence", () => {
    const rows = buildRows(
      seq("get_timeline", "add_clips", "set_transition", "web_search", "export"),
      ctx,
    );
    const toolRows = rows.filter((r) => r.kind === "tools");
    expect(toolRows.length).toBeGreaterThan(1);
    for (const r of toolRows as Any[]) expect(r.calls.length).toBeLessThanOrEqual(3);
  });

  it("still merges repeats of ONE tool, however many, into a single row", () => {
    const rows = buildRows(seq(...Array(7).fill("add_clips")), ctx);
    expect(rows).toHaveLength(1);
    expect(rowSummary((rows[0] as Any).calls, ctx)).toBe("Added 7 clips");
  });

  it("sums the leading repeats even when another tool follows them", () => {
    // The bug this caught: it reported only the FIRST call's count and hid the rest in
    // "and N more", so two adds of 2 and 1 read as "Added 2 clips".
    const calls = [
      call("add_clips", {}, { ok: true, count: 2, track_id: "trk_a" }),
      call("add_clips", {}, { ok: true, count: 1, track_id: "trk_a" }),
      call("set_transition", {}, { ok: true, kind: "crossfade" }),
    ];
    expect(rowSummary(calls, ctx)).toBe("Added 3 clips to v1 and 1 more");
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
