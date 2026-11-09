/**
 * sessionStore.js
 * ----------------
 * Simple localStorage-backed store for HTA Navigator v2 sessions.
 *
 * Data shape
 * ----------
 * sessions: Session[]
 * activeSessionId: string | null
 *
 * Session {
 *   id: string
 *   drugName: string
 *   therapyArea: string
 *   dossierType: string
 *   status: "in_progress" | "completed"
 *   createdAt: ISO string
 *   updatedAt: ISO string
 *   questions: Question[]
 * }
 *
 * Question {
 *   id: string
 *   query: string
 *   rulingIds: string[]
 *   filters?: { therapyAreas, outcomes, dossierCategories, years }
 *   matchedCount?: number        // rulings the search matched
 *   selectedCount?: number       // rulings the user kept
 *   dossierReview?: { uploadId, fileName, category }
 *   generatedQA: QAItem[]
 *   createdAt: ISO string
 *   updatedAt?: ISO string
 * }
 *
 * QAItem {
 *   id: string
 *   question: string
 *   answer: string
 *   status: "draft" | "needs_evidence" | "ready"
 *   reviewed: boolean   // legacy compat — mirrors status === "ready"
 *   priority: "high" | "medium" | "low"
 *   theme: string
 *   citations: string[]
 *   wordCount?: number
 *   savedAt?: ISO string
 * }
 */

const SESSIONS_KEY    = "htanav_v2_sessions";
const ACTIVE_ID_KEY   = "htanav_v2_activeSessionId";

// ─── Store health (Sr 99) ─────────────────────────────────────────────────────
// Everything a user creates — sessions, saved rulings, generated Q&A, drafted
// answers — exists only in this browser, under these two keys. There is no
// server copy. Two silent failure paths used to be able to destroy it:
//
//   1. `load` treated unparseable JSON exactly like "nothing stored yet" and
//      returned []. The page then showed "No sessions yet", and the very next
//      write persisted that empty array over the real data.
//   2. `save` swallowed every exception, including QuotaExceededError. Past
//      the ~5MB localStorage limit the app looked like it was saving while
//      nothing was being written.
//
// Both now fail loudly and, more importantly, non-destructively: a value that
// cannot be read is copied aside under a timestamped key and the live key is
// write-protected for the rest of the session, so a corrupt read can never be
// promoted into permanent loss.
const health = { corrupt: false, quarantineKey: null, lastError: null };

/** What the store knows about itself — for a banner, or the console. */
export function getStoreHealth() {
  return { ...health };
}

function quarantine(key, raw) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupKey = `${key}__corrupt_${stamp}`;
  try {
    localStorage.setItem(backupKey, raw);
    health.quarantineKey = backupKey;
  } catch (e) {
    // Even the rescue copy failed — most likely the quota. Say so; the raw
    // value is still sitting under the original key, untouched.
    health.lastError = `could not quarantine (${e?.name || "error"})`;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function load(key, fallback) {
  let raw = null;
  try {
    raw = localStorage.getItem(key);
  } catch (e) {
    // Blocked storage (private window, site-data policy). Nothing to recover.
    health.lastError = `localStorage unreadable (${e?.name || "error"})`;
    return fallback;
  }

  if (raw == null) return fallback;      // genuinely nothing stored yet

  try {
    return JSON.parse(raw);
  } catch (e) {
    // Readable but not parseable: the data is still there, just damaged.
    // Never report this as "empty" without protecting what is on disk.
    if (key === SESSIONS_KEY) {
      health.corrupt = true;
      health.lastError = `sessions could not be parsed (${e?.message || "invalid JSON"})`;
      quarantine(key, raw);
      console.error(
        "[sessionStore] stored sessions are corrupt and could not be read. " +
        "The raw value has been copied to " +
        `"${health.quarantineKey || "(quarantine failed)"}" and writes to ` +
        `"${SESSIONS_KEY}" are blocked for this session so it cannot be overwritten.`
      );
    }
    return fallback;
  }
}

/** @returns {boolean} true when the value actually reached localStorage. */
function save(key, value) {
  // The guard that matters: once sessions have been read as corrupt, every
  // later write would be an empty list landing on top of recoverable data.
  if (key === SESSIONS_KEY && health.corrupt) {
    console.error(
      "[sessionStore] refusing to overwrite corrupt sessions. " +
      `Recover from "${health.quarantineKey}" first, or clear it deliberately.`
    );
    return false;
  }

  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    const quota =
      e?.name === "QuotaExceededError" ||
      e?.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
      e?.code === 22;
    health.lastError = quota
      ? "browser storage is full — recent work was NOT saved"
      : `save failed (${e?.name || "error"})`;
    console.error(`[sessionStore] ${health.lastError}`, e);
    return false;
  }
}

