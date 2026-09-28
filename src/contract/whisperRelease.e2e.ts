import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// The release fetch-sidecars.mjs pins must EXIST and carry the asset it downloads.
//
// src/contract/whisperVulkan.test.ts proves the pin matches the tag the workflow WOULD publish:
// two strings in this repo. Neither is reality. On 2026-09-27 the pinned tag
// whisper-vulkan-v1.9.2-sdk1.4.357.0 turned out never to have existed as a release — the drift
// guard was green throughout — so every clean fetch silently fell back to upstream's CPU-only
// zip, which transcribes correctly and many times slower, with nothing to notice. Only asking
// GitHub catches that. Network-gated with the rest of the smoke lane's network checks.

const NET = process.env.ARTDADDY_SMOKE_NET === "1";
const fetcher = readFileSync(join(process.cwd(), "scripts/fetch-sidecars.mjs"), "utf8");

function constant(name: string): string {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]+)"`).exec(fetcher);
  expect(m, `${name} not found in scripts/fetch-sidecars.mjs`).not.toBeNull();
  return m![1];
}

describe.skipIf(!NET)("pinned whisper release exists upstream", () => {
  it("the pinned Vulkan tag is a real release carrying the asset fetch-sidecars downloads", async () => {
    const tag = constant("WHISPER_VULKAN_TAG");
    const asset = constant("WHISPER_VULKAN_ASSET");
    const res = await fetch(
      `https://api.github.com/repos/art-daddy/artdaddy/releases/tags/${encodeURIComponent(tag)}`,
      { headers: { accept: "application/vnd.github+json" } },
    );
    expect(res.status, `release '${tag}' does not exist — the fetch would fall back to CPU-only`).toBe(
      200,
    );
    const names = ((await res.json()).assets ?? []).map((a: { name: string }) => a.name);
    expect(names, `release '${tag}' has no '${asset}'`).toContain(asset);
  });

  it("the CPU fallback's upstream release exists too", async () => {
    const tag = constant("WHISPER_UPSTREAM_TAG");
    const res = await fetch(
      `https://api.github.com/repos/ggml-org/whisper.cpp/releases/tags/${encodeURIComponent(tag)}`,
      { headers: { accept: "application/vnd.github+json" } },
    );
    expect(res.status, `upstream whisper.cpp release '${tag}' not found`).toBe(200);
  });
});
