/**
 * qaMeta.js — Sr 79
 * ─────────────────────────────────────────────────────────────────────────────
 * Per-dossier display metadata, shared by the Q&A page and the PDF export.
 *
 * The RGB triples are the single source of truth. The PDF reads `rgb` and
 * `rgbLight` directly; the page reads the `hex*` fields, which are DERIVED from
 * those same triples at module load. That is deliberate — the Phase 6 rewrite
 * dropped the page's colour classes and left them only in the export, so the
 * Q&A screen rendered every dossier in the same grey while the PDF came out
 * colour-coded. Deriving one from the other means they can no longer drift.
 *
 * `ink` is the only value that is not derived: a 500-weight hue is too light to
 * read as text on its own tint, so each category carries a 700-weight pair.
 */
import { categoryCode } from "./dossierCategories";

const toHex = (rgb) =>
  "#" + rgb.map((n) => Math.round(n).toString(16).padStart(2, "0")).join("").toUpperCase();

function build({ rgb, rgbLight, ink, name, framework }) {
  return Object.freeze({
    name,
    framework,
    rgb,
    rgbLight,
    hex:       toHex(rgb),        // solid fill — group headers, PDF banners
    hexLight:  toHex(rgbLight),   // tint — chip backgrounds
    hexInk:    ink,               // readable text on the tint
    hexBorder: toHex(rgb),        // chip border
  });
}

const DOSSIER_META = Object.freeze({
  FT: build({
    name:      "Pharmacotherapeutic Dossier",
    framework: "FT",
    rgb:       [59, 130, 246],    // blue 500
    rgbLight:  [233, 242, 254],
    ink:       "#1D4ED8",         // blue 700
  }),
  BIA: build({
    name:      "Budget Impact Dossier",
    framework: "BIA",
    rgb:       [16, 185, 129],    // emerald 500
    rgbLight:  [236, 253, 245],
    ink:       "#047857",         // emerald 700
  }),
  FE: build({
    name:      "Pharmacoeconomic Dossier",
    framework: "FE",
    rgb:       [168, 85, 247],    // purple 500
    rgbLight:  [250, 245, 255],
    ink:       "#7E22CE",         // purple 700
  }),
});

const DEFAULT_META = build({
  name:      "Uncategorised",
  framework: null,
  rgb:       [148, 163, 184],     // slate 400
  rgbLight:  [248, 250, 252],
  ink:       "#475569",           // slate 600
});

/** FT / FE / BIA → display metadata. Unknown codes fall back to slate. */
const getMeta = (code) => DOSSIER_META[code] || DEFAULT_META;

/**
 * Backend category value OR display label → display metadata.
 *
 * The page groups by label ("Pharmacotherapeutic Dossier") while the generator
 * returns codes ("FT"), so colour lookups need to work from either end.
 *
 * `fallbackCode` covers a category the user named themselves: "Cost-Effective
 * Dossier" has no code of its own, but the question still came out of a known
 * dossier, and colouring it slate while its group header is purple reads as a
 * rendering fault.
 */
const getMetaForCategory = (value, fallbackCode) =>
  getMeta(categoryCode(value) || fallbackCode);

export { DOSSIER_META, DEFAULT_META, getMeta, getMetaForCategory };
