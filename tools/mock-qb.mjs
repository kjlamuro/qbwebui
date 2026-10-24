#!/usr/bin/env node
/**
 * 假 qBittorrent —— 用于演示 / 截图 / 无种子环境下的前端开发
 *
 *   node tools/mock-qb.mjs 9899
 *   QB_URL=http://127.0.0.1:9899 PORT=7799 node server.mjs
 *
 * 只实现界面会用到的接口，数据全是虚构的，任何写操作都只返回 Ok. 不落盘。
 */

import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2] || 9899);

const GiB = 1024 ** 3;
const MB = 1024 ** 2;
const now = Math.floor(Date.now() / 1000);

/** @type {any[]} */
const torrents = [
  {
    hash: 'a1'.repeat(20), name: 'ubuntu-24.04.1-desktop-amd64.iso', category: '系统镜像', tags: 'iso, linux',
    size: 5.9 * GiB, progress: 0.684, dlspeed: 12.9 * MB, upspeed: 0.86 * MB,
    num_seeds: 34, num_complete: 218, num_leechs: 12, num_incomplete: 41,
    state: 'downloading', eta: 148, added_on: now - 3600, completion_on: -1, time_active: 3600, seeding_time: 0,
    downloaded: 3.9 * GiB, uploaded: 0.41 * GiB, save_path: '/downloads/iso',
  },
  {
    hash: 'b2'.repeat(20), name: 'debian-12.7.0-amd64-netinst.iso', category: '系统镜像', tags: 'iso, linux',
    size: 0.63 * GiB, progress: 1, dlspeed: 0, upspeed: 2.4 * MB,
    num_seeds: 12, num_complete: 96, num_leechs: 3, num_incomplete: 8,
    state: 'uploading', eta: 8640000, added_on: now - 86400 * 6, completion_on: now - 86400 * 6 + 900,
    time_active: 86400 * 6, seeding_time: 86400 * 6, downloaded: 0.63 * GiB, uploaded: 2.15 * GiB,
    save_path: '/downloads/iso',
  },
  {
    hash: 'c3'.repeat(20), name: 'archlinux-2024.10.01-x86_64.iso', category: '系统镜像', tags: 'iso, linux',
    size: 1.15 * GiB, progress: 0.231, dlspeed: 6.8 * MB, upspeed: 0.34 * MB,
    num_seeds: 41, num_complete: 302, num_leechs: 22, num_incomplete: 60,
    state: 'downloading', eta: 132, added_on: now - 600, completion_on: -1, time_active: 600, seeding_time: 0,
    downloaded: 0.27 * GiB, uploaded: 0.02 * GiB, save_path: '/downloads/iso',
  },
  {
    hash: 'd4'.repeat(20), name: 'Fedora-Workstation-Live-41-1.4.x86_64.iso', category: '系统镜像', tags: 'iso',
    size: 2.1 * GiB, progress: 0, dlspeed: 0, upspeed: 0,
    num_seeds: 0, num_complete: 154, num_leechs: 0, num_incomplete: 30,
    state: 'queuedDL', eta: 8640000, added_on: now - 120, completion_on: -1, time_active: 0, seeding_time: 0,
    downloaded: 0, uploaded: 0, save_path: '/downloads/iso',
  },
  {
    hash: 'e5'.repeat(20), name: 'linuxmint-22-cinnamon-64bit.iso', category: '系统镜像', tags: 'iso, linux',
    size: 2.8 * GiB, progress: 1, dlspeed: 0, upspeed: 0,
    num_seeds: 0, num_complete: 88, num_leechs: 0, num_incomplete: 4,
    state: 'stalledUP', eta: 8640000, added_on: now - 86400 * 12, completion_on: now - 86400 * 12 + 2400,
    time_active: 86400 * 12, seeding_time: 86400 * 11, downloaded: 2.8 * GiB, uploaded: 5.9 * GiB,
    save_path: '/downloads/iso',
  },
  {
    hash: 'f6'.repeat(20), name: 'openSUSE-Leap-15.6-DVD-x86_64.iso', category: '系统镜像', tags: 'iso',
    size: 4.3 * GiB, progress: 1, dlspeed: 0, upspeed: 0,
    num_seeds: 0, num_complete: 60, num_leechs: 0, num_incomplete: 2,
    state: 'stoppedUP', eta: 8640000, added_on: now - 86400 * 20, completion_on: now - 86400 * 20 + 3600,
    time_active: 86400 * 20, seeding_time: 3600, downloaded: 4.3 * GiB, uploaded: 1.2 * GiB,
    save_path: '/downloads/iso',
  },
  {
    hash: '17'.repeat(20), name: 'Blender Open Movies Collection 2160p', category: '影视', tags: '4K, openmovie',
    size: 48.2 * GiB, progress: 0.912, dlspeed: 3.2 * MB, upspeed: 1.1 * MB,
    num_seeds: 18, num_complete: 143, num_leechs: 9, num_incomplete: 21,
    state: 'downloading', eta: 1380, added_on: now - 86400, completion_on: -1, time_active: 86400, seeding_time: 0,
    downloaded: 44 * GiB, uploaded: 3.4 * GiB, save_path: '/downloads/media',
  },
  {
    hash: '28'.repeat(20), name: 'Big Buck Bunny 2160p 60fps', category: '影视', tags: '4K',
    size: 7.6 * GiB, progress: 1, dlspeed: 0, upspeed: 4.8 * MB,
    num_seeds: 6, num_complete: 512, num_leechs: 14, num_incomplete: 26,
    state: 'uploading', eta: 8640000, added_on: now - 86400 * 30, completion_on: now - 86400 * 30 + 5400,
    time_active: 86400 * 30, seeding_time: 86400 * 29, downloaded: 7.6 * GiB, uploaded: 97.3 * GiB,
    save_path: '/downloads/media',
  },
  {
    hash: '39'.repeat(20), name: 'nextcloud-30.0.1.zip', category: '软件', tags: 'backup',
    size: 0.21 * GiB, progress: 1, dlspeed: 0, upspeed: 0.62 * MB,
    num_seeds: 2, num_complete: 33, num_leechs: 1, num_incomplete: 3,
    state: 'uploading', eta: 8640000, added_on: now - 86400 * 3, completion_on: now - 86400 * 3 + 600,
    time_active: 86400 * 3, seeding_time: 86400 * 3, downloaded: 0.21 * GiB, uploaded: 0.38 * GiB,
    save_path: '/downloads/apps',
  },
  {
    hash: '4a'.repeat(20), name: '2024-10-22-raspios-bookworm-arm64.img.xz', category: '系统镜像', tags: 'iso, arm',
    size: 1.2 * GiB, progress: 1, dlspeed: 0, upspeed: 0,
    num_seeds: 0, num_complete: 120, num_leechs: 0, num_incomplete: 1,
    state: 'stoppedUP', eta: 8640000, added_on: now - 86400 * 9, completion_on: now - 86400 * 9 + 1200,
    time_active: 86400 * 9, seeding_time: 7200, downloaded: 1.2 * GiB, uploaded: 2.4 * GiB,
    save_path: '/downloads/iso',
  },
  {
    hash: '5b'.repeat(20), name: 'proxmox-ve_8.2-1.iso', category: '', tags: '',
    size: 1.3 * GiB, progress: 0.43, dlspeed: 0, upspeed: 0,
    num_seeds: 0, num_complete: 40, num_leechs: 0, num_incomplete: 9,
    state: 'stalledDL', eta: 8640000, added_on: now - 7200, completion_on: -1, time_active: 7200, seeding_time: 0,
    downloaded: 0.56 * GiB, uploaded: 0.01 * GiB, save_path: '/downloads',
  },
  {
    hash: '7d'.repeat(20), name: 'Kind of Blue · Miles Davis [FLAC 24-192]', category: '音乐', tags: 'flac, jazz',
    size: 1.8 * GiB, progress: 1, dlspeed: 0, upspeed: 0.18 * MB,
    num_seeds: 5, num_complete: 74, num_leechs: 2, num_incomplete: 6,
    state: 'uploading', eta: 8640000, added_on: now - 86400 * 4, completion_on: now - 86400 * 4 + 1800,
    time_active: 86400 * 4, seeding_time: 86400 * 4, downloaded: 1.8 * GiB, uploaded: 0.9 * GiB,
    save_path: '/downloads/media',
  },
  {
    hash: '8e'.repeat(20), name: 'Clean Code 中文版 (Robert C. Martin).pdf', category: '书籍', tags: 'pdf, 编程',
    size: 0.02 * GiB, progress: 1, dlspeed: 0, upspeed: 0,
    num_seeds: 3, num_complete: 41, num_leechs: 0, num_incomplete: 2,
    state: 'stoppedUP', eta: 8640000, added_on: now - 86400 * 40, completion_on: now - 86400 * 40 + 300,
    time_active: 300, seeding_time: 0, downloaded: 0.02 * GiB, uploaded: 0.06 * GiB,
    save_path: '/downloads/books',
  },
  {
    hash: '6c'.repeat(20), name: 'LibreOffice_24.8.2_macOS_aarch64.dmg', category: '软件', tags: '',
    size: 0.33 * GiB, progress: 0.35, dlspeed: 0, upspeed: 0,
    num_seeds: 0, num_complete: 12, num_leechs: 0, num_incomplete: 0,
    state: 'error', eta: 8640000, added_on: now - 86400 * 2, completion_on: -1, time_active: 3600, seeding_time: 0,
    downloaded: 0.11 * GiB, uploaded: 0, save_path: '/downloads/apps',
  },
  {
    hash: '9a'.repeat(20), name: '国风写真 · 林星阑 [19P]', category: '图片', tags: '写真, 4K',
    size: 0.86 * GiB, progress: 1, dlspeed: 0, upspeed: 0.62 * MB,
    num_seeds: 3, num_complete: 64, num_leechs: 0, num_incomplete: 5,
    state: 'uploading', eta: 8640000, added_on: now - 86400 * 4, completion_on: now - 86400 * 4 + 720,
    time_active: 86400 * 4, seeding_time: 86400 * 3, downloaded: 0.86 * GiB, uploaded: 1.2 * GiB,
    save_path: '/downloads/photos',
  },
];

