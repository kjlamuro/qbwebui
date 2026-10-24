/* ══════════════════════════════════════════════════════════
   qBWebUI · 前端逻辑
   ══════════════════════════════════════════════════════════ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const isMobile = () => window.matchMedia('(max-width: 900px)').matches;

const LS = {
  theme: 'qb.theme',
  interval: 'qb.interval',
  creds: 'qb.creds',
  thumbs: 'qb.thumbs',
  kinds: 'qb.kinds',
  listTitle: 'qb.listTitle',
  addMode: 'qb.addMode',
};

const config = { target: '' };

/* ── 状态 ─────────────────────────────────────────────── */
const state = {
  list: [],
  map: new Map(),
  filter: 'all',
  category: '',
  tag: '',
  q: '',
  sort: { key: 'added_on', dir: -1 },
  selected: new Set(),
  server: {},
  rid: 0,
  detailHash: null,
  detailData: null,
  detailTab: 'files',
  fileEdit: false, // 文件列表的勾选默认锁着，点「修改下载列表」才解锁
  categories: {},
  tags: [],
  pollMs: Number(localStorage.getItem(LS.interval) ?? 2000),
  connected: false,
  firstLoad: true,
  prefs: null,
  loggedIn: false,
  pending: new Map(), // 乐观状态覆盖，避免轮询回弹造成的闪烁
  /* 封面：自定义图 > 目录自动图 > 类型图标 */
  coverOn: localStorage.getItem('qb.thumbs') !== '0',
  coverV: new Map(),    // hash -> 版本号，用于刷新图片缓存
  coverMode: new Map(), // hash -> custom | tvdb | auto | icon
  coverFlag: new Map(), // hash -> 1 有封面 / 0 明确没有（后端只读缓存给的结论，缺省=还没问过）
  coverAsked: new Set(), // 已经问过「有没有封面」的 hash
  coverKind: new Map(), // hash -> video | audio | image | book | archive | other（后端按文件权重判定）
  kindAsked: new Set(), // 已经问过后端的 hash
  kindAt: 0,
  /* TheTVDB 刮削：是否可用由服务端决定（密钥在服务端，页面不持有） */
  tvdb: { enabled: false, configured: false, auto: 'off', lang: 'zho' },
  /* 列表标题：off = 原始文件名；media = 媒体名为主；original = 原始名为主（媒体名做副标题） */
  listTitleMode: localStorage.getItem('qb.listTitle') || 'off',
  mediaTitles: new Map(), // hash -> { name, year, type }（刮削到的媒体数据）
};

/* ── 格式化 ───────────────────────────────────────────── */
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

function fmtBytes(n, digits) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (n === 0) return '0 B';
  let i = 0;
  let v = Math.abs(n);
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; }
  const d = digits ?? (v >= 100 ? 0 : v >= 10 ? 1 : 2);
  return `${v.toFixed(d)} ${UNITS[i]}`;
}

const fmtSpeed = (n) => (n > 0 ? `${fmtBytes(n)}/s` : '—');

function fmtEta(sec) {
  if (sec === null || sec === undefined || sec < 0 || sec >= 8640000) return '∞';
  if (sec < 60) return `${sec}s`;
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}天${h}时`;
  if (h > 0) return `${h}时${m}分`;
  return `${m}分`;
}

function fmtDate(ts) {
  if (!ts || ts <= 0) return '—';
  const d = new Date(ts * 1000);
  const p = (x) => String(x).padStart(2, '0');
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return `${sameYear ? '' : d.getFullYear() + '-'}${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDuration(sec) {
  if (!sec || sec <= 0) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分钟`;
}

const pct = (v) => `${(Math.min(1, Math.max(0, v)) * 100).toFixed(1)}%`;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ── 种子状态映射 ─────────────────────────────────────── */
const STATE_MAP = {
  downloading: { key: 'dl', label: '下载中' },
  forcedDL: { key: 'dl', label: '下载中' },
  metaDL: { key: 'dl', label: '获取元数据' },
  allocating: { key: 'dl', label: '分配空间' },
  stalledDL: { key: 'stall', label: '等待中' },
  queuedDL: { key: 'queue', label: '排队中' },
  pausedDL: { key: 'pause', label: '已暂停' },
  stoppedDL: { key: 'pause', label: '已暂停' },
  uploading: { key: 'seed', label: '做种中' },
  forcedUP: { key: 'seed', label: '做种中' },
  stalledUP: { key: 'stall', label: '做种等待' },
  queuedUP: { key: 'queue', label: '排队中' },
  pausedUP: { key: 'pause', label: '已暂停' },
  stoppedUP: { key: 'pause', label: '已完成' },
  checkingUP: { key: 'check', label: '校验中' },
  checkingDL: { key: 'check', label: '校验中' },
  checkingResumeData: { key: 'check', label: '恢复中' },
  moving: { key: 'check', label: '移动中' },
  missingFiles: { key: 'err', label: '文件缺失' },
  error: { key: 'err', label: '错误' },
  unknown: { key: 'stall', label: '未知' },
};

const statusOf = (t) => STATE_MAP[t.state] || { key: 'stall', label: t.state || '未知' };
const isPaused = (t) => /paused|stopped/i.test(t.state);
const isComplete = (t) => t.progress >= 0.9999;

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'downloading', label: '下载中' },
  { id: 'seeding', label: '做种中' },
  { id: 'completed', label: '已完成' },
  { id: 'paused', label: '已暂停' },
  { id: 'error', label: '错误' },
];

function matchFilter(t, f) {
  switch (f) {
    case 'downloading': return !isPaused(t) && !isComplete(t);
    case 'seeding': return !isPaused(t) && isComplete(t) && statusOf(t).key === 'seed';
    case 'completed': return isComplete(t);
    case 'paused': return isPaused(t);
    case 'error': return statusOf(t).key === 'err';
    default: return true;
  }
}

/* ── API ──────────────────────────────────────────────── */
async function api(path, opts = {}) {
  const res = await fetch(`/api/v2${path}`, { credentials: 'same-origin', ...opts });
  if (res.status === 401) {
    onUnauthorized();
    const err = new Error('unauthorized');
    err.unauthorized = true;
    throw err;
  }
  const text = await res.text();
  if (!res.ok) throw new Error(text.trim() || `HTTP ${res.status}`);
  return text;
}

async function apiJson(path, opts) {
  const text = await api(path, opts);
  try { return JSON.parse(text); } catch { return text; }
}

const post = (path, data) => {
  const body = data instanceof FormData ? data : new URLSearchParams(data || {});
  return api(path, { method: 'POST', body });
};

const torrentsAction = (action, hashes, extra = {}) =>
  post(`/torrents/${action}`, { hashes: hashes.join('|'), ...extra });

/* 兼容 5.x 的 stop/start 与旧版 pause/resume */
let useStopStart = true;
async function setPaused(hashes, paused) {
  const primary = paused ? 'stop' : 'start';
  let res;
  try {
    res = await torrentsAction(useStopStart ? primary : primary === 'stop' ? 'pause' : 'resume', hashes);
  } catch (err) {
    if (err.unauthorized) throw err;
    useStopStart = !useStopStart;
    res = await torrentsAction(paused ? 'pause' : 'resume', hashes);
  }
  // qBittorrent 的状态切换是异步的，先乐观更新，并在 2.5s 内保持，避免轮询回弹
  const until = Date.now() + 2500;
  for (const h of hashes) {
    const t = state.map.get(h);
    if (!t) continue;
    const next = paused
      ? (isComplete(t) ? 'stoppedUP' : 'stoppedDL')
      : (isComplete(t) ? 'uploading' : 'downloading');
    t.state = next;
    state.pending.set(h, { state: next, until });
  }
  renderRows();
  if (state.detailHash) renderDetail();
  return res;
}

/* ══════════ 渲染：列表 ══════════ */
const rowsEl = $('#rows');
const rowCache = new Map();

/* ══════════ 封面缩略图 ══════════ */
/* 解析顺序：自定义上传图 → 种子目录里自动找到的图 → 类型图标（兜底） */

/* 类型由后端按「目录 / 种子文件清单里各类文件的体积权重」判定，
   前端只在还没拿到结果（或拿不到）时，用分类和名字先猜一个顶着 */
const KIND_META = {
  video: { cls: 'film', icon: 'i-film', label: '视频' },
  audio: { cls: 'music', icon: 'i-music', label: '音乐' },
  image: { cls: 'image', icon: 'i-image', label: '图片' },
  book: { cls: 'book', icon: 'i-book', label: '书籍' },
  archive: { cls: 'archive', icon: 'i-archive', label: '压缩包 / 镜像' },
  other: { cls: 'other', icon: 'i-inbox', label: '其他' },
};

const KIND_GUESS = [
  { kind: 'audio', re: /(music|audio|album|ost|flac|ape|dts|soundtrack|音乐|专辑|歌曲|演唱会|无损|原声)/i },
  { kind: 'image', re: /(photo|image|picture|wallpaper|comic|manga|画集|摄影|图片|壁纸|漫画|写真|绘本|图册)/i },
  { kind: 'video', re: /(movie|film|tv|series|episode|video|anime|documentary|电影|影视|剧集|动画|番剧|综艺|纪录片|视频|纪录)/i },
  { kind: 'book', re: /(ebook|book|pdf|epub|manga|书籍|电子书|小说|漫画|教材|画册)/i },
  { kind: 'archive', re: /(software|game|iso|zip|rar|7z|dmg|course|tutorial|软件|游戏|应用|课程|教程|文档|素材)/i },
];

function coverKind(t) {
  const known = state.coverKind.get(t.hash);
  // 后端说「other」只表示没判出来，这时名字/分类的猜测更靠谱，别拿它盖掉猜测
  if (known && known !== 'other' && KIND_META[known]) return KIND_META[known];
  const hay = `${t.category || ''} ${t.name || ''} ${t.tags || ''}`;
  for (const g of KIND_GUESS) if (g.re.test(hay)) return KIND_META[g.kind];
  return KIND_META[known] || KIND_META.other;
}

/**
 * 向后端批量问类型 + 有没有封面。一次请求拿完当前列表里还不知道的 hash，
 * 结果回填后只重画受影响的行，2 秒一次的轮询不会重复发请求。
 * 「有没有封面」是为了不再对没有图的种子发 /__cover/img —— 那会 404 一片红。
 */
let kindsBusy = false;
async function ensureKinds() {
  if (kindsBusy || !state.coverOn || !state.list.length) return;
  const now = Date.now();
  if (now - state.kindAt > 300_000) { state.kindAsked.clear(); state.coverAsked.clear(); state.kindAt = now; } // 目录内容会变，5 分钟复查一次
  const needKind = state.list.map((t) => t.hash).filter((h) => !state.coverKind.has(h) && !state.kindAsked.has(h));
  /* 类型可能是从 localStorage 预填的（首屏就有图标），但封面结论一定得问一次，
     否则每行还是会去试图片、继续 404 */
  const needCover = state.list.map((t) => t.hash).filter((h) => !state.coverFlag.has(h) && !state.coverAsked.has(h));
  const batch = [...new Set([...needKind, ...needCover])].slice(0, 120);
  if (!batch.length) return;
  kindsBusy = true;
  try {
    const res = await fetch('/__cover/kinds', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hashes: batch }),
    });
    const data = await res.json();
    const kinds = data?.kinds || {};
    const covers = data?.covers || {};
    // 成功拿到回执才记账：失败要留给下一轮重试，否则这一批封面就永远不加载了
    batch.forEach((h) => { state.kindAsked.add(h); state.coverAsked.add(h); });
    let changed = false;
    for (const h of batch) {
      const k = kinds[h] || 'other';
      if (state.coverKind.get(h) !== k) { state.coverKind.set(h, k); changed = true; }
      const f = covers[h];
      if ((f === 0 || f === 1) && state.coverFlag.get(h) !== f) { state.coverFlag.set(h, f); changed = true; }
    }
    saveKinds(); // 记住这一轮的结果，下次开页面首屏就有类型
    if (changed) {
      for (const el of rowCache.values()) el._v.coverKey = null;
      renderRows();
      if (state.detailHash) renderDetail();
    }
  } catch {
    batch.forEach((h) => { state.kindAsked.delete(h); state.coverAsked.delete(h); }); // 下轮重试
  } finally {
    kindsBusy = false;
  }
}

/**
 * 添加种子后立刻把类型写进后端缓存。
 * qBittorrent 收下种子就已有文件清单（元数据不依赖下载进度），所以这一步能当场定下
 * 类型：新行一出现就是对的图标，不用等下一次轮询去扫目录，缓存里也就有了第一条记录。
 */
async function seedKinds(hashes, hint = {}) {
  if (!hashes.length) return hashes;
  try {
    const res = await fetch('/__cover/seed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hashes, name: hint.name || '', category: hint.category || '' }),
    });
    const kinds = (await res.json()).kinds || {};
    let changed = false;
    for (const h of hashes) {
      const k = kinds[h];
      if (!k) continue;
      state.kindAsked.add(h);
      if (state.coverKind.get(h) !== k) { state.coverKind.set(h, k); changed = true; }
    }
    saveKinds();
    if (changed) {
      for (const el of rowCache.values()) el._v.coverKey = null;
      renderRows();
      if (state.detailHash) renderDetail();
    }
  } catch { /* 写不进去也不影响，下次轮询会补上 */ }
  return hashes;
}

/**
 * 类型也存一份在浏览器里。
 * 后端缓存命中时几毫秒就能返回，但首屏还是会用「名字猜」渲染一帧再翻成真图标；
 * 记住上次的结果后，刷新页面第一帧就是对的（类型基本不变，后端每轮仍会校准）。
 */
function loadKinds() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS.kinds) || '{}');
    for (const [h, k] of Object.entries(raw)) if (KIND_META[k]) state.coverKind.set(h, k);
  } catch { /* 坏数据就当没有 */ }
}

let kindsSaveTimer = null;
function saveKinds() {
  clearTimeout(kindsSaveTimer);
  kindsSaveTimer = setTimeout(() => {
    if (!state.list.length) return; // 列表还没到就别写，否则会把记住的类型清空
    try {
      const out = {};
      // 只留当前列表里的，避免删掉的种子越攒越多
      for (const t of state.list) {
        const k = state.coverKind.get(t.hash);
        if (k) out[t.hash] = k;
      }
      localStorage.setItem(LS.kinds, JSON.stringify(out));
    } catch { /* 存不下就算了，下次重新问后端 */ }
  }, 2000);
}

const coverUrl = (hash) => `/__cover/img?hash=${hash}&v=${state.coverV.get(hash) || 0}`;
const shortPath = (p) => (p && p.length > 44 ? `…${p.slice(-43)}` : p || '');

/** 让某一行的缩略图重新加载 */
function bumpCover(hash) {
  state.coverV.set(hash, Date.now());
  const t = state.map.get(hash);
  const el = rowCache.get(hash);
  if (el && t) { el._v.coverKey = null; updateRow(el, t); }
}

function setCoverOn(on, render = true) {
  state.coverOn = on;
  localStorage.setItem(LS.thumbs, on ? '1' : '0');
  rowsEl.classList.toggle('has-thumb', on);
  const btn = $('#thumbBtn');
  btn.classList.toggle('is-on', on);
  btn.setAttribute('aria-pressed', String(on));
  const box = $('#setThumbs');
  if (box) box.checked = on;
  if (!render) return;
  for (const el of rowCache.values()) el._v.coverKey = null;
  renderRows();
  if (on) ensureKinds(); // 关着的时候没必要问类型
}

const SORTERS = {
  name: (t) => t.name.toLowerCase(),
  size: (t) => t.size,
  progress: (t) => t.progress,
  dlspeed: (t) => t.dlspeed,
  upspeed: (t) => t.upspeed,
  ratio: (t) => t.ratio,
  eta: (t) => (t.eta < 0 || t.progress >= 1 ? Number.MAX_SAFE_INTEGER : t.eta),
  state: (t) => statusOf(t).label,
  added_on: (t) => t.added_on,
};

function visibleTorrents() {
  const q = state.q.trim().toLowerCase();
  let list = state.list.filter((t) => {
    if (!matchFilter(t, state.filter)) return false;
    if (state.category === '__none__') { if (t.category) return false; }
    else if (state.category && t.category !== state.category) return false;
    if (state.tag && !(t.tags || '').split(',').map((s) => s.trim()).includes(state.tag)) return false;
    if (q) {
      const mt = state.mediaTitles.get(t.hash);
      const hay = `${t.name} ${mt?.name || ''} ${t.category} ${t.tags} ${t.hash}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const get = SORTERS[state.sort.key] || SORTERS.added_on;
  const dir = state.sort.dir;
  list.sort((a, b) => {
    const va = get(a);
    const vb = get(b);
    if (typeof va === 'string') return va.localeCompare(vb, 'zh-CN') * dir;
    if (va === vb) return a.name.localeCompare(b.name) * dir;
    return (va - vb) * dir;
  });
  return list;
}

function createRow(t) {
  const el = document.createElement('div');
  el.className = 'row';
  el.dataset.hash = t.hash;
  el.innerHTML = `
    <div class="cell check"><label class="check-wrap"><input type="checkbox" /><span class="checkbox"></span></label></div>
    <div class="cell name">
      <div class="thumb" data-act="cover" title="封面•刮削"><img alt="" loading="lazy" decoding="async" /><svg><use href="#i-inbox"/></svg></div>
      <div class="t-text"><div class="t-name"></div><span class="t-media" hidden></span><div class="t-sub"></div></div>
    </div>
    <div class="cell size"></div>
    <div class="cell prog"><div class="pbar"><i></i></div><div class="ptext"></div></div>
    <div class="cell dl"><b></b></div>
    <div class="cell up"><b></b></div>
    <div class="cell ratio"></div>
    <div class="cell eta"></div>
    <div class="cell state"><span class="pill"><i></i><span class="pl"></span></span></div>
    <div class="cell meta"></div>
    <div class="cell actions"><button class="icon-btn" data-act="menu" aria-label="操作"><svg><use href="#i-more"/></svg></button></div>
  `;
  const refs = {
    check: $('input', el),
    thumb: $('.thumb', el),
    thumbImg: $('.thumb img', el),
    thumbIco: $('.thumb svg use', el),
    name: $('.t-name', el),
    mediaName: $('.t-media', el),
    sub: $('.t-sub', el),
    size: $('.size', el),
    pbar: $('.pbar', el),
    fill: $('.pbar i', el),
    ptext: $('.ptext', el),
    dl: $('.dl b', el),
    up: $('.up b', el),
    ratio: $('.ratio', el),
    eta: $('.eta', el),
    pill: $('.pill', el),
    pillText: $('.pl', el),
    meta: $('.meta', el),
  };
  el._refs = refs;
  el._v = {};
  refs.thumbImg.addEventListener('load', () => refs.thumb.classList.add('has-img'));
  refs.thumbImg.addEventListener('error', () => refs.thumb.classList.remove('has-img'));
  return el;
}

function updateRow(el, t) {
  const r = el._refs;
  const v = el._v;
  const st = statusOf(t);

  /* 后端说这个种子没有封面就别发图片请求了（以前每行都试一次，404 一片红）。
     刚上传 / 刚套用 TVDB 海报的那种一定是有图的，不受旧结论影响。 */
  const coverMode = state.coverMode.get(t.hash);
  const coverForced = coverMode === 'custom' || coverMode === 'tvdb';
  const coverFlag = state.coverFlag.get(t.hash);
  const coverKey = `${state.coverOn ? 1 : 0}|${state.coverV.get(t.hash) || 0}|${coverKind(t).kind}|${coverMode || ''}|${coverForced ? 1 : (coverFlag ?? '?')}`;
  if (v.coverKey !== coverKey) {
    v.coverKey = coverKey;
    const k = coverKind(t);
    r.thumb.className = `thumb k-${k.cls}`;
    r.thumbIco.setAttribute('href', `#${k.icon}`);
    r.thumb.classList.remove('has-img');
    if (state.coverOn && coverMode !== 'icon' && (coverForced || coverFlag === 1)) {
      r.thumbImg.src = coverUrl(t.hash);
    } else {
      r.thumbImg.removeAttribute('src');
    }
  }

  // 列表标题：按设置决定用原始文件名还是刮削到的 TVDB 媒体名，另一方做副标题
  const mt = state.mediaTitles.get(t.hash);
  const mediaName = mt?.name ? (mt.year ? `${mt.name} (${mt.year})` : mt.name) : '';
  const titleKey = `${state.listTitleMode}|${mediaName}|${t.name}`;
  if (v.titleKey !== titleKey) {
    v.titleKey = titleKey;
    const mode = state.listTitleMode;
    const useMedia = mode !== 'off' && mediaName && mediaName !== t.name;
    if (!useMedia) {
      r.name.textContent = t.name;
      r.name.title = t.name;
      r.mediaName.hidden = true;
      r.mediaName.textContent = '';
    } else if (mode === 'media') {
      r.name.textContent = mediaName;
      r.name.title = t.name; // 悬停可看原始文件名
      r.mediaName.hidden = false;
      r.mediaName.textContent = t.name;
    } else { // original：原始名为主，媒体名为副
      r.name.textContent = t.name;
      r.name.title = t.name;
      r.mediaName.hidden = false;
      r.mediaName.textContent = mediaName;
    }
  }

  const catKey = `${t.category}|${t.tags}`;
  if (v.cat !== catKey) {
    r.sub.innerHTML = '';
    if (t.category) {
      const b = document.createElement('span');
      b.className = 'badge-cat';
      b.textContent = t.category;
      r.sub.append(b);
    }
    (t.tags || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 2).forEach((tag) => {
      const s = document.createElement('span');
      s.className = 'tag-mini';
      s.textContent = tag;
      r.sub.append(s);
    });
    v.cat = catKey;
  }

  if (v.size !== t.size) { r.size.textContent = fmtBytes(t.size); v.size = t.size; }

  const p = t.progress;
  if (v.prog !== p) { r.fill.style.width = `${(p * 100).toFixed(2)}%`; r.ptext.textContent = pct(p); v.prog = p; }

  if (v.dl !== t.dlspeed) { r.dl.textContent = fmtSpeed(t.dlspeed); v.dl = t.dlspeed; }
  if (v.up !== t.upspeed) { r.up.textContent = fmtSpeed(t.upspeed); v.up = t.upspeed; }
  if (v.ratio !== t.ratio) { r.ratio.textContent = t.ratio > 0 ? t.ratio.toFixed(2) : '—'; v.ratio = t.ratio; }
  const etaTxt = isComplete(t) ? '已完成' : fmtEta(t.eta);
  if (v.eta !== etaTxt) { r.eta.textContent = etaTxt; v.eta = etaTxt; }

  if (v.state !== t.state) {
    r.pill.className = `pill ${st.key}`;
    r.pillText.textContent = st.label;
    v.state = t.state;
  }

  const barCls = `pbar ${st.key === 'dl' ? 'dl' : st.key === 'seed' ? 'seed' : st.key === 'pause' ? 'pause' : st.key === 'err' ? 'err' : isComplete(t) ? 'done' : ''}`;
  if (v.barCls !== barCls) { r.pbar.className = barCls; v.barCls = barCls; }

  const metaTxt = `${fmtBytes(t.size)} · ↓ ${t.dlspeed > 0 ? fmtBytes(t.dlspeed) + '/s' : '0'} · ↑ ${t.upspeed > 0 ? fmtBytes(t.upspeed) + '/s' : '0'} · ${isComplete(t) ? '分享率 ' + (t.ratio || 0).toFixed(2) : '剩 ' + fmtEta(t.eta)}`;
  if (v.meta !== metaTxt) { r.meta.textContent = metaTxt; v.meta = metaTxt; }

  const sel = state.selected.has(t.hash);
  if (v.sel !== sel) { r.check.checked = sel; el.classList.toggle('is-selected', sel); v.sel = sel; }
}

function renderRows() {
  const list = visibleTorrents();
  const seen = new Set();

  list.forEach((t, i) => {
    let el = rowCache.get(t.hash);
    if (!el) {
      el = createRow(t);
      rowCache.set(t.hash, el);
      rowsEl.append(el);
      updateRow(el, t);
    } else {
      updateRow(el, t);
    }
    el.style.order = i;
    el.style.display = '';
    seen.add(t.hash);
  });

  // 隐藏不再可见的行（保留节点，切换筛选无闪烁）
  for (const [hash, el] of rowCache) {
    if (!seen.has(hash)) el.style.display = 'none';
  }

  const isEmpty = list.length === 0;
  $('#emptyView').hidden = !isEmpty || state.firstLoad;
  $('#skeletonView').hidden = !state.firstLoad;
  if (isEmpty && !state.firstLoad) {
    const searching = state.q || state.category || state.tag || state.filter !== 'all';
    $('#emptyTitle').textContent = searching ? '没有匹配的种子' : '这里还没有种子';
    $('#emptyDesc').textContent = searching ? '试试换个关键词或筛选条件' : '点击右上角「添加种子」开始下载';
    $('#emptyAddBtn').style.display = searching ? 'none' : '';
  }

  renderCounts();
}

function renderCounts() {
  const counts = {};
  FILTERS.forEach((f) => { counts[f.id] = 0; });
  for (const t of state.list) {
    counts.all++;
    if (matchFilter(t, 'downloading')) counts.downloading++;
    if (matchFilter(t, 'seeding')) counts.seeding++;
    if (matchFilter(t, 'completed')) counts.completed++;
    if (matchFilter(t, 'paused')) counts.paused++;
    if (matchFilter(t, 'error')) counts.error++;
  }
  $$('[data-count]').forEach((el) => { el.textContent = counts[el.dataset.count] ?? 0; });

  // 分类计数
  const catCounts = {};
  for (const t of state.list) {
    if (!t.category) continue;
    catCounts[t.category] = (catCounts[t.category] || 0) + 1;
  }
  const catList = $('#catList');
  const allCats = new Set([...Object.keys(catCounts), ...Object.keys(state.categories || {})]);
  const cats = [...allCats].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const sig = cats.map((c) => c + (catCounts[c] || 0)).join('|') + `#${state.category}`;
  if (catList._sig !== sig) {
    catList._sig = sig;
    catList.innerHTML =
      `<div class="side-row ${state.category === '__none__' ? 'is-active' : ''}" data-cat="__none__"><svg><use href="#i-inbox"/></svg><span class="side-row-name">未分类</span><em>${state.list.filter((t) => !t.category).length}</em></div>` +
      cats.map((c) => `<div class="side-row ${state.category === c ? 'is-active' : ''}" data-cat="${esc(c)}"><svg><use href="#i-folder"/></svg><span class="side-row-name">${esc(c)}</span><em>${catCounts[c] || 0}</em></div>`).join('');
  }

  // 标签
  const tagCounts = {};
  for (const t of state.list) {
    (t.tags || '').split(',').map((s) => s.trim()).filter(Boolean).forEach((tag) => {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    });
  }
  const tags = Object.keys(tagCounts).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const tagSig = tags.map((c) => c + tagCounts[c]).join('|') + `#${state.tag}`;
  const tagEl = $('#tagList');
  if (tagEl._sig !== tagSig) {
    tagEl._sig = tagSig;
    tagEl.innerHTML = tags.length
      ? tags.map((tag) => `<span class="tag-chip ${state.tag === tag ? 'is-active' : ''}" data-tag="${esc(tag)}"><span>${esc(tag)}</span></span>`).join('')
      : '<span class="hint">暂无标签</span>';
  }

  // 移动端 chips
  const chips = $('#chips');
  const chipSig = FILTERS.map((f) => counts[f.id]).join(',') + `#${state.filter}`;
  if (chips._sig !== chipSig) {
    chips._sig = chipSig;
    chips.innerHTML = FILTERS.map((f) => `<button class="chip ${state.filter === f.id ? 'is-active' : ''}" data-chip="${f.id}">${f.label}<b>${counts[f.id]}</b></button>`).join('');
  }

  // 批量条
  const n = state.selected.size;
  $('#bulkbar').hidden = n === 0;
  $('#bulkNum').textContent = n;
  const allChecked = visibleTorrents().length > 0 && visibleTorrents().every((t) => state.selected.has(t.hash));
  $('#selectAll').checked = allChecked;
}

/* ══════════ 全局速度 / 空间 ══════════ */
function renderServer() {
  const s = state.server || {};
  $('#topDl').textContent = fmtSpeed(s.dl_info_speed || 0);
  $('#topUp').textContent = fmtSpeed(s.up_info_speed || 0);
  $('#topPeers').textContent = s.total_peer_connections ?? 0;
  $('#sideDl').textContent = fmtSpeed(s.dl_info_speed || 0);
  $('#sideUp').textContent = fmtSpeed(s.up_info_speed || 0);

  const free = s.free_space_on_disk || 0;
  const totalSize = state.list.reduce((a, t) => a + (t.size || 0), 0);
  const usedRatio = totalSize + free > 0 ? totalSize / (totalSize + free) : 0;
  $('#sideFree').textContent = fmtBytes(free);
  $('#sideFreeBar').style.width = `${Math.min(100, usedRatio * 100).toFixed(1)}%`;
  $('#sideFreeBar').parentElement.title = `种子占用 ${fmtBytes(totalSize)} · 剩余 ${fmtBytes(free)}`;

  const alt = Boolean(s.use_alt_speed_limits);
  $('#altSpeedBtn').classList.toggle('is-on', alt);
  $('#altSpeedBtn').title = alt ? '备用速度限制：已开启' : '备用速度限制：已关闭';

  const online = s.connection_status === 'connected' || s.connection_status === 'firewalled';
  const conn = $('#connText');
  conn.textContent = online
    ? s.connection_status === 'firewalled' ? '已连接 · 防火墙中' : '已连接'
    : s.connection_status === 'disconnected' ? '未连接' : '连接中…';
  conn.className = online ? 'is-online' : 'is-offline';
}

/* ══════════ 轮询 ══════════ */
let pollTimer = null;
let polling = false;

/**
 * 列表数据只由 /sync/maindata 的增量维护：首帧 rid=0 拿全量（和 info 一样大，但仅此一次），
 * 之后每轮只回变化的字段（几百字节）。全量 /torrents/info 只在首帧之外、遇到未知 hash
 * （增量补不齐）时兜底拉一次——种子多的时候它一次就是近 500KB，没必要每轮都拉。
 */
function applySync(sync) {
  /* 全量更新（首帧或 qB 重连后）就换一张空表，免得留下已经删掉的种子。
     必须把新表写回 state.map —— 之前只在局部变量里换表、只更新 state.list，
     结果 state.map 一直停在初始的空表上：按 hash 查详情的抽屉整块空白，
     多选后 updateRow 也拿不到数据。 */
  if (sync.full_update) state.map = new Map();
  const map = state.map;
  let unknown = false;
  for (const [hash, patch] of Object.entries(sync.torrents || {})) {
    const prev = map.get(hash);
    if (!prev && !sync.full_update) unknown = true; // 没底子的增量，补一次全量更稳妥
    map.set(hash, { ...(prev || {}), ...patch, hash });
  }
  for (const hash of sync.torrents_removed || []) map.delete(hash);
  if (sync.categories) state.categories = { ...state.categories, ...sync.categories };
  if (sync.categories_removed?.length) {
    const next = { ...state.categories };
    for (const c of sync.categories_removed) delete next[c];
    state.categories = next;
  }
  state.list = [...map.values()];
  return unknown;
}

async function refreshFullList() {
  const torrents = await apiJson('/torrents/info');
  if (!Array.isArray(torrents)) throw new Error('bad list');
  state.list = torrents;
  state.map = new Map(torrents.map((t) => [t.hash, t]));
}

async function tick() {
  if (polling) return;
  polling = true;
  try {
    const sync = await apiJson(`/sync/maindata?rid=${state.rid}`);
    if (!sync || typeof sync !== 'object') throw new Error('bad sync');
    const unknown = applySync(sync);
    if (sync.server_state) {
      // 增量响应里 server_state 只包含变化的字段，需要合并
      state.server = { ...state.server, ...sync.server_state };
    }
    if (sync.rid) state.rid = sync.rid;
    if (unknown || !state.list.length) await refreshFullList();
    if (state.pending.size) {
      const now = Date.now();
      for (const [h, p] of state.pending) {
        if (now > p.until) { state.pending.delete(h); continue; }
        const t = state.map.get(h);
        if (t) t.state = p.state;
      }
    }
    state.firstLoad = false;
    try {
      renderRows();
      renderServer();
      ensureKinds();
      if (state.detailHash) refreshDetailShell();
    } catch (err) {
      // 渲染层的 bug 不该被当成「连接断开」，打到控制台方便定位
      console.error('[render]', err);
    }
  } catch (err) {
    if (!err.unauthorized) {
      state.connected = false;
      const conn = $('#connText');
      conn.textContent = '连接断开';
      conn.className = 'is-offline';
    }
  } finally {
    polling = false;
    schedule();
  }
}

function schedule() {
  clearTimeout(pollTimer);
  if (state.pollMs <= 0) return;
  pollTimer = setTimeout(() => {
    if (document.hidden) { schedule(); return; }
    tick();
  }, state.pollMs);
  return pollTimer;
}

let boostTimer = null;
function refreshNow(boost = true) {
  clearTimeout(pollTimer);
  tick();
  if (boost) {
    // 状态切换在 qBittorrent 端是异步的，追加一次快速复查
    clearTimeout(boostTimer);
    boostTimer = setTimeout(() => { clearTimeout(pollTimer); tick(); }, 900);
  }
}

/* ══════════ 交互：列表事件 ══════════ */
rowsEl.addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  const hash = row.dataset.hash;

  if (e.target.closest('.check-wrap')) return; // 交给 change
  if (e.target.closest('[data-act="menu"]')) { openTorrentMenu(hash); return; }
  if (e.target.closest('[data-act="cover"]')) { openCoverModal(hash); return; }
  openDetail(hash);
});

