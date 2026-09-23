import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// DRIFT GUARD between .github/workflows/whisper-windows.yml (which BUILDS and publishes the
// Vulkan whisper-cli) and scripts/fetch-sidecars.mjs (which DOWNLOADS it).
//
// The release tag is composed in the workflow from its two pinned inputs
// (`whisper-vulkan-<whisper_ref>-sdk<vulkan_sdk>`), and fetch-sidecars.mjs has to name that
// exact tag. Those twins drifted within an hour of being written: the first CI run failed on
// Vulkan SDK 1.3.296.0 (too old to ship the SPIRV-Headers CMake config ggml-vulkan requires),
// the pin moved to 1.4.357.0, and the tag moved with it while the constant did not.
//
// That drift is invisible at runtime. `gh release download` on a tag that does not exist just
// fails, and fetchWhisper() falls back to upstream's CPU-ONLY zip — which still transcribes
// correctly, only many times slower. There is no error, no wrong output, nothing to notice
// except a machine with a perfectly good GPU quietly not using it. So it gets a static check.
//
// Everything here is DERIVED from the workflow rather than restated, so it keeps holding if
// the tag template itself changes shape.
// vitest's cwd is the project root (its `root` option), and both files are read eagerly: a
// wrong path throws here rather than leaving the assertions below to pass against "".
const workflow = readFileSync(join(process.cwd(), ".github/workflows/whisper-windows.yml"), "utf8");
const fetcher = readFileSync(join(process.cwd(), "scripts/fetch-sidecars.mjs"), "utf8");

/** The `default:` of a workflow_dispatch input, read from the workflow itself. */
function inputDefault(name: string): string {
  const at = workflow.indexOf(`      ${name}:`);
  expect(at, `workflow_dispatch input '${name}' not found in the workflow`).toBeGreaterThan(-1);
  const m = /^\s+default:\s*"?([^"\n]+?)"?\s*$/m.exec(workflow.slice(at));
  expect(m, `input '${name}' has no default`).not.toBeNull();
  return m![1];
}

function constant(name: string): string {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]+)"`).exec(fetcher);
  expect(m, `${name} not found in scripts/fetch-sidecars.mjs`).not.toBeNull();
  return m![1];
}

describe("whisper Vulkan sidecar: workflow <-> fetch-sidecars", () => {
  it("names the tag the workflow will actually publish", () => {
    const template = /^\s*TAG:\s*(.+?)\s*$/m.exec(workflow);
    expect(template, "the publish step no longer defines TAG").not.toBeNull();

    const expected = template![1].replace(/\$\{\{\s*inputs\.(\w+)\s*\}\}/g, (_, input: string) =>
      inputDefault(input),
    );

    // Guard the guard: if a regex above silently missed, `expected` would still contain the
    // un-substituted expression and this file would otherwise compare two wrong strings and
    // pass. Assert the composed tag is fully resolved BEFORE comparing it to anything.
    expect(expected, "tag template was not fully substituted").not.toMatch(/\$\{\{/);
    expect(expected).toMatch(/^whisper-vulkan-v\d+\.\d+\.\d+-sdk\d+\.\d+\.\d+\.\d+$/);

    expect(
      constant("WHISPER_VULKAN_TAG"),
      "fetch-sidecars.mjs asks for a release tag the workflow does not publish — it will " +
        "silently fall back to the CPU-only build",
    ).toBe(expected);
    expect(
      constant("WHISPER_UPSTREAM_TAG"),
      "the CPU fallback must use the same pinned whisper.cpp release; `latest` may publish no binaries",
    ).toBe(inputDefault("whisper_ref"));
  });

  it("names the asset the workflow will actually attach", () => {
    const zip = /-DestinationPath\s+(\S+\.zip)/.exec(workflow);
    expect(zip, "the Package step no longer produces a .zip").not.toBeNull();
    expect(constant("WHISPER_VULKAN_ASSET")).toBe(zip![1]);
  });

  it("keeps a Vulkan SDK new enough to supply SPIRV-Headers", () => {
    // ggml-vulkan/CMakeLists.txt does `find_package(SPIRV-Headers CONFIG REQUIRED)`. The 1.3.x
    // SDKs ship no such config, so configure finds Vulkan, reports success, and THEN dies.
    // A 20-minute CI round trip to rediscover that is worth one assertion.
    const [major, minor] = inputDefault("vulkan_sdk").split(".").map(Number);
    expect(
      major * 1000 + minor,
      "Vulkan SDK 1.3.x cannot build ggml-vulkan",
    ).toBeGreaterThanOrEqual(1004);
  });
});
