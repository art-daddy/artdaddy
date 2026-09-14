// Dependency-free CDP driver for the Tauri desktop app.
//
// WHY THIS EXISTS: the shipped product is a WebView2 window, and neither the unit
// lane nor a normal browser automation tool can reach inside it. But WebView2 IS
// Edge, so launching the app with
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'
// exposes a standard CDP endpoint. That turns the REAL app — real Tauri IPC, real
// fs, real sidecar ffmpeg — into something scriptable, with no tauri-driver and no
// WebDriver install.
//
// Node 20 has no global WebSocket, hence the flag:
//   node --experimental-websocket scripts/cdp.mjs <command> [args]
//
// Commands:
//   eval <js>                 evaluate in the page, print the JSON result
//   wait <js> [timeoutMs]     poll until the expression is truthy
//   text [selector]           visible innerText (default: body)
//   shot <path>               PNG screenshot of the window
//   click <selector>          real mouse click at the element's centre
//   dblclick <selector>
//   hover <selector>
//   type <text>               insert text into the focused element
//   key <key>                 e.g. Enter, Escape, Control+z, Control+Shift+z
//   drag <selector> <dx> <dy> real press-move-release from the element's centre
//   dragxy <x1> <y1> <x2> <y2>
//   reload
import { pathToFileURL } from "node:url";

const PORT = process.env.CDP_PORT ?? "9222";
const BASE = `http://127.0.0.1:${PORT}`;

async function pageTarget() {
  const targets = await fetch(`${BASE}/json`).then((r) => r.json());
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page target — is the app running with --remote-debugging-port?");
  return page.webSocketDebuggerUrl;
}

function connect(url, onEvent) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let id = 0;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (!msg.id) {
        onEvent?.(msg); // unsolicited: Input.dragIntercepted, console, exceptions
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    };
    ws.onerror = () => reject(new Error(`cannot connect to ${url}`));
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
}

async function evaluate(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description ?? "eval threw");
  return r.result?.value;
}

/** Centre of an element in viewport coordinates, or null when it isn't there.
 *  Accepts a CSS selector, or `text=Foo` / `css|text=Foo` to match visible text
 *  (querySelector has no :has-text, and most of this UI is labelled, not id'd). */
async function centre(cdp, selector) {
  const m = /^(?:(.+?)\|)?text=(.+)$/s.exec(selector);
  const expr = m
    ? `(() => { const want = ${JSON.stringify(m[2].trim())};
        const els = Array.from(document.querySelectorAll(${JSON.stringify(m[1] ?? "button,[role=menuitem],a,[role=button],label,li")}));
        const el = els.find(e => (e.innerText ?? '').trim() === want)
                ?? els.find(e => (e.innerText ?? '').trim().includes(want));
        if (!el) return null; el.scrollIntoView({block:'center'});
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, h: r.height }; })()`
    : `(() => { const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null; el.scrollIntoView({block:'center'});
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, h: r.height }; })()`;
  return evaluate(cdp, expr);
}

async function mouse(cdp, type, x, y, extra = {}) {
  await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", ...extra });
}

/** CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
function modifierMask(name = "") {
  let m = 0;
  for (const part of name.split("+")) {
    if (/^alt$/i.test(part)) m |= 1;
    if (/^(ctrl|control)$/i.test(part)) m |= 2;
    if (/^(meta|cmd)$/i.test(part)) m |= 4;
    if (/^shift$/i.test(part)) m |= 8;
  }
  return m;
}

async function clickAt(cdp, x, y, clickCount = 1, modifiers = 0) {
  await mouse(cdp, "mouseMoved", x, y, { button: "none", modifiers });
  await mouse(cdp, "mousePressed", x, y, { clickCount, modifiers });
  await mouse(cdp, "mouseReleased", x, y, { clickCount, modifiers });
}

const VKEY = {
  Enter: [13, "Enter"],
  Escape: [27, "Escape"],
  Tab: [9, "Tab"],
  Backspace: [8, "Backspace"],
  Delete: [46, "Delete"],
  ArrowLeft: [37, "ArrowLeft"],
  ArrowRight: [39, "ArrowRight"],
  ArrowUp: [38, "ArrowUp"],
  ArrowDown: [40, "ArrowDown"],
  Space: [32, " "],
  Home: [36, "Home"],
  End: [35, "End"],
};

async function pressKey(cdp, combo) {
  const parts = combo.split("+");
  const name = parts.pop();
  let modifiers = 0;
  for (const m of parts) {
    if (/^alt$/i.test(m)) modifiers |= 1;
    if (/^(ctrl|control)$/i.test(m)) modifiers |= 2;
    if (/^(meta|cmd)$/i.test(m)) modifiers |= 4;
    if (/^shift$/i.test(m)) modifiers |= 8;
  }
  const known = VKEY[name];
  const [code, key] = known ?? [name.toUpperCase().charCodeAt(0), name];
  const base = {
    modifiers,
    key,
    code: known ? name : `Key${name.toUpperCase()}`,
    windowsVirtualKeyCode: code,
    nativeVirtualKeyCode: code,
  };
  // A plain character also needs `text`, or the page sees a keypress with no input.
  const text = !known && modifiers === 0 ? name : known && name === "Enter" ? "\r" : undefined;
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(text ? { text } : {}) });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const cdp = await connect(await pageTarget());
  await cdp.send("Runtime.enable").catch(() => {});
  const out = (v) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));

  try {
    switch (cmd) {
      case "eval":
        out(await evaluate(cdp, args.join(" ")));
        break;
      case "evalfile": {
        const { readFileSync } = await import("node:fs");
        out(await evaluate(cdp, readFileSync(args[0], "utf8")));
        break;
      }
      case "wait": {
        const expr = args[0];
        const timeout = Number(args[1] ?? 15000);
        const started = Date.now();
        for (;;) {
          const v = await evaluate(cdp, expr).catch(() => undefined);
          if (v) return out(v);
          if (Date.now() - started > timeout) throw new Error(`timed out waiting for: ${expr}`);
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      case "text":
        out(
          await evaluate(
            cdp,
            `(document.querySelector(${JSON.stringify(args[0] ?? "body")})?.innerText ?? "").slice(0, 6000)`,
          ),
        );
        break;
      case "shot": {
        const r = await cdp.send("Page.captureScreenshot", { format: "png" });
        const { writeFileSync } = await import("node:fs");
        writeFileSync(args[0], Buffer.from(r.data, "base64"));
        out(`wrote ${args[0]}`);
        break;
      }
      case "click":
      case "dblclick": {
        const c = await centre(cdp, args[0]);
        if (!c) throw new Error(`no element matches ${args[0]}`);
        await clickAt(cdp, c.x, c.y, cmd === "dblclick" ? 2 : 1);
        out(`clicked ${args[0]} at ${Math.round(c.x)},${Math.round(c.y)}`);
        break;
      }
      case "clickxy": {
        const [x, y] = args.map(Number);
        // clickxy <x> <y> [clickCount] [modifiers e.g. Shift or Ctrl+Shift]
        await clickAt(cdp, x, y, Number(args[2] ?? 1), modifierMask(args[3] ?? ""));
        out(`clicked ${x},${y}${args[3] ? ` with ${args[3]}` : ""}`);
        break;
      }
      case "hover": {
        const c = await centre(cdp, args[0]);
        if (!c) throw new Error(`no element matches ${args[0]}`);
        await mouse(cdp, "mouseMoved", c.x, c.y, { button: "none" });
        out(`hovered ${args[0]}`);
        break;
      }
      case "type":
        await cdp.send("Input.insertText", { text: args.join(" ") });
        out(`typed ${args.join(" ").length} chars`);
        break;
      case "key":
        await pressKey(cdp, args[0]);
        out(`pressed ${args[0]}`);
        break;
      case "drag": {
        const c = await centre(cdp, args[0]);
        if (!c) throw new Error(`no element matches ${args[0]}`);
        const tx = c.x + Number(args[1]);
        const ty = c.y + Number(args[2]);
        await mouse(cdp, "mouseMoved", c.x, c.y, { button: "none" });
        await mouse(cdp, "mousePressed", c.x, c.y);
        // Several intermediate moves: a single jump can miss handlers that need motion.
        for (let i = 1; i <= 8; i += 1) {
          await mouse(cdp, "mouseMoved", c.x + ((tx - c.x) * i) / 8, c.y + ((ty - c.y) * i) / 8);
        }
        await mouse(cdp, "mouseReleased", tx, ty);
        out(`dragged ${args[0]} by ${args[1]},${args[2]}`);
        break;
      }
      case "dragxy": {
        // dragxy <x1> <y1> <x2> <y2> [modifiers e.g. Alt or Ctrl+Shift]
        const [x1, y1, x2, y2] = args.slice(0, 4).map(Number);
        const modifiers = modifierMask(args[4] ?? "");
        await mouse(cdp, "mouseMoved", x1, y1, { button: "none", modifiers });
        await mouse(cdp, "mousePressed", x1, y1, { modifiers });
        for (let i = 1; i <= 8; i += 1) {
          await mouse(cdp, "mouseMoved", x1 + ((x2 - x1) * i) / 8, y1 + ((y2 - y1) * i) / 8, {
            modifiers,
          });
        }
        await mouse(cdp, "mouseReleased", x2, y2, { modifiers });
        out(`dragged ${x1},${y1} -> ${x2},${y2}${args[4] ? ` with ${args[4]}` : ""}`);
        break;
      }
      case "raw":
        out(await cdp.send(args[0], JSON.parse(args.slice(1).join(" ") || "{}")));
        break;
      case "reload":
        await cdp.send("Page.enable").catch(() => {});
        await cdp.send("Page.reload", { ignoreCache: true });
        out("reloaded");
        break;
      default:
        throw new Error(`unknown command: ${cmd}`);
    }
  } finally {
    cdp.close();
  }
}

// Also a LIBRARY: scripts/uisweep imports these so there is one CDP driver, not two.
export { centre, clickAt, connect, evaluate, modifierMask, mouse, pageTarget, pressKey };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(String(e.message ?? e));
    process.exit(1);
  });
}
