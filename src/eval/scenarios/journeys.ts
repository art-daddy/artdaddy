// Journey scenarios — end-to-end WORKFLOWS, not single verbs.
//
// The 55 canonical/regression scenarios answer "does the model call the right tool
// with the right params?". These answer a different question: "can it finish a
// real job?" — planning, sequencing, doing the frame math across a whole task, and
// stopping when it's done. Those failures cannot appear in a one-verb scenario.
//
// GRADING: never assert the edit is *good* (no oracle for taste, and the
// expectation would need rewriting every run). Assert invariants that ANY
// acceptable result satisfies — the deliverable exists, the sequence was legal,
// nothing was done twice, the geometry is sane. Keep tolerances generous: this
// grades a model, not a pure function.
import { JOURNEY_LAST_WORD_FRAME, JOURNEY_NARRATION_REF, JOURNEY_WORDS } from "../journey";
import type { Scenario, Trace } from "../types";
import { timeline, vclip, vtrack } from "./helpers";

const FPS = 30;
const NARRATION_END = 300; // the seeded clip runs 0..300; the last word starts at 205

function called(trace: Trace, name: string) {
  return trace.toolCalls.filter((c) => c.name === name);
}
function firstRound(trace: Trace, name: string): number {
  const hit = trace.toolCalls.find((c) => c.name === name);
  return hit ? trace.toolCalls.indexOf(hit) : -1;
}
function textClips(final: ReturnType<Scenario["seed"]>) {
  return (final.tracks ?? []).flatMap((t) => (t.clips ?? []).filter((c) => c.kind === "text"));
}

export const JOURNEYS: Scenario[] = [
  {
    id: "journey_import_edit_export",
    title: "Import two clips, join them with a crossfade, export the result",
    tags: ["journey", "import", "transition", "export"],
    surface: "journey",
    // Nothing on the timeline: the model must bring the media in itself.
    seed: () => timeline([], { width: 1920, height: 1080, fps: FPS }),
    prompt:
      "Import C:/media/intro.mp4 and C:/media/outro.mp4, lay them back to back in that " +
      "order with a short crossfade between them, then export the finished video as final.mp4.",
    expectTools: ["import_media", "add_clips", "set_transition", "export"],
    maxRounds: 14,
    expect: (final) => {
      const clips = (final.tracks ?? []).flatMap((t) => t.clips ?? []);
      const visual = clips.filter((c) => c.kind !== "text" && c.kind !== "audio");
      if (visual.length < 2)
        throw new Error(`expected 2 clips on the timeline, got ${visual.length}`);
      const ordered = [...visual].sort(
        (a, b) => Number(a.timeline_in ?? 0) - Number(b.timeline_in ?? 0),
      );
      // Back to back: the second starts where the first ends (a centred crossfade
      // does NOT shift clips in this model, so they abut).
      const gap = Number(ordered[1].timeline_in ?? 0) - Number(ordered[0].timeline_out ?? 0);
      if (Math.abs(gap) > 2) throw new Error(`clips are not back to back (gap ${gap} frames)`);
      // The crossfade lives on the INCOMING clip.
      if (!ordered[1].transition_in) throw new Error("no transition on the second clip");
    },
    expectTrace: (trace) => {
      const imports = called(trace, "import_media");
      if (imports.length < 2) throw new Error(`expected 2 imports, got ${imports.length}`);
      if (imports.length > 3)
        throw new Error(`re-imported the same media (${imports.length} calls)`);
      const exports = called(trace, "export");
      if (exports.length === 0) throw new Error("never produced the deliverable (no export)");
      if (exports.length > 1) throw new Error(`exported ${exports.length}× (should be once)`);
      // Sequence: the deliverable is rendered AFTER the edit, not before it.
      const lastEdit = Math.max(
        firstRound(trace, "add_clips"),
        firstRound(trace, "insert_clips"),
        firstRound(trace, "set_transition"),
      );
      if (lastEdit >= 0 && trace.toolCalls.indexOf(exports[0]) < lastEdit) {
        throw new Error("exported before finishing the edit");
      }
    },
  },

  {
    id: "journey_transcript_captions",
    title: "Caption a narration clip from its transcript and trim the dead air",
    tags: ["journey", "transcript", "captions", "trim"],
    surface: "journey",
    seed: () =>
      timeline([vtrack("v1", 0, [vclip("narration", JOURNEY_NARRATION_REF, 0, NARRATION_END)])], {
        width: 1080,
        height: 1920,
        fps: FPS,
      }),
    prompt:
      "Caption what's said in this clip so the words appear on screen as they're spoken, " +
      "then trim off the dead air after the last word.",
    expectTools: ["get_transcript", "add_text_clips"],
    maxRounds: 14,
    expect: (final) => {
      const texts = textClips(final);
      if (texts.length === 0) throw new Error("no caption/text clips were created");

      // Captions sit inside the spoken span — the frame math is the point here.
      const firstWord = JOURNEY_WORDS[0][2];
      const starts = texts.map((c) => Number(c.timeline_in ?? 0));
      const earliest = Math.min(...starts);
      if (earliest < firstWord - 30 || earliest > JOURNEY_LAST_WORD_FRAME) {
        throw new Error(
          `first caption starts at ${earliest}f; speech runs ${firstWord}..${JOURNEY_LAST_WORD_FRAME}f`,
        );
      }
      for (const c of texts) {
        const tin = Number(c.timeline_in ?? 0);
        const tout = Number(c.timeline_out ?? 0);
        if (tout <= tin) throw new Error(`caption ${c.id} has a non-positive duration`);
        if (tin < 0) throw new Error(`caption ${c.id} starts before the timeline`);
      }

      // Dead air trimmed: the narration must end after the last word but well
      // before the original tail. Generous window — where exactly to cut is taste.
      const narration = (final.tracks ?? [])
        .flatMap((t) => t.clips ?? [])
        .find((c) => c.media_ref === JOURNEY_NARRATION_REF);
      if (!narration) throw new Error("the narration clip is gone");
      const end = Number(narration.timeline_out ?? 0);
      if (end >= NARRATION_END) throw new Error(`dead air not trimmed (still ends at ${end}f)`);
      if (end < JOURNEY_LAST_WORD_FRAME) {
        throw new Error(
          `trimmed into the speech (ends ${end}f, last word at ${JOURNEY_LAST_WORD_FRAME}f)`,
        );
      }
    },
    expectTrace: (trace) => {
      const reads = called(trace, "get_transcript");
      if (reads.length === 0) throw new Error("captioned without reading the transcript");
      const adds = called(trace, "add_text_clips");
      if (adds.length === 0) throw new Error("no add_text_clips call");
      // Read BEFORE writing captions — the ordering that makes them line up.
      if (firstRound(trace, "get_transcript") > firstRound(trace, "add_text_clips")) {
        throw new Error("wrote captions before reading the transcript");
      }
      // Batching: add_text_clips takes an array. One call per word would be a
      // token/latency failure even though every individual call is valid.
      if (adds.length > 4) {
        throw new Error(`${adds.length} add_text_clips calls — should batch into one array`);
      }
    },
  },
];
