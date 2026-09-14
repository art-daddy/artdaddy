// Execution-conformance — the DISPATCH half of the split-brain guard. conformance.test.ts
// proves the client REGISTERS every tool the server advertises in /contract/tools; this
// proves every advertised tool is actually DISPATCHABLE: the crash-proof registry.run
// turns any missing-arg / garbage-arg / hallucinated-param call into a graceful
// { ok:false } — never a throw, never a non-object — for the WHOLE contract surface.
// (fuzz.property.test.ts fuzzes the validator; this pins the registry boundary per tool.)
import { describe, expect, it } from "vitest";

import { seededCtx, videoRunner } from "../test/timelineKit";
import { createToolRegistry } from "../tools";
import { toolNames } from "./views";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const CONTRACT = toolNames();

describe("registry dispatch is crash-proof across the whole contract", () => {
  it("every advertised tool is registered (a handler exists)", async () => {
    const { store } = await seededCtx(videoRunner);
    const registry = createToolRegistry(() => ({ store, runner: videoRunner }));
    const missing = CONTRACT.filter((n) => !registry.has(n));
    expect(missing).toEqual([]);
  });

  it.each(CONTRACT)(
    "%s: empty / garbage args -> structured result, never a throw",
    async (name) => {
      const { store } = await seededCtx(videoRunner);
      const registry = createToolRegistry(() => ({ store, runner: videoRunner }));
      // Empty args exercise the handler's own missing-required-arg guard; the run()
      // boundary catches any throw and returns { ok:false }. Either way it must be a
      // structured tool-result object (never undefined / a primitive / an exception).
      for (const args of [{}, { properties: {} }] as Any[]) {
        const r = (await registry.run(name, args)) as Any;
        expect(r !== null && typeof r === "object", `${name} ${JSON.stringify(args)}`).toBe(true);
      }
      // A hallucinated top-level param is rejected LOUDLY (ok:false) for every tool —
      // the split-brain canary a compile check can't provide.
      const rp = (await registry.run(name, { not_a_real_param_xyz: true })) as Any;
      expect(rp.ok, name).toBe(false);
      expect(String(rp.error)).toMatch(/unknown param/i);
    },
  );
});
