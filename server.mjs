#!/usr/bin/env node
/**
 * qBWebUI — 轻量 qBittorrent 控制台
 *
 * 一个零依赖的 Node 服务：
 *   1. 托管 ./public 下的静态页面
 *   2. 把 /api/v2/* 反向代理到 qBittorrent WebUI
 *      （浏览器直连 qBittorrent 会被 CORS 挡住，代理同时负责持有 SID 会话）
 *
 * 用法:
 *   QB_URL=http://127.0.0.1:9898 PORT=7788 node server.mjs
 */

import http from 'node:http';
import { execSync } from 'node:child_process';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createCovers } from './lib/covers.mjs';
import { createSpeedLog } from './lib/speedlog.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const DATA_DIR = process.env.QBWEBUI_DATA_DIR
  ? path.resolve(ROOT, process.env.QBWEBUI_DATA_DIR)
  : path.join(ROOT, 'data');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

const config = {
  port: 7788,
  target: 'http://127.0.0.1:9898',
  // 记住的 qBittorrent 登录（「记住我」时写入）。iOS PWA 的 WebKit 会在 7 天不
  // 交互后清掉 localStorage，浏览器侧记不住密码，就让服务端记住、自动续会话。
  remember: { username: '', password: '' },
};

async function loadConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    Object.assign(config, JSON.parse(raw));
    if (Number(config.port) !== 7788) config.filePort = Number(config.port); // 记住文件里配过的端口
  } catch {
    /* 首次运行没有配置文件，用默认值 */
  }
  if (process.env.PORT) config.port = Number(process.env.PORT);
  if (process.env.QB_URL) config.target = process.env.QB_URL;
  config.target = String(config.target || '').replace(/\/+$/, '');
}

/**
 * 只落盘 target 与记住的凭据。端口不写文件——`PORT=7786 node server.mjs` 这种临时
 * 启动不该把 7786 永久记进配置；端口来自命令行/环境变量，或文件里的可选 port。
 */
async function saveConfig() {
  const data = { target: config.target, remember: config.remember };
  if (config.filePort) data.port = config.filePort;
  await writeFile(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8');
}

/** qBittorrent 的会话 cookie，由代理统一持有 */
let sid = null;

/* ── 服务端记住凭据 + 自动续会话（iOS PWA 友好） ────────────── */

const remembered = () => {
  const r = config.remember || {};
  return Boolean(String(r.username || '').trim() && String(r.password || '').length);
};

let autoLogin$ = null;
let autoLoginFailAt = 0;

/** 没有 SID 时用记住的凭据静默登录一次；失败后 5 秒内不再撞 */
async function ensureSid() {
  if (sid || !remembered()) return sid;
  if (Date.now() - autoLoginFailAt < 5000) return null;
  autoLogin$ ||= (async () => {
    try {
      const body = new URLSearchParams({
        username: String(config.remember.username),
        password: String(config.remember.password),
      });
      const up = await fetch(targetUrl('/api/v2/auth/login'), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', referer: config.target + '/', origin: config.target },
        body: body.toString(),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT.api),
      });
      const cookies = typeof up.headers.getSetCookie === 'function' ? up.headers.getSetCookie() : [];
      for (const c of cookies) {
        const m = /(?:^|;\s*)SID=([^;]+)/.exec(c);
        if (m) sid = m[1];
      }
      if (!sid) autoLoginFailAt = Date.now();
      return sid;
    } catch {
      autoLoginFailAt = Date.now();
      return null;
    } finally {
      autoLogin$ = null;
    }
  })();
  return autoLogin$;
}

function targetUrl(p) {
  const u = new URL(config.target);
  const incoming = new URL(p, 'http://placeholder');
  u.pathname = incoming.pathname;
  u.search = incoming.search;
  return u.toString();
}

