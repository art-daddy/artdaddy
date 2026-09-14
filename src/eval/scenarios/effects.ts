// Effect-stack scenarios: the capabilities the registry rework added or exposed —
// bypass vs remove, partial merge, copying a look via the echoed stack, audio
// effects, and RECOVERY from a refusal. The last one matters most: apply_effects
// now REFUSES a call that would render nothing, and a bad refusal message would
// make the model thrash — which is the exact failure the rework fixed.
import type { Scenario } from "../types";
import { aclip, assert, atrack, clipById, timeline, vclip, vtrack } from "./helpers";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- graders poke the effect stack
type Any = any;

const fx = (c: Any, type: string): Any =>
  (c?.effects ?? []).find((e: Any) => e?.type === type) ??
  (c?.audio_effects ?? []).find((e: Any) => e?.type === type);

export const EFFECT_SCENARIOS: Scenario[] = [
  {
    id: "effect_disable",
    title: "Bypass an effect without losing it",
    tags: ["effects", "enabled"],
    seed: () =>
      timeline([
        vtrack("v1", 1, [
          vclip("a", "a.mp4", 0, 90, {
            effects: [{ type: "blur", params: { radius: 12 } }],
          } as Any),
        ]),
      ]),
    prompt: "Turn the blur off for now, but keep its settings so I can bring it back.",
    expect: (tl) => {
      const blur = fx(clipById(tl, "a"), "blur");
      assert(blur, "the blur was removed entirely; it should be bypassed, not deleted");
      assert(blur.enabled === false, "expected the blur to be bypassed (enabled:false)");
      assert(
        Number(blur.params?.radius) === 12,
        "bypassing must PRESERVE the settings (radius 12)",
      );
    },
    expectTools: ["apply_effects"],
    maxRounds: 4,
  },
  {
    id: "effect_remove",
    title: "Remove an effect",
    tags: ["effects", "remove"],
    seed: () =>
      timeline([
        vtrack("v1", 1, [
          vclip("a", "a.mp4", 0, 90, {
            effects: [
              { type: "grain", params: { grain: 40 } },
              { type: "vignette", params: { vignette: 0.4 } },
            ],
          } as Any),
        ]),
      ]),
    prompt: "Get rid of the film grain — it's too noisy. Leave everything else alone.",
    expect: (tl) => {
      const c = clipById(tl, "a") as Any;
      assert(!fx(c, "grain"), "expected the grain to be gone");
      // The failure direction: nuking the whole stack instead of one effect.
      assert(fx(c, "vignette"), "the vignette must survive — only the grain was asked for");
    },
    expectTools: ["apply_effects"],
    maxRounds: 4,
  },
  {
    id: "effect_partial_update",
    title: "Change one knob, keep the rest",
    tags: ["effects", "merge"],
    seed: () =>
      timeline([
        vtrack("v1", 1, [
          vclip("a", "a.mp4", 0, 90, {
            effects: [
              { type: "chroma", params: { color: "#00FF00", similarity: 0.2, blend: 0.4 } },
            ],
          } as Any),
        ]),
      ]),
    prompt: "The green screen key is leaving fringes — widen the tolerance a bit.",
    expect: (tl) => {
      const k = fx(clipById(tl, "a"), "chroma");
      assert(k, "expected the chroma key to still be there");
      assert(
        Number(k.params?.similarity) > 0.2,
        `expected similarity to increase from 0.2, got ${k.params?.similarity}`,
      );
      // The merge must not reset the knobs the prompt never mentioned.
      assert(String(k.params?.color).toUpperCase() === "#00FF00", "key colour must be preserved");
      assert(Number(k.params?.blend) === 0.4, "blend must be preserved (it was not mentioned)");
    },
    expectTools: ["apply_effects"],
    maxRounds: 4,
  },
  {
    id: "effect_copy_look",
    title: "Copy a look between clips",
    tags: ["effects", "echo"],
    seed: () =>
      timeline([
        vtrack("v1", 1, [
          vclip("a", "a.mp4", 0, 60, {
            effects: [
              { type: "grain", params: { grain: 35 } },
              { type: "vignette", params: { vignette: 0.5 } },
            ],
          } as Any),
          vclip("b", "b.mp4", 60, 120),
        ]),
      ]),
    prompt: "Make the second clip look like the first one.",
    expect: (tl) => {
      const b = clipById(tl, "b") as Any;
      for (const type of ["grain", "vignette"]) {
        const src = fx(clipById(tl, "a"), type);
        const dst = fx(b, type);
        assert(dst, `expected '${type}' to be copied onto the second clip`);
        assert(
          Number(dst.params?.[type]) === Number(src.params?.[type]),
          `${type} should match the source clip (${src.params?.[type]}), got ${dst.params?.[type]}`,
        );
      }
    },
    expectTools: ["apply_effects"],
    maxRounds: 6,
  },
  {
    id: "audio_eq_boost",
    title: "Audio effect on a music clip",
    tags: ["effects", "audio"],
    seed: () =>
      timeline([
        vtrack("v1", 1, [vclip("a", "a.mp4", 0, 90)]),
        atrack("a1", 0, [aclip("m", "music.mp3", 0, 90)]),
      ]),
    prompt: "The music sounds thin — give it more low end.",
    expect: (tl) => {
      const eq = fx(clipById(tl, "m"), "eq");
      assert(eq, "expected an eq on the music clip");
      assert(Number(eq.params?.bass) > 0, `expected a bass boost, got ${eq.params?.bass}`);
    },
    expectTools: ["apply_effects"],
    maxRounds: 5,
  },
  {
    id: "effect_refusal_recovery",
    title: "Recover from a refusal",
    tags: ["effects", "regression:refusal"],
    seed: () =>
      timeline([
        vtrack("v1", 1, [vclip("a", "a.mp4", 0, 90)]),
        atrack("a1", 0, [aclip("m", "music.mp3", 0, 90)]),
      ]),
    // Deliberately value-free: the likely first move is a bare {type:"eq"}, which
    // apply_effects now REFUSES. What is being measured is whether the refusal text
    // is actionable enough for the model to recover instead of retrying forever.
    prompt: "Put an EQ on the music.",
    expect: (tl) => {
      const eq = fx(clipById(tl, "m"), "eq");
      assert(eq, "expected an eq to land eventually, even if the first attempt was refused");
      const p = eq.params ?? {};
      assert(
        Number(p.bass) !== 0 || Number(p.treble) !== 0,
        "an eq that changes nothing should never have been stored",
      );
    },
    expectTrace: (trace) => {
      // The point of the scenario: a refusal must not become a retry loop.
      const calls = trace.toolCalls.filter((c) => c.name === "apply_effects");
      assert(
        calls.length <= 3,
        `apply_effects was called ${calls.length}x — the refusal message is not actionable enough`,
      );
    },
    expectTools: ["apply_effects"],
    // The refusal this scenario exists to provoke IS a tool error. Without an
    // allowance the scenario could never pass, however well the model recovered.
    maxToolErrors: 1,
    maxRounds: 6,
  },
];
