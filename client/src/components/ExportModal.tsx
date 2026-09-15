import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { api, getToken, ApiError } from "../lib/api";
import ColumnsPicker, { cellText } from "./ColumnsPicker";
import type { ExportColumn, ExportPreview, Form } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  formId: string;
  forms: Form[];
  schoolId?: string;
  status?: string;
  /** When true the caller is a staff member: the CSV request is not marked as
   *  including staff-only fields, and the server scopes the export to their own
   *  school. Defaults to false (i.e. admin). */
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (open) {
      setSelectedFormId(formId);
      setChecked(new Set());
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
        // Default: every column ticked, staff-only fields included. The server
        // only ever returns staff-only columns the caller is allowed to see, so
        // this cannot reveal one to staff.
        setChecked(new Set(p.columns.map((c) => c.key)));
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
      // Staff-only fields are included by default. The server ignores the flag for
      // staff, who only ever receive the staff-only columns their role grants.
      if (!isStaff) qs.set("include_staff_only", "1");

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
            <X size={18} />
          </button>
        </div>

        <div className="drawer-body">
          {forms.length > 1 && (
            <div className="filter-group" style={{ minWidth: 0, marginBottom: 16 }}>
              <label>Form</label>
              <select value={selectedFormId} onChange={(e) => setSelectedFormId(e.target.value)}>
                {forms
                  .filter((f) => f.status === "published")
                  .map((f) => (
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
              <ColumnsPicker
                columns={availableColumns}
                checked={checked}
                onToggle={toggleColumn}
                onToggleAll={toggleAll}
                heading="Select columns to export"
              />

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
                              <td key={c.key}>{cellText(r[c.key])}</td>
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

