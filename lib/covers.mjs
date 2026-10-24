/**
 * 封面管理
 *
 * 解析顺序：自定义图片（上传 / 目录中挑选） → 种子独立目录里自动找到的图片 → 类型图标（前端兜底）
 *
 * 只有种子拥有「自己的目录」时才会去扫图片：单文件种子往往直接躺在共享的下载
 * 根目录里，扫那个目录会把同目录下别的种子的海报拿来用，反而更糟。
 *
 * 图片统一缓存到 data/covers/ 下，避免每次请求都去读外置盘；macOS 上顺带用 sips
 * 把大图缩到 640px（没有 sips 就原样返回，不影响功能）。
 */

import path from 'node:path';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  mkdir, readdir, stat, copyFile, unlink, writeFile, readFile,
} from 'node:fs/promises';
import { createTvdb, parseTitle, titleVariants } from './tvdb.mjs';

const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp', '.svg']);
const HASH_RE = /^[a-f0-9]{40}$/i;
const MAX_UPLOAD = 8 * 1024 * 1024;
const MAX_SRC = 16 * 1024 * 1024;
const MAX_FILES = 4000;
/**
 * 目录扫描的缓存有效期分两档：
 * - 还在下载 / 校验的种子，目录内容随时会变 → 60 秒
 * - 已完成（或已暂停）的种子，目录基本不会再动 → 6 小时，并落盘，重启后仍命中
 * 缓存的是「候选图片清单 + 类型权重」，不是图片本身，所以体积很小。
 */
const SCAN_TTL_ACTIVE = 60_000;
const SCAN_TTL_DONE = 6 * 3600_000;
const SCAN_MAX = 3000; // 超过就淘汰最旧的，避免 scan.json 无限膨胀
/**
 * 类型（图标）的缓存比目录扫描更「耐用」，按来源分三档：
 * - files：来自 qBittorrent 的种子文件清单 → 元数据固定不变，永久有效
 * - dir：来自目录扫描 → 内容确实可能变，但类型没那么善变，给 30 分钟（已完成 6 小时）；
 *        候选图片另走目录扫描自己的 TTL（下载中 60 秒），两者互不拖累
 * - guess：两边都判不出来时的兜底（名字 / 分类猜的）→ 只信 60 秒，落盘后还会再试
 */
const KIND_TTL_GUESS = 60_000;
const KIND_TTL_DIR = 30 * 60_000;
// 列表缩略图只需要很小的图：自动封面压到 640px，候选图压到 320px
const AUTO_SIZE = 640;
const THUMB_SIZE = 320;
// 媒体库里约定俗成的封面文件名，优先级最高；poster / folder / cover 又比 fanart 之类更像封面
const PREFERRED_RANK = (name) => {
  if (/^(poster|folder|cover|front|movie|default|season\d+-poster)\.(jpe?g|png|webp|svg)$/i.test(name)) return 0;
  if (/^(fanart|banner|artwork|thumb)\.(jpe?g|png|webp|svg)$/i.test(name)) return 1;
  return 2;
};

const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

/** 在线预览（/__cover/file）用的类型表：能播的给准确 MIME，其余一律 octet-stream */
const FILE_MIME = {
  ...MIME,
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.ts': 'video/mp2t', '.m2ts': 'video/mp2t',
  '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.vob': 'video/mpeg',
  '.3gp': 'video/3gpp', '.3g2': 'video/3gpp2',
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/opus', '.wav': 'audio/wav',
  '.aiff': 'audio/aiff', '.aif': 'audio/aiff',
  '.heic': 'image/heic', '.heif': 'image/heif', '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.pdf': 'application/pdf', '.srt': 'text/plain; charset=utf-8', '.nfo': 'text/plain; charset=utf-8',
};

const extOf = (p) => path.extname(p).toLowerCase();

/**
 * 类型判定用的扩展名：qBittorrent 会把没下完的文件写成 xxx.mkv.part / xxx.mkv.!qB，
 * 判类型时要把这层尾巴剥掉，否则 90% 的种子都会变成「其他」。
 */
const kindExtOf = (p) => path.extname(String(p).replace(/\.(part|!qb|unconfirmed|\d+\.!ut)$/i, '')).toLowerCase();

