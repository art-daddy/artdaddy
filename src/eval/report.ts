// Report builder — turns the per-scenario results into a JSON dump + a markdown
// scorecard. The markdown leads with pass-rates per model, then the FRICTION
// section (the actionable part): the missing-feature backlog, tools ranked by
// failures, workaround snippets, and silent-corruption cases.
import { runStatus } from "./status";
import { hasFriction } from "./signals";
import type { CampaignSetup } from "./setup";
import type { CheckId, RunStatus, ScenarioResult } from "./types";

interface ReportOpts {
  models: string[];
  capUsd: number;
  spentUsd: number;
  effort?: string;
  setup?: CampaignSetup;
  /** Why the campaign stopped before its cap (an uncounted spend), if it did. */
  stoppedBecause?: string;
}

const pct = (n: number, d: number): string => (d ? `${Math.round((100 * n) / d)}%` : "—");

const STATUS_WORD: Record<RunStatus, string> = {
  pass: "✓ pass",
  fail: "✗ fail",
  known_failure: "known failure",
  fixed: "FIXED",
  skipped: "⏭ budget",
  harness_error: "⚠ harness",
};

interface ModelSummary {
  model: string;
  run: number;
  passed: number;
  tier0: number;
  tier1: number;
  harm: number;
  failed: number;
  knownFailures: number;
  fixed: number;
  avgRounds: number;
  toolErrors: number;
  cost: number;
  cachedTokens: number;
  inputTokens: number;
  modelMs: number;
  toolMs: number;
}

function summarize(results: ScenarioResult[], models: string[]): ModelSummary[] {
  return models.map((model) => {
    const rs = results.filter((r) => r.model === model && !r.skipped && !r.harnessError);
    const rounds = rs.reduce((a, r) => a + r.trace.rounds, 0);
    const status = rs.map((r) => runStatus(r));
    return {
      model,
      run: rs.length,
      passed: rs.filter((r) => r.passed).length,
      tier0: rs.filter((r) => r.tier0.passed).length,
      tier1: rs.filter((r) => r.tier1.passed).length,
      // A result written before the harm checks existed has none, and is not counted as harmed.
      harm: rs.filter((r) => r.harm?.passed !== false).length,
      failed: status.filter((s) => s === "fail").length,
      knownFailures: status.filter((s) => s === "known_failure").length,
      fixed: status.filter((s) => s === "fixed").length,
      avgRounds: rs.length ? rounds / rs.length : 0,
      toolErrors: rs.reduce((a, r) => a + r.signals.toolErrors.length, 0),
      cost: rs.reduce((a, r) => a + r.trace.usage.costUsd, 0),
      cachedTokens: rs.reduce((a, r) => a + (r.trace.usage.cachedTokens ?? 0), 0),
      inputTokens: rs.reduce((a, r) => a + r.trace.usage.inputTokens, 0),
      modelMs: rs.reduce((a, r) => a + (r.trace.clocks?.modelMs ?? 0), 0),
      toolMs: rs.reduce((a, r) => a + (r.trace.clocks?.toolMs ?? 0), 0),
    };
  });
}

/** Per check: how many runs it failed and warned on, with a few examples. Collateral on a case
 *  with no declared scope is the run's diff, recorded rather than judged, so it is counted apart. */
