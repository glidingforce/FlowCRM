/* ============================================================
   FlowCRM — client-side PDF export

   Why this exists: the "⬇ שמור כ-PDF" button used to just call
   window.print() and let the browser's own print engine turn the page
   into a PDF. That meant Chrome and Safari were each making their own
   decisions about paper size, page breaks and footer placement — and
   real device testing showed they don't agree. A real iPhone-generated
   PDF came back on US Letter paper (not the A4 this app asks for),
   spilled onto a second, entirely blank page for a one-line receipt,
   and squashed the footer differently than the same document printed
   from a laptop. There is no CSS trick that closes that gap — it's a
   real difference between how the two engines implement printing.

   This module sidesteps native browser printing for the PDF button
   entirely: it snapshots the on-screen document with html2canvas and
   assembles the PDF itself with jsPDF, one page at a time, at a fixed
   width and a paper size WE choose. Page breaks are computed from the
   real DOM element boundaries (so a table row is never sliced in half)
   and the footer is drawn fresh onto every page from its own snapshot —
   the actual "repeat on every page" behavior this app has been trying
   to get out of native print for a while, finally done reliably because
   nothing here depends on which browser or OS is running it.

   The 🖨 הדפסה button still calls window.print() for actual printing to
   a physical printer or an OS-level "print to PDF" — that path still
   inherits the Chrome/Safari differences described above, because a
   real printer dialog is outside what this module can touch.

   Both html2canvas and jsPDF are self-hosted (html2canvas.min.js,
   jspdf.umd.min.js) so this keeps working offline like the rest of the
   app — no CDN dependency at runtime.
   ============================================================ */

