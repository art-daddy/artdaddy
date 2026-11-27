// A paid call over MCP starts only for a request that is well formed. Over MCP nothing asks the person first, so a malformed
// request that the app quietly makes sense of spends their credits on whatever the sense was.
//
// The door, the tool host, the registry and the four REAL generation tools run; only the step that submits a paid
// generation (`submitGeneration`, which reserves credits and calls the server) is a recorder, so a test sees whether money
// would have been spent, and on what.
import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClientToolContext } from "../tools/context";

const h = vi.hoisted(() => ({
  /** Every paid generation that was submitted: which tool, and the text it was for. */
  submitted: [] as Array<{ tool: string; prompt: unknown }>,
}));

vi.mock("../store/projects", () => ({
  useProjects: {
    getState: () => ({
      activeId: "p1",
      active: { id: "p1", name: "QA" },
      projects: [{ id: "p1", name: "QA" }],
      refresh: async () => undefined,
    }),
  },
}));
vi.mock("../project/openDocuments", () => ({ openDocumentById: () => ({}) }));
vi.mock("../tools/genJobs", async (original) => ({
  ...(await original<typeof import("../tools/genJobs")>()),
  submitGeneration: async (options: { tool: string; source?: { prompt?: unknown } }) => {
    h.submitted.push({ tool: options.tool, prompt: options.source?.prompt });
    return { media_refs: ["media_generated_1"] };
  },
}));
vi.mock("../tools", async () => {
  const { ClientToolRegistry } = await import("../tools/registry");
  const { registerGenerationTools } = await import("../tools/generation");
  const { registerAudioTools } = await import("../tools/audio");
  return {
    ClientToolRegistry,
    createToolRegistry: (getCtx: () => ClientToolContext | null) => {
      const registry = new ClientToolRegistry();
      registerGenerationTools(registry, getCtx);
      registerAudioTools(registry, getCtx);
      return registry;
    },
  };
});
vi.mock("../tools/dataRoot", async (original) => ({
  ...(await original<typeof import("../tools/dataRoot")>()),
  projectDirFor: async () => "C:/proj",
}));
vi.mock("../tools/tauri", async () => {
  const { MemFs, makeRunner } = await import("../test/timelineKit");
  const { ProjectStoreAccess } = await import("../tools/store");
  return {
    makeTauriContext: async () => ({
      store: new ProjectStoreAccess("C:/proj", new MemFs()),
      runner: makeRunner(),
    }),
  };
});

/** Each generation tool and the argument that says what to make. */
const TEXT_OF: Record<string, string> = {
  generate_image: "prompt",
  generate_video: "prompt",
  generate_voiceover: "text",
  generate_music: "prompt",
};

type Reply = { isError?: boolean; content: Array<{ text: string }> };

beforeEach(async () => {
  vi.resetModules();
  h.submitted.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 })),
  );
  const { useAuth } = await import("../store/auth");
  useAuth.setState({ status: "unlocked", hasStoredSession: true });
  window.history.replaceState({}, "", "/p/p1");
});

async function call(name: string, args: Record<string, unknown>): Promise<Reply> {
  const { dispatch } = await import("./bridge");
  return (await dispatch({
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  } as never)) as unknown as Reply;
}

describe("a paid generation over MCP", () => {
  it.each(Object.entries(TEXT_OF))(
    "%s with text to make is submitted once, for that text",
    async (tool, field) => {
      const reply = await call(tool, { [field]: "a red kite over the sea" });
      expect(reply.isError, reply.content[0].text).toBe(false);
      expect(h.submitted).toEqual([{ tool, prompt: expect.stringContaining("a red kite") }]);
    },
  );

  it.each(Object.entries(TEXT_OF))(
    "%s with no text to make spends nothing",
    async (tool, field) => {
      for (const args of [{}, { [field]: "" }, { [field]: "   " }]) {
        const reply = await call(tool, args);
        expect(reply.isError, JSON.stringify(args)).toBe(true);
      }
      expect(h.submitted).toEqual([]);
    },
  );

  // KNOWN BUG, kept as an expected failure. Each generation tool reads what to make with String(...), so a value that is not
  // text is turned into text and a paid generation is submitted for it: `{"prompt": {"text": "a cat"}}` becomes an image of
  // "[object Object]", and `["a cat", "a dog"]` one of "a cat,a dog", on the person's credits. The schema says these are
  // strings; the in-app agent's model is held to that, an outside agent is not. When this passes, remove `.fails`.
  it.fails(
    "a generation whose text is an object or a list is refused before anything is paid for",
    async () => {
      const notText = fc.oneof(
        fc.dictionary(fc.string({ minLength: 1, maxLength: 6 }), fc.string(), {
          minKeys: 1,
          maxKeys: 2,
        }),
        fc.array(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 2 }),
      );
      await fc.assert(
        fc.asyncProperty(fc.constantFrom(...Object.keys(TEXT_OF)), notText, async (tool, value) => {
          h.submitted.length = 0;
          const reply = await call(tool, { [TEXT_OF[tool]]: value });
          expect(h.submitted, `${tool} with ${JSON.stringify(value)} was paid for`).toEqual([]);
          expect(reply.isError).toBe(true);
        }),
        { numRuns: 40 },
      );
    },
  );
});
