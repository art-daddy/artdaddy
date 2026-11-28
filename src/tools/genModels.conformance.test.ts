// The generation models the app runs (genModels.ts) against what the tool catalog tells the agent about them
// (src/contract/catalog.json: the tool schemas the server hands the in-app agent, and the MCP door an outside one). The
// agent can only name what the catalog offers, and the app only runs what genModels.ts holds, so a model, a default, a
// length or a count that one side has and the other lacks is a generation that fails, or does something else than what
// the person was told, after they approved its price. Every check reads both sides and drives the real tools through
// the registry, with only the paid call faked below them; none keeps a copy of either list.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/ai", () => ({
  callAiProxy: vi.fn(),
  toB64: () => "b64",
  fromB64: () => new Uint8Array([1]),
}));
vi.mock("./geminiEncode", () => ({ encodeImageForGemini: vi.fn() }));
vi.mock("./genJobs", () => ({ submitGeneration: vi.fn() }));

import { callAiProxy } from "../api/ai";
import catalog from "../contract/catalog.json";
import { registerAudioTools } from "./audio";
import type { ClientToolContext } from "./context";
import { registerGenerationTools } from "./generation";
import { submitGeneration } from "./genJobs";
import {
  AUDIO_BY_ID,
  GEN_BY_ID,
  IMAGE_MODELS,
  TTS_VOICES,
  VIDEO_MODELS,
  type GenModel,
} from "./genModels";
import { ClientToolRegistry } from "./registry";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

interface Prop {
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  description?: string;
}
interface Tool {
  name: string;
  description?: string;
  parameters?: { properties?: Record<string, Prop> };
}

const TOOLS = (catalog as unknown as { tools: Tool[] }).tools;
function tool(name: string): Tool {
  const found = TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`the catalog has no ${name}`);
  return found;
}
function param(name: string, key: string): Prop {
  const found = tool(name).parameters?.properties?.[key];
  if (!found) throw new Error(`${name} has no ${key} parameter in the catalog`);
  return found;
}
function offered(name: string, key: string): unknown[] {
  const values = param(name, key).enum;
  if (!values?.length) throw new Error(`${name}.${key} offers no closed list in the catalog`);
  return values;
}
/** The first capture of `re` in `text`, or a failure that names what the catalog no longer says. */
function said(text: string | undefined, re: RegExp, what: string): string {
  const m = re.exec(text ?? "");
  if (!m) throw new Error(`the catalog no longer says ${what} (${re})`);
  return m[1];
}
/** The values a sentence quotes: "'1K' | '2K' | '4K'" -> ["1K", "2K", "4K"]. */
const quoted = (text: string): string[] => [...text.matchAll(/'([^']+)'/g)].map((m) => m[1]);
/** The model ids a sentence names, by whole word: "nano-banana-pro / gpt-image-2" names neither "nano-banana" nor "gpt-image". */
const idsIn = (text: string): string[] => text.match(/[a-z0-9][a-z0-9.-]*[a-z0-9]/g) ?? [];

const proxy = vi.mocked(callAiProxy);
const submit = vi.mocked(submitGeneration);
const ctx = { store: {}, runner: { run: vi.fn() } } as unknown as ClientToolContext;

beforeEach(() => {
  // No vendor in a test: the "provider" refuses, which a submitted job swallows the way the real settle does.
  proxy
    .mockReset()
    .mockResolvedValue({ result: { ok: false, error: "no vendor in a test" } } as Any);
  submit.mockReset().mockImplementation(async (spec: Any) => {
    try {
      await spec.run({ orderId: "0".repeat(32), orderAccepted: () => undefined });
    } catch {
      /* the job's failure, not the tool's reply */
    }
    return {
      media_refs: Array.from({ length: spec.count as number }, (_, i) => `media_${i}`),
      job_id: "job",
    };
  });
});

async function run(name: string, args: Record<string, unknown>): Promise<Any> {
  const registry = new ClientToolRegistry();
  registerGenerationTools(registry, () => ctx);
  registerAudioTools(registry, () => ctx);
  return registry.run(name, args);
}
/** What the last call asked the server to make. */
const sent = (): Any => (proxy.mock.calls.at(-1)?.[1] as Any)?.args;

