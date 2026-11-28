// The generation lane's fixture: the agent lane's rig (a fake ArtDaddy server, a QA shell with an
// empty disk, scripted model replies: ../../agent-and-models/lib/qa.ts) plus the paid side of the
// server, scripted per test (genDesk.ts). Every test gets its own of each.
//
//   import { expect, test } from "./lib/gen";
//   test("...", async ({ qa, gen }) => {
//     gen.desk.quote.generate_image = 12;
//     gen.desk.next("generate_image", { kind: "inline", answer: imageAnswer() });
//     qa.server.script(askImage(), plainText("Started."), plainText("Here it is."));
//     ...
//   });
//
// When a test ends, what the paid side saw is attached to its report, and a paid call that came
// with no answer scripted fails it.
import { promises as fsp } from "node:fs";
import path from "node:path";

import type { Locator } from "@playwright/test";

import { expect, knownBug, test as agentTest, type AgentRig } from "../../agent-and-models/lib/qa";
import { GenDesk } from "./genDesk";

/** The first line of the message the app sends the model when background work it started has
 *  finished (the app's own words: src/store/jobNotes.ts JOB_WAKE_LEAD). */
export const WAKE_LEAD = "Background work you started earlier has finished:";

export class GenRig {
  constructor(
    readonly qa: AgentRig,
    readonly desk: GenDesk,
  ) {}

  /** The approval bar's buttons. */
  get allowButton(): Locator {
    return this.qa.pane.getByRole("button", { name: "Allow", exact: true });
  }

  get denyButton(): Locator {
    return this.qa.pane.getByRole("button", { name: "Deny", exact: true });
  }

  /** The approval bar: the line that says what the app wants to do. */
  get approvalBar(): Locator {
    return this.qa.page.getByText(/wants to:/).locator("xpath=../..");
  }

  /** The bar's price line ("Up to N credits · you have M left"). */
  get priceLine(): Locator {
    return this.qa.pane.getByText(/^Up to [\d.]+ credits?/);
  }

  /** The library row of `ref`, as saved (`internals/library.json`), or undefined. */
  async row(ref: string, id = this.qa.projectId()): Promise<Record<string, unknown> | undefined> {
    return (await this.qa.savedAssets(id)).find((a) => a.id === ref);
  }

  /** The library rows the generation made (`added_by: "generation"`), as saved. */
  async generatedRows(id = this.qa.projectId()): Promise<Array<Record<string, unknown>>> {
    return (await this.qa.savedAssets(id)).filter((a) => a.added_by === "generation");
  }

  /** Wait until the generation's placeholder is saved, and return it. */
  async placeholder(id = this.qa.projectId(), timeout = 15_000): Promise<Record<string, unknown>> {
    await expect
      .poll(async () => (await this.generatedRows(id)).length, { timeout })
      .toBeGreaterThan(0);
    return (await this.generatedRows(id))[0];
  }

  /** Wait until the library row `ref` is no longer being made (finished, or failed), and return it. */
  async settled(
    ref: string,
    id = this.qa.projectId(),
    timeout = 30_000,
  ): Promise<Record<string, unknown>> {
    await expect
      .poll(
        async () => {
          const row = await this.row(ref, id);
          return row ? String(row.status ?? "ready") : "missing";
        },
        { timeout },
      )
      .toMatch(/^(ready|failed)$/);
    const row = await this.row(ref, id);
    if (!row) throw new Error(`no library row ${ref}`);
    return row;
  }

  /** The bytes of a library row's file on the shell's disk, or null while there is none. */
  async fileOf(row: Record<string, unknown>, id = this.qa.projectId()): Promise<Buffer | null> {
    const rel = String(row.path ?? "");
    if (!rel) return null;
    return fsp.readFile(path.join(this.qa.shell.projectDir(id), rel)).catch(() => null);
  }

  /** Model rounds that carried the app's "background work finished" message, in order. */
  wakeRounds(): Array<{ text: string }> {
    return this.qa.server
      .modelRounds()
      .map((s) => ({ text: roundText(s.body) }))
      .filter((r) => r.text.startsWith(WAKE_LEAD));
  }

  /** Native commands the app sent that open the community (Discord) link in the person's browser. */
  communityLinksOpened(): number {
    return this.qa.shell.calls.filter((c) => c.cmd === "open_community_link").length;
  }
}

/** The person's (or the app's) text a model round carried. */
export function roundText(body: unknown): string {
  const input = ((body ?? {}) as { round_input?: { user_text?: unknown; extra_texts?: unknown } })
    .round_input;
  if (typeof input?.user_text === "string" && input.user_text) return input.user_text;
  return Array.isArray(input?.extra_texts) ? input.extra_texts.map(String).join("\n") : "";
}

export const test = agentTest.extend<{ gen: GenRig }>({
  gen: async ({ qa, page }, use, info) => {
    const desk = new GenDesk(qa.server);
    await desk.install(page);
    try {
      await use(new GenRig(qa, desk));
    } finally {
      await info.attach("paid-side.json", {
        body: JSON.stringify(
          {
            quotes: desk.quotes,
            paid: desk.paid.map((c) => ({ ...c, body: summarize(c.body) })),
            orders: [...desk.orders.values()].map((o) => ({ ...o, answer: summarize(o.answer) })),
            unscripted: desk.unscripted.length,
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
    }
    if (desk.unscripted.length)
      throw new Error(
        `the app sent ${desk.unscripted.length} paid call(s) no answer was scripted for ` +
          `(${desk.unscripted.map((c) => c.proxy).join(", ")}): a paid request nobody expected`,
      );
  },
});

/** A body small enough to attach: long strings (pictures, audio) are cut. */
function summarize(body: unknown): unknown {
  return JSON.parse(
    JSON.stringify(body ?? null, (_k, v) =>
      typeof v === "string" && v.length > 200 ? `${v.slice(0, 200)}… (${v.length} chars)` : v,
    ),
  );
}

/** The browser in a wait's name, as the shared timing helper asks. */
export function waitName(area: "generation" | "billing", what: string): string {
  return `${area}: ${what} [${test.info().project.name}]`;
}

export { expect, knownBug };
