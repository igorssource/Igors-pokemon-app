// Kartenliste auf dem Handy (data/cards.json, ca. 1 MB, wird vom Service Worker
// zwischengespeichert). Damit läuft die Suche nach Nummer sofort und ohne
// Anfragen an die Online-Datenbank. Bilder und Preise kommen weiter online.
// Die Liste wird einmal pro Woche beim Veröffentlichen neu gebaut (scripts/build-cards.mjs).

let dbPromise = null;

/** Lädt die Kartenliste (einmalig). Liefert null, wenn sie nicht geladen werden kann. */
export function loadCardsDb() {
  if (!dbPromise) {
    dbPromise = fetch('data/cards.json')
      .then(res => { if (!res.ok) throw new Error(res.status); return res.json(); })
      .then(buildIndex)
      .catch(() => { dbPromise = null; return null; });
  }
  return dbPromise;
}

const norm = n => { const s = String(n).trim().toUpperCase(); return /^\d+$/.test(s) ? String(parseInt(s, 10)) : s; };

function buildIndex(data) {
  const sets = {};
  for (const [id, [name, code, printedTotal, releaseDate]] of Object.entries(data.sets)) {
    sets[id] = { id, name, ptcgoCode: code, printedTotal, releaseDate };
  }
  const byNumber = new Map();
  const all = [];
  for (const [setId, number, name, rarity, cardId, small] of data.cards) {
    const set = sets[setId];
    const img = small || `https://images.pokemontcg.io/${setId}/${number}.png`;
    const card = {
      id: cardId || `${setId}-${number}`,
      name, number, rarity, set,
      images: { small: img, large: img.replace(/\.png$/, '_hires.png') },
    };
    all.push(card);
    const key = norm(number);
    if (!byNumber.has(key)) byNumber.set(key, []);
    byNumber.get(key).push(card);
  }
  // Neueste Sets zuerst
  for (const list of byNumber.values()) list.sort((a, b) => b.set.releaseDate.localeCompare(a.set.releaseDate));
  all.sort((a, b) => b.set.releaseDate.localeCompare(a.set.releaseDate));
  return { updated: data.updated, byNumber, all };
}

/**
 * Sucht in der lokalen Liste. Reihenfolge wie bei der Online-Suche:
 * Nummer + Set-Kürzel, Nummer + aufgedruckte Gesamtzahl, Nummer + Name, Name.
 */
export function searchLocal(db, { number, total, setCode, name }) {
  const list = number ? db.byNumber.get(norm(number)) || [] : [];
  const tot = total && /^\d+$/.test(String(total)) ? parseInt(total, 10) : null;
  const code = setCode ? setCode.toUpperCase() : '';
  const n = (name || '').toLowerCase();

  if (code) {
    const hit = list.filter(c => c.set.ptcgoCode === code && (!tot || c.set.printedTotal === tot));
    if (hit.length) return hit;
  }
  if (tot) {
    const hit = list.filter(c => c.set.printedTotal === tot);
    if (hit.length) {
      // Set-Kürzel teilweise falsch gelesen? Ähnliches Kürzel nach vorne
      return code ? [...hit].sort((a, b) => similar(b.set.ptcgoCode, code) - similar(a.set.ptcgoCode, code)) : hit;
    }
  }
  if (n.length >= 3) {
    if (list.length) {
      const hit = list.filter(c => c.name.toLowerCase().startsWith(n));
      if (hit.length) return hit;
    }
    // Nur-Name-Suche nur bei genauem Treffer (gelesene Namen sind oft Wortfetzen,
    // und deutsche Namen stehen nicht in der englischen Liste)
    const byName = db.all.filter(c => c.name.toLowerCase().split(/[\s-]/)[0] === n);
    if (byName.length) return byName.slice(0, 30);
  }
  if (list.length && !tot && !code && !n) return list.slice(0, 30);
  return [];
}

/** Gibt es eine Karte mit dieser Nummer (und ggf. dieser aufgedruckten Gesamtzahl)? */
export function existsLocal(db, { number, total }) {
  const list = db.byNumber.get(norm(number)) || [];
  const tot = total ? parseInt(total, 10) : null;
  return list.some(c => !tot || c.set.printedTotal === tot);
}

function similar(a, b) {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] === b[i]) s++;
  return s;
}
