import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClientToolContext } from "./context";
import {
  __resetPrefetch,
  isCancelledDownload,
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
afterEach(() => vi.useRealTimers());

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

    it("is recognised by the words the download itself uses for it", () => {
      expect(isCancelledDownload(new Error(modelCancelledMessage(1, 3)))).toBe(true);
      expect(isCancelledDownload(new Error("whisper model download failed: HTTP 503"))).toBe(false);
      expect(isCancelledDownload("speech model download cancelled")).toBe(false);
    });
  });
});
