import { useState, useEffect, useMemo, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import axios from "axios";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { Separator } from "../components/ui/separator";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";
import {
  ArrowLeft,
  Download,
  Calendar,
  Building2,
  CheckCircle,
  XCircle,
  AlertCircle,
  Copy,
  FileText
} from "lucide-react";

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;

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

const getOutcomeBadgeClass = (outcome) => {
  if (outcome === "Positive") return "badge-positive";
  if (outcome === "Negative") return "badge-negative";
  if (outcome?.includes?.("Conditions")) return "badge-conditional";
  return "bg-slate-100 text-slate-700 border-slate-200";
};

const getOutcomeIcon = (outcome) => {
  if (outcome === "Positive") return <CheckCircle className="w-5 h-5 text-emerald-600" />;
  if (outcome === "Negative") return <XCircle className="w-5 h-5 text-red-600" />;
  return <AlertCircle className="w-5 h-5 text-amber-600" />;
};

const seenWarnings = new Set();
function warnOnce(key, payload) {
  if (!seenWarnings.has(key)) {
    console.warn(key, payload);
    seenWarnings.add(key);
  }
}

export default function RulingDetail() {
  const { id } = useParams();
  const [ruling, setRuling] = useState(null);
  const [loading, setLoading] = useState(true);
  const [aiSummary, setAiSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const exportRef = useRef(null);
  const sourceDocRef = useRef(null);

  const requiredRulingFields = useMemo(
    () => [
      "id", "title", "drug_name", "manufacturer", "indication", "comparator",
      "price_per_unit", "annual_cost", "patient_population", "clinical_evidence",
      "cost_effectiveness", "budget_impact", "full_text", "decision_outcome",
      "therapy_area", "dossier_category", "decision_type", "decision_date",
      "zin_reference", "summary", "key_considerations", "tags"
    ],
    []
  );

  useEffect(() => {
    console.log("REACT_APP_BACKEND_URL:", process.env.REACT_APP_BACKEND_URL);
    console.log("API base:", API);

    const fetchRuling = async () => {
      setLoading(true);
      try {
        const response = await axios.get(`${API}/rulings/${id}`);
        const data = response?.data;
        if (!data || typeof data !== "object") {
          warnOnce("Expected single ruling object, got:", data);
          setRuling(null);
          toast.error("Ruling response format is invalid");
        } else {
          requiredRulingFields.forEach((f) => {
            if (data?.[f] == null) warnOnce(`ruling missing field: ${f}`, data);
          });
          if (!Array.isArray(data?.key_considerations))
            warnOnce("ruling.key_considerations should be an array", data?.key_considerations);
          if (!Array.isArray(data?.tags))
            warnOnce("ruling.tags should be an array", data?.tags);
          setRuling(data);
        }
      } catch (error) {
        console.error("Failed to fetch ruling:", {
          message: error?.message,
          code: error?.code,
          url: error?.config?.url,
          status: error?.response?.status,
          data: error?.response?.data
        });
        toast.error("Failed to load ruling details");
        setRuling(null);
      } finally {
        setLoading(false);
      }
    };

    if (id) fetchRuling();
  }, [id, requiredRulingFields]);

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text ?? "");
    toast.success("Copied to clipboard");
  };

  // ─── PDF Export ────────────────────────────────────────────────────────────
  const exportToPdf = async () => {
    const node = exportRef.current;
    if (!node) { toast.error("Nothing to export"); return; }

    const pdfHeader = node.querySelector("[data-pdf-header='true']");

    // ── Use ruling state directly — do NOT re-declare fileUrl inside here ──
    const pdfFileUrl  = ruling?.file_url ?? null;
    const pdfFileName = pdfFileUrl
      ? decodeURIComponent(pdfFileUrl.split("/").pop().split("?")[0])
      : null;

    console.log("[exportToPdf] fileUrl:", pdfFileUrl);
    console.log("[exportToPdf] fileName:", pdfFileName);

    try {
      const originalBg = node.style.backgroundColor;
      node.style.backgroundColor = "#ffffff";

      if (pdfHeader) pdfHeader.style.display = "block";

      // ── Hide source doc card before canvas capture ──
      if (sourceDocRef.current) sourceDocRef.current.style.display = "none";

      const canvas = await html2canvas(node, {
        scale: 2,
        useCORS: true,
        backgroundColor: "#ffffff",
        logging: process.env.NODE_ENV === "development"
      });

      // ── Restore source doc card ──
      if (sourceDocRef.current) sourceDocRef.current.style.display = "";
      if (pdfHeader) pdfHeader.style.display = "none";
      node.style.backgroundColor = originalBg || "";

      const imgData     = canvas.toDataURL("image/png");
      const pdf         = new jsPDF("p", "mm", "a4");
      const pageWidth   = pdf.internal.pageSize.getWidth();
      const pageHeight  = pdf.internal.pageSize.getHeight();

      const imgWidthPx  = canvas.width;
      const imgHeightPx = canvas.height;

      const margin         = 10;
      const availableWidth = pageWidth - margin * 2;
      const imgWidthMm     = availableWidth;
      const imgHeightMm    = (imgHeightPx / imgWidthPx) * imgWidthMm;

      let remainingHeightMm = imgHeightMm;

      pdf.addImage(
        imgData, "PNG",
        margin, margin,
        imgWidthMm, Math.min(remainingHeightMm, pageHeight - margin * 2),
        undefined, "FAST"
      );
      remainingHeightMm -= (pageHeight - margin * 2);

      if (remainingHeightMm > 0) {
        const sliceCanvas = document.createElement("canvas");
        const ctx         = sliceCanvas.getContext("2d");
        const mmToPx      = (mm) => (mm * 96) / 25.4;
        const targetWidthPx      = Math.floor(mmToPx(availableWidth));
        const targetPageHeightPx = Math.floor(mmToPx(pageHeight - margin * 2));
        const scaleX             = targetWidthPx / imgWidthPx;

        let offsetPx = Math.floor(
          mmToPx(pageHeight - margin * 2) / (imgWidthMm / imgWidthPx)
        );

        while (offsetPx < imgHeightPx) {
          const sliceHeightPx = Math.min(
            imgHeightPx - offsetPx,
            Math.floor(targetPageHeightPx / scaleX)
          );

          sliceCanvas.width  = targetWidthPx;
          sliceCanvas.height = Math.floor(sliceHeightPx * scaleX);

          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, sliceCanvas.width, sliceCanvas.height);
          ctx.drawImage(
            canvas,
            0, offsetPx, imgWidthPx, sliceHeightPx,
            0, 0, sliceCanvas.width, sliceCanvas.height
          );

          pdf.addPage();
          pdf.addImage(
            sliceCanvas.toDataURL("image/png"), "PNG",
            margin, margin,
            availableWidth, pageHeight - margin * 2,
            undefined, "FAST"
          );

          offsetPx += sliceHeightPx;
        }
      }

      // ── Add Source Document as native jsPDF page with clickable link ──────
      if (pdfFileUrl && pdfFileName) {
        pdf.addPage();

        const sectionY = margin + 10;

        // Section title
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(14);
        pdf.setTextColor(109, 43, 80); // Mulberry #6D2B50
        pdf.text("Source Document", margin, sectionY);

        // Divider line
        pdf.setDrawColor(226, 232, 240);
        pdf.setLineWidth(0.3);
        pdf.line(margin, sectionY + 4, pageWidth - margin, sectionY + 4);

        // Label text
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(10);
        pdf.setTextColor(100, 116, 139); // slate-500
        pdf.text("Source URL —", margin, sectionY + 14);

        // Clickable filename
        const labelWidth = pdf.getTextWidth("Source URL — ");
        const linkX      = margin + labelWidth + 1;
        const linkY      = sectionY + 14;
        const linkText   = pdfFileName;
        const linkWidth  = pdf.getTextWidth(linkText);
        const linkHeight = 5;

        pdf.setTextColor(2, 132, 199); // sky-600
        pdf.setFont("helvetica", "normal");
        pdf.text(linkText, linkX, linkY);

        // Underline
        pdf.setDrawColor(2, 132, 199);
        pdf.setLineWidth(0.3);
        pdf.line(linkX, linkY + 1, linkX + linkWidth, linkY + 1);

        // Clickable hotspot
        pdf.link(linkX, linkY - linkHeight, linkWidth, linkHeight + 2, { url: pdfFileUrl });

        console.log("[exportToPdf] Source Document page added with link:", pdfFileUrl);
      } else {
        console.warn("[exportToPdf] Skipped Source Document page — fileUrl or fileName missing", {
          pdfFileUrl,
          pdfFileName
        });
      }
      // ─────────────────────────────────────────────────────────────────────

      const safeTitle = (ruling?.title || "ruling")
        .replace(/[^\w\-]+/g, "_")
        .slice(0, 60);
      pdf.save(`${safeTitle}_${ruling?.id || "export"}.pdf`);
      toast.success("PDF exported");

    } catch (e) {
      if (sourceDocRef.current) sourceDocRef.current.style.display = "";
      if (pdfHeader) pdfHeader.style.display = "none";
      console.error("PDF export failed:", e);
      toast.error("Failed to export PDF");
    }
  };
  // ───────────────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="p-8" data-testid="ruling-detail-loading">
        <Skeleton className="h-8 w-32 mb-8" />
        <div className="grid grid-cols-3 gap-8">
          <div className="col-span-2 space-y-6">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-96 w-full" />
          </div>
          <div className="space-y-6">
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        </div>
      </div>
    );
  }

  if (!ruling) {
    return (
      <div className="p-8 text-center" data-testid="ruling-not-found">
        <FileText className="w-16 h-16 text-slate-300 mx-auto mb-4" />
        <h2 className="text-xl font-semibold font-heading mb-2" style={{ color: "#6D2B50" }}>
          Ruling Not Found
        </h2>
        <p className="text-slate-500 mb-4">The requested ruling could not be found.</p>
        <Link to="/search">
          <Button>
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Search
          </Button>
        </Link>
      </div>
    );
  }

  const outcome           = ruling?.decision_outcome   ?? "Unknown";
  const therapyArea       = ruling?.therapy_area       ?? "Unknown area";
  const decisionType      = ruling?.decision_type      ?? "Unknown type";
  const decisionDate      = ruling?.decision_date      ?? "Unknown date";
  const dossierCategory   = ruling?.dossier_category   ?? "Unknown date";
  const zinRef            = ruling?.zin_reference      ?? "N/A";
  const title             = ruling?.title              ?? "Untitled ruling";
  const summary           = ruling?.summary            ?? "No summary available.";
  const drugName          = ruling?.drug_name          ?? "Unknown drug";
  const manufacturer      = ruling?.manufacturer       ?? "Unknown manufacturer";
  const indication        = ruling?.indication         ?? "N/A";
  const comparator        = ruling?.comparator         ?? "N/A";
  const pricePerUnit      = ruling?.price_per_unit     ?? "N/A";
  const annualCost        = ruling?.annual_cost        ?? "N/A";
  const patientPopulation = ruling?.patient_population ?? "N/A";
  const clinicalEvidence  = ruling?.clinical_evidence  ?? "Not provided.";
  const costEffectiveness = ruling?.cost_effectiveness ?? "Not provided.";
  const budgetImpact      = ruling?.budget_impact      ?? "Not provided.";
  const fullText          = ruling?.full_text          ?? "";
  const keyConsiderations = Array.isArray(ruling?.key_considerations)
    ? ruling.key_considerations : [];
  const tags              = Array.isArray(ruling?.tags) ? ruling.tags : [];

  // ── Source document URL ──
  const fileUrl  = ruling?.file_url ?? null;
  const fileName = fileUrl
    ? decodeURIComponent(fileUrl.split("/").pop().split("?")[0])
    : "Source Document";

  const outcomePillStyles = {
    backgroundColor:
      outcome === "Positive" ? "#d1fae5" :
      outcome === "Negative" ? "#fee2e2" :
      outcome?.includes?.("Conditions") ? "#fef3c7" : "#f1f5f9",
    color:
      outcome === "Positive" ? "#065f46" :
      outcome === "Negative" ? "#991b1b" :
      outcome?.includes?.("Conditions") ? "#92400e" : "#475569",
    border: `1px solid ${
      outcome === "Positive" ? "#6ee7b7" :
      outcome === "Negative" ? "#fca5a5" :
      outcome?.includes?.("Conditions") ? "#fcd34d" : "#cbd5e1"
    }`
  };

  return (
    <div data-testid="ruling-detail-page">

      {/* ── Page Header ─────────────────────────────────────────────────────── */}
      <header className="page-header">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/search">
              <Button variant="ghost" size="icon" data-testid="back-btn">
                <ArrowLeft className="w-5 h-5" />
              </Button>
            </Link>
            <div>
              <h1
                className="text-xl font-bold font-heading mt-2"
                style={{ color: "#6D2B50" }}
              >
                {title}
              </h1>
              <div className="flex items-center gap-3">
                <Badge className={getOutcomeBadgeClass(outcome)}>
                  {outcome}
                </Badge>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              data-testid="download-btn"
              onClick={exportToPdf}
              title="Export the details section as PDF"
            >
              <Download className="w-4 h-4 mr-2" />
              Export PDF
            </Button>
          </div>
        </div>
      </header>

      {/* ── Exportable Content Area ──────────────────────────────────────────── */}
      <div className="p-8">
        <div className="detail-layout bg-white" ref={exportRef}>

          {/* PDF-only title block */}
          <div
            data-pdf-header="true"
            style={{
              display: "none",
              padding: "16px 0 20px",
              borderBottom: "1px solid #e2e8f0",
              marginBottom: "24px",
              gridColumn: "1 / -1"
            }}
          >
            <h1
              style={{
                fontSize: "22px",
                fontWeight: "700",
                color: "#6D2B50",
                marginBottom: "10px",
                lineHeight: "1.3"
              }}
            >
              {title}
            </h1>
            <span
              style={{
                display: "inline-block",
                padding: "3px 12px",
                borderRadius: "9999px",
                fontSize: "13px",
                fontWeight: "600",
                ...outcomePillStyles
              }}
            >
              {outcome}
            </span>
          </div>

          {/* ── Main Content Column ───────────────────────────────────────────── */}
          <div className="space-y-6">

            {/* Drug Info Card */}
            <Card className="border-slate-200" data-testid="drug-info-card">
              <CardHeader className="pb-4">
                <CardTitle
                  className="text-lg font-semibold font-heading"
                  style={{ color: "#6D2B50" }}
                >
                  Drug Information
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Drug Name</p>
                    <p className="text-lg font-semibold text-sky-600">{drugName}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Manufacturer</p>
                    <p className="text-slate-900 font-medium flex items-center gap-2">
                      <Building2 className="w-4 h-4 text-slate-400" />
                      {manufacturer}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Indication</p>
                    <p className="text-slate-700">{indication}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Comparator</p>
                    <p className="text-slate-700">{comparator}</p>
                  </div>
                </div>

                <Separator className="my-6" />

                <div className="grid grid-cols-3 gap-6">
                  <div>
                    <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Price per Unit</p>
                    <p className="text-slate-900 font-mono">{pricePerUnit}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Annual Cost</p>
                    <p className="text-slate.900 font-mono">{annualCost}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Patient Population</p>
                    <p className="text-slate-700 text-sm">{patientPopulation}</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Assessment Details */}
            <Card className="border-slate-200" data-testid="assessment-details">
              <CardHeader className="pb-4">
                <CardTitle
                  className="text-lg font-semibold font-heading"
                  style={{ color: "#6D2B50" }}
                >
                  Assessment Details
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div>
                  <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Clinical Evidence</p>
                  <p className="text-slate-700 leading-relaxed">{clinicalEvidence}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Cost-Effectiveness</p>
                  <p className="text-slate-700 leading-relaxed">{costEffectiveness}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Budget Impact</p>
                  <p className="text-slate-700 leading-relaxed">{budgetImpact}</p>
                </div>
              </CardContent>
            </Card>

            {/* Full Assessment Report */}
            <Card className="border-slate-200" data-testid="full-assessment">
              <CardHeader className="pb-4 flex flex-row items-center justify-between">
                <CardTitle
                  className="text-lg font-semibold font-heading"
                  style={{ color: "#6D2B50" }}
                >
                  Full Assessment Report
                </CardTitle>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => copyToClipboard(fullText)}
                  data-testid="copy-report-btn"
                >
                  <Copy className="w-4 h-4 mr-2" />
                  Copy
                </Button>
              </CardHeader>
              <CardContent>
                <div className="bg-slate-50 rounded-lg p-6 font-mono text-sm text-slate-700 whitespace-pre-wrap leading-relaxed max-h-96 overflow-y-auto">
                  {fullText || "No full text available."}
                </div>
              </CardContent>
            </Card>

            {/* ── Source Document (UI only — excluded from canvas) ─────────────── */}
            {fileUrl && (
              <Card
                className="border-slate-200"
                data-testid="source-document"
                ref={sourceDocRef}
              >
                <CardHeader className="pb-4">
                  <CardTitle
                    className="text-lg font-semibold font-heading"
                    style={{ color: "#6D2B50" }}
                  >
                    Source Document
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-2">
                    <FileText className="w-4 h-4 text-slate-400 flex-shrink-0" />
                    <span className="text-sm text-slate-500">Source URL —</span>
                    <a
                      href={fileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-sky-600 hover:text-sky-800 underline underline-offset-2 break-all"
                    >
                      {fileName}
                    </a>
                  </div>
                </CardContent>
              </Card>
            )}
            {/* ────────────────────────────────────────────────────────────────── */}

          </div>

          {/* ── Sidebar Column ────────────────────────────────────────────────── */}
          <div className="space-y-6">

            {/* Decision Summary */}
            <Card className="border-slate-200 sticky top-24" data-testid="decision-summary">
              <CardHeader className="pb-4">
                <div className="flex items-center gap-3">
                  {getOutcomeIcon(outcome)}
                  <CardTitle
                    className="text-lg font-semibold font-heading"
                    style={{ color: "#6D2B50" }}
                  >
                    Decision Summary
                  </CardTitle>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-500">Therapy Area</span>
                  <Badge variant="outline">{therapyArea}</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-500">Dossier Category</span>
                  <span className="text-sm font-medium">{dossierCategory}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-500">Decision Type</span>
                  <span className="text-sm font-medium">{decisionType}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-500">Decision Date</span>
                  <span className="text-sm font-mono flex items-center gap-1">
                    <Calendar className="w-3 h-3" />
                    {decisionDate}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-500">ZIN Reference</span>
                  <span className="text-sm font-mono">{zinRef}</span>
                </div>

                <Separator />

                <div>
                  <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Official Summary</p>
                  <p className="text-sm text-slate-700 leading-relaxed">{summary}</p>
                </div>

                <div>
                  <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Key Considerations</p>
                  {keyConsiderations.length > 0 ? (
                    <ul className="space-y-2">
                      {keyConsiderations.map((consideration, idx) => (
                        <li key={idx} className="flex items-start gap-2 text-sm text-slate-700">
                          <CheckCircle className="w-4 h-4 text-sky-500 mt-0.5 flex-shrink-0" />
                          <span>{consideration}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-slate-500">No key considerations provided.</p>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Tags */}
            <Card className="border-slate-200" data-testid="tags-card">
              <CardHeader className="pb-4">
                <CardTitle
                  className="text-sm font-semibold font-heading"
                  style={{ color: "#6D2B50" }}
                >
                  Tags
                </CardTitle>
              </CardHeader>
              <CardContent>
                {tags.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {tags.map(tag => (
                      <Badge key={tag} variant="outline" className="text-xs">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">No tags provided.</p>
                )}
              </CardContent>
            </Card>

            <div className="text-center py-4">
              <p className="text-sm text-slate-500 mb-4">AI-Powered Summary</p>
            </div>

          </div>

        </div>
      </div>
    </div>
  );
}