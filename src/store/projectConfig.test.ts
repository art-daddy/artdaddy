import { describe, expect, it } from "vitest";

import { joinPath, type ProjectStoreAccess } from "../tools/store";
import { projectConfig } from "./projectConfig";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const DIR = "C:/proj/p1";
const PROJ = joinPath(DIR, "internals", "project.json");
const STYLE = joinPath(DIR, "internals", "styles", "punchy", "style.md");
const WF = joinPath(DIR, "internals", "workflows", "promo", "WORKFLOW.md");

function storeWith(files: Record<string, string>): ProjectStoreAccess {
  return {
    projectDir: DIR,
    readText: async (p: string) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p];
    },
  } as Any;
}

describe("projectConfig", () => {
  it("returns undefined when project.json is missing", async () => {
    expect(await projectConfig(storeWith({}))).toBeUndefined();
  });

  it("returns undefined when there are no settings", async () => {
    expect(
      await projectConfig(storeWith({ [PROJ]: JSON.stringify({ version: 1 }) })),
    ).toBeUndefined();
  });

  it("includes the active style + workflow bodies", async () => {
    const cfg = (await projectConfig(
      storeWith({
        [PROJ]: JSON.stringify({
          settings: { active_style: "punchy", active_workflow: "promo", fps: 30 },
        }),
        [STYLE]: "STYLE BODY",
        [WF]: "WORKFLOW BODY",
      }),
    )) as Any;
    expect(cfg.settings.fps).toBe(30);
    expect(cfg.settings.style_body).toBe("STYLE BODY");
    expect(cfg.settings.workflow_body).toBe("WORKFLOW BODY");
  });

  it("skips style/workflow set to a NO_SELECTION sentinel", async () => {
    const cfg = (await projectConfig(
      storeWith({
        [PROJ]: JSON.stringify({ settings: { active_style: "none", active_workflow: "" } }),
      }),
    )) as Any;
    expect(cfg.settings.style_body).toBeUndefined();
    expect(cfg.settings.workflow_body).toBeUndefined();
  });

  it("omits the style body when the active style's file is missing", async () => {
    const cfg = (await projectConfig(
      storeWith({ [PROJ]: JSON.stringify({ settings: { active_style: "ghost" } }) }),
    )) as Any;
    expect(cfg.settings.active_style).toBe("ghost");
    expect(cfg.settings.style_body).toBeUndefined();
  });
});
