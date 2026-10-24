// The outbox's promises, asserted on what is actually in storage: a report is kept until it is
// confirmed, only a report this module wrote is ever read back, one bad entry costs only itself,
// and nothing here can grow without limit or throw into the exporter.
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LAST_USER_LIFETIME_MS,
  MAX_PENDING_REPORTS,
  MAX_REPORT_AGE_MS,
  OUTBOX_KEY,
  clearOutbox,
  lastKnownUser,
  noteFailure,
  pendingReports,
  queueReport,
  rememberUser,
  removeReport,
  type PendingReport,
} from "./exportOutbox";

const NOW = 1_800_000_000_000;

function report(over: Partial<PendingReport> = {}): PendingReport {
  return {
    id: "r-1",
    owner: "user_alice",
    at: NOW / 1000,
    failedAt: 0,
    disposable: false,
    body: { status: "done", elapsed_ms: 5, recovered: false, error: "" },
    ...over,
  };
}

function rawStored(): { reports: PendingReport[]; lastUser: string } {
  return JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? "{}");
}

beforeEach(() => clearOutbox());
afterEach(() => {
  clearOutbox();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the export report outbox", () => {
  it("keeps a report until it is removed, exactly as it was written", () => {
    const kept = report({
      body: { status: "failed", error: "ffmpeg died", width: 1920, ok: true },
    });
    expect(queueReport(kept, NOW)).toBe(true);
    expect(pendingReports(NOW)).toEqual([kept]);
    removeReport("r-1", NOW);
    expect(pendingReports(NOW)).toEqual([]);
  });

  it("holds one entry per report name: writing it again replaces it, never doubles it", () => {
    queueReport(report({ body: { status: "failed" } }), NOW);
    queueReport(report({ body: { status: "done" } }), NOW);
    expect(pendingReports(NOW).map((r) => r.body.status)).toEqual(["done"]);
  });

  it("keeps the newest MAX_PENDING_REPORTS, oldest first, however many are written", () => {
    for (let i = 0; i < MAX_PENDING_REPORTS + 10; i++) queueReport(report({ id: `r-${i}` }), NOW);
    const ids = pendingReports(NOW).map((r) => r.id);
    expect(ids).toHaveLength(MAX_PENDING_REPORTS);
    expect(ids[0]).toBe("r-10");
    expect(ids.at(-1)).toBe(`r-${MAX_PENDING_REPORTS + 9}`);
  });

  it("drops a report older than the retention, and keeps one exactly at it", () => {
    const edge = (NOW - MAX_REPORT_AGE_MS) / 1000;
    queueReport(report({ id: "at-the-limit", at: edge }), NOW - 1);
    queueReport(report({ id: "too-old", at: edge - 1 }), NOW - 1);
    queueReport(report({ id: "fresh" }), NOW);
    expect(pendingReports(NOW).map((r) => r.id)).toEqual(["at-the-limit", "fresh"]);
  });

  it("erases an expired report from storage the next time anything reads it, not just from the answer", () => {
    queueReport(
      report({ id: "old", body: { status: "failed", error: "C:/private/clip.mov" } }),
      NOW,
    );
    const later = NOW + MAX_REPORT_AGE_MS + 1;
    expect(pendingReports(later)).toEqual([]);
    expect(localStorage.getItem(OUTBOX_KEY)).not.toContain("private");
    expect(rawStored().reports).toEqual([]);
  });

  it("keeps a report the server keeps failing to store, however often, until it expires like any other", () => {
    queueReport(report(), NOW);
    for (let i = 1; i <= 200; i++) noteFailure("r-1", NOW + i * 60_000);
    expect(pendingReports(NOW + 201 * 60_000).map((r) => r.id)).toEqual(["r-1"]);
    expect(pendingReports(NOW + MAX_REPORT_AGE_MS + 1000)).toEqual([]);
  });

  it("remembers when a report last failed, for that report only, so it can be tried after the others", () => {
    queueReport(report({ id: "a" }), NOW);
    queueReport(report({ id: "b" }), NOW);
    noteFailure("a", NOW + 5);
    noteFailure("never-queued", NOW + 9);
    expect(pendingReports(NOW + 10).map((r) => [r.id, r.failedAt])).toEqual([
      ["a", NOW + 5],
      ["b", 0],
    ]);
  });

  describe("when it is full", () => {
    const fill = (count: number, over: Partial<PendingReport> = {}, from = 0) => {
      for (let i = from; i < from + count; i++) queueReport(report({ id: `r-${i}`, ...over }), NOW);
    };

    it("never lets refusal telemetry push out a report of an export that ran", () => {
      fill(MAX_PENDING_REPORTS); // fifty real exports waiting
      expect(queueReport(report({ id: "refusal", disposable: true }), NOW)).toBe(false);
      const ids = pendingReports(NOW).map((r) => r.id);
      expect(ids).toHaveLength(MAX_PENDING_REPORTS);
      expect(ids).not.toContain("refusal");
      expect(ids).toContain("r-0"); // the oldest real export is still there
    });

    it("lets a fifty-refusal burst come and go without touching the real exports before it", () => {
      fill(3); // three finished exports that could not be sent
      for (let i = 0; i < MAX_PENDING_REPORTS; i++)
        queueReport(report({ id: `refused-${i}`, disposable: true }), NOW); // one agent call refused 50
      const ids = pendingReports(NOW).map((r) => r.id);
      expect(ids.filter((id) => !id.startsWith("refused-"))).toEqual(["r-0", "r-1", "r-2"]);
      expect(ids).toHaveLength(MAX_PENDING_REPORTS);
      expect(ids.at(-1)).toBe(`refused-${MAX_PENDING_REPORTS - 1}`);
    });

    it("makes room for a real export by dropping the oldest refusal first", () => {
      fill(MAX_PENDING_REPORTS - 2);
      fill(2, { disposable: true }, 100);
      queueReport(report({ id: "real-new" }), NOW);
      const ids = pendingReports(NOW).map((r) => r.id);
      expect(ids).not.toContain("r-100");
      expect(ids).toContain("r-101");
      expect(ids).toContain("real-new");
      expect(ids).toHaveLength(MAX_PENDING_REPORTS);
    });

    it("drops the oldest real export only for a newer real export, when nothing is disposable", () => {
      fill(MAX_PENDING_REPORTS);
      queueReport(report({ id: "newest" }), NOW);
      const ids = pendingReports(NOW).map((r) => r.id);
      expect(ids).not.toContain("r-0");
      expect(ids.at(-1)).toBe("newest");
    });
  });

  it("remembers the account last seen signed in, and writing reports never forgets it", () => {
    rememberUser("user_alice", NOW);
    queueReport(report(), NOW);
    noteFailure("r-1", NOW);
    removeReport("r-1", NOW);
    expect(lastKnownUser(NOW)).toBe("user_alice");
    rememberUser("user_bob", NOW);
    expect(lastKnownUser(NOW)).toBe("user_bob");
  });

  it("forgets the account when it has not been seen for a month, and erases it from storage", () => {
    rememberUser("user_alice", NOW);
    expect(lastKnownUser(NOW + LAST_USER_LIFETIME_MS)).toBe("user_alice");
    expect(lastKnownUser(NOW + LAST_USER_LIFETIME_MS + 1)).toBe("");
    expect(localStorage.getItem(OUTBOX_KEY)).not.toContain("user_alice");
  });

  it("keeps the account for as long as it keeps being seen", () => {
    for (let day = 0; day <= 90; day++) rememberUser("user_alice", NOW + day * 86_400_000);
    expect(lastKnownUser(NOW + 90 * 86_400_000 + 1000)).toBe("user_alice");
  });

  it.each(["", "x".repeat(201)])("does not remember an account id of %j", (id) => {
    rememberUser("user_alice", NOW);
    rememberUser(id, NOW);
    expect(lastKnownUser(NOW)).toBe("user_alice");
  });

  it("does not write when there is nothing to erase", () => {
    queueReport(report(), NOW);
    rememberUser("user_alice", NOW);
    const writes = vi.fn();
    const real = localStorage;
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => real.getItem(key),
      setItem: (key: string, value: string) => {
        writes(key);
        real.setItem(key, value);
      },
      removeItem: (key: string) => {
        writes(key);
        real.removeItem(key);
      },
    });
    pendingReports(NOW);
    lastKnownUser(NOW);
    expect(writes).not.toHaveBeenCalled();
  });
});

