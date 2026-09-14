// Direct unit tests for resolveRenderPlan — the shared IR both backends (render.ts exporter,
// scene.ts preview) derive their look from. Until now it was only exercised TRANSITIVELY: the property
// fuzzer and the golden tests drive buildRenderCommand / buildScene, which assert no-throw / finite /
// z-order but NEVER the resolved VALUES. A wrong-but-consistent resolution both backends happened to
// read the same way would pass byte-identity and parity yet still be wrong. These pin the authority's
// output directly: canonical order + identity, the dual-backend media-composite fields (fit/blend/crop/
// flip/color/opacity/rotate), the B2 sampling offset (visibility.inSec), the neighbour hold, the
// transition union, and the caption look (defaults, marks, builds, presets).
//
// INPUT UNIT: resolveRenderPlan takes a SECONDS-view timeline (toSecondsView has already mapped frames
// -> seconds for the exporter; the preview passes toSecondsView(timeline)). Every time field below is
// therefore SECONDS.
import { describe, expect, it } from "vitest";

import type { Timeline } from "./model";
import { resolveRenderPlan } from "./renderPlan";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const secTL = (tracks: Any[], canvas: Any = {}): Timeline =>
  ({ canvas: { width: 1920, height: 1080, fps: 30, ...canvas }, tracks }) as Timeline;
const trk = (id: string, clips: Any[], z = 0): Any => ({ id, kind: "video", z, clips });
const vclip = (o: Any = {}): Any => ({
  kind: "video",
  media_ref: "v.mp4",
  source_in: 0,
  source_out: 2,
  timeline_in: 0,
  timeline_out: 2,
  ...o,
});
const tclip = (o: Any = {}): Any => ({ kind: "text", timeline_in: 0, timeline_out: 2, ...o });
/** Resolve a single-clip timeline and return that clip's plan entry. */
const one = (clip: Any, canvas: Any = {}): Any =>
  resolveRenderPlan(secTL([trk("v", [clip], 0)], canvas)).clips[0];
/** Resolve a single TEXT clip and return its ResolvedText. */
const oneText = (clip: Any, canvas: Any = {}): Any => one(clip, canvas).text;

