// The export beacon's contract with the server, asserted on what actually goes over the wire: the
// report travels WITH the signed-in session (the server files it under that account), carries no
// identity of its own, and keeps its text and numbers inside the server's bounds -- a server that
// refuses an over-long or out-of-range value drops the whole row (UJ-006).
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import { onAuthFailure, setClerkTokenProvider, setSessionRenewer } from "./auth";
import { apiBase } from "./config";
import {
  EXPORT_OPERATIONS,
  EXPORT_REASON_CODES,
  EXPORT_SIZE_BANDS,
  MAX_EXPORT_ERROR,
  reportExport,
  type ExportEvent,
} from "./exportEvents";

afterEach(() => {
  setClerkTokenProvider(null);
  setSessionRenewer(null);
  vi.unstubAllGlobals();
});

/** Stub the network and sign in as `token` (null = signed out). Returns the recorded requests. */
function network(
  token: string | null = "tok_alice",
  reply: () => Response = () => new Response("{}"),
) {
  setClerkTokenProvider(token === null ? null : async () => token);
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => reply());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function sent(event: ExportEvent): Promise<Record<string, unknown>> {
  const fetchMock = network();
  await reportExport(event);
  return JSON.parse(String(fetchMock.mock.calls[0][1].body)) as Record<string, unknown>;
}

async function sentBody(error: string): Promise<Record<string, unknown>> {
  return sent({ status: "failed", error });
}

/** Every key the server's ExportEventBody takes from this beacon, and nothing else. */
const REPORT_KEYS = [
  "active_ms",
  "app_version",
  "arch",
  "duration_s",
  "elapsed_ms",
  "error",
  "fps",
  "height",
  "operation",
  "platform",
  "project_id",
  "project_size_band",
  "quality",
  "readiness",
  "reason_code",
  "recovered",
  "shell",
  "size_bytes",
  "status",
  "warnings",
  "width",
];

/** The server's numeric bounds (ExportEventBody). Outside them the whole report is refused. */
const SERVER_BOUNDS: Record<string, number> = {
  duration_s: 86_400,
  size_bytes: 1e13,
  elapsed_ms: 10_000_000_000,
  active_ms: 10_000_000_000,
  width: 16_384,
  height: 16_384,
  fps: 1_000,
  warnings: 10_000,
};

