// A page driver for the export lane: real pointer and keyboard input into the running app over CDP.
// Built on scripts/cdp.mjs (the one CDP transport in this repository), with the target found on this lane's
// own debugging port, so it never attaches to another run's window.
import { writeFileSync } from "node:fs";

import { clickAt, connect, evaluate, pressKey } from "../../../scripts/cdp.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pageUrl(port) {
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error(`no page target on CDP port ${port}`);
  return page.webSocketDebuggerUrl;
}

/** Connect to the app's page once its debugging port answers. `gone()` ends the wait early when the app
 *  process has already exited (a crash at start, a single-instance hand-over). */
export async function connectPage(port, ms = 60_000, gone = () => false) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    if (gone()) throw new Error("the app exited before its page could be reached");
    try {
      const events = [];
      let driver = null;
      const cdp = await connect(await pageUrl(port), (m) => {
        events.push(m);
        if (events.length > 500) events.splice(0, events.length - 500);
        driver?.onEvent?.(m);
      });
      await cdp.send("Runtime.enable").catch(() => {});
      await cdp.send("Page.enable").catch(() => {});
      driver = new Driver(cdp, events);
      return driver;
    } catch (e) {
      last = e;
      await sleep(300);
    }
  }
  throw new Error(`the app's page never answered on CDP port ${port}: ${last?.message ?? last}`);
}

/** JS: the centre of the smallest visible element among `sel` whose first line of text is `text`
 *  (or contains it when `exact` is false), scrolled into view. */
const FIND_BY_TEXT = `((text, sel, exact) => {
  const line = (e) => ((e.innerText ?? '').trim().split('\\n')[0] ?? '').trim();
  const hits = [...document.querySelectorAll(sel)]
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
    .filter((e) => exact ? line(e) === text || (e.getAttribute('aria-label') ?? '') === text
                         : line(e).includes(text) || (e.getAttribute('aria-label') ?? '').includes(text))
    .sort((a, b) => (a.innerText ?? '').length - (b.innerText ?? '').length);
  const e = hits[0];
  if (!e) return null;
  e.scrollIntoView({ block: 'center' });
  const r = e.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: !!e.disabled };
})`;

export class Driver {
  constructor(cdp, events) {
    this.cdp = cdp;
    this.events = events;
  }

  close() {
    this.cdp.close();
  }

  eval(expr) {
    return evaluate(this.cdp, expr);
  }

  /** Poll until `expr` is truthy and return its value. */
  async waitFor(expr, ms = 10_000, every = 120) {
    const end = Date.now() + ms;
    let last;
    for (;;) {
      try {
        const v = await this.eval(expr);
        if (v) return v;
      } catch (e) {
        last = e;
      }
      if (Date.now() > end)
        throw new Error(`timed out after ${ms} ms waiting for: ${expr.slice(0, 160)}${last ? ` (${last.message})` : ""}`);
      await sleep(every);
    }
  }

  async clickAtPoint(x, y) {
    await clickAt(this.cdp, x, y, 1, 0);
    await sleep(80);
  }

  async click(selector) {
    const c = await this.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)});
      if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!c) throw new Error(`click: nothing matches ${selector}`);
    await this.clickAtPoint(c.x, c.y);
  }

  /** Click the element whose visible text (or accessible name) is `text`. */
  async clickText(text, { sel = "button,[role=menuitem],a,label,li,summary", exact = true, ms = 8000 } = {}) {
    const c = await this.waitFor(`${FIND_BY_TEXT}(${JSON.stringify(text)}, ${JSON.stringify(sel)}, ${exact})`, ms);
    if (c.disabled) throw new Error(`clickText: "${text}" is disabled`);
    await this.clickAtPoint(c.x, c.y);
  }

  /** Is there a visible element with this text? */
  hasText(text, sel = "button,[role=menuitem],a,label,li,summary", exact = true) {
    return this.eval(`!!${FIND_BY_TEXT}(${JSON.stringify(text)}, ${JSON.stringify(sel)}, ${exact})`);
  }

  async key(combo) {
    await pressKey(this.cdp, combo);
    await sleep(80);
  }

  async type(text) {
    await this.cdp.send("Input.insertText", { text });
    await sleep(60);
  }

  /** Choose an option of a <select> the way a person does: focus it, then pick with the keyboard is not
   *  portable across engines, so the value is set and the change event the app listens to is fired. */
  async select(selector, value) {
    const ok = await this.eval(`(() => { const s = document.querySelector(${JSON.stringify(selector)});
      if (!s) return 'missing'; const want = ${JSON.stringify(value)};
      if (![...s.options].some((o) => o.value === want)) return 'no option ' + want + ' in ' + [...s.options].map((o) => o.value).join(',');
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      set.call(s, want); s.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
    if (ok !== "ok") throw new Error(`select ${selector}: ${ok}`);
    await sleep(120);
  }

  /** Hand files to a hidden <input type=file>: the native Import dialog cannot be driven from CDP, and the
   *  same code path runs from the input's change event. */
  async setFiles(selector, files) {
    await this.cdp.send("DOM.enable").catch(() => {});
    const { result } = await this.cdp.send("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
    });
    if (!result?.objectId) throw new Error(`setFiles: no input for ${selector}`);
    await this.cdp.send("DOM.setFileInputFiles", { files, objectId: result.objectId });
    await sleep(200);
  }

  async screenshot(file) {
    const { data } = await this.cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(file, Buffer.from(data, "base64"));
  }
}
