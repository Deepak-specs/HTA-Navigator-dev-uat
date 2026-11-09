// src/pages/Insights.jsx
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import axios from "axios";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";
import {
  BarChart3,
  TrendingUp,
  AlertCircle,
  FileText,
  Building2,
  Calendar,
  Activity,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Search,
  Sparkles,
  Loader2,
  ChevronUp,
} from "lucide-react";
import {
  BarChart as RBarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
  LineChart,
  Line,
} from "recharts";

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;

// ─── Axios dev-mode logger (runs once) ───────────────────────────────────────
if (process.env.NODE_ENV === "development" && !axios.__LOG_INTERCEPTORS__) {
  axios.__LOG_INTERCEPTORS__ = true;
  axios.interceptors.request.use((cfg) => {
    console.log("[REQ]", cfg.method?.toUpperCase(), cfg.url);
    return cfg;
  });
  axios.interceptors.response.use(
    (res) => { console.log("[RES]", res.status, res.config?.url); return res; },
    (err) => { console.error("[ERR]", err.message); return Promise.reject(err); }
  );
}

// ─── One-time warning helper ──────────────────────────────────────────────────
const seenWarnings = new Set();
function warnOnce(key, payload) {
  if (!seenWarnings.has(key)) { console.warn(key, payload); seenWarnings.add(key); }
}

// ─── Trend window builder ─────────────────────────────────────────────────────
function buildWindowOptions(trendData) {
  if (!Array.isArray(trendData) || trendData.length === 0) return [];
  const windows = [];
  for (let i = 0; i < trendData.length; i += 6) {
    const slice = trendData.slice(i, i + 6);
    const first = slice[0]?.month ?? "";
    const last  = slice[slice.length - 1]?.month ?? "";
    windows.push({
      label:    first === last ? first : `${first} – ${last}`,
      startIdx: i,
      endIdx:   Math.min(i + 6, trendData.length),
    });
  }
  return windows;
}

// ─── Trend chart title ────────────────────────────────────────────────────────
function deriveTrendLabel(trendData) {
  if (!Array.isArray(trendData) || trendData.length === 0)
    return "Monthly Decision Trends";
  const months = trendData.map((d) => d.month).filter(Boolean);
  if (months.length === 0) return "Monthly Decision Trends";
  const first = months[0];
  const last  = months[months.length - 1];
  const years = [...new Set(months.map((m) => m.split(" ")[1]).filter(Boolean))];
  if (years.length === 1) return `Monthly Decision Trends (${years[0]})`;
  return `Monthly Decision Trends (${first} – ${last})`;
}