const PROMPT: Record<string, Record<string, unknown>> = {
  generate_image: { prompt: "a red kite" },
  generate_video: { prompt: "a red kite" },
  generate_voiceover: { text: "Hello there." },
  generate_music: { prompt: "a calm bed" },
};
/** The model a reply says the call used, as the id the catalog offers it under. */
function usedModel(name: string, reply: Any): string | undefined {
  if (name === "generate_image" || name === "generate_video") return reply.model;
  // The voice and music tools report the backend they called; map it back to the offered id.
  const category = name === "generate_voiceover" ? "tts" : "music";
  return Object.values(AUDIO_BY_ID).find(
    (m) => m.category === category && m.backend_id === reply.model,
  )?.id;
}

describe("the models the agent may name are the models the app runs", () => {
  it.each(Object.keys(PROMPT))(
    "%s runs every model its schema offers, as that model",
    async (name) => {
      const models = offered(name, "model");
      const refused: string[] = [];
      for (const id of models) {
        const reply = await run(name, { ...PROMPT[name], model: id });
        if (reply.ok !== true || usedModel(name, reply) !== id)
          refused.push(`${String(id)}: ${reply.error ?? `ran ${reply.model}`}`);
      }
      expect(refused).toEqual([]);
    },
  );

  // list_models is how the agent learns what to pick from; a model it lists that a schema does not offer is a choice
  // the agent is shown and cannot make, and one a schema offers that it does not list has no capabilities to pick by.
  it("list_models lists exactly the models the four schemas offer", async () => {
    const reply = await run("list_models", {});
    const listed = (kind: string, category?: string) =>
      (reply.models as Any[])
        .filter((m) => m.kind === kind && (category === undefined || m.category === category))
        .map((m) => m.id)
        .sort();
    expect(listed("image")).toEqual([...offered("generate_image", "model")].sort());
    expect(listed("video")).toEqual([...offered("generate_video", "model")].sort());
    expect(listed("audio", "tts")).toEqual([...offered("generate_voiceover", "model")].sort());
    expect(listed("audio", "music")).toEqual([...offered("generate_music", "model")].sort());
  });

  it("list_models offers a filter for each kind it lists, and nothing else", async () => {
    const reply = await run("list_models", {});
    const kinds = [...new Set((reply.models as Any[]).map((m) => m.kind))].sort();
    expect([...offered("list_models", "type")].sort()).toEqual(kinds);
  });
});

describe("the defaults the agent is told are the ones the app uses", () => {
  // The agent leaves a model out on the catalog's word that the default is the one it names; the person is quoted and
  // charged for whichever the app really runs.
  it.each([
    ["generate_image", "image"],
    ["generate_video", "video"],
  ] as const)("%s runs, with no model named, the default its catalog names", async (name, kind) => {
    const fromTool = said(
      tool(name).description,
      /`model` \(default '([^']+)'\)/,
      `${name}'s default`,
    );
    const fromParam = said(
      param(name, "model").description,
      /\(default ([^)\s]+)\)/,
      "the default",
    );
    const fromList = said(
      tool("list_models").description,
      new RegExp(`${kind}: ([a-z0-9.-]+)`),
      `list_models' ${kind} default`,
    );
    const reply = await run(name, PROMPT[name]);
    expect(reply.ok).toBe(true);
    expect([fromTool, fromParam, fromList]).toEqual([reply.model, reply.model, reply.model]);
    expect(GEN_BY_ID[reply.model].backend_id).toBe(sent().backend_id);
  });

  it.each([
    ["generate_voiceover", "tts"],
    ["generate_music", "music"],
  ] as const)(
    "%s runs, with no model named, the default list_models reports",
    async (name, key) => {
      const defaults = (await run("list_models", {})).defaults;
      const reply = await run(name, PROMPT[name]);
      expect(reply.ok).toBe(true);
      expect(usedModel(name, reply)).toBe(defaults[key]);
    },
  );
});

