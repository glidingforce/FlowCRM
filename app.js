/* ============================================================
   FlowCRM (self-hosted) — shared data layer
   All data lives in this browser's localStorage. Nothing is sent
   to any server. Export regularly (Settings > Backup) and keep
   the export in Google Drive so it never disappears.
   ============================================================ */

const DB_KEYS = {
  clients: "flowcrm_clients",
  documents: "flowcrm_documents",
  settings: "flowcrm_settings",
  expenses: "flowcrm_expenses",
};

const DOC_TYPES = {
  invoice: { label: "חשבונית עסקה", badge: "badge-invoice" },
  receipt: { label: "קבלה", badge: "badge-receipt" },
  quote: { label: "הצעת מחיר", badge: "badge-quote" },
};

const STATUS = {
  draft: { label: "טיוטה", badge: "badge-draft" },
  open: { label: "פתוח", badge: "badge-open" },
  closed: { label: "סגור", badge: "badge-closed" },
  canceled: { label: "מבוטל", badge: "badge-canceled" },
};

/* The 7 largest Israeli banks with their official Bank of Israel clearing
   codes, confirmed against ezcount.co.il/bank-numbers (Aug 2026). Excludes
   a couple of banks whose code has shifted post-merger (e.g. former Bank
   Igud/Otsar HaChayal) since that couldn't be independently confirmed —
   "אחר" covers those and anything else. */
const ISRAELI_BANKS = [
  "בנק לאומי (10)",
  "בנק הפועלים (12)",
  "בנק דיסקונט (11)",
  "בנק מזרחי טפחות (20)",
  "הבנק הבינלאומי הראשון (31)",
  "בנק ירושלים (54)",
  "בנק יהב (4)",
];

/* Only documents of type "receipt" (קבלה) carry payment details — an
   invoice (חשבונית עסקה) records a debt, a receipt records money that
   actually changed hands, a quote isn't a transaction at all. Each
   payment method exposes different fields since the "proof" differs
   (a check has a number+bank, a cash payment has nothing to record). */
const PAYMENT_METHOD_DEFS = {
  "מזומן": { fields: [] },
  "ביט": {
    fields: [
      { key: "phone", label: "טלפון השולח" },
      { key: "reference", label: "מספר אסמכתא" },
    ],
  },
  "PayBox": {
    fields: [
      { key: "phone", label: "טלפון השולח" },
      { key: "reference", label: "מספר אסמכתא" },
    ],
  },
  "PayPal": {
    fields: [
      { key: "email", label: "אימייל / חשבון PayPal" },
      { key: "transactionId", label: "מזהה עסקה" },
    ],
  },
  "העברה בנקאית": {
    fields: [
      { key: "bank", label: "בנק", type: "bank" },
      { key: "branch", label: "סניף" },
      { key: "account", label: "מספר חשבון" },
    ],
  },
  "צ'ק בנקאי": {
    fields: [
      { key: "checkNumber", label: "מספר צ'ק" },
      { key: "bank", label: "בנק", type: "bank" },
      { key: "branch", label: "סניף" },
      { key: "account", label: "מספר חשבון" },
    ],
  },
  "אחר": {
    fields: [
      { key: "details", label: "פרטים" },
    ],
  },
};
const PAYMENT_METHODS = Object.keys(PAYMENT_METHOD_DEFS);

function formatPaymentFields(method, fields) {
  const def = PAYMENT_METHOD_DEFS[method];
  if (!def) return "";
  const parts = def.fields
    .map(f => [f.label, (fields || {})[f.key]])
    .filter(([, v]) => v)
    .map(([label, v]) => `${label}: ${v}`);
  return parts.join(", ");
}

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.error("loadJSON failed for", key, e);
    return fallback;
  }
}
function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
  // Let the (optional) Google Drive sync module know local data changed,
  // so it can queue a debounced upload. drive-sync.js may not be loaded
  // on every page in older cached versions, so this is guarded.
  if (typeof DriveSync !== "undefined") DriveSync.noteLocalWrite(key);
}

