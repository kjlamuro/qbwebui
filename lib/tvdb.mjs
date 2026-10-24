/**
 * TheTVDB v4 刮削客户端
 *
 * 只做三件事：把种子名解析成「片名 + 年份 + 季」、按这个去 TVDB 搜索、把选中的海报
 * 下载到本地缓存目录。所有网络请求都在服务端完成，浏览器不直接访问 TVDB（避免跨域，
 * 也避免把 API Key 暴露给页面）。
 *
 * 认证：POST /login 用 apikey 换一个有效期 1 个月的 Bearer token，缓存在内存和
 * data/tvdb.json 里，过期或 401 时自动重取。
 *
 * API Key 属于「申请时登记的那个项目」，按 TheTVDB 服务条款是 non-transferable 的，
 * 所以这里不内置任何密钥：从环境变量 TVDB_API_KEY 读，或者在设置面板里填（存到
 * gitignore 掉的 data/tvdb.json）。
 *
 * 归属声明（TheTVDB 要求，除非另行书面同意）：展示其元数据的界面必须给出指向
 * thetvdb.com 的链接 —— 封面弹窗和设置面板里都有。
 */

import path from 'node:path';
import { mkdir, readdir, writeFile, readFile, unlink } from 'node:fs/promises';

const API = 'https://api4.thetvdb.com/v4';
const UA = 'qBWebUI/1.0 (+https://github.com/)';
/** 官方给的 token 有效期一个月，这里提前 10 天换，别卡在最后一天 */
const TOKEN_TTL = 20 * 24 * 3600_000;
const Q_TTL = 7 * 24 * 3600_000;
/** 译名几乎是死的，缓存放久一点，省下来的都是 API 额度 */
const TR_TTL = 60 * 24 * 3600_000;
const Q_MAX = 400;
/** 刮削语言默认用中文（大陆简体）；TVDB 的语言代码是 ISO 639-2 三字母 */
const LANG_DEFAULT = 'zho';
const MAX_IMAGE = 12 * 1024 * 1024;

