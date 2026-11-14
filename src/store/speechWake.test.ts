import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { TranscriptFailureReason } from "../tools/speechFailure";
import {
  BATCH_DEADLINE_MS,
  dirKey,
  WakeRegistry,
  type ChatKey,
  type Release,
  type TurnEnd,
} from "./speechWake";

const MIN = 60_000;
const A: ChatKey = { dir: "C:\\projects\\a", session: "chat-1" };
const B: ChatKey = { dir: "C:\\projects\\a", session: "chat-2" };

function begin(r: WakeRegistry, chat: ChatKey, exec: number): void {
  r.beginTurn(chat, exec);
}
function ask(
  r: WakeRegistry,
  chat: ChatKey,
  exec: number,
  key: string,
  now = 0,
  source = `src-${key}`,
): Release[] {
  return r.register({ ...chat, exec, key, source, ref: `ref-${key}`, audioS: 30 }, now);
}
const land = (r: WakeRegistry, chat: ChatKey, key: string, now: number): Release[] =>
  r.settle(chat, key, { kind: "landed" }, now);
const fail = (
  r: WakeRegistry,
  chat: ChatKey,
  key: string,
  now: number,
  reason: TranscriptFailureReason = "engine_failed",
): Release[] => r.settle(chat, key, { kind: "failed", reason }, now);
const refs = (rel: Release): string[] => rel.landed.map((e) => e.ref ?? "");

