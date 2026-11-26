// A program talking to the app over MCP (Claude Desktop, Cursor, Copilot): the app's own server on port
// 19787, JSON-RPC over HTTP. The export lane uses it the way an outside assistant would, to ask for a second
// export while one runs. Only local tools: never a paid one (`generate_*`, `video_ask`, `video_find_moment`,
// `web_search`); `call` refuses them.
const URL_MCP = "http://127.0.0.1:19787/mcp";
const PAID = /^(generate_|video_ask$|video_find_moment$|web_search$)/;

export async function mcpClient() {
  let id = 0;
  let session = null;
  async function rpc(method, params) {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (session) headers["mcp-session-id"] = session;
    const res = await fetch(URL_MCP, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    session = res.headers.get("mcp-session-id") ?? session;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "qa-export", version: "1" } });
  return {
    async call(name, args = {}) {
      if (PAID.test(name)) throw new Error(`refusing a paid tool: ${name}`);
      const out = await rpc("tools/call", { name, arguments: args });
      const body = out?.result?.content?.[0]?.text ?? "";
      try {
        return JSON.parse(body);
      } catch {
        return { raw: body, error: out?.error };
      }
    },
  };
}
