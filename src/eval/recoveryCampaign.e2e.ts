import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  promises as fsp,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createServer, request } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setApiBase } from "../api/config";
import { driveScenario } from "./harness";
import { Budget } from "./pricing";
import { RECOVERY_SCENARIOS } from "./scenarios/exports";
import { recoveryContext, recoveryProjectDir, RecoveryRuntime } from "./recovery";
import { evalTier1 } from "./oracle";
import type { ScenarioResult } from "./types";

const LIVE = process.env.ARTDADDY_RECOVERY_EVAL === "1";
const REGRADE = process.env.ARTDADDY_RECOVERY_REGRADE === "1";
const MODEL = "gpt-5.6-luna";
const CAP = Math.min(5, Number(process.env.ARTDADDY_EVAL_CAP_USD ?? "5"));
const REPEATS = Math.min(5, Number(process.env.ARTDADDY_EVAL_REPEATS ?? "5"));
const ROOT = path.resolve(
  process.env.ARTDADDY_RECOVERY_REPORT_DIR ?? "reports/eval/ffmpeg-recovery-2026-10-12",
);
const RESUME_HARNESS = process.env.ARTDADDY_RECOVERY_RESUME_HARNESS ?? "";
const RESERVE = 1;
const variants = [
  { name: "old", server: process.env.ARTDADDY_RECOVERY_OLD_SERVER ?? "http://127.0.0.1:8787" },
  { name: "new", server: process.env.ARTDADDY_RECOVERY_NEW_SERVER ?? "http://127.0.0.1:8788" },
];

type Provenance = {
  variant: string;
  prompt_sha256: string;
  catalog_sha256: string;
  model: string;
  max_output_tokens: number;
  schema_and_other_tools_unchanged: boolean;
};
type Run = ScenarioResult & {
  variant: string;
  repetition: number;
  promptSha256: string;
  catalogSha256: string;
  harnessSha256: string;
  executionHarnessSha256?: string;
};
type Ledger = {
  spentUsd: number;
  reservedUsd: number;
  rounds: number;
  recoveredReservations: number;
};

function localRoundFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = 600_000,
): Promise<Response> {
  const url = new URL(String(input));
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
    return Promise.reject(
      new Error("local evaluation transport requires an isolated loopback server"),
    );
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === "string" ? init.body : "";
    if (body) headers["content-length"] = String(Buffer.byteLength(body));
    const incoming = request(url, { method: init?.method ?? "GET", headers }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024)
          incoming.destroy(new Error("evaluation response exceeded its byte limit"));
        else chunks.push(chunk);
      });
      response.on("aborted", () =>
        reject(new Error("local inference response ended without a complete receipt")),
      );
      response.on("error", reject);
      response.on("end", () => {
        const payload = Buffer.concat(chunks);
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined)
            responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        resolve(
          new Response(payload, { status: response.statusCode ?? 500, headers: responseHeaders }),
        );
      });
    });
    const timer = setTimeout(
      () => incoming.destroy(new Error("local inference round exceeded the ten-minute deadline")),
      timeoutMs,
    );
    const abort = () => incoming.destroy(new Error("local inference request cancelled"));
    init?.signal?.addEventListener("abort", abort, { once: true });
    incoming.on("error", reject);
    incoming.on("close", () => {
      clearTimeout(timer);
      init?.signal?.removeEventListener("abort", abort);
    });
    if (init?.signal?.aborted) abort();
    else incoming.end(body);
  });
}

function deliveredOutcome(run: Run): boolean {
  if (run.trace.stopReason === "round_limit") return false;
  const evidence = run.trace.recovery;
  if (
    !evidence ||
    !evidence.timelineUnchanged ||
    !evidence.inputFilesUnchanged ||
    evidence.violations.length
  )
    return false;
  try {
    const claim = JSON.parse(run.trace.finalText) as {
      status?: string;
      file?: string;
      reason?: string;
    };
    const completed = evidence.artifacts.filter((artifact) => artifact.problems.length === 0);
    if (run.scenarioId === "export_recovery_both_fail")
      return (
        claim.status === "blocked" &&
        !claim.file &&
        Boolean(claim.reason) &&
        !completed.length &&
        run.trace.toolCalls.some((call) => call.name === "export") &&
        run.trace.toolCalls.some((call) => call.name === "run_ffmpeg" && call.expectedFailure)
      );
    return (
      completed.length === 1 && claim.status === "completed" && claim.file === completed[0].filename
    );
  } catch {
    return false;
  }
}