describe("resolveRenderPlan — canonical order, identity, duration", () => {
  // The EXPORT is the artifact. The preview filtered hidden tracks and the plan did not, so hiding
  // a track darkened the preview and still shipped the track in the file — invisible to every test
  // here, because none of them asked what the plan contained after a hide.
  it("a HIDDEN track does not reach the export", () => {
    const plan = resolveRenderPlan(
      secTL([
        trk("v1", [vclip({ id: "keep" })], 0),
        { ...trk("v2", [vclip({ id: "gone" })], 1), hidden: true },
      ]),
    );
    expect(plan.clips.map((c: Any) => c.srcClipId)).toEqual(["keep"]);
  });

  it("while ANY track is soloed, only soloed tracks reach the export", () => {
    const plan = resolveRenderPlan(
      secTL([
        trk("v1", [vclip({ id: "muted-out" })], 0),
        { ...trk("v2", [vclip({ id: "solo" })], 1), solo: true },
      ]),
    );
    expect(plan.clips.map((c: Any) => c.srcClipId)).toEqual(["solo"]);
  });

  it("a DISABLED clip does not reach the export", () => {
    const plan = resolveRenderPlan(
      secTL([trk("v1", [vclip({ id: "on" }), vclip({ id: "off", disabled: true })], 0)]),
    );
    expect(plan.clips.map((c: Any) => c.srcClipId)).toEqual(["on"]);
  });

  // The counterpart of the hidden-track case above, and the half that was missing: the plan asked
  // visibleTracks() for AUDIO lanes too, so `mute` was honoured by the preview's audio engine and
  // by nothing else. A user muted a lane, heard silence, exported, and the audio was still in the
  // file. It also meant `set_track mute:true` could not rescue a render that a bad audio source
  // was killing, which is how it surfaced in production.
  it("a MUTED track's audio does not reach the export", () => {
    const aclip = (id: string): Any => ({
      id,
      kind: "audio",
      media_ref: "a.m4a",
      timeline_in: 0,
      timeline_out: 2,
    });
    const plan = resolveRenderPlan(
      secTL([
        { id: "a1", kind: "audio", z: 0, clips: [aclip("heard")] } as Any,
        { id: "a2", kind: "audio", z: 1, clips: [aclip("silenced")], mute: true } as Any,
      ]),
    );
    expect(plan.clips.map((c: Any) => c.srcClipId)).toEqual(["heard"]);
  });

  it("muting an AUDIO lane leaves the picture alone", () => {
    const plan = resolveRenderPlan(
      secTL([
        trk("v1", [vclip({ id: "picture" })], 0),
        {
          id: "a1",
          kind: "audio",
          z: 1,
          mute: true,
          clips: [
            { id: "gone", kind: "audio", media_ref: "a.m4a", timeline_in: 0, timeline_out: 2 },
          ],
        } as Any,
      ]),
    );
    expect(plan.clips.map((c: Any) => c.srcClipId)).toEqual(["picture"]);
  });

  it("solo is scoped to a KIND — soloing an audio lane does not black out the picture", () => {
    const audioTrk = {
      id: "a1",
      kind: "audio",
      z: 9,
      clips: [{ kind: "audio", media_ref: "a.m4a", timeline_in: 0, timeline_out: 2 }],
      solo: true,
    };
    const plan = resolveRenderPlan(
      secTL([trk("v1", [vclip({ id: "picture" })], 0), audioTrk as Any]),
    );
    // The soloed audio lane survives, and so does the video: a single cross-kind solo filter would
    // have dropped "picture" and left the export silent-but-black.
    expect(plan.clips.map((c: Any) => c.srcClipId).sort()).toEqual(["@0", "picture"]);
  });

  it("a HIDDEN track cannot define the solo set, so hiding the soloed lane is not a black screen", () => {
    const plan = resolveRenderPlan(
      secTL([
        trk("v1", [vclip({ id: "plain" })], 0),
        { ...trk("v2", [vclip({ id: "both" })], 1), solo: true, hidden: true },
      ]),
    );
    // Hidden means "not part of the output", which includes not being part of the solo set. The
    // alternative reading — solo names an empty set, so show nothing — turns two individually
    // sensible toggles into an all-black export with no obvious cause.
    expect(plan.clips.map((c: Any) => c.srcClipId)).toEqual(["plain"]);
  });

  it("sorts tracks by z then id, drops empty tracks, keeps clip order", () => {
    const plan = resolveRenderPlan(
      secTL([
        trk("v2", [vclip({ id: "b" })], 2),
        trk("v1", [vclip({ id: "a" })], 1),
        trk("empty", [], 0), // no clips -> filtered out
        trk("va", [vclip({ id: "z" })], 5),
        trk("vb", [vclip({ id: "y" })], 5), // same z as va -> id tiebreak (va before vb)
      ]),
    );
    expect(plan.clips.map((c: Any) => c.srcTrackId)).toEqual(["v1", "v2", "va", "vb"]);
    expect(plan.clips.map((c: Any) => c.srcClipId)).toEqual(["a", "b", "z", "y"]);
  });

  it("uses clip.id for srcClipId, falling back to a track-positional @idx when absent", () => {
    const plan = resolveRenderPlan(secTL([trk("v", [vclip({ id: "keep" }), vclip({})], 0)]));
    expect(plan.clips.map((c: Any) => c.srcClipId)).toEqual(["keep", "@1"]);
  });

  it("durationSec is the max timeline_out; canvas w/h truncated, fps preserved (no 29.97 drift)", () => {
    const plan = resolveRenderPlan(
      secTL(
        [trk("v", [vclip({ timeline_out: 5 }), vclip({ timeline_in: 5, timeline_out: 9 })], 0)],
        { width: 1920.6, height: 1080.6, fps: 29.97 },
      ),
    );
    expect(plan.durationSec).toBe(9);
    expect(plan.canvas).toEqual({ w: 1920, h: 1080, fps: 29.97 });
  });
});