/* ── 种子名解析 ───────────────────────────────────────── */

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function toNum(s) {
  if (!s) return 0;
  if (/^\d+$/.test(s)) return Number(s);
  if (s.length === 1 && CN_NUM[s]) return CN_NUM[s];
  if (s === '十') return 10;
  if (/^十[一二三四五六七八九]$/.test(s)) return 10 + CN_NUM[s[1]];
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 噪音词：分辨率 / 来源 / 编码 / 制作组 / 语言标记……
 * 出现第一个这样的词，后面的内容一律不再算进片名。
 */
const NOISE = new Set(`2160p 1080p 1080i 720p 480p 576p 360p 4k 8k uhd hdr hdr10 hdr10+ sdr dv dolby vision
atmos dts dtshd dts-hd truehd aac ac3 eac3 flac lpcm mp3 opus pcm x264 x265 h264 h265 hevc av1 vp9 xvid divx
10bit 8bit 12bit remux bluray blu-ray brrip bdrip webrip web-dl webdl web hdrip hdtv pdtv dvdrip dvd dvdscr
bdr bd cam tc hc iso amzn nf netflix dsnp disney hmax atvp pcok stan hulu imax proper repack internal limited
unrated extended remastered directors criterion collection complete season series episode multi dual sub subs
subbed dubbed chs cht gb big5 chinese english japanese korean jp kr us uk fr de it es ru mini pack trilogy
saga ova oad sp specials extras bonus 2160 1080 720 diy 国语 中字 双语 简体 繁体 外挂 字幕 合集 全季
`.split(/\s+/).filter(Boolean));

const isNoise = (tok) => NOISE.has(tok.toLowerCase().replace(/^[^\w一-龥]+|[^\w一-龥]+$/g, ''));

/**
 * 种子名 → { title, year, season, episode, isSeries }
 *
 * 例：
 *   The.Matrix.1999.1080p.BluRay.x264-GRP   → { title: 'The Matrix', year: '1999', isSeries: false }
 *   Severance.S02E03.1080p.WEB-DL           → { title: 'Severance', season: 2, episode: 3, isSeries: true }
 *   [Group] 三体 第1季 4K                    → { title: '三体', season: 1, isSeries: true }
 */
export function parseTitle(raw) {
  const src = String(raw || '').trim();
  let s = src
    .replace(/\.(part|!qb|unconfirmed)$/i, '')
    .replace(/\.[a-z0-9]{2,4}$/i, ''); // 去掉扩展名

  // 前面的方括号基本都是制作组，直接丢；尾部的同理
  s = s.replace(/^\s*[\[【(][^\]】)]*[\]】)]\s*/, '').replace(/\s*[\[【(][^\]】)]*[\]】)]\s*$/, '');

  let season = 0;
  let episode = 0;
  let cut = s.length;

  const se = /\bS(\d{1,2})[\s._-]*E(\d{1,3})\b/i.exec(s);
  if (se) {
    season = toNum(se[1]);
    episode = toNum(se[2]);
    cut = Math.min(cut, se.index);
  } else {
    const st = /\bS(?:eason)?[\s._-]*(\d{1,2})\b/i.exec(s) || /第\s*([0-9一二三四五六七八九十]+)\s*季/.exec(s);
    if (st) {
      season = toNum(st[1]);
      cut = Math.min(cut, st.index);
    }
    const ep = /\bE(?:p(?:isode)?)[\s._-]*(\d{1,3})\b/i.exec(s) || /第\s*([0-9]+)\s*集/.exec(s);
    if (ep) {
      episode = toNum(ep[1]);
      cut = Math.min(cut, ep.index);
    }
  }

  const ym = /\b(19\d{2}|20[0-4]\d)\b/.exec(s);
  const year = ym ? ym[1] : '';
  if (ym && ym.index > 0) cut = Math.min(cut, ym.index);

  // 主干里再按噪音词切一刀
  let main = s.slice(0, cut === s.length ? s.length : cut);
  const tokens = main.split(/[\s._+\[\](){}【】-]+/).filter(Boolean);
  const kept = [];
  for (const t of tokens) {
    if (isNoise(t)) break;
    kept.push(t);
  }
  let title = kept.join(' ').trim();
  if (!title) title = tokens.filter((t) => !isNoise(t)).join(' ').trim();
  if (!title) title = src.replace(/[\s._]+/g, ' ').trim().slice(0, 60);

  const isSeries = season > 0 || episode > 0 || /\bS\d{1,2}[\s._-]*E\d{1,3}\b/i.test(src) || /第\s*[0-9一二三四五六七八九十]+\s*季/.test(src);

  return { title, year, season, episode, isSeries, raw: src };
}

/** 比片名用的归一化：只留字母数字和 CJK，方便判断「是不是同一个名字」 */
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/* ── 客户端 ───────────────────────────────────────────── */

