import { describe, expect, it } from "vitest";

import { paramsByTool } from "./views";

// Names-only DRIFT CANARY — defense-in-depth for the authoritative server guard
// (ArtDaddy/tests/unit/test_time_units_contract.py, which checks descriptions +
// forces every time param to be classified frames|seconds). This pins the
// TOP-LEVEL time-looking params in the bundled contract snapshot; when a new one
// appears (after `npm run codegen`), this fails — a prompt to classify its unit
// server-side (clip_id / timeline position = FRAMES, source media = SECONDS) and
// update the list below. (Nested params like source_span live inside `entries`,
// so they're covered only by the server guard's full walk.)
const TIMEY =
  /frame|duration|_span|fade|second|_s$|_in$|_out$|^at$|^t$|ranges|start|end|timeline|when/i;

const KNOWN_TOP_LEVEL_TIME_PARAMS: string[] = [
  // SECONDS: a caption hold is a duration of real silence, not a timeline position — the
  // tool converts it with the canvas fps so the model never does frame maths.
  "add_captions.max_gap_seconds",
  "clip_video.end_s",
  "clip_video.start_s",
  "download_video.end_s",
  "download_video.start_s",
  "generate_video.duration",
  "generate_video.end_frame",
  "generate_video.start_frame",
  "get_timeline.end_frame",
  "get_timeline.start_frame",
  "get_transcript.end_frame",
  "get_transcript.start_frame",
  "insert_clips.at",
  "inspect_color.at_frame",
  "inspect_media.end_seconds",
  "inspect_media.max_frames",
  "inspect_media.start_seconds",
  "inspect_timeline.end_frame",
  "inspect_timeline.max_frames",
  "inspect_timeline.start_frame",
  "ripple_delete.end",
  "ripple_delete.ranges",
  "ripple_delete.start",
  "set_clip_properties.blend",
  "set_clip_properties.duration",
  "set_clip_properties.fade",
  // PROJECT FRAMES: the source window of a PLACED clip (it already has a timeline
  // position, so it stays in the frame domain). Folded in from trim_clips in 1.7.0.
  "set_clip_properties.source_in",
  "set_clip_properties.source_out",
  "set_keyframes.keyframes",
  "set_transition.transition_in",
  "video_ask.end_seconds",
  "video_ask.start_seconds",
];

describe("time-units drift canary (bundled contract)", () => {
  it("the top-level time-looking params are the known, classified set", () => {
    const tools = paramsByTool();
    const found = Object.entries(tools)
      .flatMap(([tool, e]) => e.params.filter((p) => TIMEY.test(p)).map((p) => `${tool}.${p}`))
      .sort();
    // If this fails: a time param entered/left the contract. Classify its unit in
    // the server guard (ArtDaddy/tests/unit/test_time_units_contract.py), then update
    // KNOWN_TOP_LEVEL_TIME_PARAMS.
    expect(found).toEqual([...KNOWN_TOP_LEVEL_TIME_PARAMS].sort());
  });
});
