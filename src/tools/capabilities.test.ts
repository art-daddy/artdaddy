// The Tauri capability file is compiled into the binary, so a wrong grant fails at RUNTIME, in
// the shipped app, with no build error and no test failure.
//
// Three real bugs shipped through it. `shell:allow-spawn` was missing, so every CANCELLABLE
// sidecar call (every agent tool call) died with "not allowed". Then `shell:allow-kill` was
// missing, so Stop could not kill anything. Then the spawn grant itself was the bug: the page
// received every chunk a process wrote as its own message, and a few chatty runs at once
// overflowed the page thread's queue and froze the app's IPC (2026-10-07). Processes now start
// through the app's own `sidecar_run`, which keeps output out of the page until the run ends;
// the page holds no shell grant, so nothing can quietly go back to the old path.
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { packagedSidecarName, SIDECAR_BINS } from "./sidecar";

type Permission = string | { identifier: string };

const capability = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../src-tauri/capabilities/default.json"), "utf8"),
) as { permissions: Permission[] };
const config = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../src-tauri/tauri.conf.json"), "utf8"),
) as { bundle: { externalBin: string[] } };

const identifiers = capability.permissions.map((p) => (typeof p === "string" ? p : p.identifier));

describe("sidecar capabilities", () => {
  it("grants the page no shell permission: processes start only through the app's runner", () => {
    expect(identifiers.filter((id) => id.startsWith("shell:"))).toEqual([]);
  });

  // sidecar_run accepts exactly the bundle's externalBin entries, so a program the runner may
  // ask for that the bundle does not ship fails here instead of in a user's tool call.
  it("bundles every program the runner may ask for, under its packaged name", () => {
    for (const bin of SIDECAR_BINS) {
      expect(config.bundle.externalBin).toContain(`binaries/${packagedSidecarName(bin)}`);
    }
  });
});
