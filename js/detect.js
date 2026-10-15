// Findet Karten automatisch auf einem Foto (OpenCV): Kanten suchen, kartenförmige
// Vierecke auswählen (Seitenverhältnis 63 × 88 mm) und jede Karte gerade
// "ausschneiden" (Perspektive und Schräglage werden ausgeglichen).
// Klappt das nicht, nimmt die App das Raster mit dem gelben Rahmen.

const CARD_RATIO = 63 / 88; // Breite / Höhe einer Pokémon-Karte

let cvPromise = null;

/** Lädt OpenCV (ca. 10 MB, einmalig; danach aus dem Cache). */
export function loadCv() {
  if (!cvPromise) {
    cvPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'vendor/opencv/opencv.js';
      script.async = true;
      script.onload = () => {
        // window.cv ist ein Modul, das erst nach dem Start von WebAssembly fertig ist.
        // Achtung: es hat selbst ein "then" – deshalb nicht awaiten, sondern abfragen
        // und in { cv } verpackt zurückgeben.
        const started = Date.now();
        const check = () => {
          const cv = window.cv;
          if (cv && cv.Mat) resolve({ cv });
          else if (Date.now() - started > 60000) reject(new Error('OpenCV startet nicht'));
          else setTimeout(check, 50);
        };
        check();
      };
      script.onerror = () => reject(new Error('OpenCV konnte nicht geladen werden'));
      document.head.append(script);
    }).catch(err => { cvPromise = null; throw err; });
  }
  // Liefert { cv } – nie cv selbst (wegen dessen eigenem "then")
  return cvPromise;
}

/**
 * Sucht Karten im Foto.
 * @param {HTMLCanvasElement} source
 * @returns {Promise<Array<Array<{x:number,y:number}>>>} pro Karte 4 Eckpunkte (oben-links, oben-rechts, unten-rechts, unten-links), in Lesereihenfolge
 */
export async function detectCards(source) {
  const { cv } = await loadCv();
  const scale = Math.min(1, 1000 / Math.max(source.width, source.height));
  const small = document.createElement('canvas');
  small.width = Math.round(source.width * scale);
  small.height = Math.round(source.height * scale);
  small.getContext('2d').drawImage(source, 0, 0, small.width, small.height);

  const mats = [];
  const keep = m => (mats.push(m), m);
  try {
    const src = keep(cv.imread(small));
    const gray = keep(new cv.Mat());
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const blur = keep(new cv.Mat());
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    const edges = keep(new cv.Mat());
    cv.Canny(blur, edges, 30, 90);
    const kernel = keep(cv.Mat.ones(3, 3, cv.CV_8U));
    cv.dilate(edges, edges, kernel, new cv.Point(-1, -1), 2);

    const contours = keep(new cv.MatVector());
    const hierarchy = keep(new cv.Mat());
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const imgArea = small.width * small.height;
    const found = [];
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      if (area > imgArea * 0.008 && area < imgArea * 0.9) {
        const rr = cv.minAreaRect(c);
        const w = Math.min(rr.size.width, rr.size.height);
        const h = Math.max(rr.size.width, rr.size.height);
        const ratio = w / h;
        const fill = area / (w * h);
        if (ratio > CARD_RATIO * 0.85 && ratio < CARD_RATIO * 1.18 && fill > 0.8) {
          found.push({ rr, area: w * h });
        }
      }
      c.delete();
    }

    // Verschachtelte Treffer (Bildrahmen innerhalb der Karte, Hülle um die Karte):
    // nur das größte Viereck behalten, das die anderen enthält
    found.sort((a, b) => b.area - a.area);
    // Eine ganze Album-Seite mit 2×2 Karten hat fast dasselbe Seitenverhältnis wie eine Karte:
    // Vierecke, in denen mehrere kleinere Karten liegen, sind Seiten, keine Karten
    const isPage = f => found.filter(o => o.area < f.area * 0.6 && contains(f.rr, o.rr.center)).length >= 2;
    const singles = found.filter(f => !isPage(f));
    const cards = [];
    for (const f of singles) {
      const inside = cards.some(k => contains(k.rr, f.rr.center));
      if (!inside) cards.push(f);
    }
    if (!cards.length) return [];

    // Karten auf einem Foto sind etwa gleich groß: Ausreißer entfernen
    const areas = cards.map(c => c.area).sort((a, b) => a - b);
    const median = areas[Math.floor(areas.length / 2)];
    const good = cards.filter(c => c.area > median * 0.55 && c.area < median * 1.8);

    const quads = good.map(c => orderCorners(cv.RotatedRect.points(c.rr)).map(p => ({ x: p.x / scale, y: p.y / scale })));
    return readingOrder(quads);
  } finally {
    for (const m of mats) m.delete();
  }
}

function contains(rr, p) {
  // Punkt im gedrehten Rechteck?
  const a = (rr.angle * Math.PI) / 180;
  const dx = p.x - rr.center.x, dy = p.y - rr.center.y;
  const lx = dx * Math.cos(a) + dy * Math.sin(a);
  const ly = -dx * Math.sin(a) + dy * Math.cos(a);
  return Math.abs(lx) <= rr.size.width / 2 && Math.abs(ly) <= rr.size.height / 2;
}

