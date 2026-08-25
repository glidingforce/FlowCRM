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

   - Access tokens (~1 hour, then Google requires a fresh one). THE FIX IN
     THIS VERSION: earlier code tried to silently re-request a token from
     background code (page load, or a few seconds after you finished
     typing) with no click involved. Browsers block a popup window that
     isn't opened directly from a real click — so those silent attempts
     kept failing with "popup_failed_to_open", and on Safari/iPhone that
     happens constantly since Safari blocks the cookie-based silent path
     Google normally uses instead of a popup. That's what caused
     "asks me to log in again and again".

     The fix: this module now caches the access token (with its expiry) in
     localStorage, shared by every page. As long as that cached token is
     still valid, EVERY page load and EVERY auto-save sync reuses it —
     genuinely automatic, no Google calls, no popups. The only time it
     talks to Google in the background is once per page load, to check
     the cache; if the cached token has expired, it does NOT attempt to
     silently renew it (that's the popup-triggering behavior being
     removed). It just shows "not synced — click סנכרן עכשיו" and waits.
     Clicking "סנכרן עכשיו" or "התחברות" IS a real click, so the browser
     allows a popup there if Google needs one, and a fresh ~1-hour token
     gets cached again.

     Net effect: sync is fully automatic while you're actively using the
     app (token cache refreshes every time you click sync, which resets
     the 1-hour window). If the app sits untouched for over an hour and
     you come back, the first thing you do that touches sync will need
     one click. That is a real, permanent limitation of doing OAuth with
     no server — not something that can be "fixed" further from pure
     client-side code. On iPhone Safari specifically, expect that click
     to be needed more often than on desktop Chrome — Safari's privacy
     protections are stricter, not a bug in this app.
   - You must create your own Google Cloud OAuth Client ID and paste it
     into Settings > סנכרון לגוגל דרייב. This app cannot create one for
     you — Google requires it to be tied to a project you own. See the
     instructions in Settings.
   ============================================================ */

const DRIVE_BACKUP_FILENAME = "FlowCRM Backup.json";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const TOKEN_EXPIRY_BUFFER_MS = 60 * 1000; // treat a token as expired 60s early

