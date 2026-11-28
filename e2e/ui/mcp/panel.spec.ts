// The MCP panel and the chat's MCP chip, the way a person uses them, with the desktop side faked (no port is opened:
// the real door is the desktop lane's, e2e/desktop/mcp). What is checked: what Copy puts on the clipboard and what
// Install hands the OS for each app, the nudge for a setup that never connected, what the panel says when the port is
// taken or reserved, the chip following an outside agent, and what an outside agent is answered when the app is signed
// out or shows no project. An outside agent's requests are raised the way Rust raises them, and its answers read where
// Rust would read them (`mcp_reply`). Only free tools: never a paid one.
//
//   npm run e2e:ui -- e2e/ui/mcp
import { startTimer } from "../../lib/timing";
import { expect, knownBug, type Rig, test } from "../auth-and-accounts/lib/rig";

const ENDPOINT = "http://127.0.0.1:19787/mcp";
const browserName = () => test.info().project.name;

/** The desktop side with the server switched on (and off) on request, the way Rust answers: no port is opened. */
function serverWorks(qa: Rig): void {
  let running = false;
  qa.native("mcp_start", () => ((running = true), { running, port: 19787 }));
  qa.native("mcp_stop", () => ((running = false), { running, port: 19787 }));
  qa.native("mcp_status", () => ({ running, port: 19787 }));
}

/** What the page puts on the clipboard, kept where the test can read it (every engine, no permission prompt). */
async function watchClipboard(qa: Rig): Promise<void> {
  await qa.page.addInitScript(() => {
    const w = window as unknown as { __qaClipboard: string[] };
    w.__qaClipboard = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          w.__qaClipboard.push(text);
        },
        readText: async () => w.__qaClipboard[w.__qaClipboard.length - 1] ?? "",
      },
    });
  });
}
const clipboard = (qa: Rig) =>
  qa.page.evaluate(() => (window as unknown as { __qaClipboard: string[] }).__qaClipboard);

async function openPanel(qa: Rig): Promise<void> {
  await qa.choose("Help", "Connect an AI Agent (MCP)…");
  await expect(qa.page.getByRole("heading", { name: "Connect an AI agent" })).toBeVisible();
}

/** The setup block of one app in the panel: its name, its buttons and its snippet. */
const setup = (qa: Rig, label: string) =>
  qa.page
    .locator("div.mt-3")
    .filter({ has: qa.page.getByText(label, { exact: true }) })
    .first();

/** An outside agent's MCP request, raised as Rust raises it, and the answer the app hands back to Rust. */
async function ask(
  qa: Rig,
  id: number,
  method: string,
  params: Record<string, unknown> = {},
  client = { name: "claude-code", version: "2.0.14" },
): Promise<{ text: string; isError: boolean; raw: unknown }> {
  await qa.emit("artdaddy://mcp-request", { id, method, params, client });
  await expect
    .poll(() => qa.callsOf("mcp_reply").some((r) => r.id === id), { timeout: 30_000 })
    .toBe(true);
  const payload = qa.callsOf("mcp_reply").find((r) => r.id === id)!.payload as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  return {
    text: payload.content?.find((c) => c.type === "text")?.text ?? JSON.stringify(payload),
    isError: payload.isError === true,
    raw: payload,
  };
}

