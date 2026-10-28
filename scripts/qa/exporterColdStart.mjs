// The one definition of "this export is cold": the product has nothing to estimate from. The harness page checks it before it spends
// minutes encoding, and the report consumer re-derives the verdict from the recorded facts; neither carries its own copy.
// Importable from the browser page, so it must stay free of Node modules.

/** `start` is what the product's own estimator saw just before the cold export: `{ historySamples, estimateSeconds }`. */
export function coldStartFailure(start) {
  if (!start || typeof start !== "object") return "there is no record of the history the cold export started with";
  if (start.historySamples !== 0 || start.estimateSeconds !== null) return "the export was not cold, comparable local history already existed";
  return null;
}
