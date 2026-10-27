// A finished export is reported once, to the account that ran it, and is not lost to a moment when
// the report could not be sent. These drive the real reporter against a fake server that behaves like
// the real route where it matters here: one row per (account, event_id), a refusal of a report that is
// claimed by another account, and every way a send can fail, including the one that matters most --
// the row was written and the answer never arrived.
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setClerkTokenProvider } from "./auth";
import {
  MAX_PENDING_REPORTS,
  clearOutbox,
  lastKnownUser,
  pendingReports,
  queueReport,
  rememberUser,
} from "./exportOutbox";
import {
  __resetExportReports,
  composeBody,
  flushExportReports,
  installExportReportDelivery,
  reportExport,
  type ExportEvent,
} from "./exportEvents";
import { useAuth } from "../store/auth";
import { setSessionUserReader } from "./exportOwner";

const host = vi.hoisted(() => ({ os: "windows", arch: "x86_64" }));
vi.mock("../platform/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform/host")>()),
  hostInfo: () => ({ os: host.os, arch: host.arch }),
}));

// Who the session's own token says is signed in: known as soon as a token is held, which is before
// the profile has loaded. Null (no token held) unless a test says otherwise.
const session = vi.hoisted(() => ({ user: null as string | null }));

type Reply =
  | "ok"
  | "lost-answer" // the row is written, the answer never arrives
  | "offline"
  | "down" // 503
  | "busy" // 429
  | "refuse" // 400: the server will never take this body
  | "could-not-store" // 200 {ok:false,status:"error"}
  | "portal"; // 200 with a page that is not the server's

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface Request {
  user: string | null;
  body: Record<string, unknown>;
}

class World {
  /** What the server holds: one row per account and event_id, whatever number of sends it took. */
  rows = new Map<string, Record<string, unknown>>();
  requests: Request[] = [];
  refused = new Set<string>();
  /** Reports (by project_id) the server can never store: every send of them gets `status:"error"`. */
  poisoned = new Set<string>();
  script: Reply[] = [];
  signedIn: string | null = null;
  gate: Promise<void> | null = null;
  seenInFlight: number[] = [];

  fetch = vi.fn(async (_url: string, init: RequestInit): Promise<Response> => {
    const auth = new Headers(init.headers).get("Authorization") ?? "";
    const name = auth.startsWith("Bearer tok_") ? auth.slice("Bearer tok_".length) : null;
    const user = name ? `user_${name}` : null;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    this.requests.push({ user, body });
    this.seenInFlight.push(pendingReports().filter((r) => r.id === body.event_id).length);
    if (this.gate) await this.gate;
    if (!user) return new Response("{}", { status: 401 });
    if (body.owner_id && body.owner_id !== user) return new Response("{}", { status: 409 });
    if (this.poisoned.has(String(body.project_id))) return json({ ok: false, status: "error" });
    const reply = this.script.shift() ?? "ok";
    const key = `${user}|${body.event_id}`;
    const store = () => {
      if (!this.rows.has(key)) this.rows.set(key, { ...body, user });
    };
    switch (reply) {
      case "ok":
        store();
        return json({ ok: true, status: "ok" });
      case "lost-answer":
        store();
        throw new TypeError("the connection dropped after the row was written");
      case "offline":
        throw new TypeError("offline");
      case "down":
        return new Response("", { status: 503 });
      case "busy":
        return new Response("{}", { status: 429 });
      case "refuse":
        this.refused.add(key);
        return new Response("{}", { status: 400 });
      case "could-not-store":
        return json({ ok: false, status: "error" });
      case "portal":
        return new Response("<html>sign in to the wifi</html>", { status: 200 });
    }
  });

  constructor() {
    setClerkTokenProvider(async () => (this.signedIn ? `tok_${this.signedIn}` : null));
    vi.stubGlobal("fetch", this.fetch);
  }

  profile(name: string) {
    return {
      user_id: `user_${name}`,
      email: `${name}@example.com`,
      display_name: name,
      image_url: "",
      metered: true,
    };
  }

  signIn(name: string): void {
    this.signedIn = name;
    useAuth.setState({
      status: "unlocked",
      hasStoredSession: true,
      profile: this.profile(name),
    });
  }

  /** An explicit sign-out: nobody is signed in and the app shows the sign-in screen. */
  signOut(): void {
    this.signedIn = null;
    useAuth.setState({ status: "locked", hasStoredSession: false, profile: null });
  }

