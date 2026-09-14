// Falsifiability net for the STUDIO eval graders — runs without the model.
//
// WHY THIS EXISTS: a Tier-1 grader that cannot fail makes the expensive eval lane
// green for free. Every grader below is therefore shown to REJECT a plausible wrong
// outcome, not just accept a right one. The wrong outcomes are the real ones a model
// produces: called the tool but never used the result, placed audio on a video track,
// answered a question by editing, invented a value instead of reading the reply.
//
// It also carries the SURFACE COVERAGE guard: every tool the server advertises must
// be executable in the eval (real timeline tool or deterministic stub). Without it, a
// newly shipped tool is silently unreachable and every scenario touching it would
// score as "the model reached beyond the harness" rather than as a gap.
import { describe, expect, it } from "vitest";

import { registerTimelineTools } from "../timeline/ops";
import type { ClientToolContext } from "../tools/context";
import { ClientToolRegistry } from "../tools/registry";
import { setProjectSettingsTool } from "../tools/project";
import { toolNames } from "../contract/views";
import { WITHDRAWN_TOOLS } from "../contract/withdrawn";
import type { Timeline } from "../timeline/model";
import { emptyStudioState, registerStudioStubs, STUDIO_BBOX, studioRefIsAudio } from "./studio";
import {
  STUDIO_DOWNLOAD_REF,
  STUDIO_IMAGE_REF,
  STUDIO_MUSIC_REF,
  STUDIO_SCREENSHOT_REF,
  STUDIO_VOICEOVER_REF,
} from "./studio";
import { STUDIO_SCENARIOS } from "./scenarios/studio";
import { aclip, atrack, timeline, ttrack, vclip, vtrack } from "./scenarios/helpers";
import type { Scenario, ToolCall, Trace } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const byId = (id: string): Scenario => {
  const s = STUDIO_SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`studio scenario ${id} not found`);
  return s;
};

const trace = (calls: Partial<ToolCall>[]): Trace => ({
  toolCalls: calls.map((c, i) => ({
    round: i,
    name: c.name ?? "?",
    args: c.args ?? {},
    ok: c.ok ?? true,
    result: c.result,
    error: c.error,
  })),
  reasoning: [],
  rounds: 1,
  finalText: "done",
  usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 },
});

// ── Tier-1 geometry graders: accept the right outcome, reject a real wrong one ──

