// A stand-in for whisper-cli, used ONLY to prove the live-speech smoke harness (speechLive.smoke.e2e.ts) without the
// real engine: ARTDADDY_LIVE_FAKE_ENGINE=1. It prints what whisper-cli prints, on timers:
//   * stderr: the engine's log at once (with the PC's paths in it, which the capture must not keep), and its timing
//     lines at the end;
//   * stdout: nothing until the first window is "decoded", then one burst of segment lines per 30 s window of the
//     audio it was handed, each segment flushed as its own write (as whisper.cpp flushes each segment);
//   * the output file `<-of>.json` ONLY at the very end, so a run that is killed leaves none.
// It reads the length of the audio from the WAV it is given (16 kHz mono 16-bit: 32,000 bytes a second), as the app
// does. Killed (Cancel), it simply dies: nothing here catches a signal.
//   ARTDADDY_FAKE_STARTUP_MS   wait before the first window (default 2000)
//   ARTDADDY_FAKE_BURST_MS     wait per window (default 2000)
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
const noGpu = args.includes("-ng");
const startupMs = Number(process.env.ARTDADDY_FAKE_STARTUP_MS ?? 2000);
const burstMs = Number(process.env.ARTDADDY_FAKE_BURST_MS ?? 2000);
const WINDOW_S = 30;
const PER_WINDOW = 2;

if (!wav || !fs.existsSync(wav)) {
  process.stderr.write(`error: failed to open '${wav}'\n`);
  process.exit(2);
}
const samples = Math.floor((fs.statSync(wav).size - 44) / 2);
const audioS = samples / 16000;
const t0 = performance.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const stamp = (s) => {
  const total = Math.round(s * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const whole = Math.floor(total / 1000);
  return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor((whole % 3600) / 60))}:${pad(whole % 60)}.${pad(total % 1000, 3)}`;
};

process.stderr.write(
  [
    "ggml_vulkan: Found 1 Vulkan devices:",
    `load_backend: loaded Vulkan backend from ${process.cwd()}\\ggml-vulkan.dll`,
    `load_backend: loaded CPU backend from ${process.cwd()}\\ggml-cpu-haswell.dll`,
    `whisper_init_from_file_with_params_no_state: loading model from '${model}'`,
    `whisper_init_with_params_no_state: use gpu    = ${noGpu ? 0 : 1}`,
    "whisper_model_load: type          = 3 (small)",
    noGpu
      ? "whisper_backend_init_gpu: no GPU found"
      : "whisper_backend_init_gpu: using Vulkan0 backend",
    `read_audio_data: reading audio data from '${wav}' ...`,
    `system_info: n_threads = ${threads} / 16 | WHISPER : COREML = 0 |`,
    `main: processing '${wav}' (${samples} samples, ${audioS.toFixed(1)} sec), ${threads} threads, 1 processors, 5 beams + best of 5, lang = auto, task = transcribe, timestamps = 1 ...`,
    "",
  ].join("\n"),
);

await sleep(startupMs);
const segments = [];
const windows = Math.ceil(audioS / WINDOW_S);
for (let w = 0; w < windows; w++) {
  await sleep(burstMs);
  const from = w * WINDOW_S;
  const to = Math.min(audioS, from + WINDOW_S);
  if (w === 0) process.stdout.write("\n");
  for (let i = 0; i < PER_WINDOW; i++) {
    const a = from + ((to - from) * i) / PER_WINDOW;
    const b = from + ((to - from) * (i + 1)) / PER_WINDOW;
    segments.push({
      from: Math.round(a * 1000),
      to: Math.round(b * 1000),
      text: ` PRIVATE-WORDS-${w}-${i}`,
    });
    process.stdout.write(`[${stamp(a)} --> ${stamp(b)}]   PRIVATE-WORDS-${w}-${i}\n`);
  }
}

await sleep(150);
if (outBase) {
  const json = {
    result: { language: "en" },
    transcription: segments.map((s) => ({
      offsets: { from: s.from, to: s.to },
      text: s.text,
      tokens: [],
    })),
  };
  fs.writeFileSync(`${outBase}.json`, JSON.stringify(json));
  process.stderr.write(`output_json: saving output to '${outBase}.json'\n`);
}
const totalMs = performance.now() - t0;
process.stderr.write(
  [
    "",
    "whisper_print_timings:     load time =    480.00 ms",
    "whisper_print_timings:     fallbacks =   0 p /   0 h",
    `whisper_print_timings:    total time = ${totalMs.toFixed(2)} ms`,
    "",
  ].join("\n"),
);
process.exitCode = 0;
