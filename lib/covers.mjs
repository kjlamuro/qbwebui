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
import { execFile, spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  mkdir, readdir, stat, unlink, writeFile, readFile,
} from 'node:fs/promises';
import { createTvdb, parseTitle, titleVariants } from './tvdb.mjs';
import { torrentFiles } from './bencode.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 碰媒体盘的操作（readdir / 复制原图）统一放到子进程，并给一个硬超时。
 * 盘在休眠时 open() 可能几分钟不返回，只有子进程能被整只掐掉。
 */
const MEDIA_TIMEOUT = 20_000;
/** 预览推流时「多久没吐出一个字节」就认为盘没响应（视频卡在 open 上就是这个症状） */
const MEDIA_IDLE_TIMEOUT = 15_000;
/** 预览时等第一个字节的上限：超过就当作盘没响应，直接给 504，别让用户干等 */
const MEDIA_FIRST_BYTE_TIMEOUT = 8_000;
/** 媒体盘上的 stat / read 全部交给它做（见 lib/mediaworker.mjs） */
const MEDIA_WORKER = path.join(HERE, 'mediaworker.mjs');
/** 扫盘失败后多久再试一次（不写进 scan.json，免得把「读数失败」记成「没有图」） */
const SCAN_FAIL_TTL = 120_000;

const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp', '.svg']);
const HASH_RE = /^[a-f0-9]{40}$/i;
const MAX_UPLOAD = 8 * 1024 * 1024;
const MAX_SRC = 16 * 1024 * 1024;
const MAX_FILES = 4000;
const MAX_TORRENT = 32 * 1024 * 1024; // 大合集种子的 pieces 能到几十 MB，留足余量
/**
 * 「种子里那个正片叫什么」的缓存：文件清单拿到就记久一点（文件名不会变），
 * 拿不到（magnet 还没取到元数据）就短一些，过几分钟再问一次。
 */
const NAME_TTL = 30 * 60_000;
const NAME_TTL_EMPTY = 3 * 60_000;
/**
 * 目录扫描的缓存有效期分两档：
 * - 还在下载 / 校验的种子，目录内容随时会变 → 60 秒（此时磁盘本来就醒着）
 * - 已完成（或已暂停）的种子，目录不会再动 → **永不自动过期**
 *
 * 为什么是永不：这块盘平时是睡着的，一次 readdir + 每文件 stat 就能把它转醒，
 * 而且要好几秒才恢复转速。6 小时的旧策略等于「每天至少把整个库翻 1~2 遍」，
 * 与「缓存就是为了不碰这块盘」的初衷矛盾。记录落盘（scan.json），重启后照样命中。
 * 想让它重扫只有一个入口：用户在封面弹窗里点「重新扫描」（refresh=1）。
 * 缓存的是「候选图片清单 + 类型权重」，不是图片本身，所以体积很小。
 */
const SCAN_TTL_ACTIVE = 60_000;
const SCAN_TTL_DONE = Number.POSITIVE_INFINITY;
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
/**
 * 这些状态下 qBittorrent 正在往种子目录里写东西（或正在校验 / 移动文件），
 * 目录内容随时可能变，缓存只能短用。其余状态（暂停、做种、排队、已完成）
 * 目录都不会再动 —— 这时候重扫纯属把睡着的盘叫醒。
 */
const ACTIVE_WRITE = new Set([
  'downloading', 'forcedDL', 'metaDL', 'forcedMetaDL',
  'checkingDL', 'checkingUP', 'checkingResumeData', 'allocating', 'moving',
]);
// 列表缩略图只需要很小的图：自动封面压到 640px，候选图压到 320px
const AUTO_SIZE = 640;
const THUMB_SIZE = 320;
// 刮削可能发生在下载刚开始时。此时只缓存结果，等 qB 把内容移入最终目录后再补写。
const META_RETRY_MS = 15_000;
const META_RETRY_MAX = 40; // 完成后目录仍不可用时最多再试约 10 分钟，避免单文件种子永久轮询
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

/**
 * 一次遍历同时拿到：候选图片 + 各类文件的体积权重（用于判类型）。
 *
 * 这份实现跑在 scanworker.mjs 那个独立进程里，服务本身不直接调用它 —— 理由见
 * 下面 copyFromMedia 的注释和 lib/scanworker.mjs。
 */
export async function scanDirDirect(dir, maxDepth = 2) {
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

/**
 * 从媒体盘复制一张图。用 /bin/cp 而不是 fs.copyFile：盘卡住时子进程能被超时掐掉，
 * fs.copyFile 卡住只会拖死服务自己的线程池。
 */
export function copyFromMedia(src, dest, timeout = MEDIA_TIMEOUT) {
  return new Promise((resolve, reject) => {
    execFile('/bin/cp', [src, dest], { timeout }, (err) => (err ? reject(err) : resolve()));
  });
}

/** 往媒体盘写一个文本文件（NFO），同样走子进程，卡住可掐 */
export function writeToMedia(dest, text, timeout = MEDIA_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', 'cat > "$1"', 'sh', dest], { timeout, killSignal: 'SIGKILL' });
    let err = '';
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(signal ? `写入超时（${signal}）` : err.trim() || `exit ${code}`));
    });
    child.stdin.on('error', () => {}); // 子进程被杀时写 stdin 会 EPIPE
    child.stdin.end(text);
  });
}

/**
 * 删媒体盘上的文件（只用于我们自己写进去的 sidecar）。同样走子进程：
 * 盘掉线时 unlink 一样会卡在内核里，不能让它落进服务的线程池。
 */
export function removeFromMedia(paths, timeout = MEDIA_TIMEOUT) {
  return new Promise((resolve, reject) => {
    if (!paths.length) return resolve();
    execFile('/bin/rm', ['-f', '--', ...paths], { timeout }, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * 在媒体盘上「按顺序找第一个存在的文件」，整段在子进程里跑。
 * 返回 { full, size } / null（确实没有）/ 'timeout'（盘没响应）。
 *
 * 用子进程而不是 fs.stat，理由和 copyFromMedia 一样：盘睡着时 stat 会卡在
 * 内核里，JS 层没有任何办法打断它。
 */
export function firstExistingOnMedia(paths, timeout = MEDIA_TIMEOUT) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [MEDIA_WORKER, 'first', JSON.stringify(paths)],
      { timeout, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(err.killed ? 'timeout' : null);
        try {
          const v = JSON.parse(String(stdout || 'null'));
          resolve(v && v.full ? { full: v.full, size: v.size } : null);
        } catch {
          resolve(null);
        }
      }
    );
  });
}

