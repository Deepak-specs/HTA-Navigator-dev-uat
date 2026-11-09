// src/components/PrecedentAssessment.jsx
import { useState } from "react";
import { Link } from "react-router-dom";

const BAND_TAG = {
  strong: { cls: "v2-t-pos", icon: "✓" },
  partial: { cls: "v2-t-cond", icon: "◑" },
  weak: { cls: "v2-t-neg", icon: "✕" },
  not_assessed: { cls: "v2-t-rev", icon: "–" },
};

const CONF_LABEL = {
  high: "High confidence",
  moderate: "Moderate confidence",
  low: "Low confidence",
};

function ScoreTag({ score, band, answers }) {
  const t = BAND_TAG[band] || BAND_TAG.not_assessed;
  return (
    <span
      className={`v2-tag ${t.cls}`}
      title={answers ? `${answers.ready} of ${answers.total} answers marked Ready` : undefined}
    >
      {t.icon} {score == null ? "n/a" : `${score}%`}
    </span>
  );
}

function CiteChips({ citations = [] }) {
  if (!citations.length) return null;
  return (
    <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", marginLeft: 6 }}>
      {citations.map((c) => (
        <Link
          key={c.ruling_id || c.title}
          className="v2-chip v2-cite"
          // TODO: point this at however your app opens a ruling detail.
          to={c.ruling_id ? `/search?ruling=${encodeURIComponent(c.ruling_id)}` : "/search"}
          title={c.outcome ? `${c.title} — ${c.outcome}` : c.title}
        >
          {c.title}
          {c.year ? ` ${c.year}` : ""}
        </Link>
      ))}
    </span>
  );
}

function ActionAcc({ action, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`v2-acc${open ? " open" : ""}`}>
      <button type="button" onClick={() => setOpen((o) => !o)}>
        <span>
          {action.rank}. {action.title}
          {action.dossier_name && (
            <span className="v2-chip" style={{ marginLeft: 8 }}>
              {action.dossier_name}
            </span>
          )}
          {/* {action.impact_points > 0 && (
            <span
              className={`v2-tag ${action.impact_points >= 12 ? "v2-t-neg" : "v2-t-cond"}`}
              style={{ marginLeft: 6 }}
              title="Estimated readiness points gained. An estimate, not a measurement."
            >
              +{action.impact_points} pts
            </span>
          )} */}
        </span>
        <span>{open ? "−" : "+"}</span>
      </button>
      <div className="body">
        {action.detail}
        {action.answer_ids?.length > 0 && (
          <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 6 }}>
            Affects answers: {action.answer_ids.join(", ")}
          </div>
        )}
        <CiteChips citations={action.citations} />
      </div>
    </div>
  );
}

