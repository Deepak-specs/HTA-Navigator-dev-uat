// src/lib/searchSnapshot.js
// Snapshot of the Ruling Search view. Saved against the question in the session
// store so it survives reloads and any route into Q&A. A tab-scoped copy is
// kept as a fallback for the moment before a question exists.

const TAB_KEY = "hta_search_snapshot_v1";
const MAX_BYTES = 120 * 1024;   // per snapshot. Sessions share ONE localStorage key.

const sizeOf = (obj) => new Blob([JSON.stringify(obj)]).size;

function shrink(snapshot) {
  let snap = { ...snapshot };
  if (sizeOf(snap) <= MAX_BYTES) return snap;

  // 1. Shorten snippets (the largest field). Ranking and scores stay.
  snap.aiRelevance = Object.fromEntries(
    Object.entries(snap.aiRelevance || {}).map(([id, r]) => [
      id, { ...r, snippet: (r.snippet || "").slice(0, 140) },
    ])
  );
  if (sizeOf(snap) <= MAX_BYTES) return snap;

  // 2. Drop snippets entirely.
  snap.aiRelevance = Object.fromEntries(
    Object.entries(snap.aiRelevance || {}).map(([id, r]) => [id, { ...r, snippet: "" }])
  );
  if (sizeOf(snap) <= MAX_BYTES) return snap;

  // 3. Drop the cited-source list.
  snap.backendSources = [];
  return snap;
}

/** Adds a timestamp and enforces the size cap. */
export function packSnapshot(snapshot) {
  return shrink({ ...snapshot, savedAt: Date.now() });
}

// ── Tab-scoped fallback (sessionStorage, separate quota from sessions) ──────
export function saveTabSnapshot(snapshot) {
  try {
    sessionStorage.setItem(TAB_KEY, JSON.stringify(packSnapshot(snapshot)));
    return true;
  } catch (err) {
    console.warn("Could not save tab snapshot:", err);
    return false;
  }
}

export function loadTabSnapshot() {
  try {
    const raw = sessionStorage.getItem(TAB_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearTabSnapshot() {
  try { sessionStorage.removeItem(TAB_KEY); } catch { /* ignore */ }
}