describe("a report it could not read back is never accepted", () => {
  const unreadable: [string, Partial<Record<keyof PendingReport, unknown>>][] = [
    ["an id with a space", { id: "has space" }],
    ["an empty id", { id: "" }],
    ["an id over the server's bound", { id: "x".repeat(129) }],
    ["no owner", { owner: "" }],
    ["an owner over the bound", { owner: "u".repeat(201) }],
    ["a non-numeric time", { at: "yesterday" }],
    ["an infinite time", { at: Infinity }],
    ["a failure time that is not a number", { failedAt: "recently" }],
    ["a negative failure time", { failedAt: -5 }],
    ["a priority that is not a flag", { disposable: "yes" }],
    ["a nested body", { body: { status: "done", extra: { nested: 1 } } }],
    ["a null in the body", { body: { status: "done", error: null } }],
    ["a non-finite number in the body", { body: { status: "done", elapsed_ms: NaN } }],
    ["a body of text over the bound", { body: { status: "done", error: "e".repeat(401) } }],
    [
      "a body with too many fields",
      { body: Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`k${i}`, i])) },
    ],
    ["a body that is a list", { body: ["done"] }],
  ];

  it.each(unreadable)("refuses to queue %s", (_name, bad) => {
    expect(queueReport({ ...report(), ...bad } as PendingReport, NOW)).toBe(false);
    expect(pendingReports(NOW)).toEqual([]);
  });

  it.each(unreadable)("drops %s found in storage, and keeps its neighbours", (_name, bad) => {
    const before = report({ id: "before" });
    const after = report({ id: "after" });
    localStorage.setItem(
      OUTBOX_KEY,
      JSON.stringify({
        v: 1,
        lastUser: "user_alice",
        reports: [before, { ...report(), ...bad }, after],
      }),
    );
    expect(pendingReports(NOW).map((r) => r.id)).toEqual(["before", "after"]);
  });

  it("drops a report whose body tries to rewrite its own prototype", () => {
    localStorage.setItem(
      OUTBOX_KEY,
      `{"v":1,"lastUser":"","reports":[{"id":"r-1","owner":"u","at":${NOW / 1000},"body":{"__proto__":"x","status":"done"}}]}`,
    );
    expect(pendingReports(NOW)).toEqual([]);
  });

  it("reads every kind of damaged storage as an empty outbox, and recovers on the next write", () => {
    for (const damaged of [
      "",
      "{",
      "null",
      "[]",
      '"text"',
      "42",
      '{"reports":"x"}',
      '{"reports":[1,null,"a",[]]}',
    ]) {
      localStorage.setItem(OUTBOX_KEY, damaged);
      expect(pendingReports(NOW), damaged).toEqual([]);
      expect(lastKnownUser(NOW), damaged).toBe("");
      expect(queueReport(report(), NOW), damaged).toBe(true);
      expect(
        pendingReports(NOW).map((r) => r.id),
        damaged,
      ).toEqual(["r-1"]);
    }
  });

  it("keeps exactly the reports that are valid and fresh, in order, among any amount of damage", () => {
    const valid = fc.record({
      id: fc.stringMatching(/^[A-Za-z0-9_.:-]{1,40}$/),
      owner: fc.stringMatching(/^[A-Za-z0-9_]{1,30}$/),
      at: fc
        .integer({ min: 0, max: NOW / 1000 })
        .map((s) => Math.max(s, (NOW - MAX_REPORT_AGE_MS) / 1000)),
      failedAt: fc.integer({ min: 0, max: NOW }),
      disposable: fc.boolean(),
      body: fc.dictionary(
        // `__proto__` is refused on purpose (its own test above), so it is not a valid key here.
        fc.stringMatching(/^[a-z_]{1,12}$/).filter((key) => key !== "__proto__"),
        fc.oneof(
          fc.string({ maxLength: 40 }),
          fc.boolean(),
          fc.integer(),
          fc.double({ noNaN: true, noDefaultInfinity: true }),
        ),
        { maxKeys: 10 },
      ),
    });
    // Damage by construction: every one of these is wrong in a way the rules above forbid.
    const damaged = fc.oneof(
      fc.anything(),
      valid.map((r) => ({ ...r, id: `${r.id} bad` })),
      valid.map((r) => ({ ...r, owner: "" })),
      valid.map((r) => ({ ...r, body: { ...r.body, nested: { x: 1 } } })),
      valid.map((r) => ({ ...r, at: "never" })),
      valid.map((r) => ({ ...r, failedAt: "recently" })),
    );
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            { weight: 3, arbitrary: valid.map((r) => ({ ok: true as const, r })) },
            { weight: 2, arbitrary: damaged.map((r) => ({ ok: false as const, r })) },
          ),
          { maxLength: 30 },
        ),
        (entries) => {
          const seen = new Set<string>();
          const expected: PendingReport[] = [];
          for (const entry of entries) {
            if (!entry.ok) continue;
            const r = entry.r as PendingReport;
            if (seen.has(r.id)) continue;
            seen.add(r.id);
            expected.push(r);
          }
          localStorage.setItem(
            OUTBOX_KEY,
            JSON.stringify({ v: 1, lastUser: "", reports: entries.map((e) => e.r) }),
          );
          // A damaged entry that happens to carry an id of a valid one must not displace it, so
          // only entries that are valid on their own can appear, in their stored order.
          const got = pendingReports(NOW).filter((r) => seen.has(r.id));
          const expectedIds = expected.slice(-MAX_PENDING_REPORTS).map((r) => r.id);
          expect(got.map((r) => r.id)).toEqual(expectedIds);
          expect(pendingReports(NOW).length).toBeLessThanOrEqual(MAX_PENDING_REPORTS);
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe("storage that fails never fails the exporter", () => {
  function brokenStorage(over: Partial<Storage>): Storage {
    return {
      length: 0,
      key: () => null,
      clear: () => undefined,
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
      ...over,
    };
  }

  it("says it could not keep a report when storage is full, and throws nothing", () => {
    vi.stubGlobal(
      "localStorage",
      brokenStorage({
        setItem: () => {
          throw new DOMException("full", "QuotaExceededError");
        },
      }),
    );
    expect(queueReport(report(), NOW)).toBe(false);
    expect(() => {
      removeReport("r-1", NOW);
      noteFailure("r-1", NOW);
      rememberUser("user_alice", NOW);
    }).not.toThrow();
  });

  it("reads an outbox it cannot open as empty, and throws nothing", () => {
    vi.stubGlobal(
      "localStorage",
      brokenStorage({
        getItem: () => {
          throw new DOMException("denied", "SecurityError");
        },
      }),
    );
    expect(pendingReports(NOW)).toEqual([]);
    expect(lastKnownUser(NOW)).toBe("");
    expect(() => queueReport(report(), NOW)).not.toThrow();
  });

  it("behaves when there is no storage at all", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(queueReport(report(), NOW)).toBe(false);
    expect(pendingReports(NOW)).toEqual([]);
    expect(lastKnownUser(NOW)).toBe("");
    expect(() => {
      removeReport("r-1", NOW);
      clearOutbox();
    }).not.toThrow();
  });

  it("holds nothing beyond the report's own fields", () => {
    queueReport(report(), NOW);
    rememberUser("user_alice", NOW);
    expect(Object.keys(rawStored()).sort()).toEqual(["lastUser", "lastUserAt", "reports", "v"]);
    expect(Object.keys(rawStored().reports[0]).sort()).toEqual([
      "at",
      "body",
      "disposable",
      "failedAt",
      "id",
      "owner",
    ]);
  });
});
