import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  assess,
  classifyJob,
  decideRequeue,
  isMacos,
  MAX_ATTEMPTS,
  NOT_ACQUIRED,
  requeue,
  waitSeconds,
} from "./macosRequeue.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const REPO = "art-daddy/artdaddy";

// Real GitHub payloads (see each file's _provenance), trimmed to what the decision reads.
const real = (name) => JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));
const NEVER_RAN_MAIN = () => real("ci-run-40729832767-a1.json"); // 1 macOS job never got a runner, on main
const NEVER_RAN_FOUR = () => real("ci-run-40721246494-a1.json"); // all 4 macOS jobs
const NEVER_RAN_THREE = () => real("ci-run-40547914618-a1.json");
const NEVER_RAN_AGAIN = () => real("ci-run-40547914618-a2.json"); // the manual rerun hit the wall again
const MAC_TEST_FAILED = () => real("ci-run-40729832345-a1.json"); // a test timed out after the job ran
const MAC_HOOK_FAILED = () => real("ci-run-40177121333-a1.json");
const OTHER_OS_FAILED = () => real("ci-run-39748809973-a1.json"); // Windows + Linux failed for real
const REPLACED_BY_PUSH = () => real("ci-run-39599810500-a1.json"); // cancelled by a newer push

function decide(fixture, { tip = fixture.run.head_sha, active = [], live, run = {}, repository = REPO, maxAttempts } = {}) {
  const r = { ...fixture.run, ...run };
  return decideRequeue({
    repository,
    run: r,
    live: live ?? { status: "completed", run_attempt: r.run_attempt },
    jobs: structuredClone(fixture.jobs),
    tip,
    active,
    maxAttempts,
  });
}
const failedCheck = (decision) => decision.checks.find((c) => !c.ok)?.name;

describe("a macOS job that never got a runner is queued again", () => {
  it("re-queues the run where main's macOS browser job was never picked up", () => {
    const d = decide(NEVER_RAN_MAIN());
    expect(d.rerun).toBe(true);
    expect(d.requeue).toEqual(["real-browser UI + compositor pixels (macos-14)"]);
    expect(d.waitSeconds).toBe(300);
  });

  it("re-queues all four jobs of a run where the whole macOS pool was out", () => {
    const d = decide(NEVER_RAN_FOUR());
    expect(d.rerun).toBe(true);
    expect(d.requeue).toHaveLength(4);
    expect(d.requeue.every((name) => name.includes("macos-14"))).toBe(true);
  });

  it("goes again when the rerun hit the same wall, with a longer wait, and stops after the last attempt", () => {
    const second = decide(NEVER_RAN_AGAIN());
    expect(NEVER_RAN_AGAIN().run.run_attempt).toBe(2);
    expect(second.rerun).toBe(true);
    expect(second.waitSeconds).toBe(600);
    // the same wall once more on the third attempt: that is the last one, a person looks next
    const third = decide(NEVER_RAN_AGAIN(), { run: { run_attempt: 3 }, live: { status: "completed", run_attempt: 3 } });
    expect(third.rerun).toBe(false);
    expect(failedCheck(third)).toBe("attempts left");
    expect(third.summary).toMatch(/attempt 3 was the last of 3/);
  });

  it("waits longer before every further attempt, and never longer than the job can stay alive", () => {
    const waits = Array.from({ length: MAX_ATTEMPTS - 1 }, (_, i) => waitSeconds(i + 1));
    expect(waits).toEqual([...waits].sort((a, b) => a - b));
    expect(new Set(waits).size).toBe(waits.length);
    const workflow = readFileSync(join(root, ".github", "workflows", "ci-macos-requeue.yml"), "utf8");
    const timeout = Number(/timeout-minutes:\s*(\d+)/.exec(workflow)[1]);
    expect(timeout * 60).toBeGreaterThan(Math.max(...waits) + 600);
  });
});