function uid(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* ---------------- Seed data (first run only) ---------------- */

const SEED_SETTINGS = {
  companyName: "אחזקה פלוס",
  companyTagline: "עבודות אחזקה וחשמל",
  companyTaxId: "317750727",
  companyDealerType: "עוסק פטור",
  companyAddress: "גורדון 55, רחובות, 7628620",
  companyPhone: "0502071798",
  companyEmail: "",
  companyLogo: null, // data URL, set from Settings
  vatRate: 0,
  nextInvoiceNumber: 90062,
  nextReceiptNumber: 20084,
  nextQuoteNumber: 50014,
};

/* No real client data ships in the public source (this repo is public on
   GitHub's free plan). Add your clients from the Clients page after the
   app is live — they're stored only in your browser's local storage,
   never committed to git. */
const SEED_CLIENTS = [];

function ensureSeeded() {
  if (localStorage.getItem(DB_KEYS.settings) === null) {
    saveJSON(DB_KEYS.settings, SEED_SETTINGS);
  }
  if (localStorage.getItem(DB_KEYS.clients) === null) {
    saveJSON(DB_KEYS.clients, SEED_CLIENTS);
  }
  if (localStorage.getItem(DB_KEYS.documents) === null) {
    saveJSON(DB_KEYS.documents, []);
  }
  if (localStorage.getItem(DB_KEYS.expenses) === null) {
    saveJSON(DB_KEYS.expenses, []);
  }
}
ensureSeeded();

/* ---------------- Accessors ---------------- */

const DB = {
  getSettings() { return loadJSON(DB_KEYS.settings, SEED_SETTINGS); },
  saveSettings(s) { saveJSON(DB_KEYS.settings, s); },

  getClients() { return loadJSON(DB_KEYS.clients, []); },
  saveClients(list) { saveJSON(DB_KEYS.clients, list); },
  upsertClient(client) {
    const list = DB.getClients();
    const idx = list.findIndex(c => c.id === client.id);
    if (idx >= 0) list[idx] = client; else list.push(client);
    DB.saveClients(list);
    return client;
  },
  deleteClient(id) {
    DB.saveClients(DB.getClients().filter(c => c.id !== id));
  },
  getClient(id) { return DB.getClients().find(c => c.id === id); },

  getDocuments() { return loadJSON(DB_KEYS.documents, []); },
  saveDocuments(list) { saveJSON(DB_KEYS.documents, list); },
  upsertDocument(doc) {
    const list = DB.getDocuments();
    const idx = list.findIndex(d => d.id === doc.id);
    if (idx >= 0) list[idx] = doc; else list.unshift(doc);
    DB.saveDocuments(list);
    return doc;
  },
  getDocument(id) { return DB.getDocuments().find(d => d.id === id); },
  deleteDocument(id) {
    DB.saveDocuments(DB.getDocuments().filter(d => d.id !== id));
  },

  getExpenses() { return loadJSON(DB_KEYS.expenses, []); },
  saveExpenses(list) { saveJSON(DB_KEYS.expenses, list); },
  upsertExpense(exp) {
    const list = DB.getExpenses();
    const idx = list.findIndex(e => e.id === exp.id);
    if (idx >= 0) list[idx] = exp; else list.unshift(exp);
    DB.saveExpenses(list);
    return exp;
  },
  getExpense(id) { return DB.getExpenses().find(e => e.id === id); },
  deleteExpense(id) {
    DB.saveExpenses(DB.getExpenses().filter(e => e.id !== id));
  },

  // The next number for a document type is always one more than the
  // HIGHEST number actually in use for that type — not just whatever the
  // Settings counter says. The counter alone could drift out of sync (a
  // document number edited by hand, a restored backup, etc.); reading the
  // real documents every time means numbering always picks up exactly
  // where the last real document left off, per docType.
  nextDocNumber(docType) {
    const s = DB.getSettings();
    const key = docType === "invoice" ? "nextInvoiceNumber" : docType === "receipt" ? "nextReceiptNumber" : "nextQuoteNumber";
    const used = DB.getDocuments()
      .filter(d => d.docType === docType)
      .map(d => parseInt(d.docNumber, 10))
      .filter(n => !isNaN(n));
    const maxUsed = used.length ? Math.max(...used) : 0;
    return Math.max(maxUsed + 1, s[key] || 1);
  },
  // Pass the docNumber that was ACTUALLY saved (it may differ from what
  // nextDocNumber suggested, if the user typed their own number) so the
  // Settings counter — used only as a floor/fallback above — advances past
  // whatever was really used.
  bumpDocNumber(docType, usedNumber) {
    const s = DB.getSettings();
    const key = docType === "invoice" ? "nextInvoiceNumber" : docType === "receipt" ? "nextReceiptNumber" : "nextQuoteNumber";
    const n = parseInt(usedNumber, 10);
    const next = (!isNaN(n) ? n : (s[key] || 1)) + 1;
    if (next > (s[key] || 1)) s[key] = next;
    DB.saveSettings(s);
  },
};

/* ---------------- Calculations ---------------- */

function calcLineTotal(item) {
  return (parseFloat(item.qty) || 0) * (parseFloat(item.price) || 0);
}
function calcSubtotal(items) {
  return items.reduce((sum, it) => sum + calcLineTotal(it), 0);
}
function calcTax(subtotal, includeVat, vatRate) {
  return includeVat ? subtotal * (vatRate / 100) : 0;
}
function calcTotal(subtotal, tax) {
  return subtotal + tax;
}

function money(n) {
  const v = (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2);
  return "₪" + v;
}
const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function formatDateHe(dateStr) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-");
  const mi = parseInt(m, 10) - 1;
  const mon = MONTH_ABBR[mi] || m;
  const formatted = `${d}/${mon}/${y.slice(2)}`;
  // Mixing letters (the month) with digits and slashes inside an RTL page
  // triggers the browser's bidi algorithm to reorder the pieces (it comes
  // out "Aug/26/09" instead of "09/Aug/26") — plain numeric dates never had
  // this problem since digits+slashes alone don't confuse it. Wrapping in
  // Unicode isolate marks (U+2066/U+2069) forces it to treat the whole
  // thing as one left-to-right unit. Plain characters, not HTML, so this
  // is safe whether the caller uses textContent or innerHTML.
  return "⁦" + formatted + "⁩";
}

