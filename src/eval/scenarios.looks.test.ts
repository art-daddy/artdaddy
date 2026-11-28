// Validates the caption-look eval graders WITHOUT the live model: each new C1–C5 scenario's `expect`
// grader must PASS on a synthetic "good" final timeline (a styled / animated caption) and THROW on a
// "bad" one (a plain default caption), so a grader that always-passes (a dead assertion that would make
// the expensive model eval green for free) can't ship. Also guards scenario-id uniqueness across the
// whole corpus. The scenarios themselves run against the REAL model in eval.e2e.ts (the paid lane); this
// is the cheap correctness net for their oracles.
import { describe, expect, it } from "vitest";

import type { Timeline } from "../timeline/model";
import catalog from "../contract/catalog.json";
import { ALL_SCENARIOS, DISABLED_SCENARIOS, RECOVERY_LANE } from "./scenarios";
import { CANONICAL } from "./scenarios/canonical";
import { EFFECT_SCENARIOS } from "./scenarios/effects";
import { EXPORT_SCENARIOS, RECOVERY_SCENARIOS } from "./scenarios/exports";
import { COMPLAINT_SCENARIOS } from "./scenarios/gap_complaints";
import { aclip, atrack, timeline, ttrack, vclip, vtrack } from "./scenarios/helpers";
import { JOURNEYS } from "./scenarios/journeys";
import { REGRESSIONS } from "./scenarios/regressions";
import { STUDIO_SCENARIOS } from "./scenarios/studio";
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
      content: [{ text: "stop scrolling" }, { text: "right now" }],
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

  // The right look on the wrong words used to pass: the graders read only the look, or fell back
  // to whichever caption came first.
  const wrongWords: Array<[string, Timeline]> = [
    ["caption_word_by_word", cap({ text: "hit the bell", animation: { build: "word-by-word" } })],
    [
      "caption_emphasis_word",
      cap({ content: [{ text: "Only" }, { text: "nine", emphasis: true }, { text: "today" }] }),
    ],
    [
      "caption_kinetic_chunks",
      cap({
        content: [{ text: "stop" }, { text: "scrolling" }],
        animation: { build: "phrase-chunks" },
      }),
    ],
    ["caption_preset_punchy", cap({ text: "SUBSCRIBE", style: { preset: "punchy" } })],
  ];
  for (const [id, tl] of wrongWords)
    it(`${id}: rejects the right look on the wrong words`, () => {
      expect(() => byId(id).expect!(tl)).toThrow(/do not say/);
    });

  it("every scenario id in the corpus is unique (report keys can't collide)", () => {
    const ids = [...ALL_SCENARIOS, ...DISABLED_SCENARIOS, ...RECOVERY_LANE].map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("excludes retired-tool workflows without losing supported scenarios", () => {
    const candidates = [
      ...CANONICAL,
      ...EFFECT_SCENARIOS,
      ...REGRESSIONS,
      ...JOURNEYS,
      ...EXPORT_SCENARIOS,
      ...STUDIO_SCENARIOS,
      ...COMPLAINT_SCENARIOS,
    ];
    const withdrawn = new Set(
      catalog.tools.filter((tool) => tool.status === "withdrawn").map((tool) => tool.name),
    );
    for (const scenario of candidates) {
      const retired = scenario.expectTools?.some((name) => withdrawn.has(name)) ?? false;
      expect(ALL_SCENARIOS.includes(scenario), scenario.id).toBe(!retired);
      expect(DISABLED_SCENARIOS.includes(scenario), scenario.id).toBe(retired);
    }
    expect(ALL_SCENARIOS.length + DISABLED_SCENARIOS.length).toBe(candidates.length);
  });

  // The harness stops a recovery case before inference unless the server's tool list matches its
  // stand-ins, so in the main lane it could only ever be recorded as a harness error.
  it("keeps the recovery cases out of the main lane and runnable in their own", () => {
    expect(RECOVERY_SCENARIOS.length).toBeGreaterThan(0);
    for (const scenario of RECOVERY_SCENARIOS) {
      expect(ALL_SCENARIOS.includes(scenario), scenario.id).toBe(false);
      expect(RECOVERY_LANE.includes(scenario), scenario.id).toBe(true);
      expect(scenario.surface, scenario.id).toBe("recovery");
    }
    expect(ALL_SCENARIOS.some((s) => s.surface === "recovery")).toBe(false);
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

// Each request names WHERE (a corner, each side of the frame) or WHEN (only while the voice
// talks). Each "near" below did the kind of edit asked for in the wrong place, and used to pass.
describe("layout and ducking graders reject the near misses", () => {
  const pip = (transform: Any) =>
    timeline([vtrack("v1", 2, [vclip("pip", "pip.mp4", 0, 90, { transform } as Any)])]);
  const sideBySide = (l: Any, r: Any) =>
    timeline([
      vtrack("v1", 2, [vclip("l", "left.mp4", 0, 90, { transform: l } as Any)]),
      vtrack("v2", 1, [vclip("r", "right.mp4", 0, 90, { transform: r } as Any)]),
    ]);
  const bed = (over: Any) =>
    timeline([
      atrack("a3", 0, [aclip("bed", "music.mp3", 0, 180, over)]),
      atrack("a4", 1, [aclip("vo", "voice.mp3", 0, 90)]),
    ]);
  const cases: Array<[string, string, Timeline, Timeline]> = [
    [
      "crop_square",
      "a crop of the top and bottom only",
      timeline([
        vtrack("v2", 1, [vclip("a", "a.mp4", 0, 90, { crop: { left: 0.22, right: 0.22 } } as Any)]),
      ]),
      timeline([
        vtrack("v2", 1, [vclip("a", "a.mp4", 0, 90, { crop: { top: 0.2, bottom: 0.2 } } as Any)]),
      ]),
    ],
    [
      "pip_corner",
      "a PiP shrunk in the middle of the frame",
      pip({ scale: 0.35, position: { x: 0.78, y: 0.12 } }),
      pip({ scale: 0.35 }),
    ],
    [
      "pip_corner",
      "a PiP in the top-left corner",
      pip({ scale: 0.35, position: { x: 0.78, y: 0.12 } }),
      pip({ scale: 0.35, position: { x: 0.22, y: 0.12 } }),
    ],
    [
      "split_screen",
      "both clips shrunk on top of each other in the middle",
      sideBySide(
        { scale: 0.5, position: { x: 0.25, y: 0.5 } },
        { scale: 0.5, position: { x: 0.75, y: 0.5 } },
      ),
      sideBySide({ scale: 0.5 }, { scale: 0.5 }),
    ],
    [
      "duck_music",
      "the music turned down all the way through",
      bed({ duck: { against: "a4" } }),
      bed({ volume: 0.4 }),
    ],
    [
      "duck_music",
      "volume keyframes that fade the music out instead",
      bed({
        volume: [
          { t: 0, v: 0.3 },
          { t: 90, v: 0.3 },
          { t: 100, v: 1 },
        ],
      }),
      bed({
        volume: [
          { t: 0, v: 1 },
          { t: 180, v: 0 },
        ],
      }),
    ],
  ];
  for (const [id, what, good, near] of cases)
    it(`${id}: accepts the edit, rejects ${what}`, () => {
      expect(() => byId(id).expect!(good)).not.toThrow();
      expect(() => byId(id).expect!(near)).toThrow();
    });
});
