import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { linuxProfileVerified } from "./exporterLinuxMemory.mjs";
import { captionsFadedIn, estimateFailures, judgeSourcePictures, temporarySpaceFailures } from "./exporterQualification.mjs";

const repository = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."));
const library = JSON.parse(await readFile(path.join(repository, "scripts/qa/exporterPromiseCases.json"), "utf8"));
const directory = path.join(repository, "reports/qa/exporter");
const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
  if (error.code === "ENOENT") return [];
  throw error;
});
let invalidRecords = 0;
async function json(file) {
  try {
    if ((await stat(file)).size > 4 * 1024 * 1024) { invalidRecords++; return null; }
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") invalidRecords++;
    return null;
  }
}
const receipts = new Map();
for (const entry of entries.filter((entry) => entry.isFile() && /^memory-.*\.json$/.test(entry.name))) {
  const receipt = await json(path.join(directory, entry.name));
  if (receipt?.runId) receipts.set(receipt.runId, receipt);
}
const attempts = [];
let recoveredLegacyFailures = 0;
const temporaryRoots = [os.tmpdir(), ...(process.platform === "win32" ? [path.join(os.homedir(), "AppData/Local/Temp")] : [])];
async function historicalFailure(envelope) {
  if (envelope?.ok !== false || typeof envelope.root !== "string" || !path.basename(envelope.root).startsWith("artdaddy-export-native-")) return null;
  const parent = await stat(path.dirname(envelope.root), { bigint: true }).catch(() => null);
  let owned = false;
  for (const root of temporaryRoots) {
    const approved = await stat(root, { bigint: true }).catch(() => null);
    owned ||= !!parent && !!approved && parent.dev === approved.dev && parent.ino === approved.ino;
  }
  if (!owned) return null;
  const input = await json(path.join(envelope.root, "promise-input.json"));
  if (!input?.case?.id) return null;
  recoveredLegacyFailures++;
  return { caseId: input.case.id, kind: input.case.kind, profile: input.profile, platform: envelope.hardware?.platform,
    status: "failed", passed: false, artifactVerified: false, readiness: "unknown", elapsedMs: envelope.elapsedMs };
}
for (const entry of entries.filter((entry) => entry.isDirectory())) {
  let result = await json(path.join(directory, entry.name, "promise-library.json"));
  const envelope = await json(path.join(directory, entry.name, "report.json"));
  if (!result) result = await historicalFailure(envelope);
  if (!result) continue;
  const definition = library.cases.find((candidate) => candidate.id === result.caseId);
  const platform = result.platform ?? envelope?.hardware?.platform;
  if (!definition || !library.profiles[result.profile] || !library.platforms.includes(platform)) { invalidRecords++; continue; }
  const receipt = receipts.get(result.profileRunId);
  const kernelProfileVerified = platform === "win32" && !!receipt && receipt.scope === "windows-job-commit-pressure-simulation" && receipt.workload === "App" &&
    receipt.exitCode === 0 && receipt.configuredCommitLimitBytes > 0 &&
    receipt.configuredCommitLimitBytes <= library.profiles[result.profile].systemMemoryBytes;
  const host = result.hostProfileEvidence;
  const hostProfileVerified = ["darwin", "linux"].includes(platform) && host?.scope === "measured-host-memory" &&
    typeof host.runId === "string" && host.runId.length > 0 && host.runId === envelope?.identifier && host.platform === platform &&
    envelope?.hardware?.platform === platform && host.nodeTotalMemoryBytes === envelope.hardware.totalMemoryBytes &&
    host.nativeTotalMemoryBytes === envelope?.native?.resources?.total_memory_bytes &&
    [host.nodeTotalMemoryBytes, host.nativeTotalMemoryBytes].every((bytes) => Number.isSafeInteger(bytes) && bytes > 0 &&
      bytes <= library.profiles[result.profile].systemMemoryBytes);
  const cgroupProfileVerified = linuxProfileVerified(result, envelope, receipt, library.profiles[result.profile].systemMemoryBytes);
  const profileVerified = kernelProfileVerified || hostProfileVerified || cgroupProfileVerified;
  const exactDefinition = result.definition && ["width", "height", "fps", "durationSeconds", "visualClips", "videoLayers"]
    .every((key) => result.definition[key] === definition[key]);
  const video = result.encodedVideo;
  const complete = video?.width === definition.width && video?.height === definition.height && video?.fps === `${definition.fps}/1` &&
    video?.frames === Math.round(definition.durationSeconds * definition.fps) && result.projectFrames === video.frames;
  const withinSpeed = (elapsedMs) => result.profile === "8gb" || definition.speedFactor16gb === null ||
    Number.isFinite(elapsedMs) && elapsedMs <= definition.durationSeconds * definition.speedFactor16gb * 1000;
  // A promise line is exported cold and then again; both exports have to meet its speed line.
  const timing = withinSpeed(result.elapsedMs) && withinSpeed(result.coldPass?.elapsedMs);
  const currentTemporaryContract = Number.isSafeInteger(library.version) &&
    typeof library.temporarySpace?.scope === "string" && library.temporarySpace.scope.length > 0 &&
    result.version === library.version &&
    isDeepStrictEqual(result.temporarySpace, library.temporarySpace) &&
    isDeepStrictEqual(envelope?.native?.resources?.temporary_space, library.temporarySpace);
  // A recorded boolean is never evidence: both verdicts are re-derived from the raw measurements stored beside them.
  const temporarySpaceQualified = currentTemporaryContract && result.temporarySpaceQualified === true &&
    temporarySpaceFailures(library.temporarySpace, result.temporarySpaceEvidence).length === 0;
  const estimateProvided = result.estimateProvided === true && estimateFailures(result.estimateEvidence).length === 0;
  // The artifact flag is not evidence either: the recorded picture and caption measurements of BOTH exports are re-judged,
  // and whether a real source needs a picture proof comes from the library, never from the record.
  const realSource = library.sourceClasses[definition.source]?.realWorld === true;
  const outputProven = (pass) => (!realSource || judgeSourcePictures(pass?.sourcePictureProof).ok) &&
    (!definition.captions || captionsFadedIn(pass?.captionSamples));
  const outputEvidence = outputProven(result) && outputProven(result.coldVerification);
  const passed = definition.kind === "promise" && result.kind === "promise" && result.mode === "quality" && exactDefinition && complete &&
    envelope?.ok === true && result.passed === true && result.artifactVerified === true && result.publicationVerified === true &&
    result.stagingCleaned === true && result.scratchCleaned === true && result.sourceReady === true && outputEvidence &&
    temporarySpaceQualified && estimateProvided && profileVerified && timing;
  attempts.push({ caseId: definition.id, line: definition.line, kind: definition.kind, profile: result.profile, platform,
    passed, artifactVerified: result.artifactVerified === true, profileVerified, physical: result.physicalQualified === true,
    temporarySpaceQualified,
    temporarySpaceEvidenceKind: !currentTemporaryContract ? "legacy-or-mismatched-contract" :
      temporarySpaceQualified ? library.temporarySpace.scope : "unqualified",
    profileEvidenceKind: kernelProfileVerified ? "windows-kernel-commit" : cgroupProfileVerified ? "linux-kernel-cgroup-v2" :
      hostProfileVerified ? "measured-host-memory" : "unverified",
    readiness: result.status === "blocked-source" ? "not_ready" : ["ready", "not_ready"].includes(result.readiness) ? result.readiness : "unknown",
    blockedSource: result.status === "blocked-source", elapsedMs: Number.isFinite(result.elapsedMs) ? result.elapsedMs : null });
}
const rate = (successes, total) => total ? successes / total : null;
const rows = [];
for (const definition of library.cases) for (const profile of Object.keys(library.profiles)) for (const platform of library.platforms) {
  const observed = attempts.filter((attempt) => attempt.caseId === definition.id && attempt.profile === profile && attempt.platform === platform);
  const ready = observed.filter((attempt) => attempt.readiness === "ready");
  const physical = ready.filter((attempt) => attempt.physical);
  const source = library.sourceClasses[definition.source];
  const sourceAvailable = !!source.path && !!(await stat(path.join(repository, source.path)).catch(() => null));
  const status = observed.some((attempt) => attempt.passed) ? "verified-result" : observed.length ? "attempted-unqualified"
    : source.realWorld && !sourceAvailable ? "blocked-source" : definition.kind === "pilot" ? "pilot-not-run" : "deferred";
  rows.push({ caseId: definition.id, line: definition.line, kind: definition.kind, profile, platform, status,
    attempts: observed.length, readyAttempts: ready.length, passed: observed.filter((attempt) => attempt.passed).length,
    artifactSuccesses: observed.filter((attempt) => attempt.artifactVerified).length,
    profileVerifiedAttempts: observed.filter((attempt) => attempt.profileVerified).length,
    profileEvidenceKinds: [...new Set(observed.map((attempt) => attempt.profileEvidenceKind))].sort(),
    temporarySpaceQualifiedAttempts: observed.filter((attempt) => attempt.temporarySpaceQualified).length,
    temporarySpaceEvidenceKinds: [...new Set(observed.map((attempt) => attempt.temporarySpaceEvidenceKind))].sort(),
    unknownReadiness: observed.filter((attempt) => attempt.readiness === "unknown").length,
    sourceBlockedAttempts: observed.filter((attempt) => attempt.blockedSource).length,
    overallPassRate: rate(observed.filter((attempt) => attempt.passed).length, observed.length),
    readyPassRate: rate(ready.filter((attempt) => attempt.passed).length, ready.length),
    softwareQualified: definition.kind === "promise" && ready.length > 0 && rate(ready.filter((attempt) => attempt.passed).length, ready.length) >= 0.99,
    physicalQualified: definition.kind === "promise" && physical.length > 0 && rate(physical.filter((attempt) => attempt.passed).length, physical.length) >= 0.99 });
}
const promiseRows = rows.filter((row) => row.kind === "promise");
const promiseAttempts = attempts.filter((attempt) => attempt.kind === "promise");
const readyAttempts = promiseAttempts.filter((attempt) => attempt.readiness === "ready");
console.log(JSON.stringify({ version: 3, libraryVersion: library.version, temporarySpace: library.temporarySpace,
  scope: "controlled-export-promise-library-not-population-reliability",
  plannedVariants: promiseRows.length, attemptedVariants: promiseRows.filter((row) => row.attempts > 0).length,
  overallAttempts: promiseAttempts.length, overallPassed: promiseAttempts.filter((attempt) => attempt.passed).length,
  overallPassRate: rate(promiseAttempts.filter((attempt) => attempt.passed).length, promiseAttempts.length),
  readyAttempts: readyAttempts.length, readyPassRate: rate(readyAttempts.filter((attempt) => attempt.passed).length, readyAttempts.length),
  pilotAttempts: attempts.filter((attempt) => attempt.kind === "pilot").length,
  softwareLibraryQualified: promiseRows.length > 0 && promiseRows.every((row) => row.softwareQualified),
  physicalLibraryQualified: promiseRows.length > 0 && promiseRows.every((row) => row.physicalQualified),
  invalidRecords, recoveredLegacyFailures, rows }, null, 2));