/* ============================================================
   FlowCRM — Google Drive sync (optional, client-side only)

   How this works, honestly:
   - There is still no server. Sign-in happens entirely in the browser via
     Google Identity Services (GIS), and all Drive API calls are made
     directly from this browser to Google using the resulting access token.
     Nothing passes through any server we control.
   - Scope used is "drive.file" — the app can only see/create/edit files
     IT created, never your whole Drive. It creates exactly one file,
     "FlowCRM Backup.json", in your Drive root, and only ever touches that.
   - Sync is "last write wins" based on a lastModified timestamp stored
     inside the JSON itself (not Drive's own modified-time, to avoid
     clock-skew between devices). Whichever side has the newer timestamp
     overwrites the other, in full. This is NOT a field-by-field merge —
     if you edit the same client on two devices while both are offline and
     then both come online, one edit will simply overwrite the other. For
     a single person working from one device at a time (phone OR laptop,
     not both at once mid-edit) this is safe in practice, but it is not
     magic conflict resolution, and you should know that going in.
   - Access tokens from GIS last about an hour. This code tries to renew
     them silently in the background; browsers that block third-party
     silent auth (Safari, and Chrome/Firefox in some privacy modes) may
     occasionally require you to click "התחבר" again. That is a real
     limitation of doing OAuth with no server — not a bug to "just fix".
   - You must create your own Google Cloud OAuth Client ID and paste it
     into Settings > סנכרון לגוגל דרייב. This app cannot create one for
     you — Google requires it to be tied to a project you own. See the
     instructions in Settings.
   ============================================================ */

const DRIVE_BACKUP_FILENAME = "FlowCRM Backup.json";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

