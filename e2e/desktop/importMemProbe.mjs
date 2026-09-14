// Reproduce the large-file import OOM and MEASURE it, rather than reasoning about the code.
// Deliberately uses a mid-size file: if the amplification is what the symptom suggests, a 1 GB
// input would take the machine down again.
const PORT = 19787;
const BASE = `http://127.0.0.1:${PORT}/mcp`;
const MEDIA = process.argv[2];
if (!MEDIA) throw new Error("usage: node importMemProbe.mjs <absolute path>");

let id = 0;
let session = "";
async function rpc(method, params) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (session) headers["mcp-session-id"] = session;
  const res = await fetch(BASE, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) session = sid;
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 300) };
  }
}
async function call(name, args) {
  const r = await rpc("tools/call", { name, arguments: args });
  const t = r?.result?.content?.[0]?.text ?? "";
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "mem-probe", version: "1" },
});
const proj = await call("manage_project", { action: "create", name: `mem${Date.now() % 100000}` });
console.log("project:", JSON.stringify(proj).slice(0, 120));
await new Promise((r) => setTimeout(r, 2500));

console.log(`importing ${MEDIA} by PATH (source.path -> importFromPath)…`);
const t0 = Date.now();
const out = await call("import_media", { source: { path: MEDIA } });
console.log(`elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log("result:", JSON.stringify(out).slice(0, 300));
