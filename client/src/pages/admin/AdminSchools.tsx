import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../lib/api";
import type { School, SchoolFacets, SchoolPage } from "../../types";
import { PageHead } from "../../components/layout";

const PAGE_SIZE = 50;

// Map a configured column label to a School field. Labels come from
// SCHOOL_TABLE_COLUMNS (e.g. "Name", "GradeLevel", "Calendar"); we normalize by
// stripping whitespace and lowercasing, then match known keys.
function valueFor(school: School, label: string): string {
  const key = label.replace(/\s+/g, "").toLowerCase();
  switch (key) {
    case "name":
      return school.name;
    case "gradelevel":
    case "grade":
      return school.grade_level ?? "";
    case "calendar":
      return school.calendar ?? "";
    case "district":
      return school.district ?? "";
    default:
      // Fall back to a raw props lookup by normalized key when available.
      const raw = (school as unknown as Record<string, unknown>)[key];
      return raw === null || raw === undefined ? "" : String(raw);
  }
}

export default function AdminSchools() {
  const [columns, setColumns] = useState<string[]>([]);
  const [page, setPage] = useState<SchoolPage | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  // Filter state (search text + two dropdowns). The dropdown options are the
  // distinct values from the DB, fetched once via /api/schools/facets.
  const [search, setSearch] = useState("");
  const [gradeLevel, setGradeLevel] = useState("");
  const [calendar, setCalendar] = useState("");
  const [facets, setFacets] = useState<SchoolFacets>({ gradeLevels: [], calendars: [] });

  const load = useCallback(
    async (pg = 1) => {
      setLoading(true);
      setError("");
      try {
        const data = await api.listSchoolsPage(pg, PAGE_SIZE, {
          search: search.trim() || undefined,
          gradeLevel: gradeLevel || undefined,
          calendar: calendar || undefined,
        });
        setPage(data);
        setCurrentPage(pg);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Could not load schools");
      } finally {
        setLoading(false);
      }
    },
    [search, gradeLevel, calendar]
  );

  // When any filter changes, reset to page 1 and reload. The text search is
  // debounced so we don't hit the API on every keystroke. Skips the initial
  // mount (the mount effect below already loads page 1).
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    const t = setTimeout(() => load(1), 350);
    return () => clearTimeout(t);
  }, [search, gradeLevel, calendar, load]);

  useEffect(() => {
    // Load the configured columns and dropdown facets, then page 1.
    api
      .listSchoolColumns()
      .then(({ columns }) => setColumns(columns))
      .catch(() => setColumns(["Name"]));
    api
      .listSchoolFacets()
      .then((f) => setFacets(f))
      .catch(() => setFacets({ gradeLevels: [], calendars: [] }));
    load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearFilters = () => {
    setSearch("");
    setGradeLevel("");
    setCalendar("");
  };

  const handleImport = async () => {
    setImporting(true);
    setMessage("");
    setError("");
    try {
      const { total } = await api.importSchools();
      setMessage(`Imported ${total} schools.`);
      await load(1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Import failed");
    } finally {
      setImporting(false);
    }
  };

  const totalPages = page?.totalPages ?? 0;
  const total = page?.total ?? 0;
  const rows = page?.rows ?? [];

  return (
    <div>
      <PageHead
        title="Schools"
        subtitle="Schools loaded from the district data source. Import is manual."
        actions={
          <button className="primary-button" onClick={handleImport} disabled={importing}>
            {importing ? "Importing..." : "Import Schools"}
          </button>
        }
      />

      {error && (
        <div className="alert-error" role="alert">
          {error}
        </div>
      )}
      {message && (
        <div className="alert-success" role="status">
          {message}
        </div>
      )}

      <div className="filter-bar">
        <div className="filter-group">
          <label htmlFor="school-search">Search</label>
          <input
            id="school-search"
            type="text"
            placeholder="Search name or district…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="filter-group">
          <label htmlFor="school-grade">Grade Level</label>
          <select
            id="school-grade"
            value={gradeLevel}
            onChange={(e) => setGradeLevel(e.target.value)}
          >
            <option value="">All grades</option>
            {facets.gradeLevels.map((g) => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
        </div>
        <div className="filter-group">
          <label htmlFor="school-calendar">Calendar</label>
          <select
            id="school-calendar"
            value={calendar}
            onChange={(e) => setCalendar(e.target.value)}
          >
            <option value="">All calendars</option>
            {facets.calendars.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        <div className="filter-spacer" />
        {(search || gradeLevel || calendar) && (
          <button className="clear" onClick={clearFilters} type="button">
            Clear
          </button>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h3>
            {total} school{total === 1 ? "" : "s"}
          </h3>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <table className="grid">
            <thead>
              <tr>
                {(columns.length ? columns : ["Name"]).map((label) => (
                  <th key={label}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={columns.length || 1} style={{ textAlign: "center", padding: 24 }}>
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={columns.length || 1} style={{ textAlign: "center", padding: 24 }}>
                    No schools yet. Click <strong>Import Schools</strong> to load data.
                  </td>
                </tr>
              ) : (
                rows.map((school) => (
                  <tr key={school.id}>
                    {(columns.length ? columns : ["Name"]).map((label) => (
                      <td key={label} data-label={label}>{valueFor(school, label)}</td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="card-foot" style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            className="secondary-button"
            disabled={loading || currentPage <= 1}
            onClick={() => load(currentPage - 1)}
          >
            ‹ Prev
          </button>
          <span style={{ fontSize: 13 }}>
            Page {currentPage} of {totalPages}
          </span>
          <button
            className="secondary-button"
            disabled={loading || currentPage >= totalPages}
            onClick={() => load(currentPage + 1)}
          >
            Next ›
          </button>
          <span style={{ fontSize: 13, marginLeft: "auto" }}>{total} total</span>
        </div>
      </div>
    </div>
  );
}
