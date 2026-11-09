/**
* Layout.jsx — v2 shell
* -------------------------------------------------------
* Renders:
*   • Top bar (brand, HTA-body pill, user avatar)
*   • Left sidebar navigation
*   • Persistent session bar (above page content)
*   • New-session modal
*   • Save-to-session picker modal
*   • Toast notification
*
* Children go inside .v2-main
*/
import { useState, useCallback, useMemo, useEffect } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useSession } from "../lib/SessionContext";
import { addQuestionToSession } from "../lib/sessionStore";
import { toast } from "../lib/toast";
import NavigatorLogo from "../assets/navigator-logo.png";
import axios from "axios";



const API = `${process.env.REACT_APP_BACKEND_URL}/api`;



// ─── Navigation items ──────────────────────────────────────────────────────────
const NAV = [
  { group: "My work", items: [
   { label: "⌂ Home",         to: "/" },
   { label: "▤ My sessions",  to: "/sessions", sub: true, badge: true },
  ]},
  { group: "Research", items: [
   { label: "⌕ Ruling search", to: "/search" },
  ]},
  { group: "Prepare", items: [
   { label: "✎ Q&A generator",  to: "/qa-generator" },
   { label: "◉ Readiness check", to: "/readiness" },
  ]},
  { group: "Analyse", items: [
   { label: "▥ Insights",       to: "/insights" },
  ]},
  { group: "Support", items: [
   { label: "? Help & guides",  to: "/help" },
   { label: "⚠ Disclaimer",     to: "/disclaimer" },
  ]},
];



