// The keyboard reference, rendered from the shortcut registry. Nothing here is hand-written:
// a key listed on this sheet is the key that fires, because both come from the same entry.
import { SECTIONS, SHORTCUTS, shortcutLabels } from "../timeline/shortcuts";

export function ShortcutSheet(): JSX.Element {
  return (
    <div className="max-h-[70vh] overflow-y-auto pr-1">
      <p className="mb-4 text-xs text-neutral-400">
        Shortcuts work while the timeline has focus. Typing in a text field never triggers them.
      </p>
      <div className="grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2">
        {SECTIONS.map((section) => (
          <section key={section}>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
              {section}
            </h3>
            <ul className="space-y-1">
              {SHORTCUTS.filter((s) => s.section === section).map((s) => (
                <li key={s.id} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="text-neutral-200">
                    {s.label}
                    {s.note ? (
                      <span className="mt-0.5 block text-[11px] leading-snug text-neutral-500">
                        {s.note}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 space-x-1 whitespace-nowrap">
                    {shortcutLabels(s.id).map((k) => (
                      <kbd
                        key={k}
                        className="rounded border border-neutral-700 bg-neutral-800 px-1.5 py-0.5 font-mono text-[11px] text-neutral-300"
                      >
                        {k}
                      </kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
