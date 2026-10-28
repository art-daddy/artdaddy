// Re-queue the macOS jobs of a CI run that never got a runner.
//
// GitHub's macOS arm64 pool is short of capacity. A job that waits about twenty minutes for a runner is
// cancelled with "The job was not acquired by Runner of type hosted even after multiple attempts", and the
// whole run goes red although not a line of our code ran: 12 macOS jobs in 5 runs between 2026-10-26 and
// 10-28, one of them the run for the commit on main. Somebody then had to press "Re-run failed jobs".
//
// This presses it, and ONLY for a job that provably never started: cancelled, on a macOS runner label, with
// no step ever run, and carrying GitHub's own "not acquired" annotation. Everything else stays red for a
// human, because re-running it could only hide something:
//   - a job that ran and failed (a real regression, or a flake the test retries already had their go at),
//   - a job cancelled because a newer push replaced its run ("Canceling since a higher priority waiting
//     request ... exists"): looks the same in the job list, and re-running it would cancel the newer run,
//   - anything on Windows or Linux, and any run that also has a problem somewhere else.
//
// Guard rails, each of them a line of the decision below:
//   - push runs of this repository only (a fork's pull request never reaches a write token),
//   - at most MAX_ATTEMPTS attempts in all, with a wait before each re-queue (the pool recovers in minutes),
//   - never when the branch has moved on, or another CI run for it is active: CI cancels in-progress runs of
//     the same ref, so re-running an old run would cancel the newer one,
//   - decided again after the wait, from fresh reads.
//
//   RUN_ID=123 [RUN_ATTEMPT=1] [DRY_RUN=true] node scripts/ci/macosRequeue.mjs
//
// ci-macos-requeue.yml runs it when CI finishes red; a manual dispatch defaults to a dry run that only says
// what it would do.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The first attempt plus two re-queues. */
export const MAX_ATTEMPTS = 3;

const DONE = new Set(["success", "skipped", "neutral"]);
const ACTIVE = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);
/** GitHub's own wording for a job no runner ever picked up. */
export const NOT_ACQUIRED = /was not acquired by Runner of type hosted/i;

export const isMacos = (job) => (job.labels ?? []).some((label) => /^macos-/i.test(label));

/** How long to wait before asking again: five minutes after the first attempt, ten after the second. */
export const waitSeconds = (attempt) => 300 * attempt;

/** What a job's result says about it: "ok", "never-ran" (safe to run again), or "other" (leave it alone). */
export function classifyJob(job) {
  if (DONE.has(job.conclusion)) return { kind: "ok" };
  if (!isMacos(job)) return { kind: "other", why: `${job.name} is not a macOS job (${job.conclusion})` };
  if (job.conclusion !== "cancelled") return { kind: "other", why: `${job.name} ${job.conclusion} after it ran` };
  if ((job.steps ?? []).length) return { kind: "other", why: `${job.name} was cancelled after it started` };
  if (!Array.isArray(job.annotations))
    return { kind: "other", why: `${job.name} was cancelled before it started, and its annotations could not be read to say why` };
  const lackOfRunner = job.annotations.some((a) => a.annotation_level === "failure" && NOT_ACQUIRED.test(a.message ?? ""));
  if (!lackOfRunner)
    return { kind: "other", why: `${job.name} was cancelled before it started, but not for lack of a runner (${job.annotations.find((a) => a.annotation_level === "failure")?.message ?? "no reason given"})` };
  return { kind: "never-ran" };
}

/** Whether to re-run the failed jobs of `run`, and why not when not. Pure: every fact it needs is an argument.
 *   run     the run as it ended (GET runs/{id}/attempts/{n})
 *   live    the run now ({ status, run_attempt })
 *   jobs    that attempt's jobs, with `annotations` fetched for the ones that never started
 *   tip     the commit its branch points at now, or null when that could not be read
 *   active  the branch's OTHER unfinished CI runs, or null when they could not be listed */
export function decideRequeue({ repository, run, live, jobs, tip, active, maxAttempts = MAX_ATTEMPTS }) {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
  const classified = jobs.map((job) => ({ job, ...classifyJob(job) }));
  const never = classified.filter((c) => c.kind === "never-ran");
  const others = classified.filter((c) => c.kind === "other");

  check("push run", run.event === "push", `it was started by ${run.event}, and only a push is re-queued`);
  check(
    "this repository",
    run.head_repository?.full_name === repository && run.repository?.full_name === repository,
    `its code comes from ${run.head_repository?.full_name ?? "somewhere unknown"}`,
  );
  check("ended red", run.conclusion === "failure", `it ended ${run.conclusion}, not failure (a cancelled run was stopped on purpose or replaced by a newer push)`);
  check("attempts left", run.run_attempt < maxAttempts, `attempt ${run.run_attempt} was the last of ${maxAttempts}`);
  check("nothing else is wrong", others.length === 0, others.map((c) => c.why).join("; "));
  check("a job never started", never.length > 0, "no macOS job was cancelled for lack of a runner");
  check(
    "no newer attempt",
    live?.status === "completed" && live?.run_attempt === run.run_attempt,
    `the run is now ${live?.status} on attempt ${live?.run_attempt}: someone has already re-run it`,
  );
  check(
    "branch has not moved",
    tip != null && tip === run.head_sha,
    tip == null ? `the branch ${run.head_branch} could not be read (deleted?)` : `the branch has moved on to ${tip.slice(0, 8)}`,
  );
  check(
    "no other CI run active",
    Array.isArray(active) && active.length === 0,
    active == null ? "the branch's other runs could not be listed" : `run ${active.map((r) => r.id).join(", ")} is active, and a re-run would cancel it`,
  );

  const rerun = checks.every((c) => c.ok);
  const blocked = checks.find((c) => !c.ok);
  return {
    rerun,
    checks,
    requeue: never.map((c) => c.job.name),
    waitSeconds: rerun ? waitSeconds(run.run_attempt) : 0,
    summary: rerun
      ? `re-queue ${never.length} macOS job${never.length === 1 ? "" : "s"} that never got a runner, after ${waitSeconds(run.run_attempt)} s`
      : `not re-queued: ${blocked.name}: ${blocked.detail}`,
  };
}

