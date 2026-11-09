/**
 * DossierReviewCard.jsx — Sr 47 / Sr 48
 * ─────────────────────────────────────────────────────────────────────────────
 * Attach a dossier, or one section of it, to the current research question.
 * Navigator extracts the text, suggests a review category from the question,
 * and carries both into the Q&A generator.
 *
 * Written directly in the v2 design system rather than the legacy Tailwind the
 * rest of Search still uses, so the Phase 5 port does not have to redo it.
 *
 * State lives in SessionContext (Sr 3), not here — the whole point is that it
 * survives the navigation to Q&A.
 *
 * Backend: POST /api/dossier-review/upload  (multipart: file + question)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { toast } from "sonner";
import { useSession } from "../lib/SessionContext";
import UploadCloudIcon from "./UploadCloudIcon";
import { Trash2 } from "lucide-react";
import {
  categoryOptions, categoryLabel, categoryFromCode, inferDossierCategory,
  resolveCategory, CROSS_DOSSIER,
} from "../lib/dossierCategories";

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;

const MAX_BYTES    = 20 * 1024 * 1024;
const ACCEPT_EXT   = [".pdf", ".docx", ".doc", ".txt", ".md"];
const ACCEPT_ATTR  = ACCEPT_EXT.join(",");
const ADD_CUSTOM   = "__add_custom__";

/**
 * Content fingerprint for a chosen file, used to recognise the same document
 * being picked twice.
 *
 * SHA-256 of the bytes where the browser exposes WebCrypto — that is a secure
 * context only, so plain http:// on a LAN address falls back to a name/size/
 * mtime signature. The fallback is weaker (two different files could collide
 * in principle) but it still catches the case this guards against: the user
 * re-selecting the document they already attached.
 */
