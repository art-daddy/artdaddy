// Canonical editing scenarios — one per core timeline capability. Prompts are
// natural language (no tool/jargon hints); assertions check the ESSENTIAL outcome
// with tolerance, since the model has latitude over exact geometry. Frame math is
// at 30fps (1s = 30f). Grows freely — add an entry to extend coverage toward ~50.
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
  trackOf,
  vclip,
  vtrack,
} from "./helpers";
import { call, calls, READ_TIMELINE, say, timelineClipsIn } from "./steps";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- graders poke uncommon clip fields (transform/fade/duck/transition_in)
type Any = any;

/** Resolve a scalar-or-keyframed value to a number (last keyframe if animated). */
const numOf = (v: Any): number =>
  typeof v === "number" ? v : Array.isArray(v) && v.length ? Number(v[v.length - 1]?.v) : NaN;

/** A clip's centre in 0..1 canvas coords: its position, or the last keyframe of an animated one
 *  (no position is the middle of the frame). */
const posOf = (p: Any): { x: number; y: number } => {
  const at = Array.isArray(p) ? p[p.length - 1] : p;
  return { x: Number(at?.x ?? 0.5), y: Number(at?.y ?? 0.5) };
};

/** A keyframed value at clip-relative frame `f`: linear between keyframes, held beyond them. */
function valueAt(keys: Any[], f: number): number {
  const pts = [...keys].sort((p, q) => Number(p.t) - Number(q.t));
  if (pts.length === 0) return NaN;
  if (f <= Number(pts[0].t)) return Number(pts[0].v);
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    if (f > Number(b.t)) continue;
    const k = (f - Number(a.t)) / (Number(b.t) - Number(a.t) || 1);
    return Number(a.v) + k * (Number(b.v) - Number(a.v));
  }
  return Number(pts[pts.length - 1].v);
}

function textOf(c: { text?: unknown; content?: unknown }): string {
  if (typeof c.text === "string") return c.text;
  if (typeof c.content === "string") return c.content;
  if (Array.isArray(c.content))
    return c.content
      .map((x) => (x && typeof x === "object" ? String((x as { text?: unknown }).text ?? "") : ""))
      .join(" ");
  return "";
}

/** The captions carry every word the request gave them, in any clip and any case: a caption that
 *  moves right with the wrong words is not the caption asked for. */
function assertSays(texts: { text?: unknown; content?: unknown }[], phrase: string): void {
  const said = texts.map(textOf).join(" ").toLowerCase();
  const missing = phrase
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => !said.includes(w));
  assert(missing.length === 0, `the captions do not say "${phrase}" (they say "${said.trim()}")`);
}

/** read_whole_timeline's project: two clips the answer has to name. */
const readSeed = () =>
  timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 60), vclip("b", "b.mp4", 60, 120)])]);

/** A call that sets a clip's opacity to `v`: set_clip_properties' scalar, or an opacity keyframe. */
function setsOpacity(args: Record<string, unknown> | undefined, v: number): boolean {
  const near = (x: unknown) => typeof x === "number" && Math.abs(x - v) <= 0.06;
  if (!args) return false;
  if (near(args.opacity)) return true;
  return (
    args.property === "opacity" &&
    Array.isArray(args.keyframes) &&
    (args.keyframes as { v?: unknown }[]).some((k) => near(k?.v))
  );
}

