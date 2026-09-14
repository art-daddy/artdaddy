import { afterEach, describe, expect, it } from "vitest";

import {
  MemFs,
  makeRunner,
  registerTestDocument,
  resetTestDocuments,
  seededCtx,
} from "../test/timelineKit";
import { ensureTimeline } from "./engine";
import type { Timeline } from "./model";
import { addClipsTool, addTextClipsTool } from "./placement";
import {
  buildRenderCommand,
  canvasDuration,
  exportDestination,
  exportStem,
  exportTimelineTool,
  renderTimelineTool,
  resolveClipSources,
  runRenderPlan,
} from "./render";
import { joinPath, ProjectStoreAccess, type FsLike } from "../tools/store";
import { buildScene } from "../preview/scene";
import { __resetExportQueue, whenExportsSettle } from "./exportQueue";
import { __resetJobNotes, pendingJobNotes } from "../store/jobNotes";
import type { ClientToolContext } from "../tools/context";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// seededCtx installs a per-project open-document resolver; reset it between tests so the bare-store
// suites below (which seed timeline.json on disk and expect the no-document read path) don't pick up
// a prior test's in-memory document.
afterEach(resetTestDocuments);
// Both are module-level: a destination left reserved would make the NEXT test's export refuse.
afterEach(async () => {
  await whenExportsSettle();
  __resetExportQueue();
  __resetJobNotes();
});

// A seconds-view timeline (what buildRenderCommand consumes).
function tl(clips: Any[], canvas = { width: 1920, height: 1080, fps: 30 }): Timeline {
  const tracks: Any[] = [];
  clips.forEach((c, i) =>
    tracks.push({
      id: c.kind === "audio" ? `a${i}` : `v${i}`,
      kind: c.kind ?? "video",
      z: i,
      clips: [c],
    }),
  );
  return { canvas, tracks } as Timeline;
}

