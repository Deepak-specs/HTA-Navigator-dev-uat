// src/pages/Search.jsx
import { useState, useEffect, useMemo, useRef } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import axios from "axios";
import ReactMarkdown from "react-markdown";
import { Card, CardContent } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Checkbox } from "../components/ui/checkbox";
import { ScrollArea } from "../components/ui/scroll-area";
import { Label } from "../components/ui/label";
import { Skeleton } from "../components/ui/skeleton";
import {
  Search as SearchIcon,
  Filter,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  Calendar,
  Building2,
  X,
  FileText,
  ChevronsLeft,
  ChevronsRight,
  Check,
  AlertTriangle,   // ← NEW: used for off-topic banner
  Info,            // ← NEW: used for no-results banner
} from "lucide-react";

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;
const PAGE_SIZE    = 15;
const DEFAULT_YEAR = "2026";

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

const getOutcomeBadgeClass = (outcome) => {
  if (outcome === "Positive")               return "badge-positive";
  if (outcome === "Negative")               return "badge-negative";
  if (outcome?.includes?.("Conditions"))    return "badge-conditional";
  return "bg-slate-100 text-slate-700 border-slate-200";
};

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
function ResultBox({ answer, sources, rulings, isOffTopic, isNoResults, "data-testid": testId }) {
  const isEmpty = !answer || answer.trim() === "";
  if (isEmpty) return null;

  const formatFileName = (filename) => {
    if (!filename) return null;
    return filename.replace(/\.[^/.]+$/, "").replace(/[_-]/g, " ").trim();
  };

  const findRulingForSource = (src) => {
    if (!rulings || rulings.length === 0) return null;
    const srcFile = (src.file || "").toLowerCase().replace(/\.[^/.]+$/, "").replace(/[_\-\s]+/g, " ").trim();
    for (const ruling of rulings) {
      if (srcFile && ruling.drug_name) {
        const drugNorm = ruling.drug_name.toLowerCase().replace(/[_\-\s]+/g, " ").trim();
        if (srcFile.includes(drugNorm)) return ruling.id;
      }
      if (srcFile && ruling.title) {
        const titleNorm = ruling.title.toLowerCase().replace(/[_\-\s]+/g, " ").trim();
        if (srcFile.includes(titleNorm) || titleNorm.includes(srcFile)) return ruling.id;
      }
    }
    return null;
  };

  // ── Off-topic: amber warning banner, zero sources ─────────────────────────
  if (isOffTopic) {
    return (
      <div
        data-testid={testId}
        className="w-full rounded-xl border border-amber-200 bg-amber-50 px-5 py-4"
        role="status"
        aria-live="polite"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-1">
              Out of scope
            </p>
            <p className="text-sm text-amber-800 leading-relaxed">{answer}</p>
          </div>
        </div>
      </div>
    );
  }

  // ── No results: neutral info banner, zero sources ─────────────────────────
  if (isNoResults) {
    return (
      <div
        data-testid={testId}
        className="w-full rounded-xl border border-slate-200 bg-slate-50 px-5 py-4"
        role="status"
        aria-live="polite"
      >
        <div className="flex items-start gap-3">
          <Info className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
              No results found
            </p>
            <p className="text-sm text-slate-700 leading-relaxed">{answer}</p>
          </div>
        </div>
      </div>
    );
  }

  // ── Normal result: answer + optional sources ──────────────────────────────
  return (
    <div
      data-testid={testId}
      className="w-full px-4 py-3 rounded-md bg-slate-50 text-sm leading-relaxed text-slate-800 transition-all duration-300 ease-in-out"
      style={{ border: "2px solid #0f172a" }}
    >
      <div className="prose prose-sm max-w-none prose-slate">
        <ReactMarkdown>{answer}</ReactMarkdown>
      </div>

      {/* Sources — only rendered when NOT off-topic, NOT no-results,
          AND the backend actually returned sources */}
      {Array.isArray(sources) && sources.length > 0 && (
        <div className="mt-3 pt-3 border-t border-slate-200">
          <span className="text-xs font-semibold" style={{ color: "#6D2B50" }}>
            Cited &mdash; Sources
          </span>
          <ol className="mt-2 space-y-1 list-none p-0 m-0">
            {sources.map((src, idx) => {
              const matchedRulingId = findRulingForSource(src);
              return (
                <li key={idx} className="flex items-start gap-2">
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded shrink-0 mt-0.5 bg-sky-600 text-white text-[10px] font-bold">
                    {idx + 1}
                  </span>
                  {matchedRulingId ? (
                    <Link
                      to={`/ruling/${matchedRulingId}`}
                      className="text-xs hover:underline transition-colors duration-150 break-all leading-5"
                      style={{ color: "#6D2B50" }}
                      title="View ruling detail"
                    >
                      {formatFileName(src.file) ?? src.url}
                      {src.page_number != null && (
                        <span className="text-slate-400 ml-1">p.{src.page_number}</span>
                      )}
                    </Link>
                  ) : (
                    <a
                      href={src.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs hover:underline transition-colors duration-150 break-all leading-5"
                      style={{ color: "#6D2B50" }}
                      title={`Page ${src.page_number ?? "?"}`}
                    >
                      {formatFileName(src.file) ?? src.url}
                    </a>
                  )}
                  {!matchedRulingId && src.page_number != null && (
                    <span className="text-xs text-slate-400 shrink-0 mt-0.5">
                      p.{src.page_number}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}

// ─── PaginationControls ───────────────────────────────────────────────────────
function PaginationControls({ currentPage, totalPages, onPageChange }) {
  if (totalPages <= 1) return null;

  const getPageNumbers = () => {
    const pages = new Set();
    pages.add(1);
    pages.add(totalPages);
    for (let i = Math.max(1, currentPage - 2); i <= Math.min(totalPages, currentPage + 2); i++)
      pages.add(i);
    const sorted = [...pages].sort((a, b) => a - b);
    const result = [];
    for (let i = 0; i < sorted.length; i++) {
      if (i > 0 && sorted[i] - sorted[i - 1] > 1) result.push("...");
      result.push(sorted[i]);
    }
    return result;
  };

  return (
    <div className="flex items-center justify-between mt-8 pt-6 border-t border-slate-200" data-testid="pagination-controls">
      <p className="text-sm text-slate-500">
        Page <span className="font-semibold text-slate-700">{currentPage}</span> of{" "}
        <span className="font-semibold text-slate-700">{totalPages}</span>
      </p>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" onClick={() => onPageChange(1)} disabled={currentPage === 1} className="h-8 w-8 p-0" title="First page"><ChevronsLeft className="w-4 h-4" /></Button>
        <Button variant="outline" size="sm" onClick={() => onPageChange(currentPage - 1)} disabled={currentPage === 1} className="h-8 w-8 p-0" title="Previous page"><ChevronLeft className="w-4 h-4" /></Button>
        {getPageNumbers().map((page, idx) =>
          page === "..."
            ? <span key={`ellipsis-${idx}`} className="h-8 w-8 flex items-center justify-center text-sm text-slate-400">…</span>
            : <Button key={page} variant={currentPage === page ? "default" : "outline"} size="sm" onClick={() => onPageChange(page)} className={`h-8 w-8 p-0 text-sm ${currentPage === page ? "bg-sky-600 hover:bg-sky-700 text-white border-sky-600" : ""}`}>{page}</Button>
        )}
        <Button variant="outline" size="sm" onClick={() => onPageChange(currentPage + 1)} disabled={currentPage === totalPages} className="h-8 w-8 p-0" title="Next page"><ChevronRight className="w-4 h-4" /></Button>
        <Button variant="outline" size="sm" onClick={() => onPageChange(totalPages)} disabled={currentPage === totalPages} className="h-8 w-8 p-0" title="Last page"><ChevronsRight className="w-4 h-4" /></Button>
      </div>
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <span>Go to</span>
        <Input
          type="number" min={1} max={totalPages} defaultValue={currentPage} key={currentPage}
          onKeyDown={(e) => { if (e.key === "Enter") { const val = parseInt(e.target.value, 10); if (!isNaN(val) && val >= 1 && val <= totalPages) onPageChange(val); }}}
          className="h-8 w-16 text-center text-sm"
        />
      </div>
    </div>
  );
}

// ─── YearDropdownFilter ───────────────────────────────────────────────────────
function YearDropdownFilter({ availableYears, selectedYears, onToggle, onClearAll, hasUnknownDateRulings }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function handleOutside(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, []);

  const allOptions = useMemo(() => {
    const opts = [...availableYears];
    if (hasUnknownDateRulings) opts.push("Unknown");
    return opts;
  }, [availableYears, hasUnknownDateRulings]);

  const displayLabel = useMemo(() => {
    if (selectedYears.length === 0) return "All Years";
    if (selectedYears.length === 1) return selectedYears[0] === "Unknown" ? "Unknown date" : selectedYears[0];
    return `${selectedYears.length} years selected`;
  }, [selectedYears]);

  return (
    <div className="relative w-full" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        data-testid="qa-year-dropdown-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        className="w-full flex items-center justify-between h-9 px-3 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:border-slate-300 hover:bg-slate-50 transition-colors shadow-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:ring-offset-1"
      >
        <div className="flex items-center gap-2 min-w-0">
          <Calendar className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          <span className="truncate">{displayLabel}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {selectedYears.length > 0 && (
            <span
              onClick={(e) => { e.stopPropagation(); onClearAll(); }}
              className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-slate-200 hover:bg-red-100 hover:text-red-600 text-slate-500 text-[10px] transition-colors cursor-pointer"
              title="Clear year filters"
            >
              <X className="w-2.5 h-2.5" />
            </span>
          )}
          <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
        </div>
      </button>

      {open && (
        <div
          role="listbox"
          aria-multiselectable="true"
          data-testid="qa-year-dropdown-menu"
          className="absolute left-0 top-full mt-1.5 z-40 w-full min-w-[160px] bg-white border border-slate-200 rounded-xl shadow-xl py-1 max-h-60 overflow-y-auto"
        >
          <button
            type="button" role="option" aria-selected={selectedYears.length === 0}
            onClick={() => { onClearAll(); setOpen(false); }}
            data-testid="qa-year-option-all"
            className={`w-full flex items-center justify-between px-3 py-2 text-sm transition-colors ${selectedYears.length === 0 ? "bg-sky-50 text-sky-700 font-semibold" : "text-slate-600 hover:bg-slate-50"}`}
          >
            <span>All Years</span>
            {selectedYears.length === 0 && <Check className="w-3.5 h-3.5 text-sky-600 shrink-0" />}
          </button>
          {allOptions.length > 0 && <div className="border-t border-slate-100 my-1" />}
          {allOptions.map((year) => {
            const isSelected = selectedYears.includes(year);
            return (
              <button
                key={year} type="button" role="option" aria-selected={isSelected}
                onClick={() => onToggle(year)}
                data-testid={`qa-year-option-${year}`}
                className={`w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors ${isSelected ? "bg-sky-50 text-sky-700 font-semibold" : year === "Unknown" ? "text-slate-400 italic hover:bg-slate-50" : "text-slate-700 hover:bg-slate-50"}`}
              >
                <span className={`inline-flex items-center justify-center w-4 h-4 rounded border shrink-0 transition-colors ${isSelected ? "bg-sky-600 border-sky-600" : "border-slate-300 bg-white"}`}>
                  {isSelected && <Check className="w-2.5 h-2.5 text-white" />}
                </span>
                <span>{year === "Unknown" ? "Unknown date" : year}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function Search() {
  const location = useLocation();
  const navigate = useNavigate();

  const [rulings,                  setRulings]                  = useState([]);
  const [filteredRulings,          setFilteredRulings]          = useState([]);
  const [loading,                  setLoading]                  = useState(true);
  const [fetchError,               setFetchError]               = useState(null);
  const [isSearching,              setIsSearching]              = useState(false);
  const [searchQuery,              setSearchQuery]              = useState("");
  const [backendAnswer,            setBackendAnswer]            = useState("");
  const [backendSources,           setBackendSources]           = useState([]);
  const [therapyAreas,             setTherapyAreas]             = useState([]);
  const [decisionOutcomes,         setDecisionOutcomes]         = useState([]);
  const [dossierCategories,        setDossierCategories]        = useState([]);
  const [selectedTherapyAreas,     setSelectedTherapyAreas]     = useState([]);
  const [selectedOutcomes,         setSelectedOutcomes]         = useState([]);
  const [selectedDossierCategories,setSelectedDossierCategories]= useState([]);
  const [selectedYears,            setSelectedYears]            = useState([DEFAULT_YEAR]);
  const [currentPage,              setCurrentPage]              = useState(1);
  const [aiMatchedIds,             setAiMatchedIds]             = useState([]);
  const [submittedQuery,           setSubmittedQuery]           = useState("");

  // ← NEW: tracks the type of the last backend response
  // "none" | "off_topic" | "no_results" | "answer"
  const [resultType, setResultType] = useState("none");

  const requiredRulingFields = useMemo(() => [
    "id", "title", "summary", "decision_outcome", "therapy_area",
    "dossier_category", "manufacturer", "decision_date", "drug_name", "tags",
  ], []);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const outcomeParam    = params.get("outcome");
    const therapyAreaParam = params.get("therapyArea");
    if (outcomeParam)     setSelectedOutcomes([outcomeParam]);
    if (therapyAreaParam) setSelectedTherapyAreas([therapyAreaParam]);
    if (outcomeParam || therapyAreaParam) setSelectedYears([]);
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
    setSelectedYears((prev) => {
      if (aiMatchedIds.length > 0) return prev;
      if (isSearching) return prev;
      if (prev.length === 0 && submittedQuery) return prev;
      const stillValid = prev.filter((y) => availableYears.includes(y));
      if (stillValid.length > 0) return stillValid;
      return availableYears[0] ? [availableYears[0]] : [];
    });
  }, [availableYears, location.search, aiMatchedIds, isSearching, submittedQuery]);

  const hasUnknownDateRulings = useMemo(() =>
    rulings.some((r) => {
      const date = r?.decision_date || "";
      return !date || date.length < 4 || !/^\d{4}$/.test(date.substring(0, 4));
    }),
    [rulings]
  );

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
        setDossierCategories(dc.data   || []);
      } catch (e) {
        console.error(e);
        setFetchError("Failed to load data");
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [requiredRulingFields]);

  // Filter logic
  useEffect(() => {
    if (isSearching) return;
    let results = Array.isArray(rulings) ? rulings : [];
    if (aiMatchedIds.length > 0) {
      results = results.filter((r) => aiMatchedIds.includes(r?.id));
    } else {
      const query = (submittedQuery || "").toLowerCase().trim();
      if (query) {
        results = results.filter((r) => {
          const title   = r?.title?.toLowerCase?.()       || "";
          const drug    = r?.drug_name?.toLowerCase?.()   || "";
          const manuf   = r?.manufacturer?.toLowerCase?.() || "";
          const summary = r?.summary?.toLowerCase?.()     || "";
          return title.includes(query) || drug.includes(query) || manuf.includes(query) || summary.includes(query);
        });
      }
      if (selectedTherapyAreas.length > 0)
        results = results.filter((r) => selectedTherapyAreas.includes(r?.therapy_area));
      if (selectedOutcomes.length > 0)
        results = results.filter((r) => selectedOutcomes.includes(r?.decision_outcome));
      if (selectedDossierCategories.length > 0)
        results = results.filter((r) => selectedDossierCategories.includes(r?.dossier_category));
      if (selectedYears.length > 0) {
        results = results.filter((r) => {
          const date        = r?.decision_date || "";
          const year        = date.length >= 4 ? date.substring(0, 4) : "";
          const isValidYear = /^\d{4}$/.test(year);
          if (selectedYears.includes("Unknown") && !isValidYear) return true;
          return isValidYear && selectedYears.includes(year);
        });
      }
    }
    const sorted = results.slice().sort((a, b) => {
      const dateA = a?.decision_date ? new Date(a.decision_date) : new Date(0);
      const dateB = b?.decision_date ? new Date(b.decision_date) : new Date(0);
      return dateB - dateA;
    });
    setFilteredRulings(sorted);
    resetPage();
  }, [submittedQuery, aiMatchedIds, selectedTherapyAreas, selectedOutcomes, selectedDossierCategories, selectedYears, rulings, isSearching]);

  const toggleTherapyArea    = (area)    => setSelectedTherapyAreas((prev)    => prev.includes(area)    ? prev.filter((a) => a !== area)    : [...prev, area]);
  const toggleOutcome        = (outcome) => setSelectedOutcomes((prev)        => prev.includes(outcome) ? prev.filter((o) => o !== outcome) : [...prev, outcome]);
  const toggleDossierCategory= (dossier) => setSelectedDossierCategories((prev)=> prev.includes(dossier)? prev.filter((o) => o !== dossier) : [...prev, dossier]);
  const toggleYear           = (year)    => setSelectedYears((prev)           => prev.includes(year)    ? prev.filter((y) => y !== year)    : [...prev, year]);

  // ── handleSearch — now reads off_topic + no_results flags ────────────────
  const handleSearch = async () => {
    const trimmedQuery = searchQuery.trim();
    if (!trimmedQuery) return;

    setIsSearching(true);
    setBackendAnswer("");
    setBackendSources([]);
    setAiMatchedIds([]);
    setSubmittedQuery("");
    setResultType("none");
    setSelectedYears([]);
    setSelectedTherapyAreas([]);
    setSelectedOutcomes([]);
    setSelectedDossierCategories([]);
    resetPage();

    try {
      const response = await axios.post(`${API}/search-input`, { query: trimmedQuery });
      const data = response.data ?? {};

      const answer     = data.result             ?? "";
      const sources    = data.sources            ?? [];
      const matchedIds = data.matched_ruling_ids ?? [];
      const offTopic   = data.off_topic          === true;
      const noResults  = data.no_results         === true;

      setBackendAnswer(answer);

      if (offTopic) {
        // Off-topic: show amber banner, no sources, no ruling filter
        setBackendSources([]);
        setAiMatchedIds([]);
        setResultType("off_topic");
        setSubmittedQuery("");
        // Restore default year filter so the ruling list stays useful
        setSelectedYears(availableYears[0] ? [availableYears[0]] : []);

      } else if (noResults) {
        // No results: show info banner, no sources, fall back to text filter
        setBackendSources([]);
        setAiMatchedIds([]);
        setResultType("no_results");
        setSubmittedQuery(trimmedQuery);

      } else {
        // Normal answer
        setBackendSources(sources);
        setAiMatchedIds(matchedIds);
        setResultType("answer");
        if (matchedIds.length === 0) setSubmittedQuery(trimmedQuery);
      }

    } catch (err) {
      console.error("Backend call failed", err);
      setBackendAnswer("An error occurred while searching. Please try again.");
      setBackendSources([]);
      setAiMatchedIds([]);
      setResultType("no_results");
      setSubmittedQuery(trimmedQuery);
    } finally {
      setIsSearching(false);
    }
  };

  const handleClearSearch = () => {
    setSearchQuery("");
    setSubmittedQuery("");
    setBackendAnswer("");
    setBackendSources([]);
    setAiMatchedIds([]);
    setIsSearching(false);
    setResultType("none");
    setSelectedTherapyAreas([]);
    setSelectedOutcomes([]);
    setSelectedDossierCategories([]);
    setSelectedYears([DEFAULT_YEAR]);
    setFilteredRulings(rulings);
    resetPage();
    navigate("/search", { replace: true });
  };

  const clearFilters = () => {
    setSearchQuery("");
    setSubmittedQuery("");
    setAiMatchedIds([]);
    setBackendAnswer("");
    setBackendSources([]);
    setResultType("none");
    setSelectedTherapyAreas([]);
    setSelectedOutcomes([]);
    setSelectedDossierCategories([]);
    setSelectedYears([DEFAULT_YEAR]);
    resetPage();
    navigate("/search", { replace: true });
  };

  const hasActiveFilters =
    Boolean(submittedQuery)              ||
    aiMatchedIds.length > 0             ||
    selectedTherapyAreas.length > 0     ||
    selectedOutcomes.length > 0         ||
    selectedDossierCategories.length > 0 ||
    selectedYears.length > 0;

  if (loading) {
    return (
      <div className="flex" data-testid="search-loading">
        <div className="filter-sidebar">
          <Skeleton className="h-8 w-32 mb-6" />
          <Skeleton className="h-10 w-full mb-8" />
          <Skeleton className="h-6 w-24 mb-4" />
          {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-6 w-full mb-3" />)}
        </div>
        <div className="flex-1 p-8">
          <Skeleton className="h-10 w-64 mb-8" />
          <div className="space-y-4">
            {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-40 w-full rounded-xl" />)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-screen overflow-y-scroll" data-testid="search-page">
      <div className="max-w-full px-6 py-6">
        <div className="max-w-7xl mx-auto px-8 py-6">
          <div className="w-full max-w-4xl">
            <h1 className="text-3xl font-bold font-heading mb-6 text-center" style={{ color: "#6D2B50" }}>
              Past Ruling Search
            </h1>

            {/* Search bar */}
            <div className="flex items-center gap-3 mb-4">
              <div className="relative flex-1">
                <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  type="text"
                  placeholder="Search rulings..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                  className="pl-10"
                  data-testid="search-input"
                  disabled={isSearching}
                />
              </div>
              <Button onClick={handleSearch} data-testid="search-button" className="whitespace-nowrap px-6" disabled={isSearching}>
                {isSearching
                  ? <><Spinner className="w-4 h-4 mr-2 text-white" />Searching…</>
                  : "Search"
                }
              </Button>
              <Button variant="outline" onClick={handleClearSearch} disabled={isSearching}>Clear</Button>
            </div>

            {/* Summarised Analysis header — only shown for real answers */}
            {(isSearching || resultType === "answer") && (
              <h2 className="text-base font-semibold mb-2" style={{ color: "#6D2B50" }}>
                Summarised Analysis
              </h2>
            )}

            {/* Loading state */}
            {isSearching ? (
              <div
                className="flex items-center gap-3 bg-slate-50 border border-slate-200 rounded-md px-4 py-3 text-sm text-slate-500"
                role="status"
                aria-live="polite"
              >
                <Spinner className="w-4 h-4 text-slate-400 shrink-0" />
                <span>Analysing your query, please wait…</span>
                <span className="flex gap-1 ml-auto">
                  {[0, 1, 2].map((i) => (
                    <span key={i} className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                  ))}
                </span>
              </div>
            ) : (
              /* Result box — passes resultType flags so it renders correctly */
              <ResultBox
                answer={backendAnswer}
                sources={backendSources}
                rulings={rulings}
                isOffTopic={resultType === "off_topic"}
                isNoResults={resultType === "no_results"}
                data-testid="backend-result"
              />
            )}
          </div>
        </div>

        <div className="border-b pb-6 mb-8">
          <div className="w-full border-b pb-6 mb-8 text-center">
            <h2 className="text-xl font-semibold text-center" style={{ color: "#6D2B50" }}>
              Browse and filter historical HTA rulings from Zorginstituut Nederland
            </h2>
          </div>
        </div>

        <div className="flex gap-8 min-w-0">

          {/* ── LEFT: Filters ── */}
          <aside className="w-72 shrink-0 filter-sidebar" data-testid="filter-sidebar">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Filter className="w-5 h-5" />Filters
              </h2>
              {hasActiveFilters && (
                <Button variant="ghost" size="sm" onClick={clearFilters} className="text-slate-500 hover:text-slate-700">
                  <X className="w-4 h-4 mr-1" />Clear
                </Button>
              )}
            </div>

            <ScrollArea className="flex-1 px-5 py-4">
              {availableYears.length > 0 && (
                <div className="filter-section mb-6">
                  <h3 className="filter-label flex items-center gap-2 mb-3">
                    <Calendar className="w-3.5 h-3.5 text-slate-400" />
                    Year
                    {selectedYears.length > 0 && (
                      <span className="inline-flex items-center justify-center h-4 min-w-[1rem] px-1 rounded-full bg-sky-600 text-white text-[10px] font-semibold">
                        {selectedYears.length}
                      </span>
                    )}
                  </h3>
                  <YearDropdownFilter
                    availableYears={availableYears}
                    selectedYears={selectedYears}
                    onToggle={toggleYear}
                    onClearAll={() => setSelectedYears([])}
                    hasUnknownDateRulings={hasUnknownDateRulings}
                  />
                </div>
              )}

              <div className="filter-section">
                <h3 className="filter-label">Therapy Area</h3>
                {(therapyAreas || []).map((area) => (
                  <div key={area} className="flex items-center gap-2 mb-2">
                    <Checkbox checked={selectedTherapyAreas.includes(area)} onCheckedChange={() => toggleTherapyArea(area)} />
                    <Label>{area}</Label>
                  </div>
                ))}
              </div>

              <div className="filter-section mt-6">
                <h3 className="filter-label">Decision Outcome</h3>
                {(decisionOutcomes || []).map((outcome) => (
                  <div key={outcome} className="flex items-center gap-2 mb-2">
                    <Checkbox checked={selectedOutcomes.includes(outcome)} onCheckedChange={() => toggleOutcome(outcome)} />
                    <Label>{outcome}</Label>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </aside>

          {/* ── RIGHT: Results ── */}
          <div className="flex-1 min-w-0">
            <div className="p-8">
              {fetchError && (
                <div className="mb-6 p-3 rounded-md bg-amber-50 text-amber-800 border border-amber-200">
                  {fetchError}. Check the browser console for details.
                </div>
              )}

              {isSearching ? (
                <div className="flex flex-col items-center justify-center py-16" data-testid="results-searching">
                  <Spinner className="w-8 h-8 text-sky-500 mb-4" />
                  <p className="text-sm text-slate-500 font-medium">Finding relevant rulings…</p>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-3">
                      <p className="text-slate-600">
                        <span className="font-semibold text-slate-900">{filteredRulings.length}</span>{" "}rulings found
                      </p>
                      {filteredRulings.length > 0 && (
                        <span className="text-xs text-slate-400 border-l border-slate-200 pl-3">
                          Showing{" "}
                          <span className="font-medium text-slate-600">
                            {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, filteredRulings.length)}
                          </span>
                        </span>
                      )}
                    </div>
                    {hasActiveFilters && (
                      <div className="flex items-center gap-2 flex-wrap">
                        {selectedTherapyAreas.map((area)    => <Badge key={area}    variant="secondary" className="text-xs">{area}    <X className="w-3 h-3 ml-1 cursor-pointer" onClick={() => toggleTherapyArea(area)} /></Badge>)}
                        {selectedOutcomes.map((outcome)     => <Badge key={outcome} variant="secondary" className="text-xs">{outcome} <X className="w-3 h-3 ml-1 cursor-pointer" onClick={() => toggleOutcome(outcome)} /></Badge>)}
                        {selectedDossierCategories.map((d)  => <Badge key={d}       variant="secondary" className="text-xs">{d}       <X className="w-3 h-3 ml-1 cursor-pointer" onClick={() => toggleDossierCategory(d)} /></Badge>)}
                        {selectedYears.map((year)           => <Badge key={year}    variant="secondary" className="text-xs">{year === "Unknown" ? "Unknown date" : year}<X className="w-3 h-3 ml-1 cursor-pointer" onClick={() => toggleYear(year)} /></Badge>)}
                      </div>
                    )}
                  </div>

                  {filteredRulings.length === 0 ? (
                    <div className="empty-state" data-testid="no-results">
                      <FileText className="empty-state-icon" />
                      <h3 className="empty-state-title">No rulings found</h3>
                      <p className="empty-state-description">
                        Try adjusting your search criteria or filters to find relevant rulings.
                      </p>
                      <Button onClick={clearFilters} className="mt-4" variant="outline">
                        Clear All Filters
                      </Button>
                    </div>
                  ) : (
                    <>
                      <div className="space-y-4">
                        {paginatedRulings.map((ruling, index) => {
                          const id           = ruling?.id               ?? `ruling-${index}`;
                          const outcome      = ruling?.decision_outcome  ?? "Unknown";
                          const area         = ruling?.therapy_area      ?? "Unknown area";
                          const dossier      = ruling?.dossier_category  ?? "Unknown dossier";
                          const title        = ruling?.title             ?? "Untitled ruling";
                          const drug         = ruling?.drug_name         ?? "Unknown drug";
                          const summary      = ruling?.summary           ?? "No summary available.";
                          const manufacturer = ruling?.manufacturer      ?? "Unknown manufacturer";
                          const decisionDate = ruling?.decision_date     ?? null;
                          const tags         = Array.isArray(ruling?.tags) ? ruling.tags : [];

                          return (
                            <Link
                              key={id}
                              to={ruling?.id != null ? `/ruling/${ruling.id}` : "#"}
                              className={`block animate-fade-in-up stagger-${Math.min(index + 1, 5)}`}
                              data-testid={`search-result-${id}`}
                            >
                              <Card className="ruling-card">
                                <CardContent className="p-5">
                                  <div className="flex items-start justify-between gap-4">
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center gap-3 mb-3">
                                        <Badge className={`text-xs ${getOutcomeBadgeClass(outcome)}`}>{outcome}</Badge>
                                        <Badge variant="outline" className="text-xs">{area}</Badge>
                                        <Badge variant="outline" className="text-xs">{dossier}</Badge>
                                      </div>
                                      <h3 className="text-lg font-semibold text-slate-900 mb-2 font-heading">{title}</h3>
                                      <p className="text-sm text-sky-600 font-medium mb-2">{drug}</p>
                                      <p className="text-sm text-slate-600 line-clamp-2 mb-3">{summary}</p>
                                      <div className="flex items-center gap-4">
                                        <span className="text-xs text-slate-500 flex items-center gap-1"><Building2 className="w-3 h-3" />{manufacturer}</span>
                                        <span className={`text-xs flex items-center gap-1 ${decisionDate ? "text-slate-500" : "text-slate-400 italic"}`}><Calendar className="w-3 h-3" />{decisionDate ?? "Unknown date"}</span>
                                      </div>
                                      {tags.length > 0 && (
                                        <div className="flex items-center gap-2 mt-3">
                                          {tags.slice(0, 4).map((tag) => (
                                            <Badge key={tag} variant="outline" className="text-xs text-slate-500 bg-slate-50">{tag}</Badge>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                    <ChevronRight className="w-5 h-5 text-slate-300 flex-shrink-0 mt-2" />
                                  </div>
                                </CardContent>
                              </Card>
                            </Link>
                          );
                        })}
                      </div>
                      <PaginationControls
                        currentPage={currentPage}
                        totalPages={totalPages}
                        onPageChange={handlePageChange}
                      />
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}