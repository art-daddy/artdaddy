// The person's "Graphics chip: Auto / Off" switch (artdaddy.chipPref.v1). Off means off: the chip is not tested, not offered and not
// used, whatever the server's switches say, and the one place that is asked is `findChip`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __setExportFlag, type ExportFlagName } from "../api/exportFlags";
import { runCapabilityProbe, resolveExportResources } from "../platform/host";
import { amd, harness, nvidia, type Behaviour } from "../test/chipHarness";
import { CHIP_PREF_KEY } from "./chipPref";
import { __resetChipTests, findChip } from "./chipTest";
import { decideExportEncoder } from "./exportChoice";
import { SIZE_CLASSES } from "./exportEncoder";
import type { RenderWorkload } from "./renderPlan";

// The host's two calls the chip lookup makes on the real PC. Everything else of the module stays real.
vi.mock("../platform/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform/host")>()),
  runCapabilityProbe: vi.fn(),
  resolveExportResources: vi.fn(),
}));
vi.mock("../tools/dataRoot", () => ({ appCacheRoot: async () => "C:/cache" }));
vi.mock("../tools/tauri", () => ({
  TauriFs: class {
    async mkdir(): Promise<void> {}
    async remove(): Promise<void> {}
  },
}));

// The processor's faster setting is another quiet route and is not what these tests are about: it stays off, so that "the
// processor's normal setting" is the only thing a refused chip can fall back to.
const FLAGS: readonly ExportFlagName[] = [
  "chip_amd",
  "chip_nvidia",
  "chip_intel",
  "chip_default",
  "faster_x264",
];
beforeEach(() => {
  __resetChipTests();
  for (const flag of FLAGS) __setExportFlag(flag, flag !== "faster_x264");
});
afterEach(() => {
  for (const flag of FLAGS) __setExportFlag(flag, true);
});

const WORKLOAD: RenderWorkload = {
  width: 1920,
  height: 1080,
  fps: 30,
  durationSeconds: 600,
  visualClips: 6,
  captionClips: 0,
  audioClips: 1,
  peakVisualLayers: 1,
  peakMediaLayers: 1,
};

describe("Off means off", () => {
  it("is never tested, offered or used with the switch Off: not one command, with the server's switch on or off, running or only looking", async () => {
    for (const serverOn of [true, false])
      for (const allowRun of [true, false]) {
        __resetChipTests();
        __setExportFlag("chip_amd", serverOn);
        const h = harness([amd]);
        h.storage.set(CHIP_PREF_KEY, "off");
        const found = await findChip("hd", { allowRun }, h.deps);
        expect(found, `server ${serverOn}, run ${allowRun}`).toEqual({ chip: null, events: [] });
        expect(h.calls, `server ${serverOn}, run ${allowRun}`).toEqual([]);
      }
  });

  it("is the same switch that lets a chip be tested when it is Auto: the control that shows the witness is not vacuous", async () => {
    const rows: Array<[boolean, boolean, boolean]> = [
      // server's switch, allowRun, a test is expected
      [true, true, true],
      [true, false, false],
      [false, true, false],
      [false, false, false],
    ];
    for (const [serverOn, allowRun, tested] of rows) {
      __resetChipTests();
      __setExportFlag("chip_amd", serverOn);
      const h = harness([amd]);
      const found = await findChip("hd", { allowRun }, h.deps);
      expect(h.calls.length > 0, `server ${serverOn}, run ${allowRun}`).toBe(tested);
      expect(found.chip?.maker ?? null, `server ${serverOn}, run ${allowRun}`).toBe(
        tested ? "amd" : null,
      );
    }
  });

  it("does not use a chip that passed before: a remembered pass is not an answer while the switch is Off, and comes back with Auto", async () => {
    const h = harness([amd]);
    expect((await findChip("hd", { allowRun: true }, h.deps)).chip?.maker).toBe("amd");
    const tested = h.calls.length;
    expect(tested).toBeGreaterThan(0);

    h.storage.set(CHIP_PREF_KEY, "off");
    for (const allowRun of [true, false])
      expect(await findChip("hd", { allowRun }, h.deps), `run ${allowRun}`).toEqual({
        chip: null,
        events: [],
      });
    expect(h.calls.length).toBe(tested);

    h.storage.delete(CHIP_PREF_KEY);
    expect((await findChip("hd", { allowRun: false }, h.deps)).chip?.maker).toBe("amd");
    expect(h.calls.length).toBe(tested); // remembered: the pass was kept while it was Off
  });

  it("holds for every maker and for every larger class, which tests the chip at 1080p first", async () => {
    const lots: Behaviour[] = [{}, { chip: "fail" }, { chip: "no_device" }, { chip: "busy" }];
    for (const behaviour of lots)
      for (const sizeClass of SIZE_CLASSES) {
        __resetChipTests();
        const h = harness([nvidia, amd], behaviour);
        h.storage.set(CHIP_PREF_KEY, "off");
        await findChip(sizeClass, { allowRun: true }, h.deps);
        expect(h.calls, `${JSON.stringify(behaviour)} ${sizeClass}`).toEqual([]);
      }
  });

  it("is not Off for a value that is not exactly Off: a damaged entry reads as Auto and the chip is tested", async () => {
    for (const damaged of ["OFF", "Off", " off", "true", "1", "{}", "off\u0000", ""]) {
      __resetChipTests();
      const h = harness([amd]);
      h.storage.set(CHIP_PREF_KEY, damaged);
      await findChip("hd", { allowRun: true }, h.deps);
      expect(h.calls.length > 0, JSON.stringify(damaged)).toBe(true);
    }
  });

  it("leaves the chip row, the encoder choice and the command on the processor: nothing is looked up for a person who asked for Fast either", async () => {
    const h = harness([amd]);
    const lookup: typeof findChip = (sizeClass, options) => findChip(sizeClass, options, h.deps);
    // The control: the same long project on the same PC with the switch on Auto is given the chip.
    const auto = await decideExportEncoder(
      { request: "auto", workload: WORKLOAD, settings: {}, history: [] },
      lookup,
    );
    expect(auto.facts.encoder).toBe("amd");
    expect(auto.showRow).toBe(true);
    // And so is a short one: a chip that passed is used whatever the length, so the switch is the only thing that keeps it away.
    const SHORT = { ...WORKLOAD, durationSeconds: 5 };
    const shortAuto = await decideExportEncoder(
      { request: "auto", workload: SHORT, settings: {}, history: [] },
      lookup,
    );
    expect(shortAuto.facts.encoder).toBe("amd");
    expect(shortAuto.showRow).toBe(true);
    __resetChipTests();
    h.calls.length = 0;
    h.storage.clear();
    h.storage.set(CHIP_PREF_KEY, "off");
    for (const workload of [WORKLOAD, SHORT])
      for (const request of ["auto", "fast"] as const) {
        const decision = await decideExportEncoder(
          { request, workload, settings: {}, history: [] },
          lookup,
        );
        const which = `${request} ${workload.durationSeconds} s`;
        expect(decision.facts.encoder, which).toBe("x264");
        expect(decision.chip, which).toBeUndefined();
        expect(decision.mode, which).toBe("quality");
        expect(decision.showRow, which).toBe(false);
        expect(decision.facts.adapter, which).toBeUndefined();
      }
    expect(h.calls).toEqual([]);
  });
});

