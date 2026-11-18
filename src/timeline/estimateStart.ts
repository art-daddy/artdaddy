// HELD OFF, NOT DELETED (owner decision 2026-11-18): part of the held export-time guess machinery (flags `estimate_v2`,
// `pc_check`, both in OFF_IN_THIS_BUILD in `api/exportFlags.ts`), kept for a later release, so do not remove it as unused;
// see docs/EXPORTER_ARCHITECTURE.md, "Deferred Export Speed And Settings Work".
//
// What the app registers once, when it starts, for the honest estimate: the way to read the project the person has open, the ONE provider the route side reads (`routeEstimatesNow`), and the
// PC check, which runs only in the desktop app (its probe is ffmpeg through the app's own process). Imported once from main.tsx and by nothing else, so no test starts any of it by accident.
import { platform } from "../platform";
import { useEditor } from "../store/editor";
import { routeEstimatesHere, setOpenTimelineReader } from "./estimateDeps";
import { startPcCheck } from "./pcCheckStart";
import { setRouteEstimatesProvider } from "./routeEstimatesPort";

let stopCheck: (() => void) | null = null;

/** Takes back everything this registered: a hot reload of a dev build, and the tests. */
export function stopEstimateStart(): void {
  stopCheck?.();
  stopCheck = null;
  setRouteEstimatesProvider(null);
  setOpenTimelineReader(null);
}

setOpenTimelineReader(() => useEditor.getState().timeline);
setRouteEstimatesProvider((request) => routeEstimatesHere(request));
if (platform.name === "tauri") {
  try {
    stopCheck = startPcCheck();
  } catch {
    // The app goes on without the check: every estimate is then a labelled guess.
  }
}
import.meta.hot?.dispose(stopEstimateStart);