// ─── Key insights deriver ─────────────────────────────────────────────────────
function deriveKeyInsights({ visibleTrendData, insights, rulings, avgReviewDays }) {
  const totalRulings  = insights?.total_rulings ?? 0;
  const positive      = insights?.positive_decisions ?? 0;
  const negative      = insights?.negative_decisions ?? 0;
  const conditional   = insights?.conditional_decisions ?? 0;

  const outcomeTotal  = positive + conditional + negative;
  const denominator   = outcomeTotal > 0 ? outcomeTotal : totalRulings;
  const approvalRate  = denominator ? Math.round((positive / denominator) * 100) : 0;

  const windowPositive    = visibleTrendData.reduce((s, d) => s + (d.positive    ?? 0), 0);
  const windowNegative    = visibleTrendData.reduce((s, d) => s + (d.negative    ?? 0), 0);
  const windowConditional = visibleTrendData.reduce((s, d) => s + (d.conditional ?? 0), 0);
  const windowTotal       = windowPositive + windowNegative + windowConditional;
  const windowPeriod      = visibleTrendData.length > 0
    ? `${visibleTrendData[0].month} – ${visibleTrendData[visibleTrendData.length - 1].month}`
    : "selected period";

  const therapyBreakdown = insights?.therapy_area_breakdown ?? {};
  const topTherapyAreas  = Object.entries(therapyBreakdown)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name]) => name);

  const dominantOutcome =
    windowPositive >= windowNegative && windowPositive >= windowConditional
      ? "positive"
      : windowNegative >= windowConditional
      ? "negative"
      : "conditional";

  const visibleMonthSet = new Set(visibleTrendData.map((d) => d.month));

  const windowRulings = Array.isArray(rulings)
    ? rulings.filter((r) => {
        const raw = r?.decision_date ?? "";
        if (!raw || raw.length < 7) return false;
        try {
          const dt    = new Date(raw.slice(0, 7) + "-01");
          const label = dt.toLocaleString("en-US", { month: "short", year: "numeric" });
          return visibleMonthSet.has(label);
        } catch { return false; }
      })
    : [];

  const positiveWindowRulings = windowRulings.filter(
    (r) => r?.decision_outcome === "Positive"
  );
  const positiveTherapyCounts = {};
  positiveWindowRulings.forEach((r) => {
    const area = r?.therapy_area ?? "Unknown";
    positiveTherapyCounts[area] = (positiveTherapyCounts[area] ?? 0) + 1;
  });
  const topPositiveAreas = Object.entries(positiveTherapyCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name]) => name);

  const negativeWindowRulings = windowRulings.filter(
    (r) =>
      r?.decision_outcome === "Negative" ||
      (r?.decision_outcome ?? "").includes("Conditions")
  );
  const negativeTherapyCounts = {};
  negativeWindowRulings.forEach((r) => {
    const area = r?.therapy_area ?? "Unknown";
    negativeTherapyCounts[area] = (negativeTherapyCounts[area] ?? 0) + 1;
  });
  const topNegativeAreas = Object.entries(negativeTherapyCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name]) => name);

  const dossierCounts = {};
  windowRulings.forEach((r) => {
    const cat = r?.dossier_category ?? "Unknown";
    dossierCounts[cat] = (dossierCounts[cat] ?? 0) + 1;
  });
  const topDossiers = Object.entries(dossierCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name]) => name);

  const mfrCounts = {};
  windowRulings.forEach((r) => {
    const mfr = r?.manufacturer;
    if (mfr) mfrCounts[mfr] = (mfrCounts[mfr] ?? 0) + 1;
  });
  const topMfrInWindow = Object.entries(mfrCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 1)
    .map(([name]) => name)[0] ?? null;

  const successItems = [
    approvalRate > 0
      ? `Overall approval rate: ${approvalRate}% across ${totalRulings} rulings`
      : null,
    windowPositive > 0
      ? `${windowPositive} positive decision${windowPositive !== 1 ? "s" : ""} in ${windowPeriod}`
      : null,
    topPositiveAreas.length > 0
      ? `Leading areas: ${topPositiveAreas.join(", ")}`
      : topTherapyAreas.length > 0
      ? `Top therapy areas: ${topTherapyAreas.join(", ")}`
      : null,
    topMfrInWindow ? `Most active manufacturer: ${topMfrInWindow}` : null,
    dominantOutcome === "positive" && windowTotal > 0
      ? `Positive outcomes dominate this period (${Math.round((windowPositive / windowTotal) * 100)}%)`
      : null,
  ].filter(Boolean).slice(0, 4);

  const objectionItems = [
    windowNegative > 0
      ? `${windowNegative} negative decision${windowNegative !== 1 ? "s" : ""} in ${windowPeriod}`
      : "No negative decisions in this period",
    windowConditional > 0
      ? `${windowConditional} conditional approval${windowConditional !== 1 ? "s" : ""} — conditions attached`
      : null,
    topNegativeAreas.length > 0 ? `Challenged areas: ${topNegativeAreas.join(", ")}` : null,
    negative    > 0 ? `${negative} total negative decisions across all rulings`              : null,
    conditional > 0 ? `${conditional} total conditional decisions — review conditions carefully` : null,
  ].filter(Boolean).slice(0, 4);

  const focusItems = [
    topTherapyAreas.length > 0
      ? `Highest volume: ${topTherapyAreas[0]} (${therapyBreakdown[topTherapyAreas[0]] ?? 0} rulings)`
      : null,
    topTherapyAreas.length > 1 ? `Also active: ${topTherapyAreas.slice(1).join(", ")}` : null,
    topDossiers.length > 0
      ? `Dominant dossier type: ${topDossiers[0]}`
      : "Pharmacotherapeutic dossiers most common",
    topDossiers.length > 1
      ? `Secondary dossier: ${topDossiers[1]}`
      : "Cost-effectiveness analysis quality critical",
    windowTotal > 0 ? `${windowTotal} total decisions in ${windowPeriod}` : null,
  ].filter(Boolean).slice(0, 4);

  const timelineItems = [
    avgReviewDays > 0 ? `Avg assessment: ${avgReviewDays} days` : "Avg assessment: N/A",
    visibleTrendData.length > 0
      ? `Current window: ${visibleTrendData.length} month${visibleTrendData.length !== 1 ? "s" : ""} (${windowPeriod})`
      : null,
    dominantOutcome === "positive"
      ? "Trend: positive decisions leading this period"
      : dominantOutcome === "negative"
      ? "Trend: negative decisions elevated — review submissions"
      : "Trend: conditional approvals prominent this period",
    windowTotal > 0 && windowPositive > 0
      ? `Window approval rate: ${Math.round((windowPositive / windowTotal) * 100)}%`
      : null,
  ].filter(Boolean).slice(0, 4);

  return { successItems, objectionItems, focusItems, timelineItems, windowPeriod };
}

// ─── PDF Export Utility ───────────────────────────────────────────────────────
async function exportPageToPDF(pageRef, setExporting) {
  if (!pageRef.current) {
    toast.error("Nothing to export");
    return;
  }
  setExporting(true);

  const freezeStyle = document.createElement("style");
  freezeStyle.id = "pdf-export-freeze";
  freezeStyle.textContent = `
    [data-testid="insights-page"] *,
    [data-testid="insights-page"] *::before,
    [data-testid="insights-page"] *::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
      opacity: 1 !important;
    }
  `;
  document.head.appendChild(freezeStyle);

  try {
    await new Promise((res) => setTimeout(res, 300));

    const element = pageRef.current;
    const canvas  = await html2canvas(element, {
      scale:           2,
      useCORS:         true,
      allowTaint:      false,
      backgroundColor: "#ffffff",
      scrollX:         0,
      scrollY:         -window.scrollY,
      windowWidth:     element.scrollWidth,
      windowHeight:    element.scrollHeight,
      logging:         false,
      onclone: (clonedDoc) => {
        const clonedPage = clonedDoc.querySelector('[data-testid="insights-page"]');
        if (clonedPage) {
          clonedPage.querySelectorAll("*").forEach((el) => {
            el.style.opacity       = "1";
            el.style.animationName = "none";
            el.style.transition    = "none";
          });
        }
      },
    });

    const pdf        = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const pageWidth  = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const marginX    = 10;
    const marginY    = 10;
    const usableW    = pageWidth  - marginX * 2;
    const usableH    = pageHeight - marginY * 2;

    const imgWidthPx      = canvas.width;
    const imgHeightPx     = canvas.height;
    const ratio           = usableW / imgWidthPx;
    let remainingHeightPx = imgHeightPx;
    let sourceYPx         = 0;
    let isFirstPage       = true;

    while (remainingHeightPx > 0) {
      if (!isFirstPage) pdf.addPage();

      const sliceHeightPx = Math.min(remainingHeightPx, usableH / ratio);
      const sliceCanvas   = document.createElement("canvas");
      sliceCanvas.width   = imgWidthPx;
      sliceCanvas.height  = Math.ceil(sliceHeightPx);
      const ctx = sliceCanvas.getContext("2d");
      ctx.drawImage(canvas, 0, -sourceYPx);

      pdf.addImage(
        sliceCanvas.toDataURL("image/png"),
        "PNG",
        marginX, marginY,
        usableW, sliceHeightPx * ratio
      );

      sourceYPx         += sliceHeightPx;
      remainingHeightPx -= sliceHeightPx;
      isFirstPage        = false;
    }

    const totalPages = pdf.internal.getNumberOfPages();
    const now        = new Date().toLocaleDateString("en-GB", {
      day: "2-digit", month: "short", year: "numeric",
    });
    for (let p = 1; p <= totalPages; p++) {
      pdf.setPage(p);
      pdf.setFontSize(8);
      pdf.setTextColor(150);
      pdf.text(
        `ZIN HTA Insights  •  Exported ${now}  •  Page ${p} of ${totalPages}`,
        pageWidth / 2,
        pageHeight - 5,
        { align: "center" }
      );
    }

    pdf.save(`ZIN_HTA_Insights_${now.replace(/ /g, "_")}.pdf`);
    toast.success("PDF exported");

  } catch (err) {
    console.error("PDF export failed:", err);
    toast.error("Failed to export PDF");
  } finally {
    document.getElementById("pdf-export-freeze")?.remove();
    setExporting(false);
  }
}

