import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { browserRunPolicy, MACOS_CI_MAX_FAILURES, MACOS_CI_RETRIES } from "./browserRunPolicy";

const root = process.cwd();
const read = (file: string): string => readFileSync(resolve(root, file), "utf8");

describe("what the real-browser lane does about a failed test", () => {
  it("retries on a macOS CI runner and nowhere else", () => {
    const macCi = browserRunPolicy({ CI: "true" }, "darwin");
    expect(macCi.retries).toBeGreaterThanOrEqual(1);
    for (const platform of ["win32", "linux", "freebsd", "aix", "sunos", ""]) {
      expect(browserRunPolicy({ CI: "true" }, platform), platform).toEqual({
        retries: 0,
        maxFailures: 0,
      });
    }
  });

  it("shows every failure on a developer's own Mac, where there is no CI", () => {
    for (const env of [{}, { CI: "" }, { CI: undefined }, { HOME: "/Users/dev" }]) {
      expect(browserRunPolicy(env, "darwin"), JSON.stringify(env)).toEqual({
        retries: 0,
        maxFailures: 0,
      });
    }
  });

  it("holds for any platform and any CI value: retries exist exactly on macOS CI, and never without an early stop", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constantFrom("darwin", "win32", "linux"), fc.string()),
        fc.option(fc.oneof(fc.constantFrom("true", "1", "false", "0", ""), fc.string()), {
          nil: undefined,
        }),
        (platform, ci) => {
          const policy = browserRunPolicy({ CI: ci }, platform);
          const macCi = platform === "darwin" && !!ci;
          expect(policy.retries > 0).toBe(macCi);
          // Retries multiply the cost of a broken runner; they come with a bound or not at all.
          expect(policy.retries > 0).toBe(policy.maxFailures > 0);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("costs a bounded number of failed attempts when the whole runner is broken", () => {
    // Every test failing for good, each attempt up to its 60 s timeout: this is what a broken macOS VM
    // can burn before the run stops. Raising either number is allowed, but it has to be a decision.
    const attempts = (MACOS_CI_RETRIES + 1) * MACOS_CI_MAX_FAILURES;
    expect(attempts).toBeLessThanOrEqual(30);
    // One flaky test must never be able to stop the run on its own.
    expect(MACOS_CI_MAX_FAILURES).toBeGreaterThanOrEqual(2);
  });

  // playwright.config.ts needs @playwright/test, which only this lane installs, so the unit suite
  // cannot import it. Hold its SOURCE; browserFailureArtifacts.mjs then holds what Playwright APPLIED.
  it("is what playwright.config.ts really applies, with no per-project override", () => {
    const config = read("playwright.config.ts");
    expect(config).toMatch(/browserRunPolicy\(process\.env,\s*process\.platform\)/);
    expect(config).toMatch(/^\s*retries:\s*policy\.retries,/m);
    expect(config).toMatch(/^\s*maxFailures:\s*policy\.maxFailures,/m);
    expect(config).toMatch(/metadata:\s*\{\s*browserRunPolicy:\s*policy\s*\}/);
    // Any other `retries:` is a project or fixture setting that would beat the policy for that project.
    expect(config.match(/\bretries\s*:/g)).toHaveLength(1);
  });

  it("is checked against what Playwright applied by the failing-browser evidence run", () => {
    const evidence = read("scripts/qa/browserFailureArtifacts.mjs");
    expect(evidence).toMatch(/result\.config\.metadata\.browserRunPolicy/);
    expect(evidence).toMatch(/project\.retries,\s*policy\.retries/);
    expect(evidence).toMatch(/result\.config\.maxFailures,\s*policy\.maxFailures/);
    // ...and macOS CI may never be left without a retry, whatever the config says
    expect(evidence).toMatch(
      /process\.platform === "darwin" && process\.env\.CI\)\s*assert\.ok\(policy\.retries >= 1,/,
    );
  });

  it("is reported by the CI step that runs after the browser tests, even when they fail", () => {
    const ci = read(".github/workflows/ci.yml");
    const step =
      /- name: Report browser tests that passed only on a retry\n([\s\S]*?)(?=\n {6}- )/.exec(
        ci.replace(/\r\n/g, "\n"),
      );
    expect(step, "the flaky-test report step is missing from the browser job").not.toBeNull();
    expect(step![1]).toMatch(/if:\s*always\(\)/);
    expect(step![1]).toMatch(
      /node scripts\/ci\/browserFlakeReport\.mjs reports\/qa\/browser\/results\.json/,
    );
  });
});
