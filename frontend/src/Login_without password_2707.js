import { useState } from "react";
import { useNavigate } from "react-router-dom";
import AZLogo from "./AZ_logo.png";

function Login() {
  const navigate = useNavigate();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/authenticate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (response.ok) {
        const data = await response.json();
        localStorage.setItem("loggedIn", "true");
        localStorage.setItem("role", data.role);
        navigate("/");
      } else {
        setError("Invalid username or password");
      }
    } catch (err) {
      setError("Authentication service unavailable. Please try again later.");
    } finally {
      setLoading(false);
    }
  };

  // Allow login via Enter key press
  const handleKeyDown = (e) => {
    if (e.key === "Enter") handleLogin();
  };

  const styles = {
    page: {
      minHeight: "100vh",
      background: "linear-gradient(135deg, #830051 0%, #3b1a6e 60%, #1a0a3c 100%)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "Arial, sans-serif",
    },
    card: {
      background: "white",
      borderRadius: "16px",
      padding: "48px 40px",
      width: "100%",
      maxWidth: "400px",
      boxShadow: "0 20px 60px rgba(0, 0, 0, 0.3)",
      textAlign: "center",
    },
    logoWrapper: {
      marginBottom: "16px",
      display: "flex",
      justifyContent: "center",
    },
    title: {
      fontSize: "22px",
      fontWeight: "bold",
      color: "#830051",
      margin: "0 0 8px 0",
    },
    tagline: {
      fontSize: "13px",
      color: "#777",
      marginBottom: "28px",
      fontStyle: "italic",
    },
    input: {
      width: "100%",
      padding: "12px 14px",
      margin: "8px 0",
      borderRadius: "8px",
      border: "1px solid #ddd",
      fontSize: "14px",
      boxSizing: "border-box",
      outline: "none",
      transition: "border 0.2s",
    },
    button: {
      width: "100%",
      padding: "13px",
      marginTop: "20px",
      backgroundColor: loading ? "#b07090" : "#830051",
      color: "white",
      border: "none",
      borderRadius: "8px",
      fontSize: "15px",
      fontWeight: "bold",
      cursor: loading ? "not-allowed" : "pointer",
      letterSpacing: "0.5px",
      transition: "background 0.2s",
    },
    error: {
      color: "#d32f2f",
      fontSize: "13px",
      marginTop: "12px",
    },
    divider: {
      borderTop: "1px solid #eee",
      margin: "24px 0 16px 0",
    },
    footer: {
      fontSize: "11px",
      color: "#aaa",
    },
  };

  return (
    <div style={styles.page}>
      <div style={styles.card}>

        {/* AZ Logo */}
        <div style={styles.logoWrapper}>
          <img src={AZLogo} alt="AstraZeneca Logo" style={{ width: "80px", height: "auto" }} />
        </div>

        {/* Title */}
        <h2 style={styles.title}>Welcome to HTA Navigator</h2>

        {/* One-line tagline */}
        <p style={styles.tagline}>
          Your intelligent guide to Health Technology Assessment insights.
        </p>

        {/* Username Input */}
        <input
          type="text"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onKeyDown={handleKeyDown}
          style={styles.input}
          onFocus={(e) => (e.target.style.border = "1px solid #830051")}
          onBlur={(e) => (e.target.style.border = "1px solid #ddd")}
          disabled={loading}
        />

        {/* Password Input */}
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={handleKeyDown}
          style={styles.input}
          onFocus={(e) => (e.target.style.border = "1px solid #830051")}
          onBlur={(e) => (e.target.style.border = "1px solid #ddd")}
          disabled={loading}
        />

        {/* Login Button */}
        <button
          onClick={handleLogin}
          style={styles.button}
          disabled={loading}
          onMouseEnter={(e) => {
            if (!loading) e.target.style.backgroundColor = "#5c0038";
          }}
          onMouseLeave={(e) => {
            if (!loading) e.target.style.backgroundColor = "#830051";
          }}
        >
          {loading ? "Authenticating..." : "Login"}
        </button>

        {/* Error Message */}
        {error && <p style={styles.error}>⚠️ {error}</p>}

        {/* Footer */}
        <div style={styles.divider} />
        <p style={styles.footer}>© 2026 AstraZeneca. All rights reserved.</p>

      </div>
    </div>
  );
}

export default Login;