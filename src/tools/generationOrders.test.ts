// Every generation tool sends its call as an ORDER, and says when the server took it. This is the guard for the whole class: a
// tool added to the list of tools that make something to collect has to appear here, or the day a fifth one forgets its order
// number the result of a closed app is silently lost again.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/ai", async (orig) => ({
  ...(await orig<typeof import("../api/ai")>()),
  callAiProxy: vi.fn(),
}));
vi.mock("./genJobs", () => ({ submitGeneration: vi.fn() }));
vi.mock("./geminiEncode", () => ({ encodeImageForGemini: vi.fn() }));

import { callAiProxy, toB64 } from "../api/ai";
import { registerAudioTools } from "./audio";
import type { ClientToolContext } from "./context";
import { submitGeneration } from "./genJobs";
import { registerGenerationTools } from "./generation";
import { isResultTool, RESULT_TOOLS } from "./generationResults";
import { ClientToolRegistry } from "./registry";
import { joinPath, ProjectStoreAccess, type DirEntry, type FsLike } from "./store";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

class Fs implements FsLike {
  files = new Map<string, string>();
  bytes = new Map<string, Uint8Array>();
  async exists(p: string): Promise<boolean> {
    return this.files.has(joinPath(p)) || this.bytes.has(joinPath(p));
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
    if (!v) throw new Error("ENOENT");
    return v;
  }
  async writeBytes(p: string, b: Uint8Array): Promise<void> {
    this.bytes.set(joinPath(p), b);
  }
  async readDir(): Promise<DirEntry[]> {
    return [];
  }
  async mkdir(): Promise<void> {}
  async remove(): Promise<void> {}
}

const ORDER = "0123456789abcdef0123456789abcdef";
const proxy = vi.mocked(callAiProxy);

/** The call each tool makes, with the arguments that get it as far as a paid call. */
const CALLS: { tool: string; proxy: string; args: Record<string, unknown>; answer: unknown }[] = [
  {
    tool: "generate_image",
    proxy: "generate_image",
    args: { prompt: "a van" },
    answer: {
      result: { ok: true },
      media: [{ b64: toB64(new Uint8Array([1, 2, 3])), ext: ".png" }],
    },
  },
  {
    tool: "generate_video",
    proxy: "generate_video",
    args: { prompt: "a van driving" },
    answer: {
      result: { ok: true },
      media: [{ b64: toB64(new Uint8Array([1, 2, 3])), ext: ".mp4" }],
    },
  },
  {
    tool: "generate_voiceover",
    proxy: "voiceover",
    args: { text: "hello there" },
    answer: { result: { ok: true, pcm_b64: toB64(new Uint8Array(4)) } },
  },
  {
    tool: "generate_music",
    proxy: "music",
    args: { prompt: "lofi" },
    answer: { result: { ok: true, audio_b64: toB64(new Uint8Array([1, 2, 3])), format: "wav" } },
  },
];

function context(): ClientToolContext {
  const fs = new Fs();
  const runner = { run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) };
  return { store: new ProjectStoreAccess("C:/proj", fs), runner } as ClientToolContext;
}

beforeEach(() => {
  proxy.mockReset();
  vi.mocked(submitGeneration)
    .mockReset()
    .mockImplementation((async (spec: Any) => {
      try {
        await spec.run({ orderId: ORDER, orderAccepted: accepted });
      } catch {
        /* what the job did with the answer is not what is asserted here */
      }
      return { media_refs: ["media_gen_0"], job_id: "job_1" };
    }) as Any);
});

const accepted = vi.fn();

describe("every tool that makes something to collect", () => {
  it("is exactly the set the app knows how to bring back after a restart", () => {
    expect(CALLS.map((c) => c.tool).sort()).toEqual([...RESULT_TOOLS].sort());
    for (const tool of RESULT_TOOLS) expect(isResultTool(tool)).toBe(true);
    expect(isResultTool("export")).toBe(false);
    expect(isResultTool("style_analyze")).toBe(false);
  });

  it.each(CALLS)(
    "$tool sends its order number and says when the server took the order",
    async ({ tool, proxy: name, args, answer }) => {
      proxy.mockResolvedValue(answer as Any);
      const ctx = context();
      const registry = new ClientToolRegistry();
      registerGenerationTools(registry, () => ctx);
      registerAudioTools(registry, () => ctx);
      await registry.run(tool, args);

      expect(proxy).toHaveBeenCalledTimes(1);
      const [calledName, body, signal, opts] = proxy.mock.calls[0] as Any[];
      expect(calledName).toBe(name);
      expect(body.order_id).toBe(ORDER);
      expect(signal).toBeUndefined(); // Stop must not cancel a call that is paid for
      expect(opts?.onOrder).toBe(accepted);
    },
  );
});
