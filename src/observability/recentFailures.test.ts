// The last few failures the person met, kept in memory so a problem report can say what had just gone wrong.
//
// A report used to be a note and a transcript: nothing said which request failed or why. Codes and request ids
// only -- never a message, a prompt or a path -- and only the last few. Nothing here is sent by itself.
import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";

import {
  clearRecentFailures,
  MAX_RECENT_FAILURES,
  noteFailure,
  paidCallWhere,
  recentFailures,
} from "./recentFailures";

const LEGAL = /^[A-Za-z0-9_.:-]*$/;

beforeEach(() => clearRecentFailures());

describe("what counts as a paid call", () => {
  it.each([
    ["https://api.example/inference", "turn"],
    ["https://api.example/inference/stream", "turn"],
    ["https://api.example/ai/generate_image", "generation"],
    ["https://api.example/ai/generate_video", "generation"],
    ["https://api.example/ai/vision_video", "vision"],
    ["https://api.example/ai/vision_image", "vision"],
    ["https://api.example/ai/something_new", "ai"],
  ])("%s is %s", (url, where) => expect(paidCallWhere(url)).toBe(where));

  it.each([
    "https://api.example/usage",
    "https://api.example/me",
    "https://api.example/auth/verify",
    "https://api.example/telemetry/app",
    "https://api.example/telemetry/feedback",
    "https://api.example/billing/checkout",
    "https://api.example/ai/generate_image/quote",
    "https://api.example/ai/voiceover/quote",
    "not a url",
    "",
  ])("%s is not", (url) => expect(paidCallWhere(url)).toBeNull());
});

describe("the ring", () => {
  it("keeps the last ten, oldest first", () => {
    for (let i = 0; i < 25; i += 1)
      noteFailure({ where: "turn", code: `c${i}`, requestId: `r${i}` });
    const kept = recentFailures();
    expect(kept).toHaveLength(MAX_RECENT_FAILURES);
    expect(kept.map((f) => f.code)).toEqual(Array.from({ length: 10 }, (_, i) => `c${i + 15}`));
  });

  it("is empty after clear", () => {
    noteFailure({ where: "turn", code: "x", requestId: "r" });
    clearRecentFailures();
    expect(recentFailures()).toEqual([]);
  });

  it("hands out a copy, so a caller cannot rewrite the record", () => {
    noteFailure({ where: "turn", code: "x", requestId: "r" });
    recentFailures().pop();
    recentFailures()[0].code = "changed";
    expect(recentFailures()).toHaveLength(1);
    expect(recentFailures()[0].code).toBe("x");
  });

  it("is one entry per request: a second note for the same request adds what it knows", () => {
    noteFailure({ where: "turn", code: "http_429", requestId: "r1", status: 429 });
    noteFailure({ where: "turn", code: "other", requestId: "r2" });
    noteFailure({ where: "turn", code: "account_busy", requestId: "r1" });
    const kept = recentFailures();
    expect(kept.map((f) => f.requestId)).toEqual(["r1", "r2"]);
    expect(kept[0]).toMatchObject({ code: "account_busy", status: 429 });
  });

  it("does not let a vaguer note overwrite a typed one", () => {
    noteFailure({ where: "turn", code: "content_policy", requestId: "r1" });
    noteFailure({ where: "turn", code: "http_200", requestId: "r1" });
    noteFailure({ where: "turn", code: "unknown", requestId: "r1" });
    expect(recentFailures()[0].code).toBe("content_policy");
  });

  it("keeps failures that have no request id (the connection never answered) separate", () => {
    noteFailure({ where: "turn", code: "network" });
    noteFailure({ where: "turn", code: "network" });
    expect(recentFailures()).toHaveLength(2);
  });

  it("speaks the server's alphabet and bounds, whatever it is given", () => {
    noteFailure({ where: "a b", code: "no way! <x>", requestId: "id\r\nX: 1", status: 99999 });
    const [f] = recentFailures();
    expect([f.where, f.code, f.requestId]).toEqual(["a_b", "no_way___x_", "id__X:_1"]);
    expect(f.status).toBeUndefined();
  });

  it("holds for any sequence of notes: bounded, one entry per request id, text in the legal alphabet", () => {
    const note = fc.record({
      where: fc.string({ maxLength: 50 }),
      code: fc.string({ maxLength: 80 }),
      requestId: fc.option(fc.string({ maxLength: 200 }), { nil: undefined }),
      status: fc.option(fc.integer(), { nil: undefined }),
    });
    fc.assert(
      fc.property(fc.array(note, { maxLength: 60 }), (notes) => {
        clearRecentFailures();
        for (const n of notes) noteFailure(n);
        const kept = recentFailures();
        expect(kept.length).toBeLessThanOrEqual(MAX_RECENT_FAILURES);
        const ids = kept.map((f) => f.requestId).filter(Boolean);
        expect(new Set(ids).size).toBe(ids.length);
        for (const f of kept) {
          expect(f.where.length).toBeLessThanOrEqual(30);
          expect(f.code.length).toBeLessThanOrEqual(40);
          expect((f.requestId ?? "").length).toBeLessThanOrEqual(128);
          for (const text of [f.where, f.code, f.requestId ?? ""]) expect(text).toMatch(LEGAL);
          if (f.status !== undefined) expect(f.status >= 100 && f.status <= 599).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});
