// The local record of closed words and bounded numbers. It lives on this PC and is never sent, so
// the question that matters is what can get INTO it: whatever a caller holds, only closed words and
// bounded numbers may be stored, and whatever the storage holds, only the same may be read back.
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MODEL_FAILURE_KINDS } from "../tools/modelFailure";
import {
  clearFacts,
  FACT_RING,
  FACTS_KEY,
  fileBand,
  MODEL_FACT_EVENTS,
  MODEL_FACT_SOURCES,
  readFacts,
  recordFact,
  WAKE_FACT_EVENTS,
  WAKE_FILE_BANDS,
  type ModelFact,
  type WakeFact,
} from "./localFacts";

// The vocabulary, written out here on purpose. A word added to a list is a decision about what a
// privacy text must name, so it is an edit to this test too.
const MODEL_EVENTS = [
  "download_started",
  "download_finished",
  "download_failed",
  "download_cancelled",
];
const SOURCES = ["primary", "extra_1", "extra_2", "extra_3"];
const WAKE_EVENTS = [
  "registered",
  "landed",
  "released",
  "woke",
  "held_typing",
  "skipped_fetched",
  "capped",
  "no_credits",
  "expired",
  "dropped",
  "flag_off",
];
const BANDS = ["1", "2_4", "5_9", "10_plus"];
const KINDS: readonly string[] = MODEL_FAILURE_KINDS;
const MODEL_KEYS = ["event", "source", "attempts", "seconds", "bytes", "reason", "at"];
const WAKE_KEYS = ["event", "files", "at"];
const BOUNDS: Record<string, [number, number]> = {
  attempts: [1, 12],
  seconds: [0, 86_400],
  bytes: [0, 2_147_483_647],
};

describe("the vocabulary", () => {
  it("is the agreed one, and the key says which version of it", () => {
    expect([...MODEL_FACT_EVENTS].sort()).toEqual([...MODEL_EVENTS].sort());
    expect([...MODEL_FACT_SOURCES].sort()).toEqual([...SOURCES].sort());
    expect([...WAKE_FACT_EVENTS].sort()).toEqual([...WAKE_EVENTS].sort());
    expect([...WAKE_FILE_BANDS].sort()).toEqual([...BANDS].sort());
    expect(FACT_RING).toBe(40);
    expect(FACTS_KEY).toBe("artdaddy.local_facts.v1");
  });
});

interface Memory {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  data: Map<string, string>;
}

function memory(initial?: string): Memory {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(FACTS_KEY, initial);
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    data,
  };
}

/** The stored text, parsed: what is really in storage, not what a read hands back. */
const stored = (m: Memory): any => JSON.parse(m.data.get(FACTS_KEY) ?? "null");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const longest = (words: readonly string[]) => Math.max(...words.map((word) => word.length));

/** Every rule a stored fact keeps, whoever wrote it and whatever it was given. */
function expectClosedFact(
  value: unknown,
  keys: readonly string[],
  words: Record<string, readonly string[]>,
): void {
  expect(isRecord(value), "a fact is an object").toBe(true);
  const fact = value as Record<string, unknown>;
  for (const key of Object.keys(fact)) expect(keys, `stray key "${key}"`).toContain(key);
  expect("event" in fact && "at" in fact, "a fact always has an event and a time").toBe(true);
  expect(isFiniteNumber(fact.at), "the time is a finite number").toBe(true);
  for (const [key, list] of Object.entries(words)) {
    if (!(key in fact)) continue;
    expect(list, `${key} is not one of its words`).toContain(fact[key]);
    expect((fact[key] as string).length).toBeLessThanOrEqual(longest(list));
  }
  for (const [key, [min, max]] of Object.entries(BOUNDS)) {
    if (!(key in fact)) continue;
    expect(Number.isInteger(fact[key]), `${key} is a whole number`).toBe(true);
    expect(fact[key] as number).toBeGreaterThanOrEqual(min);
    expect(fact[key] as number).toBeLessThanOrEqual(max);
  }
}
const expectClosedModelFact = (value: unknown) =>
  expectClosedFact(value, MODEL_KEYS, { event: MODEL_EVENTS, source: SOURCES, reason: KINDS });
const expectClosedWakeFact = (value: unknown) =>
  expectClosedFact(value, WAKE_KEYS, { event: WAKE_EVENTS, files: BANDS });

/** The whole stored text: two streams and nothing else, each a short list of closed facts. */
function expectClosedRecord(text: string | undefined): void {
  expect(typeof text).toBe("string");
  const parsed: unknown = JSON.parse(text as string);
  expect(isRecord(parsed)).toBe(true);
  const record = parsed as Record<string, unknown>;
  expect(Object.keys(record).sort()).toEqual(["model_download", "speech_wake"]);
  const { model_download: models, speech_wake: wakes } = record;
  expect(Array.isArray(models) && Array.isArray(wakes)).toBe(true);
  expect((models as unknown[]).length).toBeLessThanOrEqual(FACT_RING);
  expect((wakes as unknown[]).length).toBeLessThanOrEqual(FACT_RING);
  (models as unknown[]).forEach(expectClosedModelFact);
  (wakes as unknown[]).forEach(expectClosedWakeFact);
}

