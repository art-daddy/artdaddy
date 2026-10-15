// Runtime effect classes derived from the client-authored catalog. The existing ProjectDocument
// boundaries consume these classifications; this module does not author a second per-tool map.
//
// A tool's class describes what it DOES; the enforcement slice maps each class to its runtime:
//   read             — no durable project change (may be paid/async); TURN-scoped, served with NO
//                      project lease. Cancelled via the turn's abort signal, not the job scope.
//   project-mutation — changes the open document's authoritative state (timeline / library / settings);
//                      MUST commit through the project's mutation boundary (timeline MutationGate, or the
//                      per-project write lock for the catalog/settings files).
//   project-job      — long-running work that produces a DURABLE project asset (download / generate /
//                      import / heavy ffmpeg); runs under the document's ProjectJobScope so close cancels
//                      it deterministically instead of relying on the turn signal alone.
//   derived-job      — long-running work that produces a REBUILDABLE derived cache (transcription today;
//                      proxy / index / thumbnail later); also under the ProjectJobScope, but its output
//                      is not authoritative project state.
//   app-operation    — app-level project-registry / lifecycle (list / new / open / rename / duplicate);
//                      NOT scoped to the open document — runs on the app-level registry lock.
//   deliverable      — export to a user destination OUTSIDE the project package, from an immutable
//                      snapshot (export / pack); runs on the app-level export path.

import { toolDefinitions } from ".";

export type ToolEffect =
  "read" | "project-mutation" | "project-job" | "derived-job" | "app-operation" | "deliverable";

/** Retained app-tool classifications, including withdrawn implementations. */
export const TOOL_EFFECTS: Readonly<Record<string, ToolEffect>> = Object.fromEntries(
  toolDefinitions()
    .filter((tool) => tool.surfaces?.includes("app"))
    .map((tool) => [tool.name, tool.effect as ToolEffect]),
);

/** The effect class of `name`, or undefined if it isn't a classified contract tool. */
export function toolEffect(name: string): ToolEffect | undefined {
  return TOOL_EFFECTS[name];
}

/** True when a tool's effect requires the document's ProjectJobScope (so close cancels it). */
export function isJobEffect(effect: ToolEffect): boolean {
  return effect === "project-job" || effect === "derived-job";
}

/** True when a tool's effect changes the open document's authoritative state. */
export function isMutationEffect(effect: ToolEffect): boolean {
  return effect === "project-mutation";
}