const cases: Array<{ id: string; good: Timeline; bad: Timeline; why: string }> = [
  {
    id: "add_track_for_overlay",
    why: "one track is not room for an overlay",
    good: timeline([
      vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300)]),
      vtrack("v2", 1, []),
    ]) as Timeline,
    bad: timeline([vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300)])]) as Timeline,
  },
  {
    id: "add_track_for_overlay",
    why: "a track added BELOW the footage would render under the overlay",
    good: timeline([
      vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300)]),
      vtrack("v2", 1, []),
    ]) as Timeline,
    bad: timeline([
      vtrack("v1", 5, [vclip("a", "a.mp4", 0, 300)]),
      vtrack("v2", 1, []),
    ]) as Timeline,
  },
  {
    id: "redo_after_undo",
    why: "the undo was never re-applied",
    good: timeline([vtrack("v1", 0, [vclip("a", "a.mp4", 0, 120)])]) as Timeline,
    bad: timeline([vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300)])]) as Timeline,
  },
  {
    id: "find_moment_and_trim",
    why: "kept the whole clip — the search result was ignored",
    good: timeline([vtrack("v1", 0, [vclip("a", "a.mp4", 0, 60)])]) as Timeline,
    bad: timeline([vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300)])]) as Timeline,
  },
  {
    id: "download_and_place",
    why: "downloaded but never placed",
    good: timeline([
      vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300), vclip("d", STUDIO_DOWNLOAD_REF, 300, 660)]),
    ]) as Timeline,
    bad: timeline([vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300)])]) as Timeline,
  },
  {
    id: "download_and_place",
    why: "placed at the front when asked for the end",
    good: timeline([
      vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300), vclip("d", STUDIO_DOWNLOAD_REF, 300, 660)]),
    ]) as Timeline,
    bad: timeline([
      vtrack("v1", 0, [vclip("d", STUDIO_DOWNLOAD_REF, 0, 360), vclip("a", "a.mp4", 360, 660)]),
    ]) as Timeline,
  },
  {
    id: "generate_image_and_place",
    why: "generated but never placed",
    good: timeline([
      vtrack("v1", 0, [
        vclip("t", STUDIO_IMAGE_REF, 0, 90, { kind: "image" }),
        vclip("a", "a.mp4", 90, 390),
      ]),
    ]) as Timeline,
    bad: timeline([vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300)])]) as Timeline,
  },
  {
    id: "generate_image_and_place",
    why: "placed at the back when asked for the front",
    good: timeline([
      vtrack("v1", 0, [
        vclip("t", STUDIO_IMAGE_REF, 0, 90, { kind: "image" }),
        vclip("a", "a.mp4", 90, 390),
      ]),
    ]) as Timeline,
    bad: timeline([
      vtrack("v1", 0, [
        vclip("a", "a.mp4", 0, 300),
        vclip("t", STUDIO_IMAGE_REF, 300, 390, { kind: "image" }),
      ]),
    ]) as Timeline,
  },
  {
    id: "generate_voiceover_and_place",
    why: "the voiceover landed on a VIDEO track — it would never be heard as audio",
    good: timeline([
      vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300)]),
      atrack("a1", 0, [aclip("vo", STUDIO_VOICEOVER_REF, 0, 120)]),
    ]) as Timeline,
    bad: timeline([
      vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300), vclip("vo", STUDIO_VOICEOVER_REF, 0, 120)]),
    ]) as Timeline,
  },
  {
    id: "generate_music_bed",
    why: "music on a video track",
    good: timeline([
      vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300)]),
      atrack("a1", 0, [aclip("bed", STUDIO_MUSIC_REF, 0, 300)]),
    ]) as Timeline,
    bad: timeline([
      vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300), vclip("bed", STUDIO_MUSIC_REF, 0, 300)]),
    ]) as Timeline,
  },
  {
    id: "research_then_caption",
    why: "captioned something it did not read off the page",
    good: timeline([
      vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300)]),
      ttrack("t", 1, [
        {
          id: "c",
          kind: "text",
          timeline_in: 0,
          timeline_out: 60,
          text: "Launch 09:40 UTC",
        } as Any,
      ]),
    ]) as Timeline,
    bad: timeline([
      vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300)]),
      ttrack("t", 1, [
        { id: "c", kind: "text", timeline_in: 0, timeline_out: 60, text: "Launching soon" } as Any,
      ]),
    ]) as Timeline,
  },
  {
    id: "screenshot_page_and_place",
    why: "held the screenshot for ten seconds instead of two",
    good: timeline([
      vtrack("v1", 0, [vclip("s", STUDIO_SCREENSHOT_REF, 0, 60, { kind: "image" })]),
    ]) as Timeline,
    bad: timeline([
      vtrack("v1", 0, [vclip("s", STUDIO_SCREENSHOT_REF, 0, 300, { kind: "image" })]),
    ]) as Timeline,
  },
  {
    id: "no_ffmpeg_for_speed",
    why: "the retime never happened",
    good: timeline([
      vtrack("v1", 0, [vclip("a", "a.mp4", 0, 150, { speed: 2 } as Any)]),
      atrack("a1", 0, [aclip("m", "music.mp3", 0, 300, { volume: 0.33 } as Any)]),
    ]) as Timeline,
    bad: timeline([
      vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300)]),
      atrack("a1", 0, [aclip("m", "music.mp3", 0, 300, { volume: 0.33 } as Any)]),
    ]) as Timeline,
  },
  {
    id: "no_ffmpeg_for_speed",
    why: "the music was never ducked",
    good: timeline([
      vtrack("v1", 0, [vclip("a", "a.mp4", 0, 150, { speed: 2 } as Any)]),
      atrack("a1", 0, [aclip("m", "music.mp3", 0, 300, { volume: 0.33 } as Any)]),
    ]) as Timeline,
    bad: timeline([
      vtrack("v1", 0, [vclip("a", "a.mp4", 0, 150, { speed: 2 } as Any)]),
      atrack("a1", 0, [aclip("m", "music.mp3", 0, 300)]),
    ]) as Timeline,
  },
  {
    id: "inspect_color_then_warm",
    why: "measured the shot and then did nothing",
    good: timeline([
      vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300, { color: { temperature: 0.2 } } as Any)]),
    ]) as Timeline,
    bad: timeline([vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300)])]) as Timeline,
  },
  {
    id: "library_place_from_catalog",
    why: "listed the library but never placed the ocean shot",
    good: timeline([
      vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300), vclip("o", "media_broll_ocean", 300, 500)]),
    ]) as Timeline,
    bad: timeline([vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300)])]) as Timeline,
  },
];

