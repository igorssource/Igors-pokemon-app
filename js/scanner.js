// Bilderkennung: Foto laden, in einzelne Karten zerschneiden (Raster),
// dann per Texterkennung (OCR, Tesseract) Kartennummer und Name lesen.

const MAX_SIDE = 3200; // größere Fotos werden verkleinert (Handys beenden sonst bei Speichermangel den Tab)

/** Lädt eine Bilddatei (oder einen Blob) in ein Canvas (Drehung aus der Kamera wird beachtet). */
export async function loadImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return toCanvas(img, img.naturalWidth, img.naturalHeight);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Zeichnet ein Bild oder Videobild verkleinert (max. MAX_SIDE) in ein neues Canvas. */
export function toCanvas(drawable, width, height) {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext('2d').drawImage(drawable, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Schneidet Karte Nr. `index` aus dem markierten Bereich (Raster rows × cols).
 * Es wird immer nur eine Karte gleichzeitig im Speicher gehalten.
 * @param {HTMLCanvasElement} source
 * @param {{x:number,y:number,w:number,h:number}} rect  Bereich in Bildpixeln
 */
export function cropCell(source, rect, rows, cols, index) {
  const cw = rect.w / cols;
  const ch = rect.h / rows;
  const r = Math.floor(index / cols), c = index % cols;
  const inset = 0.015; // kleiner Rand, damit keine Nachbarkarte hineinragt
  const grow = 0.08;   // großzügiger Ausschnitt für den zweiten Leseversuch (schiefe Fotos)
  const x0 = rect.x + c * cw, y0 = rect.y + r * ch;
  const card = cropCanvas(source, x0 + cw * inset, y0 + ch * inset, cw * (1 - 2 * inset), ch * (1 - 2 * inset));
  card.wide = () => {
    const gx = Math.max(0, x0 - cw * grow), gy = Math.max(0, y0 - ch * grow);
    const gx2 = Math.min(source.width, x0 + cw * (1 + grow)), gy2 = Math.min(source.height, y0 + ch * (1 + grow));
    return cropCanvas(source, gx, gy, gx2 - gx, gy2 - gy);
  };
  return card;
}

/** Gibt den Speicher eines Canvas sofort frei (wichtig auf Handys). */
export function freeCanvas(canvas) {
  if (canvas) { canvas.width = 0; canvas.height = 0; }
}

function cropCanvas(source, x, y, w, h, scale = 1) {
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(w * scale));
  out.height = Math.max(1, Math.round(h * scale));
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, x, y, w, h, 0, 0, out.width, out.height);
  return out;
}

/** Ausschnitt vergrößern, in Graustufen umwandeln und den Kontrast strecken. */
function prepareForOcr(card, region, { invert = false, binarize = null, targetWidth = 2200 } = {}) {
  const x = card.width * region.x, y = card.height * region.y;
  const w = card.width * region.w, h = card.height * region.h;
  const scale = Math.max(1, Math.min(5, targetWidth / w));
  const c = cropCanvas(card, x, y, w, h, scale);
  const ctx = c.getContext('2d');
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    d[i] = g;
    hist[g]++;
  }
  // 2 %- und 98 %-Grenze für die Kontrast-Streckung
  const total = d.length / 4;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > total * 0.02) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > total * 0.02) { hi = v; break; } }
  if (binarize) {
    localThreshold(d, c.width, c.height, binarize);
    sharpen(d, c.width, c.height, Math.max(2, Math.round(scale * 1.4)), 1.6);
    ctx.putImageData(img, 0, 0);
    return c;
  }
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    let g = Math.min(255, Math.max(0, ((d[i] - lo) * 255) / range));
    if (invert) g = 255 - g;
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * Schwarz-Weiß nach der Helligkeit der direkten Umgebung (nicht des ganzen Bildes).
 * So bleibt kleine graue Schrift lesbar, auch wenn daneben ein dunkler Tisch,
 * ein Schatten oder ein Glanzlicht ist. mode 'dark' = dunkle Schrift, 'light' = helle Schrift.
 * Erwartet Graustufen in d[i] (R-Kanal).
 */
function localThreshold(d, width, height, mode) {
  // Lokale Kontrast-Normalisierung: jeder Pixel wird mit Mittelwert und
  // Streuung seiner Umgebung verglichen. Ergebnis bleibt ein weiches Graubild,
  // das Tesseract selbst in Schwarz-Weiß umwandelt (das klappt bei unscharfer
  // Schrift besser als ein hartes Schwarz-Weiß von uns).
  const r = Math.max(12, Math.round(Math.min(width, height) / 18));
  const W = width + 1;
  const sum = new Float64Array(W * (height + 1));
  const sq = new Float64Array(W * (height + 1));
  for (let y = 0; y < height; y++) {
    let rs = 0, rq = 0;
    for (let x = 0; x < width; x++) {
      const g = d[(y * width + x) * 4];
      rs += g; rq += g * g;
      sum[(y + 1) * W + x + 1] = sum[y * W + x + 1] + rs;
      sq[(y + 1) * W + x + 1] = sq[y * W + x + 1] + rq;
    }
  }
  const box = (a, x0, y0, x1, y1) => a[y1 * W + x1] - a[y0 * W + x1] - a[y1 * W + x0] + a[y0 * W + x0];
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(height, y + r + 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(width, x + r + 1);
      const n = (x1 - x0) * (y1 - y0);
      const mean = box(sum, x0, y0, x1, y1) / n;
      const std = Math.sqrt(Math.max(0, box(sq, x0, y0, x1, y1) / n - mean * mean));
      const i = (y * width + x) * 4;
      let v = (d[i] - mean) / (std + 12); // ~ -3..3
      if (mode === 'light') v = -v;
      const out = Math.max(0, Math.min(255, 170 + v * 70));
      d[i] = d[i + 1] = d[i + 2] = out;
    }
  }
}

