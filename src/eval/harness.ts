// The scenario driver — seeds a real fs-backed project, drives the REAL client
// agent loop (ClientTurnRunner) in autopilot against the REAL model via /inference,
// executing REAL timeline tools, then captures the full trace + scores it. Mirrors
// src/agent/synclock.e2e.ts, generalized to any scenario + model + budget guard.
//
// Timeline-only tool surface (like synclock): guarantees ZERO surprise generation/
// network spend. A non-timeline tool the model reaches for is recorded as
// `notRunInHarness` (a signal), not a real error.
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ClientTurnRunner, type LoopDeps } from "../agent/loop";
import type { RoundInput, RoundResultDTO, Usage } from "../agent/types";
import { authHeaders } from "../api/auth";
import { ensureTimeline, loadTimeline } from "../timeline/engine";
import { registerTimelineTools } from "../timeline/ops";
import { setProjectSettingsTool } from "../tools/project";
import type { CommandResult, CommandRunner } from "../tools/command";
import type { ClientToolContext } from "../tools/context";
import { ClientToolRegistry } from "../tools/registry";
import { INTERNAL_DIR, ProjectStoreAccess, joinPath, type FsLike } from "../tools/store";
import { evalTier0, evalTier1 } from "./oracle";
import { registerJourneyStubs } from "./journey";
import {
  emptyStudioState,
  registerStudioStubs,
  studioRefIsAudio,
  type StudioState,
} from "./studio";
import { ProjectDocument } from "../project/ProjectDocument";
import { setOpenDocumentResolver } from "../project/openDocuments";
import { asProjectId } from "../project/types";
import { type Budget, costFromUsage } from "./pricing";
import { analyzeTrace } from "./signals";
import {
  HARNESS_UNAVAILABLE as HARNESS_MARK,
  type Scenario,
  type ScenarioResult,
  type ToolCall,
  type Trace,
} from "./types";

const nodeFs: FsLike = {
  async exists(p) {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  },
  readTextFile: (p) => fsp.readFile(p, "utf8"),
  async writeTextFile(p, c) {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, c);
  },
  async mkdir(p) {
    await fsp.mkdir(p, { recursive: true });
  },
};

