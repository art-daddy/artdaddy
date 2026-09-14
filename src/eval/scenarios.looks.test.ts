// Validates the caption-look eval graders WITHOUT the live model: each new C1–C5 scenario's `expect`
// grader must PASS on a synthetic "good" final timeline (a styled / animated caption) and THROW on a
// "bad" one (a plain default caption), so a grader that always-passes (a dead assertion that would make
// the expensive model eval green for free) can't ship. Also guards scenario-id uniqueness across the
// whole corpus. The scenarios themselves run against the REAL model in eval.e2e.ts (the paid lane); this
// is the cheap correctness net for their oracles.
import { describe, expect, it } from "vitest";

import type { Timeline } from "../timeline/model";
import { ALL_SCENARIOS } from "./scenarios";
import { CANONICAL } from "./scenarios/canonical";
import { timeline, ttrack, vclip, vtrack } from "./scenarios/helpers";
import type { Scenario } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const byId = (id: string): Scenario => {
  const s = CANONICAL.find((x) => x.id === id);
  if (!s) throw new Error(`scenario ${id} not found`);
  return s;
};
/** A base video + one text clip carrying the given caption fields (what a model would produce). */
const cap = (fields: Any): Timeline =>
  timeline([
    vtrack("v2", 1, [vclip("a", "a.mp4", 0, 150)]),
    ttrack("t", 2, [
      { id: "cap", kind: "text", timeline_in: 0, timeline_out: 60, ...fields } as Any,
    ]),
  ]);

const cases: Array<{ id: string; good: Timeline; bad: Timeline }> = [
  {
    id: "caption_styled_bold",
    good: cap({ content: [{ text: "SALE" }], style: { color: "#ffff00", bold: true } }),
    bad: cap({ content: [{ text: "SALE" }] }), // plain, no style
  },
  {
    id: "caption_word_by_word",
    good: cap({ text: "like and subscribe", animation: { build: "word-by-word" } }),
    bad: cap({ text: "like and subscribe" }), // one string, no build
  },
  {
    id: "caption_emphasis_word",
    good: cap({ content: [{ text: "Only" }, { text: "$9", emphasis: true }, { text: "today" }] }),
    bad: cap({ content: [{ text: "Only" }, { text: "$9" }, { text: "today" }] }), // no emphasis anywhere
  },
  {
    id: "caption_kinetic_chunks",
    good: cap({
      content: [{ text: "stop" }, { text: "scrolling" }],
      animation: { build: "phrase-chunks" },
    }),
    bad: cap({ text: "stop scrolling right now" }), // single plain caption, no build
  },
  {
    id: "caption_preset_punchy",
    good: cap({ text: "WAIT FOR IT", style: { preset: "punchy" } }),
    bad: cap({ text: "WAIT FOR IT" }), // no preset / bold / upper / size / outline
  },
];

describe("caption-look eval graders (validated without the model)", () => {
  for (const { id, good, bad } of cases) {
    it(`${id}: accepts a styled/animated caption, rejects a plain one`, () => {
      const s = byId(id);
      expect(s.expect, `${id} must carry a Tier-1 grader`).toBeTypeOf("function");
      expect(() => s.expect!(good)).not.toThrow(); // a correct model output scores
      expect(() => s.expect!(bad)).toThrow(); // a plain caption does NOT — the grader isn't a dead assertion
    });
  }

  it("every scenario id in the corpus is unique (report keys can't collide)", () => {
    const ids = ALL_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// A slip is defined by what stays PUT, so its grader has three ways to be wrong and
// only one to be right. Each "bad" below is a real edit a model might make instead —
// a grader that only checked source_in would score the first two green.
describe("slip grader rejects the neighbouring edits it must not accept", () => {
  const slipped = (over: Any): Timeline =>
    timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 60, 150, over)])]);

  const wrong: Array<[string, Timeline]> = [
    // trimmed instead: head moved, but the clip got shorter.
    ["a trim", slipped({ timeline_out: 120, source_in: 30, source_out: 90 })],
    // moved instead: same content, different place.
    ["a move", slipped({ timeline_in: 90, timeline_out: 180 })],
    // nothing happened.
    ["a no-op", slipped({})],
    // source_in moved but the window did not follow — parity broken.
    ["a half-applied window", slipped({ source_in: 30, source_out: 90 })],
  ];

  it("accepts a real slip", () => {
    const s = byId("slip_content_later");
    expect(() => s.expect!(slipped({ source_in: 30, source_out: 120 }))).not.toThrow();
  });

  for (const [what, tl] of wrong) {
    it(`rejects ${what}`, () => {
      expect(() => byId("slip_content_later").expect!(tl)).toThrow();
    });
  }
});