describe("what a video call may ask for is what every video model makes", () => {
  // A length the schema offers that a model does not make is refused by the server after the person approved it.
  it("every length the schema offers is one every video model makes, and is the length sent", async () => {
    const lengths = offered("generate_video", "duration") as number[];
    const wrong: string[] = [];
    for (const m of VIDEO_MODELS)
      for (const seconds of lengths) {
        if (!m.durations?.includes(seconds)) wrong.push(`${m.id} does not make ${seconds} s`);
        const reply = await run("generate_video", {
          ...PROMPT.generate_video,
          model: m.id,
          duration: seconds,
        });
        if (reply.ok !== true || sent()?.duration !== seconds)
          wrong.push(`${m.id} at ${seconds} s sent ${sent()?.duration}`);
      }
    expect(wrong).toEqual([]);
  });

  it("the length the catalog calls the default is the one sent when none is asked for", async () => {
    const named = Number(
      said(
        param("generate_video", "duration").description,
        /\(default (\d+)\)/,
        "the default length",
      ),
    );
    expect(
      Number(said(tool("generate_video").description, /seconds \(default (\d+)\)/, "it")),
    ).toBe(named);
    for (const m of VIDEO_MODELS) {
      await run("generate_video", { ...PROMPT.generate_video, model: m.id });
      expect(sent()?.duration, m.id).toBe(named);
      expect(m.durations, m.id).toContain(named);
    }
  });

  it("the resolutions the schema names are the ones the video models offer", () => {
    const named = said(param("generate_video", "resolution").description, /e\.g\. ([^)]+)\)/, "it");
    const union = [...new Set(VIDEO_MODELS.flatMap((m) => m.resolutions ?? []))].sort();
    expect(quoted(named).sort()).toEqual(union);
  });
});

describe("what an image call may ask for is what every image model makes", () => {
  // A count the schema allows that a model cannot make is cut down without a word: the person asked for four
  // pictures, approved four, and got fewer.
  it("every count the schema allows is the count every image model makes", async () => {
    const { minimum, maximum } = param("generate_image", "count");
    expect([minimum, maximum].every(Number.isInteger)).toBe(true);
    const wrong: string[] = [];
    for (const m of IMAGE_MODELS)
      for (let n = minimum!; n <= maximum!; n++) {
        const reply = await run("generate_image", {
          ...PROMPT.generate_image,
          model: m.id,
          count: n,
        });
        if (
          reply.ok !== true ||
          reply.count !== n ||
          reply.assets?.length !== n ||
          sent()?.count !== n
        )
          wrong.push(`${m.id} asked for ${n}: made ${reply.count}, sent ${sent()?.count}`);
      }
    expect(wrong).toEqual([]);
  });

  it("the qualities the schema names are the ones the models that list them offer", () => {
    const text = param("generate_image", "quality").description;
    const named = said(text, /\(e\.g\. ([^)]+)\)/, "the qualities");
    const union = [...new Set(IMAGE_MODELS.flatMap((m) => m.qualities ?? []))].sort();
    expect(quoted(named).sort()).toEqual(union);
    const provider = said(text, /list 'qualities' \(([a-z-]+)\)/, "which models list them");
    expect(
      IMAGE_MODELS.filter((m) => m.qualities?.length).every((m) => m.provider === provider),
    ).toBe(true);
  });

  const RESOLUTIONS = /Output resolution ((?:'[^']+'(?: \| )?)+)/;

  it("the resolutions the schema names are the ones the image models offer", () => {
    const named = quoted(
      said(param("generate_image", "resolution").description, RESOLUTIONS, "it"),
    );
    const union = [...new Set(IMAGE_MODELS.flatMap((m) => m.resolutions ?? []))].sort();
    expect(named.sort()).toEqual(union);
  });

  // The schema names the models that have a resolution lever and says every other one ignores it; a model that instead
  // refuses the resolution fails a call the agent was told would work.
  it.fails(
    "known bug: nano-banana-2-lite refuses a resolution the generate_image schema says it ignores",
    async () => {
      const text = param("generate_image", "resolution").description;
      const levered = idsIn(
        said(text, /list 'resolutions' \(([^)]+)\)/, "the models with a lever"),
      );
      const named = quoted(said(text, RESOLUTIONS, "the resolutions"));
      const refused: string[] = [];
      for (const m of IMAGE_MODELS) {
        if (levered.includes(m.id)) continue;
        for (const resolution of named) {
          const reply = await run("generate_image", {
            ...PROMPT.generate_image,
            model: m.id,
            resolution,
          });
          if (reply.ok !== true) refused.push(`${m.id} at ${resolution}: ${reply.error}`);
        }
      }
      expect(refused).toEqual([]);
    },
  );
});