describe("the export beacon", () => {
  it("files the report under the signed-in session, and says nothing about who that is", async () => {
    const fetchMock = network("tok_alice");
    await reportExport({
      status: "done",
      ...({ user_id: "someone_else", email: "victim@example.com" } as object),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${apiBase()}/telemetry/export`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok_alice");
    const body = JSON.parse(String(init.body));
    expect(body).not.toHaveProperty("user_id");
    expect(body).not.toHaveProperty("email");
  });

  it("sends nothing when nobody is signed in, rather than a guaranteed refusal", async () => {
    const fetchMock = network(null);
    await expect(reportExport({ status: "done" })).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is never the thing that puts up the sign-in prompt", async () => {
    const prompted = vi.fn();
    const off = onAuthFailure(prompted);
    try {
      network("tok_expired", () => new Response("{}", { status: 401 }));
      await expect(reportExport({ status: "failed", error: "x" })).resolves.toBeUndefined();
      expect(prompted).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it("reports the whole per-account record the exporter has always sent, plus the V2 vocabulary", async () => {
    const body = await sent({
      status: "done",
      operation: "render",
      readiness: "ready",
      duration_s: 49.5,
      size_bytes: 14_075_403,
      elapsed_ms: 62_000,
      width: 1920,
      height: 1080,
      fps: 30,
      quality: "high",
      warnings: 2,
      error: "",
      project_id: "odyssey_ii",
    });
    expect(body).toMatchObject({
      status: "done",
      reason_code: "none",
      operation: "render",
      readiness: "ready",
      project_size_band: "hd",
      duration_s: 49.5,
      size_bytes: 14_075_403,
      elapsed_ms: 62_000,
      width: 1920,
      height: 1080,
      fps: 30,
      quality: "high",
      warnings: 2,
      error: "",
      project_id: "odyssey_ii",
    });
    expect(Object.keys(body).sort()).toEqual(REPORT_KEYS);
  });

  it("says an export was finished by a later launch, and how long its last run took", async () => {
    const recovered = await sent({ status: "done", recovered: true, active_ms: 3_600_000 });
    expect(recovered).toMatchObject({ recovered: true, active_ms: 3_600_000 });
    // An ordinary export is not recovered, and an unknown run time reads as 0, never as a guess.
    expect(await sent({ status: "done" })).toMatchObject({ recovered: false, active_ms: 0 });
  });

  it.each([1, "true", "yes", {}, [], null, undefined, 0])(
    "treats %j as not recovered: only a real true flags an export",
    async (value) => {
      const body = await sent({ status: "done", ...({ recovered: value } as object) });
      expect(body.recovered).toBe(false);
    },
  );

  it("keeps the failure text that explains a failure, next to its reason", async () => {
    const body = await sentBody("ffmpeg render failed (code=-22): Conversion failed!");
    expect(body).toMatchObject({
      status: "failed",
      reason_code: "render_failed",
      error: "ffmpeg render failed (code=-22): Conversion failed!",
    });
  });

  it("sends a long failure within the server's bound, keeping its cause and its verdict", async () => {
    const error = `ffmpeg render failed (code=-22): ${"[vost#0:0] stream noise ".repeat(40)}Conversion failed!`;
    const sentError = String((await sentBody(error)).error);
    expect(sentError.length).toBeLessThanOrEqual(MAX_EXPORT_ERROR);
    expect(sentError.startsWith("ffmpeg render failed (code=-22)")).toBe(true);
    expect(sentError.endsWith("Conversion failed!")).toBe(true);
  });

  it("sends a short failure, and a success's empty error, untouched", async () => {
    expect((await sentBody("ffmpeg died")).error).toBe("ffmpeg died");
    expect((await sentBody("")).error).toBe("");
    const exact = "e".repeat(MAX_EXPORT_ERROR);
    expect((await sentBody(exact)).error).toBe(exact);
  });

  it("is bounded for every length, not just the one seen", async () => {
    for (const n of [MAX_EXPORT_ERROR + 1, 301, 999, 20_000]) {
      const sentError = String((await sentBody("A".repeat(n - 1) + "Z")).error);
      expect(sentError.length, `length ${n}`).toBeLessThanOrEqual(MAX_EXPORT_ERROR);
      expect(sentError.endsWith("Z"), `length ${n}`).toBe(true);
    }
  });
  it("classifies reasons without inventing readiness from failure prose", async () => {
    expect(await sentBody("No such file C:/private/source.mp4")).toMatchObject({
      reason_code: "source_unavailable",
      readiness: "unknown",
    });
    expect(await sentBody("No space left on device /private/output.mp4")).toMatchObject({
      reason_code: "storage_full",
      readiness: "unknown",
    });
    expect(await sentBody("media_abc is offline; relink its private file")).toMatchObject({
      reason_code: "source_unavailable",
      readiness: "unknown",
    });
  });

  it.each(["done", "failed"] as const)(
    "does not upgrade %s to ready without explicit checked facts",
    async (status) => {
      const fetchMock = network();
      await reportExport({ status });
      await reportExport({ status, readiness: "ready" });
      expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).readiness).toBe("unknown");
      expect(JSON.parse(String(fetchMock.mock.calls[1][1].body)).readiness).toBe("ready");
    },
  );

  it("sends only the fields the server knows, every legitimate category intact, every number inside its bound", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }),
        fc.constantFrom(...EXPORT_REASON_CODES),
        fc.constantFrom(...EXPORT_SIZE_BANDS),
        fc.constantFrom(...EXPORT_OPERATIONS),
        fc.oneof(
          fc.double(),
          fc.constantFrom(Number.NaN, Infinity, -Infinity, -1, 0, 1e30, Number.MAX_VALUE),
        ),
        async (text, reason, band, operation, weird) => {
          const fetchMock = network();
          await reportExport({
            status: "failed",
            elapsed_ms: weird,
            active_ms: weird,
            error: text,
            project_id: text,
            quality: text,
            duration_s: weird,
            size_bytes: weird,
            width: weird,
            height: weird,
            fps: weird,
            warnings: weird,
            reason_code: reason,
            project_size_band: band,
            operation,
            readiness: "ready",
            // Fields nothing should ever send, even when a caller's object carries them.
            ...{ filename: text, content: text, user_id: text, email: text },
          });
          const request = fetchMock.mock.calls[0][1];
          const body = JSON.parse(String(request.body));
          expect((request.headers as Record<string, string>).Authorization).toBe("Bearer tok_alice");
          expect(Object.keys(body).sort()).toEqual(REPORT_KEYS);
          expect(body).toMatchObject({
            reason_code: reason,
            project_size_band: band,
            operation,
            readiness: "ready",
          });
          for (const [key, max] of Object.entries(SERVER_BOUNDS)) {
            expect(Number.isFinite(body[key]), key).toBe(true);
            expect(body[key], key).toBeGreaterThanOrEqual(0);
            expect(body[key], key).toBeLessThanOrEqual(max);
          }
          expect(String(body.error).length).toBeLessThanOrEqual(MAX_EXPORT_ERROR);
          expect(String(body.project_id).length).toBeLessThanOrEqual(200);
          expect(String(body.quality).length).toBeLessThanOrEqual(20);
        },
      ),
      { numRuns: 40 },
    );
  });

  it("never turns telemetry failure into an export failure or sign-in flow", async () => {
    network();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(
      reportExport({ status: "done", width: 1080, height: 1920, elapsed_ms: 12 }),
    ).resolves.toBeUndefined();
  });

  it("survives a session provider that is itself failing", async () => {
    setClerkTokenProvider(async () => {
      throw new Error("clerk unavailable");
    });
    vi.stubGlobal("fetch", vi.fn());
    await expect(reportExport({ status: "done" })).resolves.toBeUndefined();
  });
});