async function proxy(req, res, rawBody) {
  // 会话失效时先用记住的凭据续上（iOS PWA 里浏览器侧存不住密码，就靠这里）
  if (!sid) await ensureSid();
  const url = targetUrl(req.url);
  const headers = {};
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  if (req.headers.accept) headers.accept = req.headers.accept;
  // 部分 qBittorrent 开了 CSRF / Host 校验时需要，普通情况也无副作用
  headers.referer = config.target + '/';
  headers.origin = config.target;
  if (sid) headers.cookie = `SID=${sid}`;

  let upstream;
  try {
    upstream = await fetch(url, {
      method: req.method,
      headers,
      body: rawBody && rawBody.length ? rawBody : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT.proxy),
    });
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        error: 'upstream-unreachable',
        message: `无法连接 qBittorrent (${config.target})：${err.message}`,
      })
    );
    return;
  }

  // 捕获 / 刷新 SID
  const cookies = typeof upstream.headers.getSetCookie === 'function'
    ? upstream.headers.getSetCookie()
    : [upstream.headers.get('set-cookie')].filter(Boolean);
  for (const c of cookies) {
    const m = /(?:^|;\s*)SID=([^;]+)/.exec(c);
    if (m) sid = m[1] === '' ? null : m[1];
  }

  // 403 统一翻译成 401，前端据此弹出登录
  if (upstream.status === 403) {
    sid = null;
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  const outHeaders = { 'cache-control': 'no-store' };
  const ct = upstream.headers.get('content-type');
  if (ct) outHeaders['content-type'] = ct;
  const disp = upstream.headers.get('content-disposition');
  if (disp) outHeaders['content-disposition'] = disp;

  const buf = Buffer.from(await upstream.arrayBuffer());
  outHeaders['content-length'] = String(buf.length);
  res.writeHead(upstream.status, outHeaders);
  res.end(req.method === 'HEAD' ? undefined : buf);
}

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    // sw.js 绝不允许被任何一层缓存（尤其 iOS PWA 对 SW 更新检查本来就很懒）
    const noStore = urlPath.split('?')[0] === '/sw.js';
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': noStore ? 'no-store' : 'no-cache',
      'content-length': String(info.size),
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

/**
 * 上游请求一律带超时。
 *
 * 之前一处都没设：qBittorrent 只要不响应（进程卡住、端口有人 listen 却没人
 * accept），fetch 就会一直挂着，代理请求和后台采样全都永远不返回。采样用的
 * 超时必须小于采样间隔，否则每轮都会叠上一个新的挂起请求。
 */
const UPSTREAM_TIMEOUT = {
  sample: 4000, // < 采样间隔（默认 5000）
  api: 8000, // 服务端自己的接口调用
  proxy: 15000, // 转发浏览器的请求，大 payload 留余量
  short: 5000, // 注销、自检这类
};

/** 服务端自己访问 qBittorrent（本地回环通常免登录，仍带上 SID 以防万一） */
async function qbFetch(pathname) {
  const headers = { referer: config.target + '/', origin: config.target };
  if (sid) headers.cookie = `SID=${sid}`;
  const r = await fetch(config.target + pathname, {
    headers,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT.api),
  });
  if (!r.ok) throw new Error(`upstream ${r.status}`);
  return r.json();
}

const covers = createCovers({ dataDir: DATA_DIR, qbFetch, onLog: (m) => console.warn(`[cover] ${m}`) });

/* 速度采样：即使没人打开页面也一直记，历史和峰值才不会从「打开这一刻」才开始 */
const speedlog = createSpeedLog({
  dataDir: DATA_DIR,
  interval: Number(process.env.QBWEBUI_SAMPLE_MS) || 5000,
  // 会话过期时先按记住的凭据续一次，续不上就等下轮（用户登录后自动恢复）
  qbFetch: async (p) => {
    if (!sid) await ensureSid();
    return qbFetch(p);
  },
  onLog: (m) => console.warn(`[speed] ${m}`),
});

