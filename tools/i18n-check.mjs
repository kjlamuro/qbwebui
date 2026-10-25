#!/usr/bin/env node
/**
 * i18n 自检：确认「代码里用到的 key」和「词典里有的 key」对得上。
 *
 *   node tools/i18n-check.mjs        # 只报问题，全部命中则退出码 0
 *   node tools/i18n-check.mjs -v     # 顺便列出所有 key
 *
 * 查三件事：
 *   1. index.html 里 data-i18n*="key" 的 key 在词典里都有；
 *   2. app.js 里 tr('…') / tr("…") 的 key 在词典里都有；
 *   3. 反过来：词典里有没有从来没被用到的 key（多半是改文案时留下的死条目）。
 *
 * 词典本身是 ES module，且模块顶层会读 navigator / localStorage，Node 里没有，
 * 所以先塞几个哑实现再动态 import。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');

// Node 21+ 自带 navigator（只读 getter），要 defineProperty 才能盖掉
Object.defineProperty(globalThis, 'navigator', {
  value: { languages: ['en'], language: 'en' },
  configurable: true,
  writable: true,
});
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const stubEl = { dataset: {}, classList: { add() {}, remove() {} }, querySelectorAll: () => [], appendChild() {} };
globalThis.document = {
  documentElement: stubEl,
  querySelectorAll: () => [],
  querySelector: () => null,
  addEventListener() {},
  readyState: 'complete',
};

const { t, getLang } = await import(path.join(ROOT, 'public/i18n.js'));

const html = await readFile(path.join(ROOT, 'public/index.html'), 'utf8');
const app = await readFile(path.join(ROOT, 'public/app.js'), 'utf8');

/* ── 1. HTML 里的 key ── */
const htmlKeys = new Set();
for (const m of html.matchAll(/data-i18n(?:-text|-html|-title|-placeholder|-aria|-data-placeholder)?="([^"]+)"/g)) {
  htmlKeys.add(m[1]);
}

/* ── 2. app.js 里字面量写死的 key ── */
const appKeys = new Set();
for (const m of app.matchAll(/\btr\(\s*'((?:[^'\\]|\\.)*)'/g)) appKeys.add(m[1].replace(/\\'/g, "'"));
for (const m of app.matchAll(/\btr\(\s*"((?:[^"\\]|\\.)*)"/g)) appKeys.add(m[1]);

/* ── 2b. 间接引用的 key ──
   STATE_MAP / KIND_META / MEDIA_LABEL / FILTERS 里的 label 是变量，
   源码里写的是 tr(s.label) / tr(meta.label) 这种，扫不出字面量，
   只能手工列一遍。以后往这几张表加中文 label，记得同步加到这儿。 */
const INDIRECT = [
  '获取元数据', '分配空间', '等待中', '排队中', '做种等待', '校验中', '恢复中', '移动中', '文件缺失', '未知',
  '全部', '视频', '音乐', '音频', '图片', '书籍', '压缩包 / 镜像', '其他', '媒体',
];

const known = new Set([...htmlKeys, ...appKeys, ...INDIRECT]);
const zhChars = /[\u4e00-\u9fa5]/;

/* getLang() 现在是 en：t(key) 若原样返回 key，说明英文词典缺这条 */
const missing = [];
for (const key of known) {
  if (t(key) === key && (zhChars.test(key) || key.startsWith('html.'))) missing.push(key);
}

/* ── 3. 反向：从没被引用的词典条目 ──
   词典是模块私有的，这里退一步用源码文本匹配：key 既不在 HTML、
   也不在 app.js 的 t('…') 字面量里，就当成可疑条目列出来。 */
const dictSource = await readFile(path.join(ROOT, 'public/i18n.js'), 'utf8');
const dictKeys = new Set();
for (const m of dictSource.matchAll(/^\s{2}'([^']+)':/gm)) dictKeys.add(m[1]);
for (const m of dictSource.matchAll(/^\s{2}([\u4e00-\u9fa5][^:']*?):/gm)) dictKeys.add(m[1].trim());

const unused = [...dictKeys].filter((k) => !known.has(k) && !app.includes(`'${k}'`));

/* ── 4. app.js 里剩下的中文字面量（人工过一眼，注释不算） ── */
const noComments = app
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
  .join('\n');
const zhLits = new Set();
for (const m of noComments.matchAll(/'([^'\n]*[\u4e00-\u9fa5][^'\n]*)'/g)) {
  if (zhChars.test(m[1])) zhLits.add(m[1]);
}
const untranslated = [...zhLits].filter((s) => !app.includes(`tr('${s.replace(/'/g, "\\'")}'`) && !app.includes(`tr('${s}'`));

console.log(`[i18n] 语言=${getLang()} · HTML key ${htmlKeys.size} · app key ${appKeys.size} · 词典 ${dictKeys.size}`);

if (missing.length) {
  console.error(`\n✗ 词典里缺少 ${missing.length} 条：`);
  for (const k of missing) console.error(`   ${k}`);
}

if (unused.length) {
  console.warn(`\n· 词典里没被引用到的 ${unused.length} 条（可能是废弃文案）：`);
  for (const k of unused) console.warn(`   ${k}`);
}

if (untranslated.length) {
  console.warn(`\n· app.js 里还有 ${untranslated.length} 条中文字面量没走 t()（注释已排除）：`);
  for (const s of untranslated.slice(0, 60)) console.warn(`   ${s}`);
  if (untranslated.length > 60) console.warn(`   …还有 ${untranslated.length - 60} 条`);
}

if (VERBOSE) {
  console.log('\n所有 key：');
  for (const k of [...known].sort()) console.log(`   ${k}`);
}

if (missing.length) process.exit(1);
console.log('\n✓ 所有 key 都有英文译文');
