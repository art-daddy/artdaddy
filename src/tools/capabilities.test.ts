// The Tauri capability file is the ONLY thing standing between the runner and a
// silent no-op: it is compiled into the binary, so a missing grant fails at
// RUNTIME, in the shipped app, with no build error and no test failure.
//
// Two real bugs shipped through this gap. `shell:allow-spawn` was missing, so
// every CANCELLABLE sidecar call (i.e. every agent tool call) died with
// "not allowed" while the non-cancellable paths a human clicks kept working.
// Then `shell:allow-kill` was missing, so Stop could not kill anything — the
// rejected kill was swallowed and ffmpeg/yt-dlp ran to completion after cancel.
//
// This test pins the grants to what the runner actually calls, so removing one
// (or adding a sidecar without granting it) fails here instead of in the wild.
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SIDECAR_BINS } from "./sidecar";

interface ScopedPermission {
  identifier: string;
  allow?: { name?: string; sidecar?: boolean; args?: boolean }[];
}
type Permission = string | ScopedPermission;

const capability = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../src-tauri/capabilities/default.json"), "utf8"),
) as { permissions: Permission[] };

const identifiers = capability.permissions.map((p) => (typeof p === "string" ? p : p.identifier));
const scoped = (id: string): ScopedPermission | undefined =>
  capability.permissions.find(
    (p): p is ScopedPermission => typeof p !== "string" && p.identifier === id,
  );

describe("tauri shell capabilities", () => {
  // execute() runs a plain call; spawn() is used whenever a Stop signal is present.
  it.each(["shell:allow-execute", "shell:allow-spawn"])("grants %s to every sidecar", (id) => {
    const perm = scoped(id);
    expect(perm, `${id} missing from capabilities/default.json`).toBeDefined();
    const granted = new Set((perm!.allow ?? []).map((a) => a.name));
    for (const bin of SIDECAR_BINS) expect(granted).toContain(`binaries/${bin}`);
  });

  it("grants shell:allow-kill so Stop can actually kill a running sidecar", () => {
    // Without this the kill is REJECTED and the process runs to completion while
    // the UI claims the turn was cancelled.
    expect(identifiers).toContain("shell:allow-kill");
  });

  it("passes args to every sidecar (they are all argument-driven)", () => {
    for (const id of ["shell:allow-execute", "shell:allow-spawn"]) {
      for (const entry of scoped(id)!.allow ?? []) {
        expect(entry.args, `${id} ${entry.name} must allow args`).toBe(true);
        expect(entry.sidecar, `${id} ${entry.name} must be a sidecar`).toBe(true);
      }
    }
  });

  it("grants nothing beyond the sidecars we ship", () => {
    for (const id of ["shell:allow-execute", "shell:allow-spawn"]) {
      for (const entry of scoped(id)!.allow ?? []) {
        expect(SIDECAR_BINS).toContain(String(entry.name).replace("binaries/", ""));
      }
    }
  });
});
