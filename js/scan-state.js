// Merkt sich einen laufenden Scan (Fotos, Rahmen, Ergebnisse), damit nichts
// verloren geht, wenn Android den Browser-Tab im Hintergrund neu lädt
// (z. B. während die Kamera-App offen ist oder bei knappem Speicher).
// Fotos -> IndexedDB, Rest -> sessionStorage. Beides wird nach Speichern/Abbrechen gelöscht.

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

/** Speichert ein Foto des Stapels unter seiner id (Blob bzw. Datei). */
export async function savePhoto(id, blob) {
  if (blob) await tx('readwrite', s => s.put(blob, id));
}

export async function loadPhoto(id) {
  return tx('readonly', s => s.get(id));
}

export async function deletePhoto(id) {
  try { await tx('readwrite', s => s.delete(id)); } catch { /* ignorieren */ }
}

export function saveMeta(meta) {
  try { sessionStorage.setItem(META_KEY, JSON.stringify(meta)); } catch { /* voll – egal */ }
}

export function loadMeta() {
  try { return JSON.parse(sessionStorage.getItem(META_KEY) || 'null'); } catch { return null; }
}

export async function clearScan() {
  try { sessionStorage.removeItem(META_KEY); } catch { /* ignorieren */ }
  try { await tx('readwrite', s => s.clear()); } catch { /* ignorieren */ }
}
