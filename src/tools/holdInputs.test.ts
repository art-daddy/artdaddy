// What the approval bar may quote before the user says yes (UJ-047), and why the quote can be trusted.
//
// The server HOLDS credits when a generation is sent. The bar shows "Up to N credits" beforehand by asking the server to
// price the same call, which is only honest if the app asks about the SAME call. So the inputs that move the price
// (model, count, seconds, script length) are derived by the code the tools themselves use, and this file drives the REAL
// tools through the REAL registry (the paid call is a recorder) to prove the two never disagree.
//
// quotedArgs.json is the contract with the server: the server's tests read it from the sibling checkout and prove the
// price depends on exactly these arguments, and on a script only through its length.
import { beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import contract from "./__fixtures__/quotedArgs.json";
import { registerAudioTools } from "./audio";
import type { CommandRunner } from "./command";
import type { ClientToolContext } from "./context";
import { registerGenerationTools } from "./generation";
import { IMAGE_MODELS, MUSIC_MODELS, TTS_MODELS, VIDEO_MODELS } from "./genModels";
import { QUOTE_CONTRACT, QUOTE_TEXT_CAP, holdInputs } from "./holdInputs";
import { ClientToolRegistry } from "./registry";
import { ProjectStoreAccess, joinPath, type FsLike } from "./store";

vi.mock("../api/ai", () => ({
  callAiProxy: vi.fn(),
  toB64: () => "b64data",
  fromB64: () => new Uint8Array([1, 2, 3]),
}));
// Lets one test narrow a range the served contract declares (the registry clamps to it before a handler runs).
const narrowed = vi.hoisted(() => ({ imageCountMax: null as number | null }));
vi.mock("../contract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../contract")>();
  return {
    ...actual,
    paramSchema: (name: string) => {
      const schema = actual.paramSchema(name);
      if (narrowed.imageCountMax === null || name !== "generate_image" || !schema?.properties?.count) return schema;
      return {
        ...schema,
        properties: { ...schema.properties, count: { ...schema.properties.count, maximum: narrowed.imageCountMax } },
      };
    },
  };
});
vi.mock("./geminiEncode", () => ({ encodeImageForGemini: vi.fn() }));
vi.mock("./genJobs", () => ({ submitGeneration: vi.fn() }));
vi.mock("./import", () => ({ registerLibraryClip: vi.fn() }));
vi.mock("./transcribe", () => ({ runWhisper: vi.fn() }));

import { callAiProxy } from "../api/ai";
import { encodeImageForGemini } from "./geminiEncode";
import { submitGeneration } from "./genJobs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
type Args = Record<string, unknown>;

class MockFs implements FsLike {
  files = new Map<string, string>();
  bytes = new Map<string, Uint8Array>();
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
    const b = this.bytes.get(joinPath(p));
    if (b === undefined) throw new Error("ENOENT");
    return b;
  }
  async writeBytes(p: string, b: Uint8Array): Promise<void> {
    this.bytes.set(joinPath(p), b);
  }
  async mkdir(): Promise<void> {}
}

const DIR = "C:/proj";
const ENCODED = joinPath(DIR, "internals/cache/vision/enc.jpg");

function context(): ClientToolContext {
  const fs = new MockFs();
  fs.files.set(joinPath(DIR, "ref.png"), "");
  fs.bytes.set(ENCODED, new Uint8Array([1, 2, 3]));
  const runner: CommandRunner = { run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) };
  return { store: new ProjectStoreAccess(DIR, fs), runner };
}

const proxy = vi.mocked(callAiProxy);

beforeEach(() => {
  narrowed.imageCountMax = null;
  proxy.mockReset().mockResolvedValue({ result: { ok: false, error: "stop here" } } as Any);
  vi.mocked(encodeImageForGemini).mockReset().mockResolvedValue(ENCODED);
  // The real submit publishes placeholders and fires the paid call detached; only the call matters here.
  vi.mocked(submitGeneration)
    .mockReset()
    .mockImplementation((async (spec: Any) => {
      try {
        await spec.run({ orderId: "0123456789abcdef0123456789abcdef", orderAccepted: () => undefined });
      } catch {
        /* a job that settled as failed: the call it made is all this file looks at */
      }
      return { media_refs: Array.from({ length: spec.count }, (_, i) => `media_gen_${i}`), job_id: "job_1" };
    }) as Any);
});

/** The paid call the REAL tool made for these model arguments (through the real registry), or null if it made none. */
async function paidCall(tool: string, args: Args): Promise<{ name: string; args: Args } | null> {
  const ctx = context();
  const registry = new ClientToolRegistry();
  registerGenerationTools(registry, () => ctx);
  registerAudioTools(registry, () => ctx);
  proxy.mockClear();
  await registry.run(tool, args);
  const call = proxy.mock.calls.at(-1);
  return call ? { name: call[0] as string, args: (call[1] as Any).args } : null;
}

const codePoints = (value: unknown): number => Array.from(String(value)).length;

