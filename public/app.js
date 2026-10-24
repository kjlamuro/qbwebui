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
  categories: {},
  tags: [],
  pollMs: Number(localStorage.getItem(LS.interval) ?? 2000),
  connected: false,
  firstLoad: true,
  prefs: null,
  loggedIn: false,
  pending: new Map(), // 乐观状态覆盖，避免轮询回弹造成的闪烁
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
      const hay = `${t.name} ${t.category} ${t.tags} ${t.hash}`.toLowerCase();
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
    <div class="cell name"><div class="t-name"></div><div class="t-sub"></div></div>
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
    name: $('.t-name', el),
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
  return el;
}

function updateRow(el, t) {
  const r = el._refs;
  const v = el._v;
  const st = statusOf(t);

  if (v.name !== t.name) { r.name.textContent = t.name; r.name.title = t.name; v.name = t.name; }

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

async function tick() {
  if (polling) return;
  polling = true;
  try {
    const [torrents, sync] = await Promise.all([
      apiJson('/torrents/info'),
      apiJson(`/sync/maindata?rid=${state.rid}`),
    ]);
    if (Array.isArray(torrents)) {
      state.list = torrents;
      state.map = new Map(torrents.map((t) => [t.hash, t]));
    }
    if (state.pending.size) {
      const now = Date.now();
      for (const [h, p] of state.pending) {
        if (now > p.until) { state.pending.delete(h); continue; }
        const t = state.map.get(h);
        if (t) t.state = p.state;
      }
    }
    if (sync && sync.server_state) {
      // 增量响应里 server_state 只包含变化的字段，需要合并
      state.server = { ...state.server, ...sync.server_state };
      if (sync.rid) state.rid = sync.rid;
    }
    state.firstLoad = false;
    renderRows();
    renderServer();
    if (state.detailHash) refreshDetailShell();
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
  state.detailHash = hash;
  state.detailData = null;
  state.detailTab = 'files';
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
      tabContent = files.length
        ? `<div class="d-list-head">点击左侧方框可跳过 / 恢复该文件</div>` + files.map((f, i) => `
          <div class="file-row">
            <button class="f-toggle ${f.priority > 0 ? 'on' : ''}" data-file="${i}" data-priority="${f.priority}">
              <svg><use href="#i-check"/></svg>
            </button>
            <span class="f-name ${f.priority === 0 ? 'is-skip' : ''}">${esc(f.name)}</span>
            <span class="f-size">${fmtBytes(f.size)}</span>
            <span class="f-prog">${(f.progress * 100).toFixed(0)}%</span>
          </div>`).join('')
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
  body.scrollTop = prevScroll;

  // 底部操作
  const paused = isPaused(t);
  $('#detailFoot').innerHTML = `
    <button class="btn btn-soft" data-detail="toggle">${paused ? '<svg><use href="#i-play"/></svg>继续' : '<svg><use href="#i-pause"/></svg>暂停'}</button>
    <button class="btn btn-ghost" data-detail="menu"><svg><use href="#i-more"/></svg>更多</button>
    <button class="btn btn-ghost danger" data-detail="delete"><svg><use href="#i-trash"/></svg>删除</button>
  `;
}

$('#detailBody').addEventListener('click', async (e) => {
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
let addMode = 'link';
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
  openModal('addModal');
  setTimeout(() => { if (!isMobile()) $('#addUrls').focus(); }, 120);
  if (!$('#addPath').value) $('#addPath').value = (await loadPrefs()).save_path || '';
  updatePathHint();
}

$('#addSeg').addEventListener('click', (e) => {
  const item = e.target.closest('[data-seg]');
  if (!item) return;
  addMode = item.dataset.seg;
  $$('#addSeg .seg-item').forEach((el) => el.classList.toggle('is-active', el === item));
  $$('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== addMode; });
});

$('#addFile').addEventListener('change', (e) => {
  addFiles = Array.from(e.target.files || []);
  $('#dropText').textContent = addFiles.length ? `已选择 ${addFiles.length} 个文件：${addFiles.map((f) => f.name).join('、')}` : '点击选择或拖入 .torrent 文件';
});

const dz = $('#dropzone');
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('is-over'); }));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('is-over'); }));
dz.addEventListener('drop', (e) => {
  const files = Array.from(e.dataTransfer.files || []).filter((f) => f.name.endsWith('.torrent'));
  if (files.length) {
    addFiles = files;
    $('#dropText').textContent = `已选择 ${files.length} 个文件：${files.map((f) => f.name).join('、')}`;
  }
});

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
  try {
    const res = await api('/torrents/add', { method: 'POST', body: fd });
    if (/fail/i.test(res)) throw new Error('qBittorrent 拒绝了该种子');
    closeModal('addModal');
    if (path) rememberPath(path);
    $('#addUrls').value = '';
    $('#addTags').value = '';
    addFiles = [];
    $('#dropText').textContent = '点击选择或拖入 .torrent 文件';
    toast('已添加到下载队列', 'ok');
    refreshNow();
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
}

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
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', mode === 'light' ? '#f4f5f9' : '#0b0d12');
}

$('#themeBtn').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem(LS.theme, next);
  applyTheme(next);
});

$('#altSpeedBtn').addEventListener('click', toggleAltSpeed);

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
    if (document.body.dataset.modal) {
      if (document.body.dataset.modal !== 'loginModal') closeModal(document.body.dataset.modal);
      return;
    }
    if (state.detailHash) return closeDetail();
    if (state.selected.size) { state.selected.clear(); renderRows(); return; }
    if (isMobile()) closeSidebar();
    return;
  }
  if (typing) return;

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

boot();

// 便于调试：控制台可访问 __qb
window.__qb = state;
