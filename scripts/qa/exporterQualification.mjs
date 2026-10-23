import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { isDeepStrictEqual } from "node:util";

// Pure verdicts shared by the native harness (which records raw measurements) and the report consumer (which
// re-derives every verdict from those measurements instead of trusting a recorded boolean).

// The SHA-256 of a file of any size, read as a stream. Node refuses to read a file of 2 GiB or more into one Buffer
// (ERR_FS_FILE_TOO_LARGE), and a two-hour export is 3.6 GB: a verification that holds the delivered file in memory
// cannot judge the longest promise line at all, whatever the product did.
export async function sha256OfFile(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename, { highWaterMark: 4 * 1024 * 1024 })) hash.update(chunk);
  return hash.digest("hex");
}

// Both picture discriminators ("closer than a blank frame", "closer than the wrong-orientation control") collapse
// on a near-black reference: its blank error is about zero and a flipped black frame is still black. Such a sample
// can only show that the output is also near-black, so it is judged by closeness alone.
export const NEAR_BLANK_LEVEL = 8;
// Faithful 1080p phone and web renders measured 0.44-2.58 mean absolute level error against their reference frame;
// the wrong-orientation controls measured 16-61.
export const NEAR_EXACT_ERROR = 4;
export const MIN_INFORMATIVE_SAMPLES = 2;

export const PICTURE_MESSAGES = {
  "no-samples": "Real-source picture proof has no samples",
  "malformed-sample": "Real-source picture sample is not a finite measurement",
  "blank-frame": "Real-source picture is missing or no closer than a blank frame",
  "wrong-control": "Real-source output does not follow the mapped source picture",
  "dark-reference-mismatch": "Real-source output differs from a near-black reference frame",
  "too-few-informative-frames": "Real-source clip shows too few informative frames at the sampled times to prove the mapped picture",
};

export function judgeSourcePictures(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return { ok: false, informativeSamples: 0, failures: [{ rule: "no-samples" }] };
  const failures = [];
  let informativeSamples = 0;
  for (const sample of samples) {
    const { at, sourceError, blankError, controlError } = sample ?? {};
    if (![sourceError, blankError, controlError].every((value) => Number.isFinite(value) && value >= 0)) {
      failures.push({ at, rule: "malformed-sample" });
      continue;
    }
    if (blankError >= NEAR_BLANK_LEVEL) {
      informativeSamples++;
      if (!(sourceError < blankError)) failures.push({ at, rule: "blank-frame" });
      if (!(sourceError < controlError)) failures.push({ at, rule: "wrong-control" });
    } else if (sourceError > NEAR_EXACT_ERROR) failures.push({ at, rule: "dark-reference-mismatch" });
  }
  if (informativeSamples < MIN_INFORMATIVE_SAMPLES) failures.push({ rule: "too-few-informative-frames" });
  return { ok: failures.length === 0, informativeSamples, failures };
}

export function describePictureFailures(verdict) {
  return verdict.failures.map(({ at, rule }) => `${PICTURE_MESSAGES[rule]}${at === undefined ? "" : ` (at ${at}s)`}`).join("; ");
}

// Caption pixel counts at the two sample times: nothing painted early, visibly painted once the fade has run.
export function captionsFadedIn(samples) {
  return Array.isArray(samples) && samples.length === 2 && samples.every((count) => Number.isSafeInteger(count) && count >= 0) &&
    samples[1] > 0 && samples[1] > samples[0];
}

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

// A promise attempt exports its workload twice in one app profile: a cold export with no local history, then the
// export the user sees once a comparable measurement exists (the one that shows the time estimate).
export const REQUIRED_PASSES = ["cold", "estimate"];

export function declaredContractFailures(declared) {
  if (!declared || typeof declared !== "object" || Array.isArray(declared)) return ["declared temporary-space contract is missing"];
  const failures = [];
  if (typeof declared.scope !== "string" || declared.scope.length === 0) failures.push("declared contract has no scope");
  if (![declared.totalBytes, declared.payloadBytes, declared.infrastructureBytes, declared.entryLimit].every(isCount) ||
    declared.payloadBytes === 0 || declared.entryLimit === 0) failures.push("declared contract sizes are not usable counts");
  else if (declared.payloadBytes + declared.infrastructureBytes !== declared.totalBytes) failures.push("declared contract total is not payload plus infrastructure");
  return failures;
}

