import * as store from './store.js';
import { findCards, fetchPrice, normalizeNumber, OfflineError } from './api.js';
import { loadImage, toCanvas, cropCell, freeCanvas, readCard, getOcrWorker, parseNumberText } from './scanner.js';
import * as scanState from './scan-state.js';

const $ = sel => document.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
};

const RARITY_DE = {
  'Common': 'Häufig',
  'Uncommon': 'Nicht so häufig',
  'Rare': 'Selten',
  'Rare Holo': 'Selten (Holo)',
  'Promo': 'Promo',
};
const rarityDe = r => RARITY_DE[r] || r || '–';
const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const usd = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'USD' });
const dateDe = s => (s ? new Date(s.replace(/\//g, '-')).toLocaleDateString('de-DE') : '');

// ---------- Allgemeines ----------

let toastTimer;
function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function errorText(err) {
  if (err instanceof OfflineError) return 'Keine Internetverbindung. Bitte WLAN oder mobile Daten einschalten.';
  return err?.message || 'Da ist etwas schiefgegangen.';
}

function updateOnline() {
  $('#offlineBanner').hidden = navigator.onLine;
}
addEventListener('online', updateOnline);
addEventListener('offline', updateOnline);

function showView(name, { keepScan = false } = {}) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${name}`;
  for (const b of document.querySelectorAll('.bottombar button')) b.classList.toggle('active', b.dataset.view === name);
  if (name === 'collection') renderCollection();
  if (name === 'scan' && !keepScan && !scan.source && !scan.items.length) resetScan();
  scrollTo(0, 0);
}

function renderProfiles() {
  const nav = $('#profileTabs');
  nav.replaceChildren(...store.PROFILES.map(p => el('button', {
    class: p.id === store.getActiveProfile().id ? 'active' : '',
    onclick: () => { store.setActiveProfile(p.id); renderProfiles(); renderCollection(); toast(`Sammlung von ${p.name}`); },
  }, p.name)));
}

// Eigene Rückfrage statt confirm(): große Knöpfe, auf Deutsch, kindgerecht.
// buttons: [{ label, value, primary?, danger? }] -> Promise mit value (oder null bei Abbruch)
function ask(title, text, buttons) {
  const dialog = $('#askDialog');
  return new Promise(resolve => {
    const done = value => { dialog.close(); resolve(value); };
    dialog.onclose = () => resolve(null);
    $('#askDialogBody').replaceChildren(
      el('h2', {}, title),
      text ? el('p', {}, text) : null,
      ...buttons.map(b => el('button', {
        class: 'big-btn' + (b.danger ? ' danger' : b.primary ? ' primary' : ''),
        onclick: () => done(b.value),
      }, b.label)),
      el('button', { class: 'big-btn', onclick: () => done(null) }, 'Abbrechen'),
    );
    dialog.showModal();
  });
}

// ---------- Sammlung / Galerie ----------

function renderCollection() {
  const filter = $('#collectionFilter').value.trim().toLowerCase();
  const all = store.getCollection();
  const list = filter
    ? all.filter(e => `${e.name} ${e.setName} ${e.number} ${e.rarity}`.toLowerCase().includes(filter))
    : all;
  const cardsTotal = all.reduce((s, e) => s + e.count, 0);
  $('#collectionCount').textContent = `${cardsTotal} ${cardsTotal === 1 ? 'Karte' : 'Karten'}`;
  $('#galleryEmpty').hidden = all.length > 0;
  $('#gallery').replaceChildren(...list.map(entry => el('button', {
    class: 'tile', 'aria-label': entry.name, onclick: () => openCard(entry.id),
  },
  entry.image
    ? el('img', { src: entry.image, alt: entry.name, loading: 'lazy' })
    : el('div', { class: 'noimg' }, el('strong', {}, entry.name), entry.setName),
  entry.count > 1 ? el('span', { class: 'badge' }, `×${entry.count}`) : null)));
}

function openCard(cardId) {
  const entry = store.findInCollection(cardId);
  if (!entry) return;
  const dialog = $('#cardDialog');
  const priceArea = el('div');
  const countText = el('span', {}, String(entry.count));

  const afterChange = () => {
    renderCollection();
    const updated = store.findInCollection(entry.id);
    if (!updated) { dialog.close(); return false; }
    entry.count = updated.count;
    countText.textContent = String(updated.count);
    return true;
  };

  const changeCount = async delta => {
    if (delta < 0 && entry.count === 1) return removeCard();
    store.changeCount(entry.id, delta);
    afterChange();
  };

  // Karte entfernen (z. B. verkauft oder getauscht) – immer mit Rückfrage
  const removeCard = async () => {
    const owner = store.getActiveProfile().name;
    const buttons = entry.count > 1
      ? [
        { label: '🗑️ Eine Karte entfernen', value: 1, danger: true },
        { label: `🗑️ Alle ${entry.count} entfernen`, value: entry.count, danger: true },
      ]
      : [{ label: '🗑️ Ja, entfernen', value: 1, danger: true }];
    const text = entry.count > 1
      ? `${owner} hat diese Karte ${entry.count}-mal. Wie viele sollen raus?`
      : `Die Karte wird aus der Sammlung von ${owner} gelöscht.`;
    const n = await ask(`${entry.name} entfernen?`, text, buttons);
    if (!n) return;
    store.changeCount(entry.id, -n);
    const left = afterChange();
    toast(left ? `Eine Karte entfernt, ${entry.count} übrig` : `${entry.name} wurde entfernt`);
  };

  const priceBtn = el('button', {
    class: 'big-btn',
    onclick: async () => {
      priceBtn.disabled = true;
      priceBtn.textContent = '⏳ Preis wird geladen …';
      try {
        renderPrice(priceArea, await fetchPrice(entry.id));
        priceBtn.remove();
      } catch (err) {
        priceBtn.disabled = false;
        priceBtn.textContent = '💶 Preis anzeigen';
        toast(errorText(err));
      }
    },
  }, '💶 Preis anzeigen');

  $('#cardDialogBody').replaceChildren(
    entry.imageLarge || entry.image ? el('img', { class: 'detail-img', src: entry.imageLarge || entry.image, alt: entry.name }) : null,
    el('h2', {}, entry.name),
    el('dl', { class: 'facts' },
      el('dt', {}, 'Set'), el('dd', {}, entry.setName + (entry.setCode ? ` (${entry.setCode})` : '')),
      el('dt', {}, 'Nummer'), el('dd', {}, entry.printedTotal ? `${entry.number}/${entry.printedTotal}` : entry.number),
      el('dt', {}, 'Seltenheit'), el('dd', {}, rarityDe(entry.rarity)),
      el('dt', {}, 'Anzahl'), el('dd', {},
        el('button', { class: 'small-btn', 'aria-label': 'Eine weniger', onclick: () => changeCount(-1) }, '−'), ' ',
        countText, ' ',
        el('button', { class: 'small-btn', 'aria-label': 'Eine mehr', onclick: () => changeCount(1) }, '+'))),
    priceBtn,
    priceArea,
    el('button', { class: 'big-btn primary', onclick: () => dialog.close() }, 'Schließen'),
    el('button', { class: 'big-btn danger-outline', onclick: removeCard }, '🗑️ Aus der Sammlung entfernen'),
  );
  dialog.showModal();
}

function renderPrice(target, { cardmarket, tcgplayer }) {
  const parts = [];
  if (cardmarket) {
    parts.push(el('div', { class: 'price-box' },
      el('div', {}, 'Marktpreis (Cardmarket, Trend)'),
      el('div', { class: 'price-main' }, eur.format(cardmarket.price)),
      cardmarket.avg30 != null ? el('div', {}, `Durchschnitt 30 Tage: ${eur.format(cardmarket.avg30)}`) : null,
      el('div', { class: 'hint' }, `Stand: ${dateDe(cardmarket.updatedAt)}`),
      cardmarket.url ? el('a', { href: cardmarket.url, target: '_blank', rel: 'noopener' }, 'Bei Cardmarket ansehen') : null));
  }
  if (tcgplayer) {
    parts.push(el('div', { class: 'price-box' },
      el('div', {}, 'TCGplayer (USA)'),
      ...tcgplayer.variants.map(v => el('div', {}, `${v.variant}: ${usd.format(v.price)}`)),
      el('div', { class: 'hint' }, `Stand: ${dateDe(tcgplayer.updatedAt)}`)));
  }
  if (!parts.length) parts.push(el('p', { class: 'hint' }, 'Für diese Karte ist gerade kein Preis bekannt.'));
  target.replaceChildren(...parts);
}

// ---------- Karten scannen ----------

const scan = {
  source: null,   // Canvas mit dem Foto
  rect: null,     // markierter Bereich in Bildpixeln
  layout: store.getSetting('layout') || '3x3',
  items: [],
};

function showScanStep(id) {
  for (const s of document.querySelectorAll('#view-scan .step')) s.hidden = s.id !== id;
}

function resetScan() {
  freeCanvas(scan.source);
  scan.source = null;
  scan.items = [];
  $('#cameraInput').value = '';
  $('#fileInput').value = '';
  scanState.clearScan();
  showScanStep('scanStepPick');
}

function persistScan(step) {
  scanState.saveMeta({ step, rect: scan.rect, layout: scan.layout, items: scan.items });
}

async function onPhoto(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  let canvas;
  try {
    canvas = await loadImage(file);
  } catch {
    toast('Das Foto konnte nicht geöffnet werden.');
    return;
  }
  startWithPhoto(canvas);
}

function startWithPhoto(canvas) {
  freeCanvas(scan.source);
  scan.source = canvas;
  const { width: w, height: h } = canvas;
  scan.rect = { x: w * 0.02, y: h * 0.02, w: w * 0.96, h: h * 0.96 };
  scan.items = [];
  showScanStep('scanStepGrid');
  setLayout(scan.layout);
  scanState.savePhoto(canvas).catch(() => {});
  persistScan('grid');
  getOcrWorker().catch(() => {}); // Texterkennung schon mal im Hintergrund laden
}

// Nach einem Neuladen des Tabs: angefangenen Scan wiederherstellen
async function restoreScan() {
  const meta = scanState.loadMeta();
  if (!meta) return false;
  try {
    if (meta.step === 'results' && meta.items?.length) {
      scan.items = meta.items;
      scan.layout = meta.layout || scan.layout;
      showView('scan', { keepScan: true });
      renderResults();
      showScanStep('scanStepResults');
      return true;
    }
    const blob = await scanState.loadPhoto();
    if (!blob) return false;
    scan.source = await loadImage(blob);
    scan.rect = meta.rect;
    scan.layout = meta.layout || scan.layout;
    showView('scan', { keepScan: true });
    showScanStep('scanStepGrid');
    setLayout(scan.layout);
    toast('Dein Foto ist noch da. Weiter geht\'s!');
    return true;
  } catch {
    scanState.clearScan();
    return false;
  }
}

// ---------- Kamera direkt in der App (Ausweich-Lösung) ----------
// Standard ist die normale Kamera-App des Handys (beste Qualität, Fokus).
// Lädt Android dabei die Seite neu, kann man hierauf ausweichen.

let cameraStream = null;

async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) { $('#cameraInput').click(); return; }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 } },
    });
  } catch {
    toast('Die Kamera ist nicht freigegeben. Bitte die normale Kamera benutzen.');
    return;
  }
  const track = cameraStream.getVideoTracks()[0];
  // Autofokus einschalten, wenn das Handy es erlaubt
  const caps = track.getCapabilities?.() || {};
  if (caps.focusMode?.includes('continuous')) {
    track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
  }
  const video = $('#cameraVideo');
  video.srcObject = cameraStream;
  $('#cameraOverlay').hidden = false;
  await video.play().catch(() => {});
}

function closeCamera() {
  cameraStream?.getTracks().forEach(t => t.stop());
  cameraStream = null;
  $('#cameraVideo').srcObject = null;
  $('#cameraOverlay').hidden = true;
}

async function takePicture() {
  const video = $('#cameraVideo');
  if (!video.videoWidth) return;
  let canvas = null;
  // Richtiges Foto in voller Auflösung (mit Fokus), nicht nur ein Videobild
  const track = cameraStream?.getVideoTracks()[0];
  if (track && 'ImageCapture' in window) {
    try {
      const blob = await new ImageCapture(track).takePhoto();
      canvas = await loadImage(blob);
    } catch { /* dann eben das Videobild */ }
  }
  canvas ||= toCanvas(video, video.videoWidth, video.videoHeight);
  closeCamera();
  startWithPhoto(canvas);
}

function setLayout(layout) {
  scan.layout = layout;
  store.setSetting('layout', layout);
  for (const b of document.querySelectorAll('#layoutPicker button')) b.classList.toggle('active', b.dataset.layout === layout);
  drawCrop();
}

const layoutDims = () => scan.layout.split('x').map(Number); // [rows, cols]

// Vorschau: Foto, abgedunkelter Rand, Rasterlinien, gelbe Ecken zum Ziehen
const crop = { scale: 1, drag: null };

function drawCrop() {
  const canvas = $('#cropCanvas');
  const src = scan.source;
  if (!src) return;
  crop.scale = Math.min(1, 1200 / Math.max(src.width, src.height));
  canvas.width = Math.round(src.width * crop.scale);
  canvas.height = Math.round(src.height * crop.scale);
  const ctx = canvas.getContext('2d');
  const s = crop.scale;
  const r = { x: scan.rect.x * s, y: scan.rect.y * s, w: scan.rect.w * s, h: scan.rect.h * s };
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(0,0,0,.55)';
  ctx.beginPath();
  ctx.rect(0, 0, canvas.width, canvas.height);
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.fill('evenodd');

  const [rows, cols] = layoutDims();
  const lw = Math.max(2, canvas.width / 300);
  ctx.strokeStyle = '#ffcb05';
  ctx.lineWidth = lw;
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.setLineDash([lw * 4, lw * 3]);
  ctx.beginPath();
  for (let c = 1; c < cols; c++) { ctx.moveTo(r.x + (r.w * c) / cols, r.y); ctx.lineTo(r.x + (r.w * c) / cols, r.y + r.h); }
  for (let rr = 1; rr < rows; rr++) { ctx.moveTo(r.x, r.y + (r.h * rr) / rows); ctx.lineTo(r.x + r.w, r.y + (r.h * rr) / rows); }
  ctx.stroke();
  ctx.setLineDash([]);

  const hr = handleRadius(canvas);
  ctx.fillStyle = '#ffcb05';
  ctx.strokeStyle = '#1d2433';
  for (const [hx, hy] of corners(r)) {
    ctx.beginPath();
    ctx.arc(hx, hy, hr, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

const corners = r => [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]];
const handleRadius = canvas => canvas.width / canvas.getBoundingClientRect().width * 14;

function pointerPos(e) {
  const canvas = $('#cropCanvas');
  const b = canvas.getBoundingClientRect();
  // zurück in Bildpixel des Originalfotos
  return {
    x: ((e.clientX - b.left) / b.width) * canvas.width / crop.scale,
    y: ((e.clientY - b.top) / b.height) * canvas.height / crop.scale,
    tol: (canvas.width / b.width) * 32 / crop.scale,
  };
}

function onCropDown(e) {
  if (!scan.source) return;
  const p = pointerPos(e);
  const r = scan.rect;
  const idx = corners(r).findIndex(([cx, cy]) => Math.hypot(cx - p.x, cy - p.y) < p.tol);
  if (idx >= 0) crop.drag = { type: 'corner', idx };
  else if (p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h) crop.drag = { type: 'move', dx: p.x - r.x, dy: p.y - r.y };
  else return;
  e.currentTarget.setPointerCapture(e.pointerId);
  e.preventDefault();
}

function onCropMove(e) {
  if (!crop.drag) return;
  const p = pointerPos(e);
  const W = scan.source.width, H = scan.source.height;
  const r = scan.rect;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const min = Math.min(W, H) * 0.08;
  if (crop.drag.type === 'move') {
    r.x = clamp(p.x - crop.drag.dx, 0, W - r.w);
    r.y = clamp(p.y - crop.drag.dy, 0, H - r.h);
  } else {
    let x1 = r.x, y1 = r.y, x2 = r.x + r.w, y2 = r.y + r.h;
    const px = clamp(p.x, 0, W), py = clamp(p.y, 0, H);
    const i = crop.drag.idx;
    if (i === 0 || i === 2) x1 = Math.min(px, x2 - min); else x2 = Math.max(px, x1 + min);
    if (i === 0 || i === 1) y1 = Math.min(py, y2 - min); else y2 = Math.max(py, y1 + min);
    Object.assign(r, { x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
  }
  drawCrop();
}

function onCropUp() { crop.drag = null; }

function thumb(canvas) {
  const t = document.createElement('canvas');
  const s = 220 / canvas.width;
  t.width = 220;
  t.height = Math.round(canvas.height * s);
  t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
  return t.toDataURL('image/jpeg', 0.8);
}

async function recognize() {
  const [rows, cols] = layoutDims();
  const count = rows * cols;
  persistScan('grid');
  showScanStep('scanStepProgress');
  const bar = $('#progressBar');
  const text = $('#progressText');
  bar.style.width = '0%';
  text.textContent = 'Texterkennung wird gestartet … (beim ersten Mal dauert das etwas)';
  scan.items = [];

  try {
    await getOcrWorker();
  } catch {
    toast('Die Texterkennung konnte nicht gestartet werden. Bitte die Seite neu laden und nochmal versuchen.');
    showScanStep('scanStepGrid');
    return;
  }

  for (let i = 0; i < count; i++) {
    text.textContent = `Karte ${i + 1} von ${count} …`;
    const cell = cropCell(scan.source, scan.rect, rows, cols, i); // immer nur eine Karte im Speicher
    const item = { thumb: thumb(cell), read: {}, candidates: [], chosenId: null, include: false, error: '' };
    try {
      item.read = await readCard(cell);
    } catch {
      item.error = 'Die Karte konnte nicht gelesen werden.';
    }
    freeCanvas(cell);
    if (!item.error && (item.read.number || item.read.name)) {
      text.textContent = `Karte ${i + 1} von ${count}: suche in der Datenbank …`;
      try {
        item.candidates = await findCards(item.read);
      } catch (err) {
        item.error = errorText(err);
      }
    }
    preselect(item);
    scan.items.push(item);
    bar.style.width = `${Math.round(((i + 1) / count) * 100)}%`;
  }
  persistScan('results');
  renderResults();
  showScanStep('scanStepResults');
}

function preselect(item) {
  const c = item.candidates;
  const ocrName = (item.read.name || '').toLowerCase();
  if (c.length === 1 && item.read.number) {
    item.chosenId = c[0].id;
  } else if (c.length > 1 && item.read.number && ocrName && c[0].name.toLowerCase().startsWith(ocrName)) {
    item.chosenId = c[0].id;
  } else {
    item.chosenId = null;
  }
  // Doppelte Karten werden nicht automatisch nochmal hinzugefügt
  item.include = !!item.chosenId && !store.findInCollection(item.chosenId);
}

function chosenCard(item) {
  return item.candidates.find(c => c.id === item.chosenId) || null;
}

function renderResults() {
  const box = $('#scanResults');
  box.replaceChildren(...scan.items.map((item, i) => renderResult(item, i)));
  const n = scan.items.filter(it => it.include && it.chosenId).length;
  persistScan('results');
  const btn = $('#scanSave');
  btn.textContent = n ? `✅ ${n} ${n === 1 ? 'Karte' : 'Karten'} speichern` : 'Nichts zu speichern';
  btn.disabled = n === 0;
}

function renderResult(item, index) {
  const card = chosenCard(item);
  const dup = card ? store.findInCollection(card.id) : null;
  const numberText = item.read.number
    ? `Nr. ${item.read.number}${item.read.total ? '/' + item.read.total : ''}${item.read.setCode ? ' · ' + item.read.setCode : ''}`
    : 'Keine Nummer gelesen';

  let status;
  if (item.error) status = el('span', { class: 'status fail' }, item.error);
  else if (card && dup) status = el('span', { class: 'status dup' }, `Karte bereits vorhanden (×${dup.count})`);
  else if (card) status = el('span', { class: 'status ok' }, 'Erkannt');
  else if (item.candidates.length) status = el('span', { class: 'status choose' }, 'Bitte die richtige Karte antippen');
  else status = el('span', { class: 'status fail' }, 'Nicht erkannt');

  const actions = [];
  if (card && dup) {
    actions.push(el('button', {
      class: 'small-btn' + (item.include ? ' on' : ''),
      onclick: () => { item.include = !item.include; renderResults(); },
    }, item.include ? '✓ Wird nochmal hinzugefügt (+1)' : 'Trotzdem hinzufügen (+1)'));
  } else if (card) {
    actions.push(el('button', {
      class: 'small-btn' + (item.include ? ' on' : ''),
      onclick: () => { item.include = !item.include; renderResults(); },
    }, item.include ? '✓ Wird gespeichert' : 'Nicht speichern'));
  }
  if (!card || !item.candidates.length) actions.push(...inlineManual(item));

  const candStrip = item.candidates.length > 1 || (item.candidates.length === 1 && !card)
    ? el('div', { class: 'candidates' }, ...item.candidates.slice(0, 12).map(c => el('button', {
      class: 'cand' + (c.id === item.chosenId ? ' chosen' : ''),
      'aria-label': `${c.name}, ${c.set?.name}`,
      onclick: () => {
        item.chosenId = c.id;
        item.include = !store.findInCollection(c.id);
        renderResults();
      },
    },
    el('img', { src: c.images?.small, alt: c.name, loading: 'lazy' }),
    store.findInCollection(c.id) ? el('span', { class: 'have' }, 'schon da') : null,
    el('div', { class: 'cap' }, c.set?.name || ''))))
    : null;

  return el('div', { class: 'result' + (item.include && card ? ' selected' : '') + (!item.include ? ' skipped' : ''), 'data-ocr': item.read.rawNumber || '' },
    el('img', { class: 'crop', src: card?.images?.small || item.thumb, alt: `Karte ${index + 1}` }),
    el('div', { class: 'info' },
      el('div', { class: 'title' }, card ? card.name : `Karte ${index + 1}`),
      el('div', { class: 'meta' }, card ? `${card.set?.name} · ${card.number}/${card.set?.printedTotal} · ${rarityDe(card.rarity)}` : numberText),
      status,
      candStrip,
      el('div', { class: 'actions' }, ...actions)));
}

// Kleine Eingabe direkt im Ergebnis, falls die Erkennung nicht geklappt hat
function inlineManual(item) {
  const input = el('input', { placeholder: 'Nummer, z. B. 025/165', value: item.read.number ? `${item.read.number}${item.read.total ? '/' + item.read.total : ''}` : '' });
  const go = async () => {
    const info = parseManualNumber(input.value);
    if (!info.number && !info.name) { toast('Bitte die Kartennummer eingeben.'); return; }
    btn.disabled = true;
    try {
      item.read = { ...item.read, ...info };
      item.candidates = await findCards(item.read);
      item.error = item.candidates.length ? '' : 'Keine passende Karte gefunden';
      preselect(item);
    } catch (err) {
      item.error = errorText(err);
    }
    renderResults();
  };
  const btn = el('button', { class: 'small-btn', onclick: go }, '🔍 Suchen');
  input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  return [el('div', { class: 'inline-manual' }, input, btn)];
}

function saveScan() {
  let added = 0;
  for (const item of scan.items) {
    const card = chosenCard(item);
    if (card && item.include) { store.addCard(card); added++; }
  }
  toast(`${added} ${added === 1 ? 'Karte' : 'Karten'} in der Sammlung von ${store.getActiveProfile().name} gespeichert 🎉`);
  resetScan();
  showView('collection');
}

// ---------- Von Hand suchen ----------

// Versteht "025/165", "25", "TG05/TG30", "SWSH050" und reine Namen
function parseManualNumber(value) {
  const v = value.trim();
  if (!v) return {};
  const parsed = parseNumberText(v);
  if (parsed) return parsed;
  if (/^[A-Z]{0,4}\d{1,3}$/i.test(v)) return { number: normalizeNumber(v) };
  return { name: v };
}

async function onManualSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const info = parseManualNumber(form.number.value);
  const setCode = form.setCode.value.trim();
  const name = form.name.value.trim();
  if (setCode) info.setCode = setCode;
  if (name) info.name = name;
  const out = $('#manualResults');
  if (!info.number && !info.name) { toast('Bitte eine Nummer oder einen Namen eingeben.'); return; }
  out.replaceChildren(el('p', { class: 'hint' }, '⏳ Suche läuft …'));
  try {
    const cards = await findCards(info);
    if (!cards.length) {
      out.replaceChildren(el('p', { class: 'hint' }, 'Keine passende Karte gefunden. Prüfe die Nummer oder probiere den englischen Namen.'));
      return;
    }
    out.replaceChildren(...cards.map(c => {
      const have = store.findInCollection(c.id);
      return el('button', {
        class: 'cand',
        onclick: () => {
          const existing = store.findInCollection(c.id);
          if (existing && !confirm(`Karte bereits vorhanden (×${existing.count}). Noch eine hinzufügen?`)) return;
          store.addCard(c);
          toast(`${c.name} gespeichert 🎉`);
          onManualSubmit(e); // Liste aktualisieren ("schon da")
        },
      },
      el('img', { src: c.images?.small, alt: c.name, loading: 'lazy' }),
      have ? el('span', { class: 'have' }, `schon da ×${have.count}`) : null,
      el('div', { class: 'cap' }, `${c.name} · ${c.set?.name} · ${c.number}/${c.set?.printedTotal}`));
    }));
  } catch (err) {
    out.replaceChildren(el('p', { class: 'hint' }, errorText(err)));
  }
}

// ---------- Einstellungen ----------

function openSettings() {
  $('#apiKeyInput').value = store.getSetting('apiKey') || '';
  $('#settingsDialog').showModal();
}

function closeSettings() {
  store.setSetting('apiKey', $('#apiKeyInput').value.trim());
  $('#settingsDialog').close();
}

function exportData() {
  const blob = new Blob([store.exportBackup()], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `kartensammlung-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
}

async function importData(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    if (!confirm('Die aktuelle Sammlung wird durch die Sicherung ersetzt. Fortfahren?')) return;
    store.importBackup(await file.text());
    renderCollection();
    toast('Sicherung geladen');
  } catch (err) {
    toast(err.message || 'Sicherung konnte nicht geladen werden.');
  } finally {
    e.target.value = '';
  }
}

// ---------- Start ----------

function init() {
  for (const icon of document.querySelectorAll('.lp-icon')) {
    const n = Number(getComputedStyle(icon).getPropertyValue('--n'));
    icon.replaceChildren(...Array.from({ length: n * n }, () => el('i')));
  }
  renderProfiles();
  updateOnline();

  for (const b of document.querySelectorAll('.bottombar button')) b.addEventListener('click', () => showView(b.dataset.view));
  $('#collectionFilter').addEventListener('input', renderCollection);

  $('#cameraBtn').addEventListener('click', openCamera);
  $('#cameraShutter').addEventListener('click', takePicture);
  $('#cameraClose').addEventListener('click', closeCamera);
  $('#cameraInput').addEventListener('change', onPhoto);
  $('#fileInput').addEventListener('change', onPhoto);
  $('#manualFromScan').addEventListener('click', () => showView('manual'));
  for (const b of document.querySelectorAll('#layoutPicker button')) b.addEventListener('click', () => setLayout(b.dataset.layout));
  const cropCanvas = $('#cropCanvas');
  cropCanvas.addEventListener('pointerdown', onCropDown);
  cropCanvas.addEventListener('pointermove', onCropMove);
  cropCanvas.addEventListener('pointerup', onCropUp);
  cropCanvas.addEventListener('pointercancel', onCropUp);
  $('#scanRetake').addEventListener('click', resetScan);
  $('#scanRecognize').addEventListener('click', recognize);
  $('#scanCancel').addEventListener('click', resetScan);
  $('#scanSave').addEventListener('click', saveScan);

  $('#manualForm').addEventListener('submit', onManualSubmit);

  $('#settingsBtn').addEventListener('click', openSettings);
  $('#settingsClose').addEventListener('click', closeSettings);
  $('#exportBtn').addEventListener('click', exportData);
  $('#importInput').addEventListener('change', importData);

  showView('collection');
  restoreScan();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
