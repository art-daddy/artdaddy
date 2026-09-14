// Client-side tool-arg NAME validation, read from the bundled contract (src/contract/catalog.json,
// generated from the server's registry by `npm run codegen`). Our split (server declares the
// contract, client executes) means a param the model sends that the client doesn't read is
// otherwise silently dropped; this rejects any top-level arg the tool's schema does not declare,
// so a mis-named / hallucinated param fails LOUDLY.
//
// Scope: TOP-LEVEL keys only (nested object/array params are the tool's own job,
// and clampArgs already walks the full schema for ranges).
import { allTools, liveParamNames, liveRequiredParams } from ".";

// Params some tools accept that are CLIENT-INJECTED, not model-facing, so they
// are legitimately absent from the served schema. Keep this list tiny + honest.
// Currently EMPTY: library_op's `add` (which carried a client-set `source`
// provenance) was removed in CONTRACT_VERSION 1.2.0 — importing media, with its
// provenance, is now import_media's job, and that persist path bypasses this
// top-level validation. The mechanism stays for any future internal-only param.
const INTERNAL_PARAMS: Record<string, readonly string[]> = {};

/** Top-level param names a tool declares (empty for a tool the contract doesn't know). */
export function toolParams(name: string): string[] {
  return liveParamNames(name) ?? [];
}

/** True when the contract knows this tool's params. */
export function hasParamSchema(name: string): boolean {
  return liveParamNames(name) !== null;
}

/** Every tool name in the bundled contract (used by the conformance test + fuzzers). */
export function snapshotToolNames(): string[] {
  return allTools().map((t) => t.name);
}

/** Required param names for a tool. */
export function requiredParams(name: string): string[] {
  return liveRequiredParams(name) ?? [];
}

/** Top-level keys in `args` the tool's schema does NOT declare. Underscore-prefixed
 *  keys are client-internal (injected after the model call, e.g. `_model_id`) and
 *  always allowed; returns [] for a tool the contract doesn't know (can't validate). */
export function unknownParams(name: string, args: Record<string, unknown>): string[] {
  const params = liveParamNames(name);
  if (!params) return [];
  const allowed = new Set([...params, ...(INTERNAL_PARAMS[name] ?? [])]);
  return Object.keys(args).filter((k) => !k.startsWith("_") && !allowed.has(k));
}
