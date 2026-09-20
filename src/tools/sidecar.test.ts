import { describe, expect, it } from "vitest";

import { BROWSER_BIN, packagedSidecarName, resolveSidecar, SIDECAR_BINS } from "./sidecar";

describe("resolveSidecar", () => {
  it("routes bundled tools to their sidecar id", () => {
    for (const name of ["ffmpeg", "ffprobe", "yt-dlp", "whisper-cli", BROWSER_BIN]) {
      expect(resolveSidecar(name)).toEqual({
        sidecar: true,
        path: `binaries/${packagedSidecarName(name)}`,
      });
    }
  });

  it("gives every packaged executable an application-owned name", () => {
    for (const name of SIDECAR_BINS) {
      expect(packagedSidecarName(name)).toMatch(/^artdaddy-/);
    }
  });

  it("leaves unknown programs as PATH commands", () => {
    expect(resolveSidecar("node")).toEqual({ sidecar: false, path: "node" });
    expect(resolveSidecar("bash")).toEqual({ sidecar: false, path: "bash" });
  });

  it("exposes the bundled set", () => {
    expect(SIDECAR_BINS.has("ffmpeg")).toBe(true);
    expect(SIDECAR_BINS.has(BROWSER_BIN)).toBe(true);
    expect(SIDECAR_BINS.has("node")).toBe(false);
  });
});