const server = http.createServer(async (req, res) => {
  const urlPath = req.url || '/';

  try {
    if (urlPath.startsWith('/__state')) {
      return json(res, 200, {
        target: config.target,
        authenticated: Boolean(sid),
        port: config.port,
        lan: lanAddresses(),
      });
    }

    if (urlPath.startsWith('/__auth') && req.method === 'POST') {
      // 记住 / 清除 qBittorrent 凭据（存服务端 config.json，浏览器清不掉）
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (body.clear) {
        config.remember = { username: '', password: '' };
      } else if (typeof body.username === 'string' && typeof body.password === 'string') {
        config.remember = { username: body.username.trim(), password: body.password };
      }
      await saveConfig();
      sid = null; // 换凭据后强制重登
      await ensureSid();
      return json(res, 200, { remembered: remembered() });
    }

    if (urlPath.startsWith('/__auth')) {
      return json(res, 200, { remembered: remembered() });
    }

    if (urlPath.startsWith('/__logout')) {
      try {
        await fetch(targetUrl('/api/v2/auth/logout'), {
          method: 'POST',
          headers: sid ? { cookie: `SID=${sid}` } : {},
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT.short),
        });
      } catch { /* 忽略 */ }
      sid = null;
      // 注销即清除记住的凭据，否则下一次请求又会被自动登录
      if (remembered()) {
        config.remember = { username: '', password: '' };
        await saveConfig();
      }
      return json(res, 200, { ok: true });
    }

    if (urlPath.startsWith('/__cover')) {
      const handled = await covers.handle(req, res, new URL(urlPath, 'http://localhost'));
      if (handled) return;
    }

    // 速度历史 / 单种子峰值（只读，给侧边栏、概览和详情页用）
    if (urlPath.startsWith('/__speed')) {
      const u = new URL(urlPath, 'http://localhost');
      if (u.pathname.startsWith('/__speed/peak')) {
        return json(res, 200, { peak: speedlog.peakOf(u.searchParams.get('hash')) });
      }
      const win = Number(u.searchParams.get('window')) || 300;
      return json(res, 200, speedlog.history(win));
    }

    if (urlPath.startsWith('/api/')) {
      const raw = req.method === 'GET' || req.method === 'HEAD' ? null : await readBody(req);
      return proxy(req, res, raw);
    }

    return serveStatic(req, res, urlPath);
  } catch (err) {
    json(res, 500, { error: 'internal', message: String(err && err.message ? err.message : err) });
  }
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function isPrivateV4(ip) {
  const p = ip.split('.').map(Number);
  if (p[0] === 10) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  return false;
}

function lanAddresses() {
  const all = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) all.push(ni.address);
    }
  }
  // 优先展示真正的局域网地址（过滤掉 VPN / 虚拟网卡）
  const local = all.filter(isPrivateV4);
  return local.length ? local : all;
}

await loadConfig();
await covers.ready();
await speedlog.ready();

if (process.argv.includes('--check')) {
  // 自检：确认上游可用后退出，供脚本使用
  try {
    const r = await fetch(config.target + '/api/v2/app/version', {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT.short),
    });
    console.log(`[qBWebUI] upstream ${config.target} -> ${r.status}`);
    process.exit(r.ok ? 0 : 1);
  } catch (err) {
    console.error(`[qBWebUI] upstream ${config.target} unreachable: ${err.message}`);
    process.exit(1);
  }
}

/** 列出占用指定端口的进程，供启动失败时直接告诉用户该关谁 */
function portOwners(port) {
  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .trim()
      .split('\n')
      .slice(1) // 跳过表头
      .map((line) => line.split(/\s+/))
      .filter((cols) => cols.length >= 2)
      .map((cols) => ({ command: cols[0], pid: cols[1] }));
  } catch {
    return []; // lsof 无结果时以非零码退出，视为查不到
  }
}

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    const port = config.port;
    const owners = portOwners(port);
    console.error('');
    console.error(`[qBWebUI] 启动失败：端口 ${port} 已被占用`);
    if (owners.length) {
      console.error('[qBWebUI] 占用该端口的进程：');
      for (const o of owners) console.error(`           PID ${o.pid}  ${o.command}`);
      console.error(`[qBWebUI] 结束它：kill ${owners[0].pid}`);
    } else {
      console.error(`[qBWebUI] 未能识别占用进程，手动查看：lsof -nP -iTCP:${port} -sTCP:LISTEN`);
    }
    console.error(`[qBWebUI] 或换个端口启动：PORT=${port + 1} node server.mjs`);
    console.error(`[qBWebUI] 也可修改 config.json 里的 "port"`);
    console.error('');
  } else if (err && err.code === 'EACCES') {
    console.error('');
    console.error(`[qBWebUI] 启动失败：没有权限绑定端口 ${config.port}`);
    console.error('[qBWebUI] 1024 以下端口需要 root，建议改用 1024 以上端口');
    console.error('');
  } else {
    console.error('[qBWebUI] 服务启动失败:', err);
  }
  process.exit(1);
});

