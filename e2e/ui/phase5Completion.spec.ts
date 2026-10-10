import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";

import type { UsageState } from "../../src/api/usage";

declare global {
  interface Window {
    __phase5Credits: {
      show(view: string): void;
      refresh(): Promise<void>;
      balance(): UsageState;
      startGeneration(tool: string): Promise<{ job_id: string; media_refs: string[] }>;
      completeGeneration(outcome: string): Promise<{
        status: string;
        catalogStatus: string;
        providerRuns: number;
        unrelatedChatNotes: number;
        sha256?: string;
        dimensions?: number[];
        frameHashes?: string[];
        sampleRate?: number;
        duration?: number;
        peak?: number;
        bytesWritten?: number;
      }>;
    };
  }
}

test("backend credit status survives shared pause, outage and recovery in the real UI", async ({
  page,
}, info) => {
  test.skip(
    !process.env.ARTDADDY_PHASE5_CREDIT_FIXTURE,
    "Opt-in backend-generated balance fixture required",
  );
  test.setTimeout(180_000);
  const snapshots = JSON.parse(
    readFileSync(process.env.ARTDADDY_PHASE5_CREDIT_FIXTURE!, "utf8"),
  ) as Record<string, { status: number; body: Record<string, unknown> }>;
  const media = (snapshots as unknown as { media: Record<string, { sha256: string }> }).media;
  const output = path.resolve("reports/qa/phase5/completion-live");
  await mkdir(output, { recursive: true });
  let active = "global";
  const blocked: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "phase5.invalid") {
      const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      if (url.pathname === "/usage") {
        expect(route.request().headers().authorization).toBe("Bearer isolated-qa");
        return route.fulfill({
          status: snapshots[active].status,
          json: snapshots[active].body,
          headers,
        });
      }
      return route.fulfill({
        status: 404,
        json: { error: "unexpected isolated API route" },
        headers,
      });
    }
    if (
      !["127.0.0.1", "localhost"].includes(url.hostname) &&
      !["data:", "blob:"].includes(url.protocol)
    ) {
      blocked.push(url.origin);
      return route.abort();
    }
    return route.continue();
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/scripts/qa/phase5Completion.html", {
    waitUntil: "domcontentloaded",
    timeout: 120_000,
  });
  await expect
    .poll(() => page.evaluate(() => window.__phase5Credits?.balance().globalPaused), {
      timeout: 120_000,
    })
    .toBe(true);
  await expect(page.getByText("97 cr left", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: /join our discord/i })).toHaveCount(0);
  await page.screenshot({ path: path.join(output, "chat-global-pause.png") });
  await page.evaluate(() => window.__phase5Credits.show("profile"));
  await expect(page.getByText("AI generation is paused for everyone right now.")).toBeVisible();
  await expect(page.getByText("97", { exact: true })).toBeVisible();
  await expect(page.getByText("Out of credits.", { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 900, height: 820 });
  await page.screenshot({ path: path.join(output, "profile-global-pause.png") });
  active = "unavailable";
  const before = await page.evaluate(() => window.__phase5Credits.balance());
  await page.evaluate(() => window.__phase5Credits.refresh());
  expect(await page.evaluate(() => window.__phase5Credits.balance())).toEqual(before);
  active = "available";
  await page.evaluate(() => window.__phase5Credits.refresh());
  await expect.poll(() => page.evaluate(() => window.__phase5Credits.balance().over)).toBe(false);
  const available = await page.evaluate(() => window.__phase5Credits.balance());
  expect(available.remaining).toBe(97);
  expect(available.globalPaused).toBeUndefined();
  await page.evaluate(() => window.__phase5Credits.show("chat"));
  const completions = [];
  for (const [tool, kind] of [
    ["generate_image", "image"],
    ["generate_video", "video"],
    ["generate_music", "audio"],
    ["generate_voiceover", "audio"],
  ]) {
    for (const outcome of ["done", "failed"]) {
      active = "available";
      await page.evaluate(() => window.__phase5Credits.refresh());
      await page.evaluate((name) => window.__phase5Credits.startGeneration(name), tool);
      expect((await page.evaluate(() => window.__phase5Credits.balance())).used).toBe(3);
      await expect(page.getByText("97 cr left", { exact: false })).toBeVisible();
      active = `completion_${outcome}`;
      const completion = await page.evaluate(
        (status) => window.__phase5Credits.completeGeneration(status),
        outcome,
      );
      expect(completion.status).toBe(outcome);
      expect(completion.providerRuns).toBe(1);
      expect(completion.unrelatedChatNotes).toBe(0);
      if (outcome === "done") {
        expect(completion.sha256).toBe(media[kind].sha256);
        if (kind === "image") expect(completion.dimensions).toEqual([160, 120]);
        if (kind === "video")
          expect(completion.frameHashes![0]).not.toBe(completion.frameHashes![1]);
        if (kind === "audio") {
          expect(completion.sampleRate).toBe(48000);
          expect(completion.duration).toBeGreaterThan(0.9);
          expect(completion.peak).toBeGreaterThan(0.05);
        }
      } else {
        expect(completion.catalogStatus).toBe("failed");
        expect(completion.bytesWritten).toBe(0);
      }
      await expect(
        page.getByText(`${outcome === "done" ? 96 : 98} cr left`, { exact: false }),
      ).toBeVisible();
      completions.push({ tool, outcome, ...completion });
    }
  }
  expect(blocked).toEqual([]);
  expect(errors).toEqual([]);
  const report = {
    ok: true,
    paid_calls: 0,
    backend_snapshots: snapshots,
    available_balance: available,
    completions,
  };
  await writeFile(path.join(output, "proof.json"), JSON.stringify(report, null, 2));
  await info.attach("credit-contract-proof", {
    body: JSON.stringify(report),
    contentType: "application/json",
  });
});