  /** The app still shows alice, but no token can be had (offline at start, or the session lapsed). */
  loseToken(): void {
    this.signedIn = null;
  }

  regainToken(name: string): void {
    this.signedIn = name;
  }

  /** The rows the server holds for one account. */
  rowsOf(user: string): Record<string, unknown>[] {
    return [...this.rows.values()].filter((row) => row.user === user);
  }
}

function world(): World {
  return new World();
}

const done = (over: Partial<ExportEvent> = {}): ExportEvent => ({
  status: "done",
  elapsed_ms: 62_000,
  size_bytes: 14_000_000,
  project_id: "p1",
  ...over,
});

beforeEach(() => {
  clearOutbox();
  host.os = "windows";
  session.user = null;
  setSessionUserReader(() => session.user);
});

afterEach(() => {
  setSessionUserReader(null);
  __resetExportReports();
  clearOutbox();
  setClerkTokenProvider(null);
  useAuth.setState({ status: "checking", hasStoredSession: false, profile: null });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a report that cannot be sent when the export ends", () => {
  it("waits, and is sent once someone can, with the body, the name and the owner it was kept with", async () => {
    const w = world();
    w.signIn("alice");
    await reportExport(done());
    expect(w.rowsOf("user_alice")).toHaveLength(1);

    w.loseToken(); // the session lapsed, or the app started offline: the editor is still up
    await reportExport(done({ status: "failed", error: "ffmpeg died", elapsed_ms: 9 }));
    expect(w.requests).toHaveLength(1); // nothing could be sent
    const [kept] = pendingReports();
    expect(kept).toMatchObject({
      owner: "user_alice",
      body: { status: "failed", error: "ffmpeg died" },
    });

    w.regainToken("alice");
    await flushExportReports();
    expect(pendingReports()).toEqual([]);
    expect(w.requests).toHaveLength(2);
    const sent = w.requests[1].body;
    expect(sent).toMatchObject({
      ...kept.body,
      event_id: kept.id,
      occurred_at: kept.at,
      owner_id: "user_alice",
    });
    expect(w.rowsOf("user_alice")).toHaveLength(2);
  });

  it("is on disk before it is sent, and gone only once the server has confirmed it", async () => {
    const w = world();
    w.signIn("alice");
    await reportExport(done());
    expect(w.seenInFlight).toEqual([1]); // the copy a crash mid-send would have found
    expect(pendingReports()).toEqual([]);
  });

  it("is sent again under the SAME name when the answer was lost, and the server holds it once", async () => {
    const w = world();
    w.signIn("alice");
    w.script = ["lost-answer"];
    await reportExport(done());
    expect(w.rowsOf("user_alice")).toHaveLength(1); // written, though the app never heard
    expect(pendingReports()).toHaveLength(1); // so the app still holds it
    await flushExportReports();
    expect(pendingReports()).toEqual([]);
    expect(w.requests).toHaveLength(2);
    expect(w.requests[1].body.event_id).toBe(w.requests[0].body.event_id);
    expect(w.requests[1].body.occurred_at).toBe(w.requests[0].body.occurred_at);
    expect(w.rowsOf("user_alice")).toHaveLength(1);
  });

  it("carries the facts of the run that produced it, not of the app that sends it later", async () => {
    const w = world();
    w.signIn("alice");
    w.loseToken();
    await reportExport(done());
    host.os = "macos"; // a different machine's facts by the time it can be sent
    w.regainToken("alice");
    await flushExportReports();
    expect(w.requests[0].body).toMatchObject({ platform: "windows", arch: "x86_64" });
  });

  it("survives the app being closed: a new launch finds it and sends it", async () => {
    const w = world();
    w.signIn("alice");
    w.script = ["offline"];
    await reportExport(done());
    __resetExportReports(); // the process ended; only localStorage remains
    expect(pendingReports()).toHaveLength(1);
    await flushExportReports();
    expect(w.rowsOf("user_alice")).toHaveLength(1);
    expect(pendingReports()).toEqual([]);
  });

  it("is sent on behalf of the account that ran the export, never another that signed in since", async () => {
    const w = world();
    w.signIn("alice");
    w.script = ["offline"];
    await reportExport(done({ project_id: "alices" }));
    w.signIn("bob"); // bob uses the same machine before alice's report could be sent
    await flushExportReports();
    expect(w.requests).toHaveLength(1); // nothing of alice's was sent under bob's session
    await reportExport(done({ project_id: "bobs" }));
    expect(w.rowsOf("user_bob").map((r) => r.project_id)).toEqual(["bobs"]);
    expect(w.rowsOf("user_alice")).toEqual([]);
    expect(pendingReports().map((r) => r.owner)).toEqual(["user_alice"]);
    w.signIn("alice");
    await flushExportReports();
    expect(w.rowsOf("user_alice").map((r) => r.project_id)).toEqual(["alices"]);
    expect(pendingReports()).toEqual([]);
  });

  it("is kept for its owner when the session that tries to send it is not the owner's", async () => {
    const w = world();
    // bob's session, but his profile has not loaded: the app can only guess the owner is the last
    // account it saw. The server refuses that claim; the report is neither misfiled nor lost.
    rememberUser("user_alice");
    w.regainToken("bob");
    await reportExport(done());
    expect(w.rowsOf("user_bob")).toEqual([]);
    expect(w.rowsOf("user_alice")).toEqual([]);
    expect(pendingReports().map((r) => r.owner)).toEqual(["user_alice"]);
    w.signIn("alice");
    await flushExportReports();
    expect(w.rowsOf("user_alice")).toHaveLength(1);
    expect(pendingReports()).toEqual([]);
  });

  it("is not sent under another account that signed in while its own token was being fetched", async () => {
    const w = world();
    w.signIn("alice");
    let fetchedTokens = 0;
    setClerkTokenProvider(async () => {
      // The first call is the check that a session exists; the second is the one the request carries.
      if (++fetchedTokens === 2) w.signIn("bob");
      return w.signedIn ? `tok_${w.signedIn}` : null;
    });
    await reportExport(done());
    expect(w.requests).toHaveLength(0); // never even asked: it would have been bob's session
    expect(pendingReports().map((r) => r.owner)).toEqual(["user_alice"]);
    w.signIn("alice");
    await flushExportReports();
    expect(w.rowsOf("user_alice")).toHaveLength(1);
    expect(w.rowsOf("user_bob")).toEqual([]);
  });

  it("is filed under the account that asked for the export, not the one signed in when it ends", async () => {
    const w = world();
    w.signIn("alice"); // alice asked for the export (captured when it was admitted: `owner`) ...
    w.signIn("bob"); // ... and by the time it ends, bob is the account signed in
    await reportExport(done({ project_id: "alices-export", owner: "user_alice" }));
    expect(w.requests).toHaveLength(0); // it was never sent under bob's session
    expect(pendingReports().map((r) => r.owner)).toEqual(["user_alice"]);
    w.signIn("alice");
    await flushExportReports();
    expect(w.rowsOf("user_alice").map((r) => r.project_id)).toEqual(["alices-export"]);
    expect(w.rowsOf("user_bob")).toEqual([]);
  });

  it("knows who is signed in from the session's own token before the profile has loaded", async () => {
    const w = world();
    rememberUser("user_alice"); // the account this device saw last time
    w.regainToken("bob");
    session.user = "user_bob"; // ... but the token now held is bob's, and /me has not answered yet
    w.script = ["offline"];
    await reportExport(done({ project_id: "bobs" }));
    // Not guessed to be alice's from the last launch: it belongs to the token's account.
    expect(pendingReports().map((r) => r.owner)).toEqual(["user_bob"]);
    await flushExportReports();
    expect(w.rowsOf("user_bob").map((r) => r.project_id)).toEqual(["bobs"]);
    expect(w.rowsOf("user_alice")).toEqual([]);
  });

  it("does not send a report under a token of another account even to a server that cannot check owners", async () => {
    const w = world();
    // alice's report waits; bob's token is the one held, and his profile has not loaded.
    queueReport({
      id: "alices",
      owner: "user_alice",
      at: Date.now() / 1000,
      failedAt: 0,
      disposable: false,
      body: composeBody({ status: "done" })!,
    });
    w.regainToken("bob");
    session.user = "user_bob";
    await flushExportReports();
    expect(w.requests).toHaveLength(0); // the client itself holds it back: no server check is relied on
    expect(pendingReports().map((r) => r.id)).toEqual(["alices"]);
  });

  it("keeps the reports of exports that ran when one agent call is refused fifty times", async () => {
    const w = world();
    w.signIn("alice");
    w.loseToken(); // offline: nothing can be sent while these pile up
    await reportExport(done({ project_id: "ran-1" }));
    await reportExport(done({ project_id: "ran-2" }));
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        reportExport({ status: "blocked", operation: "render", project_id: `refused-${i}` }),
      ),
    );
    const kept = pendingReports().map((r) => String(r.body.project_id));
    expect(kept).toHaveLength(MAX_PENDING_REPORTS);
    expect(kept.slice(0, 2)).toEqual(["ran-1", "ran-2"]);
    expect(pendingReports().filter((r) => r.disposable)).toHaveLength(MAX_PENDING_REPORTS - 2);
    w.regainToken("alice");
    for (let i = 0; i < 12; i++) await flushExportReports();
    expect(w.rowsOf("user_alice").map((r) => r.project_id)).toEqual(
      expect.arrayContaining(["ran-1", "ran-2"]),
    );
  });

  it("never sends a report without a session, even if the session ends while its token is being fetched", async () => {
    const w = world();
    w.signIn("alice");
    let fetched = 0;
    setClerkTokenProvider(async () => (++fetched === 1 ? "tok_alice" : null)); // gone by the second look
    await reportExport(done());
    expect(w.requests).toHaveLength(0); // not even an unauthenticated attempt
    expect(pendingReports()).toHaveLength(1);
  });

  it("is sent now or not at all when nobody is known to have run the export", async () => {
    const w = world();
    w.regainToken("alice"); // a session, but no profile and no account ever seen on this install
    w.script = ["offline"];
    await reportExport(done());
    expect(pendingReports()).toEqual([]); // not kept: filing it under whoever signs in next is a guess
    w.script = [];
    await reportExport(done({ project_id: "now" }));
    expect(w.requests.at(-1)?.body).not.toHaveProperty("owner_id"); // the session alone attributes it
    expect(w.rowsOf("user_alice").map((r) => r.project_id)).toEqual(["now"]);
  });

  it.each<[Reply, string]>([
    ["down", "the server was down"],
    ["busy", "the server said slow down"],
    ["offline", "there was no network"],
    ["lost-answer", "the answer was lost"],
    ["portal", "a captive portal answered instead"],
  ])("is kept when %s (%s), however often it happens", async (reply) => {
    const w = world();
    w.signIn("alice");
    for (let i = 0; i < 10; i++) {
      w.script = [reply];
      if (i === 0) await reportExport(done());
      else await flushExportReports();
    }
    expect(pendingReports()).toHaveLength(1);
    // None of these is the server saying it cannot store the report, so none marks it as failing.
    expect(pendingReports().every((r) => r.failedAt === 0)).toBe(true);
  });

  it("is dropped when the server refuses it for good, not retried", async () => {
    const w = world();
    w.signIn("alice");
    w.script = ["refuse"];
    await reportExport(done());
    expect(pendingReports()).toEqual([]);
    await flushExportReports();
    expect(w.requests).toHaveLength(1);
  });

  it("is kept, not given up on, however long the server keeps saying it cannot store it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const w = world();
    w.signIn("alice");
    w.poisoned.add("stuck");
    await reportExport(done({ project_id: "stuck" }));
    for (let hour = 1; hour <= 24 * 10; hour++) {
      vi.setSystemTime(Date.now() + 3_600_000);
      await flushExportReports();
    }
    expect(pendingReports().map((r) => r.body.project_id)).toEqual(["stuck"]); // ten days on
    w.poisoned.clear(); // a day when the server can store it again: it is stored
    await flushExportReports();
    expect(w.rowsOf("user_alice").map((r) => r.project_id)).toEqual(["stuck"]);
    expect(pendingReports()).toEqual([]);
  });

  it("is not let to hold up the reports behind it: ones the server cannot store go to the back", async () => {
    const w = world();
    w.signIn("alice");
    w.loseToken();
    for (const project of ["stuck-1", "stuck-2", "good-1", "good-2", "good-3"])
      await reportExport(done({ project_id: project })); // the stuck ones are the oldest
    w.regainToken("alice");
    w.poisoned.add("stuck-1");
    w.poisoned.add("stuck-2");
    await flushExportReports(); // asks the two oldest, learns they cannot be stored, and stops
    expect(w.requests).toHaveLength(2);
    await flushExportReports(); // now they sort last, so everything else goes first
    expect(w.rowsOf("user_alice").map((r) => r.project_id)).toEqual(["good-1", "good-2", "good-3"]);
    expect(pendingReports().map((r) => r.body.project_id)).toEqual(["stuck-1", "stuck-2"]);
    expect(pendingReports().every((r) => r.failedAt > 0)).toBe(true);
  });

  it("does not ask a server that fails everything for more than a couple of reports per pass", async () => {
    const w = world();
    w.signIn("alice");
    w.loseToken();
    for (let i = 0; i < 10; i++) await reportExport(done({ project_id: `p${i}` }));
    w.regainToken("alice");
    for (let i = 0; i < 10; i++) w.poisoned.add(`p${i}`);
    await flushExportReports();
    expect(w.requests).toHaveLength(2);
    expect(pendingReports()).toHaveLength(10); // none given up on
  });

  it("is sent once however many things ask for it at the same moment", async () => {
    const w = world();
    w.signIn("alice");
    w.script = ["offline"];
    await reportExport(done());
    let open!: () => void;
    w.gate = new Promise<void>((resolve) => (open = resolve));
    const flushes = [flushExportReports(), flushExportReports(), flushExportReports()];
    await vi.waitFor(() => expect(w.requests).toHaveLength(2));
    open();
    await Promise.all(flushes);
    expect(w.requests).toHaveLength(2);
    expect(w.rowsOf("user_alice")).toHaveLength(1);
  });

  it("is not left behind when the account changes while another send is in flight", async () => {
    const w = world();
    w.signIn("alice");
    w.script = ["offline"];
    await reportExport(done({ project_id: "a1" })); // alice's report waits
    w.signIn("bob");
    w.script = ["offline"];
    await reportExport(done({ project_id: "b1" })); // so does bob's
    const sentBefore = w.requests.length;
    let open!: () => void;
    w.gate = new Promise<void>((resolve) => (open = resolve));
    const pass = flushExportReports(); // bob is signed in: skips a1, sends b1 and is held there
    await vi.waitFor(() => expect(w.requests).toHaveLength(sentBefore + 1));
    w.signIn("alice"); // alice comes back while that send is still in flight
    const asked = flushExportReports(); // ... and that is exactly when delivery is asked for
    open();
    await Promise.all([pass, asked]);
    // The question asked mid-pass was not lost with the pass: alice's report went without a third trigger.
    expect(w.rowsOf("user_alice").map((r) => r.project_id)).toEqual(["a1"]);
    expect(w.rowsOf("user_bob").map((r) => r.project_id)).toEqual(["b1"]);
    expect(pendingReports()).toEqual([]);
  });

  it("is not sent a second time while its first send is still in flight", async () => {
    const w = world();
    w.signIn("alice");
    let open!: () => void;
    w.gate = new Promise<void>((resolve) => (open = resolve));
    const first = reportExport(done());
    await vi.waitFor(() => expect(w.requests).toHaveLength(1));
    await flushExportReports(); // it is on disk, and being sent right now
    expect(w.requests).toHaveLength(1);
    open();
    await first;
    expect(w.requests).toHaveLength(1);
    expect(w.rowsOf("user_alice")).toHaveLength(1);
    expect(pendingReports()).toEqual([]);
  });

  it("is sent along with the next report that does get through", async () => {
    const w = world();
    w.signIn("alice");
    w.script = ["offline"];
    await reportExport(done({ project_id: "first" }));
    await reportExport(done({ project_id: "second" }));
    await flushExportReports(); // joins the flush the second report started
    expect(
      w
        .rowsOf("user_alice")
        .map((r) => r.project_id)
        .sort(),
    ).toEqual(["first", "second"]);
  });

  it("never turns anything here into an exception for the exporter", async () => {
    const w = world();
    w.signIn("alice");
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage is gone");
      },
      setItem: () => {
        throw new Error("storage is gone");
      },
      removeItem: () => undefined,
    });
    await expect(reportExport(done())).resolves.toBeUndefined();
    expect(w.rowsOf("user_alice")).toHaveLength(1); // still sent: not being able to keep it is not a reason to lose it
    await expect(flushExportReports()).resolves.toBeUndefined();
  });
});

