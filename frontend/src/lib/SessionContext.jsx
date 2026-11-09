/**
 * SessionContext.jsx
 * ------------------
 * Provides { activeSession, refreshSessions, sessions, setActiveSession }
 * to the whole app without prop-drilling.
 * Wraps the router in App.jsx.
 */
import { createContext, useContext, useState, useCallback, useRef } from "react";
import {
  getAllSessions,
  getSession,
  getActiveSession,
  setActiveSessionId,
  createSession as storeCreateSession,
  addQuestionToSession,
} from "./sessionStore";

const SessionCtx = createContext(null);

// Module-level so `clearDossierReview` closes over one stable object rather
// than a new literal on every render.
const EMPTY_DOSSIER_REVIEW = {
  uploadId: null, fileName: "", fileSizeKb: null, pageCount: 0,
  category: "", suggestedCategory: "", manualCategory: false,
  textAvailable: false, note: "",
  // Content fingerprint of the attached file, so re-picking the same document
  // is recognised and not uploaded a second time.
  fileHash: null,
};

const CUSTOM_CATS_KEY = "htanav_v2_customDossierCategories";

// The attached dossier is scoped to the browsing session on purpose: it lives in
// sessionStorage, not localStorage, so a refresh or an accidental back-navigation
// mid-flow does not silently drop it, while closing the tab does. A dossier is a
// working attachment for the question being asked, not something to resurrect
// days later against a different question.
const DOSSIER_REVIEW_KEY = "htanav_v2_dossierReview";

