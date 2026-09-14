// Report builder — turns the per-scenario results into a JSON dump + a markdown
// scorecard. The markdown leads with pass-rates per model, then the FRICTION
// section (the actionable part): the missing-feature backlog, tools ranked by
// failures, workaround snippets, and silent-corruption cases.
import { hasFriction } from "./signals";
import type { ScenarioResult } from "./types";

interface ReportOpts {
  models: string[];
  capUsd: number;
  spentUsd: number;
}

const pct = (n: number, d: number): string => (d ? `${Math.round((100 * n) / d)}%` : "—");

interface ModelSummary {
  model: string;
  run: number;
  passed: number;
  tier0: number;
  tier1: number;
  avgRounds: number;
  toolErrors: number;
  cost: number;
}

function summarize(results: ScenarioResult[], models: string[]): ModelSummary[] {
  return models.map((model) => {
    const rs = results.filter((r) => r.model === model && !r.skipped && !r.harnessError);
    const rounds = rs.reduce((a, r) => a + r.trace.rounds, 0);
    return {
      model,
      run: rs.length,
      passed: rs.filter((r) => r.passed).length,
      tier0: rs.filter((r) => r.tier0.passed).length,
      tier1: rs.filter((r) => r.tier1.passed).length,
      avgRounds: rs.length ? rounds / rs.length : 0,
      toolErrors: rs.reduce((a, r) => a + r.signals.toolErrors.length, 0),
      cost: rs.reduce((a, r) => a + r.trace.usage.costUsd, 0),
    };
  });
}

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
  const now = new Date().toISOString();

  const L: string[] = [];
  L.push(`# Model eval — ${now.slice(0, 16).replace("T", " ")}`);
  L.push("");
  L.push(
    `Models: ${opts.models.join(", ")} · Scenarios: ${results.length} · ` +
      `Spent: **$${opts.spentUsd.toFixed(2)}** / $${opts.capUsd.toFixed(2)} cap · Skipped (budget): ${skipped}`,
  );
  L.push("");
  L.push("## Summary");
  L.push("| Model | Pass | Tier0 (safe) | Tier1 (did-it) | Avg rounds | Tool errors | Cost |");
  L.push("|---|---|---|---|---|---|---|");
  for (const s of summaries) {
    L.push(
      `| \`${s.model}\` | ${s.passed}/${s.run} (${pct(s.passed, s.run)}) | ${s.tier0}/${s.run} | ${s.tier1}/${s.run} | ` +
        `${s.avgRounds.toFixed(1)} | ${s.toolErrors} | $${s.cost.toFixed(2)} |`,
    );
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
  L.push("| Scenario | Model | Pass | T0 | T1 | Rounds | Errors | Friction |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    if (r.skipped) {
      L.push(`| ${r.scenarioId} | \`${r.model}\` | ⏭ budget | — | — | — | — | — |`);
      continue;
    }
    if (r.harnessError) {
      L.push(
        `| ${r.scenarioId} | \`${r.model}\` | ⚠ harness | — | — | — | — | ${r.harnessError.slice(0, 60)} |`,
      );
      continue;
    }
    const t1 = r.tier1.passed ? "✓" : "✗";
    const t0 = r.tier0.passed ? "✓" : "✗";
    const friction = hasFriction(r.signals) ? "⚑" : "";
    L.push(
      `| ${r.scenarioId} | \`${r.model}\` | ${r.passed ? "✓" : "✗"} | ${t0} | ${t1} | ${r.trace.rounds} | ${r.signals.toolErrors.length} | ${friction} |`,
    );
  }
  L.push("");

  const json = {
    generatedAt: now,
    models: opts.models,
    budget: { capUsd: opts.capUsd, spentUsd: opts.spentUsd, skipped },
    summary: summaries,
    backlog,
    toolFailures: failRanking,
    results,
  };
  return { json, markdown: L.join("\n") };
}
