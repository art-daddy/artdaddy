// The cases the first eval baseline (27 Nov 2026) showed to be broken, where the rig and not the
// agent failed the run. Each is driven offline through the real harness, agent loop, tools,
// stand-ins and oracle with the model's rounds scripted (reference.ts): the known-right run passes,
// and the run the baseline recorded fails only where the agent was wrong. No network and no model
// is reached (fetch is a spy that throws, and every test checks it was never called).
import { promises as fsp } from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EXTERNAL_FETCH_TOOLS } from "../agent/loop";
import { registerTimelineTools } from "../timeline/ops";
import type { Timeline } from "../timeline/model";
import type { ClientToolContext } from "../tools/context";
import { ClientToolRegistry } from "../tools/registry";
import { EVAL_PAID_TOOLS } from "./checks";
import type { InferenceRequest } from "./harness";
import { caseLibrary, LOOK_TOOLS, registerLookStubs } from "./look";
import { gradeRun } from "./oracle";
import {
  driveScripted,
  type ReferenceCalls as Calls,
  type ReferenceStep as Step,
} from "./reference";
import { ALL_SCENARIOS } from "./scenarios";
import {
  emptyStudioState,
  registerStudioStubs,
  STUDIO_HIGHLIGHTS_URL,
  STUDIO_REPLAY_REF,
  STUDIO_REPLAY_URL,
  STUDIO_SHORT_URL,
  STUDIO_URL,
  studioManageProject,
} from "./studio";
import { HARNESS_UNAVAILABLE, type Scenario, type ToolCall, type Trace } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const WORK = path.resolve("reports", "eval", `baseline-fixes-${process.pid}`);
const byId = (id: string): Scenario => ALL_SCENARIOS.find((s) => s.id === id)!;

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(async () => {
    throw new Error("network blocked in the scripted eval test");
  });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  expect(fetchSpy, "the scripted harness reached the network").not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
afterAll(() => fsp.rm(WORK, { recursive: true, force: true }));

async function drive(id: string, steps: Step[]) {
  const base = byId(id);
  // The final timeline, captured where the oracle hands it to the case's own check.
  let final: Timeline | undefined;
  const scenario = {
    ...base,
    expect: (tl: Timeline) => {
      final = tl;
      base.expect?.(tl);
    },
  } as Scenario;
  const { result, requests } = await driveScripted(scenario, steps, { workDir: WORK });
  expect(result.harnessError).toBeUndefined();
  return { result, requests, final: final! };
}
const why = (r: Awaited<ReturnType<typeof drive>>["result"]) => [
  ...r.tier0.violations,
  ...r.tier1.violations,
  ...(r.harm?.violations ?? []),
];
const calls = (...c: Calls): Step => ({ calls: c });
/** What each tool answered, as the next round's request carried it to the model. Tools of one
 *  round may finish in any order, so a reply is found by its tool's name. */
const replies = (req: InferenceRequest) =>
  (req.round_input.tool_results ?? []).map((r) => r.result as Any);
const reply = (req: InferenceRequest, name: string) =>
  (req.round_input.tool_results ?? []).find((r) => r.name === name)?.result as Any;

