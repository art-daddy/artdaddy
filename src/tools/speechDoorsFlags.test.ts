// The places that start speech work for a request ask the server's switches beside it and never wait for the answer:
// captions, a look, get_transcript. (The background transcriber is store/indexCoordinatorFlags.test.ts.) These drive the
// real entry points with a fake transcriber and a fake server, and check what each answered and what the app holds
// afterwards. The last test walks every source file, so a new place that starts speech work cannot forget to ask.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  reportAppError,
  reportTranscription,
  transcribeSpan,
  ensureTranscript,
  runWhisper,
  peekTranscript,
} = vi.hoisted(() => ({
  reportAppError: vi.fn(),
  reportTranscription: vi.fn(),
  transcribeSpan: vi.fn(async (..._a: unknown[]) => ({ parsed: {}, existed: false })),
  ensureTranscript: vi.fn(async (..._a: unknown[]) => ({ parsed: {}, existed: false })),
  runWhisper: vi.fn(async (..._a: unknown[]) => ({})),
  peekTranscript: vi.fn(async (..._a: unknown[]) => null),
}));
vi.mock("../api/appEvents", async (orig) => ({
  ...(await orig<object>()),
  reportAppError,
  reportTranscription,
}));
vi.mock("@tauri-apps/api/path", () => ({ resolveResource: async () => "C:/res/fonts" }));
vi.mock("./transcribe", async (orig) => ({
  ...(await orig<typeof import("./transcribe")>()),
  transcribeSpan,
  ensureTranscript,
  runWhisper,
  peekTranscript,
}));

import type { ClientToolContext } from "./context";
import { setClerkTokenProvider } from "../api/auth";
import {
  EXPORT_FLAG_NAMES,
  __resetExportFlags,
  exportFlag,
  type ExportFlagName,
} from "../api/exportFlags";
import { captionWords } from "./captionTranscript";
import { buildTranscript } from "./inspect";
import { getTranscriptTool } from "./transcribe";

const SPOKEN = { language: "en", duration_seconds: 4, segments: [], words: [] };

const reply = (off: readonly ExportFlagName[]): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => ({
      v: 1,
      flags: Object.fromEntries(EXPORT_FLAG_NAMES.map((name) => [name, !off.includes(name)])),
    }),
  }) as unknown as Response;

/** A server that has not answered until the test says so, through the app's own session and `authedFetch`. */
function flagsServer() {
  const open: Array<(r: Response) => void> = [];
  const request = vi.fn((url: RequestInfo | URL) => {
    if (!String(url).endsWith("/client/export-flags"))
      return Promise.reject(new TypeError(`unexpected request to ${String(url)}`));
    return new Promise<Response>((resolve) => open.push(resolve));
  });
  vi.stubGlobal("fetch", request);
  return {
    asked: () => request.mock.calls.length,
    answer: (off: readonly ExportFlagName[] = []) => open.shift()?.(reply(off)),
  };
}

const ctx = (store: object = {}): ClientToolContext =>
  ({
    store: { projectDir: "C:/p-flags", resolveRef: async (ref: string) => ref, ...store },
  }) as unknown as ClientToolContext;

beforeEach(() => {
  __resetExportFlags();
  setClerkTokenProvider(async () => "a-session-token");
  transcribeSpan.mockReset();
  transcribeSpan.mockResolvedValue({ parsed: SPOKEN, existed: false });
  ensureTranscript.mockReset();
  ensureTranscript.mockResolvedValue({ parsed: SPOKEN, existed: false });
  runWhisper.mockReset();
  runWhisper.mockResolvedValue(SPOKEN);
  peekTranscript.mockReset();
  peekTranscript.mockResolvedValue(null);
});
afterEach(() => {
  setClerkTokenProvider(null);
  __resetExportFlags();
});

