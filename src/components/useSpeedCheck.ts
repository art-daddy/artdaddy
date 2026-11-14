// The PC's speed check as the Export dialog sees it: whether it is running, what it found and when, and the one action it offers (run it again). The dialog never waits for the check and never starts it by opening: this only reads what the
// check service says and re-reads when it changes. No service (a page without the app), the switch off, or a service that throws is "no check": nothing is shown and nothing is offered.
import { useSyncExternalStore } from "react";

import { EXPORT_SPEED_PROBE_ID } from "../platform/pcCheckProbe";
import { flags3cNow } from "../timeline/flags3c";
import type { PcClass } from "../timeline/exportTypes3c";
import { pcCheckService } from "../timeline/pcCheckHandle";

export interface SpeedCheckView {
  /** A check service exists and the switch is on. */
  available: boolean;
  running: boolean;
  pcClass: PcClass;
  /** When the check that is held was made (ms), or null for none. */
  madeAt: number | null;
  /** Changes whenever anything the dialog shows about the check changes. */
  key: string;
}

const OFF: SpeedCheckView = {
  available: false,
  running: false,
  pcClass: "unknown",
  madeAt: null,
  key: "off",
};

function read(): SpeedCheckView {
  try {
    const service = pcCheckService();
    if (!service || !flags3cNow().pc_check) return OFF;
    const record = service.result(EXPORT_SPEED_PROBE_ID);
    const running = service.status().running === EXPORT_SPEED_PROBE_ID;
    const pcClass = service.pcClass();
    const madeAt = record ? record.atMs : null;
    return {
      available: true,
      running,
      pcClass,
      madeAt,
      key: `${running}|${pcClass}|${madeAt}|${record?.outcome ?? ""}`,
    };
  } catch {
    return OFF;
  }
}

function subscribe(onChange: () => void): () => void {
  try {
    return pcCheckService()?.subscribe(onChange) ?? (() => undefined);
  } catch {
    return () => undefined;
  }
}

/** Runs the check now, for a person who asked: it takes the one slot as soon as it is free and is skipped, never queued for later, if an export or a look is on. */
export function checkThisPcAgain(): void {
  try {
    pcCheckService()?.requestRun({ reason: "dialog", force: true, id: EXPORT_SPEED_PROBE_ID });
  } catch {
    // Nothing was asked; the line stays as it was.
  }
}

export function useSpeedCheck(): SpeedCheckView {
  // The subscription only tells React to look again; what is shown is read fresh on every render.
  useSyncExternalStore(
    subscribe,
    () => read().key,
    () => OFF.key,
  );
  return read();
}