describe("what is written to disk is what is sent", () => {
  const body = fc.record({
    status: fc.constantFrom("done", "failed", "cancelled", "blocked", "declined"),
    duration_s: fc.oneof(fc.double(), fc.constantFrom(NaN, Infinity, -1, 1e30)),
    size_bytes: fc.oneof(fc.double(), fc.constantFrom(NaN, Infinity, -1, 1e30)),
    error: fc.string({ maxLength: 700 }),
    project_id: fc.string({ maxLength: 300 }),
    quality: fc.string({ maxLength: 40 }),
    recovered: fc.anything(),
    reason_code: fc.anything(),
    operation: fc.anything(),
    readiness: fc.anything(),
  });

  it("is the same body after being shaped again (shaping what was read back changes nothing)", () => {
    fc.assert(
      fc.property(body, (input) => {
        const once = composeBody(input as Record<string, unknown>);
        expect(once).not.toBeNull();
        expect(composeBody(once!)).toEqual(once);
      }),
      { numRuns: 200 },
    );
  });

  it("is not a report at all without a real status", () => {
    for (const status of [undefined, null, "", "running", "DONE", 1, {}, []])
      expect(composeBody({ status })).toBeNull();
  });
});

describe("delivery, once installed", () => {
  // Timers the reporter itself armed, apart from any a fake clock also holds for a request's timeout.
  const armed = (before: number) => vi.getTimerCount() - before;

  it("starts nothing until it is installed: no timer, no listener", async () => {
    vi.useFakeTimers();
    const w = world();
    w.signIn("alice");
    w.script = ["offline"];
    const before = vi.getTimerCount();
    await reportExport(done());
    expect(armed(before)).toBe(0);
    const stop = installExportReportDelivery();
    stop();
    expect(armed(before)).toBe(0);
  });

  it("tries again on a growing schedule after a failure, and stops once it has gone through", async () => {
    vi.useFakeTimers();
    const w = world();
    w.signIn("alice");
    w.script = ["down", "down"];
    installExportReportDelivery();
    const before = vi.getTimerCount();
    await reportExport(done());
    expect(w.requests).toHaveLength(1);
    expect(armed(before)).toBeGreaterThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(w.requests).toHaveLength(1); // not before its time
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(w.requests).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(100_000);
    expect(w.requests).toHaveLength(2); // the second wait is longer than the first
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(w.requests).toHaveLength(3));
    expect(w.rowsOf("user_alice")).toHaveLength(1);
    expect(pendingReports()).toEqual([]);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(w.requests).toHaveLength(3); // delivered: it does not keep trying
  });

  it("retries soon after a failure even while a long wait for a sign-in is already pending", async () => {
    vi.useFakeTimers();
    const w = world();
    w.signIn("alice");
    w.loseToken(); // nobody can send: the next look is a long way off
    installExportReportDelivery();
    await reportExport(done());
    expect(pendingReports()).toHaveLength(1);
    w.regainToken("alice");
    w.script = ["down"];
    await flushExportReports(); // the server is down: that is a short wait, not the long one
    expect(w.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(31_000);
    await vi.waitFor(() => expect(w.requests).toHaveLength(2));
    expect(w.rowsOf("user_alice")).toHaveLength(1);
  });

  it("sends a long backlog in small batches, spaced out", async () => {
    vi.useFakeTimers();
    const w = world();
    w.signIn("alice");
    w.loseToken();
    for (let i = 0; i < 20; i++) await reportExport(done({ project_id: `p${i}` }));
    expect(pendingReports()).toHaveLength(20);
    w.regainToken("alice");
    installExportReportDelivery();
    for (const left of [15, 10, 5]) {
      await vi.waitFor(() => expect(pendingReports()).toHaveLength(left));
      await vi.advanceTimersByTimeAsync(20_000);
    }
    await vi.waitFor(() => expect(pendingReports()).toEqual([]));
    expect(w.rowsOf("user_alice")).toHaveLength(20);
  });

  it("wakes when someone signs in, without waiting for a timer", async () => {
    const w = world();
    w.signIn("alice");
    w.loseToken();
    await reportExport(done());
    w.signOut();
    installExportReportDelivery();
    expect(w.rowsOf("user_alice")).toHaveLength(0);
    w.signIn("alice");
    await vi.waitFor(() => expect(w.rowsOf("user_alice")).toHaveLength(1));
    expect(pendingReports()).toEqual([]);
  });

  it("wakes when the network comes back", async () => {
    const w = world();
    w.signIn("alice");
    w.script = ["offline"];
    installExportReportDelivery();
    await reportExport(done());
    expect(pendingReports()).toHaveLength(1);
    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(w.rowsOf("user_alice")).toHaveLength(1));
  });

  it("sends what the last run left behind, as soon as it is installed", async () => {
    const w = world();
    w.signIn("alice");
    w.script = ["offline"];
    await reportExport(done());
    __resetExportReports();
    installExportReportDelivery();
    await vi.waitFor(() => expect(w.rowsOf("user_alice")).toHaveLength(1));
  });

  it("remembers who is signed in, so a report built before the profile loads still names them", async () => {
    const w = world();
    installExportReportDelivery();
    w.signIn("alice");
    expect(lastKnownUser()).toBe("user_alice");
    useAuth.setState({ status: "checking", profile: null }); // the next launch, before /me answers
    w.regainToken("alice");
    w.script = ["offline"];
    await reportExport(done());
    expect(pendingReports().map((r) => r.owner)).toEqual(["user_alice"]);
  });

  it("is idempotent to install, and stops completely when removed", async () => {
    vi.useFakeTimers();
    const w = world();
    w.signIn("alice");
    const stop = installExportReportDelivery();
    expect(installExportReportDelivery()).toBe(stop);
    w.script = ["down"];
    const before = vi.getTimerCount();
    await reportExport(done());
    expect(armed(before)).toBeGreaterThanOrEqual(1);
    stop();
    window.dispatchEvent(new Event("online"));
    w.signIn("bob");
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(w.requests).toHaveLength(1); // removed: no timer, no listener, no subscription is left
  });
});

