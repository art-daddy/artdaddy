// The speech model (465 MiB, once per PC) as a person meets it at first launch: the download shows
// how far it is and can be cancelled, a Cancel is remembered, a download that fails says so with a
// Retry, and captions asked for meanwhile say the model is missing rather than that nobody speaks.
// The model's two places (Hugging Face and ArtDaddy's own copy) are answered by the test: no byte
// leaves this machine. A finished download needs the real 465 MiB file and is the real app's (see
// e2e/byhand/captions-and-transcription/first-run.md).
import type { Route } from "@playwright/test";

import { expect, test, type AgentRig } from "../agent-and-models/lib/qa";
import { callTools, say, type Round } from "../agent-and-models/lib/reply";
import { startTimer } from "../../lib/timing";
import { attachSpoken, captionsOf, chromiumCovers, placeSpoken, resultOf } from "./lib/rig";
import { SpeechStandIn } from "./lib/speech";

const inBrowser = (what: string): string => `captions: ${what} [${test.info().project.name}]`;
const DECLINE_KEY = "artdaddy.speech_model_declined.v1";
const MODEL_HOSTS = ["https://huggingface.co/**", "https://models.artdaddy.app/**"];

/** A PC that never said no to the download: the QA shell marks it declined at every load (no agent
 *  test needs 465 MiB), so this takes that back on the first load of the test only. */
async function neverDeclined(qa: AgentRig): Promise<void> {
  await qa.page.addInitScript((key: string) => {
    if (sessionStorage.getItem("qa-model-first-load")) return;
    sessionStorage.setItem("qa-model-first-load", "1");
    localStorage.removeItem(key);
  }, DECLINE_KEY);
}

/** Answer the model's places with `fulfil`, counting what the app asked for. */
async function modelPlaces(
  qa: AgentRig,
  fulfil: (route: Route) => Promise<void>,
): Promise<{ asked: string[] }> {
  const asked: string[] = [];
  for (const host of MODEL_HOSTS)
    await qa.page.route(host, async (route) => {
      asked.push(route.request().url());
      await fulfil(route);
    });
  return { asked };
}

test.describe("the speech model download", () => {
  test.setTimeout(150_000);

  test("at first launch the download shows at once, even before a byte arrives; Cancel stops it and is remembered", async ({
    qa,
  }) => {
    await SpeechStandIn.install(qa, { model: false });
    await neverDeclined(qa);
    // The places take the request and say nothing back: the download is under way, at 0%.
    let letGo!: () => void;
    const silent = new Promise<void>((resolve) => (letGo = resolve));
    const places = await modelPlaces(qa, async (route) => {
      await silent;
      await route.abort().catch(() => undefined);
    });
    const appeared = startTimer(inBrowser("launch to the speech model download showing"));
    try {
      await qa.open();
      const pill = qa.page.getByTestId("model-download");
      await expect(pill).toBeVisible({ timeout: 60_000 });
      appeared.stop();
      expect(places.asked.length).toBeGreaterThan(0);
      await expect(pill).toContainText(
        "Downloading the speech model (one time, about 465 MB) - 0%",
      );
      expect(await qa.page.evaluate((k) => localStorage.getItem(k), DECLINE_KEY)).toBeNull();

      await pill.getByRole("button", { name: "Cancel" }).click();
      await expect(pill).toHaveCount(0, { timeout: 15_000 });
      // A Cancel is not a failure: no failure card, and the app keeps the person's no.
      await expect(qa.page.getByTestId("model-failure")).toHaveCount(0);
      const kept = await qa.page.evaluate((k) => localStorage.getItem(k), DECLINE_KEY);
      expect(kept, "the Cancel was not remembered").not.toBeNull();
      const asked = places.asked.length;
      // Nothing starts the download again behind the person's back.
      await qa.page.waitForTimeout(5_000);
      expect(places.asked.length).toBe(asked);
    } finally {
      letGo();
    }
  });

  test("a download every place refuses shows a failure card with the reason; Retry asks again", async ({
    qa,
  }) => {
    await SpeechStandIn.install(qa, { model: false });
    await neverDeclined(qa);
    const places = await modelPlaces(qa, (route) =>
      route.fulfill({ status: 404, body: "Not Found" }),
    );
    const shown = startTimer(
      inBrowser("launch to the speech model failure card, every place refuses"),
    );
    await qa.open();
    const card = qa.page.getByTestId("model-failure");
    await expect(card).toBeVisible({ timeout: 90_000 });
    shown.stop();
    await expect(card).toContainText("Could not download the speech model.");
    const reason = await card.getAttribute("data-reason");
    expect(reason).toBeTruthy();
    expect(places.asked.length).toBeGreaterThanOrEqual(2); // both places were tried

    const before = places.asked.length;
    await card.getByRole("button", { name: "Retry" }).click();
    await expect.poll(() => places.asked.length, { timeout: 30_000 }).toBeGreaterThan(before);
    await expect(card).toBeVisible({ timeout: 60_000 });
  });

  test("captions asked for while the model cannot be downloaded say the model is missing, never that nobody speaks", async ({
    qa,
  }) => {
    await SpeechStandIn.install(qa, { model: false });
    await modelPlaces(qa, (route) => route.fulfill({ status: 404, body: "Not Found" }));
    chromiumCovers();
    await qa.openProject("sweep_qa_nomodel");
    const ref = await attachSpoken(qa);
    await placeSpoken(qa, ref);

    let told: Record<string, unknown> = {};
    qa.server.script(
      callTools([{ name: "add_captions", arguments: { language: "en" } }]),
      (round: Round) => {
        told = resultOf(round, "add_captions");
        return say("I could not make captions yet.");
      },
    );
    await qa.send("Add captions");
    await expect(qa.reply("I could not make captions yet.")).toBeVisible({ timeout: 120_000 });
    await qa.idle();
    expect(told.ok).toBe(false);
    expect(JSON.stringify(told)).toMatch(/model/i);
    expect(String(told.error ?? "")).not.toMatch(/no speech detected/);
    expect(captionsOf(await qa.savedTimeline())).toHaveLength(0);
  });
});
