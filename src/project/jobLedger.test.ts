import { describe, expect, it } from "vitest";
import {
  APP_SESSION,
  JobLedger,
  JobLedgerUnreadableError,
  JobRecordError,
  jobsPath,
  type JobRecord,
} from "./jobLedger";
import { DIR, MemFs } from "../test/timelineKit";
import { markProjectDirDead, ProjectStoreAccess, reviveProjectDir } from "../tools/store";

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
    order_id: j.order_id,
    started_by: j.started_by,
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

  describe("a job is on disk before its paid call goes out, or the call does not go out", () => {
    const spec = {
      kind: "generation" as const,
      tool: "generate_video",
      label: "a 5s video",
      order_id: "0123456789abcdef0123456789abcdef",
    };

    it("refuses to begin when the record cannot be written, and leaves nothing behind in memory", async () => {
      const { fs, store } = make();
      const ledger = await JobLedger.open(store);
      fs.writeTextFile = async () => {
        throw new Error("disk full");
      };
      await expect(ledger.begin(spec)).rejects.toBeInstanceOf(JobRecordError);
      expect(ledger.list()).toEqual([]);
      expect(ledger.running()).toEqual([]);
      expect(onDisk(fs)).toEqual([]);
    });

    it("says why, in words that tell the person nothing was charged", async () => {
      const { fs, store } = make();
      const ledger = await JobLedger.open(store);
      fs.writeTextFile = async () => {
        throw new Error("disk full");
      };
      const error = (await ledger.begin(spec).catch((e: unknown) => e)) as Error;
      expect(error.message).toMatch(/not started/i);
      expect(error.message).toMatch(/nothing was charged/i);
    });

    it("is not wedged by one failed write: the next begin works and carries only what really began", async () => {
      const { fs, store } = make();
      const ledger = await JobLedger.open(store);
      const realWrite = fs.writeTextFile.bind(fs);
      fs.writeTextFile = async () => {
        throw new Error("disk full");
      };
      await expect(ledger.begin(spec)).rejects.toBeInstanceOf(JobRecordError);
      fs.writeTextFile = realWrite;
      const id = await ledger.begin({ ...spec, label: "second" });
      expect(onDisk(fs).map((r) => r.id)).toEqual([id]);
    });

    it("refuses to begin in a project that has closed, where every write is dropped", async () => {
      const { fs, store } = make();
      const ledger = await JobLedger.open(store);
      markProjectDirDead(DIR);
      try {
        await expect(ledger.begin(spec)).rejects.toBeInstanceOf(JobRecordError);
        expect(ledger.running()).toEqual([]);
      } finally {
        reviveProjectDir(DIR);
      }
      expect(onDisk(fs)).toEqual([]);
    });

    it("never lets a failure to write the END of a job reach the job: it was done, whatever the disk says", async () => {
      const { fs, store } = make();
      const ledger = await JobLedger.open(store);
      const id = await ledger.begin(spec);
      const realWrite = fs.writeTextFile.bind(fs);
      fs.writeTextFile = async () => {
        throw new Error("disk full");
      };
      await expect(ledger.settle(id, { status: "done", media_refs: ["m"] })).resolves.toBe(true);
      fs.writeTextFile = realWrite;
      await ledger.begin({ ...spec, label: "third" });
      expect(onDisk(fs).find((r) => r.id === id)?.status).toBe("done");
    });
  });

  describe("a ledger file that is there but cannot be read is never written over", () => {
    const spec = {
      kind: "generation" as const,
      tool: "generate_video",
      label: "a 5s video",
      order_id: "0123456789abcdef0123456789abcdef",
    };

    function unreadable(fs: MemFs): { fix: () => void } {
      const realRead = fs.readTextFile.bind(fs);
      fs.readTextFile = async (p: string) => {
        if (p === PATH) throw new Error("EACCES: the file is locked");
        return realRead(p);
      };
      return {
        fix: () => {
          fs.readTextFile = realRead;
        },
      };
    }

    it("opens, but refuses to begin a paid job, and leaves the file exactly as it was", async () => {
      const { fs, store } = make();
      seed(fs, [
        { id: "keep", session: "a-previous-launch", order_id: "0123456789abcdef0123456789abcdef" },
      ] as Partial<JobRecord>[]);
      const before = fs.files.get(PATH);
      unreadable(fs);
      const ledger = await JobLedger.open(store);
      expect(ledger.list()).toEqual([]);
      expect(ledger.readable, "a ledger that could not be read says it is fine").toBe(false);
      expect(ledger.unreadableReason).toContain("EACCES: the file is locked");
      const refusal = await ledger.begin(spec).catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(JobLedgerUnreadableError);
      expect(
        (refusal as JobLedgerUnreadableError).reason,
        "the refusal does not say why",
      ).toContain("EACCES: the file is locked");
      expect(fs.files.get(PATH)).toBe(before);
    });

    it("never writes while it cannot read, whatever else happens to it", async () => {
      const { fs, store } = make();
      seed(fs, [
        { id: "keep", session: "a-previous-launch", order_id: "0123456789abcdef0123456789abcdef" },
      ] as Partial<JobRecord>[]);
      const before = fs.files.get(PATH);
      unreadable(fs);
      const ledger = await JobLedger.open(store);
      await ledger.settle("anything", { status: "failed", error: "x" });
      await ledger.begin({ ...spec, kind: "export" }).catch(() => undefined);
      expect(fs.files.get(PATH)).toBe(before);
    });

    it("refuses at the write itself, not only at the doors that lead to it", async () => {
      const { fs, store } = make();
      seed(fs, [
        { id: "keep", session: "a-previous-launch", order_id: "0123456789abcdef0123456789abcdef" },
      ] as Partial<JobRecord>[]);
      const before = fs.files.get(PATH);
      unreadable(fs);
      const ledger = await JobLedger.open(store);
      // No public call reaches the write while the file is unreadable today; one added later must still be stopped here.
      const write = (ledger as unknown as { write(): Promise<void> }).write.bind(ledger);
      await expect(write()).rejects.toBeInstanceOf(JobLedgerUnreadableError);
      expect(fs.files.get(PATH)).toBe(before);
    });

    it("reads it again at the next begin, so a lock that clears needs no restart, and nothing it holds is lost", async () => {
      const { fs, store } = make();
      seed(fs, [
        { id: "keep", session: "a-previous-launch", order_id: "0123456789abcdef0123456789abcdef" },
      ] as Partial<JobRecord>[]);
      const lock = unreadable(fs);
      const ledger = await JobLedger.open(store);
      await expect(ledger.begin(spec)).rejects.toBeInstanceOf(JobLedgerUnreadableError);
      lock.fix();
      const id = await ledger.begin(spec);
      expect(ledger.readable, "a lock that cleared is still reported").toBe(true);
      expect(ledger.unreadableReason).toBe("");
      const disk = onDisk(fs).map((r) => r.id);
      expect(disk).toContain("keep");
      expect(disk).toContain(id);
    });

    it("still opens an empty ledger for a file that is MISSING, and sets a CORRUPT one aside without losing its bytes", async () => {
      const { fs, store } = make();
      expect((await JobLedger.open(store)).list()).toEqual([]);
      fs.files.set(PATH, "{not json");
      const ledger = await JobLedger.open(store);
      expect(ledger.list()).toEqual([]);
      const aside = [...fs.files.keys()].filter((k) => k.startsWith(`${PATH}.corrupt-`));
      expect(aside).toHaveLength(1);
      expect(fs.files.get(aside[0])).toBe("{not json");
      await expect(ledger.begin(spec)).resolves.toBeTruthy();
    });
  });

  describe("a generation the server holds as an order", () => {
    it("records the order number and who asked BEFORE the paid call goes out", async () => {
      const { fs, store } = make();
      const ledger = await JobLedger.open(store);
      const id = await ledger.begin({
        kind: "generation",
        tool: "generate_video",
        label: "a 5s video",
        media_refs: ["media_gen_a"],
        order_id: "0123456789abcdef0123456789abcdef",
        started_by: "chat",
      });
      const rec = onDisk(fs).find((r) => r.id === id)!;
      expect(rec).toMatchObject({
        status: "running",
        order_id: "0123456789abcdef0123456789abcdef",
        started_by: "chat",
        session: APP_SESSION,
      });
    });

    it("is not given up on when the launch that made it is gone: it is taken over, still running", async () => {
      const { fs, store } = make();
      seed(fs, [
        {
          id: "kept",
          session: "a-previous-launch",
          order_id: "0123456789abcdef0123456789abcdef",
          started_by: "chat",
        },
        { id: "plain", session: "a-previous-launch" },
      ] as Partial<JobRecord>[]);

      const ledger = await JobLedger.open(store);

      expect(ledger.adopted().map((r) => r.id)).toEqual(["kept"]);
      expect(ledger.running().map((r) => r.id)).toEqual(["kept"]);
      expect(ledger.interrupted().map((r) => r.id)).toEqual(["plain"]);
      const disk = onDisk(fs);
      expect(disk.find((r) => r.id === "kept")).toMatchObject({
        status: "running",
        session: APP_SESSION,
        started_by: "chat",
      });
      expect(disk.find((r) => r.id === "kept")?.error).toBeUndefined();
    });

    it("is taken over only once: the next open finds it already this launch's own", async () => {
      const { fs, store } = make();
      seed(fs, [
        { id: "kept", session: "a-previous-launch", order_id: "0123456789abcdef0123456789abcdef" },
      ] as Partial<JobRecord>[]);
      await JobLedger.open(store);
      const again = await JobLedger.open(store);
      expect(again.adopted()).toEqual([]);
      expect(again.running().map((r) => r.id)).toEqual(["kept"]);
    });

    it("is left to the launch that owns it", async () => {
      const { fs, store } = make();
      seed(fs, [
        { id: "mine", session: APP_SESSION, order_id: "0123456789abcdef0123456789abcdef" },
      ] as Partial<JobRecord>[]);
      const ledger = await JobLedger.open(store);
      expect(ledger.adopted()).toEqual([]);
      expect(ledger.running().map((r) => r.id)).toEqual(["mine"]);
    });

    it("keeps its order number and who asked when it settles", async () => {
      const { fs, store } = make();
      const ledger = await JobLedger.open(store);
      const id = await ledger.begin({
        kind: "generation",
        tool: "generate_image",
        label: "an image",
        order_id: "0123456789abcdef0123456789abcdef",
        started_by: "elsewhere",
      });
      await ledger.settle(id, { status: "done", media_refs: ["media_x"] });
      expect(onDisk(fs)[0]).toMatchObject({
        status: "done",
        order_id: "0123456789abcdef0123456789abcdef",
        started_by: "elsewhere",
      });
    });

    it("is never dropped by the cap on history while it runs", async () => {
      const { fs, store } = make();
      const old: Partial<JobRecord>[] = Array.from({ length: 60 }, (_, i) => ({
        id: `old${i}`,
        status: "done" as const,
        started_at: i,
        ended_at: i,
      }));
      seed(fs, [
        ...old,
        { id: "kept", session: "a-previous-launch", order_id: "0123456789abcdef0123456789abcdef" },
      ] as Partial<JobRecord>[]);
      const ledger = await JobLedger.open(store);
      await ledger.begin({ kind: "generation", tool: "generate_image", label: "new" });
      expect(
        onDisk(fs)
          .filter((r) => r.status === "running")
          .map((r) => r.id),
      ).toContain("kept");
    });
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
