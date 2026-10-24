/**
 * 极简 bencode 解码 —— 只为从 .torrent 里读出文件清单，别的字段一律不看。
 *
 * 为什么不用现成的库：本项目零运行时依赖，而且 .torrent 的格式稳定得像化石
 * （i 整数 / l 列表 / d 字典 / <长度>:<字节串> 四种），一百行就能覆盖。
 *
 * 两个实现细节值得留意：
 * - 字节串返回 Buffer 的 subarray **视图**而不是拷贝。info.pieces 动辄几十 MB，
 *   复制一遍既慢又费内存，而我们只想看文件名。
 * - 递归带深度上限：坏的 / 恶意的种子里塞几十层嵌套不该把进程带下去。
 */

const MAX_DEPTH = 32;

/** Buffer / 字符串 → UTF-8 字符串，其它类型给空串 */
export const bstr = (v) => (Buffer.isBuffer(v) ? v.toString('utf8') : typeof v === 'string' ? v : '');

/**
 * 解一段 bencode，返回 [值, 下一个位置]。
 * 值可能是 number / Buffer / Array / object。
 */
export function bdecode(buf, pos = 0, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error('bencode 嵌套过深');
  if (pos >= buf.length) throw new Error('bencode 意外结束');

  const c = buf[pos];

  // i<数字>e
  if (c === 0x69) {
    const end = buf.indexOf(0x65, pos + 1);
    if (end < 0) throw new Error('bencode 整数未闭合');
    const n = Number(buf.toString('ascii', pos + 1, end));
    if (!Number.isFinite(n)) throw new Error('bencode 整数非法');
    return [n, end + 1];
  }

  // l<元素…>e
  if (c === 0x6c) {
    const out = [];
    let p = pos + 1;
    for (;;) {
      if (p >= buf.length) throw new Error('bencode 列表未闭合');
      if (buf[p] === 0x65) return [out, p + 1];
      const [v, next] = bdecode(buf, p, depth + 1);
      out.push(v);
      p = next;
    }
  }

  // d<键值…>e
  if (c === 0x64) {
    const out = {};
    let p = pos + 1;
    for (;;) {
      if (p >= buf.length) throw new Error('bencode 字典未闭合');
      if (buf[p] === 0x65) return [out, p + 1];
      const [k, p1] = bdecode(buf, p, depth + 1);
      const [v, p2] = bdecode(buf, p1, depth + 1);
      out[bstr(k)] = v;
      p = p2;
    }
  }

  // <长度>:<字节>
  const colon = buf.indexOf(0x3a, pos);
  if (colon < 0) throw new Error('bencode 字节串非法');
  const len = Number(buf.toString('ascii', pos, colon));
  if (!Number.isInteger(len) || len < 0) throw new Error('bencode 长度非法');
  const start = colon + 1;
  if (start + len > buf.length) throw new Error('bencode 长度越界');
  return [buf.subarray(start, start + len), start + len];
}

/**
 * .torrent → { name, files: [{ name, size }], multi }
 *
 * - `multi` 为 true 表示这是多文件种子（info.files 存在），此时 files 的 name 是
 *   相对种子根目录的路径（`正片/The.Matrix.1999.mkv`），像 qBittorrent 一样用 `/` 拼。
 * - 单文件种子没有 info.files，退回 info.name + info.length，`multi` 为 false。
 * - utf-8 字段优先（老种子的 name 可能是本地编码，`name.utf-8` 才是准的）。
 */
export function torrentFiles(buf) {
  const [root] = bdecode(buf, 0);
  if (!root || typeof root !== 'object') throw new Error('不是有效的 torrent');
  const info = root.info;
  if (!info || typeof info !== 'object') throw new Error('缺少 info 段');

  const name = bstr(info['name.utf-8']) || bstr(info.name);
  const list = Array.isArray(info.files) ? info.files : [];
  const files = [];

  for (const f of list) {
    if (!f || typeof f !== 'object') continue;
    const parts = Array.isArray(f['path.utf-8']) ? f['path.utf-8'] : Array.isArray(f.path) ? f.path : [];
    const rel = parts.map(bstr).filter(Boolean).join('/');
    if (!rel) continue;
    files.push({ name: rel, size: Number(f.length) || 0 });
  }

  if (!files.length && name) files.push({ name, size: Number(info.length) || 0 });
  return { name, files, multi: list.length > 0 };
}