rowsEl.addEventListener('change', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  const hash = row.dataset.hash;
  if (e.target.checked) state.selected.add(hash);
  else state.selected.delete(hash);
  const el = rowCache.get(hash);
  if (el) { el._v.sel = undefined; updateRow(el, state.map.get(hash)); }
  renderCounts();
});

$('#selectAll').addEventListener('change', (e) => {
  const list = visibleTorrents();
  if (e.target.checked) list.forEach((t) => state.selected.add(t.hash));
  else list.forEach((t) => state.selected.delete(t.hash));
  list.forEach((t) => {
    const el = rowCache.get(t.hash);
    if (el) { el._v.sel = undefined; updateRow(el, t); }
  });
  renderCounts();
});

$('#bulkbar').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-bulk]');
  if (!btn) return;
  const action = btn.dataset.bulk;
  const hashes = [...state.selected];
  if (!hashes.length) return;

  try {
    if (action === 'pause') { await setPaused(hashes, true); toast(`已暂停 ${hashes.length} 项`); }
    else if (action === 'resume') { await setPaused(hashes, false); toast(`已恢复 ${hashes.length} 项`); }
    else if (action === 'delete') {
      const r = await confirmDialog({
        title: `删除 ${hashes.length} 个种子？`,
        desc: '种子会从列表中移除，已下载的文件默认保留。',
        okText: '仅删除种子',
        extraText: '同时删除文件',
      });
      if (!r) return;
      await torrentsAction('delete', hashes, { deleteFiles: r === 'extra' ? 'true' : 'false' });
      hashes.forEach((h) => { state.selected.delete(h); });
      toast(`已删除 ${hashes.length} 项`, 'ok');
    } else if (action === 'clear') {
      state.selected.clear();
    }
    refreshNow();
  } catch (err) {
    toast(err.message || '操作失败', 'err');
  }
});

/* 筛选 */
$('#filterNav').addEventListener('click', (e) => {
  const item = e.target.closest('[data-filter]');
  if (!item) return;
  setFilter(item.dataset.filter);
  if (isMobile()) closeSidebar();
});

$('#chips').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-chip]');
  if (chip) setFilter(chip.dataset.chip);
});

function setFilter(f) {
  state.filter = f;
  state.firstLoad = false;
  renderRows();
  $$('#filterNav .nav-item').forEach((el) => el.classList.toggle('is-active', el.dataset.filter === f));
}

$('#catList').addEventListener('click', (e) => {
  const row = e.target.closest('[data-cat]');
  if (!row) return;
  state.category = state.category === row.dataset.cat ? '' : row.dataset.cat;
  state.firstLoad = false;
  renderRows();
  if (isMobile()) closeSidebar();
});

$('#tagList').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-tag]');
  if (!chip) return;
  state.tag = state.tag === chip.dataset.tag ? '' : chip.dataset.tag;
  state.firstLoad = false;
  renderRows();
});

/* 新建分类 */
$('#newCatBtn').addEventListener('click', async (e) => {
  e.stopPropagation();
  const name = window.prompt('新建分类名称');
  if (!name || !name.trim()) return;
  try {
    await post('/torrents/createCategory', { category: name.trim() });
    state.categories = await apiJson('/torrents/categories');
    toast('分类已创建', 'ok');
    renderCounts();
  } catch (err) { toast(err.message, 'err'); }
});

/* 搜索 */
let searchTimer;
$('#searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const v = e.target.value;
  searchTimer = setTimeout(() => {
    state.q = v;
    state.firstLoad = false;
    renderRows();
  }, 120);
});

/* 排序 */
$('#listHead').addEventListener('click', (e) => {
  const col = e.target.closest('[data-sort]');
  if (!col) return;
  const key = col.dataset.sort;
  if (state.sort.key === key) state.sort.dir *= -1;
  else state.sort = { key, dir: key === 'name' || key === 'state' ? 1 : -1 };
  updateSortUI();
  renderRows();
});

function updateSortUI() {
  $$('#listHead .col').forEach((col) => {
    const active = col.dataset.sort === state.sort.key;
    col.classList.toggle('active', active);
    col.classList.toggle('desc', active && state.sort.dir === -1);
  });
}

/* ══════════ 详情面板 ══════════ */
const detailEl = $('#detail');
const detailScrim = $('#detailScrim');

async function openDetail(hash) {
  closeViewer(); // 换种子时别把上一个种子的预览留在屏幕上
  state.detailHash = hash;
  state.detailData = null;
  state.detailTab = 'files';
  state.fileEdit = false; // 换种子就退出编辑态
  detailEl.classList.add('is-open');
  detailEl.setAttribute('aria-hidden', 'false');
  detailScrim.classList.add('is-open');
  renderDetail();
  try {
    const [props, files, trackers] = await Promise.all([
      apiJson(`/torrents/properties?hash=${hash}`),
      apiJson(`/torrents/files?hash=${hash}`),
      apiJson(`/torrents/trackers?hash=${hash}`),
    ]);
    state.detailData = { props, files, trackers };
    renderDetail();
  } catch (err) {
    if (!err.unauthorized) toast(err.message, 'err');
  }
}

function closeDetail() {
  state.detailHash = null;
  state.fileEdit = false;
  closeViewer(); // 详情关了，预览也不该留着
  detailEl.classList.remove('is-open');
  detailEl.setAttribute('aria-hidden', 'true');
  detailScrim.classList.remove('is-open');
}

$('#detailClose').addEventListener('click', closeDetail);
detailScrim.addEventListener('click', closeDetail);

function ringSvg(progress, key) {
  const r = 25;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.min(1, Math.max(0, progress)));
  const color = key === 'seed' ? 'var(--up)' : key === 'pause' ? 'var(--text-mute)' : key === 'err' ? 'var(--danger)' : 'var(--accent)';
  return `<div class="ring">
    <svg viewBox="0 0 62 62">
      <circle class="ring-bg" cx="31" cy="31" r="${r}" fill="none" stroke-width="5"/>
      <circle class="ring-fg" cx="31" cy="31" r="${r}" fill="none" style="stroke:${color}" stroke-width="5"
        stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/>
    </svg>
    <span>${(progress * 100).toFixed(0)}%</span>
  </div>`;
}

/* ══════════ 媒体预览：详情页里直接看图 / 播视频音频 ══════════ */

const MEDIA_KIND_EXTS = {
  video: new Set(['.mp4', '.m4v', '.webm', '.mkv', '.mov', '.m2ts', '.ts', '.avi', '.wmv', '.flv', '.mpg', '.mpeg', '.3gp', '.3g2']),
  audio: new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav', '.aiff', '.aif']),
  image: new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp', '.svg', '.heic', '.heif']),
};

const MEDIA_LABEL = { image: '图片', video: '视频', audio: '音频' };

