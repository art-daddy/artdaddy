// The MCP lane: what a person does with the app's MCP door in the REAL app (the switch, its port, an outside agent
// connecting, what that agent is told about cost, a restart, a port another program holds), judged on the screen, on
// the port itself and on what the agent receives, with the waits a person feels timed.
//
//   node --experimental-websocket e2e/desktop/mcp/run.mjs [filter]
//
// `filter` picks scenarios by name, comma-separated. Without one every scenario runs, in order: they share one app and
// each leaves it as the next expects (on, panel closed), so a filtered run starts from a fresh launch.
//
// What a run needs and does:
// - The real-app slot of the lab PC (the qa skill, rule 8): run it through
//   `python <wiki>/scripts/dispatch.py slot real-app --item <item> -- node --experimental-websocket e2e/desktop/mcp/run.mjs`.
// - Port 19787 free when it starts: whoever holds it receives MCP calls, and the owner's app would act on his real
//   project. A run that finds it held runs nothing. Every MCP request goes out only after the port was seen to belong
//   to this run's app (client.mjs `guard`), checked again after each start, restart and switch.
// - Windows, this worktree's node_modules and the generated Tauri folders. CARGO_TARGET_DIR, if set, is where the
//   shell is built (app.mjs: its own identifier, link scheme and window title).
// - The stand-in server (scripts/qa/standInServer.mjs): it answers the build check and refuses everything else with
//   503, including the sign-in routes (never 401: that would sign the owner out of his installed app). No request
//   can reach a model, a vendor or a real account. Only free tools are called (`manage_project`), and no project is
//   created, opened or changed: the projects folder is the owner's.
//
// Output: reports/qa/mcp/run-<stamp>/ (report.json with every check and time, the stand-in's log, screenshots of
// failures). Waits go to the shared timing file (e2e/lib/timing.mjs). Exit code 1 when a check failed that is not a
// known bug.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { record } from "../../lib/timing.mjs";
import {
  App,
  artdaddyProcesses,
  buildShell,
  IDENTIFIER,
  linkKeyExists,
  MCP_PORT,
  portHolder,
  processCommandLine,
  removeLinkKey,
  root,
  signInLinkTarget,
  sleep,
  startPage,
  webviewProcesses,
  WINDOW_TITLE,
} from "./app.mjs";
import { doorAnswers, mcpClient, NotOurPort } from "./client.mjs";

const filter = process.argv[2] ?? "";
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const runDir = path.join(root, "reports", "qa", "mcp", `run-${stamp}`);
mkdirSync(runDir, { recursive: true });
const API_PORT = Number(process.env.ARTDADDY_QA_MCP_API_PORT || 8391);

const PAID = [
  "generate_image",
  "generate_video",
  "generate_voiceover",
  "generate_music",
  "video_ask",
  "video_find_moment",
];
/** Found by this lane (28 Nov 2026), written to the QA catch-up's bug list. */
const BUG_PAID_DESCRIPTIONS =
  "Over MCP, four of the six paid tools do not say in their own description that they cost money";

const report = {
  lane: "e2e/desktop/mcp",
  started: new Date().toISOString(),
  filter,
  machine: {
    host: os.hostname(),
    cpus: os.cpus().length,
    totalMemoryGb: Math.round(os.totalmem() / 1e9),
  },
  build: {},
  scenarios: [],
};

const git = (...args) =>
  spawnSync("git", ["-C", root, ...args], { encoding: "utf8" }).stdout.trim();
const squash = (s) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
/** What a `manage_project` answer says, without the owner's project ids or names (the projects folder is his). */
function projectAnswer(out) {
  if (out.timedOut) return out.error;
  const p = out.payload;
  if (!p || typeof p !== "object") return `HTTP ${out.status}, ${squash(out.text).slice(0, 80)}`;
  const parts = [`HTTP ${out.status}`, `active_id ${p.active_id ? "set" : "null"}`];
  if ("name" in p) parts.push(`name ${p.name === null ? "null" : "set"}`);
  if (Array.isArray(p.projects)) parts.push(`${p.projects.length} projects listed`);
  return parts.join(", ");
}

// ---------------------------------------------------------------------------------------------------------------
// The page: the panel and its words.

const PANEL = `(() => { const h = [...document.querySelectorAll('h2')].find((e) => e.innerText.trim() === 'Connect an AI agent');
  return h ? h.parentElement.innerText : null; })()`;

