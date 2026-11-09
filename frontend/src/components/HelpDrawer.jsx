/**
 * HelpDrawer.jsx — Sr 6 / Sr 92
 * ─────────────────────────────────────────────────────────────────────────────
 * Contextual help: a floating button on every screen and a right-hand drawer
 * whose opening paragraph changes with the route.
 *
 * Why this exists: HTA Navigator is used occasionally — a dossier every few
 * months — so people forget the product between visits. The drawer is also
 * where the AI-transparency statements sit in language someone will actually
 * read, rather than buried in a help centre nobody opens.
 *
 * `.v2-help-fab` and `.v2-drawer` are defined in App.css.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

// ─── Per-route context copy ───────────────────────────────────────────────────
// Keyed by route prefix, longest match wins, so /ruling/:id resolves before /.
const CTX = {
  "/sessions":
    "Your sessions, in progress and completed. Each one holds the rulings you saved, " +
    "the questions generated from them and your draft answers. Expand a session to see " +
    "every research question asked under it.",
  "/search":
    "One unrestricted free-text search for questions, product names or keywords. Attach a " +
    "dossier-review file here to categorise the matched rulings against your question and " +
    "carry that context into Q&A.",
  "/ruling":
    "The ruling summary opens inside search, so your query, filters and place in the result " +
    "set stay alive. Every AI summary links to the passage it came from.",
  "/qa-generator":
    "Your search question, selected rulings and dossier-review category carry over from " +
    "Ruling Search. Additional context stays optional and separate.",
  "/readiness":
    "Readiness is scored per research question, not per session. Each dossier category is " +
    "assessed against what comparable rulings show the committee expecting, and actions are " +
    "ordered by point impact.",
  "/insights":
    "Set the period at the top right. Hover any metric label to see how it is calculated and " +
    "which denominator it uses.",
  "/help":
    "Guides, glossary, AI limitations, release notes and support in one place.",
  "/":
    "Home opens on your own work — what is in progress and what to do next — with the corpus " +
    "counters below. Every count is clickable and runs the matching filtered search.",
};

function contextFor(pathname) {
  const match = Object.keys(CTX)
    .filter((prefix) => prefix !== "/" && pathname.startsWith(prefix))
    .sort((a, b) => b.length - a.length)[0];
  return CTX[match] || CTX["/"];
}

// ─── Static content ───────────────────────────────────────────────────────────
const QUICK_ANSWERS = [
  {
    q: "Where do answers come from?",
    a: "The published ZIN rulings in the index, plus the context you enter on your session. " +
       "Nothing is drawn from the open internet or from other customers' data. Every output is cited.",
  },
  {
    q: "Can I trust a draft response?",
    a: "Treat it as a starting point. Open the citations and check the wording before it goes " +
       "anywhere near a dossier.",
  },
  {
    q: "How do I check a citation?",
    a: "Select any purple citation chip to open the source passage it was drawn from.",
  },
  {
    q: "What is the AI not good at?",
    a: "It cannot see confidential arrangement prices, so budget-impact reasoning uses list prices. " +
       "It reasons only over published Dutch rulings. Where fewer than five comparable precedents " +
       "exist, confidence is marked low — treat the output as a prompt for your own analysis.",
  },
];

const SHORTCUTS = [
  { k: "?",      d: "Open this panel" },
  { k: "Esc",    d: "Close this panel" },
  { k: "G then S", d: "Go to ruling search" },
];

export default function HelpDrawer() {
  const [open, setOpen]   = useState(false);
  const location          = useLocation();
  const navigate          = useNavigate();
  const contextCopy       = useMemo(() => contextFor(location.pathname), [location.pathname]);

  const close = useCallback(() => setOpen(false), []);

  // "?" opens the panel, Esc closes it. Typing a "?" into a field must not
  // trigger it, so inputs, textareas and contenteditable are excluded.
  useEffect(() => {
    const onKey = (e) => {
      const el       = document.activeElement;
      const tag      = el?.tagName || "";
      const isTyping = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || el?.isContentEditable;

      if (e.key === "Escape") { setOpen(false); return; }
      if (e.key === "?" && !isTyping && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <button
        type="button"
        className="v2-help-fab"
        onClick={() => setOpen(true)}
        aria-label="Help for this screen"
        aria-expanded={open}
        data-testid="help-fab"
      >
        ?
      </button>

      <aside
        className={`v2-drawer${open ? " open" : ""}`}
        aria-hidden={!open}
        aria-label="Help for this screen"
        data-testid="help-drawer"
      >
        <header>
          <b>Help for this screen</b>
          <button type="button" className="v2-btn v2-ghost v2-sm" onClick={close}>Close</button>
        </header>

        <div className="c">
          <div className="v2-banner" style={{ marginBottom: 14 }}>
            <span aria-hidden="true">◈</span>
            <div data-testid="help-context">{contextCopy}</div>
          </div>

          <h3>Quick answers</h3>
          <div className="v2-kv" style={{ marginBottom: 16 }}>
            {QUICK_ANSWERS.map(({ q, a }) => (
              <div key={q}>
                <b>{q}</b>
                <span>{a}</span>
              </div>
            ))}
          </div>

          <h3>Keyboard</h3>
          <div className="v2-kv">
            {SHORTCUTS.map(({ k, d }) => (
              <div key={k}>
                <b>{k}</b>
                <span>{d}</span>
              </div>
            ))}
          </div>

          <button
            type="button"
            className="v2-btn"
            style={{ width: "100%", marginTop: 16 }}
            onClick={() => { close(); navigate("/help"); }}
          >
            Open the full help centre
          </button>
        </div>
      </aside>
    </>
  );
}