// 补齐 /torrents/info 需要的其余字段
const normalize = (t) => Object.assign(t, {
    amount_left: t.size * (1 - t.progress),
    auto_tmm: false,
    availability: 1 + (t.num_seeds || 0) / 10,
    completed: t.size * t.progress,
    content_path: `${t.save_path}/${t.name}`,
    dl_limit: -1,
    up_limit: -1,
    downloaded_session: t.downloaded,
    uploaded_session: t.uploaded,
    ratio: t.downloaded ? t.uploaded / t.downloaded : 0,
    ratio_limit: -2,
    seeding_time_limit: -2,
    max_ratio: -1,
    max_seeding_time: -1,
    f_l_piece_prio: false,
    force_start: false,
    seq_dl: false,
    super_seeding: false,
    priority: 1,
    last_activity: Math.floor(Date.now() / 1000) - 20,
    seen_complete: t.completion_on > 0 ? t.completion_on : -1,
    magnet_uri: `magnet:?xt=urn:btih:${t.hash}`,
    tracker: 'https://tracker.example.org/announce',
    trackers_count: 3,
    total_size: t.size,
    save_path: t.save_path,
  });
torrents.forEach(normalize);

const sum = (fn) => torrents.reduce((a, t) => a + fn(t), 0);

const serverState = () => ({
  alltime_dl: 3.42e12,
  alltime_ul: 12.1e12,
  average_time_queue: 0,
  connection_status: 'connected',
  dht_nodes: 412,
  dl_info_data: 184.2e9,
  dl_info_speed: sum((t) => t.dlspeed),
  dl_rate_limit: 0,
  free_space_on_disk: 2.01e12,
  global_ratio: '3.56',
  queued_io_jobs: 0,
  queueing: true,
  read_cache_hits: '98.2',
  read_cache_overload: '0',
  refresh_interval: 1500,
  total_buffers_size: 0,
  total_peer_connections: sum((t) => t.num_leechs + t.num_seeds),
  total_queued_size: 0,
  total_wasted_session: 12.4e6,
  up_info_data: 402.7e9,
  up_info_speed: sum((t) => t.upspeed),
  up_rate_limit: 0,
  use_alt_speed_limits: false,
  write_cache_overload: '0',
});

