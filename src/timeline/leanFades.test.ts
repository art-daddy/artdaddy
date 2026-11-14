// Fix 2 in the real builder (Phase 3a): which per-pixel alpha filters get an `enable` window, that "off" and "plain" are 0.27.0 byte for byte, that the lean graph is today's graph plus those
// windows (and a shorter dip layer), and, independent of how render.ts calls leanWindows.ts, that every window is a SUPERSET of the frames whose factor (the expression text the builder
// itself wrote) is not exactly 1. The pixels are proved against real ffmpeg by the sweep harness (framemd5 before the encoder, switch off against on); these tests pin the decision and the graph.
import { describe, expect, it } from "vitest";
import type { Timeline } from "./model";
import { buildRenderCommand } from "./render";
import { compileLeanExpr } from "./leanExpr";
import type { LeanOptions } from "./leanOptions";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const OUT = "/out.mp4";
const FPS = 30;
const timeline = (tracks: Any[], canvas = { width: 1920, height: 1080, fps: FPS }): Timeline =>
  ({ canvas, tracks }) as Timeline;
const clip = (i: number, tin: number, tout: number, extra: Record<string, unknown> = {}) => ({
  media_ref: `/c${i}.mp4`,
  source_in: 0,
  source_out: tout - tin,
  timeline_in: tin,
  timeline_out: tout,
  ...extra,
});

/** Six abutting 4 s clips on one track: a fade in, every transition kind, an animated opacity and a fade out. */
function richProject(): Timeline {
  return timeline([
    {
      id: "v",
      kind: "video",
      z: 0,
      clips: [
        clip(0, 0, 4, { fade: { in: 30, out: 0 } }),
        clip(1, 4, 8, { transition_in: { kind: "crossfade", duration: 0.5 } }),
        clip(2, 8, 12, {
          transition_in: { kind: "whip", duration: 0.5 },
          opacity: [
            { t: 0, v: 1 },
            { t: 1, v: 0.6 },
            { t: 2, v: 1 },
          ],
        }),
        clip(3, 12, 16, { transition_in: { kind: "wipe-l", duration: 0.4 } }),
        clip(4, 16, 20, {
          transition_in: { kind: "wipe-r", duration: 0.5 },
          fade: { in: 0, out: 45 },
        }),
        clip(5, 20, 24, { transition_in: { kind: "dip-to-black", duration: 0.8 } }),
      ],
    },
  ]);
}