const programLine = (
  title,
) => `(() => { const ul = document.querySelector('ul[aria-label="Agents that have connected"]');
  if (!ul) return null; const li = [...ul.querySelectorAll('li')].find((l) => l.innerText.includes(${JSON.stringify(title)}));
  return li ? li.innerText.replace(/\\s+/g, ' ').trim() : null; })()`;

async function openPanelFromHelp(d) {
  await d.key("Escape");
  if (await d.eval(PANEL)) return;
  await d.clickText("Help", { sel: "button" });
  await d.clickText("Connect an AI Agent (MCP)…", { sel: "button,[role=menuitem]" });
  await d.waitFor(PANEL, 10_000);
}

async function closePanel(d) {
  if (!(await d.eval(PANEL))) return;
  await d.clickText("Close", { sel: "button" });
  await d.waitFor(`!${PANEL}`, 5_000);
}

/** Leave the server on, as most scenarios expect to find it (an earlier one may have stopped with it off). */
async function ensureServerOn(d) {
  await openPanelFromHelp(d);
  const text = squash(await d.eval(PANEL));
  if (
    text.includes("MCP server is off") &&
    (await d.hasText("Turn on MCP server", "button[role=switch]"))
  ) {
    await d.clickText("Turn on MCP server", { sel: "button[role=switch]" });
    await panelUntil(d, (s) => s.includes("MCP server is on"), 15_000, "on");
  }
  await closePanel(d);
}

/** Wait until the panel's text satisfies `test` (a function of the text, run here). Returns the text, or throws with
 *  the last text seen. */
async function panelUntil(d, test, ms, what) {
  const end = Date.now() + ms;
  let last = null;
  for (;;) {
    last = await d.eval(PANEL).catch(() => null);
    if (last && test(squash(last))) return squash(last);
    if (Date.now() > end)
      throw new Error(
        `the panel never showed ${what} in ${ms} ms; it said: ${squash(last).slice(0, 400)}`,
      );
    await sleep(150);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The port.

/** Whether this run's app holds the MCP port, as Windows says. Every MCP request waits for this to be true. */
let portVerifiedFor = null;
function verifyPort(app) {
  const holder = portHolder();
  portVerifiedFor = holder !== null && holder === app.pid ? app.pid : null;
  return { ours: portVerifiedFor !== null, holder };
}
const portChanged = () => {
  portVerifiedFor = null;
};

/** Poll the door until it answers (GET, declined with 405) or `ms` passes. Resolves with the elapsed ms or null. */
async function waitDoor(ms, every = 100) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if ((await doorAnswers()) !== null) return performance.now() - t0;
    await sleep(every);
  }
  return null;
}

async function waitDoorClosed(ms) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if ((await doorAnswers()) === null) return performance.now() - t0;
    await sleep(100);
  }
  return null;
}

/** A plain listener on the MCP port, owned by this test's process: "another program holds the port". */
function holdPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => sock.destroy());
    server.once("error", reject);
    server.listen(MCP_PORT, "127.0.0.1", () =>
      resolve({ close: () => new Promise((r) => server.close(() => r())) }),
    );
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The stand-in server: the shared one, as its own process, logging method, path and status only.

