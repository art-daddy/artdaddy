import fc from "fast-check";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The reporter is the one place a sign-in step leaves the app before there is an account, so what these test is
// what actually goes out (the body, the request, how often) and that nothing about it can get in the way of
// signing in: it must never throw and never wait, whatever is broken around it.
const platformMock = vi.hoisted(() => ({ name: "tauri" as "tauri" | "web" }));
vi.mock("../platform", () => ({ platform: platformMock }));
const host = vi.hoisted(() => ({ os: "windows", arch: "x86_64" }));
vi.mock("../platform/host", () => ({ hostInfo: () => host }));
vi.mock("./config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config")>()),
  apiBase: () => "https://api.example.com",
}));
const fetchMock = vi.hoisted(() => vi.fn());

import {
  AUTH_APP_STEPS,
  AUTH_ID_LENGTH,
  MAX_AUTH_MS,
  __resetAuthEvents,
  getInstallId,
  hasSignedInBefore,
  isAuthId,
  markSignedInBefore,
  newAuthId,
  reportAuthStep,
  resetInstallId,
  type AuthStep,
} from "./authEvents";

const ID = /^[A-Za-z0-9_-]{12}$/;
const ATTEMPT = "a1B2c3D4e5F6";

const posted = () =>
  fetchMock.mock.calls.map(([url, init]) => ({
    url: url as string,
    init: init as RequestInit,
    body: JSON.parse((init as RequestInit).body as string) as Record<string, unknown>,
  }));

