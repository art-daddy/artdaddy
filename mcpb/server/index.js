// stdio -> HTTP shim, so Claude Desktop can talk to the MCP server inside ArtDaddy.
//
// Claude Desktop only speaks stdio to a child process. Our server is HTTP on loopback, and it
// only exists while the app is running. This bridges the two: JSON-RPC lines in on stdin, HTTP
// POST out, replies back on stdout.
//
// The app is a normal desktop program, so it will be closed and reopened under a running Claude.
// That means every failure here is EXPECTED at some point, and the shim must survive it rather
// than exit: a dead shim shows up in Claude as a broken connector the user has to reinstall.
// The port is fixed in the app; the override exists so the unreachable-app path can be tested
// against a dead port without closing the editor.
const ENDPOINT = process.env.ARTDADDY_MCP_URL || "http://127.0.0.1:19787/mcp";
const PROTOCOL = "2025-06-18";

let sessionId = null;
let initializeParams = null; // replayed when the app restarts and the session is gone

const log = (...a) => console.error("[artdaddy-shim]", ...a);
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

function headers() {
  const h = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": PROTOCOL,
  };
  if (sessionId) h["Mcp-Session-Id"] = sessionId;
  return h;
}

/** Server-sent events arrive as `data:` lines in blank-line-separated blocks. */
async function readSSE(body, onMessage) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        onMessage(JSON.parse(data));
      } catch {
        /* priming/comment events carry no JSON */
      }
    }
  }
}

/** POST one message. `err.delivered` means a reply already reached the client, so the request
 *  MUST NOT be replayed — it may have already edited the user's timeline. */
async function post(message, onMessage) {
  let delivered = false;
  const deliver = (m) => {
    delivered = true;
    onMessage(m);
  };
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(message),
    });
    if (res.status === 404) throw new Error("session expired");
    if (!res.ok && res.status !== 202) throw new Error(`HTTP ${res.status}`);
    const assigned = res.headers.get("mcp-session-id");
    if (assigned) sessionId = assigned;
    const type = (res.headers.get("content-type") || "").split(";")[0];
    if (type === "text/event-stream") await readSSE(res.body, deliver);
    else if (type === "application/json") deliver(await res.json());
  } catch (err) {
    err.delivered = delivered;
    throw err;
  }
}

/** Re-handshake after the app restarted. Returns false when it is simply not running. */
async function reestablish() {
  if (!initializeParams) return false;
  sessionId = null;
  try {
    await post({ jsonrpc: "2.0", id: "shim-init", method: "initialize", params: initializeParams }, () => {});
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, () => {});
    return true;
  } catch {
    return false;
  }
}

async function handle(msg) {
  if (msg.method === "initialize") initializeParams = msg.params;

  try {
    await post(msg, send);
  } catch (err) {
    // A reply already went out, so retrying could run the same edit twice.
    if (err.delivered) return;
    const recovered = !initializeParams || msg.method === "initialize" ? false : await reestablish();
    if (recovered) {
      try {
        await post(msg, send);
        return;
      } catch {
        /* fall through to the error below */
      }
    }
    if (msg.id !== undefined) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32603, message: `ArtDaddy is not reachable (${err.message}). Is the app running?` },
      });
    }
  }
}

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg).catch((e) => log("unhandled:", e.message));
  }
});
process.stdin.on("end", () => process.exit(0));
log("started; proxying stdio <-> " + ENDPOINT);
