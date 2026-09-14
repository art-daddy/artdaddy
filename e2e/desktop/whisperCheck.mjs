// End-to-end proof that whisper actually runs inside the app: drive the real MCP server and
// transcribe a real file. The unit tests can only assert the cwd ARGUMENT; only this can tell
// "spawned correctly" from "died at 0xC0000135 before executing an instruction".
const PORT = 19787;
const BASE = `http://127.0.0.1:${PORT}/mcp`;
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
    return { raw: text.slice(0, 400) };
  }
}

async function call(name, args) {
  const r = await rpc("tools/call", { name, arguments: args });
  const t = r?.result?.content?.[0]?.text ?? JSON.stringify(r).slice(0, 400);
  try {
    return { isError: !!r?.result?.isError, json: JSON.parse(t) };
  } catch {
    return { isError: !!r?.result?.isError, json: t };
  }
}

const deadline = Date.now() + 90_000;
for (;;) {
  try {
    await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "whisper-check", version: "1" },
    });
    break;
  } catch {
    if (Date.now() > deadline) throw new Error("MCP server never came up");
    await new Promise((r) => setTimeout(r, 1500));
  }
}

const proj = await call("manage_project", { action: "create", name: `whisper${Date.now() % 100000}` });
console.log("project:", JSON.stringify(proj.json).slice(0, 160));
await new Promise((r) => setTimeout(r, 2500));

// Any short video with speech. Point ARTDADDY_SAMPLE_MEDIA at your own; a hardcoded home
// directory only ever worked on one machine.
const MEDIA = process.env.ARTDADDY_SAMPLE_MEDIA;
if (!MEDIA) {
  console.error("set ARTDADDY_SAMPLE_MEDIA to a short video with speech, e.g.");
  console.error('  $env:ARTDADDY_SAMPLE_MEDIA = "C:/media/sample-16x9.mp4"');
  process.exit(2);
}
const imp = await call("import_media", { source: { path: MEDIA } });
console.log("import:", JSON.stringify(imp.json).slice(0, 200));

const ref = imp.json?.media_ref ?? imp.json?.imported?.[0]?.media_ref;
console.log("media_ref:", ref);
if (!ref) {
  console.log("RESULT: could not import the test media");
  process.exit(1);
}

// get_transcript works on TIMELINE clips (project frames), not raw library refs, so place it.
const added = await call("add_clips", {
  entries: [{ media_ref: ref, track_id: "v1", timeline_in: 0, source_span: [0, 8] }],
});
console.log("add_clips:", JSON.stringify(added.json).slice(0, 200));

console.log("running get_transcript (this shells out to whisper-cli)...");
const t0 = Date.now();
const tr = await call("get_transcript", {});
const secs = ((Date.now() - t0) / 1000).toFixed(1);

const words = tr.json?.clips?.[0]?.words ?? null;
const count = tr.json?.word_count ?? (Array.isArray(words) ? words.length : 0);
console.log(`\nisError=${tr.isError}  elapsed=${secs}s`);
console.log("payload:", JSON.stringify(tr.json).slice(0, 600));

if (tr.isError) {
  console.log("\nRESULT: FAILED —", JSON.stringify(tr.json).slice(0, 300));
  process.exit(1);
}
console.log(`\nRESULT: ${count > 0 ? "PASS" : "NO WORDS"} — word_count=${count}`);
process.exit(count > 0 ? 0 : 1);