beforeEach(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true });
  platformMock.name = "tauri";
  host.os = "windows";
  host.arch = "x86_64";
  localStorage.clear();
  __resetAuthEvents();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("what leaves the app", () => {
  it("is one plain POST to the public beacon: no credential, no custom header, nothing to read back", () => {
    reportAuthStep("start", { ok: true, attempt: ATTEMPT });
    const [request] = posted();
    expect(request.url).toBe("https://api.example.com/e");
    expect(request.init.method).toBe("POST");
    expect(request.init.mode).toBe("no-cors");
    expect(request.init.keepalive).toBe(true);
    expect(request.init.headers).toBeUndefined();
    expect(request.init.credentials).toBeUndefined();
    expect(typeof request.init.body).toBe("string");
  });

  it("says who it is about only as an install id and an attempt id, and what happened as words", () => {
    reportAuthStep("callback", {
      ok: false,
      reason: "state_mismatch",
      attempt: ATTEMPT,
      ms: 4200.6,
    });
    const [{ body }] = posted();
    expect(body).toEqual({
      event: "auth",
      source: "app",
      step: "callback",
      install: expect.stringMatching(ID),
      attempt: ATTEMPT,
      ok: false,
      reason: "state_mismatch",
      ms: 4201,
      app_version: __ARTDADDY_RELEASE__,
      os: "windows",
      arch: "x86_64",
    });
  });

  it("sends nothing it was not given: no ok, reason, attempt or time that is not there", () => {
    reportAuthStep("screen");
    const [{ body }] = posted();
    expect(Object.keys(body).sort()).toEqual(
      ["app_version", "arch", "event", "install", "os", "source", "step"].sort(),
    );
  });

  it("can send every step with every reason it can have, and each arrives as sent", () => {
    for (const step of Object.keys(AUTH_APP_STEPS) as AuthStep[]) {
      const reasons: readonly (string | undefined)[] = [undefined, ...AUTH_APP_STEPS[step]];
      for (const reason of reasons) {
        __resetAuthEvents();
        fetchMock.mockClear();
        reportAuthStep(step, { reason: reason as never, ok: reason === undefined });
        const [{ body }] = posted();
        expect(body.step, `${step}/${reason}`).toBe(step);
        expect(body.reason, `${step}/${reason}`).toBe(reason);
      }
    }
  });

  it("keeps every word shorter than any secret the sign-in handles (a one-time code is 20 or more)", () => {
    for (const [step, reasons] of Object.entries(AUTH_APP_STEPS)) {
      for (const word of [step, ...reasons]) expect(word.length, word).toBeLessThan(20);
    }
  });

  it("sends a release the server will keep: the real version has the shape its fixed format allows", () => {
    // Written down again in analytics.py (_AUTH_VERSION_RE). A version outside it is not refused, it is simply not
    // stored, so every row would quietly lose its version: this fails the day the release string stops fitting.
    const manifest = JSON.parse(
      readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"),
    ) as { version: string };
    expect(`artdaddy@${manifest.version}`).toMatch(
      /^(?:artdaddy@)?\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[A-Za-z0-9.]{1,12})?$/,
    );
  });

  it("clamps the time to what the server keeps and leaves out one that is not a number", () => {
    reportAuthStep("callback", { ms: -50 });
    reportAuthStep("callback", { ms: 10 ** 12 });
    reportAuthStep("callback", { ms: Number.NaN });
    reportAuthStep("callback", { ms: Number.POSITIVE_INFINITY });
    reportAuthStep("callback", { ms: "12" as unknown as number });
    expect(posted().map(({ body }) => body.ms)).toEqual([
      0,
      MAX_AUTH_MS,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("drops an attempt id that does not have the id shape, so a secret put there cannot leave", () => {
    for (const bad of [
      "",
      "short",
      "x".repeat(13),
      "x".repeat(43),
      "has space12",
      "oneTimeCode0123456789",
    ]) {
      reportAuthStep("start", { attempt: bad });
    }
    expect(posted().every(({ body }) => !("attempt" in body))).toBe(true);
  });

  it("drops a reason that is not one of its own step's, so nothing but a word of the table leaves", () => {
    const secret = "oneTimeCode0123456789";
    reportAuthStep("callback", { ok: false, reason: secret as never });
    reportAuthStep("callback", { ok: false, reason: "open_failed" as never }); // a `start` reason, wrong step
    reportAuthStep("callback", { ok: false, reason: { toString: () => secret } as never });
    expect(posted().map(({ body }) => body.reason)).toEqual([undefined, undefined, undefined]);
    expect(JSON.stringify(posted().map(({ body }) => body))).not.toContain(secret);
  });

  it("sends no step that is not in the table", () => {
    reportAuthStep("authorize" as never, { ok: true });
    reportAuthStep("constructor" as never);
    reportAuthStep("__proto__" as never);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports nothing outside the desktop app", () => {
    platformMock.name = "web";
    reportAuthStep("screen", { reason: "new" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says nothing about the machine beyond the system and chip the other reports already carry", () => {
    host.os = "macos";
    host.arch = "";
    reportAuthStep("screen", { reason: "new" });
    expect(posted()[0].body).toMatchObject({ os: "macos", arch: "" });
  });
});

describe("the ids", () => {
  it("are exactly twelve URL-safe characters, always", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 200 }), (count) => {
        for (let i = 0; i < count; i++) {
          const id = newAuthId();
          if (!ID.test(id) || id.length !== AUTH_ID_LENGTH) return false;
        }
        return true;
      }),
      { numRuns: 25 },
    );
  });

  it("do not repeat", () => {
    const seen = new Set(Array.from({ length: 5000 }, () => newAuthId()));
    expect(seen.size).toBe(5000);
  });

  it("are recognised by the same rule the server applies, and nothing longer or shorter is", () => {
    expect(isAuthId(newAuthId())).toBe(true);
    for (const bad of [
      undefined,
      null,
      12,
      "",
      "a".repeat(11),
      "a".repeat(13),
      "a1B2c3D4e5F!",
      "ａ1B2c3D4e5F6",
    ]) {
      expect(isAuthId(bad), String(bad)).toBe(false);
    }
  });

  it("make the install one install for as long as it lasts, and a different one after it is forgotten", () => {
    const first = getInstallId();
    expect(first).toMatch(ID);
    expect(getInstallId()).toBe(first);
    resetInstallId();
    expect(localStorage.getItem("artdaddy.install_id")).toBeNull();
    expect(getInstallId()).not.toBe(first);
  });

  it("replace a stored id that has been tampered with, instead of sending it", () => {
    localStorage.setItem("artdaddy.install_id", "someone@example.com-and-more");
    const id = getInstallId();
    expect(id).toMatch(ID);
    expect(id).not.toContain("someone");
    expect(localStorage.getItem("artdaddy.install_id")).toBe(id);
  });

  it("still group one run's steps when the machine will not keep anything", () => {
    const stored = vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    const first = getInstallId();
    expect(first).toMatch(ID);
    expect(getInstallId()).toBe(first);
    expect(stored).toHaveBeenCalled();
  });

  it("remember that a sign-in once worked here, and do not claim it when storage is off", () => {
    expect(hasSignedInBefore()).toBe(false);
    markSignedInBefore();
    expect(hasSignedInBefore()).toBe(true);
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    expect(hasSignedInBefore()).toBe(false);
  });
});

