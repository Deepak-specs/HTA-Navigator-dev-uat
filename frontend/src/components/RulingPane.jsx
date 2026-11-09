/**
 * RulingPane.jsx — Sr 53–62
 * ─────────────────────────────────────────────────────────────────────────────
 * The redesigned ruling view, in the v2 design system.
 *
 * Rendered in two places (Sr 53):
 *   • /ruling/:id              — as a page, via RulingDetail.jsx
 *   • inside Ruling Search     — in place, keeping the query, the filters and
 *                                the user's position in the result set alive
 *
 * What is new here versus the old page:
 *   Sr 55  persistent action header (language, citation, export, save)
 *   Sr 56  English ⇄ Nederlands toggle over the original Dutch wording
 *   Sr 57  "Conditions imposed" as discrete numbered items
 *   Sr 58  the AI summary, which existed as dead state and an unused endpoint
 *   Sr 59  "Similar rulings", the precedent matching people open a ruling for
 *   Sr 60  "Used in your work" — which of your sessions cite this ruling
 *   Sr 61  "Precedent watch" — later rulings that bear on this one
 *   Sr 62  source verification date
 *   Sr 83  sections renamed and filled out to match the POC detail page:
 *          "Committee reasoning" → "Abstract Assessment Report", which now
 *          prints the report text itself (monospace, scrollable, copyable) with
 *          the optional AI summary beneath it; "Assessment" → "Abstract
 *          Assessment Details", moved above the report as in the POC; and the
 *          English ⇄ Nederlands toggle removed.
 *   Sr 84  OPTION D — the summary is no longer generated on demand. The
 *          ingestion already writes one per ruling (`summarise.py` produces
 *          `summary`, 2-4 sentences, and `key_considerations`, 3-8 items, and
 *          stores them on the node), and this page was not showing either. They
 *          now open the Abstract Assessment Report, so the reader gets the gist
 *          before the full text, at no cost and with no wait. The "Generate
 *          summary" panel and its /summarize call are gone — that endpoint
 *          returns 500 on every request and, as written, re-derives fields the
 *          node already holds.
 *   Sr 87  "Show original text side by side" removed at the user's request:
 *          the stored summary and the report text are what a reader needs, and
 *          the Dutch original is not something to put in front of them. With
 *          the Sr 83 header toggle already gone, that button was the only way
 *          into the side-by-side panel, so the panel, the `sideBySide` state
 *          and the `hasDutch` check go with it rather than linger as code
 *          nothing can reach. `dutch_text` and `english_text` still arrive in
 *          the payload — `english_text` backs the report text — so
 *          restoring the comparison later is a UI change, not a data one.
 *   Sr 88  The verbatim report block is gone too — the section is the stored
 *          summary and its key points, nothing else. Consequences handled
 *          here: Copy now copies what is on screen rather than twenty pages of
 *          document the reader cannot see; the attribution no longer says
 *          "check it against the text below", because there is no longer a
 *          text below; and `reportText` goes, since nothing reads it. The key
 *          points carry an explicit `listStyle` because Tailwind's preflight
 *          strips list markers, which is why they rendered as bare lines.
 *   Sr 89  Drug name, manufacturer and indication added to At a glance, as the
 *          POC's "Drug Information" card had them. Drug name appeared nowhere
 *          on this page at all; manufacturer only as a header chip, which is
 *          easy to read past; and the indication was buried as the sub-line of
 *          the eligible-population tile — so that sub-line now says what it
 *          is measuring instead of repeating a field that has its own tile.
 *          Identity first, then the money, which is the order the POC used and
 *          the order a reader checks them in.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { useNavigate } from "react-router-dom";
import RulingLink from "./RulingLink";
import { toast } from "sonner";
import { useSession } from "../lib/SessionContext";
import { getAllSessions } from "../lib/sessionStore";
import { categoryLabel } from "../lib/dossierCategories";
import { exportRulingToPdf } from "../lib/rulingPdf";
import DownloadCloudIcon from "./DownloadCloudIcon";

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;

function outcomeTag(outcome) {
  if (!outcome) return <span className="v2-tag" style={{ background: "#F3F1F7", color: "var(--muted)" }}>Unknown</span>;
  if (outcome === "Positive")         return <span className="v2-tag v2-t-pos">✓ Positive</span>;
  if (outcome === "Negative")         return <span className="v2-tag v2-t-neg">✕ Negative</span>;
  if (outcome.includes("Conditions")) return <span className="v2-tag v2-t-cond">◑ Positive with conditions</span>;
  if (outcome.toLowerCase().includes("review")) return <span className="v2-tag v2-t-rev">⏳ Under review</span>;
  return <span className="v2-tag v2-t-cond">{outcome}</span>;
}

function fmtDate(d) {
  if (!d) return "";
  try { return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); }
  catch { return d; }
}

/** "Not provided." reads better than an empty block for an absent field. */
function Prose({ children, fallback = "Not provided." }) {
  const text = typeof children === "string" ? children.trim() : children;
  // whiteSpace preserves the blank lines between pages, which is the only
  // structure the extracted text carries.
  return (
    <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: "var(--ink-2)", whiteSpace: "pre-wrap" }}>
      {text || fallback}
    </p>
  );
}

