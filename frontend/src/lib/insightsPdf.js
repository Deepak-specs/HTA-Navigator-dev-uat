/**
 * insightsPdf.js — Sr 89
 * ─────────────────────────────────────────────────────────────────────────────
 * Insights page → PDF.
 *
 * Lifted verbatim out of Insights.jsx during the Phase 7 rewrite so the working
 * export survives the page being rebuilt.
 *
 * Sr 94  The charts were missing from every export, for two separate reasons,
 *        both of them html2canvas limitations rather than bugs in this page:
 *
 *          - Recharts draws into inline <svg>. html2canvas serialises SVG
 *            through an <img>, and anything it cannot resolve in that pass
 *            comes out blank.
 *          - The outcome donut is a CSS conic-gradient, which html2canvas does
 *            not implement at all, so it rendered as an empty circle.
 *
 *        Both are now rasterised to PNG against the live DOM before the
 *        capture, swapped in for the duration, and restored in `finally` — so
 *        a failed export cannot leave the page altered.
 *
 * Sr 97  Two further corrections:
 *          - `windowWidth` was set to the element's own width, which re-laid
 *            the page out narrower before capturing it. Anything that did not
 *            reflow was cut off — the quarterly, manufacturer and monthly
 *            charts all lost their right edge. The viewport now stays as it is
 *            on screen and only the canvas is sized to the element.
 *          - Elements marked data-pdf-hide are left out: on-screen controls
 *            (buttons, suggested-question chips, keyboard hints) carry no
 *            meaning on paper.
 */
import jsPDF from "jspdf";
import html2canvas from "html2canvas";
import { toast } from "sonner";

// ─── Chart rasterisation ──────────────────────────────────────────────────────
// Everything below runs against the real DOM, not html2canvas's clone: the
// clone is built inside an iframe where a 100%-sized SVG can measure zero.

/** One <svg> → a PNG data URL at `scale`x, or null if it cannot be drawn. */
async function svgToPng(svg, scale) {
  const rect = svg.getBoundingClientRect();
  const w = Math.max(1, Math.ceil(rect.width));
  const h = Math.max(1, Math.ceil(rect.height));

  const clone = svg.cloneNode(true);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(w));
  clone.setAttribute("height", String(h));

  const src =
    "data:image/svg+xml;charset=utf-8," +
    encodeURIComponent(new XMLSerializer().serializeToString(clone));

  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("svg image failed to load"));
    i.src = src;
  });

  const canvas = document.createElement("canvas");
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return { png: canvas.toDataURL("image/png"), w, h };
}

/** The conic-gradient ring, drawn with canvas arcs instead. */
function donutPng(el, scale) {
  const size = Math.ceil(el.getBoundingClientRect().width) || 150;
  const own  = getComputedStyle(el);
  const root = getComputedStyle(document.documentElement);
  const num  = (name) => parseFloat(own.getPropertyValue(name)) || 0;
  const col  = (name, fallback) => (root.getPropertyValue(name) || fallback).trim();

  const s1 = num("--s1");
  const s2 = num("--s2");
  const segments = [
    [0,  s1,  col("--cond", "#B06D05")],
    [s1, s2,  col("--neg",  "#B93636")],
    [s2, 100, col("--pos",  "#1B7A54")],
  ];

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size * scale;
  const ctx = canvas.getContext("2d");
  const r = (size * scale) / 2;
  // conic-gradient starts at twelve o'clock; canvas arcs start at three.
  const angle = (percent) => (percent / 100) * 2 * Math.PI - Math.PI / 2;

  segments.forEach(([from, to, colour]) => {
    if (to <= from) return;
    ctx.beginPath();
    ctx.moveTo(r, r);
    ctx.arc(r, r, r, angle(from), angle(to));
    ctx.closePath();
    ctx.fillStyle = colour;
    ctx.fill();
  });
  return canvas.toDataURL("image/png");
}

/**
 * Swaps every chart for a PNG of itself. Returns an undo function; call it in
 * a `finally` so the page is always put back.
 */
async function rasteriseCharts(root, scale = 2) {
  const undo = [];
  const stats = { svgFound: 0, svgDone: 0, svgFailed: 0, donutFound: 0, donutDone: 0, hidden: 0 };

  for (const svg of [...root.querySelectorAll("svg")]) {
    stats.svgFound += 1;
    try {
      const { png, w, h } = await svgToPng(svg, scale);
      const img = document.createElement("img");
      img.src = png;
      img.width = w;
      img.height = h;
      img.style.display = "block";
      img.setAttribute("data-pdf-chart", "true");
      svg.parentNode.insertBefore(img, svg);
      const previous = svg.style.display;
      svg.style.display = "none";
      undo.push(() => { img.remove(); svg.style.display = previous; });
      stats.svgDone += 1;
    } catch (e) {
      // One unrenderable chart must not cost the whole export. The SVG is left
      // in place with explicit dimensions, which gives html2canvas's own SVG
      // path its best chance at it.
      stats.svgFailed += 1;
      try {
        const r = svg.getBoundingClientRect();
        svg.setAttribute("width", String(Math.max(1, Math.ceil(r.width))));
        svg.setAttribute("height", String(Math.max(1, Math.ceil(r.height))));
      } catch { /* nothing further to try */ }
      console.warn("[insightsPdf] chart not rasterised:", e?.message || e);
    }
  }

  for (const donut of [...root.querySelectorAll(".v2-donut")]) {
    stats.donutFound += 1;
    try {
      const png = donutPng(donut, scale);
      const previous = donut.style.background;
      donut.style.background = `url(${png}) center / cover no-repeat`;
      undo.push(() => { donut.style.background = previous; });
      stats.donutDone += 1;
    } catch (e) {
      console.warn("[insightsPdf] donut not rasterised:", e?.message || e);
    }
  }

  for (const el of [...root.querySelectorAll('[data-pdf-hide="true"]')]) {
    const previous = el.style.display;
    el.style.display = "none";
    undo.push(() => { el.style.display = previous; });
    stats.hidden += 1;
  }

  // Printed unconditionally: when a chart is missing from the PDF this one
  // line says whether it was never found, failed to rasterise, or was swapped
  // in fine and lost later in the capture.
  console.log("[insightsPdf] rasterise:", JSON.stringify(stats));

  return () => undo.forEach((fn) => fn());
}

