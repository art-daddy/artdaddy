// The background transcriber asks the server's switches beside its work and never waits for the answer
// (store/indexCoordinator.ts, drainTranscripts). These drive the real coordinator with a fake transcriber and a fake
// server, and check what the work did and what the app holds afterwards.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IndexCoordinator } from "./indexCoordinator";
import { setClerkTokenProvider } from "../api/auth";
import {
  EXPORT_FLAG_NAMES,
  __resetExportFlags,
  exportFlag,
  type ExportFlagName,
} from "../api/exportFlags";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// Hoisted so the vi.mock factories can reach them (the same fakes as indexCoordinator.test.ts).
const {
  processImportedMedia,
  clearSourceUrlCache,
  ensureTranscript,
  ensureTranscripts,
  runWhisper,
  adoptTranscriptions,
  measureLoudness,
  reportAppError,
  sourceHasAudio,
  sourceDurationSeconds,
} = vi.hoisted(() => ({
  processImportedMedia: vi.fn(async () => false),
  clearSourceUrlCache: vi.fn(),
  ensureTranscript: vi.fn(async (..._a: unknown[]) => ({
    path: "t.json",
    parsed: {},
    existed: false,
  })),
  ensureTranscripts: vi.fn(async (_ctx: unknown, refs: readonly string[], ..._rest: unknown[]) =>
    refs.map(() => ({ ok: true as const, existed: false })),
  ),
  runWhisper: vi.fn(async (..._a: unknown[]) => ({})),
  adoptTranscriptions: vi.fn(async () => 0),
  measureLoudness: vi.fn(async (..._a: unknown[]): Promise<object> => ({
    integrated_lufs: -23,
    true_peak_dbtp: -23,
    rms_dbfs: -26,
  })),
  reportAppError: vi.fn(),
  sourceHasAudio: vi.fn(async () => true),
  sourceDurationSeconds: vi.fn(async (..._a: unknown[]) => 0),
}));

class FakeEngineDown extends Error {
  readonly code = "speech_engine_unavailable";
}
const isSpeechEngineUnavailable = (e: unknown): boolean => e instanceof FakeEngineDown;

vi.mock("../preview/mediaProxy", () => ({ processImportedMedia }));
vi.mock("../preview/resolve", () => ({ clearSourceUrlCache }));
vi.mock("../tools/transcribe", () => ({
  ensureTranscript,
  ensureTranscripts,
  runWhisper,
  isSpeechEngineUnavailable,
  adoptTranscriptions,
}));
vi.mock("../tools/loudness", () => ({ measureLoudness }));
vi.mock("../timeline/placement", () => ({ sourceHasAudio, sourceDurationSeconds }));
vi.mock("../api/appEvents", () => ({ reportAppError }));

const runner = { run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) } as Any;
const makeRunner = async () => runner as Any;
const fakeStore = (): Any => ({
  projectDir: "C:/p",
  listClips: vi.fn(async () => []),
  resolveRef: vi.fn(async (r: string) => (/^[A-Za-z]:\//.test(r) ? r : `C:/p/${r}`)),
  offlineMedia: vi.fn(async () => null),
});

/** Waits in turns of the event loop, not by the clock: a test that freezes the date must still be able to fail. */
async function until(done: () => boolean, turns = 400): Promise<void> {
  for (let i = 0; i < turns && !done(); i++) await new Promise((r) => setTimeout(r, 5));
}

const reply = (off: readonly ExportFlagName[], status: number): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({
      v: 1,
      flags: Object.fromEntries(EXPORT_FLAG_NAMES.map((name) => [name, !off.includes(name)])),
    }),
  }) as unknown as Response;

/** A server that answers when the test says so, through the app's own session and `authedFetch`. */
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
    answer: (off: readonly ExportFlagName[] = [], status = 200) =>
      open.shift()?.(reply(off, status)),
  };
}

