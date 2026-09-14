// Cross-run eval history: which scenarios fail REPEATEDLY, not just once.
//
//   node scripts/eval-history.mjs [--model gpt-5.4-mini] [--since 2026-08-01] [--min 2]
//
// Every artifact in reports/eval is single-campaign, so a scenario that failed once and a
// scenario that has failed every time since July look identical. This rolls them up.
//
// THE TRAP THIS AVOIDS: a resumed campaign replays its checkpoint into the next report, so the
// same EXECUTION appears in several files. Counting files would make one bad run look like five.
// Executions are deduped on a fingerprint (model, scenario, wallMs, cost, rounds) — wallMs alone
// is effectively unique per execution — and the earliest sighting dates it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const DIR = path.resolve(import.meta.dirname, "../reports/eval");
const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const MODEL = argOf("--model", "");
const SINCE = argOf("--since", "") ? new Date(argOf("--since", "")) : null;
const MIN_ATTEMPTS = Number(argOf("--min", "2"));

const runs = new Map(); // fingerprint -> one executed scenario

function record(r, when) {
  if (!r?.scenarioId || !r?.model) return;
  const fp = `${r.model}\u0000${r.scenarioId}\u0000${r.wallMs}\u0000${r.trace?.usage?.costUsd}\u0000${r.trace?.rounds}`;
  const prev = runs.get(fp);
  if (prev) {
    if (when < prev.when) prev.when = when; // earliest sighting is the real execution date
    return;
  }
  runs.set(fp, {
    scenarioId: r.scenarioId,
    model: r.model,
    passed: r.passed === true,
    // tier0/tier1 are {passed, violations}, NOT booleans. Comparing them to false reports
    // "0 hard failures" for every row — a column that cannot ever be non-zero.
    tier0Passed: r.tier0?.passed !== false,
    violations: [...(r.tier0?.violations ?? []), ...(r.tier1?.violations ?? [])].map(String),
    toolErrors: r.signals?.toolErrors ?? 0,
    // INFRASTRUCTURE, not the model: `/inference` returns HTTP 200 with kind:"error" on a
    // provider failure, and until 2026-08-09 the harness ignored it — the run was recorded as
    // rounds>0, zero tool calls, empty text. Counting those as capability gaps is how a dead
    // provider looks like a failing feature. Newer runs carry harnessError; older ones only
    // have this fingerprint.
    infra:
      Boolean(r.harnessError) ||
      ((r.trace?.rounds ?? 0) > 0 &&
        (r.trace?.toolCalls?.length ?? 0) === 0 &&
        !String(r.trace?.finalText ?? "").trim()),
    when,
  });
}

for (const f of readdirSync(DIR)) {
  const full = path.join(DIR, f);
  const mtime = statSync(full).mtime;
  if (f.startsWith("eval-") && f.endsWith(".json")) {
    const j = JSON.parse(readFileSync(full, "utf8"));
    const when = j.generatedAt ? new Date(j.generatedAt) : mtime;
    for (const r of j.results ?? []) record(r, when);
  } else if (f.endsWith(".jsonl")) {
    // Checkpoints carry runs from campaigns that crashed before a report was written.
    for (const line of readFileSync(full, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        record(JSON.parse(line), mtime);
      } catch {
        /* torn final line from a kill mid-write */
      }
    }
  }
}

const all = [...runs.values()].filter(
  (r) => (!MODEL || r.model === MODEL) && (!SINCE || r.when >= SINCE),
);
if (!all.length) {
  console.log("no runs match the filters");
  process.exit(0);
}

const by = new Map();
for (const r of all) {
  const k = `${r.model}\u0000${r.scenarioId}`;
  if (!by.has(k)) by.set(k, []);
  by.get(k).push(r);
}

const infraCount = all.filter((r) => r.infra).length;

const rows = [...by.entries()]
  .map(([k, rs]) => {
    const [model, scenarioId] = k.split("\u0000");
    rs.sort((a, b) => a.when - b.when);
    // A provider error says nothing about the model, so it is neither a pass nor a fail.
    const scored = rs.filter((r) => !r.infra);
    const fails = scored.filter((r) => !r.passed);
    const last = scored[scored.length - 1];
    // The most common reason, which is what makes a row actionable rather than just alarming.
    const tally = new Map();
    for (const f of fails) for (const v of f.violations) tally.set(v, (tally.get(v) ?? 0) + 1);
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      model,
      scenarioId,
      attempts: scored.length,
      infra: rs.length - scored.length,
      fails: fails.length,
      rate: scored.length ? fails.length / scored.length : 0,
      lastPassed: last ? last.passed : true,
      lastFail: fails.length ? fails[fails.length - 1].when : null,
      hardFails: fails.filter((r) => !r.tier0Passed).length,
      why: top ? `${top[0]}${top[1] > 1 ? ` (x${top[1]})` : ""}` : "",
    };
  })
  .filter((r) => r.fails > 0);

const d = (x) => (x ? new Date(x).toISOString().slice(0, 10) : "-");
const pct = (x) => `${Math.round(x * 100)}%`;

console.log(
  `\n${all.length} distinct executions - ${by.size} model x scenario pairs` +
    `${MODEL ? ` - model ${MODEL}` : ""}${SINCE ? ` - since ${d(SINCE)}` : ""}`,
);
if (infraCount) {
  console.log(
    `${infraCount} excluded as PROVIDER/HARNESS errors (no tool calls, no text) - they are not` +
      ` evidence about the model either way.`,
  );
}

const show = (title, list, note) => {
  console.log(`\n=== ${title} (${list.length}) ===`);
  if (note) console.log(note);
  if (!list.length) return console.log("  none");
  console.log("  fails/runs  rate  hard  scenario                       model           last fail");
  for (const r of list) {
    console.log(
      `  ${`${r.fails}/${r.attempts}`.padEnd(11)} ${pct(r.rate).padStart(4)}  ${String(r.hardFails).padStart(4)}  ` +
        `${r.scenarioId.padEnd(30)} ${r.model.padEnd(15)} ${d(r.lastFail)}`,
    );
    if (r.why) console.log(`                 why: ${r.why.slice(0, 160)}`);
  }
};

const eligible = rows.filter((r) => r.attempts >= MIN_ATTEMPTS);
show(
  "PERSISTENT - failed on its most recent run",
  eligible.filter((r) => !r.lastPassed).sort((a, b) => b.rate - a.rate || b.attempts - a.attempts),
  "  hard = failed tier0 (did not do the task at all), vs a tier1 quality check.",
);
show(
  "CHRONIC - passing right now, but fails at least half the time",
  eligible.filter((r) => r.lastPassed && r.rate >= 0.5).sort((a, b) => b.rate - a.rate),
  "  Not broken today, not reliable either.",
);
console.log(
  `\nOccasional (<50%, currently passing): ${eligible.filter((r) => r.lastPassed && r.rate < 0.5).length}` +
    ` | single sighting: ${rows.filter((r) => r.attempts < MIN_ATTEMPTS).length}` +
    ` | never failed: ${by.size - rows.length}`,
);
