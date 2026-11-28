// The browser rig for the QA catch-up of sign-in, updates, the MCP panel and the reports a person can send. It is the
// agent lane's rig (e2e/ui/agent-and-models/lib: a fake ArtDaddy server and a fake desktop side, both real and fresh for
// every test) with three things those tests never needed:
//
// - The app WITHOUT the e2e sign-in bypass (`signedOutApp`). The browser lane's page server compiles the bypass in for
//   every spec (playwright.config.ts), and with it the sign-in screens never show. So this starts a second page server
//   for the specs that ask for it: this worktree's source, the same config, the bypass left out (no `.env` file is read,
//   and the variable is taken out of this process's environment while it starts), its own dependency cache so it can
//   never rewrite the lane's. It is started once per worker and warmed before the first test uses it.
// - The desktop side's answers can be changed per test (`qa.native(cmd, answer)`): an update to offer, a download that
//   fails, the MCP server's state, what opening the browser for sign-in does. Every other command is the agent lane's.
// - A native event can be raised the way Rust raises it (`qa.emit`): the sign-in link coming back from the browser, an
//   outside agent's MCP request.
//
// Nothing here reaches a real service: the page can reach only the fake server (the shell cuts every https address),
// and the fake server has no model behind it.
import { mkdirSync, readFileSync } from "node:fs";
import { createServer as netServer, type AddressInfo } from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { test as base, expect, type Page, type Route, type TestInfo } from "@playwright/test";

import { FakeArtDaddy } from "../../agent-and-models/lib/fakeServer";
import { QaShell } from "../../agent-and-models/lib/qaShell";

export { expect };

export const APP_VERSION = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string })
  .version;

type Args = Record<string, unknown>;
type Answer = (args: Args) => unknown;

/** A command the desktop side answered, with what the page sent (only for commands a test changed). */
export interface NativeCall {
  cmd: string;
  args: Args;
  at: number;
}

const COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const knownBugs = new WeakMap<TestInfo, { title: string; shows: RegExp }>();

/** Mark this test as failing until a bug in what shipped is fixed, and say how the bug shows: `shows` must match every
 *  error the test fails with. A failure any other way (a timeout, a broken step) is then reported as the failure it is,
 *  and the day the bug is fixed the test passes, which Playwright reports as a failure until the mark is removed. */
export function knownBug(title: string, shows: RegExp): void {
  const info = test.info();
  knownBugs.set(info, { title, shows });
  info.annotations.push({ type: "known bug", description: `${title}; fails with ${shows}` });
  test.fail(true, title);
}