/* ---------------- Icon set (Lucide-style stroke icons) ----------------
   Minimal, self-hosted inline SVGs — no icon font/CDN dependency, in
   keeping with the rest of the app not relying on external services for
   anything functional. Callers control size/color via CSS (stroke uses
   currentColor); ICONS values are viewBox-scaled so any size works. */
const ICONS = {
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>',
  trendingUp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>',
  receipt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6"/><path d="M14 12h-4"/></svg>',
  fileText: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>',
  layoutDashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>',
  barChart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
};
function icon(name) {
  return ICONS[name] || "";
}

/* ---------------- Shared UI helpers ---------------- */

function toast(msg) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 2200);
}

function renderSidebar(active) {
  const items = [
    ["index.html", "לוח בקרה", "layoutDashboard"],
    ["documents.html", "מסמכים", "fileText"],
    ["clients.html", "לקוחות", "users"],
    ["expenses.html", "הוצאות", "wallet"],
    ["reports.html", "דוחות", "barChart"],
    ["settings.html", "הגדרות", "settings"],
  ];
  const nav = items.map(([href, label, iconName]) =>
    `<a href="${href}" class="${active === href ? "active" : ""}">${icon(iconName)}<span>${label}</span></a>`
  ).join("");
  return `
  <button class="hamburger" id="hamburgerBtn">☰</button>
  <aside class="sidebar" id="sidebar">
    <div class="brand-row">
      <span class="brand-icon"><img src="logo-icon.png" alt="FlowCRM"></span>
      <div>
        <div class="brand">FlowCRM</div>
        <div class="brand-sub">מערכת ניהול מסמכים עצמאית</div>
      </div>
    </div>
    <nav>${nav}</nav>
    <a href="create.html" class="new-doc-btn">${icon("plus")}<span>מסמך חדש</span></a>
    <div class="footer">הנתונים נשמרים במכשיר זה בלבד</div>
  </aside>`;
}

function mountShell(active) {
  // The sidebar must be the FIRST CHILD of .app-shell (a flex row) so it sits
  // beside .main. Inserting it before .app-shell (as a body-level sibling)
  // breaks the flex pairing: the sidebar collapses to its own content height
  // and .main renders stacked below it instead of alongside it.
  const shell = document.querySelector(".app-shell");
  if (shell) {
    shell.insertAdjacentHTML("afterbegin", renderSidebar(active));
  } else {
    document.body.insertAdjacentHTML("afterbegin", renderSidebar(active));
  }
  const btn = document.getElementById("hamburgerBtn");
  const sb = document.getElementById("sidebar");
  if (btn && sb) {
    btn.addEventListener("click", () => sb.classList.toggle("open"));
    sb.querySelectorAll("a").forEach(a => a.addEventListener("click", () => sb.classList.remove("open")));
  }
}

/* Downscale an uploaded image before storing it as a data URL, so a phone
   photo (often several MB) doesn't blow past localStorage's ~5-10MB quota
   after a few receipts. PDFs and anything non-image are stored as-is. */
function fileToStoredDataURL(file, maxDim = 1400, quality = 0.82) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/") || file.type === "image/svg+xml") {
      const reader = new FileReader();
      reader.onload = () => resolve({ dataUrl: reader.result, mime: file.type, name: file.name });
      reader.onerror = reject;
      reader.readAsDataURL(file);
      return;
    }
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => {
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        // JPEG has no alpha channel — an un-drawn (transparent) pixel gets
        // filled with black by canvas.toDataURL("image/jpeg") by default.
        // A logo uploaded as a transparent PNG would otherwise come out with
        // a black box behind it instead of the white it looks like on screen.
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        resolve({ dataUrl: canvas.toDataURL("image/jpeg", quality), mime: "image/jpeg", name: file.name });
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function docBadge(docType) {
  const d = DOC_TYPES[docType];
  return `<span class="badge ${d.badge}">${d.label}</span>`;
}
function statusBadge(status) {
  const s = STATUS[status] || STATUS.open;
  return `<span class="badge ${s.badge}">${s.label}</span>`;
}

// Shared doc-card inner markup used by both index.html and documents.html,
// so the two never visually drift apart. totalAmount is passed in rather
// than recomputed here since each page already has its own docTotal(d)
// (it needs the current VAT rate from Settings, which this file doesn't
// reach into on its own).
function docCardInner(d, totalAmount) {
  const statusClass = d.isCanceled ? "canceled" : d.status;
  const statusLabel = (STATUS[statusClass] || STATUS.open).label;
  return `
    <div class="doc-card-head">
      ${docBadge(d.docType)}
      <div class="amount">${money(totalAmount)}</div>
    </div>
    <div class="name">${d.clientName || ""}</div>
    <div class="meta">מס' ${d.docNumber} · ${formatDateHe(d.issueDate)}</div>
    <div class="doc-card-status">סטטוס: ${statusLabel}</div>`;
}
