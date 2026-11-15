// The capture of one run of the real speech engine (speechLiveCapture.ts) and the FAKE engine output it can
// make. The fake engine is what the real-sidecar proof is built and proven on, so what it makes must be what
// the engine prints (the monitor reads it as it reads the engine's), and what the capture file may hold must
// be enforced by the schema check, not promised by the writer: no speech, no path of the person's PC.
import { readFileSync } from "node:fs";
import path from "node:path";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  BLANKED,
  CAPTURE_SCHEMA,
  OPTIONAL_FIELDS,
  OTHER_BLANKED,
  createTextBlanker,
  fakeCapture,
  fakeRun,
  parseCapture,
  readStderrFacts,
  redactPaths,
  replayMonitor,
  sanitizeArgs,
  scaleCapture,
  segmentStats,
  serializeCapture,
  stamp,
  validateCapture,
  withGap,
  type ChipSample,
  type SpeechLiveCapture,
} from "./speechLiveCapture";
import { whisperRunFacts } from "./whisperFacts";

const REAL_STDERR = readFileSync(
  path.join(__dirname, "__fixtures__", "whisper", "cpu.stderr.txt"),
  "utf8",
);

const chipSample: ChipSample = {
  tMs: 12_000,
  phase: "running",
  firstWordsMs: 9_000,
  doneS: 60,
  rate: 0.3,
  etaS: 120,
};
/** A capture with EVERY field the schema knows, the optional ones included: what the conformance walk
 *  deletes from, one path at a time. Built from the generator, never typed out by hand. */
