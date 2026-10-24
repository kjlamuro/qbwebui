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
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

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
    hash: '6c'.repeat(20), name: 'LibreOffice_24.8.2_macOS_aarch64.dmg', category: '软件', tags: '',
    size: 0.33 * GiB, progress: 0.35, dlspeed: 0, upspeed: 0,
    num_seeds: 0, num_complete: 12, num_leechs: 0, num_incomplete: 0,
    state: 'error', eta: 8640000, added_on: now - 86400 * 2, completion_on: -1, time_active: 3600, seeding_time: 0,
    downloaded: 0.11 * GiB, uploaded: 0, save_path: '/downloads/apps',
  },
];

// 补齐 /torrents/info 需要的其余字段
for (const t of torrents) {
  Object.assign(t, {
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
}

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

const files = (t) => {
  const extras = [
    ['SHA256SUMS', 1214],
    ['README.txt', 3480],
    ['torrent/announce.txt', 618],
    ['torrent/verify.sh', 8220],
  ];
  const isMovie = t.size > 10 * GiB;
  const entries = isMovie
    ? [
        { name: 'Disc1 - Sintel (2010) 2160p.mkv', size: t.size * 0.30 },
        { name: 'Disc1 - Tears of Steel (2012) 2160p.mkv', size: t.size * 0.24 },
        { name: 'Disc2 - Cosmos Laundromat (2015) 2160p.mkv', size: t.size * 0.21 },
        { name: 'Disc2 - Spring (2019) 2160p.mkv', size: t.size * 0.18 },
        { name: 'poster.jpg', size: 2.1 * MB },
      ]
    : [
        { name: t.name, size: t.size - extras.reduce((a, [, size]) => a + size, 0) },
        ...extras.map(([name, size]) => ({ name, size })),
      ];
  return entries.map((f, i) => ({
    index: i,
    name: f.name,
    size: Math.max(1, Math.round(f.size)),
    progress: t.progress >= 1 ? 1 : Math.min(1, Number((t.progress * 1.12).toFixed(4))),
    priority: 1,
    is_seed: t.progress >= 1,
    piece_range: [0, 10],
  }));
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
  软件: { name: '软件', savePath: '/downloads/apps' },
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

function buildMedia() {
  rmSync(MEDIA_DIR, { recursive: true, force: true });
  mkdirSync(MEDIA_DIR, { recursive: true });
  torrents.forEach((t, i) => {
    const slug = t.name.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 42).toLowerCase();
    const dir = path.join(MEDIA_DIR, `${String(i + 1).padStart(2, '0')}-${slug}`);
    mkdirSync(path.join(dir, 'extras'), { recursive: true });
    writeFileSync(path.join(dir, 'poster.svg'), posterSvg(t.name.slice(0, 26), t.category || 'demo', i));
    writeFileSync(path.join(dir, 'fanart.svg'), posterSvg(`${t.name.slice(0, 20)} · wide`, 'fanart', i + 2));
    writeFileSync(path.join(dir, 'extras', 'scene-01.svg'), posterSvg('Scene 01', t.category || 'demo', i + 3));
    writeFileSync(path.join(dir, 'extras', 'scene-02.svg'), posterSvg('Scene 02', t.category || 'demo', i + 4));
    t.content_path = dir;
    t.save_path = path.dirname(dir);
  });
}

if (MEDIA_DIR) buildMedia();

const server = http.createServer((req, res) => {
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
  if (p === '/api/v2/torrents/info') return json(res, torrents);
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
