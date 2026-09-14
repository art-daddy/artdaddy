// Regression scenarios — grounded in the REAL recorded t001–t009 sessions (mined
// offline via `npm run mine`). The top recurring bugs were: ripple_delete rejecting
// a call that carried BOTH track_id + clip_id (t005/t008/t009), set_clip_properties
// validation-rejection thrash while retiming (t008/t009 — t009 retried it ×13), and
// the sync-lock / linked-A/V invariants. These reproduce those in the timeline-only
// harness; the friction signals catch the rejections even when the task still passes.
import { clipMagnification, MAX_MAGNIFICATION } from "../../timeline/magnification";
import type { Clip } from "../../timeline/model";
import type { Scenario } from "../types";
import {
  aclip,
  assert,
  atrack,
  clipById,
  clipsOf,
  contiguousFrom,
  near,
  span,
  timeline,
  vclip,
  vtrack,
} from "./helpers";

/** The synclock seed: main track + a sync-locked overlay + linked audio + music bed. */
function synclockSeed() {
  return timeline([
    vtrack("v1", 2, [vclip("logo", "logo.png", 120, 180, { source_out: 60 })]),
    vtrack("v2", 1, [
      vclip("intro", "intro.mp4", 0, 60),
      vclip("middle", "middle.mp4", 60, 120),
      vclip("outro", "outro.mp4", 120, 180, { link_group: "lg_outro" }),
    ]),
    atrack("a2", 1, [aclip("outroAud", "outro.mp4", 120, 180, { link_group: "lg_outro" })]),
    atrack("a3", 0, [aclip("bed", "music.mp3", 0, 180)]),
  ]);
}

