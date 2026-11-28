// Failures a case stages on purpose (Scenario.faults), so a follow-up can ask the agent to try
// again. One function for every lane: the in-app harness and the lab's Copilot-lane host each call
// it on the registry they build for a run, so a staged failure reads the same in both.
import type { ClientToolRegistry } from "../tools/registry";
import type { ToolFault } from "./types";

/** Make the first `times` calls of each faulted tool in this registry answer the fault's reply
 *  instead of running. Counted per registry (one per run), per tool, from the tool's first call,
 *  and counted when the call starts, so two calls in one round cannot both take one failure. */
export function stageFaults(
  registry: ClientToolRegistry,
  faults: readonly ToolFault[] | undefined,
): void {
  if (!faults?.length) return;
  const calls = new Map<string, number>();
  const run = registry.run.bind(registry);
  registry.run = async (name, args, ...rest) => {
    const fault = faults.find((f) => f.tool === name);
    if (fault) {
      const n = calls.get(name) ?? 0;
      calls.set(name, n + 1);
      if (n < fault.times) return fault.reply(args ?? {});
    }
    return run(name, args, ...rest);
  };
}