export function createTvdb({ root, dataDir, shrink = async () => false, onLog = () => {} }) {
  const dir = path.join(root, 'tvdb');
  const cfgPath = path.join(dataDir, 'tvdb.json');
  const cfg = { apiKey: '', pin: '', lang: LANG_DEFAULT, enabled: false, auto: 'off', token: '', tokenAt: 0 };
  const cache = { q: {}, art: {} };
  /** 用量统计：官方没公开配额数字，所以自己数着用——按自然日累计，撞到 429 就短期熔断 */
  const usage = { day: '', calls: 0, blockedUntil: 0, last429: 0 };
  let login$ = null;

  async function ready() {
    await mkdir(dir, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(cfgPath, 'utf8'));
      if (raw && typeof raw === 'object') Object.assign(cfg, raw);
    } catch { /* 首次运行 */ }
    // 环境变量优先：部署时不方便进页面填就用它
    if (process.env.TVDB_API_KEY) cfg.apiKey = process.env.TVDB_API_KEY;
    if (process.env.TVDB_PIN) cfg.pin = process.env.TVDB_PIN;
    try {
      const raw = JSON.parse(await readFile(path.join(dir, 'cache.json'), 'utf8'));
      if (raw && typeof raw === 'object') {
        Object.assign(cache.q, raw.q || {});
        Object.assign(cache.art, raw.art || {});
        if (raw.usage && typeof raw.usage === 'object') Object.assign(usage, raw.usage);
      }
    } catch { /* 没有缓存 */ }
  }

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf8')
        .catch((err) => onLog(`TVDB 配置写入失败：${err.message}`));
    }, 500);
    if (saveTimer.unref) saveTimer.unref();
  }

  let cacheTimer = null;
  function saveCache() {
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(() => {
      trimCache();
      writeFile(path.join(dir, 'cache.json'), JSON.stringify({ ...cache, usage }), 'utf8')
        .catch((err) => onLog(`TVDB 缓存写入失败：${err.message}`));
    }, 3000);
    if (cacheTimer.unref) cacheTimer.unref();
  }

  function trimCache() {
    for (const bucket of [cache.q, cache.art]) {
      const keys = Object.keys(bucket);
      if (keys.length <= Q_MAX) continue;
      keys.sort((a, b) => (bucket[a].at || 0) - (bucket[b].at || 0));
      for (const k of keys.slice(0, keys.length - Q_MAX)) delete bucket[k];
    }
  }

  const apiKey = () => String(process.env.TVDB_API_KEY || cfg.apiKey || '').trim();
  const pin = () => String(process.env.TVDB_PIN || cfg.pin || '').trim();
  const configured = () => Boolean(apiKey());

  function status() {
    const key = apiKey();
    return {
      enabled: Boolean(cfg.enabled) && configured(),
      configured: configured(),
      hasEnvKey: Boolean(process.env.TVDB_API_KEY),
      keyHint: key ? `${key.slice(0, 4)}…${key.slice(-4)}` : '',
      pin: Boolean(pin()),
      lang: cfg.lang || LANG_DEFAULT,
      auto: cfg.auto || 'off',
      usage: {
        day: usage.day || today(),
        calls: usage.day === today() ? usage.calls : 0,
        blockedUntil: usage.blockedUntil > Date.now() ? usage.blockedUntil : 0,
        last429: usage.last429 || 0,
      },
    };
  }

  async function configure(patch = {}) {
    if (typeof patch.apiKey === 'string') {
      const next = patch.apiKey.trim();
      if (next && next !== cfg.apiKey) { cfg.token = ''; cfg.tokenAt = 0; }
      cfg.apiKey = next;
    }
    if (typeof patch.pin === 'string') {
      const next = patch.pin.trim();
      if (next !== cfg.pin) { cfg.token = ''; cfg.tokenAt = 0; }
      cfg.pin = next;
    }
    if (typeof patch.lang === 'string') cfg.lang = patch.lang;
    if (patch.auto === 'off' || patch.auto === 'new') cfg.auto = patch.auto;
    if (typeof patch.enabled === 'boolean') cfg.enabled = patch.enabled;
    if (cfg.enabled === undefined) cfg.enabled = false;
    save();
    return status();
  }

  async function login(force = false) {
    if (!configured()) throw new Error('还没填 TheTVDB API Key');
    if (!force && cfg.token && Date.now() - cfg.tokenAt < TOKEN_TTL) return cfg.token;
    // 并发进来只登一次，别把额度浪费在重复登录上
    login$ ||= (async () => {
      const body = { apikey: apiKey() };
      const p = pin();
      if (p) body.pin = p;
      const r = await fetch(`${API}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data?.data?.token) {
        const msg = r.status === 401 ? 'TheTVDB 拒绝了这次登录，检查 API Key（以及订阅者 PIN）' : `TheTVDB 登录失败（${r.status}）`;
        throw new Error(msg);
      }
      cfg.token = data.data.token;
      cfg.tokenAt = Date.now();
      save();
      return cfg.token;
    })().finally(() => { login$ = null; });
    return login$;
  }

  const today = () => new Date().toISOString().slice(0, 10);

  /** 记一次调用；跨天自动归零 */
  function countCall() {
    const d = today();
    if (usage.day !== d) { usage.day = d; usage.calls = 0; }
    usage.calls += 1;
    saveCache();
  }

  async function api(pathname, retry = true) {
    // 撞过 429 就先歇一会儿，别把额度继续烧在无谓的重试上
    if (usage.blockedUntil > Date.now()) {
      const min = Math.ceil((usage.blockedUntil - Date.now()) / 60000);
      throw new Error(`TheTVDB 刚才限流了，先歇 ${min} 分钟再试`);
    }
    const token = await login();
    const r = await fetch(`${API}${pathname}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': UA },
      signal: AbortSignal.timeout(15000),
    });
    countCall();
    if (r.status === 401 && retry) {
      await login(true);
      return api(pathname, false);
    }
    if (r.status === 429) {
      const wait = Math.max(60, Math.min(3600, Number(r.headers.get('retry-after')) || 0));
      usage.last429 = Date.now();
      usage.blockedUntil = Date.now() + wait * 1000;
      saveCache();
      throw new Error(`TheTVDB 返回 429（请求太频繁），已暂停 ${Math.ceil(wait / 60)} 分钟`);
    }
    if (!r.ok) throw new Error(`TheTVDB ${r.status} ${pathname}`);
    return r.json().catch(() => ({}));
  }

  /** 测试连接：登录 + 一次搜索，能出结果就算通 */
  async function test() {
    const t0 = Date.now();
    await login(true);
    const r = await api('/search?query=matrix&type=movie&limit=1');
    return { ok: true, ms: Date.now() - t0, hits: Array.isArray(r?.data) ? r.data.length : 0 };
  }

  /* ── 搜索 ───────────────────────────────────────────── */

  function score(it, want) {
    const nt = norm(want.title);
    const nn = norm(it.name);
    let s = 0;
    if (nt && nn) {
      if (nn === nt) s += 100;
      else if (nn.startsWith(nt) || nt.startsWith(nn)) s += 62;
      else if (nn.includes(nt) || nt.includes(nn)) s += 40;
      else s += Math.round(30 * similarity(nt, nn));
    }
    if (want.year && it.year) {
      const dy = Math.abs(Number(it.year) - Number(want.year));
      if (dy === 0) s += 22;
      else if (dy <= 1) s += 12;
      else if (dy <= 3) s += 2;
      else s -= 18;
    }
    if (want.isSeries && it.type === 'series') s += 16;
    if (!want.isSeries && want.kind !== 'series' && it.type === 'movie') s += 8;
    return s;
  }

  /** 简单的字符重合率，用于「名字不完全一样但很像」的兜底 */
  function similarity(a, b) {
    if (!a || !b) return 0;
    const set = new Set(b);
    let hit = 0;
    for (const ch of new Set(a)) if (set.has(ch)) hit++;
    return hit / new Set(a + b).size;
  }

  const pick = (r) => {
    const id = String(r?.tvdb_id || r?.id || '');
    if (!id) return null;
    const type = r?.type === 'movie' ? 'movie' : r?.type === 'series' ? 'series' : '';
    if (!type) return null;
    return {
      id,
      type,
      name: r?.name || r?.title || '',
      nameEn: r?.name || r?.title || '', // 译名套上后这里保留 TVDB 的原始（英文）名，方便对照
      year: r?.year ? String(r.year) : '',
      image: r?.image_url || r?.image || r?.thumbnail || '',
      overview: (r?.overview || '').slice(0, 180),
    };
  };

  /**
   * 取指定语言的译名（TheTVDB 的 /search 结果只给英文名，中文条目只能走 translations 端点；
   * 加 lang 参数给 /search 是无效的，实测仍然返回英文名）。没有该语言译名时返回 404，属正常。
   */
  async function translation({ id = '', type = 'series', lang = '' } = {}) {
    if (!id || !lang) return null;
    const seg = type === 'movie' ? 'movies' : 'series';
    const key = `tr:${seg}:${id}:${lang}`;
    const hit = cache.art[key];
    if (hit && Date.now() - hit.at < TR_TTL) return hit.data;
    let data = null;
    try {
      const res = await api(`/${seg}/${encodeURIComponent(id)}/translations/${encodeURIComponent(lang)}`);
      const d = res?.data;
      if (d?.name || d?.overview) data = { name: d.name || '', overview: (d.overview || '').slice(0, 400) };
    } catch { data = null; } // 没有译名 / 网络抽风都当作没有，别把刮削打断
    cache.art[key] = { at: Date.now(), data };
    saveCache();
    return data;
  }

  /** 给候选补译名：展示用中文名，英文名留在 nameEn；只补前 n 个，省额度 */
  async function withTranslations(items, n = 5) {
    const lang = String(cfg.lang || '');
    if (!lang || lang === 'eng' || !items.length) return items;
    await Promise.all(items.slice(0, n).map(async (it) => {
      const tr = await translation({ id: it.id, type: it.type, lang });
      if (!tr?.name) return;
      it.name = tr.name;
      if (tr.overview) it.overview = tr.overview;
    }));
    return items;
  }

  async function search({ query = '', type = '', year = '', isSeries = false, force = false, translate = 5 } = {}) {
    const want = { title: String(query || '').trim(), year: String(year || ''), isSeries };
    if (!want.title) return { items: [], parsed: null };
    // 缓存键带上语言：换语言后不会命中旧语言的译名
    const key = `${type || ''}|${want.year}|${want.isSeries ? 's' : 'm'}|${want.title.toLowerCase()}|${cfg.lang || ''}`;
    const hit = cache.q[key];
    if (!force && hit && Date.now() - hit.at < Q_TTL) return { items: hit.items, parsed: want, cached: true };

    let data = [];
    const qs = new URLSearchParams({ query: want.title, limit: '12' });
    if (type === 'series' || type === 'movie') qs.set('type', type);
    try {
      const res = await api(`/search?${qs}`);
      data = (Array.isArray(res?.data) ? res.data : []).map(pick).filter(Boolean);
    } catch (err) {
      throw err;
    }
    // 指定类型搜不到就放开再试一次
    if (!data.length && type) {
      const res = await api(`/search?${new URLSearchParams({ query: want.title, limit: '12' })}`);
      data = (Array.isArray(res?.data) ? res.data : []).map(pick).filter(Boolean);
    }

    const items = data
      .map((it, i) => ({ ...it, score: score(it, want) - i * 0.4 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);
    await withTranslations(items, translate);
    cache.q[key] = { at: Date.now(), items };
    saveCache();
    return { items, parsed: want, cached: false };
  }

  /* ── 海报 ───────────────────────────────────────────── */

  async function artworks({ id, type = 'series' } = {}) {
    if (!id) return [];
    const key = `${type}-${id}-${cfg.lang || ''}`;
    const hit = cache.art[key];
    if (hit && Date.now() - hit.at < Q_TTL) return hit.items;

    let list = [];
    if (type === 'movie') {
      const res = await api(`/movies/${encodeURIComponent(id)}/extended`);
      list = Array.isArray(res?.data?.artworks) ? res.data.artworks : [];
    } else {
      const lang = cfg.lang ? `&lang=${encodeURIComponent(cfg.lang)}` : '';
      let res = await api(`/series/${encodeURIComponent(id)}/artworks?type=2${lang}`);
      list = Array.isArray(res?.data?.artworks) ? res.data.artworks : [];
      // 指定语言没有海报就放开语言再来一次
      if (!list.length && lang) {
        res = await api(`/series/${encodeURIComponent(id)}/artworks?type=2`);
        list = Array.isArray(res?.data?.artworks) ? res.data.artworks : [];
      }
    }
    // 电视：2=剧集海报、3=背景；电影：14=海报、15=背景
    const posterType = type === 'movie' ? 14 : 2;
    const bgType = type === 'movie' ? 15 : 3;
    const byScore = (a, b) => (Number(b.score) || 0) - (Number(a.score) || 0);
    const posters = list.filter((a) => a?.type === posterType && a?.image).sort(byScore);
    const bgs = list.filter((a) => a?.type === bgType && a?.image).sort(byScore);
    const items = [...posters, ...bgs].slice(0, 24).map((a) => ({
      image: a.image,
      thumb: a.thumbnail || a.image,
      lang: a.language || '',
      kind: a.type === posterType ? 'poster' : 'backdrop',
      w: Number(a.width) || 0,
      h: Number(a.height) || 0,
    }));
    if (!items.length) items.push(...posters.slice(0, 1));
    cache.art[key] = { at: Date.now(), items };
    saveCache();
    return items;
  }

  /* ── 下载并落盘 ─────────────────────────────────────── */

  function extFromUrl(u) {
    const m = /\.([a-z0-9]{2,4})(?:\?|$)/i.exec(String(u || ''));
    return m ? `.${m[1].toLowerCase()}` : '';
  }

  function sniff(buf) {
    if (buf.length < 12) return '';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
    if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
    if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp';
    return '';
  }

  async function savePoster(hash, url) {
    const r = await fetch(String(url || ''), {
      headers: { 'user-agent': UA, accept: 'image/*' },
      signal: AbortSignal.timeout(25000),
      redirect: 'follow',
    });
    if (!r.ok) throw new Error(`海报下载失败（${r.status}）`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_IMAGE) throw new Error('海报太大了，跳过');
    const ext = sniff(buf) || extFromUrl(url) || '.jpg';
    await mkdir(dir, { recursive: true });
    // 同一个种子换海报时把旧的删掉，避免扩展名不同留下垃圾
    for (const n of await readdir(dir).catch(() => [])) {
      if (n.startsWith(`${hash}.`) || n.startsWith(`${hash}-`)) await unlink(path.join(dir, n)).catch(() => {});
    }
    const rel = `tvdb/${hash}${ext}`;
    await writeFile(path.join(root, rel), buf);
    await shrink(path.join(root, rel), 640);
    return rel;
  }

  async function dropPoster(hash) {
    for (const n of await readdir(dir).catch(() => [])) {
      if (n.startsWith(`${hash}.`) || n.startsWith(`${hash}-`)) await unlink(path.join(dir, n)).catch(() => {});
    }
  }

  /** 清空整批刮削海报（设置面板「清空自动封面」时用） */
  async function dropPosters() {
    for (const n of await readdir(dir).catch(() => [])) {
      if (n === 'cache.json') continue;
      await unlink(path.join(dir, n)).catch(() => {});
    }
  }

  /** 自动匹配：搜索后取分数最高的一个；分数太低就不硬凑，把候选交给用户挑 */
  async function best({ name = '', type = '', year = '' } = {}) {
    const parsed = parseTitle(name);
    if (type === 'series' || type === 'movie') parsed.isSeries = type === 'series';
    if (year) parsed.year = String(year);
    const { items } = await search({
      query: parsed.title,
      type: parsed.isSeries ? 'series' : 'movie',
      year: parsed.year,
      isSeries: parsed.isSeries,
      translate: 1, // 自动匹配只关心第一名，别为候选白烧额度
    });
    const top = items[0];
    if (!top) return { ok: false, reason: 'no-result', parsed, items };
    if (top.score < 45) return { ok: false, reason: 'low-score', parsed, items };
    return { ok: true, parsed, items, pick: top };
  }

  async function forget() {
    cache.q = {};
    cache.art = {};
    saveCache();
  }

  async function stats() {
    let count = 0;
    let bytes = 0;
    try {
      const { stat } = await import('node:fs/promises');
      for (const n of await readdir(dir)) {
        if (n === 'cache.json') continue;
        const s = await stat(path.join(dir, n)).catch(() => null);
        if (s?.isFile()) { count++; bytes += s.size; }
      }
    } catch { /* 目录还没建 */ }
    return { count, bytes, queries: Object.keys(cache.q).length };
  }

  return {
    ready,
    status,
    configure,
    test,
    search,
    artworks,
    translation,
    best,
    savePoster,
    dropPoster,
    dropPosters,
    forget,
    stats,
    parseTitle,
  };
}