// ─── Sessions CRUD ────────────────────────────────────────────────────────────

export function getAllSessions() {
  return load(SESSIONS_KEY, []);
}

export function getSession(id) {
  return getAllSessions().find((s) => s.id === id) || null;
}

export function createSession({ drugName = "", therapyArea = "", dossierType = "" } = {}) {
  const sessions = getAllSessions();
  const newSession = {
    id:          crypto.randomUUID(),
    drugName:    drugName || "Unnamed drug",
    therapyArea: therapyArea || "",
    dossierType: dossierType || "",
    status:      "in_progress",
    createdAt:   new Date().toISOString(),
    updatedAt:   new Date().toISOString(),
    questions:   [],
  };
  sessions.push(newSession);
  save(SESSIONS_KEY, sessions);
  return newSession;
}

export function updateSession(id, patch) {
  const sessions = getAllSessions().map((s) =>
    s.id === id ? { ...s, ...patch, updatedAt: new Date().toISOString() } : s
  );
  save(SESSIONS_KEY, sessions);
}

export function deleteSession(id) {
  const sessions = getAllSessions().filter((s) => s.id !== id);
  save(SESSIONS_KEY, sessions);
  if (getActiveSessionId() === id) setActiveSessionId(null);
}

export function markSessionCompleted(id) {
  updateSession(id, { status: "completed" });
}

// ─── Active session ────────────────────────────────────────────────────────────

export function getActiveSessionId() {
  return load(ACTIVE_ID_KEY, null);
}

export function setActiveSessionId(id) {
  save(ACTIVE_ID_KEY, id);
}

export function getActiveSession() {
  const id = getActiveSessionId();
  return id ? getSession(id) : null;
}

// ─── Questions ────────────────────────────────────────────────────────────────

export function addQuestionToSession(
  sessionId,
  { query = "", rulingIds = [], rulings = [], filters = null, matchedCount = null,
    dossierReview = null } = {}
) {
  const sessions = getAllSessions();
  const idx = sessions.findIndex((s) => s.id === sessionId);
  if (idx === -1) return null;

  // Sr 4 — a question now records the context it was asked in. The design
  // prints "42 rulings matched · 2 selected · cardiology · 2023–2026" on every
  // session row, and none of that was stored, so it could not be shown.
  const newQ = {
    id:          crypto.randomUUID(),
    query,
    rulingIds,
    // Sr 93 follow-up — the titles, not just the ids. "3 rulings saved" was a
    // dead end: nothing stored the names, so no screen could list them. Kept
    // alongside rulingIds rather than replacing it, because Q&A, the PDF
    // export and the session rows all read the id array.
    rulings: (rulings || []).filter((r) => r && r.id),
    filters,                              // {therapyAreas, outcomes, dossierCategories, years}
    matchedCount,                         // how many rulings the search matched
    selectedCount: rulingIds.length,      // how many the user kept
    dossierReview,                        // {uploadId, fileName, category}
    generatedQA: [],
    createdAt:   new Date().toISOString(),
    updatedAt:   new Date().toISOString(),
  };
  sessions[idx].questions.push(newQ);
  sessions[idx].updatedAt = new Date().toISOString();
  save(SESSIONS_KEY, sessions);
  return newQ;
}

/**
 * Amends an existing question in place (Sr 4).
 *
 * Without this, the only way to attach anything to a question was to create a
 * new one — which is why saving a Q&A set twice inflated a session's question
 * count (Sr 77). `selectedCount` is kept in step with `rulingIds` so the two
 * cannot drift apart.
 */
export function updateQuestion(sessionId, questionId, patch = {}) {
  const sessions = getAllSessions();
  const sIdx = sessions.findIndex((s) => s.id === sessionId);
  if (sIdx === -1) return null;
  const qIdx = sessions[sIdx].questions.findIndex((q) => q.id === questionId);
  if (qIdx === -1) return null;

  const merged = { ...sessions[sIdx].questions[qIdx], ...patch, updatedAt: new Date().toISOString() };
  if (patch.rulingIds) merged.selectedCount = patch.rulingIds.length;

  sessions[sIdx].questions[qIdx] = merged;
  sessions[sIdx].updatedAt = new Date().toISOString();
  save(SESSIONS_KEY, sessions);
  return merged;
}

