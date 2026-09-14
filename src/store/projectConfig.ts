// Read the co-located project.json settings (canvas + model/style/workflow) so
// each turn can seed the stateless server's ephemeral store.
//
// The server is content-free: it injects the style/workflow BODIES we send (an
// empty body => that section is omitted from the prompt). Style/workflow content
// is per-project and client-owned, so the active style/workflow markdown is read
// here from the project's `internals/` and attached alongside the settings.
import { INTERNAL_DIR, joinPath, type ProjectStoreAccess } from "../tools/store";

const NO_SELECTION = new Set(["", "none", "off", "skip"]);

async function readProjectTextOr(store: ProjectStoreAccess, path: string): Promise<string> {
  try {
    return await store.readText(path);
  } catch {
    return "";
  }
}

export async function projectConfig(
  store: ProjectStoreAccess,
): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await store.readText(joinPath(store.projectDir, INTERNAL_DIR, "project.json"));
    const pj = JSON.parse(raw) as { settings?: Record<string, unknown> };
    const settings = pj.settings;
    if (!settings) return undefined;
    const out: Record<string, unknown> = { ...settings };
    const styleName = typeof settings.active_style === "string" ? settings.active_style : "";
    if (!NO_SELECTION.has(styleName.toLowerCase())) {
      const body = await readProjectTextOr(
        store,
        joinPath(store.projectDir, INTERNAL_DIR, "styles", styleName, "style.md"),
      );
      if (body.trim()) out.style_body = body;
    }
    const workflowName =
      typeof settings.active_workflow === "string" ? settings.active_workflow : "";
    if (!NO_SELECTION.has(workflowName.toLowerCase())) {
      const body = await readProjectTextOr(
        store,
        joinPath(store.projectDir, INTERNAL_DIR, "workflows", workflowName, "WORKFLOW.md"),
      );
      if (body.trim()) out.workflow_body = body;
    }
    return { settings: out };
  } catch {
    return undefined;
  }
}
