// S5: what the person, and the app's own records, know when the speech model's download goes wrong.
//
// RED on 0.27.0 and on L2's tip (`139e05c7`), GREEN with lane L6's change. Each test is the person's side of one
// thing that happened to real people (3LkFJjC6Y... waited for captions on a 36 % download and was never told
// why it stopped; five accounts' downloads failed on a bad network and the pill just vanished): the pill
// disappears after the last failed round and nothing says it failed; no fact of a download is kept; a second
// place to fetch from cannot be used; a Cancel is forgotten at the next start; the file name is derived in two
// places; a write that fails is not reported at all.
import { createHash } from "node:crypto";

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetExportFlags, refreshExportFlags } from "../api/exportFlags";
import ImportProgress from "../components/ImportProgress";
import {
  clearModelDownload,
  setModelDownloadFailure,
  useModelDownload,
} from "../store/modelDownload";
import type { CommandRunner } from "./command";
import type { ClientToolContext } from "./context";
import { MODEL_FAILURE_KINDS, MODEL_FAILURE_WORDS, type ModelFailureKind } from "./modelFailure";
import { MODEL_MANIFEST, primaryUrl } from "./modelManifest";
import { __resetPrefetch, startSpeechModelPrefetch, type PrefetchEnv } from "./modelPrefetch";
import { joinPath, ProjectStoreAccess, type FsLike } from "./store";
import {
  __setDownloadPolicy,
  cancelModelDownload,
  ensureWhisperModel,
  modelCancelledMessage,
  PATIENT_DOWNLOAD,
  SINGLE_ATTEMPT,
  WHISPER_MODELS,
  whisperModelPath,
  type WhisperModelSpec,
} from "./transcribe";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const DIR = "C:/data/projects/p1";
const MODEL = "C:/data/models/ggml-small.bin";
const BYTES = Uint8Array.from({ length: 10 }, (_, i) => i + 1);
const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const SPEC: WhisperModelSpec = {
  revision: "test-revision",
  bytes: BYTES.length,
  sha256: sha256(BYTES),
};
const PRIMARY = "https://huggingface.co/ggerganov/whisper.cpp/resolve/test-revision/ggml-small.bin";
const FACTS_KEY = "artdaddy.local_facts.v1";

class MockFs implements FsLike {
  bytes = new Map<string, Uint8Array>();
  files = new Map<string, string>();
  /** Writing the model fails (a full disk) when set. */
  failAppend = false;
  async exists(p: string): Promise<boolean> {
    const n = joinPath(p);
    return this.files.has(n) || this.bytes.has(n);
  }
  async readTextFile(p: string): Promise<string> {
    const v = this.files.get(joinPath(p));
    if (v === undefined) throw new Error("ENOENT");
    return v;
  }
  async writeTextFile(p: string, c: string): Promise<void> {
    this.files.set(joinPath(p), c);
  }
  async readBytes(p: string): Promise<Uint8Array> {
    const v = this.bytes.get(joinPath(p));
    if (v === undefined) throw new Error("ENOENT");
    return v;
  }
  async writeBytes(p: string, data: Uint8Array): Promise<void> {
    this.bytes.set(joinPath(p), data.slice());
  }
  async appendBytes(p: string, data: Uint8Array): Promise<void> {
    if (this.failAppend) throw new Error("ENOSPC: no space left on device");
    const n = joinPath(p);
    const previous = this.bytes.get(n) ?? new Uint8Array();
    const next = new Uint8Array(previous.length + data.length);
    next.set(previous);
    next.set(data, previous.length);
    this.bytes.set(n, next);
  }
  async stat(p: string): Promise<{ isDirectory: boolean; size: number; mtimeMs?: number }> {
    const n = joinPath(p);
    const b = this.bytes.get(n);
    if (b) return { isDirectory: false, size: b.length, mtimeMs: 1 };
    const t = this.files.get(n);
    if (t !== undefined) return { isDirectory: false, size: t.length, mtimeMs: 1 };
    throw new Error("ENOENT");
  }
  async cacheDir(): Promise<string> {
    return "C:/cache/app";
  }
  async workDir(): Promise<string> {
    return "C:/work/app";
  }
  async probeMedia(p: string, headBytes: number) {
    const b = this.bytes.get(joinPath(p));
    if (!b) throw new Error("ENOENT");
    const digest = sha256(b);
    return {
      id12: digest.slice(0, 12),
      sha256: digest,
      size: b.length,
      head: b.slice(0, headBytes),
    };
  }
  async remove(p: string): Promise<void> {
    const n = joinPath(p);
    this.files.delete(n);
    this.bytes.delete(n);
  }
  async rename(from: string, to: string): Promise<void> {
    const src = joinPath(from);
    const b = this.bytes.get(src);
    if (!b) throw new Error("ENOENT");
    this.bytes.set(joinPath(to), b);
    this.bytes.delete(src);
  }
  async mkdir(): Promise<void> {}
}