function checkTally(results: ScenarioResult[]): {
  id: CheckId;
  fail: number;
  warn: number;
  examples: string[];
}[] {
  const map = new Map<CheckId, { fail: number; warn: number; examples: string[] }>();
  for (const r of results)
    for (const c of r.trace.checks ?? []) {
      if (c.verdict !== "fail" && c.verdict !== "warn") continue;
      const e = map.get(c.id) ?? { fail: 0, warn: 0, examples: [] };
      e[c.verdict] += 1;
      if (e.examples.length < 5)
        e.examples.push(`[\`${r.model}\` / ${r.scenarioId}] ${c.details.slice(0, 2).join("; ")}`);
      map.set(c.id, e);
    }
  return [...map.entries()].map(([id, e]) => ({ id, ...e }));
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** Aggregate the missing-feature backlog: (tool.param) -> scenarios that tried it. */
function undeclaredBacklog(results: ScenarioResult[]): { key: string; runs: string[] }[] {
  const map = new Map<string, Set<string>>();
  for (const r of results) {
    for (const u of r.signals.expectedButUndeclared) {
      for (const p of u.params) {
        const key = `${u.name}.${p}`;
        const set = map.get(key) ?? new Set<string>();
        set.add(`${r.scenarioId}/${r.model}`);
        map.set(key, set);
      }
    }
  }
  return [...map.entries()]
    .map(([key, runs]) => ({ key, runs: [...runs] }))
    .sort((a, b) => b.runs.length - a.runs.length);
}

function toolFailureRanking(results: ScenarioResult[]): { name: string; count: number }[] {
  const map = new Map<string, number>();
  for (const r of results)
    for (const e of r.signals.toolErrors) map.set(e.name, (map.get(e.name) ?? 0) + 1);
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

export function buildReport(
  results: ScenarioResult[],
  opts: ReportOpts,
): { json: unknown; markdown: string } {
  const summaries = summarize(results, opts.models);
  const skipped = results.filter((r) => r.skipped).length;
  const backlog = undeclaredBacklog(results);
  const failRanking = toolFailureRanking(results);
  const checks = checkTally(results);
  const now = new Date().toISOString();

  const L: string[] = [];
  L.push(`# Model eval — ${now.slice(0, 16).replace("T", " ")}`);
  L.push("");
  L.push(
    `Models: ${opts.models.join(", ")}${opts.effort ? ` · Effort: ${opts.effort}` : ""} · Scenarios: ${results.length} · ` +
      `Spent: **$${opts.spentUsd.toFixed(2)}** / $${opts.capUsd.toFixed(2)} cap · Skipped (budget): ${skipped}`,
  );
  if (opts.stoppedBecause) {
    L.push("");
    L.push(`**Stopped early:** ${opts.stoppedBecause}`);
  }
  L.push("");
  // Two campaigns compare fairly only when these are equal, or when the one that differs is
  // the thing under test. Null means the run could not learn it.
  L.push("## Setup");
  const s0 = opts.setup;
  const catalogs = [...new Set(results.map((r) => r.trace.setup?.catalogId).filter(Boolean))];
  L.push(
    `- Client commit: ${s0?.appGitSha ?? "unknown"}${s0?.appGitDirty ? " (with local changes)" : ""}`,
  );
  L.push(
    `- Server: ${s0?.server ?? "unknown"} · version ${s0?.serverVersion ?? "unknown"} · build ${s0?.serverBuild || "unknown"}`,
  );
  L.push(`- Base prompt sha256: ${s0?.promptSha256 ?? "not reported"}`);
  L.push(`- Tool catalog: ${catalogs.join(", ") || "unknown"}`);
  L.push("");
  L.push("## Summary");
  L.push(
    "| Model | Pass | Tier0 (safe) | Tier1 (did-it) | Harm-free | Fail | Known failure | Fixed | Avg rounds | Tool errors | Cost | Cached input | Model time | Tool time |",
  );
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of summaries) {
    L.push(
      `| \`${s.model}\` | ${s.passed}/${s.run} (${pct(s.passed, s.run)}) | ${s.tier0}/${s.run} | ${s.tier1}/${s.run} | ` +
        `${s.harm}/${s.run} | ${s.failed} | ${s.knownFailures} | ${s.fixed} | ` +
        `${s.avgRounds.toFixed(1)} | ${s.toolErrors} | $${s.cost.toFixed(2)} | ` +
        `${pct(s.cachedTokens, s.inputTokens)} | ${secs(s.modelMs)} | ${secs(s.toolMs)} |`,
    );
  }
  L.push("");
  L.push(
    "_Fail_ is a case that failed with no known failure on record: a regression, or a new case that never passed. " +
      "_Known failure_ is a case marked with the backlog item tracking it. _Fixed_ is a marked case that passed: remove its mark.",
  );
  L.push("");

  const marked = results.filter((r) => r.knownFailure && !r.skipped && !r.harnessError);
  if (marked.length) {
    L.push("## Known failures and fixes");
    for (const r of marked)
      L.push(
        `- [\`${r.model}\` / ${r.scenarioId}] ${runStatus(r) === "fixed" ? "**FIXED** (remove the mark)" : "still failing"} — ${r.knownFailure}`,
      );
    L.push("");
  }

  L.push("## Harm and craft checks");
  L.push("");
  L.push(
    "> A failed check fails the run. A warning is a pointer to read the trace, never a verdict. " +
      "Collateral on a case with no declared scope is the run's diff, recorded for a reader.",
  );
  L.push("");
  if (checks.length) {
    L.push("| Check | Failed runs | Warned runs | Examples |");
    L.push("|---|---|---|---|");
    for (const c of checks)
      L.push(`| \`${c.id}\` | ${c.fail} | ${c.warn} | ${c.examples.join("<br>")} |`);
  } else {
    L.push("- _(no check failed or warned)_");
  }
  L.push("");

  // What the tools put back into the context. Ranked because shaping is only worth doing
  // where the payload actually is — a guess here costs a redesign of the wrong tool.
  const byTool = new Map<string, { chars: number; calls: number }>();
  for (const r of results)
    for (const c of r.trace.toolCalls) {
      const e = byTool.get(c.name) ?? { chars: 0, calls: 0 };
      e.chars += c.resultChars ?? 0;
      e.calls += 1;
      byTool.set(c.name, e);
    }
  const fattest = [...byTool.entries()].sort((a, b) => b[1].chars - a[1].chars).slice(0, 10);
  const totalChars = [...byTool.values()].reduce((n, e) => n + e.chars, 0);
  L.push("## Tool payload — what the results cost in context");
  L.push("");
  L.push(
    `Total returned: **${(totalChars / 1000).toFixed(1)}k chars** (~${Math.round(totalChars / 4000)}k tokens) across ${results.length} run(s).`,
  );
  L.push("");
  if (fattest.length) {
    L.push("| Tool | Total chars | Calls | Avg | Max in one reply |");
    L.push("|---|---|---|---|---|");
    for (const [name, e] of fattest) {
      const max = Math.max(
        0,
        ...results.flatMap((r) =>
          r.trace.toolCalls.filter((c) => c.name === name).map((c) => c.resultChars ?? 0),
        ),
      );
      L.push(
        `| \`${name}\` | ${e.chars.toLocaleString()} | ${e.calls} | ${Math.round(e.chars / e.calls).toLocaleString()} | ${max.toLocaleString()} |`,
      );
    }
  } else {
    L.push("- _(no tool results recorded)_");
  }
  L.push("");

  L.push("## Friction — capability gaps (the actionable part)");
  L.push("");
  L.push(
    "> Sections marked _(heuristic)_ are regexes over the model's own prose: they miss " +
      "phrasings nobody anticipated and fire on innocent ones. Read the quoted trace " +
      "before acting on one. Every other section is derived from what the trace " +
      "factually contains.",
  );
  L.push("");
  L.push(
    "### Params the model expected but the contract does not declare (missing-feature backlog)",
  );
  if (backlog.length) {
    for (const b of backlog.slice(0, 25))
      L.push(`- \`${b.key}\` — tried in ${b.runs.length} run(s): ${b.runs.join(", ")}`);
  } else {
    L.push("- _(none — the model never reached for an undeclared param)_");
  }
  L.push("");
  L.push("### Tools by failure count");
  if (failRanking.length) {
    for (const f of failRanking.slice(0, 15)) L.push(`- \`${f.name}\`: ${f.count} error(s)`);
  } else {
    L.push("- _(none)_");
  }
  L.push("");
  L.push("### Suspected workarounds (from reasoning) _(heuristic)_");
  const workarounds = results.flatMap((r) =>
    r.signals.workaroundSuspected.map((s) => `- [\`${r.model}\` / ${r.scenarioId}] ${s}`),
  );
  L.push(workarounds.length ? workarounds.slice(0, 20).join("\n") : "- _(none)_");
  L.push("");
  L.push("### Silent corruption (ok:true but the result is invalid)");
  const silent = results
    .filter((r) => r.signals.silentCorruption.length)
    .map((r) => `- [\`${r.model}\` / ${r.scenarioId}] ${r.signals.silentCorruption.join("; ")}`);
  L.push(
    silent.length ? silent.join("\n") : "- _(none — no invariant broke without a tool error)_",
  );
  L.push("");
  L.push("### Claimed an edit that never landed (no successful mutating call) _(heuristic)_");
  const bluffed = results
    .filter((r) => r.signals.claimedSuccessWithoutEdit)
    .map(
      (r) => `- [\`${r.model}\` / ${r.scenarioId}] "${r.signals.claimedSuccessWithoutEdit!.claim}"`,
    );
  L.push(bluffed.length ? bluffed.join("\n") : "- _(none — every success claim had a real edit)_");
  L.push("");
  L.push("### Wrong tool for intent");
  const wrong = results
    .filter((r) => r.signals.wrongToolForIntent)
    .map(
      (r) =>
        `- [\`${r.model}\` / ${r.scenarioId}] expected ${r.signals.wrongToolForIntent!.expected.join("/")}, used ${r.signals.wrongToolForIntent!.used.join(", ") || "(none)"}`,
    );
  L.push(wrong.length ? wrong.join("\n") : "- _(none)_");
  L.push("");

  L.push("## Per-scenario");
  L.push("| Scenario | Model | Status | T0 | T1 | Harm | Rounds | Errors | Warnings | Friction |");
  L.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    const status = STATUS_WORD[runStatus(r)];
    if (r.skipped) {
      L.push(`| ${r.scenarioId} | \`${r.model}\` | ${status} | — | — | — | — | — | — | — |`);
      continue;
    }
    if (r.harnessError) {
      L.push(
        `| ${r.scenarioId} | \`${r.model}\` | ${status} | — | — | — | — | — | — | ${r.harnessError.slice(0, 60)} |`,
      );
      continue;
    }
    const t1 = r.tier1.passed ? "✓" : "✗";
    const t0 = r.tier0.passed ? "✓" : "✗";
    const harm = r.harm ? (r.harm.passed ? "✓" : "✗") : "—";
    // An unscoped case's collateral warning is its diff, recorded rather than judged.
    const warned = (r.trace.checks ?? [])
      .filter((c) => c.verdict === "warn" && c.id !== "collateral")
      .map((c) => c.id.replace(/^craft_/, ""));
    const friction = hasFriction(r.signals) ? "⚑" : "";
    L.push(
      `| ${r.scenarioId} | \`${r.model}\` | ${status} | ${t0} | ${t1} | ${harm} | ${r.trace.rounds} | ${r.signals.toolErrors.length} | ${warned.join(", ")} | ${friction} |`,
    );
  }
  L.push("");

  const json = {
    generatedAt: now,
    models: opts.models,
    effort: opts.effort ?? null,
    setup: opts.setup ?? null,
    budget: {
      capUsd: opts.capUsd,
      spentUsd: opts.spentUsd,
      skipped,
      stoppedBecause: opts.stoppedBecause ?? null,
    },
    summary: summaries,
    checks,
    backlog,
    toolFailures: failRanking,
    results: results.map((r) => ({ ...r, status: runStatus(r) })),
  };
  return { json, markdown: L.join("\n") };
}