const wildString = fc.oneof(
  fc.string(),
  fc.string({ unit: "binary" }),
  fc.constantFrom(
    "",
    "__proto__",
    "constructor",
    "toString",
    "Primary",
    "DOWNLOAD_STARTED",
    " download_started",
    "download_started ",
    "download-started",
    "primary,extra_1",
    "a".repeat(5000),
  ),
);
const wildNumber = fc.oneof(
  fc.integer(),
  fc.double(),
  fc.constantFrom(
    NaN,
    Infinity,
    -Infinity,
    -0,
    0,
    1,
    12,
    13,
    86_400,
    86_401,
    2_147_483_647,
    2_147_483_648,
    1e300,
    -1e300,
    Number.MAX_SAFE_INTEGER,
  ),
);
const wild = fc.oneof(
  wildString,
  wildNumber,
  fc.anything(),
  fc.constantFrom<unknown>(undefined, null, true, false, 10n),
);
/** A field that is right about half the time and wild the rest. */
const mostlyWild = <T>(valid: fc.Arbitrary<T>) =>
  fc.oneof(
    { weight: 2, arbitrary: valid as fc.Arbitrary<unknown> },
    { weight: 3, arbitrary: wild },
  );

const at = fc.integer({ min: 0, max: 2 ** 41 });
const modelEvent = fc.constantFrom(...MODEL_EVENTS);
const wakeEvent = fc.constantFrom(...WAKE_EVENTS);

const wildModelFact = fc.record(
  {
    event: mostlyWild(modelEvent),
    source: mostlyWild(fc.constantFrom(...SOURCES)),
    attempts: mostlyWild(fc.integer({ min: 1, max: 12 })),
    seconds: mostlyWild(fc.integer({ min: 0, max: 86_400 })),
    bytes: mostlyWild(fc.integer({ min: 0, max: 2_147_483_647 })),
    reason: mostlyWild(fc.constantFrom(...KINDS)),
    at: mostlyWild(at),
  },
  { requiredKeys: [] },
);
const wildWakeFact = fc.record(
  {
    event: mostlyWild(wakeEvent),
    files: mostlyWild(fc.constantFrom(...BANDS)),
    at: mostlyWild(at),
  },
  { requiredKeys: [] },
);

/** A fact that is right in every field, so a round trip must give it back unchanged. */
const validModelFact = fc
  .record(
    {
      event: modelEvent,
      source: fc.constantFrom(...SOURCES),
      attempts: fc.integer({ min: 1, max: 12 }),
      seconds: fc.integer({ min: 0, max: 86_400 }),
      bytes: fc.integer({ min: 0, max: 2_147_483_647 }),
      reason: fc.constantFrom(...KINDS),
      at,
    },
    { requiredKeys: ["event", "at"] },
  )
  .map((fact) => fact as ModelFact);
const validWakeFact = fc
  .record(
    { event: wakeEvent, files: fc.constantFrom(...BANDS), at },
    { requiredKeys: ["event", "at"] },
  )
  .map((fact) => fact as WakeFact);

const F1: ModelFact = { event: "download_started", source: "primary", at: 1 };
const F2: ModelFact = { event: "download_finished", seconds: 20, bytes: 1000, at: 2 };
const W1: WakeFact = { event: "woke", files: "2_4", at: 3 };