export const REGRESSIONS: Scenario[] = [
  {
    id: "t006_speed_1_2x",
    title: "Increase clip speed to 1.2× (the real t006/t008/t009 task)",
    tags: ["regression:t006", "retime"],
    // The shared prompt across t006/t008/t009 was "…increase speed to 1.2x". The
    // timeline-only, media-free part is the retime — where set_clip_properties kept
    // getting validation-rejected.
    seed: () => timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 120, { source_out: 120 })])]),
    prompt: "Increase the speed of this clip to 1.2x.",
    expect: (tl) => near(Number(clipById(tl, "a")?.speed ?? 1), 1.2, 0.05, "speed"),
    expectTools: ["set_clip_properties"],
    maxRounds: 4,
  },
  {
    id: "ripple_both_ids",
    title: "Ripple-cut a specific clip (model kept passing track_id AND clip_id)",
    tags: ["regression:t008", "regression:t009", "ripple"],
    // In t005/t008/t009 the model called ripple_delete with BOTH track_id and clip_id
    // → "pass track_id OR clip_id, not both" (3 sessions). The toolErrors signal catches
    // that rejection here even if the model recovers and completes the cut.
    seed: () =>
      timeline([
        vtrack("v2", 1, [
          vclip("a", "a.mp4", 0, 60),
          vclip("b", "b.mp4", 60, 120),
          vclip("c", "c.mp4", 120, 180),
        ]),
      ]),
    prompt: "Cut the second clip out and close the gap so the third clip follows the first.",
    expect: (tl) => {
      const cs = clipsOf(tl, "v2");
      assert(cs.length === 2, `expected 2 clips, got ${cs.length}`);
      assert(!cs.some((c) => c.id === "b"), "second clip should be gone");
      assert(contiguousFrom(tl, "v2", 0, 2), "remaining clips should be gap-free");
    },
    expectTools: ["ripple_delete", "remove_clips"],
    maxRounds: 6,
  },
  {
    id: "linked_av_retime_sync",
    title: "Retiming a clip keeps its linked audio in sync",
    tags: ["link", "retime", "invariant"],
    seed: () =>
      timeline([
        vtrack("v2", 1, [vclip("shot", "shot.mp4", 0, 120, { link_group: "lg" })]),
        atrack("a2", 0, [aclip("shotAud", "shot.mp4", 0, 120, { link_group: "lg" })]),
      ]),
    prompt: "Slow this shot down to half speed.",
    expect: (tl) => {
      const v = clipById(tl, "shot");
      const a = clipById(tl, "shotAud");
      near(Number(v?.speed ?? 1), 0.5, 0.06, "video speed");
      near(Number(a?.speed ?? 1), 0.5, 0.06, "linked audio speed (desync bug)");
      near(span(v), span(a), 1, "A/V lengths stay locked");
    },
    expectTools: ["set_clip_properties"],
    maxRounds: 6,
  },
  {
    id: "synclock_ripple",
    title: "Ripple-cut keeps a sync-locked overlay + linked audio aligned",
    tags: ["sync-lock", "ripple", "invariant"],
    seed: synclockSeed,
    prompt:
      "This project has three back-to-back clips on the main video track — an intro (0–2s), a middle section (2–4s), and an outro (4–6s). The middle section doesn't work. Remove it and tighten the timeline so the outro comes right after the intro.",
    expect: (tl) => {
      const v2 = clipsOf(tl, "v2");
      assert(!v2.some((c) => c.id === "middle"), "middle removed");
      const outro = clipById(tl, "outro");
      near(Number(outro?.timeline_in), 60, 3, "outro slid up to meet intro");
      const logo = clipById(tl, "logo");
      near(Number(logo?.timeline_in), 60, 3, "sync-locked overlay followed the outro");
      const aud = clipById(tl, "outroAud");
      near(Number(aud?.timeline_in), 60, 3, "linked audio followed its video");
      const bed = clipById(tl, "bed");
      near(Number(bed?.timeline_in), 0, 1, "full-length music bed stayed put");
      near(span(bed), 180, 2, "music bed unchanged");
    },
    expectTools: ["ripple_delete", "remove_clips"],
    maxRounds: 8,
  },
  {
    id: "t009_property_thrash",
    title: "Combined property edit lands without rejected retries",
    tags: ["regression:t009", "properties"],
    // Real t009 retried set_clip_properties ×13 (validation rejections) while retiming;
    // a low ceiling surfaces any thrash as inefficiency + retryLoops signals.
    seed: () => timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 60, { source_out: 60 })])]),
    prompt: "Set this clip to 80% opacity, 1.2x speed, and give it a short fade-out.",
    expect: (tl) => {
      const c = clipById(tl, "a");
      near(Number(c?.opacity ?? 1), 0.8, 0.06, "opacity");
      near(Number(c?.speed ?? 1), 1.2, 0.06, "speed");
      assert(c?.fade?.out != null, "expected a fade-out to be set");
    },
    expectTools: ["set_clip_properties"],
    maxRounds: 4,
  },
  {
    id: "speed_2x_parity",
    title: "2× speed keeps source/timeline parity",
    tags: ["retime", "invariant"],
    seed: () => timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 60, { source_out: 60 })])]),
    prompt: "Make this clip play twice as fast.",
    // Tier 0 enforces source/timeline parity; Tier 1 just nails the speed intent.
    expect: (tl) => near(Number(clipById(tl, "a")?.speed ?? 1), 2, 0.1, "speed"),
    expectTools: ["set_clip_properties"],
    maxRounds: 5,
  },
  {
    id: "vertical_reframe_480p",
    title: "Reframe a 480p 16:9 talk to vertical without destroying the picture",
    tags: ["regression:feedback-f82a9221", "reframe"],
    // The reported session: filling a 9:16 canvas from a 16:9 480p podcast is ALREADY a 4x
    // blow-up, and the model added `scale` 3.2-3.98 on top of `fit: cover` — a 13.8x
    // magnification showing 78x139 source pixels. The user read that as "the video is static",
    // because at that size nothing in the frame visibly changes while the audio plays on.
    seed: () =>
      timeline([vtrack("v1", 0, [vclip("a", "talk_480p.mp4", 0, 900, { source_out: 900 })])]),
    prompt: "Make this fill the vertical frame so it works as a Reel.",
    // The zoom did not arrive with the reframe — it arrived as the model's ANSWER to the
    // complaint, escalating each time it was told the shot was still static. Reframing alone
    // never reproduced it, so the complaint is the scenario.
    followUps: [
      "The video is not moving, just the voice over is moving.",
      "It's still static. Fix it.",
    ],
    expect: (tl) => {
      const c = clipById(tl, "a");
      const fit = String(c?.fit ?? "contain") === "cover" ? "cover" : "contain";
      const mag = clipMagnification(c as Clip, { w: 1080, h: 1920 }, { w: 854, h: 480 }, fit);
      assert(
        mag <= MAX_MAGNIFICATION + 1e-6,
        `the picture is magnified ${mag.toFixed(1)}x (max ${MAX_MAGNIFICATION}x) — ` +
          `only ${Math.round(1080 / mag)}x${Math.round(1920 / mag)} source pixels reach the canvas`,
      );
    },
    expectTools: ["set_clip_properties"],
    maxRounds: 12,
  },
];
