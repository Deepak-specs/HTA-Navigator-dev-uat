import { useState } from "react";
import { useNavigate } from "react-router-dom";
import AZLogo from "./AZ_logo.png";   // ✅ FIXED: import the PNG file

// // AZ Logo as an inline SVG component (official AstraZeneca wordmark style)
// const AZLogo = () => (
//   <svg width="80" height="80" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
//     <circle cx="50" cy="50" r="48" fill="#830051" />
//     <text
//       x="50%"
//       y="55%"
//       dominantBaseline="middle"
//       textAnchor="middle"
//       fontSize="32"
//       fontWeight="bold"
//       fontFamily="Arial, sans-serif"
//       fill="white"
//     >
//       AZ
//     </text>
//   </svg>
// );

function Login() {
  const navigate = useNavigate();

  // const USERNAME = "admin";
  // const PASSWORD = "12345";
  
  const USERS = [
  { username: "admin", password: "12345", role: "admin" },
  { username: "HTAUser", password: "12345", role: "reviewer" }
    // Add more users here as needed
];

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  // const handleLogin = () => {
  //   if (username === USERNAME && password === PASSWORD) {
  //     localStorage.setItem("loggedIn", "true");
  //     navigate("/");
  //   } else {
  //     setError("Invalid username or password");
  //   }
  // };

  const handleLogin = () => {
  const matchedUser = USERS.find(
    (user) => user.username === username && user.password === password
  );

  if (matchedUser) {
    localStorage.setItem("loggedIn", "true");
    localStorage.setItem("role", matchedUser.role); // optional: store role
    localStorage.setItem("username", matchedUser.username); // shown in the top bar
    localStorage.removeItem("disclaimerAccepted");
    navigate("/welcome");
  } else {
    setError("Invalid username or password");
  }
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
          style={styles.input}
          onFocus={(e) => (e.target.style.border = "1px solid #830051")}
          onBlur={(e) => (e.target.style.border = "1px solid #ddd")}
        />

        {/* Password Input */}
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={styles.input}
          onFocus={(e) => (e.target.style.border = "1px solid #830051")}
          onBlur={(e) => (e.target.style.border = "1px solid #ddd")}
        />

        {/* Login Button */}
        <button
          onClick={handleLogin}
          style={styles.button}
          onMouseEnter={(e) => (e.target.style.backgroundColor = "#5c0038")}
          onMouseLeave={(e) => (e.target.style.backgroundColor = "#830051")}
        >
          Login
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