describe("what goes in: closed words and bounded numbers, whatever the fields hold", () => {
  it("stores a model fact only as closed words and bounded numbers", () => {
    let recorded = 0;
    fc.assert(
      fc.property(wildModelFact, (input) => {
        const m = memory();
        recordFact("model_download", input as ModelFact, m);
        const recordable = MODEL_EVENTS.includes(input.event as string) && isFiniteNumber(input.at);
        if (!recordable) {
          expect(m.data.has(FACTS_KEY), "an unusable fact must leave storage untouched").toBe(
            false,
          );
          return;
        }
        recorded++;
        expectClosedRecord(m.data.get(FACTS_KEY));
        const facts = stored(m).model_download as Array<Record<string, unknown>>;
        expect(facts).toHaveLength(1);
        const [fact] = facts;
        expect(fact.event).toBe(input.event);
        expect(fact.at === input.at).toBe(true);
        // A field is kept exactly when it is valid; a wrong one drops ITSELF, never the fact.
        for (const [key, list] of [
          ["source", SOURCES],
          ["reason", KINDS],
        ] as const)
          expect(key in fact, key).toBe(list.includes(input[key] as string));
        for (const [key, [min, max]] of Object.entries(BOUNDS)) {
          const given = (input as Record<string, unknown>)[key];
          expect(key in fact, key).toBe(isFiniteNumber(given));
          if (!isFiniteNumber(given)) continue;
          const kept = fact[key] as number;
          if (given > max) expect(kept).toBe(max);
          else if (given < min) expect(kept).toBe(min);
          else expect(Math.abs(kept - given)).toBeLessThan(1);
        }
      }),
      { numRuns: 500 },
    );
    expect(recorded, "the generator must reach the recording side").toBeGreaterThan(0);
  });

  it("stores a wake fact only as closed words", () => {
    let recorded = 0;
    fc.assert(
      fc.property(wildWakeFact, (input) => {
        const m = memory();
        recordFact("speech_wake", input as WakeFact, m);
        const recordable = WAKE_EVENTS.includes(input.event as string) && isFiniteNumber(input.at);
        if (!recordable) {
          expect(m.data.has(FACTS_KEY)).toBe(false);
          return;
        }
        recorded++;
        expectClosedRecord(m.data.get(FACTS_KEY));
        const [fact] = stored(m).speech_wake as Array<Record<string, unknown>>;
        expect(fact.event).toBe(input.event);
        expect("files" in fact).toBe(BANDS.includes(input.files as string));
        if ("files" in fact) expect(fact.files).toBe(input.files);
      }),
      { numRuns: 500 },
    );
    expect(recorded).toBeGreaterThan(0);
  });

  it("loses nothing legitimate: a fact that is right in every field comes back unchanged", () => {
    fc.assert(
      fc.property(validModelFact, validWakeFact, (model, wake) => {
        const m = memory();
        recordFact("model_download", model, m);
        recordFact("speech_wake", wake, m);
        expect(readFacts("model_download", m)).toEqual([model]);
        expect(readFacts("speech_wake", m)).toEqual([wake]);
      }),
    );
  });

  it("is monotone in every number: a larger input never gives a smaller stored number", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...Object.keys(BOUNDS)),
        fc.double({ noNaN: true, noDefaultInfinity: true }),
        fc.double({ noNaN: true, noDefaultInfinity: true }),
        (key, a, b) => {
          const keep = (value: number): number => {
            const m = memory();
            recordFact(
              "model_download",
              { event: "download_started", at: 1, [key]: value } as ModelFact,
              m,
            );
            return stored(m).model_download[0][key] as number;
          };
          const [low, high] = a <= b ? [a, b] : [b, a];
          expect(keep(low)).toBeLessThanOrEqual(keep(high));
        },
      ),
    );
  });

  it.each<[string, number, number]>([
    ["attempts", 0, 1],
    ["attempts", 1, 1],
    ["attempts", 12, 12],
    ["attempts", 13, 12],
    ["attempts", -5, 1],
    ["attempts", 1e300, 12],
    ["seconds", -1, 0],
    ["seconds", 0, 0],
    ["seconds", 86_400, 86_400],
    ["seconds", 86_401, 86_400],
    ["seconds", 1e300, 86_400],
    ["bytes", -1, 0],
    ["bytes", 2_147_483_647, 2_147_483_647],
    ["bytes", 2_147_483_648, 2_147_483_647],
    ["bytes", -1e300, 0],
  ])("keeps %s=%s as %s: the nearest value inside its bounds", (key, given, kept) => {
    const m = memory();
    recordFact(
      "model_download",
      { event: "download_started", at: 1, [key]: given } as ModelFact,
      m,
    );
    expect(stored(m).model_download[0][key]).toBe(kept);
  });

  it("keeps a fractional number as a whole number beside it", () => {
    for (const given of [2.4, 2.5, 2.6, 7.999]) {
      const m = memory();
      recordFact("model_download", { event: "download_started", at: 1, seconds: given }, m);
      const kept = stored(m).model_download[0].seconds as number;
      expect(Number.isInteger(kept)).toBe(true);
      expect(Math.abs(kept - given)).toBeLessThan(1);
    }
  });

  it.each<[string, unknown]>([
    ["NaN", NaN],
    ["infinity", Infinity],
    ["minus infinity", -Infinity],
    ["a numeric string", "5"],
    ["null", null],
    ["a boolean", true],
    ["a bigint", 5n],
    ["a list holding a number", [5]],
    ["a boxed number", new Number(5)],
  ])("drops a number field that is %s and keeps the fact", (_what, given) => {
    const m = memory();
    recordFact(
      "model_download",
      {
        event: "download_failed",
        at: 1,
        attempts: given,
        seconds: given,
        bytes: given,
      } as ModelFact,
      m,
    );
    expect(stored(m).model_download).toEqual([{ event: "download_failed", at: 1 }]);
  });

  it("drops a word that is not listed from its field only, and keeps the fact", () => {
    const m = memory();
    recordFact(
      "model_download",
      {
        event: "download_failed",
        at: 1,
        attempts: 3,
        source: "nowhere",
        reason: "made_up",
      } as never,
      m,
    );
    expect(stored(m).model_download).toEqual([{ event: "download_failed", at: 1, attempts: 3 }]);
    recordFact("speech_wake", { event: "woke", at: 2, files: "11" } as never, m);
    expect(stored(m).speech_wake).toEqual([{ event: "woke", at: 2 }]);
  });

  it.each<[string, unknown]>([
    ["an object that prints as a word", { toString: () => "primary" }],
    ["a boxed string", new String("primary")],
    ["a list holding a word", ["primary"]],
    ["a word with a space after it", "primary "],
    ["a word in capitals", "PRIMARY"],
  ])("does not take %s for a word", (_what, given) => {
    const m = memory();
    recordFact(
      "model_download",
      { event: "download_started", at: 1, source: given, reason: given } as never,
      m,
    );
    expect(stored(m).model_download).toEqual([{ event: "download_started", at: 1 }]);
  });

  it.each<[string, unknown]>([
    ["an event that is not listed", { event: "bogus", at: 1 }],
    ["an event in capitals", { event: "DOWNLOAD_STARTED", at: 1 }],
    ["an event with a space before it", { event: " download_started", at: 1 }],
    ["an event of the other stream", { event: "woke", at: 1 }],
    ["no event", { at: 1 }],
    ["no time", { event: "download_started" }],
    ["a time that is NaN", { event: "download_started", at: NaN }],
    ["a time of infinity", { event: "download_started", at: Infinity }],
    ["a time that is a string", { event: "download_started", at: "1" }],
    ["a boxed time", { event: "download_started", at: new Number(1) }],
    ["a time of null", { event: "download_started", at: null }],
    ["null", null],
    ["a string", "download_started"],
    ["a number", 5],
    ["a list", ["download_started", 1]],
  ])("records nothing for %s", (_what, given) => {
    const m = memory();
    recordFact("model_download", given as never, m);
    expect(m.data.has(FACTS_KEY)).toBe(false);
    expect(readFacts("model_download", m)).toEqual([]);
  });

  it("records nothing for an event of the other stream, on either stream", () => {
    const m = memory();
    recordFact("speech_wake", { event: "download_started", at: 1 } as never, m);
    recordFact("model_download", { event: "registered", at: 1 } as never, m);
    expect(m.data.has(FACTS_KEY)).toBe(false);
  });

  it("records nothing, and does not throw, for a stream it does not know", () => {
    const m = memory();
    expect(() => recordFact("other" as never, F1 as never, m)).not.toThrow();
    expect(m.data.has(FACTS_KEY)).toBe(false);
    expect(readFacts("other" as never, m)).toEqual([]);
  });

  it("stays small whatever is thrown at it, so free text cannot pile up", () => {
    const m = memory();
    fc.assert(
      fc.property(wildModelFact, wildWakeFact, (model, wake) => {
        recordFact("model_download", model as ModelFact, m);
        recordFact("speech_wake", wake as WakeFact, m);
      }),
      { numRuns: 400 },
    );
    const text = m.data.get(FACTS_KEY);
    expectClosedRecord(text);
    expect((text as string).length).toBeLessThan(12_000);
  });
});

