import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import fc from "fast-check";
import { createServer } from "vite";
import {
  BASE_OUTCOME_BUDGET_MS, MIN_INFORMATIVE_SAMPLES, NEAR_BLANK_LEVEL, NEAR_EXACT_ERROR, REQUIRED_PASSES,
  captionsFadedIn, describePictureFailures, estimateFacts, estimateFailures, judgeSourcePictures, outcomeBudgetMs, temporarySpaceFailures,
} from "./exporterQualification.mjs";
import { qaServerOptions } from "./exporterVite.mjs";
import { startRecovery } from "./exporterRecovery.mjs";
import { REAL_ALLOWANCE_BYTES, REAL_CAPTION_SAMPLES, REAL_COLD_MESSAGE, REAL_PHONE_PICTURES, REAL_WEB_PICTURES } from "./exporterQualification.fixtures.mjs";

const library = JSON.parse(await readFile(new URL("./exporterPromiseCases.json", import.meta.url), "utf8"));
const declared = library.temporarySpace;
const rules = (verdict) => verdict.failures.map((failure) => failure.rule).sort();

const REAL_PHONE = REAL_PHONE_PICTURES;
const REAL_WEB = REAL_WEB_PICTURES;
// The first sampled frame of the earlier NASA clip was pure black, which made "closer than a blank frame" (0 < 0)
// unsatisfiable for any export, however faithful.
const BLACK_LEAD_IN = { at: 0.15, sourceError: 0.02, blankError: 0, controlError: 0 };

test("faithful real phone and web renders are accepted", () => {
  for (const samples of [REAL_PHONE, REAL_WEB]) {
    const verdict = judgeSourcePictures(samples);
    assert.deepEqual(verdict.failures, []);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.informativeSamples, 3);
  }
});

test("a faithful render of a clip with a black lead-in is accepted, and a wrong picture over black is not", () => {
  assert.equal(judgeSourcePictures([BLACK_LEAD_IN, REAL_WEB[1], REAL_WEB[2]]).ok, true);
  for (const wrong of [255, 128, NEAR_EXACT_ERROR + 0.5]) {
    const verdict = judgeSourcePictures([{ ...BLACK_LEAD_IN, sourceError: wrong }, REAL_WEB[1], REAL_WEB[2]]);
    assert.equal(verdict.ok, false);
    assert.deepEqual(rules(verdict), ["dark-reference-mismatch"]);
  }
});

test("a render that lost its picture or its orientation is rejected whatever the other frames show", () => {
  const lost = judgeSourcePictures([REAL_PHONE[0], { ...REAL_PHONE[1], sourceError: REAL_PHONE[1].blankError }, REAL_PHONE[2]]);
  assert.equal(lost.ok, false);
  assert.ok(rules(lost).includes("blank-frame"));
  const blankOnly = judgeSourcePictures([REAL_PHONE[0], { at: 0.75, sourceError: 30, blankError: 20, controlError: 60 }, REAL_PHONE[2]]);
  assert.deepEqual(rules(blankOnly), ["blank-frame"]);
  const rotationIgnored = judgeSourcePictures([REAL_PHONE[0], REAL_PHONE[1], { ...REAL_PHONE[2], sourceError: REAL_PHONE[2].controlError }]);
  assert.deepEqual(rules(rotationIgnored), ["wrong-control"]);
  assert.match(describePictureFailures(rotationIgnored), /does not follow the mapped source picture \(at 2s\)/);
});

test("a clip that is dark at every sampled time cannot prove a picture, however close the black output is", () => {
  const dark = [0.15, 0.75, 2].map((at) => ({ at, sourceError: 0, blankError: 0, controlError: 0 }));
  const verdict = judgeSourcePictures(dark);
  assert.equal(verdict.ok, false);
  assert.deepEqual(rules(verdict), ["too-few-informative-frames"]);
  const oneLit = judgeSourcePictures([dark[0], dark[1], REAL_WEB[2]]);
  assert.equal(oneLit.ok, false);
  assert.equal(oneLit.informativeSamples, MIN_INFORMATIVE_SAMPLES - 1);
});

