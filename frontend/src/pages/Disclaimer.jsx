import {
  DISCLAIMER_INTRO, DISCLAIMER_WARN_TITLE, DISCLAIMER_WARN_TEXT,
  DISCLAIMER_OVERVIEW, DISCLAIMER_NOTE,
} from "../lib/disclaimerContent";

export default function Disclaimer() {
  return (
    <div data-testid="disclaimer-page">
      <div className="v2-hdr">
        <div>
          <div className="v2-crumb">Support</div>
          <h1>Disclaimer</h1>
          <p className="v2-sub">
            The terms you agreed to when you signed in. Revisit them at any time.
          </p>
        </div>
      </div>
      <div className="v2-card v2-pad" style={{ maxWidth: 860 }}>
        <p style={{ margin: "0 0 16px", color: "var(--ink-2)" }}>{DISCLAIMER_INTRO}</p>

        <div className="v2-banner">
          <div>
            <b>{DISCLAIMER_WARN_TITLE}</b>
            <div>{DISCLAIMER_WARN_TEXT}</div>
          </div>
        </div>

        <h3 style={{ marginTop: 20 }}>Overview</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {DISCLAIMER_OVERVIEW.map(([label, text]) => (
            <div key={label} style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55 }}>
              <b style={{ color: "var(--ink)" }}>{label}:</b> {text}
            </div>
          ))}
        </div>
        <br />
        <p style={{ marginTop: 18, fontSize: 12, fontStyle: "italic", color: "var(--muted)" }}>
          {DISCLAIMER_NOTE}
        </p>
      </div>
    </div>
  );
}