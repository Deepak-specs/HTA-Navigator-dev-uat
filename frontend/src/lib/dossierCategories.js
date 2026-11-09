/**
 * dossierCategories.js — Sr 5
 * ─────────────────────────────────────────────────────────────────────────────
 * One place that reconciles three different vocabularies for the same idea.
 *
 *   Neo4j / backend   "Clinical Value Pharmaco therapeutic", "Pharmaco-economic",
 *                     "Budget Impact", "No Category"
 *   redesign_7 UI     "Pharmacotherapeutic Dossier", "Pharmacoeconomic Dossier",
 *                     "Budget Impact Dossier", "Cross-dossier Review"
 *   generate_qa       "FT", "FE", "BIA"
 *
 * We map rather than rename. The raw strings are stored as Neo4j node
 * properties, mirrored in `DossierCategoryEnum`, and string-matched inside
 * `generate_qa`; renaming them would mean a data migration to change a label.
 *
 * CROSS-DOSSIER REVIEW IS NOT A DATA VALUE. It is a review mode the user picks
 * when their research question spans more than one dossier component. Sending
 * it as a `dossier_category` filter matches nothing in Neo4j and silently
 * returns an empty result set — use `isReviewMode()` to keep it out of queries.
 */

export const CROSS_DOSSIER = "Cross-dossier Review";

/** Canonical categories, in the order the design lists them. */
export const DOSSIER_CATEGORIES = [
  {
    value: "Clinical Value Pharmaco therapeutic",
    label: "Pharmacotherapeutic Dossier",
    short: "Pharmacotherapeutic",
    code:  "FT",
    isReviewMode: false,
  },
  {
    value: "Pharmaco-economic",
    label: "Pharmacoeconomic Dossier",
    short: "Pharmacoeconomic",
    code:  "FE",
    isReviewMode: false,
  },
  {
    value: "Budget Impact",
    label: "Budget Impact Dossier",
    short: "Budget Impact",
    code:  "BIA",
    isReviewMode: false,
  },
  {
    value: "No Category",
    label: "Uncategorised",
    short: "Uncategorised",
    code:  null,
    isReviewMode: false,
  },
  {
    value: CROSS_DOSSIER,
    label: CROSS_DOSSIER,
    short: "Cross-dossier",
    code:  null,
    isReviewMode: true,
  },
];

const BY_VALUE = new Map(DOSSIER_CATEGORIES.map((c) => [c.value.toLowerCase(), c]));
const BY_LABEL = new Map(DOSSIER_CATEGORIES.map((c) => [c.label.toLowerCase(), c]));

/** Backend value (or a label, or a custom name) → display label. */
export function categoryLabel(value) {
  if (!value) return "";
  const hit = BY_VALUE.get(String(value).toLowerCase());
  return hit ? hit.label : String(value); // custom categories pass through
}

/** Display label → backend value. Unknown names pass through unchanged. */
export function categoryValue(label) {
  if (!label) return "";
  const hit = BY_LABEL.get(String(label).toLowerCase());
  return hit ? hit.value : String(label);
}

/** The FT / FE / BIA code `generate_qa` expects, or null. */
export function categoryCode(value) {
  const hit = BY_VALUE.get(String(value || "").toLowerCase())
           || BY_LABEL.get(String(value || "").toLowerCase());
  return hit ? hit.code : null;
}

/**
 * FT / FE / BIA → the backend category value, or "" when the code is unknown.
 *
 * `generate_qa` returns its results grouped by dossier code and does not repeat
 * the category on each question, so without this reverse lookup every generated
 * question arrived with an empty `dossier_category` and the Q&A page filed the
 * whole set under "Uncategorised".
 */
const BY_CODE = new Map(
  DOSSIER_CATEGORIES.filter((c) => c.code).map((c) => [c.code.toUpperCase(), c])
);

export function categoryFromCode(code) {
  const hit = BY_CODE.get(String(code || "").trim().toUpperCase());
  return hit ? hit.value : "";
}

/**
 * True when this category is a review mode rather than a stored value.
 * Callers MUST check this before using a category as a query filter.
 */
export function isReviewMode(value) {
  const hit = BY_VALUE.get(String(value || "").toLowerCase())
           || BY_LABEL.get(String(value || "").toLowerCase());
  return hit ? hit.isReviewMode : false;
}

/**
 * Strips review modes out of a list of categories destined for a backend
 * filter, so a cross-dossier selection never empties the result set.
 */
export function filterableCategories(values = []) {
  return values.filter((v) => v && !isReviewMode(v));
}

