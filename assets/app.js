'use strict';

/*
 * TibiaViewer (web). Everything happens in memory, in this tab:
 * files come from <input webkitdirectory> or drag and drop, nothing is uploaded,
 * nothing is written to disk. Grouping comes only from file names.
 */

const IMG_RE = /\.(png|jpe?g|webp)$/i;
const OTHERS_KEY = '\u0000others';
const WIN_PATH = '%LOCALAPPDATA%\\Tibia\\packages\\Tibia\\screenshots';
const THUMB_WIDTH = 560;       // px; cards are at most ~330 CSS px wide
const THUMB_CONCURRENCY = 3;   // full-size decodes in flight at once
const THUMB_CACHE = 400;       // thumbnail blob URLs kept alive (LRU)

const REASON_ICONS = {
  Achievement: 'trophy',
  BestiaryEntryCompleted: 'book',
  BestiaryEntryUnlocked: 'book',
  BossDefeated: 'crown',
  DeathPvE: 'skull',
  DeathPvP: 'skull',
  GiftOfLife: 'heart',
  HighestDamageDealt: 'sword',
  HighestHealingDone: 'heal',
  Hotkey: 'eye',
  LevelUp: 'star',
  LowHealth: 'drop',
  PlayerAttacking: 'sword',
  PlayerKill: 'sword',
  PlayerKillAssist: 'sword',
  SkillUp: 'up',
  TreasureFound: 'coin',
  ValuableLoot: 'coin',
};
const DANGER = new Set(['DeathPvE', 'DeathPvP', 'LowHealth']);

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name) => `<svg class="ic" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

/* ---------- Storage (per-viewer conveniences only) ---------- */
const store = {
  get(k, fallback) { try { const v = localStorage.getItem('tibiaviewer.' + k); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; } },
  set(k, v) { try { localStorage.setItem('tibiaviewer.' + k, JSON.stringify(v)); } catch (e) {} },
};

/* ---------- Language ---------- */
const LANGS = Object.keys(window.I18N);
let L = null;
let fmt = null;

function detectLang() {
  const saved = store.get('lang', null);
  if (LANGS.includes(saved)) return saved;
  const wanted = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]).filter(Boolean);
  for (const w of wanted) {
    const exact = LANGS.find((k) => k.toLowerCase() === w.toLowerCase());
    if (exact) return exact;
    const base = w.split('-')[0].toLowerCase();
    const loose = LANGS.find((k) => k.split('-')[0].toLowerCase() === base);
    if (loose) return loose;
  }
  return 'en';
}

function setLang(code) {
  L = window.I18N[code];
  state.lang = code;
  fmt = {
    day: new Intl.DateTimeFormat(code, { day: 'numeric', month: 'long', year: 'numeric' }),
    time: new Intl.DateTimeFormat(code, { hour: 'numeric', minute: '2-digit', second: '2-digit' }),
    month: new Intl.DateTimeFormat(code, { month: 'long', year: 'numeric' }),
    num: new Intl.NumberFormat(code),
    plural: new Intl.PluralRules(code),
    collator: new Intl.Collator(code, { sensitivity: 'base', numeric: true }),
  };
  document.documentElement.lang = code;
}

const t = (key, vars) => fill(L[key] ?? window.I18N.en[key] ?? key, vars || {});
function plural(key, n) {
  const forms = L[key] || window.I18N.en[key];
  return fill(forms[fmt.plural.select(n)] ?? forms.other, { n: fmt.num.format(n) });
}
const shotsText = (n) => plural('shots', n);
const cap1 = (s) => s.charAt(0).toLocaleUpperCase(state.lang) + s.slice(1);

function reasonInfo(key) {
  const label = (L.reasons && L.reasons[key]) || window.I18N.en.reasons[key] || splitCamel(key);
  return { label, icon: REASON_ICONS[key] || 'gem', danger: DANGER.has(key) };
}
function splitCamel(key) {
  const words = key
    .replace(/Pv([PE])/g, '\u0001$1') // keep Tibia's "PvP"/"PvE" in one piece
    .replace(/_+/g, ' ')
    .replace(/([a-z\d])([A-Z\u0001])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z\u0001][a-z])/g, '$1 $2')
    .replace(/\u0001/g, 'Pv')
    .trim().split(/\s+/);
  return words.map((w, i) => (i === 0 || /^(?:[A-Z\d]+|Pv[PE])$/.test(w) ? w : w.toLowerCase())).join(' ');
}

/* ---------- File names ---------- */
// <YYYY-MM-DD>_<HHMMSSmmm>_<Character>_<Reason>[__N].<ext>; the reason may contain "_".
function parseName(name) {
  const stem = name.replace(/\.[^.]*$/, '');
  const parts = [];
  let rest = stem;
  for (let i = 0; i < 3; i++) {
    const j = rest.indexOf('_');
    if (j < 0) return null;
    parts.push(rest.slice(0, j));
    rest = rest.slice(j + 1);
  }
  const [ds, ts, rawChar] = parts;
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ds);
  const tm = /^(\d{2})(\d{2})(\d{2})(\d{3})?$/.exec(ts);
  if (!dm || !tm) return null;
  const character = rawChar.trim();
  const reason = rest.replace(/(?:__\d+)+$/, '');
  if (!character || !reason) return null;
  const [y, mo, d] = [+dm[1], +dm[2] - 1, +dm[3]];
  const [h, mi, s] = [+tm[1], +tm[2], +tm[3]];
  if (h > 23 || mi > 59 || s > 59) return null;
  const date = new Date(y, mo, d, h, mi, s, tm[4] ? +tm[4] : 0);
  if (date.getMonth() !== mo || date.getDate() !== d) return null;
  return { character, reason, ts: date.getTime() };
}

/* ---------- State ---------- */
const saved = store.get('view', {});
const state = {
  lang: null,
  order: saved.order === 'asc' ? 'asc' : 'desc',
  character: typeof saved.character === 'string' ? saved.character : null,
  reason: '*',
  os: detectOS(),
};
let model = null;      // { chars, list, others, byId, total, folder }
let scan = null;       // { token, count } while a folder is being read
let scanToken = 0;
let visible = [];      // shots in on-screen order (for the viewer)
let viewerAt = -1;

function detectOS() {
  const p = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '').toLowerCase();
  if (p.includes('mac') || p.includes('iphone') || p.includes('ipad')) return 'mac';
  if (p.includes('linux') || p.includes('x11') || p.includes('cros')) return 'linux';
  return 'win';
}
const isChromium = () => !!(navigator.userAgentData && navigator.userAgentData.brands && navigator.userAgentData.brands.some((b) => /Chromium/i.test(b.brand)));

function saveView() { store.set('view', { order: state.order, character: state.character }); }

/* ---------- Building the model ---------- */
function buildModel(files, folder) {
  const seen = new Set();
  const chars = new Map();
  const others = [];
  const byId = [];
  for (const file of files) {
    // The same screenshot can show up twice (e.g. a raw folder next to a sorted copy)
    const key = file.name + '\u0001' + file.size;
    if (seen.has(key)) continue;
    seen.add(key);
    const shot = { id: byId.length, file, name: file.name };
    byId.push(shot);
    const p = parseName(file.name);
    if (p) {
      Object.assign(shot, p);
      let c = chars.get(p.character);
      if (!c) { c = { name: p.character, shots: [], reasons: new Map() }; chars.set(p.character, c); }
      c.shots.push(shot);
      c.reasons.set(p.reason, (c.reasons.get(p.reason) || 0) + 1);
    } else {
      shot.ts = file.lastModified;
      shot.fileDate = true;
      others.push(shot);
    }
  }
  const byTime = (a, b) => a.ts - b.ts || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const c of chars.values()) {
    c.shots.sort(byTime);
    c.first = c.shots[0].ts;
    c.last = c.shots[c.shots.length - 1].ts;
  }
  others.sort(byTime);
  return { chars, list: [...chars.values()], others, byId, total: byId.length, folder };
}

function sortedRoster() {
  return [...model.list].sort((a, b) => fmt.collator.compare(a.name, b.name));
}

function applyModel(m) {
  thumbs.clear();
  closeViewer();
  model = m;
  const valid = state.character === OTHERS_KEY ? m.others.length > 0 : m.chars.has(state.character);
  if (!valid) {
    // Default to the character with the most recent screenshot
    const latest = m.list.reduce((a, b) => (!a || b.last > a.last ? b : a), null);
    state.character = latest ? latest.name : OTHERS_KEY;
  }
  state.reason = '*';
  document.body.classList.add('loaded');
  render();
  window.scrollTo(0, 0);
  $('main').focus({ preventScroll: true });
}

/* ---------- Reading folders ---------- */
const isImage = (name) => IMG_RE.test(name) && !name.startsWith('._');

function startScan() {
  scan = { token: ++scanToken, count: 0 };
  renderMain();
  return scan.token;
}

let scanPaint = 0;
function bumpScan(token, count) {
  if (!scan || scan.token !== token) return;
  scan.count = count;
  if (scanPaint) return;
  scanPaint = requestAnimationFrame(() => {
    scanPaint = 0;
    const el = $('scanNum');
    if (el && scan) el.textContent = t('scanFound', { shots: shotsText(scan.count) });
  });
}

function finishScan(token, files, folder) {
  if (!scan || scan.token !== token) return;
  scan = null;
  if (!files.length) {
    renderMain();
    toast(t('noImages'), 'error');
    return;
  }
  applyModel(buildModel(files, folder));
}

function failScan(token, err) {
  if (!scan || scan.token !== token) return;
  scan = null;
  renderMain();
  toast(t('scanFailed', { error: (err && (err.message || err.name)) || String(err) }), 'error');
}

function fromPicker(fileList) {
  const all = [...fileList];
  if (!all.length) return;
  const token = startScan();
  const folder = (all[0].webkitRelativePath || '').split('/')[0];
  const files = all.filter((f) => isImage(f.name));
  bumpScan(token, files.length);
  // Let the scanning state paint before the (quick) model build
  setTimeout(() => finishScan(token, files, folder), 0);
}

const entryFile = (entry) => new Promise((resolve) => entry.file(resolve, () => resolve(null)));
const readBatch = (reader) => new Promise((resolve, reject) => reader.readEntries(resolve, reject));

async function walkEntry(entry, out, token) {
  if (entry.isFile) {
    if (isImage(entry.name)) {
      const f = await entryFile(entry);
      if (f) { out.push(f); bumpScan(token, out.length); }
    }
    return;
  }
  if (!entry.isDirectory) return;
  const reader = entry.createReader();
  // readEntries returns results in batches (about 100 in Chromium) until it returns []
  for (;;) {
    const batch = await readBatch(reader);
    if (!batch.length) break;
    const files = await Promise.all(batch.filter((e) => e.isFile && isImage(e.name)).map(entryFile));
    for (const f of files) if (f) out.push(f);
    bumpScan(token, out.length);
    for (const e of batch) if (e.isDirectory) await walkEntry(e, out, token);
  }
}

async function fromDrop(dt) {
  // webkitGetAsEntry must be called synchronously, before the drop event returns
  const entries = [];
  for (const item of dt.items || []) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
    if (entry) entries.push(entry);
  }
  if (!entries.length) {
    const files = [...(dt.files || [])].filter((f) => isImage(f.name));
    const token = startScan();
    finishScan(token, files, '');
    return;
  }
  const folder = entries.length === 1 && entries[0].isDirectory ? entries[0].name : entries.map((e) => e.name).join(', ');
  const token = startScan();
  const out = [];
  try {
    for (const e of entries) await walkEntry(e, out, token);
    finishScan(token, out, folder);
  } catch (err) {
    failScan(token, err);
  }
}

/* ---------- Thumbnails: lazy, bounded, revoked ---------- */
async function makeThumb(file) {
  let src;
  let done = () => {};
  try {
    // Most engines shrink while decoding; Safari may ignore resizeWidth, the canvas below scales anyway.
    src = await createImageBitmap(file, { resizeWidth: THUMB_WIDTH, resizeQuality: 'medium' });
    done = () => src.close();
  } catch (e) {
    const url = URL.createObjectURL(file);
    try {
      src = new Image();
      src.src = url;
      await src.decode();
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const sw = src.width || src.naturalWidth, sh = src.height || src.naturalHeight;
  const scale = Math.min(1, THUMB_WIDTH / sw);
  const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  done();
  const toBlob = (type, q) => new Promise((resolve) => canvas.toBlob(resolve, type, q));
  let blob = await toBlob('image/webp', 0.8);
  if (!blob || blob.type !== 'image/webp') blob = await toBlob('image/jpeg', 0.82);
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error('encode failed');
  return blob;
}

const thumbs = (() => {
  const cache = new Map();   // shot id -> blob URL, oldest first
  const pending = new Map(); // shot id -> card waiting for a slot
  const failed = new Set();
  let active = 0;
  let gen = 0;

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const card = e.target, id = +card.dataset.id;
      if (e.isIntersecting) want(card, id);
      else pending.delete(id);
    }
    pump();
  }, { rootMargin: '700px 0px' });

  const cardFor = (id, card) => (card && card.isConnected ? card : document.querySelector(`.shot[data-id="${id}"]`));

  function show(card, url) {
    const img = card.querySelector('img');
    if (img.getAttribute('src') === url) return;
    img.onload = () => card.classList.add('ready');
    img.src = url;
  }
  function broken(card) { card.classList.add('broken'); }

  function want(card, id) {
    if (failed.has(id)) return broken(card);
    const url = cache.get(id);
    if (url) { cache.delete(id); cache.set(id, url); show(card, url); return; }
    pending.set(id, card);
  }

  // Start the waiting cards closest to the middle of the viewport first
  function pump() {
    const mid = window.innerHeight / 2;
    while (active < THUMB_CONCURRENCY && pending.size) {
      let best = -1, bestD = Infinity;
      for (const [id, card] of pending) {
        if (!card.isConnected) { pending.delete(id); continue; }
        const r = card.getBoundingClientRect();
        const d = Math.abs(r.top + r.height / 2 - mid);
        if (d < bestD) { bestD = d; best = id; }
      }
      if (best < 0) break;
      const card = pending.get(best);
      pending.delete(best);
      run(best, card);
    }
  }

  async function run(id, card) {
    const g = gen;
    active++;
    try {
      const blob = await makeThumb(model.byId[id].file);
      if (g !== gen) return;
      const url = URL.createObjectURL(blob);
      cache.set(id, url);
      evict();
      const cur = cardFor(id, card);
      if (cur) show(cur, url);
    } catch (err) {
      if (g !== gen) return;
      failed.add(id);
      const cur = cardFor(id, card);
      if (cur) broken(cur);
    } finally {
      active--;
      if (g === gen) pump();
    }
  }

  function evict() {
    while (cache.size > THUMB_CACHE) {
      const [id, url] = cache.entries().next().value;
      cache.delete(id);
      URL.revokeObjectURL(url);
      const card = document.querySelector(`.shot[data-id="${id}"]`);
      if (card) {
        card.classList.remove('ready');
        card.querySelector('img').removeAttribute('src');
        // Re-arm the observer so the card reloads if it scrolls back into range
        io.unobserve(card);
        io.observe(card);
      }
    }
  }

  return {
    // New gallery markup: watch its cards (cached thumbnails reappear instantly)
    observe(root) {
      io.disconnect();
      pending.clear();
      root.querySelectorAll('.shot').forEach((card) => io.observe(card));
    },
    // New folder: drop everything
    clear() {
      gen++;
      active = 0;
      io.disconnect();
      pending.clear();
      failed.clear();
      for (const url of cache.values()) URL.revokeObjectURL(url);
      cache.clear();
    },
    stats() { return { cached: cache.size, pending: pending.size, active, failed: failed.size }; },
  };
})();

/* ---------- Rendering ---------- */
function render() {
  renderStatic();
  renderSide();
  renderMain();
}

function renderStatic() {
  $('brandSub').textContent = t('tagline');
  $('side').setAttribute('aria-label', t('characters'));
  $('langLabel').textContent = t('language');
  const sel = $('langSel');
  sel.innerHTML = LANGS.map((k) => `<option value="${esc(k)}"${k === state.lang ? ' selected' : ''}>${esc(window.I18N[k].langName)}</option>`).join('');
  sel.title = t('language');
  renderThemeBtn();
  $('viewer').setAttribute('aria-label', t('viewer'));
  $('vprev').innerHTML = `${icon('left')}${esc(t('prev'))}`;
  $('vnext').innerHTML = `${esc(t('next'))}${icon('right')}`;
  $('vopen').innerHTML = `${icon('external')}${esc(t('openTab'))}`;
  $('vclose').innerHTML = `${icon('close')}${esc(t('close'))}`;
  $('vimg').title = t('zoomHint');
  $('dropOverlayText').textContent = t('dropOverlay');
}

function renderSide() {
  const roster = $('roster');
  const status = $('sideStatus');
  if (!model) { roster.innerHTML = ''; status.innerHTML = ''; return; }
  const items = sortedRoster().map((c) => `
    <li><button class="char" type="button" data-char="${esc(c.name)}" aria-current="${state.character === c.name}">
      <span class="n">${esc(c.name)}</span><span class="c">${fmt.num.format(c.shots.length)}</span>
    </button></li>`).join('');
  const others = model.others.length ? `
    <li class="others"><button class="char" type="button" data-others="1" aria-current="${state.character === OTHERS_KEY}">
      <span class="n">${esc(t('others'))}</span><span class="c">${fmt.num.format(model.others.length)}</span>
    </button></li>` : '';
  roster.innerHTML = `<ul>${items}${others}</ul>`;
  // Keep the selected character in view inside the (scrollable) roster
  const cur = roster.querySelector('[aria-current="true"]');
  if (cur) {
    const top = cur.offsetTop - roster.offsetTop, bottom = top + cur.offsetHeight;
    if (top < roster.scrollTop || bottom > roster.scrollTop + roster.clientHeight) roster.scrollTop = top - roster.clientHeight / 3;
  }
  status.innerHTML = `
    <p class="count">${esc(t('loaded', { shots: shotsText(model.total), folder: model.folder || '—' }))}</p>
    <p>${esc(t('sessionNote'))}</p>
    <div class="row"><button class="btn" type="button" data-act="pick">${icon('folder')}${esc(t('pickOther'))}</button></div>`;
}

function renderMain() {
  const main = $('main');
  if (scan || !model) { renderLanding(main); return; }

  if (state.character === OTHERS_KEY) {
    renderGallery(main, {
      title: t('others'),
      meta: model.others.length ? t('othersMeta', { shots: shotsText(model.others.length) }) : t('othersEmpty'),
      shots: model.others,
      tabs: '',
    });
    return;
  }

  const c = model.chars.get(state.character);
  if (state.reason !== '*' && !c.reasons.has(state.reason)) state.reason = '*';

  const reasons = [...c.reasons.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const tab = (key, label, ic, count, danger) => `
    <button class="tab${danger ? ' death' : ''}" role="tab" type="button" data-reason="${esc(key)}" aria-selected="${state.reason === key}" tabindex="${state.reason === key ? 0 : -1}">
      ${icon(ic)}<span>${esc(label)}</span><span class="c">${fmt.num.format(count)}</span>
    </button>`;
  const tabs = tab('*', t('all'), 'all', c.shots.length) +
    reasons.map(([k, n]) => { const r = reasonInfo(k); return tab(k, r.label, r.icon, n, r.danger); }).join('');

  renderGallery(main, {
    title: c.name,
    meta: `${shotsText(c.shots.length)} · ${cap1(monthRange(c.first, c.last))}`,
    shots: state.reason === '*' ? c.shots : c.shots.filter((s) => s.reason === state.reason),
    tabs,
    showReason: state.reason === '*',
  });
}

function monthRange(a, b) {
  const da = new Date(a), db = new Date(b);
  if (da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth()) return fmt.month.format(da);
  try { return fmt.month.formatRange(da, db); } catch (e) { return `${fmt.month.format(da)} – ${fmt.month.format(db)}`; }
}

function whenText(s) {
  const d = new Date(s.ts);
  const text = `${fmt.day.format(d)}, ${fmt.time.format(d)}`;
  return s.fileDate ? t('fileDate', { date: text }) : text;
}

function renderGallery(main, { title, meta, shots, tabs, showReason }) {
  const ordered = state.order === 'desc' ? [...shots].reverse() : shots;
  visible = ordered;

  // Group by month, keeping display order
  const groups = [];
  ordered.forEach((s, i) => {
    const d = new Date(s.ts);
    const key = d.getFullYear() * 12 + d.getMonth();
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) { g = { key, date: d, items: [] }; groups.push(g); }
    g.items.push([s, i]);
  });

  const broken = esc(t('thumbFailed'));
  const card = (s, i) => {
    let cap;
    if (s.character) {
      const d = new Date(s.ts);
      const r = reasonInfo(s.reason);
      cap = `<span class="d">${esc(fmt.day.format(d))}, <span class="t">${esc(fmt.time.format(d))}</span></span>` +
        (showReason ? `<span class="r${r.danger ? ' death' : ''}">${icon(r.icon)}${esc(r.label)}</span>` : '');
    } else {
      cap = `<span class="f">${esc(s.name)}</span><span class="d"><span class="t">${esc(whenText(s))}</span></span>`;
    }
    return `<button class="shot" type="button" data-i="${i}" data-id="${s.id}"><span class="pic" data-broken="${broken}"><img alt="" decoding="async"></span><span class="cap">${cap}</span></button>`;
  };

  const orderLabel = state.order === 'desc' ? t('newest') : t('oldest');
  main.innerHTML = `
    <header class="hero">
      <h2>${esc(title)}</h2>
      <p>${esc(meta)}</p>
    </header>
    <div class="controls">
      <div class="reasons" role="tablist" aria-label="${esc(t('kinds'))}">${tabs}</div>
      ${shots.length > 1 ? `<button class="btn order" type="button" id="orderBtn" aria-label="${esc(t('orderAria', { order: orderLabel }))}">${icon('sort')}${esc(orderLabel)}</button>` : ''}
    </div>
    <div id="gallery">
      ${groups.length ? groups.map((g) => `
        <section class="month" data-n="${g.items.length}">
          <h3>${esc(cap1(fmt.month.format(g.date)))}<span>${esc(shotsText(g.items.length))}</span></h3>
          <div class="grid">${g.items.map(([s, i]) => card(s, i)).join('')}</div>
        </section>`).join('') : `<p class="empty">${esc(t('nothing'))}</p>`}
    </div>`;
  sizeMonths(main);
  thumbs.observe(main);
}

// content-visibility skips off-screen months; give each a realistic placeholder
// height so the scrollbar does not jump as months render.
function sizeMonths(main) {
  const first = main.querySelector('.month .grid');
  const card = first && first.querySelector('.shot');
  if (!card) return;
  const cs = getComputedStyle(first);
  const cols = cs.gridTemplateColumns.split(' ').length || 1;
  const rowGap = parseFloat(cs.rowGap) || 0;
  const cardH = card.offsetHeight;
  const head = first.offsetTop - first.parentElement.offsetTop;
  main.querySelectorAll('.month').forEach((m) => {
    const rows = Math.ceil(+m.dataset.n / cols);
    m.style.containIntrinsicSize = `auto ${Math.round(head + rows * cardH + (rows - 1) * rowGap)}px`;
  });
}

function renderLanding(main) {
  visible = [];
  const drop = scan
    ? `<div class="scan" role="status">
        <p>${esc(t('scanning'))}</p>
        <p class="num" id="scanNum">${esc(t('scanFound', { shots: shotsText(scan.count) }))}</p>
        <div class="bar"><span></span></div>
      </div>`
    : `${icon('inbox').replace('class="ic"', 'class="ic big"')}
      <h3>${esc(t('dropTitle'))}</h3>
      <p class="or">${esc(t('dropOr'))}</p>
      <button class="btn primary" type="button" data-act="pick">${icon('folder')}${esc(t('pick'))}</button>
      <p class="hint">${esc(t('dropHint'))}</p>`;

  const osTab = (key, label) => `<button type="button" role="tab" id="os-${key}" aria-controls="os-panel" aria-selected="${state.os === key}" tabindex="${state.os === key ? 0 : -1}" data-os="${key}">${label}</button>`;
  let panel;
  if (state.os === 'win') {
    panel = `
      <p>${esc(t('whereWinLead'))}</p>
      <div class="pathrow"><code class="path" id="winPath">${esc(WIN_PATH)}</code><button class="btn" type="button" data-act="copy">${icon('copy')}${esc(t('copyPath'))}</button></div>
      <p class="muted">${esc(t('whereWinPaste'))}</p>
      <p class="muted">${esc(t('whereWinOther'))}</p>`;
  } else {
    panel = `
      <p>${esc(t('whereUnixLead'))}</p>
      <p class="muted">${esc(t(state.os === 'mac' ? 'whereMacHidden' : 'whereLinuxHidden'))}</p>`;
  }

  const hadFocus = main.contains(document.activeElement) && document.activeElement.dataset.os;
  main.innerHTML = `
    <div class="landing">
      <header class="hero">
        <h2>${esc(t('landingTitle'))}</h2>
        <p>${esc(t('landingLead'))}</p>
      </header>
      <section class="dropzone frame" aria-label="${esc(t('dropTitle'))}">${drop}</section>
      <section class="card frame privacy">
        <h3>${icon('shield')}${esc(t('privacyTitle'))}</h3>
        <ul>
          <li>${esc(t('privacyNoUpload'))}</li>
          <li>${esc(t('privacyNoDisk'))}</li>
          ${isChromium() ? `<li>${esc(t('privacyChromium'))}</li>` : ''}
        </ul>
      </section>
      <section class="card frame where">
        <h3>${icon('compass')}${esc(t('whereTitle'))}</h3>
        <div class="os-tabs" role="tablist" aria-label="${esc(t('whereTitle'))}">${osTab('win', 'Windows')}${osTab('mac', 'macOS')}${osTab('linux', 'Linux')}</div>
        <div class="os-panel" id="os-panel" role="tabpanel" aria-labelledby="os-${state.os}">${panel}</div>
      </section>
      <p class="fine">${esc(t('fanMade'))}</p>
    </div>`;
  if (hadFocus) { const b = main.querySelector(`[data-os="${state.os}"]`); if (b) b.focus(); }
}

/* ---------- Viewer ---------- */
const fullUrls = new Map(); // shot id -> object URL; only the current shot and its neighbours

function fullUrl(s) {
  let u = fullUrls.get(s.id);
  if (!u) { u = URL.createObjectURL(s.file); fullUrls.set(s.id, u); }
  return u;
}
function keepFull(ids) {
  for (const [id, u] of fullUrls) if (!ids.has(id)) { URL.revokeObjectURL(u); fullUrls.delete(id); }
}

function openViewer(i) {
  const dlg = $('viewer');
  viewerAt = i;
  showInViewer();
  if (!dlg.open) dlg.showModal();
}

function closeViewer() {
  const dlg = $('viewer');
  if (dlg.open) dlg.close();
}

function showInViewer() {
  const s = visible[viewerAt];
  if (!s) return;
  const near = [visible[viewerAt - 1], s, visible[viewerAt + 1]].filter(Boolean);
  keepFull(new Set(near.map((x) => x.id)));
  const img = $('vimg');
  $('stage').classList.remove('actual');
  img.src = fullUrl(s);
  img.alt = s.name;
  let who, what;
  if (s.character) {
    const r = reasonInfo(s.reason);
    who = `<span class="who">${esc(s.character)}</span>`;
    what = `<span class="what${r.danger ? ' death' : ''}">${icon(r.icon)}${esc(r.label)}</span>`;
  } else {
    who = `<span class="who">${esc(t('others'))}</span>`;
    what = `<span class="what">${esc(s.name)}</span>`;
  }
  const pos = t('position', { i: fmt.num.format(viewerAt + 1), n: fmt.num.format(visible.length) });
  $('vinfo').innerHTML = `${who}${what}<span class="when">${esc(whenText(s))}<span class="pos">${esc(pos)}</span></span>`;
  $('vopen').href = img.src;
  $('vprev').disabled = viewerAt === 0;
  $('vnext').disabled = viewerAt === visible.length - 1;
  // A button that just got disabled drops focus to <body>; keep it inside the dialog
  const f = document.activeElement;
  if (f && f.disabled) {
    const other = f === $('vnext') ? $('vprev') : $('vnext');
    (other.disabled ? $('vclose') : other).focus();
  }
  // Warm the neighbours so arrow keys feel instant
  near.forEach((x) => { if (x !== s) new Image().src = fullUrl(x); });
}

function stepViewer(delta) {
  const j = Math.max(0, Math.min(visible.length - 1, viewerAt + delta));
  if (j !== viewerAt) { viewerAt = j; showInViewer(); }
}

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg, kind) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast frame show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), kind === 'error' ? 8000 : 3500);
}

/* ---------- Theme ---------- */
function currentTheme() {
  const th = document.documentElement.dataset.theme;
  if (th) return th;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function renderThemeBtn() {
  const dark = currentTheme() === 'dark';
  $('themeBtn').innerHTML = dark ? `${icon('sun')}${esc(t('themeLight'))}` : `${icon('moon')}${esc(t('themeDark'))}`;
}
$('themeBtn').addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('tibiaviewer.theme', next); } catch (e) {}
  renderThemeBtn();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderThemeBtn);

$('langSel').addEventListener('change', (e) => {
  setLang(e.target.value);
  store.set('lang', state.lang);
  render();
  if ($('viewer').open) showInViewer();
  $('langSel').focus();
});

/* ---------- Events ---------- */
const picker = $('picker');
picker.addEventListener('change', () => {
  const files = picker.files;
  fromPicker(files);
  picker.value = '';
});

document.addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]');
  if (!act) return;
  if (act.dataset.act === 'pick') picker.click();
  else if (act.dataset.act === 'copy') {
    try { await navigator.clipboard.writeText(WIN_PATH); toast(t('copied')); }
    catch (err) {
      const sel = window.getSelection();
      sel.selectAllChildren($('winPath'));
      toast(t('copyFailed'), 'error');
    }
  }
});

$('roster').addEventListener('click', (e) => {
  const b = e.target.closest('.char');
  if (!b) return;
  const pick = b.dataset.others ? OTHERS_KEY : b.dataset.char;
  if (state.character !== pick) { state.character = pick; state.reason = '*'; }
  saveView();
  renderSide();
  renderMain();
  window.scrollTo(0, 0);
});

$('main').addEventListener('click', (e) => {
  const os = e.target.closest('[data-os]');
  if (os) { state.os = os.dataset.os; renderMain(); return; }
  const tab = e.target.closest('.tab');
  if (tab) { state.reason = tab.dataset.reason; renderMain(); $('main').querySelector('.tab[aria-selected="true"]').focus(); return; }
  if (e.target.closest('#orderBtn')) { state.order = state.order === 'desc' ? 'asc' : 'desc'; saveView(); renderMain(); $('orderBtn').focus(); return; }
  const shot = e.target.closest('.shot');
  if (shot) openViewer(+shot.dataset.i);
});

// Arrow keys move between tabs (reason tabs and OS tabs)
$('main').addEventListener('keydown', (e) => {
  const tab = e.target.closest('[role="tab"]');
  if (!tab) return;
  const tabs = [...tab.parentElement.querySelectorAll('[role="tab"]')];
  let j = tabs.indexOf(tab);
  if (e.key === 'ArrowRight') j = (j + 1) % tabs.length;
  else if (e.key === 'ArrowLeft') j = (j - 1 + tabs.length) % tabs.length;
  else if (e.key === 'Home') j = 0;
  else if (e.key === 'End') j = tabs.length - 1;
  else return;
  e.preventDefault();
  tabs[j].focus();
  tabs[j].click();
});

// Drag and drop anywhere on the page
let dragDepth = 0;
const hasFiles = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dragging');
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if ($('viewer').open) closeViewer();
  fromDrop(e.dataTransfer);
});

$('vprev').addEventListener('click', () => stepViewer(-1));
$('vnext').addEventListener('click', () => stepViewer(1));
$('vclose').addEventListener('click', closeViewer);
$('vimg').addEventListener('click', () => $('stage').classList.toggle('actual'));
$('viewer').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeViewer(); });
// Listen on the document: focus can end up outside the dialog's buttons
document.addEventListener('keydown', (e) => {
  if (!$('viewer').open || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); stepViewer(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); stepViewer(1); }
  else if (e.key === 'Home') { e.preventDefault(); stepViewer(-viewerAt); }
  else if (e.key === 'End') { e.preventDefault(); stepViewer(visible.length); }
});
$('viewer').addEventListener('close', () => {
  keepFull(new Set());
  $('vimg').removeAttribute('src');
  $('vopen').removeAttribute('href');
  const card = document.querySelector(`.shot[data-i="${viewerAt}"]`);
  if (card) { card.scrollIntoView({ block: 'nearest' }); card.focus({ preventScroll: true }); }
});

/* ---------- Start ---------- */
setLang(detectLang());
render();

// Small hook for tests and the curious; exposes no data beyond what is on screen.
window.TibiaViewer = { parseName, reasonLabel: (k) => reasonInfo(k).label, stats: () => ({ ...thumbs.stats(), viewerUrls: fullUrls.size }) };