describe("how often", () => {
  it("says a sign-in screen was shown once for each reason in half an hour, not every time it redraws", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T10:00:00Z"));
    reportAuthStep("screen", { reason: "new" });
    reportAuthStep("screen", { reason: "new" });
    reportAuthStep("screen", { reason: "offline" });
    expect(posted().map(({ body }) => body.reason)).toEqual(["new", "offline"]);
    vi.setSystemTime(new Date("2026-11-02T10:29:00Z"));
    reportAuthStep("screen", { reason: "new" });
    expect(posted()).toHaveLength(2);
    vi.setSystemTime(new Date("2026-11-02T10:31:00Z"));
    reportAuthStep("screen", { reason: "new" });
    expect(posted()).toHaveLength(3);
  });

  it("says a renewal failed once for each cause in ten minutes, not once per request while the server is down", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T10:00:00Z"));
    for (let i = 0; i < 40; i++) reportAuthStep("refresh", { ok: false, reason: "network" });
    expect(posted()).toHaveLength(1);
    reportAuthStep("refresh", { ok: false, reason: "server_error" });
    expect(posted()).toHaveLength(2);
    vi.setSystemTime(new Date("2026-11-02T10:11:00Z"));
    reportAuthStep("refresh", { ok: false, reason: "network" });
    expect(posted()).toHaveLength(3);
  });

  it("never says a start or a callback was quiet: each is something the person did", () => {
    for (let i = 0; i < 5; i++) reportAuthStep("start", { ok: true });
    for (let i = 0; i < 5; i++) reportAuthStep("callback", { ok: false, reason: "state_mismatch" });
    expect(posted()).toHaveLength(10);
  });

  it("stops after twenty in a minute, so a loop in the app cannot flood the public route, and starts again", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T10:00:00Z"));
    for (let i = 0; i < 60; i++) reportAuthStep("callback", { ok: false, reason: "error" });
    expect(posted()).toHaveLength(20);
    vi.setSystemTime(new Date("2026-11-02T10:01:01Z"));
    reportAuthStep("callback", { ok: false, reason: "error" });
    expect(posted()).toHaveLength(21);
  });

  it("does not spend the minute's allowance on a report that was left out as a repeat", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T10:00:00Z"));
    for (let i = 0; i < 100; i++) reportAuthStep("screen", { reason: "new" });
    for (let i = 0; i < 19; i++) reportAuthStep("callback", { ok: false, reason: "error" });
    expect(posted()).toHaveLength(20);
  });
});

describe("it can never get in the way of signing in", () => {
  it("returns at once and gives back nothing to wait for", () => {
    fetchMock.mockReturnValue(new Promise(() => undefined)); // a server that never answers
    expect(reportAuthStep("start", { ok: true })).toBeUndefined();
  });

  it.each([
    [
      "fetch throws on the spot",
      () =>
        fetchMock.mockImplementation(() => {
          throw new Error("no fetch");
        }),
    ],
    ["the request is refused", () => fetchMock.mockRejectedValue(new TypeError("Failed to fetch"))],
    [
      "the request is aborted",
      () => fetchMock.mockRejectedValue(Object.assign(new Error("x"), { name: "AbortError" })),
    ],
  ])("does not throw or reject when %s", async (_name, arrange) => {
    arrange();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    expect(() => reportAuthStep("start", { ok: true })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("does not throw when the random source, the storage or the system lookup is broken", () => {
    const random = vi.spyOn(crypto, "getRandomValues").mockImplementation(() => {
      throw new Error("no entropy");
    });
    expect(() => reportAuthStep("screen", { reason: "new" })).not.toThrow();
    random.mockRestore();
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => reportAuthStep("start", { ok: true })).not.toThrow();
  });

  it("gives up on a request that never finishes after eight seconds", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return new Promise(() => undefined);
    });
    reportAuthStep("start", { ok: true });
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(7_900);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(signal?.aborted).toBe(true);
  });

  it("holds up under any input a caller could pass, and what it sends is always an object of known keys", () => {
    const allowed = new Set([
      "event",
      "source",
      "step",
      "install",
      "attempt",
      "ok",
      "reason",
      "ms",
      "app_version",
      "os",
      "arch",
    ]);
    fc.assert(
      fc.property(
        fc.constantFrom(...(Object.keys(AUTH_APP_STEPS) as AuthStep[])),
        fc.record(
          {
            ok: fc.anything(),
            reason: fc.anything(),
            attempt: fc.anything(),
            ms: fc.anything(),
            extra: fc.anything(),
          },
          { requiredKeys: [] },
        ),
        (step, detail) => {
          __resetAuthEvents();
          fetchMock.mockClear();
          expect(() => reportAuthStep(step, detail as never)).not.toThrow();
          for (const { body } of posted()) {
            for (const key of Object.keys(body)) if (!allowed.has(key)) return false;
            if (!(Object.keys(AUTH_APP_STEPS) as string[]).includes(String(body.step)))
              return false;
            if (
              "reason" in body &&
              !(AUTH_APP_STEPS[step] as readonly string[]).includes(String(body.reason))
            )
              return false;
            if ("attempt" in body && !ID.test(String(body.attempt))) return false;
            if ("ok" in body && typeof body.ok !== "boolean") return false;
            if (
              "ms" in body &&
              !(typeof body.ms === "number" && body.ms >= 0 && body.ms <= MAX_AUTH_MS)
            )
              return false;
          }
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });
});