interface Row {
  label: string;
  tool: string;
  args: Args;
  /** Whether the real tool should get as far as the paid call. Asserted, so a harness that stops short cannot pass. */
  call: boolean;
}

function rows(): Row[] {
  const out: Row[] = [];
  const add = (label: string, tool: string, args: Args, call = true) => out.push({ label, tool, args, call });
  add("image: the default model, nothing else", "generate_image", { prompt: "a red car" });
  for (const m of IMAGE_MODELS) {
    for (const count of [undefined, null, 0, -3, 1, 2.9, "3", 4, 9, "many"]) {
      add(`image ${m.id} count=${JSON.stringify(count)}`, "generate_image", {
        prompt: "a red car",
        model: m.id,
        ...(count === undefined ? {} : { count }),
      });
    }
  }
  add("video: the default model, nothing else", "generate_video", { prompt: "a van" });
  for (const m of VIDEO_MODELS) {
    for (const duration of [undefined, null, 0, 4, 5.7, 6, 8, 12, 99, "5", "soon"]) {
      add(`video ${m.id} duration=${JSON.stringify(duration)}`, "generate_video", {
        prompt: "a van",
        model: m.id,
        ...(duration === undefined ? {} : { duration }),
      });
    }
    for (const duration of [4, 6, 8]) {
      add(
        `video ${m.id} in reference mode, duration=${duration}`,
        "generate_video",
        { prompt: "a van", model: m.id, duration, reference_images: ["ref.png"] },
        Boolean(m.supports_reference_images),
      );
    }
  }
  const scripts: [string, string][] = [
    ["short", "hello there"],
    ["padded", "   padded   "],
    ["astral", "😀 hello 𝒳".repeat(40)],
    ["a lone surrogate", `broken \ud800 text`],
    ["over the server cap", "x".repeat(6000)],
    ["over the quote cap", "y".repeat(QUOTE_TEXT_CAP + 1500)],
  ];
  const models: (string | undefined)[] = [undefined, ...TTS_MODELS.map((m) => m.id)];
  for (const model of models) {
    for (const [name, text] of scripts) {
      for (const style of [undefined, "calm", "calm::", "  "]) {
        add(`voiceover ${model ?? "default"} ${name} style=${JSON.stringify(style)}`, "generate_voiceover", {
          text,
          ...(model ? { model } : {}),
          ...(style === undefined ? {} : { style }),
        });
      }
    }
  }
  add("music: the default model", "generate_music", { prompt: "lofi beat" });
  for (const m of MUSIC_MODELS) add(`music ${m.id}`, "generate_music", { prompt: "lofi beat", model: m.id });
  return out;
}

describe("holdInputs states the contract the server is tested against", () => {
  it("is exactly quotedArgs.json, which the server's tests read", () => {
    expect(QUOTE_CONTRACT).toEqual(contract);
    expect(QUOTE_TEXT_CAP).toBe(contract.text_cap);
  });
});

describe("what the bar quotes is what the tool sends", () => {
  const all = rows();

  it("walks every model of every generation tool", () => {
    const labels = all.map((r) => r.label).join("\n");
    for (const m of [...IMAGE_MODELS, ...VIDEO_MODELS, ...TTS_MODELS, ...MUSIC_MODELS]) expect(labels).toContain(m.id);
    expect(all.length).toBeGreaterThan(200);
  });

  for (const row of all) {
    it(row.label, async () => {
      const sent = await paidCall(row.tool, row.args);
      expect(sent !== null, row.call ? "the real tool should have made its paid call" : "the real tool should have refused").toBe(row.call);
      const quoted = holdInputs(row.tool, row.args);
      if (!sent) return; // refused before any paid call: nothing is spent, so a price shown would be harmless
      expect(quoted, "the tool made a paid call, so the app has to be able to quote it").not.toBeNull();
      expect(quoted!.proxy).toBe(sent.name);
      const names = (contract.args as Record<string, string[]>)[sent.name];
      expect(Object.keys(quoted!.args).sort()).toEqual([...names].sort());
      const lengthOnly = (contract.length_only as Record<string, string[]>)[sent.name] ?? [];
      for (const name of names) {
        if (lengthOnly.includes(name)) {
          expect(codePoints(quoted!.args[name])).toBe(Math.min(codePoints(sent.args[name]), QUOTE_TEXT_CAP));
        } else {
          expect(quoted!.args[name], name).toEqual(sent.args[name]);
        }
      }
    });
  }
});

describe("the quote follows what the registry does to the arguments before a tool runs", () => {
  it("honours a range the served contract narrows, the way the tool does", async () => {
    narrowed.imageCountMax = 2;
    const args = { prompt: "p", model: "nano-banana", count: 4 };
    const sent = await paidCall("generate_image", args);
    expect(sent?.args.count, "the registry clamped count to the contract before the tool ran").toBe(2);
    expect(holdInputs("generate_image", args)?.args.count).toBe(2);
  });

  it("treats a blank or null the model filled in as not set, the way the tool does", async () => {
    for (const args of [
      { prompt: "p", model: "", duration: null },
      { prompt: "p", duration: "" },
    ]) {
      const sent = await paidCall("generate_video", args);
      expect(holdInputs("generate_video", args)?.args).toEqual({
        backend_id: sent?.args.backend_id,
        duration: sent?.args.duration,
      });
    }
  });
});