describe("a batch of files the assistant was told were not ready", () => {
  it("brings the assistant back once, after the LAST of 13 files has landed, not at the first", () => {
    const r = new WakeRegistry();
    begin(r, A, 1);
    for (let i = 1; i <= 13; i++) ask(r, A, 1, `k${i}`, 0);
    expect(r.endTurn(A, 1, "done", 5_000)).toEqual([]);
    for (let i = 1; i <= 12; i++) expect(land(r, A, `k${i}`, i * 30_000)).toEqual([]);
    const out = land(r, A, "k13", 13 * 30_000);
    expect(out).toHaveLength(1);
    expect(refs(out[0])).toEqual(Array.from({ length: 13 }, (_, i) => `ref-k${i + 1}`));
    expect(out[0].size).toBe(13);
    expect(r.tick(13 * 30_000 + 5 * BATCH_DEADLINE_MS)).toEqual([]);
  });

  it("is released the moment its turn ends when every file has already landed", () => {
    const r = new WakeRegistry();
    begin(r, A, 1);
    ask(r, A, 1, "a");
    ask(r, A, 1, "b");
    expect(land(r, A, "a", 10)).toEqual([]);
    expect(land(r, A, "b", 20)).toEqual([]); // the turn is still running: nothing may start yet
    const out = r.endTurn(A, 1, "done", 30);
    expect(out.map(refs)).toEqual([["ref-a", "ref-b"]]);
  });

  it.each<TurnEnd>(["stopped", "error", "abandoned"])(
    "leaves nothing to wake for when its turn ended by %s: the person took over",
    (how) => {
      const r = new WakeRegistry();
      begin(r, A, 1);
      ask(r, A, 1, "a");
      expect(r.endTurn(A, 1, how, 5)).toEqual([]);
      expect(land(r, A, "a", 10)).toEqual([]);
      expect(r.tick(10 * BATCH_DEADLINE_MS)).toEqual([]);
      expect(r.size()).toBe(0);
    },
  );

  it("moves a file looked at again in a later turn to the newest batch, so it is never reported twice", () => {
    const r = new WakeRegistry();
    begin(r, A, 1);
    ask(r, A, 1, "a");
    ask(r, A, 1, "b");
    r.endTurn(A, 1, "done", 10);
    begin(r, A, 2); // the person said "continue"; the assistant looked at "a" again and it is still not ready
    ask(r, A, 2, "a", 20);
    expect(land(r, A, "b", 30).map(refs)).toEqual([["ref-b"]]); // the first batch only holds "b" now
    expect(land(r, A, "a", 40)).toEqual([]); // the second turn is still running
    expect(r.endTurn(A, 2, "done", 50).map(refs)).toEqual([["ref-a"]]);
  });

  it("never wakes for an older batch that a later turn emptied", () => {
    const r = new WakeRegistry();
    begin(r, A, 1);
    ask(r, A, 1, "a");
    r.endTurn(A, 1, "done", 10);
    begin(r, A, 2);
    ask(r, A, 2, "a", 20);
    expect(r.view(A).total).toBe(1);
    expect(land(r, A, "a", 30)).toEqual([]);
    expect(r.endTurn(A, 2, "done", 40).map(refs)).toEqual([["ref-a"]]);
    expect(r.tick(100 * MIN)).toEqual([]);
  });

  it("does not wake for failures and cancellations, and counts them for the plain note", () => {
    const r = new WakeRegistry();
    begin(r, A, 1);
    for (const k of ["a", "b", "c", "d"]) ask(r, A, 1, k);
    r.endTurn(A, 1, "done", 1);
    land(r, A, "a", 2);
    fail(r, A, "b", 3, "engine_failed");
    fail(r, A, "c", 4, "engine_failed");
    const out = r.settle(A, "d", { kind: "cancelled" }, 5);
    expect(out).toHaveLength(1);
    expect(refs(out[0])).toEqual(["ref-a"]);
    expect(out[0].failed).toEqual([{ reason: "engine_failed", count: 2 }]);
    expect(out[0].cancelled).toBe(1);
    expect(out[0].expired).toBe(0);
    expect(out[0].size).toBe(4);
  });

  it("settles a person's Cancel as cancelled whichever way it arrives: it is no failure and gets no note", () => {
    const r = new WakeRegistry();
    begin(r, A, 1);
    for (const k of ["a", "b"]) ask(r, A, 1, k);
    r.endTurn(A, 1, "done", 1);
    land(r, A, "a", 2);
    const out = fail(r, A, "b", 3, "cancelled");
    expect(out).toHaveLength(1);
    expect(out[0].failed).toEqual([]);
    expect(out[0].cancelled).toBe(1);
    expect(refs(out[0])).toEqual(["ref-a"]);
  });

  it("releases a batch in which nothing landed with no words to wake for", () => {
    const r = new WakeRegistry();
    begin(r, A, 1);
    ask(r, A, 1, "a");
    r.endTurn(A, 1, "done", 1);
    const out = fail(r, A, "a", 2, "audio_extraction_failed");
    expect(out).toHaveLength(1);
    expect(out[0].landed).toEqual([]);
    expect(out[0].failed).toEqual([{ reason: "audio_extraction_failed", count: 1 }]);
  });

  describe("words the assistant already has", () => {
    it("are not woken for: a later look gave them before the batch was released", () => {
      const r = new WakeRegistry();
      begin(r, A, 1);
      ask(r, A, 1, "a", 0, "file-a");
      ask(r, A, 1, "b", 0, "file-b");
      r.endTurn(A, 1, "done", 1);
      expect(r.fetched(A, "file-a", 2)).toEqual([]); // "a" was read while still pending
      const out = land(r, A, "b", 3);
      expect(out.map(refs)).toEqual([["ref-b"]]);
      expect(out[0].size).toBe(2);
    });

    it("leave a batch whose words were all read with nothing to wake for", () => {
      const r = new WakeRegistry();
      begin(r, A, 1);
      ask(r, A, 1, "a", 0, "file-a");
      r.endTurn(A, 1, "done", 1);
      land(r, A, "a", 2);
      const out = r.tick(3);
      expect(out).toEqual([]);
    });

    it("shrink what a held wake is still about, up to nothing", () => {
      const r = new WakeRegistry();
      begin(r, A, 1);
      ask(r, A, 1, "a", 0, "file-a");
      ask(r, A, 1, "b", 0, "file-b");
      r.endTurn(A, 1, "done", 1);
      land(r, A, "a", 2);
      const [release] = land(r, A, "b", 3);
      expect(r.unread(release.batchId).map((e) => e.ref)).toEqual(["ref-a", "ref-b"]);
      r.fetched(A, "file-a", 4); // the person's own turn read one of them
      expect(r.unread(release.batchId).map((e) => e.ref)).toEqual(["ref-b"]);
      r.fetched(A, "file-b", 5);
      expect(r.unread(release.batchId)).toEqual([]);
    });

    it("count for the chat that read them only", () => {
      const r = new WakeRegistry();
      begin(r, A, 1);
      begin(r, B, 1);
      ask(r, A, 1, "a", 0, "file-a");
      ask(r, B, 1, "a", 0, "file-a");
      r.fetched(B, "file-a", 1);
      r.endTurn(A, 1, "done", 2);
      r.endTurn(B, 1, "done", 2);
      expect(land(r, A, "a", 3).map(refs)).toEqual([["ref-a"]]);
      expect(land(r, B, "a", 3)).toEqual([]);
    });
  });

  describe("a file that never settles", () => {
    it("is waited for 30 minutes without new words, then the rest are released with what landed", () => {
      const r = new WakeRegistry();
      begin(r, A, 1);
      ask(r, A, 1, "a");
      ask(r, A, 1, "b");
      r.endTurn(A, 1, "done", 0);
      expect(land(r, A, "a", 20 * MIN)).toEqual([]);
      expect(r.tick(49 * MIN)).toEqual([]); // 29 minutes since the last words: the clock restarted at the landing
      const out = r.tick(50 * MIN);
      expect(out).toHaveLength(1);
      expect(refs(out[0])).toEqual(["ref-a"]);
      expect(out[0].expired).toBe(1);
    });

    it("never expires before the turn has ended (the assistant may still be working)", () => {
      const r = new WakeRegistry();
      begin(r, A, 1);
      ask(r, A, 1, "a");
      expect(r.tick(10 * BATCH_DEADLINE_MS)).toEqual([]);
      expect(r.view(A).total).toBe(1);
    });

    it("ignores a landing that arrives after the wait ended: the words are cached, nobody is woken", () => {
      const r = new WakeRegistry();
      begin(r, A, 1);
      ask(r, A, 1, "a");
      r.endTurn(A, 1, "done", 0);
      const [release] = r.tick(BATCH_DEADLINE_MS);
      expect(release.landed).toEqual([]);
      expect(release.expired).toBe(1);
      expect(land(r, A, "a", BATCH_DEADLINE_MS + 1)).toEqual([]);
      expect(r.unread(release.batchId)).toEqual([]);
    });
  });

  it("keeps two chats of one project apart, and one folder's two spellings together", () => {
    const r = new WakeRegistry();
    begin(r, A, 1);
    begin(r, B, 1);
    ask(r, A, 1, "a");
    ask(r, B, 1, "a");
    r.endTurn(A, 1, "done", 1);
    r.endTurn(B, 1, "done", 1);
    expect(land(r, B, "a", 2).map((rel) => rel.session)).toEqual(["chat-2"]);
    const respelt: ChatKey = { dir: "C:/projects/a/", session: "chat-1" };
    expect(land(r, respelt, "a", 3).map((rel) => rel.session)).toEqual(["chat-1"]);
    expect(dirKey("C:\\projects\\a\\")).toBe("C:/projects/a");
    expect(dirKey("C:/projects/a")).toBe(dirKey("C:\\projects\\a"));
  });

  it("forgets a chat that is gone, and only that chat", () => {
    const r = new WakeRegistry();
    begin(r, A, 1);
    begin(r, B, 1);
    ask(r, A, 1, "a");
    ask(r, B, 1, "a");
    r.endTurn(A, 1, "done", 1);
    r.endTurn(B, 1, "done", 1);
    expect(r.dropChat("C:/projects/a", "chat-1")).toBe(1);
    expect(land(r, A, "a", 2)).toEqual([]);
    expect(land(r, B, "a", 2).map(refs)).toEqual([["ref-a"]]);
    expect(r.dropChat("C:\\projects\\a")).toBe(1);
    expect(r.size()).toBe(0);
  });

  it("ignores an answer that comes from a turn that is no longer the live one (a straggler)", () => {
    const r = new WakeRegistry();
    begin(r, A, 1);
    r.endTurn(A, 1, "abandoned", 1);
    begin(r, A, 2);
    expect(ask(r, A, 1, "late", 5)).toEqual([]);
    expect(r.size()).toBe(0);
    expect(ask(r, A, 3, "early", 5)).toEqual([]); // not begun
    expect(r.size()).toBe(0);
  });

  it("starts clean when a turn number comes round again (a reopened project counts from 1 again)", () => {
    const r = new WakeRegistry();
    begin(r, A, 1);
    ask(r, A, 1, "old");
    r.endTurn(A, 1, "done", 1); // sealed, never resolved: the old chat instance was disposed
    begin(r, A, 1); // the new instance's first turn is numbered 1 as well
    expect(r.size()).toBe(0);
    ask(r, A, 1, "new", 5);
    expect(r.endTurn(A, 1, "done", 6)).toEqual([]);
    expect(land(r, A, "new", 7).map(refs)).toEqual([["ref-new"]]);
  });

  it("is released once, and kept until the host resolves it", () => {
    const r = new WakeRegistry();
    begin(r, A, 1);
    ask(r, A, 1, "a");
    r.endTurn(A, 1, "done", 1);
    const [release] = land(r, A, "a", 2);
    expect(r.tick(3)).toEqual([]);
    expect(r.view(A).readyUnread).toBe(1);
    expect(r.unread(release.batchId)).toHaveLength(1);
    r.resolve(release.batchId);
    expect(r.view(A).readyUnread).toBe(0);
    expect(r.size()).toBe(0);
  });

  it("counts for the card: files still waited for, and how many of them are done", () => {
    const r = new WakeRegistry();
    begin(r, A, 1);
    for (const k of ["a", "b", "c"]) ask(r, A, 1, k);
    land(r, A, "a", 1);
    fail(r, A, "b", 2);
    const view = r.view(A);
    expect(view.total).toBe(2); // "b" failed and no longer counts
    expect(view.done).toBe(1);
    expect(view.pending.map((e) => e.key)).toEqual(["c"]);
    expect(r.view(B)).toEqual({ total: 0, done: 0, pending: [], readyUnread: 0 });
  });
});

