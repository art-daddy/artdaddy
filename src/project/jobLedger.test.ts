import { describe, expect, it } from "vitest";
import { APP_SESSION, JobLedger, jobsPath, type JobRecord } from "./jobLedger";
import { DIR, MemFs } from "../test/timelineKit";
import { ProjectStoreAccess } from "../tools/store";

const PATH = jobsPath(DIR);

function seed(fs: MemFs, jobs: Partial<JobRecord>[]): void {
  const full = jobs.map((j, i) => ({
    id: j.id ?? `j${i}`,
    kind: j.kind ?? "generation",
    tool: j.tool ?? "generate_image",
    label: j.label ?? "an image",
    status: j.status ?? "running",
    started_at: j.started_at ?? 1000 + i,
    ended_at: j.ended_at,
    error: j.error,
    stderr_tail: j.stderr_tail,
    media_refs: j.media_refs,
    session: j.session ?? APP_SESSION,
  }));
  fs.files.set(PATH, JSON.stringify({ version: 1, jobs: full }));
}

function onDisk(fs: MemFs): JobRecord[] {
  const raw = fs.files.get(PATH);
  return raw ? (JSON.parse(raw).jobs as JobRecord[]) : [];
}

function make(): { fs: MemFs; store: ProjectStoreAccess } {
  const fs = new MemFs();
  return { fs, store: new ProjectStoreAccess(DIR, fs) };
}

describe("job ledger", () => {
  it("settles a job the previous app launch left running", async () => {
    const { fs, store } = make();
    seed(fs, [{ id: "dead", session: "a-previous-launch" }]);

    const ledger = await JobLedger.open(store);

    expect(ledger.interrupted().map((r) => r.id)).toEqual(["dead"]);
    // The reconciliation must reach the FILE, not just memory: the next launch has to see it too.
    const [rec] = onDisk(fs);
    expect(rec.status).toBe("interrupted");
    expect(rec.ended_at).toBeGreaterThan(0);
    expect(rec.error).toMatch(/charged/i);
  });

  // The failure direction: a project switch deliberately leaves generation running, so reopening
  // must NOT settle it. Reconciling on "reopen" alone would kill live work and report a lie.
  it("leaves a job from THIS launch running, so reopening after a switch keeps live work", async () => {
    const { fs, store } = make();
    seed(fs, [{ id: "alive", session: APP_SESSION }]);

    const ledger = await JobLedger.open(store);

    expect(ledger.interrupted()).toEqual([]);
    expect(ledger.running().map((r) => r.id)).toEqual(["alive"]);
    expect(onDisk(fs)[0].status).toBe("running");
  });

  it("tells the two apart in one ledger", async () => {
    const { fs, store } = make();
    seed(fs, [
      { id: "alive", session: APP_SESSION },
      { id: "dead", session: "a-previous-launch" },
    ]);

    const ledger = await JobLedger.open(store);

    expect(ledger.running().map((r) => r.id)).toEqual(["alive"]);
    expect(ledger.interrupted().map((r) => r.id)).toEqual(["dead"]);
  });

  it("records a job BEFORE the paid call, so a crash mid-call still leaves a trace", async () => {
    const { fs, store } = make();
    const ledger = await JobLedger.open(store);

    const id = await ledger.begin({
      kind: "generation",
      tool: "generate_video",
      label: "a 5s video",
    });

    const [rec] = onDisk(fs);
    expect(rec.id).toBe(id);
    expect(rec.status).toBe("running");
    expect(rec.session).toBe(APP_SESSION);
  });

  it("refuses a late completion for a job already settled", async () => {
    const { fs, store } = make();
    seed(fs, [{ id: "dead", session: "a-previous-launch" }]);
    const ledger = await JobLedger.open(store);

    const applied = await ledger.settle("dead", { status: "done", media_refs: ["media_x"] });

    expect(applied).toBe(false);
    expect(onDisk(fs)[0].status).toBe("interrupted");
    expect(onDisk(fs)[0].media_refs).toBeUndefined();
  });

  it("settles a failure with its reason", async () => {
    const { fs, store } = make();
    const ledger = await JobLedger.open(store);
    const id = await ledger.begin({ kind: "generation", tool: "generate_music", label: "a bed" });

    await ledger.settle(id, {
      status: "failed",
      error: "content filter",
      stderr_tail: "provider response 400",
    });

    expect(onDisk(fs)[0]).toMatchObject({
      status: "failed",
      error: "content filter",
      stderr_tail: "provider response 400",
    });
  });

  it("records an intentional cancellation as cancellation, not failure", async () => {
    const { fs, store } = make();
    const ledger = await JobLedger.open(store);
    const id = await ledger.begin({ kind: "export", tool: "export", label: "an export" });

    await ledger.settle(id, { status: "cancelled", error: "export cancelled" });

    expect(onDisk(fs)[0]).toMatchObject({
      status: "cancelled",
      error: "export cancelled",
    });
  });

  // Two generations finishing together is the normal case, not an edge case: the model is told to
  // parallelize independent gens.
  it("does not lose either of two jobs settling at the same time", async () => {
    const { fs, store } = make();
    const ledger = await JobLedger.open(store);
    const a = await ledger.begin({ kind: "generation", tool: "generate_image", label: "a" });
    const b = await ledger.begin({ kind: "generation", tool: "generate_image", label: "b" });

    await Promise.all([
      ledger.settle(a, { status: "done", media_refs: ["media_a"] }),
      ledger.settle(b, { status: "done", media_refs: ["media_b"] }),
    ]);

    const disk = onDisk(fs);
    expect(disk).toHaveLength(2);
    expect(disk.every((r) => r.status === "done")).toBe(true);
    expect(disk.flatMap((r) => r.media_refs ?? []).sort()).toEqual(["media_a", "media_b"]);
  });

  it("opens with an empty ledger when the file is corrupt rather than refusing to open", async () => {
    const { fs, store } = make();
    fs.files.set(PATH, "{not json");

    const ledger = await JobLedger.open(store);

    expect(ledger.list()).toEqual([]);
  });

  it("opens when there is no ledger at all", async () => {
    const { store } = make();
    const ledger = await JobLedger.open(store);
    expect(ledger.list()).toEqual([]);
  });

  it("caps terminal history but never drops a running job", async () => {
    const { fs, store } = make();
    const old: Partial<JobRecord>[] = Array.from({ length: 60 }, (_, i) => ({
      id: `old${i}`,
      status: "done" as const,
      started_at: i,
      ended_at: i,
    }));
    seed(fs, [...old, { id: "alive", session: APP_SESSION }]);
    const ledger = await JobLedger.open(store);

    await ledger.begin({ kind: "generation", tool: "generate_image", label: "new" });

    const disk = onDisk(fs);
    expect(disk.filter((r) => r.status === "running").map((r) => r.id)).toContain("alive");
    expect(disk.filter((r) => r.status === "done")).toHaveLength(50);
    // Newest kept, oldest cut.
    expect(disk.some((r) => r.id === "old59")).toBe(true);
    expect(disk.some((r) => r.id === "old0")).toBe(false);
  });
});