/** Selectable options for a <select>, backend values plus any custom names. */
export function categoryOptions(customCategories = []) {
  const base = DOSSIER_CATEGORIES.map(({ value, label, isReviewMode: rm }) => ({
    value, label, isReviewMode: rm, custom: false,
  }));
  const seen = new Set(base.map((o) => o.label.toLowerCase()));
  const extra = customCategories
    .filter((name) => name && !seen.has(String(name).toLowerCase()))
    .map((name) => ({ value: name, label: name, isReviewMode: false, custom: true }));
  return [...base, ...extra];
}

// ─── Category inference ───────────────────────────────────────────────────────
// Suggests a review category from the wording of the research question, so the
// user starts from a sensible default instead of an empty control. Ported from
// the mockup's `inferDossierCategory`, ordered most-specific first: budget
// language wins over economic language, which wins over clinical language.

const BUDGET_RE   = /budget|uptake|penetration|population size|financial impact|volume|eligible patients/i;
const ECONOMIC_RE = /icer|cost.?effect|cost per|economic|qaly|utilit|threshold|incremental cost|price arrangement/i;
const CLINICAL_RE = /comparator|clinical|therapeutic|endpoint|pico|efficac|safety|subgroup|trial|evidence|guideline/i;

// The same three rules, addressable one at a time so a *category name* can be
// matched without the "two hits means cross-dossier" rule that applies to a
// free-text question. A name like "Cost-Effective Dossier" names one component;
// a question mentioning both cost and comparators genuinely spans two.
const NAME_RULES = [
  { re: BUDGET_RE,   value: "Budget Impact" },
  { re: ECONOMIC_RE, value: "Pharmaco-economic" },
  { re: CLINICAL_RE, value: "Clinical Value Pharmaco therapeutic" },
];

/**
 * A user-invented category name → the canonical category it describes, or "".
 *
 * Only an unambiguous name resolves: "Cost-Effective Dossier" clearly means the
 * pharmacoeconomic component, whereas a name hitting two rules, or none, is left
 * for the caller to handle as a genuinely new category.
 *
 * @param {string} name a category label, including custom ones
 * @returns {string} a backend category value, or ""
 */
export function inferCategoryFromName(name) {
  const n = String(name || "");
  if (!n.trim()) return "";
  const hits = NAME_RULES.filter((r) => r.re.test(n));
  return hits.length === 1 ? hits[0].value : "";
}

/**
 * Resolves any category the user may have chosen — canonical, review mode, or a
 * name they typed themselves — into everything a caller needs to act on it.
 *
 * This exists because a custom category used to resolve to nothing at all:
 * `categoryCode` returned null, the generator sent an empty filter, and the
 * backend fell back to generating all three dossiers. The user's choice had no
 * effect and their questions came back labelled by someone else's vocabulary.
 *
 * @param {string} name
 * @returns {{value: string, label: string, code: string|null,
 *            isCustom: boolean, isReview: boolean, matchedVia: string}}
 *   `code`   the FT/FE/BIA code to generate, or null to generate all three.
 *   `value`  what generated questions should be filed under.
 *   `matchedVia` "none" | "canonical" | "review" | "inferred" | "custom"
 */
export function resolveCategory(name) {
  const raw = String(name || "").trim();
  const empty = {
    value: "", label: "", code: null,
    isCustom: false, isReview: false, matchedVia: "none",
  };
  if (!raw) return empty;

  const hit = BY_VALUE.get(raw.toLowerCase()) || BY_LABEL.get(raw.toLowerCase());
  if (hit) {
    return {
      value: hit.value,
      label: hit.label,
      // A review mode spans components, so it deliberately generates all three.
      code: hit.isReviewMode ? null : hit.code,
      isCustom: false,
      isReview: hit.isReviewMode,
      matchedVia: hit.isReviewMode ? "review" : "canonical",
    };
  }

  // A name the user invented. Keep their wording as the label — it is what they
  // will look for on screen — but back it with a real dossier type where the
  // name says which one.
  const inferred = inferCategoryFromName(raw);
  const backing  = inferred ? BY_VALUE.get(inferred.toLowerCase()) : null;
  return {
    value: raw,
    label: raw,
    code: backing ? backing.code : null,
    isCustom: true,
    isReview: false,
    matchedVia: backing ? "inferred" : "custom",
  };
}

/**
 * @param {string} question free-text research question
 * @returns {string} a backend category value, or CROSS_DOSSIER when the
 *                   question spans components or matches nothing specific
 */
export function inferDossierCategory(question) {
  const q = String(question || "");
  if (!q.trim()) return CROSS_DOSSIER;

  const hits = [
    BUDGET_RE.test(q)   && "Budget Impact",
    ECONOMIC_RE.test(q) && "Pharmaco-economic",
    CLINICAL_RE.test(q) && "Clinical Value Pharmaco therapeutic",
  ].filter(Boolean);

  // A question touching more than one component is genuinely cross-dossier —
  // that is the case the fourth category exists for.
  if (hits.length !== 1) return CROSS_DOSSIER;
  return hits[0];
}