describe("a price is only ever shown for a call that can be priced", () => {
  const refused: [string, string, Args][] = [
    ["an unknown image model", "generate_image", { prompt: "p", model: "no-such-model" }],
    ["a video model given to the image tool", "generate_image", { prompt: "p", model: VIDEO_MODELS[0].id }],
    ["an unknown video model", "generate_video", { prompt: "p", model: "no-such-model" }],
    ["an image model given to the video tool", "generate_video", { prompt: "p", model: IMAGE_MODELS[0].id }],
    ["a voiceover with no text", "generate_voiceover", { text: "   " }],
    ["an unknown voice model", "generate_voiceover", { text: "hi", model: "no-such-model" }],
    ["a music model given to the voiceover tool", "generate_voiceover", { text: "hi", model: MUSIC_MODELS[0].id }],
    ["an unknown music model", "generate_music", { prompt: "p", model: "no-such-model" }],
    ["a voice model given to the music tool", "generate_music", { prompt: "p", model: TTS_MODELS[0].id }],
  ];
  for (const [label, tool, args] of refused) {
    it(`${label}: the tool refuses and nothing is quoted`, async () => {
      expect(await paidCall(tool, args), "the tool really did refuse").toBeNull();
      expect(holdInputs(tool, args)).toBeNull();
    });
  }

  it.each([
    "get_timeline",
    "add_clips",
    "video_ask",
    "image_ask",
    "vision_describe",
    "find_content",
    "extract_style",
    "download_video",
    "get_page_image",
    "library_op",
    "export",
    "",
    "constructor",
    "__proto__",
  ])("%s is not a generation: nothing is quoted", (tool) => {
    expect(holdInputs(tool, { prompt: "x", model: IMAGE_MODELS[0].id })).toBeNull();
  });
});

describe("the quote carries no content of the user's", () => {
  it("sends a script as a same-length placeholder, never the words", () => {
    const quoted = holdInputs("generate_voiceover", { text: "my secret launch plan is Tuesday" });
    expect(quoted?.proxy).toBe("voiceover");
    expect(String(quoted?.args.text)).toMatch(/^x+$/);
    expect(JSON.stringify(quoted)).not.toMatch(/secret|launch|Tuesday/);
  });

  it("never carries the prompt, a media reference or a name", () => {
    const secret = "the-private-prompt";
    for (const [tool, args] of [
      ["generate_image", { prompt: secret, name: secret, reference_images: [secret] }],
      ["generate_video", { prompt: secret, start_frame: secret, name: secret }],
      ["generate_music", { prompt: secret, lyrics: secret, mood: secret }],
      ["generate_voiceover", { text: "hello", style: secret, voice: "Charon" }],
    ] as [string, Args][]) {
      expect(JSON.stringify(holdInputs(tool, args)), tool).not.toContain(secret);
    }
  });
});

describe("holdInputs never throws, whatever the model sent", () => {
  const junk = fc.oneof(
    fc.constant(null),
    fc.constant(undefined),
    fc.string(),
    fc.double({ noNaN: false }),
    fc.integer(),
    fc.boolean(),
    fc.array(fc.oneof(fc.string(), fc.integer(), fc.constant(null)), { maxLength: 4 }),
    fc.dictionary(fc.string({ maxLength: 6 }), fc.oneof(fc.string(), fc.integer()), { maxKeys: 3 }),
  );
  const tools = fc.constantFrom("generate_image", "generate_video", "generate_voiceover", "generate_music", "other");

  it("returns null or exactly the contracted arguments", () => {
    fc.assert(
      fc.property(
        tools,
        fc.record({ model: junk, count: junk, duration: junk, text: junk, style: junk, reference_images: junk, prompt: junk }),
        (tool, args) => {
          const quoted = holdInputs(tool, args as Args);
          if (quoted === null) return true;
          const names = (contract.args as Record<string, string[]>)[quoted.proxy];
          return JSON.stringify(Object.keys(quoted.args).sort()) === JSON.stringify([...names].sort());
        },
      ),
      { numRuns: 400 },
    );
  });

  it.each([null, undefined, 7, "text", [], [1, 2]])("a non-object argument list (%j) quotes nothing", (args) => {
    expect(holdInputs("generate_image", args as Any)).toBeNull();
  });

  it("counts a script in characters the way the server does, for any text", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 0x10ffff }).filter((cp) => cp < 0xd800 || cp > 0xdfff), { minLength: 1, maxLength: 300 }),
        (points) => {
          const text = String.fromCodePoint(...points);
          if (!text.trim()) return true;
          const quoted = holdInputs("generate_voiceover", { text });
          return quoted !== null && codePoints(quoted.args.text) === Math.min(codePoints(text.trim()), QUOTE_TEXT_CAP);
        },
      ),
      { numRuns: 300 },
    );
  });
});
