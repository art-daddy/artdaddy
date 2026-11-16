import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setModelDownloadFailure, useModelDownload } from "../store/modelDownload";
import type { ClientToolContext } from "./context";
import { declineModel } from "./modelDecline";
import {
  __resetPrefetch,
  isCancelledDownload,
  retrySpeechModelDownload,
  startSpeechModelPrefetch,
  type PrefetchEnv,
} from "./modelPrefetch";
import { modelCancelledMessage } from "./transcribe";

const CTX = { store: {}, runner: {} } as unknown as ClientToolContext;

function env(ensure: PrefetchEnv["ensure"], context: PrefetchEnv["context"] = async () => CTX) {
  const sleeps: number[] = [];
  const environment: PrefetchEnv = {
    context,
    ensure: vi.fn(ensure),
    sleep: async (ms) => void sleeps.push(ms),
  };
  return { environment, sleeps, ensure: environment.ensure as ReturnType<typeof vi.fn> };
}

beforeEach(() => __resetPrefetch());
afterEach(() => {
  vi.useRealTimers();
  setModelDownloadFailure(null);
  useModelDownload.getState().setNextAttemptAt(null);
});

describe("the speech model fetched at launch", () => {
  it("asks for the model once with the app's own context, and is done when it is there", async () => {
    const { environment, ensure } = env(async () => ({ path: "m", downloaded: true }));
    await startSpeechModelPrefetch(environment);
    expect(ensure).toHaveBeenCalledOnce();
    expect(ensure.mock.calls[0][0]).toBe(CTX);
  });

  it("does nothing where there is no desktop to download to", async () => {
    const { environment, ensure } = env(
      async () => ({}),
      async () => null,
    );
    await startSpeechModelPrefetch(environment);
    expect(ensure).not.toHaveBeenCalled();
  });

  it("is one download however many times the app asks while it runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { environment, ensure } = env(async () => gate);
    const a = startSpeechModelPrefetch(environment);
    const b = startSpeechModelPrefetch(environment);
    expect(a).toBe(b);
    release();
    await a;
    expect(ensure).toHaveBeenCalledOnce();
  });

  it("tries again after a minute and after five more when the machine was offline, and then leaves it to the first request that needs the model", async () => {
    const { environment, sleeps, ensure } = env(async () => {
      throw new Error("network error");
    });
    await expect(startSpeechModelPrefetch(environment)).resolves.toBeUndefined();
    expect(ensure).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([60_000, 300_000]);
  });

  it("stops trying the moment a round succeeds", async () => {
    let calls = 0;
    const { environment, sleeps, ensure } = env(async () => {
      if (++calls < 2) throw new Error("network error");
      return { path: "m", downloaded: true };
    });
    await startSpeechModelPrefetch(environment);
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([60_000]);
  });

  it("never rejects, whatever went wrong", async () => {
    const broken = env(
      async () => ({}),
      async () => {
        throw new Error("no data directory");
      },
    );
    await expect(startSpeechModelPrefetch(broken.environment)).resolves.toBeUndefined();
  });

  describe("when the person pressed Cancel", () => {
    it("is not tried again, in this session", async () => {
      const { environment, ensure, sleeps } = env(async () => {
        throw new Error(modelCancelledMessage(40, 100));
      });
      await startSpeechModelPrefetch(environment);
      await startSpeechModelPrefetch(environment);
      expect(ensure).toHaveBeenCalledOnce();
      expect(sleeps).toEqual([]);
    });

    it("stands when it was said while a round waited for the next: no round is made after it", async () => {
      const { environment, ensure } = env(async () => {
        throw new Error("network error");
      });
      // The Cancel is of a download a look had begun in the meantime: it lands while this session sleeps.
      environment.sleep = async () => declineModel();
      await startSpeechModelPrefetch(environment);
      expect(ensure).toHaveBeenCalledOnce();
    });

    it("is recognised by the words the download itself uses for it", () => {
      expect(isCancelledDownload(new Error(modelCancelledMessage(1, 3)))).toBe(true);
      expect(isCancelledDownload(new Error("whisper model download failed: HTTP 503"))).toBe(false);
      expect(isCancelledDownload("speech model download cancelled")).toBe(false);
    });
  });
});

