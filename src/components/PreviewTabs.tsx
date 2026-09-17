// The preview pane's tab strip. The live preview is tab one and cannot be closed or
// moved — it is the program monitor, and an editor whose preview you can shut is a
// trap. Library clips open to its right; a single click reuses one transient slot
// (italic) so browsing the library cannot bury the strip, and double-clicking a tab
// keeps it.
import { useEditor } from "../store/editor";
import { mediaLabel } from "./timeline/labels";
import { cn } from "./ui";

const TAB = "shrink-0 max-w-[14rem] truncate px-3 py-1 text-[11px] border-r border-edge";

export default function PreviewTabs() {
  const tabs = useEditor((s) => s.mediaTabs);
  const active = useEditor((s) => s.activeMediaTab);
  const names = useEditor((s) => s.mediaNames);
  const setActive = useEditor((s) => s.setActiveMediaTab);
  const open = useEditor((s) => s.openMediaTab);
  const close = useEditor((s) => s.closeMediaTab);

  return (
    <div
      role="tablist"
      aria-label="preview tabs"
      className="flex shrink-0 items-stretch overflow-x-auto border-b border-edge bg-panel"
    >
      <button
        type="button"
        role="tab"
        aria-selected={active === null}
        onClick={() => setActive(null)}
        className={cn(
          TAB,
          active === null
            ? "bg-neutral-950 text-neutral-100"
            : "text-neutral-400 hover:bg-neutral-800",
        )}
      >
        Live preview
      </button>
      {tabs.map((t) => {
        const label = mediaLabel(t.ref, names);
        const on = active === t.ref;
        return (
          <div
            key={t.ref}
            className={cn(
              "flex shrink-0 items-stretch border-r border-edge",
              on ? "bg-neutral-950" : "hover:bg-neutral-800",
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={on}
              title={`${label}${t.transient ? " — double-click to keep this tab open" : ""}`}
              onClick={() => setActive(t.ref)}
              onDoubleClick={() => open(t.ref, { pin: true })}
              className={cn(
                "max-w-[14rem] truncate py-1 pl-3 pr-1 text-[11px]",
                on ? "text-neutral-100" : "text-neutral-400",
                t.transient && "italic",
              )}
            >
              {label}
            </button>
            <button
              type="button"
              aria-label={`close ${label}`}
              title={`Close ${label}`}
              onClick={() => close(t.ref)}
              className="px-1.5 text-sm leading-none text-neutral-600 hover:text-neutral-200"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