describe("web_search costs nothing, so a search nobody asked for is not spending", () => {
  it("search_then_fetch: the baseline's unasked web search no longer fails a run that did the task", async () => {
    const { result } = await drive("search_then_fetch", [
      calls(["youtube_search", { query: "rocket launch full replay" }]),
      calls(["web_search", { query: "rocket launch full replay", site: "youtube.com" }]),
      calls(["download_video", { url: STUDIO_REPLAY_URL, output_name: "replay.mp4" }]),
      calls(["add_clips", { entries: [{ media_ref: STUDIO_REPLAY_REF, timeline_in: 300 }] }]),
      { text: "Added the full replay after your shot." },
    ]);
    expect(why(result)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("no case lists web_search among the paid tools it may use", () => {
    expect(EVAL_PAID_TOOLS.has("web_search")).toBe(false);
    expect(ALL_SCENARIOS.filter((s) => s.paidTools?.includes("web_search"))).toEqual([]);
  });
});

describe("export_redo_with_new_settings counts the exports that ran", () => {
  const first = [calls(["export", {}]), { text: "Exporting." }];

  it("passes the known-right run: export, then cancel it and export at 720p", async () => {
    const { result } = await drive("export_redo_with_new_settings", [
      ...first,
      calls(["manage_exports", { action: "cancel", job_id: "job_1" }]),
      calls(["export", { resolution: "720p" }]),
      { text: "Stopped the first export and started it again at 720p." },
    ]);
    expect(why(result)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("does not count the baseline's refused export as a third render; the refusal fails on its own", async () => {
    const { result } = await drive("export_redo_with_new_settings", [
      calls(["export", { reason: "render the cut", parameters: {} }]),
      ...first,
      calls(["manage_exports", { action: "cancel", job_id: "job_1" }]),
      calls(["export", { resolution: "720p" }]),
      { text: "Restarted at 720p." },
    ]);
    expect(result.trace.toolCalls[0]).toMatchObject({ name: "export", ok: false });
    expect(result.tier1.violations).toEqual([]);
    expect(result.tier0.violations).toEqual(["invariant: 1 tool call(s) errored (budget 0)"]);
    expect(result.passed).toBe(false);
  });

  it("still fails three renders that all ran", async () => {
    const { result } = await drive("export_redo_with_new_settings", [
      ...first,
      calls(["manage_exports", { action: "cancel", job_id: "job_1" }]),
      calls(["export", { resolution: "720p" }], ["export", { resolution: "720p" }]),
      { text: "Done." },
    ]);
    expect(result.tier1.violations.join()).toMatch(/exported 3x for two requests/);
  });
});

describe("library_tag_broll: the b-roll gets the tag, and the person's footage does not", () => {
  const list = calls(["library_op", { action: "list" }]);
  const tag = (...ids: string[]): Step => ({
    calls: ids.map((id) => ["library_op", { action: "update", id, tags: ["broll"] }]),
  });

  it("passes the known-right run: both b-roll clips tagged", async () => {
    const { result } = await drive("library_tag_broll", [
      list,
      tag("media_broll_city", "media_broll_ocean"),
      { text: "Tagged city.mp4 and ocean.mp4 as broll." },
    ]);
    expect(why(result)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("fails what every baseline run did: a.mp4, kept under footage, tagged as b-roll too", async () => {
    const { result } = await drive("library_tag_broll", [
      list,
      tag("media_broll_ocean", "media_broll_city", "a.mp4"),
      { text: "Tagged the city, ocean and launch clips as broll." },
    ]);
    expect(result.tier1.violations.join()).toMatch(
      /tagged as b-roll what the person keeps elsewhere: a\.mp4 \(footage\)/,
    );
    expect(result.passed).toBe(false);
  });

  it("fails a b-roll clip left untagged", async () => {
    const { result } = await drive("library_tag_broll", [
      list,
      tag("media_broll_city"),
      { text: "Done." },
    ]);
    expect(result.tier1.violations.join()).toMatch(/b-roll left untagged: ocean\.mp4/);
  });

  it("keeps what a write changed, and refuses an id the library does not hold", async () => {
    const registry = new ClientToolRegistry();
    registerStudioStubs(registry, emptyStudioState());
    await registry.run("library_op", { action: "update", id: "media_broll_city", tags: ["broll"] });
    const listed = (await registry.run("library_op", { action: "list" })) as Any;
    expect(listed.clips.find((c: Any) => c.id === "media_broll_city").tags).toEqual(["broll"]);
    expect(listed.clips.find((c: Any) => c.id === "a.mp4").tags).toBeUndefined();
    const inBroll = (await registry.run("library_op", { action: "list", folder: "broll" })) as Any;
    expect(inBroll.clips.map((c: Any) => c.id)).toEqual(["media_broll_city", "media_broll_ocean"]);
    for (const action of ["get", "update"])
      expect(await registry.run("library_op", { action, id: "city.mp4" }), action).toMatchObject({
        ok: false,
      });
    const state = (await registry.run("get_project_state", {})) as Any;
    expect(state.library.map((i: Any) => i.media_ref)).toEqual(listed.clips.map((c: Any) => c.id));
  });
});

describe("the YouTube stand-in tells one story about each video", () => {
  const studio = () => {
    const registry = new ClientToolRegistry();
    const state = emptyStudioState();
    registerStudioStubs(registry, state);
    return { registry, state };
  };

  it("lists YouTube links, each as long as its metadata and its download say", async () => {
    const { registry, state } = studio();
    const found = (await registry.run("youtube_search", { query: "rocket launch" })) as Any;
    expect(found.results.map((r: Any) => r.url)).toEqual([
      STUDIO_REPLAY_URL,
      STUDIO_HIGHLIGHTS_URL,
    ]);
    for (const r of found.results) {
      expect(new URL(r.url).hostname).toBe("www.youtube.com");
      expect(r.metadata.duration_s).toBe(r.duration_s);
      const meta = (await registry.run("video_get_metadata", { url: r.url })) as Any;
      expect(meta.metadata.duration_s).toBe(r.duration_s);
      const dl = (await registry.run("download_video", {
        url: r.url,
        output_name: "v.mp4",
      })) as Any;
      expect(dl.duration_s, r.title).toBe(r.duration_s);
    }
    const replay = found.results[0];
    expect([replay.title, replay.duration_s]).toEqual(["Rocket launch — full replay", 754]);
    // What came in is known by its real length, so it places at that length.
    expect(state.imported.find((m) => m.media_ref === STUDIO_REPLAY_REF)?.duration_s).toBe(754);
  });

  it("lists the short only when asked for shorts, as the real tool does", async () => {
    const { registry } = studio();
    const urls = async (args: Record<string, unknown>) =>
      ((await registry.run("youtube_search", { query: "launch", ...args })) as Any).results.map(
        (r: Any) => r.url,
      );
    expect(await urls({})).not.toContain(STUDIO_SHORT_URL);
    expect(await urls({ shorts: true })).toContain(STUDIO_SHORT_URL);
    expect(await urls({ n: 1 })).toEqual([STUDIO_REPLAY_URL]);
  });

  it("downloads the window asked for, and refuses a link it has no video at", async () => {
    const { registry } = studio();
    const part = (await registry.run("download_video", {
      url: STUDIO_REPLAY_URL,
      output_name: "liftoff.mp4",
      start_s: 120,
      end_s: 300,
    })) as Any;
    expect(part.duration_s).toBe(180);
    expect(part.media_ref).not.toBe(STUDIO_REPLAY_REF);
    for (const url of ["https://www.youtube.com/watch?v=Nothing0Here", "https://example.com/nope"])
      expect(
        await registry.run("download_video", { url, output_name: "x.mp4" }),
        url,
      ).toMatchObject({ ok: false });
    // The page the other research stand-ins describe still carries the full replay.
    const page = (await registry.run("video_get_metadata", { url: STUDIO_URL })) as Any;
    expect(page.metadata.duration_s).toBe(754);
  });

  it("search_then_fetch: passes the known-right run, placed whole at the replay's length", async () => {
    const { result, final } = await drive("search_then_fetch", [
      calls(["youtube_search", { query: "rocket launch full replay" }]),
      calls(["download_video", { url: STUDIO_REPLAY_URL, output_name: "replay.mp4" }]),
      calls(["add_clips", { entries: [{ media_ref: STUDIO_REPLAY_REF, timeline_in: 300 }] }]),
      { text: "Added the 12:34 replay after your shot." },
    ]);
    expect(why(result)).toEqual([]);
    expect(result.passed).toBe(true);
    // Placed with no length, it runs what the download reported, as a file placed whole does.
    const replay = final.tracks
      .flatMap((t) => t.clips ?? [])
      .find((c) => c.media_ref === STUDIO_REPLAY_REF)!;
    expect([replay.timeline_in, replay.timeline_out]).toEqual([300, 300 + 754 * 30]);
  });

  it("search_then_fetch: fails the baseline's refusal, and the wrong video", async () => {
    const refused = await drive("search_then_fetch", [
      calls(["youtube_search", { query: "rocket launch full replay" }]),
      { text: "The search only gave placeholder links, so I added nothing." },
    ]);
    expect(refused.result.tier1.violations.join()).toMatch(/never reached the timeline/);
    const wrong = await drive("search_then_fetch", [
      calls(["youtube_search", { query: "rocket launch" }]),
      calls(["download_video", { url: STUDIO_HIGHLIGHTS_URL, output_name: "h.mp4" }]),
      calls([
        "add_clips",
        { entries: [{ media_ref: "media_download_highlights", timeline_in: 300 }] },
      ]),
      { text: "Added it." },
    ]);
    expect(wrong.result.tier1.violations.join()).toMatch(/wrong result/);
    expect(wrong.result.passed).toBe(false);
  });
});

describe("the look cases get the app's free looks and library, and no paid tool", () => {
  const LOOK_CASES = ["make_it_pop", "boost_contrast", "color_warm", "insert_between"];

  it("each runs on the look surface, which offers no tool that bills or fetches", () => {
    for (const id of LOOK_CASES) expect(byId(id).surface, id).toBe("look");
    const base = new ClientToolRegistry();
    registerTimelineTools(base, () => null as unknown as ClientToolContext);
    const registry = new ClientToolRegistry();
    registerTimelineTools(registry, () => null as unknown as ClientToolContext);
    registerLookStubs(
      registry,
      byId("insert_between"),
      emptyStudioState(),
      {
        id: "p",
        name: "My project",
      },
      async () => byId("insert_between").seed(),
    );
    const added = registry.names().filter((n) => !base.has(n));
    expect(added.sort()).toEqual([...LOOK_TOOLS].sort());
    for (const name of registry.names()) {
      expect(EVAL_PAID_TOOLS.has(name), name).toBe(false);
      expect(EXTERNAL_FETCH_TOOLS.has(name), name).toBe(false);
    }
  });

  const looked = (...more: Calls) =>
    calls(["inspect_color", { clip_id: "a" }], ["inspect_media", { clip_id: "a" }], ...more);
  const grade = (args: Record<string, unknown>) =>
    calls(["apply_color", { clip_ids: ["a"], ...args }]);
  const right: Record<string, Step[]> = {
    make_it_pop: [looked(), grade({ contrast: 1.2, saturation: 1.2 }), { text: "Punched it up." }],
    boost_contrast: [looked(), grade({ contrast: 1.25 }), { text: "Contrast up." }],
    color_warm: [looked(), grade({ temperature: 7200, saturation: 1.1 }), { text: "Warmer." }],
  };
  for (const [id, steps] of Object.entries(right))
    it(`${id}: the looks answer, and the known-right grade passes`, async () => {
      const { result, requests } = await drive(id, steps);
      expect(why(result)).toEqual([]);
      expect(result.passed).toBe(true);
      const color = reply(requests[1], "inspect_color");
      const media = reply(requests[1], "inspect_media");
      expect(color.ok && media.ok).toBe(true);
      expect(color.scopes.saturation).toBeLessThan(0.2); // flat, as a request to make it pop implies
      expect(media.note).toMatch(/what the pictures show/);
    });

  for (const id of Object.keys(right))
    it(`${id}: still fails the baseline's run, which looked and then would not grade`, async () => {
      const { result, requests } = await drive(id, [
        looked(["inspect_timeline", { start_frame: 45 }]),
        { text: "I can't see the clip, so I left it unchanged." },
      ]);
      expect(replies(requests[1]).every((r) => r.ok)).toBe(true);
      expect(result.tier0.violations).toEqual([]);
      expect(result.tier1.passed).toBe(false);
    });

  it("says a grade is not measured, so a second look after grading does not read as no change", async () => {
    const { result, requests } = await drive("boost_contrast", [
      grade({ contrast: 1.25 }),
      calls(["inspect_color", { clip_id: "a" }]),
      { text: "Done." },
    ]);
    expect(result.passed).toBe(true);
    expect(reply(requests[2], "inspect_color").note).toMatch(/grade on this clip is not measured/);
  });

  const insert = (ref = "intro.mp4"): Step =>
    calls([
      "insert_clips",
      { at: 30, track_id: "v2", entries: [{ media_ref: ref, duration: 30 }] },
    ]);

  it("insert_between: the library holds the file, and the known-right insert passes", async () => {
    const { result, requests } = await drive("insert_between", [
      calls(["get_project_state", {}]),
      insert(),
      { text: "Inserted intro.mp4 for a second between the clips." },
    ]);
    expect(why(result)).toEqual([]);
    expect(result.passed).toBe(true);
    const state = reply(requests[1], "get_project_state");
    expect(state.library.map((i: Any) => i.media_ref)).toEqual(["a.mp4", "b.mp4", "intro.mp4"]);
    expect(caseLibrary(byId("insert_between")).map((i) => i.media_ref)).toEqual(
      state.library.map((i: Any) => i.media_ref),
    );
  });

  it("insert_between: importing the file the library holds gives its entry, which places as intro.mp4", async () => {
    const { result, requests } = await drive("insert_between", [
      calls(["import_media", { source: { path: "intro.mp4" } }]),
      insert(),
      { text: "Done." },
    ]);
    expect(reply(requests[1], "import_media")).toMatchObject({
      ok: true,
      media_ref: "intro.mp4",
      existed: true,
    });
    expect(result.passed).toBe(true);
  });

  it("insert_between: still fails the baseline's refusal", async () => {
    const { result } = await drive("insert_between", [
      calls(["get_project_state", {}]),
      calls(["library_op", { action: "resolve", id_or_path: "intro.mp4" }]),
      { text: "intro.mp4 isn't in your library, so I changed nothing." },
    ]);
    expect(result.tier0.violations).toEqual([]);
    expect(result.tier1.violations.join()).toMatch(/expected 3 clips, got 2/);
  });

  it("a library write is not offered on the look surface, and is not counted as a failed call", async () => {
    const { result, requests } = await drive("insert_between", [
      calls(["library_op", { action: "update", id: "intro.mp4", tags: ["intro"] }]),
      insert(),
      { text: "Done." },
    ]);
    expect(reply(requests[1], "library_op")).toEqual({ ok: false, error: HARNESS_UNAVAILABLE });
    expect(result.passed).toBe(true);
  });

  // The same class as insert_between: its request names a file, so its library holds it too.
  it("add_clip_after: the library holds outro.mp4, and the known-right append passes", async () => {
    const { result, requests } = await drive("add_clip_after", [
      calls(["library_op", { action: "list" }]),
      calls([
        "add_clips",
        { entries: [{ media_ref: "outro.mp4", track_id: "v2", timeline_in: 60, duration: 60 }] },
      ]),
      { text: "Added two seconds of outro.mp4 right after the clip." },
    ]);
    expect(reply(requests[1], "library_op").clips.map((c: Any) => c.id)).toEqual([
      "a.mp4",
      "outro.mp4",
    ]);
    expect(why(result)).toEqual([]);
    expect(result.passed).toBe(true);
  });
});

describe("project_list_and_open: the projects listed are the projects that open", () => {
  const list = calls(["list_projects", {}]);
  const open = (project: string): Step => calls(["open_project", { project }]);

  it("passes the in-app known-right run: list, point the person to Teaser, and name it", async () => {
    const { result, requests } = await drive("project_list_and_open", [
      list,
      open("proj_teaser"),
      { text: "Your other project is Teaser. Open it from File > Open Project." },
    ]);
    expect(why(result)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(reply(requests[2], "open_project")).toMatchObject({
      ok: true,
      id: "proj_teaser",
      name: "Teaser",
    });
  });

  it("refuses a project the list does not hold, as the real tool does", async () => {
    const { result, requests } = await drive("project_list_and_open", [
      list,
      open("Teaser"),
      { text: "Couldn't open Teaser." },
    ]);
    expect(reply(requests[2], "open_project")).toEqual({
      ok: false,
      error: "project not found: Teaser",
    });
    expect(result.passed).toBe(false);
  });

  it("fails opening the wrong project, and an answer that never names the other one", async () => {
    const wrong = await drive("project_list_and_open", [
      list,
      open("proj_current"),
      { text: "Teaser is your other project." },
    ]);
    expect(wrong.result.tier1.violations.join()).toMatch(/never opened the Teaser project/);
    const unnamed = await drive("project_list_and_open", [
      list,
      open("proj_teaser"),
      { text: "Done." },
    ]);
    expect(unnamed.result.tier1.violations.join()).toMatch(/does not name the other project/);
  });

  // The Copilot lane's host answers manage_project, the MCP-only door, with studioManageProject
  // and records it on the trace; graded here on such a trace.
  const mcpTrace = (rows: Partial<ToolCall>[], finalText: string): Trace => ({
    toolCalls: rows.map((c, i) => ({
      round: i + 1,
      name: c.name ?? "?",
      args: c.args ?? {},
      ok: c.ok ?? true,
    })),
    reasoning: [],
    rounds: rows.length + 1,
    finalText,
    usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 },
  });
  const graded = (rows: Partial<ToolCall>[], text = "Switched to Teaser, your other project.") => {
    const s = byId("project_list_and_open");
    return gradeRun(s, s.seed(), s.seed(), mcpTrace(rows, text));
  };
  const door = (args: Record<string, unknown>, ok = true): Partial<ToolCall> => ({
    name: "manage_project",
    args,
    ok,
  });

  it("over MCP, passes the switch the door makes, and fails pointing at the project instead", () => {
    expect(
      graded([door({ action: "list" }), door({ action: "open", id: "proj_teaser" })]).passed,
    ).toBe(true);
    const pointed = graded(
      [door({ action: "list" }), { name: "open_project", args: { project: "proj_teaser" } }],
      "Teaser is in your project list; open it from File > Open Project.",
    );
    expect(pointed.tier1.violations.join()).toMatch(/never switched to the Teaser project/);
  });

  it("the door's stand-in lists the projects list_projects lists, and opens them", async () => {
    const state = emptyStudioState();
    const registry = new ClientToolRegistry();
    registerStudioStubs(registry, state);
    const listed = (await registry.run("list_projects", {})) as Any;
    const viaDoor = studioManageProject(state, { action: "list" })!;
    expect(viaDoor.reply).toEqual({
      active_id: listed.active_project_id,
      projects: listed.projects.map((p: Any) => ({ id: p.id, name: p.name })),
    });
    expect(studioManageProject(state, { action: "open", id: "proj_teaser" })).toEqual({
      ok: true,
      reply: { opened: "proj_teaser", ready: true },
    });
    expect(studioManageProject(state, { action: "current" })?.reply).toEqual({
      active_id: "proj_teaser",
      name: "Teaser",
    });
    expect(state.opened).toEqual(["proj_teaser"]);
    expect(studioManageProject(state, { action: "open", id: "proj_nope" })?.ok).toBe(false);
    expect(studioManageProject(state, { action: "create", name: "X" })).toBeNull();
  });
});
