// Pixel-level caption smoke: renders a REAL mp4 through the BUNDLED ffmpeg (which ships libass) and
// asserts the caption produces visible pixels. This is the guard the string-only unit tests missed —
// the `ass`-on-transparent-layer regression passed every graph-string assertion while compositing
// nothing. NOT part of the unit suite: `npx vitest run --config vitest.smoke.config.ts`.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { Timeline } from "./model";
import { buildRenderCommand } from "./render";

// The bundled ffmpeg has libass (the PATH one may not); resolve the current platform's sidecar.
function bundledFfmpeg(): string | null {
  const dir = path.resolve(process.cwd(), "src-tauri/binaries");
  const names =
    process.platform === "win32"
      ? ["ffmpeg-x86_64-pc-windows-msvc.exe"]
      : process.platform === "darwin"
        ? ["ffmpeg-aarch64-apple-darwin", "ffmpeg-x86_64-apple-darwin"]
        : ["ffmpeg-x86_64-unknown-linux-gnu"];
  for (const n of names) {
    const p = path.join(dir, n);
    if (existsSync(p)) return p;
  }
  return null;
}
const FF = bundledFfmpeg();
const FONTS_SRC = path.resolve(process.cwd(), "src-tauri/resources/fonts");

function run(
  program: string,
  args: string[],
  cwd?: string,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { cwd, windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("error", (e) => resolve({ code: -1, stderr: String(e) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

/** Max luma across all frames of a rendered file (libass draws white text ~235; a black canvas ~16).
 *  `pre` is an optional filter (e.g. a crop) applied before signalstats to measure a sub-region. */
async function maxLuma(ff: string, file: string, pre = ""): Promise<number> {
  const vf = pre ? `${pre},signalstats,metadata=print` : "signalstats,metadata=print";
  const r = await run(ff, ["-hide_banner", "-i", file, "-vf", vf, "-f", "null", "-"]);
  let max = -1;
  for (const m of r.stderr.matchAll(/lavfi\.signalstats\.YMAX=(\d+)/g))
    max = Math.max(max, Number(m[1]));
  return max;
}

/** Mean luma of a (optionally cropped) region — solid fills (a box) raise it far above thin glyphs. */
async function avgLuma(ff: string, file: string, pre = ""): Promise<number> {
  const vf = pre ? `${pre},signalstats,metadata=print` : "signalstats,metadata=print";
  const r = await run(ff, ["-hide_banner", "-i", file, "-vf", vf, "-f", "null", "-"]);
  let max = -1;
  for (const m of r.stderr.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g))
    max = Math.max(max, Number(m[1]));
  return max;
}

/** {max,avg} luma of the frame at time `t` seconds (extracts a lossless PNG first). */
async function frameStats(
  ff: string,
  mp4: string,
  t: number,
): Promise<{ max: number; avg: number }> {
  const png = `${mp4}.${Math.round(t * 1000)}.png`;
  await run(ff, ["-y", "-ss", String(t), "-i", mp4, "-frames:v", "1", png]);
  const r = await run(ff, [
    "-hide_banner",
    "-i",
    png,
    "-vf",
    "signalstats,metadata=print",
    "-f",
    "null",
    "-",
  ]);
  const mx = r.stderr.match(/lavfi\.signalstats\.YMAX=(\d+)/);
  const av = r.stderr.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
  return { max: mx ? Number(mx[1]) : -1, avg: av ? Number(av[1]) : -1 };
}

/** Peak luma of a CROPPED region of the frame at `t`. Whole-frame stats answer "how much ink"; a
 *  reveal has to be asked "is there ink over HERE yet", which only a region can answer. */
async function regionMaxLuma(ff: string, mp4: string, t: number, crop: string): Promise<number> {
  const png = `${mp4}.r${Math.round(t * 1000)}.png`;
  await run(ff, ["-y", "-ss", String(t), "-i", mp4, "-frames:v", "1", png]);
  const r = await run(ff, [
    "-hide_banner",
    "-i",
    png,
    "-vf",
    `${crop},signalstats,metadata=print`,
    "-f",
    "null",
    "-",
  ]);
  const mx = r.stderr.match(/lavfi\.signalstats\.YMAX=(\d+)/);
  return mx ? Number(mx[1]) : -1;
}

/** Stage the plan's .ass + referenced fonts into `cwd` (mirrors runRenderPlan) and render. The graph
 *  references the .ass by BARE name, so it must run with `cwd` = the scratch dir. */
async function render(ff: string, cwd: string, timeline: Timeline): Promise<string> {
  const out = path.join(cwd, "out.mp4");
  const plan = buildRenderCommand(timeline, out);
  for (const f of plan.assFiles) await fsp.writeFile(path.join(cwd, f.name), f.content);
  if (plan.fonts.length) {
    await fsp.mkdir(path.join(cwd, "fonts"), { recursive: true });
    for (const file of plan.fonts)
      await fsp.copyFile(path.join(FONTS_SRC, file), path.join(cwd, "fonts", file));
  }
  const r = await run(ff, plan.args, cwd);
  expect(r.code, `ffmpeg failed: ${r.stderr.slice(-600)}`).toBe(0);
  return out;
}

const scratches: string[] = [];
async function scratch(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-cap-"));
  scratches.push(d);
  return d;
}
afterAll(async () => {
  for (const d of scratches)
    await fsp.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

const canvas = { width: 320, height: 240, fps: 30 };
const textClip = (z: number) => ({
  id: `t${z}`,
  kind: "text",
  z,
  clips: [
    {
      kind: "text",
      text: "HELLO",
      timeline_in: 0,
      timeline_out: 1,
      style: { color: "white", font: "Poppins", fontsize: 48 },
    },
  ],
});

describe.skipIf(!FF)("caption pixel smoke (bundled libass)", () => {
  it("burns a caption into visible pixels (regression guard: ass must write onto the stream)", async () => {
    const cwd = await scratch();
    const out = await render(FF!, cwd, { canvas, tracks: [textClip(0)] } as unknown as Timeline);
    // A white caption on a black canvas. The old transparent-layer+overlay path left max luma at ~16
    // (nothing composited); the direct `ass` burn puts it at ~220 (white text, softened by H.264/yuv420p).
    // 150 is decisively above the black baseline and clear of the encoded-white peak.
    expect(await maxLuma(FF!, out)).toBeGreaterThan(150);
  });

  it("a higher-z video covers a lower caption band (z-band interleave)", async () => {
    const cwd = await scratch();
    // A full-canvas opaque BLACK video on z=1 over a white caption on z=0: the video paints over the
    // caption, so the frame goes dark (proves the band composited BELOW the video, not unconditionally last).
    const black = path.join(cwd, "black.mp4");
    const g = await run(FF!, [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=320x240:d=1:r=30",
      "-pix_fmt",
      "yuv420p",
      black,
    ]);
    expect(g.code).toBe(0);
    const timeline = {
      canvas,
      tracks: [
        textClip(0),
        {
          id: "v",
          kind: "video",
          z: 1,
          clips: [
            {
              kind: "video",
              media_ref: black,
              source_in: 0,
              source_out: 1,
              timeline_in: 0,
              timeline_out: 1,
            },
          ],
        },
      ],
    } as unknown as Timeline;
    const out = await render(FF!, cwd, timeline);
    expect(await maxLuma(FF!, out)).toBeLessThan(40); // caption hidden under the black video
  });

  it("a caption band ABOVE a video burns onto the overlay output (opposite ordering)", async () => {
    const cwd = await scratch();
    // Video on z=0, caption on z=1: the `ass` filter is applied to the video's OVERLAY OUTPUT (not the
    // base) — the graph shape the text-interleaved corpus pins. The white caption must still show over
    // the black video, proving `ass` writes onto a mid-graph overlay stream too.
    const black = path.join(cwd, "black.mp4");
    const g = await run(FF!, [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=320x240:d=1:r=30",
      "-pix_fmt",
      "yuv420p",
      black,
    ]);
    expect(g.code).toBe(0);
    const timeline = {
      canvas,
      tracks: [
        {
          id: "v",
          kind: "video",
          z: 0,
          clips: [
            {
              kind: "video",
              media_ref: black,
              source_in: 0,
              source_out: 1,
              timeline_in: 0,
              timeline_out: 1,
            },
          ],
        },
        textClip(1),
      ],
    } as unknown as Timeline;
    const out = await render(FF!, cwd, timeline);
    expect(await maxLuma(FF!, out)).toBeGreaterThan(150); // caption visible on top of the video
  });

  it("keeps caption ink out of the outer 5% title-safe margin (Fix #2)", async () => {
    const cwd = await scratch();
    // A wide caption that WITHOUT the per-edge inset would wrap to the full frame width and touch the
    // side edges. Square canvas so the several wrapped lines still clear the top/bottom safe band.
    const sq = { width: 400, height: 400, fps: 30 };
    const wide = {
      id: "t",
      kind: "text",
      z: 0,
      clips: [
        {
          kind: "text",
          text: "THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG",
          timeline_in: 0,
          timeline_out: 1,
          style: { color: "white", font: "Poppins", fontsize: 40 },
        },
      ],
    };
    const out = await render(FF!, cwd, { canvas: sq, tracks: [wide] } as unknown as Timeline);
    // Every outer-5% edge strip is black: wrap box inset 5% per side, vertical centre clamped into the band.
    expect(await maxLuma(FF!, out, "crop=iw*0.05:ih:0:0")).toBeLessThan(40); // left
    expect(await maxLuma(FF!, out, "crop=iw*0.05:ih:iw*0.95:0")).toBeLessThan(40); // right
    expect(await maxLuma(FF!, out, "crop=iw:ih*0.05:0:0")).toBeLessThan(40); // top
    expect(await maxLuma(FF!, out, "crop=iw:ih*0.05:0:ih*0.95")).toBeLessThan(40); // bottom
    // Sanity: the caption DID render (centre band is bright), so the clean edges aren't a blank frame.
    expect(await maxLuma(FF!, out, "crop=iw*0.9:ih*0.9:iw*0.05:ih*0.05")).toBeGreaterThan(150);
  });

  it("paints a text OUTLINE (3A-2: black fill + white outline is visible; blank without the ring)", async () => {
    const cwd = await scratch();
    const clip = {
      id: "t",
      kind: "text",
      z: 0,
      clips: [
        {
          kind: "text",
          text: "OUTLINE",
          timeline_in: 0,
          timeline_out: 1,
          style: {
            color: "#000000",
            font: "Poppins",
            fontsize: 56,
            outline: { color: "#ffffff", width: 4 },
          },
        },
      ],
    };
    const out = await render(FF!, cwd, { canvas, tracks: [clip] } as unknown as Timeline);
    // The fill is black (invisible on the black canvas); any bright pixels come ONLY from the white
    // outline, so this proves \bord+\3c actually paints the ring (not just appears in the graph string).
    expect(await maxLuma(FF!, out)).toBeGreaterThan(150);
  });

  it("paints a drop SHADOW (3A-2: black fill + white shadow is visible)", async () => {
    const cwd = await scratch();
    const clip = {
      id: "t",
      kind: "text",
      z: 0,
      clips: [
        {
          kind: "text",
          text: "SHADOW",
          timeline_in: 0,
          timeline_out: 1,
          style: {
            color: "#000000",
            font: "Poppins",
            fontsize: 56,
            shadow: { color: "#ffffff", depth: 5 },
          },
        },
      ],
    };
    const out = await render(FF!, cwd, { canvas, tracks: [clip] } as unknown as Timeline);
    // Black fill is invisible on black; the only bright pixels are the white shadow -> \shad+\4c paints.
    expect(await maxLuma(FF!, out)).toBeGreaterThan(150);
  });

  it("paints a background BOX behind the text (3A-2: a solid region, not just glyphs)", async () => {
    const cwd = await scratch();
    const clip = {
      id: "t",
      kind: "text",
      z: 0,
      clips: [
        {
          kind: "text",
          text: "BOXED",
          timeline_in: 0,
          timeline_out: 1,
          style: {
            color: "#000000",
            font: "Poppins",
            fontsize: 56,
            box: { color: "#ffffff", opacity: 1, padding: 16 },
          },
        },
      ],
    };
    const out = await render(FF!, cwd, { canvas, tracks: [clip] } as unknown as Timeline);
    // A white box behind black text fills the centre with white (BorderStyle=3), so the centre AVERAGE is
    // bright — far above the ~16 a black frame or thin black glyphs would give.
    expect(await avgLuma(FF!, out, "crop=iw*0.5:ih*0.3:iw*0.25:ih*0.35")).toBeGreaterThan(100);
  });

  it("draws an UNDERLINE rule under the text (C1: more ink than the same caption without it)", async () => {
    const mk = (underline: boolean) =>
      ({
        canvas,
        tracks: [
          {
            id: "t",
            kind: "text",
            z: 0,
            clips: [
              {
                kind: "text",
                text: "UNDER",
                timeline_in: 0,
                timeline_out: 1,
                style: { color: "#ffffff", font: "Poppins", fontsize: 48, underline },
              },
            ],
          },
        ],
      }) as unknown as Timeline;
    const withU = await render(FF!, await scratch(), mk(true));
    const without = await render(FF!, await scratch(), mk(false));
    // The underline is an extra white rule under the glyphs, so the underlined frame carries strictly
    // MORE white ink than the identical caption without it — proving the Underline style field draws
    // (not just that a caption renders).
    expect(await avgLuma(FF!, withU)).toBeGreaterThan(await avgLuma(FF!, without));
  });

  it("emits a numeric font WEIGHT without breaking libass (C1: the Bold field carries the weight)", async () => {
    const cwd = await scratch();
    const clip = {
      id: "t",
      kind: "text",
      z: 0,
      clips: [
        {
          kind: "text",
          text: "HEAVY",
          timeline_in: 0,
          timeline_out: 1,
          style: { color: "#ffffff", font: "Poppins", fontsize: 56, weight: 900 },
        },
      ],
    };
    const out = await render(FF!, cwd, { canvas, tracks: [clip] } as unknown as Timeline);
    // A numeric weight goes to the ASS Bold field verbatim; assert it still renders (the .ass parses and
    // libass draws it). We deliberately do NOT assert it is visually heavier — faux weight on a bundled
    // single-weight family isn't a reliable pixel signal (see the dropped bold-ink probe).
    expect(await maxLuma(FF!, out)).toBeGreaterThan(150);
  });

  it("recolours a single RUN independently (C2: a per-run black run disappears on black)", async () => {
    const mk = (perRunBlack: boolean) =>
      ({
        canvas,
        tracks: [
          {
            id: "t",
            kind: "text",
            z: 0,
            clips: [
              {
                kind: "text",
                content: [
                  { text: "AAA" },
                  { text: "BBB", style: perRunBlack ? { color: "#000000" } : {} },
                ],
                timeline_in: 0,
                timeline_out: 1,
                style: { color: "#ffffff", font: "Poppins", size: 48 },
              },
            ],
          },
        ],
      }) as unknown as Timeline;
    const both = await render(FF!, await scratch(), mk(false)); // AAA + BBB both white
    const oneBlack = await render(FF!, await scratch(), mk(true)); // BBB recoloured black -> invisible
    // The per-run black recolour removes BBB's white ink, so the frame with it carries strictly LESS
    // white than the identical two-run caption drawn all-white — proving runOverride recolours ONE run.
    expect(await avgLuma(FF!, oneBlack)).toBeLessThan(await avgLuma(FF!, both));
  });

  it("emphasis recolours a hero RUN to a distinct colour (C2)", async () => {
    const cwd = await scratch();
    const clip = {
      id: "t",
      kind: "text",
      z: 0,
      clips: [
        {
          kind: "text",
          content: [{ text: "dim" }, { text: "HERO", emphasis: true }],
          timeline_in: 0,
          timeline_out: 1,
          animation: { emphasis: { kind: "color", color: "#ffffff" } },
          style: { color: "#000000", font: "Poppins", size: 48 },
        },
      ],
    };
    const out = await render(FF!, cwd, { canvas, tracks: [clip] } as unknown as Timeline);
    // Base "dim" is black (invisible on black); the hero run is recoloured WHITE by animation.emphasis, so
    // the only bright pixels come from the emphasised run — proving per-run emphasis recolour paints.
    expect(await maxLuma(FF!, out)).toBeGreaterThan(150);
  });

  it("typewriter reveal shows MORE words over time (C3: a later frame has more ink than an earlier one)", async () => {
    const cwd = await scratch();
    const clip = {
      id: "t",
      kind: "text",
      z: 0,
      clips: [
        {
          kind: "text",
          content: [
            { text: "aaa", t_in: 0, t_out: 0.7 },
            { text: "bbb", t_in: 0.7, t_out: 1.4 },
            { text: "ccc", t_in: 1.4, t_out: 2 },
          ],
          timeline_in: 0,
          timeline_out: 2,
          animation: { build: "typewriter", timing: "explicit" },
          style: { color: "#ffffff", font: "Poppins", size: 40 },
        },
      ],
    };
    const out = await render(FF!, cwd, { canvas, tracks: [clip] } as unknown as Timeline);
    const early = await frameStats(FF!, out, 0.2); // only "aaa" revealed
    const late = await frameStats(FF!, out, 1.8); // aaa + bbb + ccc revealed
    // Reveal karaoke: unsung words are transparent, so white ink strictly GROWS as words appear — the
    // 2-frame ink diff the reviewer mandates for animation (a string assertion can't tell a \k reveal
    // from an inert tag).
    expect(late.avg).toBeGreaterThan(early.avg + 1);
  });

  // A reveal build must show NOTHING where a word has not arrived yet. The ink-grows test above cannot
  // see the failure it was meant to catch: its style has no outline, and `\k` swaps only the FILL, so a
  // reveal that leaves the OUTLINE painted still grows ink while every future word sits on screen fully
  // legible. Shipped exports looked like that for every preset (all six carry an outline or shadow).
  // So: bright outline on a black canvas, and ask where the ink IS, not how much of it there is.
  const revealWords = [
    { text: "aaa", t_in: 0, t_out: 0.5 },
    { text: "bbb", t_in: 0.5, t_out: 1.0 },
    { text: "ccc", t_in: 1.0, t_out: 1.5 },
    { text: "ddd", t_in: 1.5, t_out: 2 },
  ];
  const wideCanvas = { width: 640, height: 240, fps: 30 };
  const buildClip = (build: string) => ({
    id: "t",
    kind: "text",
    z: 0,
    clips: [
      {
        kind: "text",
        content: revealWords,
        timeline_in: 0,
        timeline_out: 2,
        animation: { build, timing: "explicit" },
        // The outline is WHITE on purpose: a black one is invisible against a black canvas, which is
        // exactly how a ghosted future word escapes a luma check.
        style: {
          color: "#ffffff",
          font: "Poppins",
          size: 40,
          outline: { color: "#ffffff", width: 5 },
        },
      },
    ],
  });
  // Right half of the frame: with 4 centred words, the first ends left of centre and the last two sit
  // right of it, so this region answers "has a word that is not due yet already been drawn?"
  const RIGHT_HALF = "crop=iw/2:ih:iw/2:0";
  const LEFT_HALF = "crop=iw/2:ih:0:0";

  it("word-by-word keeps an unrevealed word ENTIRELY off screen, outline included", async () => {
    const cwd = await scratch();
    const out = await render(FF!, cwd, {
      canvas: wideCanvas,
      tracks: [buildClip("word-by-word")],
    } as unknown as Timeline);
    const rightEarly = await regionMaxLuma(FF!, out, 0.2, RIGHT_HALF);
    const leftEarly = await regionMaxLuma(FF!, out, 0.2, LEFT_HALF);
    const rightLate = await regionMaxLuma(FF!, out, 1.9, RIGHT_HALF);
    // Not vacuous: the first word really did render.
    expect(leftEarly, "the first word should be on screen at 0.2s").toBeGreaterThan(150);
    // The rule. `ccc`/`ddd` are not due at 0.2s, so their half of the frame must be untouched — no
    // fill, no outline, no shadow. Before the per-step fix this read ~235 (their outlines).
    expect(rightEarly, "words not yet revealed must leave NO ink").toBeLessThan(60);
    // ...and they do arrive, so the emptiness above is timing, not a blank render.
    expect(rightLate, "the last words should be on screen at 1.9s").toBeGreaterThan(150);
  });

  it("word-highlight does the OPPOSITE: unsung words are already on screen, dimmed", async () => {
    // The companion direction — proving the fix did not simply blank every karaoke build, and that the
    // two builds are genuinely different products rather than one implementation with a flag.
    const cwd = await scratch();
    const out = await render(FF!, cwd, {
      canvas: wideCanvas,
      tracks: [buildClip("word-highlight")],
    } as unknown as Timeline);
    const rightEarly = await regionMaxLuma(FF!, out, 0.2, RIGHT_HALF);
    expect(rightEarly, "a highlight build shows the whole phrase from the start").toBeGreaterThan(
      120,
    );
  });

  it("a style PRESET resolves into a real look (C5: clean-white renders visible text)", async () => {
    const cwd = await scratch();
    const clip = {
      id: "t",
      kind: "text",
      z: 0,
      clips: [
        {
          kind: "text",
          text: "PRESET",
          timeline_in: 0,
          timeline_out: 1,
          style: { preset: "clean-white", size: 48 },
        },
      ],
    };
    const out = await render(FF!, cwd, { canvas, tracks: [clip] } as unknown as Timeline);
    // clean-white -> Poppins white bold + black outline; on the black canvas the white fill is bright, so
    // the preset resolved into a concrete look end-to-end (not ignored). Size overridden to fit 320x240.
    expect(await maxLuma(FF!, out)).toBeGreaterThan(150);
  });

  it("highlight emphasis paints a real BOX behind the hero chunk (Slice A)", async () => {
    const cwd = await scratch();
    const clip = {
      id: "t",
      kind: "text",
      z: 0,
      clips: [
        {
          kind: "text",
          content: [{ text: "one" }, { text: "TWO", emphasis: true }],
          timeline_in: 0,
          timeline_out: 2,
          animation: {
            build: "phrase-chunks",
            timing: "even",
            emphasis: { kind: "highlight", color: "#ffffff" },
          },
          style: { color: "#000000", font: "Poppins", size: 40 },
        },
      ],
    };
    const out = await render(FF!, cwd, { canvas, tracks: [clip] } as unknown as Timeline);
    // The hero chunk gets a WHITE box behind black text; the plain chunk is black text on black. So the
    // hero frame (t=1.5s) carries more white ink than the plain frame (t=0.5s) — a REAL box (a recoloured
    // hero would stay dark on black; observed box delta ~+8 over the whole frame).
    const plain = await frameStats(FF!, out, 0.5);
    const hero = await frameStats(FF!, out, 1.5);
    expect(hero.avg).toBeGreaterThan(plain.avg + 5);
  });

  it("box-invert emphasis boxes the hero chunk with inverted text (Slice A)", async () => {
    const cwd = await scratch();
    const clip = {
      id: "t",
      kind: "text",
      z: 0,
      clips: [
        {
          kind: "text",
          content: [{ text: "one" }, { text: "TWO", emphasis: true }],
          timeline_in: 0,
          timeline_out: 2,
          animation: {
            build: "phrase-chunks",
            timing: "even",
            emphasis: { kind: "box-invert", color: "#ffffff" },
          },
          style: { color: "#ffffff", font: "Poppins", size: 40 },
        },
      ],
    };
    const out = await render(FF!, cwd, { canvas, tracks: [clip] } as unknown as Timeline);
    // box-invert: the hero gets a white box + BLACK (inverted) text; the plain chunk is thin white glyphs
    // on black. The hero's solid white box makes its frame brighter than the plain frame (delta ~+8).
    const plain = await frameStats(FF!, out, 0.5);
    const hero = await frameStats(FF!, out, 1.5);
    expect(hero.avg).toBeGreaterThan(plain.avg + 5);
  });

  it("phrase-chunks shows a DIFFERENT sub-phrase over time (3B kinetic sequence)", async () => {
    const cwd = await scratch();
    const clip = {
      id: "t",
      kind: "text",
      z: 0,
      clips: [
        {
          kind: "text",
          content: [
            { text: "WWWWWWWW", t_in: 0, t_out: 1 },
            { text: ".", t_in: 1, t_out: 2 },
          ],
          timeline_in: 0,
          timeline_out: 2,
          animation: { build: "phrase-chunks", timing: "explicit" },
          style: { color: "white", font: "Poppins", fontsize: 48 },
        },
      ],
    };
    const out = await render(FF!, cwd, { canvas, tracks: [clip] } as unknown as Timeline);
    const s1 = await frameStats(FF!, out, 0.5); // during chunk 1 (the wide word)
    const s2 = await frameStats(FF!, out, 1.5); // during chunk 2 (just a dot)
    expect(s1.max).toBeGreaterThan(150); // chunk 1 renders
    expect(s2.max).toBeGreaterThan(150); // chunk 2 renders too (the timed switch happened)
    // The wide word lays down more ink than the dot, so the two moments are DIFFERENT frames (the black
    // canvas baseline is ~16, so a margin above it, not a ratio, is the robust check). Were the chunks
    // untimed, both frames would show the same text with the same average.
    expect(s1.avg).toBeGreaterThan(s2.avg + 2);
  });

  it("entrance fade ramps a caption in (3B: dimmer at the start of the window)", async () => {
    const cwd = await scratch();
    const clip = {
      id: "t",
      kind: "text",
      z: 0,
      clips: [
        {
          kind: "text",
          text: "FADE IN",
          timeline_in: 0,
          timeline_out: 2,
          animation: { entrance: "fade", entrance_ms: 1000 },
          style: { color: "white", font: "Poppins", fontsize: 48 },
        },
      ],
    };
    const out = await render(FF!, cwd, { canvas, tracks: [clip] } as unknown as Timeline);
    const early = await frameStats(FF!, out, 0.1); // 10% into a 1s fade-in -> ~10% opacity
    const later = await frameStats(FF!, out, 1.5); // fully faded in
    expect(later.max).toBeGreaterThan(150); // full-opacity caption renders
    expect(early.avg).toBeLessThan(later.avg); // and it's visibly dimmer at the start (\fad applied)
  });

  it("emphasis recolours a hero chunk (3B: a black-recoloured hero is invisible on black)", async () => {
    const cwd = await scratch();
    const clip = {
      id: "t",
      kind: "text",
      z: 0,
      clips: [
        {
          kind: "text",
          content: [
            { text: "PLAIN", t_in: 0, t_out: 1 },
            { text: "HERO", t_in: 1, t_out: 2, emphasis: true },
          ],
          timeline_in: 0,
          timeline_out: 2,
          animation: {
            build: "phrase-chunks",
            timing: "explicit",
            emphasis: { kind: "color", color: "#000000" },
          },
          style: { color: "white", font: "Poppins", fontsize: 48 },
        },
      ],
    };
    const out = await render(FF!, cwd, { canvas, tracks: [clip] } as unknown as Timeline);
    const plain = await frameStats(FF!, out, 0.5); // white plain chunk -> visible
    const hero = await frameStats(FF!, out, 1.5); // hero recoloured BLACK on black -> invisible
    expect(plain.max).toBeGreaterThan(150);
    expect(hero.max).toBeLessThan(40); // the emphasis colour actually reached the hero chunk
  });

  it("pop entrance grows the caption into place (3B: smaller early, full later)", async () => {
    const cwd = await scratch();
    const clip = {
      id: "t",
      kind: "text",
      z: 0,
      clips: [
        {
          kind: "text",
          text: "POP",
          timeline_in: 0,
          timeline_out: 2,
          animation: { entrance: "pop", entrance_ms: 800 },
          style: { color: "white", font: "Poppins", fontsize: 90 },
        },
      ],
    };
    const out = await render(FF!, cwd, { canvas, tracks: [clip] } as unknown as Timeline);
    const early = await frameStats(FF!, out, 0.05); // ~60% scale near the start of an 800ms grow
    const settled = await frameStats(FF!, out, 1.5); // full size
    expect(settled.max).toBeGreaterThan(150); // renders at full size
    expect(settled.avg).toBeGreaterThan(early.avg); // bigger glyphs = more ink -> it grew (\t applied)
  });

  it("word-highlight sweeps words from dim to the highlight colour (3B \\k karaoke)", async () => {
    const cwd = await scratch();
    // Base white, highlight (emphasis) BLACK: words start dim white (Secondary), then sweep to black
    // (Primary) as \k passes. So the line is VISIBLE early and gone by the end.
    const clip = {
      id: "t",
      kind: "text",
      z: 0,
      clips: [
        {
          kind: "text",
          content: [
            { text: "ALPHA", t_in: 0, t_out: 1 },
            { text: "BETA", t_in: 1, t_out: 2 },
          ],
          timeline_in: 0,
          timeline_out: 2,
          animation: {
            build: "word-highlight",
            timing: "explicit",
            emphasis: { kind: "color", color: "#000000" },
          },
          style: { color: "white", font: "Poppins", fontsize: 48 },
        },
      ],
    };
    const out = await render(FF!, cwd, { canvas, tracks: [clip] } as unknown as Timeline);
    const early = await frameStats(FF!, out, 0.02); // words still dim-white (Secondary) -> visible
    const late = await frameStats(FF!, out, 1.95); // fully swept to black (Primary) -> gone
    expect(early.max).toBeGreaterThan(100);
    expect(late.max).toBeLessThan(40); // the \k sweep reached the whole line and recoloured it
  });
});

describe.skipIf(!FF)("render composite + transition pixel smoke (bundled ffmpeg)", () => {
  // Media compositing + transitions went through the render-parity refactor (resolved into the shared
  // plan) but had only unit (filter-string) + corpus (byte-identity) coverage — never actual PIXELS
  // through the bundled ffmpeg. These prove the resolved crop/flip/opacity/blend/colour/transition
  // filters render the expected LUMA, not merely the expected filter string. Each comparison renders into
  // its OWN scratch dir (render() always writes out.mp4 into cwd).
  async function source(cwd: string, name: string, lavfi: string): Promise<string> {
    const p = path.join(cwd, name);
    const r = await run(FF!, ["-y", "-f", "lavfi", "-i", lavfi, "-pix_fmt", "yuv420p", p]);
    expect(r.code, `source gen failed: ${r.stderr.slice(-300)}`).toBe(0);
    return p;
  }
  /** A source that is WHITE on the left half, BLACK on the right (spatial structure so flip/crop show). */
  async function splitLR(cwd: string, name: string): Promise<string> {
    const p = path.join(cwd, name);
    const r = await run(FF!, [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=white:s=160x240:d=1:r=30",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=160x240:d=1:r=30",
      "-filter_complex",
      "[0][1]hstack",
      "-pix_fmt",
      "yuv420p",
      p,
    ]);
    expect(r.code, `split source gen failed: ${r.stderr.slice(-300)}`).toBe(0);
    return p;
  }
  const vclip = (media_ref: string, extra: Record<string, unknown> = {}) => ({
    kind: "video",
    media_ref,
    source_in: 0,
    source_out: 1,
    timeline_in: 0,
    timeline_out: 1,
    ...extra,
  });
  const vtl = (media_ref: string, extra: Record<string, unknown> = {}) =>
    ({
      canvas,
      tracks: [{ id: "v", kind: "video", z: 0, clips: [vclip(media_ref, extra)] }],
    }) as unknown as Timeline;

  it("opacity dims a clip toward the black canvas base (0.5 white << opaque white)", async () => {
    const cwdA = await scratch();
    const cwdB = await scratch();
    const white = await source(cwdA, "white.mp4", "color=c=white:s=320x240:d=1:r=30");
    const full = await avgLuma(FF!, await render(FF!, cwdA, vtl(white, { opacity: 1 })));
    const half = await avgLuma(FF!, await render(FF!, cwdB, vtl(white, { opacity: 0.5 })));
    expect(full).toBeGreaterThan(200); // opaque white fills the frame
    expect(half).toBeLessThan(full - 40); // half-opaque white over the black base is clearly darker
  });

  it("a colour-grade brightness lift raises a mid-gray clip (Slice B colour pixel path)", async () => {
    const cwdU = await scratch();
    const cwdD = await scratch();
    const gray = await source(cwdU, "gray.mp4", "color=c=0x808080:s=320x240:d=1:r=30");
    const up = await avgLuma(
      FF!,
      await render(FF!, cwdU, vtl(gray, { color: { brightness: 0.4 } })),
    );
    const dn = await avgLuma(
      FF!,
      await render(FF!, cwdD, vtl(gray, { color: { brightness: -0.4 } })),
    );
    expect(up).toBeGreaterThan(dn + 20); // the eq=brightness grade actually moved the pixels
  });

  it("hflip mirrors the frame horizontally (a bright-left source becomes bright-right)", async () => {
    const cwdP = await scratch();
    const cwdF = await scratch();
    const lr = await splitLR(cwdP, "lr.mp4");
    const plain = await render(FF!, cwdP, vtl(lr));
    const flipped = await render(FF!, cwdF, vtl(lr, { flip: { h: true } }));
    expect(await avgLuma(FF!, plain, "crop=iw*0.4:ih:0:0")).toBeGreaterThan(150); // white on the left originally
    expect(await avgLuma(FF!, flipped, "crop=iw*0.4:ih:0:0")).toBeLessThan(80); // hflip moved white to the right
  });

  it("crop keeps the requested sub-region (crop to the bright half >> crop to the dark half)", async () => {
    const cwdA = await scratch();
    const cwdB = await scratch();
    const lr = await splitLR(cwdA, "lr.mp4");
    const keepLeft = await avgLuma(FF!, await render(FF!, cwdA, vtl(lr, { crop: { right: 0.5 } }))); // drop the right -> keep white
    const keepRight = await avgLuma(FF!, await render(FF!, cwdB, vtl(lr, { crop: { left: 0.5 } }))); // drop the left -> keep black
    expect(keepLeft).toBeGreaterThan(keepRight + 50);
  });

  it("an additive blend combines layers (red + green 'add' reads brighter than green over red)", async () => {
    const cwdA = await scratch();
    const cwdB = await scratch();
    const red = await source(cwdA, "red.mp4", "color=c=red:s=320x240:d=1:r=30");
    const green = await source(cwdA, "green.mp4", "color=c=0x00ff00:s=320x240:d=1:r=30");
    const layers = (blend: string | null) =>
      ({
        canvas,
        tracks: [
          { id: "a", kind: "video", z: 0, clips: [vclip(red)] },
          { id: "b", kind: "video", z: 1, clips: [vclip(green, blend ? { blend } : {})] },
        ],
      }) as unknown as Timeline;
    const added = await avgLuma(FF!, await render(FF!, cwdA, layers("add")));
    const normal = await avgLuma(FF!, await render(FF!, cwdB, layers(null)));
    expect(added).toBeGreaterThan(normal + 30); // add -> yellow (~226) > opaque green (~150)
  });

  it("a dip-to-white transition flashes the frame bright at the cut (geq dip pixel path)", async () => {
    const cwd = await scratch();
    const black = await source(cwd, "black.mp4", "color=c=black:s=320x240:d=1:r=30");
    const seq = {
      canvas,
      tracks: [
        {
          id: "v",
          kind: "video",
          z: 0,
          clips: [
            vclip(black, { timeline_in: 0, timeline_out: 1 }),
            vclip(black, {
              timeline_in: 1,
              timeline_out: 2,
              transition_in: { kind: "dip-to-white", duration: 0.5 },
            }),
          ],
        },
      ],
    } as unknown as Timeline;
    const out = await render(FF!, cwd, seq);
    const mid = await frameStats(FF!, out, 0.3); // inside black clip A
    const cut = await frameStats(FF!, out, 1.0); // centre of the dip
    expect(mid.avg).toBeLessThan(60); // clip body is black
    expect(cut.avg).toBeGreaterThan(150); // dipped THROUGH white at the cut (a plain crossfade would stay black)
  });
});