/** Unscharf maskieren: macht weiche (leicht unscharfe) Schrift kantiger. */
function sharpen(d, width, height, r, amount) {
  const src = new Float32Array(width * height);
  for (let i = 0; i < src.length; i++) src[i] = d[i * 4];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let s = 0, n = 0;
      for (let dy = -r; dy <= r; dy += r) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -r; dx <= r; dx += r) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          s += src[yy * width + xx]; n++;
        }
      }
      const v = src[y * width + x];
      const out = Math.max(0, Math.min(255, v + amount * (v - s / n)));
      const i = (y * width + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = out;
    }
  }
}

// Wo auf der Karte stehen Nummer und Name? (Anteile von Breite/Höhe)
const REGION_NUMBER = { x: 0, y: 0.84, w: 1, h: 0.16 };
const REGION_NAME = { x: 0.02, y: 0.02, w: 0.72, h: 0.12 };
const REGION_NUMBER_WIDE = { x: 0, y: 0.68, w: 1, h: 0.32 };
const REGION_ALL = { x: 0, y: 0, w: 1, h: 1 };

let workerPromise = null;

function absolute(path) {
  return new URL(path, document.baseURI).href;
}

/** Startet die Texterkennung (einmalig, lädt ca. 6 MB beim ersten Mal). */
export function getOcrWorker() {
  if (!workerPromise) {
    workerPromise = window.Tesseract.createWorker('eng', 1, {
      workerPath: absolute('vendor/tesseract/worker.min.js'),
      corePath: absolute('vendor/tesseract/core/'),
      langPath: absolute('vendor/tesseract/lang'),
      gzip: true,
    }).catch(err => { workerPromise = null; throw err; });
  }
  return workerPromise;
}

async function ocr(canvas, params) {
  const worker = await getOcrWorker();
  await worker.setParameters(params);
  try {
    const { data } = await worker.recognize(canvas);
    // Fehlersuche: in der Konsole window.__ocrDebug = [] setzen, dann landen hier alle Ausschnitte
    if (Array.isArray(window.__ocrDebug)) window.__ocrDebug.push({ img: canvas.toDataURL('image/png'), text: data.text });
    return data.text || '';
  } finally {
    freeCanvas(canvas);
  }
}

/**
 * Liest Nummer (+ Set-Kürzel) und Name von einer einzelnen Karte.
 * @returns {Promise<{number?:string,total?:string,setCode?:string,name?:string,rawNumber:string,rawName:string}>}
 */
export async function readCard(card) {
  const numberParams = {
    tessedit_pageseg_mode: '11',
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/',
  };
  // Mehrere Versuche: normal, invertiert (helle Schrift auf dunklem Grund,
  // z. B. Full-Art-Karten) und mit größerem Ausschnitt (schief fotografiert)
  let wide = null;
  const getWide = () => (wide ||= card.wide());
  const attempts = [
    () => prepareForOcr(card, REGION_NUMBER),
    () => prepareForOcr(card, REGION_NUMBER, { invert: true }),
  ];
  attempts.push(() => prepareForOcr(card, REGION_NUMBER, { binarize: 'dark' }));
  if (card.wide) {
    attempts.push(() => prepareForOcr(getWide(), REGION_NUMBER_WIDE, { binarize: 'dark' }));
    attempts.push(() => prepareForOcr(getWide(), REGION_NUMBER_WIDE, { binarize: 'light' }));
    // Letzter Versuch: ganze Fläche absuchen (Karte liegt z. B. klein in der Mitte des Fotos)
    attempts.push(() => prepareForOcr(getWide(), REGION_ALL, { binarize: 'dark', targetWidth: 2600 }));
  } else {
    // Automatisch ausgeschnittene Karte: der Ausschnitt passt genau, nur der Bereich unten etwas größer
    attempts.push(() => prepareForOcr(card, REGION_NUMBER_WIDE, { binarize: 'dark' }));
    attempts.push(() => prepareForOcr(card, REGION_NUMBER_WIDE, { binarize: 'light' }));
  }
  let rawNumber = '';
  let parsed = null;
  for (const attempt of attempts) {
    const text = await ocr(attempt(), numberParams);
    rawNumber += (rawNumber ? '\n---\n' : '') + text;
    parsed = parseNumberText(text);
    if (parsed) break;
  }
  freeCanvas(wide);
  const rawName = await ocr(prepareForOcr(card, REGION_NAME), {
    tessedit_pageseg_mode: '6',
    tessedit_char_whitelist: '',
  });
  return { ...(parsed || {}), name: parseNameText(rawName), rawNumber, rawName };
}

