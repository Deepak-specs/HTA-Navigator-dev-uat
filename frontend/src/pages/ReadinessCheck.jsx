/**
 * ReadinessCheck.jsx — v2
 * -----------------------
 * Matches hta_navigator_redesign_5.html #v-ready exactly.
 *
 * Key v2 changes:
 *   • Readiness is scoped per search question (not just per session)
 *   • Question selector shows all questions under the session
 *   • Score card: big number, progress bar, breakdown (ready/needs-evidence/draft)
 *   • Precedent assessment: states it is not yet available
 *   • Recommended actions: reports review progress, claims no precedent
 *
 * Sr 90 (13 Oct) — removed the fabricated assessment. The gap table derived
 * three dossier scores arithmetically from the one readiness figure
 * (qReadiness − 26 / + 14 / − 10) and paired them with fixed strings asserting
 * what ZIN precedent expects; the recommended actions were three hardcoded
 * accordions with +14/+9/+6 point values; the subtitle claimed the question
 * had been "assessed against N comparable ZIN rulings". This page makes no
 * backend call, so none of it was computed from anything. Real assessment
 * the precedent assessment is fetched from POST /api/readiness/assess.
 *   • Session selector at top, session context sidebar
 *   • Export report button
 */
import { useMemo, useState, useCallback, useEffect, useRef } from "react";   
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  getAllSessions,
  getActiveSessionId,
  setActiveSessionId,
  computeQuestionReadiness,
  computeSessionReadiness,
  countScoredQuestions,
  toggleAnswerReviewed,
} from "../lib/sessionStore";
import { useSession } from "../lib/SessionContext";
import { toast } from "../lib/toast";
import { exportReadinessToPdf } from "../lib/readinessPdf";
import DownloadCloudIcon from "../components/DownloadCloudIcon";
import { assessReadiness, buildAnswersPayload } from "../lib/readinessApi";                   
import PrecedentAssessment, { RecommendedActions } from "../components/PrecedentAssessment";  

// ─── Score colour ─────────────────────────────────────────────────────────────
// scoreColor() lived here. Its only caller was the headline number, which now
// leads with the ready/total count instead. Red-amber-green on a review-progress
// figure reads as a verdict on the dossier, which the page cannot support — a
// half-reviewed question is not a failing one. Reintroduce it only against a
// score that genuinely grades something.

// scoreTag() lived here. Its only caller was the derived per-dossier gap
// table, which is gone; the assessment that replaces it will return its own
// scores and can reintroduce a tag then, against real values.