test.describe("setting up an outside agent", () => {
  test("Copy gives the exact setup for Claude Code and Codex; Install hands Cursor and VS Code a link with the address", async ({
    qa,
  }) => {
    serverWorks(qa);
    qa.native("open_install_link", () => null);
    await watchClipboard(qa);
    await qa.openToMenu();
    const shown = startTimer(`mcp: Help menu to the panel [${browserName()}]`);
    await openPanel(qa);
    await expect(qa.page.getByText("MCP server is on")).toBeVisible();
    shown.stop();

    await setup(qa, "Claude Code").getByRole("button", { name: "Copy" }).click();
    await expect(setup(qa, "Claude Code").getByRole("button", { name: "Copied" })).toBeVisible();
    await setup(qa, "Codex").getByRole("button", { name: "Copy" }).click();
    const copied = await clipboard(qa);
    expect(copied[0]).toBe(`claude mcp add --scope user --transport http artdaddy ${ENDPOINT}`);
    expect(copied[1]).toBe(`codex mcp add artdaddy --url ${ENDPOINT}`);

    await setup(qa, "Cursor").getByRole("button", { name: "Install" }).click();
    await setup(qa, "VS Code / Copilot").getByRole("button", { name: "Install" }).click();
    await expect.poll(() => qa.callsOf("open_install_link").length).toBe(2);
    const [cursor, vscode] = qa.callsOf("open_install_link").map((a) => new URL(String(a.url)));
    // What each editor will write into its own config: the address of this door, under the name "artdaddy".
    expect(cursor.searchParams.get("name")).toBe("artdaddy");
    expect(JSON.parse(atob(cursor.searchParams.get("config")!))).toEqual({ url: ENDPOINT });
    expect(vscode.protocol).toBe("vscode:");
    expect(JSON.parse(decodeURIComponent(vscode.href.split("?")[1]))).toEqual({
      name: "artdaddy",
      type: "http",
      url: ENDPOINT,
    });
  });

  test("Claude Desktop's Install saves the connector and says where it is and what is left to do", async ({
    qa,
  }) => {
    serverWorks(qa);
    qa.native("reveal_mcp_bundle", () => "/qa-home/downloads/artdaddy.mcpb");
    await qa.openToMenu();
    await openPanel(qa);
    await setup(qa, "Claude Desktop").getByRole("button", { name: "Install" }).click();
    await expect(
      qa.page.getByText(
        "Saved to /qa-home/downloads/artdaddy.mcpb. In Claude Desktop: Settings → Extensions → Install Extension, then pick that file.",
      ),
    ).toBeVisible();
    expect(qa.callsOf("reveal_mcp_bundle")).toHaveLength(1);
  });

  test("a setup that produced no connection in 3 minutes says what to do next, under that app only", async ({
    qa,
  }) => {
    serverWorks(qa);
    await watchClipboard(qa);
    await qa.page.clock.install();
    await qa.openToMenu();
    await openPanel(qa);
    await setup(qa, "Claude Code").getByRole("button", { name: "Copy" }).click();
    await expect(qa.page.getByText(/nothing from Claude Code has connected yet/)).toHaveCount(0);
    await qa.page.clock.fastForward("03:15");
    await expect(
      setup(qa, "Claude Code").getByText(
        /Set up 3 min ago, and nothing from Claude Code has connected yet\. Next: Run the command in a terminal, then start a new Claude Code session\./,
      ),
    ).toBeVisible({ timeout: 15_000 });
    // Not said of an app the person did not set up.
    await expect(qa.page.getByText(/nothing from Codex has connected yet/)).toHaveCount(0);
  });
});

