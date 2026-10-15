// Optionale KI-Erkennung mit Claude (Anthropic). Nur aktiv, wenn in den Einstellungen
// ein eigener API-Schlüssel eingetragen ist. Kosten: Bruchteile eines Cents pro Karte.
// Das Kartenbild wird dafür an Anthropic geschickt; ohne Schlüssel bleibt alles auf dem Handy.
// Der Schlüssel liegt nur auf diesem Handy (wie der Pokémon-TCG-Schlüssel).

import { getSetting } from './store.js';

const MODEL = 'claude-haiku-5-5';

const SCHEMA = {
  type: 'object',
  properties: {
    readable: { type: 'boolean', description: 'false, wenn keine Pokémon-Karte zu erkennen ist' },
    number: { type: 'string', description: 'Kartennummer vor dem Schrägstrich, z. B. "045", "TG05" oder "SWSH050"; leer wenn nicht lesbar' },
    total: { type: 'string', description: 'Zahl nach dem Schrägstrich, z. B. "198"; leer wenn keine' },
    setCode: { type: 'string', description: 'Set-Kürzel neben der Nummer, z. B. "SVI", "OBF"; leer wenn keins gedruckt ist' },
    nameEnglish: { type: 'string', description: 'Englischer Name der Karte, z. B. "Gyarados ex"' },
    language: { type: 'string', description: 'Sprache der Karte, z. B. "de", "en", "zh", "ja"' },
  },
  required: ['readable', 'number', 'total', 'setCode', 'nameEnglish', 'language'],
  additionalProperties: false,
};

const PROMPT = `Auf dem Foto ist eine Pokémon-Sammelkarte (evtl. in einer Schutzhülle, etwas schief oder mit Spiegelung).
Lies unten auf der Karte die Kartennummer (z. B. 045/198) und das Set-Kürzel daneben (z. B. "SVI DE" -> SVI).
Gib außerdem den englischen Namen der Karte an. Nichts raten: was nicht lesbar ist, bleibt leer.`;

let clientPromise = null;
let clientKey = '';

export function aiEnabled() {
  return !!getSetting('aiKey');
}

function client() {
  const key = getSetting('aiKey');
  if (!clientPromise || clientKey !== key) {
    clientKey = key;
    clientPromise = import('../vendor/anthropic/anthropic-sdk.js')
      .then(({ Anthropic }) => new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 3 }));
  }
  return clientPromise;
}

export class AiKeyError extends Error {}

/**
 * Liest eine Karte mit Claude.
 * @param {HTMLCanvasElement} card
 * @returns {Promise<{number?:string,total?:string,setCode?:string,name?:string,language?:string}|null>}
 */
export async function aiReadCard(card) {
  const data = toJpegBase64(card, 640);
  const anthropic = await client();
  let response;
  try {
    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
          { type: 'text', text: PROMPT },
        ],
      }],
    });
  } catch (err) {
    if (err?.status === 401 || err?.status === 403) throw new AiKeyError('Der KI-Schlüssel wird nicht angenommen.');
    if (err?.status === 400 && /credit|balance/i.test(err?.message || '')) throw new AiKeyError('Das Guthaben für die KI ist aufgebraucht.');
    throw err;
  }
  if (response.stop_reason !== 'end_turn') return null;
  const text = response.content.find(b => b.type === 'text')?.text;
  if (!text) return null;
  const r = JSON.parse(text);
  if (!r.readable) return null;
  const clean = s => String(s || '').trim().toUpperCase().replace(/\s+/g, '');
  return {
    number: clean(r.number).replace(/^0+(?=\d)/, '') || undefined,
    total: clean(r.total).replace(/^0+(?=\d)/, '') || undefined,
    setCode: clean(r.setCode).slice(0, 4) || undefined,
    name: String(r.nameEnglish || '').trim() || undefined,
    language: r.language,
  };
}

function toJpegBase64(canvas, maxWidth) {
  const scale = Math.min(1, maxWidth / canvas.width);
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * scale);
  c.height = Math.round(canvas.height * scale);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', 0.88);
  c.width = 0;
  return url.slice(url.indexOf(',') + 1);
}