// ─── Accordion ────────────────────────────────────────────────────────────────
function Acc({ title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`v2-acc${open ? " open" : ""}`}>
      <button type="button" onClick={() => setOpen(o => !o)}>
        <span>{title}</span>
        <span>{open ? "−" : "+"}</span>
      </button>
      <div className="body">{children}</div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ReadinessCheck() {
  const navigate = useNavigate();
  const { refreshSessions } = useSession();

  const [searchParams] = useSearchParams();

  const requestedSessionId = searchParams.get("sessionId");
  const requestedQuestionId = searchParams.get("questionId");

  const [sessions, setSessions] = useState(() => getAllSessions());

  const [sessionId, setSessionId] = useState(() => {
    const initialSessions = getAllSessions();

    return (
      requestedSessionId ||
      getActiveSessionId() ||
      initialSessions[0]?.id ||
      ""
    );
  });

  const [questionId, setQuestionId] = useState(requestedQuestionId);

  useEffect(() => {
    if (requestedSessionId) {
      const sessionExists = sessions.some(
        (session) => session.id === requestedSessionId
      );

      if (sessionExists) {
        setSessionId(requestedSessionId);
      }
    }

    if (requestedQuestionId) {
      const requestedQuestionExists = sessions.some((session) =>
        session.questions?.some(
          (question) => question.id === requestedQuestionId
        )
      );

      if (requestedQuestionExists) {
        setQuestionId(requestedQuestionId);
      }
    }
  }, [
    requestedSessionId,
    requestedQuestionId,
    sessions,
  ]);

  const session = useMemo(
    () => sessions.find((s) => s.id === sessionId) || null,
    [sessions, sessionId]
  );

  const questions = session?.questions ?? [];

  const question = useMemo(
    () => questions.find((q) => q.id === questionId) || questions[0] || null,
    [questions, questionId]
  );

  const refresh = useCallback(() => {
    setSessions(getAllSessions());
    refreshSessions();
  }, [refreshSessions]);

  const handleToggle = (qaId) => {
    if (!session || !question) return;
    toggleAnswerReviewed(session.id, question.id, qaId);
    refresh();
  };

  const handleExport = () => {
  if (!session || !question) {
    toast("Select a session and question to export.");
    return;
  }
  try {
    exportReadinessToPdf({
      session,
      question,
      questionNo: questions.indexOf(question) + 1,
      qReadiness,
      sReadiness,
      scoredQs,
    });
    toast("Readiness report exported.");
  } catch (err) {
    console.error("Readiness PDF export failed:", err);
    toast("Could not export the report.");
    }
  };

  // Readiness numbers
  const qReadiness = question ? computeQuestionReadiness(question) : 0;
  const sReadiness = session  ? computeSessionReadiness(session)   : 0;
  const scoredQs   = session  ? countScoredQuestions(session)      : 0;
  const qaList = question?.generatedQA ?? [];
  const ready   = qaList.filter(a => a.reviewed || a.status === "ready").length;
  const needsEv = qaList.filter(a => a.status === "needs_evidence").length;
  const draft   = qaList.length - ready - needsEv;
  const exportDisabled = !question || qaList.length === 0;

  // ── Precedent assessment state (per session+question, kept in memory) ──────
  const [assessments, setAssessments] = useState({});
  const [assessLoading, setAssessLoading] = useState(false);
  const [assessError, setAssessError] = useState("");
  const abortRef = useRef(null);

  const assessKey = session && question ? `${session.id}::${question.id}` : null;
  const current = assessKey ? assessments[assessKey] : null;
  const assessment = current?.result || null;

  // Signature of everything the assessment depends on. If it changes after a
  // run, the stored result is flagged stale instead of silently shown as current.
  const answersSignature = useMemo(
    () =>
      JSON.stringify(
        qaList.map((a) => [a.id, a.answer || "", a.reviewed ? 1 : 0, a.status || ""])
      ),
    [qaList]
  );
  const isStale = !!current && current.signature !== answersSignature;

  const hasAnswerText = qaList.some((a) => (a.answer || "").trim());
  const assessDisabled = !question || qaList.length === 0 || !hasAnswerText;
  const assessDisabledReason = !question
    ? "Select a question first."
    : qaList.length === 0
    ? "Generate Q&A for this question first."
    : !hasAnswerText
    ? "Draft at least one answer before running the assessment."
    : "";

  const runAssessment = useCallback(async () => {
    if (!session || !question || assessDisabled) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setAssessLoading(true);
    setAssessError("");
    const key = `${session.id}::${question.id}`;
    const signature = answersSignature;

    try {
      const result = await assessReadiness(
        {
          question: question.query,
          session_name: session.drugName,
          therapy_area: session.therapyArea || "",
          context: session.context || session.indication || "",
          ruling_ids: question.rulingIds || [],
          answers: buildAnswersPayload(question.generatedQA),
        },
        { signal: controller.signal }
      );
      setAssessments((prev) => ({ ...prev, [key]: { result, signature } }));
    } catch (err) {
      if (err.name === "AbortError") return;
      console.error("Precedent assessment failed:", err);
      setAssessError(err.message || "Something went wrong.");
      toast("Precedent assessment failed.");
    } finally {
      if (abortRef.current === controller) setAssessLoading(false);
    }
  }, [session, question, assessDisabled, answersSignature]);

  // Cancel any in-flight request when the user switches question or leaves.
  useEffect(() => {
    setAssessError("");
    setAssessLoading(false);
    return () => abortRef.current?.abort();
  }, [assessKey]);

  const goToQA = () => {
    if (session?.id) setActiveSessionId(session.id);  navigate("/qa-generator", {
    state: {
      from: "readiness",
      sessionId: session?.id,
      questionId: question?.id,
      query: question?.query,
      rulingIds: question?.rulingIds || [],
      dossierReview: question?.dossierReview || null,
      disableGeneration: true,
    },
  });
};

const goToNext = () =>
  setQuestionId(questions[(questions.indexOf(question) + 1) % questions.length]?.id);

// assessment = current?.result || null;

  // ── Empty state ────────────────────────────────────────────────────────────
  if (sessions.length === 0) {
    return (
      <div data-testid="readiness-page">
        <div className="v2-crumb">Prepare / Readiness check</div>
        <h1>Readiness Check</h1>
        <div className="v2-card v2-pad">
          <p style={{ margin: 0, color: "var(--muted)", fontSize: 13.5 }}>
            No sessions yet — start one from the session bar, save a search question under it from{" "}
            <Link to="/search">Ruling Search</Link>, then generate Q&amp;A before checking readiness here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="readiness-page">
      <div className="v2-crumb">Prepare / Readiness check</div>

      {/* ── Question selector header card ──────────────────────────── */}
      <div className="v2-card v2-pad" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14, flexWrap: "wrap" }}>

          {/* Session info */}
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 4 }}>Session</div>
            <select
              className="v2-sel"
              style={{ width: "100%", marginBottom: 8 }}
              value={sessionId}
              onChange={(e) => { setSessionId(e.target.value); setQuestionId(null); }}
              data-testid="readiness-session-select"
            >
              {sessions.map(s => (
                <option key={s.id} value={s.id}>{s.drugName} {s.status === "completed" ? "(completed)" : ""}</option>
              ))}
            </select>
            {session && (
              <div style={{ fontSize: 12, color: "var(--muted)" }}>
                {[session.therapyArea, session.dossierType].filter(Boolean).join(" · ")}
              </div>
            )}
          </div>

          {/* Question picker */}
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 5 }}>Readiness is shown for</div>
            {questions.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--muted)" }}>
                No questions under this session yet. Save a search from <Link to="/search">Ruling Search</Link>.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {questions.map((q, idx) => {
                  const qR = computeQuestionReadiness(q);
                  const sel = q.id === (question?.id);
                  return (
                    <button
                      key={q.id}
                      className="v2-pick"
                      style={{ padding: "9px 11px", margin: 0, opacity: sel ? 1 : .75 }}
                      type="button"
                      onClick={() => setQuestionId(q.id)}
                    >
                      <div style={{ width: 20, height: 20, borderRadius: "50%", background: sel ? "var(--magenta)" : "var(--indigo)", color: "#fff", fontSize: 9.5, fontWeight: 700, display: "grid", placeItems: "center", flexShrink: 0 }}>
                        Q{idx + 1}
                      </div>
                      <div style={{ flex: 1, textAlign: "left" }}>
                        <b style={{ fontSize: 12.5 }}>"{q.query}"</b>
                        <div style={{ fontSize: 11, color: "var(--muted)" }}>
                          {q.generatedQA.length} questions · {q.generatedQA.filter(a => a.reviewed).length} ready · Q{idx + 1} readiness {qR}%
                        </div>
                      </div>
                      <span className={`v2-tag ${sel ? "v2-t-cond" : "v2-t-rev"}`} style={{ fontSize: 11 }}>
                        {sel ? "Selected" : "Switch"}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Actions */}
          <div style={{ display: "flex", gap: 7, alignItems: "flex-start", flexWrap: "wrap" }}>
            <button className={`v2-btn v2-ghost ${exportDisabled ? "v2-locked" : ""}`} type="button" onClick={handleExport} disabled={exportDisabled} aria-disabled={exportDisabled} title={
    exportDisabled
      ? "Export is unavailable until Q&A has been generated for this question."
      : undefined
  } style={{
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    ...(exportDisabled
      ? { cursor: "default", pointerEvents: "none", opacity: 0.45, filter: "grayscale(0.25)" }
      : {}),
  }} data-testid="readiness-export-btn" > 
              <DownloadCloudIcon size={18} />Export report</button>
            <button className="v2-btn v2-ghost" type="button" onClick={() => navigate("/sessions")}>Back to session</button>
          </div>
        </div>
      </div>

      {/* ── Disclaimer ─────────────────────────────────────────────── */}
      <div className="v2-banner">
        <span>◈</span>
        <div>
          The <b>review progress</b> count reflects only the answers you have marked as ready. The{" "}
          <b>precedent assessment</b> is a separate, model-generated alignment estimate of how closely your answers align with published ZIN rulings. It is intended as guidance rather than a prediction of the committee's decision, so we kindly recommend verifying each citation before relying on it.
        </div>
      </div>

      {/* ── No question ──────────────────────────────────────────────── */}
      {!question && (
        <div className="v2-card v2-pad">
          <p style={{ margin: 0, color: "var(--muted)", fontSize: 13.5 }}>
            This session has no saved search questions yet. Save one from{" "}
            <Link to="/search">Ruling Search</Link> while it's the active session.
          </p>
        </div>
      )}

      {/* ── Readiness content ─────────────────────────────────────────── */}
      {question && (
        <>
          <div className="v2-hdr" style={{ marginBottom: 10 }}>
            <div>
              <h1>Readiness for Question {questions.indexOf(question) + 1}</h1>
              <p className="v2-sub" style={{ margin: 0 }}>
																			   
																				
																			 
											 
                "{question.query}" · {question.generatedQA.length} generated question{question.generatedQA.length !== 1 ? "s" : ""}
                {(question.rulingIds?.length ?? 0) > 0 &&
                  ` · ${question.rulingIds.length} ruling${question.rulingIds.length !== 1 ? "s" : ""} saved to this question`}
              </p>
            </div>
          </div>

          {/* ── Score row ─────────────────────────────────────────────── */}
          <div className="v2-row" style={{ marginBottom: 16 }}>

            {/* Score card */}
            <div className="v2-card v2-pad" style={{ flex: "0 0 230px", textAlign: "center" }}>
              {qaList.length === 0 ? (
                <>
                  <div className="v2-rdy-score" style={{ color: "var(--muted)" }}>—</div>
                  <div style={{ fontSize: 12.5, color: "var(--muted)" }}>no answers generated yet</div>
                </>
              ) : (
                <>
                  <div className="v2-rdy-score" style={{ color: "var(--ink)" }}>
                    {ready}
                    <span style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-1px", color: "var(--muted)" }}>
                      {" / "}{qaList.length}
                    </span>
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 12 }}>
                    answers reviewed and marked ready
                  </div>
                  <div className="v2-progress"><i style={{ width: `${qReadiness}%` }} /></div>
                  <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 7 }}>
                    {qReadiness}% · Q{questions.indexOf(question) + 1} review progress
                  </div>
                </>
              )}

              {needsEv > 0 && (
                <div style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 12, textAlign: "left", lineHeight: 1.5 }}>
                  {needsEv} answer{needsEv !== 1 ? "s" : ""} need evidence attached.
                </div>
              )}

			{assessment?.overall?.score != null && (
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--line)", textAlign: "left" }}>
        <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".07em", fontWeight: 700 }}>
          Precedent alignment{isStale ? " (stale)" : ""}
        </div>
        <div style={{ fontSize: 28, fontWeight: 750, letterSpacing: "-1px" }}>
          {assessment.overall.score}%
        </div>
        <div style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.5 }}>
          {assessment.headline}
        </div>
      </div>
    )}

              <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--line)", fontSize: 11.5 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                  <span style={{ color: "var(--muted)" }}>Ready</span>
                  <b style={{ color: "var(--pos)" }}>{ready}</b>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                  <span style={{ color: "var(--muted)" }}>Needs evidence</span>
                  <b style={{ color: "var(--neg)" }}>{needsEv}</b>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--muted)" }}>Draft / not started</span>
                  <b style={{ color: "var(--muted)" }}>{draft}</b>
                </div>
                <div style={{ height: 1, background: "var(--line)", margin: "14px 0" }} />
                <div style={{ fontSize: 20, fontWeight: 700 }}>{sReadiness}%</div>
                <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
                  {scoredQs === 0
                    ? "session overall — no answers generated yet"
                    : `session overall (avg of ${scoredQs} question${scoredQs === 1 ? "" : "s"} with generated answers)`}
                </div>
              </div>
            </div>

            <PrecedentAssessment
              result={assessment}
              loading={assessLoading}
              error={assessError}
              stale={isStale}
              disabled={assessDisabled}
              disabledReason={assessDisabledReason}
              onRun={runAssessment}
            />
          </div>

          {/* ── Recommended actions ─────────────────────────────────── */}
          <RecommendedActions
            result={assessment}
            loading={assessLoading}
            onGoToQA={goToQA}
            onNext={goToNext}
            hasNext={questions.length > 1}
            fallback={
              qaList.length === 0
                ? "No Q&A has been generated for this question yet, so there is nothing to review. Generate it in the Q&A generator first."
                : needsEv > 0
                ? `${needsEv} answer${needsEv !== 1 ? "s are" : " is"} marked "needs evidence". Run the precedent assessment to see ranked, ruling-backed actions.`
                : "Run the precedent assessment to get ranked, ruling-backed actions."
            }
          />

          {/* ── QA checklist ─────────────────────────────────────────── */}
          <div className="v2-card">
            <div style={{ padding: "13px 16px", borderBottom: "1px solid var(--line)" }}>
              <h3 style={{ margin: 0 }}>Generated Q&amp;A — mark each answer reviewed</h3>
            </div>
            {qaList.length === 0 && (
              <div className="v2-pad" style={{ fontSize: 13, color: "var(--muted)" }}>
                No Q&amp;A generated for this question yet — use the <Link to="/qa-generator">Q&amp;A Generator</Link>.
              </div>
            )}
            {qaList.map((qa) => (
              <label
                key={qa.id}
                style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "12px 16px", borderBottom: "1px solid var(--line)", cursor: "pointer" }}
              >
                <input
                  type="checkbox"
                  checked={!!qa.reviewed}
                  onChange={() => handleToggle(qa.id)}
                  style={{ marginTop: 3 }}
                  data-testid={`qa-reviewed-${qa.id}`}
                />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{qa.question}</div>
                  <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 3 }}>
                    {qa.answer || <em style={{ color: "var(--muted)" }}>No answer drafted yet</em>}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
