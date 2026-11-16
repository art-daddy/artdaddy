// A stand-in for whisper-cli for the first-word harness (speechFirstWord.smoke.e2e.ts with L13_ENGINE=fake): it proves
// the harness, the scorer and every code path of the app's launch (the gate, the retry without the alignment, the
// reader of the words) with NO engine on the machine. It says nothing about what the real engine does.
//
// What it models, from the speech study's own findings and nothing else:
//   * whisper stores the FIRST word of a recording at the start of the audio, early by the quiet in front of the
//     voice, and the words after it a little less early each, so the fourth word is on its sound;
//   * with `-dtw` every token also carries `t_dtw` (units of 10 ms) = where its sound is; without it `-1`;
//   * the sound of the first word is the voice's start in THE FILE IT IS HANDED plus a short lag (the study's median
//     first word came 0.1 s after the sound began). The voice's start is read from the file's samples (the study's
//     onset proxy, ported here on its own, not imported from the app), so a window cut out of a longer file is
//     right too; the clip's own text and language come from the clip file named by L13_FAKE_CLIP_FILE.
//   * stderr says what the real engine says about the backend, the flash attention and the alignment.
// Faults (L13_FAKE_FAULT, only for a launch that carries `-dtw`, except always-exit): dtw-exit (exit 3, no output),
// dtw-garbage (exit 0, an output that is not JSON), dtw-missing (exit 0, no output), always-exit (every launch).
//   L13_FAKE_LAG_S             the first word's sound after the voice's start (default 0.1)
//   L13_FAKE_MS_PER_AUDIO_S    how long a second of audio takes (default 8 ms; a launch with -dtw takes 10% more)
import fs from "node:fs";

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const model = flag("-m");
const wav = flag("-f");
const outBase = flag("-of");
const threads = flag("-t") ?? "4";
const asked = flag("-l") ?? "auto";
const noGpu = args.includes("-ng");
const dtwPreset = flag("-dtw");
const flashOff = args.includes("-nfa");
const fault = process.env.L13_FAKE_FAULT ?? "";
const lagS = Number(process.env.L13_FAKE_LAG_S ?? 0.1);
const msPerAudioS = Number(process.env.L13_FAKE_MS_PER_AUDIO_S ?? 8);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const t0 = performance.now();

if (!wav || !fs.existsSync(wav)) {
  process.stderr.write(`error: failed to open '${wav}'\n`);
  process.exit(2);
}
const clip = JSON.parse(fs.readFileSync(process.env.L13_FAKE_CLIP_FILE, "utf8"));

/** The samples of a 16 kHz mono 16-bit WAV, walking its chunks (ffmpeg writes a LIST chunk before `data`). */
function readSamples(file) {
  const raw = fs.readFileSync(file);
  let at = 12;
  while (at + 8 <= raw.length) {
    const id = raw.toString("latin1", at, at + 4);
    const size = raw.readUInt32LE(at + 4);
    if (id === "data") {
      const end = Math.min(raw.length, at + 8 + size);
      const count = Math.floor((end - at - 8) / 2);
      const out = new Int16Array(count);
      for (let i = 0; i < count; i++) out[i] = raw.readInt16LE(at + 8 + 2 * i);
      return out;
    }
    at += 8 + size + (size & 1);
  }
  return new Int16Array(0);
}

/** The study's onset proxy: 20 ms frames, the first of three in a row more than 15 dB above the quietest tenth of the
 *  frames (numpy's linear percentile) and above -50 dBFS; null when none stands out. In ms. */
function onsetMs(samples) {
  const hop = 320;
  const frames = Math.floor(samples.length / hop);
  if (frames < 3) return null;
  const level = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) sum += (samples[i] / 32768) ** 2;
    level[f] = 20 * Math.log10(Math.sqrt(sum / hop + 1e-12));
  }
  const sorted = Float64Array.from(level).sort();
  const pos = (frames - 1) * 0.1;
  const lo = Math.floor(pos);
  const floor = sorted[lo] + (sorted[Math.min(lo + 1, frames - 1)] - sorted[lo]) * (pos - lo);
  const threshold = Math.max(floor + 15, -50);
  let run = 0;
  for (let f = 0; f < frames; f++) {
    run = level[f] > threshold ? run + 1 : 0;
    if (run === 3) return (f - 2) * 20;
  }
  return null;
}

/** The text as tokens: a spaced language gives one token per word, each with its leading space; text without spaces
 *  (Japanese, Chinese) is cut by the runtime's word-breaker into tokens with none, the first with a space, as whisper
 *  writes them. */
function tokensOf(text) {
  const spaced = text.trim().split(/\s+/).filter(Boolean);
  if (spaced.length > 1) return spaced.map((w) => ` ${w}`);
  const seg = new Intl.Segmenter(undefined, { granularity: "word" });
  const parts = [...seg.segment(text.trim())].map((s) => s.segment).filter((s) => s.trim());
  return parts.map((p, i) => (i === 0 ? ` ${p}` : p));
}