function classifyRecordedLimit(run: Run): Run {
  if (run.harnessError !== "recovery scenario model-round limit reached") return run;
  const scenario = RECOVERY_SCENARIOS.find((entry) => entry.id === run.scenarioId);
  if (!scenario || run.trace.rounds < (scenario.maxRounds ?? 16))
    throw new Error("recorded round-limit failure does not prove exhaustion");
  const { harnessError: _recordedLimit, ...recorded } = run;
  return {
    ...recorded,
    passed: false,
    tier1: {
      passed: false,
      violations: ["tier1: model exhausted the scenario round limit before completing the task"],
    },
    trace: { ...run.trace, stopReason: "round_limit" },
  };
}

class JournalBudget extends Budget {
  private ledger: Ledger;

  constructor(
    cap: number,
    private readonly file: string,
  ) {
    super(cap);
    if (!(cap > 0 && cap <= 5))
      throw new Error("campaign budget must be between zero and the authorized $5 maximum");
    this.ledger = existsSync(file)
      ? (JSON.parse(readFileSync(file, "utf8")) as Ledger)
      : { spentUsd: 0, reservedUsd: 0, rounds: 0, recoveredReservations: 0 };
    if (
      !Number.isFinite(this.ledger.spentUsd) ||
      this.ledger.spentUsd < 0 ||
      !Number.isFinite(this.ledger.reservedUsd) ||
      this.ledger.reservedUsd < 0
    )
      throw new Error("invalid campaign spend journal");
    if (this.ledger.reservedUsd) {
      this.ledger.spentUsd += this.ledger.reservedUsd;
      this.ledger.reservedUsd = 0;
      this.ledger.recoveredReservations += 1;
    }
    super.add(this.ledger.spentUsd);
    this.persist();
  }

  private persist(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.ledger, null, 2));
    renameSync(temporary, this.file);
  }

  override startRound(): void {
    if (this.ledger.reservedUsd)
      throw new Error("campaign has an unsettled model round; stop rather than retry paid work");
    if (this.remaining < RESERVE)
      throw new Error("eval budget exhausted before model round reservation");
    this.ledger.reservedUsd = RESERVE;
    this.persist();
  }

  override add(usd: number): void {
    if (!(Number.isFinite(usd) && usd > 0))
      throw new Error("missing positive server cost receipt; paid campaign stopped");
    super.add(usd);
    this.ledger.spentUsd = this.total;
    this.ledger.reservedUsd = 0;
    this.ledger.rounds += 1;
    this.persist();
    if (usd > RESERVE)
      throw new Error("model round exceeded its conservative reservation; campaign stopped");
  }
}