const properties = (t) => ({
  addition_date: t.added_on,
  comment: 'Demo data — qBWebUI mock server',
  completion_date: t.completion_on,
  created_by: 'qBWebUI mock',
  dl_limit: -1,
  dl_speed: t.dlspeed,
  dl_speed_avg: t.dlspeed * 0.92,
  download_path: t.save_path,
  eta: t.eta,
  hash: t.hash,
  infohash_v1: t.hash,
  isPrivate: false,
  last_seen: now - 20,
  name: t.name,
  nb_connections: t.num_seeds + t.num_leechs,
  nb_connections_limit: 100,
  peers: t.num_leechs,
  peers_total: t.num_incomplete,
  piece_size: 4 * MB,
  pieces_have: Math.round(t.progress * (t.size / (4 * MB))),
  pieces_num: Math.round(t.size / (4 * MB)),
  reannounce: 1800,
  save_path: t.save_path,
  seeding_time: t.seeding_time,
  seeds: t.num_seeds,
  seeds_total: t.num_complete,
  share_ratio: t.ratio,
  time_elapsed: t.time_active,
  total_downloaded: t.downloaded,
  total_downloads: t.downloaded,
  total_size: t.size,
  total_uploaded: t.uploaded,
  total_uploaded_session: t.uploaded,
  total_wasted: t.size * 0.004,
  up_limit: -1,
  up_speed: t.upspeed,
  up_speed_avg: t.upspeed * 0.85,
});