function mediaKindOf(name) {
  const ext = (String(name).match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
  for (const [kind, set] of Object.entries(MEDIA_KIND_EXTS)) if (set.has(ext)) return kind;
  return '';
}

/** 当前种子里同一类型的文件（图片浏览 / 视频连播就在这个列表里前后翻） */
function mediaFiles(kind) {
  return (state.detailData?.files || []).filter((f) => mediaKindOf(f.name) === kind);
}

function mediaUrl(name, download = false) {
  const q = new URLSearchParams({ hash: state.detailHash || '', name });
  if (download) q.set('download', '1');
  return `/__cover/file?${q}`;
}

let viewerEl = null;
let viewerState = null; // { kind, files, idx, zoom, drag, touch, pinch, lastTap, ... }
const ZOOM_MAX = 6;

function openMediaViewer(kind, startName = '') {
  if (!kind || !state.detailHash) return;
  const files = mediaFiles(kind);
  if (!files.length) return;
  const idx = Math.max(0, files.findIndex((f) => f.name === startName));
  closeViewer();
  viewerState = { kind, files, idx, zoom: null, drag: null, touch: null, pinch: null, lastTap: 0, tapX: 0, tapY: 0, suppressClick: false };
  viewerEl = document.createElement('div');
  viewerEl.className = 'media-viewer';
  viewerEl.setAttribute('role', 'dialog');
  viewerEl.setAttribute('aria-modal', 'true');
  viewerEl.setAttribute('aria-label', `${MEDIA_LABEL[kind] || '媒体'}预览`);
  viewerEl.tabIndex = -1;
  viewerEl.innerHTML = `
    <div class="mv-bar">
      <div class="mv-title">
        <span class="mv-name"></span>
        <span class="mv-sub"></span>
      </div>
      <div class="mv-zoomctl" hidden>
        <button class="mv-btn mv-zoom-btn" type="button" data-zoom="out" aria-label="缩小"><svg><use href="#i-zoom-out"/></svg></button>
        <button class="mv-zoomval" type="button" data-zoom="reset" title="恢复原始大小">100%</button>
        <button class="mv-btn mv-zoom-btn" type="button" data-zoom="in" aria-label="放大"><svg><use href="#i-zoom-in"/></svg></button>
      </div>
      <a class="mv-btn mv-dl" aria-label="下载原文件" title="下载原文件"><svg><use href="#i-download"/></svg></a>
      <button class="mv-btn mv-close" type="button" aria-label="关闭"><svg><use href="#i-x"/></svg></button>
    </div>
    <div class="mv-stage"></div>
    <button class="mv-nav mv-prev" type="button" aria-label="上一个"><svg><use href="#i-chevron-right"/></svg></button>
    <button class="mv-nav mv-next" type="button" aria-label="下一个"><svg><use href="#i-chevron-right"/></svg></button>`;
  document.body.appendChild(viewerEl);
  document.body.classList.add('mv-open');
  const stage = viewerEl.querySelector('.mv-stage');
  viewerEl.addEventListener('click', viewerClick);
  stage.addEventListener('wheel', viewerWheel, { passive: false });
  stage.addEventListener('dblclick', viewerDblClick);
  stage.addEventListener('pointerdown', viewerPointerDown);
  stage.addEventListener('pointermove', viewerPointerMove);
  stage.addEventListener('pointerup', viewerPointerUp);
  stage.addEventListener('pointercancel', viewerPointerUp);
  viewerEl.addEventListener('touchstart', viewerTouchStart, { passive: false });
  viewerEl.addEventListener('touchmove', viewerTouchMove, { passive: false });
  viewerEl.addEventListener('touchend', viewerTouchEnd, { passive: false });
  document.addEventListener('keydown', viewerKey);
  window.addEventListener('resize', viewerResize);
  renderViewer();
  viewerEl.focus({ preventScroll: true });
}

function renderViewer() {
  if (!viewerEl || !viewerState) return;
  const { kind, files, idx } = viewerState;
  const f = files[idx];
  if (!f) return;
  const multi = files.length > 1;
  const url = mediaUrl(f.name);
  const baseName = String(f.name).split('/').pop() || f.name;

  const nameEl = viewerEl.querySelector('.mv-name');
  nameEl.textContent = baseName;
  nameEl.title = f.name;
  const sub = [multi ? `${idx + 1} / ${files.length}` : '', fmtBytes(f.size)];
  if (f.progress != null && f.progress < 1) sub.push(`已下载 ${(f.progress * 100).toFixed(0)}%`);
  viewerEl.querySelector('.mv-sub').textContent = sub.filter(Boolean).join(' · ');
  const dl = viewerEl.querySelector('.mv-dl');
  dl.href = mediaUrl(f.name, true);
  dl.setAttribute('download', baseName);
  viewerEl.querySelector('.mv-prev').hidden = !multi;
  viewerEl.querySelector('.mv-next').hidden = !multi;
  viewerEl.querySelector('.mv-zoomctl').hidden = kind !== 'image';

  const stage = viewerEl.querySelector('.mv-stage');
  stage.innerHTML = '';
  stage.classList.remove('is-loading');
  viewerState.drag = null;
  viewerState.touch = null;
  viewerState.pinch = null;
  viewerState.zoom = kind === 'image' ? { s: 1, x: 0, y: 0 } : null;
  let el;

  if (kind === 'video') {
    el = document.createElement('video');
    el.controls = true;
    el.autoplay = true;
    el.playsInline = true;
    el.preload = 'metadata';
    el.src = url;
    el.addEventListener('error', () => {
      if (el.isConnected) viewerFallback('浏览器无法直接播放这个视频。MKV / HEVC / 杜比视界等格式通常需要转码，可以下载后用本地播放器打开。');
    });
    // 缓冲提示：一开始就显示，能播后消失；中途卡顿再出现
    const buffering = document.createElement('div');
    buffering.className = 'mv-buffering is-on';
    buffering.innerHTML = '<i></i><span>缓冲中…</span>';
    stage.appendChild(buffering);
    const showBuf = () => buffering.classList.add('is-on');
    const hideBuf = () => buffering.classList.remove('is-on');
    el.addEventListener('canplay', hideBuf);
    el.addEventListener('playing', hideBuf);
    el.addEventListener('waiting', showBuf);
    el.addEventListener('stalled', showBuf);
  } else if (kind === 'audio') {
    el = document.createElement('audio');
    el.controls = true;
    el.autoplay = true;
    el.src = url;
    el.addEventListener('error', () => {
      if (el.isConnected) viewerFallback('浏览器无法播放这个音频，可能还没下载完成，或编码不受支持。');
    });
  } else {
    const wrap = document.createElement('div');
    wrap.className = 'mv-zoom';
    el = document.createElement('img');
    el.alt = f.name;
    el.decoding = 'async';
    el.draggable = false;
    el.src = url;
    wrap.appendChild(el);
    stage.classList.add('is-loading');
    el.addEventListener('load', () => {
      stage.classList.remove('is-loading');
      if (viewerState?.zoom) { clampZoom(); applyZoom(); }
    });
    el.addEventListener('error', () => {
      if (el.isConnected) viewerFallback('这张图片无法显示：可能还没下载完，或浏览器不支持该格式（例如 HEIC）。可以下载后用本地应用打开。');
    });
    stage.appendChild(wrap);
    applyZoom();
  }
  if (kind !== 'image') stage.appendChild(el);

  // 预加载前后两张，翻页时不用等
  if (kind === 'image' && multi) {
    for (const d of [-1, 1]) {
      const n = files[(idx + d + files.length) % files.length];
      if (n) { const im = new Image(); im.src = mediaUrl(n.name); }
    }
  }
}

/* ── 图片缩放 / 平移 ─────────────────────────────────── */

function applyZoom() {
  if (!viewerEl || !viewerState?.zoom) return;
  const z = viewerState.zoom;
  const wrap = viewerEl.querySelector('.mv-zoom');
  if (wrap) wrap.style.transform = `translate3d(${z.x.toFixed(1)}px, ${z.y.toFixed(1)}px, 0) scale(${z.s.toFixed(4)})`;
  viewerEl.classList.toggle('is-zoomed', z.s > 1.001);
  const val = viewerEl.querySelector('.mv-zoomval');
  if (val) val.textContent = `${Math.round(z.s * 100)}%`;
  for (const btn of viewerEl.querySelectorAll('[data-zoom]')) {
    if (btn.dataset.zoom === 'in') btn.disabled = z.s >= ZOOM_MAX - 0.001;
    else if (btn.dataset.zoom === 'out') btn.disabled = z.s <= 1.001;
  }
}

function clampZoom(z = viewerState?.zoom) {
  if (!z) return;
  z.s = Math.min(ZOOM_MAX, Math.max(1, z.s));
  if (z.s <= 1.001) {
    z.s = 1;
    z.x = 0;
    z.y = 0;
    return;
  }
  const stage = viewerEl?.querySelector('.mv-stage');
  const img = stage?.querySelector('.mv-zoom img');
  const maxX = stage && img ? Math.max(0, (img.offsetWidth * z.s - stage.clientWidth) / 2) : 0;
  const maxY = stage && img ? Math.max(0, (img.offsetHeight * z.s - stage.clientHeight) / 2) : 0;
  z.x = Math.min(maxX, Math.max(-maxX, z.x));
  z.y = Math.min(maxY, Math.max(-maxY, z.y));
}

function zoomAt(next, clientX, clientY) {
  if (!viewerEl || !viewerState?.zoom) return;
  const stage = viewerEl.querySelector('.mv-stage');
  if (!stage) return;
  const rect = stage.getBoundingClientRect();
  const mx = clientX - (rect.left + rect.width / 2);
  const my = clientY - (rect.top + rect.height / 2);
  const z = viewerState.zoom;
  const u = (mx - z.x) / z.s;
  const v = (my - z.y) / z.s;
  z.s = Math.min(ZOOM_MAX, Math.max(1, next));
  if (z.s <= 1.001) {
    z.s = 1;
    z.x = 0;
    z.y = 0;
  } else {
    z.x = mx - u * z.s;
    z.y = my - v * z.s;
    clampZoom(z);
  }
  applyZoom();
}

function zoomBy(factor) {
  if (!viewerEl || !viewerState?.zoom) return;
  const stage = viewerEl.querySelector('.mv-stage');
  if (!stage) return;
  const rect = stage.getBoundingClientRect();
  zoomAt(viewerState.zoom.s * factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
}

function resetZoom() {
  if (!viewerState?.zoom) return;
  viewerState.zoom = { s: 1, x: 0, y: 0 };
  applyZoom();
}

function viewerResize() {
  if (!viewerState?.zoom) return;
  clampZoom();
  applyZoom();
}

/* ── 预览交互 ─────────────────────────────────────────── */

function viewerFallback(message) {
  if (!viewerEl || !viewerState) return;
  const f = viewerState.files[viewerState.idx];
  const stage = viewerEl.querySelector('.mv-stage');
  stage.classList.remove('is-loading');
  stage.innerHTML = `
    <div class="mv-fallback">
      <svg><use href="#i-alert"/></svg>
      <p>${esc(message)}</p>
      <div class="mv-fallback-actions">
        <a class="btn btn-soft btn-sm" href="${mediaUrl(f.name, true)}" download>下载文件</a>
        <a class="btn btn-ghost btn-sm" href="${mediaUrl(f.name)}" target="_blank" rel="noopener">新标签打开</a>
      </div>
    </div>`;
}

function stepViewer(delta) {
  if (!viewerState || viewerState.files.length < 2) return;
  const n = viewerState.files.length;
  viewerState.idx = (viewerState.idx + delta + n) % n;
  renderViewer();
}

function suppressNextClick() {
  if (!viewerState) return;
  viewerState.suppressClick = true;
  clearTimeout(viewerState.suppressTimer);
  // 防止 preventDefault 没触发 click 时把后续真正的点击也吞掉
  viewerState.suppressTimer = setTimeout(() => { if (viewerState) viewerState.suppressClick = false; }, 500);
}

function viewerClick(ev) {
  if (viewerState?.suppressClick) { viewerState.suppressClick = false; return; }
  const zoomBtn = ev.target.closest('[data-zoom]');
  if (zoomBtn) {
    if (zoomBtn.dataset.zoom === 'in') zoomBy(1.5);
    else if (zoomBtn.dataset.zoom === 'out') zoomBy(1 / 1.5);
    else resetZoom();
    return;
  }
  if (ev.target.closest('.mv-close')) { closeViewer(); return; }
  if (ev.target.closest('.mv-prev')) { stepViewer(-1); return; }
  if (ev.target.closest('.mv-next')) { stepViewer(1); return; }
  if (ev.target === viewerEl || ev.target.classList.contains('mv-stage')) closeViewer();
}

function viewerKey(ev) {
  if (!viewerState) return;
  if (ev.key === 'Escape') {
    ev.preventDefault();
    closeViewer();
    return;
  }
  if (viewerState.kind === 'image') {
    if (ev.key === '+' || ev.key === '=') { ev.preventDefault(); zoomBy(1.4); return; }
    if (ev.key === '-' || ev.key === '_') { ev.preventDefault(); zoomBy(1 / 1.4); return; }
    if (ev.key === '0') { ev.preventDefault(); resetZoom(); return; }
  }
  if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
    const tag = document.activeElement?.tagName;
    if (tag === 'VIDEO' || tag === 'AUDIO') return; // 让播放器自己快进 / 快退
    if (viewerState.files.length < 2) return;
    ev.preventDefault();
    stepViewer(ev.key === 'ArrowLeft' ? -1 : 1);
  }
}

function viewerWheel(ev) {
  if (!viewerState || viewerState.kind !== 'image') return;
  ev.preventDefault();
  const d = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaMode === 2 ? ev.deltaY * 120 : ev.deltaY;
  if (!d) return;
  zoomAt(viewerState.zoom.s * Math.exp(-d * 0.0015), ev.clientX, ev.clientY);
}

function viewerDblClick(ev) {
  if (!viewerState || viewerState.kind !== 'image') return;
  if (viewerState.zoom.s > 1.001) resetZoom();
  else zoomAt(2.5, ev.clientX, ev.clientY);
}

function viewerPointerDown(ev) {
  if (!viewerState || viewerState.kind !== 'image' || viewerState.zoom.s <= 1.001) return;
  if (ev.pointerType && ev.pointerType !== 'mouse') return;
  if (ev.button != null && ev.button !== 0) return;
  viewerState.drag = { x: viewerState.zoom.x, y: viewerState.zoom.y, cx: ev.clientX, cy: ev.clientY, moved: false };
  try { ev.currentTarget.setPointerCapture?.(ev.pointerId); } catch { /* 合成事件或指针已释放 */ }
  viewerEl.classList.add('is-dragging');
  ev.preventDefault();
}

function viewerPointerMove(ev) {
  const d = viewerState?.drag;
  if (!d) return;
  const dx = ev.clientX - d.cx;
  const dy = ev.clientY - d.cy;
  if (Math.abs(dx) + Math.abs(dy) > 4) { d.moved = true; suppressNextClick(); }
  const z = viewerState.zoom;
  z.x = d.x + dx;
  z.y = d.y + dy;
  clampZoom(z);
  applyZoom();
  ev.preventDefault();
}

function viewerPointerUp(ev) {
  if (!viewerState?.drag) return;
  viewerState.drag = null;
  viewerEl.classList.remove('is-dragging');
  try { ev.currentTarget.releasePointerCapture?.(ev.pointerId); } catch { /* 已经释放 */ }
}

function viewerTouchStart(ev) {
  if (!viewerState || viewerState.kind !== 'image') return;
  if (ev.target.closest?.('.mv-bar, .mv-nav')) return;
  const z = viewerState.zoom;
  if (ev.touches.length === 2) {
    const [a, b] = ev.touches;
    const rect = viewerEl.querySelector('.mv-stage').getBoundingClientRect();
    viewerState.pinch = {
      d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
      s: z.s,
      x: z.x,
      y: z.y,
      cx: (a.clientX + b.clientX) / 2 - (rect.left + rect.width / 2),
      cy: (a.clientY + b.clientY) / 2 - (rect.top + rect.height / 2),
    };
    viewerState.touch = null;
    suppressNextClick();
    ev.preventDefault();
    return;
  }
  if (ev.touches.length !== 1) return;
  const t = ev.touches[0];
  viewerState.touch = { x: t.clientX, y: t.clientY, panX: z.x, panY: z.y, moved: false };
}

function viewerTouchMove(ev) {
  if (!viewerState || viewerState.kind !== 'image') return;
  if (ev.target.closest?.('.mv-bar, .mv-nav')) return;
  const z = viewerState.zoom;
  if (viewerState.pinch && ev.touches.length >= 2) {
    const [a, b] = ev.touches;
    const p = viewerState.pinch;
    const rect = viewerEl.querySelector('.mv-stage').getBoundingClientRect();
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
    const cx = (a.clientX + b.clientX) / 2 - (rect.left + rect.width / 2);
    const cy = (a.clientY + b.clientY) / 2 - (rect.top + rect.height / 2);
    const u = (p.cx - p.x) / p.s;
    const v = (p.cy - p.y) / p.s;
    z.s = Math.min(ZOOM_MAX, Math.max(1, p.s * d / p.d));
    z.x = cx - u * z.s;
    z.y = cy - v * z.s;
    clampZoom(z);
    applyZoom();
    ev.preventDefault();
    return;
  }
  const tr = viewerState.touch;
  if (!tr || ev.touches.length !== 1) return;
  const t = ev.touches[0];
  const dx = t.clientX - tr.x;
  const dy = t.clientY - tr.y;
  if (Math.abs(dx) + Math.abs(dy) > 6) tr.moved = true;
  if (z.s > 1.001) {
    z.x = tr.panX + dx;
    z.y = tr.panY + dy;
    clampZoom(z);
    applyZoom();
    suppressNextClick();
    ev.preventDefault();
  }
}

function viewerTouchEnd(ev) {
  if (!viewerState || viewerState.kind !== 'image') return;
  if (ev.target.closest?.('.mv-bar, .mv-nav')) return;
  if (viewerState.pinch) {
    if (ev.touches.length < 2) {
      viewerState.pinch = null;
      viewerState.lastTap = 0;
      suppressNextClick();
    }
    return;
  }
  const tr = viewerState.touch;
  if (!tr) return;
  const z = viewerState.zoom;
  const t = ev.changedTouches[0];
  const dx = t.clientX - tr.x;
  const dy = t.clientY - tr.y;
  const moved = tr.moved || Math.abs(dx) > 10 || Math.abs(dy) > 10;
  viewerState.touch = null;
  if (moved) {
    suppressNextClick();
    ev.preventDefault();
    if (z.s <= 1.001 && Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.2) stepViewer(dx < 0 ? 1 : -1);
    return;
  }
  // 双击 / 双指之外的轻点：桌面用滚轮或按钮，手机用双击放大
  const now = Date.now();
  if (now - viewerState.lastTap < 300 && Math.hypot(t.clientX - viewerState.tapX, t.clientY - viewerState.tapY) < 40) {
    viewerState.lastTap = 0;
    suppressNextClick();
    if (z.s > 1.001) resetZoom();
    else zoomAt(2.5, t.clientX, t.clientY);
    return;
  }
  viewerState.lastTap = now;
  viewerState.tapX = t.clientX;
  viewerState.tapY = t.clientY;
}

function closeViewer() {
  if (!viewerEl) return;
  const el = viewerEl;
  viewerEl = null;
  viewerState = null;
  el.remove(); // 移除 DOM 即停掉播放、释放解码器
  document.body.classList.remove('mv-open');
  document.removeEventListener('keydown', viewerKey);
  window.removeEventListener('resize', viewerResize);
}

/**
 * 文件页顶部的「预览图片 / 预览视频」入口。
 * 图片集里通常有几十上百张，只靠一个个点文件名翻太累，所以这里按类型做前一 / 后一。
 */
function mediaBarHtml(files) {
  const counts = { image: 0, video: 0, audio: 0 };
  for (const f of files) {
    const k = mediaKindOf(f.name);
    if (k) counts[k]++;
  }
  const btn = (kind, icon, label) => (counts[kind]
    ? `<button class="d-media-btn" type="button" data-browse="${kind}"><svg><use href="#${icon}"/></svg><span>${label}</span><b>${counts[kind]}</b></button>`
    : '');
  const html = btn('image', 'i-image', '预览图片') + btn('video', 'i-play', '预览视频') + btn('audio', 'i-music', '预览音频');
  return html ? `<div class="d-media-bar">${html}</div>` : '';
}

function refreshDetailShell() {
  const t = state.map.get(state.detailHash);
  if (!t) return;
  const el = $('#detailBody');
  if (!el) return;
  // 只更新速度/进度文字，避免整块重绘打断滚动
  const hero = el.querySelector('.d-hero');
  if (hero) {
    const p = t.progress;
    const ringFg = hero.querySelector('.ring-fg');
    if (ringFg) {
      const r = 25;
      const c = 2 * Math.PI * r;
      ringFg.setAttribute('stroke-dashoffset', (c * (1 - Math.min(1, Math.max(0, p)))).toFixed(1));
    }
    const pctEl = hero.querySelector('.ring span');
    if (pctEl) pctEl.textContent = `${(p * 100).toFixed(0)}%`;
    const dl = hero.querySelector('.v-dl');
    const up = hero.querySelector('.v-up');
    if (dl) dl.textContent = fmtSpeed(t.dlspeed);
    if (up) up.textContent = fmtSpeed(t.upspeed);
  }
}

function renderDetail() {
  const hash = state.detailHash;
  const t = state.map.get(hash);
  if (!t) return;
  const st = statusOf(t);

  $('#detailName').textContent = t.name;
  $('#detailBadge').innerHTML = `<span class="pill ${st.key}"><i></i>${st.label}</span>${
    t.category ? `<span class="badge-cat">${esc(t.category)}</span>` : ''
  }`;

  const data = state.detailData;
  const body = $('#detailBody');
  const prevScroll = body.scrollTop;

  const files = data?.files || [];
  const trackers = (data?.trackers || []).filter((x) => x.url && !/^\*\*/.test(x.url));
  const props = data?.props || null;

  let tabsHtml = '';
  if (data) {
    tabsHtml = `
      <div class="d-tabs">
        <button class="d-tab ${state.detailTab === 'files' ? 'is-active' : ''}" data-tab="files">文件 ${files.length}</button>
        <button class="d-tab ${state.detailTab === 'trackers' ? 'is-active' : ''}" data-tab="trackers">Tracker ${trackers.length}</button>
        <button class="d-tab ${state.detailTab === 'info' ? 'is-active' : ''}" data-tab="info">信息</button>
      </div>`;
  }

  let tabContent = '';
  if (data) {
    if (state.detailTab === 'files') {
      // 勾选默认锁着：文件列表一排方框太容易被误点（尤其手机上）
      const editing = state.fileEdit;
      const skipped = files.filter((f) => f.priority === 0).length;
      const filesBar = files.length
        ? `<div class="d-files-bar">
            <span class="d-files-sum">${files.length} 个文件${skipped ? ` · 已跳过 ${skipped}` : ''}</span>
            <button class="btn btn-ghost btn-sm d-file-edit${editing ? ' is-on' : ''}" id="fileEditBtn" type="button">
              <svg><use href="#${editing ? 'i-check' : 'i-list'}"/></svg>${editing ? '完成' : '修改下载列表'}
            </button>
          </div>`
        : '';
      tabContent = files.length
        ? mediaBarHtml(files) + filesBar + files.map((f, i) => {
          const kind = mediaKindOf(f.name);
          const done = f.progress >= 1;
          return `
          <div class="file-row${done ? '' : ' is-partial'}${f.priority === 0 ? ' is-skip' : ''}">
            <button class="f-toggle ${f.priority > 0 ? 'on' : ''}" data-file="${i}" data-priority="${f.priority}" type="button"
              ${editing ? '' : 'disabled'} aria-label="${f.priority > 0 ? '跳过' : '恢复'}该文件">
              <svg><use href="#i-check"/></svg>
            </button>
            <span class="f-name ${f.priority === 0 ? 'is-skip' : ''} ${kind ? 'is-media' : ''}" ${kind ? `data-media="${i}" title="点击预览"` : ''}>${esc(f.name)}</span>
            <span class="f-size">${fmtBytes(f.size)}</span>
            <span class="f-prog">${(f.progress * 100).toFixed(0)}%</span>
          </div>`;
        }).join('')
        : '<div class="d-empty">暂无文件信息</div>';
    } else if (state.detailTab === 'trackers') {
      tabContent = trackers.length
        ? trackers.map((tr) => {
          const s = tr.status;
          const cls = s === 2 ? 'tr-ok' : s === 1 || s === 0 ? 'tr-warn' : 'tr-err';
          const txt = s === 2 ? '工作中' : s === 1 ? '未联系' : s === 0 ? '已禁用' : '错误';
          return `<div class="tr-row"><span class="tr-status ${cls}">●</span><span class="tr-url">${esc(tr.url)}</span><span class="tr-status ${cls}">${txt}</span></div>`;
        }).join('')
        : '<div class="d-empty">暂无 Tracker</div>';
    } else {
      tabContent = `
        <div class="kv-grid">
          <div class="kv"><span>保存路径</span><b>${esc(t.save_path || t.download_path || '—')}</b></div>
          <div class="kv"><span>种子大小</span><b>${fmtBytes(t.size)}</b></div>
          <div class="kv"><span>已下载</span><b>${fmtBytes(t.downloaded)}</b></div>
          <div class="kv"><span>已上传</span><b>${fmtBytes(t.uploaded)}</b></div>
          <div class="kv"><span>分享率</span><b>${(t.ratio || 0).toFixed(2)}</b></div>
          <div class="kv"><span>可用性</span><b>${(t.availability ?? 0).toFixed(2)}</b></div>
          <div class="kv"><span>做种 / 用户</span><b>${t.num_seeds} / ${t.num_leechs}</b></div>
          <div class="kv"><span>已连接</span><b>${props ? `${props.seeds} 做种 · ${props.peers} 下载` : '—'}</b></div>
          <div class="kv"><span>添加时间</span><b>${fmtDate(t.added_on)}</b></div>
          <div class="kv"><span>完成时间</span><b>${isComplete(t) ? fmtDate(t.completion_on) : '—'}</b></div>
          <div class="kv"><span>活跃时间</span><b>${fmtDuration(t.time_active)}</b></div>
          <div class="kv"><span>做种时间</span><b>${fmtDuration(t.seeding_time)}</b></div>
          <div class="kv"><span>下载 / 上传限速</span><b>${t.dl_limit ? fmtBytes(t.dl_limit) + '/s' : '不限'} / ${t.up_limit ? fmtBytes(t.up_limit) + '/s' : '不限'}</b></div>
          <div class="kv"><span>哈希</span><b>${t.hash.slice(0, 16)}…</b></div>
          ${props ? `<div class="kv"><span>分块</span><b>${props.pieces_have} / ${props.pieces_num} · ${fmtBytes(props.piece_size)}</b></div>` : ''}
          ${t.comment ? `<div class="kv"><span>备注</span><b>${esc(t.comment)}</b></div>` : ''}
        </div>`;
    }
  } else {
    tabContent = '<div class="sk-row"></div><div class="sk-row"></div><div class="sk-row"></div>';
  }

  body.innerHTML = `
    <div class="d-hero">
      <div class="d-cover" data-detail="cover" title="封面•刮削"><img alt="" loading="lazy" decoding="async" /><svg><use href="#i-inbox"/></svg></div>
      ${ringSvg(t.progress, st.key)}
      <div class="d-hero-info">
        <div class="d-speed">
          <span><svg><use href="#i-download"/></svg><i class="v-dl">${fmtSpeed(t.dlspeed)}</i></span>
          <span><svg><use href="#i-upload"/></svg><i class="v-up">${fmtSpeed(t.upspeed)}</i></span>
        </div>
        <div class="d-speed" style="color:var(--text-mute);font-size:11.5px">
          <span>${fmtBytes(t.downloaded || 0)} / ${fmtBytes(t.size)}</span>
          <span>${isComplete(t) ? '分享率 ' + (t.ratio || 0).toFixed(2) : '剩余 ' + fmtEta(t.eta)}</span>
        </div>
      </div>
    </div>
    ${tabsHtml}
    ${tabContent}
  `;
  const dCover = body.querySelector('.d-cover');
  if (dCover) {
    const k = coverKind(t);
    dCover.className = `d-cover k-${k.cls}${state.coverOn ? '' : ' is-off'}`;
    dCover.querySelector('use').setAttribute('href', `#${k.icon}`);
    const img = dCover.querySelector('img');
    img.addEventListener('load', () => dCover.classList.add('has-img'));
    img.addEventListener('error', () => dCover.classList.remove('has-img'));
    const mode = state.coverMode.get(hash);
    const forced = mode === 'custom' || mode === 'tvdb';
    if (state.coverOn && mode !== 'icon' && (forced || state.coverFlag.get(hash) === 1)) img.src = coverUrl(hash);
  }
  body.scrollTop = prevScroll;

  // 底部操作
  const paused = isPaused(t);
  $('#detailFoot').innerHTML = `
    <button class="btn btn-soft" data-detail="toggle">${paused ? '<svg><use href="#i-play"/></svg>继续' : '<svg><use href="#i-pause"/></svg>暂停'}</button>
    <button class="btn btn-ghost" data-detail="cover"><svg><use href="#i-photo"/></svg>封面•刮削</button>
    <button class="btn btn-ghost" data-detail="menu"><svg><use href="#i-more"/></svg>更多</button>
    <button class="btn btn-ghost danger" data-detail="delete"><svg><use href="#i-trash"/></svg>删除</button>
  `;
}

$('#detailBody').addEventListener('click', async (e) => {
  const browseBtn = e.target.closest('[data-browse]');
  if (browseBtn) {
    openMediaViewer(browseBtn.dataset.browse);
    return;
  }
  const mediaEl = e.target.closest('[data-media]');
  if (mediaEl) {
    const f = (state.detailData?.files || [])[Number(mediaEl.dataset.media)];
    if (f) openMediaViewer(mediaKindOf(f.name), f.name);
    return;
  }
  if (e.target.closest('[data-detail="cover"]')) { openCoverModal(state.detailHash); return; }
  const editBtn = e.target.closest('#fileEditBtn');
  if (editBtn) {
    state.fileEdit = !state.fileEdit;
    renderDetail();
    return;
  }
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    state.detailTab = tab.dataset.tab;
    renderDetail();
    return;
  }
  const fileBtn = e.target.closest('[data-file]');
  if (fileBtn) {
    const idx = Number(fileBtn.dataset.file);
    const nextPrio = Number(fileBtn.dataset.priority) === 0 ? 1 : 0;
    try {
      await post('/torrents/filePrio', { hash: state.detailHash, id: idx, priority: nextPrio });
      const files = await apiJson(`/torrents/files?hash=${state.detailHash}`);
      if (state.detailData) state.detailData.files = files;
      renderDetail();
    } catch (err) { toast(err.message, 'err'); }
  }
});

