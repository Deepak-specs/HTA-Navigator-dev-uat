/**
 * qaPdf.js — Sr 79
 * ─────────────────────────────────────────────────────────────────────────────
 * Generated Q&A → PDF.
 *
 * Lifted verbatim out of QAGenerator.jsx during the Phase 6 rewrite so the
 * working export survives the page being rebuilt. Logic unchanged; only the
 * module boundary is new.
 *
 * Note: the redesign's header shows "Export to Word". That is not implemented —
 * this remains a PDF export, and the button is labelled accordingly rather than
 * promising a format we do not produce.
 *
 * Sr 81  the review status is printed on each question, and the card geometry is
 *        measured with the font each block is actually drawn in (see `layout`),
 *        which is what put the question and source lines outside the card.
 */
import jsPDF from "jspdf";
import { getMeta } from "./qaMeta";

// ─── Drawing helpers ──────────────────────────────────────────────────────────
// These were left behind in QAGenerator.jsx when the export was lifted out into
// this module, so every call below threw "safeFill is not defined" and the
// button did nothing. They are restored here, unchanged from the original.
//
// jsPDF's colour setters accept several argument shapes, and passing a value
// that is undefined or out of range silently produces a black fill. Clamping
// and rounding to exactly three numeric channels keeps that from happening.
function safeFill(doc, r, g, b) {
  doc.setFillColor(
    Math.round(Math.min(255, Math.max(0, r))),
    Math.round(Math.min(255, Math.max(0, g))),
    Math.round(Math.min(255, Math.max(0, b)))
  );
}

function safeDraw(doc, r, g, b) {
  doc.setDrawColor(
    Math.round(Math.min(255, Math.max(0, r))),
    Math.round(Math.min(255, Math.max(0, g))),
    Math.round(Math.min(255, Math.max(0, b)))
  );
}

function safeText(doc, r, g, b) {
  doc.setTextColor(
    Math.round(Math.min(255, Math.max(0, r))),
    Math.round(Math.min(255, Math.max(0, g))),
    Math.round(Math.min(255, Math.max(0, b)))
  );
}

// jsPDF wraps with whatever font is current when splitTextToSize runs, not the
// one in force when the lines are finally drawn. Every block below was measured
// against whichever font the previous block happened to leave set — the
// question, drawn at 10pt bold, was measured at 9pt normal — so its lines were
// too wide for the card and ran past the right border, and the line counts the
// card height was built from were wrong. Measuring and drawing through the same
// helper keeps the two in step.
function setFont(doc, size, style = "normal") {
  doc.setFontSize(size);
  doc.setFont("helvetica", style);
}

function layout(doc, text, maxWidth, size, style = "normal") {
  setFont(doc, size, style);
  return doc.splitTextToSize(String(text || ""), maxWidth);
}

// Importance pill colours, matching the priority tags on the page.
function impPdfColor(imp) {
  switch ((imp || "").toLowerCase()) {
    case "high":   return { bg: [239, 68,  68],  light: [254, 226, 226] }; // red
    case "medium": return { bg: [245, 158, 11],  light: [254, 243, 199] }; // amber
    default:       return { bg: [148, 163, 184], light: [241, 245, 249] }; // slate
  }
}

// Review status, printed beside the importance pill. The colours match the
// status tags on the page: green for ready, amber for needs evidence, slate for
// a draft that has not been looked at yet.
function statusPdfStyle(status) {
  switch ((status || "draft").toLowerCase()) {
    case "ready":          return { label: "READY",          bg: [ 22, 163,  74] };
    case "needs_evidence": return { label: "NEEDS EVIDENCE", bg: [217, 119,   6] };
    default:               return { label: "DRAFT",          bg: [100, 116, 139] };
  }
}

