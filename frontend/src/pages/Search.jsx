// src/pages/Search.jsx
import { useState, useEffect, useMemo, useRef } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import axios from "axios";
import ReactMarkdown from "react-markdown";
import { useSession } from "../lib/SessionContext";
import {
  addQuestionToSession,
  saveQuestionSearchSnapshot,
  getQuestionSearchSnapshot,
} from "../lib/sessionStore";
import {
  packSnapshot, saveTabSnapshot, loadTabSnapshot, clearTabSnapshot,
} from "../lib/searchSnapshot";
import DossierReviewCard from "../components/DossierReviewCard";
import RulingPane from "../components/RulingPane";
import RulingLink from "../components/RulingLink";
import { categoryLabel, isReviewMode, CROSS_DOSSIER } from "../lib/dossierCategories";
import {
  getSavedSearches, saveSearch, deleteSavedSearch, markSavedSearchSeen,
  countNewSince, describeFilters, rulingCategories,
} from "../lib/savedSearches";
import { manufacturerOptions, normaliseManufacturer } from "../lib/manufacturers";
import {
  useThinkingMessage, SEARCH_THINKING, SEARCH_INTERVAL_MS,
} from "../lib/useThinkingMessage";
import { toast } from "sonner";

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;
const PAGE_SIZE    = 15;
const DEFAULT_YEAR = "2026";

// Number of real dossier types a ruling covers (0 for Uncategorised), used to
// list multi-type rulings first.
const dossierTypeCount = (r) =>
  rulingCategories(r).filter((c) => c !== "No Category").length;

// Dossier types for a result card, primary type first, without duplicates.
const dossierTypesForCard = (r) => {
  const cats = rulingCategories(r);
  const primary = r?.dossier_category;
  return primary && cats.includes(primary)
    ? [primary, ...cats.filter((c) => c !== primary)]
    : cats;
};

// Folds trivial spelling differences so one drug is one filter option.
const drugKey = (name) =>
  String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

    // Reserved filter key for rulings that name no drug. It cannot collide with a real
// drug because drugKey() only ever returns lowercase letters, digits and spaces.
const NO_DRUG_KEY   = "__uncategorised__";
const NO_DRUG_LABEL = "Uncategorised";

// The key a ruling filters under: its folded drug name, or the reserved key if none.
const rulingDrugKey = (ruling) => drugKey(ruling?.drug_name) || NO_DRUG_KEY;

// ← NEW: example queries, to remove the blank-box problem
const EXAMPLE_QUERIES = [
  "rulings rejected on comparator choice",
  "registry conditions in oncology",
  "ICER above €80,000 per QALY",
  "Pharmacoeconomic Dossier rulings since 2024",
];

// ← NEW: marks the searched terms inside a result snippet
function Highlight({ text, query }) {
  const src = String(text ?? "");
  const q   = (query || "").trim();
  if (!q || !src) return <>{src}</>;
  const terms = [...new Set(q.toLowerCase().split(/\s+/).filter((t) => t.length > 3))];
  if (terms.length === 0) return <>{src}</>;
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const parts   = src.split(new RegExp(`(${escaped.join("|")})`, "gi"));
  const lookup  = new Set(terms);
  return (
    <>
      {parts.map((part, i) =>
        lookup.has(part.toLowerCase())
          ? <mark key={i}>{part}</mark>
          : <span key={i}>{part}</span>
      )}
    </>
  );
}

if (process.env.NODE_ENV === "development" && !axios.__LOG_INTERCEPTORS__) {
  axios.__LOG_INTERCEPTORS__ = true;
  axios.interceptors.request.use((cfg) => {
    console.log("[REQ]", cfg.method?.toUpperCase(), cfg.url, { headers: cfg.headers, params: cfg.params });
    return cfg;
  });
  axios.interceptors.response.use(
    (res) => { console.log("[RES]", res.status, res.config?.url, res.data); return res; },
    (err) => {
      console.error("[ERR]", {
        message: err.message, code: err.code, url: err.config?.url,
        method: err.config?.method, status: err.response?.status, data: err.response?.data,
      });
      return Promise.reject(err);
    }
  );
}

// Sr 46 — outcome as a v2 tag. Replaces getOutcomeBadgeClass, which returned
// the legacy `.badge-*` classes defined in index.css (removed in Sr 2).
function outcomeTagV2(outcome) {
  if (!outcome) return <span className="v2-tag" style={{ background: "#F3F1F7", color: "var(--muted)" }}>Unknown</span>;
  if (outcome === "Positive")         return <span className="v2-tag v2-t-pos">✓ Positive</span>;
  if (outcome === "Negative")         return <span className="v2-tag v2-t-neg">✕ Negative</span>;
  if (outcome.includes("Conditions")) return <span className="v2-tag v2-t-cond">◑ Positive with conditions</span>;
  if (outcome.toLowerCase().includes("review")) return <span className="v2-tag v2-t-rev">⏳ Under review</span>;
  return <span className="v2-tag v2-t-cond">{outcome}</span>;
}

// ── Sr 93 — relevance bands ──────────────────────────────────────────────────
// The Q&A generator grades every predicted question high / medium / low and
// shows that as a tag. The same three bands are applied here to the search
// hits, so "which of these 50 rulings actually answers my question" is legible
// at a glance instead of having to compare percentages row by row.
//
// The band is derived from `relative`, the hit's score as a percentage of the
// TOP hit's score. That is a comparison within this result set, not an absolute
// measure of relevance: the first hit is always 100% and therefore always High,
// however weak the query. The tag's tooltip says so, because a green "High
// relevance" on a poor match would otherwise read as a guarantee.
const RELEVANCE_BANDS = [
  { key: "high",   min: 85, label: "High relevance",   cls: "v2-tag v2-t-pos",  mark: "▲" },
  { key: "medium", min: 65, label: "Medium relevance", cls: "v2-tag v2-t-cond", mark: "■" },
  { key: "low",    min: 0,  label: "Low relevance",    cls: "v2-tag",           mark: "▽" },
];

function relevanceBand(relative) {
  if (relative == null) return null;
  return RELEVANCE_BANDS.find((b) => relative >= b.min) || RELEVANCE_BANDS[RELEVANCE_BANDS.length - 1];
}

function relevanceTagV2(rel) {
  const band = relevanceBand(rel?.relative);
  if (!band) return null;
  return (
    <span
      className={band.cls}
      style={band.key === "low" ? { background: "#F3F1F7", color: "var(--muted)" } : undefined}
      title={
        `${Math.round(rel.relative)}% of the closest match's score, ranked ${rel.rank} of this result set. ` +
        "The band compares these results with each other — it is not an absolute measure of relevance."
      }
    >
      {band.mark} {band.label}
    </span>
  );
}

const seenWarnings = new Set();
function warnOnce(key, payload) {
  if (!seenWarnings.has(key)) { console.warn(key, payload); seenWarnings.add(key); }
}

function Spinner({ className = "w-4 h-4" }) {
  return (
    <svg className={`animate-spin ${className}`} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

// ─── ResultBox ────────────────────────────────────────────────────────────────
// Handles four distinct states:
//   1. off_topic  — amber banner, no sources ever shown
//   2. no_results — blue-grey info banner, no sources
//   3. normal     — answer + optional sources list
//   4. empty      — renders nothing
function ResultBox({
  answer, sources, rulings, isOffTopic, isNoResults, isNoSynthesis,
  confidence, sourceCount, matchedCount, "data-testid": testId,
}) {
  if (!answer || answer.trim() === "") return null;
  // Sr 25 — the badge states what the answer rests on. "low" is shown in the
  // conditional colour rather than the positive one, so a thin answer does not
  // look as solid as a well-grounded one.
  const confLabel = {
    high: "High confidence", moderate: "Moderate confidence", low: "Low confidence",
  }[confidence];
  const confClass = confidence === "high" ? "v2-conf"
    : confidence === "moderate" ? "v2-conf"
    : "v2-tag v2-t-cond";
  if (isOffTopic) {
    return (
      <div className="v2-banner" data-testid={testId} role="status" aria-live="polite">
        <span aria-hidden="true">⚠</span>
        <div>
          <b>Out of scope.</b> {answer}
        </div>
      </div>
    );
  }
  // Sr 100 — retrieval worked, synthesis did not. The ranked rulings are
  // above, so this says what is missing rather than borrowing the look of an
  // answer: a model refusal rendered in the AI card, under a heading reading
  // "Answer across these N rulings", is the one thing it must not look like.
  if (isNoSynthesis) {
    return (
      <div
        className="v2-banner"
        data-testid={testId}
        role="status"
        aria-live="polite"
        style={{ background: "#FBFAFD", borderColor: "var(--line)", color: "var(--ink-2)" }}
      >
        <span aria-hidden="true">◈</span>
        <div><b>No summary for this search.</b> {answer}</div>
      </div>
    );
  }
  if (isNoResults) {
    return (
      <div className="v2-banner" data-testid={testId} role="status" aria-live="polite"
           style={{ background: "#FBFAFD", borderColor: "var(--line)", color: "var(--ink-2)" }}>
        <span aria-hidden="true">◈</span>
        <div><b>No results found.</b> {answer}</div>
      </div>
    );
  }
  return (
    <div className="v2-ai" data-testid={testId}>
      <div style={{ width: "100%" }}>
        <div className="h">
          Answer across {matchedCount > 0 ? `these ${matchedCount} rulings` : "the ZIN corpus"}
          {confLabel && (
            <span className={confClass} style={{ fontSize: 10.5 }}>
              {confLabel} · {sourceCount} source{sourceCount !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--ink-2)" }}>
          <ReactMarkdown>{answer}</ReactMarkdown>
        </div>
        {Array.isArray(sources) && sources.length > 0 && (
          <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
            {sources.slice(0, 6).map((src, i) => {
              const label = (src.file || "Source")
                .replace(/\.[^/.]+$/, "").replace(/[_-]/g, " ").trim();
              return src.url ? (
                <a key={i} className="v2-chip cite" href={src.url} target="_blank" rel="noreferrer">
                  {label}{src.page_number ? ` p.${src.page_number}` : ""}
                </a>
              ) : (
                <span key={i} className="v2-chip cite">{label}</span>
              );
            })}
            {sources.length > 6 && (
              <span className="v2-chip cite">+{sources.length - 6} more</span>
            )}
          </div>
        )}
        <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 9 }}>
          Model summary, not advice. Check every citation before use.
        </div>
      </div>
    </div>
  );
}

// ─── PaginationControls ───────────────────────────────────────────────────────
// function PaginationControls({ currentPage, totalPages, onPageChange }) {
//   if (totalPages <= 1) return null;
//   return (
//     <div
//       className="v2-card v2-pad"
//       style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 12, flexWrap: "wrap" }}
//       data-testid="pagination-controls"
//     >
//       <span style={{ fontSize: 12.5, color: "var(--muted)" }}>
//         Page {currentPage} of {totalPages}
//       </span>
//       <div style={{ display: "flex", gap: 6 }}>
//         <button className="v2-btn v2-ghost v2-sm" type="button" onClick={() => onPageChange(1)} disabled={currentPage === 1}>« First</button>
//         <button className="v2-btn v2-ghost v2-sm" type="button" onClick={() => onPageChange(currentPage - 1)} disabled={currentPage === 1}>‹ Previous</button>
//         <button className="v2-btn v2-ghost v2-sm" type="button" onClick={() => onPageChange(currentPage + 1)} disabled={currentPage === totalPages}>Next ›</button>
//         <button className="v2-btn v2-ghost v2-sm" type="button" onClick={() => onPageChange(totalPages)} disabled={currentPage === totalPages}>Last »</button>
//       </div>
//     </div>
//   );
// }

function PaginationControls({ currentPage, totalPages, onPageChange, position = "bottom", ...rest }) {
  if (totalPages <= 1) return null;
  return (
    <div
      className="v2-card v2-pad"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        flexWrap: "wrap",
        // top placement sits between two cards, so it needs space below, not above
        marginTop:    position === "top" ? 0  : 12,
        marginBottom: position === "top" ? 12 : 0,
      }}
      data-testid={`pagination-controls-${position}`}
      {...rest}
    >
      <span style={{ fontSize: 12.5, color: "var(--muted)" }}>
        Page {currentPage} of {totalPages}
      </span>
      <div style={{ display: "flex", gap: 6 }}>
        <button className="v2-btn v2-ghost v2-sm" type="button" onClick={() => onPageChange(1)} disabled={currentPage === 1}>« First</button>
        <button className="v2-btn v2-ghost v2-sm" type="button" onClick={() => onPageChange(currentPage - 1)} disabled={currentPage === 1}>‹ Previous</button>
        <button className="v2-btn v2-ghost v2-sm" type="button" onClick={() => onPageChange(currentPage + 1)} disabled={currentPage === totalPages}>Next ›</button>
        <button className="v2-btn v2-ghost v2-sm" type="button" onClick={() => onPageChange(totalPages)} disabled={currentPage === totalPages}>Last »</button>
      </div>
    </div>
  );
}

