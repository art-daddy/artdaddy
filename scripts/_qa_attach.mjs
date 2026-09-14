// QA: attach files to the CHAT composer input while capturing console + exceptions.
//
// Clicking 📎 opens a NATIVE file dialog that blocks the WebView and hangs CDP, so
// the files are set on the input directly — the same change handler still runs.
//
// usage: node --experimental-websocket scripts/_qa_attach.mjs <file> [file...]
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
          `console.${msg.params.type}: ` +
            msg.params.args
              .map((a) => a.value ?? a.description ?? a.type)
              .join(" ")
              .slice(0, 400),
        );
      } else if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails;
        events.push(`EXCEPTION: ${d.exception?.description ?? d.text}`.slice(0, 700));
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

const files = process.argv.slice(2);
if (files.length === 0) throw new Error("no files given");

await cdp.send("Runtime.enable");
await cdp.send("DOM.enable");
const { root } = await cdp.send("DOM.getDocument", { depth: -1 });

// The composer's input is the one sharing the 📎 button's parent row.
const mark = await cdp.send("Runtime.evaluate", {
  expression: `(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /Attach images/.test(b.title || ''));
    if (!btn) return 'no attach button';
    const inp = btn.parentElement.querySelector('input[type=file]');
    if (!inp) return 'no sibling input';
    document.querySelectorAll('[data-qa-chat-file]').forEach(e => e.removeAttribute('data-qa-chat-file'));
    inp.setAttribute('data-qa-chat-file','1');
    return 'marked sibling of attach button';
  })()`,
  returnByValue: true,
});
console.log("locate:", mark.result?.value);

const { nodeId } = await cdp.send("DOM.querySelector", {
  nodeId: root.nodeId,
  selector: "input[data-qa-chat-file]",
});
if (!nodeId) throw new Error("chat file input not found");

await cdp.send("DOM.setFileInputFiles", { files, nodeId });
console.log("set files:", files.join(", "));

await new Promise((r) => setTimeout(r, 6000));

const chips = await cdp.send("Runtime.evaluate", {
  expression: `document.querySelectorAll('[aria-label="remove attachment"]').length`,
  returnByValue: true,
});
console.log("chips:", chips.result?.value);
console.log("--- page events ---");
for (const e of events) console.log(e);
cdp.close();
