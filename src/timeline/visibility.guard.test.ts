// Drift guard for the READ side, mirroring operations.guard.test.ts for the write side.
//
// The same defect landed three times in one week, each in a different consumer and each invisible
// to a green suite: the preview filtered `hidden` and the export did not (S6); the audio engine
// honoured neither `disabled` nor `solo` (S7); a cross-kind solo filter would have blacked out the
// picture (S8). Every one was a consumer owning its own copy of a visibility rule.
//
// So: the flags are readable from ONE module, and this fails if a render/preview consumer reaches
// for them directly instead of asking `visibility.ts`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Timeline } from "./model";
import { resolveRenderPlan } from "./renderPlan";

const SRC = join(process.cwd(), "src");

/** The flags that decide whether something plays. */
const FLAGS = ["hidden", "solo", "disabled", "mute"];

/** Modules that TURN PIXELS OR SAMPLES INTO OUTPUT. These are the ones that drifted, and the ones
 *  a user can never see the disagreement of until an export comes out wrong. */
const CONSUMERS = [
  "timeline/renderPlan.ts",
  "timeline/render.ts",
  "preview/scene.ts",
  "preview/audioEngine.ts",
  "preview/previewWorker.ts",
  "preview/protocol.ts",
];

const codeOf = (rel: string): string =>
  readFileSync(join(SRC, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("visibility.ts owns 'does this play?'", () => {
  it("no render or preview consumer reads a playback flag itself", () => {
    const offenders: string[] = [];
    for (const rel of CONSUMERS) {
      const src = codeOf(rel);
      // `.hidden` / `.solo` / `.disabled` / `.mute` as a property read — the shape a hand-rolled
      // filter takes. Asking visibility.ts instead leaves no such access here.
      const hits = FLAGS.filter((f) => new RegExp(`\\.${f}\\b`).test(src));
      if (hits.length) offenders.push(`${rel}: ${hits.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("visibility.ts stays pure — no I/O, no lock, no tool context", () => {
    const src = codeOf("timeline/visibility.ts");
    expect(src).not.toMatch(/\bawait\b/);
    expect(src).not.toMatch(/ClientToolContext|applyOp|runGesture/);
  });
});

// The check above is NEGATIVE: "no consumer reads a flag itself". S9 slipped straight through it,
// because the exporter read no flag — it ignored them. Gating everything with `visibleTracks` made
// audio inherit `hidden`, `mute` was never consulted in the export path, and a muted track shipped
// in the mp4 while the preview stayed silent. A consumer that honours NOTHING is maximally
// compliant with "don't hand-roll a filter".
//
// So the same FLAGS table also drives a POSITIVE, behavioural assertion: each flag must actually
// suppress output in the EXPORT plan. Anchoring it to the table rather than writing one test per
// flag is deliberate — `resolveRenderPlan` already had a hand-written "a HIDDEN track does not
// reach the export" test, and nobody wrote the `mute` twin for four months. Adding a flag to FLAGS
// now fails here until its suppression case exists.
const canvas = { width: 1920, height: 1080, fps: 30 };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const vclip = (id: string, o: Any = {}): Any => ({
  id,
  kind: "video",
  media_ref: "v.mp4",
  source_in: 0,
  source_out: 2,
  timeline_in: 0,
  timeline_out: 2,
  ...o,
});
const aclip = (id: string, o: Any = {}): Any => ({
  id,
  kind: "audio",
  media_ref: "a.wav",
  source_in: 0,
  source_out: 2,
  timeline_in: 0,
  timeline_out: 2,
  ...o,
});
const tl = (tracks: Any[]): Timeline => ({ canvas, tracks }) as Timeline;

/** Per flag: a timeline where it MUST suppress `gone`, while `kept` still renders. `kept` is what
 *  stops a vacuous pass — a plan that dropped everything would satisfy "gone is absent". */
const SUPPRESSES: Record<string, { timeline: Timeline; gone: string; kept: string }> = {
  hidden: {
    timeline: tl([
      { id: "v1", kind: "video", z: 0, hidden: true, clips: [vclip("gone")] },
      { id: "v2", kind: "video", z: 1, clips: [vclip("kept")] },
    ]),
    gone: "gone",
    kept: "kept",
  },
  mute: {
    timeline: tl([
      { id: "v1", kind: "video", z: 0, clips: [vclip("kept")] },
      { id: "a1", kind: "audio", z: 1, mute: true, clips: [aclip("gone")] },
    ]),
    gone: "gone",
    kept: "kept",
  },
  disabled: {
    timeline: tl([
      { id: "v1", kind: "video", z: 0, clips: [vclip("gone", { disabled: true }), vclip("kept")] },
    ]),
    gone: "gone",
    kept: "kept",
  },
  solo: {
    timeline: tl([
      { id: "a1", kind: "audio", z: 0, solo: true, clips: [aclip("kept")] },
      { id: "a2", kind: "audio", z: 1, clips: [aclip("gone")] },
    ]),
    gone: "gone",
    kept: "kept",
  },
};

describe("every playback flag suppresses the EXPORT, not just the preview", () => {
  it.each(FLAGS)("`%s` keeps its clip out of the render plan", (flag) => {
    const c = SUPPRESSES[flag];
    expect(c, `no suppression case for '${flag}' — add one when you add the flag`).toBeDefined();
    const ids = resolveRenderPlan(c.timeline).clips.map((pc) => pc.srcClipId);
    expect(ids).not.toContain(c.gone);
    // ...and the plan still rendered something, so the assertion above isn't vacuous.
    expect(ids).toContain(c.kept);
  });

  // The other direction of S9, and the reason the fix is a per-KIND gate rather than an extra
  // `mute` filter bolted onto the video rule: each flag governs its OWN medium. `hidden` is about
  // pixels, `mute` is about samples. The preview has always behaved this way (audioEngine.ts asks
  // audibleTracks, which never looks at `hidden`), so an exporter that drops a hidden lane's sound
  // is the SAME preview/export disagreement as the reported bug, just pointing the other way.
  it("a HIDDEN lane still SOUNDS when it is not muted (hidden governs picture, mute governs sound)", () => {
    const plan = resolveRenderPlan(
      tl([
        { id: "v1", kind: "video", z: 0, clips: [vclip("pic")] },
        { id: "a1", kind: "audio", z: 1, hidden: true, clips: [aclip("sound")] },
      ]),
    );
    const ids = plan.clips.map((pc) => pc.srcClipId);
    expect(ids).toContain("sound");
    expect(ids).toContain("pic");
  });
});
