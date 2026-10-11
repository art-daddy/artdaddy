import { afterEach, describe, expect, it } from "vitest";

import { setContract } from ".";
import catalog from "./catalog.json";
import {
  hasParamSchema,
  missingClipMessage,
  requiredParams,
  toolParams,
  unknownParams,
} from "./params";

// setContract mutates a module singleton, so restore the real bundle rather than an empty one:
// leaving it empty makes every later test in the file assert against a contract with no tools.
afterEach(() => setContract(catalog as Parameters<typeof setContract>[0]));

describe("params validation reads the bundled contract", () => {
  it("clip recovery only suggests media_ref when the requesting tool accepts it", () => {
    for (const tool of catalog.tools) {
      if (!("clip_id" in tool.parameters.properties)) continue;
      const message = missingClipMessage(tool.name, "missing-clip");
      expect(message).toContain("get_timeline");
      expect(message.includes("use media_ref"), tool.name).toBe(
        "media_ref" in tool.parameters.properties,
      );
    }
  });

  it("media-reading tools never ask callers to pass a download's filesystem path", () => {
    for (const tool of catalog.tools) {
      if ("media_ref" in tool.parameters.properties) {
        expect(tool.description, tool.name).not.toMatch(/pass the returned path/i);
      }
    }
  });

  it("named input recommendations refer to this tool or an explicitly named companion", () => {
    const names = new Set(catalog.tools.map((tool) => tool.name));
    const fields = (schema: unknown): string[] => {
      if (!schema || typeof schema !== "object") return [];
      const object = schema as { properties?: Record<string, unknown>; items?: unknown };
      return [
        ...Object.keys(object.properties ?? {}),
        ...Object.values(object.properties ?? {}).flatMap(fields),
        ...fields(object.items),
      ];
    };
    for (const tool of catalog.tools) {
      const companions = catalog.tools.filter((other) =>
        new RegExp(`\\b${other.name}\\b`).test(tool.description),
      );
      const declared = new Set([
        ...fields(tool.parameters),
        ...companions.flatMap((other) => fields(other.parameters)),
      ]);
      for (const match of tool.description.matchAll(
        /\b(?:pass|set|raise|lower|omit)\s+`?([a-z][a-z0-9]*_[a-z0-9_]+)`?/gi,
      )) {
        const name = match[1];
        if (!names.has(name))
          expect(declared.has(name), `${tool.name} recommends ${name}`).toBe(true);
      }
    }
  });

  it("knows a real tool's params straight from the bundle", () => {
    expect(hasParamSchema("add_clips")).toBe(true);
    expect(toolParams("add_clips").length).toBeGreaterThan(0);
  });

  it("validates against whatever the contract currently declares", () => {
    setContract({
      tools: [
        {
          name: "add_clips",
          parameters: { properties: { brand_new_param: {} }, required: ["brand_new_param"] },
        },
      ],
    });
    expect(toolParams("add_clips")).toEqual(["brand_new_param"]);
    expect(requiredParams("add_clips")).toEqual(["brand_new_param"]);
    expect(unknownParams("add_clips", { brand_new_param: 1 })).toEqual([]);
    expect(unknownParams("add_clips", { some_old_param: 1 })).toEqual(["some_old_param"]);
  });

  it("allows underscore-prefixed client-internal keys, flags undeclared model-facing ones", () => {
    setContract({ tools: [{ name: "library_op", parameters: { properties: { action: {} } } }] });
    // `_`-prefixed keys are injected AFTER the model call (e.g. _model_id) and always allowed.
    expect(unknownParams("library_op", { action: "x", _model_id: "y" })).toEqual([]);
    // `source` was library_op 'add' provenance; add is gone, so it's now flagged LOUDLY.
    expect(unknownParams("library_op", { action: "x", source: {} })).toEqual(["source"]);
  });

  it("can't validate a tool the contract doesn't know", () => {
    setContract({ tools: [] });
    expect(hasParamSchema("no_such_tool")).toBe(false);
    expect(unknownParams("no_such_tool", { anything: 1 })).toEqual([]);
  });
});