function fullSample(): SpeechLiveCapture {
  const c = fakeCapture({ audioS: 300, rate: 0.4, startupS: 3 });
  return {
    ...c,
    app: { ...fakeRun({ audioS: 300, rate: 0.4, startupS: 3 }), chip: [chipSample] },
  };
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
/** Every path to a value in `v`: objects by key, arrays as `[]` (one element stands for them all). */
function pathsOf(v: Json, prefix = ""): string[] {
  const out: string[] = [];
  if (Array.isArray(v)) {
    if (v.length > 0) out.push(...pathsOf(v[0], `${prefix}[]`));
    return out;
  }
  if (v !== null && typeof v === "object") {
    for (const [k, child] of Object.entries(v)) {
      const here = prefix ? `${prefix}.${k}` : k;
      out.push(here, ...pathsOf(child, here));
    }
  }
  return out;
}
/** `v` without the value at `p` (the first element of every array on the way for `[]`). */
function without(v: Json, p: string): Json {
  const copy = clone(v);
  const parts = p.split(".");
  let node: Json = copy;
  for (let i = 0; i < parts.length; i++) {
    let part = parts[i];
    const last = i === parts.length - 1;
    let arrayHop = false;
    if (part.endsWith("[]")) {
      part = part.slice(0, -2);
      arrayHop = true;
    }
    const obj = node as { [k: string]: Json };
    if (last && !arrayHop) {
      delete obj[part];
      return copy;
    }
    const next = obj[part];
    node = arrayHop ? (next as Json[])[0] : next;
    if (last && arrayHop) {
      (next as Json[]).splice(0, 1);
      return copy;
    }
  }
  return copy;
}

describe("the fake engine's output is what the engine prints, and the monitor reads it as it reads the engine's", () => {
  const options = fc.record({
    audioS: fc.integer({ min: 61, max: 4000 }),
    rate: fc.double({ min: 0.1, max: 3, noNaN: true }),
    startupS: fc.double({ min: 0, max: 60, noNaN: true }),
    comma: fc.boolean(),
    segmentsPerWindow: fc.integer({ min: 1, max: 6 }),
  });

  it("has one burst per decoded 30 s window, every segment, the first words after the start-up and the first window", () => {
    fc.assert(
      fc.property(options, (o) => {
        const run = fakeRun(o);
        const windows = Math.ceil(o.audioS / 30);
        const stats = segmentStats(run.chunks);
        expect(stats.bursts).toBe(windows);
        expect(stats.segments).toBe(windows * o.segmentsPerWindow);
        expect(stats.lastEndS).toBeCloseTo(o.audioS, 2);
        const first = Math.round((o.startupS + 30 * o.rate) * 1000);
        expect(run.chunks[0].tMs).toBe(first);
        for (let i = 1; i < run.chunks.length; i++)
          expect(run.chunks[i].tMs).toBeGreaterThan(run.chunks[i - 1].tMs);
      }),
      { numRuns: 120 },
    );
  });

  it("is read by the monitor to the last segment, at the speed it was made at, with the start-up it was given", () => {
    fc.assert(
      fc.property(options, (o) => {
        // a speed is claimed only after 30 s of audio and 5 s of wall time since the first burst
        fc.pre((o.audioS - 30) * o.rate >= 6 && o.startupS > 0.5);
        const { final } = replayMonitor(fakeRun(o), { liveStop: false });
        expect(final.snapshot.doneS).toBeCloseTo(o.audioS, 2);
        expect(final.snapshot.rate).not.toBeNull();
        expect(final.snapshot.rate!).toBeCloseTo(o.rate, 2);
        expect(final.snapshot.startupS!).toBeCloseTo(o.startupS, 1);
        expect(final.snapshot.backend).toBe("cpu");
      }),
      { numRuns: 120 },
    );
  });

  it("writes the comma form of the timestamps when asked, and the monitor reads the same run either way", () => {
    const dot = fakeRun({ audioS: 600, rate: 0.5, comma: false });
    const comma = fakeRun({ audioS: 600, rate: 0.5, comma: true });
    expect(comma.chunks.map((c) => c.text).join("")).toMatch(/\d{2},\d{3} --> /);
    expect(dot.chunks.map((c) => c.text).join("")).not.toMatch(/\d{2},\d{3} --> /);
    expect(replayMonitor(comma, { liveStop: false }).final.snapshot).toEqual(
      replayMonitor(dot, { liveStop: false }).final.snapshot,
    );
  });

  it("carries the engine's own log: the backend line near the top, the timings at the end, as whisperFacts reads them", () => {
    const run = fakeRun({ audioS: 1500, rate: 0.3, startupS: 3.2, threads: 6 });
    const facts = whisperRunFacts(run.stderrHead);
    expect(facts).toMatchObject({ backend: "cpu", threads: 6, model: "small" });
    expect(facts.audioSeconds).toBeCloseTo(1500, 3);
    expect(run.stderrHead.indexOf("whisper_backend_init_gpu")).toBeLessThan(
      run.stderrHead.indexOf("main: processing"),
    );
    // the engine's own total is its start-up after the process started plus the decoding
    expect(facts.wallSeconds!).toBeCloseTo(3.2 - 0.8 + 1500 * 0.3, 1);
    expect(run.stderrFacts).toEqual(readStderrFacts(run.stderrHead));
    expect(run.stderrFacts.loadMs).toBeGreaterThan(0);
  });

  it("makes the GPU-shaped log too, so the monitor's reading of it is shown on both", () => {
    const run = fakeRun({ audioS: 300, rate: 0.1, backend: "gpu" });
    expect(run.engine.backend).toBe("vulkan");
    expect(replayMonitor(run, { liveStop: false }).final.snapshot.backend).toBe("gpu");
  });

  it("makes a killed run: it ends at the kill, stopped by the person, with no timings and no output left", () => {
    const killed = fakeCapture({ audioS: 1500, rate: 0.3, startupS: 3, killAtMs: 90_000 }).killed!;
    expect(killed.exit).toMatchObject({
      killedAtMs: 90_000,
      stoppedBy: "person",
      outputFileLeft: false,
      launches: 1,
    });
    expect(killed.exit.wallMs).toBe(90_000 + killed.exit.deathMs!);
    expect(Math.max(...killed.chunks.map((c) => c.tMs))).toBeLessThanOrEqual(90_000);
    expect(killed.stderrFacts.totalMs).toBeUndefined();
    expect(killed.finalJson).toBeUndefined();
  });
});

describe("what a time-scaled and a slept-through capture are", () => {
  const run = fakeRun({ audioS: 900, rate: 0.4, startupS: 3 });

  it("is the same capture at k = 1 and at a gap of nothing", () => {
    expect(scaleCapture(run, 1)).toEqual(run);
    expect(withGap(run, 100_000, 0)).toEqual(run);
  });

  it("is a PC k times slower: every time k times, so the monitor reads k times the work per second of audio", () => {
    fc.assert(
      fc.property(fc.double({ min: 0.25, max: 12, noNaN: true }), (k) => {
        const slow = scaleCapture(run, k);
        expect(slow.exit.wallMs).toBeCloseTo(run.exit.wallMs * k, 6);
        expect(slow.stderrFacts.totalMs!).toBeCloseTo(run.stderrFacts.totalMs! * k, 6);
        slow.chunks.forEach((c, i) => expect(c.tMs).toBeCloseTo(run.chunks[i].tMs * k, 6));
        const a = replayMonitor(run, { liveStop: false }).final.snapshot;
        const b = replayMonitor(slow, { liveStop: false }).final.snapshot;
        expect(b.rate!).toBeCloseTo(a.rate! * k, 3);
        expect(b.doneS).toBe(a.doneS);
      }),
      { numRuns: 60 },
    );
  });

  it("is a sleep: what came before the gap is untouched, what came after is later by exactly the gap, in the same order and spacing", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: run.exit.wallMs - 1 }),
        fc.integer({ min: 1, max: 3_600_000 }),
        (at, gap) => {
          const slept = withGap(run, at, gap);
          expect(slept.chunks).toHaveLength(run.chunks.length);
          run.chunks.forEach((c, i) => {
            expect(slept.chunks[i].text).toBe(c.text);
            expect(slept.chunks[i].tMs).toBe(c.tMs > at ? c.tMs + gap : c.tMs);
          });
          expect(slept.exit.wallMs).toBe(run.exit.wallMs + gap);
          expect(slept.stderrFacts).toEqual(run.stderrFacts);
        },
      ),
      { numRuns: 80 },
    );
  });

  it("never touches the capture it was given", () => {
    const before = JSON.stringify(run);
    scaleCapture(run, 3);
    withGap(run, 50_000, 60_000);
    expect(JSON.stringify(run)).toBe(before);
  });
});