export default function Layout({ children }) {
  const location  = useLocation();
  const navigate  = useNavigate();
  const {
   activeSession, sessions, createSession, closeSession,
   pickerOpen, pickerItem, openSavePicker, setPickerOpen, clearPickerItem, chooseSession,
   resolvePicker, cancelPicker,
   newSessionPrefill, requestNewSession, dismissNewSession,
  } = useSession();



  // ── Signed-in user ─────────────────────────────────────────────────────────
  // Same credentials as before: Login.js writes "loggedIn", "role" and
  // "username" into localStorage; App.jsx gates every route on "loggedIn".
  const currentUser = useMemo(() => {
   let username = null;
   let role     = null;
   try {
     username = localStorage.getItem("username");
     role     = localStorage.getItem("role");
   } catch {
     /* storage unavailable — fall through to defaults */
   }
   return {
     username: username || "User",
     role:     role     || "",
     initial:  (username || "U").charAt(0).toUpperCase(),
   };
  }, []);



  const [userMenuOpen, setUserMenuOpen] = useState(false);



  // Sr 91 / Sr 96 — corpus freshness and size, read once for the shell. The top
  // bar used to print today's date, which asserts a currency the app never
  // checked, and the sidebar hardcoded "487 rulings indexed".
  const [corpus, setCorpus] = useState(null);
  useEffect(() => {
   let cancelled = false;
   axios.get(`${API}/insights`)
     .then(({ data }) => { if (!cancelled) setCorpus(data); })
     .catch(() => { /* shell renders without it */ });
   return () => { cancelled = true; };
  }, []);



  const freshness = useMemo(() => {
   const d = corpus?.corpus_current_to;
   if (!d) return null;
   const dt = new Date(String(d).slice(0, 10));
   return Number.isNaN(dt.getTime())
     ? null
     : dt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  }, [corpus]);



  const handleLogout = useCallback(() => {
   try {
     localStorage.removeItem("loggedIn");
     localStorage.removeItem("role");
     localStorage.removeItem("username");
     localStorage.removeItem("disclaimerAccepted");  
   } catch {
     /* ignore */
   }
   setUserMenuOpen(false);
   navigate("/login", { replace: true });
  }, [navigate]);



  // ── New-session modal state ────────────────────────────────────────────────
  const [showNew,       setShowNew]       = useState(false);
  const [newDrug,       setNewDrug]       = useState("");
  const [newArea,       setNewArea]       = useState("");
  const [newDossier,    setNewDossier]    = useState("");



  const openNewModal = useCallback((prefill = {}) => {
   setNewDrug(prefill.drug || "");
   setNewArea(prefill.area || "");
   setNewDossier(prefill.dossier || "");
   setShowNew(true);
  }, []);



  // Sr 42 — any page can ask for the modal via `requestNewSession(prefill)`.
  // Layout still owns the form; the context only carries the request.
  useEffect(() => {
   if (newSessionPrefill) openNewModal(newSessionPrefill);
  }, [newSessionPrefill, openNewModal]);



  const closeNewModal = useCallback(() => {
   setShowNew(false);
   dismissNewSession();
  }, [dismissNewSession]);



  const handleCreateSession = useCallback((destination = "search") => {
   if (!newDrug.trim()) return;
   const s = createSession({ drugName: newDrug.trim(), therapyArea: newArea.trim(), dossierType: newDossier.trim() });
   // Carry over any ruling that was pending from the save-to-session picker.
   let question = null;
   if (pickerItem) {
     question = addQuestionToSession(s.id, pickerItem);
     clearPickerItem();
   }
   closeNewModal();
   toast(`Session started: ${newDrug.trim()}`);



   // Sr 45 — if a caller is waiting on the picker (e.g. Ruling Search handing
   // off to the Q&A generator) it decides where to go. Only fall back to
   // /search when nothing is waiting.
   const handled = resolvePicker(s, question);
   if (!handled) navigate(destination === "qa" ? "/qa-generator" : "/search");
  }, [createSession, newDrug, newArea, newDossier, navigate, pickerItem, clearPickerItem, resolvePicker]);



  const handlePickSession = useCallback((session) => {
   const hadItem = !!pickerItem;
   chooseSession(session.id);
   toast(hadItem ? `Saved to session: ${session.drugName}` : `Switched to session: ${session.drugName}`);
  }, [chooseSession, pickerItem]);



  // ── active path check ──────────────────────────────────────────────────────
  const isActive = (to) => {
   if (to === "/") return location.pathname === "/";
   return location.pathname.startsWith(to);
  };



  // Sr 93 — distinct rulings saved across every question in the session.
  //
  // The titles come from `q.rulings`, recorded alongside the ids when the
  // question was saved. Questions saved before that was stored have ids only,
  // so those fall back to a shortened id — the count stays correct either way,
  // and re-saving the search fills the names in.
  const activeSessionRulings = useMemo(() => {
   const byId = new Map();
   (activeSession?.questions || []).forEach((q) => {
     (q.rulings || []).forEach((r) => { if (r?.id) byId.set(r.id, r); });
     (q.rulingIds || []).forEach((id) => { if (!byId.has(id)) byId.set(id, { id, title: null }); });
   });
   return [...byId.values()];
  }, [activeSession]);
  const activeSessionRulingCount = activeSessionRulings.length;
  const [rulingListOpen, setRulingListOpen] = useState(false);



  // Sr 94 — a session already covering the same drug. The design's note #29
  // wants the picker to offer that session rather than let the user create a
  // second one for the same case and split their work across both.
  const duplicateSession = useMemo(() => {
   const drug = (pickerItem?.drugName || newDrug || "").trim().toLowerCase();
   if (!drug) return null;
   return sessions.find((x) => (x.drugName || "").trim().toLowerCase() === drug) || null;
  }, [sessions, pickerItem, newDrug]);



  const sessionCount = sessions.length;



  return (
   <div className="v2-app">
     {/* ── TOP BAR ─────────────────────────────────────────────────── */}
     <div className="v2-topbar">
       <div className="v2-brand">
         <img className="navigator-header-logo" src={NavigatorLogo} alt="HTA Navigator" />
       </div>



       {/* Sr 90 — which HTA body the corpus is. ZIN is the only one indexed;
           the others are named as planned rather than offered and broken. */}
       <button
         className="v2-jsw"
         type="button"
         title="ZIN (Zorginstituut Nederland) is the indexed body. NICE, G-BA and HAS are planned."
         onClick={() => toast("NICE, G-BA and HAS are planned. ZIN is the only indexed body today.")}
         data-testid="hta-body-switcher"
       >
         <span className="dot" />
         ZIN · Netherlands <span style={{ opacity: .6 }}>▾</span>
       </button>



       <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
         {/* Sr 91 — the latest decision date actually held, not today's date */}
         <span className="v2-fresh" data-testid="corpus-freshness">
           {freshness ? `● Last sync date : ${freshness}` : "● Corpus date unavailable"}
         </span>



         {/* Signed-in user + sign out */}
         <div style={{ position: "relative" }} data-testid="user-menu">
           <button
             type="button"
             onClick={() => setUserMenuOpen((v) => !v)}
             title={`Signed in as ${currentUser.username}`}
             aria-haspopup="menu"
             aria-expanded={userMenuOpen}
             style={{
               display: "flex", alignItems: "center", gap: 8,
               background: "none", border: "none", padding: 0, cursor: "pointer",
               font: "inherit", color: "inherit",
             }}
           >
             <div className="v2-avatar">{currentUser.initial}</div>
             <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", lineHeight: 1.15 }}>
               <b style={{ fontSize: 12 }}>{currentUser.username}</b>
               {currentUser.role && (
                 <span style={{ fontSize: 10.5, color: "var(--muted)", textTransform: "capitalize" }}>
                   {currentUser.role}
                 </span>
               )}
             </span>
           </button>



           {userMenuOpen && (
             <>
               {/* click-away layer */}
               <div
                 onClick={() => setUserMenuOpen(false)}
                 style={{ position: "fixed", inset: 0, zIndex: 40 }}
               />
               <div
                 role="menu"
                 style={{
                   position: "absolute", right: 0, top: "calc(100% + 8px)", zIndex: 41,
                   minWidth: 190, background: "#fff", border: "1px solid var(--line)",
                   borderRadius: 10, boxShadow: "0 10px 30px rgba(0,0,0,.12)", padding: 10,
                 }}
               >
                 <div style={{ fontSize: 11.5, color: "var(--muted)", padding: "2px 4px 8px" }}>
                   Signed in as <b style={{ color: "var(--ink)" }}>{currentUser.username}</b>
                 </div>
                 <button
                   type="button"
                   className="v2-btn v2-ghost v2-sm"
                   onClick={handleLogout}
                   data-testid="logout-btn"
                   style={{ width: "100%", justifyContent: "center" }}
                 >
                   Sign out
                 </button>
               </div>
             </>
           )}
         </div>
       </div>
     </div>



     {/* ── SIDEBAR ─────────────────────────────────────────────────── */}
     <nav className="v2-side">
       {NAV.map(({ group, items }) => (
         <div key={group}>
           <div className="v2-navgrp">{group}</div>
           <div className="v2-nav">
             {/* Anchors rather than buttons, so every nav item can be
                 right-clicked or ctrl-clicked into a new tab or window. */}
             {items.map(({ label, to, sub, badge }) => (
               <Link
                 key={to}
                 to={to}
                 className={[sub && "sub", isActive(to) && "active"].filter(Boolean).join(" ")}
               >
                 {label}
                 {badge && sessionCount > 0 && (
                   <span className="g">{sessionCount}</span>
                 )}
               </Link>
             ))}
           </div>
         </div>
       ))}



       <div className="v2-side-foot">
         <b>ZIN · Zorginstituut NL</b>
         {corpus?.total_rulings ? `${corpus.total_rulings} rulings indexed` : "Rulings indexed"}<br />
         Source: zorginstituutnederland.nl
       </div>
     </nav>



     {/* ── MAIN ────────────────────────────────────────────────────── */}
     <main className="v2-main">
       {/* ── SESSION BAR ─────────────────────────────────────────── */}
       {activeSession ? (
         <div className="v2-sessbar" data-testid="session-bar-active">
           <div>
             <div className="lab">Working on</div>
             <b>{activeSession.drugName}</b>
           </div>
           {activeSession.therapyArea && (
             <span className="v2-chip">{activeSession.therapyArea}</span>
           )}
           {activeSession.dossierType && (
             <span className="v2-chip">{activeSession.dossierType}</span>
           )}
           <span className="v2-chip">
             {activeSession.questions.length} search question{activeSession.questions.length !== 1 ? "s" : ""}
           </span>
           {/* Sr 93 — distinct rulings across all of the session's questions.
               Clickable: the count used to be a dead end, with no screen
               anywhere listing which rulings it was counting. */}
           <span style={{ position: "relative" }}>
             <button
               type="button"
               className="v2-chip"
               data-testid="session-rulings-chip"
               onClick={() => setRulingListOpen((v) => !v)}
               disabled={activeSessionRulingCount === 0}
               aria-expanded={rulingListOpen}
               title={activeSessionRulingCount ? "Show the rulings saved in this session" : undefined}
               style={{ cursor: activeSessionRulingCount ? "pointer" : "default", font: "inherit" }}
             >
               {activeSessionRulingCount} ruling{activeSessionRulingCount !== 1 ? "s" : ""} saved
               {activeSessionRulingCount > 0 && <span aria-hidden="true"> ▾</span>}
             </button>



             {rulingListOpen && activeSessionRulingCount > 0 && (
               <div
                 data-testid="session-rulings-list"
                 style={{
                   position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 40,
                   minWidth: 320, maxWidth: 460, maxHeight: 320, overflowY: "auto",
                   background: "#fff", border: "1px solid var(--line)", borderRadius: 10,
                   boxShadow: "0 8px 24px rgba(20,10,30,.14)", padding: 8,
                 }}
               >
                 <div style={{ fontSize: 11, color: "var(--muted)", padding: "2px 8px 6px" }}>
                   Saved in this session
                 </div>
                 {activeSessionRulings.map((r) => (
                   <Link
                     key={r.id}
                     to={`/ruling/${r.id}`}
                     onClick={() => setRulingListOpen(false)}
                     style={{
                       display: "block", padding: "6px 8px", borderRadius: 6,
                       fontSize: 12.5, color: "var(--ink-2)", textDecoration: "none",
                     }}
                   >
                     {r.title || `Ruling ${String(r.id).slice(0, 8)}…`}
                     {r.year && <span style={{ color: "var(--muted)" }}> · {r.year}</span>}
                     {!r.title && (
                       <span style={{ color: "var(--muted)", fontSize: 11 }}> · saved before titles were kept</span>
                     )}
                   </Link>
                 ))}
               </div>
             )}
           </span>
           <div className="acts2">
             <Link to="/sessions" className="v2-btn v2-ghost v2-sm">Open session</Link>
             <button className="v2-btn v2-ghost v2-sm" type="button" onClick={() => openSavePicker(null)}>Switch</button>
             <button className="v2-btn v2-ghost v2-sm" type="button" onClick={() => { closeSession(); toast("Session closed"); }}>Close</button>
           </div>
         </div>
       ) : (
         <div className="v2-sessbar none" data-testid="session-bar-none">
           <div>
             <div className="lab">No session open</div>
             <b style={{ fontWeight: 600, color: "var(--ink-2)" }}>
               You are in free search. Any ruling you save will ask which session to attach it to.
             </b>
           </div>
           <div className="acts2">
             <button className="v2-btn v2-mag v2-sm" type="button" onClick={() => openNewModal()}>Start a session</button>
             {sessions.length > 0 && (
               <button className="v2-btn v2-ghost v2-sm" type="button" onClick={() => openSavePicker(null)}>
                 Reopen a session
               </button>
             )}
           </div>
         </div>
       )}



       {/* ── PAGE CONTENT ────────────────────────────────────────── */}
       {/* Expose openNewModal & setShowPicker through a DOM-free approach — pages
           can import useSession hook and call from context, or use the Layout's
           internal openNewModal by publishing it via context in SessionContext */}
       {children}
     </main>



     {/* ── MODALS ──────────────────────────────────────────────────── */}



     {/* New session modal */}
     {showNew && (
       <div className="v2-scrim open" onClick={(e) => e.target === e.currentTarget && closeNewModal()}>
         <div className="v2-modal" role="dialog" aria-modal="true" aria-label="Start a session">
           <header>
             <div>
               <h3>Start a session</h3>
               <p>Everything is optional and editable later.</p>
             </div>
             <button className="v2-btn v2-ghost v2-sm" type="button" onClick={closeNewModal}>✕</button>
           </header>
           <div className="mbody" style={{ padding: 18 }}>
             {/* Sr 95 — created with content already in it, not as an empty
                 shell. Design note #28. */}
             {pickerItem && (
               <div className="v2-banner" style={{ marginBottom: 15 }}>
                 <span aria-hidden="true">⌕</span>
                 <div>
                   <b>Pre-filled from your search.</b>
                   {pickerItem.query ? ` Research question: “${pickerItem.query}”.` : ""}
                   {pickerItem.rulingIds?.length
                     ? ` ${pickerItem.rulingIds.length} ruling${pickerItem.rulingIds.length !== 1 ? "s" : ""} will be carried over.`
                     : ""}
                 </div>
               </div>
             )}



             {/* Sr 94 — offer the existing session rather than a duplicate */}
             {duplicateSession && (
               <div className="v2-banner" style={{ marginBottom: 15 }}>
                 <span aria-hidden="true">◈</span>
                 <div>
                   You already have a session for <b>{duplicateSession.drugName}</b>.
                   <div style={{ marginTop: 7 }}>
                     <button
                       className="v2-btn v2-ghost v2-sm"
                       type="button"
                       onClick={() => { closeNewModal(); handlePickSession(duplicateSession); }}
                     >
                       Use that session instead
                     </button>
                   </div>
                 </div>
               </div>
             )}



             <div className="v2-field">
               <label>Drug</label>
               <input
                 autoFocus
                 value={newDrug}
                 onChange={(e) => setNewDrug(e.target.value)}
                 placeholder="e.g. Sacubitril/valsartan"
                 onKeyDown={(e) => e.key === "Enter" && handleCreateSession()}
               />
             </div>
             <div className="v2-two">
               <div className="v2-field">
                 <label>Therapy area</label>
                 <input
                   value={newArea}
                   onChange={(e) => setNewArea(e.target.value)}
                   placeholder="e.g. Cardiology"
                 />
               </div>
               <div className="v2-field">
                 <label>Dossier type</label>
                 <select value={newDossier} onChange={(e) => setNewDossier(e.target.value)}>
                   <option value="">Select…</option>
                   <option>Pharmacotherapeutic Dossier</option>
                   <option>Pharmacoeconomic Dossier</option>
                   <option>Budget Impact Dossier</option>
                 </select>
               </div>
             </div>
           </div>
           <footer style={{ padding: "13px 18px", borderTop: "1px solid var(--line)", display: "flex", gap: 8, justifyContent: "flex-end", background: "#FBFAFD" }}>
             <button className="v2-btn v2-ghost" type="button" onClick={closeNewModal}>Cancel</button>
             <button
               className="v2-btn v2-mag"
               type="button"
               onClick={() => handleCreateSession("search")}
               disabled={!newDrug.trim()}
             >
               Create &amp; keep searching
             </button>
             {/* <button
               className="v2-btn v2-mag"
               type="button"
               onClick={() => handleCreateSession("qa")}
               disabled={!newDrug.trim()}
             >
               Create &amp; generate questions
             </button> */}
           </footer>
         </div>
       </div>
     )}



     {/* Session picker modal — used both to switch/reopen a session and,
         when pickerItem is set, to save a specific ruling into one */}
     {pickerOpen && (
       <div className="v2-scrim open" onClick={(e) => e.target === e.currentTarget && cancelPicker()}>
         <div className="v2-modal" role="dialog" aria-modal="true" aria-label="Save to a session">
           <header>
             <div>
               <h3>{pickerItem ? "Save to a session" : "Switch session"}</h3>
               <p>{pickerItem
                 ? "Choose which session to attach this ruling to, or start a new one."
                 : "Choose which session to work in, or start a new one."}</p>
             </div>
             <button className="v2-btn v2-ghost v2-sm" type="button" onClick={cancelPicker}>✕</button>
           </header>
           <div className="mbody" style={{ padding: 18 }}>
             {/* Sr 94 — completed sessions are offered too. Adding to one
                 reopens it, which is what the design describes: a completed
                 session is a starting point for a follow-up filing, not a
                 dead end. */}
             {[...sessions]
               .sort((a, b) => (a.status === "completed" ? 1 : 0) - (b.status === "completed" ? 1 : 0))
               .map((s) => {
                 const done = s.status === "completed";
                 const rulingIds = new Set();
                 (s.questions || []).forEach((q) => (q.rulingIds || []).forEach((id) => rulingIds.add(id)));
                 return (
                   <button key={s.id} className="v2-pick" type="button" onClick={() => handlePickSession(s)}>
                     <div className="ic2">{done ? "✓" : "◑"}</div>
                     <div>
                       <b>{s.drugName}</b>
                       <span>
                         {done ? "Completed · reopens as in progress if you add to it" : "In progress"}
                         {s.therapyArea ? ` · ${s.therapyArea}` : ""}
                         {` · ${rulingIds.size} ruling${rulingIds.size !== 1 ? "s" : ""} saved`}
                       </span>
                     </div>
                   </button>
                 );
               })}
             <button
               className="v2-pick new"
               type="button"
               onClick={() => { setPickerOpen(false); openNewModal(); }}
             >
               <div className="ic2">＋</div>
               <div>
                 <b>Start a new session</b>
                 <span>Create a session anchored to a new drug</span>
               </div>
             </button>
           </div>
         </div>
       </div>
     )}

     {/* ── TOAST ───────────────────────────────────────────────────── */}
     <div id="v2-toast" className="v2-toast" role="status" aria-live="polite">
       <span id="v2-toast-msg" />
     </div>
   </div>
  );
}
 