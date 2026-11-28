# MCP: the real app's door, the way a person and an outside agent use it

`run.mjs` drives the real app (built from this worktree under its own identity, `com.artdaddy.qa.mcp`, with the window
titled "ArtDaddy QA (test): MCP lane") and an outside agent speaking MCP to it on `127.0.0.1:19787`, and judges what the
person sees in Help > Connect an AI Agent (MCP)…, what Windows says about the port, and what the agent is answered.

```
python <wiki>/scripts/dispatch.py slot real-app --item <item> -- node --experimental-websocket e2e/desktop/mcp/run.mjs [filter]
```

| Scenario | What a person does | Checked on |
| --- | --- | --- |
| `door-opens-at-launch` | starts the app | the port belongs to the app's process; the time to the door |
| `panel-says-on` | opens the panel from Help, and from the start screen's link | the words: on, the address, only this machine, nobody yet |
| `agent-connects` | connects an agent (as Claude Code), which lists the tools and calls a free one | the panel's line for that program at each step |
| `cost-text` | (the agent reads what it is told) | the cost section of `initialize`, and each paid tool's own description |
| `switch-off-and-on` | turns the server off, then on | the port let go and taken again; an agent refused, then carrying on |
| `switch-remembered` | turns it off and quits; starts again | the app keeps it off until turned on |
| `agent-across-restart` | restarts the app with an agent connected (hub journey 3) | the old session answered; named again once it says hello |
| `port-taken-by-another-program` | starts the app while another program holds the port | the panel names the holder and what to do; the switch brings it back |
| `port-freed-while-starting` | restarts while the old copy still holds the port | the new copy takes it by itself |

Rules it keeps (the qa skill): it runs nothing if anything else holds port 19787 when it starts, and every MCP request
waits until Windows says the port belongs to this run's app. Only free tools are called (`manage_project` current and
list); the paid tools, the fetchers and a library delete are refused in `client.mjs`. The server is the shared stand-in
(`scripts/qa/standInServer.mjs`, 503 for everything but the build check, never 401 on a sign-in route), and the run
fails if any `/ai/` route was asked for. No project is created, opened or changed: the projects folder is the owner's,
and the logs say only whether a project id was set, never which.

Output: `reports/qa/mcp/run-<stamp>/report.json`. Waits go to the shared timing file (`e2e/lib/timing.mjs`).

The panel's words for the other ways a port can be lost (another copy of ArtDaddy, a port Windows reserved), the
setups' Copy and Install, and an agent talking to a signed-out app are the browser lane's: `e2e/ui/mcp/panel.spec.ts`.