export const CANONICAL: Scenario[] = [
  {
    id: "trim_to_2s",
    scope: { change: ["intro"] },
    title: "Shorten a clip to 2 seconds",
    tags: ["trim"],
    seed: () => timeline([vtrack("v2", 1, [vclip("intro", "intro.mp4", 0, 90)])]),
    prompt: "Make the intro clip 2 seconds long instead of 3.",
    expect: (tl) => near(span(clipById(tl, "intro")), 60, 2, "intro span"),
    expectTools: ["set_clip_properties"],
    maxRounds: 5,
    reference: [
      READ_TIMELINE,
      call("set_clip_properties", { clip_ids: ["intro"], duration: 60 }),
      say("The intro clip is now 2 seconds long instead of 3."),
    ],
  },
  {
    id: "split_at_1s",
    scope: { change: ["a"], add: ["video"] },
    title: "Split a clip at the 1-second mark",
    tags: ["split"],
    seed: () => timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 60)])]),
    prompt: "Split the clip into two pieces at the one-second mark.",
    expect: (tl) => {
      const cs = clipsOf(tl, "v2");
      assert(cs.length === 2, `expected 2 clips after split, got ${cs.length}`);
      near(Number(cs[0].timeline_out), 30, 2, "split boundary");
      assert(contiguousFrom(tl, "v2", 0, 2), "the two halves should abut");
    },
    expectTools: ["split_clips"],
    maxRounds: 5,
    reference: [
      READ_TIMELINE,
      call("split_clips", { splits: [{ clip_id: "a", at: 30 }] }),
      say("Split it at the one-second mark: one piece runs 0 to 1 s, the other 1 to 2 s."),
    ],
  },
  {
    id: "reorder_swap",
    scope: { change: ["a", "b"] },
    title: "Swap the order of two clips",
    tags: ["reorder"],
    seed: () =>
      timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 30), vclip("b", "b.mp4", 30, 60)])]),
    prompt: "Swap the two clips so the second one plays first.",
    expect: (tl) => {
      const cs = clipsOf(tl, "v2");
      assert(cs.length === 2, `expected 2 clips, got ${cs.length}`);
      assert(cs[0].media_ref === "b.mp4", `expected b.mp4 first, got ${cs[0].media_ref}`);
      assert(contiguousFrom(tl, "v2", 0, 2), "clips should stay contiguous");
    },
    expectTools: ["move_clips"],
    maxRounds: 6,
    reference: [
      READ_TIMELINE,
      call("move_clips", {
        moves: [
          { clip_id: "b", to_timeline_in: 0 },
          { clip_id: "a", to_timeline_in: 30 },
        ],
      }),
      say("Swapped them: b.mp4 now plays first, then a.mp4."),
    ],
  },
  {
    id: "fade_in_1s",
    scope: { change: ["a"] },
    title: "Add a 1-second fade-in",
    tags: ["fade"],
    seed: () => timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 90)])]),
    prompt: "Add a one-second fade-in to the clip.",
    // A fade-in is valid EITHER as the dedicated `fade.in` field OR as an opacity
    // keyframe ramp 0->1 over ~1s (30f). The model naturally animates opacity via
    // set_keyframes (other agent-driven editors do the same), and sampleAnim/compileAnim render
    // that as a real visual fade — so both forms pass.
    expect: (tl) => {
      const c = clipById(tl, "a");
      if (c?.fade?.in != null) {
        near(Number(c.fade.in), 30, 3, "fade.in frames");
        return;
      }
      const opa = c?.opacity;
      assert(
        Array.isArray(opa) && opa.length >= 2,
        "expected a fade-in: a fade.in field or an opacity keyframe ramp",
      );
      const pts = [...opa].sort((a, b) => Number(a.t) - Number(b.t));
      const start = pts[0];
      const full = pts.find((k) => Number(k.v) >= 0.8) ?? pts[pts.length - 1];
      assert(Number(start.v) <= 0.2, `fade-in should start near 0 opacity (got ${start.v})`);
      assert(Number(full.v) >= 0.8, `fade-in should reach full opacity (got ${full.v})`);
      near(Number(full.t) - Number(start.t), 30, 6, "fade-in ramp length");
    },
    expectTools: ["set_clip_properties", "apply_effects", "set_keyframes"],
    maxRounds: 5,
    reference: [
      READ_TIMELINE,
      call("set_clip_properties", { clip_ids: ["a"], fade: { in: 30 } }),
      say("Added a one-second fade-in at the start of the clip."),
    ],
  },
  {
    id: "opacity_50",
    scope: { change: ["logo"] },
    title: "Make a clip 50% transparent",
    tags: ["properties"],
    seed: () => timeline([vtrack("v1", 2, [vclip("logo", "logo.png", 0, 60)])]),
    prompt: "Make the logo 50% transparent.",
    expect: (tl) => {
      const c = clipById(tl, "logo");
      assert(typeof c?.opacity === "number", "expected numeric opacity");
      near(c!.opacity as number, 0.5, 0.06, "opacity");
    },
    expectTools: ["set_clip_properties"],
    maxRounds: 5,
    reference: [
      READ_TIMELINE,
      call("set_clip_properties", { clip_ids: ["logo"], opacity: 0.5 }),
      say("The logo is now 50% transparent."),
    ],
  },
  {
    id: "volume_30",
    scope: { change: ["bed"] },
    title: "Lower music volume to 30%",
    tags: ["audio", "properties"],
    seed: () => timeline([atrack("a3", 0, [aclip("bed", "music.mp3", 0, 180)])]),
    prompt: "Lower the background music to 30% volume.",
    expect: (tl) => near(Number(clipById(tl, "bed")?.volume), 0.3, 0.06, "volume"),
    expectTools: ["set_clip_properties"],
    maxRounds: 5,
    reference: [
      READ_TIMELINE,
      call("set_clip_properties", { clip_ids: ["bed"], volume: 0.3 }),
      say("The background music is at 30% volume now."),
    ],
  },
  {
    id: "crossfade_half_sec",
    scope: { change: ["a", "b"] },
    title: "Crossfade between two clips",
    tags: ["transition"],
    seed: () =>
      timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 60), vclip("b", "b.mp4", 60, 120)])]),
    prompt: "Add a half-second crossfade between the two clips.",
    expect: (tl) => {
      const withTrans = clipsOf(tl, "v2").find((c) => c.transition_in);
      assert(withTrans?.transition_in, "expected a transition_in on the second clip");
      near(Number(withTrans!.transition_in!.duration), 15, 3, "crossfade duration");
    },
    expectTools: ["set_transition"],
    maxRounds: 6,
    reference: [
      READ_TIMELINE,
      call("set_transition", { clip_id: "b", transition_in: { kind: "crossfade", duration: 15 } }),
      say("Added a half-second crossfade between the two clips."),
    ],
  },
  {
    id: "add_clip_after",
    scope: { add: ["video"] },
    title: "Append a clip",
    tags: ["placement"],
    seed: () => timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 60)])]),
    prompt: "Add a 2-second clip using outro.mp4 right after the existing clip.",
    expect: (tl) => {
      const cs = clipsOf(tl, "v2");
      assert(cs.length === 2, `expected 2 clips, got ${cs.length}`);
      const last = cs[1];
      assert(last.media_ref === "outro.mp4", `expected outro.mp4 appended, got ${last.media_ref}`);
      near(Number(last.timeline_in), 60, 2, "append start");
      near(span(last), 60, 4, "appended span");
    },
    expectTools: ["add_clips", "insert_clips"],
    maxRounds: 6,
    reference: [
      READ_TIMELINE,
      call("add_clips", {
        entries: [{ media_ref: "outro.mp4", track_id: "v2", timeline_in: 60, duration: 60 }],
      }),
      say("Added 2 seconds of outro.mp4 right after the existing clip."),
    ],
  },
  {
    id: "insert_between",
    scope: { change: ["b"], add: ["video"] },
    title: "Insert a clip between two",
    tags: ["placement"],
    seed: () =>
      timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 30), vclip("b", "b.mp4", 30, 60)])]),
    prompt: "Insert intro.mp4 for one second between the two clips, pushing the later clip back.",
    expect: (tl) => {
      const cs = clipsOf(tl, "v2");
      assert(cs.length === 3, `expected 3 clips, got ${cs.length}`);
      assert(
        cs[1].media_ref === "intro.mp4",
        `expected intro.mp4 in the middle, got ${cs[1].media_ref}`,
      );
      assert(contiguousFrom(tl, "v2", 0, 2), "clips should stay gap-free");
    },
    expectTools: ["insert_clips"],
    maxRounds: 6,
  },
  {
    id: "remove_last",
    scope: { remove: ["c"] },
    title: "Delete the last clip (no ripple)",
    tags: ["remove"],
    seed: () =>
      timeline([
        vtrack("v2", 1, [
          vclip("a", "a.mp4", 0, 60),
          vclip("b", "b.mp4", 60, 120),
          vclip("c", "c.mp4", 120, 180),
        ]),
      ]),
    prompt: "Delete just the last clip and leave the others exactly where they are.",
    expect: (tl) => {
      const cs = clipsOf(tl, "v2");
      assert(cs.length === 2, `expected 2 clips, got ${cs.length}`);
      assert(!cs.some((c) => c.id === "c"), "last clip should be gone");
      near(Number(clipById(tl, "a")!.timeline_in), 0, 1, "first clip unmoved");
    },
    expectTools: ["remove_clips"],
    maxRounds: 5,
    reference: [
      READ_TIMELINE,
      call("remove_clips", { clip_ids: ["c"] }),
      say("Deleted the last clip (c.mp4); the other two have not moved."),
    ],
  },
  {
    id: "canvas_landscape",
    scope: { canvas: ["width", "height"] },
    title: "Resize the canvas",
    tags: ["canvas"],
    seed: () => timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 60)])]),
    prompt: "Change the canvas to 1920 by 1080 landscape.",
    expect: (tl) => {
      near(Number(tl.canvas?.width), 1920, 0, "canvas width");
      near(Number(tl.canvas?.height), 1080, 0, "canvas height");
    },
    expectTools: ["set_project_settings"],
    maxRounds: 4,
    maxToolErrors: 0,
    reference: [
      call("set_project_settings", { size: { width: 1920, height: 1080 }, fps: null }),
      say("The canvas is now 1920 by 1080, landscape."),
    ],
  },
  {
    id: "fps_24",
    scope: { canvas: ["fps"], change: ["a"] },
    title: "Change the frame rate",
    tags: ["canvas", "fps"],
    seed: () => timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 60)])]),
    // The canonical "value the model cannot know" case: retiming says nothing about
    // size, so any width/height it sends is invented. It used to send 0, then 1.
    prompt: "Change the project frame rate to 24 fps.",
    expect: (tl) => {
      near(Number(tl.canvas?.fps), 24, 0, "canvas fps");
      // The size must survive untouched — a guessed dimension would land here.
      near(Number(tl.canvas?.width), 1080, 0, "canvas width unchanged");
      near(Number(tl.canvas?.height), 1920, 0, "canvas height unchanged");
    },
    expectTools: ["set_project_settings"],
    maxRounds: 4,
    maxToolErrors: 0,
    reference: [
      call("set_project_settings", { fps: 24, size: null }),
      say("The project now runs at 24 fps; the canvas size is unchanged."),
    ],
  },
  {
    id: "canvas_square_no_size",
    scope: { canvas: ["width", "height"] },
    title: "Reshape the canvas without being told a size",
    tags: ["canvas"],
    seed: () => timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 60)])]),
    // Aspect only: the model must reach for the preset instead of inventing pixels.
    prompt: "Make the video square.",
    expect: (tl) => {
      const w = Number(tl.canvas?.width);
      const h = Number(tl.canvas?.height);
      near(w, h, 0, "canvas must be square");
      assert(w >= 64, `canvas collapsed to ${w}x${h}`);
    },
    expectTools: ["set_project_settings"],
    maxRounds: 4,
    maxToolErrors: 0,
    reference: [
      call("set_project_settings", { size: { aspect_ratio: "1:1" }, fps: null }),
      say("The video is square now (1:1)."),
    ],
  },
  {
    id: "read_whole_timeline",
    scope: {},
    title: "Read the timeline without knowing its length",
    tags: ["read", "read-only"],
    seed: readSeed,
    // get_timeline's window params had the SAME root cause as the canvas: both were
    // forced, so the model sent [0, 0) and got "invalid window".
    prompt: "What clips are on the timeline right now?",
    expectTools: ["get_timeline"],
    maxRounds: 3,
    maxToolErrors: 0,
    // A question must not become an edit...
    expect: (tl) =>
      assert(
        JSON.stringify(tl.tracks) === JSON.stringify(readSeed().tracks),
        "a question about the timeline changed it",
      ),
    // ...and the answer has to come from the timeline: read it (or be handed it with the
    // message), then name both clips. Doing nothing and saying anything used to pass.
    expectTrace: (t) => {
      const read = t.toolCalls.some((c) => c.ok && c.name === "get_timeline") || t.stateBlock;
      assert(read, "answered without reading the timeline");
      for (const [id, file] of [
        ["a", "a.mp4"],
        ["b", "b.mp4"],
      ])
        assert(
          new RegExp(`${file.replace(".", "\\.")}|[\`'"]${id}[\`'"]|\\bclip ${id}\\b`, "i").test(
            t.finalText,
          ),
          `the answer does not name clip ${id} (${file})`,
        );
    },
    reference: [
      READ_TIMELINE,
      say(
        "Two clips, both on track v2: a.mp4 from frame 0 to 60 (0 to 2 s), then b.mp4 from " +
          "frame 60 to 120 (2 to 4 s).",
      ),
    ],
  },
  {
    id: "color_warm",
    scope: { change: ["a"] },
    title: "Warmer, more saturated grade (open-ended)",
    tags: ["color", "open-ended"],
    seed: () => timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 90)])]),
    prompt: "Make this clip look warmer and a little more saturated.",
    expect: (tl) => {
      const c = clipById(tl, "a");
      const graded =
        (c?.color && Object.keys(c.color).length > 0) ||
        (Array.isArray(c?.effects) && c!.effects!.length > 0);
      assert(graded, "expected a colour grade / effect to be applied");
    },
    expectTools: ["apply_color", "apply_effects"],
    maxRounds: 5,
  },
  {
    id: "title_text",
    scope: { add: ["text"], addTracks: true },
    title: "Add a title card",
    tags: ["text", "captions"],
    seed: () => timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 90)])]),
    prompt: "Add a title at the start that says 'Hello' for the first two seconds.",
    // Merged with the former caption_title (same ask: a text clip over the first ~60 frames),
    // keeping both checks: the words AND where it starts. Each case alone missed one of them.
    expect: (tl) => {
      const text = clipsOf(tl, "v2").concat(
        (tl.tracks ?? []).flatMap((t) => (t.kind === "text" ? (t.clips ?? []) : [])),
      );
      const hit = text.find((c) => textOf(c).toLowerCase().includes("hello"));
      assert(hit, "expected a text clip containing 'Hello'");
      near(Number(hit!.timeline_in), 0, 2, "title starts at the start");
      near(span(hit!), 60, 6, "title duration");
    },
    expectTools: ["add_text_clips"],
    maxRounds: 6,
    reference: [
      READ_TIMELINE,
      call("add_text_clips", { entries: [{ timeline_in: 0, timeline_out: 60, content: "Hello" }] }),
      say("Added a 'Hello' title over the first two seconds."),
    ],
  },
  {
    id: "move_to_start",
    scope: { change: ["a"] },
    title: "Move a clip to the beginning",
    tags: ["move"],
    seed: () => timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 60, 120)])]),
    prompt: "Move the clip so it starts at the very beginning of the timeline.",
    expect: (tl) => near(Number(clipsOf(tl, "v2")[0]?.timeline_in), 0, 1, "clip start"),
    expectTools: ["move_clips"],
    maxRounds: 5,
    reference: [
      READ_TIMELINE,
      call("move_clips", { moves: [{ clip_id: "a", to_timeline_in: 0 }] }),
      say("Moved the clip to the very beginning of the timeline."),
    ],
  },
  {
    id: "mute_music",
    scope: { change: ["bed"], tracks: ["a3"] },
    title: "Mute the music",
    tags: ["audio", "properties"],
    seed: () => timeline([atrack("a3", 0, [aclip("bed", "music.mp3", 0, 180)])]),
    prompt: "Mute the background music completely.",
    // "Mute" is satisfied EITHER by zeroing the clip's gain OR by muting the track it
    // lives on (the standard NLE track-mute control) — both silence the music, and
    // muting the whole music track is arguably the more natural mapping of "mute".
    expect: (tl) => {
      const vol = Number(clipById(tl, "bed")?.volume ?? 1);
      const trackMuted = trackOf(tl, "a3")?.mute === true;
      assert(
        vol <= 0.001 || trackMuted,
        `expected the music muted: clip "bed" volume ~0 (got ${vol}) or track a3 muted (got ${trackMuted})`,
      );
    },
    expectTools: ["set_clip_properties", "set_track"],
    maxRounds: 5,
    reference: [
      READ_TIMELINE,
      call("set_track", { track_id: "a3", mute: true }),
      say("Muted the background music track."),
    ],
  },

  // ── compound / multi-step (two edits in one prompt) ─────────────────────────
  {
    id: "compound_fade_crossfade",
    scope: { change: ["a", "b"] },
    title: "Fade-in the first clip AND crossfade into the second",
    tags: ["compound", "fade", "transition"],
    seed: () =>
      timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 60), vclip("b", "b.mp4", 60, 120)])]),
    prompt:
      "Give the first clip a one-second fade-in, and add a half-second crossfade into the second clip.",
    expect: (tl) => {
      const a = clipById(tl, "a") as Any;
      const faded = (a?.fade?.in != null && Number(a.fade.in) > 0) || Array.isArray(a?.opacity);
      assert(faded, "expected a fade-in on the first clip (fade.in or an opacity ramp)");
      const b = clipsOf(tl, "v2").find((c) => (c as Any).transition_in) as Any;
      assert(b?.transition_in, "expected a crossfade on the second clip");
      near(Number(b.transition_in.duration), 15, 5, "crossfade duration");
    },
    expectTools: ["set_clip_properties", "set_transition", "set_keyframes"],
    maxRounds: 8,
    reference: [
      READ_TIMELINE,
      calls(
        ["set_clip_properties", { clip_ids: ["a"], fade: { in: 30 } }],
        ["set_transition", { clip_id: "b", transition_in: { kind: "crossfade", duration: 15 } }],
      ),
      say(
        "The first clip fades in over one second, and a half-second crossfade leads into the second.",
      ),
    ],
  },

  // ── captions (styled / animated: the C1–C5 look engine) ──────────────────────
  {
    id: "caption_styled_bold",
    scope: { add: ["text"], addTracks: true },
    title: "Add a big bold coloured caption",
    tags: ["captions", "text", "style"],
    seed: () => timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 150)])]),
    prompt: "Add a big bold yellow caption that says SALE across the bottom.",
    expect: (tl) => {
      const texts = (tl.tracks ?? [])
        .flatMap((t) => t.clips ?? [])
        .filter((c) => (c as Any).kind === "text") as Any[];
      const hit = texts.find((c) => textOf(c).toUpperCase().includes("SALE"));
      assert(hit, "expected a caption containing SALE");
      const st = (hit.style ?? {}) as Any;
      // Lenient: any real styling (colour / bold / heavy weight / preset / an explicit size) proves the
      // model resolved a LOOK, not a plain default caption. The model has latitude over which fields.
      const styled =
        st.color != null ||
        st.fontcolor != null ||
        st.bold === true ||
        st.preset != null ||
        (st.weight != null && Number(st.weight) >= 600) ||
        Number(st.size ?? st.fontsize ?? 0) > 0;
      assert(
        styled,
        "expected the caption STYLED (colour / bold / size / preset), not a plain default",
      );
    },
    expectTools: ["add_text_clips", "set_clip_properties"],
    maxRounds: 6,
    reference: [
      READ_TIMELINE,
      call("add_text_clips", {
        entries: [
          {
            timeline_in: 0,
            timeline_out: 150,
            content: "SALE",
            style: { size: "xl", bold: true, color: "#FFD400" },
            transform: { position: { x: 0.5, y: 0.85 } },
          },
        ],
      }),
      say("Added a big bold yellow SALE caption across the bottom for the whole clip."),
    ],
  },
  {
    id: "caption_word_by_word",
    scope: { add: ["text"], addTracks: true },
    title: "Reveal captions one word at a time",
    tags: ["captions", "animation"],
    seed: () => timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 150)])]),
    prompt: "Add captions that pop up one word at a time saying like and subscribe.",
    expect: (tl) => {
      const texts = (tl.tracks ?? [])
        .flatMap((t) => t.clips ?? [])
        .filter((c) => (c as Any).kind === "text") as Any[];
      assert(texts.length >= 1, "expected a caption");
      assertSays(texts, "like and subscribe");
      const build = String(((texts[0].animation ?? {}) as Any).build ?? "");
      // A word reveal = a karaoke-family build, OR content authored as per-word timed items.
      const perWord =
        /word|typewriter|append/i.test(build) ||
        (Array.isArray(texts[0].content) && texts[0].content.length >= 2);
      assert(
        perWord,
        "expected a word-by-word reveal (animation.build word-*/typewriter/append, or per-word content)",
      );
    },
    expectTools: ["add_text_clips"],
    maxRounds: 7,
    reference: [
      READ_TIMELINE,
      call("add_text_clips", {
        entries: [
          {
            timeline_in: 0,
            timeline_out: 90,
            content: "like and subscribe",
            animation: { build: "word-by-word", entrance: "pop" },
          },
        ],
      }),
      say("Added a 'like and subscribe' caption that pops up one word at a time."),
    ],
  },
  {
    id: "caption_emphasis_word",
    scope: { add: ["text"], addTracks: true },
    title: "Emphasise one word in a caption",
    tags: ["captions", "emphasis"],
    seed: () => timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 150)])]),
    prompt: "Add a caption that says Only $9 today and make the $9 really stand out.",
    expect: (tl) => {
      const texts = (tl.tracks ?? [])
        .flatMap((t) => t.clips ?? [])
        .filter((c) => (c as Any).kind === "text") as Any[];
      assertSays(texts, "Only $9 today");
      // The emphasis is judged on the caption that carries the $9, never on another one.
      const hit = texts.find((c) => /\$?9/.test(textOf(c)));
      assert(hit, "expected the caption");
      const anim = (hit.animation ?? {}) as Any;
      const emphAnim =
        anim.emphasis &&
        typeof anim.emphasis === "object" &&
        anim.emphasis.kind &&
        anim.emphasis.kind !== "none";
      // OR a per-run hero: a content item flagged emphasis, or carrying its own style diff.
      const emphRun =
        Array.isArray(hit.content) &&
        hit.content.some(
          (it: Any) =>
            it &&
            typeof it === "object" &&
            (it.emphasis === true || (it.style && Object.keys(it.style).length > 0)),
        );
      assert(
        emphAnim || emphRun,
        "expected the $9 emphasised (animation.emphasis, or a per-run emphasis/style)",
      );
    },
    expectTools: ["add_text_clips"],
    maxRounds: 7,
    reference: [
      READ_TIMELINE,
      call("add_text_clips", {
        entries: [
          {
            timeline_in: 0,
            timeline_out: 90,
            content: [{ text: "Only " }, { text: "$9", emphasis: true }, { text: " today" }],
            animation: { emphasis: { kind: "pop", color: "#FFD400", scale: 1.3 } },
          },
        ],
      }),
      say("Added 'Only $9 today' with the $9 popping out bigger and in yellow."),
    ],
  },
  {
    id: "caption_kinetic_chunks",
    scope: { add: ["text"], addTracks: true },
    title: "Kinetic phrase-by-phrase captions",
    tags: ["captions", "animation"],
    seed: () => timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 150)])]),
    prompt: "Add kinetic captions for stop scrolling right now that flash up phrase by phrase.",
    expect: (tl) => {
      const texts = (tl.tracks ?? [])
        .flatMap((t) => t.clips ?? [])
        .filter((c) => (c as Any).kind === "text") as Any[];
      assert(texts.length >= 1, "expected a caption");
      assertSays(texts, "stop scrolling right now");
      const build = String(((texts[0].animation ?? {}) as Any).build ?? "");
      // Kinetic = a chunk/word build, OR multi-part content, OR several separately-timed caption clips.
      const kinetic =
        /phrase|chunk|word|typewriter|append/i.test(build) ||
        (Array.isArray(texts[0].content) && texts[0].content.length >= 2) ||
        texts.length >= 2;
      assert(
        kinetic,
        "expected a kinetic build (phrase-chunks / word-* / multi-part content or multiple timed captions)",
      );
    },
    expectTools: ["add_text_clips"],
    maxRounds: 8,
    reference: [
      READ_TIMELINE,
      call("add_text_clips", {
        entries: [
          {
            timeline_in: 0,
            timeline_out: 90,
            content: "stop scrolling right now",
            animation: { build: "phrase-chunks" },
          },
        ],
      }),
      say("Added kinetic captions for 'stop scrolling right now' that flash up phrase by phrase."),
    ],
  },
  {
    id: "caption_preset_punchy",
    scope: { add: ["text"], addTracks: true },
    title: "Punchy preset captions",
    tags: ["captions", "style", "preset"],
    seed: () => timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 150)])]),
    prompt: "Add punchy TikTok-style captions that say WAIT FOR IT.",
    expect: (tl) => {
      const texts = (tl.tracks ?? [])
        .flatMap((t) => t.clips ?? [])
        .filter((c) => (c as Any).kind === "text") as Any[];
      assertSays(texts, "WAIT FOR IT");
      // The look is judged on the caption that says it, never on another one.
      const hit = texts.find((c) => textOf(c).toUpperCase().includes("WAIT"));
      assert(hit, "expected the caption");
      const st = (hit.style ?? {}) as Any;
      const punchy =
        st.preset != null ||
        st.bold === true ||
        (st.weight != null && Number(st.weight) >= 600) ||
        st.case === "upper" ||
        Number(st.size ?? st.fontsize ?? 0) >= 40 ||
        st.outline != null ||
        st.box != null;
      assert(
        punchy,
        "expected a punchy/bold caption look (preset / bold / upper / large / outline / box)",
      );
    },
    expectTools: ["add_text_clips", "set_clip_properties"],
    maxRounds: 7,
    reference: [
      READ_TIMELINE,
      call("add_text_clips", {
        entries: [
          {
            timeline_in: 0,
            timeline_out: 90,
            content: "WAIT FOR IT",
            style: { preset: "punchy" },
            animation: { preset: "pop-in" },
          },
        ],
      }),
      say("Added punchy, TikTok-style 'WAIT FOR IT' captions."),
    ],
  },

  // ── keyframed motion (pan/zoom) ──────────────────────────────────────────────
  {
    id: "zoom_in_motion",
    scope: { change: ["a"] },
    title: "Slow zoom-in over the clip",
    tags: ["keyframes", "motion"],
    seed: () => timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 90)])]),
    prompt: "Add a slow zoom-in to the clip over its whole length.",
    expect: (tl) => {
      const c = clipById(tl, "a") as Any;
      const scale = c?.transform?.scale ?? c?.transform?.scale_x;
      assert(Array.isArray(scale) && scale.length >= 2, "expected a scale keyframe ramp (zoom)");
      const pts = [...scale].sort((p: Any, q: Any) => Number(p.t) - Number(q.t));
      assert(Number(pts[pts.length - 1].v) > Number(pts[0].v), "zoom should scale UP over time");
    },
    expectTools: ["set_keyframes"],
    maxRounds: 6,
    reference: [
      READ_TIMELINE,
      call("set_keyframes", {
        clip_id: "a",
        property: "scale",
        keyframes: [
          { t: 0, v: 1 },
          { t: 89, v: 1.15, ease: "ease-in-out" },
        ],
      }),
      say("Added a slow zoom-in, from full size to 115%, across the whole clip."),
    ],
  },

  // ── PiP / transform layout ───────────────────────────────────────────────────
  {
    id: "pip_corner",
    scope: { change: ["pip"] },
    title: "Shrink to a corner picture-in-picture",
    tags: ["layout", "transform"],
    seed: () => timeline([vtrack("v1", 2, [vclip("pip", "pip.mp4", 0, 90)])]),
    prompt: "Shrink this clip to a small picture-in-picture in the top-right corner.",
    expect: (tl) => {
      const c = clipById(tl, "pip") as Any;
      const s = c?.transform?.scale;
      const scaleNum =
        typeof s === "number" ? s : Array.isArray(s) ? Number(s[s.length - 1]?.v) : NaN;
      assert(
        Number.isFinite(scaleNum) && scaleNum < 0.8,
        `expected the clip shrunk to a PiP (scale < 0.8, got ${scaleNum})`,
      );
      // "In the top-right corner": a PiP shrunk in the middle, or in another corner, is not it.
      const p = posOf(c?.transform?.position);
      assert(
        p.x > 0.5 && p.y < 0.5,
        `expected the PiP in the top-right corner, its centre is at x ${p.x}, y ${p.y}`,
      );
    },
    expectTools: ["set_clip_properties"],
    maxRounds: 6,
    reference: [
      READ_TIMELINE,
      call("set_clip_properties", {
        clip_ids: ["pip"],
        transform: { scale: 0.35, position: { x: 0.78, y: 0.12 } },
      }),
      say("Shrank the clip to a small picture-in-picture in the top-right corner."),
    ],
  },

  // ── transitions beyond crossfade ─────────────────────────────────────────────
  {
    id: "fade_to_black",
    scope: { change: ["a", "b"] },
    title: "Fade to black between two clips",
    tags: ["transition"],
    seed: () =>
      timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 60), vclip("b", "b.mp4", 60, 120)])]),
    prompt: "Put a fade to black between the two clips.",
    expect: (tl) => {
      const a = clipById(tl, "a") as Any;
      const b = clipById(tl, "b") as Any;
      const dipTransition = [a, b].some(
        (c) => c?.transition_in && /black|dip|fade/i.test(String(c.transition_in.kind)),
      );
      const fadeOutIn =
        a?.fade?.out != null &&
        Number(a.fade.out) > 0 &&
        b?.fade?.in != null &&
        Number(b.fade.in) > 0;
      assert(
        dipTransition || fadeOutIn,
        "expected a dip-to-black transition OR a fade-out then fade-in across the cut",
      );
    },
    expectTools: ["set_transition", "set_clip_properties"],
    maxRounds: 7,
    reference: [
      READ_TIMELINE,
      call("set_transition", {
        clip_id: "b",
        transition_in: { kind: "dip-to-black", duration: 30 },
      }),
      say("Put a one-second fade to black between the two clips."),
    ],
  },

  // ── audio (duck) ─────────────────────────────────────────────────────────────
  {
    id: "duck_music",
    scope: { change: ["bed"] },
    title: "Duck the music under the voiceover",
    tags: ["audio", "duck"],
    seed: () =>
      timeline([
        atrack("a3", 0, [aclip("bed", "music.mp3", 0, 180)]),
        atrack("a4", 1, [aclip("vo", "voice.mp3", 0, 90)]),
      ]),
    prompt: "Duck the background music down whenever the voiceover is talking.",
    expect: (tl) => {
      const bed = clipById(tl, "bed") as Any;
      // Ducking turns the music down only while the voice talks (the first 3 s of its 6): a
      // sidechain duck, or volume keyframes lower under the voice than after it. A flat lower
      // volume is quieter where nobody talks too, so it is not what was asked.
      if (bed?.duck != null) return;
      assert(
        Array.isArray(bed?.volume),
        "expected the music ducked under the voiceover (a duck setting or volume keyframes), not a flat volume",
      );
      const [under, after] = [valueAt(bed.volume, 45), valueAt(bed.volume, 135)];
      assert(
        under < after - 0.05,
        `expected the music lower while the voiceover talks (volume ${under} under it, ${after} after it)`,
      );
    },
    expectTools: ["set_clip_properties"],
    maxRounds: 7,
    reference: [
      READ_TIMELINE,
      call("set_clip_properties", { clip_ids: ["bed"], duck: { against: "a4" } }),
      say("The music now ducks down whenever the voiceover on track a4 is talking."),
    ],
  },

  // ── audio (split) ────────────────────────────────────────────────────────────
  {
    id: "split_music",
    scope: { change: ["bed"], add: ["audio"] },
    title: "Split the music in half",
    tags: ["audio", "split"],
    seed: () => timeline([atrack("a3", 0, [aclip("bed", "music.mp3", 0, 180)])]),
    prompt: "Split the background music into two halves.",
    expect: (tl) => {
      const cs = clipsOf(tl, "a3");
      assert(cs.length === 2, `expected 2 audio clips after the split, got ${cs.length}`);
      near(Number(cs[0].timeline_out), 90, 4, "split near the midpoint");
    },
    expectTools: ["split_clips"],
    maxRounds: 6,
    reference: [
      READ_TIMELINE,
      call("split_clips", { splits: [{ clip_id: "bed", at: 90 }] }),
      say("Split the background music into two halves at the 3-second mark."),
    ],
  },

  // ── adversarial / ambiguous ──────────────────────────────────────────────────
  {
    id: "make_it_pop",
    scope: { change: ["a"] },
    title: "Make it pop (underspecified)",
    tags: ["adversarial", "open-ended"],
    seed: () => timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 90)])]),
    prompt: "Make this clip pop more.",
    // Underspecified on purpose, and an ordinary edit like this one is expected without asking
    // first. Which look is taste, so any real treatment of the clip passes: a grade, an effect
    // or a glow. Doing nothing used to pass too; it does not any more.
    expect: (tl) => {
      const c = clipById(tl, "a") as Any;
      assert(c, "the clip is gone");
      const graded = c.color && typeof c.color === "object" && Object.keys(c.color).length > 0;
      const affected =
        Array.isArray(c.effects) && c.effects.some((e: Any) => e && e.enabled !== false);
      const glow = numOf(typeof c.glow === "object" ? c.glow?.amount : c.glow) > 0;
      assert(
        graded || affected || glow,
        "the clip was given no look at all (grade, effect or glow)",
      );
    },
    expectTools: ["apply_color", "apply_effects", "set_clip_properties"],
    maxRounds: 6,
  },

  // ── multi-turn follow-ups (needs the harness followUps extension) ────────────
  {
    id: "retrim_followup",
    scope: { change: ["intro"] },
    title: "Trim, then correct it on a follow-up turn",
    tags: ["multi-turn", "trim"],
    seed: () => timeline([vtrack("v2", 1, [vclip("intro", "intro.mp4", 0, 90)])]),
    prompt: "Make the intro clip 2 seconds long.",
    followUps: ["Actually, make it 1 second instead."],
    expect: (tl) => near(span(clipById(tl, "intro")), 30, 3, "intro is 1s after the follow-up"),
    expectTools: ["set_clip_properties"],
    maxRounds: 8,
    reference: [
      READ_TIMELINE,
      call("set_clip_properties", { clip_ids: ["intro"], duration: 60 }),
      say("The intro clip is now 2 seconds long."),
      call("set_clip_properties", { clip_ids: ["intro"], duration: 30 }),
      say("Changed it: the intro is 1 second long now."),
    ],
  },
  {
    id: "caption_retime_followup",
    scope: { add: ["text"], addTracks: true },
    title: "Add a title, then extend it on a follow-up turn",
    tags: ["multi-turn", "captions"],
    seed: () => timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 150)])]),
    prompt: "Add a title that says Intro for the first 2 seconds.",
    followUps: ["Make the title 4 seconds long instead."],
    expect: (tl) => {
      const texts = (tl.tracks ?? [])
        .flatMap((t) => t.clips ?? [])
        .filter((c) => (c as Any).kind === "text") as Any[];
      assert(texts.length >= 1, "expected the title text clip");
      near(span(texts[0]), 120, 12, "title extended to ~4s after the follow-up");
    },
    expectTools: ["add_text_clips", "set_clip_properties"],
    maxRounds: 9,
    reference: [
      READ_TIMELINE,
      call("add_text_clips", { entries: [{ timeline_in: 0, timeline_out: 60, content: "Intro" }] }),
      say("Added an 'Intro' title over the first 2 seconds."),
      // The title's id was minted by add_text_clips; a fresh read finds it.
      READ_TIMELINE,
      {
        calls: (req) => [
          [
            "set_clip_properties",
            {
              clip_ids: timelineClipsIn(req)
                .filter((c) => c.kind === "text")
                .map((c) => c.id),
              duration: 120,
            },
          ],
        ],
      },
      say("The title now runs 4 seconds."),
    ],
  },

  // ── effects ──────────────────────────────────────────────────────────────────
  {
    id: "effect_blur",
    scope: { change: ["a"] },
    title: "Add a blur",
    tags: ["effects"],
    seed: () => timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 90)])]),
    prompt: "Add a soft blur to the clip.",
    expect: (tl) =>
      assert(
        ((clipById(tl, "a") as Any)?.effects ?? []).some((e: Any) => /blur/i.test(String(e.type))),
        "expected a blur effect",
      ),
    expectTools: ["apply_effects"],
    maxRounds: 5,
    reference: [
      READ_TIMELINE,
      call("apply_effects", { clip_ids: ["a"], add: [{ type: "blur", params: { radius: 6 } }] }),
      say("Added a soft blur to the clip."),
    ],
  },
  {
    id: "effect_grain",
    scope: { change: ["a"] },
    title: "Add film grain",
    tags: ["effects"],
    seed: () => timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 90)])]),
    prompt: "Give it a grainy film look.",
    expect: (tl) =>
      assert(
        ((clipById(tl, "a") as Any)?.effects ?? []).some((e: Any) =>
          /grain|noise/i.test(String(e.type)),
        ),
        "expected a grain effect",
      ),
    expectTools: ["apply_effects", "apply_color"],
    maxRounds: 5,
    reference: [
      READ_TIMELINE,
      call("apply_effects", { clip_ids: ["a"], add: [{ type: "grain", params: { grain: 30 } }] }),
      say("Gave it a grainy film look."),
    ],
  },

  // ── colour ───────────────────────────────────────────────────────────────────
  {
    id: "black_and_white",
    scope: { change: ["a"] },
    title: "Desaturate to black & white",
    tags: ["color"],
    seed: () => timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 90)])]),
    prompt: "Make this clip black and white.",
    expect: (tl) => {
      const sat = numOf((clipById(tl, "a") as Any)?.color?.saturation);
      assert(Number.isFinite(sat) && sat <= 0.15, `expected near-zero saturation (got ${sat})`);
    },
    expectTools: ["apply_color"],
    maxRounds: 5,
    reference: [
      READ_TIMELINE,
      call("apply_color", { clip_ids: ["a"], saturation: 0 }),
      say("The clip is black and white now."),
    ],
  },
  {
    id: "boost_contrast",
    scope: { change: ["a"] },
    title: "Increase contrast",
    tags: ["color"],
    seed: () => timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 90)])]),
    prompt: "Punch up the contrast on this clip.",
    expect: (tl) => {
      const con = numOf((clipById(tl, "a") as Any)?.color?.contrast);
      assert(Number.isFinite(con) && con > 1.0, `expected contrast > 1 (got ${con})`);
    },
    expectTools: ["apply_color"],
    maxRounds: 5,
  },

  // ── crop / flip / rotate / glow / blend / transform ──────────────────────────
  {
    id: "crop_square",
    scope: { change: ["a"] },
    title: "Crop to square",
    tags: ["crop"],
    seed: () => timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 90)])]),
    prompt: "Crop the sides so the clip is square.",
    expect: (tl) => {
      const cr = (clipById(tl, "a") as Any)?.crop;
      // "The sides": a widescreen clip gets to square only by losing width. A crop of the top and
      // bottom alone makes it wider still, and passed as "a crop" before.
      const sides = (Number(cr?.left) || 0) + (Number(cr?.right) || 0);
      assert(sides > 0, "expected the sides cropped (left and right), not only the top and bottom");
    },
    expectTools: ["set_clip_properties"],
    maxRounds: 6,
    reference: [
      READ_TIMELINE,
      // a.mp4 is 1920x1080: 420 px off each side leaves a 1080x1080 square.
      call("set_clip_properties", { clip_ids: ["a"], crop: { left: 0.21875, right: 0.21875 } }),
      say("Cropped the sides so the clip is square."),
    ],
  },
  {
    id: "flip_horizontal",
    scope: { change: ["a"] },
    title: "Mirror horizontally",
    tags: ["transform"],
    seed: () => timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 90)])]),
    prompt: "Mirror this clip horizontally.",
    expect: (tl) => assert((clipById(tl, "a") as Any)?.flip?.h === true, "expected flip.h = true"),
    expectTools: ["set_clip_properties"],
    maxRounds: 5,
    reference: [
      READ_TIMELINE,
      call("set_clip_properties", { clip_ids: ["a"], flip: { h: true } }),
      say("Mirrored the clip horizontally."),
    ],
  },
  {
    id: "rotate_90",
    scope: { change: ["a"] },
    title: "Rotate 90 degrees",
    tags: ["transform"],
    seed: () => timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 90)])]),
    prompt: "Rotate this clip 90 degrees.",
    expect: (tl) => {
      const r = Math.abs(numOf((clipById(tl, "a") as Any)?.rotate));
      assert(Number.isFinite(r) && Math.abs(r - 90) <= 5, `expected ~90° rotation (got ${r})`);
    },
    expectTools: ["set_clip_properties", "set_keyframes"],
    maxRounds: 5,
    reference: [
      READ_TIMELINE,
      call("set_clip_properties", { clip_ids: ["a"], rotate: 90 }),
      say("Rotated the clip 90 degrees clockwise."),
    ],
  },
  {
    id: "add_glow",
    scope: { change: ["a"] },
    title: "Add a glow",
    tags: ["look"],
    seed: () => timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 90)])]),
    prompt: "Add a dreamy glow to this clip.",
    expect: (tl) => {
      const c = clipById(tl, "a") as Any;
      const g = c?.glow;
      const scalarGlow =
        typeof g === "number" ? g > 0 : Boolean(g && typeof g === "object" && Number(g.amount) > 0);
      // apply_effects lands glow in effects[]; the renderer maps it through the same
      // bloom sub-graph (glowFromEffects), so it is an equally valid way to add a glow.
      const effectGlow =
        Array.isArray(c?.effects) &&
        c.effects.some(
          (e: Any) =>
            e?.type === "glow" &&
            (Number(e.params?.intensity) > 0 || Number(e.params?.opacity) > 0),
        );
      assert(scalarGlow || effectGlow, "expected a glow (clip.glow or an effects[] glow)");
    },
    expectTools: ["set_clip_properties", "apply_effects"],
    maxRounds: 5,
    reference: [
      READ_TIMELINE,
      call("apply_effects", {
        clip_ids: ["a"],
        add: [{ type: "glow", params: { intensity: 30 } }],
      }),
      say("Added a dreamy glow to the clip."),
    ],
  },
  {
    id: "blend_screen",
    scope: { change: ["ov"] },
    title: "Set screen blend mode",
    tags: ["compositing"],
    seed: () => timeline([vtrack("v1", 2, [vclip("ov", "overlay.mp4", 0, 90)])]),
    prompt: "Set this overlay to screen blend mode.",
    expect: (tl) =>
      assert((clipById(tl, "ov") as Any)?.blend === "screen", "expected blend = screen"),
    expectTools: ["set_clip_properties"],
    maxRounds: 5,
    reference: [
      READ_TIMELINE,
      call("set_clip_properties", { clip_ids: ["ov"], blend: "screen" }),
      say("The overlay now uses the screen blend mode."),
    ],
  },
  {
    id: "move_to_topleft",
    scope: { change: ["a"] },
    title: "Move to the top-left corner",
    tags: ["layout", "transform"],
    seed: () => timeline([vtrack("v1", 2, [vclip("a", "a.mp4", 0, 90)])]),
    prompt: "Move this clip to the top-left corner of the frame.",
    expect: (tl) => {
      const p = (clipById(tl, "a") as Any)?.transform?.position;
      assert(
        p && numOf(p.x) < 0.5 && numOf(p.y) < 0.5,
        "expected the clip centred toward the top-left (x,y < 0.5)",
      );
    },
    expectTools: ["set_clip_properties"],
    maxRounds: 6,
    reference: [
      READ_TIMELINE,
      call("set_clip_properties", {
        clip_ids: ["a"],
        transform: { scale: 1, position: { x: 0.25, y: 0.25 } },
      }),
      say(
        "Moved the clip to the top-left corner. It is as wide as the frame, so part of it now " +
          "runs off the left edge; I can make it smaller so it sits inside the corner if you like.",
      ),
    ],
  },

  // ── keyframed audio fade ─────────────────────────────────────────────────────
  {
    id: "music_fade_out",
    scope: { change: ["bed"] },
    title: "Fade the music out at the end",
    tags: ["audio", "keyframes"],
    seed: () => timeline([atrack("a3", 0, [aclip("bed", "music.mp3", 0, 180)])]),
    prompt: "Fade the music out over the last 2 seconds.",
    expect: (tl) => {
      const bed = clipById(tl, "bed") as Any;
      const faded =
        (bed?.fade?.out != null && Number(bed.fade.out) > 0) || Array.isArray(bed?.volume);
      assert(faded, "expected a fade-out (fade.out or a volume keyframe ramp)");
    },
    expectTools: ["set_clip_properties", "set_keyframes"],
    maxRounds: 6,
    reference: [
      READ_TIMELINE,
      call("set_clip_properties", { clip_ids: ["bed"], fade: { out: 60 } }),
      say("The music now fades out over its last 2 seconds."),
    ],
  },

  // ── trim variant ─────────────────────────────────────────────────────────────
  {
    id: "trim_start",
    scope: { change: ["a"] },
    title: "Trim off the first second",
    tags: ["trim"],
    seed: () => timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 90)])]),
    prompt: "Trim off the first second of this clip.",
    // Span alone is NOT enough: a tail trim also lands on 60 frames. The HEAD has to
    // have moved, which is the difference between trimming and slipping.
    expect: (tl) => {
      const c = clipById(tl, "a") as Any;
      near(span(c), 60, 4, "clip is ~2s after trimming 1s off the 3s clip");
      near(Number(c.source_in ?? 0), 30, 4, "source starts ~1s in (the first second is gone)");
    },
    expectTools: ["set_clip_properties"],
    maxRounds: 6,
    reference: [
      READ_TIMELINE,
      call("set_clip_properties", { clip_ids: ["a"], source_in: 30, duration: 60 }),
      say("Trimmed off the first second; the clip now starts 1 s into the footage and runs 2 s."),
    ],
  },
  {
    id: "slip_content_later",
    scope: { change: ["a"] },
    title: "Show later footage without moving or resizing the clip",
    tags: ["trim", "slip"],
    // Deliberately different timeline and source origins: a model that confuses the
    // two domains cannot pass by coincidence.
    seed: () => timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 60, 150)])]),
    prompt:
      "This clip is in the right place and the right length, but it's showing the wrong moment. " +
      "Keep it exactly where it is and exactly as long, just start it one second later into the footage.",
    expect: (tl) => {
      const c = clipById(tl, "a") as Any;
      // Slip is defined by what must NOT change. Assert those first: if the length
      // moved it was a trim, if the position moved it was a move — both are the
      // wrong edit, and both would pass an oracle that only checked source_in.
      near(Number(c.timeline_in), 60, 0, "clip must not move");
      near(span(c), 90, 0, "clip length must not change");
      near(Number(c.source_in), 30, 4, "source starts ~1s later");
      near(
        Number(c.source_out) - Number(c.source_in),
        90,
        4,
        "source span still covers the clip (parity held)",
      );
    },
    expectTools: ["set_clip_properties"],
    maxRounds: 5,
    maxToolErrors: 0,
    reference: [
      READ_TIMELINE,
      call("set_clip_properties", { clip_ids: ["a"], source_in: 30 }),
      say("The clip now shows footage from one second later; its place and length are unchanged."),
    ],
  },

  {
    id: "clear_music_track",
    scope: { remove: ["bed", "bed2"], tracks: ["a3"] },
    title: "Remove everything on the music track",
    tags: ["remove"],
    seed: () =>
      timeline([
        vtrack("v2", 1, [vclip("a", "a.mp4", 0, 120)]),
        atrack("a3", 0, [aclip("bed", "music.mp3", 0, 60), aclip("bed2", "music2.mp3", 60, 120)]),
      ]),
    prompt: "Remove all the background music.",
    expect: (tl) =>
      assert(
        clipsOf(tl, "a3").length === 0,
        `expected the music track empty, got ${clipsOf(tl, "a3").length}`,
      ),
    // Emptying the clips OR removing the whole music track both clear the music.
    expectTools: ["remove_clips", "ripple_delete", "remove_tracks"],
    maxRounds: 6,
    reference: [
      READ_TIMELINE,
      call("remove_clips", { clip_ids: ["bed", "bed2"] }),
      say("Removed both music clips; the video is untouched."),
    ],
  },

  // ── split-screen layout ──────────────────────────────────────────────────────
  {
    id: "split_screen",
    scope: { change: ["l", "r"] },
    title: "Side-by-side split screen",
    tags: ["layout", "transform"],
    seed: () =>
      timeline([
        vtrack("v1", 2, [vclip("l", "left.mp4", 0, 90)]),
        vtrack("v2", 1, [vclip("r", "right.mp4", 0, 90)]),
      ]),
    prompt: "Put these two clips side by side as a split screen.",
    expect: (tl) => {
      const arranged = (id: string): boolean => {
        const c = clipById(tl, id) as Any;
        // Same precedence as the renderer (render.ts: `t.scale_x ?? t.scale`). Reading
        // them the other way round scored a CORRECT split screen as a failure.
        const s = numOf(c?.transform?.scale_x ?? c?.transform?.scale);
        const cr = c?.crop;
        const cropped = cr && (Number(cr.left) || 0) + (Number(cr.right) || 0) > 0;
        return (Number.isFinite(s) && s < 0.95) || Boolean(cropped);
      };
      assert(
        arranged("l") && arranged("r"),
        "expected both clips scaled/cropped into a side-by-side layout",
      );
      // Side by side: one picture on each half of the frame. A crop is fitted back into the
      // clip's own box (preview/scene.ts clipRects), so only a position moves a picture sideways;
      // two pictures shrunk in the middle overlap, which is not a split screen.
      const xs = ["l", "r"].map((id) => posOf((clipById(tl, id) as Any)?.transform?.position).x);
      assert(
        Math.min(...xs) < 0.5 && Math.max(...xs) > 0.5,
        `expected one clip on each side of the frame, their centres are at x ${xs.join(" and ")}`,
      );
    },
    expectTools: ["set_clip_properties"],
    maxRounds: 8,
    reference: [
      READ_TIMELINE,
      calls(
        [
          "set_clip_properties",
          { clip_ids: ["l"], transform: { scale: 0.5, position: { x: 0.25, y: 0.5 } } },
        ],
        [
          "set_clip_properties",
          { clip_ids: ["r"], transform: { scale: 0.5, position: { x: 0.75, y: 0.5 } } },
        ],
      ),
      say("Put the two clips side by side: left.mp4 on the left half, right.mp4 on the right."),
    ],
  },

  // ── more multi-turn (correction + undo) ──────────────────────────────────────
  {
    id: "speed_adjust_followup",
    scope: { change: ["a"] },
    title: "Speed up, then dial it back (follow-up)",
    tags: ["multi-turn", "retime"],
    seed: () => timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 120)])]),
    prompt: "Speed this clip up to 2x.",
    followUps: ["That's too fast — make it 1.5x instead."],
    expect: (tl) =>
      near(
        Number((clipById(tl, "a") as Any)?.speed ?? 1),
        1.5,
        0.1,
        "speed is 1.5x after the follow-up",
      ),
    expectTools: ["set_clip_properties"],
    maxRounds: 8,
    reference: [
      READ_TIMELINE,
      call("set_clip_properties", { clip_ids: ["a"], speed: 2 }),
      say("The clip plays at 2x now."),
      call("set_clip_properties", { clip_ids: ["a"], speed: 1.5 }),
      say("Eased it back to 1.5x."),
    ],
  },
  {
    id: "undo_followup",
    scope: { change: ["a"] },
    title: "Apply an edit, then undo it (follow-up)",
    tags: ["multi-turn", "undo"],
    seed: () => timeline([vtrack("v2", 1, [vclip("a", "a.mp4", 0, 90)])]),
    prompt: "Make this clip 50% transparent.",
    followUps: ["Actually, undo that — put it back to fully opaque."],
    expect: (tl) =>
      near(
        Number((clipById(tl, "a") as Any)?.opacity ?? 1),
        1,
        0.06,
        "opacity restored to 1 after undo",
      ),
    // The final opacity is the seed's own, so the end state alone cannot tell "undid it" from
    // "never did it". The trace can: the 50% edit landed, and something put it back after.
    expectTrace: (t) => {
      const edit = t.toolCalls.findIndex((c) => c.ok && setsOpacity(c.args, 0.5));
      assert(edit >= 0, "the 50% transparency edit never landed");
      const back = t.toolCalls
        .slice(edit + 1)
        .some((c) => c.ok && (c.name === "undo" || setsOpacity(c.args, 1)));
      assert(back, "nothing after the edit undid it (no undo, no opacity back to 1)");
    },
    expectTools: ["set_clip_properties", "undo"],
    maxRounds: 8,
    reference: [
      READ_TIMELINE,
      call("set_clip_properties", { clip_ids: ["a"], opacity: 0.5 }),
      say("The clip is 50% transparent now."),
      call("undo"),
      say("Undone: the clip is fully opaque again."),
    ],
  },
];