function served(bytes: Uint8Array, status = 200): Response {
  let done = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-length": String(bytes.length) }),
    body: {
      getReader: () => ({
        read: async () => {
          if (done) return { done: true, value: undefined };
          done = true;
          return { done: false, value: bytes };
        },
        cancel: async () => undefined,
        releaseLock: () => undefined,
      }),
    },
  } as unknown as Response;
}

const NO_COMMANDS: CommandRunner = { run: async () => ({ code: 1, stdout: "", stderr: "" }) };
const ctxOf = (fs: MockFs): ClientToolContext => ({
  store: new ProjectStoreAccess(DIR, fs),
  runner: NO_COMMANDS,
});

const networkDown = (): Promise<Response> => Promise.reject(new TypeError("network error"));

/** A prefetch whose every round asks the real installer, with the fake network and disk it is given. */
function prefetchOver(fs: MockFs, fetchImpl: (url: string) => Promise<Response>): PrefetchEnv {
  return {
    context: async () => ctxOf(fs),
    ensure: (ctx) => ensureWhisperModel(ctx, "small", fetchImpl as Any, SPEC),
    sleep: async () => undefined,
  };
}

const modelFacts = (): Array<Record<string, unknown>> => {
  const stored = JSON.parse(localStorage.getItem(FACTS_KEY) ?? "{}") as {
    model_download?: Array<Record<string, unknown>>;
  };
  return stored.model_download ?? [];
};

beforeEach(() => {
  localStorage.clear();
  __resetPrefetch();
  __resetExportFlags();
  __setDownloadPolicy(SINGLE_ATTEMPT);
});
afterEach(() => {
  __setDownloadPolicy(PATIENT_DOWNLOAD);
  clearModelDownload();
  setModelDownloadFailure(null);
  __resetExportFlags();
  __resetPrefetch();
  localStorage.clear();
});

describe("when the speech model's download fails for good", () => {
  it("says so on screen, with the reason in plain words and a Retry, instead of just disappearing", async () => {
    const fs = new MockFs();
    const fetchImpl = vi.fn(networkDown);
    await startSpeechModelPrefetch(prefetchOver(fs, fetchImpl));
    expect(fetchImpl).toHaveBeenCalledTimes(3); // the launch round and the two that follow it

    render(<ImportProgress />);
    const card = screen.getByTestId("model-failure");
    expect(card.textContent).toContain(
      "The connection dropped or the download site could not be reached.",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByTestId("model-download")).toBeNull(); // never "downloading" and "failed" together
  });

  it("downloads again when the person presses Retry, and the card is gone once the model is there", async () => {
    const fs = new MockFs();
    let up = false;
    const fetchImpl = vi.fn((_url: string) =>
      up ? Promise.resolve(served(BYTES)) : networkDown(),
    );
    await startSpeechModelPrefetch(prefetchOver(fs, fetchImpl));
    render(<ImportProgress />);
    expect(screen.getByTestId("model-failure")).toBeTruthy();

    up = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await vi.waitFor(() => expect(fs.bytes.get(MODEL)).toEqual(BYTES));
    await vi.waitFor(() => expect(screen.queryByTestId("model-failure")).toBeNull());
  });
});