describe("the person pressing Retry on the failure card", () => {
  const offline = async (): Promise<never> => {
    throw new Error("network error");
  };

  it("ends the wait between two rounds at once and starts the next round", async () => {
    const e = env(offline);
    let wakeUp!: () => void;
    // The wait is a minute the test never lets pass: only Retry can end it.
    e.environment.sleep = (ms) => new Promise<void>((resolve) => ((wakeUp = resolve), void ms));
    const running = startSpeechModelPrefetch(e.environment);
    await vi.waitFor(() => expect(e.ensure).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(useModelDownload.getState().nextAttemptAt).not.toBeNull());

    const retried = retrySpeechModelDownload();
    await vi.waitFor(() => expect(e.ensure).toHaveBeenCalledTimes(2));
    expect(retried).toBe(running); // one session, not a second download beside it
    wakeUp(); // the wait that belongs to the round after this one
    await vi.waitFor(() => expect(e.ensure).toHaveBeenCalledTimes(3));
    await running;
  });

  it("says a round is waiting for its turn while it waits, and says nothing once it has started", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const e = env(offline);
    e.environment.sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const running = startSpeechModelPrefetch(e.environment);
    await vi.advanceTimersByTimeAsync(0);
    expect(useModelDownload.getState().nextAttemptAt).toBe(1_000_000 + 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(useModelDownload.getState().nextAttemptAt).toBe(1_060_000 + 300_000);
    await vi.advanceTimersByTimeAsync(300_000);
    await running;
    expect(useModelDownload.getState().nextAttemptAt).toBeNull();
  });

  it("makes exactly one round when nothing is running, and waits for nothing after it", async () => {
    const e = env(offline);
    await startSpeechModelPrefetch(e.environment);
    expect(e.ensure).toHaveBeenCalledTimes(3);
    expect(e.sleeps).toEqual([60_000, 300_000]);

    await retrySpeechModelDownload();
    expect(e.ensure).toHaveBeenCalledTimes(4);
    expect(e.sleeps).toEqual([60_000, 300_000]);
    expect(useModelDownload.getState().nextAttemptAt).toBeNull();
  });

  it("takes the card away at once, and downloads again although the person cancelled before", async () => {
    let up = false;
    const e = env(async () => {
      if (!up) throw new Error(modelCancelledMessage(40, 100));
      return { path: "m", downloaded: true };
    });
    await startSpeechModelPrefetch(e.environment);
    await startSpeechModelPrefetch(e.environment);
    expect(e.ensure).toHaveBeenCalledTimes(1); // cancelled: not asked again

    setModelDownloadFailure("network");
    up = true;
    const retried = retrySpeechModelDownload();
    expect(useModelDownload.getState().failure).toBeNull();
    await retried;
    expect(e.ensure).toHaveBeenCalledTimes(2);
    // The Cancel is over: the next ask for the model at launch goes ahead.
    await startSpeechModelPrefetch(e.environment);
    expect(e.ensure).toHaveBeenCalledTimes(3);
  });

  it("asks the way the last start asked, and never rejects", async () => {
    const e = env(async () => {
      throw new Error("no data directory");
    });
    await startSpeechModelPrefetch(e.environment);
    await expect(retrySpeechModelDownload()).resolves.toBeUndefined();
  });
});

// With two model files, the card says "Could not download the speech model" about ONE of them: Retry asks for that
// file, whatever the plan names now (which can be a file that is already here: nothing would be retried and the card
// would simply be gone).
describe("the file a Retry asks for", () => {
  const offline = async (): Promise<never> => {
    throw new Error("network error");
  };

  it("is the file the failure card was about, once; a plain start asks the plan's, with no second argument", async () => {
    const e = env(async () => ({ path: "m", downloaded: true }));
    await startSpeechModelPrefetch(e.environment);
    expect(e.ensure).toHaveBeenLastCalledWith(CTX);

    setModelDownloadFailure("network", "small");
    await retrySpeechModelDownload();
    expect(e.ensure).toHaveBeenLastCalledWith(CTX, "small");

    // The card is gone and the ask is spent: the next start is the plan's again.
    expect(useModelDownload.getState()).toMatchObject({ failure: null, failureKey: null });
    await startSpeechModelPrefetch(e.environment);
    expect(e.ensure).toHaveBeenLastCalledWith(CTX);
    expect(e.ensure).toHaveBeenCalledTimes(3);
  });

  it("is the plan's when the card has no file, as a failure said without one has", async () => {
    const e = env(async () => ({ path: "m", downloaded: true }));
    await startSpeechModelPrefetch(e.environment);
    setModelDownloadFailure("network");
    await retrySpeechModelDownload();
    expect(e.ensure).toHaveBeenCalledTimes(2);
    expect(e.ensure).toHaveBeenLastCalledWith(CTX);
  });

  it("reaches the round whose wait Retry ends, and the next round of a session that keeps failing", async () => {
    const e = env(offline);
    let wakeUp!: () => void;
    // The wait is a minute the test never lets pass: only Retry, then the test, end it.
    e.environment.sleep = (ms) => new Promise<void>((resolve) => ((wakeUp = resolve), void ms));
    const running = startSpeechModelPrefetch(e.environment);
    await vi.waitFor(() => expect(e.ensure).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(useModelDownload.getState().nextAttemptAt).not.toBeNull());
    expect(e.ensure).toHaveBeenLastCalledWith(CTX);

    // A request's download of the OTHER file failed while the round waited: that is what the card is about.
    setModelDownloadFailure("network", "small");
    const retried = retrySpeechModelDownload();
    await vi.waitFor(() => expect(e.ensure).toHaveBeenCalledTimes(2));
    expect(e.ensure).toHaveBeenLastCalledWith(CTX, "small");
    expect(retried).toBe(running);

    // That failed too and the card is about the same file again: the round the app makes by itself asks for it.
    await vi.waitFor(() => expect(useModelDownload.getState().nextAttemptAt).not.toBeNull());
    setModelDownloadFailure("network", "small");
    wakeUp();
    await vi.waitFor(() => expect(e.ensure).toHaveBeenCalledTimes(3));
    expect(e.ensure).toHaveBeenLastCalledWith(CTX, "small");
    await running;
  });
});
