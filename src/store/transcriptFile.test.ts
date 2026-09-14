import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/desktop", () => ({ storeForProject: vi.fn() }));

import { storeForProject } from "../lib/desktop";
import { joinPath, type ProjectStoreAccess, readJsonOrRecover } from "../tools/store";
import {
  _persistIdle,
  loadClientSession,
  loadSession,
  loadTranscriptRequests,
  persistSession,
  persistSessionNow,
  persistSessionSoon,
  readLocalTranscript,
  SESSION_REL,
  TRANSCRIPT_REL,
} from "./transcriptFile";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const DIR = "C:/proj/p1";
const P = joinPath(DIR, TRANSCRIPT_REL);

function storeWith(files: Record<string, string>): ProjectStoreAccess {
  return {
    projectDir: DIR,
    exists: async (p: string) => p in files,
    readText: async (p: string) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p];
    },
  } as Any;
}

afterEach(() => vi.clearAllMocks());

describe("readLocalTranscript", () => {
  it("returns the requests array from the co-located file", async () => {
    const store = storeWith({ [P]: JSON.stringify({ requests: [{ id: "req_1" }] }) });
    expect(await readLocalTranscript(store)).toEqual([{ id: "req_1" }]);
  });
  it("returns [] when the file is absent (fresh session)", async () => {
    expect(await readLocalTranscript(storeWith({}))).toEqual([]);
  });
  it("returns [] when there is no requests field", async () => {
    expect(await readLocalTranscript(storeWith({ [P]: JSON.stringify({ version: 1 }) }))).toEqual(
      [],
    );
  });
  it("returns null on corrupt JSON so the caller can fall back", async () => {
    expect(await readLocalTranscript(storeWith({ [P]: "{not json" }))).toBeNull();
  });
});

describe("loadTranscriptRequests", () => {
  it("reads the co-located file on desktop", async () => {
    (storeForProject as Any).mockResolvedValue(
      storeWith({ [P]: JSON.stringify({ requests: [{ id: "a" }] }) }),
    );
    expect(await loadTranscriptRequests("p1")).toEqual([{ id: "a" }]);
  });
  it("returns [] when the local file is corrupt (no server fallback)", async () => {
    (storeForProject as Any).mockResolvedValue(storeWith({ [P]: "{bad" }));
    expect(await loadTranscriptRequests("p1")).toEqual([]);
  });
  it("returns [] when there is no store (no desktop client)", async () => {
    (storeForProject as Any).mockResolvedValue(null);
    expect(await loadTranscriptRequests("p1")).toEqual([]);
  });
});

const AK = joinPath(DIR, SESSION_REL);

function storeRW(files: Record<string, string> = {}): ProjectStoreAccess {
  // readJsonOrRecover reads through store.fs; back it with the same map (no
  // rename -> a corrupt file is preserved via a writeTextFile copy).
  const fs = {
    exists: async (p: string) => p in files,
    readTextFile: async (p: string) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p];
    },
    writeTextFile: async (p: string, c: string) => void (files[p] = c),
  };
  return {
    projectDir: DIR,
    fs,
    exists: async (p: string) => p in files,
    readText: async (p: string) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p];
    },
    writeProjectText: async (p: string, c: string) => void (files[p] = c),
    readJson: <T>(p: string, fallback: T) => readJsonOrRecover(fs as Any, p, fallback),
  } as Any;
}

describe("loadSession / persistSession", () => {
  it("reads the internals session (requests + provider snapshot)", async () => {
    const store = storeRW({
      [AK]: JSON.stringify({
        requests: [{ id: "a" }],
        provider_snapshot: { previous_response_id: "r" },
      }),
    });
    expect(await loadSession(store)).toEqual({
      requests: [{ id: "a" }],
      providerSnapshot: { previous_response_id: "r" },
      session: null,
    });
  });
  it("migrates a legacy history/transcript.json when internals is absent", async () => {
    const store = storeRW({ [P]: JSON.stringify({ requests: [{ id: "leg" }] }) });
    expect(await loadSession(store)).toEqual({
      requests: [{ id: "leg" }],
      providerSnapshot: null,
      session: null,
    });
  });
  it("is empty when neither file exists", async () => {
    expect(await loadSession(storeRW({}))).toEqual({ requests: [], providerSnapshot: null });
  });
  it("recovers from a corrupt session file (preserves bytes, degrades to empty)", async () => {
    const files: Record<string, string> = { [AK]: "{not json" };
    expect(await loadSession(storeRW(files))).toEqual({ requests: [], providerSnapshot: null });
    const backups = Object.keys(files).filter((k) => k.startsWith(`${AK}.corrupt-`));
    expect(backups).toHaveLength(1);
    expect(files[backups[0]]).toBe("{not json");
  });
  it("persists the session to internals", async () => {
    const files: Record<string, string> = {};
    await persistSession(storeRW(files), {
      requests: [{ id: "x" }],
      providerSnapshot: { previous_response_id: "r2" },
    });
    const written = JSON.parse(files[AK]);
    expect(written.requests[0].id).toBe("x");
    expect(written.provider_snapshot).toEqual({ previous_response_id: "r2" });
  });

  it("abandons the transcript write when the session is no longer live (audit gap)", async () => {
    const files: Record<string, string> = {};
    // A store whose session has ended (project closed); its writeProjectText honors the guard the
    // same way the real ProjectStoreAccess does at the atomic-rename boundary.
    const store = {
      projectDir: DIR,
      sessionLive: () => false,
      writeProjectText: async (p: string, c: string, guard?: () => boolean) => {
        if (guard && !guard()) return false;
        files[p] = c;
        return true;
      },
    } as unknown as ProjectStoreAccess;
    const committed = await persistSession(store, {
      requests: [{ id: "x" }],
      providerSnapshot: null,
    });
    expect(committed).toBe(false); // abandoned — the session closed
    expect(Object.keys(files)).toHaveLength(0); // nothing written to the project the user left
  });
});

