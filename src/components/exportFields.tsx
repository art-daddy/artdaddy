// Copies of the four small pieces ExportDialog.tsx keeps to itself (a row with its label, the look of a select, of the plain button and of the primary one), so that the Quality / Fast view draws
// the same rows without the 0.28.0 file being edited. Same classes as there: when the legacy view is deleted these become the only ones.
export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label className="flex items-center gap-3 text-xs text-neutral-400">
      <span className="w-20 shrink-0">{label}</span>
      {children}
    </label>
  );
}

export const selectCls =
  "min-w-0 flex-1 truncate rounded border border-edge bg-neutral-800 px-2 py-1 text-xs text-neutral-100 outline-none";
export const ghostCls = "rounded-md px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800";
export const primaryCls =
  "rounded-md bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white";
