// Walks EVERY eval case, offline, with no model: the rules each case must keep for the lane's
// verdicts to mean anything.
//   - A run that does nothing fails. A case a do-nothing model passes is a free pass: four did
//     (read_whole_timeline, make_it_pop, undo_followup, vertical_reframe_480p).
//   - What a case declares is about ITS seed and the real catalog: a scope naming a clip the seed
//     does not have, or a paid tool that is not paid, silently allows nothing or everything.
import { describe, expect, it } from "vitest";

import catalog from "../contract/catalog.json";
import type { Timeline } from "../timeline/model";
import { EVAL_PAID_TOOLS } from "./checks";
import { gradeRun, KNOWN_FAILURE_REF } from "./oracle";
import { ALL_SCENARIOS, DISABLED_SCENARIOS, RECOVERY_LANE } from "./scenarios";
import type { Scenario, ToolCall, Trace } from "./types";

const every: Scenario[] = [...ALL_SCENARIOS, ...DISABLED_SCENARIOS, ...RECOVERY_LANE];
const byId = (id: string) => every.find((s) => s.id === id)!;
const run = (calls: Partial<ToolCall>[] = [], finalText = "Done."): Trace => ({
  toolCalls: calls.map((c, i) => ({
    round: i + 1,
    name: c.name ?? "?",
    args: c.args ?? {},
    ok: c.ok ?? true,
  })),
  reasoning: [],
  rounds: calls.length + 1,
  finalText,
  usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 },
});
const copy = (tl: Timeline): Timeline => JSON.parse(JSON.stringify(tl)) as Timeline;

describe("a run that does nothing fails every case", () => {
  for (const s of every) {
    it(s.id, () => {
      const g = gradeRun(s, s.seed(), s.seed(), run());
      expect(g.tier0.violations, "the seed itself must be valid").toEqual([]);
      expect(g.harm.violations, "doing nothing harms nothing").toEqual([]);
      expect(g.passed, `${s.id} passes when the model does nothing`).toBe(false);
    });
  }
});

describe("what each case declares is about its own seed and the real catalog", () => {
  const tools = new Map(catalog.tools.map((t) => [t.name, t]));
  const KINDS = new Set(["video", "image", "audio", "text"]);

  for (const s of every) {
    it(s.id, () => {
      const seed = s.seed();
      const clipIds = new Set((seed.tracks ?? []).flatMap((t) => (t.clips ?? []).map((c) => c.id)));
      const trackIds = new Set((seed.tracks ?? []).map((t) => t.id));
      for (const name of s.paidTools ?? [])
        expect(EVAL_PAID_TOOLS.has(name), `paidTools names ${name}, which is not paid`).toBe(true);
      for (const name of s.mustNotCall ?? [])
        expect(tools.get(name)?.status, `mustNotCall names ${name}`).not.toBe("withdrawn");
      for (const name of s.mustNotCall ?? []) expect(tools.has(name), name).toBe(true);
      const scope = s.scope ?? {};
      for (const id of [...(scope.change ?? []), ...(scope.remove ?? [])])
        expect(clipIds.has(id), `scope names clip ${id}, not in the seed`).toBe(true);
      for (const id of scope.tracks ?? [])
        expect(trackIds.has(id), `scope names track ${id}, not in the seed`).toBe(true);
      for (const kind of scope.add ?? []) expect(KINDS.has(kind), kind).toBe(true);
      for (const field of scope.canvas ?? []) expect(field in seed.canvas, field).toBe(true);
      if (s.knownFailure !== undefined)
        expect(s.knownFailure, "knownFailure is a backlog reference").toMatch(KNOWN_FAILURE_REF);
      if (s.transcript) {
        const refs = (seed.tracks ?? []).flatMap((t) => (t.clips ?? []).map((c) => c.media_ref));
        expect(refs, "the transcript's source is on the seed").toContain(s.transcript.media_ref);
        for (const [w, a, b] of s.transcript.words) expect(b > a, w).toBe(true);
      }
    });
  }
});

