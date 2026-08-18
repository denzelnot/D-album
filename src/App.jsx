import { useState, useCallback, useEffect, useRef } from "react";
import {
  Image as ImageIcon,
  MapPin,
  Upload,
  X,
  Sparkles,
  ChevronLeft,
  ChevronRight,
  FileWarning,
  RefreshCw,
  LogOut,
  WifiOff,
  CloudOff,
  ChevronDown,
} from "lucide-react";

const SUPABASE_URL = "https://nynaypkgnnccjroypvyu.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im55bmF5cGtnbm5jY2pyb3lwdnl1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY4NzYzMzAsImV4cCI6MjEwMjQ1MjMzMH0.53rOT9vfaNsTE-Le6GVgl8_zRPAVQbaG0MuLWoKfJCs";

const MEMBER_COLORS = ["#ff6fb5", "#a78bfa", "#5eead4", "#fbbf24", "#fb7185", "#60a5fa", "#6ee7b7", "#f0abfc"];

function colorForName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return MEMBER_COLORS[hash % MEMBER_COLORS.length];
}

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?|avif)$/i;

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function extLabel(name) {
  const m = name.match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toUpperCase() : "ФОТО";
}

// Races a promise against a timer — if a network call (or anything else)
// just hangs instead of failing outright (common on flaky mobile connections),
// this forces it to give up after `ms` instead of stalling the whole batch.
function withTimeout(promise, ms, label = "Операция") {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}: превышено время ожидания`)), ms)),
  ]);
}

// Large phone-camera originals (and especially "download original" files from
// Google Photos) can be 10-20+ MB — decoding, base64-encoding and uploading
// that full-size on a low-RAM phone is exactly what triggers "not enough
// memory" errors. We downscale to a sensible viewing size first; EXIF is
// always read from the true original before this runs, so the date/location
// aren't affected. Falls back to the original file untouched if the browser
// can't decode it (e.g. HEIC) or anything goes wrong.
function resizeImage(file, maxDim = 1600, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(objectUrl);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("no blob"))), "image/jpeg", quality);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("decode failed"));
    };
    img.src = objectUrl;
  });
}

// ---------- Offline storage (IndexedDB) ----------
// "photoCache": last-known copy of the album, so it opens instantly and works
// with no signal. "pendingUploads": photos added while offline, sent for real
// once the connection comes back.
const DB_NAME = "dalbum-offline";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("photoCache")) db.createObjectStore("photoCache", { keyPath: "id" });
      if (!db.objectStoreNames.contains("pendingUploads")) db.createObjectStore("pendingUploads", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(storeName, value) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // offline storage is a nice-to-have — never let it break the app
  }
}

async function idbGetAll(storeName) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

async function idbDelete(storeName, id) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // ignore
  }
}

async function idbClearAndFill(storeName, values) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      store.clear();
      for (const v of values) store.put(v);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // ignore
  }
}

// ---------- Minimal manual EXIF reader (no external libraries) ----------
function getTypeSize(type) {
  switch (type) {
    case 1: case 2: case 6: case 7: return 1;
    case 3: case 8: return 2;
    case 4: case 9: return 4;
    case 5: case 10: return 8;
    default: return 4;
  }
}
function readEntries(view, ifdStart, little) {
  const count = view.getUint16(ifdStart, little);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const entryOffset = ifdStart + 2 + i * 12;
    entries.push({
      tag: view.getUint16(entryOffset, little),
      type: view.getUint16(entryOffset + 2, little),
      numValues: view.getUint32(entryOffset + 4, little),
      entryOffset,
    });
  }
  return entries;
}
function readValue(view, tiffStart, entry, little) {
  const size = getTypeSize(entry.type) * entry.numValues;
  const valueOffset =
    size <= 4 ? entry.entryOffset + 8 : tiffStart + view.getUint32(entry.entryOffset + 8, little);
  if (entry.type === 2) {
    let str = "";
    for (let i = 0; i < entry.numValues - 1; i++) {
      const code = view.getUint8(valueOffset + i);
      if (code === 0) break;
      str += String.fromCharCode(code);
    }
    return str;
  }
  if (entry.type === 3) return view.getUint16(valueOffset, little);
  if (entry.type === 4) return view.getUint32(valueOffset, little);
  if (entry.type === 5) {
    const vals = [];
    for (let i = 0; i < entry.numValues; i++) {
      const num = view.getUint32(valueOffset + i * 8, little);
      const den = view.getUint32(valueOffset + i * 8 + 4, little);
      vals.push(den === 0 ? 0 : num / den);
    }
    return vals;
  }
  return null;
}
function parseExifDate(str) {
  const m = str && str.trim().match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`);
  return isNaN(date.getTime()) ? null : date;
}
function parseExif(buffer) {
  try {
    const view = new DataView(buffer);
    if (view.getUint16(0) !== 0xffd8) return null;
    let offset = 2;
    while (offset < view.byteLength - 4) {
      if (view.getUint8(offset) !== 0xff) { offset++; continue; }
      const marker = view.getUint16(offset, false);
      if (marker === 0xffd8) { offset += 2; continue; }
      if (marker === 0xffd9 || (marker & 0xfff0) === 0xffd0) { offset += 2; continue; }
      if (marker === 0xffda) break;
      const segLength = view.getUint16(offset + 2, false);
      if (marker === 0xffe1) {
        const tag = String.fromCharCode(
          view.getUint8(offset + 4), view.getUint8(offset + 5),
          view.getUint8(offset + 6), view.getUint8(offset + 7)
        );
        if (tag === "Exif") {
          const tiffStart = offset + 10;
          const little = view.getUint16(tiffStart, false) === 0x4949;
          const firstIFDOffset = view.getUint32(tiffStart + 4, little);
          const ifd0 = readEntries(view, tiffStart + firstIFDOffset, little);
          let exifIFDOffset = null, gpsIFDOffset = null;
          for (const e of ifd0) {
            if (e.tag === 0x8769) exifIFDOffset = readValue(view, tiffStart, e, little);
            if (e.tag === 0x8825) gpsIFDOffset = readValue(view, tiffStart, e, little);
          }
          const result = {};
          if (exifIFDOffset != null) {
            const exifEntries = readEntries(view, tiffStart + exifIFDOffset, little);
            for (const e of exifEntries) {
              if (e.tag === 0x9003) {
                const raw = readValue(view, tiffStart, e, little);
                const parsed = parseExifDate(raw);
                if (parsed) result.takenAt = parsed;
              }
            }
          }
          if (gpsIFDOffset != null) {
            const gpsEntries = readEntries(view, tiffStart + gpsIFDOffset, little);
            let latRef, lngRef, lat, lng;
            for (const e of gpsEntries) {
              if (e.tag === 1) latRef = readValue(view, tiffStart, e, little);
              if (e.tag === 2) lat = readValue(view, tiffStart, e, little);
              if (e.tag === 3) lngRef = readValue(view, tiffStart, e, little);
              if (e.tag === 4) lng = readValue(view, tiffStart, e, little);
            }
            if (Array.isArray(lat) && Array.isArray(lng)) {
              result.lat = (lat[0] + lat[1] / 60 + lat[2] / 3600) * (latRef === "S" ? -1 : 1);
              result.lng = (lng[0] + lng[1] / 60 + lng[2] / 3600) * (lngRef === "W" ? -1 : 1);
            }
          }
          return result;
        }
      }
      offset += 2 + segLength;
    }
    return null;
  } catch {
    return null;
  }
}

