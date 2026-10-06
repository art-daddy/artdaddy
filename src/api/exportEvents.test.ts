// The export beacon's own contract with the server: a failure's text must arrive within the
// server's bound, or a server that still refuses long text drops the whole row (UJ-006).
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_EXPORT_ERROR, reportExport } from "./exportEvents";

vi.mock("./auth", () => ({ authHeaders: async () => ({ Authorization: "Bearer t" }) }));

afterEach(() => vi.unstubAllGlobals());

async function sentBody(error: string): Promise<Record<string, unknown>> {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("{}"));
  vi.stubGlobal("fetch", fetchMock);
  await reportExport({ status: "failed", error });
  return JSON.parse(String(fetchMock.mock.calls[0][1].body)) as Record<string, unknown>;
}

describe("the export beacon", () => {
  it("sends a long failure within the server's bound, keeping its cause and its verdict", async () => {
    const error = `ffmpeg render failed (code=-22): ${"[vost#0:0] stream noise ".repeat(40)}Conversion failed!`;
    const sent = String((await sentBody(error)).error);
    expect(sent.length).toBeLessThanOrEqual(MAX_EXPORT_ERROR);
    expect(sent.startsWith("ffmpeg render failed (code=-22)")).toBe(true);
    expect(sent.endsWith("Conversion failed!")).toBe(true);
  });

  it("sends a short failure, and a success's empty error, untouched", async () => {
    expect((await sentBody("ffmpeg died")).error).toBe("ffmpeg died");
    expect((await sentBody("")).error).toBe("");
    const exact = "e".repeat(MAX_EXPORT_ERROR);
    expect((await sentBody(exact)).error).toBe(exact);
  });

  it("is bounded for every length, not just the one seen", async () => {
    for (const n of [MAX_EXPORT_ERROR + 1, 301, 999, 20_000]) {
      const sent = String((await sentBody("A".repeat(n - 1) + "Z")).error);
      expect(sent.length, `length ${n}`).toBeLessThanOrEqual(MAX_EXPORT_ERROR);
      expect(sent.endsWith("Z"), `length ${n}`).toBe(true);
    }
  });
});
