/**
 * rulingPdf.js — Sr 53
 * ─────────────────────────────────────────────────────────────────────────────
 * Ruling detail → PDF.
 *
 * Lifted verbatim out of RulingDetail.jsx so the redesigned RulingPane can reuse
 * it. The logic is unchanged — only the DOM refs it used to read from component
 * scope are now parameters:
 *
 *   node          the element to rasterise
 *   sourceDocRef  the source-document card, hidden during capture and re-added
 *                 afterwards as a native page with a clickable link
 *   ruling        used for the filename and the source URL
 */
import jsPDF from "jspdf";
import html2canvas from "html2canvas";
import { toast } from "sonner";

  export async function exportRulingToPdf({ node, sourceDocRef, ruling }) {
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

      // Sr 83 — html2canvas rasterises what is on screen, so a block that
      // scrolls exports only the part that happens to be visible. Any block
      // marked data-pdf-expand (the assessment report) is opened to its full
      // height for the capture and restored afterwards.
      const expandable = Array.from(node.querySelectorAll("[data-pdf-expand='true']"));
      const expandedFrom = expandable.map((el) => ({
        el, maxHeight: el.style.maxHeight, overflowY: el.style.overflowY,
      }));
      expandable.forEach((el) => {
        el.style.maxHeight = "none";
        el.style.overflowY = "visible";
      });

      const canvas = await html2canvas(node, {
        scale: 2,
        useCORS: true,
        backgroundColor: "#ffffff",
        logging: process.env.NODE_ENV === "development"
      });

      // ── Restore source doc card ──
      if (sourceDocRef.current) sourceDocRef.current.style.display = "";
      expandedFrom.forEach(({ el, maxHeight, overflowY }) => {
        el.style.maxHeight = maxHeight;
        el.style.overflowY = overflowY;
      });
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

      const firstPageHeightMm = Math.min(remainingHeightMm, pageHeight - margin * 2);

      pdf.addImage(
        imgData, "PNG",
        margin, margin,
        imgWidthMm, firstPageHeightMm,
        undefined, "FAST"
      );
      remainingHeightMm -= (pageHeight - margin * 2);

      // Where the drawn content ends on the page currently being written. A
      // short ruling leaves most of the sheet empty, and the source section
      // below fills that rather than opening a near-blank page of its own.
      let contentBottomMm = margin + firstPageHeightMm;

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
        // Every slice page is drawn to the full text height, so nothing is
        // left over on the last one.
        contentBottomMm = pageHeight - margin;
      }

      // ── Add Source Document as native jsPDF page with clickable link ──────
      if (pdfFileUrl && pdfFileName) {
        // ZIN blob names run to 150+ characters. The filename used to be drawn
        // as a single unwrapped run beside its label, so most of it fell off
        // the right edge — along with its underline and its clickable hotspot,
        // which were sized from the full string. It is now wrapped to the text
        // column, and each line carries its own underline and link.
        const lineHeight   = 5;
        const textWidth    = pageWidth - margin * 2;

        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(10);
        const urlLines = pdf.splitTextToSize(pdfFileName, textWidth);

        // title → divider → label → the wrapped link, plus breathing room.
        const sectionHeight = 4 + 8 + 6 + urlLines.length * lineHeight + 2;

        // Reuse the current page when the ruling left room; otherwise start a
        // new one. A short ruling no longer spends a whole sheet on two lines.
        let y;
        if (pageHeight - margin - contentBottomMm >= sectionHeight + 12) {
          y = contentBottomMm + 12;
        } else {
          pdf.addPage();
          y = margin + 10;
        }

        // Section title
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(14);
        pdf.setTextColor(109, 43, 80); // Mulberry #6D2B50
        pdf.text("Source Document", margin, y);
        y += 4;

        // Divider line
        pdf.setDrawColor(226, 232, 240);
        pdf.setLineWidth(0.3);
        pdf.line(margin, y, pageWidth - margin, y);
        y += 8;

        // Label on its own line, so the full width is available to the name.
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(10);
        pdf.setTextColor(100, 116, 139); // slate-500
        pdf.text("Source URL", margin, y);
        y += 6;

        // Clickable filename, wrapped
        pdf.setTextColor(2, 132, 199); // sky-600
        urlLines.forEach((line) => {
          const lineWidth = pdf.getTextWidth(line);
          pdf.text(line, margin, y);
          pdf.setDrawColor(2, 132, 199);
          pdf.setLineWidth(0.3);
          pdf.line(margin, y + 1, margin + lineWidth, y + 1);
          pdf.link(margin, y - lineHeight + 1, lineWidth, lineHeight, { url: pdfFileUrl });
          y += lineHeight;
        });

        console.log("[exportToPdf] Source Document section added with link:", pdfFileUrl);
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
  }