// ─── PaginationButtons ────────────────────────────────────────────────────────
// Just the page label and buttons, so it can live inside another card.
function PaginationButtons({ currentPage, totalPages, onPageChange }) {
  if (totalPages <= 1) return null;
  return (
    <div
      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}
      data-testid="pagination-controls-top"
    >
      <span style={{ fontSize: 12.5, color: "var(--muted)" }}>
        Page {currentPage} of {totalPages}
      </span>
      <div style={{ display: "flex", gap: 6 }}>
        <button className="v2-btn v2-ghost v2-sm" type="button" onClick={() => onPageChange(1)} disabled={currentPage === 1}>« First</button>
        <button className="v2-btn v2-ghost v2-sm" type="button" onClick={() => onPageChange(currentPage - 1)} disabled={currentPage === 1}>‹ Previous</button>
        <button className="v2-btn v2-ghost v2-sm" type="button" onClick={() => onPageChange(currentPage + 1)} disabled={currentPage === totalPages}>Next ›</button>
        <button className="v2-btn v2-ghost v2-sm" type="button" onClick={() => onPageChange(totalPages)} disabled={currentPage === totalPages}>Last »</button>
      </div>
    </div>
  );
}

// ─── IndeterminateCheckbox ────────────────────────────────────────────────────
// React has no `indeterminate` prop, so it is set on the DOM node via a ref.
function IndeterminateCheckbox({ checked, indeterminate, onChange, ...rest }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(indeterminate);
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      {...rest}
    />
  );
}