const DriveSync = (() => {
  const LS_CLIENT_ID = "flowcrm_google_client_id";
  const LS_CONNECTED = "flowcrm_google_connected";
  const LS_FILE_ID = "flowcrm_drive_file_id";
  const LS_LAST_SYNC = "flowcrm_drive_last_sync";
  const LS_LOCAL_META = "flowcrm_sync_meta"; // { lastModified: <ms> }
  const LS_TOKEN = "flowcrm_google_token"; // { access_token, expires_at } — cached across page loads on purpose

  let tokenClient = null;
  let gisLoaded = false;
  let gisLoadPromise = null;
  let applyingRemote = false; // guards against re-triggering auto-push while we write incoming data
  let pushTimer = null;
  let statusListeners = [];
  let lastError = null;
  let needsReconnect = false; // token expired and no click has renewed it yet — not an "error", just waiting

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

  function getCachedToken() {
    const t = loadJSON(LS_TOKEN, null);
    if (!t || !t.access_token || !t.expires_at) return null;
    if (Date.now() > t.expires_at - TOKEN_EXPIRY_BUFFER_MS) return null;
    return t.access_token;
  }
  function storeToken(access_token, expires_in_seconds) {
    saveJSON(LS_TOKEN, {
      access_token,
      expires_at: Date.now() + (Number(expires_in_seconds) || 3300) * 1000,
    });
  }
  function clearToken() {
    localStorage.removeItem(LS_TOKEN);
  }

  function getStatus() {
    return {
      configured: isConfigured(),
      connected: isConnected(),
      hasValidToken: !!getCachedToken(),
      needsReconnect,
      lastSync: localStorage.getItem(LS_LAST_SYNC) || null,
      lastError,
    };
  }

  function onStatusChange(fn) {
    statusListeners.push(fn);
  }

  function loadGisScript() {
    if (gisLoaded) return Promise.resolve();
    if (gisLoadPromise) return gisLoadPromise;
    gisLoadPromise = new Promise((resolve, reject) => {
      const existing = document.getElementById("gis-script");
      if (existing) {
        existing.addEventListener("load", () => { gisLoaded = true; resolve(); });
        existing.addEventListener("error", () => reject(new Error("לא ניתן לטעון את שירות ההתחברות של גוגל")));
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
    return gisLoadPromise;
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

  // Only ever call this from code that runs directly inside a user click
  // (connect button, sync-now button). Google/the browser may need to show
  // a popup, and popups opened outside a click are blocked — that's the
  // exact bug this rewrite fixes, so never call this from a timer or
  // page-load handler.
  function requestTokenInteractive() {
    return new Promise(async (resolve, reject) => {
      try {
        await loadGisScript();
        const client = ensureTokenClient();
        client.callback = (resp) => {
          if (resp && resp.access_token) {
            storeToken(resp.access_token, resp.expires_in);
            needsReconnect = false;
            resolve(resp.access_token);
          } else {
            reject(new Error((resp && resp.error) || "לא התקבל אישור מגוגל"));
          }
        };
        client.error_callback = (err) => {
          reject(new Error((err && err.type) || "ההתחברות בוטלה"));
        };
        client.requestAccessToken({ prompt: "" }); // "" = only show UI if actually needed (e.g. first-ever connect)
      } catch (e) {
        reject(e);
      }
    });
  }

  async function connect() {
    lastError = null;
    try {
      await requestTokenInteractive();
      localStorage.setItem(LS_CONNECTED, "1");
      notify();
      await syncNow({ interactive: true });
      return true;
    } catch (e) {
      lastError = e.message || String(e);
      notify();
      throw e;
    }
  }

  function disconnect() {
    const token = getCachedToken();
    if (token && window.google && google.accounts && google.accounts.oauth2) {
      try { google.accounts.oauth2.revoke(token, () => {}); } catch (e) {}
    }
    clearToken();
    localStorage.removeItem(LS_CONNECTED);
    localStorage.removeItem(LS_FILE_ID);
    localStorage.removeItem(LS_LAST_SYNC);
    needsReconnect = false;
    notify();
  }

  // interactive=true (a real click): will pop the sign-in flow if the
  // cached token is gone. interactive=false (page load / auto-save
  // timer): NEVER calls Google — just uses the cache if it's still good,
  // otherwise fails fast with no network/popup attempt at all.
  async function ensureAccessToken(interactive) {
    const cached = getCachedToken();
    if (cached) return cached;
    if (!interactive) {
      needsReconnect = true;
      throw new Error("הטוקן פג — לחצו \"סנכרן עכשיו\" כדי לחדש");
    }
    return requestTokenInteractive();
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

  async function driveFetch(url, opts, interactive) {
    const token = await ensureAccessToken(interactive);
    const res = await fetch(url, {
      ...opts,
      headers: { ...(opts && opts.headers), Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      // Google rejected the cached token mid-flight (revoked/expired early).
      // Only retry with a fresh interactive request if this call is allowed
      // to be interactive — never pop a window from a background retry.
      clearToken();
      if (!interactive) throw new Error("ההרשאה פגה — לחצו \"סנכרן עכשיו\"");
      const fresh = await requestTokenInteractive();
      return fetch(url, {
        ...opts,
        headers: { ...(opts && opts.headers), Authorization: `Bearer ${fresh}` },
      });
    }
    return res;
  }

  async function findRemoteFileId(interactive) {
    const cached = localStorage.getItem(LS_FILE_ID);
    if (cached) return cached;
    const q = encodeURIComponent(`name='${DRIVE_BACKUP_FILENAME}' and trashed=false`);
    const res = await driveFetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`,
      undefined, interactive
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

  async function downloadRemote(fileId, interactive) {
    const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, undefined, interactive);
    if (!res.ok) throw new Error("שגיאה בהורדת הגיבוי מדרייב");
    return res.json();
  }

  async function uploadRemote(fileId, payload, interactive) {
    const body = JSON.stringify(payload, null, 2);
    if (fileId) {
      const res = await driveFetch(
        `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body },
        interactive
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
      { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body: multipartBody },
      interactive
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

  // opts.interactive: pass true ONLY when this call originates directly
  // inside a click handler (connect button, "סנכרן עכשיו" button).
  async function syncNow(opts) {
    const interactive = !!(opts && opts.interactive);
    if (!isConfigured()) throw new Error("לא הוגדר Google Client ID");
    lastError = null;
    try {
      const fileId = await findRemoteFileId(interactive);
      if (fileId) {
        const remote = await downloadRemote(fileId, interactive);
        const remoteLM = remote.lastModified || 0;
        const localLM = getLocalMeta().lastModified || 0;
        if (remoteLM > localLM) {
          applyRemoteData(remote);
        } else if (localLM > remoteLM) {
          await uploadRemote(fileId, buildBackupPayload(), interactive);
        }
        // equal timestamps: already in sync, nothing to do
      } else {
        await uploadRemote(null, buildBackupPayload(), interactive);
      }
      localStorage.setItem(LS_LAST_SYNC, new Date().toISOString());
      needsReconnect = false;
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
      // Background push: interactive:false means this silently no-ops
      // (sets needsReconnect) instead of trying to pop a sign-in window
      // while you're in the middle of typing.
      syncNow({ interactive: false }).catch(() => {});
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
    // Background: only proceeds if a cached token is still valid. Does NOT
    // attempt to (re)acquire one — that would risk the exact
    // popup-blocked-on-page-load problem this version removes.
    try {
      await syncNow({ interactive: false });
    } catch (e) {
      // Expected/routine once the ~1h token has expired — not shown as a
      // scary error; getStatus().needsReconnect tells the UI to just show
      // a calm "click sync" prompt instead.
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