$('#detailFoot').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-detail]');
  if (!btn) return;
  const t = state.map.get(state.detailHash);
  if (!t) return;
  const act = btn.dataset.detail;
  try {
    if (act === 'toggle') {
      await setPaused([t.hash], !isPaused(t));
      toast(isPaused(t) ? '已继续' : '已暂停', 'ok');
      refreshNow();
    } else if (act === 'delete') {
      const r = await confirmDialog({
        title: '删除这个种子？',
        desc: t.name,
        okText: '仅删除种子',
        extraText: '同时删除文件',
      });
      if (!r) return;
      await torrentsAction('delete', [t.hash], { deleteFiles: r === 'extra' ? 'true' : 'false' });
      closeDetail();
      toast('已删除', 'ok');
      refreshNow();
    } else if (act === 'menu') {
      openTorrentMenu(t.hash);
    } else if (act === 'cover') {
      openCoverModal(t.hash);
    }
  } catch (err) { toast(err.message, 'err'); }
});

/* ══════════ 操作菜单 ══════════ */
function openSheet(html, title = '') {
  $('#actionList').innerHTML = html;
  const head = $('#sheetTitle');
  head.textContent = title;
  head.title = title;
  openModal('actionModal');
}

function openTorrentMenu(hash) {
  const t = state.map.get(hash);
  if (!t) return;
  const paused = isPaused(t);
  openSheet(`
    <button class="action-item" data-menu="toggle"><svg><use href="#${paused ? 'i-play' : 'i-pause'}"/></svg>${paused ? '继续下载' : '暂停'}</button>
    <button class="action-item" data-menu="force"><svg><use href="#i-activity"/></svg>${t.force_start ? '取消强制开始' : '强制开始'}</button>
    <button class="action-item" data-menu="seq"><svg><use href="#i-list"/></svg>${t.seq_dl ? '关闭顺序下载' : '顺序下载'}</button>
    <button class="action-item" data-menu="cat"><svg><use href="#i-folder"/></svg>设置分类<small>${esc(t.category || '未分类')}</small></button>
    <button class="action-item" data-menu="cover"><svg><use href="#i-photo"/></svg>封面•刮削<small>自定义 / 目录 / TVDB</small></button>
    <button class="action-item" data-menu="recheck"><svg><use href="#i-refresh"/></svg>重新校验</button>
    <button class="action-item" data-menu="reannounce"><svg><use href="#i-wifi"/></svg>重新通告 Tracker</button>
    <button class="action-item danger" data-menu="delete"><svg><use href="#i-trash"/></svg>删除种子</button>
  `, t.name);
  $('#actionList')._hash = hash;
}

$('#actionList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-menu]');
  if (!btn) return;
  const hash = $('#actionList')._hash;
  const t = state.map.get(hash);
  if (!t) return;
  const act = btn.dataset.menu;

  if (act === 'cat') { openCategorySheet(hash); return; }
  if (act === 'cover') { closeModal('actionModal'); openCoverModal(hash); return; }

  closeModal('actionModal');
  try {
    if (act === 'toggle') await setPaused([hash], !isPaused(t));
    else if (act === 'force') await post('/torrents/setForceStart', { hashes: hash, value: t.force_start ? 'false' : 'true' });
    else if (act === 'seq') await post('/torrents/toggleSequentialDownload', { hashes: hash });
    else if (act === 'recheck') await post('/torrents/recheck', { hashes: hash });
    else if (act === 'reannounce') await post('/torrents/reannounce', { hashes: hash });
    else if (act === 'delete') {
      const r = await confirmDialog({
        title: '删除这个种子？', desc: t.name, okText: '仅删除种子', extraText: '同时删除文件',
      });
      if (!r) return;
      await torrentsAction('delete', [hash], { deleteFiles: r === 'extra' ? 'true' : 'false' });
      if (state.detailHash === hash) closeDetail();
      toast('已删除', 'ok');
    }
    refreshNow();
  } catch (err) { toast(err.message, 'err'); }
});

function openCategorySheet(hash) {
  const t = state.map.get(hash);
  const list = Object.keys(state.categories || {}).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  openSheet(`
    <button class="action-item" data-setcat=""><svg><use href="#i-inbox"/></svg>未分类</button>
    ${list.map((c) => `<button class="action-item" data-setcat="${esc(c)}"><svg><use href="#i-folder"/></svg>${esc(c)}${t.category === c ? '<small>当前</small>' : ''}</button>`).join('')}
  `, t.name);
  $('#actionList')._hash = hash;
}

$('#actionList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-setcat]');
  if (!btn) return;
  const hash = $('#actionList')._hash;
  closeModal('actionModal');
  try {
    await post('/torrents/setCategory', { hashes: hash, category: btn.dataset.setcat });
    toast('分类已更新', 'ok');
    refreshNow();
  } catch (err) { toast(err.message, 'err'); }
});

/* ══════════ 封面：上传 / 挑选 / 图标 ══════════ */
let coverHash = null;

