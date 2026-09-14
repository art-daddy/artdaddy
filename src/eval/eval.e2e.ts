// The eval runner — the manual/nightly "npm run eval" lane. Iterates every model
// × scenario through the live model, enforces the $ budget (skips the rest once the
// cap is hit), and writes a JSON + markdown scorecard (with the friction section)
// to reports/eval/. NON-GATING for model quality: an it() only goes red on a
// HARNESS breakage (server down / crash), never on the model missing a task — that
// is data, captured in the report.
//
// Prereqs (see src/agent/synclock.e2e.ts header): the server running with metering
// OFF. Config sets ARTDADDY_EVAL=1; override models/cap/server via env:
//   ARTDADDY_EVAL_MODELS, ARTDADDY_EVAL_CAP_USD, ARTDADDY_SERVER, ARTDADDY_EVAL_EFFORT, ARTDADDY_EVAL_ONLY
//
// RESUMABLE: each finished (model × scenario) is appended to a JSONL checkpoint the
// instant it completes, so a crash/kill loses at most the in-flight scenario — the
// full report is only written at the end, but re-running picks up where it stopped.
// Prior spend is replayed into the budget so the cap spans the whole campaign.
// Set ARTDADDY_EVAL_CHECKPOINT to a path, or "off" to disable; delete the file to redo.
import { promises as fsp } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setClerkTokenProvider, verifyAccess } from "../api/auth";
import { setApiBase } from "../api/config";
import { driveScenario } from "./harness";
import { Budget } from "./pricing";
import { buildReport } from "./report";
import { ALL_SCENARIOS } from "./scenarios";
import type { ScenarioResult, Signals, Trace } from "./types";

const EVAL = process.env.ARTDADDY_EVAL === "1";
const SERVER = process.env.ARTDADDY_SERVER ?? "http://127.0.0.1:8000";
// A gated server (the deployed one) needs a Clerk session JWT; a local dev server
// with metering off needs none and ignores this.
const TOKEN = process.env.ARTDADDY_EVAL_TOKEN ?? "";
const MODELS = (process.env.ARTDADDY_EVAL_MODELS ?? "gpt-5.4,gpt-5.4-mini")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const CAP = Number(process.env.ARTDADDY_EVAL_CAP_USD ?? "10");
const EFFORT = process.env.ARTDADDY_EVAL_EFFORT ?? "high";
const ONLY = (process.env.ARTDADDY_EVAL_ONLY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const SCENARIOS = ONLY.length ? ALL_SCENARIOS.filter((s) => ONLY.includes(s.id)) : ALL_SCENARIOS;

const CHECKPOINT_ENV = process.env.ARTDADDY_EVAL_CHECKPOINT ?? "";
const CHECKPOINT =
  CHECKPOINT_ENV.toLowerCase() === "off"
    ? null
    : path.resolve(CHECKPOINT_ENV || "reports/eval/checkpoint.jsonl");

const runKey = (model: string, scenarioId: string): string => `${model}\u0000${scenarioId}`;

/** Completed runs from a previous (possibly crashed) invocation, keyed model×scenario. */
async function loadCheckpoint(): Promise<Map<string, ScenarioResult>> {
  const done = new Map<string, ScenarioResult>();
  if (!CHECKPOINT) return done;
  let raw: string;
  try {
    raw = await fsp.readFile(CHECKPOINT, "utf8");
  } catch {
    return done; // no checkpoint yet — fresh campaign
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as ScenarioResult;
      // A later line for the same key wins (a redo overwrites the stale attempt).
      if (r?.scenarioId && r?.model) done.set(runKey(r.model, r.scenarioId), r);
    } catch {
      // Torn last line from a kill mid-write — ignore it and re-run that scenario.
    }
  }
  return done;
}

async function appendCheckpoint(r: ScenarioResult): Promise<void> {
  if (!CHECKPOINT) return;
  await fsp.mkdir(path.dirname(CHECKPOINT), { recursive: true });
  await fsp.appendFile(CHECKPOINT, `${JSON.stringify(r)}\n`);
}

/** Vitest's own testTimeout has been observed NOT to fire on a never-settling
 *  round (event loop idle, no abort), stalling the whole campaign. Own the clock. */
const WATCHDOG_MS = Number(process.env.ARTDADDY_EVAL_WATCHDOG_S ?? "420") * 1000;

const WATCHDOG = Symbol("watchdog");

