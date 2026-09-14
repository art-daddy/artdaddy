// Falsifiability net for the EXPORT eval graders — runs without the model.
//
// WHY THIS EXISTS: these graders are the only thing standing between us and shipping the
// four-exports-per-request bug again, and every one of them is a hand-written function that
// could quietly accept anything. So each is shown to REJECT the real wrong outcome, not merely
// to accept the right one. The wrong outcomes below are the ones actually recorded in user
// sessions: rendering again to find out whether the render worked, resizing the project to
// deliver one file, inventing a destination path, and leaving an abandoned render queued.
//
// It also pins the fidelity of the export STAND-IN. The stub used to reply as though the file
// were already written; against that reply none of these scenarios can reproduce anything,
// because the trap only exists when the honest answer is "still exporting".
import { describe, expect, it } from "vitest";

import { registerJourneyStubs, type JourneyState } from "./journey";
import { EXPORT_SCENARIOS } from "./scenarios/exports";
import { timeline, vclip, vtrack } from "./scenarios/helpers";
import { ClientToolRegistry } from "../tools/registry";
import type { Scenario, ToolCall, Trace } from "./types";
import type { Timeline } from "../timeline/model";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const byId = (id: string): Scenario => {
  const s = EXPORT_SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`export scenario ${id} not found`);
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
  rounds: calls.length,
  finalText: "done",
  usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 },
});

const grade = (id: string, t: Trace) => byId(id).expectTrace!(t);
const gradeTimeline = (id: string, tl: Timeline) => byId(id).expect!(tl);

const EXPORT = { name: "export", args: {} };

describe("export graders reject the outcomes that were actually shipped", () => {
  it("catches the four-exports-in-one-turn session", () => {
    // The recorded trace, reduced to its shape. Every call succeeded and the timeline was
    // correct — which is why a final-state grader scored this green while the user watched four
    // renders and ended up with four files.
    const fourTimes = trace([{ name: "add_clips" }, EXPORT, EXPORT, EXPORT, EXPORT]);
    expect(() => grade("export_once", fourTimes)).toThrow(/exported 4x/);
    expect(() => grade("export_once", trace([{ name: "add_clips" }, EXPORT]))).not.toThrow();
  });

  it("catches an export that never happened at all", () => {
    // The opposite failure, and the reason "count === 1" is the rule rather than "count <= 1":
    // a model that only SAYS it exported passes any ceiling-shaped check.
    expect(() => grade("export_once", trace([{ name: "add_clips" }]))).toThrow(/no export/);
  });

  it("allows checking an export, but not re-rendering to check it", () => {
    const checked = trace([EXPORT, { name: "manage_exports", args: { action: "list" } }]);
    expect(() => grade("export_no_verify_loop", checked)).not.toThrow();
    // Inspecting the timeline is equally fine — the grader must not privilege one way of
    // checking, or it grades agreement with me instead of the user's disk.
    expect(() =>
      grade("export_no_verify_loop", trace([EXPORT, { name: "inspect_timeline" }])),
    ).not.toThrow();
    expect(() => grade("export_no_verify_loop", trace([EXPORT, EXPORT]))).toThrow(/exported 2x/);
  });

  it("catches exporting before the edit is finished", () => {
    const backwards = trace([EXPORT, { name: "remove_clips" }]);
    expect(() => grade("export_after_edit", backwards)).toThrow(/before finishing the edit/);
    expect(() =>
      grade("export_after_edit", trace([{ name: "remove_clips" }, EXPORT])),
    ).not.toThrow();
  });

  it("catches an edit that was asked for and never made", () => {
    expect(() => grade("export_after_edit", trace([EXPORT]))).toThrow(/never made the edit/);
  });

  it("catches resizing the project to deliver one export", () => {
    // Recorded behaviour: asked for a 720p file, the model changed the CANVAS. The export is
    // right and the user's project is permanently wrong.
    const shrunk = timeline([vtrack("v1", 0, [vclip("a", "media_a", 0, 90)])], {
      width: 1280,
      height: 720,
      fps: 30,
    }) as Timeline;
    expect(() => gradeTimeline("export_settings_not_guessed", shrunk)).toThrow(
      /canvas was changed/,
    );
    const intact = timeline([vtrack("v1", 0, [vclip("a", "media_a", 0, 90)])], {
      width: 1920,
      height: 1080,
      fps: 30,
    }) as Timeline;
    expect(() => gradeTimeline("export_settings_not_guessed", intact)).not.toThrow();
  });

  it("catches a requested setting being dropped", () => {
    expect(() => grade("export_settings_not_guessed", trace([EXPORT]))).toThrow(/not "720p"/);
    expect(() =>
      grade(
        "export_settings_not_guessed",
        trace([{ name: "export", args: { resolution: "720p" } }]),
      ),
    ).not.toThrow();
  });

  it("catches a destination the model invented", () => {
    // The model cannot know where the user's Downloads folder is, so a path it supplies is a
    // guess — and a guess that lands the file somewhere the user never looks.
    const guessed = trace([
      { name: "export", args: { output_path: "C:/Users/me/Downloads/out.mp4" } },
    ]);
    expect(() => grade("export_default_destination", guessed)).toThrow(/invented a destination/);
    expect(() => grade("export_default_destination", trace([EXPORT]))).not.toThrow();
  });

  it("reads an explicit null param as ABSENT, not as a value", () => {
    // A live run failed on exactly this: the model filled every declared optional with `null`
    // instead of omitting it — the convention src/contract/strictNulls guards — and a grader
    // testing `!== undefined` called perfect behaviour a bug. Both directions, since the named
    // -destination scenario has to read the same null as "you did not give me one".
    const nulls = trace([
      {
        name: "export",
        args: { format: "mp4", output_path: null, resolution: "source", fps: null },
      },
    ]);
    expect(() => grade("export_default_destination", nulls)).not.toThrow();
    expect(() => grade("export_named_destination", nulls)).toThrow(/ignored the destination/);
  });

  it("catches a destination the user named being ignored", () => {
    // Both directions of one rule: omitting output_path is correct by default and wrong here.
    expect(() => grade("export_named_destination", trace([EXPORT]))).toThrow(
      /ignored the destination/,
    );
    expect(() =>
      grade(
        "export_named_destination",
        trace([{ name: "export", args: { output_path: "C:/Users/eval/Videos/promo.mp4" } }]),
      ),
    ).not.toThrow();
    expect(() =>
      grade(
        "export_named_destination",
        trace([{ name: "export", args: { output_path: "C:/somewhere/else.mp4" } }]),
      ),
    ).toThrow(/instead of the path the user named/);
  });

  it("catches an abandoned render left queued when the settings changed", () => {
    const stacked = trace([EXPORT, { name: "export", args: { resolution: "720p" } }]);
    expect(() => grade("export_redo_with_new_settings", stacked)).toThrow(/instead of cancelling/);
    const cancelled = trace([
      EXPORT,
      { name: "manage_exports", args: { action: "cancel", job_id: "job_1" } },
      { name: "export", args: { resolution: "720p" } },
    ]);
    expect(() => grade("export_redo_with_new_settings", cancelled)).not.toThrow();
  });

  it("does not count an fcpxml write as a render", () => {
    // fcpxml is synchronous, writes no video and costs no time; counting it would fail a model
    // that correctly gave the user both an editable timeline and a file.
    const both = trace([{ name: "export", args: { format: "fcpxml" } }, EXPORT]);
    expect(() => grade("export_once", both)).not.toThrow();
  });
});