describe("what the text blanker keeps and what it drops", () => {
  const word = fc.stringMatching(/^[A-Z]{6,18}$/);
  const lineOf = (from: number, to: number, text: string): string =>
    `[${stamp(from)} --> ${stamp(to)}]  ${text}\n`;
  /** A line of a stdout: a segment line, or output of the engine that is not one (and may be speech for all the
   *  blanker knows): words, a bracketed word that is not a time, an empty line. */
  const line = fc.oneof(
    fc.record({
      kind: fc.constant("segment" as const),
      from: fc.integer({ min: 0, max: 9000 }),
      len: fc.integer({ min: 1, max: 30 }),
      text: word,
    }),
    fc.record({ kind: fc.constant("other" as const), text: word }),
    fc.record({ kind: fc.constant("bracket" as const), text: word }),
    fc.record({ kind: fc.constant("empty" as const) }),
  );
  type Line = typeof line extends fc.Arbitrary<infer T> ? T : never;
  const render = (l: Line): string =>
    l.kind === "segment"
      ? lineOf(l.from, l.from + l.len, l.text)
      : l.kind === "other"
        ? `progress ${l.text}\n`
        : l.kind === "bracket"
          ? `[${l.text}] and more ${l.text}\n`
          : "\n";

  it("keeps every timestamp and the line structure, and no letter of anything else, however the stream is cut", () => {
    fc.assert(
      fc.property(
        fc.array(line, { minLength: 1, maxLength: 25 }),
        fc.array(fc.integer({ min: 1, max: 70 }), { minLength: 1, maxLength: 80 }),
        (lines, cuts) => {
          const original = "\n" + lines.map(render).join("");
          const blank = createTextBlanker();
          let out = "";
          let at = 0;
          for (const size of cuts) {
            out += blank(original.slice(at, at + size));
            at += size;
          }
          out += blank(original.slice(at));
          const whole = createTextBlanker()(original);
          expect(out, "cutting the stream anywhere gives the same file").toBe(whole);
          const segs = lines.filter((l) => l.kind === "segment");
          expect(segmentStats([{ tMs: 0, text: out }]).segments).toBe(segs.length);
          if (segs.length)
            expect(segmentStats([{ tMs: 0, text: out }]).lastEndS).toBeCloseTo(
              Math.max(...segs.map((s) => s.from + s.len)),
              2,
            );
          expect(out.split("\n")).toHaveLength(original.split("\n").length);
          for (const l of lines)
            if ("text" in l) expect(out, `the words ${l.text}`).not.toContain(l.text);
          expect(
            out.split(OTHER_BLANKED).length - 1,
            "one placeholder for each line of other output",
          ).toBe(lines.filter((l) => l.kind === "other" || l.kind === "bracket").length);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("blanks the words of a segment line and any other line of output, and leaves empty lines as they are", () => {
    const blank = createTextBlanker();
    expect(blank("progress = 10%\n")).toBe(`${OTHER_BLANKED}\n`);
    expect(blank(lineOf(0, 3, "hello"))).toBe(`[${stamp(0)} --> ${stamp(3)}]  ${BLANKED}\n`);
    expect(blank("\r\n")).toBe("\r\n");
    expect(blank("[not a time] words\n")).toBe(`${OTHER_BLANKED}\n`);
  });

  it("reads a segment line the pipe cut anywhere, inside its timestamps too", () => {
    const text = lineOf(65.5, 70.25, "words");
    for (let cut = 1; cut < text.length; cut++) {
      const blank = createTextBlanker();
      const out = blank(text.slice(0, cut)) + blank(text.slice(cut));
      expect(out, `cut at ${cut}`).toBe(`[${stamp(65.5)} --> ${stamp(70.25)}]  ${BLANKED}\n`);
    }
  });
});

describe("what the engine's log is cleaned of, and what must survive", () => {
  it("keeps no path of the PC the log was written on, and every fact it was read for", () => {
    const home = String.raw`C:\Users\Someone Real`;
    const log = REAL_STDERR.replaceAll(String.raw`C:\Users\me`, home);
    const clean = redactPaths(log, [home, "Someone Real"]);
    expect(clean).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(clean).not.toContain("Someone");
    expect(clean).not.toContain("AppData");
    expect(whisperRunFacts(clean)).toEqual(whisperRunFacts(log));
    expect(readStderrFacts(clean)).toEqual(readStderrFacts(log));
    expect(clean).toContain("whisper_backend_init_gpu: no GPU found");
    expect(clean.split("\n").length, "no line is lost, only changed").toBe(log.split("\n").length);
  });

  it("cleans a path with spaces on a loading line, a quoted path with either slash, and a bare drive path", () => {
    const dirty = [
      String.raw`load_backend: loaded Vulkan backend from C:\Program Files\App Name\resources\whisper\ggml-vulkan.dll`,
      "output_json: saving output to 'D:/work/launch-1/transcribe/ab12.tmp.json'",
      String.raw`error: could not open E:\x\y.wav at all`,
    ].join("\n");
    const clean = redactPaths(dirty);
    expect(clean).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(clean).toContain("load_backend: loaded Vulkan backend from <path>");
    expect(clean).toContain("output_json: saving output to '<path>'");
    expect(clean).toContain("could not open <path> at all");
  });

  it("names the model by its file, the audio and the scratch by placeholder, and keeps every other flag", () => {
    const args = [
      "-m",
      String.raw`C:\Users\x\AppData\Roaming\App\models\ggml-small.bin`,
      "-f",
      String.raw`C:\Users\x\work\ab12.wav`,
      "-ojf",
      "-of",
      String.raw`C:\Users\x\work\ab12.q.tmp`,
      "-t",
      "6",
      "-l",
      "auto",
      "-mc",
      "0",
      "-ng",
    ];
    expect(sanitizeArgs(args)).toEqual([
      "-m",
      "ggml-small.bin",
      "-f",
      "<audio>",
      "-ojf",
      "-of",
      "<scratch>",
      "-t",
      "6",
      "-l",
      "auto",
      "-mc",
      "0",
      "-ng",
    ]);
  });
});

describe("the schema check refuses what the file may not hold", () => {
  it("accepts what the generator makes, and refuses what is not a capture", () => {
    expect(validateCapture(fullSample())).toEqual([]);
    expect(validateCapture(null)).not.toEqual([]);
    expect(validateCapture("x")).not.toEqual([]);
    expect(validateCapture({})).not.toEqual([]);
  });

  it("needs every field of the schema: deleting any one gives a problem that names it, unless it is declared optional", () => {
    const sample = fullSample() as unknown as Json;
    const all = pathsOf(sample);
    // the walk reaches the sections the optional paths hang from, or it would prove nothing about them
    for (const p of [
      "stderrHead",
      "stderrFacts",
      "exit.wallMs",
      "killed.exit.killedAtMs",
      "killed.chunks[].tMs",
      "app.chip",
      "app.chip[].tMs",
      "finalJson.segments",
    ])
      expect(all, p).toContain(p);
    const optional = new Set<string>(OPTIONAL_FIELDS);
    // a field is optional in the run it belongs to, whichever section that run is in
    const relative = (p: string): string => p.replace(/^(killed|app)\./, "");
    for (const field of OPTIONAL_FIELDS)
      expect(
        all.some((p) => relative(p) === field),
        `declared optional but in no section of the sample: ${field}`,
      ).toBe(true);
    for (const p of all) {
      const problems = validateCapture(without(sample, p));
      if (optional.has(p) || optional.has(relative(p)))
        expect(problems, `${p} is declared optional`).toEqual([]);
      else expect(problems.length, `deleting ${p} was accepted`).toBeGreaterThan(0);
    }
  });

  it("refuses a field of the wrong kind, not only a missing one", () => {
    const c = clone(fullSample()) as unknown as Record<string, unknown>;
    for (const [field, wrong] of [
      ["stderrHead", 5],
      ["audioS", "300"],
      ["chunks", {}],
      ["exit", []],
      ["engine", null],
      ["schema", "speech-live-capture-v2"],
    ] as const) {
      const bad = { ...c, [field]: wrong };
      expect(validateCapture(bad).join(" "), field).toContain(field);
    }
  });

  it("refuses chunks that go back in time, and a run that ended before its last output", () => {
    const c = clone(fullSample());
    c.chunks[3].tMs = c.chunks[2].tMs - 1;
    expect(validateCapture(c).join(" ")).toContain("chunks[3].tMs");
    const d = clone(fullSample());
    d.exit.wallMs = d.chunks[d.chunks.length - 1].tMs - 1;
    expect(validateCapture(d).join(" ")).toContain("exit.wallMs");
    const e = clone(fullSample());
    e.killed!.exit.killedAtMs = e.killed!.exit.wallMs + 1;
    expect(validateCapture(e).join(" ")).toContain("killedAtMs");
  });

  it("refuses speech: a segment line with any text but the placeholder, wherever the line is cut", () => {
    const c = clone(fullSample());
    c.chunks[1].text = c.chunks[1].text.replace(BLANKED, "hello there");
    expect(validateCapture(c).join(" ")).toContain("speech");
    // a line cut in two chunks is judged whole
    const d = clone(fullSample());
    const t = d.chunks[1].text;
    const cut = t.indexOf("]") + 4;
    d.chunks[1] = { ...d.chunks[1], text: t.slice(0, cut) };
    d.chunks[2] = { ...d.chunks[2], text: "secret words\n" + d.chunks[2].text };
    expect(validateCapture(d).join(" ")).toContain("speech");
  });

  it("takes output that is not a segment line only as the placeholder: anything else may be speech", () => {
    const ok = clone(fullSample());
    ok.chunks[1].text = `${OTHER_BLANKED}\n` + ok.chunks[1].text;
    expect(validateCapture(ok)).toEqual([]);
    const bad = clone(fullSample());
    bad.chunks[1].text = "progress = 10%\n" + bad.chunks[1].text;
    expect(validateCapture(bad).join(" ")).toContain("not a segment line");
  });

  it("refuses a path of the PC anywhere in the file: the log, the flags, anything", () => {
    for (const [where, set] of [
      [
        "stderrHead",
        (c: SpeechLiveCapture) => (c.stderrHead += String.raw`loading C:\Users\x\a.bin`),
      ],
      ["args", (c: SpeechLiveCapture) => c.engine.args.push("/Users/someone/audio.wav")],
      ["killed", (c: SpeechLiveCapture) => (c.killed!.stderrHead += "at \\\\host\\share\\x")],
      ["email", (c: SpeechLiveCapture) => (c.stderrHead += "from a@b.example")],
    ] as const) {
      const c = clone(fullSample());
      set(c);
      expect(validateCapture(c).join(" "), where).toContain("privacy");
    }
  });

  it("round-trips through its file form, and says what is wrong with a file that is not one", () => {
    const c = fullSample();
    expect(parseCapture(serializeCapture(c))).toEqual(c);
    const text = serializeCapture(c);
    const oneLine = text.split("\n").filter((l) => l.includes('"tMs"') && l.includes('"text"'));
    expect(oneLine, "every output of the run is one line of the file").toHaveLength(
      c.chunks.length + c.killed!.chunks.length + c.app!.chunks.length,
    );
    expect(() => parseCapture("{}")).toThrow(/schema/);
    expect(() => parseCapture("not json")).toThrow();
    expect(JSON.parse(serializeCapture(c)).schema).toBe(CAPTURE_SCHEMA);
  });
});