// The four cases a do-nothing run used to pass now each fail it, and pass a run that does the
// task: a check that fails everything is as useless as one that passes everything.
describe("the former free passes accept the task done and reject it not done", () => {
  it("read_whole_timeline: read the timeline and name its clips", () => {
    const s = byId("read_whole_timeline");
    const read = { name: "get_timeline" };
    const answer = "Two clips on v2: a.mp4 (frames 0-60) and b.mp4 (frames 60-120).";
    expect(gradeRun(s, s.seed(), s.seed(), run([read], answer)).passed).toBe(true);
    expect(gradeRun(s, s.seed(), s.seed(), run([], answer)).tier1.violations.join()).toMatch(
      /without reading the timeline/,
    );
    expect(gradeRun(s, s.seed(), s.seed(), run([read], "There is one clip.")).passed).toBe(false);
    const edited = copy(s.seed());
    edited.tracks[0].clips![1].timeline_out = 90;
    expect(gradeRun(s, s.seed(), edited, run([read], answer)).passed).toBe(false);
  });

  it("make_it_pop: any look on the clip, and only on the clip", () => {
    const s = byId("make_it_pop");
    const graded = copy(s.seed());
    graded.tracks[0].clips![0].color = { contrast: 1.2, saturation: 1.15 };
    expect(gradeRun(s, s.seed(), graded, run([{ name: "apply_color" }])).passed).toBe(true);
    const effect = copy(s.seed());
    effect.tracks[0].clips![0].effects = [{ type: "sharpen", params: { amount: 0.5 } }];
    expect(gradeRun(s, s.seed(), effect, run([{ name: "apply_effects" }])).passed).toBe(true);
    const bypassed = copy(s.seed());
    bypassed.tracks[0].clips![0].effects = [{ type: "sharpen", enabled: false }];
    expect(gradeRun(s, s.seed(), bypassed, run([{ name: "apply_effects" }])).passed).toBe(false);
    const canvas = copy(graded);
    canvas.canvas.width = 1920;
    expect(gradeRun(s, s.seed(), canvas, run([{ name: "apply_color" }])).harm.passed).toBe(false);
  });

  it("undo_followup: the edit landed, then something put it back", () => {
    const s = byId("undo_followup");
    const half = { name: "set_clip_properties", args: { clip_ids: ["a"], opacity: 0.5 } };
    expect(gradeRun(s, s.seed(), s.seed(), run([half, { name: "undo" }])).passed).toBe(true);
    const back = { name: "set_clip_properties", args: { clip_ids: ["a"], opacity: 1 } };
    expect(gradeRun(s, s.seed(), s.seed(), run([half, back])).passed).toBe(true);
    const keyframed = {
      name: "set_keyframes",
      args: { clip_id: "a", property: "opacity", keyframes: [{ t: 0, v: 0.5 }] },
    };
    expect(gradeRun(s, s.seed(), s.seed(), run([keyframed, { name: "undo" }])).passed).toBe(true);
    // An undo with nothing before it, or an edit that failed, is not "did it, then undid it".
    expect(gradeRun(s, s.seed(), s.seed(), run([{ name: "undo" }])).passed).toBe(false);
    expect(
      gradeRun(s, s.seed(), s.seed(), run([{ ...half, ok: false }, { name: "undo" }])).passed,
    ).toBe(false);
    expect(gradeRun(s, s.seed(), s.seed(), run([{ name: "undo" }, half])).passed).toBe(false);
  });

  it("vertical_reframe_480p: the frame is filled, and the picture is not blown up past the ceiling", () => {
    const s = byId("vertical_reframe_480p");
    const set = (patch: Record<string, unknown>) => {
      const tl = copy(s.seed());
      Object.assign(tl.tracks[0].clips![0], patch);
      return tl;
    };
    const ok = (tl: Timeline) =>
      gradeRun(s, s.seed(), tl, run([{ name: "set_clip_properties" }])).passed;
    expect(ok(set({ fit: "cover" }))).toBe(true);
    expect(ok(set({ transform: { scale: 3.56 } }))).toBe(true); // contain, scaled up to fill
    expect(ok(s.seed())).toBe(false); // letterboxed: 16:9 in a 9:16 frame
    expect(ok(set({ transform: { scale: 1.78 } }))).toBe(false); // bigger, still not filled
    expect(ok(set({ fit: "cover", transform: { scale: 2 } }))).toBe(false); // 8x, past the ceiling
    expect(ok(set({ fit: "cover", transform: { position: { x: 0.8, y: 0.5 } } }))).toBe(false); // slid off
  });
});
