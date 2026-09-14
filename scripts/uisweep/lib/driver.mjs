// Sweep driver: real pointer and keyboard input into the running desktop app.
//
// Built on scripts/cdp.mjs so there is ONE CDP driver in this repo, not two — a second
// copy of the input rules is the exact defect class this sweep exists to find.
import {
  clickAt,
  connect,
  evaluate,
  modifierMask,
  mouse,
  pageTarget,
  pressKey,
} from "../../cdp.mjs";

export async function open() {
  const events = [];
  const cdp = await connect(await pageTarget(), (m) => events.push(m));
  await cdp.send("DOM.enable").catch(() => {});
  await cdp.send("Runtime.enable").catch(() => {});
  return new Driver(cdp, events);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** JS that decides whether an element is really CLICKABLE at a given point.
 *
 *  `getBoundingClientRect()` answers "where would this be drawn", NOT "is it drawn there".
 *  A clip inside the timeline's horizontal scroller reports a rect even when it has been
 *  scrolled out of the visible box and is clipped away — the pixels at that point belong to
 *  whatever panel is next to the timeline. Input dispatched there lands on that panel, the
 *  gesture does nothing, and the scenario blames the app. Ask the DOM instead. */
const HIT_FN = `(e => { const r = e.getBoundingClientRect();
     const cx = r.x + r.width/2, cy = r.y + r.height/2;
     const t = document.elementFromPoint(cx, cy);
     return !!(t && (t === e || e.contains(t) || t.contains(e))); })`;

class Driver {
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

  /** Poll until `expr` is truthy; returns its value. Throws with the expression on timeout. */
  async waitFor(expr, ms = 8000) {
    const start = Date.now();
    for (;;) {
      const v = await this.eval(expr).catch(() => null);
      if (v) return v;
      if (Date.now() - start > ms) throw new Error(`timed out waiting for: ${expr}`);
      await sleep(120);
    }
  }

  /** Bounding rect of the first match, or null. `sel` is CSS. */
  rect(sel) {
    return this.eval(
      `(() => { const e = document.querySelector(${JSON.stringify(sel)});
        if (!e) return null; const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width/2, cy: r.y + r.height/2 }; })()`,
    );
  }

  /** Rect of the element whose visible text matches, among `sel` candidates.
   *  Matches the FIRST LINE (menu items carry their shortcut on a second line) and picks
   *  the SMALLEST match, so a container that merely contains the text can't win. */
  rectByText(text, sel = "button,[role=menuitem],a,label,li") {
    return this.eval(
      `(() => { const want = ${JSON.stringify(text)};
        const line = e => ((e.innerText ?? '').trim().split('\\n')[0] ?? '').trim();
        const hits = [...document.querySelectorAll(${JSON.stringify(sel)})]
          .filter(e => e.getBoundingClientRect().width > 0)
          .filter(e => line(e) === want || line(e).includes(want) || (e.innerText ?? '').includes(want))
          .sort((a, b) => (a.innerText ?? '').length - (b.innerText ?? '').length);
        const e = hits[0];
        if (!e) return null; e.scrollIntoView({block:'center'});
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width/2, cy: r.y + r.height/2 }; })()`,
    );
  }

  async click(sel, modifiers = "") {
    const r = await this.rect(sel);
    if (!r) throw new Error(`click: no element for ${sel}`);
    await clickAt(this.cdp, r.cx, r.cy, 1, modifierMask(modifiers));
    await sleep(80);
  }

  async clickText(text, sel) {
    const r = await this.rectByText(text, sel);
    if (!r) throw new Error(`clickText: nothing matching "${text}"`);
    await clickAt(this.cdp, r.cx, r.cy, 1, 0);
    await sleep(80);
  }

  /** Input outside the window is silently discarded, which turns a wrong coordinate into a
   *  passing-looking no-op. Refuse it loudly instead.
   *
   *  Only the window bound is checked here, because a bare point carries no intent: the
   *  same coordinates are a legitimate library click and an out-of-view timeline clip. The
   *  "is it really there" question is answered by the helpers that DERIVE points from an
   *  element (`handleOn`, `trimHandle`), which is where the intent exists. */
  async #inWindow(where, ...points) {
    const v = await this.viewport();
    for (const p of points) {
      if (p.x < 0 || p.y < 0 || p.x > v.w || p.y > v.h) {
        throw new Error(
          `${where}: (${p.x.toFixed(0)},${p.y.toFixed(0)}) is outside the ${v.w}x${v.h} window — ` +
            `the app would never see this input`,
        );
      }
    }
  }

  /** Put the timeline back to scroll 0.
   *
   *  Edge autoscroll during a drag leaves the timeline scrolled, and nothing scrolls it
   *  back. Every later scenario then measures clips that are scrolled out of view and
   *  aims at pixels owned by the neighbouring panel — which is how one drag scenario
   *  silently broke every scenario after it. */
  async resetScroll() {
    await this.eval(
      `(() => { const lane = document.querySelector('[data-track-id]');
         for (let n = lane; n; n = n.parentElement) if (n.scrollLeft) n.scrollLeft = 0;
         for (const e of document.querySelectorAll('*')) if (e.scrollLeft) e.scrollLeft = 0;
         return true; })()`,
    );
    await sleep(120);
  }

  /** Left edge of the timeline scroll container, or null when it isn't mounted. */
  timelineLeftEdge() {
    return this.eval(
      `(() => { const e = document.querySelector('[data-track-id]');
         if (!e) return null; return e.getBoundingClientRect().x; })()`,
    );
  }

  async clickAtPoint(x, y, modifiers = "") {
    await this.#inWindow("clickAtPoint", { x, y });
    await clickAt(this.cdp, x, y, 1, modifierMask(modifiers));
    await sleep(80);
  }

  async key(combo) {
    await pressKey(this.cdp, combo);
    await sleep(80);
  }

  async type(text) {
    await this.cdp.send("Input.insertText", { text });
    await sleep(60);
  }

  /** Press-move-release with real mouse events. Intermediate steps matter: a single jump
   *  can skip the pointermove a gesture needs to arm itself. */
  async drag(from, to, { modifiers = "", steps = 8, holdMs = 40 } = {}) {
    await this.#inWindow("drag", from, to);
    const mods = modifierMask(modifiers);
    await mouse(this.cdp, "mouseMoved", from.x, from.y, { button: "none", modifiers: mods });
    await mouse(this.cdp, "mousePressed", from.x, from.y, { clickCount: 1, modifiers: mods });
    await sleep(holdMs);
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      await mouse(this.cdp, "mouseMoved", x, y, { button: "left", modifiers: mods });
      await sleep(16);
    }
    await sleep(holdMs);
    await mouse(this.cdp, "mouseReleased", to.x, to.y, { clickCount: 1, modifiers: mods });
    await sleep(120);
  }

  /** REAL HTML5 drag-and-drop. A synthetic `drop` DragEvent is not equivalent: something
   *  earlier in the bubble path consumes it, so the lane's handler never runs. Chrome
   *  intercepts the drag it starts itself and hands back the true payload. */
  async dragAndDrop(from, to) {
    await this.cdp.send("Input.setInterceptDrags", { enabled: true });
    const seen = this.events.length;
    await mouse(this.cdp, "mouseMoved", from.x, from.y, { button: "none" });
    await mouse(this.cdp, "mousePressed", from.x, from.y, { clickCount: 1 });
    await mouse(this.cdp, "mouseMoved", from.x + 12, from.y + 6, { button: "left" });
    await sleep(200);
    const hit = this.events.slice(seen).find((m) => m.method === "Input.dragIntercepted");
    if (!hit) {
      await mouse(this.cdp, "mouseReleased", from.x, from.y, { clickCount: 1 });
      await this.cdp.send("Input.setInterceptDrags", { enabled: false });
      throw new Error("dragAndDrop: the source never started a drag");
    }
    const data = hit.params.data;
    for (const type of ["dragEnter", "dragOver"]) {
      await this.cdp.send("Input.dispatchDragEvent", { type, x: to.x, y: to.y, data });
      await sleep(60);
    }
    await this.cdp.send("Input.dispatchDragEvent", { type: "drop", x: to.x, y: to.y, data });
    await mouse(this.cdp, "mouseReleased", to.x, to.y, { clickCount: 1 });
    await this.cdp.send("Input.setInterceptDrags", { enabled: false });
    await sleep(200);
    return data;
  }

  /** Press and release WITHOUT moving — every gesture must treat this as a no-op. */
  async pressRelease(at, { modifiers = "" } = {}) {
    const mods = modifierMask(modifiers);
    await mouse(this.cdp, "mouseMoved", at.x, at.y, { button: "none", modifiers: mods });
    await mouse(this.cdp, "mousePressed", at.x, at.y, { clickCount: 1, modifiers: mods });
    await sleep(60);
    await mouse(this.cdp, "mouseReleased", at.x, at.y, { clickCount: 1, modifiers: mods });
    await sleep(120);
  }

  /** Hand real files to a hidden <input type=file> — the app's native Import dialog
   *  cannot be driven from CDP, but the same code path runs from the input's change event. */
  async setFiles(sel, files) {
    const { result } = await this.cdp.send("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(sel)})`,
    });
    if (!result?.objectId) throw new Error(`setFiles: no input for ${sel}`);
    await this.cdp.send("DOM.setFileInputFiles", { files, objectId: result.objectId });
    await sleep(200);
  }

  /** Every clip element on the timeline with its rect and the media it shows. */
  clipEls() {
    return this.eval(
      `(() => { const hit = ${HIT_FN};
         return [...document.querySelectorAll('[title]')]
          .filter(e => e.querySelector('[aria-label="trim end"]'))
          .map(e => { const r = e.getBoundingClientRect();
            return { title: e.getAttribute('title'), x: r.x, y: r.y, w: r.width, h: r.height,
                     cx: r.x + r.width/2, cy: r.y + r.height/2, hit: hit(e) }; }); })()`,
    );
  }

  /** Clip elements on ONE lane, left to right. A global index silently drifts to another
   *  track the moment a scenario leaves a clip behind, which is how three scenarios in
   *  this suite went flaky. */
  clipsOn(trackId) {
    return this.eval(
      `(() => { const lane = document.querySelector('[data-track-id=${JSON.stringify(trackId)}]');
          if (!lane) return [];
          const hit = ${HIT_FN};
          return [...lane.querySelectorAll('[title]')]
            .filter(e => e.querySelector('[aria-label="trim end"]'))
            .map(e => { const r = e.getBoundingClientRect();
              return { title: e.getAttribute('title'), x: r.x, y: r.y, w: r.width, h: r.height,
                       cx: r.x + r.width/2, cy: r.y + r.height/2, hit: hit(e) }; })
            .sort((a, b) => a.x - b.x); })()`,
    );
  }

  /** A trim handle on the nth clip OF A GIVEN LANE. */
  async handleOn(trackId, index, edge) {
    const h = await this.eval(
      `(() => { const lane = document.querySelector('[data-track-id=${JSON.stringify(trackId)}]');
          if (!lane) return null;
          const clips = [...lane.querySelectorAll('[title]')]
            .filter(e => e.querySelector('[aria-label="trim end"]'))
            .sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x);
          const c = clips[${Number(index)}]; if (!c) return null;
          const h = c.querySelector('[aria-label="trim ${edge}"]'); if (!h) return null;
          const r = h.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height,
                   cx: r.x + r.width/2, cy: r.y + r.height/2, hit: ${HIT_FN}(h) }; })()`,
    );
    return this.#hittable(h, `handleOn(${trackId}, ${index}, ${edge})`);
  }

  /** Coordinates that do not land on the element they came from are a harness fault, and a
   *  silent one: the input goes to whatever panel owns those pixels and the gesture simply
   *  does nothing. Refuse them here rather than let a scenario report the app broken. */
  async #hittable(rect, what) {
    if (!rect || rect.hit) return rect;
    const s = await this.eval(
      `(() => { const lane = document.querySelector('[data-track-id]');
         let sc = 0; for (let n = lane; n; n = n.parentElement) if (n.scrollLeft) sc = n.scrollLeft;
         return sc; })()`,
    ).catch(() => 0);
    throw new Error(
      `${what}: the element reports (${rect.x.toFixed(0)},${rect.y.toFixed(0)}) but nothing of it ` +
        `is painted there — it is clipped by a scroller (timeline scrollLeft=${Number(s).toFixed(0)}) ` +
        `or covered. Input aimed there hits another panel. Call d.resetScroll() or place the clip in view.`,
    );
  }

  viewport() {
    return this.eval(`({ w: window.innerWidth, h: window.innerHeight })`);
  }

  /** Rect of a trim handle on the nth clip element. */
  async trimHandle(index, edge) {
    const h = await this.eval(
      `(() => { const els = [...document.querySelectorAll('[title]')]
            .filter(e => e.querySelector('[aria-label="trim end"]'));
          const e = els[${index}]; if (!e) return null;
          const h = e.querySelector('[aria-label="trim ${edge}"]'); if (!h) return null;
          const r = h.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width/2, cy: r.y + r.height/2,
                   hit: ${HIT_FN}(h) }; })()`,
    );
    return this.#hittable(h, `trimHandle(${index}, ${edge})`);
  }

  async screenshot(file) {
    const { data } = await this.cdp.send("Page.captureScreenshot", { format: "png" });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, Buffer.from(data, "base64"));
  }
}

/** Pixels per frame, CALIBRATED from a clip's drawn width against its length in the saved
 *  document. Deriving it from the app's zoom would be a second copy of the app's own math. */
export function pxPerFrame(clipEl, clipDoc) {
  const frames = clipDoc.tout - clipDoc.tin;
  if (!(frames > 0) || !(clipEl.w > 0)) return null;
  return clipEl.w / frames;
}