test("missing, empty and non-finite measurements never pass", () => {
  for (const bad of [undefined, null, [], "samples", {}]) assert.equal(judgeSourcePictures(bad).ok, false);
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, "0.4", null, undefined]) {
    for (const key of ["sourceError", "blankError", "controlError"]) {
      const verdict = judgeSourcePictures([{ ...REAL_WEB[0], [key]: value }, REAL_WEB[1], REAL_WEB[2]]);
      assert.equal(verdict.ok, false, `${key}=${String(value)}`);
      assert.ok(rules(verdict).includes("malformed-sample"));
    }
  }
});

test("the dark-frame boundary is the documented constant on both sides", () => {
  const sample = (blankError, sourceError) => ({ at: 0.15, sourceError, blankError, controlError: 0 });
  assert.equal(judgeSourcePictures([sample(NEAR_BLANK_LEVEL - 0.001, NEAR_EXACT_ERROR), REAL_WEB[1], REAL_WEB[2]]).ok, true);
  assert.equal(judgeSourcePictures([sample(NEAR_BLANK_LEVEL - 0.001, NEAR_EXACT_ERROR + 0.001), REAL_WEB[1], REAL_WEB[2]]).ok, false);
  // Exactly at the level the frame is informative again, so the strict rules apply (and a zero control cannot be beaten).
  assert.deepEqual(rules(judgeSourcePictures([sample(NEAR_BLANK_LEVEL, 0.5), REAL_WEB[1], REAL_WEB[2]])), ["wrong-control"]);
});

const at = fc.constantFrom(0.15, 0.75, 2);
const faithfulInformative = fc.tuple(fc.double({ min: NEAR_BLANK_LEVEL, max: 255, noNaN: true }), fc.double({ min: 1, max: 255, noNaN: true }),
  fc.double({ min: 0, max: 0.99, noNaN: true }), at).map(([blankError, controlError, fraction, time]) =>
  ({ at: time, sourceError: Math.min(blankError, controlError) * fraction, blankError, controlError }));
const faithfulDark = fc.tuple(fc.double({ min: 0, max: NEAR_BLANK_LEVEL - 0.01, noNaN: true }), fc.double({ min: 0, max: 255, noNaN: true }),
  fc.double({ min: 0, max: NEAR_EXACT_ERROR, noNaN: true }), at).map(([blankError, controlError, sourceError, time]) =>
  ({ at: time, sourceError, blankError, controlError }));
const faithfulSet = fc.tuple(fc.array(faithfulInformative, { minLength: MIN_INFORMATIVE_SAMPLES, maxLength: 4 }), fc.array(faithfulDark, { maxLength: 2 }))
  .chain(([lit, dark]) => fc.shuffledSubarray([...lit, ...dark], { minLength: lit.length + dark.length, maxLength: lit.length + dark.length }));
const anySample = fc.record({ at, sourceError: fc.double({ min: 0, max: 255, noNaN: true }),
  blankError: fc.double({ min: 0, max: 255, noNaN: true }), controlError: fc.double({ min: 0, max: 255, noNaN: true }) });

test("property: every faithful set is accepted, in any order", () => {
  fc.assert(fc.property(faithfulSet, (samples) => {
    assert.deepEqual(judgeSourcePictures(samples).failures, []);
    assert.deepEqual(judgeSourcePictures([...samples].reverse()).failures, []);
  }), { numRuns: 200 });
});

test("property: corrupting any one informative sample is rejected for the rule it breaks", () => {
  fc.assert(fc.property(faithfulSet, fc.nat(), fc.constantFrom("blank-frame", "wrong-control"), (samples, pick, rule) => {
    const lit = samples.map((sample, index) => ({ sample, index })).filter(({ sample }) => sample.blankError >= NEAR_BLANK_LEVEL);
    const target = lit[pick % lit.length];
    const corrupted = samples.map((sample, index) => index !== target.index ? sample :
      { ...sample, sourceError: rule === "blank-frame" ? sample.blankError + 0.5 : Math.max(sample.controlError, sample.sourceError) });
    const verdict = judgeSourcePictures(corrupted);
    assert.equal(verdict.ok, false);
    assert.ok(rules(verdict).includes(rule), `${rule} missing from ${rules(verdict)}`);
  }), { numRuns: 200 });
});