async function withWatchdog<T>(work: Promise<T>): Promise<T | typeof WATCHDOG> {
  let timer: NodeJS.Timeout | undefined;
  const alarm = new Promise<typeof WATCHDOG>((resolve) => {
    timer = setTimeout(() => resolve(WATCHDOG), WATCHDOG_MS);
  });
  try {
    return await Promise.race([work, alarm]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const emptyTrace = (): Trace => ({
  toolCalls: [],
  reasoning: [],
  rounds: 0,
  finalText: "",
  usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 },
});
const emptySignals = (): Signals => ({
  toolErrors: [],
  retryLoops: [],
  expectedButUndeclared: [],
  workaroundSuspected: [],
  escapeHatchUsed: [],
  silentCorruption: [],
  notRunInHarness: [],
});

describe.skipIf(!EVAL)("model eval (live model via /inference)", () => {
  const budget = new Budget(CAP);
  const results: ScenarioResult[] = [];
  let done = new Map<string, ScenarioResult>();

  beforeAll(async () => {
    done = await loadCheckpoint();
    // Replay prior spend so the cap bounds the CAMPAIGN, not one invocation.
    for (const r of done.values()) budget.add(r.trace.usage.costUsd);
    if (done.size) {
      // eslint-disable-next-line no-console
      console.log(
        `[eval] resuming — ${done.size} run(s) already complete ($${budget.total.toFixed(2)} spent).`,
      );
    }
    try {
      await fetch(SERVER); // any HTTP response (even 404) means it's up
    } catch {
      // Hard-fail the lane: skipping 57 scenarios here would exit 0 and read as a
      // clean run. A missing server is HARNESS breakage — it must be loud.
      throw new Error(
        `[eval] server ${SERVER} is unreachable — start it (metering OFF, see synclock.e2e header).`,
      );
    }

    // Point the client at SERVER before authenticating: changing the base drops a
    // token, since one minted by another server means nothing here.
    setApiBase(SERVER);
    if (TOKEN) setClerkTokenProvider(async () => TOKEN);
    // Same reason the harness now throws on a provider error: a 401 would otherwise
    // arrive per-scenario and be recorded as the MODEL failing every task. Verify
    // returns true on an ungated server, so local dev is unaffected.
    if (!(await verifyAccess())) {
      throw new Error(
        `[eval] ${SERVER} rejected the credentials — set ARTDADDY_EVAL_TOKEN to a valid Clerk session JWT.`,
      );
    }
  });

  for (const model of MODELS) {
    for (const scenario of SCENARIOS) {
      it(`[${model}] ${scenario.id}`, async (ctx) => {
        const prior = done.get(runKey(model, scenario.id));
        if (prior) {
          results.push(prior);
          ctx.skip();
          return;
        }
        if (budget.exceeded()) {
          results.push({
            scenarioId: scenario.id,
            title: scenario.title,
            prompt: scenario.prompt,
            tags: scenario.tags ?? [],
            model,
            passed: false,
            tier0: { passed: false, violations: [] },
            tier1: { passed: false, violations: [] },
            signals: emptySignals(),
            trace: emptyTrace(),
            wallMs: 0,
            skipped: true,
          });
          ctx.skip();
          return;
        }
        const raced = await withWatchdog(
          driveScenario(scenario, model, { server: SERVER, budget, effort: EFFORT }),
        );
        if (raced === WATCHDOG) {
          // Quarantine the hang: checkpoint it so a relaunch moves PAST this
          // scenario instead of re-hanging on it every attempt.
          const stalled: ScenarioResult = {
            scenarioId: scenario.id,
            title: scenario.title,
            prompt: scenario.prompt,
            tags: scenario.tags ?? [],
            model,
            passed: false,
            tier0: { passed: false, violations: [] },
            tier1: { passed: false, violations: [] },
            signals: emptySignals(),
            trace: emptyTrace(),
            wallMs: WATCHDOG_MS,
            harnessError: `watchdog: no completion in ${WATCHDOG_MS / 1000}s`,
          };
          results.push(stalled);
          await appendCheckpoint(stalled);
          expect.fail(stalled.harnessError);
        }
        const r = raced;
        results.push(r);
        // Checkpoint only real verdicts — a harness error must be retried on resume.
        if (!r.harnessError) await appendCheckpoint(r);
        // Non-gating for model quality: red ONLY on a harness breakage.
        expect(r.harnessError, r.harnessError ?? "").toBeUndefined();
      }, 900_000);
    }
  }

  afterAll(async () => {
    if (!results.length) return;
    const { json, markdown } = buildReport(results, {
      models: MODELS,
      capUsd: CAP,
      spentUsd: budget.total,
    });
    const dir = path.resolve("reports/eval");
    await fsp.mkdir(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    await fsp.writeFile(path.join(dir, `eval-${ts}.json`), JSON.stringify(json, null, 2));
    await fsp.writeFile(path.join(dir, `eval-${ts}.md`), markdown);
    await fsp.writeFile(path.join(dir, "latest.md"), markdown);
    // eslint-disable-next-line no-console
    console.log(
      `\n${markdown}\n\nReport: reports/eval/eval-${ts}.md · Spent $${budget.total.toFixed(2)} / $${CAP.toFixed(2)}`,
    );
  });
});