describe("a request that needs words", () => {
  it("captions: asks the server's switches beside the transcript, and the words come while the question is open", async () => {
    const server = flagsServer();
    const got = await captionWords(ctx(), "clip-a", "en", Date.now() + 5_000, { start: 0, end: 4 });
    expect(got.kind).toBe("ready");
    expect(transcribeSpan).toHaveBeenCalledTimes(1);
    expect(server.asked()).toBe(1);
    expect(exportFlag("speech_cpu_cap")).toBe(true);
    server.answer(["speech_cpu_cap"]);
    await vi.waitFor(() => expect(exportFlag("speech_cpu_cap")).toBe(false));
  });

  it("a look: asks beside the transcript, and the look answers while the question is open", async () => {
    const server = flagsServer();
    const got = await buildTranscript(ctx(), "C:/media/talk.mp4", {
      start: null,
      end: null,
      duration: null,
      wordTimestamps: false,
      language: "en",
      waitMs: 5_000,
    });
    expect(got).toHaveProperty("segments");
    expect(got.error).toBeUndefined();
    expect(runWhisper).toHaveBeenCalledTimes(1);
    expect(server.asked()).toBe(1);
    server.answer(["speech_word_times"]);
    await vi.waitFor(() => expect(exportFlag("speech_word_times")).toBe(false));
  });

  it("get_transcript: asks beside the work, and answers without waiting for the question", async () => {
    const server = flagsServer();
    const got = await getTranscriptTool(
      {},
      ctx({
        readText: async () => {
          throw new Error("no timeline yet");
        },
      }),
    );
    expect(got).toMatchObject({ ok: false, error: "no timeline to transcribe" });
    expect(server.asked()).toBe(1);
    server.answer(["speech_wake"]);
    await vi.waitFor(() => expect(exportFlag("speech_wake")).toBe(false));
  });

  it("is asked for once for all of them, not once each: the wait is the same one", async () => {
    const server = flagsServer();
    await captionWords(ctx(), "clip-a", "en", Date.now() + 5_000, { start: 0, end: 4 });
    await buildTranscript(ctx(), "C:/media/talk.mp4", {
      start: null,
      end: null,
      duration: null,
      wordTimestamps: false,
      language: "en",
      waitMs: 5_000,
    });
    expect(server.asked()).toBe(1); // the first is still open: nobody asks a second time
    server.answer(["speech_wake"]);
    await vi.waitFor(() => expect(exportFlag("speech_wake")).toBe(false));
    await captionWords(ctx(), "clip-b", "en", Date.now() + 5_000, { start: 0, end: 4 });
    expect(server.asked()).toBe(1); // and the answer is fresh: nobody asks again for ten minutes
  });
});

describe("every file that starts speech work", () => {
  /** Every non-test source file of the app. */
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory())
        return ["__fixtures__", "node_modules", "test", "eval"].includes(name) ? [] : sources(full);
      return /\.(ts|tsx)$/.test(name) && !/\.(test|e2e|smoke\.e2e|real\.e2e)\.tsx?$/.test(name)
        ? [full]
        : [];
    });
  /** The code of a file, without its comments. */
  const code = (file: string): string =>
    readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

  it("asks the server's switches, so that a new place that starts a transcription cannot forget to", () => {
    const root = path.join(__dirname, "..");
    const rel = (file: string): string => path.relative(root, file).replace(/\\/g, "/");
    const starters = sources(root).filter((file) =>
      /\b(?:runWhisper|transcribeSpan|ensureTranscripts?)\(/.test(code(file)),
    );
    // The walk found the places known today (it would pass for nothing if it looked in the wrong folder).
    expect(starters.map(rel)).toEqual(
      expect.arrayContaining([
        "store/indexCoordinator.ts",
        "tools/captionTranscript.ts",
        "tools/inspect.ts",
        "tools/transcribe.ts",
      ]),
    );
    for (const file of starters)
      expect(
        code(file),
        `${rel(file)} starts speech work and must call refreshExportFlags()`,
      ).toMatch(/\brefreshExportFlags\(\)/);
  });
});