describe("the export stand-in tells the model the truth", () => {
  const state = (): JourneyState => ({ imported: [], exports: [] });
  const reg = (s: JourneyState) => {
    const r = new ClientToolRegistry();
    registerJourneyStubs(r, s);
    return r;
  };
  const run = async (r: ClientToolRegistry, name: string, args: Record<string, unknown> = {}) =>
    (await r.run(name, args)) as Any;

  it("reports a QUEUED job, not a saved file", async () => {
    // The whole export lane depends on this. If the stub says the file is written, "make sure it
    // worked" has an obvious answer and the re-export trap never springs.
    const res = await run(reg(state()), "export");
    expect(res.ok).toBe(true);
    expect(res.status).toBe("exporting");
    expect(res.job_id).toBeTruthy();
    expect(res).not.toHaveProperty("saved");
  });

  it("refuses a relative output_path with the same words the real tool uses", async () => {
    // "export it as final.mp4" pushes a model straight at this. A stub that accepted it would
    // hide a refusal every real user would hit.
    const res = await run(reg(state()), "export", { output_path: "final.mp4" });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/absolute path/);
  });

  it("de-dupes the default destination instead of overwriting", async () => {
    const s = state();
    const r = reg(s);
    const first = await run(r, "export");
    const second = await run(r, "export");
    expect(second.saved_to).not.toBe(first.saved_to);
    expect(second.saved_to).toMatch(/ 2\.mp4$/);
  });

  it("queues the second render behind the first", async () => {
    const s = state();
    const r = reg(s);
    expect((await run(r, "export")).queue_position).toBe(0);
    expect((await run(r, "export")).status).toBe("queued");
  });

  it("can be asked what happened, and can cancel", async () => {
    const s = state();
    const r = reg(s);
    const job = await run(r, "export");
    expect((await run(r, "manage_exports", { action: "list" })).jobs).toHaveLength(1);
    expect((await run(r, "manage_exports", { action: "cancel", job_id: job.job_id })).ok).toBe(
      true,
    );
    expect(s.exports[0].status).toBe("cancelled");
    const missing = await run(r, "manage_exports", { action: "cancel", job_id: "nope" });
    expect(missing.ok).toBe(false);
  });

  it("frees the filename again once an export is cancelled", async () => {
    // A cancelled render writes nothing, so the retry gets the original name back. The stub used
    // to count it and hand back "name 2.mp4" — and a live model repeated that invented filename
    // to the user, which is exactly the fiction a stand-in must never teach.
    const s = state();
    const r = reg(s);
    const first = await run(r, "export");
    await run(r, "manage_exports", { action: "cancel", job_id: first.job_id });
    const retry = await run(r, "export");
    expect(retry.saved_to).toBe(first.saved_to);
    expect(retry.status).toBe("exporting"); // and it is not queued behind a cancelled job
  });
});