// ─── Preset analysis questions ────────────────────────────────────────────────
const PRESET_QUESTIONS = [
  {
    label: "Extrapolation methods in CEA",
    question:
      "How frequently are different extrapolation methods (e.g., Weibull, log-normal, splines, Gompertz) used in cost-effectiveness analyses across ZIN rulings, and has their usage changed over time?",
  },
  {
    label: "Modeling approach trends",
    question:
      "Have certain health economic modeling approaches (e.g., partitioned survival, Markov, semi-Markov, individual patient simulation) become more or less common in ZIN submissions over time?",
  },
  {
    label: "Utility & QALY evaluation",
    question:
      "What patterns exist in how ZIN evaluates utility values and QALY estimates? Are there recurring concerns about utility sources, mapping methods, or EQ-5D instrument choice?",
  },
  {
    label: "Indirect treatment comparisons",
    question:
      "How does ZIN assess indirect treatment comparisons (NMA, MAIC, STC)? What are the most common methodological objections raised in rulings that include an ITC?",
  },
  {
    label: "Subgroup analysis patterns",
    question:
      "What trends exist in ZIN's evaluation of subgroup analyses? Are subgroup claims frequently accepted, challenged, or restricted in reimbursement conditions?",
  },
  {
    label: "Recurring topics by therapy area",
    question:
      "Which recurring methodological topics or assessment concerns appear most frequently within specific therapeutic areas (e.g., Oncology, Rare Diseases, Neurology)?",
  },
];

// ─── Dossier colour palette ───────────────────────────────────────────────────
const DOSSIER_COLOURS = [
  "#7C3AED", // violet   — primary
  "#0284C7", // sky blue
  "#10B981", // emerald
  "#F59E0B", // amber
  "#EF4444", // red
  "#8B5CF6", // purple
  "#06B6D4", // cyan
  "#F97316", // orange
  "#EC4899", // pink
  "#14B8A6", // teal
];

function getDossierColour(index) {
  return DOSSIER_COLOURS[index % DOSSIER_COLOURS.length];
}

// ─── Custom Tooltip for Dossier Chart ────────────────────────────────────────
function DossierTooltip({ active, payload, label }) {
  if (!active || !payload || payload.length === 0) return null;
  const total = payload.reduce((sum, p) => sum + (p.value ?? 0), 0);
  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-lg p-3 text-xs min-w-[160px]">
      <p className="font-semibold text-slate-700 mb-2 border-b border-slate-100 pb-1">
        {label}
      </p>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center justify-between gap-3 py-0.5">
          <div className="flex items-center gap-1.5">
            <span
              className="w-2.5 h-2.5 rounded-sm shrink-0"
              style={{ backgroundColor: p.fill }}
            />
            <span className="text-slate-600 truncate max-w-[110px]">{p.name}</span>
          </div>
          <span className="font-semibold text-slate-800">{p.value}</span>
        </div>
      ))}
      {payload.length > 1 && (
        <div className="flex items-center justify-between gap-3 pt-1.5 mt-1 border-t border-slate-100">
          <span className="text-slate-500 font-medium">Total</span>
          <span className="font-bold text-slate-800">{total}</span>
        </div>
      )}
    </div>
  );
}

// ─── Dossier Legend ───────────────────────────────────────────────────────────
function DossierLegend({ dossierKeys }) {
  if (!dossierKeys || dossierKeys.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-3 px-1">
      {dossierKeys.map((key, idx) => (
        <div key={key} className="flex items-center gap-1.5">
          <span
            className="w-3 h-3 rounded-sm shrink-0"
            style={{ backgroundColor: getDossierColour(idx) }}
          />
          <span className="text-xs text-slate-600">{key}</span>
        </div>
      ))}
    </div>
  );
}