const DriveSync = (() => {
  const LS_CLIENT_ID = "flowcrm_google_client_id";
  const LS_CONNECTED = "flowcrm_google_connected";
  const LS_FILE_ID = "flowcrm_drive_file_id";
  const LS_LAST_SYNC = "flowcrm_drive_last_sync";
  const LS_LOCAL_META = "flowcrm_sync_meta"; // { lastModified: <ms> }

  let tokenClient = null;
  let accessToken = null;
  let gisLoaded = false;
  let applyingRemote = false; // guards against re-triggering auto-push while we write incoming data
  let pushTimer = null;
  let statusListeners = [];
  let lastError = null;

  function notify() {
    statusListeners.forEach(fn => { try { fn(getStatus()); } catch (e) {} });
  }

  function getClientId() {
    return localStorage.getItem(LS_CLIENT_ID) || "";
  }
  function setClientId(id) {
    localStorage.setItem(LS_CLIENT_ID, (id || "").trim());
  }
  function isConfigured() {
    return !!getClientId();
  }
  function isConnected() {
    return localStorage.getItem(LS_CONNECTED) === "1";
  }
  function getLocalMeta() {
    return loadJSON(LS_LOCAL_META, { lastModified: 0 });
  }
  function bumpLocalMeta() {
    saveJSON(LS_LOCAL_META, { lastModified: Date.now() });
  }

  function getStatus() {
    return {
      configured: isConfigured(),
      connected: isConnected(),
      hasToken: !!accessToken,
      lastSync: localStorage.getItem(LS_LAST_SYNC) || null,
      lastError,
    };
  }

  function onStatusChange(fn) {
    statusListeners.push(fn);
  }

  function loadGisScript() {
    if (gisLoaded) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const existing = document.getElementById("gis-script");
      if (existing) {
        existing.addEventListener("load", () => { gisLoaded = true; resolve(); });
        return;
      }
      const s = document.createElement("script");
      s.id = "gis-script";
      s.src = "https://accounts.google.com/gsi/client";
      s.async = true;
      s.defer = true;
      s.onload = () => { gisLoaded = true; resolve(); };
      s.onerror = () => reject(new Error("לא ניתן לטעון את שירות ההתחברות של גוגל"));
      document.head.appendChild(s);
    });
  }

  function ensureTokenClient() {
    if (tokenClient) return tokenClient;
    const clientId = getClientId();
    if (!clientId) throw new Error("לא הוגדר Google Client ID");
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: () => {}, // overridden per-call below
    });
    return tokenClient;
  }

  function requestToken({ silent }) {
    return new Promise(async (resolve, reject) => {
      try {
        await loadGisScript();
        const client = ensureTokenClient();
        client.callback = (resp) => {
          if (resp && resp.access_token) {
            accessToken = resp.access_token;
            resolve(accessToken);
          } else {
            reject(new Error((resp && resp.error) || "לא התקבל אישור מגוגל"));
          }
        };
        client.error_callback = (err) => {
          reject(new Error((err && err.type) || "ההתחברות בוטלה"));
        };
        client.requestAccessToken({ prompt: silent ? "" : "consent" });
      } catch (e) {
        reject(e);
      }
    });
  }

  async function connect() {
    lastError = null;
    try {
      await requestToken({ silent: false });
      localStorage.setItem(LS_CONNECTED, "1");
      notify();
      await syncNow();
      return true;
    } catch (e) {
      lastError = e.message || String(e);
      notify();
      throw e;
    }
  }

  function disconnect() {
    if (accessToken && window.google && google.accounts && google.accounts.oauth2) {
      try { google.accounts.oauth2.revoke(accessToken, () => {}); } catch (e) {}
    }
    accessToken = null;
    localStorage.removeItem(LS_CONNECTED);
    localStorage.removeItem(LS_FILE_ID);
    localStorage.removeItem(LS_LAST_SYNC);
    notify();
  }

  async function ensureAccessToken() {
    if (accessToken) return accessToken;
    return requestToken({ silent: true });
  }

  function buildBackupPayload() {
    return {
      exportedAt: new Date().toISOString(),
      lastModified: getLocalMeta().lastModified || Date.now(),
      settings: DB.getSettings(),
      clients: DB.getClients(),
      documents: DB.getDocuments(),
      expenses: DB.getExpenses(),
    };
  }

  async function driveFetch(url, opts) {
    const token = await ensureAccessToken();
    const res = await fetch(url, {
      ...opts,
      headers: { ...(opts && opts.headers), Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      // token expired/invalid mid-flight — force one real re-auth attempt
      accessToken = null;
      const fresh = await requestToken({ silent: true });
      const retry = await fetch(url, {
        ...opts,
        headers: { ...(opts && opts.headers), Authorization: `Bearer ${fresh}` },
      });
      return retry;
    }
    return res;
  }

  async function findRemoteFileId() {
    const cached = localStorage.getItem(LS_FILE_ID);
    if (cached) return cached;
    const q = encodeURIComponent(`name='${DRIVE_BACKUP_FILENAME}' and trashed=false`);
    const res = await driveFetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`
    );
    if (!res.ok) throw new Error("שגיאה בחיפוש קובץ הגיבוי בדרייב");
    const data = await res.json();
    const found = data.files && data.files[0];
    if (found) {
      localStorage.setItem(LS_FILE_ID, found.id);
      return found.id;
    }
    return null;
  }

  async function downloadRemote(fileId) {
    const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    if (!res.ok) throw new Error("שגיאה בהורדת הגיבוי מדרייב");
    return res.json();
  }

  async function uploadRemote(fileId, payload) {
    const body = JSON.stringify(payload, null, 2);
    if (fileId) {
      const res = await driveFetch(
        `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body }
      );
      if (!res.ok) throw new Error("שגיאה בהעלאת הגיבוי לדרייב");
      return fileId;
    }
    // Create new file (multipart: metadata + content)
    const boundary = "flowcrm-" + Math.random().toString(36).slice(2);
    const metadata = { name: DRIVE_BACKUP_FILENAME, mimeType: "application/json" };
    const multipartBody =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n` +
      `--${boundary}--`;
    const res = await driveFetch(
      `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id`,
      { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body: multipartBody }
    );
    if (!res.ok) throw new Error("שגיאה ביצירת קובץ הגיבוי בדרייב");
    const data = await res.json();
    localStorage.setItem(LS_FILE_ID, data.id);
    return data.id;
  }

  function applyRemoteData(data) {
    applyingRemote = true;
    try {
      if (data.settings) DB.saveSettings(data.settings);
      if (data.clients) DB.saveClients(data.clients);
      if (data.documents) DB.saveDocuments(data.documents);
      if (data.expenses) DB.saveExpenses(data.expenses);
      saveJSON(LS_LOCAL_META, { lastModified: data.lastModified || Date.now() });
    } finally {
      applyingRemote = false;
    }
  }

  async function syncNow() {
    if (!isConfigured()) throw new Error("לא הוגדר Google Client ID");
    lastError = null;
    try {
      const fileId = await findRemoteFileId();
      if (fileId) {
        const remote = await downloadRemote(fileId);
        const remoteLM = remote.lastModified || 0;
        const localLM = getLocalMeta().lastModified || 0;
        if (remoteLM > localLM) {
          applyRemoteData(remote);
        } else if (localLM > remoteLM) {
          await uploadRemote(fileId, buildBackupPayload());
        }
        // equal timestamps: already in sync, nothing to do
      } else {
        await uploadRemote(null, buildBackupPayload());
      }
      localStorage.setItem(LS_LAST_SYNC, new Date().toISOString());
      notify();
      return true;
    } catch (e) {
      lastError = e.message || String(e);
      notify();
      throw e;
    }
  }

  function scheduleAutoPush() {
    if (!isConnected() || applyingRemote) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      syncNow().catch(() => {}); // errors already surfaced via status/lastError
    }, 2500);
  }

  // Called from saveJSON() for every local write to a tracked key, so the
  // local "clock" advances and a debounced push gets queued automatically.
  function noteLocalWrite(key) {
    if (applyingRemote) return; // don't re-stamp while writing incoming remote data
    if (![DB_KEYS.settings, DB_KEYS.clients, DB_KEYS.documents, DB_KEYS.expenses].includes(key)) return;
    bumpLocalMeta();
    scheduleAutoPush();
  }

  async function initOnLoad() {
    if (!isConfigured() || !isConnected()) return;
    try {
      await requestToken({ silent: true });
      await syncNow();
    } catch (e) {
      // Silent renewal failed (expired grant, blocked third-party auth,
      // etc.) — leave state as "connected" so the UI can prompt the user
      // to click "התחבר" again rather than silently losing the setting.
      lastError = e.message || String(e);
      notify();
    }
  }

  return {
    isConfigured, isConnected, getStatus, onStatusChange,
    getClientId, setClientId,
    connect, disconnect, syncNow, initOnLoad, noteLocalWrite,
  };
})();

document.addEventListener("DOMContentLoaded", () => {
  DriveSync.initOnLoad();
});