describe("resolveRenderPlan — media composite (the dual-backend authority)", () => {
  it("resolves fit/blend to the closed union and coerces unknowns to the neutral both backends fall back to", () => {
    expect(one(vclip({ fit: "cover", blend: "screen" })).media).toMatchObject({
      fit: "cover",
      blend: "screen",
    });
    expect(one(vclip({ fit: "stretch", blend: "burn" })).media).toMatchObject({
      fit: "contain",
      blend: "normal",
    });
    expect(one(vclip()).media).toMatchObject({ fit: "contain", blend: "normal" }); // absent -> neutral
  });

  it("clamps crop edges to the open interval (0,1) and coerces flip flags with strict ===", () => {
    const m = one(
      vclip({ crop: { left: 0.1, right: 1.5, top: -0.2, bottom: 0.3 }, flip: { h: true, v: 1 } }),
    ).media;
    expect(m.crop).toEqual({ left: 0.1, right: 0, top: 0, bottom: 0.3 }); // out-of-range edges drop to 0
    expect(m.flip).toEqual({ h: true, v: false }); // v is 1, not true -> false
  });

  it("passes color/opacity/rotate through from the clip verbatim (each backend formats them)", () => {
    const pc = one(vclip({ color: { exposure: 0.5 }, opacity: 0.4, rotate: 90 }));
    expect(pc.media.color).toBe(pc.clipRef.color); // same reference — no copy, no canonicalisation
    expect(pc.media.opacity).toBe(0.4);
    expect(pc.media.rotate).toBe(90);
    expect(one(vclip()).media.color).toBeUndefined(); // unset stays unset
  });
});

describe("resolveRenderPlan — visibility + neighbour hold (B2 sampling offset)", () => {
  it("visibility.inSec/outSec are the clip's timeline span (inSec is the one declared sampling offset)", () => {
    const pc = one(vclip({ timeline_in: 2, timeline_out: 5 }));
    expect(pc.visibility.inSec).toBe(2);
    expect(pc.visibility.outSec).toBe(5);
  });

  it("holds the outgoing clip half the next clip's transition past an ABUTTING cut, zero across a gap", () => {
    const abut = resolveRenderPlan(
      secTL([
        trk(
          "v",
          [
            vclip({ id: "a", timeline_in: 0, timeline_out: 2 }),
            vclip({
              id: "b",
              timeline_in: 2,
              timeline_out: 4,
              transition_in: { kind: "crossfade", duration: 0.5 },
            }),
          ],
          0,
        ),
      ]),
    ).clips;
    expect(abut[0].visibility.holdSec).toBeCloseTo(0.25, 9); // outSec 2 + durSec/2 (0.25) - outSec 2
    expect(abut[1].visibility.holdSec).toBe(0); // last clip has no follower

    const gap = resolveRenderPlan(
      secTL([
        trk(
          "v",
          [
            vclip({ id: "a", timeline_in: 0, timeline_out: 2 }),
            vclip({
              id: "b",
              timeline_in: 3,
              timeline_out: 5,
              transition_in: { kind: "crossfade", duration: 0.5 },
            }),
          ],
          0,
        ),
      ]),
    ).clips;
    expect(gap[0].visibility.holdSec).toBe(0); // next clip starts 1s later -> nothing to hold under
  });
});

describe("resolveRenderPlan — transitions", () => {
  it("resolves transition_in to kind+durSec, coerces an unknown kind to crossfade, null when absent", () => {
    expect(one(vclip({ transition_in: { kind: "wipe-l", duration: 0.5 } })).transition).toEqual({
      kind: "wipe-l",
      durSec: 0.5,
    });
    expect(one(vclip({ transition_in: { kind: "zoom-blur", duration: 1 } })).transition?.kind).toBe(
      "crossfade",
    ); // out-of-union -> the shared fallback
    expect(one(vclip()).transition).toBeNull();
  });
});