// --- The same rules, restated as plain lists, and compared on random event sequences -----------------------
// The model below is written from the rules in speechWake.ts's header, not from its code: it keeps one list of
// files and one of batches and finds things by scanning, so a bookkeeping mistake in the registry (a key that
// is not moved, a batch that is not deleted, a release that happens twice) cannot also be in the model.

type MState = "pending" | "landed" | "fetched" | "failed" | "cancelled" | "expired";
interface MEntry {
  chat: string;
  exec: number;
  key: string;
  source: string;
  state: MState;
  failure: string | null;
}
interface MBatch {
  chat: string;
  exec: number;
  dir: string;
  session: string;
  phase: "open" | "sealed" | "released";
  progress: number;
}
interface MRelease {
  batch: string;
  landed: string[];
  failed: Array<[string, number]>;
  expired: number;
  cancelled: number;
  size: number;
}

const modelDir = (d: string): string => d.split("\\").join("/").replace(/\/+$/, "");
const modelChat = (c: ChatKey): string => `${modelDir(c.dir)}|${c.session}`;

class Model {
  entries: MEntry[] = [];
  batches: MBatch[] = [];
  live = new Map<string, number>();
  constructor(private readonly deadline: number) {}

  private batch(chat: string, exec: number): MBatch | undefined {
    return this.batches.find((b) => b.chat === chat && b.exec === exec);
  }
  private members(b: MBatch): MEntry[] {
    return this.entries.filter((e) => e.chat === b.chat && e.exec === b.exec);
  }
  private dropBatch(b: MBatch): void {
    this.entries = this.entries.filter((e) => !(e.chat === b.chat && e.exec === b.exec));
    this.batches = this.batches.filter((x) => x !== b);
  }

