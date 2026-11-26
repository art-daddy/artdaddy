// The agent lane's test fixture: every test gets its own fake ArtDaddy server (fakeServer.ts), its
// own QA shell with an empty disk (qaShell.ts), and a page wired to both before it loads. The
// helpers drive the app the way a person does (menus, the composer, buttons) and read back what
// it SAVED, from the shell's disk.
//
//   import { test, expect } from "./lib/qa";
//   test("...", async ({ qa }) => {
//     qa.server.script(plainText("Hello."));
//     await qa.openProject();
//     await qa.send("hi");
//     await expect(qa.reply("Hello.")).toBeVisible();
//   });
//
// When a test ends, the requests the server saw and the commands the shell answered are attached
// to its report, and a model round that came with no reply scripted fails it: an extra round the
// app sent (a duplicate after a failure, a retry nobody asked for) cannot pass unnoticed.
import { readFileSync } from "node:fs";

import { test as base, expect, type Locator, type Page, type TestInfo } from "@playwright/test";

import { FakeArtDaddy } from "./fakeServer";
import { QaShell } from "./qaShell";

/** What a saved transcript (`internals/transcript.json`) holds, as far as these tests read it. */
export interface SavedTranscript {
  requests?: Array<{
    message?: { text?: string };
    response?: Array<Record<string, unknown>>;
    [k: string]: unknown;
  }>;
  [k: string]: unknown;
}

export interface SavedTimeline {
  tracks?: Array<{ id?: string; kind?: string; clips?: Array<Record<string, unknown>> }>;
  [k: string]: unknown;
}

const APP_VERSION = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string })
  .version;

export class AgentRig {
  constructor(
    readonly page: Page,
    readonly server: FakeArtDaddy,
    readonly shell: QaShell,
    readonly info: TestInfo,
  ) {}

  get composer(): Locator {
    return this.page.getByPlaceholder("Message the editor…");
  }

  get sendButton(): Locator {
    return this.page.getByRole("button", { name: "Send", exact: true });
  }

  get stopButton(): Locator {
    return this.page.getByRole("button", { name: "⏹ Stop" });
  }

  /** The assistant pane (its transcript, composer and controls). */
  get pane(): Locator {
    return this.page.getByRole("region", { name: "Assistant" });
  }

  /** Text the assistant shows anywhere in its pane. */
  reply(text: string | RegExp): Locator {
    return this.pane.getByText(text);
  }

