// Where the e2e lanes find the binaries the app SHIPS: `artdaddy-<program>-<triple>` in
// src-tauri/binaries (tauri.conf.json externalBin). An unprefixed name left by an older build, or
// whatever is on PATH, is a different binary. Found 2026-10-04: 13 export and caption files looked
// only for the old unprefixed names, so they tested a July ffmpeg on one machine and skipped
// silently on every CI runner.
import { existsSync } from "node:fs";
import path from "node:path";

import { packagedSidecarName } from "../tools/sidecar";

export function hostTriple(): string {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "win32") return `${arch}-pc-windows-msvc`;
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  return `${arch}-unknown-linux-gnu`;
}

/** Where the shipped sidecar for `program` lives on this machine, staged or not. */
export function shippedSidecarPath(program: string): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.resolve(
    process.cwd(),
    "src-tauri/binaries",
    `${packagedSidecarName(program)}-${hostTriple()}${ext}`,
  );
}

/** Sidecars a CI lane deliberately does not stage, named in its workflow (comma-separated). */
function optedOut(program: string): boolean {
  return (process.env.ARTDADDY_E2E_SKIP_SIDECARS ?? "")
    .split(",")
    .map((s) => s.trim())
    .includes(program);
}

/** The shipped sidecar for `program`, or null when it is not staged. Under CI a missing sidecar
 *  THROWS unless the lane opted out of it by name: a lane that cannot find the binary must fail,
 *  never pass by skipping. */
export function shippedSidecar(program: string): string | null {
  const p = shippedSidecarPath(program);
  if (existsSync(p)) return p;
  if (process.env.CI && !optedOut(program))
    throw new Error(
      `the shipped ${program} sidecar is not staged at ${p} (run npm run fetch:sidecars), ` +
        `or list it in ARTDADDY_E2E_SKIP_SIDECARS if this lane deliberately goes without it`,
    );
  return null;
}