  begin(c: ChatKey, exec: number): void {
    const chat = modelChat(c);
    this.live.set(chat, exec);
    const stale = this.batch(chat, exec);
    if (stale) this.dropBatch(stale);
  }

  register(c: ChatKey, exec: number, key: string, source: string, now: number): MRelease[] {
    const chat = modelChat(c);
    if (this.live.get(chat) !== exec) return [];
    const here = this.batch(chat, exec);
    if (here && here.phase !== "open") return [];
    const old = this.entries.find((e) => e.chat === chat && e.key === key);
    if (old && (old.state === "landed" || old.state === "fetched")) return [];
    if (old && old.exec === exec) {
      if (old.state !== "pending") {
        old.state = "pending";
        old.failure = null;
      }
      return [];
    }
    const out = old ? this.removeEntry(old, now) : [];
    if (!this.batch(chat, exec))
      this.batches.push({
        chat,
        exec,
        dir: c.dir,
        session: c.session,
        phase: "open",
        progress: now,
      });
    this.entries.push({ chat, exec, key, source, state: "pending", failure: null });
    return out;
  }

  private removeEntry(e: MEntry, now: number): MRelease[] {
    this.entries = this.entries.filter((x) => x !== e);
    const b = this.batch(e.chat, e.exec);
    if (!b) return [];
    if (this.members(b).length === 0 && b.phase !== "released") {
      this.batches = this.batches.filter((x) => x !== b);
      return [];
    }
    return this.evaluate(b, now);
  }

