// The ONE place a keyboard shortcut is defined.
//
// The menu used to carry hand-written label strings while TimelineEditor matched raw key
// comparisons, so the two drifted: the Edit menu advertised "S" for Split at Playhead long after
// the binding became Ctrl+K, and S had come to mean snapping. A label that is written down twice
// is a label that will eventually lie.
//
// Each entry carries a declarative combo. The matcher and the printed label are both DERIVED from
// it, so a menu hint cannot disagree with the key that actually fires.

/** `shift`/`alt` default to "must not be held". "any" means the binding does not care. */
export interface Combo {
  key: string;
  cmd?: boolean;
  shift?: boolean | "any";
  alt?: boolean | "any";
}

export type ShortcutSection = "Edit" | "Tools" | "Timeline" | "Playback" | "View";

export interface Shortcut {
  id: string;
  label: string;
  section: ShortcutSection;
  combos: Combo[];
  /** Shown in the reference panel where the key alone doesn't explain the behaviour. */
  note?: string;
}

const MOD_KEYS = new Set(["Control", "Meta", "Shift", "Alt"]);

function matchOne(e: KeyboardEvent, c: Combo): boolean {
  if (MOD_KEYS.has(e.key)) return false;
  const key = c.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (key !== c.key) return false;
  if (!!c.cmd !== (e.ctrlKey || e.metaKey)) return false;
  if (c.shift !== "any" && !!c.shift !== e.shiftKey) return false;
  if (c.alt !== "any" && !!c.alt !== e.altKey) return false;
  return true;
}

export const SHORTCUTS: Shortcut[] = [
  // ── Edit ────────────────────────────────────────────────────────────────────
  { id: "selectAll", label: "Select All", section: "Edit", combos: [{ key: "a", cmd: true }] },
  { id: "undo", label: "Undo", section: "Edit", combos: [{ key: "z", cmd: true }] },
  {
    id: "redo",
    label: "Redo",
    section: "Edit",
    combos: [
      { key: "z", cmd: true, shift: true },
      { key: "y", cmd: true },
    ],
  },
  { id: "cut", label: "Cut", section: "Edit", combos: [{ key: "x", cmd: true }] },
  { id: "copy", label: "Copy", section: "Edit", combos: [{ key: "c", cmd: true }] },
  { id: "paste", label: "Paste", section: "Edit", combos: [{ key: "v", cmd: true }] },
  { id: "duplicate", label: "Duplicate", section: "Edit", combos: [{ key: "d", cmd: true }] },
  {
    id: "delete",
    label: "Delete",
    section: "Edit",
    combos: [
      { key: "Delete", shift: "any" },
      { key: "Backspace", shift: "any" },
    ],
    note: "Hold Shift to close the gap behind it (ripple delete).",
  },
  {
    id: "split",
    label: "Split at Playhead",
    section: "Edit",
    combos: [{ key: "k", cmd: true }],
  },

  // ── Tools ───────────────────────────────────────────────────────────────────
  { id: "toolPointer", label: "Selection tool", section: "Tools", combos: [{ key: "v" }] },
  {
    id: "toolRazor",
    label: "Razor tool",
    section: "Tools",
    combos: [{ key: "c" }],
    note: "Cuts where you click — Ctrl+K cuts at the playhead.",
  },
  { id: "toolSlip", label: "Slip tool", section: "Tools", combos: [{ key: "y" }] },
  { id: "toolSlide", label: "Slide tool", section: "Tools", combos: [{ key: "u" }] },
  { id: "toolRoll", label: "Rolling Edit tool", section: "Tools", combos: [{ key: "n" }] },

  // ── Timeline ────────────────────────────────────────────────────────────────
  {
    id: "snapping",
    label: "Toggle snapping",
    section: "Timeline",
    combos: [{ key: "s" }],
    note: "Hold Shift while dragging to bypass it for one gesture.",
  },
  {
    id: "selectForwardTrack",
    label: "Select clips forward (this track)",
    section: "Timeline",
    combos: [{ key: "a" }],
  },
  {
    id: "selectForwardAll",
    label: "Select clips forward (all tracks)",
    section: "Timeline",
    combos: [{ key: "a", shift: true }],
  },
  {
    id: "toggleEnabled",
    label: "Enable / disable clip",
    section: "Timeline",
    combos: [{ key: "e", shift: true }],
  },
  {
    id: "trimHead",
    label: "Trim start to playhead",
    section: "Timeline",
    combos: [{ key: "q" }],
  },
  { id: "trimTail", label: "Trim end to playhead", section: "Timeline", combos: [{ key: "w" }] },
  {
    id: "nudge",
    label: "Nudge clip",
    section: "Timeline",
    combos: [
      { key: "ArrowLeft", alt: true, shift: "any" },
      { key: "ArrowRight", alt: true, shift: "any" },
    ],
    note: "Shift nudges 5 frames at a time.",
  },
  {
    id: "deselect",
    label: "Deselect / back to Selection tool",
    section: "Timeline",
    combos: [{ key: "Escape" }],
  },

  // ── Playback ────────────────────────────────────────────────────────────────
  { id: "play", label: "Play / pause", section: "Playback", combos: [{ key: " " }] },
  { id: "goStart", label: "Go to start", section: "Playback", combos: [{ key: "Home" }] },
  { id: "goEnd", label: "Go to end", section: "Playback", combos: [{ key: "End" }] },
  {
    id: "step",
    label: "Step one frame",
    section: "Playback",
    combos: [
      { key: "ArrowLeft", alt: false, shift: "any" },
      { key: "ArrowRight", alt: false, shift: "any" },
    ],
    note: "Shift steps 5 frames at a time.",
  },

  // ── View ────────────────────────────────────────────────────────────────────
  {
    id: "zoomIn",
    label: "Zoom in",
    section: "View",
    combos: [{ key: "+" }, { key: "=" }],
  },
  { id: "zoomOut", label: "Zoom out", section: "View", combos: [{ key: "-" }, { key: "_" }] },
  {
    id: "paneLibrary",
    label: "Show / hide Library",
    section: "View",
    combos: [{ key: "0", cmd: true }],
  },
  {
    id: "paneInspector",
    label: "Show / hide Inspector",
    section: "View",
    combos: [{ key: "0", cmd: true, alt: true }],
  },
  {
    id: "paneAssistant",
    label: "Show / hide Assistant",
    section: "View",
    combos: [{ key: "a", cmd: true, alt: true }],
  },
];