test("property: the verdict does not depend on sample order, and a closer render never adds a failure", () => {
  fc.assert(fc.property(fc.array(anySample, { minLength: 1, maxLength: 5 }), fc.nat(), (samples, pick) => {
    assert.deepEqual(rules(judgeSourcePictures(samples)), rules(judgeSourcePictures([...samples].reverse())));
    const index = pick % samples.length;
    const before = judgeSourcePictures(samples).failures.filter((failure) => failure.rule !== "too-few-informative-frames");
    const closer = samples.map((sample, position) => position === index ? { ...sample, sourceError: 0 } : sample);
    const after = judgeSourcePictures(closer).failures.filter((failure) => failure.rule !== "too-few-informative-frames");
    assert.ok(after.length <= before.length);
  }), { numRuns: 200 });
});

const passEvidence = (label, before, after = before) => ({ label, observed: structuredClone(declared), beforeBytes: before,
  samples: [{ atMs: 0, temporaryBytes: before - 5 }, { atMs: 250, temporaryBytes: after }], state: "done", error: null,
  publicationVerified: true, stagingCleaned: true, scratchCleaned: true });
// The real allowance measured before a Windows promise export on 2026-10-20 (payload minus the entries already held).
const REAL_ALLOWANCE = REAL_ALLOWANCE_BYTES;
const evidence = (before = REAL_ALLOWANCE, after = before) => ({ version: 1, passes: REQUIRED_PASSES.map((label) => passEvidence(label, before, after)) });

test("restored allowance on both passes of a real-schema record qualifies", () => {
  assert.deepEqual(temporarySpaceFailures(declared, evidence()), []);
});

test("every schema-defined contract field must match the declared contract on every pass", () => {
  for (const [key, expected] of Object.entries(declared)) {
    for (const [index] of REQUIRED_PASSES.entries()) {
      const changed = evidence();
      changed.passes[index].observed = { ...declared, [key]: typeof expected === "string" ? `${expected}-x` : expected + 1 };
      const failures = temporarySpaceFailures(declared, changed);
      assert.ok(failures.some((message) => message.startsWith(`${REQUIRED_PASSES[index]}: native contract differs`)), `${key} pass ${index}`);
      const omitted = evidence();
      const { [key]: _removed, ...rest } = declared;
      omitted.passes[index].observed = rest;
      assert.ok(temporarySpaceFailures(declared, omitted).length > 0, `${key} omitted from pass ${index}`);
    }
  }
  const extra = evidence();
  extra.passes[1].observed = { ...declared, sneaky: 1 };
  assert.ok(temporarySpaceFailures(declared, extra).length > 0);
});

test("a malformed declared contract disqualifies even when the native contract equals it", () => {
  for (const broken of [undefined, null, [], { ...declared, scope: "" }, { ...declared, totalBytes: declared.totalBytes + 1 },
    { ...declared, payloadBytes: 0, totalBytes: declared.infrastructureBytes }, { ...declared, entryLimit: 0 }, { ...declared, payloadBytes: 1.5 }]) {
    const record = evidence();
    for (const pass of record.passes) pass.observed = broken;
    assert.ok(temporarySpaceFailures(broken, record).length > 0, JSON.stringify(broken));
  }
});

test("property: any allowance shortfall after settlement is a held-bytes failure on the pass that leaked", () => {
  fc.assert(fc.property(fc.integer({ min: 2, max: declared.payloadBytes }), fc.double({ min: 0, max: 1, noNaN: true }), fc.constantFrom(0, 1),
    (before, fraction, which) => {
      const shortfall = Math.max(1, Math.floor((before - 1) * fraction) + 1);
      const record = evidence(before);
      record.passes[which] = passEvidence(REQUIRED_PASSES[which], before, before - shortfall);
      const failures = temporarySpaceFailures(declared, record);
      assert.equal(failures.length, 1);
      assert.equal(failures[0], `${REQUIRED_PASSES[which]}: allowance did not return after settlement (${shortfall} bytes held)`);
    }), { numRuns: 200 });
});

test("property: an allowance that returns or grows never fails, wherever the transient dip was", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: declared.payloadBytes }), fc.integer({ min: 0, max: 1_000_000 }), (before, growth) => {
    const after = Math.min(declared.payloadBytes, before + growth);
    assert.deepEqual(temporarySpaceFailures(declared, evidence(before, after)), []);
  }), { numRuns: 200 });
});

