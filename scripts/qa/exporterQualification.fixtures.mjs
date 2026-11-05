// Raw evidence a qualified promise attempt records, for the consumer tests. Verdict logic lives in
// exporterQualification.mjs; a fixture here supplies measurements and never a verdict.

// What the product shows, as one native message, when it expects an export to take a long time and nothing like it has been exported on
// this PC yet (a cold export): its time is a rough guess from the size of the video. Built by src/timeline/exportQuestions.ts and
// pinned to its output by exportQuestions.test.ts, so a change of those words fails there instead of being found at push time.
export const REAL_COLD_MESSAGE = [
  "This export will take a long time",
  "This export is expected to take a long time.",
  "Estimated time: about 25 min (a rough guess from the size of the video: nothing like it has been exported on this PC yet)",
  "Lowering the resolution or exporting a smaller section makes it faster. Cancel to change the settings.",
  "Continue?",
].join("\n\n");

// The same question once earlier exports on this PC have been measured: the time is a measurement, not a guess.
export const REAL_MEASURED_MESSAGE = [
  "This export will take a long time",
  "This export is expected to take a long time.",
  "Estimated time: about 25 min (from earlier exports on this PC)",
  "Lowering the resolution or exporting a smaller section makes it faster. Cancel to change the settings.",
  "Continue?",
].join("\n\n");

// The payload allowance the native Workspace reported before a real Windows promise export (payload less held entries).
export const REAL_ALLOWANCE_BYTES = 17_998_794_382;
export const REAL_CAPTION_SAMPLES = [0, 270];

// Measured by the real native exporter on Windows (2026-10-20): faithful renders of a phone clip (rotation -90) and a
// NASA web clip, with the wrong-orientation controls that the harness compares against.
export const REAL_PHONE_PICTURES = [
  { at: 0.15, sourceError: 0.7074, blankError: 75.2896, controlError: 59.8511, control: "rotation-ignored" },
  { at: 0.75, sourceError: 0.6289, blankError: 75.6859, controlError: 60.1283, control: "rotation-ignored" },
  { at: 2, sourceError: 2.5795, blankError: 77.0152, controlError: 60.9888, control: "rotation-ignored" },
];
export const REAL_WEB_PICTURES = [
  { at: 0.15, sourceError: 0.4526, blankError: 17.8119, controlError: 16.459, control: "vertical-flip" },
  { at: 0.75, sourceError: 0.4376, blankError: 43.9001, controlError: 40.3975, control: "vertical-flip" },
  { at: 2, sourceError: 0.4491, blankError: 40.1687, controlError: 37.7007, control: "vertical-flip" },
];

export function qualifiedEvidence(declared) {
  const pass = (label) => ({ label, observed: structuredClone(declared), beforeBytes: REAL_ALLOWANCE_BYTES,
    samples: [{ atMs: 0, temporaryBytes: REAL_ALLOWANCE_BYTES - 5 }, { atMs: 250, temporaryBytes: REAL_ALLOWANCE_BYTES }],
    state: "done", error: null, publicationVerified: true, stagingCleaned: true, scratchCleaned: true });
  return {
    temporarySpaceEvidence: { version: 1, passes: [pass("cold"), pass("estimate")] },
    estimateEvidence: { version: 1,
      cold: { historySamples: 0, estimateSeconds: null, preflight: [{ message: REAL_COLD_MESSAGE, warning: false }] },
      estimate: { historySamples: 1, estimateSeconds: 9, actualSeconds: 8.1, preflight: [], readiness: "ready" } },
    // Caption pixel counts measured on a real Windows export of a 10 s phone clip with fading captions.
    captionSamples: REAL_CAPTION_SAMPLES,
    coldVerification: { captionSamples: REAL_CAPTION_SAMPLES },
    coldPass: { elapsedMs: 1000 },
  };
}