async function coverPost(path, body, hash = coverHash) {
  const res = await fetch(`${path}?hash=${hash}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || '操作失败');
  return data;
}

async function uploadCoverFile(hash, file, quiet = false) {
  if (!/^image\//.test(file.type)) { toast('请选择图片文件', 'err'); return false; }
  if (file.size > 8 * 1024 * 1024) { toast('图片请控制在 8MB 以内', 'err'); return false; }
  try {
    const res = await fetch(`/__cover/upload?hash=${hash}`, { method: 'POST', body: file });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || '上传失败');
    state.coverMode.set(hash, 'custom');
    bumpCover(hash);
    if (coverHash === hash) afterCoverChange(hash);
    else if (!quiet) toast('封面已设置', 'ok');
    return true;
  } catch (err) {
    toast(err.message || '封面上传失败', 'err');
    return false;
  }
}

/** 后端按文件权重视定的类型回填；变了就重画这一行 */
function setCoverKind(hash, kind) {
  if (!kind || state.coverKind.get(hash) === kind) return;
  state.coverKind.set(hash, kind);
  state.kindAsked.add(hash);
  const el = rowCache.get(hash);
  if (el) el._v.coverKey = null;
  renderRows();
  if (coverHash === hash) paintCoverBig();
}

/** 弹窗里把判定依据摆出来，方便看出「为什么是这个图标」 */
function showCoverKind(hash, weights) {
  const el = $('#coverKind');
  if (!el) return;
  const meta = KIND_META[state.coverKind.get(hash) || 'other'] || KIND_META.other;
  const w = weights || {};
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  let detail = '';
  if (total > 0) {
    const top = Object.entries(w).sort((a, b) => b[1] - a[1])[0];
    detail = ` · 体积占 ${Math.round((top[1] / total) * 100)}%`;
  }
  el.textContent = `判定类型：${meta.label}${detail}`;
}

function paintCoverBig() {
  const t = state.map.get(coverHash);
  if (!t) return;
  const k = coverKind(t);
  const box = $('#coverBig');
  box.className = `cover-big k-${k.cls}`;
  box.innerHTML = `<img alt="" /><svg><use href="#${k.icon}"/></svg>`;
  const img = box.querySelector('img');
  img.addEventListener('load', () => box.classList.add('has-img'));
  img.addEventListener('error', () => box.classList.remove('has-img'));
  if (state.coverMode.get(coverHash) === 'icon') img.removeAttribute('src');
  else img.src = coverUrl(coverHash);
}

function afterCoverChange(hash = coverHash) {
  bumpCover(hash);
  paintCoverBig();
  loadCoverCandidates(hash);
  refreshMediaTitles(); // 刮削 / 放弃都可能改媒体名，列表标题跟着变
}

async function loadCoverCandidates(hash) {
  let data = null;
  try {
    data = await fetch(`/__cover/candidates?hash=${hash}`).then((r) => r.json());
  } catch { /* 下面统一处理 */ }
  if (coverHash !== hash) return; // 已经切到别的种子
  const grid = $('#coverGrid');
  if (!data || data.error) {
    $('#coverMode').textContent = '目录不可用';
    $('#coverDir').textContent = '';
    $('#coverCount').textContent = '';
    grid.innerHTML = '<div class="cover-empty">读取不到这个种子的目录</div>';
    return;
  }
  state.coverMode.set(hash, data.mode);
  if (data.kind) setCoverKind(hash, data.kind);
  showCoverKind(hash, data.weights);
  if (!data.dir) {
    // 单文件种子直接躺在共享下载目录里：不去扫别人的图，直接引导上传
    $('#coverMode').textContent = data.mode === 'custom' ? '当前：自定义图片' : '当前：类型图标';
    $('#coverDir').textContent = '没有独立目录';
    $('#coverCount').textContent = '';
    grid.innerHTML = '<div class="cover-empty">这个种子没有独立目录，为避免误用同目录下别人的图片，目录匹配已跳过。<br>可以自己上传一张。</div>';
    paintCoverBig();
    return;
  }
  $('#coverMode').textContent =
    data.mode === 'custom' ? '当前：自定义图片'
      : data.mode === 'tvdb' ? `当前：TheTVDB 刮削${data.tvdb?.year ? `（${data.tvdb.year}）` : ''}`
        : data.mode === 'icon' ? '当前：类型图标'
          : '当前：自动（目录图片 → 类型图标）';
  $('#coverDir').textContent = shortPath(data.dir);
  $('#coverCount').textContent = data.count ? `${data.count} 张` : '目录里没找到图片';
  grid.innerHTML = data.items.length
    ? data.items.map((it) => `
      <button class="cover-item" data-rel="${esc(it.rel)}" title="${esc(it.name)}">
        <img src="/__cover/raw?hash=${hash}&rel=${encodeURIComponent(it.rel)}" alt="" loading="lazy" decoding="async" />
        <span>${esc(it.name)}</span>
      </button>`).join('')
    : '<div class="cover-empty">这个种子的目录里没有可用图片，可以自己上传一张</div>';
  paintCoverBig();
}

async function openCoverModal(hash) {
  const t = state.map.get(hash);
  if (!t) return;
  coverHash = hash;
  $('#coverName').textContent = t.name;
  $('#coverName').title = t.name;
  $('#coverMode').textContent = '读取中…';
  $('#coverDir').textContent = '';
  $('#coverCount').textContent = '';
  $('#coverGrid').innerHTML = '<div class="cover-skel"></div><div class="cover-skel"></div><div class="cover-skel"></div><div class="cover-skel"></div>';
  $('#tvdbQuery').value = '';
  $('#tvdbType').value = '';
  $('#tvdbGrid').innerHTML = '';
  $('#coverTvdbName').textContent = '';
  tvdbSetHint('—');
  paintCoverBig();
  openModal('coverModal');
  loadCoverCandidates(hash);
  loadTvdbPanel(hash);
}

$('#coverUpload').addEventListener('click', () => $('#coverFile').click());
$('#coverFile').addEventListener('change', async (e) => {
  const file = (e.target.files || [])[0];
  e.target.value = '';
  if (!file || !coverHash) return;
  await uploadCoverFile(coverHash, file);
});

$('#coverIcon').addEventListener('click', async () => {
  if (!coverHash) return;
  try {
    await coverPost('/__cover/mode', { mode: 'icon' });
    state.coverMode.set(coverHash, 'icon');
    afterCoverChange();
    toast('已改成类型图标', 'ok');
  } catch (err) { toast(err.message, 'err'); }
});

$('#coverAuto').addEventListener('click', async () => {
  if (!coverHash) return;
  try {
    await coverPost('/__cover/mode', { mode: 'auto' });
    state.coverMode.set(coverHash, 'auto');
    afterCoverChange();
    toast('已恢复自动封面', 'ok');
  } catch (err) { toast(err.message, 'err'); }
});

$('#coverGrid').addEventListener('click', async (e) => {
  const item = e.target.closest('[data-rel]');
  if (!item || !coverHash) return;
  try {
    await coverPost('/__cover/from-dir', { rel: item.dataset.rel });
    state.coverMode.set(coverHash, 'custom');
    afterCoverChange();
    toast('封面已更换', 'ok');
  } catch (err) { toast(err.message, 'err'); }
});

/* ══════════ 封面：TheTVDB 刮削 ══════════ */
/* 两段式：先搜作品（带一张默认海报），点进去再挑具体哪张海报 */

let tvdbStage = 'cand'; // cand = 搜索结果；art = 某部作品的海报列表
let tvdbLast = null;    // 当前展开的作品 { id, type, name, year }

function tvdbSetHint(text, busy = false) {
  const el = $('#coverTvdbHint');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('is-busy', busy);
}

function tvdbSkeleton(n = 4) {
  $('#tvdbGrid').innerHTML = Array.from({ length: n }, () => '<div class="cover-skel"></div>').join('');
}

function tvdbDisabled(text) {
  tvdbSetHint(text);
  $('#tvdbGrid').innerHTML = `<div class="cover-empty">${esc(text)}<br>到「设置 → TheTVDB 刮削」里填上自己的 API Key 就能用。</div>`;
}

function renderTvdbCandidates(items) {
  tvdbStage = 'cand';
  tvdbLast = null;
  $('#tvdbBack').hidden = true;
  if (!items.length) {
    $('#tvdbGrid').innerHTML = '<div class="cover-empty">TheTVDB 上没搜到，换个名字试试（可以只填英文主标题）</div>';
    return;
  }
  $('#tvdbGrid').innerHTML = items.map((it) => `
    <button class="cover-item tvdb-item" data-id="${esc(it.id)}" data-type="${esc(it.type)}"
      data-name="${esc(it.name)}" data-en="${esc(it.nameEn || '')}" data-year="${esc(it.year || '')}" title="${esc(it.overview || it.name)}">
      ${it.image ? `<img src="${esc(it.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />` : ''}
      <span class="tvdb-cap"><b>${esc(it.name)}</b><small>${esc(it.type === 'movie' ? '电影' : '剧集')}${it.year ? ` · ${esc(it.year)}` : ''}${it.nameEn && it.nameEn !== it.name ? ` · ${esc(it.nameEn)}` : ''}</small></span>
    </button>`).join('');
}

function renderTvdbPosters(items, meta, { back = true } = {}) {
  tvdbStage = 'art';
  tvdbLast = meta;
  $('#tvdbBack').hidden = !back;
  if (!items.length) {
    $('#tvdbGrid').innerHTML = '<div class="cover-empty">这部作品在 TheTVDB 上还没有海报</div>';
    return;
  }
  $('#tvdbGrid').innerHTML = items.map((a, i) => `
    <button class="cover-item tvdb-item" data-image="${esc(a.image)}" title="海报 ${i + 1}${a.kind === 'backdrop' ? '（背景图）' : ''}">
      <img src="${esc(a.thumb || a.image)}" data-full="${esc(a.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
      <span class="tvdb-cap"><small>${a.kind === 'backdrop' ? '背景图' : '海报'} · ${a.lang || '—'}</small></span>
    </button>`).join('');
  // 有些作品只有原图、没有缩略图（缩略图 URL 会 404/403），加载失败就退回原图
  for (const img of $$('#tvdbGrid img[data-full]')) {
    img.addEventListener('error', () => {
      if (img.dataset.full && img.src !== img.dataset.full) img.src = img.dataset.full;
    }, { once: true });
  }
}

async function tvdbSearchNow() {
  if (!coverHash) return;
  const h = coverHash;
  const q = $('#tvdbQuery').value.trim();
  const type = $('#tvdbType').value;
  tvdbSkeleton();
  tvdbSetHint('搜索中…', true);
  try {
    const res = await fetch(`/__cover/tvdb/search?hash=${h}&q=${encodeURIComponent(q)}&type=${encodeURIComponent(type)}`);
    const data = await res.json().catch(() => ({}));
    if (coverHash !== h) return; // 弹窗已经切到别的种子
    if (!res.ok) throw new Error(data.message || '搜索失败');
    if (!q && data.parsed?.title && $('#tvdbQuery').value.trim() === '') $('#tvdbQuery').value = data.parsed.title;
    renderTvdbCandidates(data.items || []);
    // 中英混排的名字会被拆成多个查询词逐个试，说清楚最后是按哪个词搜到的
    const used = data.query && data.query !== (q || data.parsed?.title || '') ? ` · 按「${data.query}」搜到` : '';
    tvdbSetHint(`识别为「${data.parsed?.title || '—'}」${data.parsed?.year ? ` ${data.parsed.year}` : ''}${data.parsed?.season ? ` 第${data.parsed.season}季` : ''}${used} ${(data.items || []).length} 个结果`);
  } catch (err) {
    tvdbSetHint('搜索失败');
    $('#tvdbGrid').innerHTML = `<div class="cover-empty">${esc(err.message)}</div>`;
  }
}

async function tvdbOpenArt(id, type, name, year, nameEn = '') {
  tvdbSkeleton(6);
  tvdbSetHint(`读取《${name}》的海报…`, true);
  try {
    const res = await fetch(`/__cover/tvdb/art?hash=${coverHash}&id=${encodeURIComponent(id)}&type=${encodeURIComponent(type)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || '读取失败');
    renderTvdbPosters(data.items || [], { id, type, name, nameEn, year });
    tvdbSetHint(`《${name}》· ${(data.items || []).length} 张可选，点一张套用`);
  } catch (err) {
    tvdbSetHint('读取失败');
    $('#tvdbGrid').innerHTML = `<div class="cover-empty">${esc(err.message)}</div>`;
  }
}

async function tvdbApply(meta) {
  if (!coverHash) return;
  try {
    const res = await fetch(`/__cover/tvdb/apply?hash=${coverHash}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(meta),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || '套用失败');
    state.coverMode.set(coverHash, 'tvdb');
    afterCoverChange();
    $('#coverTvdbName').textContent = meta.name ? `《${meta.name}》` : '';
    tvdbSetHint(meta.name ? `已套用《${meta.name}》${meta.year ? ` (${meta.year})` : ''}` : '已套用海报');
    toast('封面已从 TheTVDB 刮削', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

$('#tvdbSearch').addEventListener('click', () => tvdbSearchNow());
$('#tvdbQuery').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); tvdbSearchNow(); }
});
$('#tvdbType').addEventListener('change', () => { if ($('#tvdbQuery').value.trim()) tvdbSearchNow(); });
$('#tvdbBack').addEventListener('click', () => tvdbSearchNow());

/**
 * 自动匹配：只要匹配到「够像」的作品，就把它的第一张海报直接套上，不再要求人选。
 * 没把握（分数太低 / 搜不到）时才把候选摆出来让人挑。
 */
let tvdbAutoBusy = false;
async function tvdbAutoMatch({ silent = false } = {}) {
  if (!coverHash || tvdbAutoBusy) return false;
  const h = coverHash;
  tvdbAutoBusy = true;
  if (!silent) { tvdbSkeleton(); tvdbSetHint('自动匹配中…', true); }
  try {
    const res = await fetch('/__cover/tvdb/auto', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hash: h }),
    });
    const data = await res.json().catch(() => ({}));
    if (coverHash !== h) return false; // 弹窗已经切到别的种子
    if (!res.ok) throw new Error(data.message || '匹配失败');
    const r = (data.results || {})[h] || {};
    if (r.ok) {
      state.coverMode.set(h, 'tvdb');
      afterCoverChange(h);
      $('#coverTvdbName').textContent = `《${r.name}》`;
      const label = `《${r.name}》${r.year ? `（${r.year}）` : ''}`;
      // 第一张已经套上了，海报列表也铺出来——想换一张直接点，不用再搜一次
      if (r.arts?.length) renderTvdbPosters(r.arts, { id: r.id, type: r.type, name: r.name, nameEn: r.nameEn || '', year: r.year }, { back: false });
      tvdbSetHint(`已套用${label}的第一张海报${r.arts?.length > 1 ? `，另有 ${r.arts.length - 1} 张可点选` : ''}`);
      toast(`已套用${label}的海报`, 'ok');
      return true;
    }
    // 没把握就别硬套，把候选摆出来让用户自己点
    renderTvdbCandidates(r.items || []);
    const named = r.parsed?.title ? `「${r.parsed.title}」` : '';
    const namedFrom = r.nameFrom === 'file' ? '（按种子里的正片文件名）' : '';
    tvdbSetHint(r.items?.length
      ? `识别为${named}${namedFrom}，不敢确定是哪一部，挑一个吧`
      : `TheTVDB 上没找到${named}${namedFrom}，换个关键词试试（中英混排的名字可以只填英文）`);
    return false;
  } catch (err) {
    tvdbSetHint('匹配失败');
    $('#tvdbGrid').innerHTML = `<div class="cover-empty">${esc(err.message)}</div>`;
    return false;
  } finally {
    tvdbAutoBusy = false;
  }
}

$('#tvdbPick').addEventListener('click', () => { tvdbAutoMatch(); });

$('#tvdbGrid').addEventListener('click', async (e) => {
  const item = e.target.closest('.tvdb-item');
  if (!item || !coverHash) return;
  if (tvdbStage === 'cand') {
    tvdbOpenArt(item.dataset.id, item.dataset.type, item.dataset.name, item.dataset.year, item.dataset.en);
    return;
  }
  const base = tvdbLast || {};
  await tvdbApply({
    id: base.id,
    type: base.type,
    image: item.dataset.image,
    name: base.name,
    nameEn: base.nameEn || '',
    year: base.year,
  });
});

/** 打开封面弹窗时把 TVDB 区恢复成初始状态，并顺手按种子名预填片名 */
async function loadTvdbPanel(hash) {
  const t = state.map.get(hash);
  $('#coverTvdbName').textContent = '';
  $('#tvdbGrid').innerHTML = '';
  $('#tvdbBack').hidden = true;
  tvdbStage = 'cand';
  tvdbLast = null;
  const h = hash;
  try {
    const st = await fetch(`/__cover/tvdb/status?hash=${hash}`).then((r) => r.json());
    if (coverHash !== h) return;
    Object.assign(state.tvdb, {
      enabled: Boolean(st.enabled), configured: Boolean(st.configured), auto: st.auto || 'off', lang: st.lang || 'eng',
    });
    if (!st.configured) { tvdbDisabled('还没配置 TheTVDB'); return; }
    if (!st.enabled) { tvdbDisabled('TheTVDB 刮削已关闭'); return; }
    $('#tvdbQuery').value = st.parsed?.title || t?.name || '';
    $('#tvdbType').value = st.parsed?.isSeries ? 'series' : '';
    if (st.current?.name) {
      $('#coverTvdbName').textContent = `《${st.current.name}》`;
      tvdbSetHint(`当前：TheTVDB · ${st.current.type === 'movie' ? '电影' : '剧集'}${st.current.year ? ` ${st.current.year}` : ''}`);
    } else if (st.mode === 'custom' || st.mode === 'icon') {
      // 用户自己设过图（上传 / 粘贴 / 用图标）：打开弹窗别再拿自动匹配把它盖掉
      $('#coverTvdbName').textContent = '';
      tvdbSetHint(st.mode === 'custom' ? '当前是自定义图片，想换成刮削海报点「自动匹配」' : '当前用的是类型图标，想换海报点「自动匹配」');
    } else {
      const fromLabel = st.nameFrom === 'file' ? '（按种子里的正片文件名）' : '';
      tvdbSetHint(st.parsed?.title ? `识别为「${st.parsed.title}」${st.parsed.year ? ` ${st.parsed.year}` : ''}${fromLabel}，正在自动匹配…` : '—');
      // 还没刮过的种子：打开就把自动匹配跑掉，命中直接套第一张海报，不命中才留候选给人挑
      tvdbAutoMatch({ silent: true });
    }
  } catch { tvdbSetHint('—'); }
}

/* ══════════ 弹窗基础 ══════════ */
function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.hidden = false;
  document.body.dataset.modal = id;
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.hidden = true;
  if (id === 'addModal') closePathMenu();
  delete document.body.dataset.modal;
}

document.addEventListener('click', (e) => {
  const closer = e.target.closest('[data-close]');
  if (closer) { closeModal(closer.dataset.close); return; }
  if (e.target.classList.contains('modal')) {
    if (e.target.id !== 'loginModal' && e.target.id !== 'confirmModal') closeModal(e.target.id);
  }
});

function confirmDialog({ title, desc, okText = '确定', extraText, danger = true }) {
  return new Promise((resolve) => {
    $('#confirmTitle').textContent = title;
    $('#confirmDesc').textContent = desc || '';
    const ok = $('#confirmOk');
    ok.textContent = okText;
    ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
    const foot = ok.parentElement;
    $$('[data-extra]', foot).forEach((n) => n.remove());
    if (extraText) {
      const b = document.createElement('button');
      b.className = 'btn btn-ghost';
      b.dataset.extra = '1';
      b.textContent = extraText;
      foot.insertBefore(b, ok);
    }
    openModal('confirmModal');

    const done = (v) => {
      closeModal('confirmModal');
      $('#confirmModal').removeEventListener('click', onClick);
      resolve(v);
    };
    const onClick = (e) => {
      if (e.target.id === 'confirmOk') done('ok');
      else if (e.target.id === 'confirmCancel') done(null);
      else if (e.target.closest('[data-extra]')) done('extra');
    };
    $('#confirmModal').addEventListener('click', onClick);
  });
}

/* ══════════ Toast ══════════ */
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<i></i><span></span>`;
  el.querySelector('span').textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => {
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 220);
  }, 2400);
}

/* ══════════ 添加种子 ══════════ */
/* 添加方式：file = 种子文件（默认），link = 链接 / Magnet。可在设置里改默认 */
let addMode = localStorage.getItem(LS.addMode) === 'link' ? 'link' : 'file';
let addFiles = [];

$('#addBtn').addEventListener('click', openAddModal);
$('#fabAdd').addEventListener('click', openAddModal);
$('#emptyAddBtn').addEventListener('click', openAddModal);

async function loadPrefs() {
  if (state.prefs) return state.prefs;
  try { state.prefs = await apiJson('/app/preferences'); } catch { state.prefs = {}; }
  return state.prefs;
}

/* ── 保存路径：历史下拉 ───────────────────────────────── */
const PATH_LS = 'qb.paths';
const PATH_MAX = 12;
const pathMenuState = { open: false, items: [], active: -1, filtering: false };

const trimPath = (p) => String(p ?? '').trim().replace(/(.)\/+$/, '$1');

function readPathHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(PATH_LS) || '[]');
    return Array.isArray(raw)
      ? raw.map(trimPath).filter((p, i, a) => p && a.indexOf(p) === i).slice(0, PATH_MAX)
      : [];
  } catch { return []; }
}

function rememberPath(p) {
  const path = trimPath(p);
  if (!path) return;
  localStorage.setItem(PATH_LS, JSON.stringify([path, ...readPathHistory().filter((x) => x !== path)].slice(0, PATH_MAX)));
}

/* 汇总现有种子用过的目录，按使用量排序 */
function pathStats() {
  const map = new Map();
  for (const t of state.list) {
    const p = trimPath(t.save_path);
    if (!p) continue;
    const e = map.get(p) || { path: p, count: 0, last: 0 };
    e.count += 1;
    if ((t.added_on || 0) > e.last) e.last = t.added_on || 0;
    map.set(p, e);
  }
  return map;
}

function pathOptions() {
  const stats = pathStats();
  const def = trimPath(state.prefs?.save_path);
  const opts = [];
  const seen = new Set();
  const push = (path, group, badge, accent = false) => {
    const p = trimPath(path);
    if (!p || seen.has(p)) return;
    seen.add(p);
    opts.push({ path: p, group, badge, accent });
  };

  // 默认路径置顶，其次是最近用过的，最后是种子库里常用的目录
  push(def, '默认路径', '默认', true);
  readPathHistory().forEach((p) => push(p, '最近使用', stats.get(p)?.count ? `${stats.get(p).count}` : ''));
  [...stats.values()]
    .filter((e) => !seen.has(e.path))
    .sort((a, b) => b.count - a.count || b.last - a.last)
    .slice(0, 8)
    .forEach((e) => push(e.path, '常用目录', `${e.count}`));

  return opts;
}

const pathBase = (p) => {
  const parts = String(p).split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '/';
};

function pathHighlight(text, q) {
  const s = String(text ?? '');
  if (!q) return esc(s);
  const i = s.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return esc(s);
  return esc(s.slice(0, i)) + '<mark>' + esc(s.slice(i, i + q.length)) + '</mark>' + esc(s.slice(i + q.length));
}

function updatePathHint() {
  const hint = $('#pathHint');
  if (!hint) return;
  const p = trimPath($('#addPath').value);
  if (!p) { hint.textContent = ''; return; }
  const def = trimPath(state.prefs?.save_path);
  const st = pathStats().get(p);
  hint.textContent = def && p === def ? '默认路径' : st ? `已存 ${st.count} 个种子` : '新目录';
}

function positionPathMenu() {
  const menu = $('#pathMenu');
  const wrap = $('.path-input');
  if (menu.hidden || !wrap) return;
  const r = wrap.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.visualViewport?.height || window.innerHeight;
  const width = Math.min(Math.max(r.width, 280), Math.min(520, vw - 24));
  const left = Math.max(12, Math.min(r.left, vw - 12 - width));
  const below = vh - r.bottom - 12;
  const above = r.top - 12;
  const flip = below < 190 && above > below;
  menu.style.width = `${width}px`;
  menu.style.left = `${left}px`;
  if (flip) {
    menu.style.top = 'auto';
    menu.style.bottom = `${vh - r.top + 6}px`;
    menu.style.maxHeight = `${Math.min(330, Math.max(140, above))}px`;
  } else {
    menu.style.bottom = 'auto';
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.maxHeight = `${Math.min(330, Math.max(140, below))}px`;
  }
}

function setPathActive(i, scroll = true) {
  const items = $$('#pathMenu .path-item');
  if (!items.length) { pathMenuState.active = -1; return; }
  pathMenuState.active = Math.max(0, Math.min(items.length - 1, i));
  items.forEach((el, k) => el.classList.toggle('is-active', k === pathMenuState.active));
  const el = items[pathMenuState.active];
  if (scroll && el) el.scrollIntoView({ block: 'nearest' });
}

