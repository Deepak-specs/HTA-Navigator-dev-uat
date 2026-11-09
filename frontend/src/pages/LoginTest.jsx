// for login created auth folder. there 2 files are there for login - AuthContext.jsx, RequireAuth.jsx
// in pages folder created Login.jsx 
// created Login.jsx in src
//  updated src\components\Layout.jsx


import { useState } from "react"; 
import { useLocation, useNavigate } from "react-router-dom"; 
import { useAuth } from "../auth/AuthContext"; 
import { Button } from "../components/ui/button"; 
import { Input } from "../components/ui/input"; 
import { Card, CardContent, CardHeader, CardTitle } 
from "../components/ui/card"; 
import { toast } from "sonner";

export default function Login() 
{ const { login } = useAuth(); 
const navigate = useNavigate(); 
const location = useLocation(); 
const from = location.state?.from?.pathname || "/search";

const [username, setUsername] = useState(""); 
const [password, setPassword] = useState(""); 
const [submitting, setSubmitting] = useState(false);

const onSubmit = async (e) => 
    { e.preventDefault(); setSubmitting(true); 
        try { const res = login(username.trim(), password); 
            if (res.ok) { toast.success("Logged in"); navigate(from, { replace: true }); 
        } else { toast.error(res.error || "Login failed"); } }
         finally { setSubmitting(false); } };

return ( <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4"> 
<Card className="w-full max-w-sm shadow"> <CardHeader> 
    <CardTitle className="text-lg font-semibold">Sign in</CardTitle> </CardHeader> 
    <CardContent> <form onSubmit={onSubmit} className="space-y-4"> <div> 
        <label className="block text-sm text-slate-600 mb-1">Username</label>
         <Input value={username} onChange={(e) => setUsername(e.target.value)} 
         autoComplete="username" placeholder="admin" /> </div> <div> 
            <label className="block text-sm text-slate-600 mb-1">Password</label> 
            <Input type="password" value={password} onChange={(e) => 
            setPassword(e.target.value)}
             autoComplete="current-password" placeholder="secret123" /> </div> 
             <Button type="submit" className="w-full" disabled={submitting}> 
                {submitting ? "Signing in..." : "Sign in"} </Button> 
                <p className="text-xs text-slate-500 mt-2">
                     Demo credentials: admin / secret123 </p> </form> 
                     </CardContent> </Card> </div> ); }