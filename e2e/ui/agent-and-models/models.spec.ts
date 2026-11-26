// The model picker under the composer: what the person picks is what the agent is asked to use.
import { plainText } from "./fixtures/replies/plainText";
import { expect, test, type AgentRig } from "./lib/qa";

/** The pickers are plain <select>s; each is found by an option only it offers. */
const modelPicker = (qa: AgentRig) =>
  qa.pane.locator("select").filter({ has: qa.page.locator('option[value="gpt-6.1-sol"]') });
const effortPicker = (qa: AgentRig) =>
  qa.pane.locator("select").filter({ has: qa.page.locator('option[value="xhigh"]') });

const asked = (qa: AgentRig, i: number) =>
  qa.server.modelRounds()[i]?.body as { model?: string; effort?: string } | undefined;

test.describe("choosing a model and effort", () => {
  test.setTimeout(90_000);

  test("each model and effort picked is the one the round asks for", async ({ qa }) => {
    qa.server.script(
      plainText("Answered on sol at high."),
      plainText("Answered on luna with no reasoning."),
    );
    await qa.openProject();
    const model = modelPicker(qa);
    const effort = effortPicker(qa);
    // A new app starts on the default model at medium (owner decision, 14 Nov).
    await expect(model).toHaveValue("gpt-6-luna");
    await expect(effort).toHaveValue("medium");

    await model.selectOption("gpt-6.1-sol");
    // sol has no "none": it is not offered, so it cannot be sent.
    await expect(effort.locator('option[value="none"]')).toHaveCount(0);
    await effort.selectOption("high");
    await qa.send("Plan the edit");
    await expect(qa.reply("Answered on sol at high.")).toBeVisible({ timeout: 15_000 });
    await qa.idle();
    expect(asked(qa, 0)).toMatchObject({ model: "gpt-6.1-sol", effort: "high" });

    await model.selectOption("gpt-6-luna");
    await expect(effort.locator('option[value="none"]')).toHaveCount(1);
    await effort.selectOption("none");
    await qa.send("Now a quick one");
    await expect(qa.reply("Answered on luna with no reasoning.")).toBeVisible({ timeout: 15_000 });
    await qa.idle();
    expect(asked(qa, 1)).toMatchObject({ model: "gpt-6-luna", effort: "none" });
  });

  test("moving to a model that cannot take the chosen effort moves the effort to one it can", async ({
    qa,
  }) => {
    qa.server.script(plainText("Answered on sol."));
    await qa.openProject();
    await effortPicker(qa).selectOption("none");
    await modelPicker(qa).selectOption("gpt-6.1-sol");
    await expect(effortPicker(qa)).toHaveValue("low");
    await qa.send("Hello");
    await expect(qa.reply("Answered on sol.")).toBeVisible({ timeout: 15_000 });
    await qa.idle();
    expect(asked(qa, 0)).toMatchObject({ model: "gpt-6.1-sol", effort: "low" });
  });
});
