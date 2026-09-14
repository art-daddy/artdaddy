// Export scenarios — graded on WHAT THE MODEL DID, not on the final timeline.
//
// Export is the only tool in the catalog that spends the user's time and leaves litter in a
// folder they did not choose. A real recorded session had the agent export the SAME project four
// times in one turn: each render succeeded, the timeline was correct, and the user was left with
// "project.mp4", "project 2.mp4", "project 3.mp4", "project 4.mp4" and a long wait. Every
// final-state grader in this repo scores that green — the timeline is identical either way — so
// the assertions here are all on the trace.
//
// These run on the `journey` surface: real timeline tools, a stand-in export that mirrors the
// real one's QUEUED reply (`status:'exporting'`, a job_id, no file yet) and a real
// `manage_exports`, so "check what happened" is an option the model actually has. Zero spend.
import type { Scenario, Trace } from "../types";
import { timeline, vclip, vtrack } from "./helpers";

const FPS = 30;

const calls = (trace: Trace, name: string) => trace.toolCalls.filter((c) => c.name === name);
/** mp4 renders only — an fcpxml write is not a deliverable render and costs nothing. */
const renders = (trace: Trace) =>
  calls(trace, "export").filter((c) => (c.args?.format ?? "mp4") !== "fcpxml");

/** Models fill every declared optional param with an explicit `null` rather than omitting it
 *  (the convention `contract/strictNulls` exists for), so null is ABSENT, not a value. Reading it
 *  as a value failed a model that had behaved perfectly. */
const given = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/** The one rule every scenario in this file shares. */
function exportedExactlyOnce(trace: Trace): void {
  const n = renders(trace).length;
  if (n === 0) throw new Error("never produced the deliverable (no export)");
  if (n > 1)
    throw new Error(
      `exported ${n}x — every extra render leaves the user another file to sort through`,
    );
}

/** A finished 6-second cut, ready to deliver. */
const readySeed = () =>
  timeline(
    [
      vtrack("v1", 0, [
        vclip("a", "media_a", 0, 90, { source_out: 90 }),
        vclip("b", "media_b", 90, 180, { source_out: 90 }),
      ]),
    ],
    { width: 1920, height: 1080, fps: FPS },
  );

