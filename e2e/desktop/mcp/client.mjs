// An outside agent, as the app sees one: a program speaking MCP (JSON-RPC over HTTP) to the app's door on port 19787,
// announcing itself by name and version the way Claude Code, Cursor or Codex do.
//
// Only free, local tools: `call` refuses anything that spends money or reaches out (the paid tools, the two internet
// fetchers, a library delete), whatever a scenario asks. And no request leaves before `guard()` says the port belongs
// to this run's own app (qa rule 7: whoever holds 19787 receives the call, and the owner's app would act on his real
// project).
export const MCP_URL = "http://127.0.0.1:19787/mcp";

const REFUSED =
  /^(generate_|video_ask$|video_find_moment$|web_search$|download_video$|get_page_image$)/;

export class NotOurPort extends Error {}

/** How long an outside agent waits for one answer here. The app's own bound is 10 minutes; Copilot gives up at 3; a
 *  free call to a live app answers in well under a second, so a minute only ever expires on a door nobody answers. */
export const ANSWER_MS = 60_000;

export function mcpClient({ name, version, guard }) {
  let id = 0;
  let session = null;
  const info = { name, version };

  async function post(body) {
    if (!guard())
      throw new NotOurPort("the MCP port is not held by this run's app: no request sent");
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (session) headers["mcp-session-id"] = session;
    let res;
    try {
      res = await fetch(MCP_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(ANSWER_MS),
      });
    } catch (e) {
      if (e?.name === "TimeoutError")
        return {
          status: 0,
          json: null,
          timedOut: true,
          error: `no answer in ${ANSWER_MS / 1000} s`,
        };
      throw e;
    }
    session = res.headers.get("mcp-session-id") ?? session;
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { unparsed: text.slice(0, 400) };
    }
    return { status: res.status, json };
  }

  const rpc = (method, params = {}) => post({ jsonrpc: "2.0", id: ++id, method, params });

  return {
    info,
    get session() {
      return session;
    },
    /** Keep the session id the app gave this program (a client that outlives an app restart does). */
    set session(value) {
      session = value;
    },
    rpc,
    async initialize() {
      const out = await rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: info,
      });
      if (out.status === 200)
        await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      return out;
    },
    async listTools() {
      const out = await rpc("tools/list", {});
      return { ...out, tools: out.json?.result?.tools ?? [] };
    },
    async call(tool, args = {}) {
      if (REFUSED.test(tool) || (tool === "library_op" && args.action === "delete"))
        throw new Error(`refusing ${tool}: this lane calls only free, local tools`);
      const out = await rpc("tools/call", { name: tool, arguments: args });
      const result = out.json?.result;
      const text = result?.content?.find?.((c) => c.type === "text")?.text ?? out.error ?? "";
      let payload = text;
      try {
        payload = JSON.parse(text);
      } catch {
        /* a plain-text reply */
      }
      return { ...out, isError: result?.isError === true, text, payload };
    },
  };
}

/** Does anything answer on the door at all? A GET is declined with 405 by the app (it serves no event stream), so it
 *  shows the door is open without starting a session or calling anything. */
export async function doorAnswers() {
  try {
    const res = await fetch(MCP_URL, { method: "GET", signal: AbortSignal.timeout(2000) });
    await res.text().catch(() => "");
    return res.status;
  } catch {
    return null;
  }
}
