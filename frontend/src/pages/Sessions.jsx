/**
 * Sessions.jsx — v2
 * -----------------
 * "My sessions" page — matches the HTML prototype #v-subs exactly.
 * Three-level hierarchy: Session → Search question → Generated Q&A + readiness.
 * In-progress and completed sessions shown in separate sections.
 *
 * Delete flow: "Delete" enters a per-session delete mode with checkboxes on the
 * session and on each question, and the button becomes "Confirm delete".
 *   - Some (not all) questions ticked  -> confirm, then remove only those questions.
 *   - All questions or the session box -> confirm, then remove the whole session.
 *   - The session box and the question boxes always stay in sync.
 */
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Trash2 } from "lucide-react";
import {
  getAllSessions,
  computeSessionReadiness,
  computeQuestionReadiness,
  deleteSession,
  deleteQuestions,
  markSessionCompleted,
  setActiveSessionId,
  getActiveSessionId,
} from "../lib/sessionStore";
import { useSession } from "../lib/SessionContext";
import { toast } from "../lib/toast";

function readinessColor(pct) {
  if (pct >= 70) return "var(--pos)";
  if (pct >= 40) return "var(--cond)";
  return "var(--neg)";
}

function readinessTag(pct) {
  const color = readinessColor(pct);
  return <b style={{ color }}>{pct}%</b>;
}

