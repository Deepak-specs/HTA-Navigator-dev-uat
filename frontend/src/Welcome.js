import { useNavigate } from "react-router-dom";
import AZLogo from "./AZ_logo.png";
import {
  DISCLAIMER_INTRO, DISCLAIMER_WARN_TITLE, DISCLAIMER_WARN_TEXT,
  DISCLAIMER_OVERVIEW, DISCLAIMER_NOTE,
} from "./lib/disclaimerContent";

function Welcome() {
  const navigate = useNavigate();

  const handleAgree = () => {
    // Remembered for this login only; Login.js clears nothing, so logout should remove it.
    localStorage.setItem("disclaimerAccepted", "true");
    navigate("/");
  };



  const styles = {
    page: {
      minHeight: "100vh",
      background: "linear-gradient(135deg, #830051 0%, #3b1a6e 60%, #1a0a3c 100%)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "Arial, sans-serif",
      padding: "24px 16px",
      boxSizing: "border-box",
    },
    card: {
      background: "white",
      borderRadius: "16px",
      padding: "40px 44px",
      width: "100%",
      maxWidth: "760px",
      boxShadow: "0 20px 60px rgba(0, 0, 0, 0.3)",
      boxSizing: "border-box",
    },
    logoWrapper: {
      display: "flex",
      justifyContent: "center",
      marginBottom: "16px",
    },
    title: {
      fontSize: "22px",
      fontWeight: "bold",
      color: "#830051",
      margin: "0 0 8px 0",
      textAlign: "center",
    },
    intro: {
      fontSize: "13.5px",
      color: "#444",
      lineHeight: 1.55,
      margin: "0 0 18px 0",
      textAlign: "center",
    },
    warnBox: {
      background: "#fdf2f8",
      borderLeft: "4px solid #830051",
      borderRadius: "6px",
      padding: "12px 14px",
      marginBottom: "20px",
    },
    warnTitle: {
      fontSize: "14px",
      fontWeight: "bold",
      color: "#830051",
      margin: "0 0 4px 0",
    },
    warnText: {
      fontSize: "13px",
      color: "#444",
      lineHeight: 1.5,
      margin: 0,
    },
    overviewTitle: {
      fontSize: "13px",
      fontWeight: "bold",
      color: "#830051",
      margin: "0 0 8px 0",
      textTransform: "uppercase",
      letterSpacing: "0.5px",
    },
    list: {
      listStyle: "none",
      margin: "0 0 14px 0",
      padding: 0,
      maxHeight: "300px",
      overflowY: "auto",
      paddingRight: "6px",
    },
    item: {
      fontSize: "12.5px",
      color: "#444",
      lineHeight: 1.5,
      marginBottom: "6px",
    },
    note: {
      fontSize: "12px",
      color: "#777",
      fontStyle: "italic",
      margin: "0 0 4px 0",
      textAlign: "center",
    },
    button: {
      display: "block",
      width: "100%",
      maxWidth: "260px",
      margin: "22px auto 0",
      padding: "13px",
      backgroundColor: "#830051",
      color: "white",
      border: "none",
      borderRadius: "8px",
      fontSize: "15px",
      fontWeight: "bold",
      cursor: "pointer",
      letterSpacing: "0.5px",
      transition: "background 0.2s",
    },
    divider: {
      borderTop: "1px solid #eee",
      margin: "24px 0 16px 0",
    },
    footer: {
      fontSize: "11px",
      color: "#aaa",
      textAlign: "center",
      margin: 0,
    },
  };

  return (
    <div style={styles.page}>
      <div style={styles.card}>

        <div style={styles.logoWrapper}>
          <img src={AZLogo} alt="AstraZeneca Logo" style={{ width: "80px", height: "auto" }} />
        </div>

        <h2 style={styles.title}>Welcome to HTA Navigator!</h2>

        <p style={styles.intro}>{DISCLAIMER_INTRO}</p>

        <div style={styles.warnBox}>
          <p style={styles.warnTitle}>{DISCLAIMER_WARN_TITLE}</p>
          <p style={styles.warnText}>{DISCLAIMER_WARN_TEXT}</p>
        </div>

        <h3 style={styles.overviewTitle}>Overview</h3>
        <ul style={styles.list}>
          {DISCLAIMER_OVERVIEW.map(([label, text]) =>
            <li key={label} style={styles.item}>
              <strong>{label}:</strong> {text}
            </li>
          )}
        </ul>

        <p style={styles.note}>{DISCLAIMER_NOTE}</p>

        <button
          onClick={handleAgree}
          style={styles.button}
          onMouseEnter={(e) => (e.target.style.backgroundColor = "#5c0038")}
          onMouseLeave={(e) => (e.target.style.backgroundColor = "#830051")}
        >
          Agree and Continue
        </button>

        <div style={styles.divider} />
        <p style={styles.footer}>© 2026 AstraZeneca. All rights reserved.</p>

      </div>
    </div>
  );
}

export default Welcome;