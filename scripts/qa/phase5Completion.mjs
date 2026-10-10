import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const backend = path.resolve(root, "../Akaru");
const output = path.join(root, "reports/qa/phase5/completion-live");
await mkdir(output, { recursive: true });
const python = path.join(
  backend,
  ".venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
const snapshots = JSON.parse(
  execFileSync(
    python,
    [
      "-c",
      String.raw`
import os
os.environ['SENTRY_DSN'] = ''
os.environ['AZURE_COSMOS_ENDPOINT'] = ''
os.environ['AZURE_COSMOS_KEY'] = ''
import json
from fastapi.testclient import TestClient
from src.akaru.server import accounts, metering
from src.akaru.server import app as appmod
from src.akaru.server.accounts import Identity
from src.akaru.server.sessions import SessionManager
from tests.fakes import FakeFactory
from tests.unit.server.test_metering import FakeContainer

usage = FakeContainer()
metering.usage_container = lambda: usage
metering.users_container = lambda: None
metering.analytics_container = lambda: None
metering.metering_enabled = lambda: True
metering.email_for = lambda user_id: ''
metering.global_limit = lambda: 10.0
accounts.resolve_clerk_token = lambda token: Identity('u1', 100.0) if token == 'isolated-qa' else None
appmod._is_local_dev_bypass = lambda request: False
appmod.init_sentry = lambda: None
client = TestClient(appmod.create_app(SessionManager(factory=FakeFactory())))
headers = {'Authorization': 'Bearer isolated-qa'}
def snapshot():
    response = client.get('/usage', headers=headers)
    return {'status': response.status_code, 'body': response.json()}
metering.record_usage('u1', 3.0)
metering.record_usage('sibling', 7.0)
results = {'global': snapshot()}
usage = FakeContainer()
metering.record_usage('u1', 3.0)
results['available'] = snapshot()
metering.record_usage('u1', 1.0)
results['completion_done'] = snapshot()
metering.refund_usage('u1', 2.0)
results['completion_failed'] = snapshot()
def unavailable(item, partition_key):
    raise ConnectionError('isolated storage outage')
usage.read_item = unavailable
results['unavailable'] = snapshot()
client.close()
print(json.dumps(results))
`,
    ],
    { cwd: backend, encoding: "utf8", maxBuffer: 1024 * 1024 },
  ),
);
assert.equal(snapshots.global.body.pause_scope, "global");
assert.equal(snapshots.global.body.remaining, 97);
assert.equal(snapshots.unavailable.status, 503);

const media = path.join(output, "media");
await mkdir(media, { recursive: true });
const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
const triple =
  process.platform === "win32"
    ? `${arch}-pc-windows-msvc`
    : process.platform === "darwin"
      ? `${arch}-apple-darwin`
      : `${arch}-unknown-linux-gnu`;
const ffmpeg = path.join(
  root,
  "src-tauri/binaries",
  `artdaddy-ffmpeg-${triple}${process.platform === "win32" ? ".exe" : ""}`,
);
const video = path.join(media, "completion.mp4");
const image = path.join(media, "completion.png");
const audio = path.join(media, "completion.wav");
execFileSync(
  ffmpeg,
  [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x120:rate=15:duration=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=1",
    "-c:v",
    "libx264",
    "-profile:v",
    "baseline",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "15",
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-movflags",
    "+faststart",
    "-shortest",
    video,
  ],
  { timeout: 30_000 },
);
execFileSync(ffmpeg, ["-y", "-v", "error", "-i", video, "-frames:v", "1", image], {
  timeout: 30_000,
});
execFileSync(
  ffmpeg,
  ["-y", "-v", "error", "-i", video, "-vn", "-c:a", "pcm_s16le", "-ar", "48000", audio],
  { timeout: 30_000 },
);
snapshots.media = {};
for (const [kind, file] of Object.entries({ image, video, audio })) {
  const bytes = await readFile(file);
  snapshots.media[kind] = {
    file: path.basename(file),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
const fixture = path.join(output, "backend-responses.json");
await writeFile(fixture, JSON.stringify(snapshots, null, 2));
const run = spawnSync(
  process.execPath,
  [
    path.join(root, "node_modules/@playwright/test/cli.js"),
    "test",
    "e2e/ui/phase5Completion.spec.ts",
    "--project=chromium",
  ],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ARTDADDY_PHASE5_CREDIT_FIXTURE: fixture },
  },
);
if (run.error) throw run.error;
process.exitCode = run.status ?? 1;
