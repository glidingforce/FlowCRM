/* ============================================================
   FlowCRM — real print pagination + PDF export

   History, briefly: this went through position:fixed (repeats on every
   page in Chrome, breaks on Safari — confirmed on real iPhone PDFs),
   then a plain-flow footer (safe everywhere, but not pinned to the
   bottom), then an html2canvas+jsPDF export that rasterized the WHOLE
   document into one tall image and sliced it into pages (fixed the
   cross-browser inconsistency, but produced a blurry "looks like a
   photo of the document" PDF, and had a real unit-conversion bug that
   stretched the page's aspect ratio — the slice height was computed
   using the FULL page width in the mm-per-pixel ratio while the image
   was actually placed at the narrower content width, so every slice
   came out taller than it should have).

   This version fixes both problems by not leaving pagination to any
   browser's print engine AND not throwing away real text as one big
   raster image. Instead:

   1. Paginate() reflows the live document into a sequence of
      .printed-page boxes, each a FIXED, exact size (computed directly
      from A4 mm at the CSS-standard 96px/inch, so there is no separate
      "convert pixels to mm" step left to get wrong). Page breaks are
      decided by measuring real elements — a table row is never split
      across two pages — and the footer is a normal flex child with
      margin-top:auto, which pins it to the bottom of ITS OWN fixed-
      height box using nothing but standard flexbox. No position:fixed,
      no position:absolute, no reliance on @page margins lining up with
      anything — which is what broke on Safari before.

   2. The "🖨 הדפסה" button prints this reflowed structure directly via
      window.print() — real text, real selectable PDF when the OS's own
      "print to PDF" is used, with the footer now genuinely pinned to
      the bottom of every page on any engine that supports flexbox
      (which is all of them).

   3. The "⬇ שמור כ-PDF" button renders each fixed-size .printed-page
      individually with html2canvas (one call per page, not one call
      for the whole document sliced afterward) and places each at its
      exact, known size in a jsPDF document. Still a raster image under
      the hood — a genuinely vector, selectable-text PDF would mean
      re-implementing this app's entire Hebrew/RTL layout using jsPDF's
      text-drawing primitives instead of the browser's own text engine,
      which is a much bigger and riskier rewrite (Hebrew mixed with
      numbers and dates needs real bidi handling to not come out
      scrambled) — not attempted here. What this version does fix: the
      aspect-ratio bug (each page's width/height are now taken directly
      from the same fixed box used for print, not recomputed from a
      slice), and sharper output (each page rendered at higher pixel
      density on its own, instead of one giant multi-page canvas).

   Both html2canvas and jsPDF are self-hosted (html2canvas.min.js,
   jspdf.umd.min.js) so this keeps working offline like the rest of the
   app — no CDN dependency at runtime.
   ============================================================ */