describe("what goes in: only what the caller's own object holds", () => {
  it("rebuilds the fact from the known fields: extra properties never reach storage", () => {
    fc.assert(
      fc.property(
        validModelFact,
        fc.dictionary(
          fc.string().filter((key) => !MODEL_KEYS.includes(key)),
          fc.anything(),
          { maxKeys: 6 },
        ),
        (valid, extras) => {
          const m = memory();
          recordFact("model_download", { ...extras, ...valid }, m);
          const [fact] = stored(m).model_download as Array<Record<string, unknown>>;
          expect(Object.keys(fact).sort()).toEqual(Object.keys(valid).sort());
          expect(readFacts("model_download", m)).toEqual([valid]);
        },
      ),
    );
  });

  it("keeps a path, a name and an error text off the record, even under the known keys' neighbours", () => {
    const m = memory();
    recordFact(
      "model_download",
      {
        event: "download_failed",
        at: 1,
        path: "C:\\Users\\someone\\models\\ggml-small.bin",
        message: "HTTP 503 from https://example.test/path",
        reasonText: "boom",
        nested: { name: "someone" },
      } as never,
      m,
    );
    expect(m.data.get(FACTS_KEY)).not.toMatch(/someone|example|boom|503|ggml/);
    expect(stored(m).model_download).toEqual([{ event: "download_failed", at: 1 }]);
  });

  it("never reads a field the caller's object merely inherits", () => {
    const poison = {
      source: "extra_1",
      attempts: 7,
      seconds: 7,
      bytes: 7,
      reason: "network",
      leak: "C:\\somewhere",
    };
    const m = memory();
    recordFact(
      "model_download",
      Object.assign(Object.create(poison), { event: "download_started", at: 5 }),
      m,
    );
    expect(stored(m).model_download).toEqual([{ event: "download_started", at: 5 }]);
    // an object with nothing of its own is not a fact, whatever it inherits
    const bare = memory();
    recordFact("model_download", Object.create({ event: "download_started", at: 5 }), bare);
    expect(bare.data.has(FACTS_KEY)).toBe(false);
  });

  it("is not moved by a polluted Object.prototype, on the way in or out", () => {
    // Some of these are read-only: an assignment to a field of the same name on an ordinary object
    // is refused while one is on the prototype, so a fact built by assignment would be lost.
    const polluted: Array<[string, unknown, boolean]> = [
      ["source", "extra_2", false],
      ["attempts", 9, true],
      ["seconds", 9, true],
      ["bytes", 9, false],
      ["reason", "damaged", false],
      ["files", "10_plus", true],
      ["leak", "x", true],
    ];
    const m = memory();
    const before = memory(
      JSON.stringify({
        model_download: [{ event: "download_started", at: 1 }],
        speech_wake: [{ event: "woke", at: 2 }],
      }),
    );
    let read: ReadonlyArray<ModelFact> = [];
    let readWake: ReadonlyArray<WakeFact> = [];
    try {
      for (const [key, value, writable] of polluted)
        Object.defineProperty(Object.prototype, key, {
          value,
          writable,
          configurable: true,
          enumerable: true,
        });
      recordFact("model_download", { event: "download_started", at: 5 }, m);
      recordFact("model_download", { event: "download_failed", source: "primary", at: 6 }, m);
      recordFact("speech_wake", { event: "woke", at: 7 }, m);
      read = readFacts("model_download", before);
      readWake = readFacts("speech_wake", before);
    } finally {
      for (const [key] of polluted) Reflect.deleteProperty(Object.prototype, key);
    }
    expect(stored(m).model_download).toEqual([
      { event: "download_started", at: 5 },
      { event: "download_failed", source: "primary", at: 6 },
    ]);
    expect(stored(m).speech_wake).toEqual([{ event: "woke", at: 7 }]);
    expect(Object.keys(read[0])).toEqual(["event", "at"]);
    expect(Object.keys(readWake[0])).toEqual(["event", "at"]);
  });

  it("is not moved by a __proto__ key in the stored text, and does not pollute anything", () => {
    const m = memory(
      '{"model_download":[{"__proto__":{"reason":"network","leak":1},"event":"download_started","at":1}],' +
        '"speech_wake":[],"__proto__":{"model_download":[{"event":"download_failed","at":9}]}}',
    );
    const [fact] = readFacts("model_download", m);
    expect(Object.keys(fact)).toEqual(["event", "at"]);
    expect((fact as { reason?: string }).reason).toBeUndefined();
    expect(({} as { reason?: string }).reason).toBeUndefined();
    recordFact("model_download", F2, m);
    expectClosedRecord(m.data.get(FACTS_KEY));
    expect(stored(m).model_download).toHaveLength(2);
  });

  it("does not touch the object it was given", () => {
    const frozen = Object.freeze({ event: "download_finished" as const, bytes: 5, at: 1 });
    const m = memory();
    recordFact("model_download", frozen, m);
    expect(readFacts("model_download", m)).toEqual([frozen]);
  });

  it("does not throw, and records nothing, for a fact that cannot be read", () => {
    const boom = () => {
      throw new Error("boom");
    };
    const getter = Object.defineProperty({ at: 1 }, "event", { enumerable: true, get: boom });
    const proxy = new Proxy({}, { get: boom, has: boom, getOwnPropertyDescriptor: boom });
    for (const fact of [getter, proxy]) {
      const m = memory();
      expect(() => recordFact("model_download", fact as never, m)).not.toThrow();
      expect(m.data.has(FACTS_KEY)).toBe(false);
    }
  });
});