/** hash -> [{ name, size }]，由 buildMedia() 按真实落盘文件生成，
    让 /torrents/files 返回的名字和磁盘一一对应（预览就是靠它定位文件） */
const MEDIA_FILES = new Map();

const files = (t) => {
  const list = MEDIA_FILES.get(t.hash);
  if (!list?.length) {
    // 演示里临时添加的种子没有真实文件；给它一条主文件，预览会 404，属预期
    const ext = path.extname(t.name) ? '' : `.${mainFileExt(t)}`;
    return [{
      index: 0,
      name: `${t.name}${ext}`,
      size: Math.max(1, Math.round(t.size)),
      progress: t.progress || 0,
      priority: 1,
      is_seed: t.progress >= 1,
      piece_range: [0, 0],
    }];
  }
  // 按体积顺序「填」进度：前面的文件下完了、中间那个下到一半、后面的还没开始。
  // 真实 qBittorrent 也是这样，界面上未完成的文件会显示得更淡。
  const total = list.reduce((a, f) => a + f.size, 0) || 1;
  let acc = 0;
  return list.map((f, i) => {
    const start = acc / total;
    acc += f.size;
    const end = acc / total;
    const span = end - start || 1;
    const fileProgress = t.progress >= 1 ? 1 : Math.min(1, Math.max(0, (t.progress - start) / span));
    return {
      index: i,
      name: f.name,
      size: Math.max(1, Math.round(f.size)),
      progress: Number(fileProgress.toFixed(4)),
      priority: 1,
      is_seed: t.progress >= 1,
      piece_range: [0, 10],
    };
  });
};

const trackers = () => [
  {
    url: 'https://tracker.example.org/announce', status: 2, tier: 0, num_peers: 26, num_seeds: 34,
    num_leeches: 12, num_downloaded: 5120, msg: '', next_announce: 1200,
  },
  {
    url: 'udp://open.example.net:6969/announce', status: 2, tier: 1, num_peers: 8, num_seeds: 12,
    num_leeches: 3, num_downloaded: 980, msg: '', next_announce: 1500,
  },
  {
    url: '** [DHT] **', status: 2, tier: 2, num_peers: 140, num_seeds: 0, num_leeches: 0,
    num_downloaded: 0, msg: '', next_announce: 0,
  },
];