async function fileFingerprint(file) {
  try {
    if (window.crypto?.subtle?.digest) {
      const bytes  = await file.arrayBuffer();
      const digest = await window.crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
  } catch {
    // Fall through — a fingerprint we cannot compute must not block an upload.
  }
  return `name:${file.name}|size:${file.size}|mtime:${file.lastModified}`;
}

export default function DossierReviewCard({ question, onUseInQA }) {
  const {
    dossierReview, setDossierReview, clearDossierReview,
    customCategories, addCustomCategory,
  } = useSession();

  const fileInputRef = useRef(null);
  const [uploading,   setUploading]   = useState(false);
  const [showCustom,  setShowCustom]  = useState(false);
  const [customName,  setCustomName]  = useState("");
  const [customError, setCustomError] = useState("");

  const trimmedQuestion = (question || "").trim();
  const suggested = useMemo(() => inferDossierCategory(trimmedQuestion), [trimmedQuestion]);

  // Keep the suggestion live as the question changes, but never overwrite a
  // category the user chose themselves.
  useEffect(() => {
    if (dossierReview.manualCategory) return;
    if (dossierReview.category === suggested) return;
    setDossierReview({ category: suggested, suggestedCategory: suggested });
  }, [suggested, dossierReview.manualCategory, dossierReview.category, setDossierReview]);

  const options = useMemo(() => categoryOptions(customCategories), [customCategories]);

  // ── Upload ────────────────────────────────────────────────────────────────
  const handleFile = useCallback(async (input) => {
    const file = input?.files?.[0];
    if (!file) return;

    const ext = `.${(file.name.split(".").pop() || "").toLowerCase()}`;
    if (!ACCEPT_EXT.includes(ext)) {
      toast.error("Use a PDF, Word or plain-text file.");
      input.value = "";
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error("The dossier file must be 20 MB or smaller.");
      input.value = "";
      return;
    }

    // Sr 48 — refuse a document that is already attached. Without this the
    // same file could be posted repeatedly, each time costing an extraction and
    // leaving another identical copy server-side.
    const fingerprint = await fileFingerprint(file);
    if (dossierReview.uploadId && dossierReview.fileHash === fingerprint) {
      toast.warning(`"${file.name}" is already attached. Delete it first to replace it.`);
      input.value = "";
      return;
    }

    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("question", trimmedQuestion);

      const { data } = await axios.post(`${API}/dossier-review/upload`, form);

      setDossierReview({
        uploadId:          data.upload_id,
        fileName:          data.filename,
        fileSizeKb:        data.size_kb,
        pageCount:         data.page_count,
        suggestedCategory: data.suggested_category,
        // A manual choice made before uploading is preserved.
        category:          dossierReview.manualCategory
          ? dossierReview.category
          : (data.suggested_category || suggested),
        textAvailable:     data.text_available,
        note:              data.note || "",
        fileHash:          fingerprint,
      });

      // Be explicit when a file stored fine but yielded no text — otherwise the
      // UI implies the dossier will inform generation when it cannot.
      if (data.text_available) {
        toast.success("Dossier Review context added to this search.");
      } else {
        toast.warning(data.note || "File stored, but no text could be read from it.");
      }
    } catch (err) {
      const detail = err?.response?.data?.detail;
      toast.error(detail || "Upload failed. Please try again.");
    } finally {
      setUploading(false);
      if (input) input.value = "";
    }
  }, [trimmedQuestion, setDossierReview, dossierReview.manualCategory, dossierReview.category,
      dossierReview.uploadId, dossierReview.fileHash, suggested]);

  const handleRemove = useCallback(() => {
    clearDossierReview();
    if (fileInputRef.current) fileInputRef.current.value = "";
    toast("Dossier Review context deleted.");
  }, [clearDossierReview]);

  // ── Category ──────────────────────────────────────────────────────────────
  const handleCategoryChange = useCallback((e) => {
    const value = e.target.value;
    if (value === ADD_CUSTOM) {
      setShowCustom(true);
      setCustomError("");
      setCustomName("");
      return;
    }
    setShowCustom(false);
    setDossierReview({ category: value, manualCategory: true });
  }, [setDossierReview]);

  const handleAddCustom = useCallback(() => {
    const clean = customName.trim().replace(/\s+/g, " ");
    if (!clean) {
      setCustomError("Enter a category name that is not already in the list.");
      return;
    }
    const existing = options.some((o) => o.label.toLowerCase() === clean.toLowerCase());
    if (existing || !addCustomCategory(clean)) {
      setCustomError("Enter a category name that is not already in the list.");
      return;
    }
    setDossierReview({ category: clean, manualCategory: true });
    setShowCustom(false);
    setCustomName("");
    setCustomError("");
    toast.success(`Dossier category added: ${clean}`);
  }, [customName, options, addCustomCategory, setDossierReview]);

  const cancelCustom = useCallback(() => {
    setShowCustom(false);
    setCustomName("");
    setCustomError("");
  }, []);

  const hasFile       = Boolean(dossierReview.uploadId);
  const activeCategory = dossierReview.category || suggested;

  // What the chosen category will actually do when Q&A generates. A custom name
  // used to resolve to nothing and quietly generate all three dossiers, with no
  // hint here that the choice had been ignored.
  const resolved = useMemo(() => resolveCategory(activeCategory), [activeCategory]);
  const generationNote = useMemo(() => {
    if (!resolved.value) return "";
    const backing = categoryLabel(categoryFromCode(resolved.code));
    if (resolved.matchedVia === "inferred") {
      return `Generates the ${backing}, filed under “${resolved.value}”.`;
    }
    if (resolved.code) return `Generates the ${backing}.`;
    return "Generates all three dossier types, each question filed under its own.";
  }, [resolved]);

  return (
    <div
      className="v2-card v2-pad"
      style={{ marginBottom: 14, borderColor: "#CFC6E8", background: "linear-gradient(135deg,#FBF9FF 0%,#F6F3FC 100%)" }}
      data-testid="dossier-review-card"
    >
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 14, flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flex: 1, minWidth: 260 }}>
          <span aria-hidden="true" style={{ width: 32, height: 32, borderRadius: 8, background: "var(--indigo)", color: "#fff", display: "grid", placeItems: "center", fontSize: 16, flex: "0 0 auto" }}>▣</span>
          <div>
            <h3 style={{ margin: "0 0 4px", textTransform: "none", letterSpacing: 0, fontSize: 15, color: "var(--ink)" }}>
              Dossier Review context
            </h3>
            {/* Option B - Remove the Upload Dossier option from Ruling Search and keep it only in Q&A Generator - Code Removal - Part1
            <div style={{ fontSize: 12.5, lineHeight: 1.5, color: "var(--ink-2)" }}>
              Upload a dossier or section for this research question. Navigator uses it to categorise
              the matched rulings and carries the same review context into Q&amp;A.
            </div> */}
          </div>
        </div>
        <span className="v2-tag v2-t-rev">Optional · question-specific</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(260px,1.4fr) minmax(220px,1fr)", gap: 12, alignItems: "start" }}>
        {/* ── Upload ───────────────────────────────────────────────── */}

        {/* Option B - Remove the Upload Dossier option from Ruling Search and keep it only in Q&A Generator - Code Removal - Part2
         <div>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--ink-2)", marginBottom: 6 }}>
            Dossier or selected section
          </div>
          <label className={`v2-upl-label ${hasFile ? "ready" : "review"}`} data-testid="dossier-upload-label">
            <UploadCloudIcon size={24} />
            <span style={{ flex: 1 }}>
              {uploading ? (
                <b>Uploading…</b>
              ) : hasFile ? (
                <>
                  <b>Dossier ready for review</b><br />
                  <span style={{ color: "var(--muted)" }}>Choose a different file to replace it</span>
                </>
              ) : (
                <>
                  <b>Choose a file</b><br />
                  <span style={{ color: "var(--muted)" }}>PDF, Word or plain text · up to 20 MB</span>
                </>
              )}
            </span>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT_ATTR}
              style={{ display: "none" }}
              disabled={uploading}
              onChange={(e) => handleFile(e.target)}
              data-testid="dossier-upload-input"
            />
          </label>

          {hasFile && (
            <div className="v2-upl-info" data-testid="dossier-upload-info">
              <span aria-hidden="true">✓</span>
              <b>{dossierReview.fileName}</b>
              <span style={{ color: "var(--muted)" }}>
                · {dossierReview.fileSizeKb} KB
                {dossierReview.pageCount > 0 && ` · ${dossierReview.pageCount} page${dossierReview.pageCount !== 1 ? "s" : ""}`}
              </span>
              
              <button type="button" className="v2-btn v2-ghost v2-sm" onClick={handleRemove} 
              style={{ color: "var(--neg)", display: "flex", alignItems: "center", gap: 5, marginLeft: "auto" }} data-testid="dossier-delete-btn"
            ><Trash2 size={13} /> Delete</button>
            </div>
          )}

          {hasFile && !dossierReview.textAvailable && (
            <div style={{ marginTop: 7, fontSize: 11.5, color: "var(--cond)" }}>
              ⚠ {dossierReview.note || "No text could be read from this file, so it will not inform generation."}
            </div>
          )}
        </div> */}

        {/* ── Category ─────────────────────────────────────────────── */}
        <div>
          <label htmlFor="drCategory" style={{ display: "block", fontSize: 11.5, fontWeight: 700, color: "var(--ink-2)", marginBottom: 6 }}>
            Review category
          </label>
          <select
            id="drCategory"
            className="v2-sel"
            style={{ width: "100%", padding: "9px 10px" }}
            value={showCustom ? ADD_CUSTOM : activeCategory}
            onChange={handleCategoryChange}
            data-testid="dossier-category-select"
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
            <option value={ADD_CUSTOM}>＋ Add a new category…</option>
          </select>

          {showCustom && (
            <div style={{ marginTop: 8, padding: 9, border: "1px solid #D9D1EB", borderRadius: 8, background: "#fff" }}>
              <label htmlFor="drCustomCategory" style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--ink-2)", marginBottom: 5 }}>
                New category name
              </label>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  id="drCustomCategory"
                  className="v2-sel"
                  maxLength={60}
                  style={{ flex: 1, minWidth: 0, padding: "8px 9px" }}
                  placeholder="e.g. Real-world evidence"
                  value={customName}
                  onChange={(e) => { setCustomName(e.target.value); setCustomError(""); }}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleAddCustom(); } }}
                />
                <button type="button" className="v2-btn v2-mag v2-sm" onClick={handleAddCustom}>Add</button>
                <button type="button" className="v2-btn v2-ghost v2-sm" onClick={cancelCustom}>Cancel</button>
              </div>
              {customError && (
                <div style={{ color: "var(--neg)", fontSize: 11, marginTop: 5 }}>{customError}</div>
              )}
            </div>
          )}

          <div style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.45, marginTop: 6 }}>
            Navigator suggests a category from the question. Select an existing category or add a name
            that suits this dossier.
          </div>

          {generationNote && (
            <div
              style={{ fontSize: 11.5, color: "var(--ink-2)", lineHeight: 1.45, marginTop: 6 }}
              data-testid="dossier-category-effect"
            >
              {generationNote}
            </div>
          )}
        </div>
      </div>

      {/* ── Question preview ───────────────────────────────────────── */}
      <div style={{ marginTop: 12, padding: "10px 12px", border: "1px solid #DDD6EE", borderRadius: 8, background: "#fff", display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 3 }}>
            Categorisation follows this question
          </div>
          <div style={{ fontSize: 12.5, fontWeight: 650, color: "var(--ink)" }}>
            {trimmedQuestion || <span style={{ color: "var(--muted)", fontWeight: 500 }}>Type a research question above</span>}
          </div>
        </div>
        <div style={{ fontSize: 12, color: "var(--ink-2)" }}>
          Suggested: <b>{categoryLabel(suggested)}</b>
          {suggested === CROSS_DOSSIER && (
            <div style={{ fontSize: 11, color: "var(--muted)" }}>Question spans more than one component</div>
          )}
        </div>
        <button
          type="button"
          className="v2-btn v2-mag v2-sm"
          onClick={() => onUseInQA?.()}
          data-testid="dossier-use-in-qa"
        >
          Use in Q&amp;A
        </button>
      </div>
    </div>
  );
}