const json = (text) => JSON.parse(text);
const encodePath = (name) => name.split("/").map(encodeURIComponent).join("/");

/** Reads everything the decision needs, fresh. A read that fails leaves the fact unknown, which the decision refuses. */
export function assess({ repo, runId, attempt, gh }) {
  const live = json(gh(["api", `repos/${repo}/actions/runs/${runId}`]));
  const n = attempt ?? live.run_attempt;
  const run = json(gh(["api", `repos/${repo}/actions/runs/${runId}/attempts/${n}`]));
  const jobs = json(gh(["api", `repos/${repo}/actions/runs/${runId}/attempts/${n}/jobs?per_page=100`])).jobs;
  for (const job of jobs) {
    // Only a macOS job cancelled before any step can be told apart by its annotation: ask for those alone.
    if (job.conclusion !== "cancelled" || !isMacos(job) || (job.steps ?? []).length) continue;
    try {
      job.annotations = json(gh(["api", `repos/${repo}/check-runs/${job.id}/annotations`]));
    } catch {
      /* left unread: classifyJob refuses a job it cannot explain */
    }
  }
  let tip = null;
  try {
    tip = json(gh(["api", `repos/${repo}/git/ref/heads/${encodePath(run.head_branch ?? "")}`])).object?.sha ?? null;
  } catch {
    /* a deleted branch, or one that cannot be read: not re-queued */
  }
  let active = null;
  try {
    const runs = json(gh(["api", `repos/${repo}/actions/workflows/${run.workflow_id}/runs?branch=${encodeURIComponent(run.head_branch ?? "")}&per_page=30`])).workflow_runs;
    active = runs.filter((r) => r.id !== run.id && ACTIVE.has(r.status));
  } catch {
    /* left unknown: the decision refuses */
  }
  return decideRequeue({ repository: repo, run, live, jobs, tip, active });
}

export function validate({ repo, runId, attempt }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "")) throw new Error(`the repository must be owner/name, got "${repo}"`);
  if (!/^\d{1,20}$/.test(runId ?? "")) throw new Error(`RUN_ID must be a run number, got "${runId}"`);
  if (attempt !== undefined && !/^\d{1,3}$/.test(attempt)) throw new Error(`RUN_ATTEMPT must be an attempt number, got "${attempt}"`);
}

/** Decides, waits, decides again from fresh reads, and only then re-runs the failed jobs. */
export async function requeue({ repo, runId, attempt, dryRun, gh, sleep, log }) {
  validate({ repo, runId, attempt });
  const report = (decision) => {
    for (const c of decision.checks) log(`  ${c.ok ? "ok " : "NO "} ${c.name}${c.ok ? "" : `: ${c.detail}`}`);
    log(decision.summary);
  };
  const first = assess({ repo, runId, attempt: attempt && Number(attempt), gh });
  report(first);
  if (!first.rerun) return { requeued: false, decision: first };
  if (dryRun) {
    log("dry run: nothing was re-run");
    return { requeued: false, decision: first, dryRun: true };
  }
  log(`waiting ${first.waitSeconds} s: macOS capacity recovers in minutes, not seconds`);
  await sleep(first.waitSeconds * 1000);
  const again = assess({ repo, runId, attempt: attempt && Number(attempt), gh });
  log("decided again after the wait:");
  report(again);
  if (!again.rerun) return { requeued: false, decision: again };
  gh(["api", "--method", "POST", `repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`]);
  log(`re-ran the failed jobs of run ${runId}: ${again.requeue.join(", ")}`);
  return { requeued: true, decision: again };
}

function realGh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  return result.stdout;
}

async function main() {
  const env = process.env;
  const lines = [];
  const log = (line) => {
    // A value that carries a newline must never start a line of its own: lines that begin "::" are commands.
    const safe = String(line).replace(/[\r\n]+/g, " ");
    console.log(safe);
    lines.push(safe);
  };
  const result = await requeue({
    repo: env.REPOSITORY || env.GITHUB_REPOSITORY,
    runId: env.RUN_ID,
    attempt: env.RUN_ATTEMPT || undefined,
    dryRun: env.DRY_RUN === "true",
    gh: realGh,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    log,
  });
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `### macOS CI re-queue for run ${env.RUN_ID}\n\n${result.requeued ? "**Re-ran the failed jobs.**" : "**Did not re-run anything.**"}\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n`,
    );
  if (result.requeued) console.log(`::notice title=macOS CI re-queued::run ${env.RUN_ID}: ${result.decision.requeue.join(", ")} never got a runner and was queued again`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.log(`${process.env.GITHUB_ACTIONS ? "::error::" : "ERROR: "}${error.message}`);
    process.exit(1);
  });
}
