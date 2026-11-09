/**
 * Help.jsx — v2
 * -------------
 * Matches hta_navigator_redesign_5.html #v-help.
 * Tiles + FAQ accordions + keyboard shortcuts.
 */
import { useState } from "react";

function Acc({ title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`v2-acc${open ? " open" : ""}`}>
      <button type="button" onClick={() => setOpen(o => !o)}>
        <span>{title}</span>
        <span>{open ? "−" : "+"}</span>
      </button>
      <div className="body">{children}</div>
    </div>
  );
}

export default function Help() {
  return (
    <div data-testid="help-page">
      <div className="v2-crumb">Support / Help &amp; guides</div>
      <h1>Help &amp; guides</h1>
      <p className="v2-sub">Everything about using HTA Navigator, what the AI can and cannot do, and how to get support.</p>

      {/* ── Tile shortcuts ───────────────────────────────────────────── */}
      <div className="v2-tiles" style={{ marginBottom: 20 }}>
        <button className="v2-tile" type="button">
          <div className="i">▷</div>
          <b>Guided tour · 4 min</b>
          <span>Walk through search, ruling summaries and question generation with a worked example.</span>
        </button>
        <button className="v2-tile" type="button">
          <div className="i">◈</div>
          <b>Playbook</b>
          <span>Market access lead, HEOR analyst or regulatory writer — start here.</span>
        </button>
        <button className="v2-tile" type="button">
          <div className="i">✦</div>
          <b>How the AI works</b>
          <span>Where answers come from, what it will not do, and how to check it.</span>
        </button>
        <button className="v2-tile" type="button">
          <div className="i">⌘</div>
          <b>Shortcuts</b>
          <span>Navigate quickly — keyboard shortcuts and tips for writing better search queries.</span>
        </button>
      </div>

      {/* ── FAQ ─────────────────────────────────────────────────────── */}
      <h2>Common questions</h2>

      <Acc defaultOpen title="Where do the answers come from?">
        Every summary, predicted question and draft response is generated from the 487 published ZIN assessment reports in the index, plus the context you enter on your session. Nothing is drawn from the open internet or from other customers' data. Each output carries citation chips; selecting one opens the exact passage it was drawn from, so you can confirm the wording before you use it.
      </Acc>

      <Acc title="Can I put a draft response straight into a dossier?">
        Not without checking it. Drafts are starting points generated from precedent. Open each citation, confirm the wording, and edit the text to your own case before it enters a dossier.
      </Acc>

      <Acc title="How do I start a session?">
        Three ways, and none of them needs a form filled in first. Search for the precedent you care about and use "Start a session from this search", which carries your question, filters and selected rulings across. Or save any single ruling and choose "Start a new session" in the picker. Or use "Start a session" on the home page. Whichever route you take, the bar at the top of every screen shows which session is open.
      </Acc>

      <Acc title="What is the AI not good at?">
        Three known limits. It cannot see confidential arrangement prices, so budget-impact reasoning is based on list prices. It reasons only over published Dutch rulings, so it will not tell you how NICE or the G-BA would react. And where fewer than five comparable precedents exist, confidence is marked low and you should treat the output as a prompt for your own analysis rather than a finding.
      </Acc>

      <Acc title="How current is the ruling index?">
        The index refreshes every weekday morning. The date in the top bar shows the most recent published ruling captured. Individual rulings show when they were last verified against the source PDF.
      </Acc>

      <Acc title="How is the readiness score calculated?">
        Each of the three dossier types is scored separately against what comparable rulings show the committee expecting, then combined. It is an alignment score against precedent, not a probability of approval, and it is never shown without the three component scores that produced it.
      </Acc>

      {/* ── Keyboard shortcuts ──────────────────────────────────────── */}
      <h2 style={{ marginTop: 24 }}>Keyboard shortcuts</h2>
      <div className="v2-card">
        {[
          ["Ctrl / ⌘ + Enter", "Run the current AI query or search"],
          ["?",                 "Open help panel from any screen"],
          ["Esc",              "Close modal or help panel"],
        ].map(([keys, desc]) => (
          <div key={keys} style={{ display: "flex", alignItems: "center", gap: 14, padding: "10px 16px", borderBottom: "1px solid var(--line)" }}>
            <kbd style={{ fontFamily: "inherit", fontWeight: 700, fontSize: 11.5, background: "#EAE7F0", borderRadius: 5, padding: "3px 8px", minWidth: 160, display: "inline-block" }}>{keys}</kbd>
            <span style={{ fontSize: 13, color: "var(--ink-2)" }}>{desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