describe("what the app keeps about each download, on this PC, in closed words", () => {
  it("records the start and the finish of a download that worked", async () => {
    const fs = new MockFs();
    await ensureWhisperModel(ctxOf(fs), "small", (async () => served(BYTES)) as Any, SPEC);
    const facts = modelFacts();
    expect(facts.map((f) => f.event)).toEqual(["download_started", "download_finished"]);
    expect(facts[1]).toMatchObject({ source: "primary", attempts: 1, bytes: BYTES.length });
    expect(JSON.stringify(facts)).not.toContain("huggingface"); // a word, never a host or a path
  });

  it("records a download that failed, with the reason as a word", async () => {
    const fs = new MockFs();
    await expect(
      ensureWhisperModel(ctxOf(fs), "small", networkDown as Any, SPEC),
    ).rejects.toThrow();
    const facts = modelFacts();
    expect(facts.map((f) => f.event)).toEqual(["download_started", "download_failed"]);
    expect(facts[1]).toMatchObject({ reason: "network", source: "primary" });
  });

  it("records a write that failed as such: the disk, not the network", async () => {
    const fs = new MockFs();
    fs.failAppend = true;
    await expect(
      ensureWhisperModel(ctxOf(fs), "small", (async () => served(BYTES)) as Any, SPEC),
    ).rejects.toThrow();
    expect(modelFacts().at(-1)).toMatchObject({ event: "download_failed", reason: "disk_write" });
  });

  it("records a cancel as a cancel, not as a failure, and shows no failure card for it", async () => {
    const fs = new MockFs();
    const slow = (): Promise<Response> => new Promise<Response>(() => undefined);
    const asked = ensureWhisperModel(ctxOf(fs), "small", slow as Any, SPEC);
    const outcome = asked.then(
      () => "installed",
      (e: Error) => e.message,
    );
    await vi.waitFor(() => expect(modelFacts().map((f) => f.event)).toEqual(["download_started"]));
    cancelModelDownload();
    expect(await outcome).toMatch(/speech model download cancelled/);
    expect(modelFacts().map((f) => f.event)).toEqual(["download_started", "download_cancelled"]);
    expect(useModelDownload.getState().failure).toBeNull();
  });
});

// A reason is only worth showing if it is the one that happened. Every kind the card has words for must come
// from the failure it names, and a kind added to the list needs its scenario here (the record below is typed
// by the list, so a missing one does not compile).
describe("the reason a download failed is the one that happened", () => {
  type Scenario = (fs: MockFs) => (url: string, init?: RequestInit) => Promise<Response>;
  const withoutLength = (r: Response): Response =>
    Object.assign(r, { headers: new Headers() }) as Response;
  const SCENARIOS: Record<ModelFailureKind, Scenario> = {
    network: () => async () => {
      throw new TypeError("network error");
    },
    stalled: () => () => new Promise<Response>(() => undefined),
    server_busy: () => async () => served(new Uint8Array(), 503),
    server_refused: () => async () => served(new Uint8Array(), 404),
    size_mismatch: () => async () =>
      Object.assign(served(BYTES), {
        headers: new Headers({ "content-length": String(BYTES.length + 1) }),
      }) as Response,
    damaged: () => async () => served(BYTES.map((b) => (b + 1) & 255)),
    incomplete: () => async () => withoutLength(served(BYTES.slice(0, 4))),
    cannot_resume: (fs) => {
      fs.bytes.set(`${MODEL}.${SPEC.sha256.slice(0, 12)}.part`, BYTES.slice(0, 2));
      return async () => served(new Uint8Array(), 416);
    },
    disk_write: (fs) => {
      fs.failAppend = true;
      return async () => served(BYTES);
    },
    cannot_stream: () => async () =>
      ({ ok: true, status: 200, headers: new Headers(), body: null }) as unknown as Response,
    unknown: () => async () =>
      ({
        ok: true,
        status: 200,
        body: {},
        get headers(): never {
          throw new Error("a response that cannot be read");
        },
      }) as unknown as Response,
  };

  it("has a scenario for every kind the card has words for, and for no other", () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual([...MODEL_FAILURE_KINDS].sort());
  });

  it.each([...MODEL_FAILURE_KINDS])(
    "%s: the record, the card and the store all say so",
    async (kind) => {
      const fs = new MockFs();
      const fetchImpl = SCENARIOS[kind](fs);
      if (kind === "stalled") {
        vi.useFakeTimers();
        __setDownloadPolicy({ stallMs: 1_000, backoffMs: [] });
      }
      try {
        const asked = ensureWhisperModel(ctxOf(fs), "small", fetchImpl as Any, SPEC).then(
          () => "installed",
          () => "failed",
        );
        if (kind === "stalled") await vi.advanceTimersByTimeAsync(1_000);
        expect(await asked).toBe("failed");
      } finally {
        vi.useRealTimers();
      }
      expect(modelFacts().at(-1)).toMatchObject({ event: "download_failed", reason: kind });
      expect(useModelDownload.getState().failure).toBe(kind);
      render(<ImportProgress />);
      expect(screen.getByTestId("model-failure").textContent).toContain(MODEL_FAILURE_WORDS[kind]);
    },
  );
});

