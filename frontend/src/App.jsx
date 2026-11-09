/**
 * App.jsx — v2 root (merged with the original App.js auth setup)
 * ---------------------------------------------------------------
 * Preserved from your original App.js:
 *   • Login route
 *   • PrivateRoute guard (localStorage "loggedIn")
 *   • <Toaster /> from sonner
 *   • RulingDetail route
 *
 * Added for v2:
 *   • SessionProvider  (required by Layout and every v2 page)
 *   • Sessions / ReadinessCheck / Help routes
 *
 * Structure:
 *   BrowserRouter
 *     └─ SessionProvider          ← above Routes, so session state survives navigation
 *          ├─ /login             → bare Login page (NO v2 chrome)
 *          └─ everything else    → <Shell> = PrivateRoute + Layout + page
 */
import "./App.css";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";

import { SessionProvider } from "./lib/SessionContext";
import Layout from "./components/Layout";

import Login          from "./Login";
import Welcome        from "./Welcome";
import Dashboard      from "./pages/Dashboard";
import Sessions       from "./pages/Sessions";
import Search         from "./pages/Search";
import RulingDetail   from "./pages/RulingDetail";
import QAGenerator    from "./pages/QAGenerator";
import ReadinessCheck from "./pages/ReadinessCheck";
import Insights       from "./pages/Insights";
import Help           from "./pages/Help";
import Disclaimer     from "./pages/Disclaimer";

// Auth guard: must be logged in AND have accepted the disclaimer
function PrivateRoute({ children }) {
  const isLoggedIn = localStorage.getItem("loggedIn") === "true";
  const accepted   = localStorage.getItem("disclaimerAccepted") === "true";
  if (!isLoggedIn) return <Navigate to="/login" replace />;
  if (!accepted)   return <Navigate to="/welcome" replace />;
  return children;
}

// ─── Protected page wrapper: auth gate + v2 shell ────────────────────────────
function Shell({ children }) {
  return (
    <PrivateRoute>
      <Layout>{children}</Layout>
    </PrivateRoute>
  );
}

function WelcomeGate() {
  const isLoggedIn = localStorage.getItem("loggedIn") === "true";
  return isLoggedIn ? <Welcome /> : <Navigate to="/login" replace />;
}
export default function App() {
  return (
    <BrowserRouter>
      <Toaster position="top-right" richColors />
      <SessionProvider>
        <Routes>
          {/* Login renders bare — no sidebar, no session bar */}
          <Route path="/login" element={<Login />} />

          {/* Everything below is auth-gated and wrapped in the v2 shell */}
          <Route path="/welcome" element={<WelcomeGate />} />
          <Route path="/"             element={<Shell><Dashboard /></Shell>} />
          <Route path="/sessions"     element={<Shell><Sessions /></Shell>} />
          <Route path="/search"       element={<Shell><Search /></Shell>} />
          <Route path="/ruling/:id"   element={<Shell><RulingDetail /></Shell>} />
          <Route path="/qa-generator" element={<Shell><QAGenerator /></Shell>} />
          <Route path="/readiness"    element={<Shell><ReadinessCheck /></Shell>} />
          <Route path="/insights"     element={<Shell><Insights /></Shell>} />
          <Route path="/help"         element={<Shell><Help /></Shell>} />
          <Route path="/disclaimer"   element={<Shell><Disclaimer /></Shell>} />

          {/* Anything unmatched goes home */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </SessionProvider>
    </BrowserRouter>
  );
}