describe("a call that names no aspect ratio is never refused", () => {
  const KINDS: Array<[string, readonly GenModel[]]> = [
    ["generate_image", IMAGE_MODELS],
    ["generate_video", VIDEO_MODELS],
  ];
  it.each(KINDS)("%s sends the default its schema names, on every model", async (name, models) => {
    const text = param(name, "aspect_ratio").description;
    const fallback = said(text, /default '([^']+)'/, "the default aspect ratio");
    const union = [...new Set(models.flatMap((m) => m.aspect_ratios))].sort();
    expect(quoted(said(text, /\(e\.g\. ([^)]+)\)/, "the aspect ratios")).sort()).toEqual(union);
    for (const m of models) {
      const reply = await run(name, { ...PROMPT[name], model: m.id });
      expect(reply.ok, `${m.id}: ${reply.error}`).toBe(true);
      expect(sent()?.aspect_ratio, m.id).toBe(fallback);
    }
  });
});

describe("the voices and music the agent is told about", () => {
  it("the voice count, default and examples the voiceover schema names are the voice table's", async () => {
    const text = tool("generate_voiceover").description!;
    const count = Number(said(text, /(\d+) prebuilt voices/, "how many voices"));
    const named = said(text, /prebuilt voices \(default (\w+)\)/, "the default voice");
    expect(count).toBe(Object.keys(TTS_VOICES).length);
    const reply = await run("generate_voiceover", PROMPT.generate_voiceover);
    expect(reply.voice).toBe(named);
    const examples = said(text, /pick by vibe from list_models \(e\.g\. ([^)]+)\)/, "the examples");
    for (const [, voice, vibe] of examples.matchAll(/(\w+) (\w+)/g)) {
      expect(Object.keys(TTS_VOICES), voice).toContain(voice);
      expect(TTS_VOICES[voice], voice).toContain(vibe);
    }
  });

  it("the music model the schema names for sung lyrics is one that sings them", async () => {
    const id = said(
      tool("generate_music").description,
      /support lyrics, e\.g\. ([a-z0-9.-]+)\)/,
      "it",
    );
    const reply = await run("list_models", { type: "audio" });
    expect((reply.models as Any[]).find((m) => m.id === id)?.supports_lyrics).toBe(true);
  });
});

// The tool texts list the models in words the agent reads before list_models; a model left out there is one it does not
// think to use unless it asks. The Lite models were added to the schemas and the app, and not to these sentences.
const MODEL_LIST = /`model` \(default '[^']+'\): ([^—]+)—/;
const listedInText = (name: string): string[] =>
  said(tool(name).description, MODEL_LIST, `${name}'s models`)
    .split("|")
    .map((part) => part.trim().split(/\s/)[0])
    .sort();

describe("the tool texts name the models their schemas offer", () => {
  it.fails("known bug: the generate_image text leaves out nano-banana-2-lite", () => {
    expect(listedInText("generate_image")).toEqual([...offered("generate_image", "model")].sort());
  });

  it.fails("known bug: the generate_video text leaves out veo-3.1-lite", () => {
    expect(listedInText("generate_video")).toEqual([...offered("generate_video", "model")].sort());
  });

  // The two marks above stay expected failures only while a Lite model is the one thing missing: anything else the text
  // gets wrong fails here.
  it("names no model the schema does not offer, and leaves out only the Lite models", () => {
    for (const name of ["generate_image", "generate_video"]) {
      const schema = offered(name, "model") as string[];
      expect(
        listedInText(name).filter((id) => !schema.includes(id)),
        name,
      ).toEqual([]);
      expect(
        schema.filter((id) => !listedInText(name).includes(id)),
        name,
      ).toEqual(schema.filter((id) => id.endsWith("-lite")));
    }
  });
});