/* 类型 → 扩展名。权重按「体积总和」算：一部剧里 1 张海报 < 20GB 正片，正片说了算 */
const KIND_EXTS = {
  video: ['.mkv', '.mp4', '.m4v', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m2ts', '.ts', '.rmvb', '.rm', '.mpg', '.mpeg', '.vob', '.3gp', '.divx', '.ogm', '.f4v', '.mts', '.strm'],
  audio: ['.mp3', '.flac', '.ape', '.wav', '.aac', '.ogg', '.oga', '.opus', '.m4a', '.wma', '.dsf', '.dff', '.dts', '.aiff', '.aif', '.alac', '.tak', '.cue'],
  image: ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp', '.svg', '.tif', '.tiff', '.heic', '.heif', '.psd', '.psb', '.raw', '.cr2', '.arw', '.nef', '.dng', '.orf'],
  book: ['.pdf', '.epub', '.mobi', '.azw', '.azw3', '.djvu', '.cbz', '.cbr', '.fb2', '.txt', '.doc', '.docx', '.rtf', '.md'],
  archive: ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso', '.dmg', '.pkg', '.exe', '.msi', '.apk', '.ipa', '.deb', '.rpm', '.nsp', '.xci', '.appimage'],
};

const EXT_KIND = new Map();
for (const [kind, list] of Object.entries(KIND_EXTS)) for (const e of list) EXT_KIND.set(e, kind);
const kindOfExt = (ext) => EXT_KIND.get(ext) || '';

/** 权重表 → 主导类型；一个都认不出来就返回空（交给别的兜底） */
function dominantKind(weights) {
  let best = '';
  let bestSize = -1;
  for (const [kind, size] of weights) {
    if (size > bestSize) { bestSize = size; best = kind; }
  }
  return bestSize > 0 ? best : '';
}

function addWeight(weights, ext, size) {
  const kind = kindOfExt(ext);
  if (!kind) return;
  weights.set(kind, (weights.get(kind) || 0) + (Number(size) || 0));
}

/**
 * 名字 / 分类猜类型：只在「文件清单和目录都判不出来」时兜底。
 * 典型场景是刚加进来还没拿到元数据的磁力链接 —— 至少先给个像样的图标。
 */
const GUESS_RE = [
  ['audio', /(music|audio|album|ost|flac|ape|dts|soundtrack|音乐|专辑|歌曲|演唱会|无损|原声)/i],
  ['image', /(photo|image|picture|wallpaper|comic|manga|画集|摄影|图片|壁纸|漫画|写真|绘本|图册)/i],
  ['video', /(movie|film|tv|series|episode|video|anime|documentary|电影|影视|剧集|动画|番剧|综艺|纪录片|视频)/i],
  ['book', /(ebook|book|pdf|epub|mobi|书籍|电子书|小说|教材|画册|漫画)/i],
  ['archive', /(software|game|app|iso|zip|rar|7z|dmg|course|tutorial|软件|游戏|应用|课程|教程|文档|素材)/i],
];

function guessKind(text) {
  const hay = String(text || '');
  for (const [kind, re] of GUESS_RE) if (re.test(hay)) return kind;
  return '';
}

export function createCovers({ dataDir, qbFetch, onLog = () => {} }) {
  const root = path.join(dataDir, 'covers');
  const dirs = {
    custom: path.join(root, 'custom'),
    auto: path.join(root, 'auto'),
    raw: path.join(root, 'raw'),
  };
  const indexPath = path.join(root, 'index.json');
  const scanPath = path.join(root, 'scan.json');
  const index = { covers: {}, auto: {} };
  const scan = { items: {} }; // hash -> { at, dir, kind, weights, images[], done }
  const torrentCache = new Map(); // hash -> { at, info }
  const dirCache = new Map();     // hash -> 同上（内存副本，TTL 到点后回落到磁盘记录）
  /** TheTVDB 刮削：网络请求都在服务端，密钥不出本机 */
  const tvdb = createTvdb({ root, dataDir, shrink, onLog });
  let writeChain = Promise.resolve();
  let scanTimer = null;
  let ready = null;

  async function init() {
    await mkdir(dirs.custom, { recursive: true });
    await mkdir(dirs.auto, { recursive: true });
    await mkdir(dirs.raw, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(indexPath, 'utf8'));
      if (raw && typeof raw === 'object') {
        Object.assign(index.covers, raw.covers || {});
        Object.assign(index.auto, raw.auto || {});
      }
    } catch { /* 首次运行 */ }
    try {
      const raw = JSON.parse(await readFile(scanPath, 'utf8'));
      if (raw && raw.items && typeof raw.items === 'object') Object.assign(scan.items, raw.items);
    } catch { /* 首次运行 */ }
    await tvdb.ready();
  }

  function persist() {
    // 串行写入，避免并发请求互相覆盖
    writeChain = writeChain
      .then(() => writeFile(indexPath, JSON.stringify(index), 'utf8'))
      .catch((err) => onLog(`封面索引写入失败：${err.message}`));
    return writeChain;
  }

  /** 扫描缓存的写盘合并一下：一次批量问类型可能新增几十条，没必要逐条落盘 */
  function persistScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      writeChain = writeChain
        .then(() => writeFile(scanPath, JSON.stringify({ v: 1, items: scan.items }), 'utf8'))
        .catch((err) => onLog(`扫描缓存写入失败：${err.message}`));
    }, 3000);
    if (scanTimer.unref) scanTimer.unref();
  }

  const ready$ = () => (ready ||= init());

  /* ── 种子信息 ───────────────────────────────────────── */

  async function torrentInfo(hash) {
    const hit = torrentCache.get(hash);
    if (hit && Date.now() - hit.at < 60_000) return hit.info;
    let info = null;
    try {
      const list = await qbFetch(`/api/v2/torrents/info?hashes=${hash}`);
      if (Array.isArray(list) && list[0]) {
        info = {
          content_path: list[0].content_path || '',
          save_path: list[0].save_path || '',
          name: list[0].name || '',
          done: Number(list[0].progress) >= 1,
        };
      }
    } catch { /* 上游不可用，当作没有封面 */ }
    torrentCache.set(hash, { at: Date.now(), info });
    return info;
  }

  /**
   * 种子「自己的目录」。
   * - 多文件种子 / 开了「创建子目录」的单文件种子：content_path 本身是目录 → 用它
   * - 单文件种子直接躺在共享下载目录里 → 返回 null，不做目录匹配
   * - content_path 就等于 save_path（还没拿到元数据等）→ 同样是共享目录，跳过
   */
  async function torrentDir(hash) {
    const info = await torrentInfo(hash);
    if (!info) return null;
    const save = info.save_path || '';
    const candidates = [info.content_path, save && info.name ? path.join(save, info.name) : ''].filter(Boolean);
    for (const p of candidates) {
      try {
        const s = await stat(p);
        if (!s.isDirectory()) continue;
        if (save && path.resolve(p) === path.resolve(save)) continue;
        return path.resolve(p); // 统一成绝对路径，后面做前缀校验才可靠
      } catch { /* 继续试下一个 */ }
    }
    return null;
  }

  /* ── 目录里的图片 ───────────────────────────────────── */

  const ttlFor = (rec) => (rec?.done ? SCAN_TTL_DONE : SCAN_TTL_ACTIVE);

  /**
   * 目录扫描结果。命中顺序：内存 → 磁盘（scan.json）→ 真去扫盘。
   * 落盘之后，服务重启、第二天开机都不会再遍历一遍外置盘。
   */
  async function dirInfoFor(hash) {
    const now = Date.now();
    const mem = dirCache.get(hash);
    if (mem && now - mem.at < ttlFor(mem)) return mem;
    const saved = scan.items[hash];
    if (saved && now - saved.at < ttlFor(saved)) {
      dirCache.set(hash, saved);
      return saved;
    }
    const dir = await torrentDir(hash);
    const { images, kind, weights } = dir ? await scanDir(dir) : { images: [], kind: '', weights: {} };
    const rec = {
      at: now,
      dir: dir || '',
      images,
      kind,
      kindSrc: kind ? 'dir' : '', // 类型也是这次扫出来的，按目录 TTL 走
      weights,
      done: (await torrentInfo(hash))?.done || false,
    };
    dirCache.set(hash, rec);
    scan.items[hash] = rec;
    trimScan();
    persistScan();
    return rec;
  }

  function trimScan() {
    const keys = Object.keys(scan.items);
    if (keys.length <= SCAN_MAX) return;
    keys.sort((a, b) => (scan.items[a].at || 0) - (scan.items[b].at || 0));
    for (const k of keys.slice(0, keys.length - SCAN_MAX)) delete scan.items[k];
  }

  /** 一次遍历同时拿到：候选图片 + 各类文件的体积权重（用于判类型） */
  async function scanDir(dir, maxDepth = 2) {
    const images = [];
    const weights = new Map();
    let seen = 0;
    async function walk(current, depth) {
      if (images.length > 300 || seen > MAX_FILES) return;
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch { return; }
      seen += entries.length;
      const subdirs = [];
      for (const ent of entries) {
        if (ent.name.startsWith('.')) continue;
        const full = path.join(current, ent.name);
        if (ent.isDirectory()) {
          if (depth < maxDepth) subdirs.push(full);
          continue;
        }
        const ext = kindExtOf(ent.name);
        if (!kindOfExt(ext)) continue; // 跟类型无关的文件（nfo / srt / db …）不 stat，省一次外置盘 IO
        let s;
        try { s = await stat(full); } catch { continue; }
        if (!s.isFile()) continue;
        addWeight(weights, ext, s.size);
        if (IMG_EXT.has(extOf(ent.name)) && s.size <= MAX_SRC && s.size >= 1024) {
          images.push({ path: full, name: path.relative(dir, full), base: ent.name, size: s.size, mtime: Math.round(s.mtimeMs) });
        }
      }
      for (const d of subdirs) await walk(d, depth + 1);
    }
    await walk(dir, 1);
    // 约定文件名优先，其次大图优先
    images.sort((a, b) => {
      const pa = PREFERRED_RANK(a.base);
      const pb = PREFERRED_RANK(b.base);
      if (pa !== pb) return pa - pb;
      return b.size - a.size;
    });
    return { images, kind: dominantKind(weights), weights: Object.fromEntries(weights) };
  }

  /* ── 类型判定 ───────────────────────────────────────── */

  /**
   * 种子目录里既有文件又没独立目录时（单文件种子躺在共享下载目录），
   * 就问 qBittorrent 要文件清单，按文件名扩展名算权重 —— 不扫盘也准。
   */
  async function filesKind(hash) {
    try {
      const files = await qbFetch(`/api/v2/torrents/files?hash=${hash}`);
      if (!Array.isArray(files) || !files.length) return '';
      const weights = new Map();
      for (const f of files) addWeight(weights, kindExtOf(f?.name || ''), f?.size);
      return dominantKind(weights);
    } catch { return ''; }
  }

  /** 类型结果是否已经可信到不用重算（见文件顶部 KIND_TTL_* 的分档说明） */
  function kindFresh(rec, now = Date.now()) {
    if (!rec || !rec.kind) return false;
    if (rec.kindSrc === 'files') return true;
    // 猜出来的按写入时间算，目录扫出来的跟着那次扫描一起算
    if (rec.kindSrc === 'guess') return now - (rec.kindAt || rec.at || 0) < KIND_TTL_GUESS;
    return now - (rec.at || 0) < (rec.done ? SCAN_TTL_DONE : KIND_TTL_DIR);
  }

  /** 把类型写进内存记录和落盘缓存，两处都要写：内存是热路径，磁盘是重启后仍在 */
  function writeKind(hash, kind, src) {
    const now = Date.now();
    const patch = { kind, kindSrc: src, kindAt: now };
    const mem = dirCache.get(hash);
    if (mem) Object.assign(mem, patch);
    const saved = scan.items[hash];
    if (saved) Object.assign(saved, patch);
    else scan.items[hash] = { at: now, dir: '', images: [], weights: {}, done: false, ...patch };
    persistScan();
  }

  /**
   * 这个种子到底有没有封面图？**只读缓存，不触发任何 IO**。
   * 前端以前对每一行都去请求 /__cover/img，没有图的种子全落 404，
   * 一屏就是十几条红色报错（外置盘上还白跑一次 stat）。这里给它一个
   * 1 / 0 的判断，前端据此决定要不要真的发图片请求：
   *   1 = 有（自定义 / TVDB 海报，或目录扫描确实找到图）
   *   0 = 明确没有（用户关成图标，或扫描过、目录里就是没图）
   *   -1 = 还没扫过，前端照旧试探（拿不准就不要武断地藏图）
   */
  function coverFlag(hash) {
    const cur = index.covers[hash];
    if (cur?.mode === 'icon') return 0;
    if ((cur?.mode === 'custom' || cur?.mode === 'tvdb') && cur.file) return 1;
    const rec = dirCache.get(hash) || scan.items[hash];
    if (!rec) return -1;
    return rec.dir && Array.isArray(rec.images) && rec.images.length ? 1 : 0;
  }

  async function kindFor(hash, opts = {}) {
    // 类型有自己的独立缓存，先查它：命中就直接返回，不去碰目录扫描 ——
    // 目录扫描才是慢的那一步（qB 请求 + 遍历目录，外置盘上尤其明显），
    // 之前这里会「为了拿类型先扫一遍目录，扫完才发现类型本来就缓存着」。
    if (!opts.force) {
      const now = Date.now();
      const mem = dirCache.get(hash);
      if (kindFresh(mem, now)) return mem.kind;
      const saved = scan.items[hash];
      if (kindFresh(saved, now)) {
        dirCache.set(hash, saved);
        return saved.kind;
      }
    }
    const rec = await dirInfoFor(hash);
    if (!opts.force && kindFresh(rec)) return rec.kind;
    // 目录里判不出来（单文件种子 / 还没落盘）：问 qBittorrent 要文件清单。
    // 文件清单不依赖下载进度，也不会变，所以这份结果可以长期缓存。
    const fromFiles = await filesKind(hash);
    const k = fromFiles || rec.kind || 'other';
    // 来源要按「原来的来源」定：之前只是猜的，重算一次也还是猜的，不能升格成目录判定
    writeKind(hash, k, fromFiles ? 'files' : (rec.kindSrc === 'dir' ? 'dir' : 'guess'));
    return k;
  }

  /**
   * 添加种子时的「第一次类型写入」。
   * qBittorrent 收下种子后立刻就有文件清单（元数据跟下载进度无关），所以这一步
   * 直接按文件清单算类型写进缓存：新种子一进列表就是对的图标，不用等目录扫描，
   * 也不用等下一次轮询。已经有 files 来源的结果就跳过（文件清单不会变）。
   */
  async function seedKind(hash, hint = '') {
    const saved = dirCache.get(hash) || scan.items[hash];
    if (saved?.kindSrc === 'files' && saved.kind) return saved.kind;
    const rec = await dirInfoFor(hash);
    const fromFiles = await filesKind(hash);
    const guessed = fromFiles ? '' : guessKind(hint);
    const k = fromFiles || (rec.kindSrc === 'dir' ? rec.kind : '') || guessed;
    // 这一轮什么都没算出来（比如磁力还没拿到元数据）就保留上一次的结果，别把它冲成 other
    if (!k && rec.kind) return rec.kind;
    writeKind(hash, k || 'other', fromFiles ? 'files' : (rec.kindSrc === 'dir' ? 'dir' : 'guess'));
    return k || 'other';
  }

  /* ── 缓存统计与清空 ─────────────────────────────────── */

  async function dirStat(dir) {
    let count = 0;
    let bytes = 0;
    try {
      for (const name of await readdir(dir)) {
        try {
          const s = await stat(path.join(dir, name));
          if (s.isFile()) { count++; bytes += s.size; }
        } catch { /* 忽略了 */ }
      }
    } catch { /* 目录还不存在 */ }
    return { count, bytes };
  }

  async function cacheStats() {
    const [custom, auto, raw] = await Promise.all([dirStat(dirs.custom), dirStat(dirs.auto), dirStat(dirs.raw)]);
    const t = await tvdb.stats();
    const items = Object.values(scan.items);
    const oldest = items.reduce((m, r) => Math.min(m, r.at || 0), Date.now());
    return {
      scan: items.length,
      scanAgeMs: items.length ? Date.now() - oldest : 0,
      custom, auto, raw,
      tvdb: { count: t.count, bytes: t.bytes, queries: t.queries },
      images: custom.count + auto.count + raw.count + t.count,
      bytes: custom.bytes + auto.bytes + raw.bytes + t.bytes,
      // 目录图片 = 自动缩略图 + 候选图 + 自定义封面（不含 TVDB 海报），设置面板分开显示
      dirImages: custom.count + auto.count + raw.count,
      dirBytes: custom.bytes + auto.bytes + raw.bytes,
    };
  }

  async function clearDir(dir) {
    let names = [];
    try { names = await readdir(dir); } catch { return; }
    await Promise.all(names.map((n) => unlink(path.join(dir, n)).catch(() => {})));
  }

  /**
   * scope: scan = 只清目录扫描结果；tvdb = 只清 TheTVDB 海报与搜索缓存（下次重新联网刮削）；
   *        images = 只清自动生成的目录缩略图（保留自己上传的）；all = 以上全部 + 自己上传的封面
   */
  async function clearCache(scope = 'scan') {
    if (scope === 'scan' || scope === 'all') {
      dirCache.clear();
      for (const k of Object.keys(scan.items)) delete scan.items[k];
      torrentCache.clear();
      persistScan();
    }
    if (scope === 'tvdb' || scope === 'all') {
      // 刮削来的海报也算「自动封面」：清掉后需要联网重取，正好是清缓存想要的效果
      await tvdb.dropPosters();
      await tvdb.forget(); // 搜索 / 作品图缓存一并清掉，避免命中旧结果
      for (const k of Object.keys(index.covers)) {
        if (index.covers[k]?.mode === 'tvdb') {
          await removeMetaFiles(k); // 写进媒体目录的海报 / NFO 也一并清掉
          delete index.covers[k];
        }
      }
    }
    if (scope === 'images' || scope === 'all') {
      await clearDir(dirs.auto);
      await clearDir(dirs.raw);
      for (const k of Object.keys(index.auto)) delete index.auto[k];
    }
    if (scope === 'all') {
      await clearDir(dirs.custom);
      for (const k of Object.keys(index.covers)) delete index.covers[k];
    }
    persist();
    return cacheStats();
  }

  /* ── 候选图的小图（供封面弹窗的网格用） ─────────────── */

  async function ensureRawThumb(hash, rel) {
    const dir = await torrentDir(hash);
    if (!dir) return null;
    const full = path.resolve(dir, rel);
    if (!full.startsWith(dir + path.sep) || !IMG_EXT.has(extOf(full))) return null;
    const key = `${hash}-${Buffer.from(rel).toString('hex').slice(0, 60)}`;
    const file = path.join('raw', `${key}${extOf(full)}`);
    const dest = path.join(root, file);
    try {
      const s = await stat(dest);
      if (s.size > 0) return file;
    } catch { /* 还没有缓存 */ }
    try {
      await copyFile(full, dest);
      await shrink(dest, THUMB_SIZE);
      return file;
    } catch {
      // 缩略图做不出来就原样返回，浏览器端只是慢一点
      return full;
    }
  }

  /* ── 缩放（macOS 可选优化） ──────────────────────────── */

  function shrink(file, size = AUTO_SIZE) {
    if (extOf(file) === '.svg') return Promise.resolve(false); // 矢量图不用压
    return new Promise((resolve) => {
      execFile('sips', ['-Z', String(size), file], { timeout: 8000 }, (err) => {
        if (err) return resolve(false);
        return resolve(true);
      });
    });
  }

  /* ── 自动封面 ───────────────────────────────────────── */

  async function ensureAuto(hash) {
    const { dir, images } = await dirInfoFor(hash);
    if (!dir || !images.length) {
      // 种子没有独立目录 / 目录里没图：清掉可能存在的旧缓存，让它回到类型图标
      if (index.auto[hash]) { delete index.auto[hash]; persist(); }
      return null;
    }
    const pick = images[0];
    const cached = index.auto[hash];
    if (cached && cached.src === pick.path && cached.size === pick.size && cached.mtime === pick.mtime) {
      try {
        await stat(path.join(root, cached.file));
        return cached.file;
      } catch { /* 缓存被清掉了，重建 */ }
    }
    const ext = extOf(pick.path);
    const file = path.join('auto', `${hash}${ext}`);
    const dest = path.join(root, file);
    try {
      if (cached?.file) await unlink(path.join(root, cached.file)).catch(() => {});
      await copyFile(pick.path, dest);
      if (pick.size > 160 * 1024) await shrink(dest);
      index.auto[hash] = { file, src: pick.path, size: pick.size, mtime: pick.mtime, at: Date.now() };
      persist();
      return file;
    } catch (err) {
      onLog(`自动封面失败 ${hash.slice(0, 8)}: ${err.message}`);
      return null;
    }
  }

  /* ── 响应 ───────────────────────────────────────────── */

  function sendImage(req, res, file, extra = {}) {
    const full = path.isAbsolute(file) ? file : path.join(root, file);
    stat(full).then((s) => {
      const etag = `"${s.size.toString(16)}-${Math.round(s.mtimeMs).toString(16)}"`;
      const headers = {
        'content-type': MIME[extOf(full)] || 'application/octet-stream',
        'cache-control': 'public, max-age=86400',
        'content-length': String(s.size),
        etag,
        ...extra,
      };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        return res.end();
      }
      res.writeHead(200, headers);
      if (req.method === 'HEAD') return res.end();
      createReadStream(full).pipe(res);
    }).catch(() => {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'x-cover': 'none' });
      res.end('{"error":"no-cover"}');
    });
  }

  function json(res, status, data) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  function readCapped(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(new Error('too-large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function sniff(buf) {
    if (buf.length < 12) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
    if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
    if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp';
    if (buf.subarray(0, 4).toString('ascii') === 'GIF8') return '.gif';
    if (buf.subarray(4, 8).toString('ascii') === 'ftyp') {
      const brand = buf.subarray(8, 12).toString('ascii');
      if (brand === 'avif' || brand === 'avis') return '.avif';
    }
    if (buf[0] === 0x42 && buf[1] === 0x4d) return '.bmp';
    if (/<svg[\s>]/i.test(buf.subarray(0, 1024).toString('utf8'))) return '.svg';
    return null;
  }

  async function removeCustom(hash) {
    const cur = index.covers[hash];
    if (cur?.file) await unlink(path.join(root, cur.file)).catch(() => {});
  }

  /* ── TheTVDB 刮削 ───────────────────────────────────── */

  /** 把某张海报存下来并记到封面索引上（mode: tvdb，优先级高于目录自动图） */
  async function applyTvdb(hash, sel = {}) {
    let image = String(sel.image || '');
    if (!image && sel.id) {
      const arts = await tvdb.artworks({ id: String(sel.id), type: sel.type === 'movie' ? 'movie' : 'series' });
      image = (arts.find((a) => a.kind === 'poster') || arts[0])?.image || '';
    }
    if (!image) throw new Error('这个作品在 TheTVDB 上没有可用的海报');
    let overview = String(sel.overview || '');
    // 点海报直接套用时前端不带简介，这里按设置的语言补一段（中文没有就退回英文），NFO 里就有剧情了
    const lang = tvdb.status().lang || '';
    if (!overview && sel.id && lang && lang !== 'eng') {
      const tr = await tvdb.translation({ id: String(sel.id), type: sel.type === 'movie' ? 'movie' : 'series', lang }).catch(() => null);
      overview = tr?.overview || '';
    }
    if (!overview && sel.id) {
      const en = await tvdb.translation({ id: String(sel.id), type: sel.type === 'movie' ? 'movie' : 'series', lang: 'eng' }).catch(() => null);
      overview = en?.overview || '';
    }
    const file = await tvdb.savePoster(hash, image);
    index.covers[hash] = {
      mode: 'tvdb',
      file,
      source: 'tvdb',
      name: String(sel.name || ''),
      meta: {
        id: String(sel.id || ''), type: sel.type || '', year: String(sel.year || ''),
        name: String(sel.name || ''), nameEn: String(sel.nameEn || ''), overview, at: Date.now(),
      },
      at: Date.now(),
    };
    persist();
    await writeMetaFiles(hash); // 海报 + NFO 写进媒体目录，Plex / Jellyfin / Kodi 直接可用
    return { ok: true, mode: 'tvdb', name: index.covers[hash].name, v: Date.now() };
  }

  /* ── 元信息落进媒体目录（供 Plex / Jellyfin / Kodi 等识别） ── */

  const escXml = (s) => String(s || '').replace(/[<>&'"]/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]
  ));

  /** Kodi / Jellyfin / Emby 通用的 NFO：电影用 <movie>，剧集用 <tvshow> */
  function nfoXml(meta = {}) {
    const tag = meta.type === 'series' ? 'tvshow' : 'movie';
    const lines = [`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`, `<${tag}>`];
    if (meta.name) lines.push(`  <title>${escXml(meta.name)}</title>`);
    // 刮削语言是中文时把 TVDB 原始（英文）名留在 originaltitle，Kodi / Jellyfin 会显示原名
    if (meta.nameEn && meta.nameEn !== meta.name) lines.push(`  <originaltitle>${escXml(meta.nameEn)}</originaltitle>`);
    if (meta.year) lines.push(`  <year>${escXml(meta.year)}</year>`);
    if (meta.overview) lines.push(`  <plot>${escXml(meta.overview)}</plot>`);
    if (meta.id) lines.push(`  <uniqueid type="tvdb" default="true">${escXml(meta.id)}</uniqueid>`);
    lines.push(`</${tag}>`);
    return lines.join('\n');
  }

  /** 目录（含两层子目录）里体积最大的视频文件：电影的海报 / NFO 跟它同名放一起 */
  async function biggestVideo(dir, maxDepth = 2) {
    let best = null;
    let bestSize = -1;
    async function walk(current, depth) {
      if (best && depth > maxDepth) return;
      let entries;
      try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        if (ent.name.startsWith('.')) continue;
        const full = path.join(current, ent.name);
        if (ent.isDirectory()) {
          if (depth < maxDepth) await walk(full, depth + 1);
          continue;
        }
        if (!KIND_EXTS.video.includes(kindExtOf(ent.name))) continue;
        const s = await stat(full).catch(() => null);
        if (s?.isFile() && s.size > bestSize) { bestSize = s.size; best = full; }
      }
    }
    await walk(dir, 0);
    return best;
  }

  /**
   * 刮削成功后把海报和 NFO 写进种子自己的目录，命名按各媒体服务的本地资源约定：
   * - 电影：放在视频旁边，<视频名>-poster.jpg + <视频名>.nfo（Plex / Kodi / Jellyfin 都认）
   * - 剧集：种子目录根部放 poster.jpg + tvshow.nfo（剧集按整季归档，不跟单集同名）
   * 写过哪些记在 index.covers[hash].metaFiles，换海报 / 放弃刮削 / 清 TVDB 缓存时一并删掉，
   * 不在用户的媒体目录里留垃圾。单文件种子直接躺在共享根目录的不写，避免污染别的种子。
   */
  async function writeMetaFiles(hash) {
    const cur = index.covers[hash];
    if (cur?.mode !== 'tvdb' || !cur?.file) return;
    const dir = await torrentDir(hash);
    if (!dir) return;
    const targets = [];
    const put = async (dst, fn) => {
      try { await fn(dst); targets.push(dst); } catch { /* 目录只读 / 掉盘等，静默跳过 */ }
    };
    const posterSrc = path.join(root, cur.file);
    const meta = cur.meta || {};
    if (meta.type === 'series') {
      await put(path.join(dir, 'poster.jpg'), (d) => copyFile(posterSrc, d));
      await put(path.join(dir, 'tvshow.nfo'), (d) => writeFile(d, nfoXml(meta), 'utf8'));
    } else {
      const video = await biggestVideo(dir);
      if (video) {
        const base = video.slice(0, -extOf(video).length);
        await put(`${base}-poster${extOf(cur.file) || '.jpg'}`, (d) => copyFile(posterSrc, d));
        await put(`${base}.nfo`, (d) => writeFile(d, nfoXml(meta), 'utf8'));
      }
    }
    // 上一次写的文件如果这次没再写（换了作品名字就变了），清掉
    for (const old of cur.metaFiles || []) {
      if (!targets.includes(old)) await unlink(old).catch(() => {});
    }
    cur.metaFiles = targets;
    persist();
  }

  /** 删除之前写进媒体目录的元信息文件（海报 + NFO） */
  async function removeMetaFiles(hash) {
    const cur = index.covers[hash];
    for (const f of cur?.metaFiles || []) await unlink(f).catch(() => {});
    if (cur) delete cur.metaFiles;
  }

  /** 按种子名自动匹配一部作品并套用它的海报；分数太低就返回候选让用户挑 */
  async function autoTvdb(hash, opts = {}) {
    const info = await torrentInfo(hash);
    const name = String(opts.name || info?.name || '');
    if (!name) return { ok: false, reason: 'no-name' };
    const best = await tvdb.best({ name, type: opts.type, year: opts.year });
    if (!best.ok) {
      return { ok: false, reason: best.reason, parsed: best.parsed, query: best.query || '', items: (best.items || []).slice(0, 8) };
    }
    const sel = best.pick;
    let image = sel.image || '';
    let arts = [];
    try {
      arts = await tvdb.artworks({ id: sel.id, type: sel.type });
      image = (arts.find((a) => a.kind === 'poster') || arts[0])?.image || image;
    } catch { /* 拿不到海报列表就用搜索结果里那张 */ }
    await applyTvdb(hash, {
      id: sel.id, type: sel.type, image, name: sel.name, nameEn: sel.nameEn, year: sel.year, overview: sel.overview,
    });
    return {
      ok: true, id: sel.id, name: sel.name, nameEn: sel.nameEn, year: sel.year, type: sel.type,
      score: Math.round(sel.score), query: best.query || '',
      // 顺带把海报列表带回去，弹窗直接铺开——默认已经套了第一张，想换点别的就行
      arts: arts.slice(0, 12),
    };
  }

  /** 一次性拉全量种子列表，建成 hash → 基本信息 的表；顺带预热 torrentInfo 的缓存 */
  async function torrentMeta() {
    const meta = new Map();
    const all = await qbFetch('/api/v2/torrents/info').catch(() => []);
    for (const t of Array.isArray(all) ? all : []) {
      const h = String(t?.hash || '').toLowerCase();
      if (!HASH_RE.test(h)) continue;
      const info = {
        content_path: t.content_path || '',
        save_path: t.save_path || '',
        name: t.name || '',
        done: Number(t.progress) >= 1,
      };
      meta.set(h, info);
      torrentCache.set(h, { at: Date.now(), info });
    }
    return meta;
  }

  /* ── 批量刮削（SSE 进度流） ─────────────────────────── */

  let scanning = false;

  /**
   * GET /__cover/tvdb/scan/stream —— 每处理完一个种子推一条事件，页面就能显示进度。
   * 客户端断开（关页面 / 点取消）时循环自然停下，不留后台任务。同一时刻只允许一个任务。
   */
  async function scanStream(req, res, url) {
    const head = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' };
    if (!tvdb.status().configured) {
      res.writeHead(400, head);
      res.end('event: error\ndata: {"message":"先在设置里填上 TheTVDB API Key"}\n\n');
      return true;
    }
    if (scanning) {
      res.writeHead(200, head);
      res.end('event: busy\ndata: {}\n\n');
      return true;
    }
    res.writeHead(200, head);
    let stopped = false;
    const send = (event, data) => {
      if (stopped || res.writableEnded) return;
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { stopped = true; }
    };
    req.on('close', () => { stopped = true; });
    res.on('close', () => { stopped = true; });
    scanning = true;
    const force = url.searchParams.get('force') === '1';
    try {
      const meta = await torrentMeta();
      const hashes = [...meta.keys()].slice(0, 300);
      const total = hashes.length;
      send('start', { total });
      const out = { done: 0, skipped: 0, failed: 0 };
      let i = 0;
      for (const h of hashes) {
        if (stopped) break;
        i++;
        const name = meta.get(h)?.name || h.slice(0, 8);
        const item = (status, extra = {}) => send('item', { i, total, hash: h, name, status, ...extra });
        if (!force && index.covers[h]?.mode === 'tvdb') { out.skipped++; item('skip', { reason: 'already' }); continue; }
        // 音频 / 压缩包之类的没必要去 TVDB 查，省额度也省时间
        const kind = await kindFor(h).catch(() => '');
        if (kind && kind !== 'video') { out.skipped++; item('skip', { reason: 'not-video' }); continue; }
        try {
          const r = await autoTvdb(h, {});
          if (r.ok) { out.done++; item('ok', { matched: r.name, year: r.year, type: r.type }); }
          else { out.failed++; item('fail', { reason: r.reason }); }
        } catch (err) {
          out.failed++;
          item('fail', { reason: 'error', message: String(err?.message || err) });
        }
        // 稍微喘口气：TVDB 免费额度有限，连续猛打容易撞 429
        await new Promise((r) => setTimeout(r, 120));
      }
      send('done', { ...out, processed: i, total, cancelled: stopped });
    } catch (err) {
      send('error', { message: String(err?.message || err) });
    } finally {
      scanning = false;
      try { res.end(); } catch { /* 已经断开了 */ }
    }
    return true;
  }

  /* ── 路由 ───────────────────────────────────────────── */

  /** qBittorrent 偏好（只为了拿临时目录；5 分钟内复用） */
  const prefCache = { at: 0, temp: '' };
  async function tempRoot() {
    if (Date.now() - prefCache.at < 300_000) return prefCache.temp;
    let temp = '';
    try {
      const p = await qbFetch('/api/v2/app/preferences');
      if (p?.temp_path_enabled && typeof p.temp_path === 'string') temp = p.temp_path;
    } catch { /* 拿不到偏好就只试下载目录 */ }
    prefCache.at = Date.now();
    prefCache.temp = temp;
    return temp;
  }

  /** 把 qB 给的相对路径拼到某个根目录下，顺带挡掉 ../ 穿越 */
  function withinRoot(root, rel) {
    if (!root) return '';
    const rootAbs = path.resolve(root);
    const full = path.resolve(rootAbs, rel);
    if (full !== rootAbs && !full.startsWith(rootAbs + path.sep)) return '';
    return full;
  }

  /** 依次尝试完整路径，以及下载中常见的 .part / .!qB 后缀 */
  async function firstExistingFile(candidates) {
    const tried = new Set();
    for (const p of candidates) {
      if (!p || tried.has(p)) continue;
      tried.add(p);
      for (const file of [p, `${p}.part`, `${p}.!qB`]) {
        try {
          const s = await stat(file);
          if (s.isFile()) return { full: file, size: s.size };
        } catch { /* 试下一个 */ }
      }
    }
    return null;
  }

  /**
   * 定位种子里的某个文件。
   *
   * qBittorrent 的 files[].name 是**相对 save_path** 的完整路径，多文件种子已经带上了
   * 种子目录名（save_path=/dl/IV、content_path=/dl/IV/图、name=图/猫猫/x.jpg）。
   * 早期实现拿 content_path 当基准，会拼成 /dl/IV/图/图/猫猫/x.jpg，所有多文件种子
   * 都预览失败。这里以 save_path 为主，同时兼容「name 相对 content_path」的实现、
   * 单文件种子、以及下载中文件落在临时目录 / 带后缀的情况。
   */
  async function resolveTorrentFile(hash, rel) {
    const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!clean || clean.includes('\0') || clean.split('/').includes('..')) return null;
    const info = await torrentInfo(hash);
    if (!info) return null;

    const candidates = [];
    const add = (p) => { if (p && !candidates.includes(p)) candidates.push(p); };
    add(withinRoot(info.save_path, clean));
    if (info.content_path) {
      const cp = path.resolve(info.content_path);
      // 单文件种子：content_path 就是文件本身
      if (path.basename(cp) === path.posix.basename(clean)) add(cp);
      add(withinRoot(cp, clean));
    }

    let found = await firstExistingFile(candidates);
    if (!found && !info.done) {
      // 还没下完：qB 可能把未完成的文件放在临时目录里
      const temp = await tempRoot();
      if (temp) add(withinRoot(temp, clean));
      found = await firstExistingFile(candidates);
    }
    return found;
  }

  /**
   * 种子文件流（详情页在线预览视频 / 音频 / 图片）。
   * 直读本机磁盘（和扫封面同一条路），支持 HTTP Range——视频拖进度条、边下边看都靠它。
   * rel 是 qBittorrent files 列表里的 name，做了目录穿越校验。
   */
  async function serveTorrentFile(req, res, hash, rel, download = false) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method' });
    if (!HASH_RE.test(hash) || !rel) return json(res, 400, { error: 'bad-args' });
    const file = await resolveTorrentFile(hash, rel);
    if (!file) {
      return json(res, 404, {
        error: 'no-file',
        message: '文件还不在本地，或者浏览器无法直接读取（尚未下载 / 位于临时目录）',
      });
    }
    const { full, size } = file;
    const mime = FILE_MIME[extOf(full)] || 'application/octet-stream';
    // 图片允许浏览器短暂缓存：写真集来回翻页不用每次都从外置盘重读；视频不缓存，避免拖进度条拿到旧数据
    const cacheControl = mime.startsWith('image/') ? 'private, max-age=300' : 'no-store';
    if (size === 0) {
      const headers = {
        'content-type': mime,
        'accept-ranges': 'bytes',
        'cache-control': cacheControl,
        'content-length': '0',
      };
      if (download) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(full))}`;
      res.writeHead(200, headers);
      return res.end();
    }
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    let start = 0;
    let end = size - 1;
    let status = 200;
    if (m && size > 0) {
      if (m[1] === '' && m[2] !== '') {
        start = Math.max(0, size - Number(m[2])); // bytes=-N：只要末尾 N 字节
      } else {
        start = Math.min(Number(m[1]), Math.max(0, size - 1));
        if (m[2] !== '') end = Math.min(Number(m[2]), size - 1);
      }
      if (start > end || start >= size) {
        res.writeHead(416, { 'content-range': `bytes */${size}` });
        res.end();
        return;
      }
      status = 206;
    }

    const headers = {
      'content-type': mime,
      'accept-ranges': 'bytes',
      'cache-control': cacheControl,
      'content-length': String(end - start + 1),
    };
    // 预览（尤其是 Safari）不要带 Content-Disposition，in/attachment 都可能被当成下载；
    // 只有显式点「下载文件」时才告诉浏览器另存
    if (download) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(full))}`;
    if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = createReadStream(full, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy()); // 用户关掉播放器就别再读外置盘了
    stream.pipe(res);
  }

  async function handle(req, res, url) {
    const p = url.pathname;
    if (!p.startsWith('/__cover/') && p !== '/__cover') return false;
    await ready$();
    const hash = (url.searchParams.get('hash') || '').toLowerCase();

    try {
      // 媒体文件流（详情页在线预览：视频 / 音频 / 图片，支持 Range 拖进度条）
      if (p === '/__cover/file') {
        return (await serveTorrentFile(
          req,
          res,
          hash,
          url.searchParams.get('name') || '',
          url.searchParams.get('download') === '1',
        )), true;
      }

      // 图片本体
      if (p === '/__cover/img') {
        if (!HASH_RE.test(hash)) return json(res, 400, { error: 'bad-hash' }), true;
        const cur = index.covers[hash];
        if (cur?.mode === 'icon') {
          res.writeHead(404, { 'content-type': 'application/json', 'x-cover': 'icon', 'cache-control': 'no-store' });
          res.end('{"error":"icon"}');
          return true;
        }
        if (cur?.mode === 'custom' && cur.file) return sendImage(req, res, cur.file), true;
        // 刮削来的海报排在目录自动图前面：目录里那张常常是随手塞的
        if (cur?.mode === 'tvdb' && cur.file) return sendImage(req, res, cur.file), true;
        const auto = await ensureAuto(hash);
        if (auto) return sendImage(req, res, auto), true;
        res.writeHead(404, { 'content-type': 'application/json', 'x-cover': 'none' });
        res.end('{"error":"no-cover"}');
        return true;
      }

      // 候选图片的小图（相对路径）
      if (p === '/__cover/raw') {
        if (!HASH_RE.test(hash)) return json(res, 400, { error: 'bad-hash' }), true;
        const rel = url.searchParams.get('rel') || '';
        const file = await ensureRawThumb(hash, rel);
        if (!file) return json(res, 404, { error: 'no-file' }), true;
        return sendImage(req, res, file), true;
      }

      if (p === '/__cover/candidates') {
        if (!HASH_RE.test(hash)) return json(res, 400, { error: 'bad-hash' }), true;
        const { dir, images, weights } = await dirInfoFor(hash);
        const cur = index.covers[hash];
        const info = await torrentInfo(hash);
        return json(res, 200, {
          dir: dir || '',
          mode: cur?.mode || 'auto',
          name: cur?.name || '',
          kind: await kindFor(hash),
          weights,
          count: images.length,
          tvdb: cur?.mode === 'tvdb' ? (cur.meta || null) : null,
          parsed: parseTitle(info?.name || ''),
          items: images.slice(0, 60).map((i) => ({ name: i.base, rel: i.name, size: i.size })),
        }), true;
      }

      // 批量问类型：body { hashes: [...] } → { kinds: { hash: 'video' | … } }
      // 判定依据是目录 / 种子文件清单里各类文件的体积权重，行图标因此跟真实内容一致
      if (p === '/__cover/kinds' && req.method === 'POST') {
        let body = {};
        try {
          body = JSON.parse((await readCapped(req, 64 * 1024)).toString('utf8') || '{}');
        } catch { /* 空 body 当作全量未知 */ }
        const hashes = (Array.isArray(body.hashes) ? body.hashes : [])
          .map((h) => String(h || '').toLowerCase())
          .filter((h) => HASH_RE.test(h))
          .slice(0, 200);
        const kinds = {};
        const covers = {};
        const queue = [...hashes];
        // 4 路并发：外置盘扛不住 200 个同时遍历
        await Promise.all(Array.from({ length: Math.min(4, queue.length) || 0 }, async () => {
          while (queue.length) {
            const h = queue.shift();
            try {
              kinds[h] = await kindFor(h);
              // kindFor 可能顺带扫了目录，这时候 coverFlag 的结论才是准的
              const flag = coverFlag(h);
              if (flag === 0 || flag === 1) covers[h] = flag;
            } catch {
              kinds[h] = 'other';
            }
          }
        }));
        return json(res, 200, { kinds, covers }), true;
      }

      // 添加种子时立刻把类型写进缓存：body { hashes, name?, category? }
      // 此刻 qB 已经有元数据了，不用等目录扫描，新种子一进列表就是对的图标
      if (p === '/__cover/seed' && req.method === 'POST') {
        let body = {};
        try {
          body = JSON.parse((await readCapped(req, 64 * 1024)).toString('utf8') || '{}');
        } catch { /* 空 body 当作没有提示 */ }
        const hashes = (Array.isArray(body.hashes) ? body.hashes : [])
          .map((h) => String(h || '').toLowerCase())
          .filter((h) => HASH_RE.test(h))
          .slice(0, 50);
        const hint = `${body.name || ''} ${body.category || ''}`.trim();
        const kinds = {};
        const queue = [...hashes];
        await Promise.all(Array.from({ length: Math.min(4, queue.length) || 0 }, async () => {
          while (queue.length) {
            const h = queue.shift();
            try {
              kinds[h] = await seedKind(h, hint);
            } catch {
              kinds[h] = 'other';
            }
          }
        }));
        return json(res, 200, { kinds }), true;
      }

      if (p === '/__cover/upload' && req.method === 'POST') {
        if (!HASH_RE.test(hash)) return json(res, 400, { error: 'bad-hash' }), true;
        let buf;
        try {
          buf = await readCapped(req, MAX_UPLOAD);
        } catch {
          return json(res, 413, { error: 'too-large', message: '图片请控制在 8MB 以内' }), true;
        }
        const ext = sniff(buf);
        if (!ext) return json(res, 415, { error: 'bad-image', message: '只支持 jpg / png / webp / gif / avif' }), true;
        const file = path.join('custom', `${hash}-${Date.now()}${ext}`);
        await writeFile(path.join(root, file), buf);
        await removeCustom(hash);
        index.covers[hash] = { mode: 'custom', file, source: 'upload', at: Date.now() };
        persist();
        return json(res, 200, { ok: true, mode: 'custom', v: Date.now() }), true;
      }

      if (p === '/__cover/from-dir' && req.method === 'POST') {
        const body = JSON.parse((await readCapped(req, 8 * 1024)).toString('utf8') || '{}');
        if (!HASH_RE.test(hash)) return json(res, 400, { error: 'bad-hash' }), true;
        const dir = await torrentDir(hash);
        if (!dir) return json(res, 404, { error: 'no-dir', message: '找不到种子目录' }), true;
        const full = path.resolve(dir, String(body.rel || ''));
        if (!full.startsWith(dir + path.sep) || !IMG_EXT.has(extOf(full))) {
          return json(res, 400, { error: 'bad-path' }), true;
        }
        const ext = extOf(full);
        const file = path.join('custom', `${hash}-${Date.now()}${ext}`);
        const dest = path.join(root, file);
        try {
          await copyFile(full, dest);
        } catch (err) {
          return json(res, 404, { error: 'copy-failed', message: `读不到该文件：${err.message}` }), true;
        }
        const s = await stat(full).catch(() => ({ size: 0 }));
        if (s.size > 160 * 1024) await shrink(dest);
        await removeCustom(hash);
        index.covers[hash] = { mode: 'custom', file, source: 'dir', name: path.basename(full), at: Date.now() };
        persist();
        return json(res, 200, { ok: true, mode: 'custom', v: Date.now() }), true;
      }

      if (p === '/__cover/mode' && req.method === 'POST') {
        const body = JSON.parse((await readCapped(req, 8 * 1024)).toString('utf8') || '{}');
        if (!HASH_RE.test(hash)) return json(res, 400, { error: 'bad-hash' }), true;
        const mode = body.mode === 'icon' ? 'icon' : 'auto';
        await removeCustom(hash);
        if (mode === 'icon') index.covers[hash] = { mode: 'icon', at: Date.now() };
        else delete index.covers[hash];
        persist();
        return json(res, 200, { ok: true, mode }), true;
      }

      /* ── TheTVDB 刮削 ───────────────────────────────── */

      // 状态：是否配置好 / 语言 / 自动策略 + 当前种子名解析出的片名
      if (p === '/__cover/tvdb/status') {
        const st = tvdb.status();
        const cur = index.covers[hash];
        const info = hash ? await torrentInfo(hash) : null;
        return json(res, 200, {
          ...st,
          current: cur?.mode === 'tvdb' ? { name: cur.name || '', ...(cur.meta || {}) } : null,
          parsed: info?.name ? parseTitle(info.name) : null,
        }), true;
      }

      // 保存配置：body { apiKey?, pin?, lang?, auto?, enabled? }
      if (p === '/__cover/tvdb/config' && req.method === 'POST') {
        const body = JSON.parse((await readCapped(req, 8 * 1024)).toString('utf8') || '{}');
        return json(res, 200, { ok: true, status: await tvdb.configure(body) }), true;
      }

      // 测试：登录 + 一次搜索，把耗时和结果数返回给设置面板
      if (p === '/__cover/tvdb/test' && req.method === 'POST') {
        try {
          return json(res, 200, await tvdb.test()), true;
        } catch (err) {
          return json(res, 200, { ok: false, message: err.message }), true;
        }
      }

      // 搜索：hash 用来自动识别片名，q 可以覆盖
      if (p === '/__cover/tvdb/search') {
        if (!tvdb.status().configured) return json(res, 400, { error: 'no-key', message: '先在设置里填上 TheTVDB API Key' }), true;
        const info = hash ? await torrentInfo(hash) : null;
        const q = String(url.searchParams.get('q') || '').trim();
        const type = String(url.searchParams.get('type') || '');
        const year = String(url.searchParams.get('year') || '');
        const parsed = parseTitle(q || info?.name || '');
        // 手动输入的词就是用户的意图，原样搜；没输入时才拿解析结果拆成多语言候选逐个试
        const queries = q ? [q] : titleVariants(parsed.title);
        try {
          let out = { items: [] };
          let used = queries[0] || '';
          for (const query of queries) {
            out = await tvdb.search({
              query,
              type: type || (parsed.isSeries ? 'series' : 'movie'),
              year: year || parsed.year,
              isSeries: parsed.isSeries,
              force: url.searchParams.get('force') === '1',
            });
            used = query;
            if (out.items.length) break;
          }
          return json(res, 200, { parsed, query: used, queries, items: out.items }), true;
        } catch (err) {
          return json(res, 502, { error: 'tvdb', message: err.message }), true;
        }
      }

      // 某个作品的全部海报：?id=&type=
      if (p === '/__cover/tvdb/art') {
        if (!tvdb.status().configured) return json(res, 400, { error: 'no-key', message: '先在设置里填上 TheTVDB API Key' }), true;
        const id = String(url.searchParams.get('id') || '');
        const type = url.searchParams.get('type') === 'movie' ? 'movie' : 'series';
        try {
          return json(res, 200, { items: await tvdb.artworks({ id, type }) }), true;
        } catch (err) {
          return json(res, 502, { error: 'tvdb', message: err.message }), true;
        }
      }

      // 只匹配不落盘：给「添加种子」弹窗用，此时还没有 hash，先拿到海报等添加完再套
      if (p === '/__cover/tvdb/match') {
        if (!tvdb.status().configured) return json(res, 400, { error: 'no-key', message: '先在设置里填上 TheTVDB API Key' }), true;
        const name = String(url.searchParams.get('name') || '').trim();
        if (!name) return json(res, 400, { error: 'no-name', message: '没有可用的片名' }), true;
        try {
          const best = await tvdb.best({
            name,
            type: String(url.searchParams.get('type') || ''),
            year: String(url.searchParams.get('year') || ''),
          });
          if (!best.ok) {
            return json(res, 200, {
              ok: false, reason: best.reason, parsed: best.parsed, query: best.query || '',
              items: (best.items || []).slice(0, 8),
            }), true;
          }
          const sel = best.pick;
          let arts = [];
          try { arts = await tvdb.artworks({ id: sel.id, type: sel.type }); } catch { /* 用搜索结果那张 */ }
          return json(res, 200, {
            ok: true,
            query: best.query || '',
            parsed: best.parsed,
            pick: {
              id: sel.id, type: sel.type, name: sel.name, nameEn: sel.nameEn,
              year: sel.year, score: Math.round(sel.score), image: sel.image || '',
            },
            arts: arts.filter((a) => a.image).slice(0, 12),
          }), true;
        } catch (err) {
          return json(res, 502, { error: 'tvdb', message: err.message }), true;
        }
      }

      // 应用某张海报：body { id, type, image?, name?, year? }
      if (p === '/__cover/tvdb/apply' && req.method === 'POST') {
        if (!HASH_RE.test(hash)) return json(res, 400, { error: 'bad-hash' }), true;
        const body = JSON.parse((await readCapped(req, 8 * 1024)).toString('utf8') || '{}');
        try {
          const out = await applyTvdb(hash, body);
          return json(res, 200, out), true;
        } catch (err) {
          return json(res, 502, { error: 'tvdb', message: err.message }), true;
        }
      }

      // 批量刮削进度流（SSE）：GET /__cover/tvdb/scan/stream
      if (p === '/__cover/tvdb/scan/stream') return scanStream(req, res, url);

      // 自动匹配：body { hash | hashes[], type?, year?, force? }
      if (p === '/__cover/tvdb/auto' && req.method === 'POST') {
        const body = JSON.parse((await readCapped(req, 64 * 1024)).toString('utf8') || '{}');
        const list = (Array.isArray(body.hashes) ? body.hashes : [body.hash || hash])
          .map((h) => String(h || '').toLowerCase())
          .filter((h) => HASH_RE.test(h))
          .slice(0, 50);
        if (!list.length) return json(res, 400, { error: 'bad-hash' }), true;
        if (!tvdb.status().configured) return json(res, 400, { error: 'no-key', message: '先在设置里填上 TheTVDB API Key' }), true;
        const out = {};
        for (const h of list) {
          try {
            out[h] = await autoTvdb(h, body);
          } catch (err) {
            out[h] = { ok: false, reason: 'error', message: err.message };
          }
        }
        return json(res, 200, { results: out }), true;
      }

      // 批量：body { hashes? } 不给就把列表里所有影视种子都跑一遍
      if (p === '/__cover/tvdb/scan' && req.method === 'POST') {
        const body = JSON.parse((await readCapped(req, 64 * 1024)).toString('utf8') || '{}');
        if (!tvdb.status().configured) return json(res, 400, { error: 'no-key', message: '先在设置里填上 TheTVDB API Key' }), true;
        let list = (Array.isArray(body.hashes) ? body.hashes : [])
          .map((h) => String(h || '').toLowerCase())
          .filter((h) => HASH_RE.test(h));
        if (!list.length) list = [...(await torrentMeta()).keys()];
        list = list.slice(0, 300);
        const results = { done: 0, skipped: 0, failed: 0, items: [] };
        for (const h of list) {
          if (!body.force && index.covers[h]?.mode === 'tvdb') { results.skipped++; continue; }
          // 音频 / 压缩包之类的没必要去 TVDB 查，省额度也省时间
          const kind = await kindFor(h).catch(() => '');
          if (kind && kind !== 'video') { results.skipped++; continue; }
          try {
            const r = await autoTvdb(h, {});
            if (r.ok) { results.done++; results.items.push({ hash: h, name: r.name, year: r.year }); }
            else { results.failed++; results.items.push({ hash: h, ok: false, reason: r.reason }); }
          } catch {
            results.failed++;
          }
        }
        return json(res, 200, { ok: true, ...results }), true;
      }

      // 放弃刮削结果，回到「目录图 → 图标」（顺手删掉写进媒体目录的海报 / NFO）
      if (p === '/__cover/tvdb/drop' && req.method === 'POST') {
        if (!HASH_RE.test(hash)) return json(res, 400, { error: 'bad-hash' }), true;
        const cur = index.covers[hash];
        if (cur?.mode === 'tvdb' && cur.file) await unlink(path.join(root, cur.file)).catch(() => {});
        if (cur?.mode === 'tvdb') await removeMetaFiles(hash);
        if (cur?.mode === 'tvdb') delete index.covers[hash];
        await tvdb.dropPoster(hash);
        persist();
        return json(res, 200, { ok: true, mode: 'auto', v: Date.now() }), true;
      }

      // 缓存概况（设置面板用）
      if (p === '/__cover/cache') return json(res, 200, await cacheStats()), true;

      // 各种子刮削到的媒体名（列表标题显示用，一次拿全量，体积极小）
      if (p === '/__cover/titles') {
        const out = {};
        for (const [h, c] of Object.entries(index.covers)) {
          if (c?.mode === 'tvdb' && c.name) {
            out[h] = { name: c.name, year: c.meta?.year || '', type: c.meta?.type || '' };
          }
        }
        return json(res, 200, out), true;
      }

      // 清空缓存：body { scope: 'scan' | 'tvdb' | 'images' | 'all' }（auto 是旧名，等同 images）
      if (p === '/__cover/clear' && req.method === 'POST') {
        let body = {};
        try {
          body = JSON.parse((await readCapped(req, 8 * 1024)).toString('utf8') || '{}');
        } catch { /* 空 body */ }
        if (body.scope === 'auto') body.scope = 'images';
        const scope = ['scan', 'tvdb', 'images', 'all'].includes(body.scope) ? body.scope : 'scan';
        const stats = await clearCache(scope);
        return json(res, 200, { ok: true, scope, stats }), true;
      }

      if (p === '/__cover/forget' && req.method === 'POST') {
        if (!HASH_RE.test(hash)) return json(res, 400, { error: 'bad-hash' }), true;
        await removeCustom(hash);
        delete index.covers[hash];
        const cached = index.auto[hash];
        if (cached?.file) await unlink(path.join(root, cached.file)).catch(() => {});
        delete index.auto[hash];
        torrentCache.delete(hash);
        dirCache.delete(hash);
        if (scan.items[hash]) { delete scan.items[hash]; persistScan(); }
        persist();
        return json(res, 200, { ok: true }), true;
      }

      return json(res, 404, { error: 'not-found' }), true;
    } catch (err) {
      json(res, 500, { error: 'internal', message: err.message });
      return true;
    }
  }

  return {
    handle,
    ready: ready$,
    tvdb,
    clearCache,
    cacheStats,
    stats: () => ({ custom: Object.keys(index.covers).length, auto: Object.keys(index.auto).length }),
  };
}
