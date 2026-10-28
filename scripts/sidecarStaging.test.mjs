import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  describeDownloadFailure,
  describeGhFailure,
  downloadVerified,
  ffmpegPin,
  FFMPEG_PINS,
  httpFailure,
  isPinnedBuild,
  isTransientDownloadFailure,
  matchesSha256,
  parseSha256Sums,
  rewriteYtDlpPin,
  stalePaths,
  verifySha256,
  withDownloadRetries,
  YT_DLP_PIN,
  ytDlpPin,
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

describe("the yt-dlp each platform ships is pinned", () => {
  const platforms = { win: "yt-dlp.exe", mac: "yt-dlp_macos", linux: "yt-dlp_linux" };

  it("names the asset each platform downloads, at a tag that cannot move, with the digest it must have", () => {
    for (const [os, asset] of Object.entries(platforms)) {
      const pin = ytDlpPin(os);
      expect(pin.name, os).toBe(asset);
      expect(pin.version, os).toMatch(/^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/);
      expect(pin.url, os).toBe(`https://github.com/yt-dlp/yt-dlp/releases/download/${pin.version}/${asset}`);
      expect(pin.url, os).not.toMatch(/latest/i);
      expect(pin.sha256, os).toMatch(/^[0-9a-f]{64}$/);
    }
    // A digest copied to the wrong platform would download fine and fail every build, or worse pass.
    const digests = Object.keys(platforms).map((os) => ytDlpPin(os).sha256);
    expect(new Set(digests).size).toBe(digests.length);
  });

  it("refuses a platform it has no pin for, rather than guessing one", () => {
    expect(() => ytDlpPin("freebsd")).toThrow(/no pinned yt-dlp/i);
  });

  // The behaviour this replaces was a fetch of releases/latest, which is invisible in every test
  // that stages a binary. Pin the SOURCE of the fetcher, so the next download added there cannot
  // quietly go back to whatever the day serves.
  it("leaves the fetcher no way to ask upstream for 'latest'", () => {
    const fetcher = readFileSync(join(here, "fetch-sidecars.mjs"), "utf8");
    expect(fetcher).not.toMatch(/releases\/latest/);
    expect(fetcher).not.toMatch(/async function download\(/);
  });

  it("matchesSha256 accepts only the exact bytes", () => {
    const bytes = Buffer.from("a yt-dlp build");
    const digest = createHash("sha256").update(bytes).digest("hex");
    expect(matchesSha256(bytes, digest)).toBe(true);
    const changed = Buffer.from(bytes);
    changed[3] ^= 1;
    expect(matchesSha256(changed, digest)).toBe(false);
    expect(matchesSha256(Buffer.alloc(0), digest)).toBe(false);
  });
});

describe("moving the yt-dlp pin", () => {
  const source = readFileSync(join(here, "sidecarStaging.mjs"), "utf8");
  const current = Object.fromEntries(Object.values(YT_DLP_PIN.assets).map((a) => [a.name, a.sha256]));
  const sums = (over = {}) => ({
    "yt-dlp.exe": "a".repeat(64),
    "yt-dlp_macos": "b".repeat(64),
    "yt-dlp_linux": "c".repeat(64),
    ...over,
  });
  /** The pin a rewritten source declares, read by running its block, not by pattern-matching it. */
  const pinOf = (text) => {
    const block = /\/\/ <yt-dlp-pin>([\s\S]*?)\/\/ <\/yt-dlp-pin>/.exec(text)[1].replace("export const", "const");
    return new Function(`${block}; return YT_DLP_PIN;`)();
  };

  it("reads the upstream checksum file, whatever its line endings or binary-mode marker", () => {
    const text = `${"a".repeat(64)}  yt-dlp.exe\r\n${"B".repeat(64)} *yt-dlp_macos\n\nnot a checksum line\n${"c".repeat(63)}  short\n`;
    expect(parseSha256Sums(text)).toEqual({ "yt-dlp.exe": "a".repeat(64), "yt-dlp_macos": "b".repeat(64) });
  });

  it("rewrites to the current pin without changing a byte", () => {
    expect(rewriteYtDlpPin(source, YT_DLP_PIN.version, current)).toBe(source);
  });

  it("changes the pin and nothing else, and the result is a module that says what was asked", () => {
    const moved = rewriteYtDlpPin(source, "2026.11.02", sums());
    expect(pinOf(moved)).toEqual({
      version: "2026.11.02",
      assets: {
        win: { name: "yt-dlp.exe", sha256: "a".repeat(64) },
        mac: { name: "yt-dlp_macos", sha256: "b".repeat(64) },
        linux: { name: "yt-dlp_linux", sha256: "c".repeat(64) },
      },
    });
    const outside = (text) => text.replace(/\/\/ <yt-dlp-pin>[\s\S]*?\/\/ <\/yt-dlp-pin>/, "");
    expect(outside(moved)).toBe(outside(source));
  });

  it("keeps the file's line endings, so a Windows checkout is not left with mixed ones", () => {
    const crlf = source.replace(/\r?\n/g, "\r\n");
    const moved = rewriteYtDlpPin(crlf, "2026.11.02", sums());
    expect(moved.match(/(?<!\r)\n/g)).toBeNull();
    expect(pinOf(moved).version).toBe("2026.11.02");
  });

  it("accepts a dated re-release tag", () => {
    expect(pinOf(rewriteYtDlpPin(source, "2026.11.02.1", sums())).version).toBe("2026.11.02.1");
  });

  it("refuses a release that does not list every asset, or lists a digest that is not one", () => {
    for (const missing of ["yt-dlp.exe", "yt-dlp_macos", "yt-dlp_linux"]) {
      const partial = sums();
      delete partial[missing];
      expect(() => rewriteYtDlpPin(source, "2026.11.02", partial), missing).toThrow(new RegExp(missing.replace(".", "\\.")));
    }
    for (const bad of ["", "g".repeat(64), "a".repeat(63), "a".repeat(65), undefined])
      expect(() => rewriteYtDlpPin(source, "2026.11.02", sums({ "yt-dlp_linux": bad })), String(bad)).toThrow();
  });

  it("refuses anything that is not a release tag, rather than writing it into source", () => {
    for (const tag of ["latest", "v2026.11.02", "2026.11", "2026.11.02 ", '2026.11.02"; process.exit(1); "', "", "../2026.11.02"])
      expect(() => rewriteYtDlpPin(source, tag, sums()), JSON.stringify(tag)).toThrow(/not a yt-dlp release tag/);
  });

  it("refuses a file that has lost its markers instead of appending a second pin", () => {
    expect(() => rewriteYtDlpPin("export const nothing = 1;\n", "2026.11.02", sums())).toThrow(/markers/);
  });

  it("round-trips any tag and digests it is given", () => {
    const hex = fc.stringMatching(/^[0-9a-f]{64}$/);
    const tag = fc
      .tuple(fc.integer({ min: 2024, max: 2040 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 28 }))
      .map(([y, m, d]) => `${y}.${String(m).padStart(2, "0")}.${String(d).padStart(2, "0")}`);
    fc.assert(
      fc.property(tag, hex, hex, hex, (version, win, mac, linux) => {
        const moved = rewriteYtDlpPin(source, version, { "yt-dlp.exe": win, "yt-dlp_macos": mac, "yt-dlp_linux": linux });
        expect(pinOf(moved)).toEqual({
          version,
          assets: {
            win: { name: "yt-dlp.exe", sha256: win },
            mac: { name: "yt-dlp_macos", sha256: mac },
            linux: { name: "yt-dlp_linux", sha256: linux },
          },
        });
      }),
      { numRuns: 50 },
    );
  });
});

// A macOS runner lost its ffmpeg download twice in a month with a bare "fetch failed" and the whole
// lane went red for a connection that a second try would have kept. These tests hold the OUTCOME of
// a download, in both directions: a hiccup is absorbed, a wrong file never is.
describe("a download that hiccups is tried again; one that is wrong never is", () => {
  const bytes = Buffer.from("the pinned ffmpeg build");
  const pin = { url: "https://example.test/ffmpeg.zip", sha256: createHash("sha256").update(bytes).digest("hex") };
  const dropped = (code) =>
    new TypeError("fetch failed", code ? { cause: Object.assign(new Error(`read ${code}`), { code }) } : undefined);
  const transientFailures = [
    () => dropped("ECONNRESET"),
    () => dropped("ETIMEDOUT"),
    () => dropped("UND_ERR_CONNECT_TIMEOUT"),
    () => dropped("EAI_AGAIN"),
    () => dropped(),
    () => new TypeError("terminated", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) }),
    () => httpFailure(503, pin.url),
    () => httpFailure(429, pin.url),
  ];
  const permanentFailures = [
    () => httpFailure(404, pin.url),
    () => httpFailure(403, pin.url),
    () => httpFailure(401, pin.url),
    () => dropped("CERT_HAS_EXPIRED"),
    () => dropped("UNABLE_TO_VERIFY_LEAF_SIGNATURE"),
    () => dropped("DEPTH_ZERO_SELF_SIGNED_CERT"),
    () => dropped("ERR_TLS_CERT_ALTNAME_INVALID"),
    () => dropped("ERR_INVALID_URL"),
    () => new Error("not even a network error"),
  ];

  /** Fails with each of `failures` in turn, then serves `served`; remembers how often it was asked. */
  function fetcher(failures, served = bytes) {
    const asked = [];
    return {
      asked,
      fetchBytes: async (url) => {
        asked.push(url);
        if (asked.length <= failures.length) throw failures[asked.length - 1]();
        return served;
      },
    };
  }
  const clock = () => {
    const waited = [];
    return { waited, sleep: async (ms) => void waited.push(ms) };
  };

  it("serves the pinned bytes after a dropped connection and a 503, and logs what it retried", async () => {
    const f = fetcher([() => dropped("ECONNRESET"), () => httpFailure(503, pin.url)]);
    const { waited, sleep } = clock();
    const retried = [];
    const got = await downloadVerified(pin, f.fetchBytes, { sleep, onRetry: (r) => retried.push(r) });
    expect(got.equals(bytes)).toBe(true);
    expect(f.asked).toEqual([pin.url, pin.url, pin.url]);
    expect(waited).toEqual([2_000, 6_000]);
    expect(retried.map((r) => describeDownloadFailure(r.error))).toEqual([
      "fetch failed (ECONNRESET)",
      `HTTP 503 for ${pin.url}`,
    ]);
    expect(retried.map((r) => `${r.failed}/${r.of}`)).toEqual(["1/3", "2/3"]);
  });

  it("never fetches a build that fails its checksum a second time", async () => {
    const f = fetcher([], Buffer.from("some other file"));
    const { waited, sleep } = clock();
    await expect(downloadVerified(pin, f.fetchBytes, { sleep })).rejects.toThrow(/not the pinned build/);
    expect(f.asked).toHaveLength(1);
    expect(waited).toEqual([]);
  });

  it("retries a hiccup but not the wrong file that follows it", async () => {
    const f = fetcher([() => dropped("ECONNRESET")], Buffer.from("some other file"));
    const { sleep } = clock();
    await expect(downloadVerified(pin, f.fetchBytes, { sleep })).rejects.toThrow(/not the pinned build/);
    expect(f.asked).toHaveLength(2);
  });

  it("asks exactly once when the answer cannot change, and throws the fetcher's own error untouched", async () => {
    for (const make of permanentFailures) {
      const thrown = make();
      const asked = [];
      const { waited, sleep } = clock();
      const rejected = await downloadVerified(
        pin,
        async (url) => {
          asked.push(url);
          throw thrown;
        },
        { sleep },
      ).catch((e) => e);
      expect(rejected, thrown.message).toBe(thrown);
      expect(asked, thrown.message).toHaveLength(1);
      expect(waited, thrown.message).toEqual([]);
    }
    expect(httpFailure(404, pin.url).message).toBe(`HTTP 404 for ${pin.url}`);
  });

  it("gives up after three attempts, saying how many and why the last one failed", async () => {
    const f = fetcher([() => dropped("ETIMEDOUT"), () => dropped("ETIMEDOUT"), () => dropped("ETIMEDOUT"), () => dropped("ETIMEDOUT")]);
    const { waited, sleep } = clock();
    const failure = await downloadVerified(pin, f.fetchBytes, { sleep }).catch((e) => e);
    expect(failure.message).toBe("fetch failed (ETIMEDOUT); gave up after 3 attempts");
    expect(failure.cause.cause.code).toBe("ETIMEDOUT");
    expect(f.asked).toHaveLength(3);
    expect(waited).toEqual([2_000, 6_000]);
  });

  it("holds for every kind of failure: a hiccup is absorbed within the budget, a wrong answer is final at once", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 2 }),
        fc.constantFrom(...transientFailures),
        async (hiccups, make) => {
          const f = fetcher(Array.from({ length: hiccups }, () => make));
          const { waited, sleep } = clock();
          const got = await downloadVerified(pin, f.fetchBytes, { sleep });
          expect(got.equals(bytes)).toBe(true);
          expect(f.asked).toHaveLength(hiccups + 1);
          expect(waited).toEqual([2_000, 6_000].slice(0, hiccups));
        },
      ),
      { numRuns: 60 },
    );
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...permanentFailures), async (make) => {
        const f = fetcher([make, make, make]);
        const { waited, sleep } = clock();
        await expect(downloadVerified(pin, f.fetchBytes, { sleep })).rejects.toBeDefined();
        expect(f.asked).toHaveLength(1);
        expect(waited).toEqual([]);
      }),
      { numRuns: 60 },
    );
  });

  it("retries every status that means the server stumbled, and none that means the request is wrong", () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504])
      expect(isTransientDownloadFailure(httpFailure(status, pin.url)), String(status)).toBe(true);
    for (const status of [400, 401, 403, 404, 410, 416, 451])
      expect(isTransientDownloadFailure(httpFailure(status, pin.url)), String(status)).toBe(false);
  });

  it("is not fooled by something that is not an error at all", () => {
    for (const odd of [undefined, null, "fetch failed", 503, {}, { status: "503" }])
      expect(isTransientDownloadFailure(odd), String(odd)).toBe(false);
  });

  it("uses the delays it is given and stops at the last one", async () => {
    const { waited, sleep } = clock();
    let asked = 0;
    const failure = await withDownloadRetries(
      async () => {
        asked++;
        throw dropped("ECONNRESET");
      },
      { delaysMs: [5, 7, 11, 13], sleep },
    ).catch((e) => e);
    expect(asked).toBe(5);
    expect(waited).toEqual([5, 7, 11, 13]);
    expect(failure.message).toMatch(/gave up after 5 attempts/);
  });

  it("names the reason Node hides behind 'fetch failed'", () => {
    expect(describeDownloadFailure(dropped("ECONNRESET"))).toBe("fetch failed (ECONNRESET)");
    expect(describeDownloadFailure(dropped())).toBe("fetch failed");
    expect(describeDownloadFailure(httpFailure(502, pin.url))).toBe(`HTTP 502 for ${pin.url}`);
    expect(describeDownloadFailure("a string")).toBe("a string");
  });

  // fetch-sidecars.mjs cannot be imported (it downloads at import), so hold its SOURCE: every
  // pinned download goes through the retried-then-verified path, and nothing in it can fetch bytes
  // or check them any other way.
  it("leaves the fetcher no download that skips the retried-then-verified path", () => {
    const fetcher = readFileSync(join(here, "fetch-sidecars.mjs"), "utf8");
    expect(fetcher.match(/\bfetch\(/g)).toHaveLength(1);
    expect(fetcher).toMatch(/async function fetchBytes\(url\) \{\s*const res = await fetch\(url/);
    expect(fetcher).toMatch(/await downloadVerified\(\{ url, sha256 \}, fetchBytes/);
    expect(fetcher).not.toMatch(/\bverifySha256\b/);
  });
});
