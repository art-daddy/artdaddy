// Adversarial guard for the effect registry. The bug this exists to prevent:
// apply_effects accepted `{type:"glow"}`, stored it, returned ok — and the export
// had ZERO glow pixels, because the renderer needed an `amount` nothing supplied.
// So these tests assert the RENDER OUTPUT changes, never just that the tool said ok
// or that the stored object has a key.
import { describe, expect, it } from "vitest";

import { allEffects } from "../contract";
import { resolveEffect, resolveGrade, typesFor } from "./effectRegistry";
import type { Timeline } from "./model";
import { buildRenderCommand } from "./render";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

interface RegParam {
  key: string;
  type: string;
  minimum: number | null;
  maximum: number | null;
  default: number | string | null;
}
interface RegEffect {
  id: string;
  kind: string;
  params: RegParam[];
}
const EFFECTS = allEffects() as unknown as RegEffect[];
const VIDEO = EFFECTS.filter((e) => e.kind === "video");
const AUDIO = EFFECTS.filter((e) => e.kind === "audio");

function videoPlan(effects: Any[]): ReturnType<typeof buildRenderCommand> {
  const timeline = {
    canvas: { width: 640, height: 360, fps: 30 },
    tracks: [
      {
        id: "v0",
        kind: "video",
        z: 0,
        clips: [
          {
            id: "a",
            media_ref: "/a.mp4",
            source_in: 0,
            source_out: 2,
            timeline_in: 0,
            timeline_out: 2,
            ...(effects.length ? { effects } : {}),
          },
        ],
      },
    ],
  } as unknown as Timeline;
  return buildRenderCommand(timeline, "/o.mp4");
}

function audioPlan(effects: Any[]): ReturnType<typeof buildRenderCommand> {
  const timeline = {
    canvas: { width: 640, height: 360, fps: 30 },
    tracks: [
      {
        id: "a0",
        kind: "audio",
        z: 0,
        clips: [
          {
            id: "s",
            kind: "audio",
            media_ref: "/a.mp3",
            source_in: 0,
            source_out: 2,
            timeline_in: 0,
            timeline_out: 2,
            ...(effects.length ? { audio_effects: effects } : {}),
          },
        ],
      },
    ],
  } as unknown as Timeline;
  return buildRenderCommand(timeline, "/o.mp4");
}

describe("every registry effect either renders bare, or is refused bare", () => {
  // THE load-bearing invariant, and the one the original bug violated: an effect
  // must never be ACCEPTED and then render nothing. Either a bare call produces a
  // real change in the filtergraph, or it is rejected with an actionable message.
  // "Stored ok" is not a legal outcome on its own.
  const baseline = videoPlan([]).filterComplex;

  it.each(VIDEO.map((e) => [e.id, e] as const))("video '%s'", (_id, def) => {
    const { effect, error } = resolveEffect({ type: def.id }, "video");
    if (error) {
      expect(error).toContain(def.id);
      return;
    }
    const plan = videoPlan([effect]);
    expect(plan.filterComplex).not.toBe(baseline);
    expect(plan.warnings.some((w) => w.includes("unknown effect"))).toBe(false);
  });

  const audioBaseline = audioPlan([]).filterComplex;
  it.each(AUDIO.map((e) => [e.id, e] as const))("audio '%s'", (_id, def) => {
    const { effect, error } = resolveEffect({ type: def.id }, "audio");
    if (error) {
      expect(error).toContain(def.id);
      return;
    }
    expect(audioPlan([effect]).filterComplex).not.toBe(audioBaseline);
  });

  it("the regression itself: a bare glow emits the bloom sub-graph", () => {
    const { effect } = resolveEffect({ type: "glow" }, "video");
    // Was: `{type:"glow"}` stored verbatim -> glowFromEffects() returned undefined -> no pixels.
    expect(videoPlan([effect]).filterComplex).toContain("split=2");
  });

  it("refuses the inert cases instead of storing them (eq/pan/custom have no sane default)", () => {
    for (const [type, kind] of [
      ["eq", "audio"],
      ["pan", "audio"],
      ["custom", "video"],
    ] as const) {
      const { effect, error } = resolveEffect({ type }, kind);
      expect(effect, `${type} should not be stored bare`).toBeUndefined();
      expect(error).toContain("render nothing");
    }
  });

  it("an explicitly zeroed effect is refused, not silently stored as a no-op", () => {
    const { effect, error } = resolveEffect({ type: "blur", params: { radius: 0 } }, "video");
    expect(effect).toBeUndefined();
    expect(error).toContain("enabled:false");
  });
});

describe("resolveEffect rejects what it cannot honour", () => {
  it("rejects an unknown type and names the valid ones", () => {
    const { effect, error } = resolveEffect({ type: "bloom" }, "video");
    expect(effect).toBeUndefined();
    expect(error).toContain("bloom");
    for (const t of typesFor("video")) expect(error).toContain(t);
  });

  it("rejects a param that belongs to a DIFFERENT effect", () => {
    const { effect, error } = resolveEffect({ type: "glow", params: { bass: 3 } }, "video");
    expect(effect).toBeUndefined();
    expect(error).toContain("bass");
    expect(error).toContain("intensity");
  });

  it("rejects a non-numeric value for a numeric param", () => {
    const { error } = resolveEffect({ type: "blur", params: { radius: "wide" } }, "video");
    expect(error).toContain("radius");
  });

  it("resolves by KIND: the same id means different params for video vs audio", () => {
    expect(resolveEffect({ type: "denoise", params: { strength: 6 } }, "video").effect).toEqual({
      type: "denoise",
      params: { strength: 6 },
    });
    // The video param must NOT be accepted on the audio side, and vice versa.
    expect(resolveEffect({ type: "denoise", params: { strength: 6 } }, "audio").error).toContain(
      "strength",
    );
    expect(
      resolveEffect({ type: "denoise", params: { reduction_db: 30 } }, "audio").effect,
    ).toEqual({ type: "denoise", params: { reduction_db: 30 } });
    expect(resolveEffect({ type: "eq", params: { bass: 1 } }, "video").error).toContain(
      "unknown video effect",
    );
  });
});

