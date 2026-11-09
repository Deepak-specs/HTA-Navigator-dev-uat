/**
 * Insights.jsx — v2.6  (redesign_7)
 * ─────────────────────────────────────────────────────────────────────────────
 * Trends across the ZIN corpus, and a grounded answer to the user's own
 * analytical question.
 *
 * v2.6 — one window control, computed in the browser:
 *   The "Compare with" control and everything that depended on it are removed.
 *   The header count, KPI tiles, outcome donut, quarterly chart, therapy-area
 *   chart and manufacturer chart all follow a single select: Last 24 months,
 *   Last 12 months, Last 5 years, or All years.
 *
 *   The figures are computed from the ruling rows (/api/rulings), filtered to
 *   the window, rather than read from /api/insights. That endpoint is shared
 *   with the Dashboard and the sidebar and is deliberately left untouched, so
 *   nothing outside this page can change. /api/insights still supplies the
 *   corpus-wide fallback, the monthly series and the "current to" date.
 *
 * Earlier change set:
 *   Sr 80  `avg_review_time_days` removed
 *   Sr 81  24-month default window
 *   Sr 82  metric definitions and stated denominators on every KPI
 *   Sr 83  outcome donut with "under review (excluded)" in the legend
 *   Sr 84  quarterly conditional/negative share
 *   Sr 85  therapy-area volume plus conditional rate
 *   Sr 86  "What this means for your sessions" (COMMENTED OUT)
 *   Sr 87  "Ask your own insight question" with confidence and citations
 *   Sr 88  Top Manufacturers table removed
 *   Sr 89  v2 port; recharts and the PDF export kept
 *   Sr 97  analysis panel inside the PDF capture
 *   Sr 95  therapy-area chart right margin + clipping
 *   Sr 90  "By manufacturer" — top 5 by positive decisions
 *   +      Monthly decision trends paged in 6-month windows
 *   +      Key insights for HTA submissions follow the trends window
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import axios from "axios";
import { toast } from "sonner";
import {
  BarChart as RBarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, LineChart, Line, Legend, LabelList,
} from "recharts";
import { useSession } from "../lib/SessionContext";
import { addQuestionToSession, addQAToQuestion } from "../lib/sessionStore";
import { categoryLabel } from "../lib/dossierCategories";
import { normaliseManufacturer, manufacturerLabels } from "../lib/manufacturers";
import { exportPageToPDF } from "../lib/insightsPdf";
import { useThinkingMessage, INSIGHTS_THINKING } from "../lib/useThinkingMessage";
import DownloadCloudIcon from "../components/DownloadCloudIcon"	

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;

// Sr 82 — every metric states what it counts and what it divides by.
const KPI_INFO = {
  total: "ZIN advices with a decision date inside the selected window, including assessments still under review. The green line shows how many of them are published decisions.",
  pos:   "Positive ÷ published decisions in the window. Rulings still under review are excluded from the denominator, so the three shares sum to 100%.",
  cond:  "Positive with conditions ÷ published decisions in the window. Same denominator as above.",
  neg:   "Negative ÷ published decisions in the window. Same denominator as above.",
};

const WINDOWS = [
  { value: 24, label: "Last 24 months" },
  { value: 12, label: "Last 12 months" },
  { value: 60, label: "Last 5 years" },
  { value: 0,  label: "All years" },
];

const SUGGESTED = [
  "How often does ZIN request additional sensitivity analyses in cardiology submissions?",
  "What budget impact thresholds trigger additional conditions in heart failure rulings?",
  "Which comparators has ZIN rejected in NYHA class II–IV populations?",
  "How has the conditional approval rate in cardiology changed since 2022?",
];

const CONF_LABEL = { high: "High confidence", moderate: "Moderate confidence", low: "Low confidence" };

function pct(n, d) {
  return d ? Number(((n / d) * 100).toFixed(1)) : 0;
}

// ─── Monthly trends: helpers ──────────────────────────────────────────────────
const TREND_WINDOW_MONTHS = 6;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LC = MONTHS.map((m) => m.toLowerCase());

function monthKey(value) {
  const s = String(value ?? "").trim();
  const iso = /^(\d{4})-(\d{2})/.exec(s);
  if (iso) {
    const m = Number(iso[2]) - 1;
    return m >= 0 && m < 12 ? Number(iso[1]) * 12 + m : null;
  }
  const [mon, year] = s.split(/\s+/);
  const m = MONTHS_LC.indexOf(String(mon ?? "").slice(0, 3).toLowerCase());
  const y = Number(year);
  return m >= 0 && Number.isInteger(y) ? y * 12 + m : null;
}

function labelFromKey(k) {
  return `${MONTHS[k % 12]} ${Math.floor(k / 12)}`;
}

function normaliseMonthly(raw) {
  if (!Array.isArray(raw)) return [];
  const rows = raw.filter((d) => d && d.month);
  if (rows.length === 0) return [];
  const keyed = rows.map((d) => [monthKey(d.month), d]);
  if (keyed.some(([k]) => k == null)) return rows;
  const byKey = new Map(keyed);
  const keys = keyed.map(([k]) => k);
  const first = Math.min(...keys);
  const last  = Math.max(...keys);
  const out = [];
  for (let k = first; k <= last; k++) {
    out.push(byKey.get(k) ?? { month: labelFromKey(k), positive: 0, conditional: 0, negative: 0 });
  }
  return out;
}

function periodLabel(rows) {
  if (!rows?.length) return "";
  const first = rows[0].month;
  const last  = rows[rows.length - 1].month;
  return first === last ? first : `${first} – ${last}`;
}

function buildMonthWindows(series, size) {
  const windows = [];
  for (let end = series.length; end > 0; end -= size) {
    const start = Math.max(0, end - size);
    windows.unshift({ startIdx: start, endIdx: end, label: periodLabel(series.slice(start, end)) });
  }
  return windows;
}

// ─── Window maths, shared by every figure that follows the select ─────────────
// Calendar month as a single sortable integer, so window maths needs no Date.
const monthIndex = (iso) => {
  const s = String(iso ?? "");
  if (s.length < 7) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  return Number.isFinite(y) && Number.isFinite(m) ? y * 12 + (m - 1) : null;
};

const outcomeOf = (r) => {
  const o = String(r?.decision_outcome ?? "").trim();
  if (o === "Under Review") return "review";
  if (o === "Positive") return "positive";
  if (o === "Negative") return "negative";
  if (o.includes("Conditions")) return "conditional";
  return "other";
};

// Counts, published denominator and shares for a set of rulings. Same
// classification as the backend, so "All years" reproduces the corpus figures.
function summarise(rows) {
  const t = { total: rows.length, positive: 0, conditional: 0, negative: 0, review: 0 };
  rows.forEach((r) => {
    const o = outcomeOf(r);
    if (o in t) t[o] += 1;
  });
  t.published = t.positive + t.conditional + t.negative;
  t.shares = {
    positive: pct(t.positive, t.published),
    conditional: pct(t.conditional, t.published),
    negative: pct(t.negative, t.published),
  };
  return t;
}

// Per-therapy-area volume and conditional counts, published decisions only.
function byTherapyArea(rows) {
  const by = new Map();
  rows.forEach((r) => {
    const o = outcomeOf(r);
    const area = r?.therapy_area;
    if (o === "review" || !area) return;
    const e = by.get(area) ?? { area, total: 0, conditional: 0 };
    e.total += 1;
    if (o === "conditional") e.conditional += 1;
    by.set(area, e);
  });
  return [...by.values()]
    .map((e) => ({ ...e, rate: e.total ? Number(((e.conditional / e.total) * 100).toFixed(1)) : 0 }))
    .sort((a, b) => b.total - a.total);
}

// Quarterly conditional / negative share, from the ruling rows.
function quarterlySeries(rows) {
  const map = new Map();
  rows.forEach((r) => {
    const k = monthIndex(r?.decision_date);
    if (k == null) return;
    const year = Math.floor(k / 12);
    const q = Math.floor((k % 12) / 3) + 1;
    const key = year * 4 + (q - 1);
    const e = map.get(key) ?? { key, quarter: `Q${q} ${String(year).slice(2)}`, published: 0, conditional: 0, negative: 0 };
    const o = outcomeOf(r);
    if (o === "review" || o === "other") return;
    e.published += 1;
    if (o === "conditional") e.conditional += 1;
    if (o === "negative") e.negative += 1;
    map.set(key, e);
  });
  return [...map.values()]
    .sort((a, b) => a.key - b.key)
    .map((e) => ({
      quarter: e.quarter,
      conditional_share: e.published ? Number(((e.conditional / e.published) * 100).toFixed(1)) : 0,
      negative_share: e.published ? Number(((e.negative / e.published) * 100).toFixed(1)) : 0,
    }));
}

// ─── Key insights for HTA submissions ─────────────────────────────────────────
const isPositive = (r) => r?.decision_outcome === "Positive";
const isNegative = (r) => r?.decision_outcome === "Negative";
const isConditional = (r) => String(r?.decision_outcome ?? "").includes("Conditions");

function topBy(rows, keyFn, n) {
  const counts = new Map();
  rows.forEach((r) => {
    const k = keyFn(r);
    if (k && k !== "Unknown") counts.set(k, (counts.get(k) ?? 0) + 1);
  });
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, n);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ─── Sr 90 — manufacturers, ranked inside the selected window ─────────────────
const MFR_TOP_N = 5;

function rankManufacturers(rows, topN, labels) {
  const by = new Map();
  rows.forEach((r) => {
    const key = normaliseManufacturer(r?.manufacturer);
    if (!key) return;
    const outcome = String(r?.decision_outcome ?? "");
    if (outcome === "Under Review") return;
    const e = by.get(key) ?? { key, published: 0, positive: 0 };
    e.published += 1;
    if (outcome.startsWith("Positive")) e.positive += 1;
    by.set(key, e);
  });
  return [...by.values()]
    .map((e) => ({
      key: e.key,
      name: labels.get(e.key)?.label ?? e.key,
      variants: labels.get(e.key)?.variants ?? [],
      published: e.published,
      positive: e.positive,
      rate: e.published ? Math.round((e.positive / e.published) * 100) : 0,
    }))
    .sort((a, b) => b.positive - a.positive || b.published - a.published || a.name.localeCompare(b.name))
    .slice(0, topN);
}

function deriveKeyInsights({ visibleTrend, prevTrend, rulings, overall }) {
  const sum = (rows, k) => rows.reduce((s, d) => s + (Number(d?.[k]) || 0), 0);
  const wPos  = sum(visibleTrend, "positive");
  const wCond = sum(visibleTrend, "conditional");
  const wNeg  = sum(visibleTrend, "negative");
  const wTotal = wPos + wCond + wNeg;
  const share = (n, d = wTotal) => (d ? Math.round((n / d) * 100) : 0);
  const period = periodLabel(visibleTrend) || "the selected period";

  const windowKeys = new Set(visibleTrend.map((d) => monthKey(d.month)).filter((k) => k != null));
  const inWindow = rulings.filter((r) => windowKeys.has(monthKey(r?.decision_date)));

  const posAreas        = topBy(inWindow.filter(isPositive), (r) => r?.therapy_area, 2);
  const challengedAreas = topBy(inWindow.filter((r) => isNegative(r) || isConditional(r)), (r) => r?.therapy_area, 2);
  const windowAreas     = topBy(inWindow, (r) => r?.therapy_area, 3);
  const dossiers        = topBy(inWindow, (r) => r?.dossier_category, 2);
  const [topMfr]        = topBy(inWindow, (r) => r?.manufacturer, 1);
  const names = (pairs) => pairs.map(([name]) => name).join(", ");

  const dominant =
    wTotal === 0 ? null
    : wPos >= wCond && wPos >= wNeg ? "positive"
    : wNeg >= wCond ? "negative"
    : "conditional";

  const success = [
    overall.published > 0
      ? `Positive rate in the selected window: ${overall.positiveShare}% of ${overall.published} published decisions`
      : null,
    wPos > 0
      ? `${plural(wPos, "positive decision")} in ${period} (${share(wPos)}% of the period)`
      : `No positive decisions in ${period}`,
    posAreas.length > 0 ? `Positive outcomes led by: ${names(posAreas)}` : null,
    topMfr ? `Most active manufacturer this period: ${topMfr[0]} (${plural(topMfr[1], "ruling")})` : null,
  ].filter(Boolean);

  const objections = [
    wNeg > 0 ? `${plural(wNeg, "negative decision")} in ${period}` : `No negative decisions in ${period}`,
    wCond > 0 ? `${plural(wCond, "conditional approval")} — conditions attached` : null,
    challengedAreas.length > 0 ? `Most negative or conditional outcomes: ${names(challengedAreas)}` : null,
    overall.negative > 0 ? `${overall.negative} negative decisions in the selected window` : null,
  ].filter(Boolean);

  let focus = [
    windowAreas.length > 0
      ? `Highest volume this period: ${windowAreas[0][0]} (${plural(windowAreas[0][1], "ruling")})`
      : null,
    windowAreas.length > 1 ? `Also active: ${names(windowAreas.slice(1))}` : null,
    dossiers.length > 0 ? `Dominant dossier type: ${categoryLabel(dossiers[0][0])}` : null,
    dossiers.length > 1 ? `Secondary dossier type: ${categoryLabel(dossiers[1][0])}` : null,
  ].filter(Boolean);
  if (focus.length === 0) {
    const [top] = Object.entries(overall.areaCounts || {}).sort((a, b) => b[1] - a[1]);
    if (top) focus = [`Highest volume in the selected window: ${top[0]} (${plural(Number(top[1]) || 0, "ruling")})`];
  }

  // The Monthly trends pager keeps its own previous-6-months comparison; it is
  // separate from the removed page-level "Compare with" control.
  const pTotal = prevTrend.length
    ? sum(prevTrend, "positive") + sum(prevTrend, "conditional") + sum(prevTrend, "negative")
    : 0;
  const pCond = sum(prevTrend, "conditional");
  const timeline = [
    visibleTrend.length > 0
      ? `Window: ${plural(visibleTrend.length, "month")} (${period})`
      : null,
    prevTrend.length > 0
      ? `${plural(wTotal, "decision")} vs ${pTotal} in the previous ${plural(prevTrend.length, "month")}`
      : `${plural(wTotal, "decision")} in this window`,
    prevTrend.length > 0 && wTotal > 0 && pTotal > 0
      ? `Conditional share ${share(wCond)}% vs ${share(pCond, pTotal)}% in the previous window`
      : null,
    dominant === "positive"    ? "Trend: positive decisions leading this period"
    : dominant === "negative"  ? "Trend: negative decisions elevated — review comparator and evidence"
    : dominant === "conditional" ? "Trend: conditional approvals prominent this period"
    : null,
  ].filter(Boolean);

  return { period, success, objections, focus, timeline };
}

const INSIGHT_TONES = {
  success:    { bg: "#EEF7F2", border: "#CFE6DA", ink: "#155E40" },
  objections: { bg: "#FDF6EA", border: "#F0DDB6", ink: "#7A4A03" },
  focus:      { bg: "#F1EFFA", border: "#D6D1EE", ink: "#241663" },
  timeline:   { bg: "#F6F5F8", border: "#E4E1EA", ink: "#463C55" },
};

function InsightBox({ title, icon, tone, items, empty, testId }) {
  return (
    <div
      style={{ background: tone.bg, border: `1px solid ${tone.border}`, borderRadius: 10, padding: "12px 14px" }}
      data-testid={testId}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7, fontWeight: 700, fontSize: 13.5, color: tone.ink, marginBottom: 6 }}>
        <span aria-hidden="true">{icon}</span>{title}
      </div>
      <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12.5, lineHeight: 1.6, color: tone.ink }}>
        {items.length > 0
          ? items.map((t, i) => <li key={i}>{t}</li>)
          : <li style={{ fontStyle: "italic", opacity: 0.8 }}>{empty}</li>}
      </ul>
    </div>
  );
}

// ─── Sr 87 — ask your own insight question ────────────────────────────────────
function InsightQuestionPanel({ corpusTotal }) {
  const { activeSession, refreshSessions } = useSession();

  const [question, setQuestion] = useState("");
  const [result,   setResult]   = useState(null);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState(null);

  const thinkingMessage = useThinkingMessage(loading, INSIGHTS_THINKING);

  const run = useCallback(async () => {
    const q = question.trim();
    if (!q) { toast.warning("Enter a question first."); return; }
    setLoading(true); setError(null); setResult(null);
    try {
      const { data } = await axios.post(`${API}/insights-analyse`, {
        question: q,
        session_context: activeSession
          ? [activeSession.drugName, activeSession.therapyArea].filter(Boolean).join(" · ")
          : "",
      });
      setResult(data);
    } catch (err) {
      setError(err?.response?.data?.detail || "The analysis could not be completed.");
    } finally {
      setLoading(false);
    }
  }, [question, activeSession]);

  const saveToSession = useCallback(() => {
    if (!activeSession || !result) return;
    const q = addQuestionToSession(activeSession.id, { query: question.trim(), rulingIds: [] });
    if (!q) { toast.error("Could not save to session"); return; }
    addQAToQuestion(activeSession.id, q.id, [{
      question: question.trim(),
      answer: [result.summary, ...(result.findings || []).map((f) => `• ${f}`)].join("\n"),
      status: "draft",
      citations: (result.citations || []).map((c) => [c.title, c.year].filter(Boolean).join(" ")),
    }]);
    refreshSessions();
    toast.success(`Saved to ${activeSession.drugName}`);
  }, [activeSession, result, question, refreshSessions]);

  const trendKeys = useMemo(() => {
    const rows = result?.trend_data || [];
    const keys = new Set();
    rows.forEach((r) => Object.keys(r).forEach((k) => { if (k !== "label") keys.add(k); }));
    return [...keys];
  }, [result]);

  const COLOURS = ["#241663", "#B81E68", "#B06D05", "#1B7A54"];

  const scopeLink = useMemo(() => {
    const s = result?.scope;
    const areas = (s?.therapy_areas || []).filter(Boolean);
    const hasYears = s?.year_from != null || s?.year_to != null;
    if (!s || (!areas.length && !hasYears) || !result?.rulings_matched) return null;
    const p = new URLSearchParams();
    areas.forEach((a) => p.append("therapyArea", a));
    if (s.year_from != null) p.set("yearFrom", String(s.year_from));
    if (s.year_to != null) p.set("yearTo", String(s.year_to));
    return { url: `/search?${p.toString()}`, count: result.rulings_matched };
  }, [result]);

  return (
    <div
      className="v2-card"
      style={{ marginTop: 18, borderLeft: "4px solid var(--accent)" }}
      data-pdf-hide={result ? undefined : "true"}
    >
      <div className="v2-pad" style={{ borderBottom: "1px solid var(--line)" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <h2 style={{ marginBottom: 4 }}>Ask your own insight question</h2>
            <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
              Answered across the ZIN corpus, with the rulings it drew on named.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {activeSession && <span className="v2-chip">Session: {activeSession.drugName}</span>}
            <span className="v2-chip">{corpusTotal} rulings</span>
          </div>
        </div>

        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 13 }} data-pdf-hide="true">
          <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--muted)", alignSelf: "center" }}>Suggested:</span>
          {SUGGESTED.map((s) => (
            <button key={s} type="button" className="v2-chip x" onClick={() => setQuestion(s)}>
              {s.length > 46 ? `${s.slice(0, 46)}…` : s}
            </button>
          ))}
        </div>

        <div style={{ marginTop: 12 }}>
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") run(); }}
            placeholder="e.g. How often does ZIN request additional sensitivity analyses in cardiology submissions?"
            style={{ minHeight: 58, resize: "none" }}
            data-testid="insight-question"
          />
          <div
            style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 7, flexWrap: "wrap", gap: 7 }}
            data-pdf-hide="true"
          >
            <span style={{ fontSize: 11.5, color: "var(--muted)" }}>Ctrl+Enter to submit.</span>
            <div style={{ display: "flex", gap: 7 }}>
              <button className="v2-btn v2-ghost v2-sm" type="button" onClick={() => { setQuestion(""); setResult(null); setError(null); }}>
                Clear
              </button>
              <button className="v2-btn v2-mag v2-sm" type="button" onClick={run} disabled={loading} data-testid="insight-run">
                {loading ? "Analysing…" : "▶ Analyse"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {(loading || error || result) && (
        <div className="v2-pad" data-testid="insight-result">
          {loading && (
            <div style={{ fontSize: 13 }} data-testid="insight-thinking">
              <span className="sr-only" role="status" aria-live="polite">
                Analysing the ruling corpus
              </span>
              <span style={{ color: "var(--muted)" }} aria-hidden="true">{thinkingMessage}</span>
            </div>
          )}
          {error && <div style={{ fontSize: 13, color: "var(--neg)" }}>{error}</div>}

          {result && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 11, flexWrap: "wrap" }}>
                <b style={{ fontSize: 13.5 }}>Analysis results</b>
                <span className="v2-chip cite">
                  {result.rulings_analysed} of {result.rulings_total ?? corpusTotal} rulings analysed
                </span>
                {result.confidence && (
                  <span className={result.confidence === "low" ? "v2-tag v2-t-cond" : "v2-conf"}>
                    {CONF_LABEL[result.confidence]}
                  </span>
                )}
                <Link
                  className="v2-btn v2-ghost v2-sm"
                  style={{ marginLeft: "auto" }}
                  to={scopeLink ? scopeLink.url : "/search"}
                  title={scopeLink ? `Opens Ruling Search filtered to ${result.scope?.description}` : undefined}
                  data-testid="insight-open-search"
                >
                  {scopeLink
                    ? `View all ${scopeLink.count} ruling${scopeLink.count !== 1 ? "s" : ""} in ruling search →`
                    : "Open in ruling search →"}
                </Link>
              </div>

              {result.selection_basis && result.selection_basis !== "relevance" && (
                <div className="v2-banner" style={{ marginBottom: 12 }}>
                  <span aria-hidden="true">◈</span>
                  <div>
                    No ruling scored above the relevance threshold for this question, so the
                    analysis used {result.rulings_analysed} rulings in corpus order. Treat it as a
                    prompt for your own analysis rather than a finding.
                  </div>
                </div>
              )}

              <div className="v2-ai" style={{ marginBottom: 14 }}>
                <div style={{ width: "100%" }}>
                  <div className="h">AI synthesis across {result.rulings_analysed} rulings</div>
                  <div style={{ fontSize: 13, lineHeight: 1.65, color: "var(--ink-2)" }}>{result.summary}</div>

                  {(result.citations || []).length > 0 && (
                    <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {result.citations.map((c, i) => (
                        <span key={i} className="v2-chip cite">
                          {[c.title, c.year].filter(Boolean).join(" ")}
                        </span>
                      ))}
                    </div>
                  )}

                  <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 8 }}>
                    AI synthesis from the published ZIN corpus. Validate findings against the source
                    rulings before use in dossier preparation.
                  </div>
                </div>
              </div>

              {(result.findings || []).length > 0 && (
                <>
                  <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 8 }}>
                    Key findings
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
                    {result.findings.map((f, i) => (
                      <div key={i} style={{ display: "flex", gap: 9, fontSize: 12.5 }}>
                        <span style={{ color: "var(--accent)" }}>▸</span>
                        <span>{f}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {(result.trend_data || []).length > 0 && trendKeys.length > 0 && (
                <>
                  <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 8 }}>
                    Rulings by dossier type
                  </div>
                  <div style={{ width: "100%", height: 200 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <RBarChart data={result.trend_data}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#EDEAF3" vertical={false} />
                        <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#6C6478" }} />
                        <YAxis tick={{ fontSize: 11, fill: "#6C6478" }} allowDecimals={false} />
                        <Tooltip />
                        <Legend wrapperStyle={{ fontSize: 11.5 }} formatter={(v) => categoryLabel(v)} />
                        {trendKeys.map((k, i) => (
                          <Bar key={k} dataKey={k} stackId="a" fill={COLOURS[i % COLOURS.length]} />
                        ))}
                      </RBarChart>
                    </ResponsiveContainer>
                  </div>
                </>
              )}

              {/* {activeSession && (
                <div style={{ marginTop: 12 }} data-pdf-hide="true">
                  <button className="v2-btn v2-sm" type="button" onClick={saveToSession}>
                    Save to {activeSession.drugName}
                  </button>
                </div>
              )} */}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function Insights() {
  const [insights, setInsights] = useState(null);
  const [rulings,  setRulings]  = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [windowMonths, setWindowMonths] = useState(24);   // Sr 81
  const [exporting,    setExporting]    = useState(false);
  const [trendSel,     setTrendSel]     = useState("latest");
  const pageRef = useRef(null);

  // Both requests run once. /api/insights is shared with the Dashboard and is
  // called exactly as before; the window is applied below, in the browser.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [i, r] = await Promise.allSettled([
          axios.get(`${API}/insights`),
          axios.get(`${API}/rulings`),
        ]);
        if (cancelled) return;
        if (i.status === "fulfilled") setInsights(i.value.data);
        if (r.status === "fulfilled" && Array.isArray(r.value.data)) setRulings(r.value.data);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const windowLabel = WINDOWS.find((w) => w.value === windowMonths)?.label ?? "";

  // ── The window: rulings whose decision month falls inside it ──────────────
  // Anchored on the newest decision month in the data, not on today's date, so
  // "Last 12 months" means the 12 months ending at the latest ruling.
  const windowed = useMemo(() => {
    const dated = rulings.filter((r) => monthIndex(r?.decision_date) != null);
    if (dated.length === 0) return null;
    if (!windowMonths) return dated;
    const endIdx = Math.max(...dated.map((r) => monthIndex(r.decision_date)));
    const lo = endIdx - windowMonths + 1;
    return dated.filter((r) => {
      const k = monthIndex(r.decision_date);
      return k >= lo && k <= endIdx;
    });
  }, [rulings, windowMonths]);

  const fromRows = windowed != null;
  const sum = useMemo(() => (fromRows ? summarise(windowed) : null), [fromRows, windowed]);

  // When the ruling rows could not be loaded, fall back to the corpus-wide
  // figures from /api/insights rather than showing zeros.
  const total     = sum?.total     ?? insights?.total_rulings ?? 0;
  const positive  = sum?.positive  ?? insights?.positive_decisions ?? 0;
  const cond      = sum?.conditional ?? insights?.conditional_decisions ?? 0;
  const negative  = sum?.negative  ?? insights?.negative_decisions ?? 0;
  const review    = sum?.review    ?? insights?.under_review_decisions ?? 0;
  const published = sum?.published ?? insights?.denominator_published ?? Math.max(0, total - review);
  const shares = sum?.shares ?? insights?.shares_pct ?? {
    positive: pct(positive, published), conditional: pct(cond, published), negative: pct(negative, published),
  };
  const corpusAll = insights?.total_rulings ?? rulings.length ?? total;

  // ── Sr 81 — quarterly series, for the window ──────────────────────────────
  const quarterly = useMemo(() => {
    if (fromRows) return quarterlySeries(windowed);
    const all = insights?.quarterly_trends || [];
    return windowMonths ? all.slice(-Math.ceil(windowMonths / 3)) : all;
  }, [fromRows, windowed, insights, windowMonths]);

  // ── Sr 85 — therapy areas, for the window ─────────────────────────────────
  const areaRows = useMemo(() => {
    if (fromRows) return byTherapyArea(windowed);
    const byArea = insights?.conditional_rate_by_area || {};
    return Object.entries(byArea)
      .filter(([, v]) => (v?.published ?? 0) > 0)
      .map(([area, v]) => ({ area, rate: v.rate ?? 0, total: v.total ?? 0, conditional: v.conditional ?? 0 }))
      .sort((a, b) => b.total - a.total);
  }, [fromRows, windowed, insights]);

  // ── Sr 90 — manufacturers, for the window ─────────────────────────────────
  const mfr = useMemo(() => {
    if (!windowed || windowed.length === 0) return null;
    const labels = manufacturerLabels(rulings);
    const rows = rankManufacturers(windowed, MFR_TOP_N, labels);
    return {
      rows,
      named: windowed.filter((r) => normaliseManufacturer(r?.manufacturer)).length,
      windowTotal: windowed.length,
      companies: new Set(windowed.map((r) => normaliseManufacturer(r?.manufacturer)).filter(Boolean)).size,
    };
  }, [windowed, rulings]);

  // ── Monthly decision trends — 6-month windows (own pager) ─────────────────
  const monthlyTrend = useMemo(() => normaliseMonthly(insights?.monthly_trends), [insights]);
  const trendWindows = useMemo(() => buildMonthWindows(monthlyTrend, TREND_WINDOW_MONTHS), [monthlyTrend]);

  const trendIdx =
    trendWindows.length === 0 || trendSel === "all" ? null
    : trendSel === "latest" ? trendWindows.length - 1
    : Math.min(Math.max(0, trendSel), trendWindows.length - 1);

  const visibleTrend = useMemo(() => {
    if (trendIdx == null) return monthlyTrend;
    const w = trendWindows[trendIdx];
    return monthlyTrend.slice(w.startIdx, w.endIdx);
  }, [monthlyTrend, trendWindows, trendIdx]);

  const prevTrend = useMemo(() => {
    if (trendIdx == null || trendIdx === 0) return [];
    const w = trendWindows[trendIdx - 1];
    return monthlyTrend.slice(w.startIdx, w.endIdx);
  }, [monthlyTrend, trendWindows, trendIdx]);

  const keyInsights = useMemo(
    () => deriveKeyInsights({
      visibleTrend,
      prevTrend,
      rulings,
      overall: {
        published,
        positiveShare: shares.positive,
        negative,
        areaCounts: Object.fromEntries(areaRows.map((a) => [a.area, a.total])),
      },
    }),
    [visibleTrend, prevTrend, rulings, published, shares.positive, negative, areaRows]
  );

  if (loading) {
    return (
      <div data-testid="insights-loading">
        <div className="v2-crumb">Analyse / Insights</div>
        <h1>Insights &amp; analytics</h1>
        <div className="v2-card v2-pad" style={{ color: "var(--muted)" }}>Loading…</div>
      </div>
    );
  }

  // Sr 83 — donut stops, as percentages of published decisions.
  const s1 = shares.conditional;
  const s2 = shares.conditional + shares.negative;

  return (
    <div data-testid="insights-page">
      <div className="v2-crumb">Analyse / Insights</div>
      <div className="v2-hdr">
        <div>
          <h1>Insights &amp; analytics</h1>
          <p className="v2-sub" style={{ margin: 0 }} data-testid="insights-subtitle">
            Trends across {total} ZIN assessments · {windowLabel.toLowerCase()}
            {insights?.corpus_current_to && ` · current to ${insights.corpus_current_to}`}
          </p>
        </div>
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
          <select
            className="v2-sel"
            value={windowMonths}
            onChange={(e) => setWindowMonths(Number(e.target.value))}
            data-testid="window-select"
          >
            {WINDOWS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
          </select>
          <button className="v2-btn v2-ghost" type="button" disabled={exporting} onClick={() => exportPageToPDF(pageRef, setExporting)}style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
			<DownloadCloudIcon size={18} />		
			 {exporting ? "Exporting…" : "Export PDF"}
          </button>
        </div>
      </div>

      {!fromRows && (
        <div className="v2-banner" style={{ marginBottom: 12 }}>
          <span aria-hidden="true">◈</span>
          <div>
            The ruling list could not be loaded, so these figures cover the whole corpus and do not
            follow the time range.
          </div>
        </div>
      )}

      <div ref={pageRef}>
        {/* ── Sr 82 — KPIs with definitions. Sr 80: no assessment-time tile ── */}
        <div className="v2-kpis" style={{ gridTemplateColumns: "repeat(4,1fr)", marginBottom: 16 }}>

          <div className="v2-kpi v2-card">
            <div className="n">{total}</div>
            <div className="l">
              {windowMonths ? "Total Rulings in this window" : "Total Rulings assessed"}{" "}
              <span className="v2-info" title={KPI_INFO.total}>i</span>
            </div>
            <div className="tr" style={{ color: "var(--pos)", fontWeight: 600 }}>
              {published} rulings are published
            </div>
            {insights?.added_recent > 0 && (
              <div
                className="tr"
                style={{ color: "var(--muted)", marginTop: 2 }}
                title="Rulings dated in the most recent month of the corpus"
              >
                ▲ {insights.added_recent} decided in the corpus's latest month
              </div>
            )}
          </div>

          <div className="v2-kpi v2-card">
            <div className="n" style={{ color: "var(--pos)" }}>{shares.positive}%</div>
            <div className="l">Positive without conditions <span className="v2-info" title={KPI_INFO.pos}>i</span></div>
            <div className="tr" style={{ color: "var(--pos)", fontWeight: 600 }}>
              {positive} of {published} published
            </div>
          </div>

          <div className="v2-kpi v2-card">
            <div className="n" style={{ color: "var(--cond)" }}>{shares.conditional}%</div>
            <div className="l">Positive with conditions <span className="v2-info" title={KPI_INFO.cond}>i</span></div>
            <div className="tr" style={{ color: "var(--cond)", fontWeight: 600 }}>
              {cond} of {published} published
            </div>
          </div>

          <div className="v2-kpi v2-card">
            <div className="n" style={{ color: "var(--neg)" }}>{shares.negative}%</div>
            <div className="l">Negative <span className="v2-info" title={KPI_INFO.neg}>i</span></div>
            <div className="tr" style={{ color: "var(--neg)", fontWeight: 600 }}>
              {negative} of {published} published
            </div>
          </div>

        </div>
        {/* Sr 80 — no "average review days" tile: the corpus holds decision
            dates only, so a median assessment time cannot be computed. */}

        <div className="v2-row" style={{ marginBottom: 16 }}>
          {/* ── Sr 83 — outcome donut ──────────────────────────────── */}
          <div className="v2-card v2-pad" style={{ flex: 1 }}>
            <h2>Decision outcomes</h2>
            <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: -4, marginBottom: 10 }}>
              {windowLabel}
            </div>
            <div style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
              <div className="v2-donut" style={{ "--s1": `${s1}%`, "--s2": `${s2}%` }}>
                <div>
                  <b>{shares.conditional}%</b>
                  <small>conditional</small>
                </div>
              </div>
              <div className="v2-lg">
                <div><i style={{ background: "var(--cond)" }} />Positive with conditions <b>{cond}</b></div>
                <div><i style={{ background: "var(--neg)" }} />Negative <b>{negative}</b></div>
                <div><i style={{ background: "var(--pos)" }} />Positive <b>{positive}</b></div>
                <div style={{ color: "var(--muted)" }}>
                  <i style={{ background: "var(--rev)" }} />Under review <b>{review}</b>
                  <span style={{ marginLeft: 6 }}>(excluded)</span>
                </div>
                <Link to="/search" style={{ fontSize: 12, marginTop: 5 }}>View these rulings →</Link>
              </div>
            </div>
            <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 11, paddingTop: 10, borderTop: "1px solid var(--line)" }}>
              Shares are of {published} published decisions in this window. The {review} still under review are
              excluded, which is why the three slices sum to 100%.
            </div>
          </div>

          {/* ── Sr 84 — quarterly shares ───────────────────────────── */}
          <div className="v2-card v2-pad" style={{ flex: 1.35 }}>
            <h2>Conditional approvals by quarter</h2>
            {quarterly.length === 0 ? (
              <div style={{ fontSize: 12.5, color: "var(--muted)" }}>No quarterly data available.</div>
            ) : (
              <>
                <div style={{ width: "100%", height: 200 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={quarterly}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#EDEAF3" vertical={false} />
                      <XAxis dataKey="quarter" tick={{ fontSize: 11, fill: "#6C6478" }} />
                      <YAxis tick={{ fontSize: 11, fill: "#6C6478" }} unit="%" domain={[0, 100]} />
                      <Tooltip formatter={(v, n) => [`${v}%`, n === "conditional_share" ? "Conditional" : "Negative"]} />
                      <Line type="monotone" dataKey="conditional_share" stroke="#B06D05" strokeWidth={2.5} dot={{ r: 3 }} name="conditional_share" />
                      <Line type="monotone" dataKey="negative_share" stroke="#B93636" strokeWidth={2.5} strokeDasharray="4 3" dot={false} name="negative_share" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div className="v2-lg row" style={{ marginTop: 6 }}>
                  <div><i style={{ background: "var(--cond)" }} />Conditional share</div>
                  <div><i style={{ background: "var(--neg)" }} />Negative share</div>
                </div>
                {/* Sr 84 — no "ZIN guidance update" marker: no such date
                    exists in the corpus, and an invented milestone would be
                    worse than none. */}
              </>
            )}
          </div>
        </div>

        {/* ── Sr 85 therapy areas · Sr 90 manufacturers, side by side ── */}
        <div className="v2-row" style={{ flexWrap: "wrap", marginBottom: 16 }}>

          <div className="v2-card v2-pad" style={{ flex: "1 1 440px", minWidth: 0 }} data-testid="area-chart">
            <h2>By therapy area</h2>
            <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: -4, marginBottom: 10 }}>
              {windowLabel}
            </div>
            {areaRows.length === 0 ? (
              <div style={{ fontSize: 12.5, color: "var(--muted)", padding: "28px 0" }}>
                No published decisions in this window. Widen the window to see therapy areas.
              </div>
            ) : (
              <>
                {/* Sr 95 — overflow is the guard, the margin is the fix. */}
                <div style={{ width: "100%", height: Math.max(180, areaRows.length * 34), overflow: "hidden" }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <RBarChart data={areaRows} layout="vertical" margin={{ left: 24, right: 22 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#EDEAF3" horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 11, fill: "#6C6478" }} allowDecimals={false} />
                      <YAxis type="category" dataKey="area" width={110} tick={{ fontSize: 11.5, fill: "#463C55" }} />
                      <Tooltip formatter={(v, n) => [v, n === "total" ? "Rulings" : "Conditional"]} />
                      <Bar dataKey="total" fill="#241663" opacity={0.25} name="total" />
                      <Bar dataKey="conditional" fill="#B06D05" name="conditional" />
                    </RBarChart>
                  </ResponsiveContainer>
                </div>
                <div className="v2-lg row" style={{ marginTop: 6 }}>
                  <div><i style={{ background: "#241663", opacity: .25 }} />All published decisions</div>
                  <div><i style={{ background: "var(--cond)" }} />Of which conditional</div>
                </div>
              </>
            )}
          </div>

          {/* ── Sr 90 — manufacturers ranked by positive decisions ──────── */}
          {mfr && (
            <div className="v2-card v2-pad" style={{ flex: "1 1 440px", minWidth: 0 }} data-testid="mfr-chart">
              <h2>By manufacturer</h2>
              <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: -4, marginBottom: 10 }}>
                Top {MFR_TOP_N} by positive decisions · {windowLabel.toLowerCase()}
              </div>

              {mfr.rows.length === 0 ? (
                <div style={{ fontSize: 12.5, color: "var(--muted)", padding: "28px 0" }}>
                  No ruling in this window names a manufacturer. Widen the window to rank them.
                </div>
              ) : (
                <>
                  <div style={{ width: "100%", height: Math.max(180, mfr.rows.length * 34), overflow: "hidden" }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <RBarChart data={mfr.rows} layout="vertical" margin={{ left: 24, right: 22 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#EDEAF3" horizontal={false} />
                        <XAxis
                          type="number"
                          tick={{ fontSize: 11, fill: "#6C6478" }}
                          allowDecimals={false}
                          domain={[0, (max) => Math.max(1, Math.ceil(max * 1.18))]}
                        />
                        <YAxis type="category" dataKey="name" width={124} tick={{ fontSize: 11.5, fill: "#463C55" }} />
                        {/* Sr 92 — tooltip names the manufacturer and nothing else. */}
                        <Tooltip
                          formatter={(v, n) => [v, n === "published" ? "Published decisions" : "Of which positive"]}
                          labelFormatter={(name) => name}
                        />
                        <Bar dataKey="published" fill="#241663" opacity={0.25} name="published">
                          <LabelList dataKey="published" position="right" style={{ fontSize: 10.5, fill: "#6C6478" }} />
                        </Bar>
                        <Bar dataKey="positive" fill="#1B7A54" name="positive">
                          <LabelList dataKey="positive" position="right" style={{ fontSize: 10.5, fill: "#1B7A54", fontWeight: 600 }} />
                        </Bar>
                      </RBarChart>
                    </ResponsiveContainer>
                  </div>

                  <div className="v2-lg row" style={{ marginTop: 6 }}>
                    <div><i style={{ background: "#241663", opacity: .25 }} />All published decisions</div>
                    <div><i style={{ background: "var(--pos)" }} />Of which positive</div>
                  </div>

                  <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 10, lineHeight: 1.55 }}>
                    Ranked on the {mfr.named} of {mfr.windowTotal} rulings in this window that name a
                    manufacturer, across {mfr.companies} companies. Individual Manufacturer name variants are collated;
                    For instance, AstraZeneca B.V. and AstraZeneca count once. Positive includes decisions
                    carried with conditions.
                    {(mfr.rows[0].positive < 5 || mfr.rows[mfr.rows.length - 1].positive < 3) && (
                      <> <b>At this window the leaders separate by only a few decisions — read the order as indicative.</b></>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

        </div>

        {/* ── Monthly decision trends — 6-month windows ── */}
        <div className="v2-card v2-pad" style={{ marginBottom: 16 }} data-testid="trends-chart">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <h2 style={{ margin: 0 }}>Monthly decision trends</h2>
              {monthlyTrend.length > 0 && (
                <span className="v2-chip">{monthlyTrend.length} months of data</span>
              )}
            </div>

            {trendWindows.length > 1 && (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <button
                  className="v2-btn v2-ghost v2-sm"
                  type="button"
                  aria-label={`Previous ${TREND_WINDOW_MONTHS} months`}
                  title={`Previous ${TREND_WINDOW_MONTHS} months`}
                  disabled={trendIdx == null || trendIdx === 0}
                  onClick={() => setTrendSel(trendIdx - 1)}
                  data-testid="trend-prev-btn"
                >
                  ‹
                </button>
                <select
                  className="v2-sel"
                  value={trendIdx == null ? "all" : String(trendIdx)}
                  onChange={(e) => setTrendSel(e.target.value === "all" ? "all" : Number(e.target.value))}
                  aria-label="Trend period"
                  data-testid="trend-window-select"
                >
                  <option value="all">All periods</option>
                  {[...trendWindows.keys()].reverse().map((i) => (
                    <option key={i} value={i}>{trendWindows[i].label}</option>
                  ))}
                </select>
                <button
                  className="v2-btn v2-ghost v2-sm"
                  type="button"
                  aria-label={`Next ${TREND_WINDOW_MONTHS} months`}
                  title={`Next ${TREND_WINDOW_MONTHS} months`}
                  disabled={trendIdx == null || trendIdx === trendWindows.length - 1}
                  onClick={() => setTrendSel(trendIdx + 1)}
                  data-testid="trend-next-btn"
                >
                  ›
                </button>
                <span style={{ fontSize: 12, color: "var(--muted)", fontVariantNumeric: "tabular-nums", minWidth: 40, textAlign: "right" }}>
                  {trendIdx == null ? `all ${trendWindows.length}` : `${trendIdx + 1} / ${trendWindows.length}`}
                </span>
              </div>
            )}
          </div>

          {monthlyTrend.length === 0 ? (
            <div style={{ fontSize: 12.5, color: "var(--muted)", padding: "24px 0" }}>
              No monthly trend data available. Rulings need a valid decision date to appear here.
            </div>
          ) : (
            <>
              <div style={{ width: "100%", height: 260 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={visibleTrend} margin={{ top: 10, right: 12, left: -8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#EDEAF3" vertical={false} />
                    <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#6C6478" }} interval="preserveStartEnd" minTickGap={18} />
                    <YAxis tick={{ fontSize: 11, fill: "#6C6478" }} allowDecimals={false} />
                    <Tooltip />
                    <Line type="monotone" dataKey="conditional" name="Positive with conditions" stroke="#B06D05" strokeWidth={2.5} dot={visibleTrend.length <= 12 ? { r: 3 } : false} />
                    <Line type="monotone" dataKey="negative" name="Negative" stroke="#B93636" strokeWidth={2.5} dot={visibleTrend.length <= 12 ? { r: 3 } : false} />
                    <Line type="monotone" dataKey="positive" name="Positive" stroke="#1B7A54" strokeWidth={2.5} dot={visibleTrend.length <= 12 ? { r: 3 } : false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="v2-lg row" style={{ marginTop: 6 }}>
                <div><i style={{ background: "var(--cond)" }} />Positive with conditions</div>
                <div><i style={{ background: "var(--neg)" }} />Negative</div>
                <div><i style={{ background: "var(--pos)" }} />Positive</div>
              </div>
              <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--line)" }}>
                Decisions per month by decision date, {keyInsights.period}. Months with no
                decisions show as zero. Rulings still under review are not counted.
              </div>
            </>
          )}
        </div>

        {/* ── Key insights for HTA submissions ──────────── */}
        {monthlyTrend.length > 0 && (
          <div className="v2-card" style={{ marginBottom: 16 }} data-testid="key-insights">
            <div className="v2-pad" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", borderBottom: "1px solid var(--line)" }}>
              <div>
                <h2 style={{ margin: 0 }}>Key insights for HTA submissions</h2>
                <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 3 }}>
                  Follows the period selected in Monthly decision trends.
                </div>
              </div>
              <span className="v2-chip" data-testid="key-insights-period">{keyInsights.period}</span>
            </div>
            <div className="v2-pad" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
              <InsightBox
                title="Success factors" icon="▲" tone={INSIGHT_TONES.success}
                items={keyInsights.success} empty="No positive rulings in this period."
                testId="key-insights-success"
              />
              <InsightBox
                title="ZIN focus areas" icon="◈" tone={INSIGHT_TONES.focus}
                items={keyInsights.focus} empty="No focus area data for this period."
                testId="key-insights-focus"
              />
              <InsightBox
                title="Common objections" icon="◑" tone={INSIGHT_TONES.objections}
                items={keyInsights.objections} empty="No objections recorded in this period."
                testId="key-insights-objections"
              />
              <InsightBox
                title="Timeline insights" icon="◔" tone={INSIGHT_TONES.timeline}
                items={keyInsights.timeline} empty="No timeline data for this period."
                testId="key-insights-timeline"
              />
            </div>
          </div>
        )}

        {/* Sr 86 — "What this means for your sessions" remains hidden. */}

        {/* Sr 88 — the Top Manufacturers table is deliberately absent. */}

        {/* Sr 87/97 — inside pageRef, so the analysis reaches the export.
            The chip shows the whole corpus: the question is answered across
            all rulings, not just the page window. */}
        <InsightQuestionPanel corpusTotal={corpusAll} />
      </div>

    </div>
  );
}