export function exportToPdf(
  dossiers, totalQCount, selectedRulingTitles = [], yourDocumentNames = []
) {
  const doc   = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const mL    = 48;
  const mR    = 48;
  const cW    = pageW - mL - mR;
  let   y     = 0;

  const guard = (needed = 20) => {
    if (y + needed > pageH - 48) { doc.addPage(); y = 48; }
  };


  // Header: document title + page number (moved from the old footer).
  // Footer: AI-generated content disclaimer on every page.

  // Header (pages 2+): document title.
  // Footer (all pages): AI disclaimer at the left margin, page number at the right margin.

  const drawHeadersAndFooters = () => {
    const total = doc.internal.getNumberOfPages();
    for (let p = 1; p <= total; p++) {
      doc.setPage(p);

      // Header (pages 2+): document title
      if (p > 1) {
        setFont(doc, 8);
        safeText(doc, 148, 163, 184);
        doc.text("HTA Q&A Generator", mL, 24);
      }

      // Footer: disclaimer centred, page number at the right margin
      setFont(doc, 8, "italic");
      safeText(doc, 148, 163, 184);
      doc.text(
        "This is an AI-generated content",
        pageW / 2, pageH - 20, { align: "center" }
      );

      setFont(doc, 8);
      doc.text(`Page ${p} of ${total}`, pageW - mR, pageH - 20, { align: "right" });
    }
  };

  safeFill(doc, 14, 165, 233);
  doc.rect(0, 0, pageW, 190, "F");
  safeText(doc, 255, 255, 255);
  doc.setFontSize(28);
  doc.setFont("helvetica", "bold");
  doc.text("HTA Q&A Generator", mL, 78);
  doc.setFontSize(13);
  doc.setFont("helvetica", "normal");
  doc.text("Predicted ZIN Questions & Suggested Responses", mL, 108);
  doc.setFontSize(10);
  doc.text(
    `Generated: ${new Date().toLocaleDateString("en-GB", {
      day: "numeric", month: "long", year: "numeric",
    })}`,
    mL, 138
  );
  const readyCount = dossiers.reduce(
    (n, d) => n + (d.predicted_questions || [])
      .filter((q) => (q.status || "").toLowerCase() === "ready").length,
    0
  );
  // "1 dossier" counted the dossier CATEGORY the questions were generated for
  // (Pharmacoeconomic, Budget Impact, Pharmacotherapeutic) — but it read as
  // "one dossier document was attached", which is a different thing entirely
  // and was false whenever no file had been uploaded. The count is named for
  // what it actually is, and what the user did attach is stated separately
  // below.
  doc.text(
    `${totalQCount} question${totalQCount !== 1 ? "s" : ""}  •  ` +
    `${dossiers.length} dossier categor${dossiers.length !== 1 ? "ies" : "y"}  •  ` +
    `${selectedRulingTitles.length} ruling${selectedRulingTitles.length !== 1 ? "s" : ""}  •  ` +
    `${readyCount} of ${totalQCount} marked ready`,
    mL, 158
  );

  y = 216;

  if (selectedRulingTitles.length > 0) {
    safeText(doc, 30, 41, 59);
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.text("Reference Rulings:", mL, y);
    y += 16;
    selectedRulingTitles.forEach((title, idx) => {
      const lines = layout(doc, `${idx + 1}. ${title}`, cW - 20, 9);
      lines.forEach((line) => {
        guard(14);
        setFont(doc, 9);
        safeText(doc, 71, 85, 105);
        doc.text(line, mL + 10, y);
        y += 13;
      });
    });
    y += 10;
  }

  // The submitter's own documents, named as theirs. Printed even when there are
  // none: an export that lists only rulings and says nothing about uploads
  // leaves the reader to guess whether a dossier was read and ignored.
  safeText(doc, 30, 41, 59);
  setFont(doc, 10, "bold");
  guard(30);
  doc.text("Your documents:", mL, y);
  y += 16;
  if (yourDocumentNames.length > 0) {
    yourDocumentNames.forEach((name, idx) => {
      layout(doc, `${idx + 1}. ${name}`, cW - 20, 9).forEach((line) => {
        guard(14);
        setFont(doc, 9);
        safeText(doc, 71, 85, 105);
        doc.text(line, mL + 10, y);
        y += 13;
      });
    });
  } else {
    setFont(doc, 9, "italic");
    safeText(doc, 71, 85, 105);
    doc.text(
      "None attached — every source cited below is a published ZIN ruling.",
      mL + 10, y
    );
    y += 13;
  }
  y += 14;

  dossiers.forEach((d) => {
    const meta      = getMeta(d.dossier_code);
    const [r, g, b] = meta.rgb;
    const qCount    = (d.predicted_questions || []).length;
    // Wrapped rather than drawn as one line: a custom dossier name the user
    // typed is as long as they made it, and used to run off the coloured box.
    const nameLines = layout(doc, d.dossier_name || d.dossier_code, cW - 28, 11, "bold");
    const boxH      = 48 + (nameLines.length - 1) * 14;
    guard(boxH + 10);
    safeFill(doc, r, g, b);
    doc.roundedRect(mL, y, cW, boxH, 6, 6, "F");
    safeText(doc, 255, 255, 255);
    setFont(doc, 11, "bold");
    nameLines.forEach((line, i) => doc.text(line, mL + 14, y + 18 + i * 14));
    setFont(doc, 9);
    doc.text(
      `${qCount} question${qCount !== 1 ? "s" : ""}`,
      mL + 14, y + boxH - 14
    );
    y += boxH + 10;
  });

  let globalQNum = 0;
  dossiers.forEach((dossier) => {
    const meta         = getMeta(dossier.dossier_code);
    const [r, g, b]    = meta.rgb;
    const [rl, gl, bl] = meta.rgbLight;
    const qs           = Array.isArray(dossier.predicted_questions)
      ? dossier.predicted_questions : [];

    doc.addPage();
    y = 48;
    safeFill(doc, r, g, b);
    doc.rect(0, 0, pageW, 5, "F");
    safeFill(doc, rl, gl, bl);
    safeDraw(doc, r, g, b);
    doc.setLineWidth(0.8);
    const titleLines = layout(
      doc, dossier.dossier_name || dossier.dossier_code, cW - 28, 15, "bold"
    );
    const headH = 54 + (titleLines.length - 1) * 18;
    doc.roundedRect(mL, y, cW, headH, 6, 6, "FD");
    safeText(doc, r, g, b);
    setFont(doc, 15, "bold");
    titleLines.forEach((line, i) => doc.text(line, mL + 14, y + 22 + i * 18));
    setFont(doc, 9);
    safeText(doc, 100, 116, 139);
    doc.text(
      `${qs.length} predicted question${qs.length !== 1 ? "s" : ""}`,
      mL + 14, y + headH - 16
    );
    y += headH + 16;

    qs.forEach((q) => {
      globalQNum++;
      const imp = impPdfColor(q.importance);
      const st  = statusPdfStyle(q.status);

      // ── Geometry ────────────────────────────────────────────────────────
      // Every line height below is also used to draw, so the card is exactly
      // as tall as what goes in it. The source line used to be written at a y
      // that was still inside the response box, which is what printed it over
      // the box border and past the card edge.
      const Q_LH = 14, A_LH = 13, S_LH = 11;
      const qLines   = layout(doc, q.question,           cW - 62, 10, "bold");
      const aLines   = layout(doc, q.suggested_response, cW - 36,  9);
      const srcLines = q.source_ruling_title
        ? layout(doc, `Source: ${q.source_ruling_title}`, cW - 36, 7.5, "italic")
        : [];

      const headRowH = 24;                                   // Q number + pills
      const qBlockH  = qLines.length * Q_LH;
      const labelH   = 22;                                   // gap + section label
      const respBoxH = aLines.length * A_LH + 14;
      const srcH     = srcLines.length > 0 ? 12 + srcLines.length * S_LH : 0;
      const cardH    = headRowH + qBlockH + labelH + respBoxH + srcH + 14;

      guard(cardH + 16);
      const top = y;

      safeFill(doc, 226, 232, 240);
      doc.roundedRect(mL + 2, top + 3, cW, cardH, 6, 6, "F");
      safeFill(doc, 255, 255, 255);
      safeDraw(doc, 226, 232, 240);
      doc.setLineWidth(0.5);
      doc.roundedRect(mL, top, cW, cardH, 6, 6, "FD");
      safeFill(doc, r, g, b);
      doc.roundedRect(mL, top, cW, 4, 2, 2, "F");
      doc.rect(mL, top + 2, cW, 2, "F");

      // ── Question number, status pill, importance pill ───────────────────
      let cy = top + 18;
      setFont(doc, 9, "bold");
      safeText(doc, r, g, b);
      doc.text(`Q${globalQNum}.`, mL + 12, cy);

      const pillW = 52;
      const pillX = mL + cW - pillW - 12;
      safeFill(doc, imp.bg[0], imp.bg[1], imp.bg[2]);
      doc.roundedRect(pillX, cy - 10, pillW, 14, 3, 3, "F");
      safeText(doc, 255, 255, 255);
      setFont(doc, 7, "bold");
      doc.text((q.importance || "low").toUpperCase(), pillX + pillW / 2, cy - 1, { align: "center" });

      // Sized to its own label: "NEEDS EVIDENCE" does not fit a fixed pill the
      // width of "HIGH", and a fixed pill wide enough for it looks empty for
      // "READY".
      setFont(doc, 7, "bold");
      const stW = doc.getTextWidth(st.label) + 14;
      const stX = pillX - stW - 6;
      safeFill(doc, st.bg[0], st.bg[1], st.bg[2]);
      doc.roundedRect(stX, cy - 10, stW, 14, 3, 3, "F");
      safeText(doc, 255, 255, 255);
      doc.text(st.label, stX + stW / 2, cy - 1, { align: "center" });

      // ── Question ────────────────────────────────────────────────────────
      cy = top + headRowH;
      setFont(doc, 10, "bold");
      safeText(doc, 30, 41, 59);
      qLines.forEach((line) => { cy += Q_LH; doc.text(line, mL + 30, cy); });

      // ── Suggested response ──────────────────────────────────────────────
      cy += 10;
      setFont(doc, 7.5, "bold");
      safeText(doc, r, g, b);
      doc.text("SUGGESTED RESPONSE", mL + 12, cy);
      cy += 12;

      const boxTop = cy;
      safeFill(doc, rl, gl, bl);
      safeDraw(doc, r, g, b);
      doc.setLineWidth(0.4);
      doc.roundedRect(mL + 10, boxTop, cW - 20, respBoxH, 4, 4, "FD");
      setFont(doc, 9);
      safeText(doc, 71, 85, 105);
      let ay = boxTop + 14;
      aLines.forEach((line) => { doc.text(line, mL + 16, ay); ay += A_LH; });
      cy = boxTop + respBoxH;

      // ── Sources, below the box rather than across its border ────────────
      if (srcLines.length > 0) {
        cy += 12;
        setFont(doc, 7.5, "italic");
        safeText(doc, 148, 163, 184);
        srcLines.forEach((line) => { doc.text(line, mL + 12, cy); cy += S_LH; });
      }

      y = top + cardH + 14;
    });
  });

  drawHeadersAndFooters();
  doc.save("hta-questions.pdf");
}
