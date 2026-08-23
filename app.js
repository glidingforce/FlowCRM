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
      { key: "reference", label: "מספר אסמכתא / קישור" },
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
      { key: "bank", label: "בנק" },
      { key: "branch", label: "סניף" },
      { key: "account", label: "מספר חשבון" },
    ],
  },
  "צ'ק בנקאי": {
    fields: [
      { key: "checkNumber", label: "מספר צ'ק" },
      { key: "bank", label: "בנק" },
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

  nextDocNumber(docType) {
    const s = DB.getSettings();
    const key = docType === "invoice" ? "nextInvoiceNumber" : docType === "receipt" ? "nextReceiptNumber" : "nextQuoteNumber";
    return s[key];
  },
  bumpDocNumber(docType) {
    const s = DB.getSettings();
    const key = docType === "invoice" ? "nextInvoiceNumber" : docType === "receipt" ? "nextReceiptNumber" : "nextQuoteNumber";
    s[key] = s[key] + 1;
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
function formatDateHe(dateStr) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-");
  return `${d}/${m}/${y}`;
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

const FLOWCRM_ICON_SVG = `
<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <circle cx="50" cy="50" r="50" fill="#1e3a5f"/>
  <path d="M32 22 h24 l12 12 v42 a4 4 0 0 1-4 4 H32 a4 4 0 0 1-4-4 V26 a4 4 0 0 1 4-4 z" fill="#ffffff"/>
  <path d="M56 22 v10 a2 2 0 0 0 2 2 h10 z" fill="#c7d4e3"/>
  <path d="M33 55 l11 11 22-24" fill="none" stroke="#22c55e" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`.trim();

const DIGITAL_STAMP_SVG = `
<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <path id="fcStampTopArc" d="M 12 52 A 38 38 0 0 1 88 52" fill="none"/>
  </defs>
  <circle cx="50" cy="50" r="46" fill="none" stroke="#1e3a5f" stroke-width="2"/>
  <circle cx="50" cy="50" r="40" fill="none" stroke="#1e3a5f" stroke-width="1" stroke-dasharray="2 2"/>
  <text font-size="9" font-weight="700" fill="#1e3a5f" font-family="DejaVu Sans Condensed, Arial, sans-serif">
    <textPath href="#fcStampTopArc" startOffset="50%" text-anchor="middle">מסמך מאומת</textPath>
  </text>
  <path d="M32 51 L44 63 L70 35" fill="none" stroke="#22c55e" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="50" y="76" font-size="8" fill="#1e3a5f" text-anchor="middle" font-family="DejaVu Sans Condensed, Arial, sans-serif">חתום דיגיטלית</text>
</svg>`.trim();

function renderSidebar(active) {
  const items = [
    ["index.html", "לוח בקרה"],
    ["documents.html", "מסמכים"],
    ["clients.html", "לקוחות"],
    ["expenses.html", "הוצאות"],
    ["reports.html", "דוחות"],
    ["settings.html", "הגדרות"],
  ];
  const nav = items.map(([href, label]) =>
    `<a href="${href}" class="${active === href ? "active" : ""}">${label}</a>`
  ).join("");
  return `
  <button class="hamburger" id="hamburgerBtn">☰</button>
  <aside class="sidebar" id="sidebar">
    <div class="brand-row">
      <span class="brand-icon">${FLOWCRM_ICON_SVG}</span>
      <div>
        <div class="brand">FlowCRM</div>
        <div class="brand-sub">מערכת ניהול מסמכים עצמאית</div>
      </div>
    </div>
    <nav>${nav}</nav>
    <a href="create.html" class="new-doc-btn">+ מסמך חדש</a>
    <div class="footer">הנתונים נשמרים במכשיר זה בלבד</div>
  </aside>`;
}

function mountShell(active) {
  document.body.insertAdjacentHTML("afterbegin", renderSidebar(active));
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
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
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
