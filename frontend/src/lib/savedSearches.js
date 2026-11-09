/**
* savedSearches.js
* ─────────────────────────────────────────────────────────────────────────────
* "Save this search" — the feature that turns Ruling Search from a one-off
* lookup into something you come back to.
*
* A saved search records the query AND the filters it was run under, so
* re-running it reproduces the result set rather than just re-typing the words.
*
* ON MONITORING, HONESTLY
* The design describes saving a search "plus an alert", which implies email or
* push. There is no notification infrastructure on either side of this app, so
* none is claimed. What is implemented instead is real and needs no new
* infrastructure: each saved search remembers the latest decision date in the
* corpus at the moment it was saved, and `countNewSince` reports how many
* rulings have matched it since. You see the count when you next open the page.
*
* Adding email alerts later means a timer-triggered function re-running these
* queries server-side; the shape stored here is already what that would need.
*
* Storage is localStorage, consistent with sessions and interests. Every access
* is wrapped — storage throws in private windows and returns null when site
* data is cleared.
*/

const KEY = "htanav_v2_savedSearches";
const MAX_SAVED = 25;

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_SAVED)));
  } catch {
    /* storage unavailable — saving is a convenience, not critical state */
  }
}

export function getSavedSearches() {
  return read();
}

/** Latest decision date in the corpus, as the watermark for "new since". */
export function corpusWatermark(rulings = []) {
  let max = "";
  rulings.forEach((r) => {
    const d = (r?.decision_date || "").slice(0, 10);
    if (d && d > max) max = d;
  });
  return max;
}

/**
* Saves a search. Re-saving the same query under the same filters updates the
* existing entry rather than creating a duplicate, so the list stays usable.
*
* @returns {{ saved: object, updated: boolean }}
*/
export function saveSearch({ query, filters = {}, matchedCount = 0, rulings = [] }) {
  const q = String(query || "").trim();
  if (!q) return null;

  const list = read();
  const signature = JSON.stringify({
    q: q.toLowerCase(),
    a: [...(filters.therapyAreas || [])].sort(),
    o: [...(filters.outcomes || [])].sort(),
    d: [...(filters.dossierCategories || [])].sort(),
    p: Boolean(filters.onlyPico),
    y: [...(filters.years || [])].sort(),
  });

  const existing = list.findIndex((s) => s.signature === signature);
  const entry = {
    id:        existing >= 0 ? list[existing].id : crypto.randomUUID(),
    query:     q,
    filters,
    signature,
    matchedCount,
    // The watermark is only set on first save. Refreshing it on every re-save
    // would quietly reset the "new since" count to zero.
    watermark: existing >= 0 ? list[existing].watermark : corpusWatermark(rulings),
    savedAt:   existing >= 0 ? list[existing].savedAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (existing >= 0) list[existing] = entry;
  else list.unshift(entry);

  write(list);
  return { saved: entry, updated: existing >= 0 };
}

export function deleteSavedSearch(id) {
  write(read().filter((s) => s.id !== id));
}

/** Resets the watermark to now, so the "new" badge clears once acted on. */
export function markSavedSearchSeen(id, rulings = []) {
  const list = read().map((s) =>
    s.id === id ? { ...s, watermark: corpusWatermark(rulings), updatedAt: new Date().toISOString() } : s
  );
  write(list);
}

/**
* All dossier types a ruling covers — never empty.
*
* A ruling can span several dossier components (e.g. Pharmacotherapeutic +
* Budget Impact), held in the `dossier_categories` list. Facets and filters use
* the whole list, so a ruling is counted under every type it covers. The
* "No Category" rulings store an empty list, so an empty or missing list falls
* back to the primary `dossier_category`.
* Mirrors _ruling_categories() in the backend function_app.py.
*/
export function rulingCategories(r) {
  const cats = Array.isArray(r?.dossier_categories)
    ? r.dossier_categories.filter(Boolean)
    : [];
  if (cats.length > 0) return cats;
  return r?.dossier_category ? [r.dossier_category] : [];
}

/** Does this ruling satisfy a saved search's query and filters? */
export function rulingMatches(saved, r) {
  const q = (saved.query || "").toLowerCase().trim();
  if (q) {
    const hit = ["title", "drug_name", "manufacturer", "summary"]
      .some((f) => (r?.[f] || "").toLowerCase().includes(q));
    if (!hit) return false;
  }

  const f = saved.filters || {};
  if (f.therapyAreas?.length && !f.therapyAreas.includes(r?.therapy_area)) return false;
  if (f.outcomes?.length && !f.outcomes.includes(r?.decision_outcome)) return false;
  if (f.dossierCategories?.length &&
      !rulingCategories(r).some((c) => f.dossierCategories.includes(c))) return false;
  if (f.onlyPico && r?.pico_stated !== true) return false;

  if (f.years?.length) {
    const year  = (r?.decision_date || "").slice(0, 4);
    const valid = /^\d{4}$/.test(year);
    if (f.years.includes("Unknown") && !valid) return true;
    if (!valid || !f.years.includes(year)) return false;
  }
  return true;
}

/**
* Rulings matching this saved search that were decided after it was saved.
*
* Note this is a literal match, not the semantic one the live search uses —
* running embeddings over the corpus in the browser is not viable. So the count
* is a floor: it can understate, never overstate, which is the right direction
* for a notification.
*/
export function countNewSince(saved, rulings = []) {
  if (!saved?.watermark) return 0;
  return rulings.reduce((n, r) => {
    const d = (r?.decision_date || "").slice(0, 10);
    if (!d || d <= saved.watermark) return n;
    return rulingMatches(saved, r) ? n + 1 : n;
  }, 0);
}

/** A short human description of the filters, for the saved-search chip. */
export function describeFilters(filters = {}) {
  const parts = [];
  if (filters.therapyAreas?.length)      parts.push(filters.therapyAreas.join(", "));
  if (filters.outcomes?.length)          parts.push(filters.outcomes.join(", "));
  if (filters.dossierCategories?.length) parts.push(`${filters.dossierCategories.length} dossier type(s)`);
  if (filters.manufacturer)              parts.push(filters.manufacturerLabel || filters.manufacturer);
  if (filters.onlyPico)                  parts.push("has a stated PICO");
  if (filters.years?.length)             parts.push(filters.years.join(", "));
  return parts.join(" · ");
}
 