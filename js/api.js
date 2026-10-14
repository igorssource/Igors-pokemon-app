// Zugriff auf die Pokémon TCG API (https://pokemontcg.io).
// Gesucht wird vor allem über die Kartennummer, weil die auf deutschen,
// englischen, italienischen … Karten gleich ist. Der Name ist nur ein Zusatz.

import { getSetting } from './store.js';

const BASE = 'https://api.pokemontcg.io/v2';
const CARD_FIELDS = 'id,name,number,rarity,set,images';

export class OfflineError extends Error {
  constructor() { super('Keine Internetverbindung'); this.name = 'OfflineError'; }
}

export class ApiError extends Error {
  constructor(message) { super(message); this.name = 'ApiError'; }
}

const TIMEOUT_MS = 20000;
const RETRIES = 3;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Die API ist manchmal langsam oder antwortet mit 429 (zu viele Anfragen pro
// Minute, besonders ohne API-Schlüssel) bzw. 5xx. Solche Antworten kommen oft
// ohne CORS-Header an, dann meldet der Browser nur "Failed to fetch" – das ist
// KEIN fehlendes WLAN. Daher: mehrfach mit Pause wiederholen und nur dann
// "offline" melden, wenn das Handy wirklich keine Verbindung hat.
async function request(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers = {};
  const key = getSetting('apiKey');
  if (key) headers['X-Api-Key'] = key;

  let lastProblem = '';
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0 && lastProblem !== 'busy') await sleep(attempt * 3000);
    if (!navigator.onLine) throw new OfflineError();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal });
      if (res.ok) return await res.json();
      if (res.status === 404) throw new ApiError('Diese Karte gibt es in der Datenbank nicht.');
      if (res.status === 429) {
        // Limit pro Minute erreicht: so lange warten, wie der Server sagt (sonst 6 s)
        lastProblem = 'busy';
        const wait = Number(res.headers.get('Retry-After'));
        await sleep(Number.isFinite(wait) && wait > 0 ? Math.min(wait, 30) * 1000 : 6000);
        continue;
      }
      if (res.status >= 500) { lastProblem = 'down'; continue; }
      throw new ApiError(`Die Kartendatenbank hat die Anfrage abgelehnt (Fehler ${res.status}).`);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      lastProblem = err.name === 'AbortError' ? 'slow' : 'down';
    } finally {
      clearTimeout(timer);
    }
  }
  if (!navigator.onLine) throw new OfflineError();
  if (lastProblem === 'busy') {
    throw new ApiError(key
      ? 'Die Kartendatenbank ist gerade überlastet. Bitte gleich nochmal versuchen.'
      : 'Zu viele Anfragen auf einmal. Bitte kurz warten – mit einem kostenlosen API-Schlüssel (⚙️) passiert das seltener.');
  }
  if (lastProblem === 'slow') throw new ApiError('Die Kartendatenbank antwortet gerade sehr langsam. Bitte gleich nochmal versuchen.');
  throw new ApiError('Die Kartendatenbank ist gerade nicht erreichbar. Bitte gleich nochmal versuchen.');
}

// "025" -> "25", "TG05" bleibt "TG05"
export function normalizeNumber(num) {
  const n = String(num).trim().toUpperCase();
  return /^\d+$/.test(n) ? String(parseInt(n, 10)) : n;
}

const quote = s => `"${String(s).replace(/"/g, '')}"`;

const queryCache = new Map(); // gleiche Suche nicht zweimal schicken (spart Anfragen)

async function query(q) {
  if (queryCache.has(q)) return queryCache.get(q);
  const data = await request('/cards', { q, pageSize: 30, select: CARD_FIELDS, orderBy: '-set.releaseDate' });
  const cards = data.data || [];
  queryCache.set(q, cards);
  return cards;
}

/**
 * Sucht passende Karten. Probiert mehrere Wege nacheinander, vom genauesten
 * (Nummer + Set-Kürzel) bis zum ungenauesten (nur Name).
 * @param {{number?: string, total?: string|number, setCode?: string, name?: string}} info
 */
export async function findCards({ number, total, setCode, name }) {
  const tries = [];
  const num = number ? normalizeNumber(number) : '';
  const tot = total && /^\d+$/.test(String(total)) ? parseInt(total, 10) : null;
  if (num && setCode) tries.push(`number:${quote(num)} set.ptcgoCode:${quote(setCode.toUpperCase())}`);
  if (num && tot) tries.push(`number:${quote(num)} set.printedTotal:${tot}`);
  if (num && name) tries.push(`number:${quote(num)} name:${quote(name + '*')}`);
  if (name) tries.push(`name:${quote(name + '*')}`);
  if (num && !tot && !setCode && !name) tries.push(`number:${quote(num)}`);

  for (const q of tries) {
    const cards = await query(q);
    if (cards.length) return rankByName(cards, name);
  }
  return [];
}

// Wenn mehrere Karten passen, kommen die mit ähnlichem Namen nach vorne.
function rankByName(cards, name) {
  if (!name) return cards;
  const n = name.toLowerCase();
  const score = c => {
    const cn = c.name.toLowerCase();
    if (cn === n) return 3;
    if (cn.startsWith(n) || n.startsWith(cn)) return 2;
    if (cn.includes(n) || n.includes(cn)) return 1;
    return 0;
  };
  return [...cards].sort((a, b) => score(b) - score(a));
}

/** Holt den aktuellen Marktpreis einer Karte (nur auf Knopfdruck). */
export async function fetchPrice(cardId) {
  const data = await request(`/cards/${encodeURIComponent(cardId)}`, { select: 'id,tcgplayer,cardmarket' });
  const card = data.data || {};
  const result = { cardmarket: null, tcgplayer: null };

  const cm = card.cardmarket;
  if (cm?.prices) {
    const p = cm.prices;
    const main = p.trendPrice ?? p.averageSellPrice ?? p.avg30 ?? p.lowPrice ?? p.reverseHoloTrend;
    if (main != null) {
      result.cardmarket = { price: main, low: p.lowPrice ?? null, avg30: p.avg30 ?? null, updatedAt: cm.updatedAt, url: cm.url };
    }
  }

  const tp = card.tcgplayer;
  if (tp?.prices) {
    const variants = Object.entries(tp.prices)
      .map(([variant, p]) => ({ variant, price: p.market ?? p.mid ?? p.low }))
      .filter(v => v.price != null);
    if (variants.length) result.tcgplayer = { variants, updatedAt: tp.updatedAt, url: tp.url };
  }
  return result;
}
