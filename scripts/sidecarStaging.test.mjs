import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  describeGhFailure,
  ffmpegPin,
  FFMPEG_PINS,
  isPinnedBuild,
  stalePaths,
  verifySha256,
} from "./sidecarStaging.mjs";

const here = dirname(fileURLToPath(import.meta.url));

describe("the ffmpeg each platform ships is pinned", () => {
  // Every triple a release workflow builds, read from the workflows themselves (Windows builds on
  // the runner's own triple, which the workflow does not spell out).
  const releaseTriples = [
    "x86_64-pc-windows-msvc",
    ...["macos-release.yml", "linux-release.yml"].map((f) => {
      const yml = readFileSync(join(here, "..", ".github", "workflows", f), "utf8");
      return yml.match(/^\s*TRIPLE:\s*(\S+)/m)[1];
    }),
  ];

  it("has a pin for every triple a release builds", () => {
    for (const t of releaseTriples) expect(ffmpegPin(t), t).toBeTruthy();
  });

  it("pins only URLs that cannot move, each with the SHA-256 of what it serves", () => {
    const all = Object.values(FFMPEG_PINS).flatMap((p) => p.archives);
    expect(all.length).toBeGreaterThan(0);
    for (const a of all) {
      expect(a.url, a.url).not.toMatch(/latest|\/redirect\//i);
      expect(a.url, a.url).toMatch(/^https:\/\//);
      expect(a.sha256, a.url).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("gives each mac binary its own archive and every other platform one archive", () => {
    for (const t of releaseTriples) {
      const p = ffmpegPin(t);
      if (t.includes("darwin")) expect(p.archives.map((a) => a.name).sort()).toEqual(["ffmpeg", "ffprobe"]);
      else expect(p.archives).toHaveLength(1);
    }
  });

  it("refuses a platform it has no pin for, rather than guessing one", () => {
    expect(() => ffmpegPin("riscv64gc-unknown-linux-gnu")).toThrow(/no pinned ffmpeg/i);
  });
});

describe("isPinnedBuild", () => {
  const btbn = { version: "N-127021-ge0c94b2d1c" };
  const riedl = { version: "9.0.2" };

  it("accepts the version lines the pinned builds actually print", () => {
    expect(isPinnedBuild("ffmpeg version N-127021-ge0c94b2d1c-20260930 Copyright (c) 2000-2026", btbn)).toBe(true);
    expect(isPinnedBuild("ffprobe version N-127021-ge0c94b2d1c-20260930 Copyright", btbn)).toBe(true);
    expect(isPinnedBuild("ffmpeg version 9.0.2-https://www.martin-riedl.de Copyright (c) 2000-2026", riedl)).toBe(true);
  });

  // The binary this PC had staged before the pin: it must be refetched, not kept.
  it("rejects the build that was staged before the pin", () => {
    expect(isPinnedBuild("ffmpeg version N-126655-gbfac54a03b-20260919 Copyright", btbn)).toBe(false);
  });

  it("does not take a longer version for its prefix", () => {
    expect(isPinnedBuild("ffmpeg version 9.0.20-https://x Copyright", riedl)).toBe(false);
    expect(isPinnedBuild("ffmpeg version N-1270210-gabc Copyright", { version: "N-127021" })).toBe(false);
  });

  it("rejects output that is not a version line at all", () => {
    for (const out of ["", "is deprecated", "version N-127021-ge0c94b2d1c", "ffmpeg: not found"])
      expect(isPinnedBuild(out, btbn), JSON.stringify(out)).toBe(false);
  });

  it("accepts nothing but the pinned build, whatever the version string", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9.+~-]{1,30}$/), (v) => {
        const ok = isPinnedBuild(`ffmpeg version ${v} Copyright`, btbn);
        expect(ok).toBe(v === btbn.version || v.startsWith(`${btbn.version}-`));
      }),
    );
  });
});

describe("verifySha256", () => {
  const bytes = Buffer.from("the archive the pin names");
  const digest = createHash("sha256").update(bytes).digest("hex");

  it("passes the bytes the pin names", () => {
    expect(() => verifySha256(bytes, digest, "https://example/a.zip")).not.toThrow();
  });

  it("refuses one changed byte, naming the URL and both digests", () => {
    const changed = Buffer.from(bytes);
    changed[0] ^= 1;
    expect(() => verifySha256(changed, digest, "https://example/a.zip")).toThrow(
      new RegExp(`https://example/a\\.zip.*${digest}`, "s"),
    );
  });
});

