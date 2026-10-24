#!/usr/bin/env node
/**
 * 生成 README 截图：无头 Chrome 打开演示实例，按脚本点几下再截图。
 *
 *   npm run demo            # 另开一个终端（http://127.0.0.1:7799）
 *   npm run shots           # 截图写进 docs/
 *   npm run shots -- --only cover --url http://127.0.0.1:7788
 *
 * 零依赖：浏览器控制走 Chrome DevTools Protocol，通过 Node 22 内置的 WebSocket。
 * 用 macOS 的 sips 顺手压一下宽度（没有就保持原图）。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 参数 ─────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const BASE = arg('url', process.env.SHOT_URL || 'http://127.0.0.1:7799').replace(/\/$/, '');
const ONLY = arg('only');

/* ── CDP 小客户端 ─────────────────────────────────────── */

class CDP {
  constructor(url) {
    this.url = url;
    this.seq = 0;
    this.pending = new Map();
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('CDP 连接失败')));
      ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(ev.data);
        const p = msg.id && this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else p.resolve(msg.result);
      });
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }, 30000);
    });
  }

  close() {
    try { this.ws?.close(); } catch { /* 忽略 */ }
  }
}

/* ── 浏览器 ───────────────────────────────────────────── */

function findChrome() {
  const list = [
    process.env.CHROME,
    arg('chrome'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const hit = list.find((p) => existsSync(p));
  if (!hit) throw new Error('找不到 Chrome / Chromium，请用 --chrome 指定可执行文件路径');
  return hit;
}

async function launch(chrome) {
  const profile = await mkdtemp(path.join(tmpdir(), 'qbwebui-shot-'));
  const port = 9500 + Math.floor(Math.random() * 300);
  const child = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--force-color-profile=srgb',
    '--font-render-hinting=none',
    // 容器 / CI 里 Chrome 起不了自己的沙箱；只访问本机演示实例，关掉无妨
    '--no-sandbox',
    '--disable-dev-shm-usage',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 100 && !version; i++) {
    await sleep(100);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) version = await r.json();
    } catch { /* 还没起来 */ }
  }
  if (!version) {
    child.kill('SIGKILL');
    throw new Error('Chrome 没有在 10 秒内启动调试端口');
  }

  const cdp = new CDP(version.webSocketDebuggerUrl);
  await cdp.open();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);

  return {
    cdp,
    sessionId,
    async close() {
      cdp.close();
      child.kill('SIGKILL');
      await sleep(150);
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/* ── 页面操作 ─────────────────────────────────────────── */

function makePage(browser) {
  const { cdp, sessionId } = browser;

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: `(() => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '页面脚本报错');
    }
    return r.result?.value;
  };

  const waitFor = async (expression, { timeout = 15000, label = expression } = {}) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await evaluate(`return !!(${expression});`)) return;
      await sleep(120);
    }
    throw new Error(`等待超时：${label}`);
  };

  /** 等不到就算了：封面 / 类型图标这类异步结果不该让整张图失败 */
  const waitSoft = async (expression, timeout = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await evaluate(`return !!(${expression});`)) return true;
      await sleep(120);
    }
    return false;
  };

  return {
    evaluate,
    waitFor,
    waitSoft,
    async viewport(width, height, dsf, mobile) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: dsf, mobile,
        screenWidth: width, screenHeight: height,
      }, sessionId);
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: mobile }, sessionId);
    },
    async goto(url) {
      await cdp.send('Page.navigate', { url }, sessionId);
      await sleep(300);
    },
    async theme(mode) {
      const now = await evaluate("return document.documentElement.dataset.theme || '';");
      await evaluate(`localStorage.setItem('qb.theme', ${JSON.stringify(mode)});`);
      if (now === mode) return;
      await evaluate("location.reload(); return true;");
      await sleep(400);
      await this.waitFor("document.querySelectorAll('.row').length > 0", { label: '列表渲染' });
      await this.settle(600);
    },
    async settle(ms = 700) {
      // 等缩略图解码完成，避免截到一半的图
      await evaluate(`return Promise.all(
        Array.from(document.images).filter((i) => i.src && !i.complete).map((i) => new Promise((r) => {
          i.addEventListener('load', r, { once: true });
          i.addEventListener('error', r, { once: true });
        })),
      ).then(() => true);`);
      await sleep(ms);
    },
    click(selector) {
      return evaluate(`const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('找不到元素：' + ${JSON.stringify(selector)});
        el.click(); return true;`);
    },
    async shoot(file, width) {
      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'jpeg', quality: 90, captureBeyondViewport: false,
      }, sessionId);
      const out = path.join(DOCS, file);
      await writeFile(out, Buffer.from(data, 'base64'));
      if (width) {
        spawnSync('sips', ['--resampleWidth', String(width), out], { stdio: 'ignore' });
      }
      return out;
    },
  };
}

/* ── 截图清单 ─────────────────────────────────────────── */

const rowByName = (name) => `
  const row = Array.from(document.querySelectorAll('.row')).find((r) =>
    (r.querySelector('.t-name')?.textContent || '').includes(${JSON.stringify(name)}));
  if (!row) throw new Error('列表里没有：' + ${JSON.stringify(name)});
  row.scrollIntoView({ block: 'center' });
  row.click(); return true;`;

const SHOTS = [
  {
    file: 'desktop-light.jpg',
    width: 1440, height: 900, dsf: 2, out: 1600, theme: 'light',
    ready: "document.querySelectorAll('.row').length > 5",
    async run(page) {
      await page.evaluate("document.querySelector('.list-scroll').scrollTop = 0; return true;");
    },
  },
  {
    file: 'desktop-dark.jpg',
    width: 1440, height: 900, dsf: 2, out: 1600, theme: 'dark',
    ready: "document.querySelectorAll('.row').length > 5",
    async run(page) {
      await page.evaluate("document.querySelector('.list-scroll').scrollTop = 0; return true;");
    },
  },
  {
    file: 'detail.jpg',
    width: 1440, height: 900, dsf: 2, out: 1600, theme: 'light',
    ready: "document.querySelectorAll('.row').length > 5",
    async run(page) {
      await page.evaluate(rowByName('Big Buck Bunny'));
      await page.waitFor("document.querySelector('#detail.is-open') && document.querySelector('#detailBody [data-media]')", { label: '详情文件列表' });
      await page.settle(900);
    },
  },
  {
    file: 'preview.jpg',
    width: 1080, height: 675, dsf: 2, out: 1080, theme: 'dark',
    ready: "document.querySelectorAll('.row').length > 5",
    async run(page) {
      await page.evaluate(rowByName('国风写真'));
      await page.waitFor("document.querySelector('#detailBody [data-media]')", { label: '详情文件列表' });
      await page.click('#detailBody [data-media]');
      await page.waitFor("document.querySelector('.media-viewer img')?.complete", { label: '图片加载' });
      await page.settle(700);
    },
  },
  {
    file: 'cover.jpg',
    width: 1080, height: 675, dsf: 2, out: 1080, theme: 'light',
    ready: "document.querySelectorAll('.row').length > 5",
    async run(page) {
      await page.evaluate(`const row = Array.from(document.querySelectorAll('.row')).find((r) =>
          (r.querySelector('.t-name')?.textContent || '').includes('国风写真'));
        if (!row) throw new Error('列表里没有国风写真');
        row.querySelector('.thumb').click(); return true;`);
      await page.waitFor("!document.querySelector('#coverModal').hidden && document.querySelector('#coverGrid img')", { label: '封面弹窗' });
      await page.settle(800);
    },
  },
  {
    file: 'tvdb.jpg',
    width: 1080, height: 675, dsf: 2, out: 1080, theme: 'light',
    ready: "document.querySelectorAll('.row').length > 5",
    async run(page) {
      await page.evaluate(`const row = Array.from(document.querySelectorAll('.row')).find((r) =>
          (r.querySelector('.t-name')?.textContent || '').includes('Big Buck Bunny'));
        if (!row) throw new Error('列表里没有 Big Buck Bunny');
        row.querySelector('.thumb').click(); return true;`);
      await page.waitFor("!document.querySelector('#coverModal').hidden", { label: '封面弹窗' });
      // 搜索 → 点第一张候选 → 展开它的全部海报
      await page.click('#tvdbSearch');
      await page.waitFor("document.querySelector('#tvdbGrid .tvdb-item[data-id]')", { timeout: 25000, label: 'TVDB 候选' });
      await page.click('#tvdbGrid .tvdb-item[data-id]');
      await page.waitFor("document.querySelectorAll('#tvdbGrid .tvdb-item[data-image]').length >= 2", { timeout: 25000, label: 'TVDB 海报' });
      // 海报行在最下面，稍微把弹窗内容滚到底，别让最后一行被裁掉
      await page.evaluate("document.querySelector('#tvdbGrid').scrollIntoView({ block: 'end' }); return true;");
      await page.settle(1200);
    },
  },
  {
    file: 'mobile.jpg',
    width: 390, height: 844, dsf: 2, out: 780, theme: 'light', mobile: true,
    ready: "document.querySelectorAll('.row').length > 4",
    async run(page) {
      await page.evaluate("document.querySelector('.list-scroll').scrollTop = 0; return true;");
    },
  },
  {
    file: 'mobile-settings.jpg',
    width: 390, height: 844, dsf: 2, out: 780, theme: 'light', mobile: true,
    ready: "document.querySelectorAll('.row').length > 4",
    async run(page) {
      await page.click('[data-mnav="settings"]');
      await page.waitFor("!document.querySelector('#settingsModal').hidden", { label: '设置抽屉' });
      await page.evaluate("document.querySelector('#settingsModal .modal-body').scrollTop = 0; return true;");
      await page.settle(700);
    },
  },
];

/* ── 主流程 ───────────────────────────────────────────── */

const main = async () => {
  const probe = await fetch(BASE).catch(() => null);
  if (!probe?.ok) throw new Error(`打不开 ${BASE}，先跑 npm run demo`);

  const chrome = findChrome();
  console.log(`Chrome  ${chrome}`);
  console.log(`目标    ${BASE}\n`);

  const browser = await launch(chrome);
  const page = makePage(browser);

  try {
    for (const shot of SHOTS) {
      if (ONLY && !shot.file.includes(ONLY)) continue;
      const t0 = Date.now();
      await page.viewport(shot.width, shot.height, shot.dsf, !!shot.mobile);
      await page.goto(`${BASE}/?shot=${Date.now()}`);
      await page.waitFor(shot.ready, { label: shot.file });
      await page.theme(shot.theme);
      // 缩略图和类型图标是异步问服务端要的，等它们落地再截
      await page.waitSoft("document.querySelectorAll('.thumb.has-img').length >= 4", 9000);
      await page.settle(900);
      if (shot.run) await shot.run(page);
      const out = await page.shoot(shot.file, shot.out);
      console.log(`✓ ${path.relative(ROOT, out).padEnd(24)} ${Math.round((Date.now() - t0) / 100) / 10}s`);
      // 收尾：关掉弹窗 / 预览，别带到下一张
      await page.evaluate("localStorage.removeItem('qb.theme'); document.querySelectorAll('.modal').forEach((m) => (m.hidden = true)); return true;").catch(() => {});
    }
  } finally {
    await browser.close();
  }
};

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
