// The real inputs of the honest estimate (see `routeEstimates.ts`): the switches, the speed check the app ran, the server's cut-offs, this PC's earlier exports and the pace log's storage. The
// two things that are not here yet are left as named seams: the source facts reader and the lean recipe decision are `null` and `undefined`, which the estimator prices as "unknown source"
// and "today's recipe", and the open timeline is read through a reader the app registers at start-up, so nothing here has to import the editor.
import { pcClass as serverCutoffs } from "../api/exportFlags";
import { EXPORT_SPEED_PROBE_ID } from "../platform/pcCheckProbe";
import { useExportJob } from "../store/exportJob";
import { EXPORT_SPEED_REVISION } from "./exportOptions";
import type { RouteEstimates, RouteEstimatesRequest } from "./exportTypes3c";
import { flags3cNow } from "./flags3c";
import type { Timeline } from "./model";
import { pcCheckService } from "./pcCheckHandle";
import {
  admissionEstimate,
  estimatesForRoutes,
  type AdmissionEstimate,
  type AdmissionInput,
  type RouteEstimatesDeps,
} from "./routeEstimates";

let timelineReader: (() => Timeline | null) | null = null;

/** The app registers how to read the timeline the person has open (`null` removes it): until then, and wherever it fails, a project is priced without its shape. */
export function setOpenTimelineReader(read: (() => Timeline | null) | null): void {
  timelineReader = read;
}

function hardwareCores(): number {
  try {
    return typeof navigator === "undefined" ? 0 : Number(navigator.hardwareConcurrency) || 0;
  } catch {
    return 0;
  }
}

function localStore(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function estimateDepsNow(over: Partial<RouteEstimatesDeps> = {}): RouteEstimatesDeps {
  return {
    flags: flags3cNow,
    openTimeline: () => timelineReader?.() ?? null,
    facts: null,
    recipeOf: undefined,
    speedCheck: () => pcCheckService()?.result(EXPORT_SPEED_PROBE_ID) ?? null,
    cutoffs: () => serverCutoffs(),
    cores: hardwareCores,
    history: () => useExportJob.getState().calibrations,
    storage: localStore,
    build: __ARTDADDY_RELEASE__,
    speedRevision: EXPORT_SPEED_REVISION,
    now: Date.now,
    ...over,
  };
}

/** The honest estimate of each way, from this PC as it is now: what the Export dialog and the route side's provider (`setRouteEstimatesProvider`) call. */
export function routeEstimatesHere(
  request: RouteEstimatesRequest,
  over: Partial<RouteEstimatesDeps> = {},
): RouteEstimates {
  return estimatesForRoutes(request, estimateDepsNow(over));
}

/** The honest estimate of an export as the plan fixed it, from this PC as it is now: what the admission door calls. */
export function admissionEstimateHere(
  input: AdmissionInput,
  over: Partial<RouteEstimatesDeps> = {},
): AdmissionEstimate | null {
  return admissionEstimate(input, estimateDepsNow(over));
}
