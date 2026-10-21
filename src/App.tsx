import { useRef } from "react";
import { DicomViewer, type DicomViewerHandle } from "dental-cbct-viewer";
import "dental-cbct-viewer/style.css";
import "./App.css";
import { useDicomFileInterception } from "./dicom/useDicomFileInterception";

// The viewer fills its parent, so the wrapper takes the whole window. Scans are
// opened with the viewer's own "Choose folder" / "Choose files" buttons or by
// dropping a folder on it; those go through useDicomFileInterception first.
export default function App() {
  const rootRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<DicomViewerHandle>(null);
  useDicomFileInterception(rootRef, viewerRef);

  return (
    <div ref={rootRef} className="viewer-root">
      <DicomViewer ref={viewerRef} lang="en" initialLayout="1+3" />
    </div>
  );
}