const Paginate = (() => {
  // CSS defines 1in = 96px = 25.4mm — this is a fixed spec constant, not
  // a display DPI guess, so this conversion is exact on every browser.
  const MM_TO_PX = 96 / 25.4;
  const A4_WIDTH_MM = 210;
  const A4_HEIGHT_MM = 297;
  const MARGIN_MM = 12;
  // Precomputed from the constants above (kept as literals, not a runtime
  // Math.round call, so the exact same numbers can be mirrored in style.css
  // — see the .printed-page rule there). Width is A4's (210 - 2*12) *
  // 96/25.4 = 702.99 → 703 — that's fine, A4 is the narrower of the two
  // common paper sizes so a box this wide also fits on US Letter.
  //
  // Height is NOT A4's. This app asks for @page { size: A4 } and Chrome
  // on a laptop honors that — but a real iPhone-generated PDF earlier
  // came back on US Letter regardless of that CSS (612×792pt — Safari's
  // print pipeline appears to use the device's regional default paper
  // size, not the page's own @page hint). Letter is 279.4mm tall vs A4's
  // 297mm — SHORTER. A page box built for A4's full height would then be
  // taller than what actually fits on the Letter page the engine chose,
  // and the engine would silently insert its OWN extra break partway
  // through that box — corrupting the one-box-per-page assumption this
  // whole approach depends on (confirmed while testing this: it exactly
  // doubled the page count). So the height budget here is deliberately
  // Letter's shorter usable height — (279.4 - 2*12) * 96/25.4 = 965.29 →
  // 960, with a few extra px of safety margin — which comfortably fits
  // inside EITHER paper size. On an actual A4 print this leaves a little
  // unused white space at the bottom of every page; that's a fair trade
  // for never again silently splitting into extra pages depending on
  // which paper size an OS/engine decided to use.
  const CONTENT_WIDTH_PX = 703;
  const CONTENT_HEIGHT_PX = 960;
  const MAX_PAGES = 200;

  function collectFlowItems(pageEl) {
    const items = [];
    Array.from(pageEl.children).forEach(child => {
      if (child.classList.contains("watermark")) return;
      if (child.classList.contains("print-footer")) return;
      if (child.tagName === "TABLE") {
        const thead = child.querySelector("thead");
        const tbody = child.querySelector("tbody");
        const rows = tbody ? Array.from(tbody.children) : [];
        // Whenever a split table starts a fresh page, buildPageElement()
        // re-adds this thead so the columns stay labeled — that repeated
        // header costs real vertical space on every page it appears on,
        // not just the first. Measuring it here (once) and folding it
        // into packPages()'s budget is what was missing before: every
        // page's row budget was computed as if the thead were free,
        // which let one extra row get packed onto every page and pushed
        // the footer down into the last row instead of below it.
        const theadHeight = thead ? thead.getBoundingClientRect().height : 0;
        if (rows.length === 0) {
          items.push({ type: "atomic", el: child });
        } else {
          rows.forEach(tr => items.push({
            type: "row", tr,
            tableClassName: child.className,
            theadHTML: thead ? thead.outerHTML : "",
            theadHeight,
          }));
        }
      } else {
        items.push({ type: "atomic", el: child });
      }
    });
    return items;
  }

  function measure(items) {
    return items.map(item => {
      const el = item.type === "row" ? item.tr : item.el;
      return Object.assign({}, item, { height: el.getBoundingClientRect().height });
    });
  }

  function packPages(items, usableHeightPx) {
    const pages = [];
    let current = [];
    let currentHeight = 0;
    let openTableClass = null; // which table (if any) is already open on the current page — a row of this table needs no extra thead; any other row does

    items.forEach(item => {
      const isRow = item.type === "row";
      const needsThead = isRow && item.tableClassName !== openTableClass;
      let extra = needsThead ? item.theadHeight : 0;

      if (current.length && currentHeight + item.height + extra > usableHeightPx) {
        pages.push(current);
        current = [];
        currentHeight = 0;
        openTableClass = null;
        // starting a fresh page — a row now definitely needs its own
        // thead again, even if it didn't on the page that just ended
        extra = isRow ? item.theadHeight : 0;
      }
      current.push(item);
      currentHeight += item.height + extra;
      openTableClass = isRow ? item.tableClassName : null;
    });
    if (current.length) pages.push(current);
    return pages.slice(0, MAX_PAGES);
  }

  function buildPageElement(items, footerEl, watermarkEl) {
    const page = document.createElement("div");
    page.className = "printed-page";
    page.style.width = CONTENT_WIDTH_PX + "px";
    page.style.height = CONTENT_HEIGHT_PX + "px";

    if (watermarkEl) {
      const wm = watermarkEl.cloneNode(true);
      wm.style.display = "block";
      page.appendChild(wm);
    }

    const body = document.createElement("div");
    body.className = "printed-page-body";

    let openTbody = null, openTableClass = null;
    items.forEach(item => {
      if (item.type === "row") {
        if (openTableClass !== item.tableClassName) {
          const table = document.createElement("table");
          table.className = item.tableClassName;
          if (item.theadHTML) table.insertAdjacentHTML("beforeend", item.theadHTML);
          openTbody = document.createElement("tbody");
          table.appendChild(openTbody);
          body.appendChild(table);
          openTableClass = item.tableClassName;
        }
        openTbody.appendChild(item.tr.cloneNode(true));
      } else {
        openTableClass = null;
        body.appendChild(item.el.cloneNode(true));
      }
    });
    page.appendChild(body);

    if (footerEl) {
      const footer = footerEl.cloneNode(true);
      footer.style.display = "";
      footer.classList.add("printed-page-footer");
      page.appendChild(footer);
    }
    return page;
  }

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

  // Rebuilds outputEl's content as a sequence of .printed-page elements
  // reflowed from pageEl. Must run with pageEl laid out at
  // CONTENT_WIDTH_PX (the .paginating body class below does this) so
  // measurements match the final page width exactly. Returns the page
  // count.
  async function build(pageEl, footerEl, outputEl) {
    await waitForImages(pageEl);
    const watermarkEl = pageEl.querySelector(".watermark");
    const isWatermarkOn = watermarkEl && watermarkEl.style.display !== "none";
    const items = measure(collectFlowItems(pageEl));
    const footerHeightPx = footerEl ? footerEl.getBoundingClientRect().height : 0;
    // SAFETY_MARGIN_PX exists because summing individually-measured row
    // heights isn't exactly equal to how tall those same rows come out
    // once they're all stacked together for real: border-collapse on
    // <table> merges each pair of adjacent row borders into one shared
    // line, so measuring rows one at a time (each counting its own full
    // border) doesn't quite match their combined height once collapsed.
    // Packing right up to the exact computed budget left about 20-25px
    // of real per-page shortfall from this — invisible in this app's
    // own print rendering (which has some slack from CONTENT_HEIGHT_PX
    // being Letter-safe, not the full A4 height, see above) but a real,
    // visible footer/last-row overlap in the ⬇ שמור כ-PDF path, which
    // renders each page's exact box with html2canvas instead. A flat
    // safety margin is simpler and more robust than trying to compute
    // the exact border-collapse delta.
    const SAFETY_MARGIN_PX = 40;
    const usableHeightPx = CONTENT_HEIGHT_PX - footerHeightPx - SAFETY_MARGIN_PX;
    const pages = packPages(items, usableHeightPx);

    outputEl.innerHTML = "";
    pages.forEach(pageItems => {
      outputEl.appendChild(buildPageElement(pageItems, footerEl, isWatermarkOn ? watermarkEl : null));
    });
    return pages.length;
  }

  return { build, CONTENT_WIDTH_PX, CONTENT_HEIGHT_PX, A4_WIDTH_MM, A4_HEIGHT_MM, MARGIN_MM };
})();