describe("durable recovery campaign budget", () => {
  it("retains a proved round-limit attempt as a model failure without retrying paid work", () => {
    const scenario = RECOVERY_SCENARIOS.find((entry) => entry.id === "export_recovery_both_fail")!;
    const run = {
      scenarioId: scenario.id,
      passed: false,
      harnessError: "recovery scenario model-round limit reached",
      trace: { rounds: scenario.maxRounds, stopReason: undefined },
    } as unknown as Run;
    const bounded = classifyRecordedLimit(run);
    expect(bounded.harnessError).toBeUndefined();
    expect(bounded.trace.stopReason).toBe("round_limit");
    expect(bounded.passed).toBe(false);
    expect(deliveredOutcome(bounded)).toBe(false);
    const transport = {
      ...run,
      harnessError: "local inference response ended without a complete receipt",
    };
    expect(classifyRecordedLimit(transport)).toBe(transport);
    expect(() => classifyRecordedLimit({ ...run, trace: { ...run.trace, rounds: 1 } })).toThrow(
      "prove exhaustion",
    );
  });
  it("waits for a delayed complete JSON receipt without changing request bytes or retrying", async () => {
    let attempts = 0;
    let submitted = "";
    let authorization = "";
    const server = createServer((req, response) => {
      attempts += 1;
      authorization = String(req.headers.authorization ?? "");
      req.on("data", (chunk: Buffer) => (submitted += chunk.toString()));
      req.on("end", () => {
        setTimeout(() => {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ cost_usd: 0.02 }));
        }, 30);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("missing local fixture listener");
      const body = JSON.stringify({ round_input: { user_text: "synthetic" } });
      const response = await localRoundFetch(
        `http://127.0.0.1:${address.port}/inference`,
        {
          method: "POST",
          body,
          headers: {
            authorization: "Bearer synthetic-not-a-secret",
            "content-type": "application/json",
          },
        },
        500,
      );
      expect(await response.json()).toEqual({ cost_usd: 0.02 });
      expect(submitted).toBe(body);
      expect(authorization).toBe("Bearer synthetic-not-a-secret");
      expect(attempts).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("charges an unfinished round conservatively on resume and refuses new work near the cap", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-eval-budget-"));
    try {
      const file = path.join(dir, "budget.json");
      const first = new JournalBudget(1.5, file);
      first.startRound();
      expect(JSON.parse(readFileSync(file, "utf8")).reservedUsd).toBe(1);
      const resumed = new JournalBudget(1.5, file);
      expect(resumed.total).toBe(1);
      expect(() => resumed.startRound()).toThrow("reservation");
      expect(JSON.parse(readFileSync(file, "utf8")).recoveredReservations).toBe(1);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("persists actual receipts without spending the unused reservation", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-eval-receipt-"));
    try {
      const file = path.join(dir, "budget.json");
      const budget = new JournalBudget(5, file);
      budget.startRound();
      expect(() => budget.startRound()).toThrow("unsettled");
      budget.add(0.02);
      expect(new JournalBudget(5, file).total).toBe(0.02);
      expect(JSON.parse(readFileSync(file, "utf8")).reservedUsd).toBe(0);
      expect(() => new JournalBudget(6, file)).toThrow("authorized");
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("distinguishes a verified delivery after corrected arguments from clean zero-error performance", () => {
    const run = {
      scenarioId: "export_recovery_platform_limit",
      passed: false,
      trace: {
        finalText: JSON.stringify({ status: "completed", file: "finished.mp4" }),
        recovery: {
          timelineUnchanged: true,
          inputFilesUnchanged: true,
          violations: [],
          unexpectedFailures: 1,
          artifacts: [{ filename: "finished.mp4", problems: [] }],
        },
      },
    } as unknown as Run;
    expect(deliveredOutcome(run)).toBe(true);
    expect(run.passed).toBe(false);
    run.trace.recovery!.artifacts[0].problems.push("missing right-channel audio");
    expect(deliveredOutcome(run)).toBe(false);
  });
});

describe.skipIf(!LIVE)("old versus new recovery guidance (paid, opt-in)", () => {
  let budget: JournalBudget;
  let halted = false;
  const proofs = new Map<string, Provenance>();
  const completed = new Map<string, Run>();
  const results: Run[] = [];
  const checkpoint = path.join(ROOT, "campaign.jsonl");
  let harnessSha256 = "";
  let executionHarnessSha256 = "";
  const originalFetch = globalThis.fetch;
  const key = (run: Run): string =>
    `${run.variant}/${run.promptSha256}/${run.catalogSha256}/${run.harnessSha256}/${run.model}/${run.scenarioId}/${run.repetition}`;

  beforeAll(async () => {
    if (!Number.isInteger(REPEATS) || REPEATS < 1)
      throw new Error("repetitions must be 1 through 5");
    globalThis.fetch = (input, init) => {
      const url = new URL(String(input));
      return variants.some((variant) => url.origin === variant.server) &&
        url.pathname === "/inference"
        ? localRoundFetch(input, init)
        : originalFetch(input, init);
    };
    budget = new JournalBudget(CAP, path.join(ROOT, "budget.json"));
    const fingerprint = createHash("sha256");
    for (const file of [
      "src/eval/recovery.ts",
      "src/eval/harness.ts",
      "src/eval/oracle.ts",
      "src/eval/scenarios/exports.ts",
    ])
      fingerprint.update(await fsp.readFile(file));
    harnessSha256 = fingerprint.digest("hex");
    executionHarnessSha256 = harnessSha256;
    if (RESUME_HARNESS) {
      const prior = JSON.parse(await fsp.readFile(path.join(ROOT, "summary.json"), "utf8")) as {
        harnessSha256: string;
      };
      if (!/^[0-9a-f]{64}$/.test(RESUME_HARNESS) || prior.harnessSha256 !== RESUME_HARNESS)
        throw new Error(
          "compatible resume must identify the previously recorded comparison exactly",
        );
      harnessSha256 = RESUME_HARNESS;
    }
    for (const variant of variants) {
      const proof = JSON.parse(
        await fsp.readFile(path.join(ROOT, `${variant.name}-provenance.json`), "utf8"),
      ) as Provenance;
      if (
        proof.model !== MODEL ||
        proof.max_output_tokens !== 8192 ||
        !proof.schema_and_other_tools_unchanged
      )
        throw new Error("unverified model, output limit or catalog provenance");
      const parsed = new URL(variant.server);
      if (parsed.hostname !== "127.0.0.1")
        throw new Error("campaign servers must be isolated loopback listeners");
      const response = await fetch(`${variant.server}/contract/instructions`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`${variant.name} server unavailable: ${response.status}`);
      const payload = (await response.json()) as { instructions: string };
      const rendered = await fsp.readFile(path.join(ROOT, `${variant.name}-prompt.txt`), "utf8");
      if (payload.instructions !== rendered)
        throw new Error(`${variant.name} server does not serve the recorded prompt`);
      proofs.set(variant.name, proof);
    }
    if (existsSync(checkpoint)) {
      for (const line of readFileSync(checkpoint, "utf8").split("\n").filter(Boolean)) {
        const run = classifyRecordedLimit(JSON.parse(line) as Run);
        if (!run.harnessError) completed.set(key(run), run);
      }
    }
  });

  for (let repetition = 1; repetition <= REPEATS; repetition += 1) {
    for (const scenario of RECOVERY_SCENARIOS) {
      for (const variant of repetition % 2 ? variants : [...variants].reverse()) {
        it(`${variant.name} r${repetition} ${scenario.id}`, async (test) => {
          const proof = proofs.get(variant.name)!;
          const metadata = {
            variant: variant.name,
            repetition,
            promptSha256: proof.prompt_sha256,
            catalogSha256: proof.catalog_sha256,
            harnessSha256,
            executionHarnessSha256,
          };
          const runKey = key({ ...metadata, model: MODEL, scenarioId: scenario.id } as Run);
          const previous = completed.get(runKey);
          if (previous) {
            results.push(previous);
            test.skip();
            return;
          }
          if (halted || budget.remaining < RESERVE) {
            test.skip();
            return;
          }
          setApiBase(variant.server);
          const result = await driveScenario(scenario, MODEL, {
            server: variant.server,
            budget,
            effort: "high",
            artifactDir: path.join(ROOT, "artifacts", variant.name, `r${repetition}`, scenario.id),
          });
          const run: Run = { ...result, ...metadata };
          results.push(run);
          await fsp.appendFile(checkpoint, `${JSON.stringify(run)}\n`);
          console.log(
            `${variant.name} r${repetition} ${scenario.id}: ${result.passed ? "PASS" : "FAIL"}; $${result.trace.usage.costUsd.toFixed(5)}; ${result.tier1.violations.join("; ") || result.harnessError || ""}`,
          );
          if (result.harnessError) halted = true;
          expect(result.harnessError, result.harnessError ?? "").toBeUndefined();
        }, 900_000);
      }
    }
  }

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    if (!budget) return;
    const rows = RECOVERY_SCENARIOS.map((scenario) => ({
      scenario: scenario.id,
      ...Object.fromEntries(
        variants.map((variant) => {
          const selected = results.filter(
            (run) =>
              run.scenarioId === scenario.id && run.variant === variant.name && !run.harnessError,
          );
          return [
            variant.name,
            { passed: selected.filter((run) => run.passed).length, runs: selected.length },
          ];
        }),
      ),
    }));
    const summary = {
      model: MODEL,
      effort: "high",
      harnessSha256,
      executionHarnessSha256,
      compatibilityResume: Boolean(RESUME_HARNESS),
      requestedRepetitions: REPEATS,
      requestedRuns: REPEATS * RECOVERY_SCENARIOS.length * 2,
      recordedRuns: results.length,
      spentUsd: budget.total,
      capUsd: CAP,
      halted,
      rows,
    };
    await fsp.writeFile(path.join(ROOT, "summary.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  });
});

describe.skipIf(!REGRADE)("regrade frozen recovery artifacts (local, no model calls)", () => {
  it("hash-checks every retained file and applies the final artifact oracle to one recorded harness version", async () => {
    if (LIVE) throw new Error("regrading and live inference must run separately");
    const journal = JSON.parse(
      await fsp.readFile(path.join(ROOT, "budget.json"), "utf8"),
    ) as Ledger;
    if (journal.reservedUsd)
      throw new Error("campaign still has an unfinished model round; do not regrade partial state");
    const original = JSON.parse(await fsp.readFile(path.join(ROOT, "summary.json"), "utf8")) as {
      harnessSha256: string;
      recordedRuns: number;
    };
    if (!original.harnessSha256) throw new Error("no completed versioned campaign to regrade");
    const captured = (await fsp.readFile(path.join(ROOT, "campaign.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => classifyRecordedLimit(JSON.parse(line) as Run))
      .filter((run) => run.harnessSha256 === original.harnessSha256);
    const unique = new Map(
      captured.map((run) => [`${run.variant}/${run.scenarioId}/${run.repetition}`, run]),
    );
    const validationSha256 = createHash("sha256")
      .update(await fsp.readFile("src/eval/recovery.ts"))
      .digest("hex");
    const validated: (Run & { artifactValidationSha256: string })[] = [];
    const baselineSources = new Map<string, string>();
    for (const run of unique.values()) {
      const scenario = RECOVERY_SCENARIOS.find((entry) => entry.id === run.scenarioId);
      if (scenario && run.trace.stopReason === "round_limit" && !run.trace.recovery) {
        validated.push({ ...run, artifactValidationSha256: validationSha256 });
        continue;
      }
      if (!scenario || scenario.surface !== "recovery" || !run.trace.recovery)
        throw new Error(`missing recovery evidence for ${run.scenarioId}`);
      const sourceDigest = JSON.stringify(run.trace.recovery.sources);
      const previous = baselineSources.get(scenario.id);
      if (previous && previous !== sourceDigest)
        throw new Error(
          `${scenario.id}: compared runs did not receive byte-identical source media`,
        );
      baselineSources.set(scenario.id, sourceDigest);
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-recovery-regrade-"));
      try {
        const fixture = new RecoveryRuntime(
          scenario.recovery,
          recoveryContext(recoveryProjectDir(dir)),
        );
        for (const [index, artifact] of run.trace.recovery.artifacts.entries()) {
          const relative = path.relative(ROOT, artifact.path);
          if (relative.startsWith("..") || path.isAbsolute(relative))
            throw new Error("artifact escaped the recorded campaign directory");
          const bytes = await fsp.readFile(artifact.path);
          if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256)
            throw new Error(`${artifact.filename}: retained bytes changed after model execution`);
          const file = path.join(dir, `artifact-${index}.mp4`);
          await fsp.writeFile(file, bytes);
          const checked = await fixture.checkArtifact(file);
          artifact.durationS = checked.durationS;
          artifact.problems = checked.problems;
        }
        const artifactDir = path.join(
          ROOT,
          "artifacts",
          run.variant,
          `r${run.repetition}`,
          run.scenarioId,
        );
        const before = await fsp.readFile(path.join(artifactDir, "timeline-before.json"));
        const after = await fsp.readFile(path.join(artifactDir, "timeline-after.json"));
        run.trace.recovery.timelineUnchanged &&= before.equals(after);
        run.tier1 = evalTier1(scenario, scenario.seed(), run.trace);
        run.passed = run.tier0.passed && run.tier1.passed;
        validated.push({ ...run, artifactValidationSha256: validationSha256 });
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    }
    const rows = RECOVERY_SCENARIOS.map((scenario) => ({
      scenario: scenario.id,
      ...Object.fromEntries(
        variants.map((variant) => {
          const selected = validated.filter(
            (run) => run.scenarioId === scenario.id && run.variant === variant.name,
          );
          return [
            variant.name,
            {
              passed: selected.filter((run) => run.passed).length,
              outcomeMet: selected.filter(deliveredOutcome).length,
              runs: selected.length,
            },
          ];
        }),
      ),
    }));
    const final = {
      model: MODEL,
      effort: "high",
      recordedHarnessSha256: original.harnessSha256,
      artifactValidationSha256: validationSha256,
      requestedRuns: 80,
      validatedRuns: validated.length,
      reportedProviderCostUsd: validated.reduce((sum, run) => sum + run.trace.usage.costUsd, 0),
      conservativeJournalSpentUsd: journal.spentUsd,
      providerReceiptsAllAttemptsUsd: (
        await fsp.readFile(path.join(ROOT, "campaign.jsonl"), "utf8")
      )
        .split("\n")
        .filter(Boolean)
        .reduce((sum, line) => sum + (JSON.parse(line) as Run).trace.usage.costUsd, 0),
      rows,
    };
    await fsp.writeFile(
      path.join(ROOT, "validated-campaign.jsonl"),
      validated.map((run) => JSON.stringify(run)).join("\n") + "\n",
    );
    await fsp.writeFile(path.join(ROOT, "validated-summary.json"), JSON.stringify(final, null, 2));
    console.log(JSON.stringify(final, null, 2));
    expect(validated.length).toBe(original.recordedRuns);
  }, 900_000);
});
