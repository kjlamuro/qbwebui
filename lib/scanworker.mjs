#!/usr/bin/env node
/**
 * 媒体盘子进程：扫目录 / 找正片
 *
 * 为什么单独一个进程：外置盘休眠 / 掉速时，readdir 的 open() 会永久阻塞在内核里，
 * 而且没有任何超时机制能打断它。这种调用一旦落进 libuv 线程池，那个 worker 线程
 * 就再也回不来；攒够几个，进程还在、端口还听着，但页面一个都打不开（2026-10-26
 * 06:32 / 06:58 两次事故就是这个形状）。
 *
 * 放到子进程里之后，卡住只卡这个子进程，父进程超时直接掐掉它，线程池毫发无损。
 *
 * 用法（父进程调用，不面向人）：
 *   node lib/scanworker.mjs scan  <目录> [maxDepth]
 *   node lib/scanworker.mjs video <目录> [maxDepth]
 * 输出：一行 JSON
 *   scan  → { images: [...], kind, weights }
 *   video → { video: '最大的视频文件绝对路径' | null }
 */

import { biggestVideoDirect, scanDirDirect } from './covers.mjs';

const [, , mode, dir, depth] = process.argv;

if (!mode || !dir) {
  console.error('usage: scanworker.mjs <scan|video> <dir> [maxDepth]');
  process.exit(2);
}

try {
  if (mode === 'video') {
    const video = await biggestVideoDirect(dir, Number(depth) || 2);
    process.stdout.write(JSON.stringify({ video }));
  } else {
    const out = await scanDirDirect(dir, Number(depth) || 2);
    process.stdout.write(JSON.stringify(out));
  }
} catch (err) {
  console.error(`scan failed: ${err && err.message ? err.message : err}`);
  process.exit(1);
}
