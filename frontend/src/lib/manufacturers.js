/**
 * manufacturers.js — folding ZIN manufacturer spellings to one company
 * ─────────────────────────────────────────────────────────────────────────────
 * The corpus records 207 distinct manufacturer strings across the 364 rulings
 * that name one, but most of that spread is legal-entity spelling rather than
 * distinct companies. Gilead files under five names:
 *
 *   Gilead Sciences (8) · Gilead (7) · Gilead Sciences Netherlands B.V. (3)
 *   Gilead BV (1) · Gilead Sciences Netherlands BV (1)
 *
 * Ranked on the raw strings, the largest of those is 8 and the company looks
 * like a minor filer; folded, it is 20 and the largest in the corpus. Folding
 * takes 207 names to 145.
 *
 * This lives in lib/ rather than in a page because Insights ranks on it and
 * Ruling Search filters on it. Two copies would drift, and the filter exists
 * precisely so the chart can be cross-checked — a check that proves nothing if
 * the two sides fold differently.
 *
 * Scope: ONLY entity suffixes are folded. "Janssen" and "Janssen-Cilag" stay
 * separate, as do "Janssen" and "Johnson & Johnson". Merging distinct corporate
 * filers is a commercial judgement the data does not support, and a count alone
 * would never reveal it had been made — which is why variantsOf() exists.
 */

const SUFFIX =
  /\b(b v|n v|bv|nv|ltd|limited|inc|llc|gmbh|sas|sa|a\/s|ab|oy|plc|pharmaceuticals?|pharma|biosciences?|sciences?|biotech|therapeutics|healthcare|health|international|europe|nederland|netherlands|benelux|holding|group|corp|company|co)\b/g;

/** Folded key for one raw manufacturer string. "" when there is no usable name. */
export function normaliseManufacturer(raw) {
  const name = String(raw ?? "").trim();
  if (!name || name === "Unknown") return "";
  let s = name.toLowerCase().replace(/&/g, " and ").replace(/[.,]/g, " ");
  s = s.replace(/[^a-z0-9 /-]/g, " ").replace(/\s+/g, " ").trim();
  // Three passes: "Novartis Pharma B.V." sheds "pharma" and "b v" in turn.
  for (let i = 0; i < 3; i += 1) s = s.replace(SUFFIX, " ");
  return s.replace(/\s+/g, " ").trim();
}

/**
 * key → { label, variants } over the WHOLE corpus, never a filtered slice.
 * Resolving labels inside a slice let a company rename itself as the filter
 * moved: AstraZeneca showed as "AstraZeneca" over 24 months and "AstraZeneca
 * b.v." over 12, because that was the shortest spelling present in each span.
 * The label with the least entity-suffix cruft wins, measured against the
 * folded key, so one company carries one name everywhere.
 */
export function manufacturerLabels(allRows) {
  const byKey = new Map();
  (allRows || []).forEach((r) => {
    const key = normaliseManufacturer(r?.manufacturer);
    if (!key) return;
    const set = byKey.get(key) ?? new Set();
    set.add(String(r.manufacturer).trim());
    byKey.set(key, set);
  });
  const out = new Map();
  byKey.forEach((set, key) => {
    const label = [...set].sort(
      (a, b) => (a.length - key.length) - (b.length - key.length) || a.localeCompare(b)
    )[0];
    out.set(key, { label, variants: [...set].sort() });
  });
  return out;
}

/**
 * One row per company for a filter list: folded key, display label, how many
 * rulings it covers, and the raw spellings folded into it.
 *
 * `variants` is the part that makes the filter a real check rather than a
 * restatement: a count cannot show that two companies were wrongly merged, but
 * the spelling list can.
 */
export function manufacturerOptions(rows) {
  const labels = manufacturerLabels(rows);
  const counts = new Map();
  (rows || []).forEach((r) => {
    const key = normaliseManufacturer(r?.manufacturer);
    if (!key) return;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return [...counts.entries()]
    .map(([key, count]) => ({
      key,
      label: labels.get(key)?.label ?? key,
      variants: labels.get(key)?.variants ?? [],
      count,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