// Ecken sortieren: oben-links, oben-rechts, unten-rechts, unten-links
function orderCorners(pts) {
  const bySum = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const byDiff = [...pts].sort((a, b) => (a.y - a.x) - (b.y - b.x));
  return [bySum[0], byDiff[0], bySum[3], byDiff[3]];
}

// Zeilenweise von oben nach unten, in jeder Zeile von links nach rechts
function readingOrder(quads) {
  const centers = quads.map(q => ({ q, x: (q[0].x + q[2].x) / 2, y: (q[0].y + q[2].y) / 2, h: Math.abs(q[3].y - q[0].y) }));
  centers.sort((a, b) => a.y - b.y);
  const rows = [];
  for (const c of centers) {
    const row = rows.find(r => Math.abs(r.y - c.y) < c.h * 0.5);
    if (row) row.items.push(c); else rows.push({ y: c.y, items: [c] });
  }
  return rows.flatMap(r => r.items.sort((a, b) => a.x - b.x).map(c => c.q));
}

/**
 * Schneidet eine gefundene Karte gerade aus (Perspektive entzerrt).
 * @returns {Promise<HTMLCanvasElement>} Karte im Hochformat (700–1600 px breit)
 */
export async function warpCard(source, quad) {
  const { cv } = await loadCv();
  // Erst nur den Bereich um die Karte ausschneiden (spart Speicher)
  const xs = quad.map(p => p.x), ys = quad.map(p => p.y);
  const pad = 4;
  const bx = Math.max(0, Math.floor(Math.min(...xs)) - pad), by = Math.max(0, Math.floor(Math.min(...ys)) - pad);
  const bw = Math.min(source.width, Math.ceil(Math.max(...xs)) + pad) - bx;
  const bh = Math.min(source.height, Math.ceil(Math.max(...ys)) + pad) - by;
  const part = document.createElement('canvas');
  part.width = bw; part.height = bh;
  part.getContext('2d').drawImage(source, bx, by, bw, bh, 0, 0, bw, bh);

  // In Originalauflösung ausschneiden (nicht kleiner rechnen, sonst wird die winzige Nummer unscharf)
  const side = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const natural = Math.max(side(quad[0], quad[1]), side(quad[3], quad[2]));
  const W = Math.round(Math.min(1600, Math.max(700, natural))), H = Math.round(W / CARD_RATIO);
  const mats = [];
  const keep = m => (mats.push(m), m);
  try {
    const src = keep(cv.imread(part));
    part.width = 0;
    const from = keep(cv.matFromArray(4, 1, cv.CV_32FC2, quad.flatMap(p => [p.x - bx, p.y - by])));
    const to = keep(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W, 0, W, H, 0, H]));
    const M = keep(cv.getPerspectiveTransform(from, to));
    const dst = keep(new cv.Mat());
    cv.warpPerspective(src, dst, M, new cv.Size(W, H), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
    const out = document.createElement('canvas');
    cv.imshow(out, dst);
    return out;
  } finally {
    for (const m of mats) m.delete();
  }
}

/**
 * Zweiter Weg für Album-Seiten (Karten in Hüllen, deren Ränder kaum zu sehen sind):
 * sucht lange gerade Kanten und legt das Raster rows × cols so, dass möglichst viele
 * Kartenränder darauf liegen. Ergebnis: Rahmen in Bildpixeln oder null, wenn unsicher.
 */
