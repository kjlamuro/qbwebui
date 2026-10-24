/**
 * 封面管理
 *
 * 解析顺序：自定义图片（上传 / 目录中挑选） → 种子目录里自动找到的图片 → 类型图标（前端兜底）
 *
 * 图片统一缓存到 data/covers/ 下，避免每次请求都去读外置盘；macOS 上顺带用 sips
 * 把大图缩到 900px（没有 sips 就原样返回，不影响功能）。
 */

import path from 'node:path';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  mkdir, readdir, stat, copyFile, unlink, writeFile, readFile,
} from 'node:fs/promises';

const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp', '.svg']);
const HASH_RE = /^[a-f0-9]{40}$/i;
const MAX_UPLOAD = 8 * 1024 * 1024;
const MAX_SRC = 16 * 1024 * 1024;
const MAX_FILES = 4000;
// 列表缩略图只需要很小的图：自动封面压到 640px，候选图压到 320px
const AUTO_SIZE = 640;
const THUMB_SIZE = 320;
// 媒体库里约定俗成的封面文件名，优先级最高
const PREFERRED = /^(poster|folder|cover|front|fanart|thumb|banner|artwork|movie|default|season\d+-poster)\.(jpe?g|png|webp|svg)$/i;

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

const extOf = (p) => path.extname(p).toLowerCase();

export function createCovers({ dataDir, qbFetch, onLog = () => {} }) {
  const root = path.join(dataDir, 'covers');
  const dirs = {
    custom: path.join(root, 'custom'),
    auto: path.join(root, 'auto'),
    raw: path.join(root, 'raw'),
  };
  const indexPath = path.join(root, 'index.json');
  const index = { covers: {}, auto: {} };
  const torrentCache = new Map(); // hash -> { at, info }
  const dirCache = new Map();     // hash -> { at, dir, images }
  let writeChain = Promise.resolve();
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
  }

  function persist() {
    // 串行写入，避免并发请求互相覆盖
    writeChain = writeChain
      .then(() => writeFile(indexPath, JSON.stringify(index), 'utf8'))
      .catch((err) => onLog(`封面索引写入失败：${err.message}`));
    return writeChain;
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
        };
      }
    } catch { /* 上游不可用，当作没有封面 */ }
    torrentCache.set(hash, { at: Date.now(), info });
    return info;
  }

  async function torrentDir(hash) {
    const info = await torrentInfo(hash);
    if (!info) return null;
    const candidates = [info.content_path, info.save_path].filter(Boolean);
    for (const p of candidates) {
      try {
        const s = await stat(p);
        return s.isDirectory() ? p : path.dirname(p);
      } catch { /* 继续试下一个 */ }
    }
    return null;
  }

  /* ── 目录里的图片 ───────────────────────────────────── */

  // 扫目录在外置盘上不便宜，结果缓存 60s，避免每行缩略图都触发一次遍历
  async function imagesFor(hash) {
    const hit = dirCache.get(hash);
    if (hit && Date.now() - hit.at < 60_000) return hit;
    const dir = await torrentDir(hash);
    const images = dir ? await listImages(dir) : [];
    const rec = { at: Date.now(), dir: dir || '', images };
    dirCache.set(hash, rec);
    return rec;
  }

  async function listImages(dir, maxDepth = 2) {
    const out = [];
    let seen = 0;
    async function walk(current, depth) {
      if (out.length > 300 || seen > MAX_FILES) return;
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
        if (!IMG_EXT.has(extOf(ent.name))) continue;
        let s;
        try { s = await stat(full); } catch { continue; }
        if (!s.isFile() || s.size > MAX_SRC || s.size < 1024) continue;
        out.push({ path: full, name: path.relative(dir, full), base: ent.name, size: s.size, mtime: Math.round(s.mtimeMs) });
      }
      for (const d of subdirs) await walk(d, depth + 1);
    }
    await walk(dir, 1);
    // 约定文件名优先，其次大图优先
    out.sort((a, b) => {
      const pa = PREFERRED.test(a.base) ? 0 : 1;
      const pb = PREFERRED.test(b.base) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return b.size - a.size;
    });
    return out;
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
    const { images } = await imagesFor(hash);
    if (!images.length) return null;
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
        'cache-control': 'public, max-age=604800',
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
    return null;
  }

  async function removeCustom(hash) {
    const cur = index.covers[hash];
    if (cur?.file) await unlink(path.join(root, cur.file)).catch(() => {});
  }

  /* ── 路由 ───────────────────────────────────────────── */

  async function handle(req, res, url) {
    const p = url.pathname;
    if (!p.startsWith('/__cover/') && p !== '/__cover') return false;
    await ready$();
    const hash = (url.searchParams.get('hash') || '').toLowerCase();

    try {
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
        const { dir, images } = await imagesFor(hash);
        const cur = index.covers[hash];
        return json(res, 200, {
          dir: dir || '',
          mode: cur?.mode || 'auto',
          name: cur?.name || '',
          count: images.length,
          items: images.slice(0, 60).map((i) => ({ name: i.base, rel: i.name, size: i.size })),
        }), true;
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

      if (p === '/__cover/forget' && req.method === 'POST') {
        if (!HASH_RE.test(hash)) return json(res, 400, { error: 'bad-hash' }), true;
        await removeCustom(hash);
        delete index.covers[hash];
        const cached = index.auto[hash];
        if (cached?.file) await unlink(path.join(root, cached.file)).catch(() => {});
        delete index.auto[hash];
        torrentCache.delete(hash);
        dirCache.delete(hash);
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
    stats: () => ({ custom: Object.keys(index.covers).length, auto: Object.keys(index.auto).length }),
  };
}