describe("the ring: the newest facts of each stream", () => {
  it("keeps exactly the newest 40, in the order they were recorded", () => {
    fc.assert(
      fc.property(fc.array(validModelFact, { maxLength: 130 }), (facts) => {
        const m = memory();
        for (const fact of facts) recordFact("model_download", fact, m);
        expect(readFacts("model_download", m)).toEqual(facts.slice(-FACT_RING));
        if (facts.length > 0) expectClosedRecord(m.data.get(FACTS_KEY));
      }),
    );
  });

  it("drops the oldest when the 41st arrives, and never before", () => {
    const m = memory();
    const facts = Array.from({ length: 41 }, (_, i): ModelFact => ({
      event: "download_started",
      at: i,
    }));
    facts.slice(0, 40).forEach((fact) => recordFact("model_download", fact, m));
    expect(readFacts("model_download", m).map((fact) => fact.at)).toEqual(
      facts.slice(0, 40).map((f) => f.at),
    );
    recordFact("model_download", facts[40], m);
    const ats = readFacts("model_download", m).map((fact) => fact.at);
    expect(ats).toHaveLength(40);
    expect(ats[0]).toBe(1);
    expect(ats[39]).toBe(40);
  });

  it("is about the order of recording, not the time written on a fact", () => {
    const m = memory();
    const facts = Array.from({ length: 55 }, (_, i): WakeFact => ({ event: "woke", at: 1000 - i }));
    for (const fact of facts) recordFact("speech_wake", fact, m);
    expect(readFacts("speech_wake", m)).toEqual(facts.slice(-FACT_RING));
  });

  it("keeps each stream's own ring, whatever order the two are recorded in", () => {
    const step = fc.oneof(
      validModelFact.map((fact) => ({ stream: "model_download" as const, fact })),
      validWakeFact.map((fact) => ({ stream: "speech_wake" as const, fact })),
    );
    fc.assert(
      fc.property(fc.array(step, { maxLength: 160 }), (steps) => {
        const m = memory();
        for (const s of steps) {
          if (s.stream === "model_download") recordFact("model_download", s.fact, m);
          else recordFact("speech_wake", s.fact, m);
        }
        const only = <S extends string>(name: S) =>
          steps.filter((s) => s.stream === name).map((s) => s.fact);
        expect(readFacts("model_download", m)).toEqual(only("model_download").slice(-FACT_RING));
        expect(readFacts("speech_wake", m)).toEqual(only("speech_wake").slice(-FACT_RING));
      }),
    );
  });

  it("is not pushed out by a flood on the other stream", () => {
    const m = memory();
    recordFact("speech_wake", W1, m);
    for (let i = 0; i < 100; i++)
      recordFact("model_download", { event: "download_started", at: i }, m);
    expect(readFacts("speech_wake", m)).toEqual([W1]);
    expect(readFacts("model_download", m)).toHaveLength(FACT_RING);
    for (let i = 0; i < 100; i++) recordFact("speech_wake", { event: "woke", at: i }, m);
    expect(readFacts("model_download", m)).toHaveLength(FACT_RING);
  });

  it("hands back a copy: changing what was read does not change what is stored", () => {
    const m = memory();
    recordFact("model_download", F1, m);
    (readFacts("model_download", m) as ModelFact[]).push(F2);
    (readFacts("model_download", m) as ModelFact[])[0].at = 99;
    expect(readFacts("model_download", m)).toEqual([F1]);
  });
});