function checkKnownBug(info: TestInfo): void {
  const bug = knownBugs.get(info);
  if (!bug || info.expectedStatus !== "failed") return;
  const messages = info.errors.map((e) => (e.message ?? e.value ?? "").replace(COLOUR, ""));
  const other = messages.filter((m) => !bug.shows.test(m));
  if (info.status === "passed" || (info.status === "failed" && messages.length && !other.length))
    return;
  info.expectedStatus = "passed";
  throw new Error(
    `marked as failing because of "${bug.title}" (an error matching ${bug.shows}), but it ended another way ` +
      `(${info.status}): ${(other[0] ?? "no error matched").slice(0, 400)}`,
  );
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = netServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

const BYPASS_VARS = ["VITE_E2E_AUTH_BYPASS", "VITE_API_BASE_URL", "VITE_SENTRY_DSN"] as const;

/** A page server for this worktree's app with the sign-in bypass left out. Its dependency cache is its own, one per
 *  browser project, so it never rewrites the lane's cache or another run's. */
async function startSignedOutApp(
  outDir: string,
  project: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  const envDir = path.join(outDir, "signed-out-app-env");
  mkdirSync(envDir, { recursive: true });
  const saved = Object.fromEntries(BYPASS_VARS.map((k) => [k, process.env[k]]));
  delete process.env.VITE_E2E_AUTH_BYPASS;
  // As the lane's own server: a closed port. The shell points the app at the fake server through its runtime setting.
  process.env.VITE_API_BASE_URL = "http://127.0.0.1:8000";
  process.env.VITE_SENTRY_DSN = "";
  try {
    const { createServer } = await import("vite");
    const port = await freePort();
    const server = await createServer({
      configFile: path.resolve("vite.config.ts"),
      root: process.cwd(),
      mode: "development",
      envDir,
      cacheDir: path.resolve("node_modules", `.vite-qa-signed-out-${project.replace(/\W+/g, "_")}`),
      logLevel: "error",
      clearScreen: false,
      server: { host: "127.0.0.1", port, strictPort: true, hmr: false },
    });
    await server.listen();
    return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
  } finally {
    for (const k of BYPASS_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

export class Rig {
  /** Commands whose answer a test changed, as the page sent them. */
  readonly nativeCalls: NativeCall[] = [];
  private readonly answers = new Map<string, Answer>();

  constructor(
    readonly page: Page,
    readonly server: FakeArtDaddy,
    readonly shell: QaShell,
    readonly info: TestInfo,
  ) {
    const original = shell.handle.bind(shell);
    shell.handle = async (cmd: string, json: string): Promise<string> => {
      const answer = this.answers.get(cmd);
      if (!answer) return original(cmd, json);
      const args = (JSON.parse(json) ?? {}) as Args;
      this.nativeCalls.push({ cmd, args, at: performance.now() });
      shell.calls.push({ cmd, at: performance.now() });
      try {
        const value = await answer(args);
        return JSON.stringify({ ok: true, value: value === undefined ? null : value });
      } catch (e) {
        return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    };
  }

  /** From now on the desktop side answers `cmd` with `answer` (throw to make the command fail). */
  native(cmd: string, answer: Answer): void {
    this.answers.set(cmd, answer);
  }

  /** What the page sent with each call of a command a test changed. */
  callsOf(cmd: string): Args[] {
    return this.nativeCalls.filter((c) => c.cmd === cmd).map((c) => c.args);
  }

  /** Raise a native event the way Rust does (a link from the browser, an MCP request). */
  async emit(event: string, payload: unknown): Promise<void> {
    await this.page.evaluate(
      ([e, p]) =>
        (
          window as unknown as { __qaShell: { emit: (e: string, p: unknown) => void } }
        ).__qaShell.emit(e, p),
      [event, payload] as const,
    );
  }

  /** Answer one of the fake server's routes differently for this test (a rejected session, a slow check). */
  async route(pathname: string, handler: (route: Route) => Promise<void> | void): Promise<void> {
    await this.page.route(`${this.server.origin}${pathname}`, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers":
              route.request().headers()["access-control-request-headers"] ?? "*",
          },
        });
        return;
      }
      await handler(route);
    });
  }

  /** A JSON answer for `route`, with the headers the real server's CORS sends. */
  static json(status: number, body: unknown): Parameters<Route["fulfill"]>[0] {
    return {
      status,
      headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
  }

  /** Start the app: the lane's own page (sign-in bypassed) unless `at` names the signed-out app's address. */
  async open(at?: string): Promise<void> {
    await this.page.goto(at ? `${at}/` : "/");
  }

  /** Start the app and wait for its menu bar. */
  async openToMenu(at?: string): Promise<void> {
    await this.open(at);
    await expect(this.menu("File")).toBeVisible({ timeout: 90_000 });
  }

  menu(name: string) {
    return this.page.getByRole("button", { name, exact: true });
  }

  /** Open a top menu and choose an item, as a person does. */
  async choose(menu: string, item: string | RegExp): Promise<void> {
    await this.menu(menu).click();
    await this.page.getByRole("button", { name: item }).first().click();
  }

  /** File > New Project, named `name`, then wait for the editor. Returns the project's id. */
  async newProject(name = "sweep_qa_auth"): Promise<string> {
    await this.choose("File", /New Project/);
    await this.page.getByPlaceholder("Project name…").fill(name);
    await this.page.getByRole("button", { name: /^Create$/ }).click();
    await this.page.waitForURL(/\/p\//, { timeout: 30_000 });
    // The editor itself, not only its address: the menus act on the open project only once its timeline is up.
    await this.page.locator("[data-track-id]").first().waitFor({ timeout: 60_000 });
    const m = /\/p\/([^/?#]+)/.exec(this.page.url());
    return decodeURIComponent(m![1]);
  }

  /** The requests the fake server saw on one path (exact), or under a prefix ending in "/". */
  requests(pathname: string) {
    return this.server.requests(pathname);
  }
}

export const test = base.extend<{ qa: Rig }, { signedOutApp: string }>({
  signedOutApp: [
    async ({ browser }, use, workerInfo) => {
      const app = await startSignedOutApp(workerInfo.project.outputDir, workerInfo.project.name);
      try {
        // Warm it: the first page load transforms the whole app, which on a busy PC is minutes.
        const context = await browser.newContext();
        const page = await context.newPage();
        const shell = await QaShell.create(
          path.join(workerInfo.project.outputDir, "signed-out-warmup"),
        );
        const server = await FakeArtDaddy.start();
        try {
          await shell.install(page, server.origin, APP_VERSION);
          await page.goto(`${app.url}/`, { waitUntil: "load", timeout: 300_000 });
          await page
            .getByRole("button", { name: /^(File|Log in or sign up)$/ })
            .first()
            .waitFor({ timeout: 300_000 });
        } finally {
          shell.dispose();
          await server.stop();
          await context.close();
        }
        await use(app.url);
      } finally {
        await app.close();
      }
    },
    { scope: "worker", timeout: 600_000 },
  ],
  qa: async ({ page }, use, info) => {
    const server = await FakeArtDaddy.start();
    const shell = await QaShell.create(info.outputPath("qa-home"));
    const rig = new Rig(page, server, shell, info);
    await shell.install(page, server.origin, APP_VERSION);
    try {
      await use(rig);
    } finally {
      await info.attach("fake-server-requests.json", {
        body: JSON.stringify(
          server.seen.map((s) => ({ method: s.method, path: s.path, status: s.status })),
          null,
          2,
        ),
        contentType: "application/json",
      });
      await info.attach("qa-shell.json", {
        body: JSON.stringify(
          { unknown: [...shell.unknown], blocked: [...shell.blocked], changed: rig.nativeCalls },
          null,
          2,
        ),
        contentType: "application/json",
      });
      shell.dispose();
      await server.stop();
    }
    checkKnownBug(info);
  },
});
