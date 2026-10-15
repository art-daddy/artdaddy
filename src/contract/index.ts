// catalog.json is the client-authored tool source. Codegen derives its compiled identity and
// trusted server snapshots; neither app execution nor MCP replaces it with a fetched catalog.
// Compatibility is a separate admission decision, not a second catalog or schema fallback.
import catalog from "./catalog.json";
import identity from "./identity.json";

export interface ToolMeta {
  name: string;
  expensive: boolean;
  description: string;
}

export interface ParamSchema {
  type?: string | string[];
  minimum?: number;
  maximum?: number;
  required?: string[];
  properties?: Record<string, ParamSchema>;
  items?: ParamSchema;
}

export interface RawTool {
  name: string;
  expensive?: boolean;
  description?: string;
  parameters?: ParamSchema;
  status?: "active" | "withdrawn";
  surfaces?: Array<"app" | "mcp">;
  effect?: string;
  omit_for_native_video?: boolean;
  text_variant?: { description: string; parameters: ParamSchema };
}

export interface EffectDef {
  id: string;
  [key: string]: unknown;
}

export interface Catalog {
  version?: string;
  tools?: unknown[];
  effects?: unknown[];
}

let _version = "";
let _tools: ToolMeta[] = [];
let _byName: Record<string, ToolMeta> = {};
let _params: Record<string, ParamSchema> = {};
let _effects: EffectDef[] = [];
let _definitions: RawTool[] = [];

/** Replace the in-memory contract. Tests use this to drive a specific catalog; production calls
 *  it once, with the bundle, below. */
export function setContract(cat: Catalog): void {
  _definitions = (cat.tools ?? []) as RawTool[];
  const raw = _definitions.filter(
    (tool) => (!tool.status || tool.status === "active") && (!tool.surfaces || tool.surfaces.includes("app")),
  );
  _version = cat.version ?? "";
  _tools = raw.map((t) => ({
    name: t.name,
    expensive: !!t.expensive,
    description: t.description ?? "",
  }));
  _byName = Object.fromEntries(_tools.map((t) => [t.name, t]));
  _params = Object.fromEntries(
    raw
      .filter((t): t is RawTool & { parameters: ParamSchema } => !!t.parameters)
      .map((t) => [t.name, t.parameters]),
  );
  _effects = (cat.effects ?? []) as EffectDef[];
}

setContract(catalog as Catalog);

export function toolDefinition(name: string): RawTool | undefined {
  return _definitions.find((tool) => tool.name === name);
}

export function toolDefinitions(): readonly RawTool[] {
  return _definitions;
}

export function toolsForSurface(surface: "app" | "mcp"): readonly RawTool[] {
  return _definitions.filter(
    (tool) => (!tool.status || tool.status === "active") && (!tool.surfaces || tool.surfaces.includes(surface)),
  );
}

/** Contract version string. */
export function contractVersion(): string {
  return _version;
}

export function catalogIdentity(): string {
  return identity.id;
}

/** Top-level param names a tool declares, or null when the catalog doesn't know the tool. */
export function liveParamNames(name: string): string[] | null {
  if (!_byName[name]) return null;
  const s = _params[name];
  return s?.properties ? Object.keys(s.properties) : [];
}

/** Required param names for a tool, or null when the catalog doesn't know the tool. */
export function liveRequiredParams(name: string): string[] | null {
  if (!_byName[name]) return null;
  return _params[name]?.required ?? [];
}

export function allTools(): ToolMeta[] {
  return _tools;
}

export function toolByName(name: string): ToolMeta | undefined {
  return _byName[name];
}

/** Parameter JSON-schema for a tool (used by arg-clamping). */
export function paramSchema(name: string): ParamSchema | undefined {
  return _params[name];
}

/** apply_effects' registry: the ranges and defaults the model was shown, so the client clamps
 *  with the same numbers rather than a second copy. */
export function allEffects(): EffectDef[] {
  return _effects;
}