  settle(
    c: ChatKey,
    key: string,
    kind: "landed" | "failed" | "cancelled",
    reason: string,
    now: number,
  ): MRelease[] {
    const e = this.entries.find((x) => x.chat === modelChat(c) && x.key === key);
    if (!e || e.state !== "pending") return [];
    const b = this.batch(e.chat, e.exec);
    if (kind === "landed") {
      e.state = "landed";
      if (b) b.progress = now;
    } else if (kind === "failed") {
      e.state = "failed";
      e.failure = reason;
    } else e.state = "cancelled";
    return b ? this.evaluate(b, now) : [];
  }

  fetched(c: ChatKey, source: string, now: number): MRelease[] {
    const touched: MBatch[] = [];
    for (const e of this.entries) {
      if (e.chat !== modelChat(c) || e.source !== source) continue;
      if (e.state !== "pending" && e.state !== "landed") continue;
      const wasPending = e.state === "pending";
      e.state = "fetched";
      const b = this.batch(e.chat, e.exec);
      if (!b) continue;
      if (wasPending) b.progress = now;
      if (!touched.includes(b)) touched.push(b);
    }
    return touched.flatMap((b) => this.evaluate(b, now));
  }

  end(c: ChatKey, exec: number, how: TurnEnd, now: number): MRelease[] {
    const chat = modelChat(c);
    if (this.live.get(chat) === exec) this.live.delete(chat);
    const b = this.batch(chat, exec);
    if (!b || b.phase !== "open") return [];
    if (how !== "done") {
      this.dropBatch(b);
      return [];
    }
    b.phase = "sealed";
    b.progress = now;
    return this.evaluate(b, now);
  }

  tick(now: number): MRelease[] {
    return [...this.batches].flatMap((b) => this.evaluate(b, now));
  }

  dropChat(dir: string, session: string | undefined): number {
    let n = 0;
    for (const b of [...this.batches]) {
      if (modelDir(b.dir) !== modelDir(dir) || (session !== undefined && b.session !== session))
        continue;
      n += this.members(b).length;
      this.dropBatch(b);
    }
    for (const k of [...this.live.keys()]) {
      const [d, s] = k.split("|");
      if (d === modelDir(dir) && (session === undefined || s === session)) this.live.delete(k);
    }
    return n;
  }

  resolve(chat: string, exec: number): void {
    const b = this.batch(chat, exec);
    if (b) this.dropBatch(b);
  }

  private evaluate(b: MBatch, now: number): MRelease[] {
    if (b.phase !== "sealed") return [];
    const ms = this.members(b);
    if (ms.length === 0) {
      this.batches = this.batches.filter((x) => x !== b);
      return [];
    }
    const pending = ms.filter((e) => e.state === "pending");
    if (pending.length > 0) {
      if (now - b.progress < this.deadline) return [];
      for (const e of pending) e.state = "expired";
    }
    b.phase = "released";
    const failed = new Map<string, number>();
    for (const e of ms)
      if (e.state === "failed" && e.failure)
        failed.set(e.failure, (failed.get(e.failure) ?? 0) + 1);
    return [
      {
        batch: `${b.chat}|${b.exec}`,
        landed: ms.filter((e) => e.state === "landed").map((e) => `ref-${e.key}`),
        failed: [...failed].sort(([x], [y]) => (x < y ? -1 : 1)),
        expired: ms.filter((e) => e.state === "expired").length,
        cancelled: ms.filter((e) => e.state === "cancelled").length,
        size: ms.length,
      },
    ];
  }

