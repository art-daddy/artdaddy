import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, linkSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const [binary, modelFile, audioFile, directory, expected = "ask not what your country", mode = "cpu"] = process.argv.slice(2);
if (!binary || !modelFile || !audioFile || !directory) throw new Error("usage: whisperUnicode.mjs <exe> <model> <audio> <owned-output-dir> [expected text] [cpu|gpu]");
const exe = resolve(binary);
const model = resolve(modelFile);
const audio = resolve(audioFile);
const root = resolve(directory);
if (!existsSync(exe) || !existsSync(model) || !existsSync(audio)) throw new Error("Unicode probe inputs must exist");
mkdirSync(root, { recursive: true });
const hash = async (path) => {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
};
const before = await Promise.all([hash(model), hash(audio)]);
const unicode = join(root, "a\u00f1o_\u4e2d\u6587_\ud83d\ude80");
mkdirSync(unicode, { recursive: true });
const linkedModel = join(unicode, "model.bin");
const linkedAudio = join(unicode, "audio.wav");
if (!existsSync(linkedModel)) linkSync(model, linkedModel);
if (!existsSync(linkedAudio)) linkSync(audio, linkedAudio);
const cases = [
  { name: "ascii", model, audio, out: join(root, "ascii") },
  { name: "model", model: linkedModel, audio, out: join(root, "model") },
  { name: "audio", model, audio: linkedAudio, out: join(root, "audio") },
  { name: "output", model, audio, out: join(unicode, "output") },
  { name: "all", model: linkedModel, audio: linkedAudio, out: join(unicode, "all") },
];
const results = [];
for (const test of cases) {
  const result = spawnSync(exe, ["-m", test.model, "-f", test.audio, "-l", "en", "-t", "4", ...(mode === "cpu" ? ["-ng"] : []), "-otxt", "-ojf", "-of", test.out],
    { cwd: process.env.WHISPER_UNICODE_CWD || undefined, encoding: "utf8", timeout: 120000 });
  const output = `${test.out}.txt`;
  const text = existsSync(output) ? readFileSync(output, "utf8").trim() : "";
  const words = text.toLowerCase().replace(/[^a-z]/g, "");
  const wanted = expected.toLowerCase().replace(/[^a-z]/g, "");
  let jsonVerified = false;
  try {
    const saved = JSON.parse(readFileSync(`${test.out}.json`, "utf8"));
    const spoken = (saved.transcription ?? []).map((segment) => segment.text ?? "").join(" ");
    jsonVerified = spoken.toLowerCase().replace(/[^a-z]/g, "").includes(wanted);
  } catch { }
  const ok = !result.error && result.status === 0 && words.includes(wanted) && jsonVerified;
  results.push({ name: test.name, mode, ok, jsonVerified, code: result.status, transcript: text, backend: (result.stderr ?? "").split(/\r?\n/).filter((line) => /ggml_vulkan:|using.*GPU|using.*Vulkan/i.test(line)) });
}
const after = await Promise.all([hash(model), hash(audio)]);
const proof = {
  version: 1,
  results,
  inputHashes: before,
  inputsUnchanged: before.every((value, index) => value === after[index]),
  executableSha256: await hash(exe),
  librarySha256: await hash(join(process.env.WHISPER_UNICODE_CWD || dirname(exe), "whisper.dll")),
};
writeFileSync(join(root, "proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
console.log(JSON.stringify(proof, null, 2));
if (!proof.inputsUnchanged || results.some((result) => !result.ok)) process.exitCode = 1;