export function deleteQuestion(sessionId, questionId) {
  const sessions = getAllSessions();
  const idx = sessions.findIndex((s) => s.id === sessionId);
  if (idx === -1) return;
  sessions[idx].questions = sessions[idx].questions.filter((q) => q.id !== questionId);
  sessions[idx].updatedAt = new Date().toISOString();
  save(SESSIONS_KEY, sessions);
}

/**
 * Removes several questions from a session in a single write.
 *
 * Used by the My Sessions bulk-delete flow. Doing it in one pass (rather than
 * calling deleteQuestion in a loop) means one read, one write, and one
 * updatedAt stamp, so a failed save cannot leave only some questions removed.
 *
 * @returns {boolean} true when the removal reached localStorage.
 */
export function deleteQuestions(sessionId, questionIds = []) {
  if (!Array.isArray(questionIds) || questionIds.length === 0) return false;

  const ids = new Set(questionIds);
  const sessions = getAllSessions();
  const idx = sessions.findIndex((s) => s.id === sessionId);
  if (idx === -1) return false;

  sessions[idx].questions = sessions[idx].questions.filter((q) => !ids.has(q.id));
  sessions[idx].updatedAt = new Date().toISOString();
  return save(SESSIONS_KEY, sessions);
}

// ─── Search snapshot (exact restore of Ruling Search) ────────────────────────

/**
 * Attaches the Ruling Search view to a question so "Change" on the Q&A page
 * can put it back exactly. Written directly through save() rather than
 * updateQuestion(), because updateQuestion returns the merged object even when
 * the write fails, which would make a failed snapshot look successful.
 *
 * Only the most recent snapshot per session is kept. All sessions share one
 * localStorage key, so older snapshots are dropped before a new one is written
 * rather than letting the combined value outgrow the browser limit.
 *
 * @returns {boolean} true when the snapshot reached localStorage.
 */
export function saveQuestionSearchSnapshot(sessionId, questionId, snapshot) {
  if (!sessionId || !questionId || !snapshot) return false;

  const sessions = getAllSessions();
  const sIdx = sessions.findIndex((s) => s.id === sessionId);
  if (sIdx === -1) return false;
  const qIdx = sessions[sIdx].questions.findIndex((q) => q.id === questionId);
  if (qIdx === -1) return false;

  // Keep the newest snapshot in this session only.
  sessions[sIdx].questions.forEach((q, i) => {
    if (i !== qIdx && q.searchSnapshot) delete q.searchSnapshot;
  });

  sessions[sIdx].questions[qIdx].searchSnapshot = snapshot;
  sessions[sIdx].questions[qIdx].updatedAt = new Date().toISOString();
  sessions[sIdx].updatedAt = new Date().toISOString();

  const ok = save(SESSIONS_KEY, sessions);
  if (!ok) {
    console.warn(
      "[sessionStore] search snapshot was not stored (storage full or blocked). " +
      "Change will fall back to a fresh search."
    );
  }
  return ok;
}

/** Reads the stored snapshot for a question; null if there is none. */
export function getQuestionSearchSnapshot(sessionId, questionId) {
  const session = getAllSessions().find((s) => s.id === sessionId);
  const question = session?.questions?.find((q) => q.id === questionId);
  return question?.searchSnapshot || null;
}

// ─── QA items ─────────────────────────────────────────────────────────────────

export function addQAToQuestion(sessionId, questionId, qaItems = []) {
  const sessions = getAllSessions();
  const sIdx = sessions.findIndex((s) => s.id === sessionId);
  if (sIdx === -1) return;
  const qIdx = sessions[sIdx].questions.findIndex((q) => q.id === questionId);
  if (qIdx === -1) return;

  const formatted = qaItems.map((item) => ({
    id:        item.id || crypto.randomUUID(),
    question:  item.question || "",
    answer:    item.answer   || "",
    status:    item.status   || "draft",
    reviewed:  item.status === "ready",
    priority:  item.priority || "medium",
    theme:     item.theme    || "",
    citations: item.citations || [],
    wordCount: item.wordCount,
    // The dossier a question belongs to is part of the question, not a view
    // setting: dropping these on save meant a reopened session showed every
    // question as "Uncategorised" even when generation had categorised it.
    dossierCategory:   item.dossierCategory   || "",
    dossierCode:       item.dossierCode       || "",
    dossierName:       item.dossierName       || "",
    seenIn:            item.seenIn,
    rulingsConsidered: item.rulingsConsidered,
    savedAt:   new Date().toISOString(),
  }));

  sessions[sIdx].questions[qIdx].generatedQA = formatted;
  sessions[sIdx].updatedAt = new Date().toISOString();
  save(SESSIONS_KEY, sessions);
}

