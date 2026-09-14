// Scenario context: the assertions a UI sweep is allowed to make.
//
// Every check is against the PERSISTED document (see doc.mjs). A scenario may look at the
// DOM as well — to catch a ghost that promises something the commit refuses — but never
// INSTEAD of the document.
import { clips, fingerprint, readDoc, settled, spans, waitForChange } from "./doc.mjs";

export class Ctx {
  constructor(driver, projectId, name) {
    this.d = driver;
    this.projectId = projectId;
    this.name = name;
    this.checks = [];
  }

  // ---- state ---------------------------------------------------------------

  /** The saved document, once it has stopped changing. */
  doc() {
    return settled(this.projectId);
  }
  async spans() {
    return spans(await this.doc());
  }
  async clips() {
    return clips(await this.doc());
  }
  /** Clips in timeline order on a track — what a positional assertion wants. */
  async track(id) {
    const c = await this.clips();
    return Object.entries(c)
      .filter(([, v]) => v.track === id)
      .map(([k, v]) => ({ id: k, ...v }))
      .sort((a, b) => a.tin - b.tin);
  }

  /** `[start, end)` pairs on a track — the shape a structural expectation reads best in. */
  async spansOf(id) {
    return (await this.track(id)).map((c) => [c.tin, c.tout]);
  }

  /** Live UI-only state (selection, tool, playhead) — not persisted, so not in the doc. */
  ui() {
    return this.d.eval(
      `(() => { const s = window.__artdaddyTest.editor.getState();
         return { selected: s.selectedIds ?? [], selection: s.selection ?? null,
                  playhead: s.playhead ?? 0, zoom: s.zoom ?? 0 }; })()`,
    );
  }

  /** Why the app might have ignored a gesture. Captured on any failure, because "the
   *  gesture changed the document — false" says nothing about what was in the way. */
  diagnostics() {
    return this.d
      .eval(
        `(() => {
           const ae = document.activeElement;
           const pressed = [...document.querySelectorAll('[aria-pressed="true"]')]
             .map(e => e.getAttribute('aria-label')).filter(Boolean);
           const overlays = [...document.querySelectorAll('[role="dialog"], .fixed')]
             .filter(e => e.getBoundingClientRect().width > 200)
             .map(e => (e.innerText ?? '').trim().split('\\n')[0].slice(0, 40));
           return {
             focus: ae ? (ae.tagName + (ae.getAttribute('aria-label') ? '[' + ae.getAttribute('aria-label') + ']' : '')) : null,
             pressed, overlays,
             clips: document.querySelectorAll('[data-track-id] [title]').length,
             hasFocus: document.hasFocus(),
           }; })()`,
      )
      .catch((e) => ({ error: String(e).slice(0, 120) }));
  }

  // ---- assertions ----------------------------------------------------------

  expect(ok, message, detail) {
    this.checks.push({ ok: !!ok, message, detail: ok ? undefined : detail });
    return !!ok;
  }

  eq(actual, expected, message) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    return this.expect(a === e, message, `expected ${e}, got ${a}`);
  }

  /** THE invariant. One coherent gesture must be exactly one Ctrl+Z, and that undo must
   *  restore the document EXACTLY — not approximately, not "looks the same". Redo must
   *  put it back. This cannot be satisfied by a UI that merely looks right. */
  async assertOneUndo(gesture, label) {
    const beforeDoc = await this.doc();
    const before = fingerprint(beforeDoc);
    await gesture();
    // Wait for the WRITE, don't assume the gesture's own sleep outran it. `drag` returns 120ms
    // after mouse-up; the commit behind it is a debounced persist on top of a lazily-loaded
    // session, so the first gesture of a run can land later than that. Reading too early
    // reported "the gesture changed nothing" for a move that was perfectly correct. A genuine
    // no-op still fails here — just after the timeout instead of before the write. This is the
    // same reasoning the undo and redo steps below already use.
    await waitForChange(this.projectId, beforeDoc, 6000);
    const afterDoc = await this.doc();
    const after = fingerprint(afterDoc);
    if (!this.expect(after !== before, `${label}: the gesture changed the document`)) return;

    // `settled` proves the document is STABLE, not that a pending write has landed. Sampling
    // between the keypress and the write reads the pre-undo state and reports "undo did
    // nothing" — a false failure. Wait for the change first; a genuine no-op still fails,
    // just after the timeout rather than before the write.
    await this.d.key("Control+z");
    await waitForChange(this.projectId, afterDoc, 6000);
    const undoneDoc = await this.doc();
    const undone = fingerprint(undoneDoc);
    this.expect(
      undone === before,
      `${label}: ONE Ctrl+Z restores the document exactly`,
      undone === after
        ? // "undo did nothing" has three different causes and the message cannot tell them
          // apart, so read the stacks instead of guessing: an EMPTY undo stack means the
          // gesture cost 0 entries; a non-empty one means the keypress never arrived or the
          // write outran the wait. Without this a failure here is only reproducible by luck.
          `undo did nothing — ${await this.#history()}`
        : "undo left the document in a THIRD state — the gesture cost more than one entry",
    );

    await this.d.key("Control+Shift+z");
    await waitForChange(this.projectId, undoneDoc, 6000);
    const redone = fingerprint(await this.doc());
    this.expect(redone === after, `${label}: redo restores the edit exactly`);
  }

  /** The live undo/redo stacks, for the failure message above. Best-effort: the store shape
   *  is internal, so report what is reachable rather than throwing inside a diagnostic. */
  async #history() {
    const h = await this.d
      .eval(
        `(() => { const st = window.__artdaddyTest?.editor?.getState?.();
           const tl = st?.store?.getState?.()?.timeline ?? st?.store?.timeline;
           if (!tl) return null;
           return { canUndo: !!tl.canUndo?.(), canRedo: !!tl.canRedo?.(),
                    revision: tl.revision?.() ?? null, dirty: !!tl.isDirty?.() }; })()`,
      )
      .catch(() => null);
    if (!h) return "and the undo stack could not be read (store shape changed?)";
    return h.canUndo
      ? `but the undo stack is NOT empty (revision=${h.revision}, dirty=${h.dirty}) — ` +
          `the keypress never reached the app, or the write outran the 6s wait`
      : `and the undo stack is EMPTY (revision=${h.revision}) — the gesture cost 0 entries`;
  }

  /** A press that never moves is a selection, not an edit. No document change, no undo. */
  async assertNoOp(gesture, label) {
    const before = fingerprint(await this.doc());
    await gesture();
    await new Promise((r) => setTimeout(r, 700));
    const after = fingerprint(readDoc(this.projectId));
    this.expect(after === before, `${label}: a no-op gesture writes nothing`);
  }

  /** A clamped drag must stop at the rail AND the ghost must have stopped there too, or
   *  the UI promised something the commit refused. `ghost` returns the on-screen span. */
  async assertRail(gesture, expected, label, ghost) {
    let seen = null;
    await gesture((g) => {
      seen = g;
    });
    const t = await this.track(expected.track);
    this.eq(
      t.map((c) => [c.tin, c.tout]),
      expected.spans,
      `${label}: the commit stops at the rail`,
    );
    if (ghost && seen) {
      this.expect(seen.railed, `${label}: the GHOST stopped at the rail too (no snap-back)`, seen);
    }
  }

  get passed() {
    return this.checks.every((c) => c.ok);
  }
}