  view(c: ChatKey): { total: number; done: number; pending: string[]; readyUnread: number } {
    const chat = modelChat(c);
    let total = 0;
    let done = 0;
    let readyUnread = 0;
    const pending: string[] = [];
    for (const b of this.batches) {
      if (b.chat !== chat) continue;
      for (const e of this.members(b)) {
        if (b.phase === "released") {
          if (e.state === "landed") readyUnread++;
        } else if (e.state === "pending") {
          total++;
          pending.push(e.key);
        } else if (e.state === "landed" || e.state === "fetched") {
          total++;
          done++;
        }
      }
    }
    return { total, done, pending: pending.sort(), readyUnread };
  }
}

const normalise = (r: Release): MRelease => ({
  batch: `${dirKey(r.dir)}|${r.session}|${r.exec}`,
  landed: r.landed.map((e) => e.ref ?? ""),
  failed: r.failed
    .map((f): [string, number] => [f.reason, f.count])
    .sort(([x], [y]) => (x < y ? -1 : 1)),
  expired: r.expired,
  cancelled: r.cancelled,
  size: r.size,
});

const CHATS: ChatKey[] = [
  { dir: "C:\\p1", session: "s1" },
  { dir: "C:/p1/", session: "s2" },
  { dir: "C:\\p2", session: "s1" },
];
const REASONS: TranscriptFailureReason[] = ["engine_failed", "audio_extraction_failed"];

// Each step is a few random numbers. What they MEAN is decided against the model's own state when the step runs
// (which chat has a live turn, which files are pending), so most sequences are the ones that happen in the app,
// and some are the odd ones: a straggler from a finished turn, a repeat, a settle for a file nobody asked about.
const OPS = [
  "begin",
  "register",
  "register",
  "register",
  "settle",
  "settle",
  "settle",
  "fetched",
  "end",
  "end",
  "tick",
  "drop",
  "resolve",
] as const;
const step = fc.record({
  dt: fc.constantFrom(0, 1, 1_000, MIN, 29 * MIN, 31 * MIN),
  op: fc.constantFrom(...OPS),
  a: fc.nat(1000),
  b: fc.nat(1000),
  c: fc.nat(1000),
  kind: fc.constantFrom<"landed" | "failed" | "cancelled">(
    "landed",
    "landed",
    "failed",
    "cancelled",
  ),
  reason: fc.constantFrom(...REASONS),
  how: fc.constantFrom<TurnEnd>("done", "done", "done", "stopped", "error", "abandoned"),
  all: fc.boolean(),
});

const livePairs = (model: Model): Array<[number, number]> =>
  CHATS.flatMap((c, i): Array<[number, number]> => {
    const exec = model.live.get(modelChat(c));
    return exec === undefined ? [] : [[i, exec]];
  });
const chatOf = (chat: string): number => CHATS.findIndex((c) => modelChat(c) === chat);