test("a dip that is still open at the last sample leaks, while a dip that closed does not (opposite ordering)", () => {
  const closed = evidence();
  closed.passes[0].samples = [{ atMs: 0, temporaryBytes: REAL_ALLOWANCE - 1000 }, { atMs: 250, temporaryBytes: REAL_ALLOWANCE }];
  assert.deepEqual(temporarySpaceFailures(declared, closed), []);
  const open = evidence();
  open.passes[0].samples = [{ atMs: 0, temporaryBytes: REAL_ALLOWANCE }, { atMs: 250, temporaryBytes: REAL_ALLOWANCE - 1000 }];
  assert.deepEqual(temporarySpaceFailures(declared, open), ["cold: allowance did not return after settlement (1000 bytes held)"]);
});

test("an allowance that was never measured after settlement, or is out of range, cannot qualify", () => {
  for (const samples of [undefined, null, [], [{ atMs: 0, temporaryBytes: null }], [{ atMs: 0, temporaryBytes: REAL_ALLOWANCE }, { atMs: 1, temporaryBytes: null }],
    [{ atMs: 0 }], [{ atMs: 0, temporaryBytes: Number.NaN }], [{ atMs: 0, temporaryBytes: declared.payloadBytes + 1 }], [{ atMs: 0, temporaryBytes: "1" }]]) {
    const record = evidence();
    record.passes[1].samples = samples;
    assert.ok(temporarySpaceFailures(declared, record).length > 0, JSON.stringify(samples));
  }
  for (const before of [0, -1, declared.payloadBytes + 1, 1.5, Number.NaN, null, undefined, "17"]) {
    const record = evidence();
    record.passes[0].beforeBytes = before;
    assert.ok(temporarySpaceFailures(declared, record).some((message) => message.startsWith("cold: allowance before")), String(before));
  }
});

test("only a clean, published, cleaned export on each pass qualifies", () => {
  for (const key of ["publicationVerified", "stagingCleaned", "scratchCleaned"]) {
    for (const value of [false, undefined, null, "true", 1]) {
      const record = evidence();
      record.passes[1][key] = value;
      assert.deepEqual(temporarySpaceFailures(declared, record), [`estimate: ${key} is not proven`], `${key}=${String(value)}`);
    }
  }
  for (const [state, error] of [["failed", null], ["done", "disk full"], ["cancelled", null], [undefined, null], ["done", ""]]) {
    const record = evidence();
    Object.assign(record.passes[0], { state, error });
    assert.ok(temporarySpaceFailures(declared, record).some((message) => message === "cold: export did not finish cleanly"), `${state}/${error}`);
  }
});

test("missing, reordered, duplicated or legacy evidence cannot qualify", () => {
  const good = evidence();
  for (const bad of [undefined, null, {}, { version: 2, passes: good.passes }, { version: 1, passes: [] }, { version: 1, passes: [good.passes[0]] },
    { version: 1, passes: [good.passes[1]] }, { version: 1, passes: [good.passes[1], good.passes[0]] }, { version: 1, passes: [good.passes[0], good.passes[0]] },
    { version: 1, passes: [...good.passes, good.passes[1]] }, { version: 1, passes: "none" }, { version: 1, passes: [null, null] }]) {
    assert.ok(temporarySpaceFailures(declared, bad).length > 0, JSON.stringify(bad)?.slice(0, 60));
  }
});

test("verdicts never mutate their inputs", () => {
  const deepFreeze = (value) => { if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };
  assert.deepEqual(temporarySpaceFailures(deepFreeze(structuredClone(declared)), deepFreeze(evidence())), []);
  assert.equal(judgeSourcePictures(deepFreeze(structuredClone(REAL_PHONE))).ok, true);
  assert.equal(estimateFacts(deepFreeze([{ message: "Estimated time: unknown" }])).provided, false);
});

