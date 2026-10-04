import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { shippedSidecar, shippedSidecarPath } from "./sidecars";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("shippedSidecar: the e2e lanes use the binaries the app ships", () => {
  it("names the packaged file, never the old unprefixed one", () => {
    expect(shippedSidecarPath("ffmpeg").replace(/\\/g, "/")).toMatch(
      /src-tauri\/binaries\/artdaddy-ffmpeg-[a-z0-9_]+-[a-z0-9_-]+(\.exe)?$/,
    );
    expect(shippedSidecarPath("artdaddy-browser")).toMatch(/artdaddy-browser-/);
    expect(shippedSidecarPath("artdaddy-browser")).not.toMatch(/artdaddy-artdaddy/);
  });

  it("FAILS under CI when a sidecar is missing, instead of letting the lane skip", () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("ARTDADDY_E2E_SKIP_SIDECARS", "");
    expect(() => shippedSidecar("no-such-tool")).toThrow(/not staged/);
  });

  it("lets a CI lane go without a sidecar only when it names it", () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("ARTDADDY_E2E_SKIP_SIDECARS", "whisper-cli, no-such-tool");
    expect(shippedSidecar("no-such-tool")).toBeNull();
    expect(() => shippedSidecar("another-missing-tool")).toThrow(/not staged/);
  });

  it("returns null outside CI, so a fresh clone can still run the unit-free lanes", () => {
    vi.stubEnv("CI", "");
    expect(shippedSidecar("no-such-tool")).toBeNull();
  });
});

describe("no e2e file finds a sidecar on its own", () => {
  // The 13 stale-name files each carried a private copy of "where is ffmpeg". One rule, here.
  it("only src/test/sidecars.ts builds a path into src-tauri/binaries", () => {
    const root = path.resolve(process.cwd(), "src");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/(\.e2e\.ts|__e2e\.ts)$/.test(e.name)) {
          const src = readFileSync(p, "utf8");
          if (/["'`]src-tauri\/binaries|["'`]binaries["'`]|-(x86_64|aarch64)-(pc-windows|apple|unknown-linux)/.test(src))
            offenders.push(path.relative(root, p));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
