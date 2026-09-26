import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Pencil, Plus } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { SchoolDrawer } from "../../components/SchoolDrawer";
import type { School, SchoolFacets, SchoolPage } from "../../types";

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

// ---------------------------------------------------------------------------
// Schools panel
//
// The district school list, rendered inside a collapsible section on the
// Settings page. It deliberately renders no <PageHead> — the section header
// supplies the title and description — and every element is flush with the
// section body (`bodyStyle={{ padding: 0 }}`) so the toolbar, table, and pager
// read as one card instead of a card nested inside a card.
// ---------------------------------------------------------------------------
export default function SchoolsPanel() {
  const [columns, setColumns] = useState<string[]>([]);
  const [page, setPage] = useState<SchoolPage | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  // The Add/Edit drawer. `editing === null` with the drawer open means "add";
  // keeping the school object (rather than a bare id) avoids a second lookup and
  // lets the drawer show the stored values while the user types over them.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<School | null>(null);

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

  const openAdd = () => {
    setEditing(null);
    setMessage("");
    setError("");
    setDrawerOpen(true);
  };

  const openEdit = (school: School) => {
    setEditing(school);
    setMessage("");
    setError("");
    setDrawerOpen(true);
  };

  const handleSaved = async (saved: School) => {
    const wasEdit = editing !== null;
    setDrawerOpen(false);
    setEditing(null);
    setError("");
    setMessage(wasEdit ? `Saved "${saved.name}".` : `Added "${saved.name}".`);
    if (wasEdit) {
      // An edit can move the row (a rename re-sorts it) or push it out of the
      // active filter, so reload the page the reader is already on rather than
      // jumping them somewhere else.
      await load(currentPage);
    } else {
      // A new school lands in name order, which is not necessarily a page the
      // reader is looking at. Drop the filters and show page 1 — the debounced
      // filter effect re-runs off the cleared values, so this settles on the
      // unfiltered first page even though this call still sees the old filters.
      clearFilters();
      await load(1);
    }
  };

  const totalPages = page?.totalPages ?? 0;
  const total = page?.total ?? 0;
  const rows = page?.rows ?? [];

  return (
    <>
      {(error || message) && (
        <div style={{ padding: "14px 16px 0" }}>
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
        </div>
      )}

      {/* Filter toolbar. Reuses .filter-bar for its flex layout but drops the
          frame (top/left/right border + radius) so it sits flush inside the
          section, reading as the card's header row. */}
      <div
        className="filter-bar"
        style={{
          marginBottom: 0,
          borderTop: "none",
          borderLeft: "none",
          borderRight: "none",
          borderRadius: 0,
        }}
      >
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
        {/* The district feed was imported once, so the toolbar's job is now to
            add the few schools the feed does not carry — the ones a Google Form
            names but the list is missing. The server route for the feed import
            is untouched; only this button is gone. */}
        <button className="primary-button" onClick={openAdd} type="button">
          <Plus size={16} />
          <span>Add School</span>
        </button>
      </div>

      <table className="grid">
        <thead>
          <tr>
            {(columns.length ? columns : ["Name"]).map((label) => (
              <th key={label}>{label}</th>
            ))}
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={(columns.length || 1) + 1} style={{ textAlign: "center", padding: 24 }}>
                Loading…
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={(columns.length || 1) + 1} style={{ textAlign: "center", padding: 24 }}>
                No schools match. Click <strong>Add School</strong> to create one.
              </td>
            </tr>
          ) : (
            rows.map((school) => (
              <tr key={school.id}>
                {(columns.length ? columns : ["Name"]).map((label) => (
                  <td key={label} data-label={label}>{valueFor(school, label)}</td>
                ))}
                <td data-label="Actions">
                  <button
                    className="badge-button"
                    onClick={() => openEdit(school)}
                    title={`Edit ${school.name}`}
                  >
                    <Pencil size={12} />
                    <span>Edit</span>
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <div className="card-foot">
        <button
          className="secondary-button"
          disabled={loading || currentPage <= 1}
          onClick={() => load(currentPage - 1)}
        >
          <ChevronLeft size={16} />
          <span>Prev</span>
        </button>
        <span style={{ fontSize: 13 }}>
          Page {currentPage} of {totalPages}
        </span>
        <button
          className="secondary-button"
          disabled={loading || currentPage >= totalPages}
          onClick={() => load(currentPage + 1)}
        >
          <span>Next</span>
          <ChevronRight size={16} />
        </button>
        <span style={{ fontSize: 13, marginLeft: "auto" }}>{total} total</span>
      </div>

      <SchoolDrawer
        open={drawerOpen}
        school={editing}
        facets={facets}
        onClose={() => {
          setDrawerOpen(false);
          setEditing(null);
        }}
        onSaved={(saved) => void handleSaved(saved)}
      />
    </>
  );
}