describe("the registry against an independent statement of its rules", () => {
  it("agrees on every release, count and view over random sequences of events", () => {
    // The generator must actually reach the interesting states, or agreement proves nothing.
    const reached = { releases: 0, withWords: 0, withExpired: 0, withFailed: 0 };
    fc.assert(
      fc.property(fc.array(step, { minLength: 5, maxLength: 80, size: "max" }), (steps) => {
        const reg = new WakeRegistry();
        const model = new Model(BATCH_DEADLINE_MS);
        const unresolved: Array<{ id: string; chat: string; exec: number }> = [];
        const lastExec = new Map<number, number>();
        let now = 1_000;
        let held = new Set<string>(); // batches released and not yet resolved, before this step
        for (const s of steps) {
          now += s.dt;
          let got: Release[] = [];
          let want: MRelease[] = [];
          switch (s.op) {
            case "begin": {
              const ci = s.a % CHATS.length;
              // Turns are numbered in the order they begin; now and then one is not (a reopened project restarts at 1).
              const exec = s.b % 6 === 0 ? 1 + (s.c % 3) : (lastExec.get(ci) ?? 0) + 1;
              lastExec.set(ci, exec);
              reg.beginTurn(CHATS[ci], exec);
              model.begin(CHATS[ci], exec);
              break;
            }
            case "register": {
              const live = livePairs(model);
              const [ci, exec] =
                live.length && s.b % 10 !== 0
                  ? live[s.a % live.length]
                  : [s.a % CHATS.length, 1 + (s.c % 3)];
              const k = s.c % 4;
              const f = Math.floor(s.c / 4) % 4;
              got = reg.register(
                {
                  ...CHATS[ci],
                  exec,
                  key: `k${k}`,
                  source: `f${f}`,
                  ref: `ref-k${k}`,
                  audioS: 10,
                },
                now,
              );
              want = model.register(CHATS[ci], exec, `k${k}`, `f${f}`, now);
              break;
            }
            case "settle": {
              const pending = model.entries.filter((e) => e.state === "pending");
              const known =
                pending.length > 0 && s.b % 10 !== 0 ? pending[s.a % pending.length] : null;
              const ci = known ? chatOf(known.chat) : s.a % CHATS.length;
              const key = known ? known.key : `k${s.c % 4}`;
              const outcome =
                s.kind === "failed"
                  ? ({ kind: "failed", reason: s.reason } as const)
                  : ({ kind: s.kind } as const);
              got = reg.settle(CHATS[ci], key, outcome, now);
              want = model.settle(CHATS[ci], key, s.kind, s.reason, now);
              break;
            }
            case "fetched": {
              const any =
                model.entries.length > 0 && s.b % 5 !== 0
                  ? model.entries[s.a % model.entries.length]
                  : null;
              const ci = any ? chatOf(any.chat) : s.a % CHATS.length;
              const source = any ? any.source : `f${s.c % 4}`;
              got = reg.fetched(CHATS[ci], source, now);
              want = model.fetched(CHATS[ci], source, now);
              break;
            }
            case "end": {
              const live = livePairs(model);
              const [ci, exec] =
                live.length && s.b % 10 !== 0
                  ? live[s.a % live.length]
                  : [s.a % CHATS.length, 1 + (s.c % 3)];
              got = reg.endTurn(CHATS[ci], exec, s.how, now);
              want = model.end(CHATS[ci], exec, s.how, now);
              break;
            }
            case "tick":
              got = reg.tick(now);
              want = model.tick(now);
              break;
            case "drop": {
              const ci = s.a % CHATS.length;
              const session = s.all ? undefined : CHATS[ci].session;
              expect(reg.dropChat(CHATS[ci].dir, session)).toBe(
                model.dropChat(CHATS[ci].dir, session),
              );
              break;
            }
            case "resolve": {
              const next = unresolved.shift();
              if (next) {
                reg.resolve(next.id);
                model.resolve(next.chat, next.exec);
              }
              break;
            }
          }
          const byBatch = (a: MRelease, b: MRelease): number => (a.batch < b.batch ? -1 : 1);
          expect(got.map(normalise).sort(byBatch)).toEqual([...want].sort(byBatch));
          for (const g of got) {
            // A batch is released once: nothing released again while it is still held.
            expect(held.has(g.batchId)).toBe(false);
            unresolved.push({ id: g.batchId, chat: modelChat(g), exec: g.exec });
            reached.releases++;
            if (g.landed.length) reached.withWords++;
            if (g.expired) reached.withExpired++;
            if (g.failed.length) reached.withFailed++;
          }
          held = new Set(
            model.batches
              .filter((b) => b.phase === "released")
              .map((b) => unresolved.find((u) => u.chat === b.chat && u.exec === b.exec)?.id ?? "")
              .filter(Boolean),
          );
          for (const c of CHATS) {
            const v = reg.view(c);
            const m = model.view(c);
            expect({
              total: v.total,
              done: v.done,
              pending: v.pending.map((e) => e.key).sort(),
              readyUnread: v.readyUnread,
            }).toEqual(m);
          }
          expect(reg.size()).toBe(model.entries.length);
        }
      }),
      { numRuns: 600 },
    );
    expect(reached.releases).toBeGreaterThan(100);
    expect(reached.withWords).toBeGreaterThan(40);
    expect(reached.withExpired).toBeGreaterThan(5);
    expect(reached.withFailed).toBeGreaterThan(10);
  });
});