export function fitGrid(source, rows, cols) {
  const scale = Math.min(1, 1000 / Math.max(source.width, source.height));
  const W = Math.round(source.width * scale), H = Math.round(source.height * scale);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, W, H);
  const rgba = ctx.getImageData(0, 0, W, H).data;
  c.width = 0;
  const g = new Float32Array(W * H);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];

  // Sobel: senkrechte und waagerechte Kanten
  const ax = new Float32Array(W * H), ay = new Float32Array(W * H), mag = [];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = (g[i - W + 1] + 2 * g[i + 1] + g[i + W + 1]) - (g[i - W - 1] + 2 * g[i - 1] + g[i + W - 1]);
      const gy = (g[i + W - 1] + 2 * g[i + W] + g[i + W + 1]) - (g[i - W - 1] + 2 * g[i - W] + g[i - W + 1]);
      ax[i] = Math.abs(gx); ay[i] = Math.abs(gy);
      if ((x + y) % 7 === 0) mag.push(Math.hypot(gx, gy));
    }
  }
  mag.sort((a, b) => a - b);
  const T = mag[Math.floor(mag.length * 0.85)] || 1;
  const v = new Uint8Array(W * H), h = new Uint8Array(W * H);
  for (let i = 0; i < v.length; i++) {
    if (Math.hypot(ax[i], ay[i]) > T) {
      if (ax[i] > 1.5 * ay[i]) v[i] = 1;
      else if (ay[i] > 1.5 * ax[i]) h[i] = 1;
    }
  }
  // nur lange Linien behalten (mind. 5 % der Bildgröße am Stück, 1 px Wackeln erlaubt)
  const L = Math.round(0.05 * Math.max(W, H));
  const vl = longLines(v, W, H, L, true);
  const hl = longLines(h, W, H, L, false);

  const RATIO = CARD_RATIO;
  const range = (a, b) => { const r = []; for (let i = Math.max(1, Math.floor(a)); i <= Math.ceil(b); i++) r.push(i); return r; };
  const gaps = [];
  for (let gp = 0; gp <= 40; gp += 2) gaps.push(gp);

  // 1) Spalten grob, 2) Zeilen innerhalb der Spalten, 3) Spalten innerhalb der Zeilen
  let fx = fit(profile(vl, W, H, 0, H, 0, W, true), cols, range(0.35 * W / cols, 0.98 * W / cols), gaps);
  if (!fx) return null;
  let x1 = fx.start + cols * fx.size + (cols - 1) * fx.gap;
  let fy = fit(profile(hl, W, H, 0, H, fx.start, x1, false), rows, range(fx.size / RATIO * 0.85, fx.size / RATIO * 1.15), gaps);
  if (!fy) return null;
  const y1 = fy.start + rows * fy.size + (rows - 1) * fy.gap;
  fx = fit(profile(vl, W, H, fy.start, y1, 0, W, true), cols, range(fy.size * RATIO * 0.85, fy.size * RATIO * 1.15), gaps);
  if (!fx) return null;
  x1 = fx.start + cols * fx.size + (cols - 1) * fx.gap;
  // Zeilen nochmal mit den genaueren Spalten
  const fy2 = fit(profile(hl, W, H, 0, H, fx.start, x1, false), rows, range(fx.size / RATIO * 0.9, fx.size / RATIO * 1.1), gaps);
  if (fy2) { fy.start = fy2.start; fy.size = fy2.size; fy.gap = fy2.gap; fy.weakest = fy2.weakest; }
  const yEnd = fy.start + rows * fy.size + (rows - 1) * fy.gap;

  // Sicher genug? Jede gefundene Kante muss ein gutes Stück lang sein
  if (fx.weakest < 0.12 * (yEnd - fy.start) || fy.weakest < 0.12 * (x1 - fx.start)) return null;
  return { x: fx.start / scale, y: fy.start / scale, w: (x1 - fx.start) / scale, h: (yEnd - fy.start) / scale };
}

function longLines(m, W, H, L, vertical) {
  const res = new Uint8Array(W * H);
  const n = vertical ? H : W, lines = vertical ? W : H;
  for (let a = 0; a < lines; a++) {
    // Pixel (mit Nachbar ±1 quer zur Linie) entlang der Linie zählen, gleitendes Fenster
    const at = k => {
      const idx = vertical ? k * W + a : a * W + k;
      const step = vertical ? 1 : W;
      return m[idx] || (a > 0 && m[idx - step]) || (a < lines - 1 && m[idx + step]) ? 1 : 0;
    };
    const vals = new Uint8Array(n);
    for (let k = 0; k < n; k++) vals[k] = at(k);
    let run = 0;
    for (let k = 0; k < n; k++) {
      run += vals[k] - (k >= L ? vals[k - L] : 0);
      if (k >= L - 1 && run >= 0.85 * L) {
        for (let q = k - L + 1; q <= k; q++) res[vertical ? q * W + a : a * W + q] = 1;
      }
    }
  }
  return res;
}

// Summe der Linienpixel pro Spalte (vertical) bzw. Zeile, nur im angegebenen Bereich
function profile(m, W, H, y0, y1, x0, x1, vertical) {
  const p = new Float32Array(vertical ? W : H);
  for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
      if (m[y * W + x]) p[vertical ? x : y]++;
    }
  }
  // leicht glätten (Kante darf 1 px daneben liegen)
  const s = new Float32Array(p.length);
  for (let i = 0; i < p.length; i++) s[i] = p[i] + 0.5 * ((p[i - 1] || 0) + (p[i + 1] || 0));
  return s;
}

// Beste Lage für n Karten: Kanten bei start + k·(size+gap) und start + k·(size+gap) + size
function fit(P, n, sizes, gaps) {
  let best = null;
  const N = P.length;
  for (const size of sizes) {
    for (const gap of gaps) {
      const span = n * size + (n - 1) * gap;
      if (span >= N) continue;
      for (let start = 0; start < N - span; start++) {
        let sum = 0, min = Infinity;
        for (let k = 0; k < n; k++) {
          const a = P[start + k * (size + gap)], b = P[start + k * (size + gap) + size];
          sum += a + b;
          if (a < min) min = a;
          if (b < min) min = b;
        }
        const score = sum + min * n; // fehlende Kanten bestrafen
        if (!best || score > best.score) best = { score, start, size, gap, weakest: min };
      }
    }
  }
  return best;
}
