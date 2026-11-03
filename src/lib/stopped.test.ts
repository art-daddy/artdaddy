import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  isAbortFailure,
  isStoppedAnswer,
  looksLikeAbort,
  STOPPED_ERROR,
  stoppedAnswer,
} from "./stopped";

describe("the word a call that Stop ended answers", () => {
  it("is the word the tool-failure analysis filters on", () => {
    // Changing it silently changes what "a tool failed" counts in the funnel numbers, and what the chat
    // reads as a person's own Stop.
    expect(STOPPED_ERROR).toBe("cancelled");
    expect(stoppedAnswer()).toEqual({ ok: false, error: "cancelled" });
  });

  it("is recognised in every shape a tool answers it, and only then", () => {
    for (const answer of [
      { error: "cancelled" },
      { ok: false, error: "cancelled" },
      { frame: "f_1", error: "cancelled" },
      { t: 12, error: "cancelled" },
    ])
      expect(isStoppedAnswer(answer), JSON.stringify(answer)).toBe(true);
    for (const answer of [
      undefined,
      null,
      "cancelled",
      0,
      [],
      {},
      { ok: true },
      { error: "Cancelled" },
      { error: " cancelled" },
      { error: "cancelled." },
      { error: ["cancelled"] },
      { status: "cancelled" },
    ])
      expect(isStoppedAnswer(answer), JSON.stringify(answer)).toBe(false);
  });

  it("recognises no other word as a stop", () => {
    fc.assert(
      fc.property(
        fc.string().filter((error) => error !== "cancelled"),
        (error) => {
          expect(isStoppedAnswer({ error })).toBe(false);
        },
      ),
    );
  });
});

describe("what being aborted looks like when a tool throws", () => {
  // Each is a way an aborted call has surfaced: what the platform throws and what the field showed.
  const ABORTS: [string, unknown][] = [
    ["an AbortError, whatever its message", Object.assign(new Error("x"), { name: "AbortError" })],
    ["a DOMException AbortError", new DOMException("The operation was aborted.", "AbortError")],
    ["an Error: signal is aborted without reason", new Error("signal is aborted without reason")],
    ["an Error: the user aborted a request", new Error("The user aborted a request.")],
    ["a host failure that says cancelled", new Error("encode for gemini failed: cancelled")],
    ["a bare string", "cancelled"],
    ["a bare string, capitalised", "Aborted"],
    ["an object that only has the name", { name: "AbortError" }],
  ];
  const FAILURES: [string, unknown][] = [
    ["a TypeError", new TypeError("Cannot read properties of undefined (reading 'clips')")],
    ["an HTTP failure", new Error("HTTP 500")],
    ["a full disk", new Error("disk full")],
    ["a RangeError", new RangeError("Invalid array length")],
    ["a bare string", "boom"],
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["an empty object", {}],
    ["an empty array", []],
  ];

  it.each(ABORTS)("takes %s for an abort", (_name, thrown) => {
    expect(looksLikeAbort(thrown)).toBe(true);
  });

  it.each(FAILURES)("does not take %s for an abort", (_name, thrown) => {
    expect(looksLikeAbort(thrown)).toBe(false);
  });

  it("takes any text that says so for an abort, and nothing that does not", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.constantFrom("abort", "ABORTED", "Cancelled", "cancel", "aBoRt"),
        fc.string(),
        (before, word, after) => {
          expect(looksLikeAbort(new Error(before + word + after))).toBe(true);
        },
      ),
    );
    fc.assert(
      fc.property(
        fc.string().filter((text) => !/abort|cancel/i.test(text)),
        (text) => {
          expect(looksLikeAbort(new Error(text))).toBe(false);
          expect(looksLikeAbort(text)).toBe(false);
        },
      ),
    );
  });
});

// A tool's answer after Stop aborted it, in the ways the real tools give it: the vision and video tools catch the
// abort and answer with its words, a handler that throws is answered for by the registry ("tool: message"),
// and the look and caption tools answer the marker.
describe("what an aborted call's answer looks like", () => {
  const ABORTED: [string, unknown][] = [
    ["the field's words", { ok: false, error: "signal is aborted without reason" }],
    [
      "the registry answering for a throw",
      { ok: false, error: "video_ask: The user aborted a request." },
    ],
    [
      "a host failure that says cancelled",
      { ok: false, error: "encode for gemini failed: cancelled" },
    ],
    ["the marker", { ok: false, error: "cancelled" }],
    ["the marker without ok", { error: "cancelled" }],
    ["the chat refusing to start a call after Stop", { ok: false, error: "turn cancelled" }],
  ];
  const NOT_ABORTED: [string, unknown][] = [
    ["a success", { ok: true, created: 2 }],
    ["a success that carries an error field", { ok: true, error: "cancelled" }],
    ["an ordinary failure", { ok: false, error: "disk full" }],
    ["a failure with no words", { ok: false }],
    ["an error that is not text", { ok: false, error: { code: "cancelled" } }],
    ["null", null],
    ["text", "cancelled"],
    ["a number", 7],
  ];

  it.each(ABORTED)("takes %s for an abort", (_name, answer) => {
    expect(isAbortFailure(answer)).toBe(true);
  });

  it.each(NOT_ABORTED)("does not take %s for an abort", (_name, answer) => {
    expect(isAbortFailure(answer)).toBe(false);
  });

  it("never takes a success for one, whatever it says", () => {
    fc.assert(
      fc.property(fc.string(), (error) => {
        expect(isAbortFailure({ ok: true, error })).toBe(false);
      }),
    );
  });

  it("never takes a failure that says nothing of the kind for one", () => {
    fc.assert(
      fc.property(
        fc.string().filter((text) => !/abort|cancel/i.test(text)),
        (error) => {
          expect(isAbortFailure({ ok: false, error })).toBe(false);
          expect(isAbortFailure({ error })).toBe(false);
        },
      ),
    );
  });
});

// A tool that spells the word itself drifts from the chat and the telemetry the first time one of them is
// changed, and nothing fails: the card just starts reading "Couldn't ..." for a person's own Stop again.
describe("every tool answers a Stop with the one shared word", () => {
  const sources = import.meta.glob(
    ["../**/*.ts", "../**/*.tsx", "!../**/*.test.ts", "!../**/*.test.tsx", "!../lib/stopped.ts"],
    { query: "?raw", import: "default", eager: true },
  ) as Record<string, string>;

  it("has no source that writes the word as its own literal", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(100); // the glob found the app, not nothing
    const offenders = Object.entries(sources)
      .filter(([, text]) => /\berror:\s*["'`](?:cancell?ed|aborted)["'`]/i.test(text))
      .map(([path]) => path);
    expect(offenders, "answer with STOPPED_ERROR or stoppedAnswer() from lib/stopped").toEqual([]);
  });
});