// ─── YearDropdownFilter ───────────────────────────────────────────────────────
function YearDropdownFilter({ availableYears, selectedYears, onToggle, onClearAll, hasUnknownDateRulings }) {
  const options = hasUnknownDateRulings ? [...availableYears, "Unknown"] : availableYears;
  return (
    <div data-testid="year-filter">
      <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5, maxHeight: 168, overflowY: "auto" }}>
        {options.map((year) => (
          <label key={year} style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer" }}>
            <input type="checkbox" checked={selectedYears.includes(year)} onChange={() => onToggle(year)} />
            <span style={{ flex: 1 }}>{year === "Unknown" ? "Unknown date" : year}</span>
          </label>
        ))}
      </div>
      {selectedYears.length > 0 && (
        <button
          type="button"
          onClick={onClearAll}
          style={{ marginTop: 7, background: "none", border: 0, padding: 0, font: "inherit", fontSize: 11.5, color: "var(--accent)", textDecoration: "underline", cursor: "pointer" }}
        >
          Clear years
        </button>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function Search() {
  const location = useLocation();
  const navigate = useNavigate();
  const { openSavePicker, activeSession, refreshSessions, dossierReview, clearDossierReview  } = useSession();
  const [rulings,                setRulings]                = useState([]);
  const [filteredRulings,          setFilteredRulings]          = useState([]);
  const [loading,                setLoading]                = useState(true);
  const [fetchError,               setFetchError]               = useState(null);
  const [isSearching,              setIsSearching]              = useState(false);
  // Narrates the wait in the results area. The Search button keeps a fixed
  // "Searching…" — it sits in a row with Clear and Save, and a label resizing
  // every second and a half would shove its neighbours sideways.
  const thinkingMessage = useThinkingMessage(isSearching, SEARCH_THINKING, SEARCH_INTERVAL_MS);
  const [searchQuery,              setSearchQuery]              = useState("");
  const [backendAnswer,            setBackendAnswer]            = useState("");
  const [backendSources,           setBackendSources]           = useState([]);
  const [therapyAreas,             setTherapyAreas]             = useState([]);
  const [decisionOutcomes,         setDecisionOutcomes]         = useState([]);
  const [dossierCategories,        setDossierCategories]        = useState([]);
  const [selectedTherapyAreas,     setSelectedTherapyAreas]     = useState([]);
  const [selectedOutcomes,         setSelectedOutcomes]         = useState([]);
  const [selectedDossierCategories,setSelectedDossierCategories]= useState([]);
  // A single boolean rather than a facet group: a ruling either states a
  // research question or it does not, and "no PICO" is not something anyone
  // narrows to deliberately.
  // Folded manufacturer key, or "" for no manufacturer filter. Single-select:
  // this facet exists to check one company's count against the Insights chart,
  // and a multi-select union would not answer that question.
  const [selectedManufacturer,     setSelectedManufacturer]     = useState("");
  const [selectedDrugs, setSelectedDrugs] = useState([]);   // folded keys
  const [drugQuery,     setDrugQuery]     = useState("");
  const [mfrQuery,                setMfrQuery]                = useState("");
  const [onlyPico,                setOnlyPico]                = useState(false);
  const [selectedYears,            setSelectedYears]            = useState([DEFAULT_YEAR]);
  const [currentPage,              setCurrentPage]              = useState(1);
  const [aiMatchedIds,             setAiMatchedIds]             = useState([]);
  // Why each matched ruling ranked where it did: relative score, position and
  // the page-chunk that matched. Keyed by ruling id for lookup on the card.
  const [aiRelevance,              setAiRelevance]              = useState({});
  const [submittedQuery,           setSubmittedQuery]           = useState("");
  // ← NEW: rulings ticked for saving into a session
  const [selected, setSelected] = useState(new Set());
  // ← NEW: tracks the type of the last backend response
  // "none" | "off_topic" | "no_results" | "answer"
  const [resultType, setResultType] = useState("none");
  // ── Redesign additions ──────────────────────────────────────────────────────
  // How the query is matched: the AI endpoint is meaning-based; "exact" and
  // "both" are resolved locally against the ruling corpus.
  // Search matching is no longer a user choice. The design offers one
  // unrestricted entry point for questions, product names and keywords alike,
  // and asking people to pick a retrieval strategy puts an implementation
  // detail in front of the task.
  //
  // "both" is the fixed strategy because it is the forgiving one: meaning-based
  // hits come first, then any literal match the AI did not return — so a
  // product-name or reference lookup still finds its ruling even when the
  // semantic pass misses it.
  const [sortBy,         setSortBy]         = useState("newest");   // relevant | newest | oldest
  // Rulings opened from this result set — drives the "keep these together" nudge.
  const [openedRulings,  setOpenedRulings]  = useState(new Set());
  // Sr 50 — the ruling summary opens inside this page, so the query, the
  // filters and the position in the result set all stay alive. Previously it
  // was a separate route, so coming back meant re-running the search.
  const [paneRulingId,   setPaneRulingId]   = useState(null);
  // Sr 25 — so the synthesis can state how much it rests on, instead of
  // presenting every answer with equal weight.
  const [aiConfidence,   setAiConfidence]   = useState(null);
  const [aiSourceCount,  setAiSourceCount]  = useState(0);
  // Sr 100 — the model declined to summarise, but the ranking still stands.
  const [aiNoSynthesis,  setAiNoSynthesis]  = useState(false);
  // "Save this search" — turns a lookup into something you come back to.
  const [savedSearches,  setSavedSearches]  = useState(() => getSavedSearches());
  const [nudgeDismissed, setNudgeDismissed] = useState(false);

  const requiredRulingFields = useMemo(() => [
    "id", "title", "summary", "decision_outcome", "therapy_area",
    "dossier_category", "manufacturer", "decision_date", "drug_name", "tags",
  ], []);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const outcomeParam    = params.get("outcome");
    // `therapyArea` may repeat (Insights passes every label in its scope); a
    // single value behaves exactly as before.
    const therapyAreaParams = params.getAll("therapyArea").filter(Boolean);
    const yearRangeParam    = params.get("yearFrom") || params.get("yearTo");
    if (outcomeParam)     setSelectedOutcomes([outcomeParam]);
    if (therapyAreaParams.length > 0) setSelectedTherapyAreas(therapyAreaParams);
    if (outcomeParam || therapyAreaParams.length > 0 || yearRangeParam) setSelectedYears([]);
  }, [location.search]);

  const availableYears = useMemo(() => {
    const yearSet = new Set();
    rulings.forEach((r) => {
      const date = r?.decision_date || "";
      if (date && date.length >= 4) {
        const year = date.substring(0, 4);
        if (/^\d{4}$/.test(year)) yearSet.add(year);
      }
    });
    return [...yearSet].sort((a, b) => b.localeCompare(a));
  }, [rulings]);

  useEffect(() => {
    if (availableYears.length === 0) return;
    const params = new URLSearchParams(location.search);
    if (params.get("outcome") || params.get("therapyArea")) return;
    if (params.get("yearFrom") || params.get("yearTo")) return;
    setSelectedYears((prev) => {
      if (location.state?.restore === "snapshot") return prev;
      if (aiMatchedIds.length > 0) return prev;
      if (isSearching) return prev;
      if (prev.length === 0 && submittedQuery) return prev;
      const stillValid = prev.filter((y) => availableYears.includes(y));
      if (stillValid.length > 0) return stillValid;
      return availableYears[0] ? [availableYears[0]] : [];
    });
  }, [availableYears, location.search, aiMatchedIds, isSearching, submittedQuery]);

  // Optional ?yearFrom=&yearTo= (inclusive), sent by Insights' "View all …
  // rulings in ruling search" so the list shows the exact period it analysed.
  // Applied once the corpus has loaded, because the year options come from it.
  useEffect(() => {
    if (availableYears.length === 0) return;
    const params = new URLSearchParams(location.search);
    const from = parseInt(params.get("yearFrom"), 10);
    const to   = parseInt(params.get("yearTo"), 10);
    if (Number.isNaN(from) && Number.isNaN(to)) return;
    setSelectedYears(availableYears.filter((y) => {
      const n = Number(y);
      return (Number.isNaN(from) || n >= from) && (Number.isNaN(to) || n <= to);
    }));
  }, [availableYears, location.search]);

  const hasUnknownDateRulings = useMemo(() =>
    rulings.some((r) => {
      const date = r?.decision_date || "";
      return !date || date.length < 4 || !/^\d{4}$/.test(date.substring(0, 4));
    }),
    [rulings]
  );

  // ── Corpus summary for the page subtitle (real data, no placeholders) ───────
  const corpusMeta = useMemo(() => {
    const dates = rulings
      .map((r) => r?.decision_date)
      .filter((d) => typeof d === "string" && d.length >= 7)
      .sort();
    const fmt = (d) => {
      const dt = new Date(d);
      return Number.isNaN(dt.getTime())
        ? null
        : dt.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
    };
    return {
      total: rulings.length,
      from:  dates.length ? fmt(dates[0]) : null,
      to:    dates.length ? fmt(dates[dates.length - 1]) : null,
    };
  }, [rulings]);

  // ── Facet counts ────────────────────────────────────────────────────────────
  // Counted over the query-scoped corpus so a user never clicks into an empty
  // result set. Counts are independent per facet group (the standard approach).
  // STEP 1 of the pipeline (Sr 44): resolve the query — semantic, literal or
  // both — into a candidate set, with no facet filtering applied yet.
  //
  // This logic used to exist twice: once here for the facet counts, and once
  // inside the filter effect, where the facet filters sat in an `else` branch
  // that a semantic search never reached. One shared memo means the counts in
  // the sidebar and the rows in the list provably describe the same set.
  const queryCandidates = useMemo(() => {
    const all   = Array.isArray(rulings) ? rulings : [];
    const query = (submittedQuery || "").toLowerCase().trim();
    const matchesLiterally = (r) => {
      if (!query) return true;
      const t = r?.title?.toLowerCase?.()        || "";
      const d = r?.drug_name?.toLowerCase?.()    || "";
      const m = r?.manufacturer?.toLowerCase?.() || "";
      const s = r?.summary?.toLowerCase?.()      || "";
      return t.includes(query) || d.includes(query) || m.includes(query) || s.includes(query);
    };
    // Semantic hits keep the order the backend ranked them in, so the
    // "most relevant" sort has a real relevance order to preserve.
    if (aiMatchedIds.length > 0) {
      const rank   = new Map(aiMatchedIds.map((id, i) => [id, i]));
      const aiHits = all
        .filter((r) => rank.has(r?.id))
        .sort((a, b) => rank.get(a?.id) - rank.get(b?.id));
      // Meaning-based hits first, then any literal match the AI did not return.
      if (query) {
        const seen = new Set(aiHits.map((r) => r?.id));
        return [...aiHits, ...all.filter((r) => !seen.has(r?.id) && matchesLiterally(r))];
      }
      return aiHits;
    }
    if (!query) return all;
    return all.filter(matchesLiterally);
  }, [rulings, aiMatchedIds, submittedQuery]);

  const facetBase = queryCandidates;

  const facetCounts = useMemo(() => {
    const tally = (key) =>
      facetBase.reduce((acc, r) => {
        const v = r?.[key];
        if (v) acc[v] = (acc[v] || 0) + 1;
        return acc;
      }, {});
    return {
      therapy_area:     tally("therapy_area"),
      decision_outcome: tally("decision_outcome"),
      // Counted once under EACH dossier type a ruling covers, so these can add
      // up to more than the number of rulings.
      dossier_category: facetBase.reduce((acc, r) => {
        rulingCategories(r).forEach((c) => { acc[c] = (acc[c] || 0) + 1; });
        return acc;
      }, {}),
      // Counted separately: tally() keys on the value, and a boolean false
      // would be dropped by its truthiness check.
      pico:             facetBase.reduce((n, r) => n + (r?.pico_stated ? 1 : 0), 0),
    };
  }, [facetBase]);

  // ── Manufacturer facet ──────────────────────────────────────────────────────
  // Options are folded over the WHOLE corpus, not the query-scoped candidates,
  // so a company carries one label and one variant list however the search is
  // narrowed. Counts, though, are per the candidate set like every other facet.
  const mfrOptions = useMemo(() => manufacturerOptions(rulings), [rulings]);

  const mfrCounts = useMemo(() => {
    const counts = new Map();
    facetBase.forEach((r) => {
      const key = normaliseManufacturer(r?.manufacturer);
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    return counts;
  }, [facetBase]);

  // Typed text narrows on the label AND on every folded spelling, so searching
  // "Sciences" still finds Gilead, whose display label no longer contains it.
  const mfrVisible = useMemo(() => {
    const q = mfrQuery.trim().toLowerCase();
    const rows = mfrOptions
      .map((o) => ({ ...o, count: mfrCounts.get(o.key) ?? 0 }))
      .filter((o) => o.count > 0 || o.key === selectedManufacturer);
    if (!q) return rows;
    return rows.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        o.variants.some((v) => v.toLowerCase().includes(q))
    );
  }, [mfrOptions, mfrCounts, mfrQuery, selectedManufacturer]);

  const selectedMfr = useMemo(
    () => mfrOptions.find((o) => o.key === selectedManufacturer) || null,
    [mfrOptions, selectedManufacturer]
  );

  // ── Drug facet ─────────────────────────────────────────────────────────────
  // Options come from the WHOLE corpus so a drug keeps one label however the
  // search is narrowed; counts are per the query-scoped candidates, like every
  // other facet.
  const drugOptions = useMemo(() => {
    const map = new Map();   // key -> { key, label, variants:Set }
    rulings.forEach((r) => {
      const raw = (r?.drug_name || "").trim();
      const key = drugKey(raw);
      if (!key) return;
      const entry = map.get(key) || { key, label: raw, variants: new Set() };
      entry.variants.add(raw);
      map.set(key, entry);
    });
    return [...map.values()]
      .map((o) => ({ ...o, variants: [...o.variants] }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [rulings]);

  const drugCounts = useMemo(() => {
    const counts = new Map();
    facetBase.forEach((r) => {
      const key = rulingDrugKey(r);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    return counts;
  }, [facetBase]);

  const drugVisible = useMemo(() => {
    const q = drugQuery.trim().toLowerCase();
    const named = drugOptions
      .map((o) => ({ ...o, count: drugCounts.get(o.key) ?? 0 }))
      // Hide options with no matches, but keep ticked ones so they can be unticked.
      .filter((o) => o.count > 0 || selectedDrugs.includes(o.key));
    
    const uncategorized = {
      key: NO_DRUG_KEY,
      label: NO_DRUG_LABEL,
      variants: [],
      count: drugCounts.get(NO_DRUG_KEY) ?? 0,
    };
    const showUncategorized =
      uncategorized.count > 0 || selectedDrugs.includes(NO_DRUG_KEY);

    const rows = showUncategorized ? [uncategorized, ...named] : named;

    if (!q) return rows;
    return rows.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        o.variants.some((v) => v.toLowerCase().includes(q))
    );
  }, [drugOptions, drugCounts, drugQuery, selectedDrugs]);

  const toggleDrug = (key) => {
    setSelectedDrugs((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
    resetPage();
  };

  // ── Drug "Select all" ───────────────────────────────────────────────────────
  // Scope = the drugs currently listed. drugVisible is already narrowed by the
  // type-ahead text, so:
  //   - empty text box  -> every available drug (not just those scrolled into view)
  //   - text typed      -> only the drugs matching that text
  const scopedDrugKeys = useMemo(() => drugVisible.map((o) => o.key), [drugVisible]);

  const allScopedDrugsSelected =
    scopedDrugKeys.length > 0 &&
    scopedDrugKeys.every((k) => selectedDrugs.includes(k));

  const someScopedDrugsSelected =
    !allScopedDrugsSelected &&
    scopedDrugKeys.some((k) => selectedDrugs.includes(k));

  const toggleAllDrugs = (checked) => {
    const scoped = new Set(scopedDrugKeys);
    setSelectedDrugs((prev) =>
      checked
        ? [...new Set([...prev, ...scopedDrugKeys])]   // add scoped drugs, keep the rest
        : prev.filter((k) => !scoped.has(k))           // remove only the scoped drugs
    );
    resetPage();
  };

  const totalPages       = Math.max(1, Math.ceil(filteredRulings.length / PAGE_SIZE));
  const paginatedRulings = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return filteredRulings.slice(start, start + PAGE_SIZE);
  }, [filteredRulings, currentPage]);
  const resetPage        = () => setCurrentPage(1);
  const handlePageChange = (page) => { setCurrentPage(page); window.scrollTo({ top: 0, behavior: "smooth" }); };

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true); setFetchError(null);
      try {
        const [r, ta, doRes, dc] = await Promise.all([
          axios.get(`${API}/rulings`),
          axios.get(`${API}/therapy-areas`),
          axios.get(`${API}/decision-outcomes`),
          axios.get(`${API}/dossier-categories`),
        ]);
        const rulingsData = r.data || [];
        rulingsData.slice(0, 5).forEach((item, idx) => {
          requiredRulingFields.forEach((f) => {
            if (item?.[f] == null) warnOnce(`rulings[${idx}] missing field: ${f}`, item);
          });
          if (!Array.isArray(item?.tags))
            warnOnce(`rulings[${idx}].tags should be an array`, item?.tags);
        });
        setRulings(rulingsData);
        setFilteredRulings(rulingsData);
        setTherapyAreas(ta.data   || []);
        setDecisionOutcomes(doRes.data || []);
        // Sr 13 — the endpoint now returns {value,label,is_review_mode}
        // objects. Normalise so this page works against either shape.
        setDossierCategories(
          (dc.data || []).map((c) =>
            typeof c === "string"
              ? { value: c, label: categoryLabel(c), is_review_mode: isReviewMode(c) }
              : { value: c.value, label: c.label || categoryLabel(c.value), is_review_mode: !!c.is_review_mode }
          )
        );
      } catch (e) {
        console.error(e);
        setFetchError("Failed to load data");
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [requiredRulingFields]);

  // Exact restore when returning from Q&A. Runs once, after the corpus loads.
  // Order of preference: the snapshot stored on the question, then the tab copy,
  // then a fresh search rebuilt from the saved question text and ruling ids.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || loading || rulings.length === 0) return;
    if (location.state?.restore !== "snapshot") return;
    restoredRef.current = true;
    const { sessionId, questionId, query: stateQuery, rulingIds: stateIds } = location.state || {};
    let snap = (sessionId && questionId)
      ? getQuestionSearchSnapshot(sessionId, questionId)
      : null;
    if (!snap) snap = loadTabSnapshot();
    if (snap) {
      applySnapshot(snap);
      clearTabSnapshot();
      navigate(location.pathname, { replace: true, state: null });
      return;
    }
    const q = (stateQuery || "").trim();
    if (q) {
      setSearchQuery(q);
      setSelected(new Set(stateIds || []));
      handleSearch(q, {}).then(() => setSelected(new Set(stateIds || [])));
      toast("No saved view was found, so this is a fresh search for your question.");
    } else {
      toast("The previous search could not be restored.");
    }
    navigate(location.pathname, { replace: true, state: null });
  }, [loading, rulings]);

  // ── Filter pipeline (Sr 44) ─────────────────────────────────────────────────
  // STEP 2 — facets, then STEP 3 — sort.
  //
  // The facet filters are applied to the candidate set in EVERY search mode.
  // Previously they lived in an `else` branch that only ran when there were no
  // semantic hits, so after any meaning-based search the whole sidebar silently
  // did nothing: ticking "Cardiology" changed the counts but not the results.
  useEffect(() => {
    if (isSearching) return;
    let results = queryCandidates;
    if (selectedTherapyAreas.length > 0)
      results = results.filter((r) => selectedTherapyAreas.includes(r?.therapy_area));
    if (selectedOutcomes.length > 0)
      results = results.filter((r) => selectedOutcomes.includes(r?.decision_outcome));
    if (selectedDossierCategories.length > 0)
      results = results.filter((r) =>
        rulingCategories(r).some((c) => selectedDossierCategories.includes(c)));
    if (selectedManufacturer)
      results = results.filter((r) => normaliseManufacturer(r?.manufacturer) === selectedManufacturer);
    if (selectedDrugs.length > 0)
      results = results.filter((r) => selectedDrugs.includes(rulingDrugKey(r)));
    if (onlyPico)
      results = results.filter((r) => r?.pico_stated === true);
    if (selectedYears.length > 0) {
      results = results.filter((r) => {
        const date        = r?.decision_date || "";
        const year        = date.length >= 4 ? date.substring(0, 4) : "";
        const isValidYear = /^\d{4}$/.test(year);
        if (selectedYears.includes("Unknown") && !isValidYear) return true;
        return isValidYear && selectedYears.includes(year);
      });
    }
    // "Most relevant" keeps the candidate order (semantic rank, or corpus order
    // for a literal search); the date sorts re-order explicitly.
    let sorted = results;
    if (sortBy !== "relevant") {
      const dir = sortBy === "oldest" ? 1 : -1;
      sorted = results.slice().sort((a, b) => {
        const dateA = a?.decision_date ? new Date(a.decision_date) : new Date(0);
        const dateB = b?.decision_date ? new Date(b.decision_date) : new Date(0);
        return (dateB - dateA) * (dir === 1 ? -1 : 1);
      });
    }
    // Group by how many dossier types a ruling covers — 3 first, then 2, then
    // 1, then Uncategorised. Array.sort is stable, so the order chosen above
    // (newest / oldest / most relevant) is kept inside each group.
    sorted = sorted.slice().sort((a, b) => dossierTypeCount(b) - dossierTypeCount(a));
    setFilteredRulings(sorted);
    resetPage();
  }, [queryCandidates, selectedTherapyAreas, selectedOutcomes, selectedDossierCategories,
      selectedManufacturer, selectedDrugs, onlyPico, selectedYears, isSearching, sortBy]);

  const toggleTherapyArea    = (area)    => setSelectedTherapyAreas((prev)    => prev.includes(area)    ? prev.filter((a) => a !== area)    : [...prev, area]);
  const toggleOutcome        = (outcome) => setSelectedOutcomes((prev)        => prev.includes(outcome) ? prev.filter((o) => o !== outcome) : [...prev, outcome]);
  const toggleDossierCategory= (dossier) => setSelectedDossierCategories((prev)=> prev.includes(dossier)? prev.filter((o) => o !== dossier) : [...prev, dossier]);
  const toggleYear           = (year)    => setSelectedYears((prev)           => prev.includes(year)    ? prev.filter((y) => y !== year)    : [...prev, year]);

  // ── NEW: ruling selection + save-to-session ──────────────────────────────
  const toggleSelect = (id) => setSelected((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const selectAllOnPage = (checked) =>
    setSelected(checked ? new Set(paginatedRulings.map((r) => r.id)) : new Set());

  // The titles of the ticked rulings, so a saved session can list them by
  // name. Previously only ids were handed over and the names — available right
  // here in filteredRulings — were discarded, which left the "N rulings saved"
  // chip pointing at nothing.
  const rulingSummariesFor = (ids) => {
    const want = ids instanceof Set ? ids : new Set(ids || []);
    // Resolve against the whole corpus, not the filtered page: an AI hand-off
    // can include rulings the active facets have filtered out of view.
    return rulings
      .filter((r) => want.has(r?.id))
      .map((r) => ({
        id:    r.id,
        title: r.title || "Untitled ruling",
        year:  (r.decision_date || "").slice(0, 4) || null,
      }));
  };

  const selectedRulingSummaries = () => rulingSummariesFor(selected);

  const handleSaveToSession = () => {
    openSavePicker({
      query: submittedQuery || searchQuery.trim() || "Saved rulings",
      rulingIds: Array.from(selected),
      rulings:   selectedRulingSummaries(),
    });
  };

  // ── Redesign: result-set actions ────────────────────────────────────────────
  const currentQueryLabel = submittedQuery || searchQuery.trim() || "Saved rulings";

  // Everything needed to put this page back exactly as the user left it.
  const buildSnapshot = () => ({
    searchQuery,
    submittedQuery,
    backendAnswer,
    backendSources,
    resultType,
    aiMatchedIds,
    aiRelevance,
    aiConfidence,
    aiSourceCount,
    aiNoSynthesis,
    selectedTherapyAreas,
    selectedOutcomes,
    selectedDossierCategories,
    selectedDrugs,
    onlyPico,
    selectedYears,
    sortBy,
    currentPage,
    selected: Array.from(selected),
    openedRulings: Array.from(openedRulings),
    scrollY: window.scrollY,
  });

  const applySnapshot = (snap) => {
    setSearchQuery(snap.searchQuery ?? "");
    setSubmittedQuery(snap.submittedQuery ?? "");
    setBackendAnswer(snap.backendAnswer ?? "");
    setBackendSources(snap.backendSources ?? []);
    setResultType(snap.resultType ?? "none");
    setAiMatchedIds(snap.aiMatchedIds ?? []);
    setAiRelevance(snap.aiRelevance ?? {});
    setAiConfidence(snap.aiConfidence ?? null);
    setAiSourceCount(snap.aiSourceCount ?? 0);
    setAiNoSynthesis(Boolean(snap.aiNoSynthesis));
    setSelectedTherapyAreas(snap.selectedTherapyAreas ?? []);
    setSelectedOutcomes(snap.selectedOutcomes ?? []);
    setSelectedDossierCategories(snap.selectedDossierCategories ?? []);
    setSelectedDrugs(snap.selectedDrugs ?? []);
    setOnlyPico(Boolean(snap.onlyPico));
    setSelectedYears(snap.selectedYears ?? []);
    setSortBy(snap.sortBy ?? "newest");
    setSelected(new Set(snap.selected ?? []));
    setOpenedRulings(new Set(snap.openedRulings ?? []));
    // The pipeline effect resets to page 1 when filters change, so the saved
    // page and scroll position are applied after it has run.
    setTimeout(() => {
      setCurrentPage(snap.currentPage ?? 1);
      window.scrollTo({ top: snap.scrollY ?? 0 });
    }, 0);
  };

  // Remember which rulings the user opened, so the "keep these together" prompt
  // only appears after real research activity.
  const markRulingOpened = (id) => {
    if (id == null) return;
    setOpenedRulings((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

  // ── Sr 50 — in-page ruling view ─────────────────────────────────────────
  const openRulingInPage = (id) => {
    if (id == null) return;
    markRulingOpened(id);
    setPaneRulingId(id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const closeRulingPane = () => setPaneRulingId(null);

  // Position within the *filtered* set, so Previous/Next walk the list the user
  // is actually looking at rather than the whole corpus.
  const paneIndex = paneRulingId == null
    ? -1
    : filteredRulings.findIndex((r) => r?.id === paneRulingId);

  const stepRuling = (delta) => {
    const next = paneIndex + delta;
    if (next < 0 || next >= filteredRulings.length) return;
    openRulingInPage(filteredRulings[next]?.id);
  };

  // ── Save this search ──────────────────────────────────────────────────────
  const currentFilters = () => ({
    therapyAreas:      selectedTherapyAreas,
    outcomes:          selectedOutcomes,
    dossierCategories: selectedDossierCategories,
    manufacturer:      selectedManufacturer,
    manufacturerLabel: selectedMfr?.label || "",
    onlyPico,
    years:             selectedYears,
  });

  // Remove the button "Save this Search"
  //
  // const handleSaveSearch = () => {
  //   const q = (submittedQuery || searchQuery).trim();
  //   if (!q) {
  //     toast.warning("Enter a search before saving it.");
  //     return;
  //   }
  //   const result = saveSearch({
  //     query: q,
  //     filters: currentFilters(),
  //     matchedCount: filteredRulings.length,
  //     rulings,
  //   });
  //   if (!result) return;
  //   setSavedSearches(getSavedSearches());
  //   toast.success(result.updated
  //     ? "Saved search updated."
  //     : "Search saved. New matching rulings will be flagged when you return.");
  // };

  // Restores the query AND the filters, so re-running reproduces the result set
  // rather than just re-typing the words.
  const handleRunSaved = (saved) => {
    setSearchQuery(saved.query);
    setSelectedTherapyAreas(saved.filters?.therapyAreas || []);
    setSelectedOutcomes(saved.filters?.outcomes || []);
    setSelectedDossierCategories(saved.filters?.dossierCategories || []);
    setSelectedManufacturer(saved.filters?.manufacturer || "");
    setOnlyPico(Boolean(saved.filters?.onlyPico));
    setSelectedYears(saved.filters?.years || []);
    markSavedSearchSeen(saved.id, rulings);
    setSavedSearches(getSavedSearches());
    setTimeout(() => handleSearch(saved.query, saved.filters), 0);
  };

  const handleDeleteSaved = (id) => {
    deleteSavedSearch(id);
    setSavedSearches(getSavedSearches());
    toast("Saved search removed.");
  };

  const handleCopyCitation = (ruling) => {
    const parts = [
      ruling?.title,
      ruling?.manufacturer,
      ruling?.decision_outcome,
      ruling?.decision_date,
      "Zorginstituut Nederland",
    ].filter(Boolean);
    const citation = parts.join(" · ");
    navigator.clipboard?.writeText(citation)
      .then(() => toast.success("Citation copied"))
      .catch(() => toast.error("Could not copy citation"));
  };

  // Carry the ticked rulings into a session, then hand off to the Q&A generator
  // (Sr 45).
  //
  // This used to open the picker and navigate in the same tick, so the modal was
  // torn down mid-decision and you arrived at Q&A with nothing attached. The
  // navigation is now the picker's continuation: it runs only once a session has
  // actually been chosen or created, and not at all if the user cancels.
  const handleGenerateFromSelection = () => {
    if (selected.size === 0) return;
    const snapshot = buildSnapshot();
    saveTabSnapshot(snapshot);
    const rulingIds = Array.from(selected);
    // The attached dossier goes into the stored question, not just the route
    // state: route state dies on a refresh, and a question that has lost its
    // dossier generates silently different output next time it is opened.
    const attached = dossierReview?.uploadId ? dossierReview : null;
    const handoff = { query: currentQueryLabel, rulingIds,
                rulings: selectedRulingSummaries(), dossierReview: attached };
    const storeSnapshot = (sessionId, questionId) => {
      if (!sessionId || !questionId) return;
      const stored = saveQuestionSearchSnapshot(sessionId, questionId, packSnapshot(snapshot));
      if (!stored) {
        toast.warning("Your search view couldn't be saved, so Change will run a fresh search.");
      }
    };
    if (activeSession) {
      const question = addQuestionToSession(activeSession.id, handoff);
      storeSnapshot(activeSession.id, question?.id);
      refreshSessions();
      navigate("/qa-generator", {
        state: {
          from:       "search",
          query:      currentQueryLabel,
          rulingIds,
          sessionId:  activeSession.id,
          questionId: question?.id ?? null,
          dossierReview: attached,
        },
      });
      return;
    }
    openSavePicker(handoff, ({ session, question }) => {
      storeSnapshot(session?.id, question?.id);
      navigate("/qa-generator", {
        state: {
          from:       "search",
          query:      currentQueryLabel,
          rulingIds,
          sessionId:  session?.id ?? null,
          questionId: question?.id ?? null,
          dossierReview: attached,
        },
      });
    });
  };

  // Sr 47 — "Use in Q&A": carry the question, any ticked rulings and the
  // attached dossier into the Q&A generator. Same resolve-then-navigate shape
  // as handleGenerateFromSelection (Sr 45) so the picker is never orphaned.
  const handleUseDossierInQA = () => {
    const rulingIds = Array.from(selected);
    const attached = dossierReview?.uploadId ? dossierReview : null;
    // This is the question currently shown in the search box/results.
    const selectedQuestion = (submittedQuery || searchQuery || "").trim();
    if (!selectedQuestion) {
      toast.warning("Enter or select a search question first.");
      return;
    }
    const snapshot = buildSnapshot();
    saveTabSnapshot(snapshot)
    const handoff = {
      query: selectedQuestion,
      rulingIds,
      dossierReview: attached,
    };
    const storeSnapshot = (sessionId, questionId) => {
      if (!sessionId || !questionId) return;
      const stored = saveQuestionSearchSnapshot(sessionId, questionId, packSnapshot(snapshot));
      if (!stored) {
        toast.warning("Your search view couldn't be saved, so Change will run a fresh search.");
      }
    };
    const routeState = (session, question) => ({
      state: {
        from: "search",
        query: selectedQuestion,
        rulingIds,
        sessionId: session?.id ?? null,
        questionId: question?.id ?? null,
        dossierReview: attached,
      },
    });
    if (activeSession) {
      const question = addQuestionToSession(activeSession.id, handoff);
      storeSnapshot(activeSession.id, question?.id);
      refreshSessions();
      navigate("/qa-generator", routeState(activeSession, question));
      return;
    }
    openSavePicker(handoff, ({ session, question }) => {
      storeSnapshot(session?.id, question?.id);
      navigate("/qa-generator", routeState(session, question));
    });
  };

  // Sr 45 (second instance) — "Generate questions from this search" had the
  // same defect as the selection button: it opened the picker and navigated
  // immediately, so the modal was torn down mid-decision. Navigation is now the
  // picker's continuation.
  //
  //Removing the button  "Generate submission questions from this search"
  //
  //const handleGenerateFromAnswer = () => {
  //   const handoff = {
  //     query: currentQueryLabel,
  //     rulingIds: aiMatchedIds,
  //     rulings:   rulingSummariesFor(aiMatchedIds),
  //     dossierReview: dossierReview?.uploadId ? dossierReview : null,
  //   };
  //   const routeState = (session, question) => ({
  //     state: {
  //       from:       "search",
  //       query:      currentQueryLabel,
  //       rulingIds:  aiMatchedIds,
  //       sessionId:  session?.id ?? null,
  //       questionId: question?.id ?? null,
  //       dossierReview: dossierReview?.uploadId ? dossierReview : null,
  //     },
  //   });
  //   if (activeSession) {
  //     const question = addQuestionToSession(activeSession.id, handoff);
  //     refreshSessions();
  //     navigate("/qa-generator", routeState(activeSession, question));
  //     return;
  //   }
  //   openSavePicker(handoff, ({ session, question }) => {
  //     navigate("/qa-generator", routeState(session, question));
  //   });
  // };

  const handleExportSelection = () => {
    const chosen = filteredRulings.filter((r) => selected.has(r?.id));
    if (chosen.length === 0) return;
    // Sr 98 — "% match" read as a text-match score, which is the one thing it
    // is not: it is a share of the top hit's semantic score. The screen and the
    // CSV both say relevance now, and the band travels beside the number.
    // Why the relevance columns: the export is used as UAT and RTM evidence,
    // and without them it records which rulings were returned but not how
    // closely any of them matched — which is the part under review.
    // Blank for a literal text match, which carries no score.
    const header = [
      "Title", "Drug", "Manufacturer", "Outcome", "Therapy area", "Dossier",
      "Decision date", "Relevance %", "Relevance band", "Matched page",
    ];
    const esc    = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv    = [
      header.map(esc).join(","),
      ...chosen.map((r) => {
        const rel = aiRelevance[r?.id];
        return [
          r?.title, r?.drug_name, r?.manufacturer, r?.decision_outcome,
          r?.therapy_area, r?.dossier_category, r?.decision_date,
          rel?.relative != null ? Math.round(rel.relative) : "",
          relevanceBand(rel?.relative)?.label ?? "",
          rel?.page_number ?? "",
        ].map(esc).join(",");
      }),
    ].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const a   = document.createElement("a");
    a.href = url;
    a.download = `ruling-search-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(`Exported ${chosen.length} ruling${chosen.length !== 1 ? "s" : ""}`);
  };

  const runExampleQuery = (example) => {
    setSearchQuery(example);
    setSubmittedQuery(example);
    setAiMatchedIds([]); setAiRelevance({});
    setResultType("none");
    setSelectedYears([]);
    resetPage();
  };

  // ── handleSearch — now reads off_topic + no_results flags ────────────────
  const handleSearch = async (overrideQuery, overrideFilters) => {
    // A saved search passes its query directly: React state has not flushed
    // by the time this runs, so reading searchQuery would use the old value.
    // Only a string counts as an override — anything else (such as a click
    // event, if this is ever wired straight to onClick again) is ignored, so
    // the typed question is what gets sent.
    const isSavedRun   = typeof overrideQuery === "string";
    const trimmedQuery = String(isSavedRun ? overrideQuery : searchQuery).trim();
    if (!trimmedQuery) return;
    setIsSearching(true);
    setBackendAnswer("");
    setBackendSources([]);
    setAiMatchedIds([]); setAiRelevance({});
    setAiNoSynthesis(false);
    setSubmittedQuery("");
    setResultType("none");
    // Filters are cleared only for a fresh query typed by the user. A saved
    // search supplies its own, and wiping them here would defeat the point.
    if (!isSavedRun) {
      setSelectedYears([]);
      setSelectedTherapyAreas([]);
      setSelectedOutcomes([]);
      setSelectedDossierCategories([]);
      setOnlyPico(false);
      clearDossierReview();
    }
    setSelected(new Set());
    setOpenedRulings(new Set());
    setNudgeDismissed(false);
    resetPage();
    try {
      // Sr 52 — send the active filters so the synthesis covers the same set
      // the result list shows, and the dossier the user attached (Sr 21).
      //
      // "Active" means the filters the list will use once this search lands:
      // none for a fresh query (they were cleared just above) and the saved
      // ones for a saved search. Reading the filter state here would send the
      // previous render's values — the default year — and drop every matched
      // ruling from any other year.
      const f = isSavedRun ? (overrideFilters || {}) : {};
      const sendYears = (f.years || []).filter((y) => /^\d{4}$/.test(y)).sort();
      const response = await axios.post(`${API}/search-input`, {
        query: trimmedQuery,
        filters: {
          therapy_areas:      f.therapyAreas      || [],
          outcomes:           f.outcomes          || [],
          dossier_categories: f.dossierCategories || [],
          year_from:          sendYears.length ? sendYears[0] : "",
          year_to:            sendYears.length ? sendYears[sendYears.length - 1] : "",
        },
        dossier_review_upload_id: dossierReview?.uploadId || null,
      });
      const data = response.data ?? {};
      const answer     = data.result             ?? "";
      const sources    = data.sources            ?? [];
      const matchedIds = data.matched_ruling_ids ?? [];
      const offTopic   = data.off_topic          === true;
      const noResults  = data.no_results         === true;
      // Older backends return no matched_rulings; the cards simply show no
      // relevance chip in that case rather than breaking.
      const relevanceById = Object.fromEntries(
        (data.matched_rulings ?? []).map((m) => [m.ruling_id, m])
      );
      setAiConfidence(data.confidence ?? null);
      setAiSourceCount(data.source_count ?? sources.length);
      setAiNoSynthesis(data.no_synthesis === true);
      setBackendAnswer(answer);
      if (offTopic) {
        // Off-topic: show amber banner, no sources, no ruling filter
        setBackendSources([]);
        setAiMatchedIds([]); setAiRelevance({});
        setResultType("off_topic");
        setSubmittedQuery("");
        // Restore default year filter so the ruling list stays useful
        setSelectedYears(availableYears[0] ? [availableYears[0]] : []);
      } else if (noResults) {
        // No results: show info banner, no sources, fall back to text filter
        setBackendSources([]);
        setAiMatchedIds([]); setAiRelevance({});
        setResultType("no_results");
        setSubmittedQuery(trimmedQuery);
      } else {
        // Normal answer
        setBackendSources(sources);
        setAiMatchedIds(matchedIds);
        setAiRelevance(relevanceById);
        setResultType("answer");
        // Sr 93 — the list defaults to newest first, which is the right order
        // for browsing the corpus but the wrong one for a question: it buries
        // the ruling that answers it under whatever was published most
        // recently. A search that produced a ranking shows that ranking.
        if (matchedIds.length > 0) setSortBy("relevant");
        if (matchedIds.length === 0) setSubmittedQuery(trimmedQuery);
      }
    } catch (err) {
      console.error("Backend call failed", err);
      setBackendAnswer("An error occurred while searching. Please try again.");
      setBackendSources([]);
      setAiMatchedIds([]); setAiRelevance({});
      setResultType("no_results");
      setSubmittedQuery(trimmedQuery);
    } finally {
      setIsSearching(false);
    }
  };

  const handleClearSearch = () => {
    clearDossierReview();
    setSearchQuery("");
    setSubmittedQuery("");
    setBackendAnswer("");
    setBackendSources([]);
    setAiMatchedIds([]); setAiRelevance({});
    setAiNoSynthesis(false);
    setIsSearching(false);
    setResultType("none");
    setSelectedTherapyAreas([]);
    setSelectedOutcomes([]);
    setSelectedDossierCategories([]);
    setSelectedManufacturer(""); setMfrQuery("");
    setOnlyPico(false);
    setSelectedYears([DEFAULT_YEAR]);
    setSelected(new Set());
    setSortBy("newest");   // Sr 93 — no query, no ranking to sort by
    setFilteredRulings(rulings);
    resetPage();
    navigate("/search", { replace: true });
    setSelectedDrugs([]);
    setDrugQuery("");
  };

  // Resets ONLY the sidebar filters. The search question, AI answer, ranked
  // results and attached dossier are left untouched.
  const resetFiltersOnly = () => {
    setSelectedTherapyAreas([]);
    setSelectedOutcomes([]);
    setSelectedDossierCategories([]);
    setSelectedManufacturer("");
    setMfrQuery("");
    setOnlyPico(false);
    setSelectedDrugs([]);
    setDrugQuery("");
    // With a search active, the year filter must be emptied, not defaulted:
    // matches span many years, and a default year would hide most of them.
    // With no search, fall back to the default browsing year.
    const searchActive = aiMatchedIds.length > 0 || Boolean(submittedQuery);
    setSelectedYears(searchActive ? [] : [DEFAULT_YEAR]);
    setSelected(new Set());
    resetPage();
  };

  const clearFilters = () => {
    setSearchQuery("");
    clearDossierReview();
    setSubmittedQuery("");
    setAiMatchedIds([]); setAiRelevance({});
    setBackendAnswer("");
    setBackendSources([]);
    setResultType("none");
    setSelectedTherapyAreas([]);
    setSelectedOutcomes([]);
    setSelectedDossierCategories([]);
    setOnlyPico(false);
    setSelectedYears([DEFAULT_YEAR]);
    setSelected(new Set());
    setSortBy("newest");   // Sr 93 — the ranking went with the query
    resetPage();
    navigate("/search", { replace: true });
    setSelectedDrugs([]);
    setDrugQuery("");
  };

  const hasActiveFilters =
    Boolean(submittedQuery)              ||
    aiMatchedIds.length > 0             ||
    selectedTherapyAreas.length > 0     ||
    selectedOutcomes.length > 0         ||
    selectedDossierCategories.length > 0 ||
    Boolean(selectedManufacturer)       ||
    onlyPico                ||
    selectedDrugs.length > 0 ||
    selectedYears.length > 0;

  if (loading) {
    return (
      <div data-testid="search-loading">
        <div className="v2-crumb">Research / Ruling search</div>
        <h1>Ruling search</h1>
        <div className="v2-card v2-pad" style={{ color: "var(--muted)" }}>Loading rulings…</div>
      </div>
    );
  }

  const showingFrom = (currentPage - 1) * PAGE_SIZE + 1;
  const showingTo   = Math.min(currentPage * PAGE_SIZE, filteredRulings.length);

  return (
    <div data-testid="search-page">
      {/* ── Sr 50 — state B: the ruling summary, rendered in place ──────────
          The result list is kept mounted but hidden rather than unmounted, so
          returning restores scroll position, selection and pagination without
          re-running the search. */}
      {paneRulingId != null && (
        <div data-testid="search-ruling-pane">
          <RulingPane
            rulingId={paneRulingId}
            onBack={closeRulingPane}
            onPrev={() => stepRuling(-1)}
            onNext={() => stepRuling(1)}
            onOpenRuling={openRulingInPage}
            position={{
              index: paneIndex,
              total: filteredRulings.length,
              query: submittedQuery || searchQuery,
            }}
          />
        </div>
      )}
      <div style={paneRulingId != null ? { display: "none" } : undefined}>
        <div className="v2-crumb">Research / Ruling search</div>
        <h1>Ruling search</h1>
        <p className="v2-sub">
          {corpusMeta.total > 0 ? `${corpusMeta.total} ZIN rulings` : "ZIN rulings"}
          {corpusMeta.from && corpusMeta.to ? `, ${corpusMeta.from} – ${corpusMeta.to}` : ""}
          . Ask a free-text question about the ruling evidence you need.
        </p>

        {/* ── Search panel ─────────────────────────────────────────────── */}
        <div className="v2-card v2-pad" style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
            <input
              className="v2-sel"
              style={{ flex: 1, minWidth: 260, padding: "10px 12px" }}
              placeholder="e.g. Why are conditional approvals granted in heart failure?"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              disabled={isSearching}
              data-testid="search-input"
            />
            <button className="v2-btn" type="button" onClick={() => handleSearch()} disabled={isSearching} data-testid="search-button">
              {isSearching ? "Searching…" : "Search"}
            </button>
            <button className="v2-btn v2-ghost" type="button" onClick={handleClearSearch} disabled={isSearching}>Clear</button>
            {/* <button
              className="v2-btn v2-ghost"
              type="button"
              onClick={handleSaveSearch}
              disabled={isSearching}
              data-testid="save-search-btn"
            >
              Save this search
            </button> */}
            <button
              className="v2-btn v2-mag"
              type="button"
              onClick={handleSaveToSession}
              disabled={isSearching}
              data-testid="start-session-from-search-btn"
            >
              Start a session from this search
            </button>
          </div>
          <div style={{ marginTop: 11, display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center" }} data-testid="example-queries">
            <span style={{ fontSize: 11.5, color: "var(--muted)", fontWeight: 700 }}>Try:</span>
            {EXAMPLE_QUERIES.map((ex) => (
              <button key={ex} type="button" className="v2-chip x" onClick={() => runExampleQuery(ex)} disabled={isSearching}>
                {ex}
              </button>
            ))}
          </div>

          {/* ── Saved searches ───────────────────────────────────────────
              Each one re-runs with its filters restored. The badge counts
              rulings decided since the search was saved — in-app monitoring,
              with no notification infrastructure claimed. */}
          {savedSearches.length > 0 && (
            <div style={{ marginTop: 11, paddingTop: 11, borderTop: "1px solid var(--line)" }} data-testid="saved-searches">
              <div style={{ fontSize: 11.5, color: "var(--muted)", fontWeight: 700, marginBottom: 7 }}>
                Saved searches
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {savedSearches.map((sv) => {
                  const newCount = countNewSince(sv, rulings);
                  const desc     = describeFilters(sv.filters);
                  return (
                    <div
                      key={sv.id}
                      style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", fontSize: 12.5 }}
                    >
                      <button
                        type="button"
                        className="v2-chip x"
                        onClick={() => handleRunSaved(sv)}
                        disabled={isSearching}
                        title="Re-run this search with its filters"
                        style={{ fontWeight: 600 }}
                      >
                        ⌕ {sv.query}
                      </button>
                      {newCount > 0 && (
                        <span
                          className="v2-tag v2-t-cond"
                          title={`${newCount} ruling${newCount !== 1 ? "s" : ""} decided since you saved this search`}
                        >
                          {newCount} new
                        </span>
                      )}
                      {desc && <span style={{ color: "var(--muted)" }}>{desc}</span>}
                      <button
                        type="button"
                        onClick={() => handleDeleteSaved(sv.id)}
                        aria-label={`Remove saved search: ${sv.query}`}
                        style={{ marginLeft: "auto", background: "none", border: 0, padding: 0, font: "inherit", fontSize: 12, color: "var(--muted)", cursor: "pointer" }}
                      >
                        Remove
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* ── Sr 47 — Dossier Review context ───────────────────────────── */}
        <DossierReviewCard
          question={searchQuery || submittedQuery}
          onUseInQA={handleUseDossierInQA}
        />

        {fetchError && (
          <div className="v2-banner" style={{ marginBottom: 14 }}>
            <span aria-hidden="true">⚠</span>
            <div>{fetchError}. Check the browser console for details.</div>
          </div>
        )}

        <div className="v2-row">
          {/* ── Filters ─────────────────────────────────────────────── */}
          <div className="v2-card v2-pad" style={{ flex: "0 0 232px" }} data-testid="filter-sidebar">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 11 }}>
              <b>Filters</b>
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={resetFiltersOnly}
                  style={{ background: "none", border: 0, padding: 0, font: "inherit", fontSize: 12, color: "var(--accent)", textDecoration: "underline", cursor: "pointer" }}
                >
                  Clear all
                </button>
              )}
            </div>

            <h3>Therapy area</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5, marginBottom: 14 }}>
              {(therapyAreas || []).map((area) => (
                <label key={area} style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer" }}>
                  <input type="checkbox" checked={selectedTherapyAreas.includes(area)} onChange={() => toggleTherapyArea(area)} />
                  <span style={{ flex: 1 }}>{area}</span>
                  <span style={{ color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>
                    ({facetCounts.therapy_area[area] ?? 0})
                  </span>
                </label>
              ))}
            </div>

            {/* A ruling states a research question or it does not, so this is
                one switch rather than a facet group — nobody narrows to
                "rulings without a PICO". Roughly a third of the corpus
                qualifies, and nearly half of all product assessments. */}
            <h3>Research question</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5, marginBottom: 14 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer" }}
                title="Only rulings where the assessment sets out an explicit PICO">
                <input
                  type="checkbox"
                  data-testid="pico-filter"
                  checked={onlyPico}
                  onChange={() => { setOnlyPico((v) => !v); resetPage(); }}
                />
                <span style={{ flex: 1 }}>Has a stated PICO</span>
                <span style={{ color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>
                  ({facetCounts.pico})
                </span>
              </label>
            </div>

            {/* Drug */}
            <h3>Drug</h3>
            <div style={{ marginBottom: 14 }}>
              <input
                type="text"
                className="v2-sel"
                placeholder="Type to find a drug…"
                value={drugQuery}
                onChange={(e) => setDrugQuery(e.target.value)}
                aria-label="Filter the drug list"
                data-testid="drug-search"
                style={{ width: "100%", fontSize: 12.5, marginBottom: 7 }}
              />
              <div
                style={{ maxHeight: 190, overflowY: "auto", display: "flex", flexDirection: "column", gap: 5, fontSize: 12.5 }}
                data-testid="drug-filter"
              >
                {drugVisible.length > 0 && (
                  <label
                    style={{
                      display: "flex", alignItems: "center", gap: 7, cursor: "pointer",
                      fontWeight: 700, paddingBottom: 5, borderBottom: "1px solid var(--line)",
                      position: "sticky", top: 0, background: "#fff",
                    }}
                  >
                    <IndeterminateCheckbox
                      checked={allScopedDrugsSelected}
                      indeterminate={someScopedDrugsSelected}
                      onChange={(e) => toggleAllDrugs(e.target.checked)}
                      data-testid="drug-select-all"
                    />
                    <span style={{ flex: 1 }}>
                      {drugQuery.trim() ? `Select all matching "${drugQuery.trim()}"` : "Select all"}
                    </span>
                    <span style={{ color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>
                      ({scopedDrugKeys.length})
                    </span>
                  </label>
                )}
                {drugVisible.length === 0 ? (
                  <span style={{ color: "var(--muted)", fontSize: 12 }}>
                    {drugQuery.trim() ? "No drug matches that." : "No ruling in view names a drug."}
                  </span>
                ) : (
                  drugVisible.map((o) => (
                    <label key={o.key} style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={selectedDrugs.includes(o.key)}
                        onChange={() => toggleDrug(o.key)}
                      />
                      <span style={{ flex: 1 }} title={o.variants.length > 1 ? o.variants.join(" · ") : undefined}>
                        {o.label}
                      </span>
                      <span style={{ color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>({o.count})</span>
                    </label>
                  ))
                )}
              </div>
            </div>

            {(dossierCategories || []).length > 0 && (
              <>
                <h3>Dossier type</h3>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5, marginBottom: 14 }}>
                  {dossierCategories.filter((c) => !c.is_review_mode).map((cat) => (
                    <label key={cat.value} style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer" }}>
                      <input type="checkbox" checked={selectedDossierCategories.includes(cat.value)} onChange={() => toggleDossierCategory(cat.value)} />
                      <span style={{ flex: 1 }}>{cat.label}</span>
                      <span style={{ color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>
                        ({facetCounts.dossier_category[cat.value] ?? 0})
                      </span>
                    </label>
                  ))}
                  {/* Sr 48 — a review mode, not a stored value. Never sent as a
                      dossier_category filter: Neo4j holds no such value, so it
                      would silently empty the result set. */}
                  <label
                    style={{ display: "flex", alignItems: "center", gap: 7, opacity: dossierReview.uploadId ? 1 : 0.6 }}
                    title={dossierReview.uploadId
                      ? "Applies the review context from your uploaded dossier"
                      : "Available when a dossier-review file is attached to this search"}
                  >
                    <input type="checkbox" checked={Boolean(dossierReview.uploadId)} disabled={!dossierReview.uploadId} readOnly data-testid="cross-dossier-filter" />
                    <span style={{ flex: 1 }}>{CROSS_DOSSIER}</span>
                    <span style={{ color: "var(--muted)" }}>
                      ({dossierReview.uploadId ? "question context" : "upload required"})
                    </span>
                  </label>
                  <div style={{ color: "var(--muted)", fontSize: 11, lineHeight: 1.4 }} data-testid="dossier-multi-note">
                    A ruling can cover more than one dossier type, so these counts add up to more than the total.
                  </div>
                </div>
              </>
            )}

            {/* Sr 46 — grouped in the order people actually narrow:
                outcome → therapy area → dossier type → period. */}
            <h3 style={{ marginTop: 4 }}>Decision outcome</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5, marginBottom: 14 }}>
              {(decisionOutcomes || []).map((outcome) => (
                <label key={outcome} style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer" }}>
                  <input type="checkbox" checked={selectedOutcomes.includes(outcome)} onChange={() => toggleOutcome(outcome)} />
                  <span style={{ flex: 1 }}>{outcome}</span>
                  <span style={{ color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>
                    ({facetCounts.decision_outcome[outcome] ?? 0})
                  </span>
                </label>
              ))}
            </div>

            {/* ── Manufacturer ──────────────────────────────────────────────
                145 companies is far too many for a checkbox list, so this is a
                type-ahead over a scrolling list. Single-select by design: the
                facet exists to check one company's count against the Insights
                chart, and a union of several would not answer that.
                Spellings are folded, which is the whole point — filtering on
                the raw strings would return 7 for AstraZeneca against a chart
                reading 18, and look like a defect in the chart. The variant
                list under the selection shows exactly what was merged, so the
                fold itself can be judged rather than taken on trust. */}
            {/* Removing Manufacturers Filter */}
            <h3>Manufacturer</h3>
            <div style={{ marginBottom: 14 }}>
              <input
                type="text"
                className="v2-sel"
                placeholder="Type to find a company…"
                value={mfrQuery}
                onChange={(e) => setMfrQuery(e.target.value)}
                aria-label="Filter the manufacturer list"
                data-testid="mfr-search"
                style={{ width: "100%", fontSize: 12.5, marginBottom: 7 }}
              />
              {selectedMfr && (
                <div style={{ fontSize: 11.5, background: "#F7F4FD", borderRadius: 6, padding: "7px 9px", marginBottom: 7 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <b style={{ flex: 1 }}>{selectedMfr.label}</b>
                    <button
                      type="button"
                      onClick={() => { setSelectedManufacturer(""); resetPage(); }}
                      style={{ background: "none", border: 0, padding: 0, font: "inherit", color: "var(--accent)", textDecoration: "underline", cursor: "pointer" }}
                    >
                      clear
                    </button>
                  </div>
                  <div style={{ color: "var(--muted)", marginTop: 4, lineHeight: 1.5 }}>
                    {selectedMfr.variants.length === 1
                      ? "One spelling in the corpus."
                      : <>{selectedMfr.variants.length} spellings counted as one: {selectedMfr.variants.join(" · ")}</>}
                  </div>
                </div>
              )}
              <div style={{ maxHeight: 190, overflowY: "auto", display: "flex", flexDirection: "column", gap: 5, fontSize: 12.5 }}>
                {mfrVisible.length === 0 ? (
                  <span style={{ color: "var(--muted)", fontSize: 12 }}>
                    {mfrQuery.trim() ? "No company matches that." : "No ruling in view names a manufacturer."}
                  </span>
                ) : (
                  mfrVisible.map((o) => (
                    <label key={o.key} style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer" }}>
                      <input
                        type="radio"
                        name="mfr-facet"
                        checked={selectedManufacturer === o.key}
                        onChange={() => { setSelectedManufacturer(o.key); resetPage(); }}
                      />
                      <span style={{ flex: 1 }}>{o.label}</span>
                      <span style={{ color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>({o.count})</span>
                    </label>
                  ))
                )}
              </div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 7, lineHeight: 1.5 }}>
                Only {mfrCounts.size} of the companies in view name a manufacturer at all;
                rulings with no manufacturer recorded are excluded by this filter.
              </div>
            </div>

            {availableYears.length > 0 && (
              <>
                <h3>Decision period</h3>
                <YearDropdownFilter
                  availableYears={availableYears}
                  selectedYears={selectedYears}
                  onToggle={toggleYear}
                  onClearAll={() => setSelectedYears([])}
                  hasUnknownDateRulings={hasUnknownDateRulings}
                />
              </>
            )}
          </div>

          {/* ── Results ─────────────────────────────────────────────── */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {isSearching ? (
              <div className="v2-card v2-pad" data-testid="results-searching">
                {/* The announcement is static; the cycling line is hidden from
                    assistive tech, which would otherwise talk over itself
                    every time the message changes. */}
                <span className="sr-only" role="status" aria-live="polite">
                  Searching the ruling corpus
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }} aria-hidden="true">
                  <Spinner className="w-4 h-4" />
                  <span style={{ color: "var(--muted)" }}>{thinkingMessage}</span>
                </div>
              </div>
            ) : (
              <>
                {/* Sr 51 — how many matched AND where you are in the list */}
                <div
                  className="v2-card v2-pad"
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}
                >
                  <div style={{ fontSize: 13 }}>
                    <b>{filteredRulings.length} ruling{filteredRulings.length !== 1 ? "s" : ""}</b> match
                    {filteredRulings.length > 0 && (
                      <> · showing {showingFrom}–{showingTo}{" "}
                        <span style={{ color: "var(--muted)" }}>of {filteredRulings.length}</span>
                      </>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap" }}>
                    {/* Sr 49 — every active facet as a removable chip, so the
                        question "why am I seeing this?" is always answerable. */}
                    {selectedOutcomes.map((o) => (
                      <button key={`o-${o}`} type="button" className="v2-chip x" onClick={() => toggleOutcome(o)}>
                        {o} <b>×</b>
                      </button>
                    ))}
                    {selectedTherapyAreas.map((a) => (
                      <button key={`a-${a}`} type="button" className="v2-chip x" onClick={() => toggleTherapyArea(a)}>
                        {a} <b>×</b>
                      </button>
                    ))}
                    {selectedDossierCategories.map((d) => (
                      <button key={`d-${d}`} type="button" className="v2-chip x" onClick={() => toggleDossierCategory(d)}>
                        {categoryLabel(d)} <b>×</b>
                      </button>
                    ))}
                    {selectedDrugs.length > 5 ? (
                      <button
                        type="button"
                        className="v2-chip x"
                        onClick={() => setSelectedDrugs([])}
                        title="Clear the drug filter"
                      >
                        Drug: {selectedDrugs.length} selected <b>×</b>
                      </button>
                    ) : (
                      selectedDrugs.map((key) => (
                        <button key={`drug-${key}`} type="button" className="v2-chip x" onClick={() => toggleDrug(key)}>
                          Drug: {key === NO_DRUG_KEY
                          ? NO_DRUG_LABEL
                          : drugOptions.find((o) => o.key === key)?.label || key} <b>×</b>
                        </button>
                      ))
                    )}
                    {onlyPico && (
                      <button type="button" className="v2-chip x" onClick={() => setOnlyPico(false)}>
                        Has a stated PICO <b>×</b>
                      </button>
                    )}
                    {selectedYears.map((y) => (
                      <button key={`y-${y}`} type="button" className="v2-chip x" onClick={() => toggleYear(y)}>
                        {y === "Unknown" ? "Unknown date" : y} <b>×</b>
                      </button>
                    ))}

                    <select className="v2-sel" value={sortBy} onChange={(e) => setSortBy(e.target.value)} data-testid="sort-select">
                      <option value="relevant">Sort: most relevant</option>
                      <option value="newest">Sort: newest first</option>
                      <option value="oldest">Sort: oldest first</option>
                    </select>
                  </div>
                </div>
                {/* ── Pagination (top) — directly under the count / sort bar ── */}
                {filteredRulings.length > 0 && (
                  <PaginationControls
                    position="top"
                    currentPage={currentPage}
                    totalPages={totalPages}
                    onPageChange={handlePageChange}
                  />
                )}
                {filteredRulings.length === 0 ? (
                  <div className="v2-card v2-pad" data-testid="no-results">
                    <b>No rulings found</b>
                    <div style={{ fontSize: 12.5, color: "var(--muted)", margin: "4px 0 11px" }}>
                      Try adjusting your search or removing a filter.
                    </div>
                    <button className="v2-btn v2-ghost v2-sm" type="button" onClick={clearFilters}>Clear all filters</button>
                  </div>
                ) : (
                  <div className="v2-card">
                    {/* Multi-select turns search into the start of a workflow */}
                    <div
                      className="v2-pad"
                      style={{ borderBottom: "1px solid var(--line)", display: "flex", gap: 9, alignItems: "center", fontSize: 12.5, background: "#FBFAFD", flexWrap: "wrap" }}
                      data-testid="bulk-actions-bar"
                    >
                      <label style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={paginatedRulings.length > 0 && paginatedRulings.every((r) => selected.has(r.id))}
                          onChange={(e) => selectAllOnPage(e.target.checked)}
                        />
                        Select all on this page
                      </label>
                      {selected.size > 0 && <span style={{ color: "var(--muted)" }}>{selected.size} selected</span>}
                    </div>

                    {paginatedRulings.map((ruling, index) => {
                      const id      = ruling?.id ?? `ruling-${index}`;
                      const title   = ruling?.title ?? "Untitled ruling";
                      const summary = ruling?.summary ?? "No summary available.";
                      // Present only for rulings the semantic search returned;
                      // a literal text match carries no score.
                      const rel     = aiRelevance[ruling?.id];
                      return (
                        <div className="v2-item" key={id} data-testid={`search-result-${id}`}>
                          <div style={{ display: "flex", gap: 11 }}>
                            <input
                              type="checkbox"
                              style={{ marginTop: 4 }}
                              checked={selected.has(id)}
                              onChange={() => toggleSelect(id)}
                              aria-label={`Select ${title}`}
                            />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: "flex", gap: 9, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
                                {outcomeTagV2(ruling?.decision_outcome)}
                                {ruling?.therapy_area && <span className="v2-chip">{ruling.therapy_area}</span>}
                                {/* One chip per dossier type the ruling covers, primary type first. */}
                                {dossierTypesForCard(ruling).map((c) => (
                                  <span key={c} className="v2-chip" data-testid="dossier-chip">{categoryLabel(c)}</span>
                                ))}
                                {ruling?.drug_name && (<span className="v2-chip" title="Drug" style={{ fontWeight: 600 }}>
                                  {ruling.drug_name}</span>)}
                                {ruling?.decision_date && <span className="v2-chip">{ruling.decision_date}</span>}
                                {ruling?.manufacturer && <span className="v2-chip">{ruling.manufacturer}</span>}
                                {rel?.relative != null && (
                                  <span
                                    style={{ marginLeft: "auto", display: "inline-flex", gap: 7, alignItems: "center" }}
                                    data-testid={`relevance-band-${id}`}
                                  >
                                    {relevanceTagV2(rel)}
                                    <span
                                      className="v2-chip"
                                      data-testid={`relevance-${id}`}
                                      title={`Ranked ${rel.rank} for this search. The percentage is this ruling's score as a share of the closest match's — a comparison between these results, not an absolute measure.`}
                                      style={{ fontWeight: 600, color: "var(--indigo)" }}
                                    >
                                      {Math.round(rel.relative)}% relevance
                                    </span>
                                  </span>
                                )}
                              </div>
                              <h4>
                                {/* A real link, so right-click / ctrl-click
                                    offer "Open in new tab" and "Open in new
                                    window"; a plain click still opens the
                                    in-page pane. */}
                                <RulingLink
                                  id={ruling?.id}
                                  onOpen={openRulingInPage}
                                  style={{ font: "inherit", color: "var(--ink)", textAlign: "left", cursor: "pointer" }}
                                >
                                  {title}
                                </RulingLink>
                              </h4>
                              <p className="v2-clamp2">
                                <Highlight text={summary} query={submittedQuery} />
                              </p>
                              {/* Why this ruling is relevant, shown as the passage
                                  that actually matched rather than a generated
                                  gloss: it is verbatim from the ruling, so a
                                  reviewer can check it, and it costs nothing. */}
                              {rel?.snippet && (
                                <div
                                  data-testid={`why-relevant-${id}`}
                                  style={{
                                    marginTop: 7, padding: "8px 10px", borderRadius: 7,
                                    background: "var(--indigo-soft, #F5F3FB)",
                                    borderLeft: "3px solid var(--indigo)",
                                    fontSize: 12, lineHeight: 1.55, color: "var(--ink-2)",
                                  }}
                                >
                                  <span style={{ fontWeight: 700, fontSize: 10.5, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)" }}>
                                    Relevance
                                    {rel.page_number ? ` · page ${rel.page_number}` : ""}
                                  </span>
                                  {/* No line clamp here. The backend already
                                      trims this to a sentence end, so clamping
                                      would cut mid-sentence a second time and
                                      the excerpt would read as corrupt rather
                                      than abridged. */}
                                  <div style={{ marginTop: 3 }}>
                                    <Highlight text={rel.snippet} query={submittedQuery} />
                                  </div>
                                </div>
                              )}
                              <div className="v2-acts">
                                <RulingLink className="v2-btn v2-ghost v2-sm" id={ruling?.id} onOpen={openRulingInPage}>Open summary</RulingLink>
                                <button
                                  className="v2-btn v2-ghost v2-sm"
                                  type="button"
                                  onClick={() => openSavePicker({ query: title, rulingIds: ruling?.id != null ? [ruling.id] : [] })}
                                >
                                  Save to session
                                </button>
                                <button className="v2-btn v2-ghost v2-sm" type="button" onClick={() => handleCopyCitation(ruling)}>Copy citation</button>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}

                    {/* One dismissible prompt after real research activity. It
                        never returns once dismissed for this search. */}
                    {!activeSession && !nudgeDismissed && openedRulings.size >= 4 && (
                      <div className="v2-item" style={{ background: "#FBFAFD" }} data-testid="session-nudge">
                        <div style={{ display: "flex", gap: 11, alignItems: "center", flexWrap: "wrap" }}>
                          <span aria-hidden="true" style={{ fontSize: 16 }}>⌕</span>
                          <div style={{ flex: 1, minWidth: 200, fontSize: 12.5 }}>
                            <b>You have opened {openedRulings.size} rulings in this search.</b>
                            <div style={{ color: "var(--muted)" }}>
                              Keep them together as a session so the questions you generate and the
                              answers you draft are saved and linked.
                            </div>
                          </div>
                          <div style={{ display: "flex", gap: 7 }}>
                            <button
                              className="v2-btn v2-mag v2-sm"
                              type="button"
                              onClick={() => openSavePicker({ query: currentQueryLabel, rulingIds: Array.from(openedRulings) })}
                            >
                              Keep as a session
                            </button>
                            <button className="v2-btn v2-ghost v2-sm" type="button" onClick={() => setNudgeDismissed(true)}>Not now</button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {filteredRulings.length > 0 && (
                  <PaginationControls
                    position="bottom"
                    currentPage={currentPage}
                    totalPages={totalPages}
                    onPageChange={handlePageChange}
                  />
                )}

                {/* ── Grounded synthesis, after the results not instead of them ── */}
                {resultType !== "none" && (
                  <div className="v2-card v2-pad" style={{ marginTop: 14, background: "#FBFAFD" }} data-testid="summarised-analysis">
                    <ResultBox
                      answer={backendAnswer}
                      sources={backendSources}
                      rulings={rulings}
                      isOffTopic={resultType === "off_topic"}
                      isNoResults={resultType === "no_results"}
                      isNoSynthesis={aiNoSynthesis}
                      confidence={aiConfidence}
                      sourceCount={aiSourceCount}
                      matchedCount={aiMatchedIds.length}
                      data-testid="backend-result"
                    />
                    {resultType === "answer" && !aiNoSynthesis && (
                      <div style={{ marginTop: 11, display: "flex", gap: 7, flexWrap: "wrap" }} data-testid="answer-actions">
                        {/* <button className="v2-btn v2-sm" type="button" onClick={handleGenerateFromAnswer}>
                          Generate submission questions from this search
                        </button> */}
                        {/* <button
                          className="v2-btn v2-ghost v2-sm"
                          type="button"
                          onClick={() => openSavePicker({ query: currentQueryLabel, rulingIds: aiMatchedIds })}
                        >
                          Keep this search as a session
                        </button> */}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}