describe("studio Tier-1 graders reject the wrong outcome", () => {
  for (const { id, good, bad, why } of cases) {
    it(`${id}: rejects — ${why}`, () => {
      const s = byId(id);
      expect(s.expect, `${id} must carry a Tier-1 grader`).toBeTypeOf("function");
      expect(() => s.expect!(good)).not.toThrow();
      expect(() => s.expect!(bad)).toThrow();
    });
  }
});

// ── read-only graders: the timeline must come back untouched ─────────────────

describe("read-only studio scenarios reject an edit", () => {
  const readOnly = STUDIO_SCENARIOS.filter((s) => (s.tags ?? []).includes("read-only"));

  it("there are read-only scenarios to check", () => {
    expect(readOnly.length).toBeGreaterThan(0);
  });

  for (const s of readOnly) {
    it(`${s.id}: passes on the untouched seed, throws when a clip moved`, () => {
      expect(s.expect, `${s.id} must assert the timeline is untouched`).toBeTypeOf("function");
      const seed = s.seed();
      expect(() => s.expect!(seed)).not.toThrow();

      const edited = JSON.parse(JSON.stringify(seed)) as Timeline;
      const firstTrack = (edited.tracks ?? [])[0] as Any;
      if (firstTrack?.clips?.[0]) firstTrack.clips[0].timeline_out += 30;
      else (edited.tracks as Any[]).push({ id: "extra", kind: "video", z: 9, clips: [] });
      expect(() => s.expect!(edited)).toThrow();
    });
  }
});

// ── trace graders: the chain, not the call ──────────────────────────────────

describe("studio trace graders reject a broken chain", () => {
  it("find_content_then_crop: rejects a crop that invented its own bbox", () => {
    const s = byId("find_content_then_crop");
    const good = trace([
      { name: "find_content", args: { media_ref: "logo.png" } },
      { name: "crop_image", args: { media_ref: "logo.png", bbox: { ...STUDIO_BBOX } } },
    ]);
    const invented = trace([
      { name: "find_content", args: { media_ref: "logo.png" } },
      { name: "crop_image", args: { media_ref: "logo.png", bbox: { x: 0, y: 0, w: 500, h: 500 } } },
    ]);
    const neverCropped = trace([{ name: "find_content", args: {} }]);
    expect(() => s.expectTrace!(good)).not.toThrow();
    expect(() => s.expectTrace!(invented)).toThrow();
    expect(() => s.expectTrace!(neverCropped)).toThrow();
  });

  it("no_ffmpeg_for_speed: rejects a trace that shelled out to raw ffmpeg", () => {
    const s = byId("no_ffmpeg_for_speed");
    expect(() => s.expectTrace!(trace([{ name: "set_clip_properties", args: {} }]))).not.toThrow();
    expect(() =>
      s.expectTrace!(trace([{ name: "run_ffmpeg", args: { command: "-i a.mp4 -vf setpts…" } }])),
    ).toThrow();
  });

  it("metadata_before_download: rejects downloading when only asked how long it is", () => {
    const s = byId("metadata_before_download");
    expect(() => s.expectTrace!(trace([{ name: "video_get_metadata", args: {} }]))).not.toThrow();
    expect(() =>
      s.expectTrace!(
        trace([
          { name: "video_get_metadata", args: {} },
          { name: "download_video", args: {} },
        ]),
      ),
    ).toThrow();
  });

  it("list_models_before_generating: rejects burning a generation call to answer a question", () => {
    const s = byId("list_models_before_generating");
    expect(() => s.expectTrace!(trace([{ name: "list_models", args: {} }]))).not.toThrow();
    expect(() =>
      s.expectTrace!(
        trace([
          { name: "list_models", args: {} },
          { name: "generate_video", args: {} },
        ]),
      ),
    ).toThrow();
  });

  it("inspect_timeline_check: rejects inspecting a frame the prompt didn't ask for", () => {
    const s = byId("inspect_timeline_check");
    expect(() =>
      s.expectTrace!(trace([{ name: "inspect_timeline", args: { frames: [60] } }])),
    ).not.toThrow();
    // 2 seconds at 30fps is frame 60; frame 2 is the model doing no fps math at all.
    expect(() =>
      s.expectTrace!(trace([{ name: "inspect_timeline", args: { frames: [2] } }])),
    ).toThrow();
  });

  it("search_then_fetch: rejects downloading a result other than the one asked for", () => {
    const s = byId("search_then_fetch");
    expect(() =>
      s.expectTrace!(
        trace([
          { name: "youtube_search", args: { query: "rocket launch" } },
          { name: "download_video", args: { url: "https://example.com/launch" } },
        ]),
      ),
    ).not.toThrow();
    expect(() =>
      s.expectTrace!(
        trace([
          { name: "youtube_search", args: { query: "rocket launch" } },
          { name: "download_video", args: { url: "https://example.com/launch-short" } },
        ]),
      ),
    ).toThrow();
  });

  it("project_rename: rejects renaming to something else", () => {
    const s = byId("project_rename");
    expect(() =>
      s.expectTrace!(trace([{ name: "rename_project", args: { name: "Summer Reel" } }])),
    ).not.toThrow();
    expect(() =>
      s.expectTrace!(trace([{ name: "rename_project", args: { name: "Untitled" } }])),
    ).toThrow();
  });

  it("project_state_question: rejects turning a settings question into a settings change", () => {
    const s = byId("project_state_question");
    expect(() => s.expectTrace!(trace([{ name: "get_project_state", args: {} }]))).not.toThrow();
    expect(() =>
      s.expectTrace!(
        trace([
          { name: "get_project_state", args: {} },
          { name: "set_project_settings", args: {} },
        ]),
      ),
    ).toThrow();
  });

  it("library_tag_broll: rejects listing without ever tagging", () => {
    const s = byId("library_tag_broll");
    expect(() =>
      s.expectTrace!(
        trace([
          { name: "library_op", args: { action: "list" } },
          { name: "library_op", args: { action: "update", tags: ["broll"] } },
        ]),
      ),
    ).not.toThrow();
    expect(() =>
      s.expectTrace!(trace([{ name: "library_op", args: { action: "list" } }])),
    ).toThrow();
  });
});