const BY_ID = new Map(SHORTCUTS.map((s) => [s.id, s]));

export function shortcut(id: string): Shortcut | undefined {
  return BY_ID.get(id);
}

/** Does this event fire `id`? The single matcher — handlers must not re-test raw keys. */
export function hit(e: KeyboardEvent, id: string): boolean {
  const s = BY_ID.get(id);
  return !!s && s.combos.some((c) => matchOne(e, c));
}

const PRETTY: Record<string, string> = {
  " ": "Space",
  ArrowLeft: "←",
  ArrowRight: "→",
  Delete: "Del",
  Backspace: "Backspace",
  Escape: "Esc",
  Home: "Home",
  End: "End",
};

function comboLabel(c: Combo, mac: boolean): string {
  const parts: string[] = [];
  if (c.cmd) parts.push(mac ? "⌘" : "Ctrl");
  if (c.alt === true) parts.push(mac ? "⌥" : "Alt");
  if (c.shift === true) parts.push("Shift");
  parts.push(PRETTY[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key));
  return parts.join("+");
}

/** The label a menu or the reference panel shows. Derived from the same combo the matcher uses,
 *  so a menu hint that disagrees with the binding is not expressible. */
export function shortcutLabel(id: string, mac = isMac()): string {
  const s = BY_ID.get(id);
  if (!s) return "";
  // Arrow pairs read as one chord ("Alt+←/→") rather than two rows.
  const labels = s.combos.map((c) => comboLabel(c, mac));
  if (labels.length === 2 && labels[0].replace("←", "→") === labels[1]) {
    return labels[0].replace("←", "←/→");
  }
  return labels[0];
}

/** Every combo, for the reference panel — including the alternates the menu has no room for. */
export function shortcutLabels(id: string, mac = isMac()): string[] {
  return (BY_ID.get(id)?.combos ?? []).map((c) => comboLabel(c, mac));
}

export function isMac(): boolean {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.platform || "");
}

export const SECTIONS: ShortcutSection[] = ["Edit", "Tools", "Timeline", "Playback", "View"];