describe("a second place to fetch the model from, named by the remote answer", () => {
  const EXTRA = "https://huggingface.co/some-org/some-copy/resolve/main/ggml-small.bin";
  const answer = (sources: unknown): Promise<void> =>
    refreshExportFlags({
      force: true,
      signedIn: async () => true,
      fetcher: async () =>
        new Response(JSON.stringify({ v: 1, flags: {}, speech_model_sources: sources }), {
          status: 200,
        }),
    });

  beforeEach(() => {
    // Two attempts, no waiting: the first place fails, the second is tried.
    __setDownloadPolicy({ stallMs: Infinity, backoffMs: [0] });
  });

  it("is used when the first place fails, and what it sends is checked like everything else", async () => {
    await answer([EXTRA]);
    const fs = new MockFs();
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return url === EXTRA ? served(BYTES) : networkDown();
    });
    const r = await ensureWhisperModel(ctxOf(fs), "small", fetchImpl as Any, SPEC);
    expect(urls).toEqual([PRIMARY, EXTRA]);
    expect(r).toEqual({ path: MODEL, downloaded: true });
    expect(fs.bytes.get(MODEL)).toEqual(BYTES);
  });

  it("is used by the next attempt when the answer only comes after the download has begun", async () => {
    const fs = new MockFs();
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      if (url === EXTRA) return served(BYTES);
      await answer([EXTRA]); // the launch prefetch starts before the first answer comes
      return networkDown();
    });
    const r = await ensureWhisperModel(ctxOf(fs), "small", fetchImpl as Any, SPEC);
    expect(urls).toEqual([PRIMARY, EXTRA]);
    expect(r.downloaded).toBe(true);
    expect(modelFacts().at(-1)).toMatchObject({
      event: "download_finished",
      source: "extra_1",
      attempts: 2,
    });
  });

  it("never installs bytes that are not the pinned ones, whoever sends them", async () => {
    await answer([EXTRA]);
    const fs = new MockFs();
    const wrong = BYTES.map((b) => (b + 1) & 255);
    const fetchImpl = vi.fn(async (url: string) => (url === EXTRA ? served(wrong) : networkDown()));
    await expect(ensureWhisperModel(ctxOf(fs), "small", fetchImpl as Any, SPEC)).rejects.toThrow();
    expect(fs.bytes.get(MODEL)).toBeUndefined();
  });

  it("is never used for a host that is not on the compiled list (a control: this passes before and after)", async () => {
    await answer(["https://evil.example.com/ggml-small.bin", EXTRA]);
    const fs = new MockFs();
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return networkDown();
    });
    await expect(ensureWhisperModel(ctxOf(fs), "small", fetchImpl as Any, SPEC)).rejects.toThrow();
    expect(urls.every((u) => u === PRIMARY)).toBe(true);
  });
});

describe("a Cancel the person pressed", () => {
  it("is still honoured at the next start of the app: it is not downloaded again behind his back", async () => {
    const ensure = vi.fn(async () => {
      throw new Error(modelCancelledMessage(40, 100));
    });
    const env: PrefetchEnv = {
      context: async () => ctxOf(new MockFs()),
      ensure,
      sleep: async () => undefined,
    };
    await startSpeechModelPrefetch(env);
    expect(ensure).toHaveBeenCalledTimes(1);

    // The next start of the app: this page's memory is gone, the PC's storage is not.
    vi.resetModules();
    const next = await import("./modelPrefetch");
    await next.startSpeechModelPrefetch(env);
    expect(ensure).toHaveBeenCalledTimes(1);
  });
});

describe("the model's file name", () => {
  it("is what the manifest says for every model the app ships: the table of models and the path read it", () => {
    for (const [key, entry] of Object.entries(MODEL_MANIFEST)) {
      expect(WHISPER_MODELS[key], key).toMatchObject({
        file: entry.file,
        bytes: entry.bytes,
        sha256: entry.sha256,
        revision: entry.revision,
      });
      expect(whisperModelPath(DIR, key), key).toBe(`C:/data/models/${entry.file}`);
    }
  });

  it("is asked for at the manifest's pinned address when the app downloads the model it ships", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return networkDown();
    });
    await expect(
      ensureWhisperModel(ctxOf(new MockFs()), "small", fetchImpl as Any),
    ).rejects.toThrow();
    expect(urls).toEqual([primaryUrl(MODEL_MANIFEST.small)]);
  });

  it("comes from its manifest entry, not from the key it is looked up by", async () => {
    const fs = new MockFs();
    const urls: string[] = [];
    const spec = { ...SPEC, file: "ggml-small-q8_0.bin" } as Any as WhisperModelSpec;
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return served(BYTES);
    });
    await ensureWhisperModel(ctxOf(fs), "small", fetchImpl as Any, spec);
    expect(urls[0]).toBe(
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/test-revision/ggml-small-q8_0.bin",
    );
    expect(fs.bytes.has("C:/data/models/ggml-small-q8_0.bin")).toBe(true);
  });
});
