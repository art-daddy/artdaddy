// The speech model the app downloads (src/tools/modelManifest.ts: its file, size, SHA-256 and pinned revision), put where
// the export suite's transcription cases look for it: `whisperModelPath` of a project in the system's temporary folder,
// which is <parent of the temporary folder>/models (%LOCALAPPDATA%\models on Windows). Fetched from the same public place
// the app fetches it, checked byte for byte, and marked verified the way the app marks it. CI runs it before the export
// suite so those cases run instead of skipping; a model that cannot be had fails here, never as a skip.
//
//   npx vite-node scripts/ci/speechModel.ts
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { DEFAULT_MODEL_KEY, MODEL_MANIFEST, primaryUrl } from "../../src/tools/modelManifest";

const entry = MODEL_MANIFEST[DEFAULT_MODEL_KEY];
const dir = path.join(path.dirname(os.tmpdir()), "models");
const dest = path.join(dir, entry.file);

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function whole(file: string): Promise<boolean> {
  return (
    existsSync(file) && statSync(file).size === entry.bytes && (await sha256(file)) === entry.sha256
  );
}

mkdirSync(dir, { recursive: true });
if (await whole(dest)) {
  console.log(`${dest}: already here, ${entry.bytes} bytes, SHA-256 ${entry.sha256}`);
} else {
  const url = primaryUrl(entry);
  console.log(`fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const partial = `${dest}.partial`;
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(partial));
  if (!(await whole(partial)))
    throw new Error(
      `${url} is not the pinned model (${entry.bytes} bytes, SHA-256 ${entry.sha256})`,
    );
  renameSync(partial, dest);
  console.log(`${dest}: fetched and checked, ${entry.bytes} bytes, SHA-256 ${entry.sha256}`);
}
writeFileSync(
  `${dest}.verified.json`,
  JSON.stringify({ bytes: entry.bytes, sha256: entry.sha256 }),
);