// ─── DeepDivePanel ────────────────────────────────────────────────────────────
function DeepDivePanel() {
  const [selectedPreset,  setSelectedPreset]  = useState(null);
  const [customQuestion,  setCustomQuestion]  = useState("");
  const [analysisResult,  setAnalysisResult]  = useState(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError,   setAnalysisError]   = useState(null);
  const [resultExpanded,  setResultExpanded]  = useState(true);

  const activeQuestion = customQuestion.trim()
    ? customQuestion.trim()
    : selectedPreset !== null
    ? PRESET_QUESTIONS[selectedPreset].question
    : "";

  // ── Derive dossier category keys from trend_data ──────────────────────────
  const dossierKeys = useMemo(() => {
    if (!Array.isArray(analysisResult?.trend_data)) return [];
    const keys = new Set();
    analysisResult.trend_data.forEach((entry) => {
      Object.keys(entry).forEach((k) => {
        if (k !== "label" && k !== "value") keys.add(k);
      });
    });
    return [...keys];
  }, [analysisResult]);

  const hasTrendChart =
    Array.isArray(analysisResult?.trend_data) &&
    analysisResult.trend_data.length > 0;

  // Falls back to legacy single-bar if no dossier keys present
  const isGrouped = dossierKeys.length > 0;

  const findings = Array.isArray(analysisResult?.findings)
    ? analysisResult.findings
    : [];

  const handlePresetClick = useCallback((idx) => {
    setSelectedPreset((prev) => (prev === idx ? null : idx));
    setCustomQuestion("");
    setAnalysisResult(null);
    setAnalysisError(null);
  }, []);

  const handleCustomChange = useCallback((e) => {
    setCustomQuestion(e.target.value);
    if (e.target.value.trim()) setSelectedPreset(null);
    setAnalysisResult(null);
    setAnalysisError(null);
  }, []);

  const handleAnalyse = useCallback(async () => {
    if (!activeQuestion) return;
    setAnalysisLoading(true);
    setAnalysisError(null);
    setAnalysisResult(null);

    try {
      const res = await axios.post(`${API}/insights-analyse`, {
        question: activeQuestion,
      });
      const data = res?.data;
      if (!data || typeof data !== "object") {
        throw new Error("Unexpected response format from analysis endpoint.");
      }
      setAnalysisResult(data);
      setResultExpanded(true);
    } catch (err) {
      console.error("Deep-dive analysis failed:", err);
      const msg =
        err?.response?.data?.detail ??
        err?.response?.data?.message ??
        err?.message ??
        "Analysis failed. Please try again.";
      setAnalysisError(msg);
      toast.error("Analysis could not be completed.");
    } finally {
      setAnalysisLoading(false);
    }
  }, [activeQuestion]);

  const handleKeyDown = useCallback(
    (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        handleAnalyse();
      }
    },
    [handleAnalyse]
  );

  return (
    <Card className="border-slate-200 mt-6" data-testid="deep-dive-panel">

      <CardHeader className="border-b border-slate-100 bg-slate-50/50">
        <CardTitle className="text-lg font-semibold text-slate-900 font-heading flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-violet-500" />
          Deep-Dive Analysis
          <Badge variant="outline" className="ml-2 text-xs text-violet-700 border-violet-200 bg-violet-50">
            AI-powered
          </Badge>
        </CardTitle>
        <p className="text-sm text-slate-500 mt-1">
          Investigate specific methodological topics across all ZIN rulings.
          Select a preset question or define your own, then click{" "}
          <span className="font-medium text-slate-700">Analyse</span>.
        </p>
      </CardHeader>

      <CardContent className="p-6 space-y-6">

        {/* ── Preset chips ── */}
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">
            Suggested questions
          </p>
          <div className="flex flex-wrap gap-2">
            {PRESET_QUESTIONS.map((pq, idx) => (
              <button
                key={idx}
                onClick={() => handlePresetClick(idx)}
                data-testid={`deep-dive-preset-${idx}`}
                className={[
                  "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium",
                  "border transition-colors duration-150",
                  selectedPreset === idx
                    ? "bg-violet-600 text-white border-violet-600 shadow-sm"
                    : "bg-white text-slate-600 border-slate-200 hover:border-violet-300 hover:text-violet-700 hover:bg-violet-50",
                ].join(" ")}
              >
                {pq.label}
              </button>
            ))}
          </div>
        </div>

        {/* ── Custom question textarea ── */}
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
            Or ask your own question
          </p>
          <div className="relative">
            <Search className="absolute left-3 top-3 w-4 h-4 text-slate-400 pointer-events-none" />
            <textarea
              value={customQuestion}
              onChange={handleCustomChange}
              onKeyDown={handleKeyDown}
              placeholder="e.g. How often does ZIN request additional sensitivity analyses in oncology submissions?"
              rows={3}
              data-testid="deep-dive-custom-input"
              className="w-full pl-9 pr-4 py-2.5 text-sm text-slate-800 border border-slate-200 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-violet-300 focus:border-violet-400 placeholder:text-slate-400 bg-white"
            />
            <p className="text-xs text-slate-400 mt-1 text-right">Ctrl+Enter to submit</p>
          </div>
        </div>

        {/* ── Analyse button ── */}
        <div className="flex items-center gap-3">
          <Button
            onClick={handleAnalyse}
            disabled={!activeQuestion || analysisLoading}
            data-testid="deep-dive-analyse-btn"
            className="bg-violet-600 hover:bg-violet-700 text-white px-5 py-2 rounded-lg text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {analysisLoading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Analysing…
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 mr-2" />
                Analyse
              </>
            )}
          </Button>

          {activeQuestion && !analysisLoading && (
            <p
              className="text-xs text-slate-400 italic truncate max-w-md"
              title={activeQuestion}
            >
              &ldquo;{activeQuestion.length > 80
                ? activeQuestion.slice(0, 80) + "…"
                : activeQuestion}&rdquo;
            </p>
          )}
        </div>

        {/* ── Error state ── */}
        {analysisError && (
          <div
            className="flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700"
            data-testid="deep-dive-error"
          >
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-red-500" />
            <span>{analysisError}</span>
          </div>
        )}

        {/* ── Results panel ── */}
        {analysisResult && !analysisError && (
          <div
            className="border border-violet-200 rounded-xl overflow-hidden"
            data-testid="deep-dive-result"
          >
            {/* Results header */}
            <div
              className="flex items-center justify-between px-5 py-3 bg-violet-50 border-b border-violet-200 cursor-pointer select-none"
              onClick={() => setResultExpanded((v) => !v)}
              data-testid="deep-dive-result-toggle"
            >
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-violet-600" />
                <span className="text-sm font-semibold text-violet-800">
                  Analysis Results
                </span>
                {analysisResult.rulings_analysed != null && (
                  <Badge
                    variant="outline"
                    className="text-xs text-violet-600 border-violet-300 bg-white"
                  >
                    {analysisResult.rulings_analysed} rulings analysed
                  </Badge>
                )}
              </div>
              {resultExpanded
                ? <ChevronUp   className="w-4 h-4 text-violet-500" />
                : <ChevronDown className="w-4 h-4 text-violet-500" />
              }
            </div>

            {resultExpanded && (
              <div className="p-5 space-y-5 bg-white">

                {/* Summary */}
                {analysisResult.summary && (
                  <p className="text-sm text-slate-700 leading-relaxed">
                    {analysisResult.summary}
                  </p>
                )}

                {/* Key Findings */}
                {findings.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
                      Key Findings
                    </p>
                    <ul className="space-y-2">
                      {findings.map((finding, i) => (
                        <li
                          key={i}
                          className="flex items-start gap-2 text-sm text-slate-700"
                        >
                          <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-violet-400 shrink-0" />
                          {finding}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* ── Trend Chart — categorised by dossier type ── */}
                {hasTrendChart && (
                  <div>
                    {/* Section header */}
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
                        Trend Over Time
                      </p>
                      {isGrouped && (
                        <Badge
                          variant="outline"
                          className="text-xs text-violet-700 border-violet-200 bg-violet-50"
                        >
                          By dossier type
                        </Badge>
                      )}
                    </div>

                    {/* Chart */}
                    <div className="h-64">
                      <ResponsiveContainer width="100%" height="100%">
                        <RBarChart
                          data={analysisResult.trend_data}
                          margin={{ top: 4, right: 16, left: 0, bottom: 4 }}
                          barCategoryGap="30%"
                        >
                          <CartesianGrid
                            strokeDasharray="3 3"
                            stroke="#E2E8F0"
                            vertical={false}
                          />
                          <XAxis
                            dataKey="label"
                            tick={{ fontSize: 11, fill: "#64748B" }}
                            axisLine={{ stroke: "#E2E8F0" }}
                            tickLine={false}
                            interval="preserveStartEnd"
                          />
                          <YAxis
                            allowDecimals={false}
                            tick={{ fontSize: 11, fill: "#64748B" }}
                            axisLine={false}
                            tickLine={false}
                            width={28}
                          />
                          <Tooltip
                            content={<DossierTooltip />}
                            cursor={{ fill: "#F1F5F9" }}
                          />

                          {isGrouped ? (
                            // ── Stacked bars, one per dossier category ──────
                            dossierKeys.map((key, idx) => (
                              <Bar
                                key={key}
                                dataKey={key}
                                stackId="dossier"
                                fill={getDossierColour(idx)}
                                radius={
                                  idx === dossierKeys.length - 1
                                    ? [4, 4, 0, 0]
                                    : [0, 0, 0, 0]
                                }
                                name={key}
                                maxBarSize={48}
                              />
                            ))
                          ) : (
                            // ── Legacy single bar (backward-compatible) ─────
                            <Bar
                              dataKey="value"
                              fill="#7C3AED"
                              radius={[4, 4, 0, 0]}
                              barSize={36}
                              name="Occurrences"
                            />
                          )}
                        </RBarChart>
                      </ResponsiveContainer>
                    </div>

                    {/* Custom legend — only shown for grouped mode */}
                    {isGrouped && <DossierLegend dossierKeys={dossierKeys} />}
                  </div>
                )}

                {/* Footer note */}
                <p className="text-xs text-slate-400 italic border-t border-slate-100 pt-3">
                  AI-derived pattern summary based on available ZIN ruling corpus.
                  Validate findings against source rulings before use in dossier preparation.
                </p>

              </div>
            )}
          </div>
        )}

      </CardContent>
    </Card>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function Insights() {
  const [insights,     setInsights]     = useState(null);
  const [rulings,      setRulings]      = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [windowIdx,    setWindowIdx]    = useState(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [exporting,    setExporting]    = useState(false);
  const [showAllMfr,   setShowAllMfr]   = useState(false);

  const dropdownRef = useRef(null);
  const pageRef     = useRef(null);

  const expectedInsightFields = useMemo(() => [
    "total_rulings", "positive_decisions", "conditional_decisions",
    "negative_decisions", "avg_review_time_days", "therapy_area_breakdown",
    "top_manufacturers", "all_manufacturers", "monthly_trends",
  ], []);

  useEffect(() => {
    function handleClickOutside(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target))
        setDropdownOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    const fetchAll = async () => {
      setLoading(true);
      try {
        const [insightsRes, rulingsRes] = await Promise.allSettled([
          axios.get(`${API}/insights`),
          axios.get(`${API}/rulings`),
        ]);

        if (insightsRes.status === "fulfilled") {
          const data = insightsRes.value?.data;
          if (!data || typeof data !== "object") {
            warnOnce("Expected insights object, got:", data);
            setInsights(null);
          } else {
            expectedInsightFields.forEach((f) => {
              if (data?.[f] == null) warnOnce(`insights missing field: ${f}`, data);
            });
            setInsights(data);
          }
        } else {
          console.error("Failed to fetch insights:", insightsRes.reason);
          setInsights(null);
        }

        if (rulingsRes.status === "fulfilled") {
          const data = rulingsRes.value?.data;
          setRulings(Array.isArray(data) ? data : []);
        } else {
          console.error("Failed to fetch rulings:", rulingsRes.reason);
          setRulings([]);
        }
      } catch (error) {
        console.error("Unexpected fetch error:", error);
      } finally {
        setLoading(false);
      }
    };
    fetchAll();
  }, [expectedInsightFields]);

  const trendData = useMemo(
    () => (Array.isArray(insights?.monthly_trends) ? insights.monthly_trends : []),
    [insights]
  );

  const windowOptions = useMemo(() => buildWindowOptions(trendData), [trendData]);

  useEffect(() => {
    if (windowOptions.length > 0 && windowIdx === null)
      setWindowIdx(windowOptions.length - 1);
  }, [windowOptions, windowIdx]);

  const visibleTrendData = useMemo(() => {
    if (windowIdx === null || windowOptions.length === 0) return trendData;
    const w = windowOptions[windowIdx];
    return trendData.slice(w.startIdx, w.endIdx);
  }, [trendData, windowOptions, windowIdx]);

  const therapyAreaData = useMemo(() =>
    insights?.therapy_area_breakdown &&
    typeof insights.therapy_area_breakdown === "object"
      ? Object.entries(insights.therapy_area_breakdown)
          .map(([name, value]) => ({ name, value }))
      : [],
    [insights]
  );

  const manufacturersToDisplay = useMemo(() =>
    showAllMfr
      ? (insights?.all_manufacturers ?? insights?.top_manufacturers ?? [])
      : (insights?.top_manufacturers ?? []),
    [showAllMfr, insights]
  );

  const hasMoreManufacturers =
    (insights?.all_manufacturers?.length ?? 0) >
    (insights?.top_manufacturers?.length  ?? 0);

  const avgReviewDays = insights?.avg_review_time_days ?? 0;

  const { successItems, objectionItems, focusItems, timelineItems, windowPeriod } =
    useMemo(() =>
      deriveKeyInsights({ visibleTrendData, insights, rulings, avgReviewDays }),
      [visibleTrendData, insights, rulings, avgReviewDays]
    );

  if (loading) {
    return (
      <div className="p-8" data-testid="insights-loading">
        <Skeleton className="h-10 w-64 mb-8" />
        <div className="grid grid-cols-4 gap-6 mb-8">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-32 rounded-xl" />)}
        </div>
        <div className="grid grid-cols-2 gap-6">
          <Skeleton className="h-80 rounded-xl" />
          <Skeleton className="h-80 rounded-xl" />
        </div>
      </div>
    );
  }

  const totalRulings    = insights?.total_rulings         ?? 0;
  const positive        = insights?.positive_decisions    ?? 0;
  const conditional     = insights?.conditional_decisions ?? 0;
  const negative        = insights?.negative_decisions    ?? 0;
  const outcomeTotal    = positive + conditional + negative;
  const denominator     = outcomeTotal > 0 ? outcomeTotal : totalRulings;
  const approvalRate    = denominator ? Math.round((positive    / denominator) * 100) : 0;
  const conditionalRate = denominator ? Math.round((conditional / denominator) * 100) : 0;
  const isFirstWindow   = windowIdx === 0;
  const isLastWindow    = windowIdx === windowOptions.length - 1;
  const trendChartTitle = deriveTrendLabel(visibleTrendData);

  const outcomeData = [
    { name: "Positive",    value: positive,    color: "#10B981" },
    { name: "Conditional", value: conditional, color: "#F59E0B" },
    { name: "Negative",    value: negative,    color: "#EF4444" },
  ];

  return (
    <>
      {/* ── Export button — outside pageRef so it never appears in PDF ── */}
      <div className="flex justify-end px-8 pt-6">
        {!exporting && (
          <Button
            variant="outline"
            size="sm"
            data-testid="insights-download-btn"
            onClick={() => exportPageToPDF(pageRef, setExporting)}
            title="Export insights as PDF"
          >
            <Download className="w-4 h-4 mr-2" />
            Export PDF
          </Button>
        )}
      </div>

      {/* ── Everything inside pageRef is captured by html2canvas ── */}
      <div data-testid="insights-page" ref={pageRef}>

        <header className="page-header">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-sky-100 rounded-xl flex items-center justify-center">
              <BarChart3 className="w-5 h-5 text-sky-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-900 font-heading">
                Insights &amp; Analytics
              </h1>
              <p className="text-slate-500">
                Trends and patterns from ZIN HTA assessments
              </p>
            </div>
          </div>
        </header>

        <div className="p-8">

          {/* ── KPI cards ── */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">

            <Card className="metric-card animate-fade-in-up stagger-1" data-testid="insight-total">
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="metric-value" style={{ color: "#6D2B50" }}>{totalRulings}</p>
                    <p className="metric-label">Total Rulings</p>
                  </div>
                  <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ backgroundColor: "#f3e8ee" }}>
                    <FileText className="w-6 h-6" style={{ color: "#6D2B50" }} />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="metric-card animate-fade-in-up stagger-2" data-testid="insight-positive-rate">
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="metric-value" style={{ color: "#6D2B50" }}>{approvalRate}%</p>
                    <p className="metric-label">Approval Rate</p>
                  </div>
                  <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ backgroundColor: "#f3e8ee" }}>
                    <TrendingUp className="w-6 h-6" style={{ color: "#6D2B50" }} />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="metric-card animate-fade-in-up stagger-3" data-testid="insight-conditional-rate">
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="metric-value" style={{ color: "#6D2B50" }}>{conditionalRate}%</p>
                    <p className="metric-label">Conditional Rate</p>
                  </div>
                  <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ backgroundColor: "#f3e8ee" }}>
                    <AlertCircle className="w-6 h-6" style={{ color: "#6D2B50" }} />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="metric-card animate-fade-in-up stagger-4" data-testid="insight-review-time">
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="metric-value" style={{ color: "#6D2B50" }}>{avgReviewDays}</p>
                    <p className="metric-label">Avg Review Days</p>
                  </div>
                  <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ backgroundColor: "#f3e8ee" }}>
                    <Calendar className="w-6 h-6" style={{ color: "#6D2B50" }} />
                  </div>
                </div>
              </CardContent>
            </Card>

          </div>

          {/* ── Charts row ── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">

            <Card className="chart-container" data-testid="outcome-chart">
              <CardHeader>
                <CardTitle className="text-lg font-semibold text-slate-900 font-heading">
                  Decision Outcomes Distribution
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={outcomeData}
                        cx="50%" cy="50%"
                        innerRadius={60} outerRadius={100}
                        paddingAngle={2} dataKey="value"
                        label={({ name, percent }) =>
                          `${name} ${(percent * 100).toFixed(0)}%`
                        }
                      >
                        {outcomeData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <Card className="chart-container" data-testid="therapy-area-chart">
              <CardHeader>
                <CardTitle className="text-lg font-semibold text-slate-900 font-heading">
                  Rulings by Therapy Area
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-72">
                  {therapyAreaData.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-sm text-slate-400">
                      No therapy area data available.
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <RBarChart
                        data={therapyAreaData}
                        layout="vertical"
                        margin={{ left: 20 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                        <XAxis type="number" />
                        <YAxis
                          type="category"
                          dataKey="name"
                          width={100}
                          tick={{ fontSize: 12 }}
                        />
                        <Tooltip />
                        <Bar
                          dataKey="value"
                          fill="#0284C7"
                          radius={[0, 4, 4, 0]}
                          barSize={24}
                        />
                      </RBarChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </CardContent>
            </Card>

          </div>

          {/* ── Monthly trends ── */}
          <Card className="chart-container mb-8" data-testid="trends-chart">
            <CardHeader>
              <div className="flex items-center justify-between flex-wrap gap-3">

                <div className="flex items-center gap-3">
                  <CardTitle className="text-lg font-semibold text-slate-900 font-heading">
                    {trendChartTitle}
                  </CardTitle>
                  {trendData.length > 0 && (
                    <Badge
                      variant="outline"
                      className="text-xs text-emerald-700 border-emerald-300 bg-emerald-50"
                    >
                      {trendData.length} month{trendData.length !== 1 ? "s" : ""}
                    </Badge>
                  )}
                </div>

                {windowOptions.length > 1 && (
                  <div className="flex items-center gap-1" ref={dropdownRef}>

                    <button
                      onClick={() => setWindowIdx((i) => Math.max(0, (i ?? 0) - 1))}
                      disabled={isFirstWindow}
                      title="Previous 6 months"
                      data-testid="trend-prev-btn"
                      className="h-8 w-8 flex items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:border-slate-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors shadow-sm"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>

                    <div className="relative">
                      <button
                        onClick={() => setDropdownOpen((o) => !o)}
                        data-testid="trend-window-dropdown-btn"
                        className="flex items-center gap-1.5 h-8 px-3 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:border-slate-300 hover:bg-slate-50 transition-colors shadow-sm min-w-[168px] justify-between"
                      >
                        <div className="flex items-center gap-1.5">
                          <Calendar className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                          <span className="truncate">
                            {windowIdx !== null
                              ? windowOptions[windowIdx]?.label
                              : "All periods"}
                          </span>
                        </div>
                        <ChevronDown
                          className={`w-3.5 h-3.5 text-slate-400 shrink-0 transition-transform duration-150 ${
                            dropdownOpen ? "rotate-180" : ""
                          }`}
                        />
                      </button>

                      {dropdownOpen && (
                        <div
                          className="absolute right-0 top-full mt-1.5 z-30 bg-white border border-slate-200 rounded-xl shadow-xl py-1 min-w-[180px] max-h-64 overflow-y-auto"
                          data-testid="trend-window-dropdown-menu"
                        >
                          <button
                            onClick={() => { setWindowIdx(null); setDropdownOpen(false); }}
                            className={`w-full text-left px-4 py-2 text-xs transition-colors border-b border-slate-100 ${
                              windowIdx === null
                                ? "bg-sky-50 text-sky-700 font-semibold"
                                : "text-slate-500 hover:bg-slate-50"
                            }`}
                          >
                            All periods
                          </button>
                          {windowOptions.map((opt, idx) => (
                            <button
                              key={idx}
                              onClick={() => { setWindowIdx(idx); setDropdownOpen(false); }}
                              data-testid={`trend-window-option-${idx}`}
                              className={`w-full text-left px-4 py-2 text-xs transition-colors ${
                                windowIdx === idx
                                  ? "bg-sky-50 text-sky-700 font-semibold"
                                  : "text-slate-600 hover:bg-slate-50"
                              }`}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    <button
                      onClick={() =>
                        setWindowIdx((i) =>
                          Math.min(windowOptions.length - 1, (i ?? 0) + 1)
                        )
                      }
                      disabled={isLastWindow}
                      title="Next 6 months"
                      data-testid="trend-next-btn"
                      className="h-8 w-8 flex items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:border-slate-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors shadow-sm"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>

                    <span className="text-xs text-slate-400 ml-1 tabular-nums">
                      {windowIdx !== null
                        ? `${windowIdx + 1} / ${windowOptions.length}`
                        : `all ${windowOptions.length}`}
                    </span>

                  </div>
                )}

              </div>
            </CardHeader>

            <CardContent>
              <div className="h-80">
                {trendData.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center gap-2 text-slate-400">
                    <BarChart3 className="w-10 h-10 text-slate-300" />
                    <p className="text-sm font-medium">No trend data available</p>
                    <p className="text-xs text-slate-400">
                      Rulings need a valid decision_date to appear here.
                    </p>
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={visibleTrendData} margin={{ top: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                      <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                      <YAxis allowDecimals={false} />
                      <Tooltip />
                      <Legend />
                      <Line
                        type="monotone"
                        dataKey="positive"
                        stroke="#10B981"
                        strokeWidth={2}
                        dot={{ r: 4 }}
                        name="Positive"
                      />
                      <Line
                        type="monotone"
                        dataKey="conditional"
                        stroke="#F59E0B"
                        strokeWidth={2}
                        dot={{ r: 4 }}
                        name="Conditional"
                      />
                      <Line
                        type="monotone"
                        dataKey="negative"
                        stroke="#EF4444"
                        strokeWidth={2}
                        dot={{ r: 4 }}
                        name="Negative"
                      />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            </CardContent>
          </Card>

          {/* ── Bottom grid: manufacturers + key insights ── */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

            <Card className="border-slate-200" data-testid="top-mfrs-table">
              <CardHeader className="border-b border-slate-100 bg-slate-50/50">
                <CardTitle className="text-lg font-semibold text-slate-900 font-heading flex items-center gap-2">
                  <Building2 className="w-5 h-5 text-slate-500" />
                  Top Manufacturers
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Rank</th>
                      <th>Manufacturer</th>
                      <th>Rulings</th>
                    </tr>
                  </thead>
                  <tbody>
                    {manufacturersToDisplay.length > 0 ? (
                      manufacturersToDisplay.map((mfr, index) => (
                        <tr key={mfr?.name ?? `mfr-${index}`}>
                          <td>
                            <span className="w-6 h-6 bg-slate-100 rounded-full inline-flex items-center justify-center text-xs font-semibold">
                              {index + 1}
                            </span>
                          </td>
                          <td className="font-medium">{mfr?.name ?? "Unknown"}</td>
                          <td>
                            <Badge variant="secondary" className="font-mono">
                              {mfr?.count ?? 0}
                            </Badge>
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={3} className="text-sm text-slate-500 p-4">
                          No manufacturer data.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>

                {hasMoreManufacturers && (
                  <div className="px-4 pb-4 pt-2">
                    <button
                      onClick={() => setShowAllMfr((prev) => !prev)}
                      className="w-full text-xs font-medium text-sky-600 hover:text-sky-800 border border-sky-100 hover:border-sky-300 rounded-lg py-2 transition-colors duration-150 flex items-center justify-center gap-1"
                      data-testid="toggle-manufacturers-btn-insights"
                    >
                      {showAllMfr
                        ? <>Show Less ▲</>
                        : <>Show All ({insights?.all_manufacturers?.length ?? 0}) ▼</>
                      }
                    </button>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="lg:col-span-2 border-slate-200" data-testid="key-insights">
              <CardHeader className="border-b border-slate-100 bg-slate-50/50">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <CardTitle className="text-lg font-semibold text-slate-900 font-heading flex items-center gap-2">
                    <Activity className="w-5 h-5 text-sky-500" />
                    Key Insights for HTA Submissions
                  </CardTitle>
                  {windowPeriod && (
                    <Badge
                      variant="outline"
                      className="text-xs text-sky-700 border-sky-200 bg-sky-50"
                    >
                      {windowPeriod}
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="p-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

                  <div className="space-y-4">
                    <div className="p-4 bg-emerald-50 rounded-lg border border-emerald-200">
                      <div className="flex items-center gap-2 mb-2">
                        <TrendingUp className="w-5 h-5 text-emerald-600" />
                        <h4 className="font-semibold text-emerald-800">Success Factors</h4>
                      </div>
                      <ul className="text-sm text-emerald-700 space-y-1">
                        {successItems.length > 0
                          ? successItems.map((item, i) => <li key={i}>• {item}</li>)
                          : <li className="text-emerald-500 italic">No positive rulings in this period.</li>
                        }
                      </ul>
                    </div>

                    <div className="p-4 bg-amber-50 rounded-lg border border-amber-200">
                      <div className="flex items-center gap-2 mb-2">
                        <AlertCircle className="w-5 h-5 text-amber-600" />
                        <h4 className="font-semibold text-amber-800">Common Objections</h4>
                      </div>
                      <ul className="text-sm text-amber-700 space-y-1">
                        {objectionItems.length > 0
                          ? objectionItems.map((item, i) => <li key={i}>• {item}</li>)
                          : <li className="text-amber-500 italic">No objections recorded in this period.</li>
                        }
                      </ul>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div className="p-4 bg-sky-50 rounded-lg border border-sky-200">
                      <div className="flex items-center gap-2 mb-2">
                        <FileText className="w-5 h-5 text-sky-600" />
                        <h4 className="font-semibold text-sky-800">ZIN Focus Areas</h4>
                      </div>
                      <ul className="text-sm text-sky-700 space-y-1">
                        {focusItems.length > 0
                          ? focusItems.map((item, i) => <li key={i}>• {item}</li>)
                          : <li className="text-sky-500 italic">No focus area data available.</li>
                        }
                      </ul>
                    </div>

                    <div className="p-4 bg-slate-100 rounded-lg border border-slate-200">
                      <div className="flex items-center gap-2 mb-2">
                        <Calendar className="w-5 h-5 text-slate-600" />
                        <h4 className="font-semibold text-slate-800">Timeline Insights</h4>
                      </div>
                      <ul className="text-sm text-slate-700 space-y-1">
                        {timelineItems.map((item, i) => <li key={i}>• {item}</li>)}
                      </ul>
                    </div>
                  </div>

                </div>
              </CardContent>
            </Card>

          </div>

          {/* ── Deep-Dive Analysis Panel ── */}
          <DeepDivePanel />

        </div>
      </div>
    </>
  );
}