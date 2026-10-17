import { useEffect, useState } from "react";
import { CheckCircle2, X } from "lucide-react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../context/AuthContext";
import type { FormAccessNotice } from "../types";

export function FormAccessNoticeBar() {
  const { user } = useAuth();
  const userId = user ? String(user.id) : "";
  const [result, setResult] = useState<{
    userId: string;
    notices: FormAccessNotice[];
    error: string | null;
  } | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [dismissError, setDismissError] = useState<{ id: number; text: string } | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (!userId) {
      setResult(null);
      return;
    }
    let cancelled = false;
    api
      .listFormAccessNotices()
      .then((notices) => {
        if (!cancelled) setResult({ userId, notices, error: null });
      })
      .catch((err) => {
        if (!cancelled) {
          setResult({
            userId,
            notices: [],
            error: err instanceof ApiError ? err.message : "Could not load form access notices.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [userId, retryCount]);

  const current = result?.userId === userId ? result : null;
  const dismiss = async (notice: FormAccessNotice) => {
    setBusyId(notice.event_id);
    setDismissError(null);
    try {
      await api.dismissFormAccessNotice(notice.event_id);
      setResult((state) =>
        state?.userId === userId
          ? { ...state, notices: state.notices.filter((row) => row.event_id !== notice.event_id) }
          : state
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setResult((state) =>
          state?.userId === userId
            ? { ...state, notices: state.notices.filter((row) => row.event_id !== notice.event_id) }
            : state
        );
      } else {
        setDismissError({
          id: notice.event_id,
          text: err instanceof ApiError ? err.message : "Could not close this notice.",
        });
      }
    } finally {
      setBusyId(null);
    }
  };

  if (!current) return null;
  if (current.error) {
    return (
      <div className="alert-error" role="alert">
        {current.error}
        <button
          type="button"
          className="secondary-button"
          style={{ marginLeft: 12 }}
          onClick={() => setRetryCount((count) => count + 1)}
        >
          Try again
        </button>
      </div>
    );
  }
  if (current.notices.length === 0) return null;

  return (
    <section className="sysmsg-stack" aria-label="New form access">
      {current.notices.map((notice) => (
        <article className="sysmsg" key={notice.event_id}>
          <span className="sysmsg-icon" aria-hidden="true">
            <CheckCircle2 size={16} />
          </span>
          <div className="sysmsg-text">
            <h2 className="sysmsg-title">You now have access to a form</h2>
            <p className="sysmsg-body">
              {notice.form_title} is now available to you.{" "}
              <Link to="/staff/forms">View available forms</Link>
            </p>
            {dismissError?.id === notice.event_id && (
              <p className="sysmsg-error" role="alert">
                {dismissError.text}
              </p>
            )}
          </div>
          <button
            type="button"
            className="icon-button sysmsg-close"
            title={`Close access notice for "${notice.form_title}"`}
            aria-label={`Close access notice for "${notice.form_title}"`}
            disabled={busyId === notice.event_id}
            onClick={() => void dismiss(notice)}
          >
            <X size={16} />
          </button>
        </article>
      ))}
    </section>
  );
}
