// What the Export dialog's chip row reads about this PC: read from what the chip test remembers, never by running it, and in agreement with
// the one lookup an export asks (findChip): the row says "passed" exactly when the exporter would use the chip.
import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";

import { __setExportFlag, type ExportFlagName } from "../api/exportFlags";
import { amd, harness, intel, nvidia, type Behaviour } from "../test/chipHarness";
import { CHIP_PREF_KEY } from "./chipPref";
import {
  FAIL_TTL_MS,
  PASS_TTL_MS,
  __resetChipTests,
  chipStatusOf,
  findChip,
  liftChipSetAside,
  markChipSuspect,
} from "./chipTest";
import type { SizeClass } from "./exportEncoder";

const FLAGS: readonly ExportFlagName[] = ["chip_amd", "chip_nvidia", "chip_intel", "chip_default"];
beforeEach(() => {
  __resetChipTests();
  for (const flag of FLAGS) __setExportFlag(flag, true);
});

describe("what the chip row reads", () => {
  it("has nothing to say about a PC with no chip of a known maker, and asks nothing of it", async () => {
    const h = harness([]);
    expect(await chipStatusOf("hd", h.deps)).toEqual({
      found: false,
      flagsOn: false,
      pref: "auto",
      setAside: false,
      verdict: "unknown",
      adapters: [],
    });
    expect(h.calls).toEqual([]);
  });

  it("does not know yet before the chip has been tested, runs no test to find out, and knows once it has been", async () => {
    const h = harness([amd]);
    const before = await chipStatusOf("hd", h.deps);
    expect(before).toMatchObject({
      found: true,
      flagsOn: true,
      verdict: "unknown",
      setAside: false,
    });
    expect(before.adapters).toEqual([{ adapter: amd, result: null }]);
    expect(h.calls).toEqual([]);

    await findChip("hd", { allowRun: true }, h.deps);
    const tested = h.calls.length;
    const after = await chipStatusOf("hd", h.deps);
    expect(after).toMatchObject({ verdict: "passed", setAside: false });
    expect(after.adapters).toEqual([{ adapter: amd, result: "passed" }]);
    expect(h.calls.length).toBe(tested);
  });

  it.each([
    ["fail", "encode_failed"],
    ["no_device", "no_device"],
  ] as const)("says the chip did not pass, and why (%s)", async (chip, result) => {
    const h = harness([nvidia], { chip });
    await findChip("hd", { allowRun: true }, h.deps);
    const status = await chipStatusOf("hd", h.deps);
    expect(status.verdict).toBe("not_passed");
    expect(status.adapters).toEqual([{ adapter: nvidia, result }]);
  });

  it("says nothing of a test that could not be made right now: busy is not remembered, so it is not an answer", async () => {
    const h = harness([amd], { chip: "busy" });
    await findChip("hd", { allowRun: true }, h.deps);
    expect(await chipStatusOf("hd", h.deps)).toMatchObject({ verdict: "unknown" });
  });

  it("says a chip that stopped an export is set aside, and says passed again once the person lifts it, with nothing tested again", async () => {
    const h = harness([amd]);
    await findChip("hd", { allowRun: true }, h.deps);
    const tested = h.calls.length;
    markChipSuspect(amd, h.deps);
    const aside = await chipStatusOf("hd", h.deps);
    expect(aside).toMatchObject({ setAside: true, verdict: "unknown" });
    expect((await findChip("hd", { allowRun: false }, h.deps)).chip).toBeNull();

    await liftChipSetAside(h.deps);
    expect(await chipStatusOf("hd", h.deps)).toMatchObject({ setAside: false, verdict: "passed" });
    expect((await findChip("hd", { allowRun: false }, h.deps)).chip?.maker).toBe("amd");
    expect(h.calls.length).toBe(tested);
  });

  it("is lifted for this run of the app and for the stored memory both, so a restart does not bring it back", async () => {
    const h = harness([amd]);
    await findChip("hd", { allowRun: true }, h.deps);
    markChipSuspect(amd, h.deps);
    await liftChipSetAside(h.deps);
    __resetChipTests(); // a new run of the app: only what was written down is left
    expect((await findChip("hd", { allowRun: false }, h.deps)).chip?.maker).toBe("amd");
    expect(JSON.parse(h.storage.get("artdaddy.chipTest.v1")!).suspect).toEqual({});
  });

  it("shows a chip that is set aside while another proven chip is used as passed: the chip in use is what the row says", async () => {
    const h = harness([nvidia, amd]);
    const first = (await findChip("hd", { allowRun: true }, h.deps)).chip!;
    const [setAside, other] = first.maker === "nvidia" ? [nvidia, amd] : [amd, nvidia];
    markChipSuspect(setAside, h.deps);
    expect(await chipStatusOf("hd", h.deps)).toMatchObject({ setAside: true, verdict: "unknown" }); // the other is untested
    expect((await findChip("hd", { allowRun: true }, h.deps)).chip?.maker).toBe(other.maker);
    const status = await chipStatusOf("hd", h.deps);
    expect(status).toMatchObject({ verdict: "passed", setAside: false });
    expect(status.adapters.map((entry) => entry.result)).toEqual(["passed", "passed"]);
  });

  it("carries the person's switch, and what the server allows", async () => {
    const h = harness([amd]);
    expect((await chipStatusOf("hd", h.deps)).pref).toBe("auto");
    h.storage.set(CHIP_PREF_KEY, "off");
    expect((await chipStatusOf("hd", h.deps)).pref).toBe("off");
    __setExportFlag("chip_default", false);
    expect((await chipStatusOf("hd", h.deps)).flagsOn).toBe(false);
    __setExportFlag("chip_default", true);
    __setExportFlag("chip_amd", false);
    expect((await chipStatusOf("hd", h.deps)).flagsOn).toBe(false);
    const both = harness([amd, nvidia]);
    expect((await chipStatusOf("hd", both.deps)).flagsOn).toBe(true); // NVIDIA's switch is still on
  });

  it("forgets a failure after its day and a pass after its month, as the lookup does", async () => {
    const failing = harness([amd], { chip: "fail" });
    await findChip("hd", { allowRun: true }, failing.deps);
    failing.now.t += FAIL_TTL_MS - 1;
    expect((await chipStatusOf("hd", failing.deps)).verdict).toBe("not_passed");
    failing.now.t += 2;
    expect((await chipStatusOf("hd", failing.deps)).verdict).toBe("unknown");

    const passing = harness([amd]);
    await findChip("hd", { allowRun: true }, passing.deps);
    passing.now.t += PASS_TTL_MS - 1;
    expect((await chipStatusOf("hd", passing.deps)).verdict).toBe("passed");
    passing.now.t += 2;
    expect((await chipStatusOf("hd", passing.deps)).verdict).toBe("unknown");
  });

  it("says at 4K what the 1080p test said when that failed (4K is offered only to a chip that passed there), and knows nothing until both are in", async () => {
    const bad = harness([nvidia], { chip: "fail" });
    await findChip("uhd", { allowRun: true }, bad.deps);
    const failed = await chipStatusOf("uhd", bad.deps);
    expect(failed.verdict).toBe("not_passed");
    expect(failed.adapters[0].result).toBe("encode_failed");

    const good = harness([amd]);
    await findChip("hd", { allowRun: true }, good.deps);
    expect(await chipStatusOf("uhd", good.deps)).toMatchObject({ verdict: "unknown" }); // 4K itself not tested yet
    await findChip("uhd", { allowRun: true }, good.deps);
    expect(await chipStatusOf("uhd", good.deps)).toMatchObject({ verdict: "passed" });
  });

  it("never throws: a PC that cannot be asked has no chip, and a damaged memory knows nothing", async () => {
    const h = harness([amd]);
    h.storage.set("artdaddy.chipTest.v1", "{not json");
    expect(await chipStatusOf("hd", h.deps)).toMatchObject({ found: true, verdict: "unknown" });
    const broken = { ...h.deps, adapters: async () => Promise.reject(new Error("no PC")) };
    expect(await chipStatusOf("hd", broken)).toMatchObject({ found: false, verdict: "unknown" });
    await expect(liftChipSetAside(broken)).resolves.toBeUndefined();
  });
});

