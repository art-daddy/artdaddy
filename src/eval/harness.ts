// The scenario driver — seeds a real fs-backed project, drives the REAL client
// agent loop (ClientTurnRunner) in autopilot against the REAL model via /inference,
// executing REAL timeline tools, then captures the full trace + scores it. Mirrors
// src/agent/synclock.e2e.ts, generalized to any scenario + model + budget guard.
// A test can pass `send` to script the model's rounds: the same loop, tools, oracle and
// records then run with no network and no model.
//
// Timeline-only tool surface (like synclock): guarantees ZERO surprise generation/
// network spend. A non-timeline tool the model reaches for is recorded as
// `notRunInHarness` (a signal), not a real error.
import { randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ClientTurnRunner, type LoopDeps } from "../agent/loop";
import { composeModelText } from "../agent/compose";
import { readStateBlock } from "../agent/stateBlock";
import { agentEventContext } from "../api/agentEvents";
import type { RoundInput, RoundResultDTO, Usage } from "../agent/types";
import { authedFetch } from "../api/auth";
import { catalogIdentity } from "../contract";
import { DEFAULT_EFFORT } from "../store/chatControls";
import { ensureTimeline, loadTimeline } from "../timeline/engine";
import { registerTimelineTools } from "../timeline/ops";
import { setProjectSettingsTool } from "../tools/project";
import type { CommandResult, CommandRunner } from "../tools/command";
import type { ClientToolContext } from "../tools/context";
import { ClientToolRegistry } from "../tools/registry";
import { INTERNAL_DIR, ProjectStoreAccess, joinPath, type FsLike } from "../tools/store";
import { gradeRun } from "./oracle";
import { stageFaults } from "./faults";
import { registerJourneyStubs } from "./journey";
import {
  emptyStudioState,
  registerStudioStubs,
  studioRefIsAudio,
  type StudioState,
} from "./studio";
import { registerLookStubs } from "./look";
import { ProjectDocument } from "../project/ProjectDocument";
import { setOpenDocumentResolver } from "../project/openDocuments";
import { asProjectId } from "../project/types";
import { type Budget, costFromUsage } from "./pricing";
import { analyzeTrace } from "./signals";
import type { CampaignSetup } from "./setup";
import { RecoveryRuntime, recoveryContext, recoveryProjectDir } from "./recovery";
import {
  HARNESS_UNAVAILABLE as HARNESS_MARK,
  type RoundClock,
  type RunClocks,
  type RunSetup,
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
    // Sources must have a SIZE, or every rule that depends on one (how far a clip may be
    // zoomed before it stops being a picture) is invisible to every scenario. A ref that
    // names its resolution gets it; anything else is 1080p, the common case. Answered in the
    // shape the size owner (tools/media probePath) asks for: if this stops matching, sizes
    // silently become unknown and the zoom ceiling is skipped in every scenario.
    if (program === "ffprobe" && args.includes("-show_streams")) {
      const ref = String(args[args.length - 1] ?? "");
      if (studioRefIsAudio(ref))
        return { code: 0, stdout: JSON.stringify({ format: {}, streams: [] }), stderr: "" };
      const [width, height] = /480p/i.test(ref) ? [854, 480] : [1920, 1080];
      return {
        code: 0,
        stdout: JSON.stringify({
          format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
          streams: [{ codec_type: "video", width, height }],
        }),
        stderr: "",
      };
    }
    // Timeline-only harness: no real files to probe. Emulate a plain VIDEO source
    // for STREAM probes so a newly added media_ref (e.g. outro.mp4) places as video.
    // A code-0/empty ffprobe reads as "no video stream" and misfires sourceHasVideo,
    // downgrading the clip to audio (which then can't sit on a video track) — the
    // add_clip_after / insert_between failure. Report a video stream, no audio;
    // everything else (duration, etc.) stays a benign no-op.
    if (program === "ffprobe" && args.includes("-select_streams")) {
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

/** The harness's stand-in for ffprobe, exposed so a guard test can prove sizes still reach the zoom
 *  rule through it (if its answers stop matching what the size owner asks, every scenario silently
 *  loses that rule). */
export const harnessProbeRunner: CommandRunner = probeRunner;

/** The stand-in ffprobe, plus how long the media the import stand-in brought in runs. Without it a
 *  file placed whole got the 5 s that a source of unknown length defaults to, while the import had
 *  told the model it runs 10 s. */
function probeWithImports(
  imported: () => readonly { media_ref: string; duration_s: number }[],
): CommandRunner {
  return {
    run: async (program, args) => {
      if (program === "ffprobe" && args.includes("format=duration")) {
        const source = String(args[args.length - 1] ?? "");
        const hit = imported().find((m) => m.media_ref === source);
        if (hit) return { code: 0, stdout: String(hit.duration_s), stderr: "" };
      }
      return probeRunner.run(program, args);
    },
  };
}

/** What every eval project is called, as a person's own project would be. Named after the case,
 *  it told the model what the task was before it read the request. */
export const EVAL_PROJECT_NAME = "My project";

/** Make a run's project folder inside its temp folder, named the way the app names a new project
 *  (its name's slug and six hex digits, tools/project.ts). The folder's name is the project id the
 *  model is shown; the case's id stays on the temp folder above it. */
async function evalProjectDir(root: string): Promise<string> {
  const dir = path.join(root, `my_project_${randomBytes(3).toString("hex")}`);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/** The JSON body of one /inference round, as the harness sends it. */
export interface InferenceRequest {
  round_input: RoundInput;
  provider_snapshot: Record<string, unknown> | null;
  model: string;
  effort: string;
  mode: string;
  catalog_id: string;
  app_version: string;
}

export interface DriveOpts {
  server: string;
  budget: Budget;
  effort?: string; // reasoning effort, default the picker's (store/chatControls.ts)
  mode?: string; // loop mode, default "autopilot"
  artifactDir?: string;
  /** What the campaign runs against (eval.e2e.ts reads it once); recorded on every run. */
  setup?: CampaignSetup;
  /** Sends one round. Default: POST it to `${server}/inference`. A test passes a scripted one,
   *  which drives the same loop, tools, oracle and records with no network and no model. */
  send?: (request: InferenceRequest) => Promise<RoundResultDTO>;
  /** Where each run's throwaway project folder is made (default: the OS temp folder). */
  workDir?: string;
}

/** What a round reports that the app's Usage type does not name (yet). */
type RoundUsage = Usage & { cached_tokens?: number; credits?: number };

/** Wall time covered by a set of [start, end) intervals: parallel tool calls count once. */
function coveredMs(spans: [number, number][]): number {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let end = -Infinity;
  for (const [s, e] of sorted) {
    if (e <= end) continue;
    total += e - Math.max(s, end);
    end = e;
  }
  return total;
}

const FIRST_TOKEN_NOTE =
  "not measured: the harness sends each round to /inference, which answers the whole round at once; " +
  "a first-token time needs the streamed route (/inference/stream)";

/** Per-round model and tool time, from the rounds' clocks and the calls each round asked for. */
function clocksOf(rounds: RoundClock[], calls: ToolCall[]): RunClocks {
  const byRound = new Map<number, [number, number][]>();
  for (const c of calls) {
    if (typeof c.startMs !== "number" || typeof c.ms !== "number") continue;
    const spans = byRound.get(c.round) ?? [];
    spans.push([c.startMs, c.startMs + c.ms]);
    byRound.set(c.round, spans);
  }
  const out = rounds.map((r) => {
    const spans = byRound.get(r.round) ?? [];
    return { ...r, toolMs: Math.round(coveredMs(spans)), tools: spans.length };
  });
  return {
    rounds: out,
    modelMs: out.reduce((n, r) => n + r.modelMs, 0),
    toolMs: out.reduce((n, r) => n + r.toolMs, 0),
    firstTokenNote: FIRST_TOKEN_NOTE,
  };
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
  const now = (): number => Date.now() - started;
  const toolCalls: ToolCall[] = [];
  const reasoning: string[] = [];
  let rounds = 0;
  let turn = 0;
  let finalText = "";
  const turnTexts: string[] = [];
  let recovery: RecoveryRuntime | null = null;
  let providerError = "";
  let roundLimitReached = false;
  // The person's Stop (Scenario.stopAfter): set once the turn's calls reach the stop point.
  let stopPressed = false;
  const usage: Trace["usage"] = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    cachedTokens: 0,
    credits: null,
    costUnknownRounds: 0,
  };
  const effort = opts.effort ?? DEFAULT_EFFORT;
  const mode = opts.mode ?? "autopilot";
  const appVersion = process.env.ARTDADDY_EVAL_APP_VERSION ?? "0.24.0";
  const setup: RunSetup = {
    model,
    effort,
    mode,
    catalogId: catalogIdentity(),
    appVersion,
    appGitSha: opts.setup?.appGitSha ?? null,
    appGitDirty: opts.setup?.appGitDirty ?? null,
    server: opts.setup?.server ?? opts.server ?? null,
    serverVersion: opts.setup?.serverVersion ?? null,
    serverBuild: opts.setup?.serverBuild ?? null,
    promptSha256: opts.setup?.promptSha256 ?? null,
    preload: process.env.ARTDADDY_EVAL_PRELOAD === "1",
  };
  const roundClocks: RoundClock[] = [];
  // `prompt` is persisted so a later reader (report, LLM judge) can grade what the
  // model did against what was actually asked, not just the scenario's title.
  const meta = {
    scenarioId: scenario.id,
    title: scenario.title,
    prompt: scenario.prompt,
    tags: scenario.tags ?? [],
    model,
    ...(scenario.knownFailure ? { knownFailure: scenario.knownFailure } : {}),
  };
  let docCleanup: (() => Promise<void>) | null = null;
  let dir: string | null = null;

  try {
    if (opts.workDir) await fsp.mkdir(opts.workDir, { recursive: true });
    dir = await fsp.mkdtemp(
      path.join(opts.workDir ?? os.tmpdir(), `artdaddy-eval-${scenario.id}-`),
    );
    const realContext =
      scenario.surface === "recovery" ? recoveryContext(recoveryProjectDir(dir)) : null;
    const store = realContext?.store ?? new ProjectStoreAccess(await evalProjectDir(dir), nodeFs);
    await ensureTimeline(store);
    // Seed by WRITING timeline.json, not via replaceTimeline: that path restores
    // into an open ProjectDocument's live session and is a documented no-op for a
    // bare store (`return false`), which silently left every scenario running on an
    // EMPTY timeline. Write-then-verify so a future change can't reintroduce that.
    await store.writeTextAtomic(
      joinPath(store.projectDir, INTERNAL_DIR, "timeline.json"),
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
    // Keyed by the project folder's BASENAME: that is how the coordinator maps a store's
    // projectDir onto a document id.
    const projectId = asProjectId(path.basename(store.projectDir));
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
    // What the journey and studio stand-ins record (imports among it), read by the probe below.
    const studio: StudioState = emptyStudioState();
    const ctx =
      realContext ??
      ({ store, runner: probeWithImports(() => studio.imported) } as ClientToolContext);

    const registry = new ClientToolRegistry();
    registerTimelineTools(registry, () => ctx);
    // The canvas tool lives with the PROJECT tools (it edits the active timeline and
    // mirrors the result into project.json), so the timeline-only surface has to opt
    // it in explicitly or every canvas scenario silently loses its only tool.
    registry.register("set_project_settings", (args) => setProjectSettingsTool(args, ctx));
    // The app answers get_project_state; a timeline-only harness did not, so a model that asked for it spent a
    // round on "not available". Both arms of an eval get the same answer the app gives: the project's name and
    // canvas, and an empty library unless a stub surface below says otherwise.
    registry.register("get_project_state", async () => {
      const tl = await loadTimeline(store);
      return {
        ok: true,
        project_id: String(projectId),
        name: EVAL_PROJECT_NAME,
        canvas: tl.canvas ?? null,
        library: [],
        library_count: 0,
      };
    });
    // A workflow scenario also needs import / transcript / export. Those are
    // deterministic stand-ins (see journey.ts) so the run still costs nothing
    // beyond the model itself and cannot touch the network. The "studio" surface
    // widens that to the WHOLE non-timeline catalog (see studio.ts) — same rule:
    // no network, no paid inference, no ffmpeg.
    if (scenario.surface === "journey") registerJourneyStubs(registry, studio);
    else if (scenario.surface === "studio")
      registerStudioStubs(registry, studio, 30, () => loadTimeline(store));
    else if (scenario.surface === "recovery") {
      recovery = new RecoveryRuntime(scenario.recovery, ctx);
      await recovery.initialize();
      const surfaceResponse = await authedFetch(`${opts.server}/contract/tools`);
      if (!surfaceResponse.ok)
        throw new Error("recovery tool-surface preflight failed before inference");
      const surface = (await surfaceResponse.json()) as { tools: { name: string }[] };
      if (
        JSON.stringify(surface.tools.map((tool) => tool.name).sort()) !==
        JSON.stringify(recovery.toolNames())
      )
        throw new Error(
          "model catalog and executable recovery handlers differ; no paid inference permitted",
        );
    }
    // The "look" surface: the timeline tools plus the app's free looks and the person's library
    // (look.ts). The Copilot lane's host registers it the same way.
    if (scenario.surface === "look")
      registerLookStubs(
        registry,
        scenario,
        studio,
        { id: String(projectId), name: EVAL_PROJECT_NAME },
        () => loadTimeline(store),
      );
    // A failure the case stages on purpose (faults.ts), after every stand-in is in place.
    stageFaults(registry, scenario.faults);

    let snapshot: Record<string, unknown> | null = null;
    const send =
      opts.send ??
      (async (request: InferenceRequest): Promise<RoundResultDTO> => {
        const res = await authedFetch(`${opts.server}/inference`, {
          method: "POST",
          // This posts to /inference itself rather than going through src/agent/api.ts, so it
          // has to carry the auth header too — against a gated server it 401s without one.
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        });
        if (!res.ok)
          throw new Error(`/inference ${res.status}: ${await res.text().catch(() => "")}`);
        return (await res.json()) as RoundResultDTO;
      });
    const infer = async (roundInput: RoundInput): Promise<RoundResultDTO> => {
      if (recovery && rounds >= (scenario.maxRounds ?? 16)) {
        roundLimitReached = true;
        throw new Error("recovery scenario model-round limit reached");
      }
      opts.budget.startRound();
      const sentAt = now();
      const dto = await send({
        round_input: roundInput,
        provider_snapshot: snapshot,
        model,
        effort,
        mode,
        // The server refuses a call that does not name the tool catalog it was built against (426), as the app does.
        catalog_id: setup.catalogId,
        app_version: appVersion,
      });
      const modelMs = now() - sentAt;
      snapshot = dto.provider_snapshot ?? snapshot;
      rounds += 1;
      const u: RoundUsage = dto.usage ?? {};
      usage.inputTokens += u.input_tokens ?? 0;
      usage.outputTokens += u.output_tokens ?? 0;
      usage.reasoningTokens += u.reasoning_tokens ?? 0;
      if (typeof u.cached_tokens === "number" && u.cached_tokens > 0)
        usage.cachedTokens = (usage.cachedTokens ?? 0) + u.cached_tokens;
      if (typeof u.credits === "number" && Number.isFinite(u.credits))
        usage.credits = (usage.credits ?? 0) + u.credits;
      const cost = costFromUsage(u);
      roundClocks.push({
        round: rounds,
        turn,
        modelMs,
        toolMs: 0,
        tools: 0,
        firstTokenMs: null,
        costKnown: cost !== null,
      });
      if (cost === null) {
        // Tokens were spent and the server named no price: the cap can no longer bound the
        // campaign, so it ends here rather than counting the round as free.
        usage.costUnknownRounds = (usage.costUnknownRounds ?? 0) + 1;
        const reason = "a model round used tokens and its reply carried no cost (usage.cost_usd)";
        opts.budget.stop(reason);
        throw new Error(`eval stopped: ${reason}`);
      }
      usage.costUsd += cost;
      opts.budget.add(cost);
      return dto;
    };

    const deps: LoopDeps = {
      eventContext: agentEventContext,
      infer,
      runTool: async (name, args, trace) => {
        const a = (args ?? {}) as Record<string, unknown>;
        const startMs = now();
        if (!recovery && !registry.has(name)) {
          toolCalls.push({
            round: rounds,
            turn,
            name,
            args: a,
            ok: false,
            error: HARNESS_MARK,
            startMs,
            ms: 0,
          });
          return { ok: false, error: `tool '${name}' is not available in this eval harness` };
        }
        const r = (
          recovery
            ? await recovery.execute(name, a, rounds)
            : await registry.run(name, a, trace.context, trace)
        ) as {
          ok?: boolean;
          error?: string;
        };
        const ms = now() - startMs;
        const ok = r?.ok !== false;
        const serialized = JSON.stringify(r ?? null);
        toolCalls.push({
          round: rounds,
          turn,
          name,
          args: a,
          ok,
          result: serialized.slice(0, 1200),
          resultChars: serialized.length,
          error: ok ? undefined : String(r?.error ?? ""),
          expectedFailure: recovery?.expectedErrors.has(r),
          startMs,
          ms,
        });
        if (
          scenario.stopAfter &&
          turn === scenario.stopAfter.turn &&
          toolCalls.filter((c) => c.turn === turn).length >= scenario.stopAfter.calls
        )
          stopPressed = true;
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
      mode: () => mode as "autopilot",
      stopped: () => opts.budget.exceeded() || stopPressed,
      onUsage: () => {},
      session: () => ({}),
    };

    const runner = new ClientTurnRunner(deps);
    // The app reads the project for the model before its first round (store/chat.ts, agent/stateBlock.ts). The
    // flag lets an eval measure that: the same scenarios, with and without it.
    let firstMessage = scenario.prompt;
    let stateBlock = false;
    if (process.env.ARTDADDY_EVAL_PRELOAD === "1" && !recovery) {
      const block = await readStateBlock({
        has: (n: string) => registry.has(n),
        run: async (n, a, o) =>
          registry.run(n, a, o.trace?.context ?? agentEventContext(), o.trace),
      });
      if (block) {
        firstMessage = composeModelText(scenario.prompt, [], [], { stateBlock: block });
        stateBlock = true;
      }
    }
    await runner.start(firstMessage);
    turnTexts.push(finalText);
    await recovery?.recordClaim(finalText);
    if (providerError && !roundLimitReached) throw new Error(`provider error: ${providerError}`);
    // Multi-turn: replay each follow-up as a new user turn on the SAME runner
    // (timeline + provider continuity carry over) before scoring the final state.
    const followUps =
      scenario.followUps ??
      (recovery?.jobs.some((job) => job.status === "exporting")
        ? [
            "The background export job has now settled. Check its result and finish the requested video if a valid recovery is available. Leave the editable project unchanged. Reply in the same JSON format.",
          ]
        : []);
    for (const followUp of followUps) {
      if (opts.budget.exceeded() || roundLimitReached) break;
      recovery?.releaseQueuedFailure();
      turn += 1;
      // After a Stop the app sends the next message with an answer for every call left
      // unanswered (store/chat.ts carriedDebt); otherwise nothing is owed and this is empty.
      stopPressed = false;
      await runner.start(followUp, runner.takeUnsentResults());
      turnTexts.push(finalText);
      await recovery?.recordClaim(finalText);
      if (providerError && !roundLimitReached) throw new Error(`provider error: ${providerError}`);
    }

    await doc.autosave.flush();
    const final = await loadTimeline(store);
    const trace: Trace = {
      toolCalls,
      reasoning,
      rounds,
      ...(roundLimitReached ? { stopReason: "round_limit" as const } : {}),
      finalText,
      turnTexts,
      usage,
      ...(stateBlock ? { stateBlock: true } : {}),
      payload: payloadOf(toolCalls),
      ...(recovery
        ? {
            recovery: await recovery.evidence(
              opts.artifactDir ?? path.resolve("reports/eval/artifacts", path.basename(dir)),
            ),
          }
        : {}),
      setup,
      clocks: clocksOf(roundClocks, toolCalls),
    };
    // A wasted tool call can BE the regression, so tool errors fail the run (tier0
    // only looks at the end state, which the model usually still reaches). The
    // budget defaults to 0 and is raised only by a scenario that provokes an error
    // on purpose — see evalTier0. The diff runs from the seed AS LOADED, so nothing the
    // load itself normalises reads as the model's change.
    const grade = gradeRun(scenario, seeded, final, trace);
    trace.diff = grade.diff;
    trace.checks = grade.checks;
    const signals = analyzeTrace(scenario, trace, grade.tier0.violations);
    await docCleanup?.();
    docCleanup = null;
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);

    return {
      ...meta,
      wallMs: Date.now() - started,
      passed: grade.passed,
      tier0: grade.tier0,
      tier1: grade.tier1,
      harm: grade.harm,
      signals,
      trace,
    };
  } catch (e) {
    await docCleanup?.();
    // A run that errors must not leave its project folder behind either.
    if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    const trace: Trace = {
      toolCalls,
      reasoning,
      rounds,
      finalText,
      turnTexts,
      usage,
      payload: payloadOf(toolCalls),
      setup,
      clocks: clocksOf(roundClocks, toolCalls),
    };
    const empty = { passed: false, violations: [] as string[] };
    return {
      ...meta,
      wallMs: Date.now() - started,
      passed: false,
      tier0: empty,
      tier1: empty,
      harm: empty,
      signals: analyzeTrace(scenario, trace, []),
      trace,
      harnessError: e instanceof Error ? e.message : String(e),
    };
  }
}
