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
import { readFile, writeFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(ROOT, 'config.json');

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

const config = { port: 7788, target: 'http://127.0.0.1:9898' };

async function loadConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    Object.assign(config, JSON.parse(raw));
  } catch {
    /* 首次运行没有配置文件，用默认值 */
  }
  if (process.env.PORT) config.port = Number(process.env.PORT);
  if (process.env.QB_URL) config.target = process.env.QB_URL;
  config.target = String(config.target || '').replace(/\/+$/, '');
}

async function saveConfig() {
  const data = { port: config.port, target: config.target };
  await writeFile(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8');
}

/** qBittorrent 的会话 cookie，由代理统一持有 */
let sid = null;

function targetUrl(p) {
  const u = new URL(config.target);
  const incoming = new URL(p, 'http://placeholder');
  u.pathname = incoming.pathname;
  u.search = incoming.search;
  return u.toString();
}

async function proxy(req, res, rawBody) {
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
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
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

    if (urlPath.startsWith('/__config') && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (typeof body.target === 'string' && body.target.trim()) {
        const next = body.target.trim().replace(/\/+$/, '');
        try {
          const probe = new URL(next);
          if (!/^https?:$/.test(probe.protocol)) throw new Error('protocol');
        } catch {
          return json(res, 400, { error: 'bad-url', message: '请输入完整的 http(s)://地址' });
        }
        if (next !== config.target) sid = null;
        config.target = next;
        await saveConfig();
      }
      return json(res, 200, { target: config.target });
    }

    if (urlPath.startsWith('/__logout')) {
      try {
        await fetch(targetUrl('/api/v2/auth/logout'), {
          method: 'POST',
          headers: sid ? { cookie: `SID=${sid}` } : {},
        });
      } catch { /* 忽略 */ }
      sid = null;
      return json(res, 200, { ok: true });
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

if (process.argv.includes('--check')) {
  // 自检：确认上游可用后退出，供脚本使用
  try {
    const r = await fetch(config.target + '/api/v2/app/version');
    console.log(`[qBWebUI] upstream ${config.target} -> ${r.status}`);
    process.exit(r.ok ? 0 : 1);
  } catch (err) {
    console.error(`[qBWebUI] upstream ${config.target} unreachable: ${err.message}`);
    process.exit(1);
  }
}

server.listen(config.port, '0.0.0.0', () => {
  const lan = lanAddresses();
  console.log('');
  console.log('  qBWebUI 已启动');
  console.log(`  本机   http://127.0.0.1:${config.port}`);
  for (const ip of lan) console.log(`  局域网 http://${ip}:${config.port}`);
  console.log(`  上游   ${config.target}`);
  console.log('');
});