async function startStandIn() {
  const log = path.join(runDir, "stand-in.log");
  const child = spawn(
    process.execPath,
    [
      path.join(root, "scripts", "qa", "standInServer.mjs"),
      "--port",
      String(API_PORT),
      "--log",
      log,
    ],
    {
      cwd: root,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  const url = `http://127.0.0.1:${API_PORT}`;
  for (let i = 0; i < 100; i += 1) {
    const ok = await fetch(`${url}/health`).then(
      () => true,
      () => false,
    );
    if (ok) break;
    await sleep(100);
  }
  return {
    url,
    log,
    lines: () => {
      try {
        return readFileSync(log, "utf8").split(/\r?\n/).filter(Boolean);
      } catch {
        return [];
      }
    },
    close: () => {
      try {
        child.kill();
      } catch {
        /* gone */
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios. Each leaves the app running with the server on and the panel closed, unless it says otherwise.

const agentA = { name: "claude-code", version: "2.0.14", title: "Claude Code" };
const agentB = { name: "cursor", version: "1.7.0", title: "Cursor" };

const scenarios = [
  {
    name: "door-opens-at-launch",
    what: "The app starts and its MCP door opens on 127.0.0.1:19787 with nothing for the person to do",
    async run(t) {
      // The launch itself happens in main(); this reads what it found.
      t.check(
        "the door answered after the launch",
        t.state.doorMs !== null,
        `${t.state.doorMs === null ? "never" : `${Math.round(t.state.doorMs)} ms after the spawn`}`,
      );
      const { ours, holder } = verifyPort(t.app);
      t.check(
        "Windows says this run's app holds port 19787",
        ours,
        `holder pid ${holder}, app pid ${t.app.pid}`,
      );
      if (t.state.doorMs !== null)
        t.time("mcp: launch to the door open (dev build)", t.state.doorMs);
    },
  },
  {
    name: "panel-says-on",
    what: "Help > Connect an AI Agent (MCP)… says the server is on, where, and that nobody has connected yet; the start screen's link opens the same panel",
    async run(t) {
      const t0 = performance.now();
      await openPanelFromHelp(t.d);
      t.time("mcp: Help menu to the panel", performance.now() - t0);
      const text = squash(await t.d.eval(PANEL));
      t.check("it says the server is on", text.includes("MCP server is on"), text.slice(0, 200));
      t.check("it names the address and port", text.includes(`Running on 127.0.0.1:${MCP_PORT}`));
      t.check(
        "it says only this machine can reach it",
        text.includes("Reachable only from this machine"),
      );
      t.check(
        "it says no agent has connected yet",
        text.includes("Waiting for an agent to connect."),
      );
      t.check(
        "the switch offers to turn it off",
        await t.d.hasText("Turn off MCP server", "button[role=switch]"),
      );
      t.check(
        "every setup carries the endpoint a person pastes",
        (text.match(/http:\/\/127\.0\.0\.1:19787\/mcp/g) ?? []).length >= 4,
        `${(text.match(/http:\/\/127\.0\.0\.1:19787\/mcp/g) ?? []).length} times`,
      );
      await closePanel(t.d);
      // The other way in: the start screen's sentence for a person who would rather use their own agent.
      if (await t.d.hasText("Connect Claude, Cursor or Codex over MCP", "button")) {
        await t.d.clickText("Connect Claude, Cursor or Codex over MCP", { sel: "button" });
        const again = await t.d.waitFor(PANEL, 5_000).catch(() => null);
        t.check(
          "the start screen's link opens the same panel",
          !!again && squash(again).includes("MCP server is on"),
        );
        await closePanel(t.d);
      } else t.note("the start screen's link was not on screen (a project is open?)");
    },
  },
  {
    name: "agent-connects",
    what: "An outside agent (announcing itself as Claude Code) connects, gets the tools and uses a free one; the panel follows each step",
    async run(t) {
      await openPanelFromHelp(t.d);
      const a = (t.state.agentA = mcpClient({
        ...agentA,
        guard: () => portVerifiedFor === t.app.pid,
      }));
      const t0 = performance.now();
      const init = await a.initialize();
      t.state.initA = init;
      t.check(
        "initialize answers 200 with a session id",
        init.status === 200 && !!a.session,
        `HTTP ${init.status}`,
      );
      t.check(
        "it speaks protocol 2025-06-18",
        init.json?.result?.protocolVersion === "2025-06-18",
        init.json?.result?.protocolVersion,
      );
      const named = `${agentA.title} ${agentA.version}`;
      const line1 = await t.d.waitFor(programLine(named), 5_000).catch(() => null);
      if (line1) t.time("mcp: an agent connects to the panel naming it", performance.now() - t0);
      t.check("the panel names the program and its version", !!line1, line1 ?? "not listed");
      t.check(
        "…and says it has not asked for tools yet",
        /has not asked for tools yet/.test(line1 ?? ""),
        line1,
      );

      const list = await a.listTools();
      t.state.tools = list.tools;
      t.check(
        "tools/list gives the catalog",
        list.tools.length >= 50,
        `${list.tools.length} tools`,
      );
      t.check(
        "manage_project is offered",
        list.tools.some((x) => x.name === "manage_project"),
      );
      const line2 = await t.d
        .waitFor(`(${programLine(named)} ?? '').includes('has the tool list')`, 5_000)
        .then(
          () => t.d.eval(programLine(named)),
          () => null,
        );
      t.check(
        "the panel says it has the tool list and has used no tool",
        /has the tool list · no tool used yet/.test(line2 ?? ""),
        line2 ?? "",
      );

      const cur = await a.call("manage_project", { action: "current" });
      t.check(
        "a free tool call is answered",
        cur.status === 200 && !cur.isError,
        projectAnswer(cur),
      );
      // The window shows the start screen (no project open). What `current` says then is pinned in the browser lane
      // (e2e/ui/mcp), where the projects are the test's own; here the projects folder is the owner's.
      t.note(`manage_project current on the start screen: ${projectAnswer(cur)}`);
      const line3 = await t.d
        .waitFor(`(${programLine(named)} ?? '').includes('1 call')`, 5_000)
        .then(
          () => t.d.eval(programLine(named)),
          () => null,
        );
      t.check(
        "the panel counts the call",
        /last tool call .* · 1 call/.test(line3 ?? ""),
        line3 ?? "",
      );
      await closePanel(t.d);
    },
  },
  {
    name: "cost-text",
    what: "What an outside agent is told about cost when it connects, and in the tools themselves",
    async run(t) {
      const init =
        t.state.initA ??
        (await mcpClient({ ...agentA, guard: () => portVerifiedFor === t.app.pid }).initialize());
      const said = squash(init.json?.result?.instructions);
      t.check("initialize carries instructions", said.length > 200, `${said.length} characters`);
      t.check("they have the cost section", said.includes("# Cost and destructive actions"));
      t.check(
        "they say this connection has no approval prompt",
        said.includes("this connection has no approval prompt"),
      );
      for (const tool of PAID)
        t.check(`they name ${tool} as spending the user's credits`, said.includes(tool));
      t.check(
        "they say to wait for the person's yes before a paid call",
        said.includes("WAIT for the user to confirm before calling one"),
      );
      t.check(
        "they say the two fetchers reach the internet",
        said.includes("download_video and get_page_image fetch from the internet"),
      );
      t.check(
        "they say a library delete needs a yes",
        said.includes("library_op with action='delete'"),
      );
      t.check(
        "they tell a session with no project how to open one",
        said.includes("Call manage_project with action='list'"),
      );
      // Not every client hands a server's instructions to its model, so each paid tool's own description is the one
      // cost text every agent sees.
      const tools = t.state.tools ?? (await t.state.agentA.listTools()).tools;
      const silent = PAID.filter((name) => {
        const d = tools.find((x) => x.name === name)?.description ?? "";
        // "spend the effort" and "token cost" are not about the person's money: only words that say the call costs them.
        return !/(costs? (real )?money|credits|paid tool|charges?)/i.test(d);
      });
      t.knownBug(
        BUG_PAID_DESCRIPTIONS,
        "every paid tool's own description says it costs money",
        silent.length === 0,
        silent.length ? `silent: ${silent.join(", ")}` : "",
      );
    },
  },
  {
    name: "switch-off-and-on",
    what: "The person turns the server off (agents are refused, the port is let go) and on again (the agent carries on)",
    async run(t) {
      await openPanelFromHelp(t.d);
      const t0 = performance.now();
      await t.d.clickText("Turn off MCP server", { sel: "button[role=switch]" });
      portChanged();
      // Timed from the click to the moment nothing answers on the port, watched while the screen is read.
      const closing = waitDoorClosed(15_000).then((ms) =>
        ms === null ? null : performance.now() - t0,
      );
      const off = await panelUntil(t.d, (s) => s.includes("MCP server is off"), 10_000, "off");
      t.check("the panel says it is off", off.includes("MCP server is off"));
      t.check(
        "it says agents cannot connect until it is on",
        off.includes("Agents cannot connect until you turn it on."),
      );
      t.check(
        "the list of connected programs is gone",
        !(await t.d.eval(
          `!!document.querySelector('ul[aria-label="Agents that have connected"]')`,
        )),
      );
      const closedAfter = await closing;
      const holderNow = portHolder();
      t.check(
        "the port is let go",
        closedAfter !== null && holderNow === null,
        `holder ${holderNow}`,
      );
      if (closedAfter !== null) t.time("mcp: switch off to the port let go", closedAfter);
      // Nobody holds the port now (checked just above), so this reaches no one: an agent's next request is refused.
      const refused = await fetch("http://127.0.0.1:19787/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        signal: AbortSignal.timeout(3000),
      }).then(
        (r) => `HTTP ${r.status}`,
        (e) => `refused (${e.cause?.code ?? e.message})`,
      );
      t.check("an agent's next request is refused", refused.startsWith("refused"), refused);

      const t1 = performance.now();
      await t.d.clickText("Turn on MCP server", { sel: "button[role=switch]" });
      await panelUntil(t.d, (s) => s.includes("MCP server is on"), 15_000, "on");
      const openMs = await waitDoor(10_000);
      if (openMs !== null) t.time("mcp: switch on to the door open", performance.now() - t1);
      const { ours, holder } = verifyPort(t.app);
      t.check("the port is this app's again", ours, `holder ${holder}`);

      // The agent that was connected before carries on with the session it had.
      const a = t.state.agentA;
      const again = await a.call("manage_project", { action: "current" });
      t.check(
        "the agent's next call, on its old session, is answered",
        again.status === 200 && !again.isError,
        projectAnswer(again),
      );
      const listed = await t.d
        .waitFor(
          `(() => { const ul = document.querySelector('ul[aria-label="Agents that have connected"]'); return ul ? ul.innerText.replace(/\\s+/g, ' ') : null; })()`,
          5_000,
        )
        .catch(() => null);
      t.note(
        `after the switch, before it says hello again, the panel lists: ${listed ?? "nobody"}`,
      );
      await a.initialize();
      const named = await t.d
        .waitFor(programLine(`${agentA.title} ${agentA.version}`), 5_000)
        .catch(() => null);
      t.check("once it says hello again the panel names it", !!named, named ?? "not listed");
      await closePanel(t.d);
    },
  },
  {
    name: "switch-remembered",
    what: "The person turns the server off and quits; at the next start it stays off until they turn it on",
    async run(t) {
      await openPanelFromHelp(t.d);
      await t.d.clickText("Turn off MCP server", { sel: "button[role=switch]" });
      portChanged();
      await panelUntil(t.d, (s) => s.includes("MCP server is off"), 10_000, "off");
      await closePanel(t.d);
      const t0 = performance.now();
      t.check("File > Exit ends the app", await t.app.quit(), `pid ${t.app.pid}`);
      t.time("app: File > Exit to the process gone", performance.now() - t0);
      const boot = await t.app.launch("after switching off");
      t.time("app: start again to the menu (dev build, warm page)", boot.ms);
      t.note(`the copy that quit kept its web view for ${boot.lingeredMs} ms after it ended`);
      await sleep(3000); // longer than a boot start takes to bind when it does
      const holder = portHolder();
      t.check("the app did not open the door", holder !== t.app.pid, `holder ${holder}`);
      await openPanelFromHelp(t.d);
      const text = await panelUntil(t.d, (s) => s.includes("MCP server is"), 5_000, "a state");
      t.check("the panel says it is off", text.includes("MCP server is off"), text.slice(0, 160));
      t.check(
        "the switch offers to turn it on",
        await t.d.hasText("Turn on MCP server", "button[role=switch]"),
      );
      await t.d.clickText("Turn on MCP server", { sel: "button[role=switch]" });
      await panelUntil(t.d, (s) => s.includes("MCP server is on"), 15_000, "on");
      await waitDoor(10_000);
      const v = verifyPort(t.app);
      t.check("turned on, the port is this app's", v.ours, `holder ${v.holder}`);
      await closePanel(t.d);
    },
  },
  {
    name: "agent-across-restart",
    what: "An agent stays connected while the person restarts the app; its next call is answered, and once it says hello again the panel names it (hub journey 3)",
    async run(t) {
      const b = mcpClient({ ...agentB, guard: () => portVerifiedFor === t.app.pid });
      const init = await b.initialize();
      t.check("the agent connects", init.status === 200 && !!b.session, `HTTP ${init.status}`);
      await b.listTools();
      const used = await b.call("manage_project", { action: "list" });
      t.check("it lists the projects", used.status === 200 && !used.isError, projectAnswer(used));
      const session = b.session;
      portChanged();
      const oldPid = t.app.pid;
      t.check("File > Exit ends the app", await t.app.quit());
      t.note(
        `web view processes of the copy that quit, still running at the relaunch: ${JSON.stringify(webviewProcesses(oldPid))}`,
      );
      await t.app.launch("restart with an agent connected");
      // Timed from the new copy's start (the launch first waits for the old copy's web view to go).
      const t0 = t.app.startedAt;
      const doorMs = await waitDoor(20_000);
      t.check("the door opens again by itself", doorMs !== null);
      t.time("mcp: restart to the door open (dev build, warm page)", performance.now() - t0);
      const v = verifyPort(t.app);
      t.check("the port is this app's", v.ours, `holder ${v.holder}`);
      t.note(
        `after the restart: page ${(await t.app.pageAlive()) ? "alive" : "GONE"}, web view processes ${JSON.stringify(webviewProcesses(t.app.pid))}`,
      );
      b.session = session;
      const after = await b.call("manage_project", { action: "current" });
      if (after.timedOut)
        t.note(
          `the call got no answer: page ${(await t.app.pageAlive()) ? "alive" : "GONE"}, web view processes ${JSON.stringify(webviewProcesses(t.app.pid))}`,
        );
      t.check(
        "its next call, on the session it had, is answered",
        after.status === 200 && !after.isError,
        projectAnswer(after),
      );
      await openPanelFromHelp(t.d);
      const before = await t.d.eval(
        `(() => { const ul = document.querySelector('ul[aria-label="Agents that have connected"]'); return ul ? ul.innerText.replace(/\\s+/g, ' ') : null; })()`,
      );
      t.note(
        `before it says hello again the panel lists: ${before ?? "nobody"} (a known limit: the app forgets what a session announced when it restarts)`,
      );
      await b.initialize();
      const named = await t.d
        .waitFor(programLine(`${agentB.title} ${agentB.version}`), 5_000)
        .catch(() => null);
      t.check(
        "once it says hello again the panel names it, not 'An agent'",
        !!named && !named.startsWith("An agent"),
        named ?? "not listed",
      );
      const fresh = await b.call("manage_project", { action: "current" });
      t.check("and its calls are answered", fresh.status === 200 && !fresh.isError);
      await closePanel(t.d);
    },
  },
  {
    name: "port-taken-by-another-program",
    what: "Another program holds port 19787 when the app starts: the panel says who holds it and what to do; once it is closed the switch brings the door back",
    async run(t) {
      portChanged();
      t.check("File > Exit ends the app", await t.app.quit());
      const held = await holdPort();
      try {
        t.check(
          "the test's own listener holds the port",
          portHolder() === process.pid,
          `holder ${portHolder()}, test pid ${process.pid}`,
        );
        await t.app.launch("with the port taken");
        const t0 = t.app.startedAt;
        await openPanelFromHelp(t.d);
        const text = await panelUntil(
          t.d,
          (s) => s.includes("It last failed with"),
          30_000,
          "why it failed",
        );
        t.time("mcp: launch to the taken-port message", performance.now() - t0);
        t.check("the panel says it is off", text.includes("MCP server is off"), text.slice(0, 200));
        t.check(
          "it says the port is in use by another program",
          /Port 19787 is in use by another program/.test(text),
          text.match(/It last failed with:[^.]*\./)?.[0],
        );
        t.check("it says what to do", text.includes("Close it and switch this back on."));
        t.check("the other program keeps the port", portHolder() === process.pid);
      } finally {
        await held.close();
      }
      const t1 = performance.now();
      await t.d.clickText("Turn on MCP server", { sel: "button[role=switch]" });
      await panelUntil(t.d, (s) => s.includes("MCP server is on"), 15_000, "on");
      t.time("mcp: switch on after the port was freed", performance.now() - t1);
      await waitDoor(10_000);
      const v = verifyPort(t.app);
      t.check("the port is this app's", v.ours, `holder ${v.holder}`);
      const c = mcpClient({
        name: "codex-mcp-client",
        version: "0.46.0",
        guard: () => portVerifiedFor === t.app.pid,
      });
      const init = await c.initialize();
      t.check("an agent can connect", init.status === 200, `HTTP ${init.status}`);
      await closePanel(t.d);
    },
  },
  {
    name: "port-freed-while-starting",
    what: "The copy of the app being replaced still holds the port for a few seconds (a restart, an update): the new copy waits and takes it, with nothing for the person to do",
    async run(t) {
      portChanged();
      t.check("File > Exit ends the app", await t.app.quit());
      const held = await holdPort();
      let released = false;
      try {
        await t.app.launch("while the old copy closes");
        const t0 = t.app.startedAt;
        await openPanelFromHelp(t.d);
        const first = squash(await t.d.eval(PANEL));
        t.note(
          `${Math.round(performance.now() - t0)} ms after the spawn the panel says: ${first.match(/MCP server is \w+/)?.[0] ?? "no state"}`,
        );
        if (first.includes("MCP server is starting")) {
          t.check(
            "while it waits it says why",
            first.includes(`old copy can take a few seconds to let go of port ${MCP_PORT}`),
            first.slice(0, 300),
          );
        } else
          t.note(
            "the wait had ended before the panel could be opened, so the 'starting' words were not seen",
          );
        await held.close();
        released = true;
        const t1 = performance.now();
        const text = await panelUntil(
          t.d,
          (s) => s.includes("MCP server is on") || s.includes("It last failed with"),
          15_000,
          "on or failed",
        );
        const startedAlone = text.includes("MCP server is on");
        t.check(
          "the app took the port by itself once it was free",
          startedAlone,
          text.slice(0, 200),
        );
        if (startedAlone)
          t.time("mcp: port freed to the server on, without a click", performance.now() - t1);
        if (!startedAlone) {
          t.note(
            "the start gave up before the port was freed: switched on by hand to leave the app as the next run expects",
          );
          await t.d.clickText("Turn on MCP server", { sel: "button[role=switch]" });
          await panelUntil(t.d, (s) => s.includes("MCP server is on"), 15_000, "on");
        }
      } finally {
        if (!released) await held.close();
      }
      await waitDoor(10_000);
      const v = verifyPort(t.app);
      t.check("the port is this app's", v.ours, `holder ${v.holder}`);
      await closePanel(t.d);
    },
  },
];

// ---------------------------------------------------------------------------------------------------------------

function context(s, app, state) {
  const result = { name: s.name, what: s.what, checks: [], times: [], notes: [] };
  return {
    result,
    app,
    state,
    get d() {
      return app.d;
    },
    check(label, ok, detail = "") {
      result.checks.push({ label, ok: !!ok, detail: String(detail ?? "") });
      console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail !== "" ? ` — ${detail}` : ""}`);
      return !!ok;
    },
    /** A check that fails today because the app is wrong: the run stays green, and the mark shows the day it is fixed. */
    knownBug(title, label, ok, detail = "") {
      result.checks.push({ label, ok: !!ok, detail: String(detail ?? ""), knownBug: title });
      console.log(
        `  ${ok ? "PASS (known bug fixed? remove the mark)" : "xfail"} ${label}${detail ? ` — ${detail}` : ""} [${title}]`,
      );
      return !!ok;
    },
    time(name, ms) {
      result.times.push({ name, ms: Math.round(ms) });
      record(name, ms);
    },
    note(text) {
      result.notes.push(text);
      console.log(`  note ${text}`);
    },
  };
}

async function main() {
  const modelVars = Object.keys(process.env).filter((k) => /AZURE|GOOGLE|OPENAI|VERTEX/i.test(k));
  if (modelVars.length)
    throw new Error(`refusing to run with model variables set: ${modelVars.join(", ")}`);
  if (process.platform !== "win32") throw new Error("this lane drives the Windows app");

  const others = artdaddyProcesses();
  report.othersAtStart = others;
  const holderAtStart = portHolder();
  report.portHolderAtStart = holderAtStart;
  if (holderAtStart !== null)
    throw new Error(
      `port ${MCP_PORT} is held by pid ${holderAtStart} (${processCommandLine(holderAtStart).slice(0, 160)}): this lane runs nothing while another program holds it`,
    );

  const linkBefore = signInLinkTarget();
  const linkKeyBefore = linkKeyExists();
  const shell = buildShell(path.join(runDir, "cargo.log"));
  const status = git("status", "--short").split(/\r?\n/).filter(Boolean);
  report.build = {
    worktree: root,
    head: git("rev-parse", "HEAD"),
    clean: status.length === 0,
    status,
    appSourceChanged: status.some((line) => !/(e2e\/|reports\/)/.test(line.replaceAll("\\", "/"))),
    identifier: IDENTIFIER,
    windowTitle: WINDOW_TITLE,
    exe: shell.exe,
    exeBuiltAt: shell.builtAt,
    shellBuildMs: shell.ms,
  };

  const standIn = await startStandIn();
  const page = await startPage(standIn.url);
  const app = new App(runDir);
  const state = {};
  try {
    if (portHolder() !== null)
      throw new Error(`port ${MCP_PORT} was taken while the shell was built: nothing run`);
    // The door's readiness is timed from the spawn, so the poll starts before the launch does.
    const t0 = performance.now();
    let doorAt = null;
    let polling = true;
    const poll = (async () => {
      while (polling && doorAt === null) {
        if ((await doorAnswers()) !== null) doorAt = performance.now();
        else await sleep(100);
      }
    })();
    const boot = await app.launch("first launch");
    const end = Date.now() + 30_000;
    while (doorAt === null && Date.now() < end) await sleep(100);
    polling = false;
    await poll;
    state.doorMs = doorAt === null ? null : doorAt - t0;
    report.build.version = await app.d.eval(
      "window.__TAURI_INTERNALS__.invoke('plugin:app|version')",
    );
    report.build.identifierReported = await app.d.eval(
      "window.__TAURI_INTERNALS__.invoke('plugin:app|identifier')",
    );
    report.build.commandLine = processCommandLine(app.pid);
    if (report.build.identifierReported !== IDENTIFIER)
      throw new Error(
        `the app reports ${report.build.identifierReported}, not ${IDENTIFIER}: stale or foreign build`,
      );
    console.log(
      `build ${report.build.head.slice(0, 10)}${report.build.clean ? "" : report.build.appSourceChanged ? " (app source changed!)" : " (only test files are new)"} · v${report.build.version} · ${shell.exe}`,
    );
    console.log(`app up in ${boot.ms} ms (pid ${app.pid}); run folder ${runDir}`);

    const wanted = filter
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean);
    for (const s of scenarios) {
      if (wanted.length && !wanted.some((f) => s.name.includes(f))) continue;
      const t = context(s, app, state);
      console.log(`\n▶ ${s.name}: ${s.what}`);
      const began = performance.now();
      try {
        if (!app.running()) {
          await app.launch(`before ${s.name}`);
          await waitDoor(20_000);
        } else if (!(await t.app.pageAlive())) {
          // The process is up but its page is gone (a blank window): what an earlier scenario left. Said, then started anew.
          t.check(
            "the app's window still has its page when the scenario starts",
            false,
            `web view processes: ${JSON.stringify(webviewProcesses(app.pid))}`,
          );
          portChanged();
          app.kill();
          await sleep(2000);
          await app.launch(`after a lost page, before ${s.name}`);
          await waitDoor(20_000);
        }
        t.result.webviewAtStart = webviewProcesses(app.pid);
        if (s.name !== "door-opens-at-launch") {
          await ensureServerOn(app.d);
          await waitDoor(10_000);
        }
        if (s.name !== "door-opens-at-launch" && portVerifiedFor !== app.pid) {
          const v = verifyPort(app);
          if (!v.ours && !s.name.startsWith("port-") && s.name !== "switch-remembered") {
            t.result.notRun = `port ${MCP_PORT} is held by ${v.holder ?? "nobody"}, not this run's app (pid ${app.pid})`;
          }
        }
        if (!t.result.notRun) await s.run(t);
      } catch (e) {
        t.result.error = String(e?.stack ?? e);
        console.log(`  threw: ${String(e?.message ?? e).split("\n")[0]}`);
        if (e instanceof NotOurPort) t.result.notRun = e.message;
        t.result.atError = {
          appRunning: app.running(),
          pageAlive: await app.pageAlive(),
          webview: webviewProcesses(app.pid),
        };
        console.log(`  at the error: ${JSON.stringify(t.result.atError)}`);
        await app.d?.screenshot(path.join(runDir, `${s.name}-error.png`)).catch(() => {});
      }
      t.result.ms = Math.round(performance.now() - began);
      t.result.status = t.result.notRun
        ? "not run"
        : t.result.error || t.result.checks.some((c) => !c.ok && !c.knownBug)
          ? "fail"
          : t.result.checks.some((c) => !c.ok && c.knownBug)
            ? "expected failure"
            : "pass";
      report.scenarios.push(t.result);
      console.log(`  ${t.result.status.toUpperCase()} (${(t.result.ms / 1000).toFixed(1)} s)`);
    }
  } finally {
    portChanged();
    await app.stop();
    report.launches = app.launches;
    await page.close();
    standIn.close();
    report.standIn = standIn.lines().map((l) => l.replace(/^\S+ /, ""));
    report.paidRoutesCalled = report.standIn.filter((l) => /\s\/ai\//.test(l));
    if (!linkKeyBefore && linkKeyExists()) removeLinkKey();
    report.signInLink = { before: linkBefore, after: signInLinkTarget() };
    report.portHolderAtEnd = portHolder();
  }
}

let failed = false;
try {
  await main();
} catch (e) {
  report.error = String(e?.stack ?? e);
  console.error(`\nrun failed: ${String(e?.message ?? e)}`);
  failed = true;
}
report.ended = new Date().toISOString();
writeFileSync(path.join(runDir, "report.json"), JSON.stringify(report, null, 2));
const counts = {};
for (const s of report.scenarios) counts[s.status] = (counts[s.status] ?? 0) + 1;
console.log(
  `\n${
    Object.entries(counts)
      .map(([k, v]) => `${v} ${k}`)
      .join(", ") || "no scenarios ran"
  }`,
);
console.log(`report: ${path.join(runDir, "report.json")}`);
if (report.paidRoutesCalled?.length) {
  console.error(`a paid route was asked for: ${report.paidRoutesCalled.join("; ")}`);
  failed = true;
}
if (report.signInLink && report.signInLink.before !== report.signInLink.after) {
  console.error(
    `the artdaddy:// link changed during the run: ${report.signInLink.before} -> ${report.signInLink.after}`,
  );
  failed = true;
}
process.exit(failed || report.scenarios.some((s) => s.status === "fail") ? 1 : 0);