export function updateQAAnswer(sessionId, questionId, qaId, answer) {
  const sessions = getAllSessions();
  const sIdx = sessions.findIndex((s) => s.id === sessionId);
  if (sIdx === -1) return;
  const qIdx = sessions[sIdx].questions.findIndex((q) => q.id === questionId);
  if (qIdx === -1) return;
  const aIdx = sessions[sIdx].questions[qIdx].generatedQA.findIndex((a) => a.id === qaId);
  if (aIdx === -1) return;
  sessions[sIdx].questions[qIdx].generatedQA[aIdx].answer  = answer;
  sessions[sIdx].questions[qIdx].generatedQA[aIdx].savedAt = new Date().toISOString();
  sessions[sIdx].updatedAt = new Date().toISOString();
  save(SESSIONS_KEY, sessions);
}

export function updateQAStatus(sessionId, questionId, qaId, status) {
  const sessions = getAllSessions();
  const sIdx = sessions.findIndex((s) => s.id === sessionId);
  if (sIdx === -1) return;
  const qIdx = sessions[sIdx].questions.findIndex((q) => q.id === questionId);
  if (qIdx === -1) return;
  const aIdx = sessions[sIdx].questions[qIdx].generatedQA.findIndex((a) => a.id === qaId);
  if (aIdx === -1) return;
  sessions[sIdx].questions[qIdx].generatedQA[aIdx].status   = status;
  sessions[sIdx].questions[qIdx].generatedQA[aIdx].reviewed = status === "ready";
  sessions[sIdx].updatedAt = new Date().toISOString();
  save(SESSIONS_KEY, sessions);
}

export function toggleAnswerReviewed(sessionId, questionId, qaId) {
  const sessions = getAllSessions();
  const sIdx = sessions.findIndex((s) => s.id === sessionId);
  if (sIdx === -1) return;
  const qIdx = sessions[sIdx].questions.findIndex((q) => q.id === questionId);
  if (qIdx === -1) return;
  const aIdx = sessions[sIdx].questions[qIdx].generatedQA.findIndex((a) => a.id === qaId);
  if (aIdx === -1) return;
  const curr = sessions[sIdx].questions[qIdx].generatedQA[aIdx];
  const next = curr.status === "ready" ? "draft" : "ready";
  sessions[sIdx].questions[qIdx].generatedQA[aIdx].status   = next;
  sessions[sIdx].questions[qIdx].generatedQA[aIdx].reviewed = next === "ready";
  sessions[sIdx].updatedAt = new Date().toISOString();
  save(SESSIONS_KEY, sessions);
}

// ─── Readiness computation ────────────────────────────────────────────────────

export function computeQuestionReadiness(question) {
  const qa = question?.generatedQA ?? [];
  if (qa.length === 0) return 0;
  const ready = qa.filter((a) => a.reviewed || a.status === "ready").length;
  return Math.round((ready / qa.length) * 100);
}

// Only questions that actually have generated Q&A count towards the session
// average. A saved search with nothing generated has no review work to be done,
// so scoring it 0% would drag the session figure down and make progress appear
// to go backwards each time a search is saved.
export function computeSessionReadiness(session) {
  const qs = (session?.questions ?? []).filter(
    (q) => (q?.generatedQA ?? []).length > 0
  );
  if (qs.length === 0) return 0;
  const total = qs.reduce((acc, q) => acc + computeQuestionReadiness(q), 0);
  return Math.round(total / qs.length);
}

// Number of questions the session readiness figure is averaged over, so the UI
// can say what the percentage actually covers.
export function countScoredQuestions(session) {
  return (session?.questions ?? []).filter(
    (q) => (q?.generatedQA ?? []).length > 0
  ).length;
}
