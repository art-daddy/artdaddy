// Starts the PC check in the app: the one service (`platform/pcCheck.ts`) with its real inputs, the speed probe registered, the service made known to the rest of the app, the chip test's turn in its
// one slot, and the six signals the service decides from, read from the app's own sources. Everything here fails soft: a piece that cannot start leaves the check out and the app as it was.
import { exportFlag, pcClass as serverCutoffs } from "../api/exportFlags";
import { runCapabilityProbe } from "../platform/host";
import {
  createPcCheckService,
  type PcCheckDeps,
  type PcCheckFiles,
  type PcCheckService,
} from "../platform/pcCheck";
import { checkFiles } from "../platform/pcCheckFiles";
import { exportSpeedProbe } from "../platform/pcCheckProbe";
import { useEditor } from "../store/editor";
import { backgroundWorkActive, subscribeBackgroundWork } from "../tools/workGate";
import { setChipTestGate } from "./chipTest";
import { exportAskedNow, subscribeExportAsk } from "./exportAsk";
import { listExportRecords, subscribeExports } from "./exportQueue";
import { flags3cNow } from "./flags3c";
import { startPcCheckSignals } from "./pcCheckController";
import { setPcCheckService, pcCheckService } from "./pcCheckHandle";
import { observeInput, observePlayback } from "./pcCheckSignals";
import type { StorageLike } from "./pcClass";

export interface PcCheckStartOptions {
  /** Replaces pieces of the service's own dependencies (the tests replace the probe and the files; the app replaces nothing). */
  service?: Partial<PcCheckDeps>;
}

function storageOrNull(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function hardwareCores(): number {
  try {
    return typeof navigator === "undefined" ? 1 : Number(navigator.hardwareConcurrency) || 1;
  } catch {
    return 1;
  }
}

/** True while the battery reports discharging, null when the page cannot tell. The page's battery answer comes asynchronously, once, and is live after that. */
function batteryHint(): () => boolean | null {
  let battery: { charging?: unknown } | null = null;
  try {
    const nav = navigator as unknown as { getBattery?: () => Promise<{ charging?: unknown }> };
    void nav
      .getBattery?.()
      .then((found) => (battery = found))
      .catch(() => undefined);
  } catch {
    // A page with no battery interface cannot tell.
  }
  return () => (battery && typeof battery.charging === "boolean" ? !battery.charging : null);
}

/** The check's folder in the app's cache, through the app's own file layer (loaded when first used: nothing here runs outside the desktop app). */
function appFiles(): PcCheckFiles {
  const fs = async () => new (await import("../tools/tauri")).TauriFs();
  return checkFiles(
    {
      mkdir: async (path) => (await fs()).mkdir(path),
      remove: async (path) => (await fs()).remove(path),
      rename: async (from, to) => (await fs()).rename(from, to),
      stat: async (path) => (await fs()).stat(path),
    },
    async () => (await import("../tools/dataRoot")).appCacheRoot(),
  );
}

/** A project is open for the check when its editor has loaded it: a project that is still loading is reading its files. */
function projectOpenNow(): boolean {
  const editor = useEditor.getState();
  return editor.projectId !== null && editor.timeline !== null;
}

/** The open project's playhead in seconds, or null when none is open. */
function playheadNow(): number | null {
  const editor = useEditor.getState();
  return editor.projectId !== null ? editor.playhead : null;
}

/** Starts the check and returns how to stop it: the service is disposed (a run under way is stopped and stores nothing), and what it registered with the rest of the app is taken back. */
export function startPcCheck(options: PcCheckStartOptions = {}): () => void {
  const now = (): number => Date.now();
  const service: PcCheckService = createPcCheckService({
    now,
    storage: storageOrNull(),
    build: __ARTDADDY_RELEASE__,
    cores: hardwareCores(),
    flags: () => ({ pc_check: flags3cNow().pc_check }),
    cutoffs: () => serverCutoffs(),
    batteryDischarging: batteryHint(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    probe: (args, probeOptions) => runCapabilityProbe(args, probeOptions),
    files: appFiles(),
    ...options.service,
  });
  service.registerProbe(exportSpeedProbe());
  setPcCheckService(service);
  setChipTestGate((fn) => service.withSlot("chip-test", fn));

  let push: () => void = () => undefined;
  const target = typeof window === "undefined" ? null : window;
  const input = observeInput(target, now, () => push());
  const playback = observePlayback({
    target: typeof document === "undefined" ? null : document,
    playhead: playheadNow,
    now,
  });
  const signals = startPcCheckSignals({
    service,
    read: {
      exportBusy: () =>
        listExportRecords().some(
          (record) => record.state === "queued" || record.state === "running",
        ),
      exportAsked: exportAskedNow,
      playing: playback.playing,
      lookOrSpeechJob: backgroundWorkActive,
      projectOpen: projectOpenNow,
      lastInputAtMs: input.lastInputAtMs,
      enabled: () => exportFlag("pc_check") !== false,
    },
    listen: [subscribeExports, subscribeExportAsk, subscribeBackgroundWork],
    now,
    setBeat: (fn, ms) => setInterval(fn, ms),
    clearBeat: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  });
  push = signals.push;

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    signals.stop();
    input.dispose();
    playback.dispose();
    service.dispose();
    if (pcCheckService() === service) setPcCheckService(null);
    setChipTestGate(null);
  };
}
