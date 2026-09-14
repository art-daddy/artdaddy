import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemFs } from "../test/timelineKit";
import { joinPath } from "./store";
import {
  claimProjectLock,
  foreignProjectLock,
  HEARTBEAT_MS,
  readProjectLock,
  releaseProjectLock,
} from "./projectLock";

/** timelineKit's MemFs has no `remove`, and releaseProjectLock calls it optionally — so
 *  without this the release test passes against a function that does nothing at all. */
class LockFs extends MemFs {
  async remove(p: string): Promise<void> {
    this.files.delete(joinPath(p));
  }
}

const DIR = "D:/Dropbox/Hero";
const LOCK = `${DIR}/internals/.lock`;

/** A lock written by a DIFFERENT app run. The module's own instance id is private and
 *  per-run, so the only way to model "someone else" is to write the file directly. */
async function foreignLock(fs: MemFs, at: number): Promise<void> {
  await fs.writeTextFile(LOCK, JSON.stringify({ instance: "other-machine", at }));
}

describe("project lock", () => {
  let fs: LockFs;
  beforeEach(() => {
    fs = new LockFs();
  });

  it("does not report OUR OWN lock as someone else's", async () => {
    // The failure that would make this useless: warning the user about themselves on every
    // reopen. A claim followed by a read must look clear.
    await claimProjectLock(fs, DIR);
    expect(await fs.exists(LOCK)).toBe(true);
    expect(await readProjectLock(fs, DIR)).toBeNull();
    expect(await foreignProjectLock(fs, DIR)).toBeNull();
  });

  it("reports a recent lock from another run, and ignores a long-dead one", async () => {
    const now = Date.parse("2026-08-16T12:00:00Z");
    await foreignLock(fs, now - 10_000);
    expect(await foreignProjectLock(fs, DIR, now)).toMatchObject({ instance: "other-machine" });
    // A CRASHED instance stops beating, so its claim dies in about a minute instead of
    // warning about a phantom editor all day (reported 2026-08-17: the banner was still up
    // with a single app running).
    await foreignLock(fs, now - 5 * 60 * 1000);
    expect(await foreignProjectLock(fs, DIR, now)).toBeNull();
  });

  it("treats an unreadable lock as no lock", async () => {
    // A corrupt byte must never be able to lock someone out of their own project.
    await fs.writeTextFile(LOCK, "{not json");
    expect(await readProjectLock(fs, DIR)).toBeNull();
    expect(await foreignProjectLock(fs, DIR)).toBeNull();
  });

  it("releases only our own lock, never someone else's", async () => {
    // Releasing on the way out of a project another machine has since claimed would hand
    // them a false all-clear.
    await foreignLock(fs, Date.now());
    await releaseProjectLock(fs, DIR);
    expect(await fs.exists(LOCK)).toBe(true);
    // Ours goes.
    await claimProjectLock(fs, DIR);
    await releaseProjectLock(fs, DIR);
    expect(await fs.exists(LOCK)).toBe(false);
  });

  it("treats a wrongly-typed lock as no lock", async () => {
    // Valid JSON, nonsense contents. Same invariant as the unparseable case: a corrupt
    // byte must not warn the user about a phantom editor forever.
    await fs.writeTextFile(LOCK, JSON.stringify({ instance: 42, at: Date.now() }));
    expect(await readProjectLock(fs, DIR)).toBeNull();
    // A lock with no timestamp is ancient, not current.
    await fs.writeTextFile(LOCK, JSON.stringify({ instance: "other-machine" }));
    expect(await foreignProjectLock(fs, DIR)).toBeNull();
  });

  it("does not throw releasing on a filesystem that cannot delete", async () => {
    // releaseProjectLock calls fs.remove OPTIONALLY, so on a store without it the release
    // is a silent no-op — it must still not break close. (This is also why the fixture in
    // this file adds `remove`: without it the main release test proves nothing.)
    const noDelete = new MemFs();
    await claimProjectLock(noDelete, DIR);
    await expect(releaseProjectLock(noDelete, DIR)).resolves.toBeUndefined();
    expect(await noDelete.exists(LOCK)).toBe(true);
  });

  it("never blocks opening a project it cannot write to", async () => {
    // A read-only volume is a reason to skip the courtesy, not to refuse the project.
    const readOnly = new LockFs();
    readOnly.writeTextFile = async () => {
      throw new Error("EROFS");
    };
    await expect(claimProjectLock(readOnly, DIR)).resolves.toBeUndefined();
  });
});

// A lock says "a LIVE editor has this open". Nothing distinguished that from "an editor had
// this open and died" except a timestamp nobody refreshed, so a crash warned about a second
// instance that did not exist. The holder now re-stamps while open, which is what makes a
// short staleness window correct rather than merely shorter.
describe("project lock — heartbeat", () => {
  let fs: LockFs;
  beforeEach(() => {
    fs = new LockFs();
    vi.useFakeTimers();
  });
  afterEach(async () => {
    await releaseProjectLock(fs, DIR);
    vi.useRealTimers();
  });

  /** Let the beat's promise chain settle after a timer fires. */
  async function tick(times: number): Promise<void> {
    for (let i = 0; i < times; i++) {
      vi.advanceTimersByTime(HEARTBEAT_MS);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
  }
  const stampedAt = async (): Promise<number> =>
    (JSON.parse(await fs.readTextFile(LOCK)) as { at: number }).at;

  it("keeps OUR claim alive while the project stays open", async () => {
    vi.setSystemTime(new Date("2026-08-17T10:00:00Z"));
    await claimProjectLock(fs, DIR);
    const first = await stampedAt();

    await tick(20); // far beyond the staleness window
    const later = await stampedAt();
    expect(later).toBeGreaterThan(first);
    // The OUTCOME: a second run opening now is still warned, because we are still here.
    const foreignView = { instance: "other-machine", at: later };
    await fs.writeTextFile(LOCK, JSON.stringify(foreignView));
    expect(await foreignProjectLock(fs, DIR, later + 1_000)).not.toBeNull();
  });

  it("stops beating once released, so a closed project leaves no live claim", async () => {
    vi.setSystemTime(new Date("2026-08-17T10:00:00Z"));
    await claimProjectLock(fs, DIR);
    await releaseProjectLock(fs, DIR);
    // The failure this guards: a timer outliving close would re-create the lock file for a
    // project nobody has open — a warning with no editor behind it, forever.
    await tick(5);
    expect(await fs.exists(LOCK)).toBe(false);
  });

  it("does not stamp over a claim another run has taken", async () => {
    vi.setSystemTime(new Date("2026-08-17T10:00:00Z"));
    await claimProjectLock(fs, DIR);
    const theirs = { instance: "other-machine", at: Date.now() };
    await fs.writeTextFile(LOCK, JSON.stringify(theirs));
    await tick(3);
    const held = JSON.parse(await fs.readTextFile(LOCK)) as { instance: string };
    expect(held.instance).toBe("other-machine");
  });
});
