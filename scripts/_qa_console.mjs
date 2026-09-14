// Watch the page console for a window, printing shell/ffmpeg related messages.
// usage: node --experimental-websocket scripts/_qa_console.mjs [seconds] [reload]
const PORT = process.env.CDP_PORT ?? "9222";
const BASE = `http://127.0.0.1:${PORT}`;

const targets = await fetch(`${BASE}/json`).then((r) => r.json());
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("no page target");

const events = [];
const cdp = await new Promise((resolve, reject) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (!msg.id) {
      if (msg.method === "Runtime.consoleAPICalled") {
        events.push(
          `${msg.params.type}: ` +
            msg.params.args
              .map((a) => a.value ?? a.description ?? a.type)
              .join(" ")
              .slice(0, 400),
        );
      } else if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails;
        events.push(`EXCEPTION: ${d.exception?.description ?? d.text}`.slice(0, 500));
      }
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
  };
  ws.onerror = () => reject(new Error("cannot connect"));
  ws.onopen = () =>
    resolve({
      send(method, params = {}) {
        id += 1;
        const mid = id;
        return new Promise((res, rej) => {
          pending.set(mid, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      },
      close: () => ws.close(),
    });
});

const seconds = Number(process.argv[2] ?? 20);
await cdp.send("Runtime.enable");
if (process.argv[3] === "reload") {
  await cdp.send("Page.enable").catch(() => {});
  await cdp.send("Page.reload", { ignoreCache: true });
}
await new Promise((r) => setTimeout(r, seconds * 1000));

const interesting = events.filter((e) => /spawn|ffmpeg|ffprobe|shell|proxy|poster|not allowed/i.test(e));
console.log(`captured ${events.length} messages, ${interesting.length} shell/media related:`);
for (const e of interesting) console.log("  " + e);
const denied = interesting.filter((e) => /not allowed/i.test(e));
console.log(denied.length ? `\nSTILL DENIED: ${denied.length}` : "\nNO PERMISSION DENIALS");
cdp.close();