// The product's own text is the authority: extract its template from the shipped source and render it.
const queueSource = await readFile(new URL("../../src/timeline/exportQueue.ts", import.meta.url), "utf8");
const template = /`(Estimated encoding and saving time: about )\$\{[^}]*\}( minute\(s\)[^`]*)`/.exec(queueSource);
const unknown = /"(Estimated time: unknown[^"]*)"/.exec(queueSource);
const measured = (minutes, before = "Check this export before starting.\n", after = "\nEstimated worker memory: about 1.0 GiB") =>
  `${before}${template[1]}${minutes}${template[2]}${after}`;

test("the estimate parser follows the text the product prints", () => {
  assert.ok(template, "the product no longer prints a measured estimate sentence this parser knows");
  assert.ok(unknown, "the product no longer prints an explicit unknown-time sentence");
  assert.deepEqual(estimateFacts([{ message: measured(7) }]), { provided: true, minutes: 7, unknownStated: false });
  const real = "Check this export before starting. This project is within the declared size limits; resource fit has not yet been established. " +
    "Memory fit cannot be estimated yet because a comparable observation or native measurement is missing. Temporary-file or final-file space cannot be estimated yet. " +
    "A comparable successful local run is not available to estimate time. Estimated time: unknown (no comparable local measurement yet).";
  assert.deepEqual(estimateFacts([{ message: real }]), { provided: false, minutes: null, unknownStated: true });
  assert.deepEqual(estimateFacts([{ message: `x ${unknown[1]}` }]), { provided: false, minutes: null, unknownStated: true });
});

test("an estimate counts only when the one confirmation the user saw states a positive measured time", () => {
  for (const preflight of [undefined, null, [], "text", [{}], [{ message: 5 }], [{ message: measured(0) }], [{ message: measured(-3) }],
    [{ message: measured(7) }, { message: measured(7) }], [{ message: measured("many") }], [{ message: measured(7).replace("Estimated", "Estimate") }]])
    assert.equal(estimateFacts(preflight).provided, false, JSON.stringify(preflight));
  fc.assert(fc.property(fc.integer({ min: 1, max: 100_000 }), fc.string({ maxLength: 40 }), fc.string({ maxLength: 40 }), (minutes, before, after) => {
    assert.deepEqual(estimateFacts([{ message: measured(minutes, before, after) }]).minutes, minutes);
  }), { numRuns: 100 });
});

const cold = () => ({ historySamples: 0, estimateSeconds: null, preflight: [{ message: REAL_COLD_MESSAGE, warning: true }] });
const silent = () => ({ historySamples: 1, estimateSeconds: 9, actualSeconds: 8.1, preflight: [], readiness: "ready" });
const prompted = () => ({ historySamples: 1, estimateSeconds: 9, actualSeconds: 8.1, preflight: [{ message: measured(1), warning: false }], readiness: "ready" });
const estimates = (estimate = silent(), first = cold()) => ({ version: 1, cold: first, estimate });

test("an honest cold export followed by a repeated export with a measured estimate qualifies, silent or prompted", () => {
  assert.deepEqual(estimateFailures(estimates(silent())), []);
  assert.deepEqual(estimateFailures(estimates(prompted())), []);
});

test("a repeated export that raised a confirmation must have said the estimate it had", () => {
  const hidden = prompted();
  hidden.preflight = [{ message: REAL_COLD_MESSAGE, warning: true }];
  assert.deepEqual(estimateFailures(estimates(hidden)), ["estimate: the confirmation hid the measured estimate the product had"]);
});

test("silence is only acceptable with established readiness, and one request shows at most one confirmation", () => {
  for (const readiness of ["unknown", "not_ready", undefined, null, "READY"]) {
    assert.deepEqual(estimateFailures(estimates({ ...silent(), readiness })), ["estimate: no confirmation was shown but storage readiness was not established"], String(readiness));
  }
  const twice = { ...prompted(), preflight: [prompted().preflight[0], prompted().preflight[0]] };
  assert.deepEqual(estimateFailures(estimates(twice)), ["estimate: the user was shown more than one confirmation"]);
  assert.ok(estimateFailures(estimates({ ...silent(), preflight: undefined })).length > 0);
});

test("a cold export must really be cold, show one confirmation and say the time is unknown", () => {
  assert.ok(estimateFailures(estimates(silent(), { ...cold(), historySamples: 1 })).some((message) => message.startsWith("cold: the export was not cold")));
  assert.ok(estimateFailures(estimates(silent(), { ...cold(), estimateSeconds: 5 })).some((message) => message.startsWith("cold: the export was not cold")));
  assert.ok(estimateFailures(estimates(silent(), { ...cold(), preflight: [] })).some((message) => message.startsWith("cold: the user was not shown exactly one")));
  const claimed = { ...cold(), preflight: [{ message: measured(3), warning: true }] };
  const failures = estimateFailures(estimates(silent(), claimed));
  assert.ok(failures.includes("cold: a measured estimate was claimed without comparable local history"));
  assert.ok(failures.includes("cold: the confirmation did not state that the time is unknown"));
  const mute = { ...cold(), preflight: [{ message: "Check this export before starting.", warning: true }] };
  assert.deepEqual(estimateFailures(estimates(silent(), mute)), ["cold: the confirmation did not state that the time is unknown"]);
});

test("a repeated export with no history, no produced estimate or no measured time cannot qualify", () => {
  for (const historySamples of [0, -1, 1.5, "1", null, undefined]) assert.ok(estimateFailures(estimates({ ...silent(), historySamples })).length > 0, String(historySamples));
  for (const estimateSeconds of [null, undefined, 0, -2, Number.NaN, Number.POSITIVE_INFINITY, "9"])
    assert.ok(estimateFailures(estimates({ ...silent(), estimateSeconds })).includes("estimate: the product produced no measured estimate from its history"), String(estimateSeconds));
  for (const actualSeconds of [null, undefined, 0, -1, Number.NaN, "8"])
    assert.ok(estimateFailures(estimates({ ...silent(), actualSeconds })).includes("estimate: the actual export time was not measured"), String(actualSeconds));
});

test("missing or legacy estimate evidence cannot qualify", () => {
  for (const bad of [undefined, null, {}, { version: 2, cold: cold(), estimate: silent() }, { version: 1, estimate: silent() }, { version: 1, cold: cold() }, "estimated"])
    assert.deepEqual(estimateFailures(bad), ["no recorded estimate evidence"], JSON.stringify(bad));
  // A boolean written by the harness is not evidence.
  assert.deepEqual(estimateFailures({ estimateProvided: true }), ["no recorded estimate evidence"]);
});

test("property: valid evidence qualifies for any measured numbers, and each single corruption disqualifies it", () => {
  const corruptions = [
    (evidence) => { evidence.cold.historySamples = 1; },
    (evidence) => { evidence.cold.estimateSeconds = 4; },
    (evidence) => { evidence.cold.preflight = []; },
    (evidence) => { evidence.estimate.historySamples = 0; },
    (evidence) => { evidence.estimate.estimateSeconds = null; },
    (evidence) => { evidence.estimate.actualSeconds = 0; },
    (evidence) => { evidence.estimate.readiness = "unknown"; },
    (evidence) => { evidence.estimate.preflight = [{ message: REAL_COLD_MESSAGE, warning: true }]; },
    (evidence) => { evidence.estimate.preflight = [prompted().preflight[0], prompted().preflight[0]]; },
  ];
  fc.assert(fc.property(fc.integer({ min: 1, max: 50 }), fc.double({ min: 0.001, max: 1e6, noNaN: true }), fc.double({ min: 0.001, max: 1e6, noNaN: true }),
    fc.boolean(), fc.integer({ min: 1, max: 100_000 }), (samples, estimateSeconds, actualSeconds, silentRun, minutes) => {
      const estimate = { historySamples: samples, estimateSeconds, actualSeconds,
        preflight: silentRun ? [] : [{ message: measured(minutes), warning: false }], readiness: "ready" };
      assert.deepEqual(estimateFailures(estimates(estimate)), []);
      for (const [index, corrupt] of corruptions.entries()) {
        const copy = structuredClone(estimates(estimate));
        corrupt(copy);
        if (index === 6 && !silentRun) continue; // readiness is only consulted when the product stayed silent
        assert.ok(estimateFailures(copy).length > 0, `corruption ${index}`);
      }
    }), { numRuns: 100 });
});

test("captions count as painted only when nothing shows early and something shows after the fade", () => {
  assert.equal(captionsFadedIn(REAL_CAPTION_SAMPLES), true);
  for (const bad of [[0, 0], [270, 270], [270, 0], [5, 3], [0, -1], [0, 1.5], [0, Number.NaN], [0, "270"], [0], [0, 270, 270], [], null, undefined, "0,270", { 0: 0, 1: 270, length: 2 }])
    assert.equal(captionsFadedIn(bad), false, JSON.stringify(bad));
  fc.assert(fc.property(fc.nat(10_000), fc.integer({ min: 1, max: 10_000 }), (early, extra) => {
    assert.equal(captionsFadedIn([early, early + extra]), true);
    assert.equal(captionsFadedIn([early + extra, early]), false);
    assert.equal(captionsFadedIn([early, early]), false);
  }), { numRuns: 100 });
});

test("the outcome wait outlasts every library line running exactly at its speed line, and runs without a line keep the old wait", () => {
  // Every previously green CI and local run waited 12 minutes for launch, crash recovery and the compiled-engine regression.
  assert.ok(BASE_OUTCOME_BUDGET_MS >= 12 * 60_000, "the fixed allowance must never shrink below what green runs already needed");
  assert.equal(outcomeBudgetMs(null), 12 * 60_000, "a run without a promise line must keep exactly the old wait");
  for (const none of [null, undefined, {}, "youtube-hd", 7, { durationSeconds: 0 }, { durationSeconds: -5 }, { durationSeconds: Number.NaN },
    { durationSeconds: "600" }, { durationSeconds: Number.POSITIVE_INFINITY }]) assert.equal(outcomeBudgetMs(none), BASE_OUTCOME_BUDGET_MS, JSON.stringify(none));
  for (const definition of library.cases) {
    const budget = outcomeBudgetMs(definition);
    const exportsNeeded = definition.kind === "promise" ? 2 : 1;
    assert.ok(Number.isSafeInteger(budget) && budget <= 2 ** 31 - 1, `${definition.id}: not a usable timer delay`);
    // Base allowance plus each export running exactly at the accepted speed (4x when the line has no speed requirement).
    assert.ok(budget >= BASE_OUTCOME_BUDGET_MS + exportsNeeded * definition.durationSeconds * (definition.speedFactor16gb ?? 4) * 1000, definition.id);
  }
  const youtube = library.cases.find((entry) => entry.id === "youtube-hd");
  assert.ok(outcomeBudgetMs(youtube) >= (12 + 2 * 600 * 2 / 60) * 60_000, "two 10-minute exports at the 2x speed line must fit");
  // The old fixed 12 minutes could not even hold one such export, which is why a long line looked like a hang.
  assert.ok(outcomeBudgetMs(youtube) > 4 * BASE_OUTCOME_BUDGET_MS);
});

test("property: the outcome wait never shrinks as a line gets longer or slower, and a promise line waits for two exports", () => {
  const speed = fc.double({ min: 0.5, max: 8, noNaN: true });
  fc.assert(fc.property(fc.integer({ min: 1, max: 20_000 }), fc.integer({ min: 0, max: 20_000 }), speed, speed, (seconds, more, slow, extra) => {
    const at = (durationSeconds, speedFactor16gb, kind = "promise") => outcomeBudgetMs({ durationSeconds, speedFactor16gb, kind });
    assert.ok(at(seconds + more, slow) >= at(seconds, slow));
    assert.ok(at(seconds, slow + extra) >= at(seconds, slow));
    assert.ok(at(seconds, slow) > at(seconds, slow, "measurement"), "a promise line exports twice");
    assert.ok(at(seconds, slow, "measurement") >= BASE_OUTCOME_BUDGET_MS);
  }), { numRuns: 200 });
});

// Vite's client reloads its page when the hot-module socket drops, which restarts the harness page while the app keeps exporting.
// The page is only safe when no such socket can be opened at all.
async function hotSocketAccepted(options) {
  const root = await mkdtemp(path.join(os.tmpdir(), "exporter-vite-"));
  await writeFile(path.join(root, "index.html"), "<!doctype html><title>qa</title>");
  const server = await createServer({ root, configFile: false, logLevel: "silent", server: options });
  try {
    await server.listen();
    const { port } = server.httpServer.address();
    return await new Promise((resolve, reject) => {
      const request = http.request({ host: "127.0.0.1", port, path: "/", headers: { Connection: "Upgrade", Upgrade: "websocket",
        "Sec-WebSocket-Version": "13", "Sec-WebSocket-Protocol": "vite-hmr", "Sec-WebSocket-Key": randomBytes(16).toString("base64") } });
      request.on("upgrade", (response, socket) => { socket.destroy(); resolve(response.statusCode === 101); });
      request.on("response", (response) => { response.resume(); resolve(false); });
      request.on("error", () => resolve(false));
      request.setTimeout(5000, () => { request.destroy(); reject(new Error("the hot-socket probe timed out")); });
      request.end();
    });
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("the harness's dev server offers no hot-module socket, so Vite's reload-on-disconnect cannot fire", async () => {
  // The control proves the probe can tell the difference: a stock dev server does accept the socket.
  assert.equal(await hotSocketAccepted({ host: "127.0.0.1", port: 0, strictPort: true }), true, "the probe must see a stock dev server's hot socket");
  assert.equal(await hotSocketAccepted(qaServerOptions), false, "the harness's dev server must not accept a hot-module socket");
});

test("the native harness serves its page with those options and carries no private copy of them", async () => {
  const source = await readFile(new URL("./exporterNative.mjs", import.meta.url), "utf8");
  assert.match(source, /server: qaServerOptions,/);
  assert.doesNotMatch(source, /server: \{ host: "127\.0\.0\.1"/);
});

// The recovery instance that exited 0 a moment after starting, in two of sixteen back-to-back pilots on 2026-10-23, was the single-instance
// guard handing over to a killed instance that was still being torn down. These fakes exit (or not) the way the real child did.
const recoveryDelays = { windowMs: 60, delayMs: 1 };
function fakeApp(exitsAfterMs, code = 0) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  if (exitsAfterMs !== null) setTimeout(() => { child.exitCode = code; child.emit("exit", code, null); }, exitsAfterMs);
  return child;
}
const handover = (attempt) => ["recovery-instance-handed-over-to-the-dying-one", attempt, 0];

test("a recovery instance that hands over to the dying one is started again, and each handover is recorded", async () => {
  const plan = [fakeApp(2), fakeApp(2), fakeApp(null)];
  const labels = [], steps = [];
  const child = await startRecovery((label) => { labels.push(label); return plan[labels.length - 1]; }, steps, recoveryDelays);
  assert.equal(child, plan[2]);
  assert.deepEqual(labels, ["2", "2-retry1", "2-retry2"]);
  assert.deepEqual(steps.map((step) => [step.phase, step.attempt, step.exitCode]), [handover(1), handover(2)]);
});

test("only a quick exit 0 is retried: another exit code, or an instance that stays up, is returned at once", async () => {
  for (const [instance, what] of [[fakeApp(2, 1), "exit 1"], [fakeApp(2, 101), "exit 101"], [fakeApp(null), "still running"]]) {
    const labels = [], steps = [];
    const child = await startRecovery((label) => { labels.push(label); return instance; }, steps, recoveryDelays);
    assert.equal(child, instance, what);
    assert.deepEqual(labels, ["2"], what);
    assert.deepEqual(steps, [], what);
  }
});

test("a recovery instance that really exits 0 cannot pass: the last quick exit 0 is returned as it is", async () => {
  const plan = [fakeApp(2), fakeApp(2), fakeApp(2)];
  const labels = [], steps = [];
  const child = await startRecovery((label) => { labels.push(label); return plan[labels.length - 1]; }, steps, recoveryDelays);
  assert.equal(child, plan[2]);
  assert.equal(child.exitCode, 0);
  assert.equal(labels.length, 3);
  assert.equal(steps.length, 2);
});

test("an instance that is already gone when it is checked counts as a quick exit", async () => {
  const gone = Object.assign(new EventEmitter(), { exitCode: 0, signalCode: null });
  const plan = [gone, fakeApp(null)];
  const labels = [], steps = [];
  const child = await startRecovery((label) => { labels.push(label); return plan[labels.length - 1]; }, steps, recoveryDelays);
  assert.equal(child, plan[1]);
  assert.deepEqual(steps.map((step) => [step.phase, step.attempt, step.exitCode]), [handover(1)]);
});

test("however many instances hand over, no more than three are started and each handover is recorded", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 6 }), async (handovers) => {
    const labels = [], steps = [];
    await startRecovery((label) => { labels.push(label); return fakeApp(labels.length <= handovers ? 1 : null); }, steps, { windowMs: 40, delayMs: 0 });
    const started = Math.min(handovers, 2) + 1;
    assert.equal(labels.length, started);
    assert.equal(steps.length, started - 1);
  }), { numRuns: 14 });
});

test("the native harness starts its recovery instance through that retry, never directly", async () => {
  const source = await readFile(new URL("./exporterNative.mjs", import.meta.url), "utf8");
  assert.match(source, /const second = await startRecovery\(\(label\) => start\(config, label\), proof\.steps\);/);
  assert.doesNotMatch(source, /const second = start\(config/);
});
