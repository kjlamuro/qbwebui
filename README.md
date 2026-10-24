# qBWebUI

轻量、好看的 qBittorrent 网页控制台。桌面与手机同一套代码自适应，**零运行时依赖**（只用 Node 内置模块 + 原生前端），一条命令启动。

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![node](https://img.shields.io/badge/node-%3E%3D18-3c873a.svg)
![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)
![frontend](https://img.shields.io/badge/frontend-vanilla%20JS-f7df1e.svg)

![桌面端](docs/desktop-light.jpg)

## 特性

- **列表**：名称 / 大小 / 进度 / 下载 / 上传 / 分享率 / 剩余时间 / 状态，点表头排序；每 2 秒增量刷新，几百个种子也不卡
- **筛选**：全部、下载中、做种中、已完成、已暂停、错误；分类、标签、名称搜索
- **单条操作**：暂停 / 继续、强制开始、顺序下载、设置分类、重新校验、重新通告 Tracker、删除（可选删文件）
- **批量操作**：多选后统一暂停 / 恢复 / 删除
- **详情抽屉**：进度环、实时速度、分块与分享率、文件列表（逐个跳过 / 恢复）、Tracker 状态
- **添加种子**：magnet / 链接 / `.torrent` 文件（支持拖拽、多选），可指定保存路径、分类、标签、暂停添加
- **保存路径历史**：输入框下拉切换目录——默认路径置顶，其次是最近用过的，最后是从种子库统计出的常用目录（带种子数）；支持关键词过滤、`↑↓` 选择、`↵` 确认
- **封面缩略图**：自动从种子目录里挑图片（优先 `poster` / `folder` / `cover` 等常见名），没有就回退到类型图标；也可以手动上传、或直接从目录里选一张。缩略图缓存在 `data/covers/`（macOS 上顺带用 `sips` 压到 640px），可在设置里一键关掉
- **全局**：上下行速度、剩余空间、累计流量、全局限速、备用速度限制
- **外观**：深色 / 浅色 / 跟随系统；桌面端侧边栏 + 表格，移动端卡片 + 底部导航；可「添加到主屏幕」当 App 用

## 快速开始

需要 Node.js ≥ 18，以及一个开着 Web UI 的 qBittorrent（4.x / 5.x 都可以）。

```bash
git clone https://github.com/kjlamuro/qbwebui.git
cd qbwebui
node server.mjs        # 或 npm start
```

```
本机   http://127.0.0.1:7788
局域网 http://192.168.x.x:7788   ← 手机用这个
```

macOS 也可以直接双击 `start.command`（会自动打开浏览器）。

### 只想先看看界面？

不需要装 qBittorrent，用内置的假数据跑一遍：

```bash
npm run demo           # http://127.0.0.1:7799
```

`tools/mock-qb.mjs` 是一个只读的假 qBittorrent，12 个虚构种子，任何操作都只返回成功、不落盘。README 里的截图就是用它生成的。

## 配置

优先级：环境变量 > `config.json` > 默认值。

| 项 | 环境变量 | 默认 |
| --- | --- | --- |
| qBittorrent WebUI 地址 | `QB_URL` | `http://127.0.0.1:9898` |
| 本服务监听端口 | `PORT` | `7788` |

```bash
QB_URL=http://192.168.1.10:9898 PORT=7788 node server.mjs
```

也可以在界面「设置 → qBittorrent 连接」里改，会写入 `config.json` 并立即生效（该文件已在 `.gitignore` 里）。

> 常见坑：qBittorrent 设置里的 `连接 → 监听端口`（例如 40459）是 BT 端口，**不是** WebUI 端口。要填的是 `Web UI → 端口`（例如 9898）。

## 手机上用

1. 手机和电脑连同一个 Wi-Fi
2. 打开 `http://<电脑局域网 IP>:7788`
3. iOS Safari「分享 → 添加到主屏幕」，Android Chrome「添加到主屏幕」，即可全屏独立运行（已配 `manifest`）

首次打开若弹登录框，输入 qBittorrent 的用户名密码；勾选「记住这台设备」后本机自动登录。也可以在 qBittorrent 里把内网段加进「Web UI → 免验证白名单」（如 `192.168.1.0/24`）。

## 快捷键（桌面）

| 键 | 作用 |
| --- | --- |
| `/` 或 `⌘/Ctrl + F` | 聚焦搜索 |
| `a` | 添加种子 |
| `空格` | 暂停 / 恢复（有选中则批量） |
| `Esc` | 关闭弹窗 / 详情，取消选择 |

## 界面

| 深色主题 | 详情抽屉 |
| --- | --- |
| ![深色](docs/desktop-dark.jpg) | ![详情](docs/detail.jpg) |

<p align="center">
  <img src="docs/mobile.jpg" width="320" alt="移动端">
</p>

## 安全说明

- 服务默认监听 `0.0.0.0`，**同一局域网内的人都能打开这个页面**。不要把它暴露到公网；需要远程访问请走 VPN 或带鉴权的反向代理。
- 「记住这台设备」会把 qBittorrent 账号密码以明文存在浏览器 `localStorage` 里，共用电脑请勿勾选。
- 代理只在内存里持有 qBittorrent 的 SID，不写磁盘；重启服务需要重新登录。
- 本项目不包含任何用户系统，鉴权完全交给 qBittorrent 自己。
- 封面缓存写在 `data/covers/`，其索引里含**本机磁盘绝对路径**，因此该目录和 `config.json` 一样已在 `.gitignore` 中，不会进入版本库。

## 为什么要有一个本地 Node 服务

浏览器直连 qBittorrent WebUI 会被 CORS 拦掉，登录凭证（SID）又是 HttpOnly Cookie，前端拿不到。所以 `server.mjs` 只做两件事：

1. 托管 `public/` 下的静态页面
2. 把 `/api/v2/*` 反向代理到 qBittorrent，**在服务端**保管 SID

前端因此只和同源地址打交道，没有跨域问题，也不需要任何构建步骤。

## 目录

```
server.mjs              静态托管 + API 反向代理（SID 会话）
start.command           macOS 双击启动
public/
  index.html            页面骨架、SVG 图标集
  styles.css            设计系统、深浅色、响应式布局
  app.js                轮询、渲染、交互逻辑
  manifest.webmanifest  PWA 清单
  icon*.svg/png         图标
lib/
  covers.mjs            封面缓存、候选图扫描
tools/
  mock-qb.mjs           假 qBittorrent（演示 / 开发用）
  demo.mjs              一条命令拉起演示环境
docs/                   README 截图
```

## 实现要点

- 每 2 秒并发拉 `/torrents/info` 和 `/sync/maindata?rid=`；后者是增量，`server_state` **只带变化字段**，必须合并而不是覆盖，否则「剩余空间」会变成 0
- 列表用 keyed DOM diff：只更新变化的文本 / 进度，靠 CSS `order` 重排
- qBittorrent 的暂停是**异步**的（1~2 秒后才生效），前端先乐观更新并保留 2.5 秒窗口，避免状态回弹闪烁
- 兼容 WebAPI 5.x 的 `stop/start` 与旧版的 `pause/resume`，失败时自动切换
- 保存路径下拉用 `position: fixed` 动态定位，不会被弹窗的滚动容器裁切；下方空间不足时向上展开
- 表格列宽分 4 档 `--row-grid` 分别校准到**该断点最窄时也放得下**（可用宽 ≈ 视口宽 − 268px），否则 901/1041/1181/1281 这些交界处会溢出、最右侧操作列被裁掉
- 操作菜单同一个组件两套形态：≤900px 底部抽屉，>900px 居中浮层

## 开发

```bash
npm run demo         # 假数据跑界面，改前端不需要连真实 qBittorrent
npm run check        # 语法检查
```

前端没有打包步骤，改完 `public/` 刷新即可。

## 已知限制

- 单实例、单用户：不做多用户与权限，鉴权交给 qBittorrent
- 不含 RSS、搜索插件、限速计划等 qBittorrent 原生界面里的小众面板
- 子路径部署（如 `https://example.com/qb/`）尚未适配

## English

A lightweight, self-hosted web UI for qBittorrent — responsive for desktop and mobile, zero runtime dependencies, no build step. It ships a tiny Node reverse proxy so the browser never hits CORS or the HttpOnly session cookie. Run `node server.mjs`, or `npm run demo` to explore the UI with mock data.

## License

[MIT](LICENSE)。与 qBittorrent 官方无关，仅为第三方客户端。
