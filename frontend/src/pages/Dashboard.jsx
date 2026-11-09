/**
 * Dashboard.jsx — v2.4  (redesign_7)
 * ------------------------------------------------------------------
 * Home opens on the user's own work, then the corpus:
 *   • "Continue where you left off" active session card + help card
 *   • Assessment landscape — 5 KPI tiles, each with a stated definition,
 *     a share of a stated denominator, and a real prior-period trend
 *   • "New in your therapy areas" feed, filtered to the user's interests
 *   • By therapy area — exact ruling count per area (conditional rate on hover)
 *   • Top manufacturers — ruling count per manufacturer, top N with a
 *     show-all toggle (restored from the POC dashboard)
 *
 * Endpoints:
 *   GET /api/rulings   → recent rulings (list projection)
 *   GET /api/insights  → counts, denominator, shares, per-area rates, comparison,
 *                        top_manufacturers / all_manufacturers
 *
 * Both calls degrade gracefully; the page renders from whichever succeeds.
 *
 * Change set: Sr 33–43, plus the Top Manufacturers panel restored from the POC.
 */
import { useState, useEffect, useMemo, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import axios from "axios";
import { useSession } from "../lib/SessionContext";
import { computeSessionReadiness } from "../lib/sessionStore";
import { getInterests, setInterests, effectiveInterests, matchesInterests } from "../lib/interests";

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;

// How many rulings the Home feed shows.
const FEED_SIZE = 3;

// How many manufacturers show before "Show all". Only used when the list is
// derived locally — when /api/insights succeeds, its top_manufacturers list wins.
const MFR_TOP_N = 5;

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Greeting band for the local hour: morning / afternoon / evening.
// Evening also covers late night — "Good night" reads as a farewell.
function greetingForHour(hour) {
  if (hour >= 5  && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 18) return "Good afternoon";
  return "Good evening";
}

function outcomeTag(outcome) {
  if (!outcome) return <span className="v2-tag" style={{ background: "#F3F1F7", color: "var(--muted)" }}>Unknown</span>;
  if (outcome === "Positive")             return <span className="v2-tag v2-t-pos">✓ Positive</span>;
  if (outcome === "Negative")             return <span className="v2-tag v2-t-neg">✕ Negative</span>;
  if (outcome.includes("Conditions"))     return <span className="v2-tag v2-t-cond">◑ Positive with conditions</span>;
  if (outcome.toLowerCase().includes("review")) return <span className="v2-tag v2-t-rev">⏳ Under review</span>;
  return <span className="v2-tag v2-t-cond">{outcome}</span>;
}

function fmtDate(d) {
  if (!d) return "";
  try { return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); }
  catch { return d; }
}

function fmtMonthYear(d) {
  if (!d) return null;
  const dt = new Date(String(d).slice(0, 10));
  return Number.isNaN(dt.getTime())
    ? null
    : dt.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}

// Sr 34 — metric definitions. Shown on hover so a number never appears without
// a way to find out what it counts.
const KPI_INFO = {
  total:  "Every published ZIN advice in the index, including assessments still under review.",
  pos:    "Reimbursement recommended with no additional conditions. Shown as a share of published decisions.",
  cond:   "Reimbursement recommended subject to conditions — start/stop criteria, registry participation or a price arrangement.",
  neg:    "Reimbursement not recommended in the assessed indication.",
  review: "Assessment still open at the last index refresh. Excluded from the percentage denominator.",
};

