// Merkt sich einen laufenden Scan (Foto, Rahmen, Ergebnisse), damit nichts
// verloren geht, wenn Android den Browser-Tab im Hintergrund neu lädt
// (z. B. während die Kamera-App offen ist oder bei knappem Speicher).
// Foto -> IndexedDB, Rest -> sessionStorage. Beides wird nach Speichern/Abbrechen gelöscht.

const DB = 'pkmn-tracker-scan';
const STORE = 'photo';
const META_KEY = 'pkmn-tracker:scan';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

export async function savePhoto(canvas) {
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));
  if (blob) await tx('readwrite', s => s.put(blob, 'current'));
}

export async function loadPhoto() {
  return tx('readonly', s => s.get('current'));
}

export function saveMeta(meta) {
  try { sessionStorage.setItem(META_KEY, JSON.stringify(meta)); } catch { /* voll – egal */ }
}

export function loadMeta() {
  try { return JSON.parse(sessionStorage.getItem(META_KEY) || 'null'); } catch { return null; }
}

export async function clearScan() {
  try { sessionStorage.removeItem(META_KEY); } catch { /* ignorieren */ }
  try { await tx('readwrite', s => s.delete('current')); } catch { /* ignorieren */ }
}
