import { useEffect, useState } from "react";

import type { ProjectListEntry } from "../api/types";
import { BRAND } from "../brand";
import { useProjectSwitch } from "../store/closeCoordinator";
import { setFirstPrompt } from "../store/firstPrompt";
import { useMcpPanel } from "../store/mcpPanel";
import { useProjects } from "../store/projects";
import { NewProjectDialog, ProjectThumb } from "./ProjectDialogs";
import { Button } from "./ui";

/** Recent projects shown before the list is expanded — Premiere's recent-files behaviour. */
const RECENT = 5;

/** "3 days ago" — enough to sort the pile by hand without a date-formatting dependency. */
function when(iso: string | undefined): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}

/** A project name from the first sentence — renameable, and better than "Untitled". */
function nameFrom(prompt: string): string {
  const first = prompt
    .trim()
    .split(/[.!?\n]/)[0]
    .trim();
  return (first.length > 48 ? `${first.slice(0, 45)}…` : first) || "Untitled";
}

/** What the window shows with no project open.
 *
 *  It used to be the full editor with every pane empty — a LIBRARY with nothing to list, a
 *  SOURCE monitor with nothing to play, a FILES tree of no project. Panes that can only say
 *  "there is nothing here" are not a workspace, so nothing routed to `/` mounts them: this
 *  replaces them entirely and offers the only two things that are actually possible here,
 *  opening one of your projects or starting a new one. */
export default function ProjectPicker() {
  const projects = useProjects((s) => s.projects);
  const refresh = useProjects((s) => s.refresh);
  const create = useProjects((s) => s.create);
  const switchTo = useProjectSwitch();
  const openMcp = useMcpPanel((s) => s.openPanel);
  const [dialog, setDialog] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [text, setText] = useState("");
  const [aspect, setAspect] = useState("9:16");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const start = async () => {
    const prompt = text.trim();
    if (!prompt || busy) return;
    setBusy(true);
    setError(null);
    try {
      const p = await create(nameFrom(prompt), aspect);
      setFirstPrompt(prompt); // waiting in the composer once the project opens
      await switchTo(p.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the project.");
      setBusy(false);
    }
  };

  const sorted: ProjectListEntry[] = [...projects].sort(
    (a, b) => Date.parse(b.lastOpenedAt ?? "") - Date.parse(a.lastOpenedAt ?? "") || 0,
  );
  const shown = showAll ? sorted : sorted.slice(0, RECENT);
  const hidden = sorted.length - shown.length;

  return (
    // The PAGE never scrolls: the prompt box and the MCP line must stay on screen however many
    // projects exist. Only the list below scrolls.
    <div className="flex h-full flex-col overflow-hidden bg-bg">
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-6 px-8 py-10">
        <header className="flex items-center gap-3">
          <img src="/icon.png" alt="" width={52} height={52} className="shrink-0 rounded-[13px]" />
          <div>
            <h1 className="text-2xl font-semibold text-ink">{BRAND.displayName}</h1>
            <p className="mt-0.5 text-sm text-ink-dim">{BRAND.tagline}</p>
          </div>
        </header>

        <section className="rounded-lg border border-edge bg-surface p-4">
          <label htmlFor="picker-prompt" className="text-xs font-medium text-ink-dim">
            Describe what you want to make
          </label>
          <textarea
            id="picker-prompt"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void start();
              }
            }}
            rows={3}
            disabled={busy}
            placeholder="A 30-second vertical cut of my podcast with captions…"
            className="mt-2 w-full resize-none rounded-md border border-edge bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-60"
          />
          <div className="mt-2 flex items-center gap-2">
            <label htmlFor="picker-aspect" className="text-xs text-ink-dim">
              Aspect
            </label>
            <select
              id="picker-aspect"
              value={aspect}
              onChange={(e) => setAspect(e.target.value)}
              disabled={busy}
              className="rounded-md border border-edge bg-neutral-900 px-2 py-1.5 text-sm"
            >
              <option value="9:16">9:16</option>
              <option value="16:9">16:9</option>
              <option value="1:1">1:1</option>
            </select>
            <div className="ml-auto flex gap-2">
              <Button onClick={() => setDialog(true)}>New project…</Button>
              <Button
                variant="primary"
                disabled={busy || !text.trim()}
                onClick={() => void start()}
              >
                {busy ? "Creating…" : "Start"}
              </Button>
            </div>
          </div>
          {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        </section>

        <section className="flex min-h-0 flex-1 flex-col">
          <h2 className="mb-2 shrink-0 text-[11px] font-semibold uppercase tracking-wider text-ink-dim">
            Your projects
          </h2>
          {sorted.length === 0 ? (
            <p className="rounded-lg border border-dashed border-edge px-4 py-8 text-center text-xs text-neutral-500">
              No projects yet.
            </p>
          ) : (
            <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-edge bg-surface">
              <ul className="min-h-0 flex-1 divide-y divide-edge overflow-y-auto">
                {shown.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => void switchTo(p.id)}
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-raised"
                    >
                      <ProjectThumb path={p.path} className="ml-0 h-10 w-10" />
                      <span className="min-w-0 flex-1 truncate text-sm text-ink">{p.name}</span>
                      <span className="shrink-0 text-xs text-neutral-500">
                        {when(p.lastOpenedAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {hidden > 0 && (
                <button
                  type="button"
                  onClick={() => setShowAll(true)}
                  className="shrink-0 border-t border-edge px-3 py-2 text-xs text-ink-dim hover:bg-raised hover:text-ink"
                >
                  Show all {sorted.length} projects
                </button>
              )}
            </div>
          )}
        </section>

        {/* The one screen every new user reads, so it is where "can I use my own agent?"
            gets answered instead of being left in the Help menu. Outside the scroll area, so a
            long project list cannot bury it. */}
        <p className="shrink-0 border-t border-edge pt-4 text-xs text-neutral-500">
          Prefer your own agent?{" "}
          <button onClick={openMcp} className="text-brand underline-offset-2 hover:underline">
            Connect Claude, Cursor or Codex over MCP
          </button>
          .
        </p>
      </div>

      {dialog && (
        <NewProjectDialog onClose={() => setDialog(false)} onDone={(id) => void switchTo(id)} />
      )}
    </div>
  );
}