// Sr 35 — renders a signed percentage-point delta, or nothing when the backend
// could not compute one. Never fabricates a direction.
function TrendRow({ delta, unit = "pts", suffix = "vs prior period" }) {
  if (delta === null || delta === undefined || Number.isNaN(delta)) return null;
  if (delta === 0) return <div className="tr" style={{ color: "var(--muted)" }}>No change {suffix}</div>;
  const up = delta > 0;
  return (
    <div className={`tr ${up ? "v2-up" : "v2-dn"}`}>
      {up ? "▲" : "▼"} {Math.abs(delta)} {unit} {suffix}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const navigate = useNavigate();
  const { activeSession, openSavePicker, requestNewSession } = useSession();

  const [rulings,  setRulings]  = useState([]);
  const [insights, setInsights] = useState(null);
  const [loading,  setLoading]  = useState(true);

  // Sr 41 — therapy-area interests, and the small editor behind "edit interests".
  const [interests,    setInterestsState] = useState(() => getInterests());
  const [editingAreas, setEditingAreas]   = useState(false);

  // Top manufacturers — show all / show less toggle.
  const [showAllMfr, setShowAllMfr] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function fetchAll() {
      try {
        const [rRes, iRes] = await Promise.allSettled([
          axios.get(`${API}/rulings`),
          axios.get(`${API}/insights`),
        ]);
        if (cancelled) return;
        if (rRes.status === "fulfilled" && Array.isArray(rRes.value?.data))
          setRulings(rRes.value.data);
        if (iRes.status === "fulfilled" && iRes.value?.data)
          setInsights(iRes.value.data);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchAll();
    return () => { cancelled = true; };
  }, []);

  // ── KPI figures ────────────────────────────────────────────────────────────
  const total    = insights?.total_rulings           ?? rulings.length;
  const positive = insights?.positive_decisions      ?? rulings.filter(r => r.decision_outcome === "Positive").length;
  const cond     = insights?.conditional_decisions   ?? rulings.filter(r => r.decision_outcome?.includes("Conditions")).length;
  const negative = insights?.negative_decisions      ?? rulings.filter(r => r.decision_outcome === "Negative").length;
  const review   = insights?.under_review_decisions  ?? 0;

  // Sr 36 — shares come from the backend, over the published denominator
  // (total minus under-review). Dashboard used to divide by the full total
  // while Insights did not, so the two screens disagreed. The local fallback
  // uses the same denominator so it cannot reintroduce the discrepancy.
  const published = insights?.denominator_published ?? Math.max(0, total - review);
  const localShare = (n) => (published ? Number(((n / published) * 100).toFixed(1)) : 0);

  const posPct  = insights?.shares_pct?.positive    ?? localShare(positive);
  const condPct = insights?.shares_pct?.conditional ?? localShare(cond);
  const negPct  = insights?.shares_pct?.negative    ?? localShare(negative);
  // "Under review" is the excluded slice, so it is expressed against the full
  // total — labelled as such in its tooltip rather than mixed into the shares.
  const revPct  = total ? Number(((review / total) * 100).toFixed(1)) : 0;

  const delta = insights?.comparison?.delta ?? {};
  const comparisonSuffix = insights?.comparison?.window_months
    ? `vs prior ${insights.comparison.window_months} months`
    : "vs prior period";

  // Sr 33 — the real corpus window, rather than a hardcoded date range.
  const corpusFrom = fmtMonthYear(insights?.corpus_earliest);
  const corpusTo   = fmtMonthYear(insights?.corpus_current_to);
  const corpusWindow = corpusFrom && corpusTo ? `${corpusFrom} – ${corpusTo}` : null;

  // ── Sr 40 / Sr 41 — feed filtered to the user's therapy areas ─────────────
  const { areas: feedAreas, source: feedSource } = useMemo(
    () => effectiveInterests(activeSession, interests),
    [activeSession, interests]
  );

  const feedRulings = useMemo(() => {
    const sorted = [...rulings].sort((a, b) =>
      String(b?.decision_date || "").localeCompare(String(a?.decision_date || ""))
    );
    const inScope = sorted.filter((r) => matchesInterests(r, feedAreas));
    // Never show an empty feed because of a narrow interest list — fall back to
    // the newest rulings overall and say so.
    return inScope.length > 0
      ? { items: inScope.slice(0, FEED_SIZE), filtered: feedAreas.length > 0 }
      : { items: sorted.slice(0, FEED_SIZE), filtered: false };
  }, [rulings, feedAreas]);

  // Therapy areas offered in the interests editor, taken from the corpus.
  const availableAreas = useMemo(() => {
    const fromInsights = Object.keys(insights?.therapy_area_breakdown || {});
    if (fromInsights.length) return fromInsights.sort();
    return [...new Set(rulings.map((r) => r?.therapy_area).filter(Boolean))].sort();
  }, [insights, rulings]);

  const toggleArea = useCallback((area) => {
    setInterestsState((prev) => {
      const next = prev.includes(area) ? prev.filter((a) => a !== area) : [...prev, area];
      setInterests(next);
      return next;
    });
  }, []);

  // ── By therapy area — exact ruling count per area ─────────────────────────
  // Counts come from /api/insights (therapy_area_breakdown), the same figures
  // the POC showed. If insights failed, count from the rulings list instead.
  // The Sr 37 conditional rate is kept in each bar's hover text when the
  // backend sends it.
  const areaRows = useMemo(() => {
    let counts = insights?.therapy_area_breakdown;
    if (!counts || Object.keys(counts).length === 0) {
      counts = {};
      rulings.forEach((r) => {
        const area = r?.therapy_area;
        if (area) counts[area] = (counts[area] || 0) + 1;
      });
    }
    const condByArea = insights?.conditional_rate_by_area || {};
    return Object.entries(counts)
      .map(([area, n]) => ({ area, count: Number(n) || 0, condInfo: condByArea[area] }))
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count || a.area.localeCompare(b.area));
  }, [insights, rulings]);

  const maxAreaCount = areaRows.reduce((m, r) => Math.max(m, r.count), 0);

  // ── Top manufacturers (restored from the POC dashboard) ───────────────────
  // The backend sends a short top list and the full list. If /api/insights
  // failed or omitted both, count from the rulings list instead, so the panel
  // degrades the same way the KPI tiles do.
  const { topManufacturers, allManufacturers } = useMemo(() => {
    if (insights?.top_manufacturers || insights?.all_manufacturers) {
      const all = Array.isArray(insights.all_manufacturers) ? insights.all_manufacturers : null;
      const top = Array.isArray(insights.top_manufacturers)
        ? insights.top_manufacturers
        : (all || []).slice(0, MFR_TOP_N);
      return { topManufacturers: top, allManufacturers: all || top };
    }
    const counts = new Map();
    rulings.forEach((r) => {
      const name = r?.manufacturer;
      if (name) counts.set(name, (counts.get(name) || 0) + 1);
    });
    const all = [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    return { topManufacturers: all.slice(0, MFR_TOP_N), allManufacturers: all };
  }, [insights, rulings]);

  const manufacturersToDisplay = showAllMfr ? allManufacturers : topManufacturers;
  const hasMoreManufacturers   = allManufacturers.length > topManufacturers.length;

  // ── Active session summary ────────────────────────────────────────────────
  const sessionStats = useMemo(() => {
    if (!activeSession) return null;
    const qs = activeSession.questions || [];
    const rulingsSaved = new Set();
    let questionsGenerated = 0;
    let answersReady = 0;
    let needsEvidence = 0;
    qs.forEach((q) => {
      (q.rulingIds || []).forEach((id) => rulingsSaved.add(id));
      const qa = q.generatedQA || [];
      questionsGenerated += qa.length;
      answersReady  += qa.filter((a) => a.reviewed || a.status === "ready").length;
      needsEvidence += qa.filter((a) => a.status === "needs_evidence").length;
    });
    return {
      readiness: computeSessionReadiness(activeSession),
      rulingsSaved: rulingsSaved.size,
      questionsGenerated,
      answersReady,
      needsEvidence,
      answersOutstanding: questionsGenerated - answersReady,
    };
  }, [activeSession]);

  // Sr 43 — name the specific gap rather than reporting that one exists.
  // Themed grouping arrives with the richer Q&A payload (Sr 22); until a
  // question carries a theme this states the count and status honestly instead
  // of inventing a subject.
  const nextAction = useMemo(() => {
    if (!activeSession) return null;
    const qs = activeSession.questions || [];
    if (qs.length === 0)
      return "Use Ruling Search to find ZIN precedent and add it to this session.";
    if (sessionStats.questionsGenerated === 0)
      return "Rulings are saved but no questions generated yet — open the Q&A generator.";
    if (sessionStats.needsEvidence > 0) {
      const n = sessionStats.needsEvidence;
      const themed = qs
        .flatMap((q) => (q.generatedQA || []).filter((a) => a.status === "needs_evidence"))
        .map((a) => a.theme)
        .filter(Boolean);
      const topTheme = themed.length
        ? [...new Set(themed)].slice(0, 1)[0]
        : null;
      return topTheme
        ? `${n} predicted question${n !== 1 ? "s" : ""} on ${topTheme} ${n === 1 ? "has" : "have"} no evidence attached.`
        : `${n} predicted question${n !== 1 ? "s" : ""} ${n === 1 ? "is" : "are"} marked "needs evidence".`;
    }
    if (sessionStats.answersOutstanding > 0) {
      const n = sessionStats.answersOutstanding;
      return `${n} generated question${n !== 1 ? "s" : ""} still need${n === 1 ? "s" : ""} an answer marked ready.`;
    }
    return "All generated questions are marked ready — review readiness before moving on.";
  }, [activeSession, sessionStats]);

  // Greeting keyed to the time of day, re-ticking so it does not go stale on a
  // dashboard left open across a band boundary.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const greeting = useMemo(() => {
    let username = null;
    try { username = localStorage.getItem("username"); } catch { /* greet without a name */ }
    const band = greetingForHour(now.getHours());
    return username ? `${band}, ${username}` : band;
  }, [now]);

  const feedCount = feedRulings.items.length;

  return (
    <div data-testid="dashboard-page">
      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="v2-hdr">
        <div>
          <h1 data-testid="dashboard-greeting">{greeting}</h1>
          <p className="v2-sub">
            {activeSession
              ? `1 session in progress, and ${feedCount} recent ZIN ruling${feedCount !== 1 ? "s" : ""}${feedRulings.filtered ? " in your therapy areas" : ""}.`
              : "No session open — start one to track your preparation."}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="v2-btn v2-ghost" type="button" onClick={() => navigate("/search")}>Search rulings</button>
          {/* Sr 42 — opens the modal in place instead of navigating to /sessions */}
          <button className="v2-btn v2-mag" type="button" onClick={() => requestNewSession({})} data-testid="start-session-btn">
            Start a session
          </button>
        </div>
      </div>

      {/* ── Tabs ────────────────────────────────────────────────────── */}
      <div className="v2-tabs">
        <button className="on" type="button">Overview</button>
        <button type="button" onClick={() => navigate("/sessions")}>My sessions</button>
      </div>

      {/* ── Continue card ───────────────────────────────────────────── */}
      <h2>Continue where you left off</h2>
      <div className="v2-row" style={{ marginBottom: 24, alignItems: "stretch" }}>
        {activeSession ? (
          <div className="v2-card v2-pad" style={{ flex: "1.1" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
              <div>
                <b style={{ fontSize: 14.5 }}>{activeSession.drugName}</b>
                <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
                  {[activeSession.therapyArea, activeSession.dossierType, "ZIN"].filter(Boolean).join(" · ")}
                </div>
              </div>
              <span className="v2-tag v2-t-cond">◑ In progress</span>
            </div>
            <div style={{ margin: "13px 0 6px", display: "flex", justifyContent: "space-between", fontSize: 12 }}>
              <span>Preparation completeness</span>
              <b>{sessionStats.readiness}%</b>
            </div>
            <div className="v2-progress"><i style={{ width: `${sessionStats.readiness}%` }} /></div>
            <div className="v2-meta" style={{ marginTop: 9 }}>
              <span className="v2-chip">{sessionStats.rulingsSaved} ruling{sessionStats.rulingsSaved !== 1 ? "s" : ""} saved</span>
              <span className="v2-chip">{sessionStats.questionsGenerated} question{sessionStats.questionsGenerated !== 1 ? "s" : ""} generated</span>
              <span className="v2-chip">{sessionStats.answersReady} answer{sessionStats.answersReady !== 1 ? "s" : ""} ready</span>
            </div>
            <div style={{ marginTop: 12, paddingTop: 11, borderTop: "1px solid var(--line)", fontSize: 12.5 }}>
              <b style={{ color: sessionStats.needsEvidence > 0 ? "var(--neg)" : "var(--accent)" }}>Next action</b> — {nextAction}
              <div style={{ marginTop: 9 }}>
                <button className="v2-btn v2-sm" type="button" onClick={() => navigate("/qa-generator")}>Open Q&amp;A generator</button>{" "}
                <button className="v2-btn v2-ghost v2-sm" type="button" onClick={() => navigate("/readiness")}>View readiness</button>
              </div>
            </div>
          </div>
        ) : (
          <div className="v2-card v2-pad" style={{ flex: "1.1" }}>
            <div style={{ fontSize: 14, color: "var(--muted)" }}>
              No session in progress. Start one to track rulings, generate questions and measure readiness.
            </div>
            <div style={{ marginTop: 12 }}>
              <button className="v2-btn v2-mag v2-sm" type="button" onClick={() => requestNewSession({})}>Start a session</button>
            </div>
          </div>
        )}

        <div className="v2-card v2-pad" style={{ flex: 1, background: "var(--indigo)", color: "#fff", borderColor: "var(--indigo)", display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <h3 style={{ color: "rgba(255,255,255,.65)" }}>New to HTA Navigator?</h3>
          <div style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 14 }}>
            Take the four-minute guided tour, or open the playbook for your role. The help centre also explains where the AI's answers come from and what it will not do.
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="v2-btn" style={{ background: "#fff", color: "var(--indigo)", borderColor: "#fff" }} type="button" onClick={() => navigate("/help")}>Open help centre</button>
            <button className="v2-btn" style={{ background: "transparent", color: "#fff", borderColor: "rgba(255,255,255,.4)" }} type="button" onClick={() => navigate("/search")}>Search rulings</button>
          </div>
        </div>
      </div>

      {/* ── Sr 33 — Assessment landscape ────────────────────────────── */}
      <div className="v2-hdr" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Assessment landscape</h2>
        <div style={{ fontSize: 12, color: "var(--muted)" }}>
          All {total} ZIN rulings{corpusWindow ? ` · ${corpusWindow}` : ""}
          {published !== total && ` · ${published} published decisions used for percentages`}
          {" · "}
          <Link to="/help">how these are calculated</Link>
        </div>
      </div>

      {loading ? (
        <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 16 }}>Loading KPIs…</div>
      ) : (
        <div className="v2-kpis" style={{ marginBottom: 20 }}>
          <button className="v2-kpi v2-card" onClick={() => navigate("/search")} type="button">
            <div className="n">{total}</div>
            <div className="l">Total rulings <span className="v2-info" title={KPI_INFO.total}>i</span></div>
            <div className="bar"><i style={{ width: "100%", background: "var(--indigo)" }} /></div>
            {insights?.added_recent > 0 && (
              <div className="tr v2-up">▲ {insights.added_recent} added recently</div>
            )}
          </button>

          <button className="v2-kpi v2-card" onClick={() => navigate("/search")} type="button">
            <div className="n">{positive} <em>{posPct}%</em></div>
            <div className="l">Positive <span className="v2-info" title={KPI_INFO.pos}>i</span></div>
            <div className="bar"><i style={{ width: `${posPct}%`, background: "var(--pos)" }} /></div>
            <TrendRow delta={delta.positive_pct} suffix={comparisonSuffix} />
          </button>

          <button className="v2-kpi v2-card" onClick={() => navigate("/search")} type="button">
            <div className="n">{cond} <em>{condPct}%</em></div>
            <div className="l">Positive with conditions <span className="v2-info" title={KPI_INFO.cond}>i</span></div>
            <div className="bar"><i style={{ width: `${condPct}%`, background: "var(--cond)" }} /></div>
            <TrendRow delta={delta.conditional_pct} suffix={comparisonSuffix} />
          </button>

          <button className="v2-kpi v2-card" onClick={() => navigate("/search")} type="button">
            <div className="n">{negative} <em>{negPct}%</em></div>
            <div className="l">Negative <span className="v2-info" title={KPI_INFO.neg}>i</span></div>
            <div className="bar"><i style={{ width: `${negPct}%`, background: "var(--neg)" }} /></div>
            <TrendRow delta={delta.negative_pct} suffix={comparisonSuffix} />
          </button>

          <button className="v2-kpi v2-card" onClick={() => navigate("/search")} type="button">
            <div className="n">{review} <em>{revPct}%</em></div>
            <div className="l">Under review <span className="v2-info" title={KPI_INFO.review}>i</span></div>
            <div className="bar"><i style={{ width: `${revPct}%`, background: "var(--rev)" }} /></div>
            <div className="tr" style={{ color: "var(--muted)" }}>Excluded from shares</div>
          </button>
        </div>
      )}

      {/* ── Feed + right column ─────────────────────────────────────── */}
      <div className="v2-row" style={{ marginTop: 4 }}>
        {/* Sr 40 — New in your therapy areas */}
        <div className="v2-card" style={{ flex: "2.1" }}>
          <div className="v2-pad" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--line)" }}>
            <div>
              <b>{feedRulings.filtered ? "New in your therapy areas" : "New rulings"}</b>
              <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
                {feedAreas.length > 0 ? feedAreas.join(", ") : "All therapy areas"}
                {feedSource === "session" && " (from your open session)"}
                {" · "}
                <button
                  type="button"
                  onClick={() => setEditingAreas((v) => !v)}
                  style={{ background: "none", border: 0, padding: 0, font: "inherit", color: "var(--accent)", textDecoration: "underline", cursor: "pointer" }}
                  data-testid="edit-interests"
                >
                  edit interests
                </button>
              </div>
            </div>
            <button className="v2-btn v2-ghost v2-sm" type="button" onClick={() => navigate("/search")}>View all</button>
          </div>

          {/* Sr 41 — interests editor */}
          {editingAreas && (
            <div className="v2-pad" style={{ borderBottom: "1px solid var(--line)", background: "#FBFAFD" }}>
              <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
                Pick the therapy areas you follow. With none selected the feed shows every area.
              </div>
              <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                {availableAreas.map((area) => {
                  const on = interests.includes(area);
                  return (
                    <button
                      key={area}
                      type="button"
                      className="v2-chip x"
                      onClick={() => toggleArea(area)}
                      style={on ? { background: "var(--indigo-soft)", borderColor: "#D6D1EE", color: "var(--indigo)", fontWeight: 600 } : undefined}
                    >
                      {on ? "✓ " : ""}{area}
                    </button>
                  );
                })}
                {availableAreas.length === 0 && (
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>No therapy areas loaded.</span>
                )}
              </div>
            </div>
          )}

          {loading && (
            <div className="v2-pad" style={{ color: "var(--muted)", fontSize: 13 }}>Loading rulings…</div>
          )}

          {!loading && feedCount === 0 && (
            <div className="v2-pad" style={{ color: "var(--muted)", fontSize: 13 }}>No rulings loaded.</div>
          )}

          {!loading && feedAreas.length > 0 && !feedRulings.filtered && feedCount > 0 && (
            <div className="v2-pad" style={{ fontSize: 12, color: "var(--muted)", borderBottom: "1px solid var(--line)" }}>
              Nothing new in {feedAreas.join(", ")} — showing the latest rulings across all areas.
            </div>
          )}

          {feedRulings.items.map((r) => (
            <div className="v2-item" key={r.id}>
              <div style={{ display: "flex", gap: 9, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
                {outcomeTag(r.decision_outcome)}
                {r.therapy_area && <span className="v2-chip">{r.therapy_area}</span>}
                {r.decision_date && <span className="v2-chip">{fmtDate(r.decision_date)}</span>}
              </div>
              <h4>
                <Link to={r.id ? `/ruling/${r.id}` : "#"}>{r.title || "Untitled ruling"}</Link>
              </h4>
              {/* Sr 40 — clamped to two lines so one long summary cannot bury the list */}
              <p className="v2-clamp2">{r.summary || "No summary available."}</p>
              <div className="v2-acts">
                <Link to={r.id ? `/ruling/${r.id}` : "#"} className="v2-btn v2-ghost v2-sm">Open</Link>
                <button
                  className="v2-btn v2-ghost v2-sm"
                  type="button"
                  onClick={() => openSavePicker({ query: r.title || "Saved ruling", rulingIds: r.id != null ? [r.id] : [] })}
                >
                  Save to session
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* ── Right column: conditions by area, then top manufacturers ─ */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          {/* ── By therapy area — ruling count per area ────────────── */}
          {/* Shows the exact number of rulings in each area, as the POC did.
              Bar length is relative to the largest area. The Sr 37 conditional
              rate moved to the hover text. Sr 39 removed the quick-actions
              panel that used to sit below this; the manufacturers panel
              (removed in Sr 38) is restored underneath. */}
          <div className="v2-card v2-pad" data-testid="therapy-area-breakdown">
            <h3>By Therapy Area</h3>
            {loading && <div style={{ fontSize: 12.5, color: "var(--muted)" }}>Loading…</div>}

            {!loading && areaRows.length === 0 && (
              <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
                No per-area breakdown available.
              </div>
            )}

            {!loading && areaRows.length > 0 && (
              <>
                <div className="v2-bars">
                  {areaRows.map(({ area, count, condInfo }) => {
                    const plural = count !== 1 ? "s" : "";
                    const tip = condInfo?.published
                      ? `${count} ruling${plural} in ${area} · ${condInfo.conditional ?? 0} of ${condInfo.published} published decisions carried conditions`
                      : `${count} ruling${plural} in ${area}`;
                    return (
                      <button
                        key={area}
                        type="button"
                        className="b"
                        onClick={() => navigate(`/search?therapyArea=${encodeURIComponent(area)}`)}
                        title={tip}
                        style={{ background: "none", border: 0, padding: 0, font: "inherit", color: "inherit", textAlign: "left", width: "100%", cursor: "pointer" }}
                        data-testid={`therapy-area-link-${area}`}
                      >
                        <span>{area}</span>
                        <i style={{ width: `${maxAreaCount ? Math.max(2, (count / maxAreaCount) * 100) : 0}%` }} />
                        <span>{count}</span>
                      </button>
                    );
                  })}
                </div>
                <div style={{ marginTop: 12, paddingTop: 11, borderTop: "1px solid var(--line)", fontSize: 12, color: "var(--ink-2)" }}>
                  Number of ZIN rulings in each therapy area. Select an area to see its rulings.
                  {" "}
                  <Link to="/insights">See the trend →</Link>
                </div>
              </>
            )}
          </div>

          {/* ── Top manufacturers (from the POC dashboard) ─────────── */}
          <div className="v2-card v2-pad" data-testid="top-manufacturers">
            <h3>Top Manufacturers</h3>
            {loading && <div style={{ fontSize: 12.5, color: "var(--muted)" }}>Loading…</div>}

            {!loading && manufacturersToDisplay.length === 0 && (
              <div style={{ fontSize: 12.5, color: "var(--muted)" }}>No manufacturer data available.</div>
            )}

            {!loading && manufacturersToDisplay.length > 0 && (
              // The full list can run to 150+ names, so the expanded view
              // scrolls inside the card instead of stretching the page.
              <div
                style={showAllMfr ? { maxHeight: 320, overflowY: "auto", paddingRight: 4 } : undefined}
                data-testid="manufacturer-list"
              >
                {manufacturersToDisplay.map((mfr, index) => {
                  const count = mfr?.count ?? 0;
                  return (
                    <div
                      key={mfr?.name ?? `mfr-${index}`}
                      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "6px 0" }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
                        <span
                          style={{
                            width: 22, height: 22, flexShrink: 0, borderRadius: "50%",
                            background: "#F3F1F7", color: "var(--muted)",
                            fontSize: 11, fontWeight: 600,
                            display: "flex", alignItems: "center", justifyContent: "center",
                          }}
                        >
                          {index + 1}
                        </span>
                        <span
                          style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                          title={mfr?.name}
                        >
                          {mfr?.name ?? "Unknown"}
                        </span>
                      </div>
                      <span className="v2-chip" style={{ flexShrink: 0 }}>
                        {count} ruling{count !== 1 ? "s" : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {!loading && hasMoreManufacturers && (
              <button
                type="button"
                className="v2-btn v2-ghost v2-sm"
                onClick={() => setShowAllMfr((v) => !v)}
                style={{ width: "100%", marginTop: 10 }}
                aria-expanded={showAllMfr}
                data-testid="toggle-manufacturers-btn"
              >
                {showAllMfr ? "Show less ▲" : `Show all (${allManufacturers.length}) ▼`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