// ── surface coverage: the drift guard ───────────────────────────────────────

describe("studio surface covers the whole advertised contract", () => {
  const registry = new ClientToolRegistry();
  registerTimelineTools(registry, () => null as unknown as ClientToolContext);
  registry.register("set_project_settings", (args) =>
    setProjectSettingsTool(args, null as unknown as ClientToolContext),
  );
  registerStudioStubs(registry, emptyStudioState());
  const executable = new Set(registry.names());

  it("every tool the server advertises is executable in the eval (real or stubbed)", () => {
    const missing = toolNames().filter((n) => !executable.has(n));
    expect(
      missing,
      "add a deterministic stub in src/eval/studio.ts for each of these, or the eval " +
        "silently cannot reach them",
    ).toEqual([]);
  });

  it("no stub exists for a tool that is neither advertised nor withdrawn", () => {
    const known = new Set([...toolNames(), ...WITHDRAWN_TOOLS]);
    expect([...executable].filter((n) => !known.has(n))).toEqual([]);
  });
});

// ── the harness's audio/video routing fact ──────────────────────────────────

describe("studioRefIsAudio keeps generated audio off video tracks", () => {
  it("classifies the generated audio refs as audio", () => {
    expect(studioRefIsAudio(STUDIO_VOICEOVER_REF)).toBe(true);
    expect(studioRefIsAudio(STUDIO_MUSIC_REF)).toBe(true);
    expect(studioRefIsAudio("library/gen_music_1.mp3")).toBe(true);
    expect(studioRefIsAudio("library/gen_voiceover_1.wav")).toBe(true);
  });

  it("does not misclassify video/image refs (which would break every placement)", () => {
    expect(studioRefIsAudio(STUDIO_IMAGE_REF)).toBe(false);
    expect(studioRefIsAudio(STUDIO_DOWNLOAD_REF)).toBe(false);
    expect(studioRefIsAudio("a.mp4")).toBe(false);
    expect(studioRefIsAudio("")).toBe(false);
  });
});

// ── every studio scenario is wired to the studio surface ────────────────────

describe("studio scenario wiring", () => {
  it("scenarios that need a stubbed tool declare the studio surface", () => {
    const wrong = STUDIO_SCENARIOS.filter(
      (s) => (s.tags ?? []).includes("studio") && s.surface !== "studio",
    ).map((s) => s.id);
    expect(wrong).toEqual([]);
  });

  it("every scenario carries at least one grader (no free passes)", () => {
    const ungraded = STUDIO_SCENARIOS.filter((s) => !s.expect && !s.expectTrace).map((s) => s.id);
    expect(ungraded).toEqual([]);
  });
});
