#!/usr/bin/env node
/**
 * 演示模式：同时拉起「假 qBittorrent」和本服务，用虚构数据预览界面
 *
 *   npm run demo            # http://127.0.0.1:7799
 *   QB_MOCK_PORT=9899 PORT=7799 node tools/demo.mjs
 *
 * 不需要本机安装 qBittorrent，也不会读写任何真实配置。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK_PORT = Number(process.env.QB_MOCK_PORT || 9899);
const PORT = Number(process.env.PORT || 7799);
const node = process.execPath;

const children = [];
const run = (script, args, env) => {
  const child = spawn(node, [script, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  children.push(child);
  return child;
};

const shutdown = () => {
  for (const c of children) if (!c.killed) c.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

run(path.join(ROOT, 'tools', 'mock-qb.mjs'), [String(MOCK_PORT)]);

setTimeout(() => {
  const app = run(path.join(ROOT, 'server.mjs'), [], {
    QB_URL: `http://127.0.0.1:${MOCK_PORT}`,
    PORT: String(PORT),
  });
  app.on('exit', (code) => {
    shutdown();
    process.exit(code ?? 0);
  });
  console.log('');
  console.log(`  演示模式（虚构数据）  http://127.0.0.1:${PORT}`);
  console.log('  Ctrl+C 结束');
}, 300);
