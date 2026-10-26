#!/usr/bin/env node
/**
 * 媒体盘文件子进程 —— 预览（图片 / 视频 / 音频）用的。
 *
 * 为什么必须单开一个进程：外置盘休眠、掉速、权限不足时，open() 会在内核里
 * 无限等待，而且**无法被中断**。这种调用只要落进服务自己的 libuv 线程池，
 * 那个线程就再也回不来；看视频时浏览器会连发好几个 Range 请求，几下就能把
 * 8 个线程全占满 —— 表现就是「进程还在、端口还在听，但一个响应都发不出去」，
 * 然后被看门狗判死。2026-10-26 18:40 那次崩溃就是这么来的。
 *
 * 所以媒体盘上的 stat 和 read 全部在这里做，服务只负责转发字节：
 * 卡住就整只掐掉这个子进程，服务自身毫发无损。
 *
 * 用法：
 *   node mediaworker.mjs first  '["/a.jpg","/a.jpg.part"]'   → {"full":"/a.jpg","size":123} | null
 *   node mediaworker.mjs stream /a.mp4 0 1048575              → 从 start 到 end（含）的字节
 *   node mediaworker.mjs stream /a.mp4 0 ''                   → 从 start 到文件末尾
 */

import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

const [mode, ...rest] = process.argv.slice(2);

function out(text) {
  process.stdout.write(text);
}

/**
 * 等 stdout 真的把已写的内容送出去。
 * 管道写是异步的，进程退出那一刻还没 flush 的数据会直接丢。
 */
function flush() {
  return new Promise((resolve) => {
    if (!process.stdout.writableNeedDrain) return process.stdout.write('', resolve);
    process.stdout.once('drain', () => process.stdout.write('', resolve));
  });
}

async function first() {
  let list = [];
  try {
    list = JSON.parse(rest[0] || '[]');
  } catch { /* 参数坏了就当没有 */ }
  for (const p of Array.isArray(list) ? list : []) {
    if (typeof p !== 'string' || !p) continue;
    try {
      const s = await stat(p);
      if (s.isFile()) {
        out(JSON.stringify({ full: p, size: s.size }));
        // 这里**不能**用 process.exit()：stdout 接的是管道，写是异步的，
        // 硬退出会把还没 flush 的 JSON 丢掉，父进程解析失败 → 明明存在的文件
        // 被当成「没找到」，表现就是随机的 404 / 破图。写完等 flush 再自然退出。
        await flush();
        return;
      }
    } catch { /* 试下一个 */ }
  }
  out('null');
  await flush();
}

async function stream() {
  const file = rest[0];
  const start = Number(rest[1] || 0) || 0;
  const endArg = rest[2];
  const opts = { start };
  if (endArg !== '' && endArg != null) opts.end = Number(endArg);

  const rs = createReadStream(file, opts);
  // SIGKILL 由父进程发；SIGTERM 时先别急着退出，把已读的字节吐干净
  process.on('SIGTERM', () => rs.destroy());
  try {
    await pipeline(rs, process.stdout);
  } catch {
    process.exit(1); // 父进程已经走了（EPIPE）或读失败，直接退
  }
}

if (mode === 'first') await first();
else if (mode === 'stream') await stream();
else {
  process.stderr.write('usage: mediaworker.mjs first <json> | stream <file> [start] [end]\n');
  process.exit(2);
}
