// import { Outlet, NavLink } from "react-router-dom";
// import { 
//   LayoutDashboard, 
//   Search, 
//   FileText, 
//   BrainCircuit, 
//   BarChart3,
//   Building2,
//   ChevronRight
// } from "lucide-react";

// const navItems = [
//   { to: "/", icon: LayoutDashboard, label: "Dashboard", exact: true },
//   { to: "/search", icon: Search, label: "Ruling Search" },
//   { to: "/qa-generator", icon: BrainCircuit, label: "Q&A Generator" },
//   { to: "/insights", icon: BarChart3, label: "Insights" },
// ];

// export default function Layout() {
//   return (
//     <div className="flex min-h-screen bg-slate-50">
//       {/* Sidebar */}
//       <aside className="sidebar" data-testid="sidebar-navigation">
//         {/* Logo */}
//         <div className="px-6 py-6 border-b border-white/10">
//           <div className="flex items-center gap-3">
//             <div className="w-10 h-10 bg-sky-500 rounded-lg flex items-center justify-center">
//               <FileText className="w-5 h-5 text-white" />
//             </div>
//             <div>
//               <h1 className="text-white font-bold text-lg font-heading tracking-tight">
//                 HTA Navigator
//               </h1>
//               <p className="text-slate-400 text-xs">ZIN Edition</p>
//             </div>
//           </div>
//         </div>

//         {/* Navigation */}
//         <nav className="px-4 py-6 space-y-1">
//           {navItems.map((item) => (
//             <NavLink
//               key={item.to}
//               to={item.to}
//               end={item.exact}
//               className={({ isActive }) =>
//                 `sidebar-link ${isActive ? 'active' : ''}`
//               }
//               data-testid={`nav-${item.label.toLowerCase().replace(/\s+/g, '-')}`}
//             >
//               <item.icon className="w-5 h-5" />
//               <span className="font-medium">{item.label}</span>
//               <ChevronRight className="w-4 h-4 ml-auto opacity-50" />
//             </NavLink>
//           ))}
//         </nav>

//         {/* Footer */}
//         <div className="absolute bottom-0 left-0 right-0 px-6 py-4 border-t border-white/10">
//           <div className="flex items-center gap-3">
//             <div className="w-8 h-8 bg-white/10 rounded-lg flex items-center justify-center">
//               <Building2 className="w-4 h-4 text-slate-300" />
//             </div>
//             <div>
//               <p className="text-white text-sm font-medium">Zorginstituut NL</p>
//               <p className="text-slate-400 text-xs">Healthcare Institute</p>
//             </div>
//           </div>
//         </div>
//       </aside>

//       {/* Main Content */}
//       <main className="main-content">
//         <Outlet />
//       </main>
//     </div>
//   );
// }


import { Outlet, NavLink, useNavigate } from "react-router-dom";
import { 
  LayoutDashboard, 
  Search, 
  FileText, 
  BrainCircuit, 
  BarChart3,
  Building2,
  ChevronRight,
  LogOut
} from "lucide-react";

const navItems = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard", exact: true },
  { to: "/search", icon: Search, label: "Ruling Search" },
  { to: "/qa-generator", icon: BrainCircuit, label: "Q&A Generator" },
  { to: "/insights", icon: BarChart3, label: "Insights" },
];

export default function Layout() {
  const navigate = useNavigate();

  const handleLogout = () => {
    localStorage.removeItem("loggedIn");  // ✅ Clear login status
    navigate("/login");                   // ✅ Redirect to login page
  };

  return (
    <div className="flex min-h-screen bg-slate-50">
      {/* Sidebar */}
      <aside className="sidebar" data-testid="sidebar-navigation">
        
        {/* Logo */}
        <div className="px-6 py-6 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-sky-500 rounded-lg flex items-center justify-center">
              <FileText className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-white font-bold text-lg font-heading tracking-tight">
                HTA Navigator
              </h1>
              <p className="text-slate-400 text-xs">ZIN Edition</p>
            </div>
          </div>
        </div>

        {/* Navigation */}
        <nav className="px-4 py-6 space-y-1">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.exact}
              className={({ isActive }) =>
                `sidebar-link ${isActive ? "active" : ""}`
              }
              data-testid={`nav-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
            >
              <item.icon className="w-5 h-5" />
              <span className="font-medium">{item.label}</span>
              <ChevronRight className="w-4 h-4 ml-auto opacity-50" />
            </NavLink>
          ))}
        </nav>

        {/* Footer with Logout Button */}
        <div className="absolute bottom-0 left-0 right-0 px-6 py-4 border-t border-white/10">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-white/10 rounded-lg flex items-center justify-center">
                <Building2 className="w-4 h-4 text-slate-300" />
              </div>
              <div>
                <p className="text-white text-sm font-medium">Zorginstituut NL</p>
                <p className="text-slate-400 text-xs">Healthcare Institute</p>
              </div>
            </div>

            {/* ✅ Logout Button */}
            <button
              onClick={handleLogout}
              className="flex items-center gap-2 text-red-300 hover:text-red-400 transition"
            >
              <LogOut className="w-4 h-4" />
              <span className="text-sm">Logout</span>
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}