import { createContext, useContext, useEffect, useMemo, useState } 
from "react"; import { useNavigate } from "react-router-dom";

const AuthContext = createContext(null);

export function AuthProvider({ children }) 
{ 
const [authed, setAuthed] = useState(false); const navigate = useNavigate();

useEffect(() => 
    { const token = localStorage.getItem("auth_token"); 
        setAuthed(Boolean(token)); }, []);

const login = (username, password) =>
     { // DEMO ONLY: hardcoded credentials 
     const OK_USER = "admin"; const OK_PASS = "secret123";

     if (username === OK_USER && password === OK_PASS) {
  localStorage.setItem("auth_token", "demo_token");
  setAuthed(true);
  return { ok: true };
}
return { ok: false, error: "Invalid username or password." };
     };
const logout = () => { localStorage.removeItem("auth_token"); setAuthed(false); navigate("/login", { replace: true }); };

const value = useMemo(() => ({ authed, login, logout }), [authed]);

return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>; }

export function useAuth() 
{ const ctx = useContext(AuthContext); if (!ctx) { throw new Error("useAuth must be used within AuthProvider"); } return ctx; 
}