/**
 * readinessPdf.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Readiness Check -> PDF, for the selected question.
 *
 * Built the same way as qaPdf.js: jsPDF only, hand-drawn cards, measured with
 * the font they are drawn in. It reports REVIEW PROGRESS and nothing else. The
 * Readiness page makes no precedent assessment (Sr 90), so this export must not
 * imply one; the disclaimer from the page is printed on the report because the
 * file travels without the page around it.
 */
import jsPDF from "jspdf";

// ─── Drawing helpers (same behaviour as qaPdf.js) ─────────────────────────────
const clamp = (n) => Math.round(Math.min(255, Math.max(0, n)));
const fill = (doc, [r, g, b]) => doc.setFillColor(clamp(r), clamp(g), clamp(b));
const draw = (doc, [r, g, b]) => doc.setDrawColor(clamp(r), clamp(g), clamp(b));
const ink  = (doc, [r, g, b]) => doc.setTextColor(clamp(r), clamp(g), clamp(b));

function setFont(doc, size, style = "normal") {
  doc.setFontSize(size);
  doc.setFont("helvetica", style);
}

// Measure with the font the block is drawn in (see qaPdf.js for why).
function layout(doc, text, maxWidth, size, style = "normal") {
  setFont(doc, size, style);
  return doc.splitTextToSize(String(text || ""), maxWidth);
}

const INDIGO = [36, 22, 99];
const SLATE  = [71, 85, 105];
const MUTED  = [100, 116, 139];
const LINE   = [226, 232, 240];

// Matches the status pills in qaPdf.js
function statusStyle(status) {
  switch (status) {
    case "ready":          return { label: "READY",          bg: [22, 163, 74] };
    case "needs_evidence": return { label: "NEEDS EVIDENCE", bg: [217, 119, 6] };
    default:               return { label: "DRAFT",          bg: [100, 116, 139] };
  }
}

// The page counts an answer as ready when it is reviewed OR status is "ready".
function effectiveStatus(qa) {
  if (qa.reviewed || qa.status === "ready") return "ready";
  if (qa.status === "needs_evidence") return "needs_evidence";
  return "draft";
}

const fileSafe = (s) =>
  String(s || "session").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "session";