describe("persistSessionSoon (coalesced + serialized, R10)", () => {
  it("coalesces a burst of persists down to the LATEST snapshot", async () => {
    const files: Record<string, string> = {};
    const writes: string[] = [];
    const store = storeRW(files);
    (store as Any).writeProjectText = vi.fn(async (p: string, c: string) => {
      writes.push(c);
      files[p] = c;
    });
    for (let i = 1; i <= 5; i++)
      persistSessionSoon(store, { requests: [{ id: `r${i}` }], providerSnapshot: null });
    await _persistIdle(DIR);
    // Only the newest snapshot needs to reach disk: 5 calls collapse to the
    // in-flight write + one coalesced tail (≤ 2 writes), and r5 is the result.
    expect(JSON.parse(files[AK]).requests[0].id).toBe("r5");
    expect(writes.length).toBeLessThanOrEqual(2);
  });

  it("serializes writes so a slow earlier write can't clobber a later one", async () => {
    const files: Record<string, string> = {};
    let first = true;
    const store = storeRW(files);
    (store as Any).writeProjectText = vi.fn(async (p: string, c: string) => {
      if (first) {
        first = false;
        await new Promise((r) => setTimeout(r, 20)); // stall the FIRST write
      }
      files[p] = c;
    });
    persistSessionSoon(store, { requests: [{ id: "A" }], providerSnapshot: null });
    await Promise.resolve(); // let A's write start and stall on the timer
    persistSessionSoon(store, { requests: [{ id: "B" }], providerSnapshot: null });
    await _persistIdle(DIR);
    // Un-serialized, the slow A would land LAST and clobber B. Serialized, A
    // finishes first, then B — so the latest (B) is the final content.
    expect(JSON.parse(files[AK]).requests[0].id).toBe("B");
  });

  it("_persistIdle resolves immediately when nothing is queued", async () => {
    await expect(_persistIdle("C:/proj/idle-none")).resolves.toBeUndefined();
  });
});

describe("persistSessionNow (ordered, failure-reporting close-final write, finding #1)", () => {
  // A store whose writeProjectText durability is controllable per-call, keyed to its own dir so the
  // module-level queue can't cross-contaminate between tests.
  function nowStore(dir: string, write: (p: string, c: string) => boolean) {
    return {
      projectDir: dir,
      sessionLive: () => true,
      writeProjectText: async (p: string, c: string, guard?: () => boolean) => {
        if (guard && !guard()) return false;
        return write(p, c); // may return false (abandoned) or throw (disk error)
      },
    } as unknown as ProjectStoreAccess;
  }

  it("reports true and writes the snapshot when the disk is healthy", async () => {
    const dir = "C:/proj/now-ok";
    const files: Record<string, string> = {};
    const store = nowStore(dir, (p, c) => ((files[p] = c), true));
    expect(
      await persistSessionNow(store, { requests: [{ id: "final" }], providerSnapshot: null }),
    ).toBe(true);
    expect(JSON.parse(files[joinPath(dir, SESSION_REL)]).requests[0].id).toBe("final");
  });

  it("reports FALSE when the write is abandoned (returns false) — nothing durable", async () => {
    const dir = "C:/proj/now-abandon";
    const files: Record<string, string> = {};
    const store = nowStore(dir, () => false);
    expect(
      await persistSessionNow(store, { requests: [{ id: "x" }], providerSnapshot: null }),
    ).toBe(false);
    expect(Object.keys(files)).toHaveLength(0);
  });

  it("reports FALSE when the write THROWS (disk error) instead of silently swallowing", async () => {
    const dir = "C:/proj/now-throw";
    const store = nowStore(dir, () => {
      throw new Error("disk full");
    });
    expect(
      await persistSessionNow(store, { requests: [{ id: "x" }], providerSnapshot: null }),
    ).toBe(false);
  });

  it("a still-pending OLDER snapshot can NEVER clobber the close-final one (latest-wins, ordered)", async () => {
    const dir = "C:/proj/now-order";
    const files: Record<string, string> = {};
    const writes: string[] = [];
    const store = nowStore(
      dir,
      (p, c) => (writes.push(JSON.parse(c).requests[0]?.id), (files[p] = c), true),
    );
    // A burst of fire-and-forget producer snapshots is still queued...
    persistSessionSoon(store, { requests: [{ id: "old-1" }], providerSnapshot: null });
    persistSessionSoon(store, { requests: [{ id: "old-2" }], providerSnapshot: null });
    // ...then the close writes the final snapshot through the SAME queue and awaits durability.
    expect(
      await persistSessionNow(store, { requests: [{ id: "final" }], providerSnapshot: null }),
    ).toBe(true);
    // The LAST thing on disk is the final snapshot (an older queued write never lands on top of it).
    expect(JSON.parse(files[joinPath(dir, SESSION_REL)]).requests[0].id).toBe("final");
    expect(writes[writes.length - 1]).toBe("final");
  });
});

describe("loadClientSession", () => {
  it("uses the co-located internals session on desktop", async () => {
    (storeForProject as Any).mockResolvedValue(
      storeRW({ [AK]: JSON.stringify({ requests: [{ id: "d" }], provider_snapshot: null }) }),
    );
    expect(await loadClientSession("p1")).toEqual({
      requests: [{ id: "d" }],
      providerSnapshot: null,
      session: null,
    });
  });
  it("is empty when there is no store (no desktop client)", async () => {
    (storeForProject as Any).mockResolvedValue(null);
    expect(await loadClientSession("p1")).toEqual({ requests: [], providerSnapshot: null });
  });
});
