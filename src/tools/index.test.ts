import { describe, expect, it } from "vitest";

import { createToolRegistry } from ".";

describe("tool registry", () => {
  it("registers all client tools", () => {
    const registry = createToolRegistry(() => null);
    for (const name of [
      "probe_media",
      "run_ffmpeg",
      "clip_video",
      "crop_image",
      "download_video",
      "video_get_metadata",
      "youtube_search",
      "get_timeline",
      "add_clips",
      "move_clips",
      "split_clips",
      "set_clip_properties",
      "apply_color",
      "undo",
      "export",
      "library_op",
    ]) {
      expect(registry.has(name)).toBe(true);
    }
  });
});

describe("tool dispatch contract", () => {
  it("unknown tool names reject", async () => {
    const reg = createToolRegistry(() => null);
    await expect(reg.run("definitely_not_a_tool", {})).rejects.toThrow(/no client tool/i);
  });

  it("every registered tool dispatches by contract name and returns an { ok } envelope", async () => {
    // A null context = no project open. Dispatch each tool by name with empty args;
    // every handler must return a JSON object carrying a boolean `ok` (never throw,
    // never return undefined) — the envelope the model relies on.
    const reg = createToolRegistry(() => null);
    for (const name of reg.names()) {
      const res = (await reg.run(name, {})) as { ok?: unknown };
      expect(res, `${name} returned a non-object`).toBeTypeOf("object");
      expect(typeof res?.ok, `${name} did not return a boolean 'ok'`).toBe("boolean");
    }
  });

  it("context-requiring tools fail cleanly (not-ready) under a null context", async () => {
    const reg = createToolRegistry(() => null);
    const r = (await reg.run("get_timeline", {})) as { ok: boolean; error?: unknown };
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/not ready|runtime/i);
  });
});