const probeRunner: CommandRunner = {
  run: async (program, args): Promise<CommandResult> => {
    // Timeline-only harness: no real files to probe. Emulate a plain VIDEO source
    // for STREAM probes so a newly added media_ref (e.g. outro.mp4) places as video.
    // A code-0/empty ffprobe reads as "no video stream" and misfires sourceHasVideo,
    // downgrading the clip to audio (which then can't sit on a video track) — the
    // add_clip_after / insert_between failure. Report a video stream, no audio;
    // everything else (duration, etc.) stays a benign no-op.
    if (program === "ffprobe" && args.includes("-select_streams")) {
      // Sources must have a SIZE, or every rule that depends on one (how far a clip may be
      // zoomed before it stops being a picture) is invisible to every scenario. A ref that
      // names its resolution gets it; anything else is 1080p, the common case.
      if (args.includes("stream=width,height")) {
        const ref = String(args[args.length - 1] ?? "");
        return { code: 0, stdout: /480p/i.test(ref) ? "854,480" : "1920,1080", stderr: "" };
      }
      const kind = args[args.indexOf("-select_streams") + 1];
      // ...but an AUDIO asset must not claim a video stream, or a generated
      // voiceover/music bed would place onto a video track and every audio
      // scenario would fail on the harness instead of on the model.
      const audio = args.some((a) => typeof a === "string" && studioRefIsAudio(a));
      if (audio) return { code: 0, stdout: kind === "a" ? "0" : "", stderr: "" };
      return { code: 0, stdout: kind === "v" ? "0" : "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  },
};

export interface DriveOpts {
  server: string;
  budget: Budget;
  effort?: string; // reasoning effort, default "high"
  mode?: string; // loop mode, default "autopilot"
}

/** What the tools handed back across a scenario. Reported per run so payload shaping can be
 *  sized from data: `usage.inputTokens` cannot answer it, because a cached round bills a fat
 *  payload the same as a lean one. */
function payloadOf(calls: ToolCall[]): Trace["payload"] {
  let total = 0;
  let max = 0;
  let maxTool = "";
  for (const c of calls) {
    const n = c.resultChars ?? 0;
    total += n;
    if (n > max) {
      max = n;
      maxTool = c.name;
    }
  }
  return { resultChars: total, maxResultChars: max, maxResultTool: maxTool };
}

/** Drive one (scenario × model) run end-to-end and return its scored result. */
export async function driveScenario(
  scenario: Scenario,
  model: string,
  opts: DriveOpts,
): Promise<ScenarioResult> {
  const started = Date.now();
  const toolCalls: ToolCall[] = [];
  const reasoning: string[] = [];
  let rounds = 0;
  let finalText = "";
  let providerError = "";
  const usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 };
  // `prompt` is persisted so a later reader (report, LLM judge) can grade what the
  // model did against what was actually asked, not just the scenario's title.
  const meta = {
    scenarioId: scenario.id,
    title: scenario.title,
    prompt: scenario.prompt,
    tags: scenario.tags ?? [],
    model,
  };
  let docCleanup: (() => Promise<void>) | null = null;

  try {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `artdaddy-eval-${scenario.id}-`));
    const store = new ProjectStoreAccess(dir, nodeFs);
    await ensureTimeline(store);
    // Seed by WRITING timeline.json, not via replaceTimeline: that path restores
    // into an open ProjectDocument's live session and is a documented no-op for a
    // bare store (`return false`), which silently left every scenario running on an
    // EMPTY timeline. Write-then-verify so a future change can't reintroduce that.
    await store.writeTextAtomic(
      joinPath(dir, INTERNAL_DIR, "timeline.json"),
      JSON.stringify(scenario.seed(), null, 2),
    );
    const seeded = await loadTimeline(store);
    const wantTracks = (scenario.seed().tracks ?? []).length;
    if ((seeded.tracks ?? []).length !== wantTracks) {
      throw new Error(
        `seed failed: wrote ${wantTracks} track(s), read back ${(seeded.tracks ?? []).length}`,
      );
    }

    // Every mutation now commits through an open ProjectDocument (applyOp rejects a
    // bare store with "no open project for this store"), so the harness must open one
    // exactly like the app does — otherwise EVERY editing scenario fails on the
    // harness rather than on the model.
    // Keyed by the temp dir's BASENAME: that is how the coordinator maps a store's
    // projectDir onto a document id.
    const projectId = asProjectId(path.basename(dir));
    const doc = new ProjectDocument(projectId, {
      open: async () => "loaded",
      dispose: async () => {},
    });
    await doc.open();
    setOpenDocumentResolver((id) => (String(id) === String(projectId) ? doc : undefined));
    docCleanup = async () => {
      setOpenDocumentResolver(() => undefined);
      await doc.close().catch(() => undefined);
    };
    const ctx = { store, runner: probeRunner } as ClientToolContext;

    const registry = new ClientToolRegistry();
    registerTimelineTools(registry, () => ctx);
    // The canvas tool lives with the PROJECT tools (it edits the active timeline and
    // mirrors the result into project.json), so the timeline-only surface has to opt
    // it in explicitly or every canvas scenario silently loses its only tool.
    registry.register("set_project_settings", (args) => setProjectSettingsTool(args, ctx));
    // A workflow scenario also needs import / transcript / export. Those are
    // deterministic stand-ins (see journey.ts) so the run still costs nothing
    // beyond the model itself and cannot touch the network. The "studio" surface
    // widens that to the WHOLE non-timeline catalog (see studio.ts) — same rule:
    // no network, no paid inference, no ffmpeg.
    const studio: StudioState = emptyStudioState();
    if (scenario.surface === "journey") registerJourneyStubs(registry, studio);
    else if (scenario.surface === "studio") registerStudioStubs(registry, studio);

    let snapshot: Record<string, unknown> | null = null;
    const infer = async (roundInput: RoundInput): Promise<RoundResultDTO> => {
      const res = await fetch(`${opts.server}/inference`, {
        method: "POST",
        // This posts to /inference itself rather than going through src/agent/api.ts, so it
        // has to carry the auth header too — against a gated server it 401s without one.
        headers: { "Content-Type": "application/json", ...(await authHeaders()) },
        body: JSON.stringify({
          round_input: roundInput,
          provider_snapshot: snapshot,
          model,
          effort: opts.effort ?? "high",
          mode: opts.mode ?? "autopilot",
        }),
      });
      if (!res.ok) throw new Error(`/inference ${res.status}: ${await res.text().catch(() => "")}`);
      const dto = (await res.json()) as RoundResultDTO;
      snapshot = dto.provider_snapshot ?? snapshot;
      rounds += 1;
      const u: Usage = dto.usage ?? {};
      usage.inputTokens += u.input_tokens ?? 0;
      usage.outputTokens += u.output_tokens ?? 0;
      usage.reasoningTokens += u.reasoning_tokens ?? 0;
      const cost = costFromUsage(model, u);
      usage.costUsd += cost;
      opts.budget.add(cost);
      return dto;
    };

    const deps: LoopDeps = {
      infer,
      runTool: async (name, args) => {
        const a = (args ?? {}) as Record<string, unknown>;
        if (!registry.has(name)) {
          toolCalls.push({ round: rounds, name, args: a, ok: false, error: HARNESS_MARK });
          return { ok: false, error: `tool '${name}' is not available in this eval harness` };
        }
        const r = (await registry.run(name, a)) as { ok?: boolean; error?: string };
        const ok = r?.ok !== false;
        const serialized = JSON.stringify(r ?? null);
        toolCalls.push({
          round: rounds,
          name,
          args: a,
          ok,
          result: serialized.slice(0, 1200),
          resultChars: serialized.length,
          error: ok ? undefined : String(r?.error ?? ""),
        });
        return r;
      },
      emit: (event, data) => {
        if (event === "text" && typeof data.text === "string") finalText = data.text;
        if (event === "reasoning" && typeof data.text === "string") reasoning.push(data.text);
        // A provider failure comes back as HTTP 200 with kind:"error", so res.ok proves nothing
        // and the runner just ends the turn. Left unhandled it scores as rounds=1, zero tool
        // calls, empty text — indistinguishable from "the model chose to do nothing", which is
        // how 24 scenarios in one campaign were recorded as capability gaps.
        if (event === "error") providerError = String(data.error ?? "unknown provider error");
      },
      mode: () => (opts.mode ?? "autopilot") as "autopilot",
      stopped: () => opts.budget.exceeded(),
      onUsage: () => {},
      session: () => ({}),
    };

    const runner = new ClientTurnRunner(deps);
    await runner.start(scenario.prompt);
    if (providerError) throw new Error(`provider error: ${providerError}`);
    // Multi-turn: replay each follow-up as a new user turn on the SAME runner
    // (timeline + provider continuity carry over) before scoring the final state.
    for (const followUp of scenario.followUps ?? []) {
      if (opts.budget.exceeded()) break;
      await runner.start(followUp);
      if (providerError) throw new Error(`provider error: ${providerError}`);
    }

    const final = await loadTimeline(store);
    const trace: Trace = {
      toolCalls,
      reasoning,
      rounds,
      finalText,
      usage,
      payload: payloadOf(toolCalls),
    };
    // A wasted tool call can BE the regression, so tool errors fail the run (tier0
    // only looks at the end state, which the model usually still reaches). The
    // budget defaults to 0 and is raised only by a scenario that provokes an error
    // on purpose — see evalTier0.
    const tier0 = evalTier0(final, trace, scenario.maxToolErrors ?? 0);
    const tier1 = evalTier1(scenario, final, trace);
    const signals = analyzeTrace(scenario, trace, tier0.violations);
    await docCleanup?.();
    docCleanup = null;
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);

    return {
      ...meta,
      wallMs: Date.now() - started,
      passed: tier0.passed && tier1.passed,
      tier0,
      tier1,
      signals,
      trace,
    };
  } catch (e) {
    await docCleanup?.();
    const trace: Trace = {
      toolCalls,
      reasoning,
      rounds,
      finalText,
      usage,
      payload: payloadOf(toolCalls),
    };
    const empty = { passed: false, violations: [] as string[] };
    return {
      ...meta,
      wallMs: Date.now() - started,
      passed: false,
      tier0: empty,
      tier1: empty,
      signals: analyzeTrace(scenario, trace, []),
      trace,
      harnessError: e instanceof Error ? e.message : String(e),
    };
  }
}
