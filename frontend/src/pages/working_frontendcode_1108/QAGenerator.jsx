// src/pages/QAGenerator.jsx
import { useState, useEffect, useMemo, useCallback, memo, useRef } from "react";
import axios from "axios";
import { toast } from "sonner";
import { jsPDF } from "jspdf";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { ScrollArea } from "../components/ui/scroll-area";
import { Checkbox } from "../components/ui/checkbox";
import { Label } from "../components/ui/label";
import {
  BrainCircuit, FileText, Loader2, Copy, Download,
  ChevronRight, ChevronLeft, Sparkles, CheckCircle,
  Lightbulb, ChevronsLeft, ChevronsRight, BookOpen,
  MessageSquare, Filter, Search as SearchIcon, X,
  Stethoscope, ThumbsUp, ThumbsDown, Send, Bot, User,
  PanelRightOpen, PanelRightClose, Globe, TrendingUp,
  AlertTriangle,
} from "lucide-react";

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;
const RULINGS_PAGE_SIZE     = 15;
const MAX_RULINGS_SELECTION = 10;

// ─── Pinned years ─────────────────────────────────────────────────────────────
const PINNED_YEARS = ["2026", "2025"];

// ─── Stable icon constants ────────────────────────────────────────────────────
const FT_ICON  = <FileText    className="w-4 h-4" />;
const BIA_ICON = <BookOpen    className="w-4 h-4" />;
const FE_ICON  = <CheckCircle className="w-4 h-4" />;
const DEF_ICON = <Lightbulb   className="w-4 h-4" />;

// ─── Dossier colour palette ───────────────────────────────────────────────────
const DOSSIER_META = Object.freeze({
  FT: {
    colorHeader: "text-blue-800",
    colorBadge:  "bg-blue-100 text-blue-700",
    colorBorder: "border-blue-300",
    colorBg:     "bg-blue-50",
    colorBar:    "bg-blue-500",
    colorIndex:  "bg-blue-500 text-white",
    colorQ:      "text-blue-600",
    colorABg:    "bg-blue-50 border-blue-200",
    colorALabel: "text-blue-500",
    icon:        FT_ICON,
    rgb:         [59, 130, 246],
    rgbLight:    [233, 242, 254],
  },
  BIA: {
    colorHeader: "text-emerald-800",
    colorBadge:  "bg-emerald-100 text-emerald-700",
    colorBorder: "border-emerald-300",
    colorBg:     "bg-emerald-50",
    colorBar:    "bg-emerald-500",
    colorIndex:  "bg-emerald-500 text-white",
    colorQ:      "text-emerald-600",
    colorABg:    "bg-emerald-50 border-emerald-200",
    colorALabel: "text-emerald-500",
    icon:        BIA_ICON,
    rgb:         [16, 185, 129],
    rgbLight:    [236, 253, 245],
  },
  FE: {
    colorHeader: "text-purple-800",
    colorBadge:  "bg-purple-100 text-purple-700",
    colorBorder: "border-purple-300",
    colorBg:     "bg-purple-50",
    colorBar:    "bg-purple-500",
    colorIndex:  "bg-purple-500 text-white",
    colorQ:      "text-purple-600",
    colorABg:    "bg-purple-50 border-purple-200",
    colorALabel: "text-purple-500",
    icon:        FE_ICON,
    rgb:         [168, 85, 247],
    rgbLight:    [250, 245, 255],
  },
});

const DEFAULT_META = Object.freeze({
  colorHeader: "text-slate-800",
  colorBadge:  "bg-slate-100 text-slate-700",
  colorBorder: "border-slate-300",
  colorBg:     "bg-slate-50",
  colorBar:    "bg-slate-400",
  colorIndex:  "bg-slate-400 text-white",
  colorQ:      "text-slate-600",
  colorABg:    "bg-slate-50 border-slate-200",
  colorALabel: "text-slate-500",
  icon:        DEF_ICON,
  rgb:         [148, 163, 184],
  rgbLight:    [248, 250, 252],
});

const getMeta = (code) => DOSSIER_META[code] || DEFAULT_META;

const impStyle = (imp) => {
  switch ((imp || "").toLowerCase()) {
    case "high":
      return { badge: "bg-red-100 text-red-700 border border-red-200",       dot: "bg-red-500"   };
    case "medium":
      return { badge: "bg-amber-100 text-amber-700 border border-amber-200", dot: "bg-amber-500" };
    default:
      return { badge: "bg-slate-100 text-slate-600 border border-slate-200", dot: "bg-slate-400" };
  }
};

const impPdfColor = (imp) => {
  switch ((imp || "").toLowerCase()) {
    case "high":   return { bg: [239, 68,  68],  light: [254, 226, 226] };
    case "medium": return { bg: [245, 158, 11],  light: [254, 243, 199] };
    default:       return { bg: [148, 163, 184], light: [241, 245, 249] };
  }
};

