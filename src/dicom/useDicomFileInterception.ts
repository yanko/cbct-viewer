import { useEffect, type RefObject } from "react";
import type { DicomViewerHandle } from "dental-cbct-viewer";
import { expandMultiFrameDicom } from "./splitMultiFrame";

// The viewer's own "Choose files" / "Choose folder" pickers and its drop zone
// hand files straight to its loader. Catch them first (capture phase, before
// React sees the event), split multi-frame volumes, and load the result through
// the viewer's public `loadStudy` API. Surface-scan (STL) and plan (JSON)
// pickers are left alone.
const DICOM_INPUT = 'input[type="file"][accept*=".dcm"], input[type="file"][webkitdirectory]';
const DICOM_DROP_ZONE = 'div:has(> input[type="file"][accept*=".dcm"])';

export function useDicomFileInterception(
  rootRef: RefObject<HTMLElement | null>,
  viewerRef: RefObject<DicomViewerHandle | null>,
): void {
  useEffect(() => {
    const load = async (files: File[]) => {
      try {
        await viewerRef.current?.loadStudy(await expandMultiFrameDicom(files));
      } catch (error) {
        console.error("[cbct-viewer] Could not load DICOM files:", error);
        window.alert(`Could not load the scan: ${error instanceof Error ? error.message : error}`);
      }
    };

    const onChange = (event: Event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || !input.matches(DICOM_INPUT)) return;
      if (!rootRef.current?.contains(input)) return;
      event.stopImmediatePropagation();
      const files = Array.from(input.files ?? []);
      input.value = ""; // allow picking the same folder again
      if (files.length > 0) void load(files);
    };

    const onDrop = (event: DragEvent) => {
      const zone = event.target instanceof Element ? event.target.closest(DICOM_DROP_ZONE) : null;
      if (!zone || !rootRef.current?.contains(zone) || !event.dataTransfer) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      // Entries must be taken synchronously, while the drop event is live.
      const entries = Array.from(event.dataTransfer.items)
        .map((item) => item.webkitGetAsEntry())
        .filter((entry): entry is FileSystemEntry => entry !== null);
      const looseFiles = Array.from(event.dataTransfer.files);
      // Clear the zone's "dragging" highlight, which its own drop handler would reset.
      zone.dispatchEvent(new DragEvent("dragleave", { bubbles: true }));
      void (entries.length > 0 ? readEntries(entries) : Promise.resolve(looseFiles)).then(
        (files) => {
          if (files.length > 0) return load(files);
        },
      );
    };

    window.addEventListener("change", onChange, true);
    window.addEventListener("drop", onDrop, true);
    return () => {
      window.removeEventListener("change", onChange, true);
      window.removeEventListener("drop", onDrop, true);
    };
  }, [rootRef, viewerRef]);
}

async function readEntries(entries: FileSystemEntry[]): Promise<File[]> {
  const files: File[] = [];
  for (const entry of entries) {
    if (entry.isFile) {
      files.push(
        await new Promise<File>((resolve, reject) =>
          (entry as FileSystemFileEntry).file(resolve, reject),
        ),
      );
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
          reader.readEntries(resolve, reject),
        );
        if (batch.length === 0) break;
        files.push(...(await readEntries(batch)));
      }
    }
  }
  return files;
}