export const EXPORT_SCENARIOS: Scenario[] = [
  {
    id: "export_once",
    title: "A plain export request renders exactly one file",
    tags: ["export", "regression:multi-export"],
    surface: "journey",
    seed: readySeed,
    prompt: "Export this video.",
    expectTools: ["export"],
    maxRounds: 4,
    expectTrace: exportedExactlyOnce,
  },

  {
    id: "export_no_verify_loop",
    title: "Asked to make sure it worked, the model checks instead of re-rendering",
    tags: ["export", "regression:multi-export"],
    surface: "journey",
    // The recorded session almost verbatim. The invitation to verify is the trap: the reply says
    // "exporting", not "saved", so a model that treats re-running the tool as a way to find out
    // starts a second render — and gets the same inconclusive answer again.
    seed: readySeed,
    prompt: "Export the video, and make sure it actually worked.",
    expectTools: ["export"],
    maxRounds: 8,
    // Same rule as export_once; the PROMPT is the variable under test. Checking by any means is
    // fine and is not asserted — naming an approved tool would grade the model on agreeing with
    // me rather than on not filling the user's Downloads folder.
    expectTrace: exportedExactlyOnce,
  },

  {
    id: "export_after_edit",
    title: "The deliverable is rendered after the edit, not before it",
    tags: ["export", "sequencing"],
    surface: "journey",
    seed: readySeed,
    prompt: "Cut the second clip out, then export what's left.",
    expectTools: ["export"],
    maxRounds: 8,
    expect: (final) => {
      const clips = (final.tracks ?? []).flatMap((t) => t.clips ?? []);
      if (clips.length !== 1) throw new Error(`expected 1 clip left, got ${clips.length}`);
    },
    expectTrace: (trace) => {
      exportedExactlyOnce(trace);
      const exportAt = trace.toolCalls.indexOf(renders(trace)[0]);
      const edits = trace.toolCalls.filter((c) =>
        ["remove_clips", "ripple_delete", "split_clips", "move_clips"].includes(c.name),
      );
      if (!edits.length) throw new Error("never made the edit it was asked for");
      const lastEdit = trace.toolCalls.indexOf(edits[edits.length - 1]);
      if (exportAt < lastEdit) throw new Error("exported before finishing the edit");
    },
  },

  {
    id: "export_settings_not_guessed",
    title: "A requested setting is passed as a setting, not baked in another way",
    tags: ["export", "settings"],
    surface: "journey",
    // The failure this catches is the model "helpfully" resizing the CANVAS to get a 720p file,
    // which permanently changes the user's project to deliver one export.
    seed: readySeed,
    prompt: "Export this at 720p.",
    expectTools: ["export"],
    maxRounds: 4,
    expect: (final) => {
      if (Number(final.canvas?.height) !== 1080)
        throw new Error(
          `the project canvas was changed to ${final.canvas?.height}p to do an export`,
        );
    },
    expectTrace: (trace) => {
      exportedExactlyOnce(trace);
      const res = renders(trace)[0].args?.resolution;
      if (res !== "720p")
        throw new Error(`export resolution was ${JSON.stringify(res)}, not "720p"`);
    },
  },

  {
    id: "export_default_destination",
    title: "With no destination named, the model does not invent an absolute path",
    tags: ["export", "destination"],
    surface: "journey",
    // The contract says to OMIT output_path unless the user named a destination, because the
    // model cannot know where the user's Downloads folder is. A guessed path is either refused
    // (a wasted call, which maxToolErrors catches) or silently drops the file somewhere the user
    // will not look — the failure that reads as "my export vanished".
    seed: readySeed,
    prompt: "Render the finished video out for me.",
    expectTools: ["export"],
    maxRounds: 4,
    expectTrace: (trace) => {
      exportedExactlyOnce(trace);
      const out = given(renders(trace)[0].args?.output_path);
      if (out) throw new Error(`invented a destination ('${out}') the user never named`);
    },
  },

  {
    id: "export_named_destination",
    title: "A destination the user DID name is honoured",
    tags: ["export", "destination"],
    surface: "journey",
    // The other direction of the same rule: omitting output_path is right by default and wrong
    // here. A scenario that only tested the default would be satisfied by a model that never
    // passes the parameter at all.
    seed: readySeed,
    prompt: "Export this and save it to C:/Users/eval/Videos/promo.mp4",
    expectTools: ["export"],
    maxRounds: 4,
    expectTrace: (trace) => {
      exportedExactlyOnce(trace);
      const out = given(renders(trace)[0].args?.output_path);
      if (!out) throw new Error("ignored the destination the user gave and used the default");
      if (!out.replace(/\\/g, "/").toLowerCase().endsWith("videos/promo.mp4"))
        throw new Error(`exported to '${out}' instead of the path the user named`);
    },
  },

  {
    id: "export_redo_with_new_settings",
    title: "Changing the settings mid-render cancels the first one rather than stacking",
    tags: ["export", "cancel"],
    surface: "journey",
    // Two renders are CORRECT here — the user changed their mind. What must not happen is both
    // running: the first file is already unwanted, and leaving it queued means the user waits
    // through it and then has to delete it.
    seed: readySeed,
    prompt: "Export this video.",
    followUps: ["Actually make it 720p instead."],
    expectTools: ["export", "manage_exports"],
    maxRounds: 10,
    expectTrace: (trace) => {
      const n = renders(trace).length;
      if (n < 2) throw new Error("never re-exported at the new setting");
      if (n > 2) throw new Error(`exported ${n}x for two requests`);
      const cancelled = calls(trace, "manage_exports").filter((c) => c.args?.action === "cancel");
      if (!cancelled.length)
        throw new Error("left the unwanted first render queued instead of cancelling it");
      if (renders(trace)[1].args?.resolution !== "720p")
        throw new Error("the second export did not use the new setting");
    },
  },
];