describe("canvasDuration", () => {
  it("is the max timeline_out", () => {
    expect(
      canvasDuration(
        tl([{ media_ref: "a.mp4", source_in: 0, source_out: 2, timeline_in: 0, timeline_out: 2 }]),
      ),
    ).toBe(2);
    expect(
      canvasDuration({ canvas: { width: 1, height: 1, fps: 30 }, tracks: [] } as Timeline),
    ).toBe(0);
  });

  // A hidden track never reaches the picture, but it used to set the LENGTH: a 15.8s cut exported
  // as a 40.8s file with 25 seconds of black on the end, and the only workaround was to delete the
  // track instead of hiding it. The rule is that the length and the content are decided by the same
  // gate ΓÇö stated here as an outcome, so it survives a rewrite of how the gate is asked.
  const twoTracks = (flag: Record<string, unknown>): Timeline =>
    ({
      canvas: { width: 16, height: 16, fps: 30 },
      tracks: [
        {
          id: "v1",
          kind: "video",
          z: 0,
          clips: [
            {
              id: "keep",
              media_ref: "a.mp4",
              kind: "video",
              source_in: 0,
              source_out: 2,
              timeline_in: 0,
              timeline_out: 2,
            },
          ],
        },
        {
          id: "v2",
          kind: "video",
          z: 1,
          ...flag,
          clips: [
            {
              id: "long",
              media_ref: "b.mp4",
              kind: "video",
              source_in: 0,
              source_out: 9,
              timeline_in: 0,
              timeline_out: 9,
            },
          ],
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

  it("ignores a HIDDEN track's length, because the picture ignores its pixels", () => {
    expect(canvasDuration(twoTracks({}))).toBe(9); // control: visible, so it counts
    expect(canvasDuration(twoTracks({ hidden: true }))).toBe(2);
  });

  it("ignores a MUTED audio track's length for the same reason", () => {
    const audio = (flag: Record<string, unknown>): Timeline =>
      ({
        canvas: { width: 16, height: 16, fps: 30 },
        tracks: [
          {
            id: "v1",
            kind: "video",
            z: 0,
            clips: [
              {
                id: "keep",
                media_ref: "a.mp4",
                kind: "video",
                source_in: 0,
                source_out: 2,
                timeline_in: 0,
                timeline_out: 2,
              },
            ],
          },
          {
            id: "a1",
            kind: "audio",
            z: 1,
            ...flag,
            clips: [
              {
                id: "bed",
                media_ref: "m.mp3",
                kind: "audio",
                source_in: 0,
                source_out: 9,
                timeline_in: 0,
                timeline_out: 9,
              },
            ],
          },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any;
    expect(canvasDuration(audio({}))).toBe(9);
    expect(canvasDuration(audio({ mute: true }))).toBe(2);
  });

  // NOT covered on purpose: a user-DISABLED clip still sets the length. `suppressClip` writes the
  // same flag for a technical reason (a source with no audio stream), so reading it here made a
  // perfectly normal export report zero seconds. Named residual, not an oversight.
  it("a disabled clip still counts, because `disabled` has two meanings today", () => {
    const t = twoTracks({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (t.tracks[1].clips as any)[0].disabled = true;
    expect(canvasDuration(t)).toBe(9);
  });
});

describe("buildRenderCommand", () => {
  // The whole exporter works in seconds. Before this was normalised inside buildRenderCommand, a
  // caller that forgot toSecondsView got a silently 30x-long render plan instead of an error, and
  // the eval oracle's Tier-0 render check had been compiling exactly that plan for every scenario.
  // The rule is stated as "both views compile to the SAME plan", which survives a rewrite of how
  // the conversion happens.
  it("compiles a frames-view timeline to the same plan as its seconds equivalent", () => {
    // `fade` is deliberately NOT in COORD_KEYS ΓÇö it is frames in BOTH views and the exporter
    // divides by fps itself ΓÇö so it carries the same number through either path. Including it
    // here pins that asymmetry, which is the part most likely to be "tidied up" wrongly.
    const clips = (scale: number): Any[] => [
      {
        media_ref: "/v.mp4",
        kind: "video",
        source_in: 0,
        source_out: 2 * scale,
        timeline_in: 0,
        timeline_out: 2 * scale,
        fade: { in: 15, out: 15 },
      },
    ];
    const canvas = { width: 640, height: 360, fps: 30 };
    const seconds = buildRenderCommand(tl(clips(1), canvas), "/o.mp4");
    const frames = buildRenderCommand(
      { ...tl(clips(30), canvas), units: "frames" } as Any,
      "/o.mp4",
    );
    expect(frames.filterComplex).toBe(seconds.filterComplex);
    expect(frames.args).toEqual(seconds.args);
    expect(frames.duration).toBe(2);
  });

  it("does not mistake a seconds timeline for frames", () => {
    // The failure direction: normalising unconditionally would divide every already-correct
    // caller's times by the fps.
    const plan = buildRenderCommand(
      tl([{ media_ref: "/v.mp4", source_in: 0, source_out: 2, timeline_in: 0, timeline_out: 2 }]),
      "/o.mp4",
    );
    expect(plan.duration).toBe(2);
  });

  it("golden: snapshots the filter_complex for a multi-feature timeline", () => {
    const plan = buildRenderCommand(
      tl([
        {
          media_ref: "/v.mp4",
          kind: "video",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
          transform: { position: { x: 0.6, y: 0.4 }, scale: 0.5 },
          opacity: 0.8,
          rotate: 15,
          crop: { left: 0.1, right: 0.1 },
          effects: [{ type: "blur", params: { radius: 5 } }],
          color: { brightness: 0.2, contrast: 1.2 },
        },
        {
          media_ref: "/a.mp3",
          kind: "audio",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
          volume: 0.7,
          fade: { in: 0.5, out: 0.5 },
        },
      ]),
      "/out.mp4",
    );
    expect(plan.filterComplex).toMatchSnapshot();
  });

  it("golden: is deterministic ΓÇö the same timeline builds an identical graph", () => {
    const make = (): { fc: string; args: string[] } => {
      const p = buildRenderCommand(
        tl([
          {
            media_ref: "/v.mp4",
            kind: "video",
            source_in: 0,
            source_out: 2,
            timeline_in: 0,
            timeline_out: 2,
            transform: { position: { x: 0.6, y: 0.4 }, scale: 0.5 },
            opacity: 0.8,
            rotate: 15,
            crop: { left: 0.1, right: 0.1 },
          },
          {
            media_ref: "/a.mp3",
            kind: "audio",
            source_in: 0,
            source_out: 2,
            timeline_in: 0,
            timeline_out: 2,
            volume: 0.7,
            fade: { in: 0.5, out: 0.5 },
          },
        ]),
        "/out.mp4",
      );
      return { fc: p.filterComplex, args: p.args };
    };
    const a = make();
    const b = make();
    expect(a.fc).toBe(b.fc); // byte-identical filter graph
    expect(a.args).toEqual(b.args);
  });

  it("crop/flip resolved in the shared plan: hflip/vflip + crop edge mapping reach the exporter", () => {
    // crop + flip are resolved ONCE in renderPlan (pc.media) and consumed by BOTH backends. Assert the
    // exporter reads the plan's strict-boolean flip + clamped crop: an h<->v or left<->right/top swap,
    // or a dropped flag, fails HERE (the golden snapshot's clip has no flip, so this is the flip gate).
    const plan = buildRenderCommand(
      tl([
        {
          media_ref: "/v.mp4",
          kind: "video",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
          flip: { h: true, v: true },
          crop: { left: 0.2, top: 0.05 },
        },
      ]),
      "/out.mp4",
    );
    expect(plan.filterComplex).toContain("hflip");
    expect(plan.filterComplex).toContain("vflip");
    // crop edge mapping: left=0.2 -> x offset iw*0.200000 + width iw*0.800000; top=0.05 -> y ih*0.050000.
    expect(plan.filterComplex).toContain("crop=iw*0.800000:ih*0.950000:iw*0.200000:ih*0.050000");
  });

  it("golden: a speeded audio clip uses pitch-preserving atempo (not asetrate)", () => {
    // source span (2s) != timeline span (1s) -> the audio fills the slot via atempo,
    // which changes tempo at the SAME pitch (asetrate would chipmunk it).
    const plan = buildRenderCommand(
      tl([
        {
          media_ref: "/a.mp3",
          kind: "audio",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 1,
          speed: 2,
        },
      ]),
      "/out.mp4",
    );
    expect(plan.filterComplex).toContain("atempo");
    expect(plan.filterComplex).not.toContain("asetrate");
  });

  it("builds a base canvas, a scaled overlay, and an audio mix", () => {
    const plan = buildRenderCommand(
      tl([
        { media_ref: "/a.mp4", source_in: 0, source_out: 2, timeline_in: 0, timeline_out: 2 },
        {
          kind: "audio",
          media_ref: "/m.mp3",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
          volume: 0.5,
          audio_effects: [
            { type: "loudnorm", params: { target: -16 } },
            { type: "compressor", params: { threshold: -20, ratio: 3 } },
            { type: "denoise", params: { reduction_db: 8 } },
          ],
        },
      ]),
      "/out.mp4",
    );
    expect(plan.duration).toBe(2);
    expect(plan.filterComplex).toContain("color=c=black:s=1920x1080:r=30:d=2.000000[base]");
    expect(plan.filterComplex).toContain("scale=1920:1080:force_original_aspect_ratio=decrease");
    expect(plan.filterComplex).toContain("overlay=x=0:y=0:enable='between(t,0.000000,2.000000)'");
    expect(plan.filterComplex).toContain("adelay=0|0,volume=0.5000");
    // Audio effects render as afilters after volume, in canonical order.
    expect(plan.filterComplex).toContain("afftdn=nr=8.00");
    expect(plan.filterComplex).toContain("acompressor=threshold=0.100000:ratio=3.00");
    expect(plan.filterComplex).toContain("loudnorm=I=-16.0");
    expect(plan.args).toContain("-ss");
    expect(plan.args).toContain("/a.mp4");
    expect(plan.args.join(" ")).toContain("-map [a0]");
    expect(plan.args).toContain("-c:a");
    expect(plan.args.slice(-3)).toEqual(["-t", "2.000000", "/out.mp4"]);
  });

  it("a KEYFRAMED volume renders as a per-frame envelope, not a flat level", () => {
    // It used to be `isNum(clip.volume) ? clip.volume : 1` ΓÇö a curve fell through to full
    // level, so "duck the music under the voice" exported at full volume and the tool that
    // set it reported success. The preview had its own wrong answer (it played key[0] flat).
    const plan = buildRenderCommand(
      tl([
        {
          kind: "audio",
          media_ref: "/m.mp3",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
          volume: [
            { t: 0, v: 1 },
            { t: 30, v: 0.2 },
          ],
        },
      ]),
      "/out.mp4",
    );
    const vol = /volume=('[^']*'|[0-9.]+)/.exec(plan.filterComplex)?.[1] ?? "";
    expect(vol).toMatch(/^'/); // an expression, not a constant
    expect(vol).toContain("0.200000"); // ...that actually reaches the second key's value
    expect(plan.filterComplex).toContain("eval=frame"); // ...and is re-evaluated over time
  });

  it("loops an audio clip to fill a longer slot (aloop + atrim, no 'not rendered' warning)", () => {
    const plan = buildRenderCommand(
      tl([
        {
          kind: "audio",
          media_ref: "/m.mp3",
          source_in: 0,
          source_out: 4,
          timeline_in: 0,
          timeline_out: 10,
          loop: true,
        },
      ]),
      "/o.mp4",
    );
    expect(plan.filterComplex).toContain("aloop=loop=-1:size=192000"); // 4s * 48000
    expect(plan.filterComplex).toContain("atrim=duration=10.000000");
    expect(plan.warnings.some((w) => w.includes("loop"))).toBe(false);
  });

  it("applies speed to a looped audio clip via atempo before the slot trim (preview/export parity)", () => {
    // loop + speed:2 ΓÇö preview loops at playbackRate 2, so export must atempo the repeated
    // stream (not leave it at 1x). atempo must land BETWEEN aloop and atrim, else the trim
    // would cut the pre-speed stream and fill only half the slot.
    const plan = buildRenderCommand(
      tl([
        {
          kind: "audio",
          media_ref: "/m.mp3",
          source_in: 0,
          source_out: 4,
          timeline_in: 0,
          timeline_out: 10,
          loop: true,
          speed: 2,
        },
      ]),
      "/o.mp4",
    );
    const fc = plan.filterComplex;
    expect(fc).toContain("aloop=loop=-1:size=192000");
    expect(fc).toContain("atempo=2.000000");
    expect(fc.indexOf("aloop")).toBeLessThan(fc.indexOf("atempo=2.000000"));
    expect(fc.indexOf("atempo=2.000000")).toBeLessThan(fc.indexOf("atrim=duration=10.000000"));
  });

  it("derives a source_out-less audio clip's window from its timeline span (no `-ss 0 -to 0` silence)", () => {
    // audio is valid WITHOUT a source window (model + validator); the exporter must derive
    // source_out = source_in + timeline-span instead of emitting a zero-length input.
    const plan = buildRenderCommand(
      tl([{ kind: "audio", media_ref: "/a.mp3", timeline_in: 0, timeline_out: 2 }]),
      "/o.mp4",
    );
    const i = plan.args.indexOf("/a.mp3");
    expect(plan.args.slice(i - 5, i)).toEqual(["-ss", "0.000000", "-to", "2.000000", "-i"]);
  });

  it("derives a source_out-less audio clip's window at the clip's speed (atempo, no preview/export drift)", () => {
    // speed 2 + no source window: derive source_out = source_in + span*speed so the export reads
    // 4 source seconds and applies atempo (was deriving 2s @ 1x -> lost the speed + drifted from preview).
    const plan = buildRenderCommand(
      tl([{ kind: "audio", media_ref: "/a.mp3", timeline_in: 0, timeline_out: 2, speed: 2 }]),
      "/o.mp4",
    );
    const i = plan.args.indexOf("/a.mp3");
    expect(plan.args.slice(i - 5, i)).toEqual(["-ss", "0.000000", "-to", "4.000000", "-i"]);
    expect(plan.filterComplex).toContain("atempo");
  });

  it("loops images, honours a cover layout, opacity, and speed", () => {
    const img = buildRenderCommand(
      tl([{ media_ref: "/p.png", timeline_in: 0, timeline_out: 3 }]),
      "/o.mp4",
    );
    expect(img.args).toContain("-loop");
    expect(img.args.join(" ")).toContain("-an"); // no audio

    const cover = buildRenderCommand(
      tl([
        {
          media_ref: "/a.mp4",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
          opacity: 0.5,
          transform: {
            position: { x: 60 / 1920, y: 70 / 1080 },
            scale_x: 100 / 1920,
            scale_y: 100 / 1080,
          },
          fit: "cover",
        },
      ]),
      "/o.mp4",
    );
    expect(cover.filterComplex).toContain("force_original_aspect_ratio=increase");
    expect(cover.filterComplex).toContain("crop=100:100");
    expect(cover.filterComplex).toContain("colorchannelmixer=aa=0.5000");
    expect(cover.filterComplex).toContain("overlay=x=10:y=20");

    const fast = buildRenderCommand(
      tl([
        {
          media_ref: "/a.mp4",
          source_in: 0,
          source_out: 4,
          timeline_in: 0,
          timeline_out: 2,
          speed: 2,
        },
      ]),
      "/o.mp4",
    );
    expect(fast.filterComplex).toContain("/2.000000+0.000000/TB");
  });

  it("emits source crop + flip filters (no longer deferred)", () => {
    const plan = buildRenderCommand(
      tl([
        {
          media_ref: "/a.mp4",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
          crop: { left: 0.1, right: 0.1 },
          flip: { h: true, v: true },
        },
      ]),
      "/o.mp4",
    );
    expect(plan.filterComplex).toContain("crop=iw*0.800000:ih*1.000000:iw*0.100000:ih*0.000000");
    expect(plan.filterComplex).toContain("hflip");
    expect(plan.filterComplex).toContain("vflip");
    expect(plan.warnings.some((w) => w.includes("crop") || w.includes("flip"))).toBe(false);
  });

  it("emits a constant rotate filter (no longer deferred)", () => {
    const plan = buildRenderCommand(
      tl([
        {
          media_ref: "/a.mp4",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
          rotate: 90,
        },
      ]),
      "/o.mp4",
    );
    expect(plan.filterComplex).toContain("format=yuva420p");
    expect(plan.filterComplex).toContain("rotate=a='(90.000000)*PI/180':c=black@0:ow=iw:oh=ih");
    expect(plan.warnings.some((w) => w.includes("rotate"))).toBe(false);
  });

  it("emits per-frame expressions for keyframed position and rotate", () => {
    const plan = buildRenderCommand(
      tl([
        {
          media_ref: "/a.mp4",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
          rotate: [
            { t: 0, v: 0 },
            { t: 2, v: 90 },
          ],
          transform: {
            position: {
              x: [
                { t: 0, v: 0.1 },
                { t: 2, v: 0.5 },
              ],
              y: 0.5,
            },
            scale_x: 0.5,
            scale_y: 0.5,
          },
        },
      ]),
      "/o.mp4",
    );
    // Centre-based overlay: posX(t) - overlay_w/2, with a per-frame position expr.
    expect(plan.filterComplex).toContain("overlay=x='round((");
    expect(plan.filterComplex).toContain("-overlay_w/2)");
    expect(plan.filterComplex).toContain("if(lt(t,");
    expect(plan.filterComplex).toContain("rotate=a='(if(lt(t,");
    expect(plan.warnings.some((w) => w.includes("rotate"))).toBe(false);
  });

  it("emits an aspect-preserving eval=frame scale + centered overlay for keyframed scale", () => {
    const plan = buildRenderCommand(
      tl([
        {
          media_ref: "/a.mp4",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
          transform: {
            position: { x: 0.5, y: 0.5 },
            scale: [
              { t: 0, v: 0.5 },
              { t: 2, v: 1 },
            ],
          },
        },
      ]),
      "/o.mp4",
    );
    expect(plan.filterComplex).toContain("scale=w='max(2,round((");
    expect(plan.filterComplex).toContain("eval=frame");
    // Aspect preserved (no stretch) - contain fits the source inside the box.
    expect(plan.filterComplex).toContain("force_original_aspect_ratio=decrease");
    expect(plan.filterComplex).toContain("force_divisible_by=2");
    // The aspect-preserved clip is re-centered via overlay_w/overlay_h.
    expect(plan.filterComplex).toContain("-overlay_w/2)");
    expect(plan.filterComplex).toContain("-overlay_h/2)");
  });

  it("cover-fits and centers a keyframed-scale clip (Ken Burns zoom)", () => {
    const plan = buildRenderCommand(
      tl([
        {
          media_ref: "/a.mp4",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
          transform: {
            position: {
              x: [
                { t: 0, v: 0.5 },
                { t: 2, v: 0.55 },
              ],
              y: 0.5,
            },
            scale: [
              { t: 0, v: 1 },
              { t: 2, v: 1.2 },
            ],
          },
          fit: "cover",
        },
      ]),
      "/o.mp4",
    );
    // Cover keeps aspect (scale up + crop overflow), animated -> eval=frame; centre via overlay_w.
    expect(plan.filterComplex).toContain("force_original_aspect_ratio=increase");
    expect(plan.filterComplex).toContain("eval=frame");
    expect(plan.filterComplex).toContain("-overlay_w/2)");
  });

  it("emits colour grade + effect filters (no longer deferred)", () => {
    const plan = buildRenderCommand(
      tl([
        {
          media_ref: "/a.mp4",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
          color: { brightness: 0.1, contrast: 1.2, saturation: 0.8, gamma: 1.1, temperature: 5000 },
          effects: [
            { type: "blur", params: { radius: 4 } },
            { type: "grain", params: { grain: 10 } },
          ],
        },
      ]),
      "/o.mp4",
    );
    expect(plan.filterComplex).toContain(
      "eq=brightness=0.1000:contrast=1.2000:saturation=0.8000:gamma=1.1000",
    );
    expect(plan.filterComplex).toContain("colortemperature=temperature=8450.0");
    expect(plan.filterComplex).toContain("gblur=sigma=4.0000");
    expect(plan.filterComplex).toContain("noise=alls=10.0000:allf=t");
    expect(plan.warnings.some((w) => w.includes("color") || w.includes("effects"))).toBe(false);
  });

  // The knob ran BACKWARDS on export while the preview and the docs both said "higher is warmer":
  // ffmpeg's colortemperature models the light source, so a bigger number cools. Asserting the
  // literal string (as this file used to) restates whatever the code does and cannot catch a flip.
  // These assert the RULE, and tie it to the other owner of the same knob.
  it("normalizes sparse source timestamps to project CFR before compositing", () => {
    const plan = buildRenderCommand(
      tl([
        {
          media_ref: "/screen-recording.mov",
          source_in: 0,
          source_out: 3,
          timeline_in: 0,
          timeline_out: 3,
        },
      ]),
      "/o.mp4",
    );
    expect(plan.filterComplex).toContain("fps=fps=30:start_time=0:round=near:eof_action=round");
  });

  it("grades warmer as temperature RISES, agreeing with the preview", () => {
    const emitted = (kelvin: number): number => {
      const plan = buildRenderCommand(
        tl([
          {
            media_ref: "/a.mp4",
            source_in: 0,
            source_out: 2,
            timeline_in: 0,
            timeline_out: 2,
            color: { temperature: kelvin },
          },
        ]),
        "/o.mp4",
      );
      const m = /colortemperature=temperature=([\d.]+)/.exec(plan.filterComplex);
      expect(m).not.toBeNull();
      return Number(m![1]);
    };
    // ffmpeg warms as its own number FALLS, so a warmer request must emit a SMALLER one.
    expect(emitted(9000)).toBeLessThan(emitted(6500));
    expect(emitted(6500)).toBeLessThan(emitted(4000));
    // Neutral stays neutral, or every ungraded-but-present clip picks up a tint.
    expect(emitted(6500)).toBe(6500);
    // Never outside the filter's accepted range, however extreme the request.
    expect(emitted(40000)).toBeGreaterThanOrEqual(1000);
    expect(emitted(1000)).toBeLessThanOrEqual(40000);
    // Parity: the preview reddens as Kelvin rises (scene.test.ts pins that), so the export must
    // warm over the same interval. If either owner flips, these disagree and this fails.
    const previewRed = (kelvin: number): number =>
      buildScene(
        tl([
          { media_ref: "a.png", timeline_in: 0, timeline_out: 30, color: { temperature: kelvin } },
        ]),
        0,
        new Map() as Any,
      ).layers[0].wb[0];
    expect(previewRed(9000)).toBeGreaterThan(previewRed(4000)); // preview: warmer
    expect(emitted(9000)).toBeLessThan(emitted(4000)); // export: warmer too

    // The knob must keep RESOLVING across the contract's declared range, not flatten against the
    // filter's 1000 K floor. A linear reflection bottomed out at 12000 K, so every setting above
    // it exported an identical frame while the UI still moved.
    const high = [12000, 16000, 20000, 28000, 40000].map(emitted);
    expect(new Set(high).size).toBe(high.length);
    for (let i = 1; i < high.length; i++) expect(high[i]).toBeLessThan(high[i - 1]);
  });

  it("emits extra colour knobs and effect types (denoise/sharpen/custom)", () => {
    const plan = buildRenderCommand(
      tl([
        {
          media_ref: "/a.mp4",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
          color: { exposure: 0.5, tint: 0.2, vibrance: 0.3, lut: "/luts/film.cube" },
          effects: [
            { type: "denoise" },
            { type: "sharpen" },
            { type: "vignette", params: { vignette: 0.5 } },
            { type: "motion", params: { frames: 5 } },
            { type: "custom", params: { expr: "hflip" } },
            { type: "bogus" },
          ],
        },
      ]),
      "/o.mp4",
    );
    expect(plan.filterComplex).toContain("exposure=exposure=0.5000");
    expect(plan.filterComplex).toContain("colorbalance=gm=0.2000");
    expect(plan.filterComplex).toContain("vibrance=intensity=0.3000");
    expect(plan.filterComplex).toContain("lut3d=file=/luts/film.cube");
    expect(plan.filterComplex).toContain("hqdn3d=4.0000");
    expect(plan.filterComplex).toContain("unsharp=luma_msize_x=5");
    expect(plan.filterComplex).toContain("vignette=angle=0.7854");
    expect(plan.filterComplex).toContain("tmix=frames=5");
    expect(plan.filterComplex).toContain("hflip");
    expect(plan.warnings.some((w) => w.includes("custom effect"))).toBe(true);
    expect(plan.warnings.some((w) => w.includes("unknown effect"))).toBe(true);
  });

  it("emits levels, colour wheels, and tone curves", () => {
    const plan = buildRenderCommand(
      tl([
        {
          media_ref: "/a.mp4",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
          color: {
            blacks: 0.4,
            whites: 0.2,
            shadows: 0.3,
            highlights: -0.2,
            shadowsHue: 210,
            shadowsAmount: 0.5,
            masterCurve: [
              [0, 0.05],
              [1, 0.95],
            ],
          },
        },
      ]),
      "/o.mp4",
    );
    expect(plan.filterComplex).toContain("colorlevels=rimin=");
    expect(plan.filterComplex).toContain("colorbalance=rs=-0.2500");
    expect(plan.filterComplex).toContain("curves=master='0/0 0.25/0.2950 0.75/0.7200 1/1'");
    expect(plan.filterComplex).toContain("curves=master='0.0000/0.0500 1.0000/0.9500'");
  });

  it("renders chroma-key, clarity, and glow-as-effect", () => {
    const plan = buildRenderCommand(
      tl([
        {
          media_ref: "/a.mp4",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
          effects: [
            { type: "chroma", params: { color: "#00FF00", similarity: 0.4 } },
            { type: "clarity", params: { clarity: 0.5, dehaze: 0.3 } },
            { type: "glow", params: { intensity: 50 } },
          ],
        },
      ]),
      "/o.mp4",
    );
    expect(plan.filterComplex).toContain("chromakey=0x00FF00:0.4000:0.1000");
    expect(plan.filterComplex).toContain("unsharp=luma_msize_x=7");
    expect(plan.filterComplex).toContain("eq=contrast=1.0900");
    expect(plan.filterComplex).toContain("split=2"); // glow bloom sub-graph, driven from effects[]
  });

  it("renders glow as a split/blur/screen sub-graph", () => {
    const plan = buildRenderCommand(
      tl([
        {
          media_ref: "/a.mp4",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
          glow: 50,
        },
      ]),
      "/o.mp4",
    );
    expect(plan.filterComplex).toContain("split=2");
    expect(plan.filterComplex).toContain("lutyuv=y='if(gt(val,200),val,16)'");
    expect(plan.filterComplex).toContain("gblur=sigma=7.0000"); // 50/100 * 14
    expect(plan.filterComplex).toContain("blend=c0_mode=screen:c0_opacity=");
  });

  it("renders a non-normal blend as a masked-blend sub-graph", () => {
    const plan = buildRenderCommand(
      tl([
        {
          media_ref: "/a.mp4",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
          blend: "multiply",
        },
      ]),
      "/o.mp4",
    );
    expect(plan.filterComplex).toContain("blend=all_mode=multiply:shortest=1");
    expect(plan.filterComplex).toContain("alphamerge");
  });

  it("renders a crossfade transition centered on the cut", () => {
    // Two clips on ONE track so the outgoing/incoming pair share the cut.
    const oneTrack = {
      canvas: { width: 1920, height: 1080, fps: 30 },
      tracks: [
        {
          id: "v0",
          kind: "video",
          z: 0,
          clips: [
            { media_ref: "/a.mp4", source_in: 0, source_out: 2, timeline_in: 0, timeline_out: 2 },
            {
              media_ref: "/b.mp4",
              source_in: 0,
              source_out: 2,
              timeline_in: 2,
              timeline_out: 4,
              transition_in: { kind: "crossfade", duration: 0.5 },
            },
          ],
        },
      ],
    } as Timeline;
    const plan = buildRenderCommand(oneTrack, "/o.mp4");
    // Incoming fades in over the CENTERED window [cut-dur/2, cut+dur/2] = [1.75, 2.25].
    expect(plan.filterComplex).toContain("a='alpha(X,Y)*clip((T-1.750000)/0.500000,0,1)'");
    // Outgoing (A) holds its last frame for the second half (dur/2 = 0.25s).
    expect(plan.filterComplex).toContain("tpad=stop_mode=clone:stop_duration=0.250000");
    // Incoming (B) freezes its first frame for the first half (lead-in).
    expect(plan.filterComplex).toContain("tpad=start_mode=clone:start_duration=0.250000");
    expect(plan.warnings.some((w) => w.includes("transition"))).toBe(false);
  });

  it("renders wipe / whip / dip transitions centered on the cut (C2a)", () => {
    // Same abutting pair as the crossfade case; B carries the transition. Each kind emits a distinct
    // alpha over the SAME centred window [1.75, 2.25] the preview reads ΓÇö none is "approximated" now.
    const build = (kind: string) =>
      buildRenderCommand(
        {
          canvas: { width: 1920, height: 1080, fps: 30 },
          tracks: [
            {
              id: "v0",
              kind: "video",
              z: 0,
              clips: [
                {
                  media_ref: "/a.mp4",
                  source_in: 0,
                  source_out: 2,
                  timeline_in: 0,
                  timeline_out: 2,
                },
                {
                  media_ref: "/b.mp4",
                  source_in: 0,
                  source_out: 2,
                  timeline_in: 2,
                  timeline_out: 4,
                  transition_in: { kind, duration: 0.5 },
                },
              ],
            },
          ],
        } as Timeline,
        "/o.mp4",
      );
    const p = "clip((T-1.750000)/0.500000,0,1)"; // the shared 0->1 progress over the centred window
    // wipe-l keeps the LEFT fraction p (the preview shader discards x>p); wipe-r keeps the right.
    expect(build("wipe-l").filterComplex).toContain(`a='alpha(X,Y)*lt(X,W*${p})'`);
    expect(build("wipe-r").filterComplex).toContain(`a='alpha(X,Y)*gt(X,W*(1-${p}))'`);
    // whip = soft (0.12) left wipe: smoothstep(x-0.12, x, p) = t*t*(3-2t).
    expect(build("whip").filterComplex).toContain(`(3-2*(clip((${p}-X/W+0.12)/0.12,0,1)))`);
    // dip: incoming fades in over the SECOND half (2p-1); a full-canvas colour flash (alpha 2p) is
    // overlaid BETWEEN outgoing and incoming ΓÇö black for dip-to-black, white for dip-to-white.
    expect(build("dip-to-black").filterComplex).toContain(`a='alpha(X,Y)*clip(2*${p}-1,0,1)'`);
    expect(build("dip-to-black").filterComplex).toContain(
      "geq=r='0':g='0':b='0':a='255*clip(2*(T-1.750000)/0.500000,0,1)'",
    );
    expect(build("dip-to-white").filterComplex).toContain(
      "geq=r='255':g='255':b='255':a='255*clip(2*(T-1.750000)/0.500000,0,1)'",
    );
    for (const kind of ["wipe-l", "wipe-r", "whip", "dip-to-black", "dip-to-white"]) {
      expect(build(kind).warnings.some((w) => w.includes("transition"))).toBe(false);
    }
  });

  it("warns that a custom transition's expr is not evaluated (rendered as a crossfade)", () => {
    // `custom` carries a raw xfade expr; we render it as a plain crossfade and deliberately do NOT
    // evaluate the expr (an ffmpeg-injection surface). The downgrade must be VISIBLE, not silent.
    const plan = buildRenderCommand(
      {
        canvas: { width: 100, height: 100, fps: 30 },
        tracks: [
          {
            id: "v",
            kind: "video",
            z: 0,
            clips: [
              { media_ref: "/a.mp4", source_in: 0, source_out: 2, timeline_in: 0, timeline_out: 2 },
              {
                media_ref: "/b.mp4",
                source_in: 0,
                source_out: 2,
                timeline_in: 2,
                timeline_out: 4,
                transition_in: { kind: "custom", duration: 0.5, expr: "A*B" },
              },
            ],
          },
        ],
      } as Timeline,
      "/o.mp4",
    );
    expect(plan.warnings.some((w) => w.includes("custom expr not evaluated"))).toBe(true);
    // The raw expr never reaches the graph; custom renders as the linear crossfade dissolve.
    expect(plan.filterComplex).not.toContain("A*B");
    expect(plan.filterComplex).toContain("a='alpha(X,Y)*clip((T-1.750000)/0.500000,0,1)'");
  });

  it("renders audio fade and stretch", () => {
    const plan = buildRenderCommand(
      tl([
        {
          kind: "audio",
          media_ref: "/m.mp3",
          source_in: 0,
          source_out: 4,
          timeline_in: 0,
          timeline_out: 2,
          fade: { in: 15, out: 15 },
          stretch: true,
        },
      ]),
      "/o.mp4",
    );
    expect(plan.filterComplex).toContain("afade=t=in:st=0.000000:d=0.500000"); // 15 frames / 30 fps
    expect(plan.filterComplex).toContain("afade=t=out:st=1.500000:d=0.500000");
    expect(plan.filterComplex).toContain("atempo=2.000000"); // srcSpan 4 / tlSpan 2
  });

  it("renders a visual (alpha) fade on a video clip ΓÇö the twin of afade", () => {
    const plan = buildRenderCommand(
      tl([
        {
          kind: "video",
          media_ref: "/v.mp4",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
          fade: { in: 15, out: 15 },
        },
      ]),
      "/o.mp4",
    );
    // Same `fade` field as audio, but on video it ramps the ALPHA plane (15f/30 = 0.5s each).
    expect(plan.filterComplex).toContain("format=yuva420p");
    expect(plan.filterComplex).toContain("a='alpha(X,Y)*(min(");
    expect(plan.filterComplex).toContain("clip((T-0.000000)/0.500000,0,1)"); // fade-in ramp
    expect(plan.filterComplex).toContain("clip((2.000000-T)/0.500000,0,1)"); // fade-out ramp
  });

  it("renders a text clip as a libass caption band", () => {
    const plan = buildRenderCommand(
      tl(
        [
          {
            kind: "text",
            text: "Hello: World",
            timeline_in: 0,
            timeline_out: 2,
            style: { fontsize: 64, color: "yellow" },
            transform: { position: { x: 0.5, y: 0.5 } },
          },
        ],
        { width: 200, height: 100, fps: 30 },
      ),
      "/o.mp4",
    );
    // Captions burn in via a libass `ass` filter applied DIRECTLY to the accumulated stream ΓÇö libass
    // doesn't write an alpha plane, so the old "draw on a transparent layer then overlay" composited nothing.
    expect(plan.filterComplex).toContain("[base]ass=f=cap_band0.ass:fontsdir=fonts");
    expect(plan.filterComplex).not.toContain("format=rgba,ass="); // no transparent caption layer
    expect(plan.filterComplex).not.toContain("drawtext");
    expect(plan.assFiles).toHaveLength(1);
    expect(plan.assFiles[0].name).toBe("cap_band0.ass");
    const ass = plan.assFiles[0].content;
    expect(ass).toContain("PlayResX: 200");
    expect(ass).toContain("PlayResY: 100");
    // The static look (Poppins default family, authored 64px) lives in the named [V4+ Styles] row.
    expect(ass).toContain("Poppins,64,");
    // Safe margin insets the wrap box per EDGE: MarginL=MarginR=round(200*0.05)=10 (was 0,0 ΓÇö edge-touching).
    expect(ass).toContain(",10,10,0,,");
    // Centred (an5) at the canvas midpoint; the static marks moved to the style, so the inline override
    // is position-only and the text passes through.
    expect(ass).toContain("{\\an5\\pos(100,50)}Hello: World");
    expect(ass).toContain("0:00:00.00,0:00:02.00"); // start,end timing
    expect(plan.warnings.some((w) => w.includes("text"))).toBe(false);
  });

  it("clamps a caption's vertical centre into the title-safe band (Fix #2)", () => {
    const plan = buildRenderCommand(
      tl(
        [
          {
            kind: "text",
            text: "Low",
            timeline_in: 0,
            timeline_out: 2,
            style: { color: "white" },
            transform: { position: { x: 0.5, y: 0.99 } },
          },
        ],
        { width: 200, height: 100, fps: 30 },
      ),
      "/o.mp4",
    );
    // y=0.99 would place the centre at 99px on a 100px canvas (in the outer 5%); it clamps to
    // ch - round(ch*0.05) = 95, so the caption can't be anchored inside the bottom margin.
    expect(plan.assFiles[0].content).toContain("\\pos(100,95)");
  });

  it("resolves static caption styling (bold / upper-case / spacing / weight) into the ASS style (C1)", () => {
    const plan = buildRenderCommand(
      tl(
        [
          {
            kind: "text",
            text: "hi there",
            timeline_in: 0,
            timeline_out: 2,
            style: { bold: true, case: "upper", spacing: 8, color: "white" },
          },
        ],
        { width: 400, height: 200, fps: 30 },
      ),
      "/o.mp4",
    );
    const ass = plan.assFiles[0].content;
    const style = ass.split("\n").find((l) => l.startsWith("Style:"))!;
    expect(style).toContain(",-1,"); // Bold field = -1
    expect(style).toContain("100,100,8,"); // ScaleX,ScaleY,Spacing = 8 (letter spacing)
    expect(ass).toContain("}HI THERE"); // case applied in the PLAN, so both backends draw the identical string
    expect(ass).not.toContain("hi there");
    // A numeric weight lands in the Bold field verbatim (overrides the bold flag).
    const heavy = buildRenderCommand(
      tl([{ kind: "text", text: "x", timeline_in: 0, timeline_out: 2, style: { weight: 700 } }], {
        width: 400,
        height: 200,
        fps: 30,
      }),
      "/o.mp4",
    );
    expect(heavy.assFiles[0].content.split("\n").find((l) => l.startsWith("Style:"))!).toContain(
      ",700,",
    );
  });

  it("resolves outline / shadow / box painted decorations into the ASS style (C1)", () => {
    const plan = buildRenderCommand(
      tl(
        [
          {
            kind: "text",
            text: "X",
            timeline_in: 0,
            timeline_out: 2,
            style: {
              outline: { color: "#ffffff", width: 3 },
              shadow: { color: "#000000", depth: 2 },
            },
          },
        ],
        { width: 400, height: 200, fps: 30 },
      ),
      "/o.mp4",
    );
    const style = plan.assFiles[0].content.split("\n").find((l) => l.startsWith("Style:"))!;
    // outline width 3 + shadow depth 2 -> BorderStyle=1, Outline=3, Shadow=2 (all style-line fields now).
    expect(style).toContain(",1,3,2,");
    // A box WINS over an outline: the caption uses BorderStyle=3 with the box padding, not the outline width.
    const boxed = buildRenderCommand(
      tl(
        [
          {
            kind: "text",
            text: "Y",
            timeline_in: 0,
            timeline_out: 2,
            style: {
              outline: { color: "#fff", width: 5 },
              box: { color: "#000000", opacity: 0.6, padding: 10 },
            },
          },
        ],
        { width: 400, height: 200, fps: 30 },
      ),
      "/o.mp4",
    );
    const boxStyle = boxed.assFiles[0].content.split("\n").find((l) => l.startsWith("Style:"))!;
    expect(boxStyle).toContain(",3,10,"); // BorderStyle=3 (opaque box), Outline = padding 10
    expect(boxed.assFiles[0].content).not.toContain("\\bord"); // border is never an inline tag now
  });

  it("applies a style preset, with explicit fields overriding it (C5)", () => {
    const plan = buildRenderCommand(
      tl(
        [
          {
            kind: "text",
            text: "hi",
            timeline_in: 0,
            timeline_out: 2,
            style: { preset: "clean-white" },
          },
        ],
        { width: 1080, height: 1920, fps: 30 },
      ),
      "/o.mp4",
    );
    const style = plan.assFiles[0].content.split("\n").find((l) => l.startsWith("Style:"))!;
    expect(style).toContain("Poppins,92,"); // preset font + size seeded
    expect(style).toContain(",-1,"); // preset bold
    // Explicit fields override the preset.
    const over = buildRenderCommand(
      tl(
        [
          {
            kind: "text",
            text: "hi",
            timeline_in: 0,
            timeline_out: 2,
            style: { preset: "clean-white", size: 50, color: "#ff0000" },
          },
        ],
        { width: 1080, height: 1920, fps: 30 },
      ),
      "/o.mp4",
    );
    const os = over.assFiles[0].content.split("\n").find((l) => l.startsWith("Style:"))!;
    expect(os).toContain("Poppins,50,"); // size overridden
    expect(os).toContain("&H000000FF"); // colour overridden to red (Primary, ARGB BGR order)
    // A preset that forces upper-case cases the text in the plan.
    const punchy = buildRenderCommand(
      tl(
        [
          {
            kind: "text",
            text: "loud",
            timeline_in: 0,
            timeline_out: 2,
            style: { preset: "punchy" },
          },
        ],
        { width: 1080, height: 1920, fps: 30 },
      ),
      "/o.mp4",
    );
    expect(punchy.assFiles[0].content).toContain("}LOUD");
  });

  it("expands a phrase-chunks caption into ONE timed Dialogue per chunk (Fix #3B)", () => {
    const plan = buildRenderCommand(
      tl(
        [
          {
            kind: "text",
            content: [
              { text: "first", t_in: 0, t_out: 1 },
              { text: "second", t_in: 1, t_out: 2 },
            ],
            timeline_in: 0,
            timeline_out: 2,
            animation: { build: "phrase-chunks", timing: "explicit" },
            style: { color: "white" },
          },
        ],
        { width: 400, height: 200, fps: 30 },
      ),
      "/o.mp4",
    );
    const dialogues = plan.assFiles[0].content.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(dialogues).toHaveLength(2);
    expect(dialogues[0]).toContain("0:00:00.00,0:00:01.00");
    expect(dialogues[0]).toContain("}first");
    expect(dialogues[1]).toContain("0:00:01.00,0:00:02.00");
    expect(dialogues[1]).toContain("}second");
  });

  it("splits phrase-chunks evenly across the clip when timing isn't explicit", () => {
    const plan = buildRenderCommand(
      tl(
        [
          {
            kind: "text",
            content: [{ text: "a" }, { text: "b" }],
            timeline_in: 0,
            timeline_out: 2,
            animation: { build: "phrase-chunks" },
            style: { color: "white" },
          },
        ],
        { width: 400, height: 200, fps: 30 },
      ),
      "/o.mp4",
    );
    const dialogues = plan.assFiles[0].content.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(dialogues).toHaveLength(2);
    expect(dialogues[0]).toContain("0:00:00.00,0:00:01.00"); // 2s / 2 chunks
    expect(dialogues[1]).toContain("0:00:01.00,0:00:02.00");
  });

  it("resolves entrance/exit fade into a \\fad tag (Fix #3B)", () => {
    const plan = buildRenderCommand(
      tl(
        [
          {
            kind: "text",
            text: "hi",
            timeline_in: 0,
            timeline_out: 2,
            animation: { entrance: "fade", exit: "fade", entrance_ms: 500, exit_ms: 200 },
            style: { color: "white" },
          },
        ],
        { width: 400, height: 200, fps: 30 },
      ),
      "/o.mp4",
    );
    expect(plan.assFiles[0].content).toContain("\\fad(500,200)");
    // A 'fade' with no explicit duration defaults to 300ms; a missing side is 0.
    const def = buildRenderCommand(
      tl(
        [
          {
            kind: "text",
            text: "hi",
            timeline_in: 0,
            timeline_out: 2,
            animation: { entrance: "fade" },
            style: { color: "white" },
          },
        ],
        { width: 400, height: 200, fps: 30 },
      ),
      "/o.mp4",
    );
    expect(def.assFiles[0].content).toContain("\\fad(300,0)");
  });

  it("applies emphasis to hero chunks ΓÇö recolour (colour kinds) and pop (scale) (Fix #3B)", () => {
    const colorPlan = buildRenderCommand(
      tl(
        [
          {
            kind: "text",
            content: [{ text: "plain" }, { text: "hero", emphasis: true }],
            timeline_in: 0,
            timeline_out: 2,
            animation: {
              build: "phrase-chunks",
              timing: "even",
              emphasis: { kind: "color", color: "#ff0000" },
            },
            style: { color: "#ffffff" },
          },
        ],
        { width: 400, height: 200, fps: 30 },
      ),
      "/o.mp4",
    );
    const cd = colorPlan.assFiles[0].content;
    const d = cd.split("\n").filter((l) => l.startsWith("Dialogue:"));
    const styles = cd.split("\n").filter((l) => l.startsWith("Style:"));
    // The recolour now manifests as a DISTINCT named style (Primary colour), not an inline \1c: plain
    // white vs hero red are two styles, and each chunk references its own.
    expect(styles.length).toBeGreaterThanOrEqual(2);
    expect(cd).toContain("&H000000FF"); // hero red Primary (full ARGB, BGR byte order)
    expect(d[0]).toContain("}plain");
    expect(d[1]).toContain("}hero");
    expect(d[0].split(",")[3]).not.toBe(d[1].split(",")[3]); // plain + hero reference different styles

    const popPlan = buildRenderCommand(
      tl(
        [
          {
            kind: "text",
            content: [{ text: "a" }, { text: "b", emphasis: true }],
            timeline_in: 0,
            timeline_out: 2,
            animation: {
              build: "phrase-chunks",
              timing: "even",
              emphasis: { kind: "pop", scale: 1.5 },
            },
            style: { color: "#ffffff" },
          },
        ],
        { width: 400, height: 200, fps: 30 },
      ),
      "/o.mp4",
    );
    const p = popPlan.assFiles[0].content.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(p[0]).not.toContain("\\fscx"); // plain chunk: no scale
    expect(p[1]).toContain("\\fscx150\\fscy150"); // hero chunk popped to 150%
  });

  it("highlight / box-invert emphasis boxes the hero chunk (BorderStyle=3), not a recolour (Slice A)", () => {
    const heroStyles = (kind: string) => {
      const ass = buildRenderCommand(
        tl(
          [
            {
              kind: "text",
              content: [{ text: "a" }, { text: "b", emphasis: true }],
              timeline_in: 0,
              timeline_out: 2,
              animation: {
                build: "phrase-chunks",
                timing: "even",
                emphasis: { kind, color: "#ffff00" },
              },
              style: { color: "#ffffff" },
            },
          ],
          { width: 400, height: 200, fps: 30 },
        ),
        "/o.mp4",
      ).assFiles[0].content;
      // The hero chunk's style carries the emphasis-colour box (&H0000FFFF = yellow, ARGB BGR order).
      return ass.split("\n").filter((l) => l.startsWith("Style:") && l.includes("&H0000FFFF"));
    };
    const hi = heroStyles("highlight");
    expect(hi).toHaveLength(1); // exactly the hero chunk's box style, in the emphasis colour
    expect(hi[0]).toMatch(/,3,\d/); // BorderStyle=3 (opaque box), not the recolour of before
    expect(hi[0]).toContain("&H00FFFFFF"); // highlight keeps the base white text (Primary)
    const inv = heroStyles("box-invert");
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatch(/,3,\d/);
    expect(inv[0]).toContain("&H00000000"); // box-invert inverts the text to black (Primary)
  });

  it("emits \\t for a pop entrance and \\move for a slide entrance (Fix #3B)", () => {
    const pop = buildRenderCommand(
      tl(
        [
          {
            kind: "text",
            text: "hi",
            timeline_in: 0,
            timeline_out: 2,
            animation: { entrance: "pop", entrance_ms: 400 },
            style: { color: "white" },
          },
        ],
        { width: 400, height: 200, fps: 30 },
      ),
      "/o.mp4",
    );
    expect(pop.assFiles[0].content).toContain("\\fscx60\\fscy60\\t(0,400,\\fscx100\\fscy100)");
    const slide = buildRenderCommand(
      tl(
        [
          {
            kind: "text",
            text: "hi",
            timeline_in: 0,
            timeline_out: 2,
            animation: { entrance: "slide-up", entrance_ms: 400 },
            style: { color: "white" },
            transform: { position: { x: 0.5, y: 0.5 } },
          },
        ],
        { width: 400, height: 200, fps: 30 },
      ),
      "/o.mp4",
    );
    // slide-up animates position via \move (ending at the final pos) instead of a static \pos.
    expect(slide.assFiles[0].content).toContain("\\move(200,");
    expect(slide.assFiles[0].content).not.toContain("\\pos(200,100)");
  });

  it("builds a \\k karaoke line for word-highlight (Fix #3B)", () => {
    const plan = buildRenderCommand(
      tl(
        [
          {
            kind: "text",
            content: [
              { text: "one", t_in: 0, t_out: 1 },
              { text: "two", t_in: 1, t_out: 2 },
            ],
            timeline_in: 0,
            timeline_out: 2,
            animation: {
              build: "word-highlight",
              timing: "explicit",
              emphasis: { kind: "color", color: "#00ff00" },
            },
            style: { color: "#ffffff" },
          },
        ],
        { width: 400, height: 200, fps: 30 },
      ),
      "/o.mp4",
    );
    const line = plan.assFiles[0].content.split("\n").find((l) => l.startsWith("Dialogue:"))!;
    expect(line).toContain("\\1c&H00FF00&"); // highlight = emphasis green (Primary)
    expect(line).toContain("\\2c&HFFFFFF&\\2a&H80&"); // unspoken = dim base white (Secondary)
    expect(line).toContain("{\\k100}one {\\k100}two"); // one \k per word, 100cs each
    // A word-highlight caption is ONE Dialogue (not one per word).
    expect(
      plan.assFiles[0].content.split("\n").filter((l) => l.startsWith("Dialogue:")),
    ).toHaveLength(1);
  });

  it("renders word-by-word / append / typewriter as a stepped REVEAL (C3)", () => {
    for (const build of ["word-by-word", "append", "typewriter"]) {
      const plan = buildRenderCommand(
        tl(
          [
            {
              kind: "text",
              content: [
                { text: "one", t_in: 0, t_out: 1 },
                { text: "two", t_in: 1, t_out: 2 },
              ],
              timeline_in: 0,
              timeline_out: 2,
              animation: { build, timing: "explicit" },
              style: { color: "#ffffff" },
            },
          ],
          { width: 400, height: 200, fps: 30 },
        ),
        "/o.mp4",
      );
      const lines = plan.assFiles[0].content.split("\n").filter((l) => l.startsWith("Dialogue:"));
      // One line PER STEP, not one \k line for the whole caption: a single \k line can only swap the
      // fill, which leaves the outline of a word that has not been spoken yet painted on screen.
      expect(lines, build).toHaveLength(2);
      expect(lines[0], build).toContain("{\\alpha&HFF&}two"); // "two" not due yet -> fully hidden
      expect(lines[1], build).not.toContain("\\alpha"); // both words are due -> nothing hidden
      // The reveal boundary follows the explicit word timing, not an even split.
      expect(lines[1], build).toContain("0:00:01.00");
    }
  });

  it("clamps each caption's font to a BUNDLED family (unknown -> Poppins, never a system fallback)", () => {
    const plan = buildRenderCommand(
      tl(
        [
          {
            kind: "text",
            text: "Hi",
            timeline_in: 0,
            timeline_out: 2,
            style: { font: "Anton", fontsize: 40, color: "white" },
          },
          {
            kind: "text",
            text: "Yo",
            timeline_in: 0,
            timeline_out: 2,
            style: { font: "Nonesuch", fontsize: 40, color: "white" },
          },
        ],
        { width: 200, height: 100, fps: 30 },
      ),
      "/o.mp4",
    );
    // Two text clips, no video between -> one shared band; each distinct font family gets its own named style.
    expect(plan.assFiles).toHaveLength(1);
    const ass = plan.assFiles[0].content;
    const styles = ass.split("\n").filter((l) => l.startsWith("Style:"));
    expect(styles.some((s) => s.includes("Anton,40,"))).toBe(true); // known family kept
    expect(styles.some((s) => s.includes("Poppins,40,"))).toBe(true); // "Nonesuch" clamped to the bundled default
    expect(ass).not.toContain("Nonesuch"); // never emitted -> no per-machine system-font fallback
    expect(plan.fonts.length).toBeGreaterThan(0); // both families bundled -> their ttfs are staged
    // No drawtext fontfile path anymore ΓÇö glyphs resolve by family from the staged fontsdir at render.
    expect(plan.filterComplex).not.toContain("fontfile");
    expect(plan.filterComplex).toContain("ass=f=cap_band0.ass:fontsdir=fonts");
  });

  it("scales text size by transform.scale (fold-in: sizePx * scale)", () => {
    const plan = buildRenderCommand(
      tl(
        [
          {
            kind: "text",
            text: "hi",
            timeline_in: 0,
            timeline_out: 2,
            style: { size: 40 },
            transform: { scale: 2 },
          },
        ],
        { width: 400, height: 200, fps: 30 },
      ),
      "/o.mp4",
    );
    expect(plan.assFiles[0].content).toContain("Poppins,80,"); // 40 * 2
  });

  it("reads text from a content array and skips empty text clips", () => {
    const plan = buildRenderCommand(
      tl(
        [
          {
            kind: "text",
            content: [{ text: "Line A" }, { text: "Line B" }],
            timeline_in: 0,
            timeline_out: 2,
            style: { size: 30 },
          },
          { kind: "text", text: "", timeline_in: 0, timeline_out: 2 },
        ],
        { width: 200, height: 100, fps: 30 },
      ),
      "/o.mp4",
    );
    // The content array joins into one caption; the empty clip emits no Dialogue (single band, one line).
    expect(plan.assFiles).toHaveLength(1);
    const ass = plan.assFiles[0].content;
    expect(ass).toContain("Poppins,30,"); // authored size 30 in the named style
    expect(ass).toContain("}Line A Line B");
    expect((ass.match(/^Dialogue:/gm) ?? []).length).toBe(1); // empty clip skipped
  });

  it("covers glow object form, screen blend, and the audio duck warning", () => {
    const g = buildRenderCommand(
      tl([
        {
          media_ref: "/a.mp4",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
          glow: { amount: 100, opacity: 0.4 },
          blend: "screen",
        },
      ]),
      "/o.mp4",
    );
    expect(g.filterComplex).toContain("blend=c0_mode=screen:c0_opacity=0.4000");
    expect(g.filterComplex).toContain("blend=all_mode=screen:shortest=1");
    const a = buildRenderCommand(
      tl([
        {
          kind: "audio",
          media_ref: "/m.mp3",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
          duck: { against: "x" },
          loop: true,
        },
      ]),
      "/o.mp4",
    );
    expect(a.warnings.some((w) => w.includes("no audio to key off"))).toBe(true);
    expect(a.warnings.some((w) => w.includes("loop"))).toBe(false); // loop now fills (aloop), no warning
  });

  // `duck` was accepted, persisted, clamped and PREVIEWED, while the exporter emitted
  // "duck not rendered (scoped)" ΓÇö so the agent truthfully reported a ducked mix the delivered file
  // did not contain (measured: score -13.7 LUFS against a -21.3 LUFS voiceover, narration buried).
  describe("duck reaches the graph", () => {
    const voiceAndMusic = (duck: Record<string, unknown>) =>
      buildRenderCommand(
        {
          canvas: { width: 16, height: 16, fps: 30 },
          tracks: [
            {
              id: "vo",
              kind: "audio",
              z: 0,
              clips: [
                {
                  id: "speech",
                  kind: "audio",
                  media_ref: "/v.wav",
                  source_in: 0,
                  source_out: 2,
                  timeline_in: 0,
                  timeline_out: 2,
                },
              ],
            },
            {
              id: "music",
              kind: "audio",
              z: 1,
              clips: [
                {
                  id: "bed",
                  kind: "audio",
                  media_ref: "/m.mp3",
                  source_in: 0,
                  source_out: 2,
                  timeline_in: 0,
                  timeline_out: 2,
                  duck,
                },
              ],
            },
          ],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        "/o.mp4",
      );

    it("keys the ducked clip off the named track and stops warning", () => {
      const p = voiceAndMusic({ against: "vo" });
      expect(p.filterComplex).toContain("sidechaincompress");
      expect(p.warnings.some((w) => w.includes("duck"))).toBe(false);
    });

    it("still mixes the key track into the output rather than spending it on the sidechain", () => {
      // An ffmpeg pad is consumed once. Without an asplit the voice would key the duck and then be
      // MISSING from the mix ΓÇö a silent voiceover, which is worse than no ducking at all.
      const p = voiceAndMusic({ against: "vo" });
      expect(p.filterComplex).toContain("asplit");
      const mix = p.filterComplex.split("amix=inputs=2")[0].split(";").at(-1) ?? "";
      expect(mix).toMatch(/\[k0m\]/); // the voice's mix tap, not its sidechain tap
    });

    it("carries the caller's ratio and threshold, and defaults them otherwise", () => {
      expect(voiceAndMusic({ against: "vo", ratio: 12, threshold: 0.2 }).filterComplex).toContain(
        "threshold=0.2:ratio=12",
      );
      expect(voiceAndMusic({ against: "vo" }).filterComplex).toContain("threshold=0.03:ratio=8");
    });

    // The failure direction: a clip must not key off itself (it would gate on its own level and
    // duck nothing), and an unknown track must be reported rather than silently ignored.
    it("refuses to key a clip off its own track, and says so", () => {
      const p = voiceAndMusic({ against: "music" });
      expect(p.filterComplex).not.toContain("sidechaincompress");
      expect(p.warnings.some((w) => w.includes("no audio to key off"))).toBe(true);
    });
  });

  it("emits a per-frame geq alpha for keyframed opacity (no longer deferred)", () => {
    const plan = buildRenderCommand(
      tl([
        {
          media_ref: "/a.mp4",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
          opacity: [
            { t: 0, v: 0 },
            { t: 2, v: 1 },
          ],
        },
      ]),
      "/o.mp4",
    );
    expect(plan.filterComplex).toContain("format=yuva420p");
    expect(plan.filterComplex).toContain("geq=lum='lum(X,Y)'");
    expect(plan.filterComplex).toContain("a='alpha(X,Y)*clip(");
    expect(plan.warnings.some((w) => w.includes("opacity"))).toBe(false);
  });

  it("mixes two audio clips and warns on deferred features", () => {
    const twoAudio = buildRenderCommand(
      tl([
        {
          kind: "audio",
          media_ref: "/m.mp3",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
        },
        {
          kind: "audio",
          media_ref: "/n.mp3",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
        },
      ]),
      "/o.mp4",
    );
    expect(twoAudio.filterComplex).toContain("amix=inputs=2:normalize=0");

    const warned = buildRenderCommand(
      tl([
        {
          media_ref: "/a.mp4",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
          transition_in: { kind: "wipe-l", duration: 15 },
        },
        {
          kind: "audio",
          media_ref: "/m.mp3",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
          duck: { against: "x" },
        },
      ]),
      "/o.mp4",
    );
    // wipe-l is now RENDERED as a spatially-masked geq (C2a), not "approximated as none", so it must
    // NOT warn; a `duck` against a track that carries no audio must. (Positive render coverage for
    // every transition kind lives in render.corpus.test.ts.)
    expect(warned.filterComplex).toContain("a='alpha(X,Y)*lt(X,W*");
    expect(warned.warnings.some((w) => w.includes("transition"))).toBe(false);
    expect(warned.warnings.some((w) => w.includes("duck"))).toBe(true);
  });

  it("renders audio over a black canvas when there is no video", () => {
    const plan = buildRenderCommand(
      tl([
        {
          kind: "audio",
          media_ref: "/m.mp3",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
        },
      ]),
      "/o.mp4",
    );
    expect(plan.args.join(" ")).toContain("-map [base]");
    expect(plan.args.join(" ")).toContain("-map [a0]");
  });
});

describe("exportTimelineTool (format contract)", () => {
  it("rejects fcpxml as deferred and accepts mp4/mov/video past the format gate", async () => {
    const { ctx } = await seededCtx(); // empty starter timeline
    const bad = (await exportTimelineTool({ format: "fcpxml" }, ctx)) as Any;
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toMatch(/fcpxml|deferred|unsupported/i); // NLE interchange is deferred
    // Supported formats clear the format gate ΓÇö they fail LATER on the empty
    // timeline, NOT with an 'unsupported format' error.
    for (const format of ["mp4", "mov", "video"]) {
      const r = (await exportTimelineTool({ format }, ctx)) as Any;
      expect(r.ok).toBe(false);
      expect(String(r.error)).not.toMatch(/unsupported/i);
    }
    expect(((await exportTimelineTool({}, null)) as Any).ok).toBe(false); // no context
  });
});

async function renderCtx(
  ffmpeg: (path: string) => { code: number; stderr: string },
): Promise<{ ctx: ClientToolContext; fs: MemFs }> {
  const fs = new MemFs();
  const store = new ProjectStoreAccess("C:/proj", fs);
  registerTestDocument("C:/proj"); // back the store with an open document so addClipsTool commits
  await ensureTimeline(store);
  const runner = {
    run: async (program: string, args: string[]) => {
      if (program === "ffmpeg") {
        const r = ffmpeg(args[args.length - 1]);
        if (r.code === 0) await fs.writeTextFile(args[args.length - 1], "video");
        return { code: r.code, stdout: "", stderr: r.stderr };
      }
      return { code: 0, stdout: "", stderr: "" }; // ffprobe (add_clips has-audio) -> no audio
    },
  };
  return { ctx: { store, runner }, fs };
}

describe("resolveClipSources ΓÇö lut hardening", () => {
  it("drops an absolute lut and resolves a contained project-relative lut", async () => {
    // An agent-supplied LUT must be a library asset, never a raw system path fed to ffmpeg's
    // lut3d=file=. An absolute lut is dropped (grade still applies); a contained ref resolves.
    const fs = new MemFs();
    await fs.writeTextFile("C:/proj/luts/film.cube", "LUT"); // a contained project asset
    const store = new ProjectStoreAccess("C:/proj", fs);
    const ctx: ClientToolContext = { store, runner: makeRunner() };
    const timeline = tl([
      { media_ref: "a.mp4", color: { lut: "/etc/evil.cube" } }, // absolute -> dropped
      { media_ref: "b.mp4", color: { lut: "luts/film.cube" } }, // contained -> resolved to absolute
    ]);
    await resolveClipSources(ctx, timeline);
    expect((timeline.tracks[0].clips![0].color as Any).lut).toBe(""); // no arbitrary-file lut3d reaches ffmpeg
    expect((timeline.tracks[1].clips![0].color as Any).lut).toBe(
      joinPath("C:/proj/luts/film.cube"),
    );
  });
});

class BytesFs extends MemFs {
  bin = new Map<string, Uint8Array>();
  async readBytes(p: string): Promise<Uint8Array> {
    const v = this.bin.get(joinPath(p));
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return v;
  }
}

/** A PNG header at an arbitrary size ΓÇö enough for the decodability check, no pixels needed. */
function pngHeader(w: number, h: number): Uint8Array {
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0,
    0,
    0,
    13,
    0x49,
    0x48,
    0x44,
    0x52,
    ...[24, 16, 8, 0].map((s) => (w >>> s) & 255),
    ...[24, 16, 8, 0].map((s) => (h >>> s) & 255),
  ]);
}

describe("runRenderPlan ΓÇö undecodable still backstop", () => {
  // The import fence stops NEW media, but a library authored before it ΓÇö or a linked file that
  // changed on disk ΓÇö still reaches here. ffmpeg answers an oversized still under `-loop 1` by
  // retrying forever (29 minutes of CPU, no output, no error), so the only observable proof is
  // that ffmpeg is never spawned at all.
  function planFor(size: Uint8Array): {
    plan: ReturnType<typeof buildRenderCommand>;
    ctx: ClientToolContext;
    spawned: string[];
  } {
    const fs = new BytesFs();
    fs.bin.set(joinPath("C:/proj/library/shot.png"), size);
    const spawned: string[] = [];
    const ctx: ClientToolContext = {
      store: new ProjectStoreAccess("C:/proj", fs),
      runner: makeRunner((program) => {
        spawned.push(program);
        return { code: 0, stdout: "", stderr: "" };
      }),
    };
    const plan = buildRenderCommand(
      tl([{ media_ref: "C:/proj/library/shot.png", timeline_in: 0, timeline_out: 3 }]),
      "C:/proj/out.mp4",
    );
    return { plan, ctx, spawned };
  }

  it("refuses to launch ffmpeg on a still it cannot decode, and says which file", async () => {
    const { plan, ctx, spawned } = planFor(pngHeader(6864, 41754));
    const r = await runRenderPlan(ctx, plan);
    expect(spawned).toEqual([]); // the hang can only be prevented BEFORE the spawn
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("shot.png");
    expect(r.stderr).toMatch(/6864x41754/);
    expect(r.stderr).not.toContain("C:/proj"); // absolute paths stay internal
  });

  it("runs normally when the same still is decodable (the guard is not blanket)", async () => {
    const { plan, ctx, spawned } = planFor(pngHeader(3000, 2000));
    expect((await runRenderPlan(ctx, plan)).code).toBe(0);
    expect(spawned).toEqual(["ffmpeg"]);
  });

  it("still spawns when the still is unreadable ΓÇö ffmpeg names a missing file better", async () => {
    const spawned: string[] = [];
    const ctx: ClientToolContext = {
      store: new ProjectStoreAccess("C:/proj", new BytesFs()), // nothing registered: readBytes throws
      runner: makeRunner((program) => {
        spawned.push(program);
        return { code: 1, stdout: "", stderr: "No such file" };
      }),
    };
    const plan = buildRenderCommand(
      tl([{ media_ref: "C:/proj/library/gone.png", timeline_in: 0, timeline_out: 3 }]),
      "C:/proj/out.mp4",
    );
    await runRenderPlan(ctx, plan);
    expect(spawned).toEqual(["ffmpeg"]);
  });

  it("carries every still onto the plan ΓÇö a video-only render lists none", () => {
    // Without this the guard above is inert: it can only check what buildRenderCommand hands it.
    const mixed = buildRenderCommand(
      tl([
        { media_ref: "/a.mp4", source_in: 0, source_out: 2, timeline_in: 0, timeline_out: 2 },
        { media_ref: "/p.png", timeline_in: 0, timeline_out: 2 },
        { media_ref: "/q.jpg", timeline_in: 0, timeline_out: 2 },
      ]),
      "/o.mp4",
    );
    expect(mixed.stillImages).toEqual(["/p.png", "/q.jpg"]);
    expect(
      buildRenderCommand(
        tl([{ media_ref: "/a.mp4", source_in: 0, source_out: 2, timeline_in: 0, timeline_out: 2 }]),
        "/o.mp4",
      ).stillImages,
    ).toEqual([]);
  });
});

/** A minimal in-memory FsLike that (unlike MemFs) implements recursive `remove` and prefix-aware
 *  `exists`, so a caption-lifecycle test can PROVE the per-render scratch DIR and its .ass files are
 *  gone afterwards ΓÇö MemFs tracks only exact file keys and has no remove, so it can't observe cleanup. */
class CapFs implements FsLike {
  files = new Map<string, string>();
  async exists(p: string): Promise<boolean> {
    const k = joinPath(p);
    if (this.files.has(k)) return true;
    const prefix = k.endsWith("/") ? k : `${k}/`;
    for (const f of this.files.keys()) if (f.startsWith(prefix)) return true; // a dir with children
    return false;
  }
  async readTextFile(p: string): Promise<string> {
    const v = this.files.get(joinPath(p));
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return v;
  }
  async writeTextFile(p: string, c: string): Promise<void> {
    this.files.set(joinPath(p), c);
  }
  async mkdir(): Promise<void> {}
  async remove(p: string): Promise<void> {
    const k = joinPath(p);
    const prefix = k.endsWith("/") ? k : `${k}/`;
    for (const f of [...this.files.keys()])
      if (f === k || f.startsWith(prefix)) this.files.delete(f);
  }
}

/** Author a one-caption timeline through the REAL producer (addTextClipsTool) so it's guaranteed
 *  valid, then run renderTimelineTool with a runner that records ffmpeg's cwd + whether the caption
 *  .ass was staged there at run time. */
async function captionRenderCtx(
  ffmpeg: () => { code: number; stderr: string },
): Promise<{ ctx: ClientToolContext; fs: CapFs; seen: { cwd?: string; assStaged: boolean } }> {
  const fs = new CapFs();
  const store = new ProjectStoreAccess("C:/proj", fs);
  registerTestDocument("C:/proj");
  await ensureTimeline(store);
  const seen: { cwd?: string; assStaged: boolean } = { assStaged: false };
  const runner = {
    run: async (program: string, args: string[], _signal?: AbortSignal, cwd?: string) => {
      if (program === "ffmpeg") {
        seen.cwd = cwd;
        // The .ass the graph references by BARE name must already sit in the cwd at run time.
        seen.assStaged = cwd != null && (await fs.exists(joinPath(cwd, "cap_band0.ass")));
        const r = ffmpeg();
        if (r.code === 0) await fs.writeTextFile(args[args.length - 1], "video");
        return { code: r.code, stdout: "", stderr: r.stderr };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const ctx: ClientToolContext = { store, runner };
  await addTextClipsTool(
    { entries: [{ content: "Hello", timeline_in: 0, timeline_out: 60 }] },
    ctx,
  );
  return { ctx, fs, seen };
}

describe("renderTimelineTool", () => {
  it("errors without ctx and when the timeline is empty", async () => {
    expect(((await renderTimelineTool({}, null)) as Any).ok).toBe(false);
    const { ctx } = await seededCtx();
    const r = (await renderTimelineTool({}, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("empty");
  });

  it("renders a placed clip to an mp4", async () => {
    const { ctx } = await renderCtx(() => ({ code: 0, stderr: "" }));
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }] },
      ctx,
    );
    const r = (await renderTimelineTool({}, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(String(r.final_mp4)).toContain("renderer/final.mp4");
    expect(r.duration_s).toBe(2);
  });

  it("surfaces an ffmpeg failure", async () => {
    const { ctx } = await renderCtx(() => ({ code: 1, stderr: "boom filter error" }));
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }] },
      ctx,
    );
    const r = (await renderTimelineTool({}, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.stderr_tail)).toContain("boom");
    // The reason must be IN the message, not in a sibling field: the export path throws
    // `new Error(res.error)` and drops everything else, so every export failure reached the user
    // as "ffmpeg render failed (code=-22). Read stderr_tail." with no stderr_tail anywhere.
    expect(String(r.error)).toContain("boom");
    expect(String(r.error)).not.toMatch(/Read stderr_tail/i);
  });

  it("says ffmpeg printed nothing rather than pointing at an empty field", async () => {
    const { ctx } = await renderCtx(() => ({ code: -22, stderr: "" }));
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }] },
      ctx,
    );
    const r = (await renderTimelineTool({}, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("code=-22");
    expect(String(r.error)).toMatch(/printed nothing/i);
  });

  it("errors when ffmpeg reports success but writes no file", async () => {
    const store = new ProjectStoreAccess("C:/proj", new MemFs());
    await ensureTimeline(store);
    const ctx: ClientToolContext = { store, runner: makeRunner() };
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }] },
      ctx,
    );
    expect(((await renderTimelineTool({}, ctx)) as Any).ok).toBe(false);
  });

  it("rejects a timeline that fails preflight", async () => {
    const store = new ProjectStoreAccess("C:/proj", new MemFs());
    await store.writeText(
      "C:/proj/internals/timeline.json",
      JSON.stringify({
        units: "frames",
        canvas: { width: 100, height: 100, fps: 30 },
        tracks: [
          {
            id: "v",
            kind: "video",
            z: 0,
            clips: [
              {
                media_ref: "/a.mp4",
                source_in: 0,
                source_out: 30,
                timeline_in: 30,
                timeline_out: 10,
              },
            ],
          },
        ],
      }),
    );
    const ctx: ClientToolContext = { store, runner: makeRunner() };
    const r = (await renderTimelineTool({}, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(r.preflight_errors).toBeDefined();
  });

  it("stages caption .ass files in a scratch cwd and cleans it up on success", async () => {
    const { ctx, fs, seen } = await captionRenderCtx(() => ({ code: 0, stderr: "" }));
    const r = (await renderTimelineTool({}, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(seen.cwd).toBeTruthy(); // ffmpeg ran with the per-render scratch dir as cwd
    expect(seen.assStaged).toBe(true); // and the caption file was staged there BEFORE the run
    // Cleanup: the scratch dir and its .ass are gone ΓÇö nothing leaks into the project package.
    expect(await fs.exists(joinPath(seen.cwd!, "cap_band0.ass"))).toBe(false);
    expect(await fs.exists(seen.cwd!)).toBe(false);
  });

  it("removes the caption scratch dir even when ffmpeg fails (finally cleanup)", async () => {
    const { ctx, fs, seen } = await captionRenderCtx(() => ({
      code: 1,
      stderr: "boom filter error",
    }));
    const r = (await renderTimelineTool({}, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(seen.cwd).toBeTruthy();
    expect(seen.assStaged).toBe(true); // staged before ffmpeg, even on the failing run
    // The scratch dir is still removed on the failure path (cleanup is in `finally`, not the ok branch).
    expect(await fs.exists(seen.cwd!)).toBe(false);
  });
});

describe("exportTimelineTool", () => {
  it("delegates mp4 to render and rejects unknown formats", async () => {
    expect(((await exportTimelineTool({}, null)) as Any).ok).toBe(false);
    const { ctx } = await seededCtx();
    const bad = (await exportTimelineTool({ format: "fcpxml" }, ctx)) as Any;
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toContain("unsupported");
    const mp4 = (await exportTimelineTool({ format: "mp4" }, ctx)) as Any;
    expect(mp4.ok).toBe(false); // empty timeline -> render error
  });

  it("renders the deliverable into the OS Downloads dir, not the project", async () => {
    const { ctx } = await renderCtx(() => ({ code: 0, stderr: "" }));
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }] },
      ctx,
    );
    const r = (await exportTimelineTool({}, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(r.format).toBe("mp4");
    expect(r.saved_to).toBe("proj.mp4"); // filename only ΓÇö no system path leaked to the model
    expect(String(r.note)).toContain("Downloads");
  });

  // ΓöÇΓöÇ Save As: the user chooses where the deliverable lands ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
  //
  // The rule under test is `exportDestination` ΓÇö the ONE place that decides the output
  // path for BOTH doors (the Export menu, which passes the path the user picked in the OS
  // save dialog, and the agent, which usually passes nothing). Asserting it in isolation
  // is not enough: the tool could compute a destination and then render somewhere else,
  // so the first test reads the path ffmpeg was ACTUALLY handed.

  it("renders to the path the caller chose, not Downloads (the whole path, menu -> ffmpeg)", async () => {
    let outPath = "";
    const { ctx, fs } = await renderCtx((p) => {
      outPath = p;
      return { code: 0, stderr: "" };
    });
    await fs.writeTextFile("D:/Videos/keep.txt", "x"); // make D:/Videos a real folder
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }] },
      ctx,
    );
    const r = (await exportTimelineTool({ output_path: "D:/Videos/final cut.mp4" }, ctx)) as Any;
    expect(r.ok).toBe(true);
    // The OUTCOME: ffmpeg wrote where the user pointed, and the file is there.
    expect(outPath).toBe("D:/Videos/final cut.mp4");
    expect(await fs.exists("D:/Videos/final cut.mp4")).toBe(true);
    expect(r.saved_to).toBe("final cut.mp4");
    // The "Saved to your Downloads folder" note is a LIE once a path was chosen, so it is
    // absent. Without this the dialog cheerfully misreports every custom destination.
    expect(r.note).toBeUndefined();
  });

  it("still defaults to Downloads when no destination is chosen", async () => {
    let outPath = "";
    const { ctx } = await renderCtx((p) => {
      outPath = p;
      return { code: 0, stderr: "" };
    });
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }] },
      ctx,
    );
    // Empty string / whitespace is "not chosen", not "write to the root".
    const r = (await exportTimelineTool({ output_path: "   " }, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(outPath).toBe("C:/Users/test/Downloads/proj.mp4");
    expect(String(r.note)).toContain("Downloads");
  });

  // Reported 2026-08-10: "while exporting it just over-writes existing file". Nobody CHOSE
  // the default destination, so a second export silently destroying the first deliverable is
  // data loss. other NLEs' `uniqueExportURL` de-dupes exactly here (" 2", " 3", ΓÇª) and AME
  // appends a numeric suffix rather than clobbering.
  it("a second default export never clobbers the first deliverable", async () => {
    const paths: string[] = [];
    const { ctx, fs } = await renderCtx((p) => {
      paths.push(p);
      return { code: 0, stderr: "" };
    });
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }] },
      ctx,
    );

    const first = (await exportTimelineTool({}, ctx)) as Any;
    // Distinguishable bytes, so "still there" cannot be satisfied by a fresh render.
    await fs.writeTextFile("C:/Users/test/Downloads/proj.mp4", "FIRST DELIVERABLE");
    const second = (await exportTimelineTool({}, ctx)) as Any;
    const third = (await exportTimelineTool({}, ctx)) as Any;

    expect([first.saved_to, second.saved_to, third.saved_to]).toEqual([
      "proj.mp4",
      "proj 2.mp4",
      "proj 3.mp4",
    ]);
    // The OUTCOME, not the name: ffmpeg was pointed elsewhere and the first file's own
    // bytes survived both later exports.
    expect(await fs.readTextFile("C:/Users/test/Downloads/proj.mp4")).toBe("FIRST DELIVERABLE");
    expect(paths).toEqual([
      "C:/Users/test/Downloads/proj.mp4",
      "C:/Users/test/Downloads/proj 2.mp4",
      "C:/Users/test/Downloads/proj 3.mp4",
    ]);
  });

  // The failure direction: de-duping everything would break the Save As flow, where the OS
  // dialog has already asked "replace?" and the user said yes. Writing "cut 2.mp4" next to
  // the file they picked would be its own bug.
  it("...but a chosen output_path still overwrites, because the dialog already asked", async () => {
    const { ctx, fs } = await renderCtx(() => ({ code: 0, stderr: "" }));
    await fs.writeTextFile("D:/Videos/keep.txt", "x");
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }] },
      ctx,
    );
    await fs.writeTextFile("D:/Videos/cut.mp4", "OLD");
    const r = (await exportTimelineTool({ output_path: "D:/Videos/cut.mp4" }, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(r.saved_to).toBe("cut.mp4"); // not "cut 2.mp4"
    expect(await fs.readTextFile("D:/Videos/cut.mp4")).toBe("video");
    expect(await fs.exists("D:/Videos/cut 2.mp4")).toBe(false);
  });

  it("refuses a destination it cannot honour rather than writing somewhere else", async () => {
    const { ctx, fs } = await renderCtx(() => ({ code: 0, stderr: "" }));
    await fs.writeTextFile("D:/Videos/keep.txt", "x");
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }] },
      ctx,
    );
    const refuse = async (output_path: string) => {
      const r = (await exportTimelineTool({ output_path }, ctx)) as Any;
      expect(r.ok).toBe(false);
      return String(r.error);
    };
    // Relative: joinPath does not resolve it, so "wherever the process happens to be".
    expect(await refuse("videos/out.mp4")).toContain("absolute");
    expect(await refuse("../out.mp4")).toContain("absolute");
    // Wrong extension is REFUSED, not silently honoured: mp4 bytes in a .mov still play,
    // so a caller who asked for ProRes would never notice they got H.264.
    expect(await refuse("D:/Videos/out.mov")).toContain(".mp4");
    expect(await refuse("D:/Videos/out.webm")).toContain(".mp4");
    // NOTE: "the path is a folder" is NOT covered here on purpose. MemFs has neither `stat`
    // nor `readDir`, so ProjectStoreAccess.isDirectory is hard-false against it ΓÇö this
    // fixture cannot represent a directory, and a passing assertion would only be proving
    // that. It is exercised below against a store that can actually answer the question.
  });

  it("refuses a folder as the destination, and accepts a file inside that same folder", async () => {
    // Both directions against a store that can genuinely tell a directory from a file
    // (Tauri's fs has `stat`; MemFs has nothing, which is why the fixture is local).
    const dirs = new Set(["D:/Videos"]);
    const store = {
      projectDir: "C:/proj",
      exportPath: async (f: string) => `C:/Users/test/Downloads/${f}`,
      isDirectory: async (p: string) => dirs.has(p.replace(/\\/g, "/").replace(/\/+$/, "")),
      exists: async () => false,
    };
    const folder = await exportDestination(store, { outputPath: "D:/Videos" });
    expect(folder.ok).toBe(false);
    expect(folder.ok === false && folder.error).toContain("folder");
    // The failure direction: the guard must not swallow the ordinary case it sits in front of.
    const file = await exportDestination(store, { outputPath: "D:/Videos/cut.mp4" });
    expect(file.ok && file.path).toBe("D:/Videos/cut.mp4");
    expect(file.ok && file.defaulted).toBe(false);
  });

  it("exportDestination: extension is appended, case is tolerated, roots resolve", async () => {
    const fs = new MemFs();
    await fs.writeTextFile("D:/Videos/keep.txt", "x");
    const store = new ProjectStoreAccess("C:/proj", fs);
    const at = async (outputPath: string) => {
      const d = await exportDestination(store, { outputPath });
      return d.ok ? d.path : `ERR:${d.error}`;
    };
    // No extension -> .mp4 appended (a bare name from the save dialog still works).
    expect(await at("D:/Videos/final")).toBe("D:/Videos/final.mp4");
    // A dot in a DIRECTORY is not an extension.
    expect(await at("D:/My.Videos/final")).toBe("D:/My.Videos/final.mp4");
    // Case is a spelling, not a different format.
    expect(await at("D:/Videos/final.MP4")).toBe("D:/Videos/final.MP4");
    // Backslashes (what the Windows save dialog returns) and UNC shares.
    expect(await at("D:\\Videos\\final.mp4")).toBe("D:/Videos/final.mp4");
    expect(await at("\\\\nas\\share\\final.mp4")).toContain("final.mp4");
    // Drive root: "C:" alone is the process's cwd on that drive, not the root.
    expect(await at("C:\\final.mp4")).toBe("C:/final.mp4");
    // POSIX root.
    expect(await at("/final.mp4")).toBe("/final.mp4");
  });

  it("a chosen destination bypasses the NAME sanitizer, and that is safe", async () => {
    // `name` is model-supplied text joined onto Downloads, so it is reduced to a bare
    // basename (traversal test above). `output_path` is a whole path the user picked, so
    // it must NOT be reduced ΓÇö but it also must not become a second traversal door: the
    // absolute-path rule is what closes it, and `name` is ignored entirely once set.
    const fs = new MemFs();
    await fs.writeTextFile("D:/Videos/keep.txt", "x");
    const store = new ProjectStoreAccess("C:/proj", fs);
    const d = await exportDestination(store, {
      name: "../../../../evil",
      outputPath: "D:/Videos/mine.mp4",
    });
    expect(d.ok && d.path).toBe("D:/Videos/mine.mp4"); // the name has no influence at all
    // A relative traversal offered AS the path is refused outright.
    const bad = await exportDestination(store, { outputPath: "../../../../Users/evil/x.mp4" });
    expect(bad.ok).toBe(false);
  });

  it("succeeds when the fs REFUSES to confirm the output, fails the JOB when it denies it", async () => {
    // Tauri's fs scope is $DATA/ArtDaddy + $DOWNLOAD + $HOME/**. A Save As destination on
    // another drive or a network share is outside it, and `exists` THROWS rather than
    // returning false. ffmpeg is a sidecar and writes there fine, so a thrown check is
    // "can't tell", not "missing" ΓÇö reading it as missing reported "ffmpeg render failed"
    // for a video sitting exactly where the user asked for it.
    const scoped = async (onOut: () => Promise<boolean>) => {
      __resetJobNotes();
      __resetExportQueue();
      const { ctx, fs } = await renderCtx(() => ({ code: 0, stderr: "" }));
      await addClipsTool(
        { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }] },
        ctx,
      );
      // Only the OUT-OF-SCOPE path is refused, exactly as Tauri behaves ΓÇö in-scope media
      // resolution keeps working. A blanket stub would break source resolution instead and
      // prove nothing about the check under test.
      const real = fs.exists.bind(fs);
      fs.exists = (p: string) => (p.startsWith("D:/") ? onOut() : real(p));
      // `origin` is what marks this as the AGENT exporting; without it the queue (rightly)
      // withholds the wake and there is no job note to read the verdict from.
      const r = (await exportTimelineTool(
        { output_path: "D:/Client Work/cut.mp4" },
        { ...ctx, origin: { chatSessionId: "t1", branchId: 0, executionId: 1 } },
      )) as Any;
      // The encode now happens after the turn, so the verdict is on the JOB, not the call.
      await whenExportsSettle();
      const notes = pendingJobNotes(ctx.store.projectDir);
      return { r, job: notes[notes.length - 1] as Any };
    };
    // Refusal (throw) -> trust ffmpeg's exit code.
    const refused = await scoped(() => Promise.reject(new Error("path not allowed on the scope")));
    expect(refused.r.ok).toBe(true);
    expect(refused.job.status).toBe("done");
    // The failure direction the tolerance must NOT swallow: an answerable "no" still fails.
    // Without this, ffmpeg exiting 0 having written nothing would report a phantom success.
    const denied = await scoped(() => Promise.resolve(false));
    expect(denied.job.status).toBe("failed");
    expect(String(denied.job.error)).toContain("render failed");
  });

  it("keeps the .mp4 extension on the staging file ffmpeg writes", async () => {
    // ffmpeg picks its CONTAINER from the output extension. Staging to `<name>.part-a1b2c3`
    // made every real export die with "Unable to find a suitable output format" ΓÇö invisible
    // to a mocked runner, so this asserts the actual argument. MemFs has no rename, and
    // without one the export writes straight to the destination and never stages at all.
    const mem = new MemFs();
    const fs: FsLike = {
      exists: (p) => mem.exists(p),
      readTextFile: (p) => mem.readTextFile(p),
      writeTextFile: (p, c) => mem.writeTextFile(p, c),
      mkdir: () => mem.mkdir(),
      downloadDir: () => mem.downloadDir(),
      rename: async (from: string, to: string) => {
        mem.files.set(joinPath(to), await mem.readTextFile(from));
        mem.files.delete(joinPath(from));
      },
    };
    const store = new ProjectStoreAccess("C:/proj", fs);
    registerTestDocument("C:/proj");
    await ensureTimeline(store);
    let out = "";
    const ctx: ClientToolContext = {
      store,
      runner: {
        run: async (program: string, args: string[]) => {
          if (program === "ffmpeg") {
            out = args[args.length - 1];
            await fs.writeTextFile(out, "video");
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    };
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }] },
      ctx,
    );
    await exportTimelineTool({ name: "deliverable" }, ctx);
    await whenExportsSettle();

    expect(out).toContain(".part-"); // it really staged, or the extension rule is untested
    expect(out).toMatch(/\.mp4$/);
    // And the finished file is at the destination, under its real name.
    expect(await fs.exists("C:/Users/test/Downloads/deliverable.mp4")).toBe(true);
  });

  it("sanitizes a traversal export name so ffmpeg cannot write outside Downloads", async () => {
    let outPath = "";
    const { ctx } = await renderCtx((p) => {
      outPath = p;
      return { code: 0, stderr: "" };
    });
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }] },
      ctx,
    );
    const r = (await exportTimelineTool({ name: "../../../../Users/evil/pwned" }, ctx)) as Any;
    expect(r.ok).toBe(true);
    // The render output stays INSIDE the Downloads dir ΓÇö no `..`, no separators
    // carried over from the name ΓÇö so the would-be arbitrary write is neutralized.
    expect(outPath.startsWith("C:/Users/test/Downloads/")).toBe(true);
    expect(outPath).not.toContain("..");
    expect(outPath.slice("C:/Users/test/Downloads/".length)).not.toContain("/");
    expect(String(r.saved_to)).toBe("pwned.mp4"); // model sees a bare filename
  });

  it("exportStem reduces any path / traversal name to a safe basename", () => {
    expect(exportStem("../../evil", "fb")).toBe("evil");
    expect(exportStem("..\\..\\evil.mp4", "fb")).toBe("evil");
    expect(exportStem("/etc/cron.d/evil", "fb")).toBe("evil");
    expect(exportStem("C:/Windows/System32/x", "fb")).toBe("x");
    expect(exportStem("..", "fb")).toBe("fb"); // pure traversal -> fallback
    expect(exportStem("", "fb")).toBe("fb");
    expect(exportStem("My Cool Cut.mp4", "fb")).toBe("My Cool Cut");
    expect(exportStem("my.video.final", "fb")).toBe("my.video"); // strips only the trailing ext
  });

  // Media linked in place can be moved or deleted between import and export. Premiere renders red
  // "Media Offline" frames; a deliverable with silent holes in it is worse than being told, so the
  // export has to refuse and NAME what is gone.
  //
  // Every catalog row is PLACED on the timeline unless `placeIds` narrows it: the check is scoped
  // to what the render needs, so a fixture whose clips reference nothing in the catalog would
  // prove the opposite of what it claims.
  async function withCatalog(clips: Record<string, unknown>[], placeIds?: string[]) {
    let spawned = false;
    const { ctx, fs } = await renderCtx(() => {
      spawned = true;
      return { code: 0, stderr: "" };
    });
    await fs.writeTextFile("C:/proj/internals/library.json", JSON.stringify({ version: 1, clips }));
    const refs = placeIds ?? clips.map((c) => String(c.id));
    await addClipsTool(
      {
        entries: refs.map((media_ref, i) => ({
          media_ref,
          timeline_in: i * 60,
          timeline_out: i * 60 + 60,
        })),
      },
      ctx,
    );
    return { ctx, fs, spawned: () => spawned };
  }

  it("refuses to export when a linked source is gone, naming every missing file", async () => {
    const { ctx, spawned } = await withCatalog([
      { id: "media_a", path: "D:/shoot/hero.mp4", filename: "hero.mp4", external: true },
      { id: "media_b", path: "D:/shoot/broll.mp4", filename: "broll.mp4", external: true },
    ]);
    const r = (await exportTimelineTool({}, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("hero.mp4");
    expect(String(r.error)).toContain("broll.mp4");
    expect(String(r.error)).not.toContain("D:/shoot"); // absolute paths stay internal
    expect(spawned()).toBe(false); // nothing to gain from a render that cannot be right
  });

  it("exports normally when the linked source is present", async () => {
    // The other direction: the guard must not block a project whose links are healthy.
    const { ctx, fs } = await withCatalog([
      { id: "media_a", path: "D:/shoot/hero.mp4", filename: "hero.mp4", external: true },
    ]);
    await fs.writeTextFile("D:/shoot/hero.mp4", "video");
    expect(((await exportTimelineTool({}, ctx)) as Any).ok).toBe(true);
  });

  it("never calls media inside the project offline", async () => {
    // A copied clip cannot go offline; reporting one would send the user hunting for a file
    // that was never theirs to move, and block an export that would have worked.
    const { ctx } = await withCatalog([
      { id: "media_c", path: "library/media_c.mp4", filename: "c.mp4" },
    ]);
    expect(((await exportTimelineTool({}, ctx)) as Any).ok).toBe(true);
  });

  it("ignores an offline file NO clip uses", async () => {
    // Reported from a real session: deleting a source you have stopped using blocked every
    // export until you found and removed the library row. The check reads the LIBRARY, so an
    // orphan row spoke for a render that never needed it.
    const { ctx, fs } = await withCatalog(
      [
        { id: "media_used", path: "D:/shoot/used.mp4", filename: "used.mp4", external: true },
        { id: "media_orphan", path: "D:/shoot/gone.mp4", filename: "gone.mp4", external: true },
      ],
      ["media_used"],
    );
    await fs.writeTextFile("D:/shoot/used.mp4", "video");
    const r = (await exportTimelineTool({}, ctx)) as Any;
    expect(r.ok).toBe(true);
  });

  it("still refuses when the offline file IS the one a clip uses", async () => {
    // The failure direction. Scoping the check must not turn it off.
    const { ctx } = await withCatalog([
      { id: "media_used", path: "D:/shoot/used.mp4", filename: "used.mp4", external: true },
    ]);
    const r = (await exportTimelineTool({}, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("used.mp4");
  });
});

describe("assertSourcesResolved ΓÇö a plan cannot be built from library refs", () => {
  const oneClip = (mediaRef: string) => ({
    units: "frames",
    canvas: { width: 200, height: 100, fps: 30 },
    tracks: [
      {
        id: "v1",
        kind: "video",
        z: 0,
        clips: [
          {
            id: "c1",
            kind: "video",
            media_ref: mediaRef,
            source_in: 0,
            source_out: 30,
            timeline_in: 0,
            timeline_out: 30,
          },
        ],
      },
    ],
    failures: [],
  });

  // The shape the timeline actually stores. inspect_color handed exactly this to ffmpeg, which
  // answered "No such file or directory" ΓÇö indistinguishable from missing media, so the failure
  // read as broken media for every user instead of a skipped step.
  it.each(["media_97a96bef9baa", "library/media_97a96bef9baa.mp4"])(
    "throws on an unresolved source (%s)",
    (ref) => {
      expect(() => buildRenderCommand(oneClip(ref) as Any, "/o.mp4")).toThrow(/unresolved source/i);
    },
  );

  it("builds normally once the source is a real path", () => {
    // The other direction: the guard must not fire on the resolved form every working path uses.
    const plan = buildRenderCommand(oneClip("D:/shoot/a.mp4") as Any, "/o.mp4");
    expect(plan.args.join(" ")).toContain("D:/shoot/a.mp4");
  });
});