// The rule that survives a rewrite: whatever the row says "passed" for is a chip the exporter's own lookup gives, and whatever it
// says anything else for is not. The same facts are asked of both, over every shape of PC and of what happened to its chips.
describe("agrees with the lookup an export asks", () => {
  const behaviours: Behaviour[] = [
    {},
    { chip: "fail" },
    { chip: "no_device" },
    { chip: "busy" },
    { chip: "slow" },
    { chipSsim: 0.2 },
  ];
  it("says passed exactly when findChip would give a chip, for any PC, switches, suspicions and size class", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.subarray([amd, nvidia, intel]),
        fc.constantFrom(...behaviours),
        fc.constantFrom<SizeClass>("hd", "uhd"),
        fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
        fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
        fc.boolean(),
        async (adapters, behaviour, sizeClass, makerOn, suspect, runFirst) => {
          __resetChipTests();
          const h = harness(adapters, behaviour);
          for (const [index, flag] of (
            ["chip_amd", "chip_nvidia", "chip_intel"] as const
          ).entries())
            __setExportFlag(flag, makerOn[index]);
          if (runFirst) await findChip(sizeClass, { allowRun: true }, h.deps);
          for (const [index, adapter] of [amd, nvidia, intel].entries())
            if (suspect[index] && adapters.includes(adapter)) markChipSuspect(adapter, h.deps);
          const status = await chipStatusOf(sizeClass, h.deps);
          const used = (await findChip(sizeClass, { allowRun: false }, h.deps)).chip;
          expect(status.verdict === "passed", JSON.stringify({ status, used })).toBe(used !== null);
          if (status.verdict === "passed") expect(status.setAside).toBe(false);
          expect(status.found).toBe(adapters.length > 0);
        },
      ),
      { numRuns: 150 },
    );
  });
});
