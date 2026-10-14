// Sammlungen pro Kind. Gespeichert wird nur, welche Karten jemand besitzt
// (plus Name/Bild-Link für die Galerie). Die eigentlichen Kartendaten und
// Preise kommen immer frisch aus der Online-Datenbank.

export const PROFILES = [
  { id: 'max', name: 'Max' },
  { id: 'tim', name: 'Tim' },
];

const KEY = 'pkmn-tracker:v1';

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* leer starten */ }
  return { activeProfile: PROFILES[0].id, apiKey: '', layout: '3x3', collections: {} };
}

let state = load();

function save() {
  localStorage.setItem(KEY, JSON.stringify(state));
}

export function getActiveProfile() {
  return PROFILES.find(p => p.id === state.activeProfile) || PROFILES[0];
}

export function setActiveProfile(id) {
  state.activeProfile = id;
  save();
}

export function getSetting(name) { return state[name]; }
export function setSetting(name, value) { state[name] = value; save(); }

export function getCollection(profileId = state.activeProfile) {
  return state.collections[profileId] || [];
}

export function findInCollection(cardId, profileId = state.activeProfile) {
  return getCollection(profileId).find(e => e.id === cardId) || null;
}

// Wandelt eine Karte aus der API in einen schlanken Sammlungs-Eintrag um.
export function toEntry(card) {
  return {
    id: card.id,
    name: card.name,
    number: card.number,
    setId: card.set?.id || '',
    setName: card.set?.name || '',
    setCode: card.set?.ptcgoCode || '',
    printedTotal: card.set?.printedTotal || null,
    rarity: card.rarity || '',
    image: card.images?.small || '',
    imageLarge: card.images?.large || '',
    count: 1,
    addedAt: new Date().toISOString(),
  };
}

// Fügt eine Karte hinzu. Ist sie schon da, wird nur die Anzahl erhöht.
export function addCard(card, profileId = state.activeProfile) {
  const list = state.collections[profileId] ||= [];
  const existing = list.find(e => e.id === card.id);
  if (existing) {
    existing.count += 1;
  } else {
    list.unshift(toEntry(card));
  }
  save();
}

export function changeCount(cardId, delta, profileId = state.activeProfile) {
  const list = state.collections[profileId] || [];
  const entry = list.find(e => e.id === cardId);
  if (!entry) return;
  entry.count += delta;
  if (entry.count <= 0) list.splice(list.indexOf(entry), 1);
  save();
}

export function exportBackup() {
  return JSON.stringify({ app: 'pkmn-tracker', version: 1, exportedAt: new Date().toISOString(), collections: state.collections }, null, 2);
}

export function importBackup(text) {
  const data = JSON.parse(text);
  if (data?.app !== 'pkmn-tracker' || typeof data.collections !== 'object') {
    throw new Error('Das ist keine Sicherung dieser App.');
  }
  state.collections = data.collections;
  save();
}
