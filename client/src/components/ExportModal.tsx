import { useEffect, useMemo, useState } from "react";
import { api, getToken, ApiError } from "../lib/api";
import type { ExportColumn, ExportPreview, Form } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  formId: string;
  forms: Form[];
  schoolId?: string;
  status?: string;
  /** When true, the "include staff-only fields" toggle is hidden and staff-only
   *  columns are never selectable. Defaults to false (i.e. admin). */
  isStaff?: boolean;
}

export default function ExportModal({
  open,
  onClose,
  formId,
  forms,
  schoolId,
  status,
  isStaff = false,
}: Props) {
  const [selectedFormId, setSelectedFormId] = useState(formId);
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [includeStaffOnly, setIncludeStaffOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (open) {
      setSelectedFormId(formId);
      setChecked(new Set());
      setIncludeStaffOnly(false);
      setError("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || !selectedFormId) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    api
      .exportPreview({
        form_id: Number(selectedFormId),
        school_id: schoolId ? Number(schoolId) : undefined,
        status: status || undefined,
      })
      .then((p) => {
        if (cancelled) return;
        setPreview(p);
        // Default: all non-staff-only columns checked
        setChecked(new Set(p.columns.filter((c) => !c.staff_only).map((c) => c.key)));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Could not load export preview");
        setPreview(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, selectedFormId, schoolId, status]);

  const availableColumns = useMemo(() => preview?.columns || [], [preview]);

  const toggleColumn = (key: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const toggleAll = () => {
    const all = availableColumns.map((c) => c.key);
    if (all.every((k) => checked.has(k))) setChecked(new Set());
    else setChecked(new Set(all));
  };

  const allChecked = availableColumns.length > 0 && availableColumns.every((c) => checked.has(c.key));

  const selectedColumns: ExportColumn[] = useMemo(
    () => availableColumns.filter((c) => checked.has(c.key)),
    [availableColumns, checked]
  );

  if (!open) return null;

  const handleExport = async () => {
    setExporting(true);
    setError("");
    try {
      const token = getToken();
      const qs = new URLSearchParams({ form_id: selectedFormId });
      if (schoolId) qs.set("school_id", schoolId);
      if (status) qs.set("status", status);
      if (includeStaffOnly) qs.set("include_staff_only", "1");

      const res = await fetch(`/api/export/csv?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        credentials: "include",
      });
      if (!res.ok) throw new ApiError(res.status, "Export failed");

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `submissions-export.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="drawer-overlay open" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>Export Submissions</h2>
          <button className="icon-button close" onClick={onClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="drawer-body">
          {forms.length > 1 && (
            <div className="filter-group" style={{ minWidth: 0, marginBottom: 16 }}>
              <label>Form</label>
              <select value={selectedFormId} onChange={(e) => setSelectedFormId(e.target.value)}>
                {forms.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.title}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="export-summary">
            <div className="stat">
              <b>{preview?.total ?? 0}</b>
              <span>Rows</span>
            </div>
            <div className="stat">
              <b>{preview?.columns.length ?? 0}</b>
              <span>Columns</span>
            </div>
          </div>

          {error && (
            <div
              style={{
                background: "rgb(255,232,234)",
                color: "rgb(186,48,64)",
                padding: "10px 12px",
                borderRadius: "var(--radius)",
                fontSize: 13,
                marginBottom: 14,
              }}
            >
              {error}
            </div>
          )}

          {loading ? (
            <div className="loading-state">
              <div className="spinner" /> Loading preview...
            </div>
          ) : (
            <>
              <h3
                style={{
                  fontSize: 13,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: "var(--text-muted)",
                  marginBottom: 8,
                  fontWeight: 700,
                }}
              >
                Select columns to export
              </h3>
              <div className="col-picker">
                <div className="cp-head">
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                    <input type="checkbox" checked={allChecked} onChange={toggleAll} />
                    Select all
                  </label>
                  <span>{selectedColumns.length} selected</span>
                </div>
                <div className="cp-grid">
                  {availableColumns.map((c) => (
                    <div
                      key={c.key}
                      className={`cp-item ${!checked.has(c.key) ? "dim" : ""}`}
                      onClick={() => toggleColumn(c.key)}
                    >
                      <input
                        type="checkbox"
                        checked={checked.has(c.key)}
                        onChange={() => toggleColumn(c.key)}
                      />
                      <span>{c.label}</span>
                      {c.staff_only && <span className="badge badge-slate tag">Staff</span>}
                    </div>
                  ))}
                </div>
              </div>

              {!isStaff && (
                <div className="file-note" style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 8 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={includeStaffOnly}
                      onChange={(e) => setIncludeStaffOnly(e.target.checked)}
                    />
                    Include staff-only fields
                  </label>
                </div>
              )}

              {preview && (
                <div className="export-preview" style={{ marginTop: 16 }}>
                  <h3>Preview</h3>
                  <div className="preview-table">
                    <table>
                      <thead>
                        <tr>
                          {selectedColumns.map((c) => (
                            <th key={c.key}>{c.label}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {preview.rows.slice(0, 8).map((r, i) => (
                          <tr key={i}>
                            {selectedColumns.map((c) => (
                              <td key={c.key}>{previewCell(r[c.key])}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="drawer-foot">
          <span className="file-note" style={{ marginTop: 0 }}>
            CSV will download as <code>submissions-export.csv</code>
          </span>
          <div className="spacer" />
          <button className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" onClick={handleExport} disabled={exporting || !selectedColumns.length}>
            {exporting ? "Exporting..." : "Export CSV"}
          </button>
        </div>
      </div>
    </div>
  );
}

function previewCell(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