  /** The id of the open project, from the route (`/p/<id>`). */
  projectId(): string {
    const m = /\/p\/([^/?#]+)/.exec(this.page.url());
    if (!m) throw new Error(`no project is open (at ${this.page.url()})`);
    return decodeURIComponent(m[1]);
  }

  /** Start the app and wait until its chrome is up. A cold dev server transforms for a while. */
  async open(): Promise<void> {
    await this.page.goto("/");
    await expect(this.page.getByRole("button", { name: "File", exact: true })).toBeVisible({
      timeout: 90_000,
    });
  }

  /** File > New Project, as a person does it, then wait for the assistant to be ready. */
  async newProject(name = "sweep_qa_agent"): Promise<string> {
    await this.page.getByRole("button", { name: "File", exact: true }).click();
    await this.page
      .getByRole("button", { name: /New Project/i })
      .first()
      .click();
    await this.page.getByPlaceholder("Project name…").fill(name);
    await this.page.getByRole("button", { name: /^Create$/ }).click();
    await this.page.waitForURL(/\/p\//, { timeout: 30_000 });
    await expect(this.composer).toBeEnabled({ timeout: 30_000 });
    return this.projectId();
  }

  /** Start the app and make a fresh project. */
  async openProject(name?: string): Promise<string> {
    await this.open();
    return this.newProject(name);
  }

  /** Quit and start the app again, then open `name` from File > Open Project, as a person
   *  coming back to their work does. Returns the id the route shows. */
  async reopen(name = "sweep_qa_agent"): Promise<string> {
    await this.open();
    await this.page.getByRole("button", { name: "File", exact: true }).click();
    await this.page
      .getByRole("button", { name: /Open Project/i })
      .first()
      .click();
    await this.page.getByRole("button", { name, exact: true }).click();
    await this.page.waitForURL(/\/p\//, { timeout: 30_000 });
    await expect(this.composer).toBeEnabled({ timeout: 30_000 });
    return this.projectId();
  }

  /** A clip as the timeline draws it. */
  timelineClip(clipId: string): Locator {
    return this.page.locator(`[data-clip-id="${clipId}"]`);
  }

  /** Type into the composer and press Send. */
  async send(text: string): Promise<void> {
    await this.composer.fill(text);
    await this.sendButton.click();
  }

  /** Attach a file with the paperclip, as a person does: the button opens the OS file dialog
   *  (answered by the shell with a copy of `fixture`), and the file comes in by reference. */
  async attach(fixture: string): Promise<void> {
    const page = await this.shell.addMedia(fixture);
    this.shell.pickFiles([page]);
    await this.page.getByTitle("Attach images, video, or audio").click();
    const name = page.split("/").pop()!;
    await expect(this.pane.getByText(name, { exact: true })).toBeVisible({ timeout: 20_000 });
  }

  /** The library's assets as saved (`internals/library.json`). */
  async savedAssets(id = this.projectId()): Promise<Array<Record<string, unknown>>> {
    const lib = (await this.savedLibrary(id)) as { clips?: Array<Record<string, unknown>> } | null;
    return lib?.clips ?? [];
  }

  /** Wait until no turn is running (the Send button is back). */
  async idle(timeout = 30_000): Promise<void> {
    await expect(this.stopButton).toHaveCount(0, { timeout });
  }

  async savedTimeline(id = this.projectId()): Promise<SavedTimeline | null> {
    return this.shell.readProjectJson<SavedTimeline>(id, "internals/timeline.json");
  }

  async savedTranscript(id = this.projectId()): Promise<SavedTranscript | null> {
    return this.shell.readProjectJson<SavedTranscript>(id, "internals/transcript.json");
  }

  async savedLibrary(id = this.projectId()): Promise<Record<string, unknown> | null> {
    return this.shell.readProjectJson(id, "internals/library.json");
  }

  /** The saved transcript as one string, for "does the record say X" checks. */
  async savedTranscriptText(id = this.projectId()): Promise<string> {
    return JSON.stringify((await this.savedTranscript(id)) ?? {});
  }
}

export const test = base.extend<{ qa: AgentRig }>({
  qa: async ({ page }, use, info) => {
    const server = await FakeArtDaddy.start();
    const shell = await QaShell.create(info.outputPath("qa-home"));
    await shell.install(page, server.origin, APP_VERSION);
    const rig = new AgentRig(page, server, shell, info);
    try {
      await use(rig);
    } finally {
      await info.attach("fake-server-requests.json", {
        body: JSON.stringify(
          server.seen.map((s) => ({ ...s, body: summarize(s.body) })),
          null,
          2,
        ),
        contentType: "application/json",
      });
      await info.attach("qa-shell.json", {
        body: JSON.stringify(
          { unknown: [...shell.unknown], blocked: [...shell.blocked], calls: shell.calls },
          null,
          2,
        ),
        contentType: "application/json",
      });
      shell.dispose();
      await server.stop();
      if (process.env.QA_AGENT_DEBUG) {
        console.log(
          "[qa] server:",
          server.seen.map((s) => `${s.method} ${s.path} ${s.status ?? ""} ${s.end ?? ""}`),
        );
        console.log("[qa] shell unknown:", [...shell.unknown]);
        console.log(
          "[qa] shell errors:",
          shell.calls.filter((c) => c.error).map((c) => `${c.cmd}: ${c.error}`),
        );
      }
    }
    if (server.unscripted.length)
      throw new Error(
        `the app sent ${server.unscripted.length} model round(s) no reply was scripted for: ` +
          "an extra round (a duplicate, an unasked retry) or a test that forgot to script one",
      );
  },
});

/** A request body small enough to attach: long strings (pictures, history) are cut. */
function summarize(body: unknown): unknown {
  return JSON.parse(
    JSON.stringify(body ?? null, (_k, v) =>
      typeof v === "string" && v.length > 400 ? `${v.slice(0, 400)}… (${v.length} chars)` : v,
    ),
  );
}

export { expect };