// The whole promise, against every order of the things that can happen: reports finishing while
// signed in, signed out or offline, accounts changing, the app restarting, and a server that is down,
// slow, refusing, or drops the answer after writing the row. After everything works again and each
// account has signed in once, the server must hold every report that could be attributed, exactly
// once, under the account that ran it, and no request may ever have claimed another account's report.
describe("whatever order things happen in", () => {
  type Action =
    | { t: "settle" }
    | { t: "signIn"; who: "alice" | "bob" }
    | { t: "switch"; who: "alice" | "bob" } // the account changes while a pass is already running
    | { t: "signOut" }
    | { t: "loseToken" }
    | { t: "flush" }
    | { t: "restart" }
    | { t: "reply"; r: Reply };

  const replies: Reply[] = [
    "ok",
    "lost-answer",
    "offline",
    "down",
    "busy",
    "refuse",
    "could-not-store",
    "portal",
  ];
  const action: fc.Arbitrary<Action> = fc.oneof(
    { weight: 5, arbitrary: fc.constant<Action>({ t: "settle" }) },
    {
      weight: 2,
      arbitrary: fc.constantFrom<Action>(
        { t: "signIn", who: "alice" },
        { t: "signIn", who: "bob" },
      ),
    },
    {
      weight: 2,
      arbitrary: fc.constantFrom<Action>(
        { t: "switch", who: "alice" },
        { t: "switch", who: "bob" },
      ),
    },
    { weight: 1, arbitrary: fc.constant<Action>({ t: "signOut" }) },
    { weight: 1, arbitrary: fc.constant<Action>({ t: "loseToken" }) },
    { weight: 3, arbitrary: fc.constant<Action>({ t: "flush" }) },
    { weight: 1, arbitrary: fc.constant<Action>({ t: "restart" }) },
    { weight: 6, arbitrary: fc.constantFrom(...replies).map((r): Action => ({ t: "reply", r })) },
  );

  // Found by generation, then kept so they run every time: a restart while the delivery pass that
  // the previous action left behind was still running (see the restart action below).
  const restartsWithWorkInFlight: Action[][] = [
    [
      { t: "switch", who: "alice" },
      { t: "reply", r: "busy" },
      { t: "reply", r: "ok" },
      { t: "settle" },
      { t: "reply", r: "ok" },
      { t: "reply", r: "lost-answer" },
      { t: "settle" },
      { t: "restart" },
      { t: "flush" },
    ],
    [
      { t: "reply", r: "offline" },
      { t: "switch", who: "bob" },
      { t: "settle" },
      { t: "reply", r: "ok" },
      { t: "reply", r: "lost-answer" },
      { t: "settle" },
      { t: "restart" },
      { t: "switch", who: "bob" },
      { t: "settle" },
    ],
  ];

  it("every attributable report reaches the server once, under its own account", async () => {
    await fc.assert(
      fc
        .asyncProperty(fc.array(action, { minLength: 1, maxLength: 30 }), async (actions) => {
          clearOutbox();
          __resetExportReports();
          useAuth.setState({ status: "checking", hasStoredSession: false, profile: null });
          let counter = 0;
          vi.stubGlobal("crypto", { randomUUID: () => `r-${++counter}` });
          const w = world();

          // What the specification says about whose report each one is.
          const ownerOf = new Map<string, string>();
          let lastUser = "";
          let shown: string | null = null; // the account the app shows as signed in

          // Whenever somebody who can send is signed in and the server is behaving, asking for a
          // flush leaves nothing of theirs behind that one pass could have sent. A trigger swallowed
          // by a pass that had already decided what to skip would fail this the moment it happened,
          // not only if a later trigger happened to rescue it.
          const mineNow = () =>
            w.signedIn === null
              ? 0
              : pendingReports().filter((r) => r.owner === `user_${w.signedIn}`).length;
          const behaving = () => w.signedIn !== null && w.script.length === 0;
          const expectProgress = (before: number) => {
            const after = mineNow();
            if (before > 0)
              expect(after, "a flush left reports it could have sent").toBeLessThan(before);
            if (before <= 5) expect(after, "a flush left reports it could have sent").toBe(0);
          };

          for (const a of actions) {
            if (a.t === "signIn") {
              w.signIn(a.who);
              shown = `user_${a.who}`;
            } else if (a.t === "switch") {
              const pass = flushExportReports(); // already running when the account changes
              w.signIn(a.who);
              shown = `user_${a.who}`;
              const before = mineNow();
              const clean = behaving();
              await flushExportReports();
              await pass;
              if (clean) expectProgress(before);
            } else if (a.t === "signOut") {
              w.signOut();
              shown = null;
            } else if (a.t === "loseToken") w.loseToken();
            else if (a.t === "reply") w.script.push(a.r);
            else if (a.t === "flush") {
              const before = mineNow();
              const clean = behaving();
              await flushExportReports();
              if (clean) expectProgress(before);
            } else if (a.t === "restart") {
              // A relaunch ends the old process and everything it had started. reportExport leaves a
              // pass running for the backlog without waiting for it, and resetting the module only makes
              // it forget that pass: the old one would carry on beside the next, and the second could
              // send a report the first had already confirmed. No real restart leaves work behind.
              await flushExportReports();
              __resetExportReports();
            } else {
              if (shown) lastUser = shown;
              const id = `r-${counter + 1}`;
              ownerOf.set(id, shown ?? lastUser);
              await reportExport(done({ project_id: id }));
            }
            expect(pendingReports().length).toBeLessThanOrEqual(50);
          }

          // Everything works again; each account gets to sign in.
          w.script = [];
          for (const who of ["alice", "bob", "alice"] as const) {
            w.signIn(who);
            for (let i = 0; i < 10 && pendingReports().some((r) => r.owner === `user_${who}`); i++)
              await flushExportReports();
          }

          for (const [id, owner] of ownerOf) {
            const stored = w.rows.has(`${owner}|${id}`);
            const refused = w.refused.has(`${owner}|${id}`);
            if (owner === "") {
              // Nobody was known to have run it, so it could only have been sent at once, and it
              // could not be: nobody was signed in.
              expect(
                [...w.rows.keys()].some((k) => k.endsWith(`|${id}`)),
                `${id} had no owner`,
              ).toBe(false);
            } else {
              expect(stored || refused, `${id} of ${owner} was lost`).toBe(true);
            }
            // Never under anyone else.
            for (const key of w.rows.keys())
              if (key.endsWith(`|${id}`)) expect(key, id).toBe(`${owner}|${id}`);
          }
          // Every send of one report is the same report: same name, same time, same body.
          const byId = new Map<string, Request>();
          for (const r of w.requests) {
            const id = String(r.body.event_id);
            const first = byId.get(id);
            if (first) expect(r.body, id).toEqual(first.body);
            else byId.set(id, r);
            // And it never claimed an account other than the session that carried it.
            if (r.body.owner_id !== undefined) expect(r.body.owner_id, id).toBe(r.user);
          }
          // A report known to an account was on disk whenever it was in flight.
          w.requests.forEach((r, i) => {
            if (r.body.owner_id !== undefined)
              expect(w.seenInFlight[i], String(r.body.event_id)).toBe(1);
          });
        })
        .afterEach(() => {
          vi.unstubAllGlobals();
          setClerkTokenProvider(null);
        }),
      {
        numRuns: 150,
        examples: restartsWithWorkInFlight.map((actions) => [actions] as [Action[]]),
      },
    );
  });
});