function formatDateHeader(date) {
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" }).toUpperCase();
}
function formatDateFull(date) {
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function formatCoords(lat, lng) {
  const latAbs = Math.abs(lat).toFixed(2);
  const lngAbs = Math.abs(lng).toFixed(2);
  return `${latAbs}° ${lat >= 0 ? "с.ш." : "ю.ш."}, ${lngAbs}° ${lng >= 0 ? "в.д." : "з.д."}`;
}
function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

// ---------- Supabase REST helpers (plain fetch, no SDK) ----------
async function signUp(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.msg || data.error_description || data.error || "Не удалось зарегистрироваться");
  return data;
}

async function signIn(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.msg || data.error_description || "Неверная почта или пароль");
  return data;
}

async function recoverPassword(email) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/recover`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.msg || err.error_description || "Не удалось отправить письмо для сброса пароля");
  }
}

async function refreshSession(refreshToken) {
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } catch {
    const err = new Error("Нет соединения");
    err.isNetworkError = true;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.msg || data.error_description || "Не удалось продлить сессию");
  return data;
}

const SESSION_KEY = "dalbum-session";
function saveSession(data) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(data));
  } catch {
    // storage unavailable (private browsing etc.) — session just won't persist
  }
}
function loadStoredSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function clearStoredSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
}

async function uploadToStorage(accessToken, path, file) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/photos/${encodeURIComponent(path)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: SUPABASE_ANON_KEY,
      "Content-Type": file.type || "application/octet-stream",
    },
    body: file,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || "Не удалось загрузить файл в облако");
  }
}

async function insertPhotoRow(accessToken, row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/photos`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(row),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || "Не удалось сохранить запись в базе");
  return data[0];
}

async function fetchPhotoRows(accessToken) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/photos?select=*&order=taken_at.desc`, {
    headers: { Authorization: `Bearer ${accessToken}`, apikey: SUPABASE_ANON_KEY },
  });
  const data = await res.json().catch(() => ([]));
  if (!res.ok) throw new Error(data.message || "Не удалось загрузить список фото");
  return data;
}

async function deletePhotoRow(accessToken, id) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/photos?id=eq.${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}`, apikey: SUPABASE_ANON_KEY },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || "Не удалось удалить запись");
  }
}

async function deleteStorageObject(accessToken, path) {
  await fetch(`${SUPABASE_URL}/storage/v1/object/photos/${encodeURIComponent(path)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}`, apikey: SUPABASE_ANON_KEY },
  });
}

