// The engine's own word times over LONG recordings, read by the app's own parser (lane L13, review item L13-003:
// "every word of a recording of any length is moved onto alignment times; the evidence beyond one whisper window is one 38.6 s clip").
// Opt-in: it does nothing unless L13_LONG_DIR is set, and it starts no engine: it reads the raw JSON that rig\long_probe.mjs kept (window L).
//
//   $env:L13_LONG_DIR = "<lane>\results\L"; $env:ARTDADDY_SMOKE_NO_WARMUP = "1"
//   npx vitest run --config vitest.smoke.config.ts src/tools/speechLongFile.analysis.e2e.ts --maxWorkers=1
//
// For every `<id>.dtw.json` in the folder (the output of a launch with `-dtw small -nfa`) it reads the file the two ways the app can,
// as whisper stored the times and on the engine's own times (parseWhisperCppJson), and reports, in `long-analysis.txt` next to it:
//  * the words (the same in both readings, so the nth word of one is the nth word of the other) and how far each moved, by 30 s window of
//    the file and for the words after 60 s: median, 10th and 90th percentile, the largest move either way, and how many moved 0.5 s or more;
//  * the tokens the app refuses as not the file's clock (an alignment time more than WINDOW_MS from where the token was stored);
//  * the words settleWords changed after the tokens were moved (a start that went back is held at the word before it, an end over the next
//    word's start is cut back): the number, and the largest change.
// It asserts only what makes the numbers mean anything: the two readings have the same words in the same order.
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { tokenOnSound, WINDOW_MS } from "./speechWordTimes";
import { parseWhisperCppJson } from "./transcribe";

const DIR = process.env.L13_LONG_DIR ?? "";
const files =
  DIR && fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith(".dtw.json")) : [];
const OUT = process.env.L13_LONG_OUT ?? path.join(DIR || ".", "long-analysis.txt");

interface Token {
  text?: string;
  offsets?: { from?: number; to?: number };
  t_dtw?: number;
}
interface Segment {
  offsets?: { from?: number; to?: number };
  tokens?: Token[];
}
interface RawJson {
  transcription?: Segment[];
}

const median = (xs: number[]): number | null => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length
    ? s.length % 2
      ? s[(s.length - 1) / 2]
      : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
    : null;
};
const quantile = (xs: number[], q: number): number | null => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : null;
};
const f = (x: number | null, d = 2): string => (x === null ? "-" : x.toFixed(d));
const isSpecial = (t: string): boolean => /^\s*\[_/.test(t) || t.trim() === "";

/** The JSON with every token that has a usable engine time moved onto it, exactly as the parser does it, and how many were refused. */
function moved(raw: RawJson): { json: RawJson; refused: number; withTime: number; tokens: number } {
  let refused = 0;
  let withTime = 0;
  let tokens = 0;
  const transcription = (raw.transcription ?? []).map((seg) => {
    const segFrom = seg.offsets?.from ?? 0;
    return {
      ...seg,
      tokens: seg.tokens?.map((tok) => {
        if (isSpecial(tok.text ?? "")) return tok;
        tokens++;
        const from = tok.offsets?.from ?? segFrom;
        if (typeof tok.t_dtw === "number" && tok.t_dtw >= 0) withTime++;
        const at = tokenOnSound({ from, to: tok.offsets?.to ?? from }, tok.t_dtw);
        if (!at) {
          if (typeof tok.t_dtw === "number" && tok.t_dtw >= 0) refused++;
          return tok;
        }
        return { ...tok, offsets: at };
      }),
    };
  });
  return { json: { ...raw, transcription }, refused, withTime, tokens };
}

describe.skipIf(files.length === 0)(
  "the engine's own word times over long recordings, read by the app's parser",
  () => {
    const lines: string[] = [];
    const say = (s = ""): void => void lines.push(s);

    for (const name of files) {
      it(`${name}: the two readings have the same words, and the moves are reported`, () => {
        const rawText = fs.readFileSync(path.join(DIR, name), "utf8");
        const raw = JSON.parse(rawText) as RawJson;
        const stored = parseWhisperCppJson(rawText, { wordTimes: false });
        const aligned = parseWhisperCppJson(rawText, { wordTimes: true });
        expect(aligned.words.map((w) => w.word)).toStrictEqual(stored.words.map((w) => w.word));

        const shifts = aligned.words.map((w, i) => w.start_seconds - stored.words[i].start_seconds);
        const after60 = shifts.filter((_, i) => stored.words[i].start_seconds >= 60);
        const byWindow = new Map<number, number[]>();
        stored.words.forEach((w, i) => {
          const k = Math.floor(w.start_seconds / 30);
          byWindow.set(k, [...(byWindow.get(k) ?? []), shifts[i]]);
        });
        const { json, refused, withTime, tokens } = moved(raw);
        const preSettle = parseWhisperCppJson(JSON.stringify(json), { wordTimes: false });
        expect(preSettle.words).toHaveLength(aligned.words.length);
        const changes = aligned.words
          .map((w, i) =>
            Math.max(
              Math.abs(w.start_seconds - preSettle.words[i].start_seconds),
              Math.abs(w.end_seconds - preSettle.words[i].end_seconds),
            ),
          )
          .filter((d) => d > 1e-9);

        say(
          `${name}: ${stored.words.length} words, ${tokens} tokens, ${withTime} with an engine time`,
        );
        say(
          `  tokens refused as not the file's clock (more than ${WINDOW_MS / 1000} s from where they were stored): ${refused}`,
        );
        say(
          `  words moved by the alignment: median ${f(median(shifts))} s, largest forward ${f(Math.max(...shifts))} s, largest back ${f(Math.min(...shifts))} s; ${shifts.filter((s) => Math.abs(s) >= 0.5).length} of ${shifts.length} moved 0.5 s or more`,
        );
        say(
          `  after 60 s: ${after60.length} words; median ${f(median(after60))} s, 10th / 90th percentile ${f(quantile(after60, 0.1))} / ${f(quantile(after60, 0.9))} s, largest forward ${f(after60.length ? Math.max(...after60) : null)} s, largest back ${f(after60.length ? Math.min(...after60) : null)} s`,
        );
        say(
          `  words changed by settleWords after the tokens moved: ${changes.length} of ${aligned.words.length}; largest change ${f(changes.length ? Math.max(...changes) : null, 3)} s`,
        );
        say("  by 30 s window of the file (words, median move, smallest, largest):");
        for (const [k, xs] of [...byWindow.entries()].sort((a, b) => a[0] - b[0]))
          say(
            `    window ${String(k).padStart(2)} (${String(k * 30).padStart(3)} s): ${String(xs.length).padStart(4)} words, median ${f(median(xs)).padStart(6)}, min ${f(Math.min(...xs)).padStart(6)}, max ${f(Math.max(...xs)).padStart(6)}`,
          );
        say();
      });
    }

    it("writes the report", () => {
      fs.writeFileSync(OUT, `${lines.join("\n")}\n`);
      expect(fs.existsSync(OUT)).toBe(true);
    });
  },
);
