// The export beacon's own contract with the server: a failure's text must arrive within the
// server's bound, or a server that still refuses long text drops the whole row (UJ-006).
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EXPORT_OPERATIONS,
  EXPORT_REASON_CODES,
  EXPORT_SIZE_BANDS,
  reportExport,
} from "./exportEvents";

vi.mock("./auth", () => ({
  authedFetch: (url: string, init: RequestInit = {}) => fetch(url, init),
}));

afterEach(() => vi.unstubAllGlobals());

async function sentBody(error: string): Promise<Record<string, unknown>> {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("{}"));
  vi.stubGlobal("fetch", fetchMock);
  await reportExport({ status: "failed", error });
  return JSON.parse(String(fetchMock.mock.calls[0][1].body)) as Record<string, unknown>;
}

describe("the export beacon", () => {
  it("reports a bounded reason without sending error text or project identity", async () => {
    const body = await sentBody("ffmpeg render failed for C:/Users/private/person.mov");
    expect(body).toMatchObject({
      status: "failed",
      reason_code: "render_failed",
      readiness: "unknown",
    });
    expect(body).not.toHaveProperty("error");
    expect(body).not.toHaveProperty("project_id");
    expect(JSON.stringify(body)).not.toContain("person.mov");
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
      const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("{}"));
      vi.stubGlobal("fetch", fetchMock);
      await reportExport({ status });
      await reportExport({ status, readiness: "ready" });
      expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).readiness).toBe("unknown");
      expect(JSON.parse(String(fetchMock.mock.calls[1][1].body)).readiness).toBe("ready");
    },
  );

  it("drops arbitrary private fields while preserving every legitimate reporting category", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }),
        fc.constantFrom(...EXPORT_REASON_CODES),
        fc.constantFrom(...EXPORT_SIZE_BANDS),
        fc.constantFrom(...EXPORT_OPERATIONS),
        async (privateText, reason, band, operation) => {
          const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("{}"));
          vi.stubGlobal("fetch", fetchMock);
          await reportExport({
            status: "failed",
            elapsed_ms: 1234,
            error: privateText,
            project_id: privateText,
            reason_code: reason,
            project_size_band: band,
            operation,
            readiness: "ready",
            ...{ filename: privateText, content: privateText, user_id: privateText },
          });
          const request = fetchMock.mock.calls[0][1];
          const body = JSON.parse(String(request.body));
          expect(body).toMatchObject({
            reason_code: reason,
            project_size_band: band,
            operation,
            elapsed_ms: 1234,
            readiness: "ready",
          });
          expect(Object.keys(body).sort()).toEqual([
            "app_version",
            "arch",
            "elapsed_ms",
            "operation",
            "platform",
            "project_size_band",
            "readiness",
            "reason_code",
            "shell",
            "status",
          ]);
          expect(request.credentials).toBe("omit");
          expect(request.headers).toEqual({ "Content-Type": "application/json" });
        },
      ),
      { numRuns: 40 },
    );
  });

  it("never turns telemetry failure into an export failure or sign-in flow", async () => {
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
});