export default function Sessions() {
  const navigate = useNavigate();
  const { refreshSessions } = useSession();

  const [sessions,  setSessions]  = useState(() => getAllSessions());
  const [openIds,   setOpenIds]   = useState({});
  // Delete mode, per session: { [sessionId]: true }
  const [deleteMode, setDeleteMode] = useState({});
  // Selected question ids, per session: { [sessionId]: string[] }
  const [selected,   setSelected]   = useState({});
  // A session with no questions has nothing to tick, so its own checkbox is
  // tracked separately: { [sessionId]: true }
  const [emptySessionChecked, setEmptySessionChecked] = useState({});
  const activeId = getActiveSessionId();

  const refresh = () => {
    setSessions(getAllSessions());
    refreshSessions();
  };

  const toggleOpen = (id) =>
    setOpenIds((prev) => ({ ...prev, [id]: !prev[id] }));

  // ── Delete-mode helpers ────────────────────────────────────────────────
  const exitDeleteMode = (sessionId) => {
    setDeleteMode((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    setSelected((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    setEmptySessionChecked((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  };

  const enterDeleteMode = (sessionId) => {
    setDeleteMode((prev) => ({ ...prev, [sessionId]: true }));
    setSelected((prev) => ({ ...prev, [sessionId]: [] }));
    setEmptySessionChecked((prev) => ({ ...prev, [sessionId]: false }));
  };

  const toggleQuestion = (sessionId, qId) =>
    setSelected((prev) => {
      const current = prev[sessionId] || [];
      const next = current.includes(qId)
        ? current.filter((x) => x !== qId)
        : [...current, qId];
      return { ...prev, [sessionId]: next };
    });

  // Ticking the session box selects every question; unticking clears them all.
  const toggleSessionBox = (session) => {
    const allIds = session.questions.map((q) => q.id);
    if (allIds.length === 0) {
      setEmptySessionChecked((prev) => ({ ...prev, [session.id]: !prev[session.id] }));
      return;
    }
    setSelected((prev) => {
      const current = prev[session.id] || [];
      const allSelected = allIds.every((id) => current.includes(id));
      return { ...prev, [session.id]: allSelected ? [] : allIds };
    });
  };

  // ── Deletion ───────────────────────────────────────────────────────────
  const handleDelete = (id, name) => {
    if (!window.confirm(`Delete session "${name}"? This can't be undone.`)) return;
    deleteSession(id);
    exitDeleteMode(id);
    refresh();
    toast(`Deleted session "${name}"`);
  };

  const handleDeleteQuestions = (session, ids) => {
    const n = ids.length;
    if (!window.confirm(
      `Delete ${n} search question${n !== 1 ? "s" : ""} from "${session.drugName}"? This can't be undone.`
    )) return;

    // deleteQuestions reports whether the write actually reached storage, so
    // the UI never claims a deletion that was not saved.
    const ok = deleteQuestions(session.id, ids);
    if (!ok) {
      toast("Could not delete the selected questions. Browser storage may be full or unavailable.");
      return;
    }

    exitDeleteMode(session.id);
    refresh();
    toast(`Deleted ${n} question${n !== 1 ? "s" : ""}`);
  };

  const handleConfirmDelete = (session) => {
    const allIds      = session.questions.map((q) => q.id);
    const selectedIds = (selected[session.id] || []).filter((id) => allIds.includes(id));

    // Session with no questions: only its own checkbox can be ticked.
    if (allIds.length === 0) {
      if (!emptySessionChecked[session.id]) {
        toast("Select the session to delete.");
        return;
      }
      handleDelete(session.id, session.drugName);
      return;
    }

    if (selectedIds.length === 0) {
      toast("Select at least one question or the session to delete.");
      return;
    }

    // Every question selected (equivalent to the session box being ticked):
    // existing whole-session behaviour.
    if (selectedIds.length === allIds.length) {
      handleDelete(session.id, session.drugName);
      return;
    }

    // Some, but not all, questions selected.
    handleDeleteQuestions(session, selectedIds);
  };

  const handleComplete = (id) => {
    markSessionCompleted(id);
    refresh();
    toast("Session marked completed");
  };

  const handleMakeActive = (id) => {
    setActiveSessionId(id);
    refresh();
    toast("Session set as active");
  };

  const inProgress = sessions.filter((s) => s.status !== "completed");
  const completed  = sessions.filter((s) => s.status === "completed");

  const SessionRow = ({ session }) => {
    const readiness    = computeSessionReadiness(session);
    const isOpen       = !!openIds[session.id];
    const isActive     = session.id === activeId;
    const inDeleteMode = !!deleteMode[session.id];

    const questionIds = session.questions.map((q) => q.id);
    const selectedIds = selected[session.id] || [];
    // Derived, never stored: the session box is checked exactly when every
    // question is checked, so the two cannot drift apart.
    const allSelected = questionIds.length > 0
      ? questionIds.every((id) => selectedIds.includes(id))
      : !!emptySessionChecked[session.id];

    return (
      <div className="v2-card" style={{ marginBottom: 6 }} data-testid={`session-row-${session.id}`}>
        {/* ── Session header ──────────────────────────────────────── */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", background: "#FAF9FC", flexWrap: "wrap", borderBottom: isOpen ? "1px solid var(--line)" : "none" }}>
          {inDeleteMode && (
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() => toggleSessionBox(session)}
              aria-label={`Select session ${session.drugName}`}
              data-testid={`session-checkbox-${session.id}`}
              style={{ width: 16, height: 16, cursor: "pointer", flex: "0 0 auto" }}
            />
          )}
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
              <b style={{ fontSize: 14.5 }}>{session.drugName}</b>
              {isActive && <span className="v2-tag v2-t-rev">Active</span>}
              {session.status === "completed"
                ? <span className="v2-tag v2-t-pos">✓ Completed</span>
                : <span className="v2-tag v2-t-cond">◑ In progress</span>
              }
            </div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
              {[session.therapyArea, session.dossierType].filter(Boolean).join(" · ")}
              {" "}·{" "}{session.questions.length} search question{session.questions.length !== 1 ? "s" : ""}
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5, flexWrap: "wrap" }}>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3, gap: 10 }}>
                <span style={{ color: "var(--muted)" }}>
                  {session.status === "completed" ? "Final readiness" : "Overall readiness"}
                </span>
                {readinessTag(readiness)}
              </div>
              <div className="v2-progress" style={{ width: 120 }}>
                <i style={{ width: `${readiness}%` }} />
              </div>
            </div>
            <button className="v2-btn v2-ghost v2-sm" type="button" onClick={() => toggleOpen(session.id)}>
              {isOpen ? "▴ Collapse" : "▾ Expand questions"}
            </button>
          </div>
        </div>

        {/* ── Expanded: child questions ────────────────────────────── */}
        {isOpen && (
          <div>
            {/* Action row */}
            <div style={{ display: "flex", gap: 8, padding: "10px 16px 10px 40px", flexWrap: "wrap", borderBottom: "1px solid var(--line)", background: "#FBFAFD" }}>
              {!isActive && session.status !== "completed" && (
                <button className="v2-btn v2-ghost v2-sm" type="button" onClick={() => handleMakeActive(session.id)}>Make active</button>
              )}
              {session.status !== "completed" && (
                <button className="v2-btn v2-ghost v2-sm" type="button" onClick={() => handleComplete(session.id)}>Mark completed</button>
              )}
              {session.status === "completed" && (
                <button className="v2-btn v2-ghost v2-sm" type="button" onClick={() => handleMakeActive(session.id)}>Reopen</button>
              )}

              <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
                {inDeleteMode && (
                  <button
                    className="v2-btn v2-ghost v2-sm"
                    type="button"
                    onClick={() => exitDeleteMode(session.id)}
                    data-testid={`session-delete-cancel-${session.id}`}
                  >
                    Cancel
                  </button>
                )}
                <button
                  className="v2-btn v2-ghost v2-sm"
                  type="button"
                  onClick={() =>
                    inDeleteMode ? handleConfirmDelete(session) : enterDeleteMode(session.id)
                  }
                  style={{ color: "var(--neg)", display: "flex", alignItems: "center", gap: 5 }}
                  data-testid={`session-delete-btn-${session.id}`}
                >
                  <Trash2 size={13} /> {inDeleteMode ? "Confirm delete" : "Delete"}
                </button>
              </div>
            </div>

            {/* Questions */}
            {session.questions.length === 0 && (
              <div style={{ padding: "12px 16px 12px 40px", fontSize: 13, color: "var(--muted)" }}>
                No search questions saved under this session yet. Save a search from{" "}
                <Link to="/search">Ruling Search</Link> while this session is active.
              </div>
            )}

            {session.questions.map((q, idx) => {
              const qReadiness = computeQuestionReadiness(q);
              return (
                <div key={q.id} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "12px 16px 12px 40px", borderBottom: "1px solid var(--line)", background: "#FDFCFF", flexWrap: "wrap" }}>
                  {inDeleteMode && (
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(q.id)}
                      onChange={() => toggleQuestion(session.id, q.id)}
                      aria-label={`Select Q${idx + 1}`}
                      data-testid={`question-checkbox-${q.id}`}
                      style={{ width: 16, height: 16, marginTop: 3, cursor: "pointer", flex: "0 0 auto" }}
                    />
                  )}
                  <div style={{ flexShrink: 0, width: 22, height: 22, borderRadius: "50%", background: "var(--indigo)", color: "#fff", fontSize: 10, fontWeight: 700, display: "grid", placeItems: "center", marginTop: 1 }}>Q{idx + 1}</div>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <b style={{ fontSize: 13 }}>"{q.query}"</b>
                    <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 2 }}>
                      {q.rulingIds?.length ?? 0} rulings · {q.generatedQA.length} generated ·{" "}
                      {q.generatedQA.filter((a) => a.reviewed).length} reviewed
                    </div>
                    <div style={{ marginTop: 7, display: "flex", gap: 7, flexWrap: "wrap" }}>
                      <span className="v2-chip">{q.generatedQA.length} questions generated</span>
                      <span className="v2-chip v2-t-pos" style={{ background: "var(--pos-bg)", color: "var(--pos)" }}>
                        {q.generatedQA.filter(a => a.reviewed).length} of {q.generatedQA.length} ready
                      </span>
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 7, minWidth: 130 }}>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3, gap: 10 }}>
                        <span style={{ fontSize: 12, color: "var(--muted)" }}>Q{idx + 1} readiness</span>
                        <b style={{ fontSize: 12 }}>{qReadiness}%</b>
                      </div>
                      <div className="v2-progress" style={{ width: 110 }}>
                        <i style={{ width: `${qReadiness}%` }} />
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <Link to="/qa-generator" state={{
                        from: "sessions",
                        sessionId: session.id,
                        questionId: q.id,
                        query: q.query,
                        rulingIds: q.rulingIds || [],
                        dossierReview: q.dossierReview || null,
                      }}
                        className="v2-btn v2-ghost v2-sm">Open Q&amp;A</Link>
                      <Link to={`/readiness?sessionId=${encodeURIComponent(session.id)}&questionId=${encodeURIComponent(q.id)}`} className="v2-btn v2-sm v2-mag">Readiness</Link>
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Add-question CTA footer */}
            <div style={{ padding: "10px 16px 10px 40px", background: "#F6F5F9", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, color: "var(--muted)" }}>
                Ask another research question about this drug in Ruling Search and it will appear here automatically.
              </span>
              <button className="v2-btn v2-ghost v2-sm" type="button" onClick={() => navigate("/search")}>
                Go to Ruling Search →
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div data-testid="sessions-page">
      <div className="v2-crumb">Home / My sessions</div>
      <div className="v2-hdr">
        <div>
          <h1>My sessions</h1>
          <p className="v2-sub" style={{ margin: 0 }}>
            Each session is anchored to a drug. Under it sit the search questions you asked in Ruling Search; under each question sit its generated Q&amp;A set and readiness score.
          </p>
        </div>
        <button className="v2-btn v2-mag" type="button" onClick={() => navigate("/")}>Start a session</button>
      </div>

      {/* ── Tabs ──────────────────────────────────────────────────── */}
      <div className="v2-tabs">
        <button type="button" onClick={() => navigate("/")}>Overview</button>
        <button className="on" type="button">My sessions</button>
      </div>

      {sessions.length === 0 && (
        <div className="v2-card v2-pad" data-testid="sessions-empty">
          <p style={{ margin: 0, color: "var(--muted)", fontSize: 13.5 }}>
            No sessions yet. Use the session bar at the top of any page to start one, then save a search from{" "}
            <Link to="/search">Ruling Search</Link> under it.
          </p>
        </div>
      )}

      {inProgress.length > 0 && (
        <>
          <h2>In progress</h2>
          {inProgress.map((s) => <SessionRow key={s.id} session={s} />)}
        </>
      )}

      {completed.length > 0 && (
        <>
          <h2 style={{ marginTop: 20 }}>Completed</h2>
          {completed.map((s) => <SessionRow key={s.id} session={s} />)}
          <div className="v2-banner" style={{ marginTop: 14 }}>
            <span>◈</span>
            <div>Completed sessions stay in full. Reopen one to use its search questions and answers as a starting point for a new indication or a follow-up filing.</div>
          </div>
        </>
      )}
    </div>
  );
}