// ─── Debounce hook ────────────────────────────────────────────────────────────
function useDebounce(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

// ─── Feedback logger ──────────────────────────────────────────────────────────
const logFeedback = async (payload) => {
  console.info(
    `[QA-FEEDBACK] type=${payload.feedbackType} | question="${payload.question}" | ` +
    `rulings=${JSON.stringify(payload.rulingIds ?? [])} | dossier=${payload.dossierCode ?? "db-search"} | ` +
    `importance=${payload.importance} | mode=${payload.mode ?? "ruling"} | ` +
    `issues=${JSON.stringify(payload.issues ?? [])} | comment="${payload.comment ?? ""}" | ` +
    `timestamp=${payload.timestamp}`
  );
  try {
    await axios.post(`${API}/feedback/qa`, payload);
  } catch {
    // Silently ignore — logging still happens via console
  }
};

// ─── Negative feedback issue options ─────────────────────────────────────────
const NEGATIVE_ISSUES = [
  "This is harmful / unsafe",
  "This isn't true",
  "This isn't helpful",
  "Question is irrelevant",
  "Response is incomplete",
];

// ─── Expanded example prompts ─────────────────────────────────────────────────
const DB_EXAMPLE_PROMPTS = [
  "What concerns has ZIN raised about utilities in oncology?",
  "Common criticisms of subgroup analyses",
  "How does ZIN evaluate extrapolation assumptions?",
  "What indirect comparison methods has ZIN accepted?",
  "What risks are associated with using a single-arm trial?",
  "How has ZIN assessed budget impact models in rare diseases?",
  "What are common reasons for a negative ZIN decision?",
];

// ─── Feedback panel (shared by both ruling-based and database search cards) ───
function FeedbackPanel({ feedbackMeta }) {
  const [feedbackType,   setFeedbackType]   = useState(null);
  const [submitted,      setSubmitted]      = useState(false);
  const [selectedIssues, setSelectedIssues] = useState([]);
  const [comment,        setComment]        = useState("");
  const [submittingNeg,  setSubmittingNeg]  = useState(false);

  const handlePositive = async () => {
    if (submitted) return;
    setFeedbackType("positive");
    setSubmitted(true);
    await logFeedback({
      ...feedbackMeta,
      feedbackType: "positive",
      issues:       [],
      comment:      "",
      timestamp:    new Date().toISOString(),
    });
    toast.success("Thanks for the positive feedback!");
  };

  const handleNegativeOpen = () => {
    if (submitted) return;
    setFeedbackType("negative");
  };

  const handleNegativeSubmit = async () => {
    setSubmittingNeg(true);
    await logFeedback({
      ...feedbackMeta,
      feedbackType: "negative",
      issues:       selectedIssues,
      comment,
      timestamp:    new Date().toISOString(),
    });
    setSubmitted(true);
    setSubmittingNeg(false);
    toast.success("Thanks for your feedback — it helps us improve!");
  };

  const toggleIssue = (issue) =>
    setSelectedIssues((prev) =>
      prev.includes(issue) ? prev.filter((i) => i !== issue) : [...prev, issue]
    );

  if (submitted) {
    return (
      <div className="mt-3">
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <CheckCircle className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
          <span>
            {feedbackType === "positive"
              ? "Marked as helpful — thank you!"
              : "Feedback submitted — thank you!"}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-400 mr-1">Was this helpful?</span>
        <button
          onClick={handlePositive}
          title="Helpful"
          className={`flex items-center gap-1 px-2 py-1 rounded-md border text-xs font-medium transition-colors ${
            feedbackType === "positive"
              ? "bg-emerald-50 border-emerald-300 text-emerald-700"
              : "bg-white border-slate-200 text-slate-500 hover:border-emerald-300 hover:text-emerald-600 hover:bg-emerald-50"
          }`}
        >
          <ThumbsUp className="w-3.5 h-3.5" />
          <span>Yes</span>
        </button>
        <button
          onClick={handleNegativeOpen}
          title="Not helpful"
          className={`flex items-center gap-1 px-2 py-1 rounded-md border text-xs font-medium transition-colors ${
            feedbackType === "negative"
              ? "bg-red-50 border-red-300 text-red-700"
              : "bg-white border-slate-200 text-slate-500 hover:border-red-300 hover:text-red-600 hover:bg-red-50"
          }`}
        >
          <ThumbsDown className="w-3.5 h-3.5" />
          <span>No</span>
        </button>
      </div>

      {feedbackType === "negative" && !submitted && (
        <div className="rounded-lg border border-red-100 bg-red-50 p-3 space-y-3">
          <div>
            <p className="text-xs font-semibold text-slate-600 mb-2">Select all that apply:</p>
            <div className="space-y-1.5">
              {NEGATIVE_ISSUES.map((issue) => (
                <div key={issue} className="flex items-center gap-2">
                  <Checkbox
                    id={`issue-${issue}-${feedbackMeta.questionIndex}`}
                    checked={selectedIssues.includes(issue)}
                    onCheckedChange={() => toggleIssue(issue)}
                    className="h-3.5 w-3.5"
                  />
                  <Label
                    htmlFor={`issue-${issue}-${feedbackMeta.questionIndex}`}
                    className="text-xs text-slate-600 cursor-pointer"
                  >
                    {issue}
                  </Label>
                </div>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-600 mb-1">Additional comments:</p>
            <Textarea
              placeholder="Tell us what went wrong or how we can improve..."
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={2}
              className="resize-none text-xs bg-white"
            />
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={() => setFeedbackType(null)}
              className="text-xs text-slate-400 hover:text-slate-600"
            >
              Cancel
            </button>
            <Button
              size="sm"
              onClick={handleNegativeSubmit}
              disabled={submittingNeg}
              className="h-7 text-xs bg-red-600 hover:bg-red-700 text-white"
            >
              {submittingNeg
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : "Submit Feedback"
              }
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Ruling pagination controls ───────────────────────────────────────────────
const RulingPaginationControls = memo(function RulingPaginationControls({
  currentPage, totalPages, onPageChange,
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between px-4 py-3 border-t border-slate-200 bg-white">
      <span className="text-xs text-slate-500">
        <span className="font-semibold text-slate-700">{currentPage}</span>
        {" / "}
        <span className="font-semibold text-slate-700">{totalPages}</span>
      </span>
      <div className="flex items-center gap-1">
        <Button
          variant="outline" size="sm" className="h-7 w-7 p-0"
          disabled={currentPage === 1} onClick={() => onPageChange(1)}
        >
          <ChevronsLeft className="w-3.5 h-3.5" />
        </Button>
        <Button
          variant="outline" size="sm" className="h-7 w-7 p-0"
          disabled={currentPage === 1} onClick={() => onPageChange(currentPage - 1)}
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </Button>
        {Array.from({ length: totalPages }, (_, i) => i + 1)
          .filter((p) => p === 1 || p === totalPages || Math.abs(p - currentPage) <= 1)
          .reduce((acc, p, idx, arr) => {
            if (idx > 0 && p - arr[idx - 1] > 1) acc.push("...");
            acc.push(p);
            return acc;
          }, [])
          .map((item, idx) =>
            item === "..." ? (
              <span
                key={`e-${idx}`}
                className="h-7 w-5 flex items-center justify-center text-xs text-slate-400"
              >
                …
              </span>
            ) : (
              <Button
                key={item}
                variant={currentPage === item ? "default" : "outline"}
                size="sm"
                onClick={() => onPageChange(item)}
                className={`h-7 w-7 p-0 text-xs ${
                  currentPage === item
                    ? "bg-sky-600 hover:bg-sky-700 text-white border-sky-600"
                    : ""
                }`}
              >
                {item}
              </Button>
            )
          )}
        <Button
          variant="outline" size="sm" className="h-7 w-7 p-0"
          disabled={currentPage === totalPages} onClick={() => onPageChange(currentPage + 1)}
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </Button>
        <Button
          variant="outline" size="sm" className="h-7 w-7 p-0"
          disabled={currentPage === totalPages} onClick={() => onPageChange(totalPages)}
        >
          <ChevronsRight className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
});

// ─── Single question card (ruling-based mode) ─────────────────────────────────
const QCard = memo(function QCard({
  q, num, code, dossierName, therapyArea, rulingIds, sourceRulingTitle, onCopy,
}) {
  const m  = getMeta(code);
  const is = impStyle(q.importance);

  const feedbackMeta = {
    mode:              "ruling",                  // ← identifies the source mode
    questionIndex:     num,
    question:          q.question,
    importance:        q.importance,
    suggestedResponse: q.suggested_response,
    dossierCode:       code,
    dossierName,
    rulingIds,
  };

  return (
    <div className="group relative bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm hover:shadow-md transition-shadow">
      <div className={`h-1 w-full ${m.colorBar}`} />
      <div className="p-5">
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="flex items-start gap-2 flex-1 min-w-0">
            <span className={`shrink-0 text-xs font-bold mt-0.5 whitespace-nowrap ${m.colorQ}`}>
              Q{num}.
            </span>
            <p className="text-sm font-semibold text-slate-800 leading-snug">{q.question}</p>
          </div>
          <Button
            variant="ghost" size="sm"
            className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity text-slate-400 hover:text-slate-700 shrink-0"
            onClick={() => onCopy(q)}
            title="Copy"
          >
            <Copy className="w-3.5 h-3.5" />
          </Button>
        </div>
        <div className="flex items-center gap-2 flex-wrap mb-4">
          <span className={`flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full capitalize ${is.badge}`}>
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${is.dot}`} />
            {q.importance}
          </span>
          {dossierName && (
            <span className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full ${m.colorBadge}`}>
              <span className="shrink-0">{m.icon}</span>
              {dossierName}
            </span>
          )}
          {therapyArea && (
            <span className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-teal-50 text-teal-700 border border-teal-200">
              <Stethoscope className="w-3 h-3 shrink-0" />
              {therapyArea}
            </span>
          )}
          {sourceRulingTitle && (
            <span className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
              <FileText className="w-3 h-3 shrink-0" />
              {sourceRulingTitle}
            </span>
          )}
        </div>
        <div className={`rounded-lg border p-3.5 ${m.colorABg}`}>
          <div className="flex items-center gap-1.5 mb-2">
            <MessageSquare className={`w-3.5 h-3.5 shrink-0 ${m.colorALabel}`} />
            <span className={`text-xs font-semibold uppercase tracking-wide ${m.colorALabel}`}>
              Suggested Response
            </span>
          </div>
          <p className="text-sm text-slate-600 leading-relaxed">{q.suggested_response}</p>
        </div>
        <FeedbackPanel feedbackMeta={feedbackMeta} />
      </div>
    </div>
  );
});

// ─── Dossier block ────────────────────────────────────────────────────────────
const DossierBlock = memo(function DossierBlock({
  dossier, offset, onCopy, therapyAreas, rulingIds,
}) {
  const m  = getMeta(dossier.dossier_code);
  const qs = Array.isArray(dossier.predicted_questions) ? dossier.predicted_questions : [];

  return (
    <div
      className={`rounded-2xl border overflow-hidden ${m.colorBorder}`}
      data-testid={`dossier-section-${dossier.dossier_code}`}
    >
      <div className={`p-4 space-y-3 ${m.colorBg}`}>
        {qs.map((q, i) => (
          <QCard
            key={i}
            q={q}
            num={offset + i + 1}
            code={dossier.dossier_code}
            dossierName={dossier.dossier_name}
            therapyArea={therapyAreas}
            rulingIds={rulingIds}
            sourceRulingTitle={q.source_ruling_title ?? null}
            onCopy={onCopy}
          />
        ))}
      </div>
    </div>
  );
});

// ─── Database search result card ──────────────────────────────────────────────
// ── CHANGED: accepts dbQuery, dbDossierType, dbIndication for feedback context;
//             renders FeedbackPanel below the recommendation block.
const DbResultCard = memo(function DbResultCard({
  item, num, onCopy, dbQuery, dbDossierType, dbIndication,
}) {
  const is = impStyle(item.importance);

  // ── Build feedback metadata for this specific database search result ───────
  const feedbackMeta = {
    mode:              "database",                // ← distinguishes from ruling mode
    questionIndex:     num,
    question:          item.question,
    importance:        item.importance,
    suggestedResponse: item.suggested_response,
    recommendation:    item.recommendation ?? null,
    dossierCode:       dbDossierType || null,     // dossier type filter used, if any
    dossierName:       null,                      // not applicable in db-search mode
    rulingIds:         [],                        // no specific rulings selected
    searchQuery:       dbQuery,                   // the free-text query that produced this result
    indication:        dbIndication || null,      // indication filter used, if any
    frequency:         item.frequency ?? null,    // how many rulings raised this concern
    sourceRulingTitles: Array.isArray(item.source_rulings)
      ? item.source_rulings.map((s) => s.title ?? s)
      : [],
  };

  return (
    <div className="group relative bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm hover:shadow-md transition-shadow">
      <div className="h-1 w-full bg-sky-500" />
      <div className="p-5">
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="flex items-start gap-2 flex-1 min-w-0">
            <span className="shrink-0 text-xs font-bold mt-0.5 whitespace-nowrap text-sky-600">
              Q{num}.
            </span>
            <p className="text-sm font-semibold text-slate-800 leading-snug">{item.question}</p>
          </div>
          <Button
            variant="ghost" size="sm"
            className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity text-slate-400 hover:text-slate-700 shrink-0"
            onClick={() => onCopy(item)}
            title="Copy"
          >
            <Copy className="w-3.5 h-3.5" />
          </Button>
        </div>

        <div className="flex items-center gap-2 flex-wrap mb-4">
          {item.importance && (
            <span className={`flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full capitalize ${is.badge}`}>
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${is.dot}`} />
              {item.importance}
            </span>
          )}
          {item.frequency && (
            <span className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
              <TrendingUp className="w-3 h-3 shrink-0" />
              Raised in {item.frequency} ruling{item.frequency !== 1 ? "s" : ""}
            </span>
          )}
          {Array.isArray(item.source_rulings) && item.source_rulings.map((src, i) => (
            <span
              key={i}
              className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 border border-slate-200"
            >
              <FileText className="w-3 h-3 shrink-0" />
              {src.title ?? src}
            </span>
          ))}
        </div>

        <div className="rounded-lg border p-3.5 bg-sky-50 border-sky-200">
          <div className="flex items-center gap-1.5 mb-2">
            <MessageSquare className="w-3.5 h-3.5 shrink-0 text-sky-500" />
            <span className="text-xs font-semibold uppercase tracking-wide text-sky-500">
              Suggested Response
            </span>
          </div>
          <p className="text-sm text-slate-600 leading-relaxed">{item.suggested_response}</p>
        </div>

        {item.recommendation && (
          <div className="mt-3 rounded-lg border p-3.5 bg-amber-50 border-amber-200">
            <div className="flex items-center gap-1.5 mb-2">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-600" />
              <span className="text-xs font-semibold uppercase tracking-wide text-amber-600">
                Recommendation
              </span>
            </div>
            <p className="text-sm text-slate-600 leading-relaxed">{item.recommendation}</p>
          </div>
        )}

        {/* ── ADDED: feedback panel — identical UX to ruling-based cards ── */}
        <FeedbackPanel feedbackMeta={feedbackMeta} />
      </div>
    </div>
  );
});

// ─── Selected rulings strip ───────────────────────────────────────────────────
const SelectedRulingStrip = memo(function SelectedRulingStrip({
  selectedRulings, rulings, onRemove,
}) {
  if (selectedRulings.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 mb-3">
      {selectedRulings.map((id) => {
        const ruling = rulings.find((r) => r.id === id);
        if (!ruling) return null;
        return (
          <span
            key={id}
            className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-sky-100 text-sky-800 border border-sky-200 max-w-[280px]"
          >
            <FileText className="w-3 h-3 shrink-0" />
            <span className="truncate">{ruling.title}</span>
            <button
              onClick={() => onRemove(id)}
              className="ml-0.5 text-sky-500 hover:text-sky-800 transition-colors shrink-0"
              title="Remove ruling"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        );
      })}
    </div>
  );
});

// ─── Mode toggle ──────────────────────────────────────────────────────────────
function ModeToggle({ mode, onChange }) {
  return (
    <div className="inline-flex rounded-lg border border-slate-200 bg-slate-100 p-1 gap-1">
      <button
        onClick={() => onChange("ruling")}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
          mode === "ruling"
            ? "bg-white text-sky-700 shadow-sm border border-slate-200"
            : "text-slate-500 hover:text-slate-700"
        }`}
        data-testid="mode-ruling-btn"
      >
        <FileText className="w-3.5 h-3.5" />
        Ruling-Based
      </button>
      <button
        onClick={() => onChange("database")}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
          mode === "database"
            ? "bg-white text-sky-700 shadow-sm border border-slate-200"
            : "text-slate-500 hover:text-slate-700"
        }`}
        data-testid="mode-database-btn"
      >
        <Globe className="w-3.5 h-3.5" />
        Database Search
        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-700">
          NEW
        </span>
      </button>
    </div>
  );
}

// ─── Chat message bubble ──────────────────────────────────────────────────────
const ChatBubble = memo(function ChatBubble({ message }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex gap-2.5 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${
        isUser ? "bg-sky-600" : "bg-slate-100 border border-slate-200"
      }`}>
        {isUser
          ? <User className="w-3.5 h-3.5 text-white" />
          : <Bot  className="w-3.5 h-3.5 text-slate-500" />
        }
      </div>
      <div className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
        isUser
          ? "bg-sky-600 text-white rounded-tr-sm"
          : "bg-white border border-slate-200 text-slate-700 rounded-tl-sm shadow-sm"
      }`}>
        {message.content}
      </div>
    </div>
  );
});

// ─── Chat starter questions ───────────────────────────────────────────────────
const CHAT_STARTERS = [
  "What concerns appeared across all selected rulings?",
  "How did ZIN evaluate utilities in these cases?",
  "Which arguments appeared most persuasive?",
  "What were the key differences between these rulings?",
  "What extrapolation concerns were raised?",
  "Which subgroup analyses were accepted or rejected?",
];

// ─── Chat panel ───────────────────────────────────────────────────────────────
function ChatPanel({ selectedRulings, rulingTitles, onClose }) {
  const [chatHistory, setChatHistory] = useState([
    {
      role:    "assistant",
      content: `I have access to ${rulingTitles.length} selected ruling${
        rulingTitles.length !== 1 ? "s" : ""
      }. Ask me anything about them — recurring concerns, differences, how ZIN evaluated specific topics, or which arguments were persuasive.`,
    },
  ]);
  const [chatInput,   setChatInput]   = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory, chatLoading]);

  const sendMessage = useCallback(async (overrideText) => {
    const text = (overrideText ?? chatInput).trim();
    if (!text || chatLoading) return;
    setChatInput("");
    const userMsg = { role: "user", content: text };
    setChatHistory((prev) => [...prev, userMsg]);
    setChatLoading(true);
    try {
      const { data } = await axios.post(`${API}/qa/chat`, {
        ruling_ids: selectedRulings,
        history:    chatHistory,
        message:    text,
      });
      setChatHistory((prev) => [
        ...prev,
        { role: "assistant", content: data.reply ?? "No response received." },
      ]);
    } catch {
      setChatHistory((prev) => [
        ...prev,
        { role: "assistant", content: "Sorry, I couldn't get a response. Please try again." },
      ]);
      toast.error("Chat request failed");
    } finally {
      setChatLoading(false);
    }
  }, [chatInput, chatHistory, chatLoading, selectedRulings]);

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <aside
      className="w-96 shrink-0 border-l border-slate-200 bg-white flex flex-col"
      data-testid="qa-chat-panel"
    >
      <div className="p-4 border-b border-slate-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-sky-100 rounded-lg flex items-center justify-center">
            <MessageSquare className="w-3.5 h-3.5 text-sky-600" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Chat with Rulings</h3>
            <p className="text-xs text-slate-400">
              {rulingTitles.length} ruling{rulingTitles.length !== 1 ? "s" : ""} in context
            </p>
          </div>
        </div>
        <Button
          variant="ghost" size="sm"
          onClick={onClose}
          className="h-7 w-7 p-0 text-slate-400 hover:text-slate-700"
          title="Close chat"
        >
          <PanelRightClose className="w-4 h-4" />
        </Button>
      </div>

      <div className="px-4 py-2 border-b border-slate-100 flex flex-wrap gap-1.5">
        {rulingTitles.map((title, i) => (
          <span
            key={i}
            className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-sky-50 text-sky-700 border border-sky-200"
          >
            <FileText className="w-2.5 h-2.5 shrink-0" />
            <span className="truncate max-w-[200px]">{title}</span>
          </span>
        ))}
      </div>

      <ScrollArea className="flex-1 px-4 py-4">
        <div className="space-y-4">
          {chatHistory.map((msg, i) => (
            <ChatBubble key={i} message={msg} />
          ))}
          {chatLoading && (
            <div className="flex gap-2.5">
              <div className="shrink-0 w-7 h-7 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center">
                <Bot className="w-3.5 h-3.5 text-slate-500" />
              </div>
              <div className="bg-white border border-slate-200 rounded-2xl rounded-tl-sm px-3.5 py-3 shadow-sm">
                <div className="flex gap-1">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="w-1.5 h-1.5 rounded-full bg-slate-300 animate-bounce"
                      style={{ animationDelay: `${i * 0.15}s` }}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {chatHistory.length === 1 && (
        <div className="px-4 pb-3">
          <p className="text-xs text-slate-400 mb-2 font-medium">Suggested questions:</p>
          <div className="flex flex-wrap gap-1.5">
            {CHAT_STARTERS.map((starter) => (
              <button
                key={starter}
                onClick={() => sendMessage(starter)}
                className="text-xs px-2.5 py-1.5 rounded-lg bg-slate-50 border border-slate-200 text-slate-600 hover:bg-sky-50 hover:border-sky-300 hover:text-sky-700 transition-colors text-left"
              >
                {starter}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="p-4 border-t border-slate-200">
        <div className="flex gap-2">
          <Textarea
            placeholder="Ask about these rulings..."
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={2}
            className="resize-none text-sm flex-1"
            disabled={chatLoading}
          />
          <Button
            onClick={() => sendMessage()}
            disabled={chatLoading || !chatInput.trim()}
            className="bg-sky-600 hover:bg-sky-700 self-stretch px-3 shrink-0"
            title="Send"
          >
            {chatLoading
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Send    className="w-4 h-4" />
            }
          </Button>
        </div>
        <p className="text-[11px] text-slate-400 mt-1.5">
          Enter to send · Shift+Enter for new line
        </p>
      </div>
    </aside>
  );
}

// ─── Cycling thinking messages ────────────────────────────────────────────────
const THINKING_MESSAGES = [
  "Thinking...",
  "Analysing ruling patterns...",
  "Identifying recurring themes...",
  "Synthesising across rulings...",
  "Predicting ZIN questions...",
  "Reviewing dossier context...",
  "Formulating suggested responses...",
  "Almost there...",
];

const DB_THINKING_MESSAGES = [
  "Searching all rulings...",
  "Finding relevant precedents...",
  "Analysing historical patterns...",
  "Identifying common ZIN concerns...",
  "Synthesising evidence base...",
  "Generating insights...",
  "Almost there...",
];

function useThinkingMessage(active, messages) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!active) { setIndex(0); return; }
    const id = setInterval(
      () => setIndex((prev) => (prev + 1) % messages.length),
      2000
    );
    return () => clearInterval(id);
  }, [active, messages]);
  return messages[index];
}

// ─── PDF helpers ──────────────────────────────────────────────────────────────
function safeFill(doc, r, g, b) {
  doc.setFillColor(
    Math.round(Math.min(255, Math.max(0, r))),
    Math.round(Math.min(255, Math.max(0, g))),
    Math.round(Math.min(255, Math.max(0, b)))
  );
}
function safeDraw(doc, r, g, b) {
  doc.setDrawColor(
    Math.round(Math.min(255, Math.max(0, r))),
    Math.round(Math.min(255, Math.max(0, g))),
    Math.round(Math.min(255, Math.max(0, b)))
  );
}
function safeText(doc, r, g, b) {
  doc.setTextColor(
    Math.round(Math.min(255, Math.max(0, r))),
    Math.round(Math.min(255, Math.max(0, g))),
    Math.round(Math.min(255, Math.max(0, b)))
  );
}
function splitLines(doc, text, maxWidth) {
  return doc.splitTextToSize(String(text || ""), maxWidth);
}

// ─── PDF export (Ruling-Based) ────────────────────────────────────────────────
function exportToPdf(dossiers, totalQCount, selectedRulingTitles = []) {
  const doc   = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const mL    = 48;
  const mR    = 48;
  const cW    = pageW - mL - mR;
  let   y     = 0;

  const guard = (needed = 20) => {
    if (y + needed > pageH - 48) { doc.addPage(); y = 48; }
  };

  const drawFooters = () => {
    const total = doc.internal.getNumberOfPages();
    for (let p = 1; p <= total; p++) {
      doc.setPage(p);
      doc.setFontSize(8);
      safeText(doc, 180, 180, 180);
      doc.text(
        `Page ${p} of ${total}  •  HTA Q&A Generator`,
        pageW / 2, pageH - 20, { align: "center" }
      );
    }
  };

  safeFill(doc, 14, 165, 233);
  doc.rect(0, 0, pageW, 190, "F");
  safeText(doc, 255, 255, 255);
  doc.setFontSize(28);
  doc.setFont("helvetica", "bold");
  doc.text("HTA Q&A Generator", mL, 78);
  doc.setFontSize(13);
  doc.setFont("helvetica", "normal");
  doc.text("Predicted ZIN Questions & Suggested Responses", mL, 108);
  doc.setFontSize(10);
  doc.text(
    `Generated: ${new Date().toLocaleDateString("en-GB", {
      day: "numeric", month: "long", year: "numeric",
    })}`,
    mL, 138
  );
  doc.text(
    `${totalQCount} question${totalQCount !== 1 ? "s" : ""}  •  ` +
    `${dossiers.length} dossier${dossiers.length !== 1 ? "s" : ""}  •  ` +
    `${selectedRulingTitles.length} ruling${selectedRulingTitles.length !== 1 ? "s" : ""}`,
    mL, 158
  );

  y = 216;

  if (selectedRulingTitles.length > 0) {
    safeText(doc, 30, 41, 59);
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.text("Reference Rulings:", mL, y);
    y += 16;
    selectedRulingTitles.forEach((title, idx) => {
      const lines = splitLines(doc, `${idx + 1}. ${title}`, cW - 20);
      lines.forEach((line) => {
        guard(14);
        doc.setFontSize(9);
        doc.setFont("helvetica", "normal");
        safeText(doc, 71, 85, 105);
        doc.text(line, mL + 10, y);
        y += 13;
      });
    });
    y += 10;
  }

  dossiers.forEach((d) => {
    const meta      = getMeta(d.dossier_code);
    const [r, g, b] = meta.rgb;
    const qCount    = (d.predicted_questions || []).length;
    guard(58);
    safeFill(doc, r, g, b);
    doc.roundedRect(mL, y, cW, 48, 6, 6, "F");
    safeText(doc, 255, 255, 255);
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.text(d.dossier_name || d.dossier_code, mL + 14, y + 18);
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.text(`${qCount} question${qCount !== 1 ? "s" : ""}`, mL + 14, y + 34);
    y += 58;
  });

  let globalQNum = 0;
  dossiers.forEach((dossier) => {
    const meta         = getMeta(dossier.dossier_code);
    const [r, g, b]    = meta.rgb;
    const [rl, gl, bl] = meta.rgbLight;
    const qs           = Array.isArray(dossier.predicted_questions)
      ? dossier.predicted_questions : [];

    doc.addPage();
    y = 48;
    safeFill(doc, r, g, b);
    doc.rect(0, 0, pageW, 5, "F");
    safeFill(doc, rl, gl, bl);
    safeDraw(doc, r, g, b);
    doc.setLineWidth(0.8);
    doc.roundedRect(mL, y, cW, 54, 6, 6, "FD");
    safeText(doc, r, g, b);
    doc.setFontSize(15);
    doc.setFont("helvetica", "bold");
    doc.text(dossier.dossier_name || dossier.dossier_code, mL + 14, y + 22);
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    safeText(doc, 100, 116, 139);
    doc.text(
      `${qs.length} predicted question${qs.length !== 1 ? "s" : ""}`,
      mL + 14, y + 38
    );
    y += 70;

    qs.forEach((q) => {
      globalQNum++;
      const imp      = impPdfColor(q.importance);
      const qLines   = splitLines(doc, q.question,           cW - 62);
      const aLines   = splitLines(doc, q.suggested_response, cW - 32);
      const srcLines = q.source_ruling_title
        ? splitLines(doc, `Source: ${q.source_ruling_title}`, cW - 32)
        : [];
      const respBoxH = aLines.length * 13 + 18;
      const srcH     = srcLines.length > 0 ? srcLines.length * 11 + 8 : 0;
      const cardH    = 14 + 14 + qLines.length * 14 + 10 + 16 + respBoxH + srcH + 14;
      guard(cardH + 16);
      const top = y;
      safeFill(doc, 226, 232, 240);
      doc.roundedRect(mL + 2, top + 3, cW, cardH, 6, 6, "F");
      safeFill(doc, 255, 255, 255);
      safeDraw(doc, 226, 232, 240);
      doc.setLineWidth(0.5);
      doc.roundedRect(mL, top, cW, cardH, 6, 6, "FD");
      safeFill(doc, r, g, b);
      doc.roundedRect(mL, top, cW, 4, 2, 2, "F");
      doc.rect(mL, top + 2, cW, 2, "F");
      let cy = top + 18;
      doc.setFontSize(9);
      doc.setFont("helvetica", "bold");
      safeText(doc, r, g, b);
      doc.text(`Q${globalQNum}.`, mL + 12, cy);
      const pillW = 52;
      const pillX = mL + cW - pillW - 12;
      const pillY = cy - 10;
      safeFill(doc, ...imp.bg);
      doc.roundedRect(pillX, pillY, pillW, 14, 3, 3, "F");
      safeText(doc, 255, 255, 255);
      doc.setFontSize(7);
      doc.setFont("helvetica", "bold");
      doc.text(
        (q.importance || "low").toUpperCase(),
        pillX + pillW / 2, cy - 1,
        { align: "center" }
      );
      cy += 6;
      doc.setFontSize(10);
      doc.setFont("helvetica", "bold");
      safeText(doc, 30, 41, 59);
      qLines.forEach((line) => { cy += 14; doc.text(line, mL + 30, cy); });
      cy += 10;
      doc.setFontSize(7.5);
      doc.setFont("helvetica", "bold");
      safeText(doc, r, g, b);
      doc.text("SUGGESTED RESPONSE", mL + 12, cy);
      cy += 4;
      safeFill(doc, rl, gl, bl);
      safeDraw(doc, r, g, b);
      doc.setLineWidth(0.4);
      doc.roundedRect(mL + 10, cy, cW - 20, respBoxH, 4, 4, "FD");
      cy += 12;
      doc.setFontSize(9);
      doc.setFont("helvetica", "normal");
      safeText(doc, 71, 85, 105);
      aLines.forEach((line) => { doc.text(line, mL + 16, cy); cy += 13; });
      if (srcLines.length > 0) {
        cy += 4;
        doc.setFontSize(7.5);
        doc.setFont("helvetica", "italic");
        safeText(doc, 148, 163, 184);
        srcLines.forEach((line) => { doc.text(line, mL + 16, cy); cy += 11; });
      }
      y = top + cardH + 14;
    });
  });

  drawFooters();
  doc.save("hta-questions.pdf");
}

// ─── PDF export (Database Search) ────────────────────────────────────────────
function exportDbToPdf(results, meta, query, dossierType, indication) {
  const doc   = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const mL    = 48;
  const mR    = 48;
  const cW    = pageW - mL - mR;
  let   y     = 0;

  const guard = (needed = 20) => {
    if (y + needed > pageH - 48) { doc.addPage(); y = 48; }
  };

  const drawFooters = () => {
    const total = doc.internal.getNumberOfPages();
    for (let p = 1; p <= total; p++) {
      doc.setPage(p);
      doc.setFontSize(8);
      safeText(doc, 180, 180, 180);
      doc.text(
        `Page ${p} of ${total}  •  HTA Q&A Generator — Database Search`,
        pageW / 2, pageH - 20, { align: "center" }
      );
    }
  };

  safeFill(doc, 14, 165, 233);
  doc.rect(0, 0, pageW, 190, "F");
  safeText(doc, 255, 255, 255);
  doc.setFontSize(28);
  doc.setFont("helvetica", "bold");
  doc.text("HTA Q&A Generator", mL, 78);
  doc.setFontSize(13);
  doc.setFont("helvetica", "normal");
  doc.text("Database Search — Evidence-Based Insights", mL, 108);
  doc.setFontSize(10);
  doc.text(
    `Generated: ${new Date().toLocaleDateString("en-GB", {
      day: "numeric", month: "long", year: "numeric",
    })}`,
    mL, 138
  );

  const metaParts = [
    `${results.length} insight${results.length !== 1 ? "s" : ""}`,
    meta?.rulings_searched != null
      ? `${meta.rulings_searched} ruling${meta.rulings_searched !== 1 ? "s" : ""} searched`
      : null,
    meta?.rulings_matched != null
      ? `${meta.rulings_matched} matched`
      : null,
  ].filter(Boolean);
  doc.text(metaParts.join("  •  "), mL, 158);

  y = 216;

  safeText(doc, 30, 41, 59);
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.text("Search Query:", mL, y);
  y += 16;
  const queryLines = splitLines(doc, query, cW - 20);
  queryLines.forEach((line) => {
    guard(14);
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    safeText(doc, 71, 85, 105);
    doc.text(line, mL + 10, y);
    y += 13;
  });
  y += 6;

  if (dossierType || indication) {
    if (dossierType) {
      guard(14);
      doc.setFontSize(9);
      doc.setFont("helvetica", "bold");
      safeText(doc, 30, 41, 59);
      doc.text("Dossier Type: ", mL, y);
      doc.setFont("helvetica", "normal");
      safeText(doc, 71, 85, 105);
      doc.text(dossierType, mL + 72, y);
      y += 14;
    }
    if (indication) {
      guard(14);
      doc.setFontSize(9);
      doc.setFont("helvetica", "bold");
      safeText(doc, 30, 41, 59);
      doc.text("Indication: ", mL, y);
      doc.setFont("helvetica", "normal");
      safeText(doc, 71, 85, 105);
      doc.text(indication, mL + 60, y);
      y += 14;
    }
    y += 6;
  }

  results.forEach((item, idx) => {
    const imp      = impPdfColor(item.importance);
    const qLines   = splitLines(doc, item.question,           cW - 62);
    const aLines   = splitLines(doc, item.suggested_response, cW - 32);
    const recLines = item.recommendation
      ? splitLines(doc, item.recommendation, cW - 32)
      : [];

    const srcTags    = Array.isArray(item.source_rulings)
      ? item.source_rulings.map((s) => s.title ?? s)
      : [];
    const srcTagText = srcTags.length > 0
      ? splitLines(doc, `Sources: ${srcTags.join(" · ")}`, cW - 32)
      : [];

    const respBoxH = aLines.length  * 13 + 18;
    const recBoxH  = recLines.length > 0 ? recLines.length * 13 + 28 : 0;
    const srcH     = srcTagText.length > 0 ? srcTagText.length * 11 + 8 : 0;
    const freqH    = item.frequency ? 14 : 0;
    const cardH    = 14 + 14 + qLines.length * 14 + 10 + 16 + respBoxH + recBoxH + srcH + freqH + 14;

    guard(cardH + 16);
    const top = y;

    safeFill(doc, 226, 232, 240);
    doc.roundedRect(mL + 2, top + 3, cW, cardH, 6, 6, "F");
    safeFill(doc, 255, 255, 255);
    safeDraw(doc, 226, 232, 240);
    doc.setLineWidth(0.5);
    doc.roundedRect(mL, top, cW, cardH, 6, 6, "FD");
    safeFill(doc, 14, 165, 233);
    doc.roundedRect(mL, top, cW, 4, 2, 2, "F");
    doc.rect(mL, top + 2, cW, 2, "F");

    let cy = top + 18;

    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    safeText(doc, 14, 165, 233);
    doc.text(`Q${idx + 1}.`, mL + 12, cy);

    const pillW = 52;
    const pillX = mL + cW - pillW - 12;
    const pillY = cy - 10;
    safeFill(doc, ...imp.bg);
    doc.roundedRect(pillX, pillY, pillW, 14, 3, 3, "F");
    safeText(doc, 255, 255, 255);
    doc.setFontSize(7);
    doc.setFont("helvetica", "bold");
    doc.text(
      (item.importance || "low").toUpperCase(),
      pillX + pillW / 2, cy - 1,
      { align: "center" }
    );

    if (item.frequency) {
      cy += 6;
      doc.setFontSize(7.5);
      doc.setFont("helvetica", "normal");
      safeText(doc, 180, 83, 9);
      doc.text(
        `Raised in ${item.frequency} ruling${item.frequency !== 1 ? "s" : ""}`,
        mL + 30, cy
      );
    }

    cy += 6;
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    safeText(doc, 30, 41, 59);
    qLines.forEach((line) => { cy += 14; doc.text(line, mL + 30, cy); });
    cy += 10;

    doc.setFontSize(7.5);
    doc.setFont("helvetica", "bold");
    safeText(doc, 14, 165, 233);
    doc.text("SUGGESTED RESPONSE", mL + 12, cy);
    cy += 4;
    safeFill(doc, 224, 242, 254);
    safeDraw(doc, 14, 165, 233);
    doc.setLineWidth(0.4);
    doc.roundedRect(mL + 10, cy, cW - 20, respBoxH, 4, 4, "FD");
    cy += 12;
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    safeText(doc, 71, 85, 105);
    aLines.forEach((line) => { doc.text(line, mL + 16, cy); cy += 13; });

    if (recLines.length > 0) {
      cy += 6;
      doc.setFontSize(7.5);
      doc.setFont("helvetica", "bold");
      safeText(doc, 180, 83, 9);
      doc.text("RECOMMENDATION", mL + 12, cy);
      cy += 4;
      safeFill(doc, 255, 251, 235);
      safeDraw(doc, 245, 158, 11);
      doc.setLineWidth(0.4);
      doc.roundedRect(mL + 10, cy, cW - 20, recBoxH - 22, 4, 4, "FD");
      cy += 12;
      doc.setFontSize(9);
      doc.setFont("helvetica", "normal");
      safeText(doc, 71, 85, 105);
      recLines.forEach((line) => { doc.text(line, mL + 16, cy); cy += 13; });
    }

    if (srcTagText.length > 0) {
      cy += 4;
      doc.setFontSize(7.5);
      doc.setFont("helvetica", "italic");
      safeText(doc, 148, 163, 184);
      srcTagText.forEach((line) => { doc.text(line, mL + 16, cy); cy += 11; });
    }

    y = top + cardH + 14;
  });

  drawFooters();
  doc.save("hta-database-insights.pdf");
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function QAGenerator() {

  const [rulings,               setRulings]               = useState([]);
  const [therapyAreas,          setTherapyAreas]          = useState([]);
  const [decisionOutcomes,      setDecisionOutcomes]      = useState([]);
  const [dossierCategories,     setDossierCategories]     = useState([]);

  const [searchQuery,               setSearchQuery]               = useState("");
  const [selectedTherapyAreas,      setSelectedTherapyAreas]      = useState([]);
  const [selectedOutcomes,          setSelectedOutcomes]          = useState([]);
  const [selectedDossierCategories, setSelectedDossierCategories] = useState([]);
  const [selectedYears,             setSelectedYears]             = useState([]);
  const [yearDropdownOpen,          setYearDropdownOpen]          = useState(false);

  const [mode, setMode] = useState("ruling");

  const [selectedRulings, setSelectedRulings] = useState([]);
  const [context,         setContext]         = useState("");
  const [dossiers,        setDossiers]        = useState([]);
  const [loading,         setLoading]         = useState(true);
  const [generating,      setGenerating]      = useState(false);
  const [rulingPage,      setRulingPage]      = useState(1);

  const [chatOpen, setChatOpen] = useState(false);

  const [dbQuery,       setDbQuery]       = useState("");
  const [dbDossierType, setDbDossierType] = useState("");
  const [dbIndication,  setDbIndication]  = useState("");
  const [dbContext,     setDbContext]     = useState("");
  const [dbResults,     setDbResults]     = useState([]);
  const [dbMeta,        setDbMeta]        = useState(null);
  const [dbGenerating,  setDbGenerating]  = useState(false);
  const [dbSearched,    setDbSearched]    = useState(false);

  const thinkingMessage   = useThinkingMessage(generating,   THINKING_MESSAGES);
  const dbThinkingMessage = useThinkingMessage(dbGenerating, DB_THINKING_MESSAGES);

  const debouncedSearch = useDebounce(searchQuery, 300);

  const selectedRulingTherapyAreas = useMemo(() => {
    if (selectedRulings.length === 0) return null;
    const areas = [
      ...new Set(
        selectedRulings
          .map((id) => rulings.find((r) => r.id === id)?.therapy_area)
          .filter(Boolean)
      ),
    ];
    return areas.length > 0 ? areas.join(", ") : null;
  }, [selectedRulings, rulings]);

  const selectedRulingTitles = useMemo(
    () =>
      selectedRulings
        .map((id) => rulings.find((r) => r.id === id)?.title)
        .filter(Boolean),
    [selectedRulings, rulings]
  );

  const availableYears = useMemo(() => {
    const yearSet = rulings.reduce((acc, r) => {
      const year = (r?.decision_date || "").substring(0, 4);
      if (/^\d{4}$/.test(year)) acc.add(year);
      return acc;
    }, new Set());
    return [...yearSet].sort((a, b) => b.localeCompare(a));
  }, [rulings]);

  const hasUnknownDateRulings = useMemo(
    () =>
      rulings.some((r) => {
        const date = r?.decision_date || "";
        return !date || date.length < 4 || !/^\d{4}$/.test(date.substring(0, 4));
      }),
    [rulings]
  );

  const filteredRulings = useMemo(() => {
    let results = Array.isArray(rulings) ? rulings : [];
    const query = (debouncedSearch || "").toLowerCase().trim();
    if (query) {
      results = results.filter((r) =>
        (r?.title        || "").toLowerCase().includes(query) ||
        (r?.drug_name    || "").toLowerCase().includes(query) ||
        (r?.manufacturer || "").toLowerCase().includes(query) ||
        (r?.summary      || "").toLowerCase().includes(query)
      );
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
        if (isValidYear  && selectedYears.includes(year))      return true;
        if (!isValidYear && selectedYears.includes("Unknown")) return true;
        return false;
      });
    }
    return results;
  }, [
    rulings, debouncedSearch,
    selectedTherapyAreas, selectedOutcomes,
    selectedDossierCategories, selectedYears,
  ]);

  useEffect(() => { setRulingPage(1); }, [
    debouncedSearch, selectedTherapyAreas,
    selectedOutcomes, selectedDossierCategories, selectedYears,
  ]);

  const totalRulingPages = Math.max(1, Math.ceil(filteredRulings.length / RULINGS_PAGE_SIZE));
  const paginatedRulings = useMemo(() => {
    const start = (rulingPage - 1) * RULINGS_PAGE_SIZE;
    return filteredRulings.slice(start, start + RULINGS_PAGE_SIZE);
  }, [filteredRulings, rulingPage]);

  const hasActiveFilters =
    Boolean(searchQuery)                ||
    selectedTherapyAreas.length > 0      ||
    selectedOutcomes.length > 0          ||
    selectedDossierCategories.length > 0 ||
    selectedYears.length > 0;

  const totalQCount = useMemo(
    () => dossiers.reduce((s, d) => s + (d.predicted_questions?.length || 0), 0),
    [dossiers]
  );

  const hasResults = dossiers.length > 0;

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [rulingsRes, taRes, doRes, dcRes] = await Promise.all([
          axios.get(`${API}/rulings`),
          axios.get(`${API}/therapy-areas`),
          axios.get(`${API}/decision-outcomes`),
          axios.get(`${API}/dossier-categories`),
        ]);
        setRulings(rulingsRes.data      || []);
        setTherapyAreas(taRes.data      || []);
        setDecisionOutcomes(doRes.data  || []);
        setDossierCategories(dcRes.data || []);
      } catch (err) {
        console.error("Failed to fetch data:", err);
        toast.error("Failed to load rulings");
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  const toggleTherapyArea = useCallback(
    (area) => setSelectedTherapyAreas((p) =>
      p.includes(area) ? p.filter((a) => a !== area) : [...p, area]
    ), []
  );
  const toggleOutcome = useCallback(
    (outcome) => setSelectedOutcomes((p) =>
      p.includes(outcome) ? p.filter((o) => o !== outcome) : [...p, outcome]
    ), []
  );
  const toggleDossierCategory = useCallback(
    (cat) => setSelectedDossierCategories((p) =>
      p.includes(cat) ? p.filter((c) => c !== cat) : [...p, cat]
    ), []
  );
  const toggleYear = useCallback(
    (year) => setSelectedYears((p) =>
      p.includes(year) ? p.filter((y) => y !== year) : [...p, year]
    ), []
  );
  const clearFilters = useCallback(() => {
    setSearchQuery("");
    setSelectedTherapyAreas([]);
    setSelectedOutcomes([]);
    setSelectedDossierCategories([]);
    setSelectedYears([]);
  }, []);

  const toggleRuling = useCallback((id) => {
    setSelectedRulings((prev) => {
      if (prev.includes(id)) return prev.filter((r) => r !== id);
      if (prev.length >= MAX_RULINGS_SELECTION) {
        toast.warning(`You can select up to ${MAX_RULINGS_SELECTION} rulings at once`);
        return prev;
      }
      return [...prev, id];
    });
  }, []);

  const handleModeChange = useCallback((newMode) => {
    setMode(newMode);
    setDossiers([]);
    setDbResults([]);
    setDbSearched(false);
    setDbMeta(null);
    setChatOpen(false);
  }, []);

  const generate = useCallback(async () => {
    if (selectedRulings.length === 0) {
      toast.warning("Please select at least one ruling");
      return;
    }
    setGenerating(true);
    setDossiers([]);
    setChatOpen(false);
    try {
      const { data } = await axios.post(`${API}/qa/generate`, {
        ruling_ids: selectedRulings,
        context,
      });
      const arr = Array.isArray(data.dossiers)  ? data.dossiers
                : Array.isArray(data.questions) ? data.questions
                : [];
      setDossiers(arr);
      if (arr.length > 0) {
        toast.success(
          selectedRulings.length > 1
            ? `Generated questions from ${selectedRulings.length} rulings`
            : `Loaded ${arr.length} dossier${arr.length !== 1 ? "s" : ""}`
        );
      } else {
        toast.warning("No dossiers returned");
      }
    } catch (err) {
      console.error("generate error:", err);
      toast.error("Failed to generate questions");
    } finally {
      setGenerating(false);
    }
  }, [selectedRulings, context]);

  const generateFromDatabase = useCallback(async () => {
    if (!dbQuery.trim()) {
      toast.warning("Please enter a question or topic to search");
      return;
    }
    setDbGenerating(true);
    setDbResults([]);
    setDbSearched(false);
    setDbMeta(null);
    try {
      const { data } = await axios.post(`${API}/qa/search-generate`, {
        query:        dbQuery.trim(),
        context:      dbContext     || undefined,
        dossier_type: dbDossierType || undefined,
        indication:   dbIndication  || undefined,
      });
      const results = Array.isArray(data.questions) ? data.questions
                    : Array.isArray(data.results)   ? data.results
                    : [];
      setDbResults(results);
      setDbMeta(data.meta ?? null);
      setDbSearched(true);
      if (data.meta?.off_topic) {
        toast.warning(
          data.meta.message ||
          "Your query does not appear to be related to HTA or ZIN ruling topics."
        );
      } else {
        toast.success(
          results.length > 0
            ? `Found ${results.length} insight${results.length !== 1 ? "s" : ""} across the database`
            : "No results found — try rephrasing your question"
        );
      }
    } catch (err) {
      console.error("DB search error:", err);
      toast.error("Database search failed");
      setDbSearched(true);
    } finally {
      setDbGenerating(false);
    }
  }, [dbQuery, dbContext, dbDossierType, dbIndication]);

  const copyQ = useCallback((q) => {
    navigator.clipboard.writeText(
      `Q. ${q.question}\n\nImportance: ${q.importance}\n\nA. ${q.suggested_response}`
    );
    toast.success("Copied");
  }, []);

  const exportAll = useCallback(() => {
    try {
      exportToPdf(dossiers, totalQCount, selectedRulingTitles);
      toast.success("PDF exported");
    } catch (err) {
      console.error("PDF export error:", err);
      toast.error("Failed to export PDF");
    }
  }, [dossiers, totalQCount, selectedRulingTitles]);

  const exportDbAll = useCallback(() => {
    try {
      exportDbToPdf(dbResults, dbMeta, dbQuery, dbDossierType, dbIndication);
      toast.success("PDF exported");
    } catch (err) {
      console.error("PDF export error:", err);
      toast.error("Failed to export PDF");
    }
  }, [dbResults, dbMeta, dbQuery, dbDossierType, dbIndication]);

  if (loading) return (
    <div className="flex min-h-screen" data-testid="qa-generator-loading">
      <div className="w-64 border-r border-slate-200 p-6">
        <Skeleton className="h-6 w-32 mb-6" />
        {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-5 w-full mb-3" />)}
      </div>
      <div className="w-80 border-r border-slate-200 p-4">
        <Skeleton className="h-8 w-full mb-4" />
        {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-20 w-full mb-3" />)}
      </div>
      <div className="flex-1 p-8">
        <Skeleton className="h-10 w-64 mb-8" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen" data-testid="qa-generator-page">

      {/* COL 1 — Filter sidebar (ruling mode only) */}
      {mode === "ruling" && (
        <aside
          className="w-64 shrink-0 border-r border-slate-200 bg-white flex flex-col"
          data-testid="qa-filter-sidebar"
        >
          <div className="p-5 border-b border-slate-200 flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
              <Filter className="w-4 h-4" /> Filters
            </h2>
            {hasActiveFilters && (
              <Button
                variant="ghost" size="sm" onClick={clearFilters}
                className="text-slate-500 hover:text-slate-700 h-7 px-2"
                data-testid="qa-clear-filters-btn"
              >
                <X className="w-3.5 h-3.5 mr-1" /> Clear
              </Button>
            )}
          </div>

          <ScrollArea className="flex-1 px-5 py-4">
            <div className="mb-6">
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
                Therapy Area
              </h3>
              {therapyAreas.map((area) => (
                <div key={area} className="flex items-center gap-2 mb-2">
                  <Checkbox
                    id={`qa-ta-${area}`}
                    checked={selectedTherapyAreas.includes(area)}
                    onCheckedChange={() => toggleTherapyArea(area)}
                  />
                  <Label htmlFor={`qa-ta-${area}`} className="text-sm cursor-pointer">
                    {area}
                  </Label>
                </div>
              ))}
            </div>

            <div className="mb-6">
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
                Decision Outcome
              </h3>
              {decisionOutcomes.map((outcome) => (
                <div key={outcome} className="flex items-center gap-2 mb-2">
                  <Checkbox
                    id={`qa-do-${outcome}`}
                    checked={selectedOutcomes.includes(outcome)}
                    onCheckedChange={() => toggleOutcome(outcome)}
                  />
                  <Label htmlFor={`qa-do-${outcome}`} className="text-sm cursor-pointer">
                    {outcome}
                  </Label>
                </div>
              ))}
            </div>

            {(availableYears.length > 0 || hasUnknownDateRulings) && (
              <div className="mb-6">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-2">
                    YEAR
                    {selectedYears.length > 0 && (
                      <span className="inline-flex items-center justify-center h-4 min-w-[1rem] px-1 rounded-full bg-sky-600 text-white text-[10px] font-semibold">
                        {selectedYears.length}
                      </span>
                    )}
                  </span>
                </div>
                {PINNED_YEARS.filter((y) => availableYears.includes(y)).map((year) => (
                  <div key={year} className="flex items-center gap-2 mb-2">
                    <Checkbox
                      id={`qa-year-pinned-${year}`}
                      checked={selectedYears.includes(year)}
                      onCheckedChange={() => toggleYear(year)}
                      data-testid={`qa-year-pinned-${year}`}
                    />
                    <Label
                      htmlFor={`qa-year-pinned-${year}`}
                      className="text-sm cursor-pointer font-medium text-slate-700"
                    >
                      {year}
                    </Label>
                  </div>
                ))}
                {(availableYears.some((y) => !PINNED_YEARS.includes(y)) || hasUnknownDateRulings) && (
                  <>
                    <button
                      type="button"
                      onClick={() => setYearDropdownOpen((prev) => !prev)}
                      className="w-full flex items-center justify-between text-xs font-semibold text-slate-400 uppercase tracking-wider cursor-pointer select-none focus:outline-none hover:text-slate-600 transition-colors mt-1 mb-1"
                      aria-expanded={yearDropdownOpen}
                      aria-controls="qa-year-filter-dropdown"
                      data-testid="qa-year-filter-toggle"
                    >
                      <span>More years</span>
                      <ChevronRight className={`w-3.5 h-3.5 text-slate-400 transition-transform duration-200 ${yearDropdownOpen ? "rotate-90" : ""}`} />
                    </button>
                    {yearDropdownOpen && (
                      <div
                        id="qa-year-filter-dropdown"
                        className="mt-1 border border-slate-200 rounded-md bg-white shadow-sm overflow-hidden"
                        data-testid="qa-year-filter-dropdown"
                      >
                        <div className="max-h-48 overflow-y-auto py-1">
                          {availableYears
                            .filter((y) => !PINNED_YEARS.includes(y))
                            .map((year) => (
                              <label
                                key={year}
                                className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-slate-50 transition-colors"
                                data-testid={`qa-year-filter-${year}`}
                              >
                                <Checkbox
                                  checked={selectedYears.includes(year)}
                                  onCheckedChange={() => toggleYear(year)}
                                />
                                <span className="text-sm text-slate-700">{year}</span>
                              </label>
                            ))}
                          {hasUnknownDateRulings && (
                            <label
                              className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-slate-50 transition-colors"
                              data-testid="qa-year-filter-unknown"
                            >
                              <Checkbox
                                checked={selectedYears.includes("Unknown")}
                                onCheckedChange={() => toggleYear("Unknown")}
                              />
                              <span className="text-sm text-slate-400 italic">Unknown date</span>
                            </label>
                          )}
                        </div>
                        {selectedYears.filter((y) => !PINNED_YEARS.includes(y)).length > 0 && (
                          <div className="border-t border-slate-100 px-3 py-1.5">
                            <button
                              type="button"
                              onClick={() =>
                                setSelectedYears((prev) => prev.filter((y) => PINNED_YEARS.includes(y)))
                              }
                              className="text-xs text-sky-600 hover:text-sky-800 transition-colors focus:outline-none"
                              data-testid="qa-year-filter-clear"
                            >
                              Clear other years
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </ScrollArea>
        </aside>
      )}

      {/* COL 2 — Ruling selection panel (ruling mode only) */}
      {mode === "ruling" && (
        <aside
          className="w-80 shrink-0 border-r border-slate-200 bg-white flex flex-col"
          data-testid="qa-ruling-panel"
        >
          <div className="p-4 border-b border-slate-200">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-sm font-semibold text-slate-900 font-heading">
                Select Rulings
              </h2>
              <span className="text-xs text-slate-400">Up to {MAX_RULINGS_SELECTION}</span>
            </div>
            <p className="text-xs text-slate-400 mb-3">
              Select one or more rulings to analyse together
            </p>
            <div className="relative">
              <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
              <Input
                type="text"
                placeholder="Search rulings..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 h-8 text-sm"
                data-testid="qa-ruling-search-input"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {hasActiveFilters && (
            <div className="px-4 pt-2 pb-1 flex flex-wrap gap-1.5 border-b border-slate-100">
              {selectedTherapyAreas.map((area) => (
                <Badge key={area} variant="secondary"
                  className="text-xs h-5 gap-1 pr-1 cursor-pointer"
                  onClick={() => toggleTherapyArea(area)}>
                  {area} <X className="w-2.5 h-2.5" />
                </Badge>
              ))}
              {selectedOutcomes.map((outcome) => (
                <Badge key={outcome} variant="secondary"
                  className="text-xs h-5 gap-1 pr-1 cursor-pointer"
                  onClick={() => toggleOutcome(outcome)}>
                  {outcome} <X className="w-2.5 h-2.5" />
                </Badge>
              ))}
              {selectedDossierCategories.map((cat) => (
                <Badge key={cat} variant="secondary"
                  className="text-xs h-5 gap-1 pr-1 cursor-pointer"
                  onClick={() => toggleDossierCategory(cat)}>
                  {cat} <X className="w-2.5 h-2.5" />
                </Badge>
              ))}
              {selectedYears.map((year) => (
                <Badge key={year} variant="secondary"
                  className="text-xs h-5 gap-1 pr-1 cursor-pointer"
                  onClick={() => toggleYear(year)}>
                  {year === "Unknown" ? "Unknown date" : year}
                  <X className="w-2.5 h-2.5" />
                </Badge>
              ))}
            </div>
          )}

          <div className="px-4 pt-2 pb-1 flex items-center justify-between">
            <p className="text-xs text-slate-500">
              <span className="font-semibold text-slate-700">{filteredRulings.length}</span>{" "}
              {hasActiveFilters ? "matching" : "total"} rulings
            </p>
            {filteredRulings.length > 0 && (
              <p className="text-xs text-slate-400">
                Showing{" "}
                <span className="font-medium text-slate-600">
                  {(rulingPage - 1) * RULINGS_PAGE_SIZE + 1}–
                  {Math.min(rulingPage * RULINGS_PAGE_SIZE, filteredRulings.length)}
                </span>
              </p>
            )}
          </div>

          <ScrollArea className="flex-1 p-4">
            {filteredRulings.length === 0 ? (
              <div className="text-center py-8" data-testid="qa-no-rulings">
                <FileText className="w-10 h-10 text-slate-300 mx-auto mb-3" />
                <p className="text-sm text-slate-500 font-medium">No rulings match</p>
                <p className="text-xs text-slate-400 mt-1">
                  Try adjusting your filters or search query
                </p>
                <Button variant="outline" size="sm" onClick={clearFilters} className="mt-3 text-xs">
                  Clear Filters
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                {paginatedRulings.map((ruling) => {
                  const sel   = selectedRulings.includes(ruling.id);
                  const atCap = selectedRulings.length >= MAX_RULINGS_SELECTION && !sel;
                  return (
                    <Card
                      key={ruling.id}
                      onClick={() => !atCap && toggleRuling(ruling.id)}
                      className={`transition-all ${
                        atCap
                          ? "opacity-50 cursor-not-allowed border-slate-200"
                          : "cursor-pointer"
                      } ${
                        sel
                          ? "border-sky-500 bg-sky-50 shadow-sm"
                          : "border-slate-200 hover:border-slate-300"
                      }`}
                      data-testid={`select-ruling-${ruling.id}`}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-start gap-3">
                          <div className={`mt-1 w-4 h-4 rounded border-2 shrink-0 flex items-center justify-center transition-all ${
                            sel ? "border-sky-500 bg-sky-500" : "border-slate-300 bg-white"
                          }`}>
                            {sel && (
                              <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 10 10">
                                <path
                                  d="M1.5 5l2.5 2.5 4.5-4.5"
                                  stroke="currentColor"
                                  strokeWidth="1.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className={`font-medium text-sm line-clamp-2 ${
                              sel ? "text-sky-900" : "text-slate-900"
                            }`}>
                              {ruling.title}
                            </p>
                            <div className="flex items-center gap-2 mt-2 flex-wrap">
                              <Badge variant="outline" className="text-xs">
                                {ruling.therapy_area}
                              </Badge>
                              <Badge variant="outline" className={`text-xs ${
                                ruling.decision_outcome === "Positive"   ? "badge-positive"
                                : ruling.decision_outcome === "Negative" ? "badge-negative"
                                : "badge-conditional"
                              }`}>
                                {ruling.decision_outcome}
                              </Badge>
                            </div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </ScrollArea>

          <RulingPaginationControls
            currentPage={rulingPage}
            totalPages={totalRulingPages}
            onPageChange={setRulingPage}
          />

          <div className="p-4 border-t border-slate-200 bg-slate-50">
            {selectedRulings.length > 0 ? (
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm text-slate-600">
                  <span className="font-semibold text-sky-700">{selectedRulings.length}</span>
                  {" "}ruling{selectedRulings.length !== 1 ? "s" : ""} selected
                  {selectedRulings.length >= MAX_RULINGS_SELECTION && (
                    <span className="ml-1 text-xs text-amber-600 font-medium">(max)</span>
                  )}
                </p>
                <Button
                  variant="ghost" size="sm"
                  onClick={() => setSelectedRulings([])}
                  className="text-xs text-slate-400 hover:text-slate-600 h-6 px-2"
                  data-testid="clear-ruling-btn"
                >
                  Clear all
                </Button>
              </div>
            ) : (
              <p className="text-sm text-slate-400 italic">No rulings selected</p>
            )}
          </div>
        </aside>
      )}

      {/* COL 3 — Main content area */}
      <div className="flex-1 flex flex-col min-w-0">

        <header className="page-header">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-sky-100 rounded-xl flex items-center justify-center">
                <BrainCircuit className="w-5 h-5 text-sky-600" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-slate-900 font-heading">
                  Q&amp;A Generator
                </h1>
                <p className="text-slate-500">
                  Predict questions ZIN may ask during your submission review
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <ModeToggle mode={mode} onChange={handleModeChange} />
              {mode === "ruling" && hasResults && (
                <Button variant="outline" onClick={exportAll} data-testid="export-all-btn">
                  <Download className="w-4 h-4 mr-2" /> Export PDF
                </Button>
              )}
              {mode === "database" && dbResults.length > 0 && (
                <Button variant="outline" onClick={exportDbAll} data-testid="export-db-btn">
                  <Download className="w-4 h-4 mr-2" /> Export PDF
                </Button>
              )}
            </div>
          </div>
        </header>

        <div className="flex-1 p-8 bg-slate-50 dot-pattern overflow-auto">

          {/* DATABASE SEARCH MODE */}
          {mode === "database" ? (
            <>
              <Card className="mb-6 border-slate-200" data-testid="db-search-card">
                <CardHeader className="pb-2">
                  <CardTitle className="text-lg font-semibold text-slate-900 font-heading flex items-center gap-2">
                    <Globe className="w-5 h-5 text-sky-600" />
                    Search Entire Ruling Database
                  </CardTitle>
                  <p className="text-sm text-slate-500 mt-1">
                    Ask any HTA question and Navigator will search across all available rulings
                    to find relevant precedents, recurring concerns, and evidence-based recommendations.
                  </p>
                </CardHeader>
                <CardContent className="pt-2">

                  <div className="grid grid-cols-2 gap-3 mb-4">
                    <div>
                      <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">
                        Dossier Type
                        <span className="ml-1 font-normal normal-case text-slate-400">(optional)</span>
                      </label>
                      <select
                        value={dbDossierType}
                        onChange={(e) => setDbDossierType(e.target.value)}
                        className="w-full h-9 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500 transition-colors"
                        data-testid="db-dossier-type-select"
                      >
                        <option value="">All dossier types</option>
                        <option value="FT">Full Dossier (FT)</option>
                        <option value="BIA">Budget Impact Analysis (BIA)</option>
                        <option value="FE">Pharmacoeconomic Evaluation (FE)</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">
                        Indication / Therapy Area
                        <span className="ml-1 font-normal normal-case text-slate-400">(optional)</span>
                      </label>
                      <Input
                        placeholder="e.g. Oncology, Type 2 Diabetes..."
                        value={dbIndication}
                        onChange={(e) => setDbIndication(e.target.value)}
                        className="h-9 text-sm"
                        data-testid="db-indication-input"
                      />
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2 mb-4">
                    {DB_EXAMPLE_PROMPTS.map((example) => (
                      <button
                        key={example}
                        onClick={() => setDbQuery(example)}
                        className="text-xs px-3 py-1.5 rounded-full bg-white border border-slate-200 text-slate-600 hover:bg-sky-50 hover:border-sky-300 hover:text-sky-700 transition-colors"
                      >
                        {example}
                      </button>
                    ))}
                  </div>

                  <Textarea
                    placeholder={`e.g. "What concerns has ZIN historically raised regarding utilities in similar submissions?"`}
                    value={dbQuery}
                    onChange={(e) => setDbQuery(e.target.value)}
                    rows={3}
                    className="resize-none mb-4"
                    data-testid="db-search-textarea"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && e.ctrlKey) generateFromDatabase();
                    }}
                  />

                  <Textarea
                    placeholder="Additional context about your dossier or indication (optional)..."
                    value={dbContext}
                    onChange={(e) => setDbContext(e.target.value)}
                    rows={2}
                    className="resize-none mb-4 text-sm"
                    data-testid="db-context-textarea"
                  />

                  <div className="flex items-center justify-between">
                    <p className="text-xs text-slate-500">
                      Navigator searches all rulings and synthesises evidence-based insights
                      · Ctrl+Enter to search
                    </p>
                    <Button
                      onClick={generateFromDatabase}
                      disabled={dbGenerating || !dbQuery.trim()}
                      className="bg-sky-600 hover:bg-sky-700 min-w-[200px] justify-center"
                      data-testid="db-search-btn"
                    >
                      {dbGenerating ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin shrink-0" />
                          <span>{dbThinkingMessage}</span>
                        </>
                      ) : (
                        <>
                          <SearchIcon className="w-4 h-4 mr-2" />
                          Search Database
                        </>
                      )}
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {dbGenerating ? (
                <div
                  className="flex flex-col items-center justify-center py-20 bg-white rounded-xl border border-slate-200"
                  data-testid="db-generating-state"
                >
                  <div className="relative mb-6">
                    <Globe className="w-14 h-14 text-sky-300" />
                    <Loader2 className="w-6 h-6 text-sky-600 animate-spin absolute -bottom-1 -right-1" />
                  </div>
                  <h3 className="text-lg font-semibold text-slate-800 mb-1">
                    {dbThinkingMessage}
                  </h3>
                  <p className="text-sm text-slate-400 max-w-sm text-center">
                    Searching across all available ZIN rulings to find relevant precedents
                    and generate evidence-based insights.
                  </p>
                  <div className="flex gap-1.5 mt-5">
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className="w-2 h-2 rounded-full bg-sky-400 animate-bounce"
                        style={{ animationDelay: `${i * 0.15}s` }}
                      />
                    ))}
                  </div>
                </div>

              ) : dbSearched && dbResults.length === 0 ? (
                <div
                  className="empty-state bg-white rounded-xl border border-slate-200"
                  data-testid="db-empty-results"
                >
                  <SearchIcon className="empty-state-icon" />
                  <h3 className="empty-state-title">
                    {dbMeta?.off_topic ? "Query Not HTA-Related" : "No Results Found"}
                  </h3>
                  <p className="empty-state-description">
                    {dbMeta?.off_topic
                      ? (dbMeta.message ||
                        "Your query does not appear to be related to HTA or ZIN ruling topics. " +
                        "Please ask about clinical evidence, cost-effectiveness, budget impact, " +
                        "reimbursement, or ZIN assessment methodology.")
                      : "Try rephrasing your question or using different terminology. " +
                        "You can also try one of the example prompts above."
                    }
                  </p>
                </div>

              ) : dbResults.length > 0 ? (
                <div data-testid="db-results">
                  <div className="flex items-center justify-between gap-2 mb-5">
                    <div className="flex items-center gap-2">
                      <TrendingUp className="w-4 h-4 text-sky-600" />
                      <h3 className="text-base font-semibold text-slate-900 font-heading">
                        {dbResults.length} insight{dbResults.length !== 1 ? "s" : ""} found
                        across the ruling database
                      </h3>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                      {dbMeta?.rulings_searched != null && (
                        <span className="text-xs text-slate-500 bg-slate-100 px-2.5 py-1 rounded-full border border-slate-200">
                          Searched{" "}
                          <strong className="text-slate-700">{dbMeta.rulings_searched}</strong>{" "}
                          ruling{dbMeta.rulings_searched !== 1 ? "s" : ""}
                        </span>
                      )}
                      {dbMeta?.rulings_matched != null && (
                        <span className="text-xs text-sky-700 bg-sky-50 px-2.5 py-1 rounded-full border border-sky-200">
                          <strong>{dbMeta.rulings_matched}</strong> matched
                        </span>
                      )}
                      {dbDossierType && (
                        <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-purple-50 text-purple-700 border border-purple-200">
                          {dbDossierType}
                        </span>
                      )}
                      {dbIndication && (
                        <span className="flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full bg-teal-50 text-teal-700 border border-teal-200">
                          <Stethoscope className="w-3 h-3 shrink-0" />
                          {dbIndication}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* ── CHANGED: pass dbQuery, dbDossierType, dbIndication into each card ── */}
                  <div className="space-y-4">
                    {dbResults.map((item, i) => (
                      <DbResultCard
                        key={i}
                        item={item}
                        num={i + 1}
                        onCopy={copyQ}
                        dbQuery={dbQuery}
                        dbDossierType={dbDossierType}
                        dbIndication={dbIndication}
                      />
                    ))}
                  </div>
                </div>

              ) : (
                <div
                  className="empty-state bg-white rounded-xl border border-slate-200"
                  data-testid="db-initial-state"
                >
                  <Globe className="empty-state-icon" />
                  <h3 className="empty-state-title">Ask Anything About ZIN Rulings</h3>
                  <p className="empty-state-description">
                    Enter a question above to search across all available rulings.
                    Navigator will identify relevant precedents and generate
                    evidence-based insights and recommendations.
                  </p>
                </div>
              )}
            </>

          ) : (
            /* RULING-BASED MODE */
            <>
              <Card className="mb-6 border-slate-200" data-testid="context-input-card">
                <CardHeader className="pb-4">
                  <CardTitle className="text-lg font-semibold text-slate-900 font-heading">
                    Additional Context (Optional)
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <SelectedRulingStrip
                    selectedRulings={selectedRulings}
                    rulings={rulings}
                    onRemove={toggleRuling}
                  />
                  <Textarea
                    placeholder="Describe your drug, indication, or specific concerns you want addressed..."
                    value={context}
                    onChange={(e) => setContext(e.target.value)}
                    rows={3}
                    className="resize-none"
                    data-testid="context-textarea"
                  />
                  <div className="flex items-center justify-between mt-4">
                    <p className="text-xs text-slate-500">
                      {selectedRulings.length > 1
                        ? `The AI will synthesise across ${selectedRulings.length} rulings to identify common themes and generate questions`
                        : "The AI will use the selected ruling and your context to generate relevant questions"
                      }
                    </p>
                    <Button
                      onClick={generate}
                      disabled={generating || selectedRulings.length === 0}
                      className="bg-sky-600 hover:bg-sky-700 min-w-[240px] justify-center"
                      data-testid="generate-qa-btn"
                    >
                      {generating ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin shrink-0" />
                          <span>{thinkingMessage}</span>
                        </>
                      ) : (
                        <>
                          <Sparkles className="w-4 h-4 mr-2" />
                          {selectedRulings.length > 1
                            ? `Generate from ${selectedRulings.length} Rulings`
                            : "Generate Questions"
                          }
                        </>
                      )}
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {generating ? (
                <div
                  className="flex flex-col items-center justify-center py-20 bg-white rounded-xl border border-slate-200"
                  data-testid="qa-generating-state"
                >
                  <div className="relative mb-6">
                    <BrainCircuit className="w-14 h-14 text-sky-300" />
                    <Loader2 className="w-6 h-6 text-sky-600 animate-spin absolute -bottom-1 -right-1" />
                  </div>
                  <h3 className="text-lg font-semibold text-slate-800 mb-1">
                    {thinkingMessage}
                  </h3>
                  <p className="text-sm text-slate-400 max-w-xs text-center">
                    {selectedRulings.length > 1
                      ? `Synthesising ${selectedRulings.length} rulings and identifying recurring ZIN concerns across assessments.`
                      : "Analysing the selected ruling and generating predicted ZIN questions for each dossier type."
                    }
                  </p>
                  <div className="flex gap-1.5 mt-5">
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className="w-2 h-2 rounded-full bg-sky-400 animate-bounce"
                        style={{ animationDelay: `${i * 0.15}s` }}
                      />
                    ))}
                  </div>
                </div>

              ) : !hasResults ? (
                <div
                  className="empty-state bg-white rounded-xl border border-slate-200"
                  data-testid="qa-empty-state"
                >
                  <BrainCircuit className="empty-state-icon" />
                  <h3 className="empty-state-title">No Questions Generated Yet</h3>
                  <p className="empty-state-description">
                    Select one or more rulings from the panel and click
                    &quot;Generate Questions&quot; to predict what ZIN may ask
                    during your submission review.
                  </p>
                </div>

              ) : (
                <div data-testid="qa-results">
                  <div className="flex items-center justify-between gap-2 mb-3">
                    <div className="flex items-center gap-2">
                      <Lightbulb className="w-4 h-4 text-sky-600" />
                      <h3 className="text-base font-semibold text-slate-900 font-heading">
                        Predicted Questions ({totalQCount}) across {dossiers.length}{" "}
                        {dossiers.length === 1 ? "dossier" : "dossiers"}
                        {selectedRulings.length > 1 && (
                          <span className="ml-2 text-sm font-normal text-slate-500">
                            · synthesised from {selectedRulings.length} rulings
                          </span>
                        )}
                      </h3>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setChatOpen((prev) => !prev)}
                      className={`gap-2 ${
                        chatOpen ? "border-sky-400 text-sky-700 bg-sky-50" : ""
                      }`}
                      data-testid="toggle-chat-btn"
                    >
                      {chatOpen ? (
                        <><PanelRightClose className="w-4 h-4" /> Close Chat</>
                      ) : (
                        <><PanelRightOpen  className="w-4 h-4" /> Chat with Rulings</>
                      )}
                    </Button>
                  </div>

                  {selectedRulings.length > 1 && (
                    <div className="flex flex-wrap gap-2 mb-5 p-3 bg-white rounded-lg border border-slate-200">
                      <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide w-full mb-1">
                        Reference Rulings
                      </span>
                      {selectedRulingTitles.map((title, i) => (
                        <span
                          key={i}
                          className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-slate-100 text-slate-700 border border-slate-200"
                        >
                          <FileText className="w-3 h-3 shrink-0 text-slate-400" />
                          {title}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="space-y-6">
                    {dossiers.map((dossier, di) => {
                      const offset = dossiers
                        .slice(0, di)
                        .reduce((s, d) => s + (d.predicted_questions?.length || 0), 0);
                      return (
                        <DossierBlock
                          key={dossier.dossier_code ?? di}
                          dossier={dossier}
                          offset={offset}
                          onCopy={copyQ}
                          therapyAreas={selectedRulingTherapyAreas}
                          rulingIds={selectedRulings}
                        />
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}

        </div>
      </div>

      {/* COL 4 — Chat panel (ruling mode, results present, chat open) */}
      {mode === "ruling" && chatOpen && hasResults && (
        <ChatPanel
          selectedRulings={selectedRulings}
          rulingTitles={selectedRulingTitles}
          onClose={() => setChatOpen(false)}
        />
      )}

    </div>
  );
}