describe("clamping and merge semantics", () => {
  const params = (r: ReturnType<typeof resolveEffect>): Any => r.effect?.params;

  it("clamps out of range instead of rejecting, at BOTH ends", () => {
    expect(params(resolveEffect({ type: "blur", params: { radius: 9999 } }, "video")).radius).toBe(
      50,
    );
    expect(params(resolveEffect({ type: "pan", params: { balance: -9 } }, "audio")).balance).toBe(
      -1,
    );
    expect(
      params(resolveEffect({ type: "compressor", params: { threshold: -999 } }, "audio")).threshold,
    ).toBe(-60);
  });

  it("clamping that lands on zero is refused, not stored as an inert effect", () => {
    // The two rules interact: -5 clamps to a 0 radius, which would render nothing.
    const { effect, error } = resolveEffect({ type: "blur", params: { radius: -5 } }, "video");
    expect(effect).toBeUndefined();
    expect(error).toContain("render nothing");
  });

  it("a partial update keeps the values it does not mention", () => {
    const first = resolveEffect({ type: "chroma", params: { similarity: 0.9 } }, "video").effect!;
    const second = resolveEffect(
      { type: "chroma", params: { blend: 0.5 } },
      "video",
      first,
    ).effect!;
    expect((second.params as Any).similarity).toBe(0.9); // carried, not reset to the default
    expect((second.params as Any).blend).toBe(0.5);
  });

  it("a param with no registry default stays absent rather than being invented", () => {
    // glow.opacity is deliberately defaultless so the renderer can scale it from intensity.
    expect(resolveEffect({ type: "glow" }, "video").effect).toEqual({
      type: "glow",
      params: { intensity: 25 },
    });
  });

  it("enabled:false survives resolution and bypasses the render", () => {
    const off = resolveEffect({ type: "blur", enabled: false }, "video").effect!;
    expect(off.enabled).toBe(false);
    expect(videoPlan([off]).filterComplex).toBe(videoPlan([]).filterComplex);
    const offGlow = resolveEffect({ type: "glow", enabled: false }, "video").effect!;
    expect(videoPlan([offGlow]).filterComplex).not.toContain("split=2");
  });
});

describe("apply_color grade knobs (same registry, flat face)", () => {
  it("clamps every numeric knob to its registry range \u2014 the description promised this and nothing did it", () => {
    const { grade } = resolveGrade({ exposure: 99, saturation: -5, temperature: 1e9 });
    expect(grade).toEqual({ exposure: 3, saturation: 0, temperature: 40000 });
  });

  it("rejects an unknown knob instead of silently dropping it", () => {
    const { grade, error } = resolveGrade({ warmth: 20 });
    expect(grade).toBeUndefined();
    expect(error).toContain("warmth");
    expect(error).toContain("temperature"); // names the real knobs
  });

  it("rejects a junk key smuggled in via a pasted whole-grade object", () => {
    // The grade-copy path used to Object.assign anything into clip.color.
    expect(resolveGrade({ exposure: 0.2, __proto__x: 1 }).error).toContain("__proto__x");
  });

  it("rejects a literal __proto__ key rather than letting it reach the prototype setter", () => {
    const hostile = JSON.parse('{"exposure":0.2,"__proto__":{"polluted":true}}');
    const patch = Object.assign(Object.create(null), hostile);
    expect(resolveGrade(patch).error).toContain("__proto__");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("does NOT invent neutral values: an unset knob means 'don't touch'", () => {
    // Unlike effects, a grade is a partial patch \u2014 filling defaults would rewrite
    // knobs the user never mentioned.
    expect(resolveGrade({ contrast: 1.2 }).grade).toEqual({ contrast: 1.2 });
  });

  it("passes non-numeric knobs (lut, curves) through untouched", () => {
    const curve = [
      [0, 0.05],
      [1, 0.95],
    ];
    const { grade } = resolveGrade({ lut: "media_1.cube", masterCurve: curve });
    expect(grade).toEqual({ lut: "media_1.cube", masterCurve: curve });
  });
});

describe("registry integrity", () => {
  it("a param key never means two different things (what a shared `amount` cost us)", () => {
    const seen = new Map<string, string>();
    for (const e of EFFECTS) {
      for (const p of e.params) {
        const sig = `${p.type}:${p.minimum}:${p.maximum}`;
        const prev = seen.get(p.key);
        if (prev !== undefined) expect(sig, `param '${p.key}'`).toBe(prev);
        seen.set(p.key, sig);
      }
    }
  });

  it("every numeric default sits inside its own declared range", () => {
    for (const e of EFFECTS) {
      for (const p of e.params) {
        if (p.type !== "number" || typeof p.default !== "number") continue;
        if (p.minimum !== null)
          expect(p.default, `${e.id}.${p.key}`).toBeGreaterThanOrEqual(p.minimum);
        if (p.maximum !== null)
          expect(p.default, `${e.id}.${p.key}`).toBeLessThanOrEqual(p.maximum);
      }
    }
  });

  it("no effect is silently inert: it renders bare or it is refused (glow's old default of 0 would fail here)", () => {
    for (const e of EFFECTS) {
      const { effect, error } = resolveEffect({ type: e.id }, e.kind as "video" | "audio");
      expect(Boolean(effect) !== Boolean(error), `${e.id} must resolve or refuse`).toBe(true);
    }
  });
});
