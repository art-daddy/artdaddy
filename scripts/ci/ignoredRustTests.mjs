// The #[ignore]d Rust tests CI runs on purpose: a plain `cargo test` leaves them out because each needs something a
// developer's PC may not have, and until 28 Nov no lane named them (the coverage measurement of 26 Nov). CI's cargo test
// jobs have it: the real pinned ffmpeg and ffprobe (fetched before this runs), and on Linux the unified cgroup v2
// hierarchy. Run from the repository root:
//
//   node scripts/ci/ignoredRustTests.mjs
//
// It runs every test listed for this system in one `cargo test --ignored --exact`, with ARTDADDY_QA_FFMPEG naming the
// staged ffmpeg, and fails unless cargo reported each one by name as passed: a test renamed or moved would otherwise
// make this a green run of nothing. scripts/ci/ignoredRustTests.test.mjs holds every #[ignore]d test of the shell to a
// lane that runs it, this list among them.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Each test by its full path in the shell's library, and the systems it runs on. */
export const IGNORED_IN_CI = [
  {
    test: "jobs::export_delivery_tests::scratch_capture_preserves_real_nut_frames_and_audio",
    systems: ["linux", "darwin", "win32"],
  },
  {
    test: "jobs::export_delivery_tests::crash_recovery_renders_and_publishes_a_real_video",
    systems: ["linux", "darwin", "win32"],
  },
  {
    test: "jobs::resources::tests::actual_kernel_snapshot_retains_its_process_and_directory_identity",
    systems: ["linux"],
  },
];

/** The tests cargo's output reports as passed (`test <name> ... ok`). */
export function passedTests(output) {
  return new Set([...output.matchAll(/^test (\S+) \.\.\. ok\s*$/gm)].map((m) => m[1]));
}

/** What went wrong, if anything, for a run of `wanted` that printed `output` and exited `code`. */
export function verdict(wanted, output, code) {
  const passed = passedTests(output);
  const missing = wanted.filter((test) => !passed.has(test));
  const problems = [];
  if (code !== 0) problems.push(`cargo test exited ${code}`);
  for (const test of missing) problems.push(`${test} was not reported as passed`);
  return problems;
}

function hostTriple() {
  const out = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  const triple = /^host: (\S+)$/m.exec(out.stdout ?? "")?.[1];
  if (!triple) throw new Error(`rustc -vV gave no host triple: ${out.stderr}`);
  return triple;
}

async function main() {
  const wanted = IGNORED_IN_CI.filter((t) => t.systems.includes(process.platform)).map(
    (t) => t.test,
  );
  const exe = process.platform === "win32" ? ".exe" : "";
  const ffmpeg = path.join(ROOT, "src-tauri", "binaries", `artdaddy-ffmpeg-${hostTriple()}${exe}`);
  if (!existsSync(ffmpeg))
    throw new Error(`no staged ffmpeg at ${ffmpeg}: fetch the sidecars first`);
  const args = [
    "test",
    "--locked",
    "--manifest-path",
    path.join(ROOT, "src-tauri", "Cargo.toml"),
    "--lib",
    "--",
  ];
  args.push("--ignored", "--exact", "--show-output", ...wanted);
  console.log(`cargo ${args.join(" ")}\nARTDADDY_QA_FFMPEG=${ffmpeg}`);
  const child = spawn("cargo", args, {
    cwd: ROOT,
    env: { ...process.env, ARTDADDY_QA_FFMPEG: ffmpeg },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
  const code = await new Promise((resolve) => child.on("close", (c) => resolve(c ?? 1)));
  const problems = verdict(wanted, output, code);
  if (problems.length) {
    for (const problem of problems) console.error(`::error title=Ignored Rust tests::${problem}`);
    process.exit(1);
  }
  console.log(`all ${wanted.length} ran and passed: ${wanted.join(", ")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