describe("resolveRenderPlan — text look defaults + static marks", () => {
  it("unifies defaults: Poppins, size = round(ch*0.06), white, centre, safe-margin wrap box", () => {
    const tx = oneText(tclip({ text: "hello" }), { width: 1000, height: 1000 });
    expect(tx).toMatchObject({
      font: "Poppins",
      sizePx: 60,
      color: "white",
      align: "center",
      text: "hello",
    });
    expect(tx).toMatchObject({
      safeMarginXPx: 50,
      safeMarginYPx: 50,
      wPx: 900,
      cxPx: 500,
      cyPx: 500,
      hasPos: false,
    });
  });

  it("clamps the font to a bundled family (unbundled -> Poppins, loose spelling aliased)", () => {
    expect(oneText(tclip({ text: "x", style: { font: "Impact" } })).font).toBe("Poppins");
    expect(oneText(tclip({ text: "x", style: { font: "bebas neue" } })).font).toBe("Bebas Neue");
    expect(oneText(tclip({ text: "x", style: { font: "bebasneue" } })).font).toBe("Bebas Neue"); // space-insensitive alias
    expect(oneText(tclip({ text: "x", style: { font: "PLAYFAIRDISPLAY" } })).font).toBe(
      "Playfair Display",
    ); // case + space insensitive
  });

  it("a numeric weight (100..900) overrides the bold flag; out-of-range weight -> null", () => {
    expect(oneText(tclip({ style: { weight: 700 } }))).toMatchObject({ weight: 700, bold: false });
    expect(oneText(tclip({ style: { weight: 50 } }))).toMatchObject({ weight: null });
    expect(oneText(tclip({ style: { bold: true } }))).toMatchObject({ weight: null, bold: true });
  });

  it("box wins over outline when both are set (they share OutlineColour under different BorderStyles)", () => {
    const tx = oneText(
      tclip({
        text: "x",
        style: { box: { color: "#000000" }, outline: { color: "#ffffff", width: 5 } },
      }),
    );
    expect(tx.box).toMatchObject({ color: "#000000" });
    expect(tx.outline).toBeNull();
  });

  it("transform.scale multiplies the type size; case transforms the drawn text", () => {
    expect(
      oneText(tclip({ text: "x", style: { size: 100 }, transform: { scale: 0.5 } })).sizePx,
    ).toBe(50);
    expect(oneText(tclip({ text: "Hello", style: { case: "upper" } })).text).toBe("HELLO");
    expect(oneText(tclip({ text: "Hello", style: { case: "lower" } })).text).toBe("hello");
  });

  it("clamps a positioned caption's vertical centre into the safe band and detects authored hard breaks", () => {
    const tx = oneText(tclip({ text: "x", transform: { position: { x: 0.5, y: 0.99 } } }), {
      width: 1000,
      height: 1000,
    });
    expect(tx).toMatchObject({ hasPos: true, cxPx: 500, cyPx: 950 }); // y 990 clamped to ch - safeMarginY (950)
    expect(oneText(tclip({ text: "a\nb" })).hardBreaks).toBe(true);
    expect(oneText(tclip({ text: "ab" })).hardBreaks).toBe(false);
  });
});