// Each of these is something storage can hold that this code did not write.
const DAMAGED: ReadonlyArray<[string, string]> = [
  ["empty text", ""],
  ["text that is not JSON", "not json"],
  ["an object cut off", '{"model_download":['],
  ["null", "null"],
  ["a number", "42"],
  ["a string", '"model_download"'],
  ["a boolean", "true"],
  ["an empty list", "[]"],
  ["a list holding a record", '[{"model_download":[],"speech_wake":[]}]'],
  ["streams that are not lists", '{"model_download":"x","speech_wake":7}'],
  [
    "streams that are objects",
    '{"model_download":{"0":{"event":"download_started","at":1}},"speech_wake":{}}',
  ],
  [
    "lists of things that are not facts",
    '{"model_download":[1,"a",null,true,[],{}],"speech_wake":[null]}',
  ],
  [
    "facts with an event that is not listed, or from the other stream",
    '{"model_download":[{"event":"bogus","at":1}],"speech_wake":[{"event":"download_started","at":1}]}',
  ],
  ["facts with no time", '{"model_download":[{"event":"download_started"}],"speech_wake":[]}'],
  [
    "facts with a time that is not a number",
    '{"model_download":[{"event":"download_started","at":"1"}],"speech_wake":[]}',
  ],
  ["somebody else's record under this key", '{"someone":"else","note":"not ours"}'],
  ["a value nested far too deep", "[".repeat(50_000)],
];

