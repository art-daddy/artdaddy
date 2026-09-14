// The tool catalog (contract) is BUNDLED: `catalog.json` is generated from the server's tool
// registry by `npm run codegen` and committed, so the app has its full contract before it talks
// to anything. It used to be fetched from GET /contract/tools at startup — which fired before
// sign-in, on every launch, and left a clone of this repo with no usable contract at all.
//
// The catalog is therefore always ready and never fails: no loading state, no retry, no degraded
// mode. Drift against the server is caught in the server repo before it can ship, not by a
// warning in a user's console.
import catalog from "./catalog.json";

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

interface RawTool {
  name: string;
  expensive?: boolean;
  description?: string;
  parameters?: ParamSchema;
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

/** Replace the in-memory contract. Tests use this to drive a specific catalog; production calls
 *  it once, with the bundle, below. */
export function setContract(cat: Catalog): void {
  const raw = (cat.tools ?? []) as RawTool[];
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

/** Contract version string. */
export function contractVersion(): string {
  return _version;
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
