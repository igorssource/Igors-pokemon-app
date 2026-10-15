// Baut die kleine Kartenliste data/cards.json für die Suche auf dem Handy.
// Quelle: die offenen Daten der Pokémon TCG API (github.com/PokemonTCG/pokemon-tcg-data).
// Läuft automatisch einmal pro Woche beim Veröffentlichen (.github/workflows/pages.yml).
// Aufruf: node scripts/build-cards.mjs

import fs from 'node:fs';

const RAW = 'https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master';
const OUT = new URL('../data/cards.json', import.meta.url);

async function get(path) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${RAW}/${path}`);
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
}

const sets = await get('sets/en.json');
sets.sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));
const out = { updated: new Date().toISOString().slice(0, 10), sets: {}, cards: [] };
let odd = 0;
for (const s of sets) {
  out.sets[s.id] = [s.name, s.ptcgoCode || '', s.printedTotal || s.total, s.releaseDate];
  const cards = await get(`cards/en/${s.id}.json`).catch(() => []);
  for (const c of cards) {
    // Bild-Adresse ist fast immer images.pokemontcg.io/<set>/<nummer>.png – nur Abweichungen speichern
    const small = c.images?.small || '';
    const std = `https://images.pokemontcg.io/${s.id}/${c.number}.png`;
    const id = c.id === `${s.id}-${c.number}` ? '' : c.id;
    if (small !== std || id) odd++;
    const row = [s.id, c.number, c.name, c.rarity || ''];
    if (small !== std || id) row.push(id, small);
    out.cards.push(row);
  }
}
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`${out.cards.length} Karten aus ${sets.length} Sets, ${odd} mit Sonderadresse, ${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB`);