describe("what is never re-queued", () => {
  it("a macOS job that ran and failed: that is a result, not an absence", () => {
    for (const make of [MAC_TEST_FAILED, MAC_HOOK_FAILED]) {
      const d = decide(make());
      expect(d.rerun).toBe(false);
      expect(failedCheck(d)).toBe("nothing else is wrong");
      expect(d.summary).toMatch(/failure after it ran/);
    }
  });

  it("failures on Windows or Linux, which a macOS retry would only paper over", () => {
    const d = decide(OTHER_OS_FAILED());
    expect(d.rerun).toBe(false);
    expect(d.summary).toMatch(/is not a macOS job/);
  });

  it("a run a newer push replaced: its jobs look the same, but nobody ran out of capacity", () => {
    const d = decide(REPLACED_BY_PUSH());
    expect(d.rerun).toBe(false);
    // cancelled runs are turned away at the door, and the jobs would be too
    expect(failedCheck(d)).toBe("ended red");
    expect(d.checks.filter((c) => !c.ok).map((c) => c.name)).toContain("nothing else is wrong");
    // Even if GitHub had ended that run as a failure, the jobs' own annotation says why they stopped.
    const asFailure = decide(REPLACED_BY_PUSH(), { run: { conclusion: "failure" } });
    expect(asFailure.rerun).toBe(false);
    expect(asFailure.summary).toMatch(/not for lack of a runner \(Canceling since a higher priority waiting request/);
  });

  it("a run with a never-started macOS job AND a real failure somewhere else", () => {
    const mixed = NEVER_RAN_MAIN();
    const windowsFailure = OTHER_OS_FAILED().jobs.find((j) => j.conclusion === "failure" && j.labels.includes("windows-latest"));
    mixed.jobs = mixed.jobs.map((j) => (j.name.startsWith("export suite (windows") ? windowsFailure : j));
    const d = decide(mixed);
    expect(d.rerun).toBe(false);
    expect(d.summary).toMatch(/export suite \(windows-latest\) is not a macOS job/);
  });

  it("a job it cannot explain: if the annotations cannot be read, it is left alone", () => {
    const fixture = NEVER_RAN_MAIN();
    for (const job of fixture.jobs) delete job.annotations;
    const d = decide(fixture);
    expect(d.rerun).toBe(false);
    expect(d.summary).toMatch(/annotations could not be read/);
  });

  it("a job cancelled after it started, even with the 'not acquired' wording somewhere in it", () => {
    const fixture = NEVER_RAN_MAIN();
    const job = fixture.jobs.find((j) => j.conclusion === "cancelled");
    job.steps = [{ name: "Set up job", conclusion: "success" }];
    expect(decide(fixture).rerun).toBe(false);
  });

  it("a Windows or Linux job that never got a runner either: this is for the macOS pool, as asked", () => {
    for (const label of ["windows-latest", "ubuntu-22.04"]) {
      const fixture = NEVER_RAN_MAIN();
      fixture.jobs.find((j) => j.conclusion === "cancelled").labels = [label];
      const d = decide(fixture);
      expect(d.rerun, label).toBe(false);
      expect(d.summary, label).toMatch(/is not a macOS job \(cancelled\)/);
    }
  });

  it("a pull request, a run from another repository, and a run that did not fail", () => {
    expect(failedCheck(decide(NEVER_RAN_MAIN(), { run: { event: "pull_request" } }))).toBe("push run");
    expect(failedCheck(decide(NEVER_RAN_MAIN(), { run: { head_repository: { full_name: "someone/fork" } } }))).toBe("this repository");
    expect(failedCheck(decide(NEVER_RAN_MAIN(), { repository: "someone/else" }))).toBe("this repository");
    for (const conclusion of ["success", "cancelled", "timed_out", null])
      expect(failedCheck(decide(NEVER_RAN_MAIN(), { run: { conclusion } })), String(conclusion)).toBe("ended red");
  });

  it("a branch that has moved on, one that is gone or unreadable, or another CI run still going", () => {
    expect(failedCheck(decide(NEVER_RAN_MAIN(), { tip: "f".repeat(40) }))).toBe("branch has not moved");
    expect(decide(NEVER_RAN_MAIN(), { tip: "f".repeat(40) }).summary).toMatch(/moved on to ffffffff/);
    expect(failedCheck(decide(NEVER_RAN_MAIN(), { tip: null }))).toBe("branch has not moved");
    expect(failedCheck(decide(NEVER_RAN_MAIN(), { active: [{ id: 99, status: "in_progress" }] }))).toBe("no other CI run active");
    expect(decide(NEVER_RAN_MAIN(), { active: [{ id: 99, status: "queued" }] }).summary).toMatch(/run 99 is active/);
    expect(failedCheck(decide(NEVER_RAN_MAIN(), { active: null }))).toBe("no other CI run active");
  });

  it("a run somebody has already re-run, or is re-running", () => {
    expect(failedCheck(decide(NEVER_RAN_MAIN(), { live: { status: "completed", run_attempt: 2 } }))).toBe("no newer attempt");
    expect(failedCheck(decide(NEVER_RAN_MAIN(), { live: { status: "in_progress", run_attempt: 1 } }))).toBe("no newer attempt");
  });

  it("knows a macOS job by the runner label CI really uses, and none of the others", () => {
    const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
    const labels = [...ci.matchAll(/os:\s*\[([^\]]+)\]/g)].flatMap((m) => m[1].split(",").map((s) => s.trim()));
    expect(labels.length).toBeGreaterThan(2);
    for (const label of new Set(labels)) expect(isMacos({ labels: [label] }), label).toBe(/mac/i.test(label));
    expect(isMacos({ labels: [] })).toBe(false);
    expect(isMacos({})).toBe(false);
  });
});