const PdfExport = (() => {
  const A4_WIDTH_MM = 210;
  const A4_HEIGHT_MM = 297;
  const MARGIN_MM = 12;
  const FOOTER_RESERVE_MM = 18; // vertical room reserved at the bottom of EVERY page for the footer
  const RENDER_SCALE = 2; // html2canvas oversampling factor, for print-quality sharpness
  const MAX_PAGES = 200; // sanity cap so a measurement bug can't loop forever

  // The set of elements that must never be sliced in half across a page
  // break. Different pages (an invoice vs. the annual report) use
  // different block classes, so this list covers both — a selector that
  // matches nothing on a given page is simply a no-op.
  const ATOMIC_SELECTORS = [
    ".print-header", ".print-meta", ".print-title", ".print-totals",
    ".print-payment", ".print-note",
    ".print-table tr", ".print-payment tr", ".data-table tr",
    ".report-summary", ".concentration-box",
  ].join(",");

  function waitForImages(root) {
    const imgs = Array.from(root.querySelectorAll("img"));
    return Promise.all(imgs.map(img => {
      if (img.complete && img.naturalWidth > 0) return Promise.resolve();
      return new Promise(resolve => {
        img.addEventListener("load", resolve, { once: true });
        img.addEventListener("error", resolve, { once: true });
      });
    }));
  }

  // Y-offsets (in pageEl's own local pixel space) of every atomic
  // block's top/bottom edge — used to pull a candidate page break back
  // to a safe spot instead of cutting a block in half.
  function findBreakBoxes(root) {
    const rootTop = root.getBoundingClientRect().top;
    const boxes = [];
    root.querySelectorAll(ATOMIC_SELECTORS).forEach(el => {
      const r = el.getBoundingClientRect();
      boxes.push({ top: r.top - rootTop, bottom: r.bottom - rootTop });
    });
    boxes.sort((a, b) => a.top - b.top);
    return boxes;
  }

  function computeSlices(totalHeightPx, usableHeightPx, boxes) {
    const slices = [];
    let cursor = 0;
    let guard = 0;
    while (cursor < totalHeightPx - 1 && guard++ < MAX_PAGES) {
      const limit = cursor + usableHeightPx;
      if (limit >= totalHeightPx) { slices.push([cursor, totalHeightPx]); break; }
      let safe = limit;
      for (const b of boxes) {
        if (b.top < limit && b.bottom > limit) { safe = b.top; break; } // this block straddles the limit — break before it
      }
      if (safe <= cursor) safe = limit; // no safe boundary in range (a single block taller than a page) — hard cut
      slices.push([cursor, safe]);
      cursor = safe;
    }
    return slices;
  }

  async function ensureLibsLoaded() {
    if (typeof window.html2canvas !== "function") throw new Error("html2canvas לא נטען");
    if (!window.jspdf || !window.jspdf.jsPDF) throw new Error("jsPDF לא נטען");
  }

  // pageEl: the .print-page element to render. footerEl: the element to
  // draw once per page as a repeating footer (pass null for none — it
  // just prints once at wherever it naturally falls). Returns the jsPDF
  // instance; call .save(filename) on it (kept separate so tests/other
  // callers can inspect the output instead of triggering a download).
  async function buildPdf({ pageEl, footerEl }) {
    await ensureLibsLoaded();
    await waitForImages(pageEl);

    document.body.classList.add("pdf-exporting");
    const prevFooterDisplay = footerEl ? footerEl.style.display : null;
    if (footerEl) footerEl.style.display = "none";

    try {
      const boxes = findBreakBoxes(pageEl);
      const sourceWidthPx = pageEl.offsetWidth;
      const totalHeightPx = pageEl.scrollHeight;
      const mmPerPx = A4_WIDTH_MM / sourceWidthPx;
      const usableHeightMm = A4_HEIGHT_MM - MARGIN_MM * 2 - FOOTER_RESERVE_MM;
      const usableHeightPx = usableHeightMm / mmPerPx;

      const canvas = await html2canvas(pageEl, { scale: RENDER_SCALE, backgroundColor: "#ffffff", useCORS: true });
      const pxPerSourcePx = canvas.width / sourceWidthPx;

      let footerCanvas = null;
      if (footerEl) {
        footerEl.style.display = "";
        footerCanvas = await html2canvas(footerEl, { scale: RENDER_SCALE, backgroundColor: "#ffffff", useCORS: true });
        footerEl.style.display = "none";
      }

      const slices = computeSlices(totalHeightPx, usableHeightPx, boxes);
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ unit: "mm", format: "a4" });

      slices.forEach(([fromPx, toPx], i) => {
        if (i > 0) pdf.addPage();

        const sliceCanvas = document.createElement("canvas");
        sliceCanvas.width = canvas.width;
        sliceCanvas.height = Math.max(1, Math.round((toPx - fromPx) * pxPerSourcePx));
        sliceCanvas.getContext("2d").drawImage(
          canvas,
          0, Math.round(fromPx * pxPerSourcePx), canvas.width, sliceCanvas.height,
          0, 0, canvas.width, sliceCanvas.height
        );
        const sliceHeightMm = (toPx - fromPx) * mmPerPx;
        pdf.addImage(sliceCanvas.toDataURL("image/png"), "PNG", MARGIN_MM, MARGIN_MM, A4_WIDTH_MM - MARGIN_MM * 2, sliceHeightMm);

        if (footerCanvas) {
          const footerWidthMm = A4_WIDTH_MM - MARGIN_MM * 2;
          const footerHeightMm = footerWidthMm * (footerCanvas.height / footerCanvas.width);
          const footerY = A4_HEIGHT_MM - MARGIN_MM - footerHeightMm;
          pdf.addImage(footerCanvas.toDataURL("image/png"), "PNG", MARGIN_MM, footerY, footerWidthMm, footerHeightMm);
        }
      });

      return pdf;
    } finally {
      document.body.classList.remove("pdf-exporting");
      if (footerEl) footerEl.style.display = prevFooterDisplay || "";
    }
  }

  async function exportAndSave({ pageEl, footerEl, filename }) {
    const pdf = await buildPdf({ pageEl, footerEl });
    pdf.save(filename);
    return pdf;
  }

  return { buildPdf, exportAndSave };
})();