const samples = readSamples(wav);
const audioS = samples.length / 16000;
const voiceMs = onsetMs(samples);
const lang = asked !== "auto" ? asked : (clip.language ?? "en");
const dtw = dtwPreset !== undefined;
const word = tokensOf(clip.text ?? "word");
const n = word.length;
const firstSound = Math.min((voiceMs ?? 0) / 1000 + lagS, Math.max(0, audioS - 0.3));
const step = n > 1 ? Math.max(0.05, (audioS - 0.1 - firstSound) / n) : 0.3;
const sound = word.map((_, i) => firstSound + i * step);
// Where whisper stores each word: the first at 0, the next ones less early each, the fourth on its sound.
const stored = sound.map((s, i) => Math.max(0, s - firstSound * Math.max(0, 1 - i / 4)));
const length = word.map((_, i) =>
  Math.min(0.6, step * 0.9, i + 1 < n ? stored[i + 1] - stored[i] : 9),
);

process.stderr.write(
  [
    noGpu
      ? "load_backend: loaded CPU backend (fake)"
      : "ggml_vulkan: Found 1 Vulkan devices: (fake)",
    `whisper_init_from_file_with_params_no_state: loading model from '${model}'`,
    `whisper_init_with_params_no_state: use gpu    = ${noGpu ? 0 : 1}`,
    `whisper_init_with_params_no_state: flash attn = ${flashOff ? 0 : 1}`,
    `whisper_init_with_params_no_state: dtw        = ${dtw ? 1 : 0}`,
    noGpu
      ? "whisper_backend_init_gpu: no GPU found"
      : "whisper_backend_init_gpu: using Vulkan0 backend",
    `main: processing '${wav}' (${samples.length} samples, ${audioS.toFixed(1)} sec), ${threads} threads, 1 processors, lang = ${lang}, task = transcribe, timestamps = 1 ...`,
    "",
  ].join("\n"),
);

if (fault === "always-exit" || (dtw && fault === "dtw-exit")) {
  process.stderr.write(
    "whisper_init_from_file_with_params_no_state: failed (the fake engine's fault)\n",
  );
  process.exit(3);
}

await sleep(30 + msPerAudioS * audioS * (dtw ? 1.1 : 1));

const stamp = (s) => {
  const total = Math.round(s * 1000);
  const p = (v, w = 2) => String(v).padStart(w, "0");
  const whole = Math.floor(total / 1000);
  return `${p(Math.floor(whole / 3600))}:${p(Math.floor((whole % 3600) / 60))}:${p(whole % 60)}.${p(total % 1000, 3)}`;
};

const segments = [];
for (let first = 0; first < n; first += 8) {
  const last = Math.min(n, first + 8) - 1;
  const from = first === 0 ? 0 : Math.round(stored[first] * 1000);
  const to = Math.round((stored[last] + length[last]) * 1000);
  const tokens = [
    { text: "[_BEG_]", offsets: { from, to: from }, id: 50364, p: 0.9, t_dtw: dtw ? 0 : -1 },
  ];
  for (let i = first; i <= last; i++) {
    const f = Math.round(stored[i] * 1000);
    tokens.push({
      text: word[i],
      timestamps: {
        from: stamp(stored[i]).replace(".", ","),
        to: stamp(stored[i] + length[i]).replace(".", ","),
      },
      offsets: { from: f, to: Math.round((stored[i] + length[i]) * 1000) },
      id: 1000 + i,
      p: 0.9,
      t_dtw: dtw ? Math.round(sound[i] * 100) : -1,
    });
  }
  tokens.push({
    text: "[_TT_150]",
    offsets: { from: to, to },
    id: 50514,
    p: 0.5,
    t_dtw: dtw ? 0 : -1,
  });
  segments.push({
    timestamps: {
      from: stamp(from / 1000).replace(".", ","),
      to: stamp(to / 1000).replace(".", ","),
    },
    offsets: { from, to },
    text: word.slice(first, last + 1).join(""),
    tokens,
  });
}
for (const s of segments)
  process.stdout.write(
    `[${stamp(s.offsets.from / 1000)} --> ${stamp(s.offsets.to / 1000)}]  ${s.text}\n`,
  );

if (outBase && !(dtw && fault === "dtw-missing")) {
  const json =
    dtw && fault === "dtw-garbage"
      ? '{"result": {"language": "en"}, "transcription": [{"offsets": '
      : JSON.stringify({
          params: { model },
          model: { ftype: /q8_0/.test(model ?? "") ? 7 : 1 },
          result: { language: lang },
          transcription: segments,
        });
  fs.writeFileSync(`${outBase}.json`, json);
  process.stderr.write(`output_json: saving output to '${outBase}.json'\n`);
}
process.stderr.write(
  [
    "",
    "whisper_print_timings:     load time =    30.00 ms",
    `whisper_print_timings:    total time = ${(performance.now() - t0).toFixed(2)} ms`,
    "",
  ].join("\n"),
);
process.exitCode = 0;
