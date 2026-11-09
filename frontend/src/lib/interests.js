/**
 * interests.js — Sr 41
 * ─────────────────────────────────────────────────────────────────────────────
 * The therapy areas a user cares about, used to filter the Home feed.
 *
 * The design opens Home on "New in your therapy areas" rather than a global
 * ruling list, and offers an "edit interests" link. Nothing stored that, so the
 * link went to /search and the feed stayed global.
 *
 * Deliberately localStorage, not the backend: there is no user-profile store in
 * this app, and interests are a per-person display preference rather than
 * shared state. Moving them server-side later only means swapping these four
 * functions. Every access is wrapped — storage throws in private windows and
 * returns null when site data is cleared.
 */

const KEY = "htanav_v2_interests";

/** @returns {string[]} chosen therapy areas; empty means "no preference set" */
export function getInterests() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((a) => typeof a === "string") : [];
  } catch {
    return [];
  }
}

export function setInterests(areas = []) {
  try {
    localStorage.setItem(KEY, JSON.stringify([...new Set(areas.filter(Boolean))]));
  } catch {
    /* storage unavailable — the feed falls back to showing everything */
  }
}

export function hasInterests() {
  return getInterests().length > 0;
}

/**
 * Interests to filter by, falling back so the feed is never empty:
 *   explicit choice → the active session's therapy area → no filter at all.
 *
 * `explicit` is passed in rather than read from storage here, so a React caller
 * can hold it in state and have its memo dependencies tell the truth. Omit it
 * and current storage is used.
 *
 * @param {object|null} activeSession
 * @param {string[]|null} explicitInterests
 * @returns {{ areas: string[], source: "explicit"|"session"|"none" }}
 */
export function effectiveInterests(activeSession, explicitInterests = null) {
  const explicit = Array.isArray(explicitInterests) ? explicitInterests : getInterests();
  if (explicit.length > 0) return { areas: explicit, source: "explicit" };

  const area = activeSession?.therapyArea?.trim();
  if (area) return { areas: [area], source: "session" };

  return { areas: [], source: "none" };
}

/** Case-insensitive match, so "Rare Diseases" and "rare diseases" agree. */
export function matchesInterests(ruling, areas = []) {
  if (areas.length === 0) return true;
  const area = (ruling?.therapy_area || "").trim().toLowerCase();
  if (!area) return false;
  return areas.some((a) => a.trim().toLowerCase() === area);
}
