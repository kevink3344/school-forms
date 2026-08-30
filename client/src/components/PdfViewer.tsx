import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";

// ---------------------------------------------------------------------------
// Inline PDF preview for a generated Google Doc.
//
// The doc is owned by the app's OAuth Drive account, so the only way a normal
// staff/admin account can view it is through the scoped /api/documents/:id/pdf
// endpoint (which streams a PDF export). This component fetches that blob and
// shows it in an <iframe>. The browser's native PDF viewer supplies its own
// zoom + save/download controls, so no toolbar is rendered here. Because the
// export is a snapshot, re-fetching after a regenerate (via the `refreshKey`
// prop) returns the freshly generated content.
// ---------------------------------------------------------------------------

interface PdfViewerProps {
  /** The DB row id of the document (used to call /api/documents/:id/pdf). */
  documentRowId: number | null;
  /** Bump this to force a re-fetch (e.g. after a regenerate). */
  refreshKey?: number;
}

export function PdfViewer({ documentRowId, refreshKey = 0 }: PdfViewerProps) {
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Fetch the PDF blob whenever the document (or refreshKey) changes.
  useEffect(() => {
    if (!documentRowId) {
      setPdfUrl(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    api
      .getDocumentPdf(documentRowId)
      .then((b) => {
        if (cancelled) return;
        // Revoke any previous object URL to avoid leaks.
        setPdfUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return URL.createObjectURL(b);
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Could not load PDF");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [documentRowId, refreshKey]);

  // Clean up the object URL when the component unmounts.
  useEffect(() => {
    return () => {
      setPdfUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, []);

  if (!documentRowId) {
    return (
      <div className="pdf-viewer-placeholder">
        This document doesn&apos;t have a PDF yet. It may still be generating.
      </div>
    );
  }

  return (
    <div className="pdf-viewer">
      <div className="pdf-stage">
        {loading ? (
          <div className="pdf-loading">
            <div className="spinner" /> Loading PDF...
          </div>
        ) : error ? (
          <div className="pdf-error">{error}</div>
        ) : pdfUrl ? (
          <iframe className="pdf-frame" src={pdfUrl} title="Document preview" />
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Slide-in drawer wrapper. Renders the overlay + drawer with a header and the
// PdfViewer inside. Used standalone from the submission detail page; the
// Documents list page embeds the PdfViewer in its own existing drawer instead.
// ---------------------------------------------------------------------------
interface PdfViewerDrawerProps {
  title?: string;
  documentRowId: number | null;
  refreshKey?: number;
  onClose: () => void;
}

export function PdfViewerDrawer({
  title = "Document Preview",
  documentRowId,
  refreshKey = 0,
  onClose,
}: PdfViewerDrawerProps) {
  return (
    <div className="drawer-overlay open" onClick={onClose}>
      <div className="drawer drawer-pdf" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>{title}</h2>
          <button className="icon-button close" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="drawer-body drawer-body-pdf">
          <PdfViewer documentRowId={documentRowId} refreshKey={refreshKey} />
        </div>
        <div className="drawer-foot">
          <div className="spacer" />
          <button className="secondary-button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