const categories = {
  系统镜像: { name: '系统镜像', savePath: '/downloads/iso' },
  影视: { name: '影视', savePath: '/downloads/media' },
  音乐: { name: '音乐', savePath: '/downloads/media' },
  书籍: { name: '书籍', savePath: '/downloads/books' },
  软件: { name: '软件', savePath: '/downloads/apps' },
  图片: { name: '图片', savePath: '/downloads/photos' },
};

const json = (res, data, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
};

/* ── 演示封面 ────────────────────────────────────────────
   设了 MOCK_MEDIA_DIR 就给每个种子造一个真实目录 + 几张 SVG 图，
   这样 /__cover 的「目录图片兜底」和封面弹窗才有东西可看。      */
const MEDIA_DIR = process.env.MOCK_MEDIA_DIR || '';

const PALETTES = [
  ['#3b82f6', '#8b5cf6'], ['#f97316', '#ef4444'], ['#10b981', '#0ea5e9'],
  ['#f59e0b', '#d946ef'], ['#0ea5e9', '#22d3ee'], ['#84cc16', '#14b8a6'],
];

function posterSvg(title, sub, i) {
  const [a, b] = PALETTES[i % PALETTES.length];
  const dots = Array.from({ length: 26 }, (_, k) => {
    const x = ((k * 97) % 400) + 10;
    const y = ((k * 53) % 600) + 10;
    const r = ((k % 4) + 1) * 1.6;
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff" opacity="0.16"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/>
    </linearGradient>
  </defs>
  <rect width="400" height="600" fill="url(#g)"/>
  ${dots}
  <rect x="26" y="26" width="348" height="548" rx="18" fill="none" stroke="#fff" stroke-opacity="0.35" stroke-width="2"/>
  <text x="200" y="270" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="30" font-weight="700" fill="#fff">${title}</text>
  <text x="200" y="308" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="17" fill="#fff" fill-opacity="0.86">${sub}</text>
  <text x="200" y="560" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="13" fill="#fff" fill-opacity="0.6">qBWebUI demo artwork</text>
</svg>`;
}

/* 按分类给演示种子造一个「像真的」主文件：体积远大于海报，
   这样 /__cover 的类型判定（按体积权重）才能测出 video / audio / book 的差别 */
const KIND_EXT_BY_CAT = { 影视: 'mkv', 音乐: 'flac', 软件: 'zip', 系统镜像: 'iso', 书籍: 'pdf', 图片: 'jpg' };

function mainFileExt(t) {
  const hit = path.extname(t.name).toLowerCase();
  if (hit && hit !== '.') return hit.slice(1);
  return KIND_EXT_BY_CAT[t.category] || 'mkv';
}

/** 文件 / 目录名里不能出现的字符，替换掉；同时去掉首尾的点 */
const safeName = (name) => String(name).replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+|\.+$/g, '') || 'demo';

const SAMPLE_VIDEO = fileURLToPath(new URL('./assets/demo.mp4', import.meta.url));

const EXTRA_FILES = [
  ['SHA256SUMS', 1214],
  ['README.txt', 3480],
  ['torrent/announce.txt', 618],
  ['torrent/verify.sh', 8220],
];

/**
 * 在 MOCK_MEDIA_DIR 里造出和 /torrents/files 完全一致的真实文件：
 * - 多文件种子带「种子目录/文件」的路径（qBittorrent 的 name 就是以 save_path 为根的）
 * - 影视主文件用 tools/assets/demo.mp4，演示视频预览真的能播
 * - 图片种子造 19 张 SVG，演示上一张 / 下一张浏览
 * - 其余种子用占位文件撑出体积权重，供封面类型判定
 */
function buildMedia() {
  rmSync(MEDIA_DIR, { recursive: true, force: true });
  mkdirSync(MEDIA_DIR, { recursive: true });
  const filler = Buffer.alloc(256 * 1024, 0x20); // 占位内容，只为让体积权重成立
  // 这个目录是演示用的，示例视频缺失时退回占位文件，不影响其它接口
  const writeVideo = (file) => {
    try {
      copyFileSync(SAMPLE_VIDEO, file);
    } catch {
      writeFileSync(file, filler);
    }
  };

  torrents.forEach((t, i) => {
    /** @type {{name:string,size:number}[]} */
    const list = [];
    const photos = t.category === '图片';
    const collection = /Open Movies Collection/i.test(t.name);
    // 名字自带扩展名的（iso / zip / pdf …）天然是单文件种子；没扩展名的才按奇偶拆出
    // 一部分「种子目录 + 多文件」的形态，和真实 qBittorrent 的保存结构一致
    const multi = photos || collection || (!path.extname(t.name) && i % 2 === 1);
    const extrasSize = EXTRA_FILES.reduce((a, [, size]) => a + size, 0);
    const dirName = safeName(t.name);

    const addExtras = (dir, prefix) => {
      for (const [rel, size] of EXTRA_FILES) {
        const file = path.join(dir, rel);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, Buffer.alloc(size, 0x20));
        list.push({ name: prefix + rel, size });
      }
    };
    const addArtwork = (dir, prefix) => {
      const art = [
        ['poster.svg', posterSvg(t.name.slice(0, 26), t.category || 'demo', i)],
        ['fanart.svg', posterSvg(`${t.name.slice(0, 20)} · wide`, 'fanart', i + 2)],
        ['extras/scene-01.svg', posterSvg('Scene 01', t.category || 'demo', i + 3)],
        ['extras/scene-02.svg', posterSvg('Scene 02', t.category || 'demo', i + 4)],
      ];
      for (const [rel, svg] of art) {
        const file = path.join(dir, rel);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, svg);
        list.push({ name: prefix + rel, size: Buffer.byteLength(svg) });
      }
    };

    if (multi) {
      const dir = path.join(MEDIA_DIR, dirName);
      mkdirSync(dir, { recursive: true });
      t.save_path = MEDIA_DIR;
      t.content_path = dir;
      const prefix = `${dirName}/`;

      if (photos) {
        // 19 张竖图，正好演示图片浏览的翻页 / 键盘 / 滑动
        const count = 19;
        for (let k = 1; k <= count; k++) {
          const name = `${String(k).padStart(2, '0')}.svg`;
          const svg = posterSvg(`写真 ${String(k).padStart(2, '0')}`, `demo photo set · ${k}/${count}`, i + k);
          writeFileSync(path.join(dir, name), svg);
          list.push({ name: prefix + name, size: t.size / count });
        }
      } else if (collection) {
        // 四部短片：演示多视频的「上一个 / 下一个」
        const episodes = [
          ['Disc1 - Sintel (2010) 2160p.mp4', 0.30],
          ['Disc1 - Tears of Steel (2012) 2160p.mp4', 0.24],
          ['Disc2 - Cosmos Laundromat (2015) 2160p.mp4', 0.21],
          ['Disc2 - Spring (2019) 2160p.mp4', 0.18],
        ];
        for (const [name, share] of episodes) {
          writeVideo(path.join(dir, name));
          list.push({ name: prefix + name, size: t.size * share });
        }
      } else {
        const ext = t.category === '影视' ? '.mp4' : `.${mainFileExt(t)}`;
        const mainName = `${dirName}${ext}`;
        if (ext === '.mp4') writeVideo(path.join(dir, mainName));
        else writeFileSync(path.join(dir, mainName), filler);
        list.push({ name: prefix + mainName, size: t.size - extrasSize });
      }

      addArtwork(dir, prefix);
      addExtras(dir, prefix);
    } else {
      const ext = path.extname(t.name).toLowerCase() || `.${mainFileExt(t)}`;
      const mainName = path.extname(t.name) ? t.name : `${t.name}${ext}`;
      const file = path.join(MEDIA_DIR, mainName);
      if (ext === '.mp4') writeVideo(file);
      else writeFileSync(file, filler);
      t.save_path = MEDIA_DIR;
      t.content_path = file;
      list.push({ name: mainName, size: t.size - extrasSize });
      addExtras(MEDIA_DIR, '');
    }

    MEDIA_FILES.set(t.hash, list);
  });
}

if (MEDIA_DIR) buildMedia();

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://placeholder');
  const p = url.pathname;
  const hash = url.searchParams.get('hash');

  if (p === '/api/v2/app/version') return json(res, 'v5.0.3');
  if (p === '/api/v2/app/webapiVersion') return json(res, '2.11.2');
  if (p === '/api/v2/app/preferences') {
    return json(res, {
      save_path: '/downloads',
      temp_path: '/downloads/temp',
      max_ratio_enabled: false,
      max_seeding_time_enabled: false,
      listen_port: 51413,
      dht: true,
      upnp: true,
    });
  }
  if (p === '/api/v2/torrents/info') {
    const hashes = url.searchParams.get('hashes');
    if (!hashes) return json(res, torrents);
    const want = hashes.split('|');
    return json(res, torrents.filter((t) => want.includes(t.hash)));
  }
  // 添加种子：真的往列表里塞一条，才能演示「添加时就把类型写进缓存」这条链路
  if (p === '/api/v2/torrents/add' && req.method === 'POST') {
    const buf = await readBody(req);
    const raw = buf.toString('latin1');
    const field = (name) => {
      const m = raw.match(new RegExp(`name="${name}"[\\s\\S]{0,120}?\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`));
      // multipart 里的中文是 UTF-8 字节，按 latin1 取出后再转回来
      return m ? Buffer.from(m[1].trim(), 'latin1').toString('utf8') : '';
    };
    const urls = field('urls');
    const file = (raw.match(/filename="([^"]+\.torrent)"/) || [])[1] || '';
    const category = field('category');
    const savepath = field('savepath');
    let name = '';
    if (urls) {
      const dn = /[?&]dn=([^&]+)/.exec(urls);
      name = dn ? decodeURIComponent(dn[1].replace(/\+/g, ' ')) : urls.split('\n')[0].slice(0, 60);
    } else if (file) {
      name = file.replace(/\.torrent$/i, '');
    }
    if (name) {
      const t = {
        hash: randomBytes(20).toString('hex'),
        name,
        category: category || '',
        tags: field('tags'),
        size: 4 * GiB, progress: 0, dlspeed: 0, upspeed: 0,
        num_seeds: 0, num_complete: 0, num_leechs: 0, num_incomplete: 0,
        state: 'downloading', eta: 3600, added_on: Math.floor(Date.now() / 1000),
        completion_on: -1, time_active: 0, seeding_time: 0, downloaded: 0, uploaded: 0,
        save_path: savepath || '/downloads',
      };
      normalize(t);
      t.content_path = `${t.save_path}/${name}`; // 还没落盘：目录不存在，类型只能靠文件清单判定
      torrents.unshift(t);
      console.log(`[mock-qb] 添加种子：${name}${category ? ` (${category})` : ''}`);
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('Ok.');
  }

  if (p === '/api/v2/torrents/categories') return json(res, categories);
  if (p === '/api/v2/torrents/properties') {
    const t = torrents.find((x) => x.hash === hash);
    return t ? json(res, properties(t)) : json(res, {}, 404);
  }
  if (p === '/api/v2/torrents/files') {
    const t = torrents.find((x) => x.hash === hash);
    return t ? json(res, files(t)) : json(res, [], 404);
  }
  if (p === '/api/v2/torrents/trackers') return json(res, trackers());
  if (p === '/api/v2/sync/maindata') {
    // 真实 qBittorrent 这里是增量；mock 每次全量返回，前端会合并
    return json(res, { rid: Date.now() % 100000, full_update: true, torrents: {}, server_state: serverState() });
  }
  if (p === '/api/v2/auth/login') {
    res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'SID=mock; path=/' });
    return res.end('Ok.');
  }
  if (p.startsWith('/api/v2/')) {
    // 所有写操作都假装成功
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('Ok.');
  }
  json(res, { error: 'not-found', path: p }, 404);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-qb] 假 qBittorrent 已启动: http://127.0.0.1:${PORT} (${torrents.length} 个虚构种子)`);
  if (MEDIA_DIR) console.log(`[mock-qb] 演示封面目录：${MEDIA_DIR}`);
});