// Evidence is the raw per-pass record: the native contract, the payload allowance before the export, repeated
// allowance samples after settlement, and the export outcome. Every verdict below is recomputed from those values.
export function temporarySpaceFailures(declared, evidence) {
  const failures = declaredContractFailures(declared);
  if (!evidence || evidence.version !== 1 || !Array.isArray(evidence.passes)) return [...failures, "no recorded temporary-space evidence"];
  if (!isDeepStrictEqual(evidence.passes.map((pass) => pass?.label), REQUIRED_PASSES)) failures.push(`evidence must hold the ${REQUIRED_PASSES.join(" and ")} passes in order`);
  for (const pass of evidence.passes) {
    const name = String(pass?.label);
    if (!isDeepStrictEqual(pass?.observed, declared)) failures.push(`${name}: native contract differs from the declared contract`);
    const before = pass?.beforeBytes;
    if (!isCount(before) || before === 0 || before > declared?.payloadBytes) failures.push(`${name}: allowance before the export is outside the declared payload`);
    const after = Array.isArray(pass?.samples) ? pass.samples.at(-1)?.temporaryBytes : undefined;
    if (!isCount(after)) failures.push(`${name}: allowance was not measured after settlement`);
    else if (after > declared?.payloadBytes) failures.push(`${name}: allowance after settlement exceeds the declared payload`);
    else if (isCount(before) && after < before) failures.push(`${name}: allowance did not return after settlement (${before - after} bytes held)`);
    if (pass?.state !== "done" || (pass.error !== null && pass.error !== undefined)) failures.push(`${name}: export did not finish cleanly`);
    for (const key of ["publicationVerified", "stagingCleaned", "scratchCleaned"])
      if (pass?.[key] !== true) failures.push(`${name}: ${key} is not proven`);
  }
  return failures;
}

const ESTIMATE = /Estimated encoding and saving time: about (\d+) minute\(s\)/;

// A confirmation is the only place the product prints a time estimate. When it prints one it must be the measured
// estimate or an honest "unknown"; "unknown" is never a qualifying outcome for a repeated export.
export function estimateFacts(preflight) {
  const messages = Array.isArray(preflight) ? preflight.map((entry) => (typeof entry?.message === "string" ? entry.message : "")) : [];
  const single = messages.length === 1 ? messages[0] : "";
  const match = ESTIMATE.exec(single);
  const minutes = match ? Number(match[1]) : null;
  return { provided: minutes !== null && minutes >= 1, minutes, unknownStated: single.includes("Estimated time: unknown") };
}

const isPositive = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;

// The product asks nothing when every estimate is known and fits, so a repeated export cannot be required to show
// an estimate sentence. What it must do is have a measured estimate from its own history and then either say it in
// the confirmation it chose to raise or proceed silently with storage ready. A cold export must say "unknown".
export function estimateFailures(evidence) {
  if (!evidence || evidence.version !== 1 || !evidence.cold || !evidence.estimate) return ["no recorded estimate evidence"];
  const failures = [];
  const { cold, estimate } = evidence;
  if (cold.historySamples !== 0 || cold.estimateSeconds !== null) failures.push("cold: the export was not cold, comparable local history already existed");
  if (!Array.isArray(cold.preflight) || cold.preflight.length !== 1) failures.push("cold: the user was not shown exactly one confirmation");
  else {
    const facts = estimateFacts(cold.preflight);
    if (facts.provided) failures.push("cold: a measured estimate was claimed without comparable local history");
    if (!facts.unknownStated) failures.push("cold: the confirmation did not state that the time is unknown");
  }
  if (!Number.isSafeInteger(estimate.historySamples) || estimate.historySamples < 1) failures.push("estimate: no comparable local history existed");
  if (!isPositive(estimate.estimateSeconds)) failures.push("estimate: the product produced no measured estimate from its history");
  if (!isPositive(estimate.actualSeconds)) failures.push("estimate: the actual export time was not measured");
  const confirmations = Array.isArray(estimate.preflight) ? estimate.preflight.length : -1;
  if (confirmations === 0) {
    if (estimate.readiness !== "ready") failures.push("estimate: no confirmation was shown but storage readiness was not established");
  } else if (confirmations === 1) {
    if (!estimateFacts(estimate.preflight).provided) failures.push("estimate: the confirmation hid the measured estimate the product had");
  } else failures.push("estimate: the user was shown more than one confirmation");
  return failures;
}

// The wait for a native run's outcome: a fixed allowance for launch, crash recovery and the compiled-engine regression, plus
// every export of the line at its slowest accepted speed, twice over. A slow or failing run must be observed and reported,
// not cut off by a timeout that hides the result. A run with no promise line (the CI recovery runs) keeps the fixed allowance.
export const BASE_OUTCOME_BUDGET_MS = 12 * 60_000;
export function outcomeBudgetMs(definition) {
  const positive = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  const seconds = positive(definition?.durationSeconds);
  if (!seconds) return BASE_OUTCOME_BUDGET_MS;
  const exports = definition?.kind === "promise" ? 2 : 1;
  const speed = positive(definition?.speedFactor16gb) || 4;
  return BASE_OUTCOME_BUDGET_MS + Math.ceil(exports * seconds * speed * 2 * 1000);
}