function renderPathMenu() {
  const listEl = $('#pathList');
  const footEl = $('#pathFoot');
  if (!listEl || !footEl) return;
  // 打开时展示完整历史；只有用户主动输入后才按关键词过滤
  const q = pathMenuState.filtering ? $('#addPath').value.trim().toLowerCase() : '';
  const all = pathOptions();
  const list = q ? all.filter((o) => o.path.toLowerCase().includes(q)) : all;
  pathMenuState.items = list;

  if (!list.length) {
    const typed = trimPath($('#addPath').value);
    listEl.innerHTML = `<div class="path-empty">
      <span>${all.length ? '没有匹配的历史目录' : '还没有历史目录'}</span>
      ${typed ? `<button class="path-use" type="button" data-path="${esc(typed)}">
        <svg><use href="#i-folder"/></svg>使用该路径
      </button><small>${esc(typed)}</small>` : ''}
    </div>`;
    footEl.innerHTML = typed ? '<span>按 <kbd>↵</kbd> 直接使用当前路径</span>' : '';
    pathMenuState.active = -1;
    return;
  }

  let html = '';
  let group = '';
  list.forEach((o, i) => {
    if (o.group !== group) {
      group = o.group;
      html += `<div class="path-group">${esc(group)}</div>`;
    }
    html += `<div class="path-item ${i === pathMenuState.active ? 'is-active' : ''}" role="option" data-i="${i}" data-path="${esc(o.path)}">
      <svg class="path-item-ico"><use href="#i-folder"/></svg>
      <span class="path-item-main">
        <span class="path-item-name">${pathHighlight(pathBase(o.path), q)}</span>
        <span class="path-item-path">${pathHighlight(o.path, q)}</span>
      </span>
      ${o.badge ? `<em class="path-item-badge ${o.accent ? 'is-accent' : ''}">${esc(o.badge)}</em>` : ''}
    </div>`;
  });
  listEl.innerHTML = html;

  footEl.innerHTML =
    `<span class="path-kbd"><kbd>↑</kbd><kbd>↓</kbd> 选择 · <kbd>↵</kbd> 确认</span>` +
    (readPathHistory().length
      ? `<button class="path-clear" type="button" id="pathClear"><svg><use href="#i-trash"/></svg>清除最近</button>`
      : '<span></span>');

  requestAnimationFrame(() => {
    listEl.classList.toggle('is-scroll', listEl.scrollHeight > listEl.clientHeight + 2);
  });
}

function openPathMenu(fromTyping = false) {
  if (document.body.dataset.modal !== 'addModal') return;
  const menu = $('#pathMenu');
  if (pathMenuState.open && !fromTyping) { positionPathMenu(); return; }
  // 主动点开/聚焦时展示完整历史，输入触发的打开则保留过滤词
  if (!fromTyping) pathMenuState.filtering = false;
  pathMenuState.open = true;
  menu.hidden = false;
  $('.path-input').classList.add('is-open');
  $('#addPath').setAttribute('aria-expanded', 'true');
  const cur = trimPath($('#addPath').value);
  pathMenuState.active = -1;
  renderPathMenu();
  // 打开时把当前值所在项设为高亮，无则不高亮（回车直接提交输入内容）
  const idx = pathMenuState.items.findIndex((o) => o.path === cur);
  setPathActive(idx, false);
  positionPathMenu();
  loadPrefs().then(() => {
    if (!pathMenuState.open) return;
    const typed = trimPath($('#addPath').value);
    renderPathMenu();
    setPathActive(pathMenuState.items.findIndex((o) => o.path === typed), false);
    positionPathMenu();
  });
}

function closePathMenu() {
  const menu = $('#pathMenu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  pathMenuState.open = false;
  pathMenuState.active = -1;
  $('.path-input')?.classList.remove('is-open');
  $('#addPath')?.setAttribute('aria-expanded', 'false');
}

function applyPath(p) {
  const path = trimPath(p);
  if (!path) return;
  $('#addPath').value = path;
  rememberPath(path);
  updatePathHint();
  closePathMenu();
  $('#addPath').focus();
}

$('#addPath').addEventListener('focus', () => openPathMenu());
$('#addPath').addEventListener('click', () => openPathMenu());
$('#pathToggle').addEventListener('mousedown', (e) => e.preventDefault());
$('#pathToggle').addEventListener('click', () => {
  if (pathMenuState.open) { closePathMenu(); return; }
  openPathMenu();
  if (pathMenuState.open) setPathActive(0, false);
});
$('#addPath').addEventListener('input', () => {
  pathMenuState.active = -1;
  pathMenuState.filtering = true;
  if (!pathMenuState.open) openPathMenu(true);
  else { renderPathMenu(); positionPathMenu(); }
  updatePathHint();
});

$('#addPath').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!pathMenuState.open) { openPathMenu(); return; }
    const step = e.key === 'ArrowDown' ? 1 : -1;
    const next = pathMenuState.active < 0 ? (step > 0 ? 0 : pathMenuState.items.length - 1) : pathMenuState.active + step;
    setPathActive((next + pathMenuState.items.length) % Math.max(1, pathMenuState.items.length));
  } else if (e.key === 'Backspace' || e.key === 'Delete') {
    pathMenuState.filtering = true;
  } else if (e.key === 'Enter') {
    if (pathMenuState.open && pathMenuState.active >= 0) {
      e.preventDefault();
      const item = pathMenuState.items[pathMenuState.active];
      if (item) applyPath(item.path);
    } else {
      closePathMenu();
      $('#addSubmit').click();
    }
  } else if (e.key === 'Escape') {
    if (pathMenuState.open) { e.preventDefault(); e.stopPropagation(); closePathMenu(); }
  } else if (e.key === 'Tab') {
    closePathMenu();
  }
});

$('#pathMenu').addEventListener('mousedown', (e) => {
  if (e.target.closest('.path-item')) e.preventDefault(); // 保持输入框焦点
});
$('#pathMenu').addEventListener('click', (e) => {
  const clear = e.target.closest('#pathClear');
  if (clear) {
    localStorage.removeItem(PATH_LS);
    renderPathMenu();
    positionPathMenu();
    updatePathHint();
    toast('已清除路径历史');
    return;
  }
  const use = e.target.closest('.path-use');
  if (use) { applyPath(use.dataset.path); return; }
  const item = e.target.closest('.path-item');
  if (item) applyPath(item.dataset.path);
});

document.addEventListener('mousedown', (e) => {
  if (!pathMenuState.open) return;
  if (e.target.closest('#pathMenu') || e.target.closest('.path-input')) return;
  closePathMenu();
});
window.addEventListener('resize', () => { if (pathMenuState.open) positionPathMenu(); });
document.addEventListener('scroll', () => { if (pathMenuState.open) positionPathMenu(); }, true);
window.visualViewport?.addEventListener('resize', () => { if (pathMenuState.open) positionPathMenu(); });
window.visualViewport?.addEventListener('scroll', () => { if (pathMenuState.open) positionPathMenu(); });

async function openAddModal() {
  fillCategorySelect();
  resetAddCover();
  addKwAuto = '';
  addKwDirty = false;
  $('#addKw').value = '';
  applyAddMode(addMode);
  openModal('addModal');
  // 只有「链接 / Magnet」这页才需要弹键盘
  setTimeout(() => { if (addMode === 'link' && !isMobile()) $('#addUrls').focus(); }, 120);
  if (!$('#addPath').value) $('#addPath').value = (await loadPrefs()).save_path || '';
  updatePathHint();
}

/** 切到某一页：段控高亮 + 面板显隐，都走这里，避免两边状态不一致 */
function applyAddMode(mode) {
  addMode = mode === 'link' ? 'link' : 'file';
  $$('#addSeg .seg-item').forEach((el) => el.classList.toggle('is-active', el.dataset.seg === addMode));
  $$('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== addMode; });
  syncAddKeyword(); // 两种方式各自猜一个关键词，用户改过的就不动
}

$('#addSeg').addEventListener('click', (e) => {
  const item = e.target.closest('[data-seg]');
  if (!item) return;
  applyAddMode(item.dataset.seg);
});

/**
 * 文件名截断：种子名经常又长又多语言，原样铺进拖拽框会把框撑破、把按钮顶走。
 * 中间省略而不是结尾省略——开头是片名，结尾是 .torrent 后缀，两头都是有效信息。
 * 完整名字挂在 title 上，鼠标悬停还能看全。
 */
function shortName(name, max = 40) {
  const s = String(name || '');
  if (s.length <= max) return s;
  const tail = Math.min(12, Math.floor(max / 3)); // 留住后缀 + 少量结尾
  return `${s.slice(0, max - tail - 1)}…${s.slice(-tail)}`;
}

/** 已选文件的提示文案：多选只报第一个名字，个数由前缀说明，全名留在 title 里 */
function dropHintOf(files) {
  if (!files.length) return '点击选择或拖入 .torrent 文件'; // 取消选择也要回到初始态
  // 多选时再压短一点，免得「已选择 N 个文件：」加名字之后尾巴孤零零折一行
  const first = shortName(files[0].name, files.length > 1 ? 30 : 40);
  return `已选择 ${files.length} 个文件：${first}`;
}

/** 把已选文件写进拖拽框：文案截断，title 里放全名 */
function renderDropText(files) {
  const el = $('#dropText');
  el.textContent = dropHintOf(files);
  el.title = files.length ? files.map((f) => f.name).join('\n') : '';
}

/** 封面那行的说明文字：短标签清掉旧 title，长文件名才挂全名 */
function setCoverHint(text, title = '') {
  const el = $('#addCoverHint');
  if (!el) return;
  el.textContent = text;
  if (title) el.title = title;
  else el.removeAttribute('title');
}

$('#addFile').addEventListener('change', (e) => {
  addFiles = Array.from(e.target.files || []);
  renderDropText(addFiles);
  syncAddKeyword(true);
  // 有种子名就顺手刮一次海报，用户什么都不用点
  if (addFiles.length) scrapeAddCover({ auto: true });
});

const dz = $('#dropzone');
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('is-over'); }));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('is-over'); }));
dz.addEventListener('drop', (e) => {
  const files = Array.from(e.dataTransfer.files || []).filter((f) => f.name.endsWith('.torrent'));
  if (files.length) {
    addFiles = files;
    renderDropText(addFiles);
    syncAddKeyword(true);
    scrapeAddCover({ auto: true });
  }
});

// magnet 粘进来就试着刮（有 dn 才有片名，拿不到就等用户点按钮）
$('#addUrls').addEventListener('paste', () => {
  setTimeout(() => {
    const v = ($('#addUrls').value || '').trim();
    if (!/^magnet:\?/i.test(v) && !/^https?:\/\//i.test(v)) return;
    syncAddKeyword(true);
    if (!addCoverFile) scrapeAddCover({ auto: true });
  }, 100);
});

/** 添加后轮询一会儿，找出新出现的种子哈希（qBittorrent 的 add 接口不返回 hash） */
async function waitNewHashes(before, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const list = await apiJson('/torrents/info');
      if (!Array.isArray(list)) continue;
      state.list = list;
      state.map = new Map(list.map((t) => [t.hash, t]));
      const fresh = list.filter((t) => !before.has(t.hash)).map((t) => t.hash);
      if (fresh.length) return fresh;
    } catch { /* 继续等 */ }
  }
  return [];
}

/* ── 添加时的封面 ─────────────────────────────────────── */
let addCoverFile = null;
let addCoverUrl = null;
/* 添加框里刮到的海报：此时种子还没进 qBittorrent，没有 hash，等添加完再按 hash 落盘 */
let addTvdb = null;
let addTvdbBusy = false;
let addScrapeSeq = 0; // 每发起一次刮削 +1，回来的旧结果直接丢掉

function resetAddCover() {
  // 清空的瞬间把还在飞的刮削也作废，否则「移除」之后旧结果回来又把海报贴上了
  addScrapeSeq++;
  addCoverFile = null;
  addTvdb = null;
  if (addCoverUrl) URL.revokeObjectURL(addCoverUrl);
  addCoverUrl = null;
  const box = $('#addCoverBox');
  box.classList.remove('has-img');
  box.innerHTML = '<svg><use href="#i-image"/></svg>';
  $('#addCoverClear').hidden = true;
  setCoverHint('可选');
  $('#addCoverTitle').textContent = '不设置也可以';
  $('#addCoverDesc').textContent = '默认用种子目录里的图片，没有就显示类型图标；也可以在下面直接粘一张';
  $('#addScrapeLabel').textContent = '刮削封面';
  $('#addArts').hidden = true;
  $('#addArts').innerHTML = '';
  clearAddKwHint();
  const input = $('#addCoverFile');
  if (input) input.value = '';
}

/* ── 添加时直接刮削：种子名 → TheTVDB 匹配 → 选海报 → 添加后自动套用 ── */

/** 从待添加的内容里猜片名：.torrent 去掉后缀；magnet 取 dn，拿不到就退回网址最后一段 */
function addNameGuess() {
  if (addMode === 'link') {
    const first = (($('#addUrls').value || '').split('\n').map((s) => s.trim()).filter(Boolean)[0]) || '';
    if (!first) return '';
    const m = /[?&]dn=([^&]*)/.exec(first);
    if (m) {
      try { return decodeURIComponent(m[1].replace(/\+/g, ' ')).trim(); } catch { return m[1].trim(); }
    }
    const tail = (first.split('/').pop() || '').replace(/\.torrent$/i, '');
    return /^[0-9a-f]{32,40}$/i.test(tail) ? '' : tail; // 纯哈希搜不出东西
  }
  return (addFiles[0]?.name || '').replace(/\.torrent$/i, '');
}

/**
 * 关键词：默认填种子文件名（magnet 取 dn），但它是**可编辑**的——
 * 种子名里带一堆发布组 / 压制参数时，用户改成「Obsession」这种干净片名往往一次就中。
 * addKwAuto 记住上次自动填的值，用来判断用户是不是真改过；改回自动值就继续跟着走。
 *
 * 和详情页一样先把文件名解析成片名（剥掉 1080p / x264 / 制作组 / S01E02），
 * 解析结果在 addParsed 里存着：关键词跟着变干净，发请求时还能把年份 / 影视类型带上，
 * 不然「The.Matrix.1999」被剥成「The Matrix」之后再猜年份就猜不出来了。
 */
let addKwAuto = '';
let addKwDirty = false;
let addParsed = null;    // 解析结果 { title, year, season, isSeries }
let addNameFrom = '';    // 'file' = 种子里的正片文件名；'torrent' = 种子名兜底
let addParseSeq = 0;     // 每解析一次 +1，回来的旧结果直接丢掉
let addParse$ = null;    // 当前解析请求，刮削前等它，别拿脏名先搜一遍
let addTorrentSeen = null; // 上次解过的 .torrent，同一份文件别重复上传

function syncAddKeyword(force = false) {
  const raw = addNameGuess();
  addKwAuto = raw;
  addParsed = null;
  addNameFrom = '';
  if (force) addKwDirty = false;
  if (!addKwDirty) $('#addKw').value = raw;
  clearAddKwHint();
  addParse$ = raw || addFiles[0] ? resolveAddName(raw) : null;
}

/**
 * 关键词该取哪个名字，按可靠程度排：
 *   1. .torrent 里的正片文件名 —— 发布名是发布组堆出来的，正片文件名通常干净得多
 *   2. 种子名（magnet 的 dn / .torrent 的文件名）—— 拿不到文件清单时兜底
 * 两条都走服务端同一套 parseTitle，剥掉 1080p / x264 / 制作组 / S01E02 这些噪音。
 */
async function resolveAddName(raw) {
  const my = ++addParseSeq;
  let got = null;
  try {
    if (addMode !== 'link' && addFiles[0]) got = await torrentInnerName(addFiles[0]);
    if (!got?.name && raw) got = await parseSeedName(raw);
  } catch { /* 两条路都不通就用原名，服务端 match 里还会再解析一次 */ }
  if (my !== addParseSeq) return; // 期间换了文件 / 又粘了别的链接
  const title = got?.parsed?.title || '';
  if (!title) return;
  addParsed = got.parsed;
  addNameFrom = got.from || '';
  if (!addKwDirty) {
    addKwAuto = title;
    $('#addKw').value = title;
  }
  // 名字没变、又没有年份这类额外信息，就别唠叨
  const worthTelling = got.from === 'file' ? title !== raw || Boolean(got.parsed.year) : title !== raw;
  if (worthTelling) renderAddKwHint(got);
}

/** 还没添加的 .torrent 里有什么文件：交给服务端解 bencode，同一份文件不重复上传 */
async function torrentInnerName(file) {
  const key = `${file.name}:${file.size}:${file.lastModified}`;
  if (addTorrentSeen?.key === key) return addTorrentSeen.res;
  const res = await fetch('/__cover/tvdb/torrent', { method: 'POST', body: file });
  const data = await res.json().catch(() => ({}));
  const out = res.ok && data?.name ? data : null;
  addTorrentSeen = { key, res: out };
  return out;
}

