import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ArtDaddyError } from "../lib/errors";
import {
  classifyTranscriptFailure,
  FAILURE_ADVICE,
  failureText,
  TRANSCRIPT_FAILURE_REASONS,
  TranscriptionFailure,
} from "./speechFailure";

describe("the reasons a transcription fails", () => {
  it("each has advice, and the advice says whether trying again can help", () => {
    expect(Object.keys(FAILURE_ADVICE).sort()).toEqual([...TRANSCRIPT_FAILURE_REASONS].sort());
    for (const reason of TRANSCRIPT_FAILURE_REASONS)
      expect(FAILURE_ADVICE[reason], reason).toMatch(/retry|again/i);
  });

  it("is a typed error: its code follows its reason, it is an Error, and it keeps its cause", () => {
    const cause = new Error("HTTP 404");
    const e = new TranscriptionFailure("model_unavailable", "the model is gone", { cause });
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(ArtDaddyError);
    expect(e.code).toBe("speech_model_unavailable");
    expect(e.reason).toBe("model_unavailable");
    expect(e.expected).toBe(false);
    expect(e.cause).toBe(cause);
    expect(new TranscriptionFailure("engine_unavailable", "x", { expected: true }).expected).toBe(
      true,
    );
  });

  it("reads the reason an error named, and calls anything else the engine's, whatever was thrown", () => {
    for (const reason of TRANSCRIPT_FAILURE_REASONS)
      expect(classifyTranscriptFailure(new TranscriptionFailure(reason, "m")).reason).toBe(reason);
    fc.assert(
      fc.property(fc.anything(), (thrown) => {
        const got = classifyTranscriptFailure(thrown);
        expect(got.reason).toBe("engine_failed");
        expect(typeof got.message).toBe("string");
      }),
    );
  });

  it("tells a person our own errors whole and a subprocess's only by the tail, where its reason is", () => {
    const ours = new TranscriptionFailure("engine_failed", "x".repeat(500));
    expect(failureText(ours)).toHaveLength(500);
    const theirs = `${"noise ".repeat(100)}the real reason`;
    expect(failureText(new Error(theirs)).length).toBeLessThanOrEqual(200);
    expect(failureText(new Error(theirs))).toMatch(/the real reason$/);
  });
});
