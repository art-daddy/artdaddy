// Makes the fixtures of the captions lane from things already in the repository, with no paid
// service:
//
//   media/spoken_scenes.mp4   12 s, 320x180 at 30 fps: a red scene (0-4 s), a green one (4-8 s)
//                             and a blue one (8-12 s), with the speech lane's recording as its sound
//                             (src/tools/__fixtures__/speech/spoken.ogg, Windows' own voice reading
//                             a known script). Made with the shipped ffmpeg.
//   media/subtitles.srt       three cues at authored times, for the subtitle-file scenario.
//   speech/spoken.whisper.json
//                             what the real speech engine wrote for that sound: the shipped
//                             whisper-cli, the speech model already on this PC, the arguments the
//                             app passes for English on a graphics chip (greedy, no carried text).
//                             The browser lane's speech stand-in (lib/speech.ts) answers with it,
//                             so every caption test reads words a real engine produced.
//
//   node e2e/ui/captions-and-transcription/fixtures/make-fixtures.mjs [path to ggml-small.bin]
//
// The model defaults to %LOCALAPPDATA%\models\ggml-small.bin (the speech lane's copy). Run it
// again only when the recording or the engine changes; the tests never run it.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const root = path.resolve(here, "../../../..");
const ext = process.platform === "win32" ? ".exe" : "";
const triple =
  process.platform === "win32"
    ? "x86_64-pc-windows-msvc"
    : process.platform === "darwin"
      ? `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`
      : "x86_64-unknown-linux-gnu";
const bin = (name) => path.join(root, "src-tauri", "binaries", `${name}-${triple}${ext}`);
const ffmpeg = bin("ffmpeg");
const whisper = bin("whisper-cli");
const speech = path.join(root, "src/tools/__fixtures__/speech/spoken.ogg");

mkdirSync(path.join(here, "media"), { recursive: true });
mkdirSync(path.join(here, "speech"), { recursive: true });

// ── the clip ─────────────────────────────────────────────────────────────────
const clip = path.join(here, "media", "spoken_scenes.mp4");
execFileSync(
  ffmpeg,
  [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0xC83232:s=320x180:r=30:d=4",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x32B446:s=320x180:r=30:d=4",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x3246C8:s=320x180:r=30:d=4",
    "-i",
    speech,
    "-filter_complex",
    "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v];[3:a]aresample=48000,apad=whole_dur=12[a]",
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-preset",
    "veryslow",
    "-crf",
    "30",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "30",
    "-c:a",
    "aac",
    "-b:a",
    "48k",
    "-ac",
    "1",
    "-t",
    "12",
    "-movflags",
    "+faststart",
    clip,
  ],
  { stdio: "inherit" },
);

// ── a subtitle file ──────────────────────────────────────────────────────────
writeFileSync(
  path.join(here, "media", "subtitles.srt"),
  [
    "1",
    "00:00:01,000 --> 00:00:03,000",
    "First authored line",
    "",
    "2",
    "00:00:05,000 --> 00:00:07,500",
    "Second authored line",
    "",
    "3",
    "00:00:09,000 --> 00:00:11,000",
    "Third authored line",
    "",
  ].join("\r\n"),
);

// ── what the real engine hears in it ─────────────────────────────────────────
const model =
  process.argv[2] ?? path.join(process.env.LOCALAPPDATA ?? "", "models", "ggml-small.bin");
if (!existsSync(model)) {
  console.log(`no speech model at ${model}: the clip is made, the engine output is not`);
  process.exit(0);
}
const tmp = path.join(os.tmpdir(), `qa-captions-${process.pid}`);
mkdirSync(tmp, { recursive: true });
try {
  const wav = path.join(tmp, "spoken.wav");
  // As the app extracts it (transcribe.ts extractWav): 16 kHz mono PCM.
  execFileSync(ffmpeg, [
    "-y",
    "-v",
    "error",
    "-i",
    clip,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    wav,
  ]);
  const out = path.join(tmp, "spoken");
  execFileSync(
    whisper,
    [
      "-m",
      model,
      "-f",
      wav,
      "-ojf",
      "-of",
      out,
      "-t",
      "4",
      "-l",
      "en",
      "-mc",
      "0",
      "-bs",
      "1",
      "-bo",
      "1",
    ],
    {
      cwd: path.join(root, "src-tauri", "resources", "whisper"),
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  const json = JSON.parse(readFileSync(`${out}.json`, "utf8"));
  // Only what the app reads (transcribe.ts parseWhisperCppJson) and where it came from: the host's
  // file paths in `params` are dropped.
  const kept = {
    made_by:
      "e2e/ui/captions-and-transcription/fixtures/make-fixtures.mjs (shipped whisper-cli, ggml-small.bin, -l en -bs 1 -bo 1 -mc 0)",
    systeminfo: json.systeminfo,
    model: json.model,
    result: json.result,
    transcription: json.transcription,
  };
  writeFileSync(
    path.join(here, "speech", "spoken.whisper.json"),
    `${JSON.stringify(kept, null, 1)}\n`,
  );
  console.log(`engine heard: ${json.transcription.map((s) => s.text.trim()).join(" | ")}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