/** 兜底：把种子名丢给服务端解析（纯本地计算，不联网、不耗额度） */
async function parseSeedName(raw) {
  const res = await fetch(`/__cover/tvdb/parse?name=${encodeURIComponent(raw)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.parsed?.title) return null;
  return { name: raw, from: 'torrent', parsed: data.parsed };
}

function renderAddKwHint(got) {
  const hint = $('#addKwHint');
  if (!hint) return;
  const p = got.parsed || {};
  const extra = `${p.year ? ` ${p.year}` : ''}${p.season ? ` 第${p.season}季` : ''}`;
  const title = `<b>${esc(p.title)}</b>${esc(extra)}`;
  hint.innerHTML = got.from === 'file'
    ? `按种子里的 <b>${esc(clipLabel(got.name, 34))}</b> 认作 ${title}，不对可以直接改`
    : `已从种子名识别为 ${title}，不对可以直接改`;
  hint.hidden = false;
}

/** 名字太长就截一段，够认出是哪个文件就行 */
function clipLabel(s, n) {
  const t = String(s || '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function clearAddKwHint() {
  const hint = $('#addKwHint');
  if (!hint) return;
  hint.hidden = true;
  hint.textContent = '';
}

function addKeyword() {
  return ($('#addKw').value || '').trim() || addNameGuess();
}

$('#addKw').addEventListener('input', () => {
  addKwDirty = $('#addKw').value.trim() !== addKwAuto;
  if (addKwDirty) clearAddKwHint(); // 用户自己动了关键词，就别再念叨解析结果
});
$('#addKw').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  scrapeAddCover();
});

function showAddPoster(image) {
  const box = $('#addCoverBox');
  box.innerHTML = `<img src="${esc(image)}" alt="" referrerpolicy="no-referrer" />`;
  box.classList.add('has-img');
}

function renderAddArts(arts, current) {
  const wrap = $('#addArts');
  if (!arts.length) { wrap.hidden = true; wrap.innerHTML = ''; return; }
  wrap.innerHTML = arts.map((a) => `
    <button class="add-art ${a.image === current ? 'is-on' : ''}" type="button" data-image="${esc(a.image)}"
      title="${esc(a.kind === 'backdrop' ? '背景图' : '海报')} · ${esc(a.lang || '—')}">
      <img src="${esc(a.thumb || a.image)}" data-full="${esc(a.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
    </button>`).join('');
  wrap.hidden = false;
  for (const img of $$('#addArts img[data-full]')) {
    img.addEventListener('error', () => {
      if (img.dataset.full && img.src !== img.dataset.full) img.src = img.dataset.full;
    }, { once: true });
  }
}

/** auto = 选了文件 / 粘了链接后顺手跑，失败不弹错 */
async function scrapeAddCover({ auto = false } = {}) {
  // 自动那次正在跑就别再自动跑；但手动点「刮削封面」不受限制——
  // 用户改完关键词就是想立刻按新词重搜，不该被上一次请求挡住（结果用序号丢弃旧的）
  if (auto && addTvdbBusy) return;
  if (auto && addCoverFile) return; // 已经手动选了图，别覆盖
  // 设置里选「仅手动」时，选文件 / 粘链接不自动联网，把主动权留给「刮削封面」按钮
  if (auto && state.tvdb.auto !== 'new') return;
  // 等文件名解析回来再搜：解析是纯本地计算（毫秒级），但关键词、年份、影视类型都靠它，
  // 抢在这之前发请求等于又按脏名搜一遍
  if (addParse$) { try { await addParse$; } catch { /* 解析失败就用原名 */ } }
  if (auto && addCoverFile) return;
  const name = addKeyword();
  if (!name) {
    if (!auto) toast(addMode === 'link' ? '先粘贴 magnet 或链接，或直接填个关键词' : '先选择 .torrent 文件，或直接填个关键词', 'err');
    return;
  }
  if (!state.tvdb.enabled || !state.tvdb.configured) {
    if (!auto) toast('先到「设置 → TheTVDB 刮削」里启用并填上 API Key', 'err');
    return;
  }
  if (!auto && addCoverFile) resetAddCover(); // 手动点了刮削，就用刮削的替换掉自定义图
  const my = ++addScrapeSeq;
  addTvdbBusy = true;
  const btn = $('#addScrapeBtn');
  btn.classList.add('is-busy');
  $('#addScrapeLabel').textContent = '刮削中…';
  setCoverHint(`搜索「${shortName(name, 24)}」…`, name);
  try {
    const qs = new URLSearchParams({ name });
    // 关键词还是解析出来那个时，把年份 / 类型一起带上——名字洗干净的同时别把 1999、S02 这些信息弄丢
    if (addParsed && !addKwDirty && name === addParsed.title) {
      if (addParsed.year) qs.set('year', addParsed.year);
      if (typeof addParsed.isSeries === 'boolean') qs.set('type', addParsed.isSeries ? 'series' : 'movie');
    }
    const res = await fetch(`/__cover/tvdb/match?${qs}`);
    const data = await res.json().catch(() => ({}));
    if (my !== addScrapeSeq) return; // 期间又搜了一次，这次结果作废
    if (addCoverFile) return; // 刮削期间用户改用手动选图了
    if (!res.ok) throw new Error(data.message || '刮削失败');
    if (!data.ok) {
      setCoverHint('没匹配到');
      if (!auto) {
        toast(data.reason === 'low-score'
          ? '没把握是哪一部，把关键词改得更准一点再试，也可以点「选择图片」手动设'
          : 'TheTVDB 上没找到这部作品，换个关键词再试，也可以点「选择图片」手动设', 'err');
      }
      return;
    }
    const pick = data.pick || {};
    const arts = (data.arts || []).filter((a) => a.image);
    const image = (arts.find((a) => a.kind === 'poster') || arts[0])?.image || pick.image || '';
    if (!image) throw new Error('这部作品在 TheTVDB 上没有可用海报');
    addTvdb = {
      id: pick.id, type: pick.type, image,
      name: pick.name || '', nameEn: pick.nameEn || '', year: pick.year || '',
    };
    showAddPoster(image);
    renderAddArts(arts, image);
    $('#addCoverTitle').textContent = `《${pick.name}》${pick.year ? ` (${pick.year})` : ''}`;
    $('#addCoverDesc').textContent = '来自 TheTVDB，添加后自动套用；想换一张点下面任意一张';
    setCoverHint(pick.type === 'movie' ? '电影' : '剧集');
    $('#addCoverClear').hidden = false;
    toast(`已匹配《${pick.name}》，添加后自动套用海报`, 'ok');
  } catch (err) {
    if (my !== addScrapeSeq) return;
    setCoverHint('刮削失败');
    if (!auto) toast(err.message, 'err');
  } finally {
    if (my === addScrapeSeq) {
      addTvdbBusy = false;
      btn.classList.remove('is-busy');
      $('#addScrapeLabel').textContent = '刮削封面';
    }
  }
}

$('#addScrapeBtn').addEventListener('click', () => scrapeAddCover());
$('#addArts').addEventListener('click', (e) => {
  const item = e.target.closest('[data-image]');
  if (!item) return;
  const image = item.dataset.image;
  if (addTvdb) addTvdb.image = image;
  showAddPoster(image);
  $$('#addArts .add-art').forEach((el) => el.classList.toggle('is-on', el === item));
});

$('#addCoverBtn').addEventListener('click', () => $('#addCoverFile').click());
$('#addCoverFile').addEventListener('change', (e) => {
  const file = (e.target.files || [])[0];
  e.target.value = '';
  setAddCoverFile(file);
});

/** 设置「添加后要用的自定义封面」：选文件、粘贴、拖进来都走这里 */
function setAddCoverFile(file) {
  if (!file) return false;
  if (!/^image\//.test(file.type)) { toast('请选择图片文件', 'err'); return false; }
  if (file.size > 8 * 1024 * 1024) { toast('图片请控制在 8MB 以内', 'err'); return false; }
  addCoverFile = file;
  addTvdb = null; // 自定义图优先，刮削结果作废
  if (addCoverUrl) URL.revokeObjectURL(addCoverUrl);
  addCoverUrl = URL.createObjectURL(file);
  const box = $('#addCoverBox');
  box.innerHTML = `<img src="${addCoverUrl}" alt="" />`;
  box.classList.add('has-img');
  $('#addCoverClear').hidden = false;
  setCoverHint(shortName(file.name, 24) || '已粘贴的图片', file.name || '');
  $('#addCoverTitle').textContent = '自定义图片';
  $('#addCoverDesc').textContent = '添加后按这张设置；想换回刮削的海报点「刮削封面」';
  $('#addArts').hidden = true;
  $('#addArts').innerHTML = '';
  return true;
}

/**
 * 剪贴板里的图片。截图工具（⌘⇧4）、网页右键「复制图片」、本地图片复制都会进 items 的
 * image/* 里；老浏览器只给 files，一起兜住。
 */
function clipboardImage(e) {
  const dt = e.clipboardData;
  if (!dt) return null;
  for (const item of dt.items || []) {
    if (item.kind === 'file' && /^image\//.test(item.type)) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  for (const file of dt.files || []) {
    if (/^image\//.test(file.type)) return file;
  }
  return null;
}

/** 正在输入框里打字时，粘贴该走浏览器的默认行为（比如往关键词框里粘文字） */
function isTypingTarget(node) {
  const check = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  return check(node) || check(document.activeElement);
}

// ⌘/Ctrl+V 直接贴一张图当封面：封面弹窗立刻落盘；添加弹窗先预览，添加成功后落盘；
// 开着详情面板时也认，省得为了换个封面再点进「封面•刮削」
document.addEventListener('paste', async (e) => {
  if (isTypingTarget(e.target)) return;
  const file = clipboardImage(e);
  if (!file) return;
  if (!$('#coverModal').hidden && coverHash) {
    e.preventDefault();
    const ok = await uploadCoverFile(coverHash, file);
    if (ok) toast('已粘贴封面', 'ok');
    return;
  }
  if ($('#detail').classList.contains('is-open') && state.detailHash) {
    e.preventDefault();
    const hash = state.detailHash;
    const ok = await uploadCoverFile(hash, file, true); // 提示统一走下面这句
    if (ok) {
      // 详情面板不会因为封面变了整块重画，直接把 hero 里的图换掉（load 事件会补 has-img）
      const img = document.querySelector('#detail .d-cover img');
      if (img) img.src = coverUrl(hash);
      toast('已粘贴封面', 'ok');
    }
    return;
  }
  if (!$('#addModal').hidden) {
    e.preventDefault();
    if (setAddCoverFile(file)) toast('已粘贴封面，添加后自动套用', 'ok');
  }
});

/* ── 内联粘贴框：手机长按走系统「粘贴」菜单，桌面直接 Ctrl+V，也可以把图拖进去 ── */
// 系统不让网页直接读图片剪贴板（iOS 基本必拒），所以借 contenteditable 让系统自己弹「粘贴」；
// 两个弹窗里各有一个这样的框，粘上来立刻生效，不再「点按钮 → 再进一个面板」。

/** 有些浏览器粘贴过来的是 <img src="data:|blob:">，把地址上的图捞回来 */
async function fileFromSrc(src) {
  if (!src) return null;
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!/^image\//.test(blob.type)) return null;
    const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    return new File([blob], `pasted.${ext}`, { type: blob.type });
  } catch { return null; }
}

function bindPasteBox(el, apply) {
  if (!el) return;
  const take = (file) => {
    if (!file) return false;
    el.innerHTML = ''; // 图取走后清空，占位文字回来
    apply(file);
    return true;
  };

  el.addEventListener('paste', async (e) => {
    const file = clipboardImage(e);
    if (file) { e.preventDefault(); take(file); return; }
    // iOS 有时只给 text/html，里面是 <img src="blob:|data:">
    const html = e.clipboardData?.getData('text/html') || '';
    const src = /<img[^>]+src\s*=\s*["']([^"']+)["']/i.exec(html)?.[1];
    const fromHtml = await fileFromSrc(src);
    if (fromHtml) { e.preventDefault(); take(fromHtml); return; }
    // 都没拿到就别拦，让系统把图插进框里，下面的 input 事件接着处理
  });

  // 系统插进来的图 → 取走用掉；有人往里打字 → 直接清掉（这个框只收图）
  el.addEventListener('input', async () => {
    const img = el.querySelector('img');
    if (img) {
      const src = img.currentSrc || img.src;
      el.innerHTML = '<span class="paste-busy">正在读取图片…</span>';
      const file = await fileFromSrc(src);
      if (!take(file)) el.innerHTML = '';
      return;
    }
    if ((el.textContent || '').trim()) el.innerHTML = '';
  });

  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('is-over'); });
  el.addEventListener('dragleave', () => el.classList.remove('is-over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('is-over');
    take(Array.from(e.dataTransfer?.files || []).find((f) => /^image\//.test(f.type)));
  });
  // 离开时把残留内容清掉，免得下次粘的图插到旧位置
  el.addEventListener('blur', () => { if (!el.querySelector('img')) el.innerHTML = ''; });
}

bindPasteBox($('#coverPasteInput'), (file) => {
  if (!coverHash) { toast('先选中一个种子', 'err'); return; }
  uploadCoverFile(coverHash, file).then((ok) => { if (ok) toast('已粘贴封面', 'ok'); });
});
bindPasteBox($('#addPasteInput'), (file) => {
  if (setAddCoverFile(file)) toast('已粘贴封面，添加后自动套用', 'ok');
});

$('#addCoverClear').addEventListener('click', resetAddCover);

function fillCategorySelect() {
  const sel = $('#addCategory');
  const cats = Object.keys(state.categories || {}).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  sel.innerHTML = `<option value="">默认分类</option>` + cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
}

$('#addSubmit').addEventListener('click', async () => {
  const btn = $('#addSubmit');
  const fd = new FormData();
  const urls = $('#addUrls').value.trim();

  if (addMode === 'link' && !urls) { toast('请粘贴 magnet 或链接', 'err'); return; }
  if (addMode === 'file' && !addFiles.length) { toast('请选择 .torrent 文件', 'err'); return; }

  if (addMode === 'link') fd.append('urls', urls);
  else addFiles.forEach((f) => fd.append('torrents', f, f.name));

  const path = trimPath($('#addPath').value);
  if (path) fd.append('savepath', path);
  const cat = $('#addCategory').value;
  if (cat) fd.append('category', cat);
  const tags = $('#addTags').value.trim();
  if (tags) fd.append('tags', tags);
  fd.append('paused', $('#addPaused').checked ? 'true' : 'false');
  fd.append('sequentialDownload', $('#addSeq').checked ? 'true' : 'false');

  btn.disabled = true;
  btn.textContent = '添加中…';
  const before = new Set(state.map.keys());
  // 种子名先留一份：添加成功后列表里才有真名，这里先用它给类型兜底
  const hintName = addMode === 'link' ? (urls.split('\n')[0] || '').trim() : (addFiles[0]?.name || '');
  try {
    const res = await api('/torrents/add', { method: 'POST', body: fd });
    if (/fail/i.test(res)) throw new Error('qBittorrent 拒绝了该种子');
    closeModal('addModal');
    if (path) rememberPath(path);
    $('#addUrls').value = '';
    $('#addTags').value = '';
    addFiles = [];
    renderDropText(addFiles);
    toast('已添加到下载队列', 'ok');
    refreshNow();
    // 新种子一出现就把类型写进缓存（后台跑，不挡界面）；带封面时顺便等它拿到新 hash
    const wantTvdb = addCoverFile ? null : addTvdb; // 手动选的图优先于刮削
    const pending = (state.coverOn || addCoverFile || wantTvdb)
      ? waitNewHashes(before).then(async (fresh) => {
        const out = await seedKinds(fresh, { name: hintName, category: cat });
        // 添加框里已经挑好海报了，就别再让「自动刮削」把它覆盖掉
        if (!wantTvdb) autoScrapeNew(fresh);
        return out;
      })
      : null;
    if (addCoverFile) {
      const fresh = pending ? await pending : await waitNewHashes(before);
      if (!fresh.length) {
        toast('没找到刚添加的种子，封面未设置', 'err');
      } else {
        const file = addCoverFile;
        const done = await Promise.all(fresh.map((h) => uploadCoverFile(h, file, true)));
        if (done.some(Boolean)) toast('封面已设置', 'ok');
        renderRows();
      }
      resetAddCover();
    } else if (wantTvdb) {
      const fresh = pending ? await pending : await waitNewHashes(before);
      if (!fresh.length) {
        toast('没找到刚添加的种子，海报未套用', 'err');
      } else {
        let done = 0;
        for (const h of fresh) {
          try {
            const res = await fetch(`/__cover/tvdb/apply?hash=${h}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(wantTvdb),
            });
            if (!res.ok) continue;
            done++;
            state.coverMode.set(h, 'tvdb');
            state.coverV.set(h, Date.now());
            const el = rowCache.get(h);
            if (el) el._v.coverKey = null;
          } catch { /* 一个失败不影响其它 */ }
        }
        if (done) {
          toast(`已刮削《${wantTvdb.name}》的海报`, 'ok');
          renderRows();
          refreshMediaTitles();
        } else {
          toast('海报套用失败', 'err');
        }
      }
      resetAddCover();
    } else if (pending) {
      pending.catch(() => {});
    }
  } catch (err) {
    toast(err.message || '添加失败', 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '开始下载';
  }
});

/* ══════════ 设置 ══════════ */
$('#settingsBtn').addEventListener('click', openSettings);

async function openSettings() {
  openModal('settingsModal');
  try {
    const info = await fetch('/__state').then((r) => r.json());
    $('#setTarget').value = info.target;
    const lan = (info.lan || []).map((ip) => `http://${ip}:${info.port}`).join('  ·  ');
    $('#setLanHint').textContent = lan ? `手机访问：${lan}` : '';
    const p = await loadPrefs();
    $('#setDlLimit').value = Math.round((p.dl_limit || 0) / 1024);
    $('#setUpLimit').value = Math.round((p.up_limit || 0) / 1024);
    $('#setAltSpeed').checked = Boolean(p.use_alt_speed_limits);
    const s = state.server;
    $('#setTotalDl').textContent = fmtBytes(s.alltime_dl || 0);
    $('#setTotalUp').textContent = fmtBytes(s.alltime_ul || 0);
    $('#setGlobalRatio').textContent = Number(s.global_ratio || 0).toFixed(2);
  } catch (err) { /* 忽略 */ }
  $('#setTheme').value = localStorage.getItem(LS.theme) || 'system';
  $('#setInterval').value = String(state.pollMs);
  $('#setThumbs').checked = state.coverOn;
  const am = $('#setAddMode');
  if (am) am.value = addMode;
  const lt = $('#setListTitle');
  if (lt) lt.value = state.listTitleMode;
  refreshCacheInfo();
  refreshTvdbInfo();
  // 真机视口/安全区读数：iOS 适配排障用，平时就是一行小字
  const vp = $('#setViewportInfo');
  if (vp) {
    window.__syncSafeArea?.();
    const d = window.__iosDebug;
    const cssV = (document.querySelector('link[rel="stylesheet"]')?.href.match(/[?&]v=([^&]+)/) || [])[1] || 'base';
    vp.textContent = d
      ? `样式 ${cssV} · ${d.standalone ? 'PWA' : '浏览器'} · 视口 ${d.inner} · 屏幕 ${d.screen} · 安全区 上${d.safeTop}/下${d.safeBottom}`
        + (d.deficit > 0 ? ` · 缺口${d.deficit}px已补偿` : ' · 无缺口')
      : '';
  }
}

/** 缓存概况：扫描了多少个种子、缩略图占了多少空间 */
async function refreshCacheInfo() {
  const el = $('#setCacheInfo');
  if (!el) return;
  el.textContent = '读取中…';
  try {
    const s = await fetch('/__cover/cache').then((r) => r.json());
    el.textContent = `目录扫描结果 ${s.scan} 个种子 · TVDB 海报 ${s.tvdb?.count || 0} 张 / ${fmtBytes(s.tvdb?.bytes || 0)}`
      + ` · 目录图片 ${s.dirImages ?? s.images} 张 / ${fmtBytes(s.dirBytes ?? s.bytes)}`;
  } catch { el.textContent = '读取失败'; }
}

/** 拉一次全量媒体名（TVDB 刮削结果，供列表标题显示），体积极小随便刷 */
async function refreshMediaTitles() {
  try {
    const data = await fetch('/__cover/titles').then((r) => r.json());
    state.mediaTitles = new Map(Object.entries(data || {}));
    renderRows(); // mKey 变化的行会自动重算标题
  } catch { /* 拉不到就先用原始名 */ }
}

/* ══════════ 设置：TheTVDB 刮削 ══════════ */

/** 拉一次服务端状态：密钥在服务端，页面只拿到「配好没有」 */
async function refreshTvdbInfo() {
  const info = $('#setTvdbInfo');
  if (!info) return;
  info.textContent = '读取中…';
  try {
    const st = await fetch('/__cover/tvdb/status').then((r) => r.json());
    Object.assign(state.tvdb, {
      enabled: Boolean(st.enabled), configured: Boolean(st.configured), auto: st.auto || 'off', lang: st.lang || 'eng',
    });
    $('#setTvdbEnabled').checked = Boolean(st.enabled);
    $('#setTvdbLang').value = st.lang || 'zho';
    $('#setTvdbAuto').value = st.auto || 'off';
    if (!$('#setTvdbKey').value) $('#setTvdbKey').value = '';
    $('#setTvdbKey').placeholder = st.keyHint ? `已保存：${st.keyHint}` : 'thetvdb.com → Dashboard → API Keys';
    $('#setTvdbKeyHint').textContent = st.hasEnvKey ? '来自环境变量' : st.configured ? '已配置' : '未配置';
    const u = st.usage || {};
    const usageTxt = u.blockedUntil
      ? ` · 已限流，${new Date(u.blockedUntil).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 后恢复`
      : ` · 今日已调用 ${u.calls || 0} 次`;
    info.textContent = st.configured
      ? `已配置 · 海报语言 ${st.lang || '不限'} · 自动刮削${st.auto === 'new' ? '：新加入的影视种子' : '：仅手动'}${usageTxt}`
      : '还没填 API Key：去 thetvdb.com 登录 → Dashboard → API Keys 申请一个（免费的）';
  } catch { info.textContent = '读取失败'; }
}

$('#setTvdbSave').addEventListener('click', async () => {
  const btn = $('#setTvdbSave');
  btn.disabled = true;
  btn.textContent = '测试中…';
  try {
    const res = await fetch('/__cover/tvdb/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiKey: $('#setTvdbKey').value.trim() || undefined,
        pin: $('#setTvdbPin').value.trim(),
        lang: $('#setTvdbLang').value,
        auto: $('#setTvdbAuto').value,
        enabled: $('#setTvdbEnabled').checked,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || '保存失败');
    const t = await fetch('/__cover/tvdb/test', { method: 'POST' }).then((r) => r.json());
    if (t.ok) toast(`TheTVDB 连接正常（${t.ms}ms）`, 'ok');
    else toast(t.message || '连接失败，检查 API Key', 'err');
    $('#setTvdbKey').value = '';
    $('#setTvdbPin').value = '';
    refreshTvdbInfo();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '保存并测试';
  }
});

/** 批量刮削：用 SSE 进度流，界面实时显示「第几个 / 正在刮谁 / 成功多少」 */
let tvdbScanEs = null;

function scrapeStopped(finished = false) {
  if (tvdbScanEs) { tvdbScanEs.close(); tvdbScanEs = null; }
  const btn = $('#setTvdbScan');
  btn.disabled = false;
  btn.innerHTML = '<svg><use href="#i-refresh"/></svg>刮削全部影视种子';
  if (!finished) $('#tvdbScanBox').hidden = true;
}