const PdfExport = (() => {
  async function ensureLibsLoaded() {
    if (typeof window.html2canvas !== "function") throw new Error("html2canvas לא נטען");
    if (!window.jspdf || !window.jspdf.jsPDF) throw new Error("jsPDF לא נטען");
  }

  // Runs fn() with <body> in "paginating" mode (pageEl forced to the
  // exact printed content width, sidebar/buttons hidden) and #paginatedOutput
  // rebuilt from pageEl's current content, then always tears the mode
  // back down again afterward — used by both the print button and the
  // PDF export so they reflow the document the exact same way.
  async function withPaginatedOutput(pageEl, footerEl, fn) {
    const outputEl = document.getElementById("paginatedOutput");
    document.body.classList.add("paginating");
    try {
      await Paginate.build(pageEl, footerEl, outputEl);
      return await fn(outputEl);
    } finally {
      document.body.classList.remove("paginating");
    }
  }

  async function printDocument(pageEl, footerEl) {
    await withPaginatedOutput(pageEl, footerEl, async () => {
      document.body.classList.add("printing-paginated");
      await new Promise(resolve => {
        const cleanup = () => { document.body.classList.remove("printing-paginated"); resolve(); };
        window.addEventListener("afterprint", cleanup, { once: true });
        window.print();
        // afterprint doesn't fire in every environment (some in-app
        // browsers/webviews) — this is a safety net so the class is
        // never left stuck on.
        setTimeout(cleanup, 3000);
      });
    });
  }

  async function buildPdf(pageEl, footerEl) {
    await ensureLibsLoaded();
    return withPaginatedOutput(pageEl, footerEl, async (outputEl) => {
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ unit: "mm", format: "a4" });
      const pageEls = Array.from(outputEl.querySelectorAll(".printed-page"));
      const widthMm = Paginate.A4_WIDTH_MM - Paginate.MARGIN_MM * 2;
      const heightMm = (Paginate.CONTENT_HEIGHT_PX / Paginate.CONTENT_WIDTH_PX) * widthMm;

      for (let i = 0; i < pageEls.length; i++) {
        if (i > 0) pdf.addPage();
        const canvas = await html2canvas(pageEls[i], {
          scale: 3, backgroundColor: "#ffffff", useCORS: true,
          width: Paginate.CONTENT_WIDTH_PX, height: Paginate.CONTENT_HEIGHT_PX,
          onclone: (clonedDoc) => {
            // "Tainted canvases may not be exported": the printed page
            // itself only ever uses the self-hosted DejaVu font (see
            // --font-print in style.css), but every page's <head> still
            // has the Google Fonts <link> for the app's on-screen Rubik
            // UI font, and that's a cross-origin stylesheet. html2canvas
            // walks all stylesheets in the document while cloning it —
            // touching that cross-origin stylesheet is enough to taint
            // the canvas in some browsers, even though nothing in the
            // captured .printed-page subtree actually renders in Rubik.
            // Dropping it from the clone removes the only cross-origin
            // resource on the page, with zero visual effect on the PDF.
            clonedDoc.querySelectorAll(
              'link[href*="fonts.googleapis.com"], link[href*="fonts.gstatic.com"]'
            ).forEach((el) => el.remove());
          },
        });
        // JPEG, not PNG: jsPDF embeds a JPEG's already-compressed bytes
        // directly into the PDF stream, but its PNG path re-encodes the
        // bitmap essentially uncompressed — a single A4 page at this
        // resolution came out over 20MB as PNG and under 300KB as JPEG
        // (quality 0.92), with no visible difference for a document
        // that's mostly white background, black text and thin lines.
        pdf.addImage(canvas.toDataURL("image/jpeg", 0.92), "JPEG", Paginate.MARGIN_MM, Paginate.MARGIN_MM, widthMm, heightMm);
      }
      return pdf;
    });
  }

  async function exportAndSave({ pageEl, footerEl, filename }) {
    // Opening the app straight from disk (double-clicking index.html, a
    // file:// address) is the single most common real cause of
    // html2canvas's "Tainted canvases may not be exported": under
    // file://, Chrome/Safari treat every loaded resource — even the
    // app's own same-folder images (logo, stamp) — as unverifiably
    // cross-origin, and drawing any of them into a canvas blocks the
    // canvas from ever being exported. There is no code-side fix for
    // that; the app has to be served over http(s) (the GitHub Pages
    // URL, or any local server) for canvas-based PDF export to work at
    // all. Fail with a clear message instead of the cryptic browser one.
    if (window.location.protocol === "file:") {
      throw new Error(
        "שמירת PDF לא עובדת כשפותחים את הקובץ ישירות מהמחשב (file://). " +
        "יש לגלוש לכתובת המקוונת של האתר (למשל כתובת ה-GitHub Pages), ואז לנסות שוב."
      );
    }
    const pdf = await buildPdf(pageEl, footerEl);
    pdf.save(filename);
    return pdf;
  }

  return { printDocument, buildPdf, exportAndSave };
})();