describe("what comes out, and storage that holds something else", () => {
  it.each(DAMAGED)("reads %s as no facts, and the next record still works", (_what, text) => {
    const m = memory(text);
    expect(readFacts("model_download", m)).toEqual([]);
    expect(readFacts("speech_wake", m)).toEqual([]);
    recordFact("model_download", F1, m);
    expect(readFacts("model_download", m)).toEqual([F1]);
    expect(readFacts("speech_wake", m)).toEqual([]);
    expectClosedRecord(m.data.get(FACTS_KEY));
    expect(stored(m)).toEqual({ model_download: [F1], speech_wake: [] });
  });

  it("keeps the good facts beside bad ones, and a good stream beside a broken one", () => {
    const m = memory(
      JSON.stringify({
        model_download: [F1, 5, { event: "bogus", at: 1 }, null, F2],
        speech_wake: "broken",
        someone_else: { note: "x" },
      }),
    );
    expect(readFacts("model_download", m)).toEqual([F1, F2]);
    expect(readFacts("speech_wake", m)).toEqual([]);
    recordFact("speech_wake", W1, m);
    expect(stored(m)).toEqual({ model_download: [F1, F2], speech_wake: [W1] });
  });

  it("reads back only closed facts, whatever text is in storage", () => {
    // A bigint is something a wild field can hold and JSON cannot write down; it goes in as text.
    const asText = (value: unknown) =>
      JSON.stringify(value, (_key, part) => (typeof part === "bigint" ? part.toString() : part));
    const text = fc.oneof(
      fc.jsonValue().map(asText),
      fc
        .record(
          { model_download: fc.array(wildModelFact), speech_wake: fc.array(wildWakeFact) },
          { requiredKeys: [] },
        )
        .map(asText),
      fc.string(),
    );
    let readSome = 0;
    fc.assert(
      fc.property(text, (given) => {
        const m = memory(given);
        const models = readFacts("model_download", m);
        const wakes = readFacts("speech_wake", m);
        expect(models.length).toBeLessThanOrEqual(FACT_RING);
        expect(wakes.length).toBeLessThanOrEqual(FACT_RING);
        models.forEach(expectClosedModelFact);
        wakes.forEach(expectClosedWakeFact);
        if (models.length + wakes.length > 0) readSome++;
        recordFact("speech_wake", W1, m);
        expectClosedRecord(m.data.get(FACTS_KEY));
      }),
      { numRuns: 400 },
    );
    expect(readSome, "the generator must reach text that holds facts").toBeGreaterThan(0);
  });

  it("never reads more than the ring, even from a record somebody made longer", () => {
    const long = Array.from({ length: 90 }, (_, i) => ({ event: "download_started", at: i }));
    const m = memory(JSON.stringify({ model_download: long, speech_wake: [] }));
    const facts = readFacts("model_download", m);
    expect(facts).toHaveLength(FACT_RING);
    expect(facts[0].at).toBe(50);
    expect(facts[FACT_RING - 1].at).toBe(89);
  });
});

describe("storage that fails", () => {
  const boom = () => {
    throw new Error("blocked");
  };
  const nothing = () => undefined;
  const STORES: ReadonlyArray<[string, { getItem: unknown; setItem: unknown } | null]> = [
    ["no storage at all", null],
    ["reads that throw", { getItem: boom, setItem: nothing }],
    ["writes that throw", { getItem: () => null, setItem: boom }],
    ["reads and writes that throw", { getItem: boom, setItem: boom }],
    ["a read that answers with a number", { getItem: () => 42, setItem: nothing }],
    ["a read that answers with undefined", { getItem: () => undefined, setItem: nothing }],
    ["a read that answers with an object", { getItem: () => ({}), setItem: nothing }],
  ];

  it.each(STORES)("does not throw for %s, and reads no facts", (_what, store) => {
    const s = store as never;
    expect(() => recordFact("model_download", F1, s)).not.toThrow();
    expect(() => recordFact("speech_wake", W1, s)).not.toThrow();
    expect(() => clearFacts(s)).not.toThrow();
    expect(() => readFacts("model_download", s)).not.toThrow();
    expect(readFacts("model_download", s)).toEqual([]);
    expect(readFacts("speech_wake", s)).toEqual([]);
  });

  it("writes nothing over a record it could not read, and works again when storage does", () => {
    const m = memory(JSON.stringify({ model_download: [F1], speech_wake: [W1] }));
    let blocked = true;
    const flaky = {
      getItem: (key: string) => {
        if (blocked) throw new Error("blocked");
        return m.getItem(key);
      },
      setItem: m.setItem,
    };
    recordFact("model_download", F2, flaky);
    clearFacts({
      getItem: flaky.getItem,
      setItem: () => {
        throw new Error("blocked");
      },
    });
    blocked = false;
    expect(readFacts("model_download", m)).toEqual([F1]);
    expect(readFacts("speech_wake", m)).toEqual([W1]);
    recordFact("model_download", F2, flaky);
    expect(readFacts("model_download", m)).toEqual([F1, F2]);
    expect(readFacts("speech_wake", m)).toEqual([W1]);
  });

  it("does not throw whatever the facts and the storage are", () => {
    fc.assert(
      fc.property(
        wildModelFact,
        wildWakeFact,
        fc.constantFrom(...STORES),
        (model, wake, [, store]) => {
          const s = store as never;
          expect(() => {
            recordFact("model_download", model as ModelFact, s);
            recordFact("speech_wake", wake as WakeFact, s);
            readFacts("model_download", s);
            readFacts("speech_wake", s);
          }).not.toThrow();
        },
      ),
    );
  });
});