// 兜底日志：任何未捕获异常都先落盘，避免进程无声消失后无从排查
process.on('uncaughtException', (err) => {
  console.error('[qBWebUI] 未捕获异常:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[qBWebUI] 未处理的 Promise 拒绝:', reason);
});

// 关闭终端窗口会向本进程发 SIGHUP。Node 默认直接退出且不写任何日志（曾因此出现
// 「服务无声消失」），而且 nohup 挡不住——Node 启动时会重置信号处理，把 nohup 的
// SIGHUP 忽略覆盖掉。这里显式接管，让服务在窗口关闭后继续跑。
process.on('SIGHUP', () => {
  console.log('[qBWebUI] 终端会话已结束（SIGHUP），服务继续运行。停止请用 stop.command');
});

server.listen(config.port, '0.0.0.0', () => {
  const lan = lanAddresses();
  speedlog.start();
  console.log('');
  console.log('  qBWebUI 已启动');
  console.log(`  本机   http://127.0.0.1:${config.port}`);
  for (const ip of lan) console.log(`  局域网 http://${ip}:${config.port}`);
  console.log(`  上游   ${config.target}`);
  console.log('');
});

/* ── 线程池看门狗 ──────────────────────────────────────────────
 * libuv 的线程池只有 4 个线程，所有 fs 操作共用它。外置硬盘掉速、休眠唤醒、
 * 盘符短暂失联时，一次 readdir / stat 的 open() 可能永久阻塞在内核里——这种
 * 阻塞没有超时，JS 层完全无从中断。4 个线程被占满之后，静态文件、上游代理、
 * 采样请求全部无限排队：进程还在、端口还在监听，但一个响应都发不出来。
 * （2026-10-26 06:32 那次就是这样挂的，日志里一个字都没有，最后只能 SIGKILL。）
 *
 * 这种事在应用层救不回来，能做的只有「尽快发现 → 果断退出 → 交给 launchd
 * 重启」。探针用的就是走线程池的 fs.stat，最能直接反映线程池死活。
 */
const startedAt = Date.now();
const WATCHDOG = {
  intervalMs: Number(process.env.QBWEBUI_WATCHDOG_MS ?? 5000),
  probeTimeoutMs: 3000,
  strikes: 3, // 连续 3 次（约 9 秒）都不响应才动手，避免偶发慢 IO 被误杀
  // 启动 2 分钟内不查：缓存冷的时候外置盘本来就慢
  warmupMs: Number(process.env.QBWEBUI_WATCHDOG_WARMUP_MS ?? 120000),
};

let fsStrikes = 0;

function probeThreadpool() {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), WATCHDOG.probeTimeoutMs);
    // 成功也好、ENOENT 也好，都说明线程池能干活；只有「一直不回来」才算卡死
    stat(path.join(ROOT, 'package.json')).then(
      () => { clearTimeout(timer); resolve(true); },
      () => { clearTimeout(timer); resolve(true); }
    );
  });
}

if (WATCHDOG.intervalMs > 0) {
  setInterval(async () => {
    if (Date.now() - startedAt < WATCHDOG.warmupMs) return;
    if (await probeThreadpool()) {
      fsStrikes = 0;
      return;
    }
    fsStrikes += 1;
    if (fsStrikes < WATCHDOG.strikes) {
      console.error(`[qBWebUI] 文件系统无响应（第 ${fsStrikes}/${WATCHDOG.strikes} 次），继续观察`);
      return;
    }
    console.error('');
    console.error('[qBWebUI] 线程池已被卡死：文件系统连续多次无响应，服务实际已不可用。');
    console.error('[qBWebUI] 主动退出，交给 launchd 重启（外置硬盘掉速 / 休眠唤醒常见原因）。');
    console.error('');
    // 不能用 process.exit：退出钩子里的写盘同样会卡死。SIGKILL 才能保证真的退出去。
    process.kill(process.pid, 'SIGKILL');
  }, WATCHDOG.intervalMs).unref();
}