async function signPaths(accessToken, paths) {
  if (paths.length === 0) return {};
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/photos`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expiresIn: 3600, paths }),
  });
  const data = await res.json().catch(() => ([]));
  if (!res.ok) return {};
  const map = {};
  for (const item of data) {
    if (item.signedURL) map[item.path] = `${SUPABASE_URL}/storage/v1${item.signedURL}`;
  }
  return map;
}

function FallbackTile({ name, big }) {
  return (
    <div style={{ ...styles.fallback, aspectRatio: big ? "4 / 3" : "1 / 1" }}>
      <div style={styles.fallbackIcon}>
        <FileWarning size={big ? 26 : 18} color="#1a1420" strokeWidth={2} />
      </div>
      <div style={{ ...styles.fallbackName, fontSize: big ? 13 : 11 }}>{name}</div>
      <div style={styles.fallbackBadge}>{extLabel(name)}</div>
    </div>
  );
}

export default function DAlbom() {
  const [session, setSession] = useState(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState("login"); // 'login' | 'signup'
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [resetSent, setResetSent] = useState(false);
  const [restoringSession, setRestoringSession] = useState(true);

  const [photos, setPhotos] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [lightboxId, setLightboxId] = useState(null);
  const [loadingPhotos, setLoadingPhotos] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [isOnline, setIsOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  const [pendingCount, setPendingCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [viewFilter, setViewFilter] = useState("all");
  const [batchProgress, setBatchProgress] = useState(null); // {done, total} while a multi-select upload is running
  const [batchSummary, setBatchSummary] = useState("");
  const [collapsedDays, setCollapsedDays] = useState(() => new Set());

  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  // Restore a saved login on launch, and keep it refreshed automatically —
  // signing out now only happens if you tap "Выйти".
  useEffect(() => {
    const stored = loadStoredSession();
    if (!stored?.refresh_token) {
      setRestoringSession(false);
      return;
    }
    refreshSession(stored.refresh_token)
      .then((data) => {
        setSession(data);
        saveSession(data);
      })
      .catch((e) => {
        if (e.isNetworkError) {
          // no connection right now — the saved login is probably still fine,
          // don't throw it away just because we couldn't check
          setSession(stored);
        } else {
          clearStoredSession();
        }
      })
      .finally(() => setRestoringSession(false));
  }, []);

  useEffect(() => {
    if (!session?.refresh_token) return;
    const id = setInterval(() => {
      refreshSession(session.refresh_token)
        .then((data) => {
          setSession(data);
          saveSession(data);
        })
        .catch(() => {});
    }, 50 * 60 * 1000); // refresh well before the ~1h token expiry
    return () => clearInterval(id);
  }, [session]);

  const myId = session?.user?.id;
  const myLabel = session?.user?.email || "";

  const loadFromCache = useCallback(async () => {
    const cached = await idbGetAll("photoCache");
    const pending = await idbGetAll("pendingUploads");
    const cachedPhotos = cached.map((c) => ({
      ...c,
      url: c.dataUrl,
      takenAt: new Date(c.takenAt),
      remote: true,
      previewFailed: !c.dataUrl,
    }));
    const pendingPhotos = pending.map((p) => ({
      id: p.id,
      url: p.dataUrl,
      name: p.name,
      takenAt: new Date(p.takenAt),
      hasExifDate: p.hasExifDate,
      lat: p.lat,
      lng: p.lng,
      uploadedBy: p.uploadedBy,
      ownerId: p.ownerId,
      previewFailed: !p.dataUrl,
      pending: true,
    }));
    setPhotos([...pendingPhotos, ...cachedPhotos]);
    setPendingCount(pending.length);
  }, []);

  const cacheRemotePhotos = useCallback(async (loaded) => {
    const loadedIds = new Set(loaded.map((p) => p.id));
    const existingCache = await idbGetAll("photoCache");
    const alreadyCached = new Set(existingCache.map((c) => c.id));
    for (const c of existingCache) if (!loadedIds.has(c.id)) idbDelete("photoCache", c.id);

    // Only the photos we don't already have offline, newest first, and capped —
    // re-downloading and re-encoding the whole album on every single app open
    // (which is what was happening before) is exactly what was making things
    // feel slow, and could leave later photos never cached at all on a weak phone.
    const toCache = loaded.filter((p) => p.url && !alreadyCached.has(p.id)).slice(0, 60);

    for (const p of toCache) {
      try {
        const res = await withTimeout(fetch(p.url), 15000, "Загрузка офлайн-копии");
        const blob = await res.blob();
        const dataUrl = await readAsDataURL(blob);
        await idbPut("photoCache", {
          id: p.id,
          dataUrl,
          filePath: p.filePath,
          name: p.name,
          takenAt: p.takenAt.toISOString(),
          hasExifDate: p.hasExifDate,
          lat: p.lat,
          lng: p.lng,
          uploadedBy: p.uploadedBy,
          ownerId: p.ownerId,
        });
      } catch {
        // this one just won't be viewable offline until the next successful sync
      }
      // yield to the main thread between photos so this background job never
      // freezes scrolling/tapping while it works through a big batch
      await new Promise((r) => setTimeout(r, 30));
    }
  }, []);

  const loadPhotos = useCallback(
    async (accessToken) => {
      setLoadingPhotos(true);
      try {
        const rows = await fetchPhotoRows(accessToken);
        const urlMap = await signPaths(accessToken, rows.map((r) => r.file_path));
        const loaded = rows.map((r) => ({
          id: r.id,
          url: urlMap[r.file_path] || null,
          filePath: r.file_path,
          name: r.file_path.split("/").pop(),
          takenAt: new Date(r.taken_at || r.uploaded_at),
          hasExifDate: !!r.taken_at,
          lat: r.lat,
          lng: r.lng,
          uploadedBy: r.uploaded_by,
          ownerId: r.owner_id,
          previewFailed: !urlMap[r.file_path],
          remote: true,
        }));
        const pending = await idbGetAll("pendingUploads");
        const pendingPhotos = pending.map((p) => ({
          id: p.id,
          url: p.dataUrl,
          name: p.name,
          takenAt: new Date(p.takenAt),
          hasExifDate: p.hasExifDate,
          lat: p.lat,
          lng: p.lng,
          uploadedBy: p.uploadedBy,
          ownerId: p.ownerId,
          previewFailed: !p.dataUrl,
          pending: true,
        }));
        setPhotos([...pendingPhotos, ...loaded]);
        setPendingCount(pending.length);
        cacheRemotePhotos(loaded);
      } catch (e) {
        await loadFromCache();
        if (isOnline) setUploadError(e.message);
      } finally {
        setLoadingPhotos(false);
      }
    },
    [cacheRemotePhotos, loadFromCache, isOnline]
  );

  const syncPendingUploads = useCallback(async () => {
    if (!session?.access_token) return;
    const pending = await idbGetAll("pendingUploads");
    if (pending.length === 0) return;
    setSyncing(true);
    for (const item of pending) {
      try {
        const blobRes = await fetch(item.dataUrl);
        const blob = await blobRes.blob();
        const safeName = item.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const path = `${item.ownerId}/${item.uploadedAt}-${safeName}`;
        await withTimeout(uploadToStorage(session.access_token, path, blob), 30000, "Загрузка в облако");
        const row = await withTimeout(
          insertPhotoRow(session.access_token, {
            uploaded_by: item.uploadedBy,
            owner_id: item.ownerId,
            file_path: path,
            taken_at: item.takenAt,
            lat: item.lat,
            lng: item.lng,
          }),
          15000,
          "Сохранение записи"
        );
        await idbDelete("pendingUploads", item.id);
        idbPut("photoCache", {
          id: row.id,
          dataUrl: item.dataUrl,
          filePath: path,
          name: item.name,
          takenAt: item.takenAt,
          hasExifDate: item.hasExifDate,
          lat: item.lat,
          lng: item.lng,
          uploadedBy: item.uploadedBy,
          ownerId: item.ownerId,
        });
        setPhotos((prev) =>
          prev.map((p) => (p.id === item.id ? { ...p, id: row.id, filePath: path, pending: false, remote: true } : p))
        );
      } catch {
        // stays in the queue — we'll retry on the next reconnect
      }
    }
    setSyncing(false);
    const remaining = await idbGetAll("pendingUploads");
    setPendingCount(remaining.length);
  }, [session]);

  useEffect(() => {
    if (session?.access_token) loadPhotos(session.access_token);
  }, [session, loadPhotos]);

  useEffect(() => {
    if (isOnline && session?.access_token) syncPendingUploads();
  }, [isOnline, session, syncPendingUploads]);

  const handleAuthSubmit = async () => {
    setAuthError("");
    setAuthBusy(true);
    try {
      if (authMode === "signup") {
        const data = await signUp(email.trim(), password);
        if (data.access_token) {
          setSession(data);
          saveSession(data);
        } else {
          setAuthError("Проверьте почту — нужно подтвердить регистрацию по ссылке из письма, затем войдите.");
          setAuthMode("login");
        }
      } else {
        const data = await signIn(email.trim(), password);
        setSession(data);
        saveSession(data);
      }
    } catch (e) {
      setAuthError(e.message);
    } finally {
      setAuthBusy(false);
    }
  };

  const handleRecover = async () => {
    setAuthError("");
    setAuthBusy(true);
    try {
      await recoverPassword(email.trim());
      setResetSent(true);
    } catch (e) {
      setAuthError(e.message);
    } finally {
      setAuthBusy(false);
    }
  };

  const handleFiles = useCallback(
    async (fileList) => {
      if (!session?.access_token) return;
      const files = Array.from(fileList).filter((f) => f.type.startsWith("image/") || IMAGE_EXT_RE.test(f.name));
      if (files.length === 0) return;

      let ok = 0;
      let failed = 0;
      setBatchProgress({ done: 0, total: files.length });

      for (const file of files) {
        try {
          let exif = null;
          try {
            const buffer = await file.arrayBuffer();
            exif = parseExif(buffer);
          } catch {
            exif = null;
          }

          let uploadBlob = file;
          let uploadName = file.name;
          try {
            uploadBlob = await withTimeout(resizeImage(file), 15000, "Сжатие фото");
            uploadName = file.name.replace(/\.[a-zA-Z0-9]+$/, "") + ".jpg";
          } catch {
            // couldn't decode/resize in time (e.g. HEIC, or a very heavy file) — use the original as-is
            uploadBlob = file;
            uploadName = file.name;
          }

          let localUrl = null;
          try {
            localUrl = await readAsDataURL(uploadBlob);
          } catch {
            localUrl = null;
          }

          const takenAt = exif?.takenAt || new Date(file.lastModified);
          const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

          if (!isOnline) {
            const queued = {
              id: tempId,
              dataUrl: localUrl,
              name: uploadName,
              takenAt: takenAt.toISOString(),
              uploadedAt: Date.now(),
              hasExifDate: !!exif?.takenAt,
              lat: exif?.lat ?? null,
              lng: exif?.lng ?? null,
              uploadedBy: myLabel,
              ownerId: myId,
            };
            await idbPut("pendingUploads", queued);
            setPendingCount((n) => n + 1);
            setPhotos((prev) => [
              {
                id: tempId,
                url: localUrl,
                name: uploadName,
                takenAt,
                hasExifDate: !!exif?.takenAt,
                lat: exif?.lat ?? null,
                lng: exif?.lng ?? null,
                uploadedBy: myLabel,
                ownerId: myId,
                previewFailed: !localUrl,
                pending: true,
              },
              ...prev,
            ]);
            ok++;
            continue;
          }

          const optimistic = {
            id: tempId,
            url: localUrl,
            name: uploadName,
            takenAt,
            hasExifDate: !!exif?.takenAt,
            lat: exif?.lat ?? null,
            lng: exif?.lng ?? null,
            uploadedBy: myLabel,
            ownerId: myId,
            previewFailed: !localUrl,
            uploading: true,
          };
          setPhotos((prev) => [optimistic, ...prev]);

          try {
            const safeName = uploadName.replace(/[^a-zA-Z0-9._-]/g, "_");
            const path = `${myId}/${Date.now()}-${safeName}`;
            await withTimeout(uploadToStorage(session.access_token, path, uploadBlob), 30000, "Загрузка в облако");
            const row = await withTimeout(
              insertPhotoRow(session.access_token, {
                uploaded_by: myLabel,
                owner_id: myId,
                file_path: path,
                taken_at: takenAt.toISOString(),
                lat: exif?.lat ?? null,
                lng: exif?.lng ?? null,
              }),
              15000,
              "Сохранение записи"
            );
            setPhotos((prev) =>
              prev.map((p) => (p.id === tempId ? { ...p, id: row.id, filePath: path, uploading: false, remote: true } : p))
            );
            // we already have this exact photo decoded in memory (localUrl) —
            // save it straight to the offline cache instead of downloading it
            // back from the network a second time just to cache it
            if (localUrl) {
              idbPut("photoCache", {
                id: row.id,
                dataUrl: localUrl,
                filePath: path,
                name: uploadName,
                takenAt: takenAt.toISOString(),
                hasExifDate: !!exif?.takenAt,
                lat: exif?.lat ?? null,
                lng: exif?.lng ?? null,
                uploadedBy: myLabel,
                ownerId: myId,
              });
            }
            ok++;
          } catch (e) {
            setUploadError(e.message);
            setPhotos((prev) => prev.map((p) => (p.id === tempId ? { ...p, uploading: false, failed: true } : p)));
            failed++;
          }
        } catch {
          // whatever went wrong with this one file, it must never stop the rest of the batch
          failed++;
        } finally {
          setBatchProgress((prev) => (prev ? { ...prev, done: prev.done + 1 } : null));
        }
      }

      setBatchProgress(null);
      if (files.length > 1) {
        setBatchSummary(
          failed > 0 ? `Загружено ${ok} из ${files.length} — ${failed} не удалось` : `Загружено ${ok} из ${files.length}`
        );
      }
    },
    [myId, myLabel, session, isOnline]
  );

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer.files);
  };

  // iOS Safari, when the app is installed as a home-screen PWA, sometimes
  // doesn't deliver React's synthetic onChange the first time the native
  // photo picker closes — the files silently vanish until a second try.
  // Binding directly to the DOM node's own change event is more reliable
  // there. We also reset the input's value after every use so picking the
  // exact same photos again still fires a change event next time.
  const fileInputRef = useRef(null);
  useEffect(() => {
    const input = fileInputRef.current;
    if (!input) return;
    const onChange = (e) => {
      handleFiles(e.target.files);
      e.target.value = "";
    };
    input.addEventListener("change", onChange);
    return () => input.removeEventListener("change", onChange);
  }, [handleFiles]);

  const removePhoto = async (id) => {
    const photo = photos.find((p) => p.id === id);
    if (photo?.pending) {
      setPhotos((prev) => prev.filter((p) => p.id !== id));
      await idbDelete("pendingUploads", id);
      setPendingCount((n) => Math.max(0, n - 1));
      return;
    }
    if (!isOnline) {
      setUploadError("Без интернета можно удалять только ещё не отправленные фото");
      return;
    }
    setPhotos((prev) => prev.filter((p) => p.id !== id));
    if (!photo?.remote || !session?.access_token) return;
    try {
      await deletePhotoRow(session.access_token, id);
      if (photo.filePath) deleteStorageObject(session.access_token, photo.filePath);
      idbDelete("photoCache", id);
    } catch (e) {
      setUploadError(e.message);
      setPhotos((prev) => [...prev, photo]);
    }
  };

  const markPreviewFailed = (id) =>
    setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, previewFailed: true } : p)));

  const displayName = (emailAddr) => {
    if (!emailAddr) return "";
    const name = emailAddr.split("@")[0];
    return name.charAt(0).toUpperCase() + name.slice(1);
  };

  const knownMembers = [...new Set(photos.map((p) => p.uploadedBy).filter(Boolean))].sort();

  const visiblePhotos = viewFilter === "all" ? photos : photos.filter((p) => p.uploadedBy === viewFilter);

  const groups = {};
  for (const photo of visiblePhotos) {
    const key = dayKey(photo.takenAt);
    if (!groups[key]) groups[key] = [];
    groups[key].push(photo);
  }
  const sortedKeys = Object.keys(groups).sort((a, b) => (a < b ? 1 : -1));
  const orderedPhotos = sortedKeys.flatMap((k) => groups[k]);
  const lightboxIndex = orderedPhotos.findIndex((p) => p.id === lightboxId);
  const lightboxPhoto = lightboxIndex >= 0 ? orderedPhotos[lightboxIndex] : null;
  const showLightboxAt = (i) => { if (i >= 0 && i < orderedPhotos.length) setLightboxId(orderedPhotos[i].id); };

  const [zoomed, setZoomed] = useState(false);
  useEffect(() => setZoomed(false), [lightboxId]);
  const touchStartRef = useRef(null);
  const lastTapRef = useRef(0);

  const handleLightboxTouchStart = (e) => {
    if (e.touches.length === 1) {
      touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, time: Date.now() };
    }
  };
  const handleLightboxTouchEnd = (e) => {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start) return;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    const dt = Date.now() - start.time;

    if (!zoomed && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 600) {
      showLightboxAt(lightboxIndex + (dx < 0 ? 1 : -1));
      return;
    }
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      const now = Date.now();
      if (now - lastTapRef.current < 300) {
        setZoomed((z) => !z);
        lastTapRef.current = 0;
      } else {
        lastTapRef.current = now;
      }
    }
  };

  const fontImports = (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,600;1,9..144,600&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
      * { box-sizing: border-box; }
      .dalb-scroll::-webkit-scrollbar { width: 8px; }
      .dalb-scroll::-webkit-scrollbar-thumb { background: #4a3a58; border-radius: 4px; }
      @keyframes dalbFadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes dalbPop { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }
      @keyframes dalbSpin { to { transform: rotate(360deg); } }
      .dalb-card { position: relative; break-inside: avoid; margin-bottom: 12px; border-radius: 12px; overflow: hidden; background: #251c2e; border: 1px solid #3d2f49; cursor: pointer; transition: transform 0.2s ease, box-shadow 0.2s ease; }
      .dalb-card:hover { transform: rotate(-0.6deg) scale(1.025); box-shadow: 0 10px 24px rgba(139,92,246,0.25); z-index: 2; }
      .dalb-card img { width: 100%; display: block; }
      .dalb-remove { position: absolute; top: 6px; right: 6px; width: 22px; height: 22px; border-radius: 50%; border: none; background: rgba(20,14,26,0.8); color: #f3ecf5; display: flex; align-items: center; justify-content: center; cursor: pointer; opacity: 0; transition: opacity 0.15s ease; }
      .dalb-card:hover .dalb-remove { opacity: 1; }
      .dalb-masonry { column-count: 4; column-gap: 12px; }
      @media (max-width: 900px) { .dalb-masonry { column-count: 3; } .dalb-root { padding: 20px 18px 32px !important; } }
      @media (max-width: 600px) { .dalb-masonry { column-count: 2; } }
      .dalb-pill { transition: all 0.15s ease; }
      .dalb-pill:hover { transform: translateY(-1px); }
      .dalb-addbtn { border: 1.5px dashed #4a3a58; background: transparent; color: #a698b0; }
      .dalb-addbtn:hover { border-color: #c084fc; color: #e9d5ff; }
      .dalb-lightbox-nav { transition: background 0.15s ease; }
      .dalb-lightbox-nav:hover { background: rgba(255,255,255,0.12); }
      .dalb-spin { animation: dalbSpin 0.8s linear infinite; }
      .dalb-input { background: #251c2e; border: 1px solid #3d2f49; color: #f3ecf5; border-radius: 10px; padding: 10px 14px; font-size: 14px; font-family: 'Inter', sans-serif; outline: none; }
      .dalb-input:focus { border-color: #c084fc; }
      .dalb-btn { background: linear-gradient(135deg, #ff9ecb, #c9a4fb); color: #1a1420; border: none; border-radius: 10px; padding: 10px 18px; font-size: 14px; font-weight: 700; cursor: pointer; }
      .dalb-btn:disabled { opacity: 0.5; cursor: default; }
    `}</style>
  );

  if (restoringSession) {
    return (
      <div style={styles.authRoot}>
        {fontImports}
        <RefreshCw size={20} color="#c9a4fb" className="dalb-spin" />
      </div>
    );
  }

  if (!session) {
    return (
      <div style={styles.authRoot}>
        {fontImports}
        <div style={styles.bgBlobPink} />
        <div style={styles.bgBlobViolet} />
        <div style={styles.authCard}>
          <div style={styles.logoRow}>
            <div style={styles.logoMark}><Sparkles size={16} color="#1a1420" strokeWidth={2.5} /></div>
            <h1 style={styles.title}>D-Album</h1>
          </div>
          <p style={{ color: "#a698b0", fontSize: 13.5, margin: "4px 0 4px" }}>
            Семейный альбом. {authMode === "signup" ? "Создайте аккаунт." : "Войдите по почте и паролю."}
          </p>

          {resetSent ? (
            <p style={{ color: "#c9bdd2", fontSize: 13 }}>
              Письмо для сброса пароля отправлено на {email}. Проверьте почту.
            </p>
          ) : (
            <>
              <input
                className="dalb-input"
                type="email"
                placeholder="ваша почта"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <input
                className="dalb-input"
                type="password"
                placeholder="пароль"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && email && password && handleAuthSubmit()}
              />
              <button className="dalb-btn" disabled={!email || !password || authBusy} onClick={handleAuthSubmit}>
                {authBusy ? "Секунду..." : authMode === "signup" ? "Зарегистрироваться" : "Войти"}
              </button>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
                <span
                  style={{ color: "#c9a4fb", cursor: "pointer" }}
                  onClick={() => { setAuthMode(authMode === "signup" ? "login" : "signup"); setAuthError(""); }}
                >
                  {authMode === "signup" ? "У меня уже есть аккаунт" : "Первый раз — создать аккаунт"}
                </span>
                {authMode === "login" && (
                  <span style={{ color: "#a698b0", cursor: "pointer" }} onClick={() => email && handleRecover()}>
                    Забыли пароль?
                  </span>
                )}
              </div>
            </>
          )}
          {authError && <p style={{ color: "#ff9ecb", fontSize: 13 }}>{authError}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="dalb-root" style={styles.root}>
      {fontImports}
      <div style={styles.bgBlobPink} />
      <div style={styles.bgBlobViolet} />

      <header style={styles.header}>
        <div style={styles.logoRow}>
          <div style={styles.logoMark}><Sparkles size={16} color="#1a1420" strokeWidth={2.5} /></div>
          <h1 style={styles.title}>D-Album</h1>
        </div>
        <div style={styles.memberPicker}>
          <span
            style={{
              ...styles.memberPill,
              borderColor: isOnline ? "#3d2f49" : "#ff6fb5",
              color: isOnline ? "#8fe0a8" : "#ff9ecb",
              cursor: "default",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            {isOnline ? (syncing ? "Синхронизация..." : "Онлайн") : <><WifiOff size={12} strokeWidth={2} /> Офлайн</>}
            {pendingCount > 0 && (
              <span style={styles.pendingBadge}>{pendingCount}</span>
            )}
          </span>
          <span style={{ ...styles.memberPill, borderColor: colorForName(myLabel), color: "#c9bdd2", cursor: "default" }}>
            Вы: {myLabel}
          </span>
          <button
            className="dalb-pill"
            onClick={() => loadPhotos(session.access_token)}
            style={{ ...styles.iconBtn }}
            title="Обновить"
          >
            <RefreshCw size={14} className={loadingPhotos ? "dalb-spin" : ""} />
          </button>
          <button className="dalb-pill" onClick={() => { setSession(null); clearStoredSession(); }} style={styles.iconBtn} title="Выйти">
            <LogOut size={14} />
          </button>
        </div>
      </header>

      <label
        className="dalb-drop"
        style={{ ...styles.dropzone, borderColor: dragOver ? "#c084fc" : "#3d2f49", background: dragOver ? "rgba(192,132,252,0.08)" : "#251c2e" }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.heic,.heif"
          multiple
          onClick={(e) => { e.target.value = ""; }}
          style={{ position: "absolute", width: 1, height: 1, opacity: 0 }}
        />
        <div style={styles.uploadIcon}><Upload size={18} color="#1a1420" strokeWidth={2} /></div>
        <div>
          <div style={styles.dropTitle}>Перетащите фото сюда или нажмите, чтобы выбрать</div>
          <div style={styles.dropSub}>
            {isOnline
              ? "Загружается в общее облако — увидят все члены семьи"
              : "Нет связи — фото сохранится на телефоне и отправится само, когда появится интернет"}
          </div>
        </div>
      </label>

      {batchProgress && (
        <div style={styles.progressBanner}>
          Загружаем {batchProgress.done} из {batchProgress.total}...
          <div style={styles.progressTrack}>
            <div style={{ ...styles.progressFill, width: `${(batchProgress.done / batchProgress.total) * 100}%` }} />
          </div>
        </div>
      )}

      {!batchProgress && batchSummary && (
        <div style={styles.summaryBanner} onClick={() => setBatchSummary("")}>
          {batchSummary} (нажмите, чтобы скрыть)
        </div>
      )}

      {uploadError && (
        <div style={styles.errorBanner} onClick={() => setUploadError("")}>{uploadError} (нажмите, чтобы скрыть)</div>
      )}

      {knownMembers.length > 1 && (
        <div style={styles.filterRow}>
          <button
            className="dalb-pill"
            onClick={() => setViewFilter("all")}
            style={{
              ...styles.memberPill,
              borderColor: viewFilter === "all" ? "#c084fc" : "#3d2f49",
              color: viewFilter === "all" ? "#1a1420" : "#c9bdd2",
              background: viewFilter === "all" ? "#c084fc" : "transparent",
              fontWeight: viewFilter === "all" ? 700 : 500,
            }}
          >
            Общий альбом
          </button>
          {knownMembers.map((m) => (
            <button
              key={m}
              className="dalb-pill"
              onClick={() => setViewFilter(m)}
              style={{
                ...styles.memberPill,
                borderColor: viewFilter === m ? colorForName(m) : "#3d2f49",
                color: viewFilter === m ? "#1a1420" : "#c9bdd2",
                background: viewFilter === m ? colorForName(m) : "transparent",
                fontWeight: viewFilter === m ? 700 : 500,
              }}
            >
              {m === myLabel ? "Мои фото" : displayName(m)}
            </button>
          ))}
        </div>
      )}

      <div className="dalb-scroll" style={styles.body}>
        {photos.length === 0 ? (
          <div style={styles.empty}>
            <ImageIcon size={28} color="#4a3a58" strokeWidth={1.5} />
            <div style={styles.emptyTitle}>{loadingPhotos ? "Загружаем альбом..." : "Пока пусто"}</div>
            <div style={styles.emptySub}>{loadingPhotos ? "" : "Загрузите первое фото — оно откроет альбом"}</div>
          </div>
        ) : (
          sortedKeys.map((key) => {
            const dayPhotos = groups[key];
            const withLocation = dayPhotos.find((p) => p.lat != null);
            const isCollapsed = collapsedDays.has(key);
            return (
              <section key={key} style={{ animation: "dalbFadeIn 0.4s ease" }}>
                <div
                  style={{ ...styles.dayHeader, cursor: "pointer" }}
                  onClick={() =>
                    setCollapsedDays((prev) => {
                      const next = new Set(prev);
                      next.has(key) ? next.delete(key) : next.add(key);
                      return next;
                    })
                  }
                >
                  <ChevronDown
                    size={15}
                    strokeWidth={2}
                    style={{ color: "#a698b0", transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)", transition: "transform 0.15s ease" }}
                  />
                  <span style={styles.dayHeaderDate}>{formatDateHeader(dayPhotos[0].takenAt)}</span>
                  <span style={{ fontSize: 11, color: "#6b5c78" }}>{dayPhotos.length}</span>
                  {withLocation && (
                    <span style={styles.dayHeaderPlace}><MapPin size={12} strokeWidth={2} />{formatCoords(withLocation.lat, withLocation.lng)}</span>
                  )}
                  {!dayPhotos[0].hasExifDate && <span style={styles.noExifTag}>по дате загрузки</span>}
                </div>
                {!isCollapsed && (
                <div className="dalb-masonry">
                  {dayPhotos.map((photo) => {
                    const isMine = photo.ownerId === myId;
                    return (
                      <div key={photo.id} className="dalb-card" onClick={() => setLightboxId(photo.id)} style={{ opacity: photo.uploading ? 0.6 : 1 }}>
                        {photo.previewFailed || !photo.url ? (
                          <FallbackTile name={photo.name} />
                        ) : (
                          <img src={photo.url} alt={photo.name} onError={() => markPreviewFailed(photo.id)} />
                        )}
                        {isMine && (
                          <button className="dalb-remove" onClick={(e) => { e.stopPropagation(); removePhoto(photo.id); }} aria-label="Удалить фото">
                            <X size={13} strokeWidth={2.5} />
                          </button>
                        )}
                        {photo.pending && (
                          <div style={styles.pendingChip} title="Офлайн — отправится, когда будет интернет">
                            <CloudOff size={11} strokeWidth={2} /> ждёт отправки
                          </div>
                        )}
                        <div style={{ ...styles.avatarChip, background: colorForName(photo.uploadedBy || "") }} title={photo.uploadedBy}>
                          {displayName(photo.uploadedBy)}
                        </div>
                      </div>
                    );
                  })}
                </div>
                )}
              </section>
            );
          })
        )}
      </div>

      {lightboxPhoto && (
        <div style={styles.lightboxOverlay} onClick={(e) => { if (e.target === e.currentTarget) setLightboxId(null); }}>
          <button className="dalb-lightbox-nav" onClick={() => setLightboxId(null)} style={{ ...styles.lightboxBtn, top: 16, right: 16 }} aria-label="Закрыть"><X size={20} strokeWidth={2} /></button>
          {lightboxIndex > 0 && (
            <button className="dalb-lightbox-nav" onClick={() => showLightboxAt(lightboxIndex - 1)} style={{ ...styles.lightboxBtn, left: 16, top: "50%", transform: "translateY(-50%)" }} aria-label="Предыдущее фото"><ChevronLeft size={22} strokeWidth={2} /></button>
          )}
          {lightboxIndex < orderedPhotos.length - 1 && (
            <button className="dalb-lightbox-nav" onClick={() => showLightboxAt(lightboxIndex + 1)} style={{ ...styles.lightboxBtn, right: 16, top: "50%", transform: "translateY(-50%)" }} aria-label="Следующее фото"><ChevronRight size={22} strokeWidth={2} /></button>
          )}
          <div style={styles.lightboxContent}>
            {lightboxPhoto.previewFailed || !lightboxPhoto.url ? (
              <div style={{ width: 320 }}><FallbackTile name={lightboxPhoto.name} big /></div>
            ) : (
              <div style={{ overflow: "hidden", maxWidth: "100%", maxHeight: "72vh", borderRadius: 12 }}>
                <img
                  src={lightboxPhoto.url}
                  alt={lightboxPhoto.name}
                  style={{ ...styles.lightboxImg, transform: zoomed ? "scale(2.2)" : "scale(1)", transition: "transform 0.2s ease", touchAction: "none" }}
                  onError={() => markPreviewFailed(lightboxPhoto.id)}
                  onTouchStart={handleLightboxTouchStart}
                  onTouchEnd={handleLightboxTouchEnd}
                />
              </div>
            )}
            <div style={styles.lightboxMeta}>
              <span style={styles.lightboxDate}>{formatDateFull(lightboxPhoto.takenAt)}</span>
              {lightboxPhoto.lat != null && (
                <span style={styles.dayHeaderPlace}><MapPin size={12} strokeWidth={2} />{formatCoords(lightboxPhoto.lat, lightboxPhoto.lng)}</span>
              )}
              <span style={styles.lightboxUploader}>
                <span style={{ ...styles.avatarDotInline, background: colorForName(lightboxPhoto.uploadedBy || "") }} />
                {lightboxPhoto.uploadedBy === myLabel ? "Вы" : displayName(lightboxPhoto.uploadedBy)}
              </span>
              <span style={{ fontSize: 10.5, color: "#6b5c78" }}>· смахните для след. · 2 тапа — приблизить</span>
              {lightboxPhoto.ownerId === myId && (
                <button
                  className="dalb-pill"
                  onClick={() => { removePhoto(lightboxPhoto.id); setLightboxId(null); }}
                  style={{ ...styles.memberPill, borderColor: "#ff6fb5", color: "#ff9ecb", cursor: "pointer" }}
                >
                  Удалить
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  root: { position: "relative", minHeight: "100%", background: "#1a1420", color: "#f3ecf5", fontFamily: "'Inter', sans-serif", padding: "28px 32px 40px", display: "flex", flexDirection: "column", gap: 20, overflow: "hidden" },
  authRoot: { position: "relative", minHeight: "100%", background: "#1a1420", color: "#f3ecf5", fontFamily: "'Inter', sans-serif", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, overflow: "hidden" },
  authCard: { position: "relative", zIndex: 1, display: "flex", flexDirection: "column", gap: 12, background: "#251c2e", border: "1px solid #3d2f49", borderRadius: 18, padding: 28, width: 320 },
  bgBlobPink: { position: "absolute", top: -120, right: -80, width: 340, height: 340, borderRadius: "50%", background: "radial-gradient(circle, rgba(255,111,181,0.16), transparent 70%)", pointerEvents: "none" },
  bgBlobViolet: { position: "absolute", bottom: -140, left: -100, width: 380, height: 380, borderRadius: "50%", background: "radial-gradient(circle, rgba(139,92,246,0.14), transparent 70%)", pointerEvents: "none" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 16, position: "relative", zIndex: 1 },
  logoRow: { display: "flex", alignItems: "center", gap: 10 },
  logoMark: { width: 30, height: 30, borderRadius: 9, background: "linear-gradient(135deg, #ff6fb5, #a78bfa)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  title: { fontFamily: "'Fraunces', serif", fontStyle: "italic", fontWeight: 600, fontSize: 30, margin: 0, letterSpacing: "-0.01em", background: "linear-gradient(90deg, #ff9ecb, #c9a4fb)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" },
  memberPicker: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  memberLabel: { fontSize: 13, color: "#a698b0" },
  memberPills: { display: "flex", gap: 6, flexWrap: "wrap" },
  memberPill: { padding: "6px 14px", borderRadius: 999, border: "1px solid", fontSize: 13, fontFamily: "'Inter', sans-serif", cursor: "pointer" },
  iconBtn: { width: 30, height: 30, padding: 0, borderRadius: "50%", border: "1px solid #3d2f49", background: "transparent", color: "#c9bdd2", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" },
  memberInput: { padding: "6px 14px", borderRadius: 999, border: "1px solid #c084fc", fontSize: 13, fontFamily: "'Inter', sans-serif", background: "#251c2e", color: "#f3ecf5", width: 100, outline: "none" },
  dropzone: { position: "relative", zIndex: 1, display: "flex", alignItems: "center", gap: 14, padding: "18px 22px", borderRadius: 16, border: "1.5px dashed", cursor: "pointer", transition: "all 0.15s ease" },
  uploadIcon: { width: 34, height: 34, borderRadius: 10, background: "linear-gradient(135deg, #ff9ecb, #c9a4fb)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  dropTitle: { fontSize: 14, fontWeight: 500, color: "#f3ecf5" },
  dropSub: { fontSize: 12.5, color: "#a698b0", marginTop: 2 },
  errorBanner: { position: "relative", zIndex: 1, background: "rgba(255,111,181,0.12)", border: "1px solid rgba(255,111,181,0.3)", color: "#ff9ecb", padding: "8px 14px", borderRadius: 10, fontSize: 12.5, cursor: "pointer" },
  progressBanner: { position: "relative", zIndex: 1, background: "#251c2e", border: "1px solid #3d2f49", color: "#c9bdd2", padding: "10px 14px", borderRadius: 10, fontSize: 12.5, display: "flex", flexDirection: "column", gap: 6 },
  progressTrack: { height: 4, borderRadius: 999, background: "#3d2f49", overflow: "hidden" },
  progressFill: { height: "100%", background: "linear-gradient(90deg, #ff9ecb, #c9a4fb)", transition: "width 0.2s ease" },
  summaryBanner: { position: "relative", zIndex: 1, background: "rgba(94,234,212,0.1)", border: "1px solid rgba(94,234,212,0.3)", color: "#8fe0c4", padding: "8px 14px", borderRadius: 10, fontSize: 12.5, cursor: "pointer" },
  body: { flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 28, position: "relative", zIndex: 1 },
  empty: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: "70px 0", color: "#6b5c78" },
  emptyTitle: { fontFamily: "'Fraunces', serif", fontSize: 18, color: "#a698b0" },
  emptySub: { fontSize: 13, color: "#6b5c78" },
  dayHeader: { display: "flex", alignItems: "center", gap: 12, borderBottom: "1px solid #3d2f49", paddingBottom: 8, marginBottom: 12, flexWrap: "wrap" },
  dayHeaderDate: { fontFamily: "'Fraunces', serif", fontSize: 17, fontWeight: 600, letterSpacing: "0.01em" },
  dayHeaderPlace: { display: "flex", alignItems: "center", gap: 4, fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, color: "#e9b8ff", background: "rgba(192,132,252,0.12)", padding: "3px 9px", borderRadius: 999 },
  noExifTag: { fontSize: 11, color: "#6b5c78", fontFamily: "'JetBrains Mono', monospace", marginLeft: "auto" },
  filterRow: { position: "relative", zIndex: 1, display: "flex", gap: 6, flexWrap: "wrap" },
  avatarDot: { position: "absolute", bottom: 6, left: 6, width: 10, height: 10, borderRadius: "50%", border: "1.5px solid rgba(26,20,32,0.85)" },
  avatarChip: { position: "absolute", bottom: 6, left: 6, fontSize: 10, fontWeight: 700, color: "#1a1420", padding: "2px 8px", borderRadius: 999, maxWidth: "70%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  avatarDotInline: { display: "inline-block", width: 8, height: 8, borderRadius: "50%", marginRight: 6 },
  pendingBadge: { background: "#ff6fb5", color: "#1a1420", fontSize: 10, fontWeight: 700, borderRadius: 999, padding: "1px 6px", lineHeight: 1.4 },
  pendingChip: { position: "absolute", top: 6, left: 6, display: "flex", alignItems: "center", gap: 4, fontSize: 9.5, fontFamily: "'JetBrains Mono', monospace", color: "#1a1420", background: "rgba(255,158,203,0.92)", padding: "2px 7px", borderRadius: 999 },
  fallback: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 14, background: "linear-gradient(160deg, #2f2438, #251c2e)" },
  fallbackIcon: { width: 40, height: 40, borderRadius: 10, background: "linear-gradient(135deg, #ff9ecb, #c9a4fb)", display: "flex", alignItems: "center", justifyContent: "center" },
  fallbackName: { color: "#c9bdd2", textAlign: "center", wordBreak: "break-word", lineHeight: 1.3 },
  fallbackBadge: { fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: "0.06em", color: "#e9b8ff", background: "rgba(192,132,252,0.14)", padding: "2px 8px", borderRadius: 999 },
  lightboxOverlay: { position: "fixed", inset: 0, background: "rgba(12,8,16,0.92)", backdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, animation: "dalbPop 0.18s ease" },
  lightboxBtn: { position: "absolute", width: 38, height: 38, borderRadius: "50%", border: "none", background: "rgba(255,255,255,0.06)", color: "#f3ecf5", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" },
  lightboxContent: { display: "flex", flexDirection: "column", alignItems: "center", gap: 14, maxWidth: "88%", maxHeight: "88%" },
  lightboxImg: { maxWidth: "100%", maxHeight: "72vh", borderRadius: 12, boxShadow: "0 20px 60px rgba(0,0,0,0.5)" },
  lightboxMeta: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", justifyContent: "center" },
  lightboxDate: { fontFamily: "'Fraunces', serif", fontSize: 15, color: "#f3ecf5" },
  lightboxUploader: { display: "flex", alignItems: "center", fontSize: 13, color: "#c9bdd2" },
};