export async function exportPageToPDF(pageRef, setExporting) {
  if (!pageRef.current) {
    toast.error("Nothing to export");
    return;
  }
  setExporting(true);

  const freezeStyle = document.createElement("style");
  freezeStyle.id = "pdf-export-freeze";
  freezeStyle.textContent = `
    [data-testid="insights-page"] *,
    [data-testid="insights-page"] *::before,
    [data-testid="insights-page"] *::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
      opacity: 1 !important;
    }
  `;
  document.head.appendChild(freezeStyle);

  let restoreCharts = () => {};

  try {
    await new Promise((res) => setTimeout(res, 300));

    const element = pageRef.current;
    restoreCharts = await rasteriseCharts(element);
    // One frame, so the swapped-in images are laid out before the capture
    // measures the page height.
    await new Promise((res) => requestAnimationFrame(() => res()));
    const canvas  = await html2canvas(element, {
      scale:           2,
      useCORS:         true,
      allowTaint:      false,
      backgroundColor: "#ffffff",
      scrollX:         0,
      scrollY:         -window.scrollY,
      // The canvas is sized to the element; the viewport is left alone.
      width:           element.scrollWidth,
      height:          element.scrollHeight,
      windowWidth:     document.documentElement.scrollWidth,
      windowHeight:    document.documentElement.scrollHeight,
      logging:         false,
      onclone: (clonedDoc) => {
        const clonedPage = clonedDoc.querySelector('[data-testid="insights-page"]');
        if (clonedPage) {
          clonedPage.querySelectorAll("*").forEach((el) => {
            el.style.opacity       = "1";
            el.style.animationName = "none";
            el.style.transition    = "none";
          });
        }
      },
    });

    const pdf        = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const pageWidth  = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const marginX    = 10;
    const marginTop  = 14;   // room for the header
    const marginBot  = 14;   // room for the footer
    const usableW    = pageWidth  - marginX * 2;
    const usableH    = pageHeight - marginTop - marginBot;

    const imgWidthPx      = canvas.width;
    const imgHeightPx     = canvas.height;
    const ratio           = usableW / imgWidthPx;
    let remainingHeightPx = imgHeightPx;
    let sourceYPx         = 0;
    let isFirstPage       = true;

    while (remainingHeightPx > 0) {
      if (!isFirstPage) pdf.addPage();

      const sliceHeightPx = Math.min(remainingHeightPx, usableH / ratio);
      const sliceCanvas   = document.createElement("canvas");
      sliceCanvas.width   = imgWidthPx;
      sliceCanvas.height  = Math.ceil(sliceHeightPx);
      const ctx = sliceCanvas.getContext("2d");
      ctx.drawImage(canvas, 0, -sourceYPx);

      pdf.addImage(
        sliceCanvas.toDataURL("image/png"),
        "PNG",
        marginX, marginTop,
        usableW, sliceHeightPx * ratio
      );

      sourceYPx         += sliceHeightPx;
      remainingHeightPx -= sliceHeightPx;
      isFirstPage        = false;
    }

    const totalPages = pdf.internal.getNumberOfPages();
    const now        = new Date().toLocaleDateString("en-GB", {
      day: "2-digit", month: "short", year: "numeric",
    });
    for (let p = 1; p <= totalPages; p++) {
      pdf.setPage(p);
      pdf.setFontSize(8);
      pdf.setTextColor(150);

      // Header (pages 2+): document title and export date
      if (p > 1) {
        pdf.setFont("helvetica", "normal");
        pdf.text(`ZIN HTA Insights  •  Exported ${now}`, marginX, 8);
      }
 
      // Footer: disclaimer at the left margin, page number at the right margin
      pdf.setFont("helvetica", "italic");
      pdf.text(
        "This is an AI-generated content",
        pageWidth / 2, pageHeight - 7, { align: "center" }
      );

      pdf.setFont("helvetica", "normal");
      pdf.text(`Page ${p} of ${totalPages}`, pageWidth - marginX, pageHeight - 7, { align: "right" });
    }
    pdf.save(`ZIN_HTA_Insights_${now.replace(/ /g, "_")}.pdf`);
    toast.success("PDF exported");

  } catch (err) {
    console.error("PDF export failed:", err);
    toast.error("Failed to export PDF");
  } finally {
    restoreCharts();
    document.getElementById("pdf-export-freeze")?.remove();
    setExporting(false);
  }
}
