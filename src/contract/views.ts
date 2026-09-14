// Views of the bundled catalog in the shapes consumers want. These replace the separate
// tools.snapshot.json / params.snapshot.json files: same information, derived from the one
// committed catalog rather than generated into parallel files that could disagree with it.
import { allTools, liveParamNames, liveRequiredParams } from ".";

/** Every tool the contract offers, sorted. */
export function toolNames(): string[] {
  return allTools()
    .map((t) => t.name)
    .sort();
}

/** Tools the server bills for — the approval gate's expectation comes from here, not a
 *  hand-maintained second list. */
export function expensiveToolNames(): string[] {
  return allTools()
    .filter((t) => t.expensive)
    .map((t) => t.name)
    .sort();
}

export interface ParamEntry {
  params: string[];
  required: string[];
}

/** Top-level param + required names per tool. */
export function paramsByTool(): Record<string, ParamEntry> {
  return Object.fromEntries(
    allTools().map((t) => [
      t.name,
      {
        params: [...(liveParamNames(t.name) ?? [])].sort(),
        required: [...(liveRequiredParams(t.name) ?? [])].sort(),
      },
    ]),
  );
}