describe("resolveRenderPlan — caption builds", () => {
  it("phrase-chunks split evenly by default and honour explicit t_in/t_out", () => {
    const even = oneText(
      tclip({
        content: [{ text: "a" }, { text: "b" }],
        animation: { build: "phrase-chunks" },
        timeline_in: 0,
        timeline_out: 4,
      }),
    );
    expect(even.chunks).toEqual([
      { text: "a", relInSec: 0, relOutSec: 2, emphasis: false },
      { text: "b", relInSec: 2, relOutSec: 4, emphasis: false },
    ]);
    const explicit = oneText(
      tclip({
        content: [
          { text: "a", t_in: 0.5 },
          { text: "b", t_in: 1.5, t_out: 3 },
        ],
        animation: { build: "phrase-chunks", timing: "explicit" },
        timeline_in: 0,
        timeline_out: 4,
      }),
    );
    expect(explicit.chunks).toEqual([
      { text: "a", relInSec: 0.5, relOutSec: 1.5, emphasis: false }, // no t_out -> runs to the next chunk's t_in
      { text: "b", relInSec: 1.5, relOutSec: 3, emphasis: false },
    ]);
  });

  it("karaoke syllables carry durCs; reveal builds set karaokeReveal, word-highlight does not", () => {
    const hl = oneText(
      tclip({
        content: [{ text: "x" }, { text: "y" }],
        animation: { build: "word-highlight" },
        timeline_in: 0,
        timeline_out: 2,
      }),
    );
    expect(hl.karaoke).toEqual([
      { word: "x", durCs: 100 },
      { word: "y", durCs: 100 },
    ]);
    expect(hl.karaokeReveal).toBe(false); // word-highlight only DIMS unsung
    const reveal = oneText(
      tclip({
        content: [{ text: "x" }, { text: "y" }],
        animation: { build: "typewriter" },
        timeline_in: 0,
        timeline_out: 2,
      }),
    );
    expect(reveal.karaokeReveal).toBe(true); // typewriter/append/word-by-word HIDE unsung
  });

  it("an animation PRESET reaches the plan, not just the merge helper", () => {
    // mergeAnimation could be perfectly correct and never called. Ask the plan.
    const plan = oneText(
      tclip({
        content: [{ text: "x" }, { text: "y" }],
        animation: { preset: "karaoke" },
        timeline_in: 0,
        timeline_out: 2,
      }),
    );
    expect(plan.karaoke).toEqual([
      { word: "x", durCs: 100 },
      { word: "y", durCs: 100 },
    ]);
    expect(plan.karaokeReveal).toBe(false); // karaoke = word-highlight, which DIMS rather than hides
  });

  it("a size TIER reaches the plan and scales with the canvas", () => {
    const big = oneText(tclip({ style: { size: "xl" }, timeline_in: 0, timeline_out: 2 }));
    const small = oneText(tclip({ style: { size: "s" }, timeline_in: 0, timeline_out: 2 }));
    expect(big.sizePx).toBeGreaterThan(small.sizePx);
  });

  it("multi-run content resolves per-run styles (null unless an override is present; unset inherits base)", () => {
    expect(oneText(tclip({ content: [{ text: "a" }, { text: "b" }] })).runs).toBeNull(); // no per-run style/emphasis -> simpler joined path
    const runs = oneText(
      tclip({
        content: [
          { text: "a", style: { color: "#ff0000" } },
          { text: "b", emphasis: true },
        ],
      }),
    ).runs;
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ text: "a", color: "#ff0000", emphasis: false });
    expect(runs[1]).toMatchObject({ text: "b", color: "white", font: "Poppins", emphasis: true }); // inherits base colour/font
  });

  it("a style preset seeds defaults that explicit fields override", () => {
    const punchy = oneText(tclip({ text: "hi", style: { preset: "punchy" } }));
    expect(punchy).toMatchObject({ font: "Anton", sizePx: 110, color: "#ffffff", text: "HI" }); // punchy upper-cases + Anton 110
    expect(punchy.outline).toMatchObject({ widthPx: 8, color: "#000000" });
    const overridden = oneText(
      tclip({ text: "hi", style: { preset: "punchy", font: "Poppins", size: 40 } }),
    );
    expect(overridden).toMatchObject({ font: "Poppins", sizePx: 40 }); // explicit font/size win over the seed
  });

  it("every named preset seeds its signature look (font + colour + distinctive mark), not just punchy", () => {
    // Each preset is a look CONTRACT the model picks by name; a silent drift in the STYLE_PRESETS table
    // would change the rendered caption with nothing to catch it. Pin each preset's font + a distinctive
    // mark (bold/italic/case/box/outline/shadow) so the table can't rot unnoticed.
    const p = (preset: string) => oneText(tclip({ text: "hi", style: { preset } }));
    expect(p("clean-white")).toMatchObject({ font: "Poppins", color: "#ffffff", bold: true });
    expect(p("clean-white").outline).toMatchObject({ color: "#000000" });
    expect(p("boxed")).toMatchObject({ font: "Poppins", color: "#ffffff", bold: true });
    expect(p("boxed").box).toMatchObject({ color: "#000000" }); // BorderStyle=3 box
    expect(p("boxed").outline).toBeNull(); // boxed zeroes the outline so the ring isn't doubled
    expect(p("headline")).toMatchObject({ font: "Bebas Neue", color: "#ffffff", text: "HI" }); // headline upper-cases
    expect(p("headline").outline).toMatchObject({ color: "#000000" });
    expect(p("editorial")).toMatchObject({ font: "Playfair Display", italic: true });
    expect(p("editorial").shadow).toMatchObject({ color: "#000000" });
    expect(p("minimal")).toMatchObject({ font: "Oswald", color: "#ffffff" });
    expect(p("minimal").shadow).toMatchObject({ color: "#000000" });
  });

  it("resolves animation.emphasis into kind/color/scalePct", () => {
    expect(
      oneText(tclip({ text: "x", animation: { emphasis: { kind: "pop", scale: 1.5 } } })).emphasis,
    ).toEqual({ kind: "pop", color: "", scalePct: 150 });
    expect(
      oneText(tclip({ text: "x", animation: { emphasis: { kind: "color", color: "#ff0" } } }))
        .emphasis,
    ).toEqual({ kind: "color", color: "#ff0", scalePct: 120 });
    expect(oneText(tclip({ text: "x" })).emphasis).toBeNull();
  });
});