// The real PC's side: the lookup with no stand-in dependencies reads the person's choice from the app's own storage and
// runs its test through `runCapabilityProbe`, which is what a spy on that one function sees.
describe("on the real wiring", () => {
  const store = new Map<string, string>();
  const probe = vi.mocked(runCapabilityProbe);
  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
    const scripted = harness([amd]);
    probe.mockReset();
    probe.mockImplementation((args, options) => scripted.deps.probe(args, options));
    vi.mocked(resolveExportResources).mockReset();
    vi.mocked(resolveExportResources).mockResolvedValue({
      total_memory_bytes: null,
      available_memory_bytes: null,
      scratch_free_bytes: null,
      destination_free_bytes: null,
      budgets: { memoryBytes: null, temporaryBytes: null, executionSeconds: null },
      adapters: [amd],
    });
  });

  const chipCalls = () =>
    probe.mock.calls.filter(([, options]) => options.kind.startsWith("chip-test"));

  it("sees a chip test through runCapabilityProbe while the switch is Auto", async () => {
    const found = await findChip("hd", { allowRun: true });
    expect(found.chip?.maker).toBe("amd");
    expect(chipCalls().length).toBeGreaterThan(0);
  });

  it("sees no call of the chip's kind while the switch is Off, and the chip is not found", async () => {
    store.set(CHIP_PREF_KEY, "off");
    expect(await findChip("hd", { allowRun: true })).toEqual({ chip: null, events: [] });
    expect(await findChip("uhd", { allowRun: true })).toEqual({ chip: null, events: [] });
    expect(await findChip("uhd60", { allowRun: true })).toEqual({ chip: null, events: [] });
    expect(probe).not.toHaveBeenCalled();
  });

  it("sees no call of the chip's kind from the encoder decision either, for a long project the chip would have been chosen for", async () => {
    store.set(CHIP_PREF_KEY, "off");
    const decision = await decideExportEncoder({
      request: "auto",
      workload: WORKLOAD,
      settings: {},
      history: [],
    });
    expect(decision.facts.encoder).toBe("x264");
    expect(chipCalls()).toEqual([]);
  });
});
