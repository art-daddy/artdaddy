// The two shared containers every panel is built from.
//
// `Pane` is the chrome around a top-level pane (title, trailing actions, a hide button).
// `PaneSection` is a collapsible group INSIDE one — the direct analogue of other NLEs'
// `EditorPanelGroup(title:isExpanded:onReset:headerAccessory:content:)`, which is a section
// container in their inspector, not their window splitter. Keeping the two separate matters:
// a single component that tried to be both would take a props bag that fits neither.
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { cn } from "./ui";

export interface PaneProps {
  title: string;
  /** Trailing header controls (other NLEs' `headerAccessory`). */
  actions?: ReactNode;
  /** Shown as an × in the header when the pane is one the user is allowed to hide. */
  onHide?: () => void;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}

export function Pane({
  title,
  actions,
  onHide,
  children,
  className,
  bodyClassName,
}: PaneProps): JSX.Element {
  return (
    <section className={cn("flex h-full min-h-0 flex-col bg-panel", className)} aria-label={title}>
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-edge px-3">
        <h2 className="truncate text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
          {title}
        </h2>
        <div className="ml-auto flex items-center gap-1">
          {actions}
          {onHide && (
            <button
              type="button"
              onClick={onHide}
              aria-label={`hide ${title}`}
              title={`Hide ${title}`}
              className="rounded px-1 text-sm leading-none text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
            >
              ×
            </button>
          )}
        </div>
      </header>
      <div className={cn("min-h-0 flex-1 overflow-y-auto", bodyClassName)}>{children}</div>
    </section>
  );
}

const SECTION_KEY = "artdaddy-sections-v1";

function readCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(SECTION_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

export interface PaneSectionProps {
  title: string;
  /** Stable id for remembering the collapsed state. Omit to make the section always open. */
  id?: string;
  defaultOpen?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}

export function PaneSection({
  title,
  id,
  defaultOpen = true,
  actions,
  children,
}: PaneSectionProps): JSX.Element {
  const [open, setOpen] = useState(() => (id ? (readCollapsed()[id] ?? defaultOpen) : defaultOpen));

  useEffect(() => {
    if (!id) return;
    try {
      localStorage.setItem(SECTION_KEY, JSON.stringify({ ...readCollapsed(), [id]: open }));
    } catch {
      /* private mode / quota — the section just won't remember */
    }
  }, [id, open]);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  return (
    <div className="border-b border-edge">
      <div className="flex items-center gap-1 px-3 py-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label={title}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[10px] font-semibold uppercase tracking-wider text-neutral-400 hover:text-neutral-200"
        >
          <span
            aria-hidden
            className={cn(
              "inline-block text-[8px] leading-none transition-transform",
              open ? "rotate-90" : "rotate-0",
            )}
          >
            ▶
          </span>
          <span className="truncate">{title}</span>
        </button>
        {actions}
      </div>
      {open && <div className="px-3 pb-2">{children}</div>}
    </div>
  );
}