describe("clearing", () => {
  it("forgets both streams, and the record still takes facts afterwards", () => {
    const m = memory();
    recordFact("model_download", F1, m);
    recordFact("speech_wake", W1, m);
    clearFacts(m);
    expect(readFacts("model_download", m)).toEqual([]);
    expect(readFacts("speech_wake", m)).toEqual([]);
    expectClosedRecord(m.data.get(FACTS_KEY));
    recordFact("speech_wake", W1, m);
    expect(readFacts("speech_wake", m)).toEqual([W1]);
  });

  it("clears a damaged record too", () => {
    const m = memory("not json");
    clearFacts(m);
    expectClosedRecord(m.data.get(FACTS_KEY));
  });
});

describe("the default storage is this page's localStorage", () => {
  // The configured unstubbing happens before the NEXT test, so this puts the real one back first.
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.removeItem(FACTS_KEY);
  });

  it("keeps facts there, in one record under the key", () => {
    recordFact("speech_wake", W1);
    recordFact("model_download", F1);
    expect(JSON.parse(localStorage.getItem(FACTS_KEY) ?? "null")).toEqual({
      model_download: [F1],
      speech_wake: [W1],
    });
    expect(readFacts("speech_wake")).toEqual([W1]);
    clearFacts();
    expect(readFacts("speech_wake")).toEqual([]);
    expect(readFacts("model_download")).toEqual([]);
  });

  it("keeps nothing, and throws nothing, where there is no localStorage", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(() => recordFact("model_download", F1)).not.toThrow();
    expect(() => clearFacts()).not.toThrow();
    expect(readFacts("model_download")).toEqual([]);
  });

  it("keeps nothing, and throws nothing, where reaching localStorage throws", () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    try {
      expect(() => recordFact("model_download", F1)).not.toThrow();
      expect(() => clearFacts()).not.toThrow();
      expect(readFacts("model_download")).toEqual([]);
    } finally {
      if (saved) Object.defineProperty(globalThis, "localStorage", saved);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});

describe("fileBand", () => {
  // Built from lists, not comparisons, so it is not the code's own arithmetic again.
  const BAND_OF = new Map<number, string>([[1, "1"]]);
  for (const n of [2, 3, 4]) BAND_OF.set(n, "2_4");
  for (const n of [5, 6, 7, 8, 9]) BAND_OF.set(n, "5_9");
  const expected = (n: number) => (n >= 10 ? "10_plus" : BAND_OF.get(n));

  it.each<[number, string]>([
    [1, "1"],
    [2, "2_4"],
    [4, "2_4"],
    [5, "5_9"],
    [9, "5_9"],
    [10, "10_plus"],
    [11, "10_plus"],
    [1000, "10_plus"],
    [Infinity, "10_plus"],
    [0, "1"],
    [-3, "1"],
    [-Infinity, "1"],
    [NaN, "1"],
  ])("puts %s in band %s", (files, band) => {
    expect(fileBand(files)).toBe(band);
  });

  it("puts every whole number of files, 1 to 200, in its band", () => {
    for (let files = 1; files <= 200; files++)
      expect(fileBand(files), String(files)).toBe(expected(files));
  });

  it("puts a number between two whole numbers no higher than the one above it, and not below the one below", () => {
    for (const files of [1.5, 2.5, 4.99, 5.5, 9.99, 10.5]) {
      const rank = (n: number) => WAKE_FILE_BANDS.indexOf(fileBand(n));
      expect(rank(files)).toBeGreaterThanOrEqual(rank(Math.floor(files)));
      expect(rank(files)).toBeLessThanOrEqual(rank(Math.ceil(files)));
    }
  });

  it("is always a listed band, and never moves down as the count goes up", () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true }), fc.double({ noNaN: true }), (a, b) => {
        const [low, high] = a <= b ? [a, b] : [b, a];
        const rank = (n: number) => WAKE_FILE_BANDS.indexOf(fileBand(n));
        expect(rank(low)).toBeGreaterThanOrEqual(0);
        expect(rank(low)).toBeLessThanOrEqual(rank(high));
      }),
    );
  });

  it.each<[string, unknown]>([
    ["a numeric string", "5"],
    ["null", null],
    ["undefined", undefined],
    ["an object", {}],
    ["a list", [7]],
    ["a boxed number", new Number(7)],
  ])("puts %s in the first band", (_what, given) => {
    expect(fileBand(given as number)).toBe("1");
  });
});