test.describe("when the port cannot be had", () => {
  test("another copy of ArtDaddy holds it: after the wait the panel says so and how to fix it", async ({
    qa,
  }) => {
    qa.native("mcp_start", () => {
      throw new Error(
        "could not bind 127.0.0.1:19787: Only one usage of each socket address (protocol/network address/port) is normally permitted. (os error 10048)",
      );
    });
    qa.native("mcp_status", () => ({ running: false, port: 19787 }));
    qa.native("mcp_port_holder", () => ({ holder: "artdaddy" }));
    await qa.openToMenu();
    await openPanel(qa);
    await expect(
      qa.page.getByText(
        "It last failed with: Port 19787 is in use by another copy of this app: a second window, or another Windows account signed in on this computer. Close it (end it in Task Manager if you cannot see a window) and switch this back on.",
      ),
    ).toBeVisible({ timeout: 30_000 });
    await expect(qa.page.getByText("MCP server is off")).toBeVisible();
    await expect(qa.page.getByRole("switch", { name: "Turn on MCP server" })).toBeEnabled();
  });

  test("Windows has set the port aside: the panel says a restart usually frees it", async ({
    qa,
  }) => {
    qa.native("mcp_start", () => {
      throw new Error(
        "could not bind 127.0.0.1:19787: An attempt was made to access a socket in a way forbidden by its access permissions. (os error 10013)",
      );
    });
    qa.native("mcp_status", () => ({ running: false, port: 19787 }));
    await qa.openToMenu();
    await openPanel(qa);
    await expect(
      qa.page.getByText(
        /Windows has set port 19787 aside for something else .* Restarting the computer usually frees it\./,
      ),
    ).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("an outside agent at work", () => {
  test("the chat's chip follows it: connected, then has the tools, then used one; and it opens the panel", async ({
    qa,
  }) => {
    serverWorks(qa);
    qa.native("mcp_reply", () => null);
    await qa.openToMenu();
    await qa.newProject("sweep_qa_mcp chip");
    const chip = qa.page.getByRole("button", { name: "Connect your own agent/MCP" });
    await expect(chip).toBeVisible({ timeout: 30_000 });
    await qa.emit("artdaddy://mcp-session", { client: { name: "claude-code", version: "2.0.14" } });
    await expect(qa.page.getByRole("button", { name: "Claude Code: connected" })).toBeVisible();
    const list = await ask(qa, 1, "tools/list");
    expect(list.isError).toBe(false);
    await expect(
      qa.page.getByRole("button", { name: "Claude Code: no tool used yet" }),
    ).toBeVisible();
    const current = await ask(qa, 2, "tools/call", {
      name: "manage_project",
      arguments: { action: "current" },
    });
    expect(current.isError).toBe(false);
    const connected = qa.page.getByRole("button", { name: "Connected: Claude Code" });
    await expect(connected).toBeVisible();
    await connected.click();
    await expect(qa.page.getByRole("heading", { name: "Connect an AI agent" })).toBeVisible();
    await expect(
      qa.page
        .getByRole("list", { name: "Agents that have connected" })
        .getByText(/Claude Code 2\.0\.14/),
    ).toBeVisible();
  });

  test("a signed-out app lists and runs nothing for an outside agent", async ({
    qa,
    signedOutApp,
  }) => {
    qa.shell.refreshToken = null;
    serverWorks(qa);
    qa.native("mcp_reply", () => null);
    await qa.open(signedOutApp);
    await expect(qa.page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible({
      timeout: 90_000,
    });
    await expect.poll(() => qa.callsOf("mcp_start").length, { timeout: 30_000 }).toBe(1);
    const list = await ask(qa, 1, "tools/list");
    expect(list.isError).toBe(true);
    expect(JSON.stringify(list.raw)).not.toMatch(/"tools"/);
    expect(list.text).toMatch(/"ran": false/);
    const made = await ask(qa, 2, "tools/call", {
      name: "manage_project",
      arguments: { action: "create", name: "sweep_qa_mcp should not exist" },
    });
    expect(made.isError).toBe(true);
    // Nothing was made on disk.
    expect(
      await qa.shell.readProjectJson("sweep_qa_mcp_should_not_exist", "project.json"),
    ).toBeNull();
    await expect(qa.page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
  });

  test("a signed-out app tells an outside agent that the person must sign in", async ({
    qa,
    signedOutApp,
  }) => {
    knownBug(
      "A signed-out app tells an outside agent to finish an update or build check, not to sign in",
      /signed out, so nothing can be listed or run/,
    );
    qa.shell.refreshToken = null;
    serverWorks(qa);
    qa.native("mcp_reply", () => null);
    await qa.open(signedOutApp);
    await expect(qa.page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible({
      timeout: 90_000,
    });
    await expect.poll(() => qa.callsOf("mcp_start").length, { timeout: 30_000 }).toBe(1);
    const list = await ask(qa, 1, "tools/list");
    // What the agent relays to the person: today it says to finish an update or check in the app, which the
    // person cannot find on a sign-in screen.
    expect(list.text).toMatch(/signed out, so nothing can be listed or run/);
    expect(list.text).toMatch(/ask the user to sign in/);
  });

  test("after a restart on the start screen, manage_project current tells the agent that no project is open", async ({
    qa,
  }) => {
    knownBug(
      "On the start screen, MCP manage_project current reports the last project as open, and the agent's next tool call reopens it",
      /active_id/,
    );
    serverWorks(qa);
    qa.native("mcp_reply", () => null);
    await qa.openToMenu();
    await qa.newProject("sweep_qa_mcp last session");
    // The person quits with the project open and starts the app again: the start screen, nothing open, and the
    // project in its list.
    await qa.openToMenu();
    await expect(qa.page.getByText("Connect Claude, Cursor or Codex over MCP")).toBeVisible();
    await expect(qa.page.getByText("sweep_qa_mcp last session").first()).toBeVisible({
      timeout: 30_000,
    });
    const current = await ask(qa, 1, "tools/call", {
      name: "manage_project",
      arguments: { action: "current" },
    });
    expect(JSON.parse(current.text)).toMatchObject({ active_id: null });
  });

  test("after a restart on the start screen, an agent's tool call does not reopen the last project by itself", async ({
    qa,
  }) => {
    knownBug(
      "On the start screen, MCP manage_project current reports the last project as open, and the agent's next tool call reopens it",
      /toHaveURL|Expected pattern/,
    );
    serverWorks(qa);
    qa.native("mcp_reply", () => null);
    await qa.openToMenu();
    await qa.newProject("sweep_qa_mcp last session");
    await qa.openToMenu();
    await expect(qa.page.getByText("Connect Claude, Cursor or Codex over MCP")).toBeVisible();
    await expect(qa.page.getByText("sweep_qa_mcp last session").first()).toBeVisible({
      timeout: 30_000,
    });
    const read = await ask(qa, 1, "tools/call", { name: "get_timeline", arguments: {} });
    // The person's screen stays where they left it; the agent is told to open a project first.
    await expect(qa.page).toHaveURL(/127\.0\.0\.1:\d+\/$/, { timeout: 2_000 });
    expect(read.text).toMatch(/No project is open/);
  });
});
