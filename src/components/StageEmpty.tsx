// What the stage offers when there is nothing to play yet.
//
// It used to read "No timeline yet — ask the agent to build one", which names the one route a
// newcomer cannot take: they have no media to ask about. Descript puts the two real starting
// moves on its empty project — bring a file in, or record one — so this does the same, in the
// largest empty area in the app.
import { useRef, useState } from "react";

import { importViaDialog, uploadFiles } from "../lib/upload";
import { isMediaFile } from "../media/formats";
import { notifyLibraryChanged } from "../tools/import";
import { useProjectNotice } from "../store/projectNotice";
import { useRecordPanel } from "../store/recordPanel";
import { cn } from "./ui";

export default function StageEmpty({ projectId }: { projectId: string }): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const openRecorder = useRecordPanel((s) => s.openRecorder);

  const fail = (e: unknown): void =>
    useProjectNotice
      .getState()
      .notify(`Couldn't import: ${e instanceof Error ? e.message : String(e)}`);

  const take = async (files: File[]): Promise<void> => {
    const media = files.filter((f) => isMediaFile(f.name));
    if (!media.length) return;
    setBusy(true);
    try {
      await uploadFiles(projectId, media);
      notifyLibraryChanged();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  // Desktop opens the OS dialog; the hidden input is the WEB fallback, because a file input
  // never opens on macOS while the window keeps native drag-drop.
  const browse = async (): Promise<void> => {
    setBusy(true);
    try {
      const picked = await importViaDialog(projectId, "Import media");
      if (picked === null) inputRef.current?.click();
      else if (picked.length) notifyLibraryChanged();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex w-full max-w-md flex-col items-center gap-3 px-6">
      <button
        type="button"
        onClick={() => void browse()}
        disabled={busy}
        aria-label="upload file"
        onDragOver={(e) => {
          if (![...e.dataTransfer.types].includes("Files")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void take([...(e.dataTransfer.files ?? [])]);
        }}
        className={cn(
          "flex w-full flex-col items-center gap-1 rounded-lg border border-dashed px-6 py-10 transition-colors",
          dragOver ? "border-accent bg-accent/10" : "border-edge hover:border-neutral-600",
        )}
      >
        <span className="text-sm font-medium text-neutral-200">
          {busy ? "Importing…" : "Upload file"}
        </span>
        <span className="text-[11px] text-neutral-500">Click to browse, or drop a file here</span>
      </button>

      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*,audio/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          void take(files);
        }}
      />

      <button
        type="button"
        onClick={openRecorder}
        aria-label="record video"
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-edge px-6 py-2.5 text-sm text-neutral-200 hover:border-neutral-600"
      >
        <span className="h-2 w-2 rounded-full bg-red-500" aria-hidden />
        Record
      </button>

      <p className="text-[11px] text-neutral-600">Or ask the agent to build something.</p>
    </div>
  );
}