export default function RulingPane({
  rulingId,
  onBack,         // in-page mode only
  onPrev,
  onNext,
  position,       // { index, total, query } — in-page mode only
  onOpenRuling,   // in-page mode: swap the pane instead of navigating away
}) {
  const { openSavePicker } = useSession();
  const navigate = useNavigate();

  // Opening a similar ruling should behave like the surroundings: swap the pane
  // when embedded in search, navigate when standing alone as a page.
  const openRuling = useCallback((id) => {
    if (!id) return;
    if (onOpenRuling) onOpenRuling(id);
    else navigate(`/ruling/${id}`);
  }, [onOpenRuling, navigate]);

  const [ruling,  setRuling]  = useState(null);
  const [loading, setLoading] = useState(true);
  const [failed,  setFailed]  = useState(false);

  const [similar,        setSimilar]        = useState([]);
  const [precedentWatch, setPrecedentWatch] = useState(null);
  const [similarBasis,   setSimilarBasis]   = useState(null);

  const exportRef    = useRef(null);
  const sourceDocRef = useRef(null);

  // ── Fetch ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!rulingId) return;
    let cancelled = false;

    setLoading(true);
    setFailed(false);

    (async () => {
      try {
        const { data } = await axios.get(`${API}/rulings/${rulingId}`);
        if (cancelled) return;
        if (!data || typeof data !== "object") {
          setRuling(null); setFailed(true);
          toast.error("Ruling response format is invalid");
        } else {
          setRuling(data);
        }
      } catch {
        if (!cancelled) { setRuling(null); setFailed(true); toast.error("Failed to load ruling details"); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    // Sr 59/61 — independent of the main fetch, so a failure here leaves the
    // ruling readable rather than blanking the page.
    (async () => {
      try {
        const { data } = await axios.get(`${API}/rulings/${rulingId}/similar`);
        if (cancelled) return;
        setSimilar(data?.similar || []);
        setPrecedentWatch(data?.precedent_watch || null);
        setSimilarBasis(data?.basis || null);
      } catch {
        if (!cancelled) { setSimilar([]); setPrecedentWatch(null); }
      }
    })();

    return () => { cancelled = true; };
  }, [rulingId]);

  // ── Sr 60 — which sessions cite this ruling ───────────────────────────────
  const usedIn = useMemo(() => {
    if (!rulingId) return [];
    try {
      return getAllSessions()
        .map((s) => {
          const questions = (s.questions || []).filter((q) => (q.rulingIds || []).includes(rulingId));
          if (questions.length === 0) return null;
          const citations = questions.reduce(
            (n, q) => n + (q.generatedQA || []).filter((a) => (a.citations || []).length > 0).length, 0
          );
          return { id: s.id, name: s.drugName, questions: questions.length, citations };
        })
        .filter(Boolean);
    } catch { return []; }
  }, [rulingId]);

  const handleCopyCitation = useCallback(() => {
    const parts = [
      ruling?.title, ruling?.manufacturer, ruling?.decision_outcome,
      ruling?.decision_date, "Zorginstituut Nederland",
    ].filter(Boolean);
    navigator.clipboard?.writeText(parts.join(" · "))
      .then(() => toast.success("Citation copied"))
      .catch(() => toast.error("Could not copy citation"));
  }, [ruling]);

  // Sr 83/88 — one click to lift this section into a submission draft. It
  // copies exactly what is displayed: the summary and its key points. Copying
  // the full document instead would hand over twenty pages the reader never
  // saw.
  const handleCopySummary = useCallback(() => {
    const points = Array.isArray(ruling?.key_considerations)
      ? ruling.key_considerations.filter(Boolean)
      : [];
    const text = [
      (ruling?.summary || "").trim(),
      ...points.map((k) => "• " + k),
    ].filter(Boolean).join("\n");
    if (!text) { toast.error("No summary to copy"); return; }
    navigator.clipboard?.writeText(text)
      .then(() => toast.success("Summary copied"))
      .catch(() => toast.error("Could not copy the summary"));
  }, [ruling]);

  const handleExport = useCallback(() => {
    exportRulingToPdf({ node: exportRef.current, sourceDocRef, ruling });
  }, [ruling]);

  if (loading) {
    return <div className="v2-card v2-pad" style={{ color: "var(--muted)" }}>Loading ruling…</div>;
  }
  if (failed || !ruling) {
    return (
      <div className="v2-card v2-pad">
        <b>Ruling not found.</b>
        <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 4 }}>
          It may have been removed from the index, or the link may be out of date.
        </div>
        {onBack && <button className="v2-btn v2-ghost v2-sm" style={{ marginTop: 10 }} onClick={onBack}>← Back to results</button>}
      </div>
    );
  }

  const conditions = Array.isArray(ruling.conditions) ? ruling.conditions : [];
  const inPage     = Boolean(onBack);

  const keyConsiderations = Array.isArray(ruling.key_considerations)
    ? ruling.key_considerations.filter(Boolean)
    : [];

  return (
    <div data-testid="ruling-pane">
      {/* ── Sr 50 — result-set navigation, in-page mode only ────────── */}
      {inPage && (
        <div className="v2-backbar">
          <button className="v2-btn v2-ghost v2-sm" type="button" onClick={onBack}>← Back to results</button>
          {position && (
            <span style={{ color: "var(--muted)" }}>
              Ruling {position.index + 1} of {position.total}
              {position.query ? ` for “${position.query}”` : ""}
            </span>
          )}
          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <button className="v2-btn v2-ghost v2-sm" type="button" onClick={onPrev} disabled={!onPrev || position?.index === 0}>Previous</button>
            <button className="v2-btn v2-ghost v2-sm" type="button" onClick={onNext} disabled={!onNext || (position && position.index >= position.total - 1)}>Next ruling</button>
          </div>
        </div>
      )}

      {/* ── Sr 55 — persistent action header ─────────────────────────── */}
      <div className="v2-hdr" style={{ alignItems: "flex-start" }}>
        <div>
          <h1 style={{ maxWidth: 720 }}>{ruling.title || "Untitled ruling"}</h1>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 7 }}>
            {outcomeTag(ruling.decision_outcome)}
            {ruling.therapy_area && <span className="v2-chip">{ruling.therapy_area}</span>}
            {ruling.dossier_category && <span className="v2-chip">{categoryLabel(ruling.dossier_category)}</span>}
            {ruling.manufacturer && <span className="v2-chip">{ruling.manufacturer}</span>}
            {ruling.decision_date && <span className="v2-chip">Decision {fmtDate(ruling.decision_date)}</span>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
          <button className="v2-btn v2-ghost v2-sm" type="button" onClick={handleCopyCitation}>Copy citation</button>
          <button className="v2-btn v2-ghost v2-sm" type="button" onClick={handleExport} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}> <DownloadCloudIcon size={16} />Export PDF</button>
          <button
            className="v2-btn v2-mag v2-sm"
            type="button"
            onClick={() => openSavePicker({ query: ruling.title || "Saved ruling", rulingIds: [ruling.id] })}
          >
            Save to session
          </button>
        </div>
      </div>

      {/* ── Sr 61 — precedent watch ──────────────────────────────────── */}
      {precedentWatch?.has_later && (
        <div className="v2-banner" style={{ marginBottom: 16 }}>
          <span aria-hidden="true">⚑</span>
          <div>
            <b>Precedent watch.</b> {precedentWatch.note}
            <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
              {precedentWatch.rulings.map((r) => (
                <span key={r.id} className="v2-chip">{r.title} · {fmtDate(r.decision_date)}</span>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="v2-row" ref={exportRef}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* ── At a glance ───────────────────────────────────────── */}
          <h2>At a glance</h2>
          <div className="v2-facts" style={{ marginBottom: 16 }}>
            <div className="v2-fact">
              <div className="k">Drug</div>
              <div className="v" style={{ fontSize: 15 }}>{ruling.drug_name || "—"}</div>
              <div className="s">As named in the advice</div>
            </div>
            <div className="v2-fact">
              <div className="k">Manufacturer</div>
              <div className="v" style={{ fontSize: 15 }}>{ruling.manufacturer || "Not stated"}</div>
              <div className="s">{ruling.manufacturer ? "Applicant" : "No manufacturer recorded"}</div>
            </div>
            <div className="v2-fact">
              <div className="k">Indication</div>
              {/* Prose, not a figure — at the tile's default 17px bold a full
                  indication fills the card and reads as a headline. */}
              <div className="v" style={{ fontSize: 14 }}>{ruling.indication || "Not stated"}</div>
              <div className="s">As assessed</div>
            </div>
            <div className="v2-fact">
              <div className="k">Price per unit</div>
              <div className="v">{ruling.price_per_unit || "—"}</div>
              <div className="s">Manufacturer list price</div>
            </div>
            <div className="v2-fact">
              <div className="k">Annual cost per patient</div>
              <div className="v">{ruling.annual_cost || "—"}</div>
              <div className="s">Manufacturer estimate</div>
            </div>
            <div className="v2-fact">
              <div className="k">Eligible population</div>
              <div className="v">{ruling.patient_population || "—"}</div>
              <div className="s">Expected to be treated</div>
            </div>
            <div className="v2-fact">
              <div className="k">Comparator</div>
              <div className="v" style={{ fontSize: 14 }}>{ruling.comparator || "—"}</div>
              <div className="s">As assessed</div>
            </div>
          </div>

          {/* ── PICO — the research question, where the document states one ──
              pico_stated is false for most publications: ministerial advice
              letters and package advice rarely frame a question. Saying so is
              the point; inferring one from scattered facts is what the
              extraction prompt is written to avoid. */}
          <h2>Research question (PICO)</h2>
          {ruling.pico_stated ? (
            <div className="v2-card" style={{ marginBottom: 16 }} data-testid="pico-panel">
              <div className="v2-item">
                <div className="v2-facts" style={{ border: 0 }}>
                  <div className="v2-fact">
                    <div className="k">Population</div>
                    <div className="v" style={{ fontSize: 14 }}>{ruling.pico_population || "—"}</div>
                  </div>
                  <div className="v2-fact">
                    <div className="k">Intervention</div>
                    <div className="v" style={{ fontSize: 14 }}>{ruling.pico_intervention || "—"}</div>
                  </div>
                  <div className="v2-fact">
                    <div className="k">Comparator</div>
                    <div className="v" style={{ fontSize: 14 }}>{ruling.pico_comparator || "—"}</div>
                  </div>
                </div>
              </div>
              {Array.isArray(ruling.pico_outcomes) && ruling.pico_outcomes.length > 0 && (
                <div className="v2-item">
                  <div style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".07em", color: "var(--muted)", marginBottom: 7 }}>
                    Outcomes assessed
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {ruling.pico_outcomes.map((o, i) => (
                      <span className="v2-chip" key={i}>{o}</span>
                    ))}
                  </div>
                </div>
              )}
              <div className="v2-item" style={{ fontSize: 11.5, color: "var(--muted)" }}>
                {ruling.pico_source
                  ? <>Stated in <b style={{ color: "var(--ink-2)" }}>{ruling.pico_source}</b> of the published advice. Check it against the source before relying on it.</>
                  : <>Extracted from the published advice. Check it against the source before relying on it.</>}
              </div>
            </div>
          ) : (
            <div className="v2-banner" style={{ marginBottom: 16 }} data-testid="pico-absent">
              <span aria-hidden="true">◈</span>
              <div>
                <b>No research question stated.</b> This publication does not set out a
                PICO. Most ministerial advice letters and package advice do not; formal
                assessment reports usually do.
              </div>
            </div>
          )}

          {/* ── Sr 57 — conditions imposed ─────────────────────────── */}
          {conditions.length > 0 && (
            <>
              <h2>Conditions imposed</h2>
              <div className="v2-card" style={{ marginBottom: 16 }}>
                {conditions.map((c) => (
                  <div className="v2-item" key={c.n} style={{ display: "flex", gap: 11 }}>
                    <span className="v2-tag v2-t-cond">{c.n}</span>
                    <div>
                      <b>{c.label}</b>
                      <p>{c.text}</p>
                    </div>
                  </div>
                ))}
                <div className="v2-item" style={{ fontSize: 11.5, color: "var(--muted)" }}>
                  Extracted from the published advice. Check each against the source before relying on it.
                </div>
              </div>
            </>
          )}

          {/* ── Assessment Details ───────────── */}
          {/* The three fields the POC detail page led with, kept in the
              reading order it used: the figures first, then the report they
              were taken from. */}
          <h2>Assessment Details</h2>
          <div className="v2-card" style={{ marginBottom: 16 }}>
            <div className="v2-item"><b>Clinical evidence</b><Prose>{ruling.clinical_evidence}</Prose></div>
            <div className="v2-item"><b>Cost-effectiveness</b><Prose>{ruling.cost_effectiveness}</Prose></div>
            <div className="v2-item"><b>Budget impact</b><Prose>{ruling.budget_impact}</Prose></div>
          </div>

          {/* ── Abstract Assessment Report ────────────────────────── */}
          {/* Sr 83/84 — this heading used to introduce an on-demand AI summary,
              so a reader who wanted the committee's own words had nothing to
              read until they asked a model to summarise them. The section now
              carries the ingestion's stored summary followed by the report
              text itself, in the monospace, scrollable, copyable block the POC
              used. Nothing here calls a model. */}
          <div style={{ display: "flex", alignItems: "baseline", gap: 7, marginBottom: 12, flexWrap: "wrap" }}>
            <h2 style={{ margin: 0, marginRight: "auto" }}>Abstract Assessment Report</h2>
            <button
              className="v2-btn v2-ghost v2-sm"
              type="button"
              onClick={handleCopySummary}
              disabled={!ruling.summary && keyConsiderations.length === 0}
              title="Copy this summary and its key points"
            >
              Copy
            </button>
          </div>
          {/* Sr 84 — the ingestion's own summary, shown rather than generated.
              Labelled for what it is: a model summary written at ingestion from
              this report, not wording ZIN published. */}
          {(ruling.summary || keyConsiderations.length > 0) && (
            <div className="v2-ai" style={{ marginBottom: 12 }} data-testid="report-summary">
              <div style={{ width: "100%" }}>
                <div className="h">
                  Summary of this report
                  {keyConsiderations.length > 0 && (
                    <span className="v2-conf">{keyConsiderations.length} key points</span>
                  )}
                </div>
                {ruling.summary && (
                  <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--ink-2)" }}>
                    {ruling.summary}
                  </div>
                )}
                {keyConsiderations.length > 0 && (
                  <ul style={{
                    margin: "10px 0 0",
                    paddingLeft: 20,
                    // Tailwind's preflight sets list-style: none on every ul,
                    // so the markers have to be asked for back explicitly.
                    listStyle: "disc outside",
                    fontSize: 12.5,
                    color: "var(--ink-2)",
                    lineHeight: 1.6,
                  }}>
                    {keyConsiderations.map((k, i) => <li key={i}>{k}</li>)}
                  </ul>
                )}
                <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 9 }}>
                  Written at ingestion from this report · model summary, not advice.
                  Check it against the published advice before relying on it.
                </div>
              </div>
            </div>
          )}



          {/* ── Sr 62 — source document ────────────────────────────── */}
          <h2>Source document</h2>
          <div className="v2-card v2-pad" ref={sourceDocRef} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ fontSize: 12.5 }}>
              <b>{ruling.zin_reference || ruling.title || "ZIN advice"}</b>
              <div style={{ color: "var(--muted)" }}>
                Zorginstituut Nederland
                {ruling.decision_date && ` · published ${fmtDate(ruling.decision_date)}`}
                {ruling.page_count > 0 && ` · PDF, ${ruling.page_count} pages`}
                {ruling.verified_at && ` · verified against source ${fmtDate(ruling.verified_at)}`}
              </div>
            </div>
            <div style={{ display: "flex", gap: 7 }}>
              {ruling.file_url ? (
                <>
                  {/* <a className="v2-btn v2-ghost v2-sm" href={ruling.file_url} target="_blank" rel="noreferrer">Open original</a> */}
                  <a className="v2-btn v2-ghost v2-sm" href={ruling.file_url} download>View Original</a>
                </>
              ) : (
                <span style={{ fontSize: 12, color: "var(--muted)" }}>No source file linked</span>
              )}
            </div>
          </div>
        </div>

        {/* ── Sidebar ──────────────────────────────────────────────── */}
        <div style={{ flex: "0 0 234px" }}>
          {/* Sr 59 — similar rulings */}
          <div className="v2-card v2-pad" style={{ marginBottom: 14 }}>
            <h3>Similar rulings</h3>
            {similar.length === 0 && (
              <div style={{ fontSize: 12.5, color: "var(--muted)" }}>No comparable rulings found.</div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {similar.map((s) => (
                <RulingLink
                  key={s.id}
                  id={s.id}
                  onOpen={openRuling}
                  style={{ textAlign: "left", font: "inherit", cursor: "pointer" }}
                >
                  <b style={{ fontSize: 12.5, color: "var(--ink)" }}>{s.title}</b>
                  <div style={{ color: "var(--muted)", fontSize: 12 }}>
                    {/* A heuristic match must not masquerade as a measured one. */}
                    {s.basis === "vector" ? `${s.similarity_pct}% similar` : "Related"}
                    {s.outcome ? ` · ${s.outcome.toLowerCase()}` : ""}
                  </div>
                </RulingLink>
              ))}
            </div>
            {similarBasis === "heuristic" && similar.length > 0 && (
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 9, paddingTop: 9, borderTop: "1px solid var(--line)" }}>
                Matched on therapy area and outcome — semantic matching was unavailable.
              </div>
            )}
          </div>

          {/* Sr 60 — used in your work */}
          <div className="v2-card v2-pad">
            <h3>Used in your work</h3>
            {usedIn.length === 0 ? (
              <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
                Not yet saved to any session.
              </div>
            ) : (
              <div style={{ fontSize: 12.5, color: "var(--ink-2)", display: "flex", flexDirection: "column", gap: 7 }}>
                {usedIn.map((u) => (
                  <div key={u.id}>
                    Saved to <b>{u.name}</b>
                    <div style={{ color: "var(--muted)", fontSize: 11.5 }}>
                      {u.questions} research question{u.questions !== 1 ? "s" : ""}
                      {u.citations > 0 && ` · cited in ${u.citations} draft answer${u.citations !== 1 ? "s" : ""}`}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
