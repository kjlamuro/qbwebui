/**
 * 速度采样日志
 *
 * 浏览器只能看到「当前这一刻」的速度，关掉页面就断了。这里让服务端常驻采样：
 *   · 全局上下行速度 —— 画折线，跨刷新 / 跨重启都在
 *   · 每个种子的瞬时速度峰值 —— 详情页「峰值下载」用
 *
 * 采样走 /sync/maindata 的增量接口（和前端同一套），不会因为种子多就把整张
 * /torrents/info 一遍遍拉回来。只有增量里一条种子都没给的时候（比如仓库里的 mock），
 * 才退化成每分钟拉一次 /torrents/info 兜底。
 *
 * 数据落在 dataDir/speed-history.json：内存里留 2 小时的点，文件每 60 秒写一次，
 * 退出时再补一次。峰值按 30 天过期清理。
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

const FILE = 'speed-history.json';
const KEEP_MS = 2 * 60 * 60 * 1000; // 内存里保留 2 小时
const MAX_POINTS = 1440; // 5 秒一个点正好 2 小时
const PEAK_TTL = 30 * 24 * 60 * 60 * 1000; // 峰值记录保留 30 天
const SAVE_MS = 60 * 1000;

export function createSpeedLog({ dataDir, qbFetch, interval = 5000, onLog = () => {} }) {
  const file = path.join(dataDir, FILE);
  const step = Math.min(60000, Math.max(1000, Number(interval) || 5000));

  let points = []; // [[ts, dl, up], ...]
  let peaks = new Map(); // hash -> { dl, up, at }
  let server = {}; // 合并后的 server_state（增量响应只带变化的字段）
  let torrents = new Map(); // hash -> { dl, up }
  let rid = 0;
  let lastSeed = 0;
  let dirty = false;
  let timer = null;
  let saver = null;
  let lastOk = 0; // 最后一次成功采样——用于判断「是不是连不上了」
  let warned = 0;

  const snapshot = () => {
    const now = Date.now();
    const pk = {};
    for (const [hash, v] of peaks) {
      if (now - v.at <= PEAK_TTL && (v.dl > 0 || v.up > 0)) pk[hash] = [v.dl, v.up, v.at];
    }
    return { v: 1, interval: step, updated: now, points, peaks: pk };
  };

  async function save() {
    if (!dirty) return;
    dirty = false;
    try {
      await mkdir(dataDir, { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(snapshot()), 'utf8');
      await rename(tmp, file);
    } catch (err) {
      dirty = true;
      onLog(`写盘失败：${err.message}`);
    }
  }

  /**
   * 退出前补一次落盘，然后用 SIGKILL 收尾。
   *
   * 这条路踩过两个坑，都记在这里免得以后又改回去：
   *   1. 原来用 writeFileSync：文件系统一旦卡死，同步写会把信号处理器自己也挂住。
   *   2. 光换成异步也不够 —— process.exit() 在关闭阶段会等 libuv 线程池 join，
   *      线程卡在系统调用里就永远回不来。实测：线程池卡死后调 process.exit(0)，
   *      进程照样活着。而且此时主线程被困在关闭流程里，定时器也不会再触发，
   *      所以「超时就退出」这种兜底在主线程里做不到。
   *
   * 结论：先异步落盘（最多等 800ms），再用 SIGKILL 打掉自己。SIGKILL 是唯一
   * 能保证退出的手段。代价是最多丢一个保存周期，换来 SIGTERM / Ctrl+C 一定有效。
   * launchd 用 KeepAlive 托管时，bootout 会正常卸载，不受影响。
   */
  function shutdown() {
    let done = false;
    const bye = () => {
      if (done) return;
      done = true;
      try {
        process.kill(process.pid, 'SIGKILL');
      } catch {
        process.exit(0);
      }
    };
    setTimeout(bye, 800).unref();
    if (!dirty) return bye();
    save().then(bye, bye);
  }

  async function load() {
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'));
      const now = Date.now();
      points = (Array.isArray(raw.points) ? raw.points : [])
        .filter((p) => Array.isArray(p) && p.length >= 3 && now - p[0] <= KEEP_MS && now - p[0] >= -60000)
        .map((p) => [Number(p[0]), Number(p[1]) || 0, Number(p[2]) || 0])
        .slice(-MAX_POINTS);
      for (const [hash, v] of Object.entries(raw.peaks || {})) {
        if (!Array.isArray(v) || v.length < 3) continue;
        if (now - Number(v[2]) > PEAK_TTL) continue;
        peaks.set(hash, { dl: Number(v[0]) || 0, up: Number(v[1]) || 0, at: Number(v[2]) || now });
      }
    } catch {
      /* 第一次跑没有文件，或者上次写坏了：当作空历史重新开始 */
    }
  }

  let ticking = false;

  /** 上一轮还没回来就跳过这一轮：上游卡住时别每 5 秒再叠一个请求上去 */
  async function tick() {
    if (ticking) return;
    ticking = true;
    try { await tickOnce(); } finally { ticking = false; }
  }

  async function tickOnce() {
    let sync;
    try {
      sync = await qbFetch(`/api/v2/sync/maindata?rid=${rid}`);
    } catch (err) {
      // 只跳过这一轮，定时器还在，下一轮照常重试——不是「暂停」。
      // 偶发抖一次别反复刷屏：同样的话一分钟说一次；一旦成功就重置计数。
      if (Date.now() - warned > 60000) {
        warned = Date.now();
        onLog(`采样失败（${err.message}），下轮自动重试`);
      }
      return;
    }
    if (!sync || typeof sync !== 'object') return;
    warned = 0; // 恢复成功，下次出错要能立刻说

    if (sync.server_state) server = { ...server, ...sync.server_state };
    if (sync.rid != null) rid = sync.rid;

    if (sync.full_update) torrents.clear();
    for (const hash of sync.torrents_removed || []) torrents.delete(String(hash));
    const patch = sync.torrents || {};
    for (const hash of Object.keys(patch)) {
      const p = patch[hash] || {};
      const prev = torrents.get(hash);
      torrents.set(hash, {
        dl: p.dlspeed != null ? p.dlspeed : prev ? prev.dl : 0,
        up: p.upspeed != null ? p.upspeed : prev ? prev.up : 0,
      });
    }

    // 增量一条种子都没回（mock 就是这样）：一分钟用 /torrents/info 兜一次底
    if (!torrents.size && Date.now() - lastSeed > 60000) {
      lastSeed = Date.now();
      try {
        const list = await qbFetch('/api/v2/torrents/info');
        if (Array.isArray(list)) {
          for (const t of list) torrents.set(t.hash, { dl: t.dlspeed || 0, up: t.upspeed || 0 });
        }
      } catch { /* 兜底失败不影响全局速度采样 */ }
    }

    const now = Date.now();
    const dl = Number(server.dl_info_speed) || 0;
    const up = Number(server.up_info_speed) || 0;
    points.push([now, dl, up]);
    if (points.length > MAX_POINTS) points.splice(0, points.length - MAX_POINTS);

    for (const [hash, v] of torrents) {
      if (!v || (v.dl <= 0 && v.up <= 0)) continue;
      const prev = peaks.get(hash);
      const dlPeak = Math.max(v.dl, prev?.dl || 0);
      const upPeak = Math.max(v.up, prev?.up || 0);
      if (!prev || dlPeak !== prev.dl || upPeak !== prev.up) {
        peaks.set(hash, { dl: dlPeak, up: upPeak, at: now });
      }
    }

    lastOk = now;
    dirty = true;
  }

  return {
    interval: step,
    async ready() {
      await load();
    },
    start() {
      if (timer) return;
      // 从「现在」开始计时而不是 0：上游一直连不上（qB 还没起来 / 已经关了）
      // 时 lastOk 永远不会被赋值，用 0 会被误判成「没断」，干脆以启动时刻为基准。
      if (!lastOk) lastOk = Date.now();
      tick().catch(() => {});
      timer = setInterval(() => { tick().catch(() => {}); }, step);
      timer.unref?.(); // 别因为采样定时器把进程吊着
      saver = setInterval(() => { save().catch(() => {}); }, SAVE_MS);
      saver.unref?.();
      for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, shutdown);
    },
    stop() {
      clearInterval(timer);
      clearInterval(saver);
      timer = null;
      saver = null;
    },
    flush: () => save(),

    /** 最近 winSec 秒的点；顺手把窗口内的峰值算出来，前端不用再扫一遍 */
    history(winSec = 300) {
      const now = Date.now();
      const from = now - Math.max(10, Math.min(7200, winSec)) * 1000;
      const list = [];
      let maxDl = 0;
      let maxUp = 0;
      for (const p of points) {
        if (p[0] < from) continue;
        list.push(p);
        if (p[1] > maxDl) maxDl = p[1];
        if (p[2] > maxUp) maxUp = p[2];
      }
      // stale：连续好几轮都拿不到上游数据（qB 关了 / 登出 / 网络断了）。
      // 这时候曲线会停在过去某一刻却毫无提示，跟「卡住了」看不出区别，前端得明说。
      const stale = lastOk > 0 && now - lastOk > step * 4;
      return {
        interval: step,
        now,
        from,
        points: list,
        max: { dl: maxDl, up: maxUp },
        samples: points.length,
        stale,
      };
    },

    peakOf(hash) {
      const v = peaks.get(String(hash || '').toLowerCase());
      return v ? { dl: v.dl, up: v.up, at: v.at } : null;
    },
  };
}