beforeEach(() => {
  __resetExportFlags();
  setClerkTokenProvider(async () => "a-session-token");
  processImportedMedia.mockReset();
  processImportedMedia.mockResolvedValue(false);
  ensureTranscript.mockReset();
  ensureTranscript.mockResolvedValue({ path: "t.json", parsed: {}, existed: false });
  ensureTranscripts.mockReset();
  ensureTranscripts.mockImplementation(async (_ctx, refs) =>
    refs.map(() => ({ ok: true as const, existed: false })),
  );
  adoptTranscriptions.mockReset();
  adoptTranscriptions.mockResolvedValue(0);
  measureLoudness.mockReset();
  measureLoudness.mockResolvedValue({ integrated_lufs: -23, true_peak_dbtp: -23, rms_dbfs: -26 });
  sourceHasAudio.mockReset();
  sourceHasAudio.mockResolvedValue(true);
  sourceDurationSeconds.mockReset();
  sourceDurationSeconds.mockResolvedValue(0);
});
afterEach(() => {
  setClerkTokenProvider(null);
  vi.useRealTimers();
  __resetExportFlags();
});

describe("the background transcriber and the server's switches", () => {
  it("asks beside a transcription, does not wait for the answer, and takes it for what comes next", async () => {
    const server = flagsServer();
    const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
    c.indexSource("library/a.mp3");
    await until(() => ensureTranscript.mock.calls.length > 0);
    expect(ensureTranscript).toHaveBeenCalledTimes(1); // the work went on with the question still open
    expect(server.asked()).toBe(1);
    expect(exportFlag("speech_cpu_cap")).toBe(true);
    server.answer(["speech_cpu_cap"]);
    await until(() => !exportFlag("speech_cpu_cap"));
    expect(exportFlag("speech_cpu_cap")).toBe(false);
    c.dispose();
  });

  it("costs the transcription nothing when the server is down, and changes nothing", async () => {
    const server = flagsServer();
    const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
    c.indexSource("library/a.mp3");
    await until(() => server.asked() > 0 && ensureTranscript.mock.calls.length > 0);
    expect(server.asked()).toBe(1);
    expect(ensureTranscript).toHaveBeenCalledTimes(1); // the work started with the question still open
    server.answer([], 503);
    c.indexSource("library/b.mp3");
    await until(() => ensureTranscript.mock.calls.length >= 2);
    expect(ensureTranscript).toHaveBeenCalledTimes(2);
    for (const name of EXPORT_FLAG_NAMES) expect(exportFlag(name), name).toBe(true);
    c.dispose();
  });

  it("keeps asking through a long session, never sooner than the wait: the file that comes ten minutes later is chosen by a fresh answer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const server = flagsServer();
    const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
    c.indexSource("library/a.mp3");
    await until(() => ensureTranscript.mock.calls.length >= 1);
    expect(server.asked()).toBe(1);
    server.answer(["lean_decoders"]);
    await until(() => !exportFlag("lean_decoders"));
    expect(exportFlag("lean_decoders")).toBe(false);

    // Another file a minute later is inside the wait: no question.
    vi.setSystemTime(Date.now() + 60_000);
    c.indexSource("library/b.mp3");
    await until(() => ensureTranscript.mock.calls.length >= 2);
    expect(server.asked()).toBe(1);

    // Ten minutes on, the next file asks again, and is not held up by it.
    vi.setSystemTime(Date.now() + 11 * 60_000);
    c.indexSource("library/c.mp3");
    await until(() => ensureTranscript.mock.calls.length >= 3);
    expect(ensureTranscript).toHaveBeenCalledTimes(3);
    expect(server.asked()).toBe(2);
    server.answer(["lean_decoders", "speech_cpu_cap"]);
    await until(() => !exportFlag("speech_cpu_cap"));
    expect(exportFlag("speech_cpu_cap")).toBe(false);
    c.dispose();
  });
});