function readStoredDossierReview(fallback) {
  try {
    const raw = sessionStorage.getItem(DOSSIER_REVIEW_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    // Only an upload that actually exists server-side is worth restoring; a
    // half-written record would make the UI claim a dossier it cannot send.
    if (!parsed || typeof parsed !== "object" || !parsed.uploadId) return fallback;
    return { ...fallback, ...parsed };
  } catch {
    return fallback;
  }
}

function writeStoredDossierReview(value) {
  try {
    if (value?.uploadId) {
      sessionStorage.setItem(DOSSIER_REVIEW_KEY, JSON.stringify(value));
    } else {
      sessionStorage.removeItem(DOSSIER_REVIEW_KEY);
    }
  } catch {
    // Private mode or a full quota — the in-memory copy still works for this
    // navigation, so this is not worth surfacing to the user.
  }
}

export function SessionProvider({ children }) {
  const [sessions, setSessions]         = useState(() => getAllSessions());
  const [activeSession, setActiveSess]  = useState(() => getActiveSession());

  // ── Save-to-session picker — shared so any page can trigger it with an
  // optional pending item ({ query, rulingIds }) to attach once a session
  // is chosen or created. Layout.jsx renders the actual modal.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerItem, setPickerItem] = useState(null);

  // Continuation for the picker (Sr 45). Callers that need to do something
  // *after* a session is chosen — such as Ruling Search handing off to the Q&A
  // generator — pass a callback instead of acting immediately. Held in a ref so
  // the resolve path never closes over a stale copy.
  const pickerOnResolved = useRef(null);

  // ── Dossier Review context (Sr 3) ─────────────────────────────────────────
  // The dossier a user attaches to their research question in Ruling Search,
  // which Q&A then reuses. It lives here rather than in Search's own state
  // because the whole point is that it survives the navigation to Q&A — the
  // mockup keeps it in a module-level singleton, which React would discard.
  //
  // `manualCategory` records whether the user overrode the suggestion, so
  // retyping the question does not silently undo their choice.
  const [dossierReview, setDossierReviewState] = useState(
    () => readStoredDossierReview(EMPTY_DOSSIER_REVIEW)
  );

  const setDossierReview = useCallback((patch) => {
    setDossierReviewState((prev) => {
      const next = { ...prev, ...patch };
      writeStoredDossierReview(next);
      return next;
    });
  }, []);

  const clearDossierReview = useCallback(() => {
    writeStoredDossierReview(null);
    setDossierReviewState(EMPTY_DOSSIER_REVIEW);
  }, []);

  // Sr 13 — user-added categories. Per-browser by design: there is no
  // user-profile store, and a category someone invents for their own dossier is
  // a display preference, not shared data. Swapping this for a server call
  // later means changing only these two functions.
  const [customCategories, setCustomCategoriesState] = useState(() => {
    try {
      const raw = localStorage.getItem(CUSTOM_CATS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((c) => typeof c === "string") : [];
    } catch { return []; }
  });

  // Returns whether the name was added, so the caller can show a duplicate
  // error. Checked against current state rather than inside a setState updater,
  // which would run after this function had already returned.
  const addCustomCategory = useCallback((name) => {
    const clean = String(name || "").trim().replace(/\s+/g, " ");
    if (!clean) return false;
    if (customCategories.some((c) => c.toLowerCase() === clean.toLowerCase())) return false;
    const next = [...customCategories, clean];
    setCustomCategoriesState(next);
    try { localStorage.setItem(CUSTOM_CATS_KEY, JSON.stringify(next)); } catch { /* non-fatal */ }
    return true;
  }, [customCategories]);

  // ── New-session modal (Sr 42) ─────────────────────────────────────────────
  // The modal is rendered by Layout but triggered from anywhere, so the request
  // lives here. `null` means closed; an object (possibly empty) means open, and
  // its fields pre-fill the form. Previously pages had to navigate to /sessions
  // to start a session, which the design creates in place instead.
  const [newSessionPrefill, setNewSessionPrefill] = useState(null);
  const requestNewSession = useCallback((prefill = {}) => setNewSessionPrefill(prefill), []);
  const dismissNewSession = useCallback(() => setNewSessionPrefill(null), []);

  const refreshSessions = useCallback(() => {
    const all = getAllSessions();
    setSessions(all);
    setActiveSess(getActiveSession());
  }, []);

  const activateSession = useCallback((id) => {
    setActiveSessionId(id);
    clearDossierReview();
    refreshSessions();
  }, [refreshSessions, clearDossierReview]);

  const closeSession = useCallback(() => {
    setActiveSessionId(null);
    clearDossierReview();
    refreshSessions();
  }, [refreshSessions, clearDossierReview]);

  const createSession = useCallback((opts) => {
    const s = storeCreateSession(opts);
    setActiveSessionId(s.id);
    refreshSessions();
    return s;
  }, [refreshSessions]);

  // `onResolved({ session, question })` fires once the user has actually picked
  // or created a session — never before.
  const openSavePicker = useCallback((item = null, onResolved = null) => {
    setPickerItem(item);
    pickerOnResolved.current = typeof onResolved === "function" ? onResolved : null;
    setPickerOpen(true);
  }, []);

  const clearPickerItem = useCallback(() => setPickerItem(null), []);

  // Called by both picker paths — choosing an existing session, and creating a
  // new one from inside the picker (Layout.jsx). Returns true when a
  // continuation ran, so the caller knows not to apply its own default
  // navigation on top of it.
  const resolvePicker = useCallback((session, question) => {
    const cb = pickerOnResolved.current;
    pickerOnResolved.current = null;
    if (!cb) return false;
    cb({ session, question });
    return true;
  }, []);

  // Discards the continuation without running it, so a cancelled picker never
  // navigates the user somewhere they did not ask to go.
  const cancelPicker = useCallback(() => {
    pickerOnResolved.current = null;
    setPickerItem(null);
    setPickerOpen(false);
  }, []);

  const chooseSession = useCallback((sessionId) => {
    const question = pickerItem ? addQuestionToSession(sessionId, pickerItem) : null;
    setActiveSessionId(sessionId);
    refreshSessions();
    setPickerOpen(false);
    setPickerItem(null);
    const session = getSession(sessionId);
    resolvePicker(session, question);
    return { session, question };
  }, [pickerItem, refreshSessions, resolvePicker]);

  return (
    <SessionCtx.Provider value={{
      sessions, activeSession, refreshSessions, activateSession, closeSession, createSession,
      pickerOpen, pickerItem, openSavePicker, setPickerOpen, clearPickerItem, chooseSession,
      resolvePicker, cancelPicker,
      newSessionPrefill, requestNewSession, dismissNewSession,
      dossierReview, setDossierReview, clearDossierReview,
      customCategories, addCustomCategory,
    }}>
      {children}
    </SessionCtx.Provider>
  );
}

export function useSession() {
  return useContext(SessionCtx);
}
