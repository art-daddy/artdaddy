// QA helper: print what the running app shows (composer, buttons, route) over CDP.
import { open } from "../uisweep/lib/driver.mjs";

const d = await open();
const r = await d.eval(`JSON.stringify({
  path: location.pathname,
  textareas: [...document.querySelectorAll('textarea')].map(t => ({ ph: t.placeholder, disabled: t.disabled, w: Math.round(t.getBoundingClientRect().width) })),
  editables: document.querySelectorAll('[contenteditable=true]').length,
  buttons: [...document.querySelectorAll('button')]
    .map(b => (b.innerText || b.title || b.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 30))
    .filter(Boolean),
})`);
console.log(r);
d.close();
