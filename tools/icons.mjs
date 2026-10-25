#!/usr/bin/env node
/**
 * 从 public/icon.svg 生成 PWA 图标位图。
 *
 *   npm run icons
 *
 * 为什么需要脚本：这三个位图的处理方式并不相同，手工生成极易出错。
 *
 *   1. 不能用 `--window-size=<n>` 直接截 SVG。SVG 根节点带 width/height 时，
 *      Chrome 会先按固有尺寸（512）渲染、再裁出左上角 n×n 的区域。之前
 *      icon-180.png 就是这么坏的：只剩一块纯蓝底，箭头和字母全被裁掉了。
 *      这里改成用 HTML 把 SVG 显式缩放到目标尺寸后再截，尺寸由布局决定而非裁剪。
 *   2. iOS 会自己套一层圆角遮罩，所以 apple-touch-icon 必须是**满幅不透明**的。
 *      若自带圆角且四角透明，iOS 会把透明区合成成白底，主屏上就是"蓝方块四角露白"。
 *   3. Android 的自适应图标同样会裁剪，需要 maskable 版本：背景满幅、内容收进
 *      中间安全区，否则图案边缘会被切掉。
 *
 * 排除 1 之后，manifest 里 "any" 用的 512 仍保留自绘圆角（浏览器不一定会遮），
 * 而 iOS / maskable 两份走满幅。
 */

import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync, deflateSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'public/icon.svg');

/* 直接按目标尺寸栅格化。不放大再缩：SVG 是矢量的，多一次重采样只会引入
   额外的色阶、把 PNG 撑大，并不会更清晰。 */
const SS = 1;
/* maskable 的内容安全区：Android 保证可见的是中间直径 80% 的圆，留一点余量取 76% */
const SAFE = 0.76;

const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean).find((p) => existsSync(p));

if (!CHROME) {
  console.error('找不到 Chrome / Chromium。可用 CHROME_PATH 指定可执行文件路径。');
  process.exit(1);
}

/** 去掉自绘圆角，让背景铺满画布（iOS 与 maskable 用） */
const fullBleed = (svg) => svg.replace(/rx="\d+"/, 'rx="0"');

/** 把图形收进安全区，背景仍满幅 */
const shrinkContent = (svg) => {
  const c = 256; // 画布中心
  const k = SAFE;
  return svg.replace(
    /<rect width="512"[^>]*\/>/,
    (m) => `${m}\n  <g transform="translate(${c} ${c}) scale(${k}) translate(${-c} ${-c})">`
  ).replace(/\n<\/svg>/, '\n  </g>\n</svg>');
};

async function shoot(svg, size, outPath, opaque) {
  const dir = await mkdtemp(path.join(tmpdir(), 'qbicon-'));
  const px = size * SS;
  // 显式给出 width/height，让 SVG 缩放到布局尺寸，而不是按固有尺寸绘制后被裁
  const html = `<!DOCTYPE html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent}
svg{display:block;width:${px}px;height:${px}px}</style>
${svg}`;
  await writeFile(path.join(dir, 'page.html'), html, 'utf8');

  const args = [
    '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${px},${px}`,
    `--screenshot=${path.join(dir, 'shot.png')}`,
  ];
  if (!opaque) args.unshift('--default-background-color=00000000');
  args.push(`file://${path.join(dir, 'page.html')}`);

  const r = spawnSync(CHROME, args, { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(r.stderr?.slice(-500) || '(无输出)');
    throw new Error(`截图失败：${size}px`);
  }

  // sips 负责缩放（顺带把 macOS 上 2 倍灰度细节收干净），随后自己重编码压一遍
  const tmp = path.join(dir, 'scaled.png');
  const s = spawnSync('sips', ['-z', String(size), String(size), path.join(dir, 'shot.png'), '--out', tmp], {
    encoding: 'utf8',
  });
  if (s.status !== 0) throw new Error(`sips 缩放失败：${s.stderr || ''}`);
  await writeFile(outPath, optimizePng(await readFile(tmp)));
  await rm(dir, { recursive: true, force: true });
}

/**
 * 无损重编码 PNG。
 *
 * Chrome 与 sips 输出时基本不做行过滤（filter 全 0），渐变图会因此大得离谱
 * （512 实测 123KB）。这里按行挑最优过滤再 deflate，像素数据不变，体积降到
 * 三分之一左右。只处理脚本自己产出的 8 位 RGB/RGBA 非隔行图，其余原样返回。
 */
function optimizePng(buf) {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(SIG)) return buf;

  const chunks = [];
  for (let i = 8; i < buf.length; ) {
    const len = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString('latin1');
    chunks.push({ type, data: buf.subarray(i + 8, i + 8 + len) });
    i += 12 + len;
    if (type === 'IEND') break;
  }

  const ihdr = chunks.find((c) => c.type === 'IHDR')?.data;
  if (!ihdr) return buf;
  const w = ihdr.readUInt32BE(0);
  const h = ihdr.readUInt32BE(4);
  const depth = ihdr[8];
  const colorType = ihdr[9];
  const interlace = ihdr[12];
  const ch = { 2: 3, 6: 4 }[colorType];
  if (depth !== 8 || !ch || interlace !== 0) return buf;

  const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const stride = w * ch;

  // 反过滤，还原原始像素
  const px = Buffer.alloc(stride * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const line = raw.subarray(p, p + stride);
    p += stride;
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v = (v + a) & 0xff;
      else if (f === 2) v = (v + b) & 0xff;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (f === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      cur[x] = v;
    }
  }

  // 逐行挑过滤：以"每字节按有符号计绝对值之和"作为熵的近似，取最小者
  const out = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    let best = null;
    let bestScore = Infinity;
    let bestFilter = 0;
    for (const f of [4, 1, 2, 0]) {
      const cand = Buffer.alloc(stride);
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= ch ? cur[x - ch] : 0;
        const b = prev[x];
        const c = x >= ch ? prev[x - ch] : 0;
        let v;
        if (f === 0) v = cur[x];
        else if (f === 1) v = cur[x] - a;
        else if (f === 2) v = cur[x] - b;
        else {
          const pa = Math.abs(b - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + b - 2 * c);
          v = cur[x] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
        v &= 0xff;
        cand[x] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = cand;
        bestFilter = f;
      }
    }
    out[y * (stride + 1)] = bestFilter;
    best.copy(out, y * (stride + 1) + 1);
  }

  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc32 = (b) => {
    let c = -1;
    for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const t = Buffer.from(type, 'latin1');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };

  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(out, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const svg = await readFile(SRC, 'utf8');

const JOBS = [
  // Apple：满幅不透明，圆角交给 iOS 的遮罩
  { file: 'icon-180.png', size: 180, svg: fullBleed(svg), opaque: true },
  // manifest "any"：保留自绘圆角与透明四角
  { file: 'icon-512.png', size: 512, svg, opaque: false },
  // manifest "maskable"：满幅背景 + 内容收进安全区
  { file: 'icon-512-maskable.png', size: 512, svg: shrinkContent(fullBleed(svg)), opaque: true },
];

for (const job of JOBS) {
  const out = path.join(ROOT, 'public', job.file);
  await shoot(job.svg, job.size, out, job.opaque);
  console.log(`✓ public/${job.file}  ${job.size}×${job.size}`);
}
