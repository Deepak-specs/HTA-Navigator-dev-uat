/**
 * QAGenerator.jsx — v2.4  (redesign_7)
 * ─────────────────────────────────────────────────────────────────────────────
 * Predict the questions an assessment committee is likely to ask, and draft
 * answers grounded in the rulings the user already searched.
 *
 * The defining change (Sr 66/68): this page CONTINUES the search rather than
 * restarting it. The previous version rebuilt its own ruling picker — a second
 * search box, four filter groups, pagination — plus a mode toggle between
 * "ruling" and "database" generation, and a chat panel calling an endpoint that
 * did not exist. All of that is gone; the question, the selected rulings and the
 * dossier-review context arrive from Ruling Search.
 *
 * Change set:
 *   Sr 63  chat panel removed (called /api/qa/chat, which never existed)
 *   Sr 64  mode toggle + database branch removed
 *   Sr 65  db* state removed
 *   Sr 66  internal ruling picker removed
 *   Sr 67  redundant corpus fetches removed
 *   Sr 68  "Carried over from your ruling search" header
 *   Sr 69  Dossier Review context panel
 *   Sr 70  optional additional-context upload
 *   Sr 71  group by dossier category / priority / status
 *   Sr 72  completeness meter
 *   Sr 73  per-question card with status, citations, word count
 *   Sr 74  feedback posting to the real endpoint
 *   Sr 75  session-context sidebar
 *   Sr 76  question-themes panel
 *   Sr 77  re-saving updates the question instead of creating a new one
 *   Sr 78  all selected ruling ids + explicit dossier categories sent
 *   Sr 79  v2 port; PDF export preserved in lib/qaPdf.js
 *   Sr 80  "Grounded in" row under each answer: the rulings and documents
 *          the answer rests on, clickable, with ZIN rulings separated from
 *          the user's own material and an explicit note when neither backs it
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import axios from "axios";
import { toast } from "sonner";
import { useSession } from "../lib/SessionContext";
import UploadCloudIcon from "../components/UploadCloudIcon";
import {
  addQuestionToSession, addQAToQuestion, updateQuestion,
  updateQAAnswer, updateQAStatus, setActiveSessionId,
} from "../lib/sessionStore";
import {
  categoryLabel, categoryCode, categoryFromCode, resolveCategory,
} from "../lib/dossierCategories";
import { getMeta, getMetaForCategory } from "../lib/qaMeta";
import { exportToPdf } from "../lib/qaPdf";
import DownloadCloudIcon from "../components/DownloadCloudIcon";
import { Trash2 } from "lucide-react";

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;

const STATUSES = [
  { value: "draft",          label: "Draft" },
  { value: "needs_evidence", label: "Needs evidence" },
  { value: "ready",          label: "Ready" },
];

const NEGATIVE_ISSUES = [
  "This is harmful / unsafe",
  "This isn't true",
  "This isn't helpful",
  "Question is irrelevant",
  "Response is incomplete",
];

const GROUP_BY = [
  { value: "dossier",  label: "Group by: dossier category" },
  { value: "priority", label: "Group by: priority" },
  { value: "status",   label: "Group by: status" },
];

const wordCount = (t) => (String(t || "").trim().match(/\S+/g) || []).length;

// Source labels for the PDF export, matching what RulingLink shows on screen:
// the user's own dossier is named as theirs, never as a ruling.
const sourceLabels = (item) => {
  const rows = item.sourceRulings || [];
  if (rows.length === 0) return item.citations || [];
  return rows.map((r) => {
    const base = [r.title, r.year].filter(Boolean).join(" ");
    return r.isDossier ? `Your dossier: ${base}` : base;
  });
};

// ─── Cycling thinking messages ────────────────────────────────────────────────
// Generation fans out to three parallel LLM calls and routinely takes 30-60s. A
// button that only reads "Generating…" for a minute looks hung, so the wait is
// narrated the way the original POC did it.
const THINKING_MESSAGES = [
  "Thinking...",
  "Analysing ruling patterns...",
  "Predicting ZIN questions...",
  "Reviewing dossier context...",
  "Formulating suggested responses...",
  "Almost there...",
];

function useThinkingMessage(active) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!active) { setIndex(0); return undefined; }
    const id = setInterval(() => {
      setIndex((prev) => (prev + 1) % THINKING_MESSAGES.length);
    }, 2000);
    return () => clearInterval(id);
  }, [active]);
  return THINKING_MESSAGES[index];
}

function priorityTag(importance) {
  const v = (importance || "").toLowerCase();
  if (v === "high")   return <span className="v2-tag v2-t-neg">▲ High priority</span>;
  if (v === "medium") return <span className="v2-tag v2-t-cond">■ Medium priority</span>;
  return <span className="v2-tag" style={{ background: "#F3F1F7", color: "var(--muted)" }}>Low priority</span>;
}

function statusTag(status) {
  if (status === "ready")          return <span className="v2-tag v2-t-pos">✓ Ready</span>;
  if (status === "needs_evidence") return <span className="v2-tag v2-t-cond">◑ Needs evidence</span>;
  return <span className="v2-chip">Draft</span>;
}

// ─── Sr 74 — feedback ─────────────────────────────────────────────────────────
// Posts to /api/feedback/qa, which exists as of Sr 29. The old version posted to
// a route that did not exist and swallowed the 404, so nothing was ever captured.
function FeedbackPanel({ meta }) {
  const [type, setType]       = useState(null);
  const [issues, setIssues]   = useState([]);
  const [comment, setComment] = useState("");
  const [sent, setSent]       = useState(false);
  const [busy, setBusy]       = useState(false);

  const send = useCallback(async (feedbackType, extra = {}) => {
    setBusy(true);
    try {
      await axios.post(`${API}/feedback/qa`, {
        ...meta, feedbackType, timestamp: new Date().toISOString(), ...extra,
      });
      setSent(true);
      toast.success("Thanks — this has been added to the evaluation set.");
    } catch {
      toast.error("Feedback could not be sent.");
    } finally {
      setBusy(false);
    }
  }, [meta]);

  if (sent) {
    return <span style={{ fontSize: 11.5, color: "var(--pos)" }}>✓ Feedback recorded</span>;
  }

  if (type === "negative") {
    return (
      <div style={{ width: "100%", marginTop: 9, padding: 11, border: "1px solid var(--line)", borderRadius: 8, background: "#fff" }}>
        <div style={{ fontSize: 11.5, fontWeight: 700, marginBottom: 7 }}>What was wrong?</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          {NEGATIVE_ISSUES.map((i) => (
            <button
              key={i}
              type="button"
              className="v2-chip x"
              onClick={() => setIssues((p) => p.includes(i) ? p.filter((x) => x !== i) : [...p, i])}
              style={issues.includes(i) ? { background: "var(--neg-bg)", borderColor: "#E6B8B8", color: "var(--neg)", fontWeight: 600 } : undefined}
            >
              {issues.includes(i) ? "✓ " : ""}{i}
            </button>
          ))}
        </div>
        <textarea
          placeholder="Anything else? (optional)"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          style={{ minHeight: 54 }}
        />
        <div style={{ display: "flex", gap: 7, marginTop: 8, justifyContent: "flex-end" }}>
          <button className="v2-btn v2-ghost v2-sm" type="button" onClick={() => setType(null)}>Cancel</button>
          <button className="v2-btn v2-sm" type="button" disabled={busy} onClick={() => send("negative", { issues, comment })}>
            {busy ? "Sending…" : "Send feedback"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", gap: 6 }}>
      <button className="v2-btn v2-ghost v2-sm" type="button" disabled={busy} onClick={() => send("positive")}>Useful</button>
      <button className="v2-btn v2-ghost v2-sm" type="button" onClick={() => setType("negative")}>Not useful</button>
    </div>
  );
}

// ─── Link to the original ruling PDF ──────────────────────────────────────────
// The PDF link is resolved on click through GET /api/rulings/{id}, which returns
// a file_url built from the current SAS token. Links are therefore never stored
// with a session, so a saved question cannot end up holding an expired link.
const rulingUrlCache = new Map();

function RulingLink({ ruling }) {
  const [busy, setBusy] = useState(false);
  const label = [ruling.title, ruling.year].filter(Boolean).join(" · ");

  const chipStyle = { maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

  // The submitter's own dossier is a legitimate source but is NOT a published
  // ZIN ruling. Labelling it "Ruling:" would present their own figures as
  // corpus evidence — which is exactly the misattribution this replaces.
  if (ruling.isDossier) {
    return <span className="v2-chip cite" title={label} style={chipStyle}>Your dossier: {label}</span>;
  }

  // Questions saved before rulings were linked carry a title only.
  if (!ruling.id) {
    return <span className="v2-chip cite" title={label} style={chipStyle}>Ruling: {label}</span>;
  }

  const open = async (e) => {
    e.preventDefault();
    if (busy) return;
    const cached = rulingUrlCache.get(ruling.id);
    if (cached) { window.open(cached, "_blank", "noopener"); return; }

    // Open the tab inside the click handler so pop-up blockers allow it, then
    // point it at the PDF once the link is known.
    const tab = window.open("", "_blank");
    setBusy(true);
    try {
      const { data } = await axios.get(`${API}/rulings/${encodeURIComponent(ruling.id)}`);
      if (!data?.file_url) throw new Error("no file_url");
      rulingUrlCache.set(ruling.id, data.file_url);
      if (tab) { tab.opener = null; tab.location.href = data.file_url; }
      else window.open(data.file_url, "_blank", "noopener");
    } catch {
      if (tab) tab.close();
      toast.error("The original document is not available for this ruling.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <a
      href="#"
      onClick={open}
      className="v2-chip cite"
      title={`Open the original ruling: ${label}`}
      style={{ ...chipStyle, textDecoration: "underline", cursor: busy ? "progress" : "pointer" }}
      data-testid={`qa-ruling-link-${ruling.id}`}
    >
      {busy ? "Opening…" : <>Ruling: {label} ↗</>}
    </a>
  );
}

// ─── Sr 73 — one generated question ───────────────────────────────────────────
function QuestionCard({ item, index, onAnswerChange, onStatusChange }) {
  const [draft, setDraft] = useState(item.answer || "");
  const [dirty, setDirty] = useState(false);

  useEffect(() => { setDraft(item.answer || ""); setDirty(false); }, [item.id, item.answer]);

  const commit = useCallback(() => {
    if (!dirty) return;
    onAnswerChange(item.id, draft);
    setDirty(false);
  }, [dirty, draft, item.id, onAnswerChange]);

  const isReady = item.status === "ready";

  // Sr 79 — dossier colour, the same hues the PDF export uses.
  const dossierMeta = getMetaForCategory(item.dossierCategory, item.dossierCode);

  // Sr 80 — "Grounded in": the sources this answer rests on, shown under the
  // answer and labelled, rather than as unlabelled chips in the tag row where
  // they read as two more tags. Published ZIN rulings are listed first and the
  // submitter's own documents after, so corpus evidence is never presented
  // interleaved with the user's own material. Questions saved before rulings
  // were linked carry only `citations`, so fall back to those.
  const sources = useMemo(() => {
    const rows = item.sourceRulings?.length
      ? item.sourceRulings
      : (item.citations || []).map((c) => ({ id: null, title: c, year: null }));
    return [...rows.filter((r) => !r.isDossier), ...rows.filter((r) => r.isDossier)];
  }, [item.sourceRulings, item.citations]);

  const rulingCount = sources.filter((r) => !r.isDossier).length;

  return (
    <div className="v2-qa" data-testid={`qa-item-${item.id}`}>
      <div className="q">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8, alignItems: "center" }}>
          {priorityTag(item.priority)}
          {item.dossierCategory && (
            <span
              className="v2-chip"
              style={{
                background:  dossierMeta.hexLight,
                color:       dossierMeta.hexInk,
                borderColor: dossierMeta.hexBorder,
                fontWeight:  600,
              }}
            >
              Dossier: {categoryLabel(item.dossierCategory)}
            </span>
          )}
          {item.theme && <span className="v2-chip">Theme: {item.theme}</span>}
          {item.seenIn > 0 && item.rulingsConsidered > 0 && (
            <span className="v2-chip">Seen in {item.seenIn} of {item.rulingsConsidered} rulings</span>
          )}
          <span style={{ marginLeft: "auto" }}>{statusTag(item.status)}</span>
        </div>
        <p>Q{index + 1}. {item.question}</p>
      </div>

      <div className="a">
        <div className="lbl">
          <span>{isReady ? "Draft response" : "Draft response · edit freely"}</span>
          <span>
            {wordCount(draft)} words
            {item.savedAt && ` · saved ${new Date(item.savedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`}
          </span>
        </div>

        {isReady ? (
          <div style={{ fontSize: 12.5, lineHeight: 1.6, color: "var(--ink-2)", background: "#fff", border: "1px solid var(--line)", borderRadius: 8, padding: 11 }}>
            {draft || <span style={{ color: "var(--muted)" }}>No answer drafted.</span>}
          </div>
        ) : (
          <textarea
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setDirty(true); }}
            onBlur={commit}
            placeholder="Draft your response…"
          />
        )}

        <div
          style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 10, alignItems: "center" }}
          data-testid={`qa-grounded-${item.id}`}
        >
          <span
            style={{
              fontSize: 11, fontWeight: 800, color: "var(--muted)",
              textTransform: "uppercase", letterSpacing: ".07em",
            }}
          >
            Grounded in
          </span>
          {sources.length > 0 ? (
            sources.map((r) => <RulingLink key={r.id || r.title} ruling={r} />)
          ) : (
            <span
              className="v2-chip"
              title="Nothing in the selected rulings or your attached documents was cited for this question, so the answer is Navigator interpretation rather than ZIN evidence. Verify it before relying on it."
              style={{ background: "#FDECEA", color: "#8C1D18", borderColor: "#F2B8B5" }}
              data-testid={`qa-ungrounded-${item.id}`}
            >
              No source cited — Navigator interpretation
            </span>
          )}
          {/* Sources, but no published ruling among them: the answer rests on
              the user's own submission, which is context rather than precedent.
              Saying so is the distinction the evidence requirement asks for —
              otherwise a dossier chip reads exactly like a ruling chip. */}
          {sources.length > 0 && rulingCount === 0 && (
            <span
              className="v2-chip"
              title="This answer draws only on your own document. It is not supported by a published ZIN ruling."
              style={{ background: "var(--cond-bg, #FDF3E2)", color: "#8A5A00", borderColor: "#EBD3A6" }}
              data-testid={`qa-no-ruling-${item.id}`}
            >
              No ZIN ruling cited
            </span>
          )}
          <div style={{ marginLeft: "auto", display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap" }}>
            <select
              className="v2-sel"
              value={item.status || "draft"}
              onChange={(e) => onStatusChange(item.id, e.target.value)}
              data-testid={`qa-status-${item.id}`}
            >
              {STATUSES.map((s) => <option key={s.value} value={s.value}>Status: {s.label}</option>)}
            </select>
            {!isReady ? (
              <button className="v2-btn v2-sm" type="button" onClick={() => { commit(); onStatusChange(item.id, "ready"); }}>
                Mark ready
              </button>
            ) : (
              <button className="v2-btn v2-ghost v2-sm" type="button" onClick={() => onStatusChange(item.id, "draft")}>
                Reopen for editing
              </button>
            )}
          </div>
        </div>

        <div style={{ marginTop: 9, display: "flex", justifyContent: "flex-end" }}>
          <FeedbackPanel
            meta={{
              question: item.question, answer: draft,
              theme: item.theme, importance: item.priority,
              dossierCode: item.dossierCode, rulingIds: item.rulingIds || [],
              mode: "ruling",
            }}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function QAGenerator() {
  const navigate = useNavigate();
  const location = useLocation();
  const disableGeneration = location.state?.disableGeneration === true;
  const lockedFromReadiness = disableGeneration;
  const {
    activeSession, refreshSessions, dossierReview, requestNewSession,
  } = useSession();

  // Sr 68 — context carried over from Ruling Search, via route state.
  const handoff = location.state?.from === "search" || location.state?.from === "sessions" || location.state?.from === "readiness" ? location.state : null;

  const [questionId, setQuestionId] = useState(handoff?.questionId ?? null);
  const [context,    setContext]    = useState("");
  const [items,      setItems]      = useState([]);
  const [generating, setGenerating] = useState(false);
  const [groupBy,    setGroupBy]    = useState("dossier");
  const [uploadName, setUploadName] = useState("");
  // The upload used to set uploadName and stop there, so the tick said the
  // file was attached while it never left the browser and was never seen by
  // the model. These carry it through to the backend as [D2].
  const [uploadId,     setUploadId]     = useState(null);
  const [uploading,    setUploading]    = useState(false);
  const [uploadError,  setUploadError]  = useState("");
  const [genMeta,    setGenMeta]    = useState(null);
  const fileRef = useRef(null);

  const thinkingMessage = useThinkingMessage(generating);

  // The question this page is working on: the one handed over, else the
  // session's most recent.
  const question = useMemo(() => {
  const qs = activeSession?.questions || [];

  if (questionId) {
    return qs.find((q) => q.id === questionId) || null;
  }

  return qs.length ? qs[qs.length - 1] : null;
  }, [activeSession, questionId]);

  useEffect(() => {
    if (!questionId && question?.id) setQuestionId(question.id);
  }, [question, questionId]);

  // Load any Q&A already stored against this question, so returning to the page
  // shows the work rather than an empty generator.
  useEffect(() => {
    if (!question) { setItems([]); return; }
    setItems((question.generatedQA || []).map((a) => ({
      id: a.id, question: a.question, answer: a.answer,
      status: a.status || "draft", priority: a.priority, theme: a.theme,
      dossierCategory: a.dossierCategory || categoryFromCode(a.dossierCode),
      dossierCode: a.dossierCode, dossierName: a.dossierName || "",
      citations: a.citations || [], seenIn: a.seenIn, rulingsConsidered: a.rulingsConsidered,
      sourceRulings: a.sourceRulings || [],
      rulingIds: question.rulingIds || [], savedAt: a.savedAt,
    })));
  }, [question]);

  const searchQuery = handoff?.query || question?.query || "";
  const rulingIds   = handoff?.rulingIds || question?.rulingIds || [];
  const review      = handoff?.dossierReview || question?.dossierReview || dossierReview;

  // ── Sr 78 — generate across every selected ruling, with an explicit category
  const generate = useCallback(async () => {
    if (rulingIds.length === 0) {
      toast.warning("Select rulings in Ruling Search first.");
      return;
    }
    setGenerating(true);
    try {
      // The review category the user chose in Ruling Search decides which
      // dossier types to generate. A custom name they invented resolves too, so
      // "Cost-Effective Dossier" generates the pharmacoeconomic dossier instead
      // of silently falling through to all three.
      const resolved = resolveCategory(review?.category);
      const categories = resolved.code ? [resolved.code] : [];

      const { data } = await axios.post(`${API}/qa/generate`, {
        ruling_ids: rulingIds,
        context,
        dossier_categories: categories,
        dossier_review_upload_id: review?.uploadId || null,
        context_upload_id: uploadId || null,
      });

      // When exactly one dossier was asked for under a name the user invented,
      // every question that comes back belongs to that name — file them under it
      // rather than relabelling them with our own vocabulary.
      const customLabel =
        resolved.isCustom && resolved.code && (data.dossiers || []).length === 1
          ? resolved.value
          : "";

      const flat = [];
      (data.dossiers || []).forEach((d) => {
        (d.predicted_questions || []).forEach((q) => {
          flat.push({
            id: crypto.randomUUID(),
            question: q.question || "",
            answer:   q.suggested_response || "",
            status:   "draft",
            priority: q.importance || "medium",
            theme:    q.theme || "",
            // generate_qa groups by dossier and does not repeat the category on
            // each question, so inherit it from the user's own category when
            // there is one, else from the block the question came in.
            dossierCategory:
              q.dossier_category || customLabel || categoryFromCode(d.dossier_code),
            dossierCode:     d.dossier_code,
            dossierName:     d.dossier_name || "",
            citations: (q.source_rulings || [])
              .map((s) => [s.title, s.section ? `§${s.section}` : null, s.year].filter(Boolean).join(" "))
              .filter(Boolean),
            // The ruling(s) this question was generated from, shown beside the
            // dossier category on the card.
            sourceRulings: (q.source_rulings || [])
              .filter((s) => s && s.title)
              .map((s) => ({
                id: s.ruling_id || null, title: s.title, year: s.year || null,
                isDossier: Boolean(s.is_dossier),
              })),
            seenIn: q.seen_in_count ?? q.frequency ?? 0,
            rulingsConsidered: data.meta?.rulings_used ?? rulingIds.length,
            rulingIds,
          });
        });
      });

      setItems(flat);
      setGenMeta(data.meta || null);

      if (data.meta?.missing_ruling_ids?.length) {
        toast.warning(`${data.meta.missing_ruling_ids.length} selected ruling(s) could not be read and were skipped.`);
      }
      // The page claims a dossier informed the questions; say so only when the
      // backend confirms it actually read one.
      if (review?.uploadId && data.meta && !data.meta.used_dossier_review) {
        toast.warning("The attached dossier could not be read, so it did not inform these questions.");
      }
      // Same guard for the document attached on this page.
      if (uploadId && data.meta && !data.meta.used_context_upload) {
        toast.warning("The attached document could not be read, so it did not inform these questions.");
      }

      // Confirm what was read, not only what failed. Attaching a document and
      // seeing no mention of it in the output is indistinguishable from the
      // upload being ignored, which is exactly the confusion this removes.
      (data.meta?.attachments || []).forEach((a) => {
        toast.success(
          `Read ${a.name}${a.pages ? ` — ${a.pages} page${a.pages !== 1 ? "s" : ""}` : ""}` +
          `, ${a.chars.toLocaleString()} characters.`
        );
      });

      // Read, but nothing drew on it. A normal outcome when the document does
      // not bear on these questions — and worth saying, because it is a signal
      // about relevance rather than a failure.
      const uncited = (data.meta?.refs_uncited || []).filter((r) => r.startsWith("D"));
      if (uncited.length) {
        const names = uncited
          .map((r) => (data.meta.attachments || []).find((a) => a.ref === r)?.name || r)
          .join(", ");
        toast.warning(
          `${names} was read but no question drew on it — it may not relate to these rulings.`
        );
      }

      toast.success(`${flat.length} question${flat.length !== 1 ? "s" : ""} generated from ${data.meta?.rulings_used ?? rulingIds.length} ruling(s).`);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Generation failed.");
    } finally {
      setGenerating(false);
    }
    // uploadId belongs here: without it the callback closes over the value from
    // the render before the upload resolved, and generate would send null for a
    // document the user can see is attached.
  }, [rulingIds, context, review, uploadId]);

  // ── Sr 77 — persist: update the question, never create a duplicate ─────────
  const persist = useCallback((next) => {
    if (!activeSession || !question) return;
    addQAToQuestion(activeSession.id, question.id, next.map((a) => ({
      id: a.id, question: a.question, answer: a.answer, status: a.status,
      priority: a.priority, theme: a.theme, citations: a.citations,
      wordCount: wordCount(a.answer),
      dossierCategory: a.dossierCategory, dossierCode: a.dossierCode,
      dossierName: a.dossierName,
      seenIn: a.seenIn, rulingsConsidered: a.rulingsConsidered,
      sourceRulings: a.sourceRulings || [],
    })));
    updateQuestion(activeSession.id, question.id, {
      dossierReview: review?.uploadId
        ? { uploadId: review.uploadId, fileName: review.fileName, category: review.category }
        : question.dossierReview || null,
    });
    refreshSessions();
  }, [activeSession, question, review, refreshSessions]);

  const handleAnswerChange = useCallback((id, answer) => {
    setItems((prev) => {
      const next = prev.map((a) => a.id === id ? { ...a, answer, savedAt: new Date().toISOString() } : a);
      if (activeSession && question) updateQAAnswer(activeSession.id, question.id, id, answer);
      persist(next);
      return next;
    });
  }, [activeSession, question, persist]);

  const handleStatusChange = useCallback((id, status) => {
    setItems((prev) => {
      const next = prev.map((a) => a.id === id ? { ...a, status } : a);
      if (activeSession && question) updateQAStatus(activeSession.id, question.id, id, status);
      persist(next);
      return next;
    });
  }, [activeSession, question, persist]);

  const saveAll = useCallback(() => {
    if (!activeSession) {
      requestNewSession({});
      return;
    }
    if (!question) {
      const q = addQuestionToSession(activeSession.id, {
        query: searchQuery || "Generated question set",
        rulingIds,
        dossierReview: review?.uploadId ? review : null,
      });
      setQuestionId(q?.id ?? null);
      refreshSessions();
      toast.success("Saved to session.");
      return;
    }
    persist(items);
    toast.success(`Saved ${items.length} question${items.length !== 1 ? "s" : ""} to ${activeSession.drugName}.`);
  }, [activeSession, question, items, persist, rulingIds, searchQuery, review, refreshSessions, requestNewSession]);

  // ── Sr 72 — completeness ──────────────────────────────────────────────────
  const readyCount = items.filter((a) => a.status === "ready").length;
  const needsCount = items.filter((a) => a.status === "needs_evidence").length;
  const pct = items.length ? Math.round((readyCount / items.length) * 100) : 0;

  // ── Sr 71 — grouping ──────────────────────────────────────────────────────
  const groups = useMemo(() => {
    const key = (a) => {
      if (groupBy === "priority") return (a.priority || "medium").toLowerCase();
      if (groupBy === "status")   return a.status || "draft";
      // Prefer the mapped category label; a dossier the mapping does not know
      // still names itself, which beats lumping it under "Uncategorised".
      if (a.dossierCategory) return categoryLabel(a.dossierCategory);
      return a.dossierName || a.dossierCode || "Uncategorised";
    };
    const out = new Map();
    items.forEach((a) => {
      const k = key(a);
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(a);
    });
    return [...out.entries()];
  }, [items, groupBy]);

  // ── Sr 76 — themes ────────────────────────────────────────────────────────
  const themes = useMemo(() => {
    const counts = new Map();
    items.forEach((a) => {
      const t = a.theme || "Unthemed";
      counts.set(t, (counts.get(t) || 0) + 1);
    });
    const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const max  = rows.length ? rows[0][1] : 1;
    return rows.map(([name, n]) => ({ name, n, pct: Math.round((n / max) * 100) }));
  }, [items]);

  // ── PDF export ────────────────────────────────────────────────────────────
  // Rebuilds the dossier shape lib/qaPdf.js draws from, so the export keeps the
  // per-dossier sections and colours instead of flattening everything into one
  // unnamed block.
  const handleExport = useCallback(() => {
    if (items.length === 0) return;
    try {
      const byDossier = new Map();
      items.forEach((a) => {
        const code = a.dossierCode || "ALL";
        if (!byDossier.has(code)) {
          byDossier.set(code, {
            dossier_code: code,
            dossier_name: a.dossierName
              || categoryLabel(a.dossierCategory)
              || "Generated questions",
            predicted_questions: [],
          });
        }
        byDossier.get(code).predicted_questions.push({
          question:           a.question,
          importance:         a.priority,
          // The review state the user set on the card. Without it the export
          // read as though every answer were finished, which is the opposite
          // of what a dossier team needs from a working document.
          status:             a.status || "draft",
          suggested_response: a.answer,
          // Built from sourceRulings rather than the flattened `citations`
          // string, which drops the is_dossier flag — the submitter's own
          // document was printing as a bare filename beside ZIN ruling
          // titles, reading as though it were another published source.
          source_ruling_title: sourceLabels(a).join("; "),
        });
      });
      // The ruling titles for the header. This used to be hard-coded to [],
      // so every export claimed "0 rulings" however many it had cited.
      const distinctRulings = new Map();
      // The user's own uploads, kept apart from the rulings. The cover used to
      // report the number of dossier CATEGORIES generated, which a reader took
      // for the number of dossier documents attached; the export now names the
      // documents, and says so when there are none.
      const distinctDocuments = new Map();
      items.forEach((a) => (a.sourceRulings || []).forEach((r) => {
        if (!r || !r.title) return;
        if (r.isDossier) distinctDocuments.set(r.title, r.title);
        else distinctRulings.set(r.id || r.title, r.title);
      }));
      exportToPdf(
        [...byDossier.values()], items.length,
        [...distinctRulings.values()], [...distinctDocuments.values()]
      );
      toast.success("PDF exported.");
    } catch (err) {
      console.error("PDF export failed:", err);
      toast.error("Could not export the PDF.");
    }
  }, [items]);

  const handleUpload = async (input) => {
    const f = input?.files?.[0];
    if (!f) return;

    setUploadName(`${f.name} (${Math.round(f.size / 1024)} KB)`);
    setUploadId(null);
    setUploadError("");

    // 20 MB is what the endpoint accepts (DOSSIER_MAX_BYTES). Checking here
    // too saves the user a slow upload that can only be rejected.
    if (f.size > 20 * 1024 * 1024) {
      setUploadError("That file is over 20 MB. Attach a smaller document or an extract.");
      setUploadName("");
      return;
    }

    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", f);
      const { data } = await axios.post(`${API}/dossier-review/upload`, form);
      const id = data?.upload_id || data?.uploadId || data?.id || null;
      if (!id) throw new Error("No upload id returned");
      setUploadId(id);
      if (data?.note) toast(data.note);
    } catch (err) {
      console.error("Context upload failed:", err);
      // The id stays null, so generate will not claim the file was used.
      setUploadError(
        err?.response?.data?.detail ||
        "Could not upload that document. Generating will continue without it."
      );
      toast.error("Could not attach that document.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div data-testid="qa-page">
      <div className="v2-crumb">Prepare / Q&amp;A generator</div>
      <div className="v2-hdr">
        <div>
          <h1>Q&amp;A generator</h1>
          <p className="v2-sub" style={{ margin: 0 }}>
            Predict the questions an assessment committee is likely to ask, and draft answers
            grounded in the rulings you searched.
          </p>
        </div>
        <button
          className="v2-btn v2-ghost"
          type="button"
          disabled={items.length === 0}
          onClick={handleExport}
        style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <DownloadCloudIcon size={18} />
          Export PDF
        </button>
      </div>

      {/* ── Sr 68 — carried over from Ruling Search ───────────────────── */}
      <div className="v2-card v2-pad" style={{ marginBottom: 14 }}>
        <h3 style={{ marginBottom: 9 }}>Carried over from your ruling search</h3>

        {searchQuery ? (
          <div style={{ background: "var(--indigo-soft)", border: "1px solid #D6D1EE", borderRadius: 8, padding: "11px 13px", fontSize: 13.5, fontWeight: 600, color: "var(--indigo)", display: "flex", gap: 10, alignItems: "flex-start" }}>
            <span aria-hidden="true" style={{ opacity: .6 }}>⌕</span>
            <div style={{ flex: 1 }} data-testid="qa-carried-question">
              {searchQuery}
              <div style={{ fontWeight: 500, fontSize: 12, color: "var(--ink-2)", marginTop: 4 }}>
                {rulingIds.length} ruling{rulingIds.length !== 1 ? "s" : ""} selected
                {question?.matchedCount ? ` from ${question.matchedCount} matches` : ""}
                {question?.filters?.therapyAreas?.length ? ` · ${question.filters.therapyAreas.join(", ")}` : ""}
              </div>
            </div>
            <button className="v2-btn v2-ghost v2-sm" type="button" onClick={() => navigate("/search")}>Change</button>
          </div>
        ) : (
          <div className="v2-banner">
            <span aria-hidden="true">⌕</span>
            <div>
              Nothing carried over yet. Search for precedent and select the rulings you want to
              generate from.
              <div style={{ marginTop: 8 }}>
                <button className="v2-btn v2-mag v2-sm" type="button" onClick={() => navigate("/search")}>
                  Go to Ruling Search
                </button>
              </div>
            </div>
          </div>
        )}

       {/*  ── Sr 69 — Dossier Review context ───────────────────────────
        <div style={{ marginTop: 10, border: "1px solid #D9D1EB", borderRadius: 8, padding: "11px 13px", background: "#FCFAFF", display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
          <span aria-hidden="true" style={{ width: 26, height: 26, borderRadius: 7, background: "var(--indigo)", color: "#fff", display: "grid", placeItems: "center", flex: "0 0 auto" }}>▣</span>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 3 }}>
              Dossier Review context from Ruling Search
            </div>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)" }}>
              {review?.fileName || "No dossier-review file attached"}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 3 }}>
              {review?.fileName
                ? `Categorised as ${categoryLabel(review.category)}${searchQuery ? ` for “${searchQuery}”` : ""}.`
                : "Upload a dossier in Ruling Search to categorise rulings and generated questions."}
            </div>
          </div>
          {review?.category && <span className="v2-tag v2-t-rev">{categoryLabel(review.category)}</span>}
          <button className="v2-btn v2-ghost v2-sm" type="button" onClick={() => navigate("/search")}>
            Edit review context
          </button>
        </div> */}

        {/* ── Sr 70 — additional context ─────────────────────────────── */}
        <div style={{ marginTop: 14 }}>
          <h3 style={{ marginBottom: 7 }}>
            Additional context{" "}
            <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 500 }}>— optional</span>
          </h3>
          <textarea
            value={context}
            onChange={(e) => setContext(e.target.value)}
            placeholder="Describe your drug, indication, comparator or the specific concerns you want addressed."
          />

          <div style={{ marginTop: 11 }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--ink-2)", marginBottom: 6 }}>
              Upload a document as additional context{" "}
              <span style={{ fontWeight: 500, color: "var(--muted)" }}>
                (optional — clinical summary, study report, or draft dossier section; English only)
              </span>
            </div>
            <label className={`v2-upl-label ${uploadId ? "ready" : ""}`}>
              <UploadCloudIcon size={24} />
              <span style={{ flex: 1 }}>
                {uploading
                  ? `Uploading ${uploadName}…`
                  : uploadName || "Click to choose a file — PDF, Word or plain text, up to 20 MB"}
              </span>
              <input ref={fileRef} type="file" accept=".pdf,.docx,.doc,.txt" style={{ display: "none" }} onChange={(e) => handleUpload(e.target)} />
            </label>
            {uploadError && (
              <div className="v2-upl-info" style={{ color: "var(--danger, #B3261E)" }}>
                <span aria-hidden="true">!</span>
                <span>{uploadError}</span>
              </div>
            )}
           
            {uploadId && !uploading && (
              <div className="v2-upl-info">
                <span aria-hidden="true">✓</span>
                <span>{uploadName}</span>
                <button
                type="button"
                className="v2-btn v2-ghost v2-sm"
                onClick={() => {
                  setUploadName("");
                  setUploadId(null);
                  setUploadError("");
                  if (fileRef.current) fileRef.current.value = "";
                }}
                style={{ color: "var(--neg)", display: "flex", alignItems: "center", gap: 5, marginLeft: "auto" }}
              >
                <Trash2 size={13} /> Delete
              </button>
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 9, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
            <button
              className={`v2-btn v2-mag ${lockedFromReadiness ? "v2-locked" : ""}`}
              type="button"
              onClick={generate}
              disabled={disableGeneration || generating || rulingIds.length === 0}
              aria-disabled={disableGeneration || generating || rulingIds.length === 0}
              title={
                disableGeneration
                  ? "Generation is disabled when returning from Readiness Check."
                  : undefined
              }
              style={lockedFromReadiness ? { cursor: "default", pointerEvents: "none",  opacity: 0.45, filter: "grayscale(0.25)"  } : undefined}
              data-testid="generate-btn"
            >
              {disableGeneration? "Generated questions " : generating ? thinkingMessage : "Generate questions"}
            </button>
            <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
              The AI reads across your selected rulings, the Ruling Search dossier-review context,
              and any optional additional context.
            </span>
          </div>
        </div>
      </div>


      <div className="v2-row">
        <div style={{ flex: 1, minWidth: 0 }}>
          {items.length > 0 && !generating && (
            <>
              {/* ── Sr 71 / Sr 72 ─────────────────────────────────────── */}
              <div className="v2-card v2-pad" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
                <b style={{ fontSize: 13 }}>{items.length} question{items.length !== 1 ? "s" : ""} generated</b>
                {needsCount > 0 && <span className="v2-chip">Needs evidence ({needsCount})</span>}
                {genMeta?.rulings_used > 0 && (
                  <span className="v2-chip">across {genMeta.rulings_used} ruling{genMeta.rulings_used !== 1 ? "s" : ""}</span>
                )}
                {/* Toasts disappear; these do not. Each states something the
                    backend already knew and the UI used to discard. */}
                {(genMeta?.attachments || []).map((a) => (
                  <span
                    key={a.ref}
                    className="v2-chip"
                    title={`${a.name} — ${a.chars.toLocaleString()} characters read into the prompt`}
                    data-testid={`attachment-chip-${a.ref}`}
                  >
                    {(genMeta?.refs_uncited || []).includes(a.ref) ? "○" : "✓"} {a.name}
                  </span>
                ))}
                {genMeta?.questions_without_ruling > 0 && (
                  <span
                    className="v2-chip"
                    title="These questions cite no ruling or document. Check them before relying on the answer — an uncited claim about what ZIN expects is not grounded in the corpus."
                    data-testid="ungrounded-chip"
                    style={{ background: "#FDECEA", color: "#8C1D18", borderColor: "#F2B8B5" }}
                  >
                    {genMeta.questions_without_ruling} ungrounded
                  </span>
                )}
                <select className="v2-sel" value={groupBy} onChange={(e) => setGroupBy(e.target.value)} data-testid="group-by">
                  {GROUP_BY.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
                </select>
                <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 9, fontSize: 12 }}>
                  <span>Answers ready</span>
                  <div className="v2-progress" style={{ width: 92 }}><i style={{ width: `${pct}%` }} /></div>
                  <b>{readyCount}/{items.length}</b>
                </div>
              </div>

              {groups.map(([name, groupItems]) => {
                // Only a dossier grouping carries a dossier colour; the
                // priority and status headings stay plain.
                const meta = groupBy === "dossier"
                  ? getMeta(categoryCode(name) || groupItems[0]?.dossierCode)
                  : null;
                return (
                <div key={name} style={{ marginBottom: 18 }}>
                  {meta ? (
                    <div
                      data-testid={"qa-group-" + name}
                      style={{
                        background: meta.hex,
                        color: "#fff",
                        borderRadius: 10,
                        padding: "10px 14px",
                        marginBottom: 10,
                      }}
                    >
                      <b style={{ fontSize: 13.5 }}>{name}</b>
                      <div style={{ fontSize: 12, opacity: 0.9 }}>
                        {groupItems.length} question{groupItems.length !== 1 ? "s" : ""}
                      </div>
                    </div>
                  ) : (
                    <h3 style={{ marginBottom: 8 }}>{name} · {groupItems.length}</h3>
                  )}
                  {groupItems.map((item) => (
                    <QuestionCard
                      key={item.id}
                      item={item}
                      index={items.indexOf(item)}
                      onAnswerChange={handleAnswerChange}
                      onStatusChange={handleStatusChange}
                    />
                  ))}
                </div>
                );
              })}

              <div style={{ display: "flex", gap: 8 }}>
                <button className="v2-btn" type="button" onClick={saveAll}>
                  {activeSession ? `Save to ${activeSession.drugName}` : "Save to a session"}
                </button>
              <button
                className="v2-btn v2-ghost"
                type="button"
                onClick={() => {
                  if (!activeSession?.id || !question?.id) {
                    navigate("/readiness");
                    return;
                  }

                  setActiveSessionId(activeSession.id);

                  navigate(
                    `/readiness?sessionId=${encodeURIComponent(
                      activeSession.id
                    )}&questionId=${encodeURIComponent(question.id)}`
                  );
                }}
              >
                View readiness
              </button>
              </div>
            </>
          )}

          {generating && (
            <div
              className="v2-card v2-pad"
              style={{ textAlign: "center", padding: "48px 16px" }}
              data-testid="qa-generating-state"
            >
              <div style={{ fontSize: 34, lineHeight: 1, marginBottom: 12 }} aria-hidden="true">⌬</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--ink)", marginBottom: 6 }}>
                {thinkingMessage}
              </div>
              <div style={{ fontSize: 12.5, color: "var(--muted)", maxWidth: 340, margin: "0 auto" }}>
                Analysing the selected ruling{rulingIds.length !== 1 ? "s" : ""} and generating
                predicted ZIN questions for each dossier type.
              </div>
              <div className="v2-progress" style={{ width: 160, margin: "16px auto 0" }}>
                <i style={{ width: "100%", opacity: .45 }} />
              </div>
            </div>
          )}

          {items.length === 0 && !generating && (
            <div className="v2-card v2-pad" style={{ color: "var(--muted)", fontSize: 13 }}>
              No questions generated yet.
            </div>
          )}
        </div>

        {/* ── Sr 75 / Sr 76 — sidebar ───────────────────────────────── */}
        <div style={{ flex: "0 0 236px" }}>
          <div className="v2-card v2-pad" style={{ marginBottom: 14 }}>
            <h3>Session context</h3>
            {activeSession ? (
              <div className="v2-kv">
                <div><b>{activeSession.drugName}</b><span>{activeSession.therapyArea || "No therapy area"}</span></div>
                <div><b>Dossier type</b><span>{activeSession.dossierType || "Not set"}</span></div>
                <div>
                  <b>Dossier Review</b>
                  <span>{review?.category ? `${categoryLabel(review.category)} · from Ruling Search` : "None attached"}</span>
                </div>
                <div><b>Rulings selected</b><span>{rulingIds.length} from your search</span></div>
              </div>
            ) : (
              <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
                No session open. Start one to keep these questions and answers.
                <div style={{ marginTop: 9 }}>
                  <button className="v2-btn v2-mag v2-sm" type="button" onClick={() => requestNewSession({})}>
                    Start a session
                  </button>
                </div>
              </div>
            )}
          </div>

          {/*Disable the "Question Themes"
           {themes.length > 0 && (
            <div className="v2-card v2-pad">
              <h3>Question themes</h3>
              <div className="v2-bars">
                {themes.map((t) => (
                  <div className="b" key={t.name} style={{ gridTemplateColumns: "96px 1fr 26px" }}>
                    <span>{t.name}</span>
                    <i style={{ width: `${t.pct}%` }} />
                    <span>{t.n}</span>
                  </div>
                ))}
              </div>
            </div>
          )} */}
        </div>
      </div>
    </div>
  );
}
