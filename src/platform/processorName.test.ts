// The processor's model name: read through its own native command, for the one hint that needs it, and kept on this PC.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const shell = vi.hoisted(() => ({ name: "tauri" }));
vi.mock("./index", () => ({ platform: shell }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { PROCESSOR_NAME_RETRY_MS, __resetProcessorName, processorName } from "./host";

beforeEach(() => {
  invoke.mockReset();
  shell.name = "tauri";
  __resetProcessorName();
});

describe("the processor's name", () => {
  it("is what the native command says, asked once per run of the app", async () => {
    invoke.mockResolvedValue("Intel(R) Core(TM) i7-6700 CPU @ 3.40GHz");
    expect(await processorName()).toBe("Intel(R) Core(TM) i7-6700 CPU @ 3.40GHz");
    expect(await processorName()).toBe("Intel(R) Core(TM) i7-6700 CPU @ 3.40GHz");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("processor_name");
  });

  it("is tidied: control characters and runs of space are one space, the ends are trimmed", async () => {
    invoke.mockResolvedValue("  Intel(R)\u0000 Core(TM)\t\ti7-6700\r\n CPU  ");
    expect(await processorName()).toBe("Intel(R) Core(TM) i7-6700 CPU");
  });

  it.each([[""], ["   "], [null], [undefined], [42], [{}], [["Intel"]], ["x".repeat(129)]])(
    "is no name for an answer that is not one: %j",
    async (answer) => {
      invoke.mockResolvedValue(answer);
      expect(await processorName()).toBeNull();
    },
  );

  it("is no name, and not an error, when the command fails or is not there", async () => {
    invoke.mockRejectedValue(new Error("command processor_name not found"));
    expect(await processorName()).toBeNull();
    invoke.mockImplementation(() => {
      throw new Error("not a promise");
    });
    __resetProcessorName();
    expect(await processorName()).toBeNull();
  });

  it("is no name, and does not ask, off the app (the web build)", async () => {
    shell.name = "web";
    expect(await processorName()).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not wait for a command that never answers: no name after about two seconds", async () => {
    invoke.mockReturnValue(new Promise(() => undefined));
    const started = Date.now();
    expect(await processorName()).toBeNull();
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(1_900);
    expect(waited).toBeLessThan(10_000);
  });

  it("is asked for again after a first answer that came too late or failed, once the short cool-down has passed: a busy app at start-up does not lose the hint for the whole run", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    try {
      invoke.mockReturnValueOnce(new Promise(() => undefined));
      const first = processorName();
      await vi.advanceTimersByTimeAsync(2_100);
      expect(await first).toBeNull();
      // inside the cool-down no name stands and the command is not asked at every look
      invoke.mockResolvedValue("Intel(R) Core(TM) i7-6700 CPU @ 3.40GHz");
      expect(await processorName()).toBeNull();
      expect(invoke).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(PROCESSOR_NAME_RETRY_MS);
      expect(await processorName()).toBe("Intel(R) Core(TM) i7-6700 CPU @ 3.40GHz");
      expect(invoke).toHaveBeenCalledTimes(2);
      // a name that was read is kept for the run
      await vi.advanceTimersByTimeAsync(10 * PROCESSOR_NAME_RETRY_MS);
      expect(await processorName()).toBe("Intel(R) Core(TM) i7-6700 CPU @ 3.40GHz");
      expect(invoke).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Where the name may go: it is read by the chip row's hint and by nothing that is sent. A file that mentions the command or its wrapper
// is listed here, so a report, an event, a log or a request that starts to read it fails this test.
describe("where the processor's name is read", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) return files(full);
      return /\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
    });

  it("is mentioned only by the wrapper and by the chip row that shows the hint", () => {
    const root = path.join(process.cwd(), "src");
    const mentions = files(root)
      .filter((file) => /processor_name|processorName/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(root, file).split(path.sep).join("/"))
      .sort();
    expect(mentions).toEqual(["components/ChipRow.tsx", "platform/host.ts"]);
  });
});