describe("the rules hold for any run at all", () => {
  const annotation = fc.constantFrom(
    { annotation_level: "failure", message: "The job was not acquired by Runner of type hosted even after multiple attempts" },
    { annotation_level: "failure", message: "Canceling since a higher priority waiting request for ci-CI-refs/heads/x exists" },
    { annotation_level: "failure", message: "Process completed with exit code 1." },
    { annotation_level: "notice", message: "The job was not acquired by Runner of type hosted even after multiple attempts" },
    { annotation_level: "notice", message: "Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times." },
  );
  const job = fc.record({
    id: fc.integer({ min: 1, max: 1e6 }),
    name: fc.string({ minLength: 1, maxLength: 12 }),
    conclusion: fc.constantFrom("success", "skipped", "failure", "cancelled", "timed_out", null),
    labels: fc.constantFrom(["macos-14"], ["windows-latest"], ["ubuntu-22.04"], []),
    steps: fc.array(fc.record({ name: fc.string(), conclusion: fc.constantFrom("success", "failure", null) }), { maxLength: 2 }),
    annotations: fc.option(fc.array(annotation, { maxLength: 3 }), { nil: undefined }),
  });
  const SHA = "a".repeat(40);
  const input = fc.record({
    run: fc.record({
      id: fc.constant(1),
      event: fc.constantFrom("push", "pull_request", "schedule"),
      conclusion: fc.constantFrom("failure", "cancelled", "success", "timed_out"),
      run_attempt: fc.integer({ min: 1, max: 5 }),
      head_sha: fc.constant(SHA),
      head_branch: fc.constant("main"),
      head_repository: fc.record({ full_name: fc.constantFrom(REPO, "x/y") }),
      repository: fc.constant({ full_name: REPO }),
    }),
    jobs: fc.array(job, { maxLength: 8 }),
    tip: fc.constantFrom(SHA, "b".repeat(40), null),
    active: fc.constantFrom([], [{ id: 2, status: "in_progress" }], null),
    liveStatus: fc.constantFrom("completed", "in_progress"),
    liveAttempt: fc.integer({ min: 1, max: 5 }),
  });
  const lackOfRunner = (j) =>
    j.conclusion === "cancelled" &&
    (j.labels ?? []).some((l) => l.startsWith("macos-")) &&
    j.steps.length === 0 &&
    (j.annotations ?? []).some((a) => a.annotation_level === "failure" && /not acquired by Runner of type hosted/.test(a.message));

  it("re-queues only a job that provably never ran, only on a push to this repository, within the attempts, on a branch still at that commit with nothing else running", () => {
    fc.assert(
      fc.property(input, (i) => {
        const d = decideRequeue({
          repository: REPO,
          run: i.run,
          live: { status: i.liveStatus, run_attempt: i.liveAttempt },
          jobs: i.jobs,
          tip: i.tip,
          active: i.active,
        });
        if (!d.rerun) {
          expect(d.waitSeconds).toBe(0);
          return;
        }
        // every job that is not simply fine is one that never started for lack of a runner
        for (const j of i.jobs) if (!["success", "skipped"].includes(j.conclusion)) expect(lackOfRunner(j), j.name).toBe(true);
        expect(i.jobs.some(lackOfRunner)).toBe(true);
        expect(d.requeue).toEqual(i.jobs.filter(lackOfRunner).map((j) => j.name));
        expect(i.run.event).toBe("push");
        expect(i.run.head_repository.full_name).toBe(REPO);
        expect(i.run.conclusion).toBe("failure");
        expect(i.run.run_attempt).toBeLessThan(MAX_ATTEMPTS);
        expect(i.tip).toBe(i.run.head_sha);
        expect(i.active).toEqual([]);
        expect(i.liveStatus).toBe("completed");
        expect(i.liveAttempt).toBe(i.run.run_attempt);
        expect(d.waitSeconds).toBeGreaterThan(0);
      }),
      { numRuns: 400 },
    );
  });

  it("never re-queues a run that has a job which ran and failed, however the rest looks", () => {
    fc.assert(
      fc.property(input, (i) => {
        const ranAndFailed = { id: 7, name: "ran", conclusion: "failure", labels: ["macos-14"], steps: [{ name: "x", conclusion: "failure" }] };
        const d = decideRequeue({
          repository: REPO,
          run: { ...i.run, event: "push", conclusion: "failure", run_attempt: 1, head_repository: { full_name: REPO } },
          live: { status: "completed", run_attempt: 1 },
          jobs: [...i.jobs, ranAndFailed],
          tip: SHA,
          active: [],
        });
        expect(d.rerun).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it("classifies a job by what happened to it and nothing else", () => {
    const never = { name: "j", conclusion: "cancelled", labels: ["macos-14"], steps: [], annotations: [{ annotation_level: "failure", message: "The job was not acquired by Runner of type hosted even after multiple attempts" }] };
    expect(classifyJob(never).kind).toBe("never-ran");
    expect(NOT_ACQUIRED.test("The job was not acquired by Runner of type hosted even after multiple attempts")).toBe(true);
    expect(classifyJob({ ...never, conclusion: "success" }).kind).toBe("ok");
    expect(classifyJob({ ...never, conclusion: "failure" }).kind).toBe("other");
    expect(classifyJob({ ...never, labels: ["windows-latest"] }).kind).toBe("other");
    expect(classifyJob({ ...never, steps: [{ name: "s", conclusion: null }] }).kind).toBe("other");
    expect(classifyJob({ ...never, annotations: [{ annotation_level: "notice", message: never.annotations[0].message }] }).kind).toBe("other");
  });
});

/** A GitHub that answers from a real run's payloads and records every call. */
function fakeGithub(fixture, state = {}) {
  const world = { tip: fixture.run.head_sha, active: [], liveAttempt: fixture.run.run_attempt, liveStatus: "completed", failAnnotations: false, failActive: false, failPost: false, ...state };
  const calls = [];
  const posts = [];
  const { run, jobs } = fixture;
  const base = `repos/${run.repository.full_name}`;
  const gh = (args) => {
    calls.push(args);
    if (args.includes("--method")) {
      posts.push({ method: args[args.indexOf("--method") + 1], path: args.at(-1) });
      if (world.failPost) throw new Error("gh api failed: HTTP 403 Workflow is already running");
      return "";
    }
    if (args.length !== 2 || args[0] !== "api") throw new Error(`unexpected gh call: ${args.join(" ")}`);
    const path = args[1];
    if (path === `${base}/actions/runs/${run.id}`) return JSON.stringify({ ...run, status: world.liveStatus, run_attempt: world.liveAttempt });
    if (path === `${base}/actions/runs/${run.id}/attempts/${run.run_attempt}`) return JSON.stringify(run);
    if (path === `${base}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`)
      return JSON.stringify({ jobs: jobs.map(({ annotations, ...job }) => job) }); // GitHub does not inline annotations
    const annotations = /check-runs\/(\d+)\/annotations$/.exec(path);
    if (annotations) {
      if (world.failAnnotations) throw new Error("gh api failed: HTTP 403");
      return JSON.stringify(jobs.find((j) => String(j.id) === annotations[1]).annotations ?? []);
    }
    if (path.startsWith(`${base}/git/ref/heads/`)) {
      if (world.tip == null) throw new Error("gh api failed: HTTP 404");
      return JSON.stringify({ object: { sha: world.tip } });
    }
    if (path.startsWith(`${base}/actions/workflows/${run.workflow_id}/runs?`)) {
      if (world.failActive) throw new Error("gh api failed: HTTP 500");
      return JSON.stringify({ workflow_runs: world.active });
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { gh, calls, posts, world };
}

const runRequeue = (fixture, { state, dryRun = false, attempt = String(fixture.run.run_attempt), onSleep } = {}) => {
  const github = fakeGithub(fixture, state);
  const slept = [];
  const log = [];
  const promise = requeue({
    repo: REPO,
    runId: String(fixture.run.id),
    attempt,
    dryRun,
    gh: github.gh,
    sleep: async (ms) => {
      slept.push(ms);
      onSleep?.(github.world);
    },
    log: (line) => log.push(line),
  });
  return { ...github, slept, log, promise };
};
const RERUN_PATH = `repos/${REPO}/actions/runs/${NEVER_RAN_MAIN().run.id}/rerun-failed-jobs`;

describe("the whole procedure, against GitHub's real answers", () => {
  it("waits, looks again, and then re-runs the failed jobs exactly once", async () => {
    const t = runRequeue(NEVER_RAN_MAIN());
    const result = await t.promise;
    expect(result.requeued).toBe(true);
    expect(t.slept).toEqual([300_000]);
    expect(t.posts).toEqual([{ method: "POST", path: RERUN_PATH }]);
    expect(t.log.join("\n")).toMatch(/re-ran the failed jobs of run 40729832767: real-browser UI/);
    // everything else it did was a read
    expect(t.calls.filter((c) => !c.includes("--method")).every((c) => c.length === 2 && c[0] === "api")).toBe(true);
  });

  it("changes nothing on a dry run, and says what it would have done", async () => {
    const t = runRequeue(NEVER_RAN_MAIN(), { dryRun: true });
    const result = await t.promise;
    expect(result).toMatchObject({ requeued: false, dryRun: true });
    expect(result.decision.rerun).toBe(true);
    expect(t.posts).toEqual([]);
    expect(t.slept).toEqual([]);
    expect(t.log.at(-1)).toBe("dry run: nothing was re-run");
  });

  it("decides again after the wait: a branch that moved on while it waited is left alone", async () => {
    const t = runRequeue(NEVER_RAN_MAIN(), { onSleep: (w) => (w.tip = "c".repeat(40)) });
    const result = await t.promise;
    expect(result.requeued).toBe(false);
    expect(t.posts).toEqual([]);
    expect(t.log.join("\n")).toMatch(/NO  branch has not moved: the branch has moved on to cccccccc/);
  });

  it("decides again after the wait: a run somebody re-ran by hand, or a new run that started, is left alone", async () => {
    const byHand = runRequeue(NEVER_RAN_MAIN(), { onSleep: (w) => ((w.liveAttempt = 2), (w.liveStatus = "in_progress")) });
    expect((await byHand.promise).requeued).toBe(false);
    expect(byHand.posts).toEqual([]);
    const newRun = runRequeue(NEVER_RAN_MAIN(), { onSleep: (w) => w.active.push({ id: 5, status: "queued" }) });
    expect((await newRun.promise).requeued).toBe(false);
    expect(newRun.posts).toEqual([]);
  });

  it("does nothing when it cannot read what it needs to be sure: annotations, the branch, or the other runs", async () => {
    for (const state of [{ failAnnotations: true }, { tip: null }, { failActive: true }]) {
      const t = runRequeue(NEVER_RAN_MAIN(), { state });
      expect((await t.promise).requeued, JSON.stringify(state)).toBe(false);
      expect(t.posts).toEqual([]);
      expect(t.slept).toEqual([]);
    }
  });

  it("never touches a run whose macOS job ran and failed", async () => {
    for (const make of [MAC_TEST_FAILED, MAC_HOOK_FAILED, OTHER_OS_FAILED, REPLACED_BY_PUSH]) {
      const t = runRequeue(make());
      expect((await t.promise).requeued).toBe(false);
      expect(t.posts).toEqual([]);
    }
  });

  it("fails loudly when GitHub refuses the re-run, instead of reporting it done", async () => {
    const t = runRequeue(NEVER_RAN_MAIN(), { state: { failPost: true } });
    await expect(t.promise).rejects.toThrow(/Workflow is already running/);
  });

  it("looks at the attempt it was told about, and at the latest when it is not told", () => {
    const github = fakeGithub(NEVER_RAN_MAIN());
    expect(assess({ repo: REPO, runId: 40729832767, attempt: undefined, gh: github.gh }).rerun).toBe(true);
    expect(assess({ repo: REPO, runId: 40729832767, attempt: 1, gh: github.gh }).rerun).toBe(true);
  });

  it("refuses anything that is not a repository, a run number and an attempt number, before it asks GitHub anything", async () => {
    const bad = [
      { repo: "no-slash", runId: "1" },
      { repo: "a/b; rm -rf /", runId: "1" },
      { repo: REPO, runId: "1; echo" },
      { repo: REPO, runId: "$(id)" },
      { repo: REPO, runId: "" },
      { repo: REPO, runId: "1", attempt: "x" },
      { repo: REPO, runId: "1", attempt: "-1" },
    ];
    for (const args of bad) {
      const calls = [];
      await expect(requeue({ ...args, dryRun: true, gh: (a) => (calls.push(a), "{}"), sleep: async () => {}, log: () => {} })).rejects.toThrow(/must be|got/);
      expect(calls, JSON.stringify(args)).toEqual([]);
    }
  });
});

describe("the workflow that runs it", () => {
  const yml = readFileSync(join(root, ".github", "workflows", "ci-macos-requeue.yml"), "utf8").replace(/\r\n/g, "\n");
  const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8").replace(/\r\n/g, "\n");
  const block = (text, key) => new RegExp(`^${key}:\\n((?: {2}.*\\n|\\n)*)`, "m").exec(`${text}\n`)?.[1] ?? null;

  it("is triggered by CI finishing and by hand, and by nothing an outsider can start", () => {
    const on = block(yml, "on");
    expect([...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]).sort()).toEqual(["workflow_dispatch", "workflow_run"]);
    expect(yml).not.toMatch(/pull_request|^\s*push:|issue_comment|pull_request_target/m);
    const named = /^name:\s*(.+)$/m.exec(ci)[1].trim();
    expect(on).toMatch(new RegExp(`workflows:\\s*\\[${named}\\]`));
    expect(on).toMatch(/types:\s*\[completed\]/);
  });

  it("holds exactly the permissions it uses, and no more", () => {
    const granted = Object.fromEntries([...block(yml, "permissions").matchAll(/^ {2}([a-z-]+):\s*(\S+)/gm)].map((m) => [m[1], m[2]]));
    expect(granted).toEqual({ actions: "write", checks: "read", contents: "read" });
  });

  it("only looks at failed push runs of this repository, before it does anything", () => {
    const cond = /^ {4}if: >-\n((?: {6}.*\n)+)/m.exec(yml)[1];
    expect(cond).toMatch(/workflow_dispatch/);
    expect(cond).toMatch(/workflow_run\.conclusion == 'failure'/);
    expect(cond).toMatch(/workflow_run\.event == 'push'/);
    expect(cond).toMatch(/workflow_run\.head_repository\.full_name == github\.repository/);
  });

  it("splices only numbers, the repository and its own token into anything, and never into a command", () => {
    const allowed = new Set([
      "github.event.workflow_run.id || inputs.run_id",
      "github.event.workflow_run.run_attempt || inputs.attempt",
      "github.event_name == 'workflow_dispatch' && inputs.dry_run",
      "github.repository",
      "github.token",
    ]);
    const used = [...yml.matchAll(/\$\{\{\s*(.*?)\s*\}\}/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(3);
    for (const expression of used) expect(allowed.has(expression), expression).toBe(true);
    // not into a shell: no `run:` value, inline or block, holds an expression
    const runs = [...yml.matchAll(/^ *run:(.*(?:\n {10,}.*)*)/gm)].map((m) => m[1]);
    expect(runs.length).toBe(1);
    for (const command of runs) expect(command).not.toContain("${{");
    expect(runs[0].trim()).toBe("node scripts/ci/macosRequeue.mjs");
  });

  it("runs reviewed code only: first-party actions, the default branch's checkout, and no token left in it", () => {
    const uses = [...yml.matchAll(/^\s*- uses:\s*(\S+)/gm)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(1);
    for (const action of uses) expect(action, action).toMatch(/^actions\/(checkout|setup-node)@v\d+$/);
    expect(yml).toMatch(/uses: actions\/checkout@v4\n {8}with:\n {10}persist-credentials: false/);
    expect(yml).not.toMatch(/ref:\s/);
  });

  it("serialises per run and never cancels a wait already under way", () => {
    expect(block(yml, "concurrency")).toMatch(/group: ci-macos-requeue-\$\{\{ github\.event\.workflow_run\.id \|\| inputs\.run_id \}\}/);
    expect(block(yml, "concurrency")).toMatch(/cancel-in-progress: false/);
  });

  it("is the script that is in the repository, on a cheap runner", () => {
    expect(readFileSync(join(root, "scripts", "ci", "macosRequeue.mjs"), "utf8")).toContain("RUN_ID");
    expect(yml).toMatch(/runs-on: ubuntu-/);
    for (const name of ["GH_TOKEN", "REPOSITORY", "RUN_ID", "RUN_ATTEMPT", "DRY_RUN"]) expect(yml).toContain(`${name}:`);
  });
});