const ALPHA_GEQ =
  /geq=lum='lum\(X,Y\)':cb='cb\(X,Y\)':cr='cr\(X,Y\)':a='(alpha\(X,Y\)\*[^']*)'(:enable='([^']*)')?/g;
const stripWindows = (graph: string) =>
  graph.replace(/(a='alpha\(X,Y\)\*[^']*')(:enable='[^']*')/g, "$1");

describe("fix 2: the switches and the record", () => {
  it("without the lean option the plan is 0.27.0's; with every switch off the graph is byte-identical and each construct is counted as kept: flag_off", () => {
    const base = buildRenderCommand(richProject(), OUT);
    expect(base.lean).toBeUndefined();
    const off = buildRenderCommand(richProject(), OUT, { lean: { fades: false, dip: false } });
    expect(off.filterComplex).toBe(base.filterComplex);
    expect(off.args).toEqual(base.args);
    expect(off.lean).toEqual({ ran: [], kept: ["flag_off"] });
  });

  it("a plain build (the person's Try again) keeps today's graph whatever the switches say, and counts nothing", () => {
    const base = buildRenderCommand(richProject(), OUT);
    const plain = buildRenderCommand(richProject(), OUT, {
      lean: { plain: true, fades: true, dip: true },
    });
    expect(plain.filterComplex).toBe(base.filterComplex);
    expect(plain.lean).toEqual({ ran: [], kept: [] });
  });

  it("with the switches on, the graph is today's graph plus the enable windows and a shorter dip layer, nothing else", () => {
    const base = buildRenderCommand(richProject(), OUT);
    const fades = buildRenderCommand(richProject(), OUT, { lean: { fades: true } });
    expect(fades.lean?.ran).toEqual(["fades"]);
    expect(fades.filterComplex).not.toBe(base.filterComplex);
    expect(stripWindows(fades.filterComplex)).toBe(base.filterComplex);
    const dip = buildRenderCommand(richProject(), OUT, { lean: { dip: true } });
    expect(dip.lean?.ran).toEqual(["dip"]);
    const layer = (g: string) =>
      /color=c=black:s=1920x1080:r=30:d=([\d.]+)[^;]*geq=r='0'/.exec(g)![1];
    expect(Number(layer(base.filterComplex))).toBeCloseTo(24, 3);
    expect(Number(layer(dip.filterComplex))).toBeLessThan(2);
    // the base canvas stream, the overlay gate and every other chain are the same text
    const without = (g: string) =>
      g.replace(
        /color=c=black:s=1920x1080:r=30:d=[\d.]+(,setpts=PTS\+\d+)?(,format=rgba,geq=r='0')/,
        "LAYER$2",
      );
    expect(without(dip.filterComplex)).toBe(without(base.filterComplex));
  });

  it("every alpha geq of the lean graph carries a window, except the wipe-right clips that are not a shape of the proof", () => {
    const lean: LeanOptions = { fades: true };
    const plan = buildRenderCommand(richProject(), OUT, { lean });
    const all = [...plan.filterComplex.matchAll(ALPHA_GEQ)];
    expect(all.length).toBeGreaterThanOrEqual(7);
    for (const m of all) expect(m[3], m[1]).toBeDefined();
  });
});

describe("fix 2: the wipe-right exception is taken only for a clip with one fixed left edge", () => {
  const wipeRight = (extra: Record<string, unknown>) =>
    timeline([
      {
        id: "v",
        kind: "video",
        z: 0,
        clips: [
          clip(0, 0, 4),
          clip(1, 4, 8, { transition_in: { kind: "wipe-r", duration: 0.5 }, ...extra }),
        ],
      },
    ]);
  const windowed = (g: string) =>
    [...g.matchAll(ALPHA_GEQ)]
      .filter((m) => m[1].includes("gt(X,W*(1-"))
      .map((m) => m[3] !== undefined);

  it("a static, unrotated, unblended clip gets the window; a rotated, blended, animated-position or cropped one keeps today's graph and says not_proven", () => {
    const lean: LeanOptions = { fades: true };
    const eligible = buildRenderCommand(wipeRight({}), OUT, { lean });
    expect(windowed(eligible.filterComplex)).toEqual([true]);
    expect(eligible.lean).toEqual({ ran: ["fades"], kept: [] });
    for (const extra of [
      { rotate: 10 },
      { blend: "screen" },
      {
        transform: {
          position: {
            x: [
              { t: 0, v: 0.4 },
              { t: 1, v: 0.6 },
            ],
            y: 0.5,
          },
        },
      },
      { crop: { left: 0.1, right: 0, top: 0, bottom: 0 } },
      { flip: { h: true } },
    ]) {
      const t = wipeRight(extra);
      const plan = buildRenderCommand(t, OUT, { lean });
      expect(windowed(plan.filterComplex), JSON.stringify(extra)).toEqual([false]);
      expect(plan.lean?.kept, JSON.stringify(extra)).toContain("not_proven");
      expect(plan.filterComplex, JSON.stringify(extra)).toBe(
        buildRenderCommand(t, OUT).filterComplex,
      );
    }
  });
});

// The factor of every windowed geq, evaluated by the evaluator over the frames of the project, at several widths and columns, against the window the builder emitted.
describe("fix 2: every window the builder emits is a superset of the frames where its factor is not 1 (independent of how render.ts calls the window functions)", () => {
  const widths = [2, 3, 10, 1080, 1920];
  const factorOf = (text: string) => compileLeanExpr(text.replace(/alpha\(X,Y\)/g, "1"));

  function check(t: Timeline, seconds: number) {
    const plan = buildRenderCommand(t, OUT, { lean: { fades: true } });
    const found = [...plan.filterComplex.matchAll(ALPHA_GEQ)];
    expect(found.length).toBeGreaterThan(0);
    let checked = 0;
    for (const m of found) {
      const factor = factorOf(m[1]);
      expect(factor, m[1]).not.toBeNull();
      const window = m[3] === undefined ? null : compileLeanExpr(m[3]);
      if (m[3] !== undefined) expect(window, m[3]).not.toBeNull();
      // wipe-right is the owner's one exception: today's factor on a late frame is gt(X,0), zero at column 0 for the rest of the clip, and the window closes on purpose; the superset rule
      // is judged on the columns that really change (1 and up), and the window must be closed once the wipe is over
      const wipeRight = m[1].includes("gt(X,W*(1-");
      const columns = (W: number) =>
        wipeRight ? [1, Math.floor(W / 2), W - 1] : [0, 1, Math.floor(W / 2), W - 1];
      let lastOpen = -Infinity;
      for (let k = -4; k <= Math.ceil(seconds * FPS) + 4; k++) {
        const T = k / FPS;
        const needs = widths.some((W) =>
          columns(W).some((X) => {
            const v = factor!({ T, W, H: 1080, X, Y: 0 });
            return !(v === 1);
          }),
        );
        if (window && window({ T, W: 1920, H: 1080 }) !== 0) lastOpen = k;
        if (!needs) continue;
        checked++;
        if (window)
          expect(window({ T, W: 1920, H: 1080 }), `${m[1]} at frame ${k}: ${m[3]}`).not.toBe(0);
      }
      if (wipeRight) {
        expect(window, m[1]).not.toBeNull();
        // closed for every frame from two frames after the last frame that still needs it
        expect(window!({ T: (lastOpen + 3) / FPS, W: 1920, H: 1080 }), m[3]).toBe(0);
        expect(window!({ T: (Math.ceil(seconds * FPS) + 4) / FPS, W: 1920, H: 1080 }), m[3]).toBe(
          0,
        );
      }
    }
    expect(checked).toBeGreaterThan(50);
  }

  it("the six-clip project (a fade in, every transition kind, an animated opacity, a fade out)", () => {
    check(richProject(), 24);
  });

  it("odd and even transition lengths and fades at the project's first frame (a negative start)", () => {
    for (const duration of [0.5, 0.4, 1 / 3, 0.1]) {
      for (const kind of ["crossfade", "wipe-l", "whip", "dip-to-white"]) {
        check(
          timeline([
            {
              id: "v",
              kind: "video",
              z: 0,
              clips: [
                clip(0, 0, 2, { transition_in: { kind, duration }, fade: { in: 12, out: 9 } }),
                clip(1, 2, 5, { transition_in: { kind: "crossfade", duration } }),
              ],
            },
          ]),
          5,
        );
      }
    }
  });
});