/**
 * 起一个子进程，把媒体文件的 [start, end] 字节吐到 stdout。
 * 调用方负责 pipe、空闲超时和 kill —— 卡住时死的是这个子进程，不是服务。
 */
export function openMediaStream(full, start, end) {
  return spawn(
    process.execPath,
    [MEDIA_WORKER, 'stream', full, String(start), String(end)],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  );
}

/**
 * 找「正片」：体积最大的视频文件。同样跑在子进程里（见 scanworker.mjs）。
 */
export async function biggestVideoDirect(dir, maxDepth = 2) {
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

export function createCovers({ dataDir, qbFetch, onLog = () => {} }) {
  const root = path.join(dataDir, 'covers');

  /**
   * 这个路径是不是在 data/ 里（缓存、demo 素材）。
   * 内建盘上的文件直接流没问题；媒体盘（外置 / 网络卷）必须走子进程。
   */
  const localRoot = path.resolve(dataDir) + path.sep;
  const isLocalPath = (full) => path.resolve(full).startsWith(localRoot);
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
  let metaTimer = null;
  let metaRunning = false;
  const metaWrites = new Map(); // hash -> Promise，串行化同一种子的套用与后台补写
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
        // 兼容旧索引：元信息写媒体目录现在是**手动操作**，不再后台补写。
        // 旧记录里 metaRetry 一律作废；只有「没有状态但确实写过文件」的才按已应用算，
        // error 保持 error —— 那说明上次写入没成功，用户需要重新点一次。
        let touched = false;
        for (const cur of Object.values(index.covers)) {
          if (cur?.mode !== 'tvdb') continue;
          if (cur.metaRetry) { delete cur.metaRetry; touched = true; }
          if (cur.metaAttempts) { delete cur.metaAttempts; touched = true; }
          const hasFiles = Array.isArray(cur.metaFiles) && cur.metaFiles.length;
          if (!cur.metaStatus || cur.metaStatus === 'pending') {
            cur.metaStatus = hasFiles ? 'written' : 'idle';
            cur.metaMessage = hasFiles ? '海报和 NFO 已写入媒体目录' : '';
            touched = true;
          } else if (cur.metaStatus === 'written' && cur.metaMessage !== '海报和 NFO 已写入媒体目录') {
            cur.metaMessage = '海报和 NFO 已写入媒体目录';
            touched = true;
          }
        }
        if (touched) persist();
      }
    } catch { /* 首次运行 */ }
    try {
      const raw = JSON.parse(await readFile(scanPath, 'utf8'));
      if (raw && raw.items && typeof raw.items === 'object') Object.assign(scan.items, raw.items);
    } catch { /* 首次运行 */ }
    // 老版本没有 scanned 标记。老记录基本都是真扫过目录的（哪怕是单文件种子扫出
    // 「没有独立目录」也是真实结论）；只有 writeKind 新建的半成品会显式写 false。
    // 这里补上 true，否则升级后第一批浏览会把这些种子全部重新 stat 一遍。
    let migrated = false;
    for (const rec of Object.values(scan.items)) {
      if (!rec || typeof rec !== 'object' || typeof rec.scanned === 'boolean') continue;
      rec.scanned = true;
      if (rec.done) rec.settled = true;
      migrated = true;
    }
    if (migrated) persistScan();
    await tvdb.ready();
    scheduleMetaRetry(1000);
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
          state: String(list[0].state || ''),
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
  async function torrentDir(hash, preInfo) {
    const info = preInfo !== undefined ? preInfo : await torrentInfo(hash);
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

  /* ── 片名来源：优先种子里的文件清单 ─────────────────── */

  /**
   * 从文件清单里挑「正片」：体积最大的视频文件，跳过 sample / 花絮。
   * qBittorrent 的 files 接口、以及 .torrent 里解出来的清单，格式一致，都能直接喂进来。
   */
  function mainVideoFrom(files) {
    let best = '';
    let bestSize = -1;
    for (const f of files || []) {
      const raw = String(f?.name || '');
      if (!raw) continue;
      if (kindOfExt(kindExtOf(raw)) !== 'video') continue;
      const base = raw.split('/').pop();
      if (!base || /^(sample|trailer|preview|featurette|teaser)\b/i.test(base)) continue;
      const size = Number(f.size) || 0;
      if (size > bestSize) { bestSize = size; best = base; }
    }
    return best;
  }

  /**
   * 解析出来的东西像不像一个片名。
   * 正片文件名有时候就是 `01.mkv` / `cd1.avi` / `sample.mkv`，这种拿去搜 TVDB 纯属白烧额度，
   * 不如退回种子名。
   */
  function looksLikeTitle(title) {
    const s = String(title || '').trim();
    if (s.length < 2) return false;
    if (/^[\d\s._-]+$/.test(s)) return false; // 01 / 2024 / 1-2
    if (/^[a-z0-9]{32,40}$/i.test(s)) return false; // 长得像 hash
    if (/^(cd|disc|disk|part|vol|ep|episode|e|sample|trailer|preview|featurette|teaser)\d*$/i.test(s)) return false;
    return true;
  }

  /** 种子里的正片文件名：走 qBittorrent 的文件清单，还没下完也能拿到 */
  const nameCache = new Map(); // hash → { at, file }
  async function filesName(hash) {
    const hit = nameCache.get(hash);
    if (hit && Date.now() - hit.at < (hit.file ? NAME_TTL : NAME_TTL_EMPTY)) return hit;
    let file = '';
    try {
      const files = await qbFetch(`/api/v2/torrents/files?hash=${hash}`);
      if (Array.isArray(files)) file = mainVideoFrom(files);
    } catch { /* 上游不可用，交给种子名兜底 */ }
    const rec = { at: Date.now(), file };
    nameCache.set(hash, rec);
    if (nameCache.size > 800) nameCache.delete(nameCache.keys().next().value);
    return rec;
  }

  /**
   * 一个种子到底按什么名字去搜 TVDB。优先级：
   *   用户手填的关键词 > 种子里的正片文件名 > 种子名
   *
   * 文件清单排前面是有原因的：种子名是发布组堆出来的
   * （`Some.Release.2024.2160p.WEB-DL.DDP5.1.Atmos-GRP`），而正片文件名往往就是
   * `The.Matrix.1999.1080p.mkv` 这种干净得多的东西，年份、片名都在，误配少一截。
   */
  async function seedTitle(hash, opts = {}) {
    const forced = String(opts.name || '').trim();
    if (forced) return { name: forced, from: 'manual', parsed: parseTitle(forced) };

    let pick = '';
    let from = '';
    if (hash && HASH_RE.test(hash)) {
      const rec = await filesName(hash);
      if (rec.file) {
        const fileParsed = parseTitle(rec.file);
        if (looksLikeTitle(fileParsed.title)) { pick = rec.file; from = 'file'; }
      }
    }
    if (!pick) {
      const info = hash ? await torrentInfo(hash) : null;
      if (info?.name) { pick = info.name; from = 'torrent'; }
    }
    return { name: pick, from, parsed: parseTitle(pick) };
  }

  /* ── 目录里的图片 ───────────────────────────────────── */

  const ttlFor = (rec) => (rec?.done || rec?.settled ? SCAN_TTL_DONE : SCAN_TTL_ACTIVE);

  /**
   * 目录扫描结果。命中顺序：内存 → 磁盘（scan.json）→ 真去扫盘。
   * 落盘之后，服务重启、第二天开机都不会再遍历一遍外置盘。
   *
   * opts.refresh 是唯一的重扫入口（封面弹窗里的「重新扫描」）：默认路径永远
   * 优先吃缓存，宁可结果旧一点，也不去叫醒一块睡着的盘。
   */
  async function dirInfoFor(hash, opts = {}) {
    const now = Date.now();
    if (!opts.refresh) {
      const cached = dirCache.get(hash) || scan.items[hash];
      // scanned 标记「这条记录是真遍历过目录得来的」。只有它才能被续期：
      // writeKind 也会建记录（dir 为空、images 为空），那是「只知道类型」的半成品，
      // 直接续用会让封面弹窗永远显示「没有独立目录」。
      if (cached?.scanned) {
        if (now - cached.at < ttlFor(cached)) {
          dirCache.set(hash, cached);
          return cached;
        }
        // 记录过期了，但「过期」只是保险起见怕目录变了。先问一句上游（纯 HTTP，
        // 不摸盘）：如果这个种子已经不在写这个目录了（下完了 / 暂停 / 只做种），
        // 目录就不可能再变 —— 直接续用旧结果，免得为了保险去叫醒睡着的盘。
        const info = await torrentInfo(hash);
        if (info && (info.done || !ACTIVE_WRITE.has(info.state))) {
          Object.assign(cached, { at: now, done: info.done, state: info.state, settled: true });
          dirCache.set(hash, cached);
          persistScan();
          return cached;
        }
      } else if (cached?.failed && now - cached.at < SCAN_FAIL_TTL) {
        // 上次读盘失败（超时 / 卷卡住）：给它一个冷静期，别每开一次页面就去撞一次
        return cached;
      }
    }
    const info = await torrentInfo(hash);
    const dir = await torrentDir(hash, info);
    const scanned = dir
      ? await withScanSlot(() => scanDir(dir))
      : { images: [], kind: '', weights: {} };
    const { images, kind, weights } = scanned;
    if (scanned.failed) {
      // 没读成 ≠ 目录里没图。写成「没有图」会让这个种子永远只剩类型图标，
      // 所以只在内存里记一笔失败的临时结论，scan.json 一个字都不动。
      const rec = {
        at: now,
        dir: dir || '',
        images: [],
        kind: '',
        kindSrc: '',
        weights: {},
        done: Boolean(info?.done),
        state: info?.state || '',
        scanned: false,
        failed: true,
      };
      dirCache.set(hash, rec);
      return rec;
    }
    // 上一次的类型结论（可能来自文件清单）别被这次扫盘结果冲掉
    const prev = scan.items[hash];
    const mergedKind = kind || prev?.kind || '';
    const rec = {
      at: now,
      dir: dir || '',
      images,
      kind: mergedKind,
      kindSrc: kind ? 'dir' : (prev?.kindSrc || ''),
      weights,
      done: info?.done || false,
      state: info?.state || '',
      scanned: true,
      // 这次扫描时它就不写盘了 → 以后也不用再扫（除非手动 refresh）
      settled: Boolean(info && (info.done || !ACTIVE_WRITE.has(info.state))),
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

  /**
   * 目录遍历是重 IO，而且多半读的是外置盘。一次只放 2 个进去：libuv 线程池
   * 总共 4 个线程，扫描把它占满之后静态资源和上游代理会跟着一起排队——极端
   * 情况就是整站无响应。留一半线程给 HTTP 这条主路。
   */
  const SCAN_SLOTS = 2;
  let scanActive = 0;
  const scanWaiters = [];
  async function withScanSlot(fn) {
    if (scanActive >= SCAN_SLOTS) await new Promise((r) => scanWaiters.push(r));
    scanActive += 1;
    try {
      return await fn();
    } finally {
      scanActive -= 1;
      const next = scanWaiters.shift();
      if (next) next();
    }
  }

  /**
   * 扫目录：**放到子进程里做**。
   *
   * 外置盘休眠 / 掉速时，readdir 的 open() 会永久阻塞在内核里 —— 没有超时，JS 层
   * 完全无从中断。这种阻塞一旦落在线程池 worker 上，那个线程就再也回不来：今天
   * 06:32 和 06:58 两次「进程还在、页面打不开」都是这么来的。
   * 放进子进程后最坏只是子进程卡住被 timeout 掐掉，服务本身毫发无损。
   */
  const SCAN_WORKER = path.join(HERE, 'scanworker.mjs');

  /** 起一个媒体盘子进程，超时/失败一律返回 null（调用方按「读不到」处理） */
  function runWorker(mode, dir, depth = 2) {
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [SCAN_WORKER, mode, dir, String(depth)],
        { timeout: MEDIA_TIMEOUT, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => {
          if (err) {
            onLog(`读盘失败（${mode}），已跳过 ${dir}：${err.killed ? '超时' : err.message}`);
            resolve(null);
            return;
          }
          try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
        }
      );
    });
  }

  async function scanDir(dir, maxDepth = 2) {
    const out = await runWorker('scan', dir, maxDepth);
    if (!out) return { images: [], kind: '', weights: {}, failed: true };
    return { images: out.images || [], kind: out.kind || '', weights: out.weights || {}, failed: false };
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
    if (rec.settled) return true; // 目录不会再变，扫出来的类型就是定论
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
    else scan.items[hash] = { at: now, dir: '', images: [], weights: {}, done: false, scanned: false, ...patch };
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
    // 只缓存了类型、还没真遍历过目录（scanned=false）→ 结论未知，让前端试探一次，
    // 由 /__cover/img 触发那唯一一次扫描。判成「没有封面」会让自动封面永远不出现。
    if (!rec || rec.scanned === false) return -1;
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
    // 先问 qBittorrent 的文件清单：纯上游 HTTP，**完全不碰媒体盘**。
    // 清单不随下载进度变化，写成 kindSrc='files' 后永久有效，一个种子一辈子只问一次。
    // 以前是反过来（先扫盘、扫不出来才问清单），为了一个图标先把睡着的盘叫醒。
    const fromFiles = await filesKind(hash);
    if (fromFiles) {
      writeKind(hash, fromFiles, 'files');
      return fromFiles;
    }
    // 清单也判不出来（磁力还没拿到元数据 / 全是 .nfo 这类），才退到扫目录
    const rec = await dirInfoFor(hash, opts);
    const k = rec.kind || 'other';
    // 来源要按「原来的来源」定：之前只是猜的，重算一次也还是猜的，不能升格成目录判定
    writeKind(hash, k, rec.kindSrc === 'dir' ? 'dir' : 'guess');
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
    // 同样先走文件清单：加种子的瞬间就把类型定下来，一次盘都不用碰
    const fromFiles = await filesKind(hash);
    if (fromFiles) {
      writeKind(hash, fromFiles, 'files');
      return fromFiles;
    }
    const rec = await dirInfoFor(hash);
    const guessed = guessKind(hint);
    const k = (rec.kindSrc === 'dir' ? rec.kind : '') || guessed;
    // 这一轮什么都没算出来（比如磁力还没拿到元数据）就保留上一次的结果，别把它冲成 other
    if (!k && rec.kind) return rec.kind;
    writeKind(hash, k || 'other', rec.kindSrc === 'dir' ? 'dir' : 'guess');
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
          // 媒体目录里的海报 / NFO 是用户手动「应用」的成果，清缓存不动它 ——
          // 清缓存是本地行为，不该顺手改别人的媒体库。要删请用弹窗里的「移除」。
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

  /**
   * 候选图的小图（供封面弹窗的网格用）。
   * 先查 thumb 缓存：做过一次就再也不回媒体盘取原图，弹窗重开是零 IO。
   */
  async function ensureRawThumb(hash, rel) {
    const ext = extOf(rel);
    if (!IMG_EXT.has(ext)) return null;
    const key = `${hash}-${Buffer.from(rel).toString('hex').slice(0, 60)}`;
    const file = path.join('raw', `${key}${ext}`);
    const dest = path.join(root, file);
    try {
      const s = await stat(dest);
      if (s.size > 0) return file;
    } catch { /* 还没有缓存 */ }
    const dir = await torrentDir(hash);
    if (!dir) return null;
    const full = path.resolve(dir, rel);
    if (!full.startsWith(dir + path.sep)) return null;
    try {
      await withScanSlot(() => copyFromMedia(full, dest));
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

  /**
   * 自动封面：**先看本地缓存，有就直接给它**。
   *
   * 封面一旦复制进 data/covers/auto/<hash>.<ext>，就只跟这个种子绑定，跟媒体盘
   * 在不在线无关。旧实现是「先扫目录拿候选图，再比对 size/mtime 决定要不要重建」，
   * 于是每看一次封面就要叫醒一次盘——缓存白做。现在只有缓存文件真丢了（清过缓存、
   * 手动换过图）才回退去扫目录。
   */
  async function ensureAuto(hash, opts = {}) {
    const cached = index.auto[hash];
    if (cached?.file && !opts.refresh) {
      try {
        const s = await stat(path.join(root, cached.file));
        if (s.size > 0) return cached.file;
      } catch { /* 缓存文件被清掉了，往下重建 */ }
    }
    const { dir, images } = await dirInfoFor(hash, opts);
    if (!dir || !images.length) {
      // 种子没有独立目录 / 目录里没图：清掉可能存在的旧缓存，让它回到类型图标
      if (index.auto[hash]) { delete index.auto[hash]; persist(); }
      return null;
    }
    const pick = images[0];
    // 走到这里说明缓存文件不存在，才需要读源图（唯一一次碰媒体盘）
    const ext = extOf(pick.path);
    const file = path.join('auto', `${hash}${ext}`);
    const dest = path.join(root, file);
    try {
      if (cached?.file) await unlink(path.join(root, cached.file)).catch(() => {});
      // 读源图走扫描槽：盘在休眠/掉速时一次读可能卡十几秒，不能让它连带占满线程池
      await withScanSlot(() => copyFromMedia(pick.path, dest));
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

  /**
   * 发图。返回 Promise<boolean>：true = 已写出响应；false = 文件不在（调用方还能补救）。
   */
  function sendImage(req, res, file, extra = {}) {
    const full = path.isAbsolute(file) ? file : path.join(root, file);
    return stat(full).then((s) => {
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
        res.end();
        return true;
      }
      res.writeHead(200, headers);
      if (req.method === 'HEAD') {
        res.end();
        return true;
      }
      createReadStream(full).pipe(res);
      return true;
    }).catch(() => {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'x-cover': 'none' });
      res.end('{"error":"no-cover"}');
      return false;
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
    // 换海报会重建索引对象：把「已经写进媒体目录的文件清单」带过来，否则旧 sidecar
    // 就成了没人认领的孤儿（之后既清不掉，也不知道盘上已经有元信息）。
    const prev = index.covers[hash];
    const keptFiles = Array.isArray(prev?.metaFiles) && prev.metaFiles.length ? prev.metaFiles : [];
    const sameWork = Boolean(prev?.meta?.id && String(prev.meta.id) === String(sel.id || ''));
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
      // 元信息写媒体目录是手动操作：这里只落本机缓存，等用户点「应用到媒体目录」。
      metaStatus: keptFiles ? (sameWork ? 'written' : 'stale') : 'idle',
      metaMessage: keptFiles
        ? (sameWork ? '海报和 NFO 已写入媒体目录' : '元信息已更换，需要重新应用到媒体目录')
        : '',
      ...(keptFiles.length ? { metaFiles: keptFiles, metaDir: prev.metaDir || '' } : {}),
    };
    persist();
    return {
      ok: true, mode: 'tvdb', name: index.covers[hash].name, v: Date.now(),
      metaStatus: index.covers[hash].metaStatus, metaMessage: index.covers[hash].metaMessage,
      metaFiles: keptFiles,
    };
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
    const out = await runWorker('video', dir, maxDepth);
    return out?.video || null;
  }

  /**
   * 刮削成功后把海报和 NFO 写进种子自己的目录，命名按各媒体服务的本地资源约定：
   * - 电影：放在视频旁边，<视频名>-poster.jpg + <视频名>.nfo（Plex / Kodi / Jellyfin 都认）
   * - 剧集：种子目录根部放 poster.jpg + tvshow.nfo（剧集按整季归档，不跟单集同名）
   * 下载中绝不写 content_path，避免它指向临时目录时把 sidecar 留在错误位置。
   * 写过哪些记在 metaFiles，换海报 / 放弃刮削 / 清 TVDB 缓存时一并删掉。
   */
  function metaResult(cur, status, message, retry, extra = {}) {
    const patch = { metaStatus: status, metaMessage: message, metaRetry: retry, ...extra };
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
      const same = Array.isArray(value)
        ? JSON.stringify(cur[key] || []) === JSON.stringify(value)
        : cur[key] === value;
      if (!same) { cur[key] = value; changed = true; }
    }
    if (changed) { cur.metaAt = Date.now(); persist(); }
    if (retry) scheduleMetaRetry();
    return { ok: status === 'written', status, message, files: cur.metaFiles || [] };
  }

  function scheduleMetaRetry(delay = META_RETRY_MS) {
    if (metaTimer) return;
    const pending = Object.values(index.covers).some((c) => c?.mode === 'tvdb' && c.metaRetry);
    if (!pending) return;
    metaTimer = setTimeout(() => {
      metaTimer = null;
      runMetaRetries().catch((err) => onLog(`元信息补写失败：${err.message}`));
    }, delay);
    if (metaTimer.unref) metaTimer.unref();
  }

  async function runMetaRetries() {
    if (metaRunning) return;
    metaRunning = true;
    try {
      await ready$();
      const hashes = Object.entries(index.covers)
        .filter(([, c]) => c?.mode === 'tvdb' && c.metaRetry)
        .map(([h]) => h);
      // 串行访问外置盘；完成前只是轻量查询，完成后才复制海报、写 NFO。
      for (const h of hashes) await writeMetaFiles(h);
    } finally {
      metaRunning = false;
      scheduleMetaRetry();
    }
  }

  async function writeMetaFiles(hash, opts = {}) {
    const prev = metaWrites.get(hash) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => writeMetaFilesNow(hash, opts));
    metaWrites.set(hash, next);
    try {
      return await next;
    } finally {
      if (metaWrites.get(hash) === next) metaWrites.delete(hash);
    }
  }

  async function writeMetaFilesNow(hash, opts = {}) {
    // 手动应用：不做后台重试（重试会在用户不知情时反复去摸媒体盘，也会让「手动」
    // 变成事实上自动）。失败就把原因回给按钮，用户自己决定要不要再点一次。
    const manual = Boolean(opts.manual);
    const cur = index.covers[hash];
    if (cur?.mode !== 'tvdb' || !cur?.file) {
      return { ok: false, status: 'idle', message: '请先刮削海报和元信息', files: [] };
    }
    // 60 秒的常规种子信息缓存会盖住“刚完成 / 刚移动”，补写必须读实时状态。
    torrentCache.delete(hash);
    const info = await torrentInfo(hash);
    if (!info) {
      const attempts = (cur.metaAttempts || 0) + 1;
      const canRetry = !manual && attempts < META_RETRY_MAX;
      return metaResult(cur, canRetry ? 'pending' : 'error',
        canRetry ? '暂时无法读取种子位置，将自动重试' : '无法读取种子位置，种子可能已被删除',
        canRetry, { metaAttempts: attempts });
    }
    if (!info.done) {
      return metaResult(cur, 'idle', '下载完成后才能写入媒体目录', false, { metaAttempts: 0 });
    }

    const attempts = (cur.metaAttempts || 0) + 1;
    const canRetry = !manual && attempts < META_RETRY_MAX;
    const dir = await torrentDir(hash);
    if (!dir) {
      return metaResult(cur, canRetry ? 'pending' : 'error',
        canRetry ? '最终媒体目录尚未就绪，将自动重试' : '找不到可写入的种子独立目录',
        canRetry, { metaAttempts: attempts });
    }

    const targets = [];
    const errors = [];
    const put = async (dst, fn) => {
      try { await fn(dst); targets.push(dst); }
      catch (err) { errors.push(`${path.basename(dst)}：${err.message}`); }
    };
    const posterSrc = path.join(root, cur.file);
    const meta = cur.meta || {};
    if (meta.type === 'series') {
      await put(path.join(dir, 'poster.jpg'), (d) => copyFromMedia(posterSrc, d));
      await put(path.join(dir, 'tvshow.nfo'), (d) => writeToMedia(d, nfoXml(meta)));
    } else {
      const video = await withScanSlot(() => biggestVideo(dir));
      if (!video) {
        return metaResult(cur, canRetry ? 'pending' : 'error',
          canRetry ? '等待正片文件进入最终目录' : '最终目录中没有可关联的视频文件',
          canRetry, { metaAttempts: attempts });
      }
      const base = video.slice(0, -extOf(video).length);
      await put(`${base}-poster${extOf(cur.file) || '.jpg'}`, (d) => copyFromMedia(posterSrc, d));
      await put(`${base}.nfo`, (d) => writeToMedia(d, nfoXml(meta)));
    }

    if (errors.length) {
      // 部分成功也保留完整旧清单，确保下次重试或“放弃刮削”能清理所有已写文件。
      const files = [...new Set([...(cur.metaFiles || []), ...targets])];
      return metaResult(cur, canRetry ? 'pending' : 'error',
        `元信息写入失败：${errors.join('；')}`, canRetry, { metaAttempts: attempts, metaFiles: files });
    }

    // 只有新位置完整写好后才清理旧 sidecar，避免移动或重试时把仅存的元信息删掉。
    for (const old of cur.metaFiles || []) {
      if (!targets.includes(old)) await unlink(old).catch(() => {});
    }
    return metaResult(cur, 'written', '海报和 NFO 已写入媒体目录', false, {
      metaAttempts: 0, metaFiles: targets, metaDir: dir,
    });
  }

  /**
   * 删除之前写进媒体目录的元信息文件（海报 + NFO）。
   * 只删自己写过的、且文件名符合 sidecar 约定的：这个函数会动用户的媒体库，
   * 不能拿索引里一个脏路径就去 rm。
   */
  const SIDECAR_RE = /^(poster\.(jpe?g|png|webp)|tvshow\.nfo|.+(-poster\.(jpe?g|png|webp))|.+\.nfo)$/i;

  function safeSidecars(cur) {
    const dir = cur?.metaDir ? path.resolve(cur.metaDir) : '';
    return (cur?.metaFiles || []).filter((f) => {
      if (!f || !path.isAbsolute(f) || !SIDECAR_RE.test(path.basename(f))) return false;
      if (dir && path.resolve(path.dirname(f)) !== dir) return false;
      return true;
    });
  }

  async function removeMetaFiles(hash) {
    const cur = index.covers[hash];
    const files = safeSidecars(cur);
    let removed = 0;
    if (files.length) {
      try {
        await removeFromMedia(files);
        removed = files.length;
      } catch (err) {
        onLog(`清理媒体目录 sidecar 失败：${err.message}`);
        return { ok: false, removed: 0, message: `删除失败：${err.message}` };
      }
    }
    if (cur) {
      delete cur.metaFiles;
      delete cur.metaDir;
      delete cur.metaAttempts;
      delete cur.metaRetry;
      if (cur.mode === 'tvdb') {
        cur.metaStatus = 'idle';
        cur.metaMessage = '';
        cur.metaAt = Date.now();
      }
      persist();
    }
    return { ok: true, removed, message: removed ? '已从媒体目录移除' : '媒体目录里没有可移除的元信息' };
  }

  /**
   * 换封面类型（自定义 / 图标 / 自动）时，把「已经写进媒体目录的文件」带过去。
   * 不带的话这些 sidecar 就再也没人追踪了：用户想移除也找不到入口。
   */
  function withMetaCarry(hash, patch) {
    const cur = index.covers[hash];
    if (!Array.isArray(cur?.metaFiles) || !cur.metaFiles.length) return patch;
    return {
      ...patch,
      metaFiles: cur.metaFiles,
      metaDir: cur.metaDir || '',
      metaStatus: cur.metaStatus || 'written',
      metaMessage: cur.metaMessage || '海报和 NFO 已写入媒体目录',
    };
  }

  /** 当前种子的刮削-写入状态（前端状态行直接用这个，避免为刷新状态再读一次盘） */
  function metaSummary(hash) {
    const cur = index.covers[hash];
    const hasFiles = Array.isArray(cur?.metaFiles) && cur.metaFiles.length;
    if (cur?.mode !== 'tvdb' && !hasFiles) return null;
    return {
      status: cur.metaStatus || (hasFiles ? 'written' : 'idle'),
      message: cur.metaMessage || '',
      count: hasFiles ? cur.metaFiles.length : 0,
      dir: cur.metaDir || '',
      // 只有还在刮削状态才能重新生成 NFO；换成自定义图后只剩「移除」可用
      canApply: cur.mode === 'tvdb',
    };
  }

  /** 手动「应用到媒体目录」：把当前刮削的海报 + NFO 写进种子目录 */
  async function applyMetaToDir(hash) {
    const cur = index.covers[hash];
    if (cur?.mode !== 'tvdb') {
      return { ok: false, status: 'idle', message: '请先刮削海报和元信息', files: [] };
    }
    if (!cur.meta || (!cur.meta.name && !cur.meta.id)) {
      return { ok: false, status: 'idle', message: '这条封面没有刮削元信息，无法生成 NFO', files: [] };
    }
    return writeMetaFiles(hash, { manual: true });
  }

  /** 按种子名自动匹配一部作品并套用它的海报；分数太低就返回候选让用户挑 */
  async function autoTvdb(hash, opts = {}) {
    const seed = await seedTitle(hash, { name: opts.name });
    const name = seed.name;
    if (!name) return { ok: false, reason: 'no-name', nameFrom: '', sourceName: '' };
    const best = await tvdb.best({ name, type: opts.type, year: opts.year });
    const origin = { nameFrom: seed.from, sourceName: seed.name };
    if (!best.ok) {
      return { ok: false, reason: best.reason, parsed: best.parsed, query: best.query || '', items: (best.items || []).slice(0, 8), ...origin };
    }
    const sel = best.pick;
    let image = sel.image || '';
    let arts = [];
    try {
      arts = await tvdb.artworks({ id: sel.id, type: sel.type });
      image = (arts.find((a) => a.kind === 'poster') || arts[0])?.image || image;
    } catch { /* 拿不到海报列表就用搜索结果里那张 */ }
    const applied = await applyTvdb(hash, {
      id: sel.id, type: sel.type, image, name: sel.name, nameEn: sel.nameEn, year: sel.year, overview: sel.overview,
    });
    return {
      ok: true, id: sel.id, name: sel.name, nameEn: sel.nameEn, year: sel.year, type: sel.type,
      metaStatus: applied.metaStatus, metaMessage: applied.metaMessage, metaFiles: applied.metaFiles,
      score: Math.round(sel.score), query: best.query || '', ...origin,
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

  /**
   * 依次尝试完整路径，以及下载中常见的 .part / .!qB 后缀。
   * stat 走子进程：预览视频时浏览器会连发 Range 请求，几个卡在休眠盘上的
   * stat 就足以把主进程的线程池占满（18:40 那次崩溃就是这么来的）。
   */
  async function firstExistingFile(candidates) {
    const expanded = [];
    const tried = new Set();
    for (const p of candidates) {
      if (!p || tried.has(p)) continue;
      tried.add(p);
      for (const file of [p, `${p}.part`, `${p}.!qB`]) expanded.push(file);
    }
    return firstExistingOnMedia(expanded, 10_000); // 预览要快：10 秒找不到就当盘没响应
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
    if (file === 'timeout') {
      return json(res, 504, {
        error: 'timeout',
        message: '读取媒体盘超时（磁盘可能已休眠或没有响应），稍后重试',
      });
    }
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
    if (req.method === 'HEAD') {
      res.writeHead(status, headers);
      return res.end();
    }

    // 本地缓存目录（data/ 下）是内建盘，直接流没问题；媒体盘一律走子进程。
    // 差别就在「卡住时死谁」：媒体盘上 open() 卡进内核是不可中断的，落进服务
    // 线程池就再也回不来（看视频会发好几个 Range 请求，几次就占满）。
    if (isLocalPath(full)) {
      res.writeHead(status, headers);
      const stream = createReadStream(full, { start, end });
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy()); // 用户关掉播放器就别再读盘了
      stream.pipe(res);
      return;
    }

    // 媒体盘：先让子进程吐出第一个字节，确认盘真的读得动，再发响应头。
    // 反过来做（先 writeHead 再流）在盘没响应时只能 destroy，浏览器看到的是
    // 「连接被重置」而不是一句能看懂的话。
    const child = openMediaStream(full, start, end);
    const first = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ type: 'timeout' }), MEDIA_FIRST_BYTE_TIMEOUT);
      const done = (v) => { clearTimeout(timer); resolve(v); };
      child.stdout.once('data', (chunk) => done({ type: 'data', chunk }));
      child.once('error', () => done({ type: 'error' }));
      child.once('close', (code) => done({ type: 'close', code }));
    });
    if (first.type !== 'data') {
      try { child.kill('SIGKILL'); } catch { /* 已经退了 */ }
      if (first.type === 'timeout') {
        return json(res, 504, {
          error: 'timeout',
          message: '读取媒体盘超时（磁盘可能已休眠或没有响应），稍后重试',
        });
      }
      return json(res, 404, {
        error: 'no-file',
        message: '这个文件读不出来（可能已被移动或删除）',
      });
    }

    res.writeHead(status, headers);
    let settled = false;
    let idle = null;
    const finish = (destroy) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      try { child.kill('SIGKILL'); } catch { /* 已经退了 */ }
      if (destroy) res.destroy();
    };
    // 空闲超时：中途盘罢工（子进程不再吐字节）时掐掉它，别让请求永远挂着
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => finish(true), MEDIA_IDLE_TIMEOUT);
    };
    arm();
    res.write(first.chunk);
    child.stdout.on('data', (chunk) => {
      arm();
      // 手动处理背压：4K 视频一口气灌进内存会炸，缓冲满了先暂停子进程
      if (!res.write(chunk)) {
        child.stdout.pause();
        res.once('drain', () => {
          arm();
          child.stdout.resume();
        });
      }
    });
    child.stdout.on('error', () => finish(true));
    child.on('error', () => finish(true));
    child.on('close', (code) => {
      clearTimeout(idle);
      if (settled) return;
      if (code !== 0) return finish(true);
      settled = true;
      if (!res.writableEnded) res.end();
    });
    res.on('close', () => finish(true)); // 关掉播放器就掐掉子进程，别再占着盘
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
        // 索引里有、文件却没了（手工删过缓存）→ 直接 404 让前端退成图标。
        // 绝不在这里「回退去读目录」：那等于为了补一张图把睡着的盘叫醒。
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
        // 手动「重新扫描」：这是唯一会主动去读媒体盘的入口。顺手作废这个种子的
        // 自动封面缓存，好让下一次 /__cover/img 按新结果重挑一张。
        const refresh = url.searchParams.get('refresh') === '1';
        if (refresh) {
          const old = index.auto[hash];
          if (old?.file) {
            delete index.auto[hash];
            persist();
            unlink(path.join(root, old.file)).catch(() => {});
          }
        }
        const { dir, images, weights, failed } = await dirInfoFor(hash, { refresh });
        const cur = index.covers[hash];
        const info = await torrentInfo(hash);
        return json(res, 200, {
          dir: dir || '',
          // 读盘失败（超时 / 无权限）：前端据此提示，而不是显示「目录里没找到图片」
          readError: Boolean(failed),
          mode: cur?.mode || 'auto',
          name: cur?.name || '',
          kind: await kindFor(hash),
          weights,
          count: images.length,
          tvdb: cur?.mode === 'tvdb' ? (cur.meta || null) : null,
          // 元信息是否已经写进媒体目录：手动按钮据此显示状态
          meta: metaSummary(hash),
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
        index.covers[hash] = withMetaCarry(hash, { mode: 'custom', file, source: 'upload', at: Date.now() });
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
          await withScanSlot(() => copyFromMedia(full, dest));
        } catch (err) {
          return json(res, 404, { error: 'copy-failed', message: `读不到该文件：${err.message}` }), true;
        }
        const s = await stat(full).catch(() => ({ size: 0 }));
        if (s.size > 160 * 1024) await shrink(dest);
        await removeCustom(hash);
        index.covers[hash] = withMetaCarry(hash, { mode: 'custom', file, source: 'dir', name: path.basename(full), at: Date.now() });
        persist();
        return json(res, 200, { ok: true, mode: 'custom', v: Date.now() }), true;
      }

      if (p === '/__cover/mode' && req.method === 'POST') {
        const body = JSON.parse((await readCapped(req, 8 * 1024)).toString('utf8') || '{}');
        if (!HASH_RE.test(hash)) return json(res, 400, { error: 'bad-hash' }), true;
        const mode = body.mode === 'icon' ? 'icon' : 'auto';
        await removeCustom(hash);
        if (mode === 'icon') index.covers[hash] = withMetaCarry(hash, { mode: 'icon', at: Date.now() });
        else if (Array.isArray(index.covers[hash]?.metaFiles) && index.covers[hash].metaFiles.length) {
          // 回到自动封面，但媒体目录里还有之前写进去的文件：留一条记录好让「移除」还在
          index.covers[hash] = withMetaCarry(hash, { mode: 'auto', at: Date.now() });
        } else delete index.covers[hash];
        persist();
        return json(res, 200, { ok: true, mode }), true;
      }

      /* ── TheTVDB 刮削 ───────────────────────────────── */

      // 状态：是否配置好 / 语言 / 自动策略 + 这个种子该按什么名字去搜
      if (p === '/__cover/tvdb/status') {
        const st = tvdb.status();
        const cur = index.covers[hash];
        const seed = await seedTitle(hash);
        return json(res, 200, {
          ...st,
          // mode 用来区分「没设过封面」和「用户明确选了自定义图 / 图标」：
          // 后者不该在打开弹窗时被自动匹配覆盖掉
          mode: cur?.mode || '',
          current: cur?.mode === 'tvdb' ? { name: cur.name || '', ...(cur.meta || {}) } : null,
          metaStatus: cur?.mode === 'tvdb' ? (cur.metaStatus || 'pending') : '',
          metaMessage: cur?.mode === 'tvdb' ? (cur.metaMessage || '') : '',
          metaFiles: cur?.mode === 'tvdb' ? (cur.metaFiles || []) : [],
          parsed: seed.parsed?.title ? seed.parsed : null,
          nameFrom: seed.from,   // file = 种子里的正片文件名，torrent = 种子名兜底
          sourceName: seed.name, // 上面那个名字的原文，界面可以摊给用户看
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

      // 搜索：hash 用来自动识别片名（优先种子里的正片文件名），q 可以覆盖
      if (p === '/__cover/tvdb/search') {
        if (!tvdb.status().configured) return json(res, 400, { error: 'no-key', message: '先在设置里填上 TheTVDB API Key' }), true;
        const q = String(url.searchParams.get('q') || '').trim();
        const type = String(url.searchParams.get('type') || '');
        const year = String(url.searchParams.get('year') || '');
        const seed = q ? null : await seedTitle(hash);
        const parsed = parseTitle(q || seed?.name || '');
        // 关键词可能是「痴迷 Obsession」这种中英混排（用户直接照种子名粘的），整串搜 0 条；
        // 所以先按原词搜，没结果再拆成英文段 / 中文段接着试，别让用户自己猜着删字。
        const queries = q ? [q, ...titleVariants(q).filter((v) => v !== q)] : titleVariants(parsed.title);
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
          return json(res, 200, {
            parsed, query: used, queries, items: out.items,
            nameFrom: seed?.from || (q ? 'manual' : ''),
            sourceName: seed?.name || q,
          }), true;
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

      // 只解析片名、不联网也不耗额度：添加弹窗选好文件就要把干净片名填进关键词框，
      // 不能等 match 回来才变干净，更不能在没配 API Key 时退化成脏文件名。
      if (p === '/__cover/tvdb/parse') {
        const name = String(url.searchParams.get('name') || '').trim();
        if (!name) return json(res, 400, { error: 'no-name', message: '没有可用的片名' }), true;
        const parsed = parseTitle(name);
        return json(res, 200, { parsed, variants: titleVariants(parsed.title) }), true;
      }

      // 还没添加的 .torrent：直接把文件丢上来，解出里面的正片文件名。
      // 发布名常是一串堆料，而正片文件名通常干净得多，用它去搜 TVDB 更稳。
      if (p === '/__cover/tvdb/torrent' && req.method === 'POST') {
        let buf;
        try {
          buf = await readCapped(req, MAX_TORRENT);
        } catch {
          return json(res, 413, { error: 'too-large', message: '.torrent 太大了' }), true;
        }
        let t;
        try {
          t = torrentFiles(buf);
        } catch {
          return json(res, 400, { error: 'bad-torrent', message: '这不是有效的 .torrent 文件' }), true;
        }
        // 只有多文件种子才算「种子内的文件名」；单文件种子的名字就是种子名，没必要区分
        let name = t.name;
        let from = 'torrent';
        if (t.multi) {
          const file = mainVideoFrom(t.files);
          if (file && looksLikeTitle(parseTitle(file).title)) { name = file; from = 'file'; }
        }
        if (!name) return json(res, 400, { error: 'no-name', message: '从种子里没读到文件名' }), true;
        const parsed = parseTitle(name);
        return json(res, 200, { name, from, parsed, variants: titleVariants(parsed.title) }), true;
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

      // 手动把刮削结果写进媒体目录：body { hash }
      if (p === '/__cover/meta/apply' && req.method === 'POST') {
        if (!HASH_RE.test(hash)) return json(res, 400, { error: 'bad-hash' }), true;
        try {
          const out = await applyMetaToDir(hash);
          return json(res, 200, { ...out, meta: metaSummary(hash) }), true;
        } catch (err) {
          return json(res, 502, { ok: false, error: 'meta', message: err.message }), true;
        }
      }

      // 从媒体目录移除已经写过的海报 / NFO：body { hash }
      if (p === '/__cover/meta/remove' && req.method === 'POST') {
        if (!HASH_RE.test(hash)) return json(res, 400, { error: 'bad-hash' }), true;
        try {
          return json(res, 200, { ...(await removeMetaFiles(hash)), meta: metaSummary(hash) }), true;
        } catch (err) {
          return json(res, 502, { ok: false, error: 'meta', message: err.message }), true;
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