export function exportReadinessToPdf({
  session, question, questionNo, qReadiness, sReadiness, scoredQs,
}) {
  const qaList  = question?.generatedQA ?? [];
  const items   = qaList.map((qa) => ({ ...qa, _st: effectiveStatus(qa) }));
  const ready   = items.filter((a) => a._st === "ready").length;
  const needsEv = items.filter((a) => a._st === "needs_evidence").length;
  const draft   = items.length - ready - needsEv;

  const doc   = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const mL = 48, mR = 48;
  const cW = pageW - mL - mR;
  let y = 0;

  const guard = (needed = 20) => {
    if (y + needed > pageH - 48) { doc.addPage(); y = 48; }
  };

  const drawHeadersAndFooters = () => {
    const total = doc.internal.getNumberOfPages();
    for (let p = 1; p <= total; p++) {
      doc.setPage(p);

      // Header (pages 2+)
      if (p > 1) {
        setFont(doc, 8);
        ink(doc, [148, 163, 184]);
        doc.text("HTA Navigator Readiness Check", mL, 24);
      }

      // Footer
      setFont(doc, 8, "italic");
      ink(doc, [148, 163, 184]);
      doc.text(
        "This is an AI-generated content",
        pageW / 2, pageH - 20, { align: "center" }
      );

      setFont(doc, 8);
      doc.text(`Page ${p} of ${total}`, pageW - mR, pageH - 20, { align: "right" });
    }
  };

  // ── Cover band ────────────────────────────────────────────────────────────
  fill(doc, INDIGO);
  doc.rect(0, 0, pageW, 150, "F");
  ink(doc, [255, 255, 255]);
  setFont(doc, 26, "bold");
  doc.text("Readiness Check", mL, 70);
  setFont(doc, 12);
  doc.text("Review progress for the selected question", mL, 94);
  setFont(doc, 10);
  doc.text(
    `Generated: ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`,
    mL, 118
  );
  y = 176;

  // ── Session details ───────────────────────────────────────────────────────
  ink(doc, [30, 41, 59]);
  setFont(doc, 11, "bold");
  doc.text("Session", mL, y);
  y += 16;

  const details = [
    ["Drug",         session?.drugName     || "—"],
    ["Therapy area", session?.therapyArea  || "—"],
    ["Dossier type", session?.dossierType  || "—"],
    ["Status",       session?.status === "completed" ? "Completed" : "Active"],
  ];
  details.forEach(([k, v]) => {
    guard(14);
    setFont(doc, 9, "bold");
    ink(doc, MUTED);
    doc.text(`${k}:`, mL + 10, y);
    setFont(doc, 9);
    ink(doc, SLATE);
    doc.text(String(v), mL + 90, y);
    y += 14;
  });
  y += 10;

  // ── Question ──────────────────────────────────────────────────────────────
  guard(60);
  ink(doc, [30, 41, 59]);
  setFont(doc, 11, "bold");
  doc.text(`Q${questionNo} — search question`, mL, y);
  y += 16;
  layout(doc, `"${question?.query || ""}"`, cW - 20, 10).forEach((line) => {
    guard(14);
    setFont(doc, 10);
    ink(doc, SLATE);
    doc.text(line, mL + 10, y);
    y += 14;
  });
  const rulingCount = question?.rulingIds?.length ?? 0;
  setFont(doc, 9);
  ink(doc, MUTED);
  doc.text(
    `${items.length} generated question${items.length !== 1 ? "s" : ""}` +
    (rulingCount ? `  •  ${rulingCount} ruling${rulingCount !== 1 ? "s" : ""} saved to this question` : ""),
    mL + 10, y
  );
  y += 24;

  // ── Progress card ─────────────────────────────────────────────────────────
  const cardH = 92;
  guard(cardH + 16);
  fill(doc, [255, 255, 255]);
  draw(doc, LINE);
  doc.setLineWidth(0.5);
  doc.roundedRect(mL, y, cW, cardH, 6, 6, "FD");
  fill(doc, INDIGO);
  doc.roundedRect(mL, y, cW, 4, 2, 2, "F");
  doc.rect(mL, y + 2, cW, 2, "F");

  // Big count, left side. The count leads and the percentage follows, as on
  // the page (Sr 91): it is a tally of ticked answers, not a graded verdict.
  ink(doc, [30, 41, 59]);
  if (items.length === 0) {
    setFont(doc, 22, "bold");
    ink(doc, MUTED);
    doc.text("—", mL + 18, y + 48);
    setFont(doc, 9);
    doc.text("no answers generated yet", mL + 18, y + 66);
  } else {
    setFont(doc, 30, "bold");
    ink(doc, [30, 41, 59]);
    const big = String(ready);
    doc.text(big, mL + 18, y + 50);
    const bigW = doc.getTextWidth(big);
    setFont(doc, 16, "bold");
    ink(doc, MUTED);
    doc.text(` / ${items.length}`, mL + 18 + bigW, y + 50);
    setFont(doc, 9);
    doc.text("answers reviewed and marked ready", mL + 18, y + 66);

    // Progress bar
    const barX = mL + 18, barY = y + 74, barW = 190, barH = 6;
    fill(doc, [237, 234, 243]);
    doc.roundedRect(barX, barY, barW, barH, 3, 3, "F");
    if (qReadiness > 0) {
      fill(doc, INDIGO);
      doc.roundedRect(barX, barY, Math.max(4, (barW * qReadiness) / 100), barH, 3, 3, "F");
    }
    setFont(doc, 8);
    ink(doc, MUTED);
    doc.text(`${qReadiness}%  •  Q${questionNo} review progress`, barX + barW + 8, barY + 6);
  }

  // Breakdown, right side
  const colX = mL + cW - 190;
  const rows = [
    ["Ready",              ready,   [22, 163, 74]],
    ["Needs evidence",     needsEv, [185, 54, 54]],
    ["Draft / not started", draft,  MUTED],
  ];
  rows.forEach(([label, n, col], i) => {
    const ry = y + 28 + i * 16;
    setFont(doc, 9);
    ink(doc, MUTED);
    doc.text(label, colX, ry);
    setFont(doc, 9, "bold");
    ink(doc, col);
    doc.text(String(n), mL + cW - 18, ry, { align: "right" });
  });
  y += cardH + 14;

  // ── Session overall ───────────────────────────────────────────────────────
  guard(36);
  setFont(doc, 9, "bold");
  ink(doc, [30, 41, 59]);
  doc.text(`Session overall: ${sReadiness}%`, mL, y);
  setFont(doc, 8.5, "italic");
  ink(doc, MUTED);
  y += 13;
  doc.text(
    scoredQs === 0
      ? "No answers generated yet."
      : `Average of ${scoredQs} question${scoredQs === 1 ? "" : "s"} with generated answers.`,
    mL, y
  );
  y += 20;

  // ── Disclaimer (mirrors the on-page banner) ───────────────────────────────
  const discLines = layout(
    doc,
    "This score is a progress tracker, not a compliance check. It reflects the share of " +
    "generated Q&A that has been reviewed and marked ready - not a signed-off " +
    "dossier-completeness rule. No precedent assessment against ZIN rulings has been " +
    "performed, so this report makes no claim about dossier quality or likely outcome.",
    cW - 24, 8.5, "italic"
  );
  const discH = discLines.length * 11 + 16;
  guard(discH + 10);
  fill(doc, [241, 239, 250]);
  draw(doc, [214, 209, 238]);
  doc.setLineWidth(0.5);
  doc.roundedRect(mL, y, cW, discH, 5, 5, "FD");
  setFont(doc, 8.5, "italic");
  ink(doc, INDIGO);
  discLines.forEach((line, i) => doc.text(line, mL + 12, y + 14 + i * 11));
  y += discH + 22;

  // ── Q&A checklist ─────────────────────────────────────────────────────────
  guard(40);
  ink(doc, [30, 41, 59]);
  setFont(doc, 12, "bold");
  doc.text("Generated Q&A checklist", mL, y);
  y += 18;

  if (items.length === 0) {
    setFont(doc, 9, "italic");
    ink(doc, MUTED);
    doc.text("No Q&A generated for this question yet.", mL + 10, y);
    y += 14;
  }

  items.forEach((qa, idx) => {
    const st = statusStyle(qa._st);

    const Q_LH = 13, A_LH = 12;
    const qLines = layout(doc, qa.question, cW - 80, 9.5, "bold");
    const aLines = layout(doc, qa.answer || "No answer drafted yet", cW - 36, 9,
      qa.answer ? "normal" : "italic");
    const blockH = 12 + qLines.length * Q_LH + 6 + aLines.length * A_LH + 14;

    guard(blockH + 10);
    const top = y;

    fill(doc, [255, 255, 255]);
    draw(doc, LINE);
    doc.setLineWidth(0.5);
    doc.roundedRect(mL, top, cW, blockH, 5, 5, "FD");

    // Status pill, sized to its own label
    setFont(doc, 7, "bold");
    const pillW = doc.getTextWidth(st.label) + 14;
    const pillX = mL + cW - pillW - 10;
    fill(doc, st.bg);
    doc.roundedRect(pillX, top + 8, pillW, 14, 3, 3, "F");
    ink(doc, [255, 255, 255]);
    doc.text(st.label, pillX + pillW / 2, top + 18, { align: "center" });

    // Question
    let cy = top + 12;
    setFont(doc, 9.5, "bold");
    ink(doc, INDIGO);
    doc.text(`${idx + 1}.`, mL + 12, cy + Q_LH - 3);
    ink(doc, [30, 41, 59]);
    qLines.forEach((line) => { cy += Q_LH; doc.text(line, mL + 28, cy - 3); });

    // Answer
    cy += 6;
    setFont(doc, 9, qa.answer ? "normal" : "italic");
    ink(doc, qa.answer ? SLATE : MUTED);
    aLines.forEach((line) => { cy += A_LH; doc.text(line, mL + 16, cy - 2); });

    y = top + blockH + 8;
  });

  drawHeadersAndFooters();

  const date = new Date().toISOString().slice(0, 10);
  doc.save(`readiness-${fileSafe(session?.drugName)}-Q${questionNo}-${date}.pdf`);
}