function scrapeUpdate(s) {
  const box = $('#tvdbScanBox');
  box.hidden = false;
  const pct = s.total ? Math.min(100, Math.round((s.i / s.total) * 100)) : 0;
  $('#tvdbScanBar').style.width = `${pct}%`;
  $('#tvdbScanCount').textContent = `${s.i} / ${s.total}`;
  $('#tvdbScanNow').textContent = s.name ? `正在刮：${s.name}` : '准备中…';
  const bits = [];
  if (s.done) bits.push(`成功 ${s.done}`);
  if (s.skipped) bits.push(`跳过 ${s.skipped}`);
  if (s.failed) bits.push(`没匹配 ${s.failed}`);
  $('#tvdbScanStat').textContent = bits.join(' · ') || '—';
}

function startTvdbScan() {
  if (tvdbScanEs) return;
  const btn = $('#setTvdbScan');
  btn.disabled = true;
  btn.innerHTML = '<svg><use href="#i-refresh"/></svg>刮削中…';
  const agg = { done: 0, skipped: 0, failed: 0, i: 0, total: 0 };
  const es = new EventSource('/__cover/tvdb/scan/stream');
  tvdbScanEs = es;
  es.addEventListener('start', (e) => {
    const d = JSON.parse(e.data || '{}');
    agg.total = d.total || 0;
    scrapeUpdate(agg);
    if (!agg.total) { toast('没有可刮削的种子', 'err'); scrapeStopped(); }
  });
  es.addEventListener('item', (e) => {
    const d = JSON.parse(e.data || '{}');
    agg.i = d.i || agg.i + 1;
    agg.total = d.total || agg.total;
    if (d.status === 'ok') agg.done++;
    else if (d.status === 'skip') agg.skipped++;
    else agg.failed++;
    if (d.status === 'ok') { state.coverMode.set(d.hash, 'tvdb'); state.coverV.set(d.hash, Date.now()); }
    scrapeUpdate({ ...agg, name: d.name });
  });
  es.addEventListener('done', (e) => {
    const d = JSON.parse(e.data || '{}');
    es.close();
    tvdbScanEs = null;
    refreshAllCovers();
    refreshMediaTitles();
    refreshCacheInfo();
    $('#tvdbScanNow').textContent = d.cancelled ? '已停止' : '刮削完成';
    $('#tvdbScanBar').style.width = '100%';
    toast(d.cancelled
      ? `已停止：完成 ${d.done} 个，跳过 ${d.skipped} 个，没匹配 ${d.failed} 个`
      : `刮削完成：成功 ${d.done} 个，跳过 ${d.skipped} 个，没匹配上 ${d.failed} 个`, d.cancelled ? '' : 'ok');
    btn.disabled = false;
    btn.innerHTML = '<svg><use href="#i-refresh"/></svg>刮削全部影视种子';
    setTimeout(() => { $('#tvdbScanBox').hidden = true; }, 2500);
  });
  es.addEventListener('busy', () => {
    es.close();
    tvdbScanEs = null;
    toast('已经有一个刮削任务在跑了', 'err');
    btn.disabled = false;
    btn.innerHTML = '<svg><use href="#i-refresh"/></svg>刮削全部影视种子';
  });
  es.addEventListener('error', (e) => {
    // 服务端推的 error 事件带 message；连接断开时 e.data 为空，交给 onerror 处理
    const msg = e.data ? (JSON.parse(e.data || '{}').message || '刮削失败') : null;
    if (msg) { toast(msg, 'err'); scrapeStopped(); }
  });
  es.onerror = () => { if (tvdbScanEs) { toast('刮削中断（连接已断开）', 'err'); scrapeStopped(); } };
}

$('#setTvdbScan').addEventListener('click', async () => {
  if (tvdbScanEs) return;
  const ok = await confirmDialog({
    title: '刮削全部影视种子？',
    desc: '会给列表里每个影视类种子去 TheTVDB 查一次并下载海报，种子多的时候会花点时间，也消耗 API 额度。已经刮过的会跳过，过程中可以随时点「停止」。',
    okText: '开始刮削',
  });
  if (!ok) return;
  startTvdbScan();
});

$('#tvdbScanCancel').addEventListener('click', () => {
  if (!tvdbScanEs) return;
  tvdbScanEs.close();
  tvdbScanEs = null;
  toast('已停止刮削');
  refreshAllCovers();
  refreshMediaTitles();
  refreshCacheInfo();
  scrapeStopped();
});

/** 新种子加进来后按设置自动刮一次（后台跑，失败也不打扰） */
async function autoScrapeNew(hashes) {
  if (!hashes?.length || state.tvdb.auto !== 'new' || !state.tvdb.enabled) return;
  try {
    const res = await fetch('/__cover/tvdb/auto', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hashes }),
    });
    const data = await res.json().catch(() => ({}));
    const results = data.results || {};
    const hits = Object.entries(results).filter(([, r]) => r.ok);
    if (!hits.length) return;
    const now = Date.now();
    for (const [h] of hits) {
      state.coverMode.set(h, 'tvdb');
      state.coverV.set(h, now);
      const el = rowCache.get(h);
      if (el) el._v.coverKey = null;
    }
    renderRows();
    refreshMediaTitles();
  } catch { /* 联网刮削失败不影响下载 */ }
}

/** 清空后让所有行重新取一次图（服务端缓存没了，版本号也要跟着换） */
function refreshAllCovers() {
  const now = Date.now();
  for (const t of state.list) state.coverV.set(t.hash, now);
  state.kindAsked.clear();
  for (const el of rowCache.values()) el._v.coverKey = null;
  renderRows();
  if (state.detailHash) refreshDetailShell();
}

$('#setCacheScan').addEventListener('click', async () => {
  const btn = $('#setCacheScan');
  btn.disabled = true;
  try {
    const res = await fetch('/__cover/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'scan' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || '清空失败');
    refreshAllCovers();
    toast('扫描缓存已清空，下次会重新扫描目录', 'ok');
    refreshCacheInfo();
  } catch (err) { toast(err.message, 'err'); } finally { btn.disabled = false; }
});

$('#setCacheTvdb').addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: '清空 TheTVDB 缓存？',
    desc: '会删除已下载的 TVDB 海报和搜索 / 作品图缓存。之后打开封面或重新刮削时会再次联网查询，消耗 API 额度。不影响目录缩略图和你上传的封面。',
    okText: '清空',
  });
  if (!ok) return;
  const btn = $('#setCacheTvdb');
  btn.disabled = true;
  try {
    const res = await fetch('/__cover/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'tvdb' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || '清空失败');
    for (const [h, m] of state.coverMode) if (m === 'tvdb') state.coverMode.delete(h);
    state.mediaTitles.clear();
    refreshAllCovers();
    toast('TheTVDB 缓存已清空，下次会重新联网刮削', 'ok');
    refreshCacheInfo();
  } catch (err) { toast(err.message, 'err'); } finally { btn.disabled = false; }
});

$('#setCacheImages').addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: '清空目录图片缓存？',
    desc: '会删除自动生成的目录缩略图，之后按目录内容重新生成。不影响 TVDB 海报和你上传 / 挑选过的封面。',
    okText: '清空',
  });
  if (!ok) return;
  const btn = $('#setCacheImages');
  btn.disabled = true;
  try {
    const res = await fetch('/__cover/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'images' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || '清空失败');
    refreshAllCovers();
    toast('目录图片缓存已清空，之后会按目录内容重新生成', 'ok');
    refreshCacheInfo();
  } catch (err) { toast(err.message, 'err'); } finally { btn.disabled = false; }
});

$('#setTargetSave').addEventListener('click', async () => {
  const url = $('#setTarget').value.trim();
  try {
    const res = await fetch('/__config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || '保存失败');
    toast('已切换，正在重连…', 'ok');
    state.rid = 0;
    closeModal('settingsModal');
    bootAuth();
  } catch (err) { toast(err.message, 'err'); }
});

$('#setLimitSave').addEventListener('click', async () => {
  try {
    const dl = Number($('#setDlLimit').value || 0) * 1024;
    const up = Number($('#setUpLimit').value || 0) * 1024;
    await post(`/transfer/setDownloadLimit?limit=${dl}`);
    await post(`/transfer/setUploadLimit?limit=${up}`);
    const altNow = Boolean(state.server.use_alt_speed_limits);
    if (altNow !== $('#setAltSpeed').checked) await post('/transfer/toggleSpeedLimitsMode');
    state.prefs = null;
    toast('限速已应用', 'ok');
    refreshNow();
  } catch (err) { toast(err.message, 'err'); }
});

$('#setTheme').addEventListener('change', (e) => {
  applyTheme(e.target.value);
});

$('#setInterval').addEventListener('change', (e) => {
  state.pollMs = Number(e.target.value);
  localStorage.setItem(LS.interval, String(state.pollMs));
  schedule();
  toast(state.pollMs ? `刷新频率 ${state.pollMs / 1000}s` : '已切换为手动刷新');
});

$('#setThumbs').addEventListener('change', (e) => {
  setCoverOn(e.target.checked);
  toast(e.target.checked ? '列表已显示缩略图' : '列表已隐藏缩略图');
});

$('#setAddMode').addEventListener('change', (e) => {
  applyAddMode(e.target.value);
  localStorage.setItem(LS.addMode, addMode);
  toast(addMode === 'file' ? '添加种子默认用 .torrent 文件' : '添加种子默认用链接 / Magnet');
});

$('#setListTitle').addEventListener('change', (e) => {
  state.listTitleMode = e.target.value;
  localStorage.setItem(LS.listTitle, state.listTitleMode);
  renderRows(); // 标题缓存键里有 mode，直接重算
});

$('#setLogout').addEventListener('click', async () => {
  await fetch('/__logout', { method: 'POST' });
  localStorage.removeItem(LS.creds);
  closeModal('settingsModal');
  $('#loginModal').hidden = false;
  toast('已退出登录');
});

/* ══════════ 概览（移动） ══════════ */
function openStats() {
  const s = state.server;
  const counts = { dl: 0, seed: 0, pause: 0, err: 0 };
  state.list.forEach((t) => {
    if (matchFilter(t, 'downloading')) counts.dl++;
    if (matchFilter(t, 'seeding')) counts.seed++;
    if (isPaused(t)) counts.pause++;
    if (matchFilter(t, 'error')) counts.err++;
  });
  $('#statsBody').innerHTML = `
    <div class="mini-stats">
      <div><small>下载速度</small><b style="color:var(--dl)">${fmtSpeed(s.dl_info_speed || 0)}</b></div>
      <div><small>上传速度</small><b style="color:var(--up)">${fmtSpeed(s.up_info_speed || 0)}</b></div>
      <div><small>剩余空间</small><b>${fmtBytes(s.free_space_on_disk || 0)}</b></div>
    </div>
    <div class="mini-stats">
      <div><small>下载中</small><b>${counts.dl}</b></div>
      <div><small>做种中</small><b>${counts.seed}</b></div>
      <div><small>已暂停</small><b>${counts.pause}</b></div>
    </div>
    <div class="card-block">
      <div class="block-title"><svg><use href="#i-activity"/></svg>累计流量</div>
      <div class="mini-stats">
        <div><small>下载</small><b>${fmtBytes(s.alltime_dl || 0)}</b></div>
        <div><small>上传</small><b>${fmtBytes(s.alltime_ul || 0)}</b></div>
        <div><small>分享率</small><b>${Number(s.global_ratio || 0).toFixed(2)}</b></div>
      </div>
    </div>
    <div class="card-block">
      <div class="block-title"><svg><use href="#i-wifi"/></svg>连接状态</div>
      <div class="kv" style="border:0"><span>DHT 节点</span><b>${s.dht_nodes ?? 0}</b></div>
      <div class="kv" style="border:0"><span>已连接 Peers</span><b>${s.total_peer_connections ?? 0}</b></div>
      <div class="kv" style="border:0"><span>备用速度</span><b>${s.use_alt_speed_limits ? '已开启' : '已关闭'}</b></div>
      <button class="btn btn-soft" id="statsAltBtn">切换备用速度限制</button>
    </div>
  `;
  openModal('statsModal');
  const altBtn = $('#statsAltBtn');
  if (altBtn) altBtn.addEventListener('click', toggleAltSpeed);
}

async function toggleAltSpeed() {
  try {
    await post('/transfer/toggleSpeedLimitsMode');
    toast('已切换限速模式', 'ok');
    refreshNow();
  } catch (err) { toast(err.message, 'err'); }
}

/* ══════════ 移动端导航 ══════════ */
$$('[data-mnav]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const act = btn.dataset.mnav;
    if (act === 'filter') { openSidebar(); return; }
    if (act === 'stats') { openStats(); return; }
    if (act === 'settings') { openSettings(); return; }
    closeSidebar();
    closeDetail();
    window.scrollTo({ top: 0 });
  });
});

function openSidebar() {
  $('#sidebar').classList.add('is-open');
  $('#scrim').classList.add('is-open');
}
function closeSidebar() {
  $('#sidebar').classList.remove('is-open');
  $('#scrim').classList.remove('is-open');
}
$('#menuBtn').addEventListener('click', openSidebar);
$('#sideClose').addEventListener('click', closeSidebar);
$('#scrim').addEventListener('click', closeSidebar);

/* ══════════ 主题 ══════════ */
function applyTheme(mode) {
  if (mode === 'system') {
    localStorage.removeItem(LS.theme);
    mode = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } else {
    localStorage.setItem(LS.theme, mode);
  }
  document.documentElement.dataset.theme = mode;
  /* 状态栏底色 = 页面实色（--bg），与 index.html 里的 __syncThemeColor 同一实现 */
  if (window.__syncThemeColor) window.__syncThemeColor();
}

$('#themeBtn').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem(LS.theme, next);
  applyTheme(next);
});

$('#altSpeedBtn').addEventListener('click', toggleAltSpeed);

$('#thumbBtn').addEventListener('click', () => {
  const next = !state.coverOn;
  setCoverOn(next);
  toast(next ? '已显示缩略图' : '已隐藏缩略图');
});

/* ══════════ 登录 ══════════ */
let loginRetried = false;

function onUnauthorized() {
  state.loggedIn = false;
  if (!$('#loginModal').hidden) return;
  $('#loginTarget').textContent = config.target || location.origin;
  fetch('/__state').then((r) => r.json()).then((d) => {
    config.target = d.target;
    $('#loginTarget').textContent = d.target;
  }).catch(() => {});
  const creds = readCreds();
  if (creds && !loginRetried) {
    loginRetried = true;
    $('#loginRemember').checked = true;
    doLogin(creds.username, creds.password, true);
    return;
  }
  $('#loginUser').value = creds?.username || '';
  $('#loginModal').hidden = false;
  setTimeout(() => $('#loginUser').focus(), 200);
}

function readCreds() {
  try { return JSON.parse(localStorage.getItem(LS.creds) || 'null'); } catch { return null; }
}

async function doLogin(username, password, silent) {
  try {
    const res = await fetch('/api/v2/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password }),
    });
    const text = (await res.text()).trim();
    if (/ok/i.test(text)) {
      state.loggedIn = true;
      loginRetried = false;
      $('#loginModal').hidden = true;
      $('#loginErr').hidden = true;
      if ($('#loginRemember').checked) {
        localStorage.setItem(LS.creds, JSON.stringify({ username, password }));
        // 双保险：服务端也存一份（iOS PWA 的 WebKit 会 7 天清一次 localStorage，
        // 但清不掉服务端 config.json —— 会话由服务端自动续）
        fetch('/__auth', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username, password }),
        }).catch(() => {});
      } else {
        localStorage.removeItem(LS.creds);
        fetch('/__auth', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clear: true }),
        }).catch(() => {});
      }
      if (!silent) toast('登录成功', 'ok');
      state.rid = 0;
      refreshNow();
      return true;
    }
    throw new Error('用户名或密码错误');
  } catch (err) {
    if (!silent) {
      $('#loginErr').textContent = err.message || '登录失败';
      $('#loginErr').hidden = false;
    }
    $('#loginModal').hidden = false;
    return false;
  }
}

$('#loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const btn = $('#loginSubmit');
  btn.disabled = true;
  btn.textContent = '登录中…';
  doLogin($('#loginUser').value, $('#loginPass').value, false).finally(() => {
    btn.disabled = false;
    btn.textContent = '登录';
  });
});

$('#pwEye').addEventListener('click', () => {
  const input = $('#loginPass');
  input.type = input.type === 'password' ? 'text' : 'password';
});

async function bootAuth() {
  try {
    await api('/app/version');
    state.loggedIn = true;
    $('#loginModal').hidden = true;
    tick();
  } catch (err) {
    if (!err.unauthorized) {
      toast(err.message || '无法连接 qBittorrent', 'err');
    }
  }
}

/* ══════════ 快捷键 ══════════ */
document.addEventListener('keydown', (e) => {
  const typing = /input|textarea|select/i.test(document.activeElement?.tagName || '');
  if (e.key === 'Escape') {
    // 预览层在最上面：Escape 只关预览，不要把背后的详情抽屉一起关了
    if (viewerEl) { closeViewer(); return; }
    if (document.body.dataset.modal) {
      if (document.body.dataset.modal !== 'loginModal') closeModal(document.body.dataset.modal);
      return;
    }
    if (state.detailHash) return closeDetail();
    if (state.selected.size) { state.selected.clear(); renderRows(); return; }
    if (isMobile()) closeSidebar();
    return;
  }
  if (viewerEl || typing) return;

  if (e.key === '/' || (e.key === 'f' && (e.metaKey || e.ctrlKey))) {
    e.preventDefault();
    $('#searchInput').focus();
    $('#searchInput').select();
  } else if (e.key === 'a') {
    openAddModal();
  } else if (e.key === ' ' && !document.body.dataset.modal) {
    e.preventDefault();
    const list = visibleTorrents();
    const hashes = state.selected.size ? [...state.selected] : list.length ? [list[0].hash] : [];
    if (hashes.length) {
      const anyActive = hashes.some((h) => !isPaused(state.map.get(h)));
      setPaused(hashes, anyActive).then(() => refreshNow()).catch((err) => toast(err.message, 'err'));
    }
  }
});

/* ══════════ 启动 ══════════ */
async function boot() {
  applyTheme(localStorage.getItem(LS.theme) || 'system');
  loadKinds(); // 上次记住的类型，让第一帧就不空着
  setCoverOn(state.coverOn, false);
  registerServiceWorker();
  // 服务端才知道有没有配 TheTVDB，先问一次，添加种子时要按它决定要不要自动刮削
  fetch('/__cover/tvdb/status').then((r) => r.json()).then((st) => {
    Object.assign(state.tvdb, {
      enabled: Boolean(st.enabled), configured: Boolean(st.configured), auto: st.auto || 'off', lang: st.lang || 'eng',
    });
  }).catch(() => {});
  refreshMediaTitles(); // 列表标题要用刮削名，先拉一次全量
  updateSortUI();
  setFilter('all');
  try {
    state.categories = await apiJson('/torrents/categories');
  } catch { state.categories = {}; }
  await bootAuth();
  // 分类偶尔会新增，低频同步
  setInterval(async () => {
    try { state.categories = await apiJson('/torrents/categories'); } catch { /* noop */ }
  }, 60000);
  window.addEventListener('resize', () => {
    if (!isMobile()) closeSidebar();
  });
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshNow();
});

/* ══════════ Service Worker（iOS PWA 秒开 / 离线壳 / 版本更新） ══════════ */

/** 手动检查界面更新：iOS PWA 的 SW 更新很懒，给个按钮兜底 */
$('#setCheckUpdate')?.addEventListener('click', async () => {
  const btn = $('#setCheckUpdate');
  btn.disabled = true;
  try {
    if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) {
      // 没有 SW（或首次），直接重载页面就能拿到最新
      location.reload();
      return;
    }
    const reg = await navigator.serviceWorker.getRegistration();
    const next = await reg?.update();
    const waiting = next?.waiting || next?.installing;
    if (waiting) {
      toast('新版本已就绪，即将刷新', 'ok');
      waiting.postMessage('SKIP_WAITING');
      setTimeout(() => location.reload(), 1200);
    } else {
      toast('已是最新版本', 'ok');
    }
  } catch (err) {
    toast(`检查失败：${err.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
});

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol !== 'http:' && location.protocol !== 'https:') return;
  // 有新版本接管页面时刷新一次（首次安装的 controllerchange 不算）
  let hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) location.reload();
  });
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    // 打开应用时检查一次更新；iOS PWA 的 SW 更新很懒，回前台也补一次
    reg.update().catch(() => {});
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) reg.update().catch(() => {});
    });
  }).catch(() => {});
}

boot();

// 便于调试：控制台可访问 __qb
window.__qb = state;