/* ── Assessment table panel (sits in the score row) ─────────────────────── */
export default function PrecedentAssessment({
  result,
  loading,
  error,
  stale,
  disabled,
  disabledReason,
  onRun,
}) {
  let content;

  if (loading) {
    content = (
      <div data-testid="precedent-loading" style={{ fontSize: 13, color: "var(--ink-2)" }}>
        <b>Assessing against precedent…</b>
        <div style={{ color: "var(--muted)", marginTop: 6 }}>
          Selecting comparable rulings and scoring each dossier.
        </div>
      </div>
    );
  } else if (error) {
    content = (
      <div data-testid="precedent-error">
        <div className="v2-banner" style={{ marginBottom: 10 }}>
          <span>⚠</span>
          <div>
            <b>Assessment could not be completed.</b> {error}
          </div>
        </div>
        <button className="v2-btn v2-mag v2-sm" type="button" onClick={onRun}>
          Try again
        </button>
      </div>
    );
  } else if (!result) {
    content = (
      <div data-testid="precedent-idle">
        <h3 style={{ marginTop: 0, marginBottom: 6 }}>Precedent assessment</h3>
        <div style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.6 }}>
          Compare your drafted answers with what comparable ZIN rulings show the committee
          expecting, per dossier type, and see where your answers diverge.
        </div>
        <button
          className="v2-btn v2-mag"
          type="button"
          style={{ marginTop: 12, ...(disabled ? { opacity: 0.45, pointerEvents: "none" } : {}) }}
          onClick={onRun}
          disabled={disabled}
          title={disabledReason}
          data-testid="precedent-run-btn"
        >
          Run precedent assessment
        </button>
        {disabled && disabledReason && (
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 8 }}>
            {disabledReason}
          </div>
        )}
      </div>
    );
  } else {
    const { dossiers = [], precedent, caveat, confidence } = result;
    content = (
      <div data-testid="precedent-table">
        <div
          style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}
        >
          <h3 style={{ margin: 0 }}>Precedent assessment</h3>
          {/* {confidence && (
            <span className={`v2-conf ${confidence === "low" ? "v2-conf-low" : ""}`}>
              {CONF_LABEL[confidence] || confidence}
            </span>
          )} */}
          {/* <button
            className="v2-btn v2-ghost v2-sm"
            type="button"
            style={{ marginLeft: "auto" }}
            onClick={onRun}
            data-testid="precedent-rerun-btn"
          >
            Re-run
          </button> */}
        </div>

        {stale && (
          <div className="v2-banner" style={{ marginBottom: 10 }} data-testid="precedent-stale">
            <span>↻</span>
            <div>
              Your answers have changed since this was run. Re-run to refresh the assessment.
            </div>
          </div>
        )}

        <div style={{ overflowX: "auto" }}>
          <table className="v2-assess-table">
            <thead>
              <tr>
                <th>Dossier type</th>
                <th>Score</th>
                <th>What precedent expects</th>
                <th>Gap in your answers</th>
              </tr>
            </thead>
            <tbody>
              {dossiers.map((d) => (
                <tr key={d.code} data-testid={`precedent-row-${d.code}`}>
                  <td>
                    <b>{d.name}</b>
                    <div style={{ color: "var(--muted)" }}>{d.focus}</div>
                    <div style={{ color: "var(--muted)", fontSize: 11 }}>
                      {d.answers.total} answer{d.answers.total !== 1 ? "s" : ""}
                    </div>
                  </td>
                  <td>
                    <ScoreTag score={d.score} band={d.band} answers={d.answers} />
                  </td>
                  <td>
                    {d.precedent_expects || <span style={{ color: "var(--muted)" }}>---</span>}
                    <CiteChips citations={d.citations} />
                  </td>
                  <td>
                    {d.gap && d.gap.trim() !== "No answers drafted."
                      ? d.gap
                      : <span style={{ color: "var(--muted)" }}>---</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {precedent && (
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 10 }}>
            Assessed against <b>{precedent.count}</b> comparable ruling
            {precedent.count !== 1 ? "s" : ""} (
            {precedent.basis === "user_selection"
              ? "your selected set"
              : precedent.basis === "relevance"
              ? "matched to your question"
              : "most recent — no close match found"}
            ). Of {precedent.published} published: {precedent.conditional} conditional,{" "}
            {precedent.negative} negative, {precedent.positive} positive.
          </div>
        )}
        {caveat && <div style={{ fontSize: 12, color: "var(--note)", marginTop: 6 }}>{caveat}</div>}
        <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 6, fontStyle: "italic" }}>
          {result.overall?.note}
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1 }} className="v2-card v2-pad" data-testid="precedent-assessment">
      {content}
    </div>
  );
}

/* ── Recommended actions panel (full-width, below the score row) ────────── */
export function RecommendedActions({ result, loading, fallback, onGoToQA, onNext, hasNext }) {
  const actions = result?.actions || [];
  return (
    <div className="v2-card v2-pad" style={{ marginBottom: 14 }} data-testid="recommended-actions">
      <h2 style={{ marginBottom: 12 }}>
        Recommended actions{actions.length > 0 ? " — highest impact first" : ""}
      </h2>

      {loading ? (
        <div style={{ fontSize: 13, color: "var(--muted)" }}>Preparing recommendations…</div>
      ) : actions.length > 0 ? (
        actions.map((a, i) => (
          <ActionAcc key={`${a.rank}-${a.title}`} action={a} defaultOpen={i === 0} />
        ))
      ) : (
        <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6 }}>
          {result ? "No specific actions were recommended for this question." : fallback}
        </div>
      )}

      {/* {actions.length > 0 && (
        <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 6 }}>
          Point values are model estimates of readiness gained, not measured outcomes.
        </div>
      )} */}

      <div
        style={{
          marginTop: 12,
          paddingTop: 12,
          borderTop: "1px solid var(--line)",
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <button className="v2-btn v2-mag v2-sm" type="button" onClick={onGoToQA}>
          Go to Q&amp;A Generator to fix these
        </button>
        {/* {hasNext && (
          <button className="v2-btn v2-ghost v2-sm" type="button" onClick={onNext}>
            Check next question →
          </button>
        )} */}
      </div>
    </div>
  );
}