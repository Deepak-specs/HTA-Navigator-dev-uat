// for login created auth folder. there 2 files are there for login - AuthContext.jsx, RequireAuth.jsx
// in pages folder created Login.jsx 
// created Login.jsx in src
//  updated src\components\Layout.jsx


import { useState } from "react";
import { useNavigate } from "react-router-dom";

function Login() {
  const navigate = useNavigate();

  const USERNAME = "admin";
  const PASSWORD = "12345";

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const handleLogin = () => {
    if (username === USERNAME && password === PASSWORD) {
      localStorage.setItem("loggedIn", "true");
      navigate("/");
    } else {
      setError("Invalid username or password");
    }
  };

  return (
    <div style={{ textAlign: "center", marginTop: "200px" }}>
      <h2>Welcome to HTA Navigator</h2>

      <input
        type="text"
        placeholder="Username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        style={{ padding: "16px", margin: "10px" }}
      />

      <br />

      <input
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        style={{ padding: "16px", margin: "10px" }}
      />

      <br />

      <button onClick={handleLogin} style={{ marginTop: "20px" }}>
        Login
      </button>

      {error && <p style={{ color: "red" }}>{error}</p>}
    </div>
  );
}

export default Login;