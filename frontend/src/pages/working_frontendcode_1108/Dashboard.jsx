import { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import axios from "axios";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import {
  FileText,
  TrendingUp,
  TrendingDown,
  AlertCircle,
  ChevronRight,
  Calendar,
  Building2,
  Activity
} from "lucide-react";

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;

// Dev-only Axios logging interceptors
if (process.env.NODE_ENV === "development" && !axios.__LOG_INTERCEPTORS__) {
  axios.__LOG_INTERCEPTORS__ = true;
  axios.interceptors.request.use(cfg => {
    console.log("[REQ]", cfg.method?.toUpperCase(), cfg.url, { headers: cfg.headers, params: cfg.params });
    return cfg;
  });
  axios.interceptors.response.use(
    res => {
      console.log("[RES]", res.status, res.config?.url, res.data);
      return res;
    },
    err => {
      console.error("[ERR]", {
        message: err.message,
        code: err.code,
        url: err.config?.url,
        method: err.config?.method,
        status: err.response?.status,
        data: err.response?.data,
      });
      return Promise.reject(err);
    }
  );
}

// Outcome helpers
const getOutcomeStyle = (outcome) => {
  if (outcome === "Positive") return "outcome-positive";
  if (outcome === "Negative") return "outcome-negative";
  if (outcome?.includes?.("Conditions")) return "outcome-conditional";
  return "bg-slate-100 text-slate-700";
};

const getOutcomeIcon = (outcome) => {
  if (outcome === "Positive") return <TrendingUp className="w-4 h-4" />;
  if (outcome === "Negative") return <TrendingDown className="w-4 h-4" />;
  return <AlertCircle className="w-4 h-4" />;
};

// Simple warning de-duplication
const seenWarnings = new Set();
function warnOnce(key, payload) {
  if (!seenWarnings.has(key)) {
    console.warn(key, payload);
    seenWarnings.add(key);
  }
}

export default function Dashboard() {
  const [rulings, setRulings] = useState([]);
  const [insights, setInsights] = useState(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(null);

  // Show All toggle state for Top Manufacturers
  const [showAllMfr, setShowAllMfr] = useState(false);

  const expectedInsightFields = useMemo(
    () => [
      "total_rulings",
      "positive_decisions",
      "conditional_decisions",
      "negative_decisions",
      "under_review_decisions",
      "therapy_area_breakdown",
      "top_manufacturers",
      "all_manufacturers",
    ],
    []
  );

  useEffect(() => {
    console.log("REACT_APP_BACKEND_URL:", process.env.REACT_APP_BACKEND_URL);
    console.log("API base:", API);

    const fetchData = async () => {
      setFetchError(null);
      try {
        const results = await Promise.allSettled([
          axios.get(`${API}/rulings`),
          axios.get(`${API}/insights`)
        ]);

        const [rulingsRes, insightsRes] = results;

        // Handle rulings
        if (rulingsRes.status === "fulfilled") {
          const data = rulingsRes.value?.data;
          if (!Array.isArray(data)) {
            warnOnce("Expected rulings array, got:", data);
            setRulings([]);
          } else {
            const requiredRulingFields = [
              "id", "title", "summary", "decision_outcome",
              "therapy_area", "manufacturer", "decision_date"
            ];
            data.slice(0, 5).forEach((r, idx) => {
              requiredRulingFields.forEach((f) => {
                if (r?.[f] == null) {
                  warnOnce(`rulings[${idx}] missing field: ${f}`, r);
                }
              });
            });
            setRulings(data);
          }
        } else {
          const err = rulingsRes.reason;
          console.error("Rulings request failed", {
            message: err?.message,
            code: err?.code,
            url: err?.config?.url,
            status: err?.response?.status,
            data: err?.response?.data
          });
          setRulings([]);
          setFetchError((prev) => prev || "Failed to load rulings");
        }

        // Handle insights
        if (insightsRes.status === "fulfilled") {
          const data = insightsRes.value?.data;
          if (data == null || typeof data !== "object") {
            warnOnce("Expected insights object, got:", data);
            setInsights(null);
          } else {
            expectedInsightFields.forEach((f) => {
              if (data?.[f] == null) {
                warnOnce(`insights missing field: ${f}`, data);
              }
            });
            if (data.therapy_area_breakdown && typeof data.therapy_area_breakdown !== "object") {
              warnOnce("insights.therapy_area_breakdown should be an object", data.therapy_area_breakdown);
            }
            if (data.top_manufacturers && !Array.isArray(data.top_manufacturers)) {
              warnOnce("insights.top_manufacturers should be an array", data.top_manufacturers);
            }
            setInsights(data);
          }
        } else {
          const err = insightsRes.reason;
          console.error("Insights request failed", {
            message: err?.message,
            code: err?.code,
            url: err?.config?.url,
            status: err?.response?.status,
            data: err?.response?.data
          });
          setInsights(null);
          setFetchError((prev) => prev || "Failed to load insights");
        }
      } catch (error) {
        console.error("Unexpected dashboard fetch error", error);
        setFetchError("Unexpected error during fetch");
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [expectedInsightFields]);

  // Derive the manufacturer list to display based on toggle state
  const manufacturersToDisplay = showAllMfr
    ? (insights?.all_manufacturers ?? insights?.top_manufacturers ?? [])
    : (insights?.top_manufacturers ?? []);

  const hasMoreManufacturers =
    (insights?.all_manufacturers?.length ?? 0) >
    (insights?.top_manufacturers?.length ?? 0);

  if (loading) {
    return (
      <div className="p-8" data-testid="dashboard-loading">
        <div className="mb-8">
          <Skeleton className="h-10 w-64 mb-2" />
          <Skeleton className="h-5 w-96" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div data-testid="dashboard-page">

      {/* ── Header ── */}
      <header className="page-header">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 font-heading">
              Dashboard
            </h1>
            <p className="text-slate-500 mt-1">
              Overview of HTA rulings and assessment insights
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-4 py-2 bg-slate-100 rounded-lg">
              <Calendar className="w-4 h-4 text-slate-500" />
              <span className="text-sm text-slate-600">
                {new Date().toLocaleDateString("en-NL", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })}
              </span>
            </div>
          </div>
        </div>
      </header>

      <div className="p-8">

        {/* ── Optional error banner ── */}
        {fetchError && (
          <div
            className="mb-6 p-3 rounded-md bg-amber-50 text-amber-800 border border-amber-200"
            data-testid="dashboard-error"
          >
            {fetchError}. Check the browser console for details.
          </div>
        )}

        {/* ── Metrics Grid ── */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-6 mb-8">

          {/* ── Total Rulings — not clickable ── */}
          <Card
            className="metric-card animate-fade-in-up stagger-1"
            data-testid="metric-total-rulings"
          >
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="metric-value">{insights?.total_rulings ?? 0}</p>
                  <p className="metric-label">Total Rulings</p>
                </div>
                <div className="w-12 h-12 bg-sky-100 rounded-xl flex items-center justify-center">
                  <FileText className="w-6 h-6 text-sky-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* ── Positive Decisions ── */}
          <Link
            to="/search?outcome=Positive"
            className="block"
            data-testid="metric-positive-link"
          >
            <Card
              className="metric-card animate-fade-in-up stagger-2 cursor-pointer
                         hover:shadow-md hover:border-emerald-200
                         transition-all duration-200"
              data-testid="metric-positive"
            >
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="metric-value text-emerald-600">
                      {insights?.positive_decisions ?? 0}
                    </p>
                    <p className="metric-label">Positive Decisions</p>
                  </div>
                  <div className="w-12 h-12 bg-emerald-100 rounded-xl flex items-center justify-center">
                    <TrendingUp className="w-6 h-6 text-emerald-600" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </Link>

          {/* ── Conditional Decisions ── */}
          <Link
            to="/search?outcome=Positive+with+Conditions"
            className="block"
            data-testid="metric-conditional-link"
          >
            <Card
              className="metric-card animate-fade-in-up stagger-3 cursor-pointer
                         hover:shadow-md hover:border-amber-200
                         transition-all duration-200"
              data-testid="metric-conditional"
            >
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="metric-value text-amber-600">
                      {insights?.conditional_decisions ?? 0}
                    </p>
                    <p className="metric-label">Conditional</p>
                  </div>
                  <div className="w-12 h-12 bg-amber-100 rounded-xl flex items-center justify-center">
                    <AlertCircle className="w-6 h-6 text-amber-600" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </Link>

          {/* ── Negative Decisions ── */}
          <Link
            to="/search?outcome=Negative"
            className="block"
            data-testid="metric-negative-link"
          >
            <Card
              className="metric-card animate-fade-in-up stagger-4 cursor-pointer
                         hover:shadow-md hover:border-red-200
                         transition-all duration-200"
              data-testid="metric-negative"
            >
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="metric-value text-red-600">
                      {insights?.negative_decisions ?? 0}
                    </p>
                    <p className="metric-label">Negative Decisions</p>
                  </div>
                  <div className="w-12 h-12 bg-red-100 rounded-xl flex items-center justify-center">
                    <TrendingDown className="w-6 h-6 text-red-600" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </Link>

          {/* ── Under Review ── */}
          <Link
            to="/search?outcome=Under+Review"
            className="block"
            data-testid="metric-under-review-link"
          >
            <Card
              className="metric-card animate-fade-in-up stagger-5 cursor-pointer
                         hover:shadow-md hover:border-sky-200
                         transition-all duration-200"
              data-testid="metric-under-review"
            >
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="metric-value text-sky-600">
                      {insights?.under_review_decisions ?? 0}
                    </p>
                    <p className="metric-label">Under Review</p>
                  </div>
                  <div className="w-12 h-12 bg-sky-100 rounded-xl flex items-center justify-center">
                    <Activity className="w-6 h-6 text-sky-600" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </Link>

        </div>

        {/* ── Main Content Grid ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* ── Recent Rulings ── */}
          <div className="lg:col-span-2">
            <Card className="border-slate-200" data-testid="recent-rulings-section">
              <CardHeader className="border-b border-slate-100 bg-slate-50/50">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg font-semibold text-slate-900 font-heading">
                    Recent Rulings
                  </CardTitle>
                  <Link to="/search">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-sky-600 hover:text-sky-700"
                    >
                      View All
                      <ChevronRight className="w-4 h-4 ml-1" />
                    </Button>
                  </Link>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y divide-slate-100">
                  {/* {(rulings || []).slice(0, 5).map((ruling, index) => { */}
                   
                     {(rulings || [])
                    .slice()
                    .sort((a, b) => {
                      const dateA = a?.decision_date ? new Date(a.decision_date) : new Date(0);
                      const dateB = b?.decision_date ? new Date(b.decision_date) : new Date(0);
                      return dateB - dateA;
                    })
                    .slice(0, 5)
                    .map((ruling, index) => {
                      
                    const title = ruling?.title || "Untitled ruling";
                    if (!ruling?.title) {
                      warnOnce(`ruling ${ruling?.id ?? "(no id)"} missing title`, ruling);
                    }
                    return (
                      <Link
                        key={ruling.id ?? `ruling-${index}`}
                        to={ruling?.id != null ? `/ruling/${ruling.id}` : "#"}
                        className={`block p-5 hover:bg-slate-50 transition-colors animate-fade-in-up stagger-${index + 1}`}
                        data-testid={`ruling-item-${ruling.id ?? index}`}
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-2">
                              <Badge
                                variant="outline"
                                className={`text-xs ${getOutcomeStyle(ruling?.decision_outcome)}`}
                              >
                                {getOutcomeIcon(ruling?.decision_outcome)}
                                <span className="ml-1">
                                  {ruling?.decision_outcome ?? "Unknown"}
                                </span>
                              </Badge>
                            </div>
                            <h3 className="font-semibold text-slate-900 mb-1 truncate">
                              {title}
                            </h3>
                            <p className="text-sm text-slate-500 line-clamp-2">
                              {ruling?.summary ?? "No summary available."}
                            </p>
                            <div className="flex items-center gap-4 mt-3">
                              <Badge variant="outline" className="text-xs">
                                {ruling?.therapy_area ?? "Unknown area"}
                              </Badge>
                              <span className="text-xs text-slate-400 flex items-center gap-1">
                                <Building2 className="w-3 h-3" />
                                {ruling?.manufacturer ?? "Unknown manufacturer"}
                              </span>
                              <span className="text-xs text-slate-400 flex items-center gap-1">
                                <Calendar className="w-3 h-3" />
                                {ruling?.decision_date ?? "Unknown date"}
                              </span>
                            </div>
                          </div>
                          <ChevronRight className="w-5 h-5 text-slate-300 flex-shrink-0 mt-1" />
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* ── Sidebar Panels ── */}
          <div className="space-y-6">

            {/* ── By Therapy Area ── */}
            <Card className="border-slate-200" data-testid="therapy-area-breakdown">
              <CardHeader className="border-b border-slate-100 bg-slate-50/50">
                <CardTitle className="text-lg font-semibold text-slate-900 font-heading">
                  By Therapy Area
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                <div className="space-y-1">
                  {insights?.therapy_area_breakdown &&
                    Object.entries(insights.therapy_area_breakdown).map(([area, count]) => (
                      <Link
                        key={area}
                        to={`/search?therapyArea=${encodeURIComponent(area)}`}
                        className="flex items-center justify-between
                                   rounded-lg px-2 py-2
                                   hover:bg-slate-50 hover:shadow-sm
                                   transition-all duration-150 group"
                        data-testid={`therapy-area-link-${area}`}
                      >
                        <div className="flex items-center gap-2">
                          <Activity className="w-4 h-4 text-sky-500 group-hover:text-sky-600 transition-colors" />
                          <span className="text-sm text-slate-700 group-hover:text-slate-900 transition-colors">
                            {area}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge
                            variant="secondary"
                            className="font-mono text-xs group-hover:bg-sky-100 group-hover:text-sky-700 transition-colors"
                          >
                            {count ?? 0}
                          </Badge>
                          <ChevronRight className="w-3.5 h-3.5 text-slate-300 group-hover:text-sky-400 transition-colors" />
                        </div>
                      </Link>
                    ))}
                  {!insights?.therapy_area_breakdown && (
                    <div className="text-sm text-slate-500 px-2 py-2">
                      No breakdown available.
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* ── Top Manufacturers ── */}
            <Card className="border-slate-200" data-testid="top-manufacturers">
              <CardHeader className="border-b border-slate-100 bg-slate-50/50">
                <CardTitle className="text-lg font-semibold text-slate-900 font-heading">
                  Top Manufacturers
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                <div className="space-y-3">
                  {manufacturersToDisplay.length > 0 ? (
                    manufacturersToDisplay.map((mfr, index) => (
                      <div
                        key={mfr?.name ?? `mfr-${index}`}
                        className="flex items-center justify-between"
                      >
                        <div className="flex items-center gap-2">
                          <span className="w-6 h-6 bg-slate-100 rounded-full flex items-center justify-center text-xs font-semibold text-slate-600">
                            {index + 1}
                          </span>
                          <span className="text-sm text-slate-700">
                            {mfr?.name ?? "Unknown"}
                          </span>
                        </div>
                        <Badge variant="outline" className="font-mono text-xs">
                          {mfr?.count ?? 0} rulings
                        </Badge>
                      </div>
                    ))
                  ) : (
                    <div className="text-sm text-slate-500">No manufacturers data.</div>
                  )}
                </div>

                {/* Show All / Show Less toggle */}
                {hasMoreManufacturers && (
                  <button
                    onClick={() => setShowAllMfr((prev) => !prev)}
                    className="mt-4 w-full text-xs font-medium text-sky-600 hover:text-sky-800
                               border border-sky-100 hover:border-sky-300 rounded-lg py-2
                               transition-colors duration-150 flex items-center justify-center gap-1"
                    data-testid="toggle-manufacturers-btn"
                  >
                    {showAllMfr ? (
                      <>Show Less ▲</>
                    ) : (
                      <>Show All ({insights?.all_manufacturers?.length ?? 0}) ▼</>
                    )}
                  </button>
                )}
              </CardContent>
            </Card>

            {/* ── Quick Actions ── */}
            <Card
              className="border-slate-200 bg-slate-900 text-white"
              data-testid="quick-actions"
            >
              <CardContent className="p-6">
                <h3 className="font-semibold mb-2 font-heading">Quick Actions</h3>
                <p className="text-slate-400 text-sm mb-4">
                  Prepare for your next HTA submission
                </p>
                <div className="space-y-2">
                  <Link to="/search">
                    <Button
                      variant="secondary"
                      className="w-full justify-start bg-white/10 hover:bg-white/20 text-white border-0"
                      data-testid="quick-search-btn"
                    >
                      <FileText className="w-4 h-4 mr-2" />
                      Search Rulings
                    </Button>
                  </Link>
                  <Link to="/qa-generator">
                    <Button
                      variant="secondary"
                      className="w-full justify-start bg-white/10 hover:bg-white/20 text-white border-0"
                      data-testid="quick-qa-btn"
                    >
                      <Activity className="w-4 h-4 mr-2" />
                      Generate Q&A
                    </Button>
                  </Link>
                </div>
              </CardContent>
            </Card>

          </div>
        </div>
      </div>
    </div>
  );
}