describe("stalePaths", () => {
  it("prunes the file that actually survived: SDL2.dll from the pre-Vulkan zip", () => {
    const onDisk = ["ggml.dll", "ggml-vulkan.dll", "whisper.dll", "SDL2.dll"];
    const fromThisBuild = ["ggml.dll", "ggml-vulkan.dll", "whisper.dll"];
    expect(stalePaths(onDisk, fromThisBuild)).toEqual(["SDL2.dll"]);
  });

  // The failure direction, and the one that would do damage: over-pruning deletes a backend
  // this build needs. Windows filenames are case-insensitive, so a case-sensitive comparison
  // would call a live file stale and remove it — leaving whisper unable to start.
  it("does not prune a live file whose case differs", () => {
    expect(stalePaths(["GGML-Vulkan.DLL"], ["ggml-vulkan.dll"])).toEqual([]);
  });

  it("prunes nothing when the sets agree", () => {
    const set = ["a.dll", "b.dll"];
    expect(stalePaths(set, set)).toEqual([]);
  });

  it("prunes everything when the build produced a disjoint set", () => {
    expect(stalePaths(["old.dll"], ["new.dll"])).toEqual(["old.dll"]);
  });

  it("never proposes deleting something the build produced, whatever the inputs", () => {
    const name = fc.stringMatching(/^[A-Za-z0-9._-]{1,12}$/);
    fc.assert(
      fc.property(fc.array(name), fc.array(name), (existing, incoming) => {
        const stale = stalePaths(existing, incoming);
        const keep = new Set(incoming.map((n) => n.toLowerCase()));
        // The invariant that survives a rewrite: only leftovers, and never a live file.
        expect(stale.every((n) => existing.includes(n))).toBe(true);
        expect(stale.some((n) => keep.has(n.toLowerCase()))).toBe(false);
      }),
    );
  });

  it("has nothing left to prune once the prune has happened", () => {
    const name = fc.stringMatching(/^[A-Za-z0-9._-]{1,12}$/);
    fc.assert(
      fc.property(fc.array(name), fc.array(name), (existing, incoming) => {
        const stale = new Set(stalePaths(existing, incoming));
        const after = existing.filter((n) => !stale.has(n));
        expect(stalePaths(after, incoming)).toEqual([]);
      }),
    );
  });
});

describe("describeGhFailure", () => {
  // The defect being fixed: one message named all three possible causes, so the reader
  // checked three things when exactly one was true. Each cause must exclude the others'
  // advice — asserting only that the right words appear would still pass the old message.
  it("says gh is missing, and does not blame the release", () => {
    const m = describeGhFailure({ ghInstalled: false });
    expect(m).toMatch(/not installed/i);
    expect(m).not.toMatch(/re-run/i);
  });

  it("says to log in, and does not claim gh is missing or the release absent", () => {
    const m = describeGhFailure({ ghInstalled: true, stderr: "error: not logged in to github.com" });
    expect(m).toMatch(/auth login/i);
    expect(m).not.toMatch(/not installed/i);
    expect(m).not.toMatch(/re-run/i);
  });

  it("says to publish the release, and does not send you to gh auth login", () => {
    const m = describeGhFailure({ ghInstalled: true, stderr: "release not found" });
    expect(m).toMatch(/re-run/i);
    expect(m).not.toMatch(/auth login/i);
    expect(m).not.toMatch(/not installed/i);
  });

  // A private repo answers 404 to an unauthorised caller, so both signals arrive together.
  // Authentication is the fixable one; sending someone to re-publish a release that already
  // exists is the wrong instruction.
  it("prefers the auth cause when gh reports 404 AND an auth hint", () => {
    const m = describeGhFailure({
      ghInstalled: true,
      stderr: "HTTP 404: Not Found\nTry authenticating with: gh auth login",
    });
    expect(m).toMatch(/auth login/i);
  });

  // Asserted on the ADVICE, not the words "rate limit": those are in the stderr too, so
  // matching them passes even with this branch deleted and the raw gh line echoed back.
  it("names the rate limit rather than guessing at the release", () => {
    const m = describeGhFailure({ ghInstalled: true, stderr: "API rate limit exceeded for user" });
    expect(m).toMatch(/retry later/i);
    expect(m).not.toMatch(/re-run/i);
  });

  it("surfaces an unrecognised failure instead of swallowing it", () => {
    const m = describeGhFailure({ ghInstalled: true, stderr: "\n\ntls handshake timeout\nmore" });
    expect(m).toBe("tls handshake timeout");
  });

  // gh indents its output, so the first non-empty line usually arrives padded. The blank-ish
  // line before it is what makes this bite: a whitespace-only string is truthy, so picking
  // the first TRUTHY line rather than the first non-BLANK one selects "   " and reports an
  // empty reason.
  it("skips a whitespace-only line and strips the padding gh puts on the real one", () => {
    const m = describeGhFailure({ ghInstalled: true, stderr: "\n   \n   tls handshake timeout   \n" });
    expect(m).toBe("tls handshake timeout");
  });

  it("still explains itself when gh produced no output at all", () => {
    expect(describeGhFailure({ ghInstalled: true })).toBe("gh failed without saying why");
  });

  it("always returns something to print", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.string(), (ghInstalled, stderr) => {
        // The caller interpolates this into a warning; an empty reason renders as a blank
        // line, which reads as "no reason given" rather than "we could not tell".
        expect(describeGhFailure({ ghInstalled, stderr }).trim().length).toBeGreaterThan(0);
      }),
    );
  });
});