// ---------- Text auswerten (ohne Browser-Abhängigkeiten, daher testbar) ----------

// Buchstaben, die die Texterkennung gern mit Ziffern verwechselt
const DIGIT_FIX = { O: '0', D: '0', Q: '0', U: '0', I: '1', L: '1', S: '5', B: '8', Z: '2', G: '6' };
const DIGITISH = '[0-9ODQUILSBZG]';
const fixDigits = s => s.replace(/[ODQUILSBZG]/g, ch => DIGIT_FIX[ch]);
const LANG_CODES = 'DE|EN|IT|FR|ES|PT|JP|NL|KO|ZH';

/**
 * Sucht in OCR-Text nach einer Kartennummer wie "025/165", "TG05/TG30" oder "SWSH050".
 * @returns {{number:string,total?:string,setCode?:string}|null}
 */
export function parseNumberText(raw) {
  const text = String(raw).toUpperCase().replace(/[\\|]/g, '/');
  const lines = text.split(/\n+/);
  for (const line of lines) {
    // Set-Kürzel + Sprache direkt vor der Nummer, z. B. "MEW DE 025/165" (OCR verschluckt oft die Leerzeichen)
    const setMatch = line.match(new RegExp(`([A-Z]{3})\\s*(?:${LANG_CODES})\\s*${DIGITISH}{1,3}\\s*/`));
    const setCode = setMatch ? setMatch[1] : undefined;

    const re = /([A-Z0-9]{1,8})\s*\/\s*([A-Z0-9]{2,6})/g;
    let m;
    while ((m = re.exec(line))) {
      const result = interpretPair(m[1], m[2]);
      if (result) return setCode ? { ...result, setCode } : result;
    }

    // Schrägstrich nicht erkannt ("MEWDE004165" oder "MEW DE 004 1 165"):
    // nur wenn Set-Kürzel + Sprache davor stehen, sonst wäre es zu unsicher
    const glued = line.match(new RegExp(`([A-Z]{3})\\s*(?:${LANG_CODES})\\s*(${DIGITISH}{3})\\s*[1IL]?\\s*(${DIGITISH}{3})(?![0-9])`));
    if (glued) {
      const result = interpretPair(glued[2], glued[3]);
      if (result) return { ...result, setCode: glued[1] };
    }

    const promo = line.match(new RegExp(`\\b(SWSH|SM|XY|BW)\\s?(${DIGITISH}{2,3})\\b`));
    if (promo) return { number: promo[1] + fixDigits(promo[2]) };
  }
  return null;
}

function interpretPair(a, b) {
  // Trainer-Galerie / Galarian Gallery: TG05/TG30, GG12/GG70
  const pref = a.match(new RegExp(`(TG|GG|RC|SV)(${DIGITISH}{1,3})$`));
  if (pref && /^(TG|GG|RC|SV)/.test(b)) {
    return { number: pref[1] + fixDigits(pref[2]).padStart(2, '0') };
  }
  // Normale Nummer: die letzten bis zu 3 "Ziffern" vor dem Schrägstrich
  const left = a.match(new RegExp(`(${DIGITISH}{1,3})$`));
  const right = b.match(new RegExp(`^(${DIGITISH}{2,3})`));
  if (!left || !right) return null;
  const num = fixDigits(left[1]);
  const total = fixDigits(right[1]);
  if (!/^\d+$/.test(num) || !/^\d+$/.test(total)) return null;
  const n = parseInt(num, 10), t = parseInt(total, 10);
  if (n < 1 || t < 10 || t > 400 || n > t + 150) return null;
  return { number: String(n), total: String(t) };
}

const NAME_STOPWORDS = new Set([
  'BASIS', 'BASIC', 'PHASE', 'STAGE', 'STUFE', 'KP', 'HP', 'PV', 'PS', 'ENTWICKELT', 'EVOLVES', 'AUS', 'FROM',
  'POKEMON', 'POKÉMON', 'TRAINER', 'ITEM', 'ARTIKEL', 'UNTERSTÜTZUNG', 'SUPPORTER', 'TOOL', 'BASE', 'BASE.',
  'FASE', 'BASICO', 'BASE', 'EVOLUZIONE',
]);

/** Errät den Kartennamen aus dem oberen Kartenrand (nur als Zusatzinfo). */
export function parseNameText(raw) {
  const words = String(raw).match(/[A-Za-zÄÖÜäöüßÉé][A-Za-zÄÖÜäöüßÉé'\-.]{2,}/g) || [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i].replace(/[.\-']+$/, '');
    if (w.length < 3 || NAME_STOPWORDS.has(w.toUpperCase())) continue;
    if (!/[aeiouäöüy]/i.test(w)) continue; // "KRRT" o. ä. ist kein Name
    if (i > 0 && /^(FROM|AUS)$/i.test(words[i - 1])) continue; // "Entwickelt aus Glumanda" überspringen
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }
  return '';
}
