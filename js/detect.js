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
    const cards = [];
    for (const f of found) {
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
