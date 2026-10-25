/* ══════════════════════════════════════════════════════════
   qBWebUI · 国际化（中 / 英）

   设计取舍：
   · 中文原文直接当 key（gettext 那套）。界面本来就用中文写的，翻译成英文时
     只需要写一份 EN 词典，中文侧零维护 —— 万一漏翻也只会回落成中文，不会出现
     「界面上冒出一串 menu.addTorrent」这种事故。
   · 静态文案在 HTML 上用 data-i18n / data-i18n-text / data-i18n-title 标注，
     属性值留空即「拿节点自己现有的文字当 key」，改 HTML 时不用同步维护一份映射表。
   · 带 <code> / <a> 的长段落换成语义 key（data-i18n-key），词典里存整段 HTML。
   · 语言选择存 localStorage，首次访问按 navigator.language 猜：中文浏览器给
     中文，其余全给英文。
   ══════════════════════════════════════════════════════════ */

const LANG_KEY = 'qb.lang';
export const LOCALES = ['zh', 'en'];

/* ── 英文词典：key = 中文原文（或语义 key） ─────────────── */

const p = (n, one, many) => (n === 1 ? one : many);

const EN = {
  /* ── 状态 / 筛选 ── */
  '下载中': 'Downloading',
  '获取元数据': 'Fetching metadata',
  '分配空间': 'Allocating',
  '等待中': 'Stalled',
  '排队中': 'Queued',
  '已暂停': 'Paused',
  '做种中': 'Seeding',
  '做种等待': 'Seeding (stalled)',
  '已完成': 'Completed',
  '校验中': 'Checking',
  '恢复中': 'Resuming',
  '移动中': 'Moving',
  '文件缺失': 'Files missing',
  '错误': 'Error',
  '未知': 'Unknown',
  '全部': 'All',

  /* ── 类型 ── */
  '视频': 'Video',
  '音乐': 'Music',
  '音频': 'Audio',
  '图片': 'Image',
  '书籍': 'Books',
  '压缩包 / 镜像': 'Archive / ISO',
  '其他': 'Other',

  /* ── 通用 ── */
  '下载': 'Down',
  '上传': 'Up',
  '下载速度': 'Down speed',
  '上传速度': 'Up speed',
  '剩余空间': 'Free space',
  '连接': 'Peers',
  '连接中…': 'Connecting…',
  '已连接': 'Connected',
  '已连接 · 防火墙中': 'Connected · firewalled',
  '未连接': 'Disconnected',
  '连接断开': 'Disconnected',
  '分类': 'Categories',
  '标签': 'Tags',
  '未分类': 'Uncategorized',
  '暂无标签': 'No tags yet',
  '近 5 分钟': 'Last 5 min',
  '近 {n} 秒': 'Last {n}s',
  '近 {n} 分钟': 'Last {n} min',
  '分享率': 'Ratio',
  '剩余': 'ETA',
  '不限': 'Unlimited',
  '可选': 'Optional',
  '自动': 'Auto',
  '手动': 'Manual',
  '关闭': 'Close',
  '取消': 'Cancel',
  '确定': 'OK',
  '清空': 'Clear',
  '删除': 'Delete',
  '移除': 'Remove',
  '恢复': 'Resume',
  '暂停': 'Pause',
  '继续': 'Resume',
  '更多': 'More',
  '完成': 'Done',
  '返回': 'Back',
  '搜索': 'Search',
  '停止': 'Stop',
  '电影': 'Movie',
  '剧集': 'Series',
  '海报': 'Poster',
  '背景图': 'Backdrop',
  '当前': 'Current',
  '媒体': 'Media',
  '浏览器': 'Browser',
  '已开启': 'On',
  '已关闭': 'Off',

  /* ── 列表 / 空态 ── */
  '这里还没有种子': 'No torrents yet',
  '没有匹配的种子': 'No matching torrents',
  '点击右上角「添加种子」开始下载': 'Click “Add torrent” to start downloading',
  '试试换个关键词或筛选条件': 'Try another keyword or filter',
  '种子占用 {size} · 剩余 {free}': 'Torrents {size} · free {free}',
  '备用速度限制：已开启': 'Alternative rate limits: on',
  '备用速度限制：已关闭': 'Alternative rate limits: off',
  '分享率 {v}': 'Ratio {v}',
  // eta 是 '∞' 时别拼成 "∞ left"，英文里看「∞ ETA」更自然
  '剩 {eta}': (v) => (v.eta === '∞' ? '∞ ETA' : `${v.eta} left`),
  '剩余 {eta}': (v) => (v.eta === '∞' ? '∞ ETA' : `${v.eta} left`),
  '采样中…': 'Sampling…',
  '无流量': 'No traffic',
  '已断连': 'Disconnected',
  '峰值 ↓ {v}': 'Peak ↓ {v}',

  /* ── 批量 / 确认 / 提示 ── */
  '已暂停 {n} 项': (v) => `Paused ${v.n} ${p(v.n, 'torrent', 'torrents')}`,
  '已恢复 {n} 项': (v) => `Resumed ${v.n} ${p(v.n, 'torrent', 'torrents')}`,
  '已删除 {n} 项': (v) => `Deleted ${v.n} ${p(v.n, 'torrent', 'torrents')}`,
  '删除 {n} 个种子？': (v) => `Delete ${v.n} ${p(v.n, 'torrent', 'torrents')}?`,
  '种子会从列表中移除，已下载的文件默认保留。': 'Torrents are removed from the list; downloaded files are kept by default.',
  '仅删除种子': 'Remove torrent only',
  '同时删除文件': 'Also delete files',
  '操作失败': 'Action failed',
  '删除这个种子？': 'Delete this torrent?',
  '已删除': 'Deleted',
  '已继续': 'Resumed',
  '新建分类名称': 'New category name',
  '分类已创建': 'Category created',
  '分类已更新': 'Category updated',
  '请选择图片文件': 'Please choose an image file',
  '图片请控制在 8MB 以内': 'Images must be 8MB or smaller',
  '上传失败': 'Upload failed',
  '封面上传失败': 'Cover upload failed',
  '封面已设置': 'Cover set',
  '封面已更换': 'Cover changed',
  '已改成类型图标': 'Switched to type icon',
  '已恢复自动封面': 'Restored automatic cover',
  '已重新扫描目录': 'Folder rescanned',
  '读取失败': 'Read failed',
  '读取这个目录失败（超时或没有磁盘访问权限）。缓存里的封面不受影响；需要重新扫描时可稍后再试。': 'Could not read this folder (timed out, or no disk access). Cached covers are unaffected — try scanning again later.',
  '已粘贴封面': 'Cover pasted',
  '已粘贴封面，添加后自动套用': 'Cover pasted — applied after adding',
  '先选中一个种子': 'Select a torrent first',
  '正在读取图片…': 'Reading image…',
  '已粘贴的图片': 'Pasted image',

  /* ── 详情面板 ── */
  '信息': 'Info',
  '文件 {n}': 'Files {n}',
  '{n} 个文件': '{n} files',
  '已跳过 {n}': '{n} skipped',
  '修改下载列表': 'Edit file list',
  '跳过该文件': 'Skip this file',
  '恢复该文件': 'Resume this file',
  '点击预览': 'Click to preview',
  '暂无文件信息': 'No file info',
  '工作中': 'Working',
  '未联系': 'Not contacted',
  '已禁用': 'Disabled',
  '暂无 Tracker': 'No trackers',
  '保存路径': 'Save path',
  '种子大小': 'Torrent size',
  '已下载': 'Downloaded',
  '已上传': 'Uploaded',
  '平均下载': 'Avg. down',
  '平均上传': 'Avg. up',
  '峰值下载': 'Peak down',
  '峰值上传': 'Peak up',
  '可用性': 'Availability',
  '做种 / 用户': 'Seeds / peers',
  '{s} 做种 · {p} 下载': '{s} seeds · {p} peers',
  '添加时间': 'Added',
  '完成时间': 'Completed',
  '活跃时间': 'Active time',
  '做种时间': 'Seeding time',
  '下载 / 上传限速': 'Down / up limit',
  '分块': 'Pieces',
  '备注': 'Comment',
  '哈希': 'Hash',
  '封面•刮削': 'Cover & scrape',
  '当前：自动（目录图片 → 类型图标）': 'Current: auto (folder image → type icon)',
  '不设置也可以': 'Leave it empty',
  '默认用种子目录里的图片，没有就显示类型图标；也可以在下面直接粘一张':
    'Uses an image from the torrent folder by default, otherwise a type icon. You can also paste one below.',
  '刮削全部影视种子': 'Scrape all movies & series',
  'qBittorrent 统计：累计下载量 / 有效活跃时长': 'qBittorrent stats: total downloaded / active time',
  'qBittorrent 统计：累计上传量 / 有效活跃时长': 'qBittorrent stats: total uploaded / active time',
  '本服务每 5 秒采样一次取最大值，真实瞬时峰值只会更高；从没跑过的种子显示 —':
    'Sampled every 5s by this server; the true instantaneous peak can only be higher. “—” if never active.',
  '预览图片': 'Preview images',
  '预览视频': 'Preview video',
  '预览音频': 'Preview audio',
  '{label}预览': '{label} preview',
  '缩小': 'Zoom out',
  '放大': 'Zoom in',
  '恢复原始大小': 'Reset zoom',
  '下载原文件': 'Download original',
  '上一个': 'Previous',
  '下一个': 'Next',
  '已下载 {n}%': '{n}% downloaded',
  '缓冲中…': 'Buffering…',
  '下载文件': 'Download file',
  '新标签打开': 'Open in new tab',
  '浏览器无法直接播放这个视频。MKV / HEVC / 杜比视界等格式通常需要转码，可以下载后用本地播放器打开。':
    'This video cannot play in the browser. MKV / HEVC / Dolby Vision usually need transcoding — download it and open it locally.',
  '浏览器无法播放这个音频，可能还没下载完成，或编码不受支持。':
    'This audio cannot play in the browser: it may be incomplete or in an unsupported codec.',
  '这张图片无法显示：可能还没下载完，或浏览器不支持该格式（例如 HEIC）。可以下载后用本地应用打开。':
    'This image cannot be displayed: it may be incomplete, or the format (e.g. HEIC) is unsupported. Download it and open it locally.',

  /* ── 操作菜单 ── */
  '继续下载': 'Resume',
  '取消强制开始': 'Cancel force start',
  '强制开始': 'Force start',
  '关闭顺序下载': 'Disable sequential download',
  '顺序下载': 'Sequential download',
  '设置分类': 'Set category',
  '自定义 / 目录 / TVDB': 'Custom / folder / TVDB',
  '重新校验': 'Recheck',
  '重新通告 Tracker': 'Reannounce tracker',
  '删除种子': 'Delete torrent',
  '操作': 'Actions',

  /* ── 封面弹窗 ── */
  '目录不可用': 'Folder unavailable',
  '读取不到这个种子的目录': 'Cannot read this torrent’s folder',
  '当前：自定义图片': 'Current: custom image',
  '当前：类型图标': 'Current: type icon',
  '当前：TheTVDB 刮削': 'Current: TheTVDB poster',
  '没有独立目录': 'No dedicated folder',
  '这个种子没有独立目录，为避免误用同目录下别人的图片，目录匹配已跳过。<br>可以自己上传一张。':
    'This torrent has no dedicated folder. Folder matching is skipped to avoid using another torrent’s image.<br>You can upload one yourself.',
  '{n} 张': '{n} images',
  '目录里没找到图片': 'No images found in the folder',
  '这个种子的目录里没有可用图片，可以自己上传一张': 'No usable image in this folder — upload one yourself',
  '读取中…': 'Loading…',
  '读取失败': 'Load failed',
  '判定类型：{label}': 'Detected type: {label}',
  ' · 体积占 {n}%': ' · {n}% of size',
  '到「设置 → TheTVDB 刮削」里填上自己的 API Key 就能用。':
    'Add your own API key in “Settings → TheTVDB scraping” to use it.',
  'TheTVDB 上没有简介，点开海报看看对不对得上也一样。': 'No overview on TheTVDB — check the posters instead.',
  '看它的海报': 'View posters',
  '就用这张': 'Use this one',
  '直接套用第一张': 'Use the first one',
  'TheTVDB 上没搜到，换个名字试试（可以只填英文主标题）':
    'Not found on TheTVDB. Try another name (the English title alone often works).',
  '海报 {n}': 'Poster {n}',
  '（背景图）': ' (backdrop)',

  /* ── TheTVDB 搜索 ── */
  '搜索中…': 'Searching…',
  '搜索失败': 'Search failed',
  ' · 按「{q}」搜到': ' · found with “{q}”',
  '识别为「{title}」': 'Recognised as “{title}”',
  ' 第{n}季': ' S{n}',
  '{n} 个结果': '{n} results',
  '读取《{name}》的海报…': 'Loading posters for “{name}”…',
  '《{name}》· {n} 张可选，点一张套用': '“{name}” · {n} posters, tap one to apply',
  '套用中…': 'Applying…',
  '读取海报失败': 'Failed to load posters',
  '这部作品在 TheTVDB 上还没有海报': 'No posters for this title on TheTVDB yet',
  '套用失败': 'Failed to apply',
  '已套用《{name}》': 'Applied “{name}”',
  '已套用海报': 'Poster applied',
  '封面已从 TheTVDB 刮削': 'Cover scraped from TheTVDB',
  '自动匹配中…': 'Auto-matching…',
  '匹配失败': 'Match failed',
  '已套用{label}的第一张海报': 'Applied the first poster of {label}',
  '，另有 {n} 张可点选': ', {n} more to pick from',
  '已套用{label}的海报': 'Applied the poster for {label}',
  '（按种子里的正片文件名）': ' (from the main video file)',
  '识别为{name}{from}，不敢确定是哪一部，挑一个看看简介':
    'Recognised {name}{from}, but unsure which title it is — pick one to read its overview',
  'TheTVDB 上没找到{name}{from}，换个关键词试试（中英混排的名字可以只填英文）':
    'Nothing on TheTVDB for {name}{from}. Try other keywords (for mixed CN/EN names, try the English part only).',
  '还没配置 TheTVDB': 'TheTVDB is not configured',
  'TheTVDB 刮削已关闭': 'TheTVDB scraping is off',
  '当前：TheTVDB · {type}{year}': 'Current: TheTVDB · {type}{year}',
  '当前是自定义图片，想换成刮削海报点「自动匹配」': 'Currently a custom image — click “Auto match” to use a scraped poster',
  '当前用的是类型图标，想换海报点「自动匹配」': 'Currently a type icon — click “Auto match” to get a poster',
  '识别为「{title}」{year}{from}，正在自动匹配…': 'Recognised “{title}”{year}{from}, auto-matching…',

  /* ── 添加种子 ── */
  '默认路径': 'Default path',
  '最近使用': 'Recently used',
  '常用目录': 'Frequently used',
  '默认': 'Default',
  '已存 {n} 个种子': '{n} torrents saved here',
  '新目录': 'New folder',
  '没有匹配的历史目录': 'No matching folders',
  '还没有历史目录': 'No history yet',
  '使用该路径': 'Use this path',
  '按 <kbd>↵</kbd> 直接使用当前路径': 'Press <kbd>↵</kbd> to use the current path',
  '<kbd>↑</kbd><kbd>↓</kbd> 选择 · <kbd>↵</kbd> 确认': '<kbd>↑</kbd><kbd>↓</kbd> to move · <kbd>↵</kbd> to confirm',
  '清除最近': 'Clear recent',
  '已清除路径历史': 'Path history cleared',
  '已选择 {n} 个文件：{name}': (v) => `Selected ${v.n} ${p(v.n, 'file', 'files')}: ${v.name}`,
  '点击选择或拖入 .torrent 文件': 'Click to choose or drop .torrent files',
  '自定义图片': 'Custom image',
  '添加后按这张设置；想换回刮削的海报点「刮削封面」':
    'This image is applied after adding; click “Scrape cover” to use a scraped poster instead',
  '来自 TheTVDB，添加后自动套用；想换一张点下面任意一张':
    'From TheTVDB, applied after adding; tap another one below to change',
  '刮削封面': 'Scrape cover',
  '刮削中…': 'Scraping…',
  '搜索「{name}」…': 'Searching “{name}”…',
  '没匹配到': 'No match',
  '没把握是哪一部，把关键词改得更准一点再试，也可以点「选择图片」手动设':
    'Not sure which title this is — refine the keywords, or pick an image manually',
  'TheTVDB 上没找到这部作品，换个关键词再试，也可以点「选择图片」手动设':
    'Not found on TheTVDB — try other keywords, or pick an image manually',
  '不敢确定是哪一部，看简介挑一部': 'Not sure which title this is — read the overview and pick one',
  '这部作品在 TheTVDB 上没有可用海报': 'No usable poster for this title on TheTVDB',
  '已匹配《{name}》，添加后自动套用海报': 'Matched “{name}” — poster applied after adding',
  '刮削失败': 'Scrape failed',
  /* 刮削信息手动写入媒体目录 */
  '尚未写入媒体目录': 'Not applied to the media folder',
  '正在写入媒体目录…': 'Writing to the media folder…',
  '已写入媒体目录（{n} 个文件）': 'Applied to the media folder ({n} files)',
  '（{n} 个文件）': ' ({n} files)',
  '写入失败': 'Write failed',
  '移除失败': 'Remove failed',
  '从媒体目录删除这个种子的海报和 NFO？': 'Delete this torrent’s poster and NFO from the media folder?',
  '已从媒体目录移除': 'Removed from the media folder',
  '海报和 NFO 已写入媒体目录': 'Poster and NFO written to the media folder',
  '元信息已更换，需要重新应用到媒体目录': 'Metadata changed — apply it to the media folder again',
  '下载完成后才能写入媒体目录': 'Available once the download finishes',
  '请先刮削海报和元信息': 'Scrape a poster and metadata first',
  '这条封面没有刮削元信息，无法生成 NFO': 'This cover has no scraped metadata — cannot build an NFO',
  '媒体目录里没有可移除的元信息': 'Nothing to remove in the media folder',
  '无法读取种子位置，种子可能已被删除': 'Cannot read the torrent location — it may have been deleted',
  '最终目录中没有可关联的视频文件': 'No video file in the final folder',
  '按种子里的 {file} 认作 {title}，不对可以直接改':
    'Recognised as {title} from {file} inside the torrent — edit it if that’s wrong',
  '已从种子名识别为 {title}，不对可以直接改':
    'Recognised as {title} from the torrent name — edit it if that’s wrong',
  '默认分类': 'Default category',
  '请粘贴 magnet 或链接': 'Paste a magnet link or URL',
  '请选择 .torrent 文件': 'Choose a .torrent file',
  '先粘贴 magnet 或链接，或直接填个关键词': 'Paste a magnet / URL first, or just type a keyword',
  '先选择 .torrent 文件，或直接填个关键词': 'Choose a .torrent file first, or just type a keyword',
  '先到「设置 → TheTVDB 刮削」里启用并填上 API Key': 'Enable TheTVDB scraping and add an API key in Settings first',
  'qBittorrent 拒绝了该种子': 'qBittorrent rejected this torrent',
  '添加中…': 'Adding…',
  '开始下载': 'Start download',
  '已添加到下载队列': 'Added to the download queue',
  '没找到刚添加的种子，封面未设置': 'Could not find the newly added torrent — cover not set',
  '没找到刚添加的种子，海报未套用': 'Could not find the newly added torrent — poster not applied',
  '已刮削《{name}》的海报': 'Scraped the poster for “{name}”',
  '海报套用失败': 'Failed to apply poster',
  '添加失败': 'Failed to add',

  /* ── 设置 ── */
  '样式 {v} · {mode} · 视口 {inner} · 屏幕 {screen} · 安全区 上{top}/下{bottom}':
    'CSS {v} · {mode} · viewport {inner} · screen {screen} · safe area top {top}/bottom {bottom}',
  ' · 缺口{n}px已补偿': ' · {n}px gap compensated',
  ' · 无缺口': ' · no gap',
  '目录扫描结果 {n} 个种子 · TVDB 海报 {t} 张 / {tb} · 目录图片 {d} 张 / {db}':
    'Scan: {n} torrents · TVDB posters {t} / {tb} · folder images {d} / {db}',
  '已保存：{k}': 'Saved: {k}',
  '来自环境变量': 'From environment',
  '已配置': 'Configured',
  '未配置': 'Not configured',
  ' · 已限流，{time} 后恢复': ' · rate limited, resumes at {time}',
  ' · 今日已调用 {n} 次': ' · {n} calls today',
  '已配置 · 海报语言 {lang} · 自动刮削{auto}': 'Configured · poster language {lang} · auto scrape{auto}',
  '：新加入的影视种子': ': new movie / series torrents',
  '：仅手动': ': manual only',
  '还没填 API Key：去 thetvdb.com 登录 → Dashboard → API Keys 申请一个（免费的）':
    'No API key yet: sign in at thetvdb.com → Dashboard → API Keys to get one (free)',
  '测试中…': 'Testing…',
  '保存并测试': 'Save and test',
  '保存失败': 'Save failed',
  'TheTVDB 连接正常（{ms}ms）': 'TheTVDB reachable ({ms}ms)',
  '连接失败，检查 API Key': 'Connection failed — check the API key',
  '正在刮：{name}': 'Scraping: {name}',
  '准备中…': 'Preparing…',
  '成功 {n}': 'ok {n}',
  '跳过 {n}': 'skipped {n}',
  '没匹配 {n}': 'no match {n}',
  '没有可刮削的种子': 'No torrents to scrape',
  '已停止': 'Stopped',
  '刮削完成': 'Scraping finished',
  '已停止：完成 {d} 个，跳过 {s} 个，没匹配 {f} 个':
    'Stopped: {d} done, {s} skipped, {f} no match',
  '刮削完成：成功 {d} 个，跳过 {s} 个，没匹配上 {f} 个':
    'Finished: {d} done, {s} skipped, {f} no match',
  '已经有一个刮削任务在跑了': 'A scrape job is already running',
  '刮削中断（连接已断开）': 'Scrape interrupted (connection lost)',
  '刮削全部影视种子？': 'Scrape all movies & series?',
  '会给列表里每个影视类种子去 TheTVDB 查一次并下载海报，种子多的时候会花点时间，也消耗 API 额度。已经刮过的会跳过，过程中可以随时点「停止」。':
    'Each movie / series torrent will be looked up on TheTVDB and its poster downloaded. With many torrents this takes a while and uses API quota. Already-scraped ones are skipped, and you can stop at any time.',
  '开始刮削': 'Start scraping',
  '已停止刮削': 'Scraping stopped',
  '扫描缓存已清空，下次会重新扫描目录': 'Scan cache cleared — folders will be rescanned next time',
  '清空失败': 'Failed to clear',
  '清空 TheTVDB 缓存？': 'Clear the TheTVDB cache?',
  '会删除已下载的 TVDB 海报和搜索 / 作品图缓存。之后打开封面或重新刮削时会再次联网查询，消耗 API 额度。不影响目录缩略图和你上传的封面。':
    'Deletes downloaded TVDB posters plus cached searches and artwork. Covers and future scrapes will go online again and use API quota. Folder thumbnails and your own uploads are untouched.',
  'TheTVDB 缓存已清空，下次会重新联网刮削': 'TheTVDB cache cleared — the next scrape will go online',
  '清空目录图片缓存？': 'Clear the folder image cache?',
  '会删除自动生成的目录缩略图，之后按目录内容重新生成。不影响 TVDB 海报和你上传 / 挑选过的封面。':
    'Deletes auto-generated folder thumbnails; they are regenerated from the folder contents. TVDB posters and your own covers are untouched.',
  '目录图片缓存已清空，之后会按目录内容重新生成': 'Folder image cache cleared — thumbnails will be regenerated',
  '限速已应用': 'Rate limits applied',
  '刷新频率 {n}s': 'Refresh every {n}s',
  '已切换为手动刷新': 'Switched to manual refresh',
  '列表已显示缩略图': 'Thumbnails shown in the list',
  '列表已隐藏缩略图': 'Thumbnails hidden in the list',
  '已显示缩略图': 'Thumbnails shown',
  '已隐藏缩略图': 'Thumbnails hidden',
  '添加种子默认用 .torrent 文件': 'New torrents default to .torrent files',
  '添加种子默认用链接 / Magnet': 'New torrents default to links / magnets',
  '已退出登录': 'Signed out',
  '已切换限速模式': 'Rate limit mode toggled',

  /* ── 概览 ── */
  '速度趋势': 'Speed trend',
  '累计流量': 'Total traffic',
  '累计下载': 'Total downloaded',
  '累计上传': 'Total uploaded',
  '全局分享率': 'Global ratio',
  '连接状态': 'Connection',
  'DHT 节点': 'DHT nodes',
  '已连接 Peers': 'Connected peers',
  '备用速度': 'Alt speed',
  '切换备用速度限制': 'Toggle alternative rate limits',

  /* ── 侧边栏 / 登录 / SW ── */
  '展开侧边栏': 'Expand sidebar',
  '收起侧边栏': 'Collapse sidebar',
  '登录成功': 'Signed in',
  '用户名或密码错误': 'Wrong username or password',
  '登录失败': 'Sign-in failed',
  '登录中…': 'Signing in…',
  '登录': 'Sign in',
  '无法连接 qBittorrent': 'Cannot reach qBittorrent',
  '新版本已就绪，即将刷新': 'Update ready, reloading…',
  '已是最新版本': 'Already up to date',
  '检查失败：{msg}': 'Update check failed: {msg}',

  /* ══ 静态 HTML：语义 key（含 <code> / <a> 的长段落） ══ */
  'html.title': 'qBWebUI · Download console',
  'html.connecting': 'Connecting…',
  'html.side.categories': 'Categories',
  'html.side.newCategory': 'New category',
  'html.side.download': 'Down',
  'html.side.upload': 'Up',
  'html.bulk.selected': ' selected',
  'html.auth.via': 'Phone: ',
  'html.search.placeholder': 'Search torrents…',
  'html.col.name': 'Name',
  'html.col.size': 'Size',
  'html.col.progress': 'Progress',
  'html.col.dl': 'Down',
  'html.col.up': 'Up',
  'html.col.ratio': 'Ratio',
  'html.col.eta': 'ETA',
  'html.col.state': 'Status',
  'html.col.actions': 'Actions',
  'html.login.title': 'Sign in to qBittorrent',
  'html.login.user': 'Username',
  'html.login.pass': 'Password',
  'html.login.remember': 'Remember this device',
  'html.add.title': 'Add torrent',
  'html.add.tabLink': 'Link / Magnet',
  'html.add.tabFile': 'Torrent file',
  'html.add.urlsPlaceholder': 'One magnet link or .torrent URL per line\nmagnet:?xt=urn:btih:…',
  'html.add.dropText': 'Click to choose or drop .torrent files',
  'html.add.dropSub': 'Multiple files supported',
  'html.add.path': 'Save path',
  'html.add.pathPlaceholder': 'Default path',
  'html.add.pathPick': 'Choose from folders used before',
  'html.add.category': 'Category',
  'html.add.tags': 'Tags',
  'html.add.tagsPlaceholder': 'Comma separated, e.g. Movies, 4K',
  'html.add.coverTitle': 'Cover thumbnail',
  'html.add.coverHint': 'Optional',
  'html.add.coverName': 'Leave it empty',
  'html.add.coverDesc':
    'Uses an image from the torrent folder by default, otherwise a type icon. You can also paste one below.',
  'html.add.coverPick': 'Choose image',
  'html.add.coverPickTitle': 'Choose an image, or press ⌘/Ctrl+V',
  'html.add.pasteAria': 'Paste cover image',
  'html.add.pasteTitle': 'Long-press here to paste; ⌘/Ctrl+V works on desktop',
  'html.add.pastePlaceholder': 'Long-press to paste an image',
  'html.add.pastePlaceholderAlt': 'Long-press to paste',
  'html.add.kw': 'Keyword (default: parsed title)',
  'html.add.scrapeKw': 'Scrape keywords',
  'html.add.scrape': 'Scrape cover',
  'html.add.paused': 'Add paused',
  'html.add.seq': 'Sequential download',
  'html.add.submit': 'Start download',
  'html.cover.title': 'Cover & scrape',
  'html.cover.upload': 'Upload',
  'html.cover.uploadTitle': 'Choose an image, or press ⌘/Ctrl+V',
  'html.cover.icon': 'Use icon',
  'html.cover.auto': 'Auto',
  'html.cover.rescan': 'Rescan',
  'html.cover.rescanTitle': 'Read this torrent folder again (normally the cache never touches the disk)',
  'html.cover.dir': 'Images in folder',
  'html.cover.apply': 'Apply to media folder',
  'html.cover.applyTitle': 'Write the scraped poster and NFO into the torrent folder so Plex / Jellyfin / Kodi can read them',
  'html.cover.applyRemove': 'Remove',
  'html.cover.tvdb': 'TheTVDB scraping',
  'html.cover.tvdbQuery': 'Keywords (defaults to the torrent name — Enter to search)',
  'html.cover.tvdbType': 'Search type',
  'html.cover.tvdbAuto': 'Auto',
  'html.cover.tvdbSeries': 'Series',
  'html.cover.tvdbMovie': 'Movie',
  'html.cover.search': 'Search',
  'html.cover.back': 'Back',
  'html.cover.pick': 'Auto match',
  'html.cover.results': 'TheTVDB results',
  'html.cover.attr':
    'Metadata provided by <a href="https://www.thetvdb.com" target="_blank" rel="noreferrer">TheTVDB</a> · Posters belong to their respective owners; personal local use only',
  'html.set.title': 'Settings',
  'html.set.rate': 'Global rate limits',
  'html.set.dlLimit': 'Download limit (KB/s, 0 = unlimited)',
  'html.set.upLimit': 'Upload limit (KB/s, 0 = unlimited)',
  'html.set.alt': 'Enable alternative rate limits',
  'html.set.applyRate': 'Apply limits',
  'html.set.addBlock': 'Add torrent',
  'html.set.addMode': 'Default add mode',
  'html.set.addModeFile': 'Torrent file (.torrent)',
  'html.set.addModeLink': 'Link / Magnet',
  'html.set.addModeHint':
    'Which tab the add dialog opens on. You can switch any time; chosen files and pasted links are kept either way.',
  'html.set.look': 'Appearance',
  'html.set.theme': 'Theme',
  'html.set.themeSystem': 'Follow system',
  'html.set.themeDark': 'Dark',
  'html.set.themeLight': 'Light',
  'html.set.lang': 'Language',
  'html.set.langAuto': 'Follow browser',
  'html.set.interval': 'Refresh rate',
  'html.set.sec1': '1s',
  'html.set.sec2': '2s',
  'html.set.sec5': '5s',
  'html.set.manual': 'Manual',
  'html.set.thumbs': 'Show cover thumbnails in the list',
  'html.set.listTitle': 'List title',
  'html.set.listTitleHint': 'Media names come from TheTVDB',
  'html.set.titleOff': 'File name only',
  'html.set.titleMedia': 'Media name first · file name as subtitle',
  'html.set.titleOriginal': 'File name first · media name as subtitle',
  'html.set.cache': 'Cover cache',
  'html.set.clearScan': 'Clear scan cache',
  'html.set.clearTvdb': 'Clear TVDB cache',
  'html.set.clearImages': 'Clear folder image cache',
  'html.set.cacheHint':
    'Folders are scanned once and cached by torrent state for 6 hours (1 minute while downloading), persisted across restarts; image thumbnails live in <code>data/covers/</code>. “Clear TVDB cache” removes scraped posters and search records so they are fetched again; “Clear folder image cache” removes generated thumbnails so they are rebuilt from folder contents. Neither touches covers you uploaded or picked.',
  'html.set.tvdb': 'TheTVDB scraping',
  'html.set.tvdbEnable': 'Enable online poster scraping',
  'html.set.apiKey': 'API Key',
  'html.set.pin': 'Subscriber PIN',
  'html.set.pinHint': 'Not needed for most keys',
  'html.set.scrapeLang': 'Scrape language',
  'html.set.langHint': 'Titles / overviews',
  'html.set.langZho': 'Chinese (Simplified first, then Traditional)',
  'html.set.langZhtw': 'Chinese (Taiwan Traditional first)',
  'html.set.langYue': 'Cantonese',
  'html.set.langAny': 'Any (TheTVDB original)',
  'html.set.autoScrape': 'Auto scrape',
  'html.set.autoOff': 'Manual only',
  'html.set.autoNew': 'New movie / series torrents',
  'html.set.tvdbSave': 'Save and test',
  'html.set.tvdbScan': 'Scrape all movies & series',
  'html.set.stop': 'Stop',
  'html.set.tvdbHint':
    'Metadata from <a href="https://www.thetvdb.com" target="_blank" rel="noreferrer">TheTVDB</a>. The key is stored only on this machine in <code>data/tvdb.json</code> (never committed), or via <code>TVDB_API_KEY</code> / <code>TVDB_PIN</code>. Titles and overviews follow your language setting; the original title is kept as well (visible in the search subtitles and written to <code>originaltitle</code> in the NFO), falling back to the original when no translation exists. TheTVDB’s terms require attribution, which the cover dialog provides. After a successful scrape the poster and NFO are written into the torrent’s own folder following media-library conventions (movies: <code>video-poster.jpg</code> + <code>video.nfo</code>; series: <code>poster.jpg</code> + <code>tvshow.nfo</code>), so Plex / Jellyfin / Kodi pick them up directly. Discarding a scrape or clearing the TVDB cache deletes them as well.',
  'html.set.traffic': 'Total traffic',
  'html.set.totalDl': 'Total downloaded',
  'html.set.totalUp': 'Total uploaded',
  'html.set.ratio': 'Global ratio',
  'html.set.checkUpdate': 'Check for updates',
  'html.set.logout': 'Sign out',
  'html.set.overview': 'Overview',
  'html.confirm.title': 'Confirm',
  'html.path.history': 'Path history',
  'html.nav.torrents': 'Torrents',
  'html.nav.filter': 'Filter',
  'html.nav.stats': 'Overview',
  'html.nav.settings': 'Settings',
  'html.nav.add': 'Add torrent',
  'html.menu': 'Menu',
  'html.theme.toggle': 'Toggle theme',
  'html.thumbs.toggle': 'Show / hide thumbnails',
  'html.alt.toggle': 'Alternative rate limits',
  'html.sidebar.collapse': 'Collapse sidebar',
  'html.sidebar.close': 'Close',
};

/* 语义 key 的中文原文：EN 有、ZH 也得有，否则切回中文会露出 key */
const ZH = {
  'html.title': 'qBWebUI · 下载控制台',
  'html.connecting': '连接中…',
  'html.side.categories': '分类',
  'html.side.newCategory': '新建分类',
  'html.side.download': '下载',
  'html.side.upload': '上传',
  'html.bulk.selected': ' 项已选',
  'html.auth.via': '手机访问：',
  'html.search.placeholder': '搜索种子名称…',
  'html.col.name': '名称',
  'html.col.size': '大小',
  'html.col.progress': '进度',
  'html.col.dl': '下载',
  'html.col.up': '上传',
  'html.col.ratio': '分享率',
  'html.col.eta': '剩余',
  'html.col.state': '状态',
  'html.col.actions': '操作',
  'html.login.title': '登录 qBittorrent',
  'html.login.user': '用户名',
  'html.login.pass': '密码',
  'html.login.remember': '记住这台设备',
  'html.add.title': '添加种子',
  'html.add.tabLink': '链接 / Magnet',
  'html.add.tabFile': '种子文件',
  'html.add.urlsPlaceholder': '每行一个 magnet 链接或 .torrent 网址\nmagnet:?xt=urn:btih:…',
  'html.add.dropText': '点击选择或拖入 .torrent 文件',
  'html.add.dropSub': '支持多选',
  'html.add.path': '保存路径',
  'html.add.pathPlaceholder': '默认路径',
  'html.add.pathPick': '选择历史目录',
  'html.add.category': '分类',
  'html.add.tags': '标签',
  'html.add.tagsPlaceholder': '用逗号分隔，例如：电影, 4K',
  'html.add.coverTitle': '封面缩略图',
  'html.add.coverHint': '可选',
  'html.add.coverName': '不设置也可以',
  'html.add.coverDesc': '默认用种子目录里的图片，没有就显示类型图标；也可以在下面直接粘一张',
  'html.add.coverPick': '选择图片',
  'html.add.coverPickTitle': '选择图片，或直接 ⌘/Ctrl+V 粘贴',
  'html.add.pasteAria': '粘贴封面图片',
  'html.add.pasteTitle': '长按这里粘贴，桌面也可以直接 ⌘/Ctrl+V',
  'html.add.pastePlaceholder': '长按这里粘贴图片',
  'html.add.pastePlaceholderAlt': '长按粘贴图片',
  'html.add.kw': '搜索关键词（默认取种子里认出的片名，可改）',
  'html.add.scrapeKw': '刮削搜索关键词',
  'html.add.scrape': '刮削封面',
  'html.add.paused': '添加后暂停',
  'html.add.seq': '顺序下载',
  'html.add.submit': '开始下载',
  'html.cover.title': '封面•刮削',
  'html.cover.upload': '上传',
  'html.cover.uploadTitle': '选择图片，或直接 ⌘/Ctrl+V 粘贴',
  'html.cover.icon': '用图标',
  'html.cover.auto': '自动',
  'html.cover.rescan': '重新扫描',
  'html.cover.rescanTitle': '重新读一遍这个种子的目录（平时走缓存，不会去打扰磁盘）',
  'html.cover.dir': '目录中的图片',
  'html.cover.apply': '应用到媒体目录',
  'html.cover.applyTitle': '把刮削到的海报和 NFO 写进种子所在目录，供 Plex / Jellyfin / Kodi 识别',
  'html.cover.applyRemove': '移除',
  'html.cover.tvdb': 'TheTVDB 刮削',
  'html.cover.tvdbQuery': '关键词（默认取种子名，可改，回车重搜）',
  'html.cover.tvdbType': '搜索类型',
  'html.cover.tvdbAuto': '自动',
  'html.cover.tvdbSeries': '剧集',
  'html.cover.tvdbMovie': '电影',
  'html.cover.search': '搜索',
  'html.cover.back': '返回',
  'html.cover.pick': '自动匹配',
  'html.cover.results': 'TheTVDB 搜索结果',
  'html.cover.attr':
    'Metadata provided by <a href="https://www.thetvdb.com" target="_blank" rel="noreferrer">TheTVDB</a> · 海报版权归各自权利人，仅限个人本地使用',
  'html.set.title': '设置',
  'html.set.rate': '全局限速',
  'html.set.dlLimit': '下载上限 (KB/s，0 = 不限)',
  'html.set.upLimit': '上传上限 (KB/s，0 = 不限)',
  'html.set.alt': '启用备用速度限制',
  'html.set.applyRate': '应用限速',
  'html.set.addBlock': '添加种子',
  'html.set.addMode': '默认添加方式',
  'html.set.addModeFile': '种子文件（.torrent）',
  'html.set.addModeLink': '链接 / Magnet',
  'html.set.addModeHint':
    '打开「添加种子」时默认停在哪一页。另一页随时能切，选过的文件和粘过的链接都不会因为切换丢失。',
  'html.set.look': '外观',
  'html.set.theme': '主题',
  'html.set.themeSystem': '跟随系统',
  'html.set.themeDark': '深色',
  'html.set.themeLight': '浅色',
  'html.set.lang': '语言',
  'html.set.langAuto': '跟随浏览器',
  'html.set.interval': '刷新频率',
  'html.set.sec1': '1 秒',
  'html.set.sec2': '2 秒',
  'html.set.sec5': '5 秒',
  'html.set.manual': '手动',
  'html.set.thumbs': '在列表中显示封面缩略图',
  'html.set.listTitle': '列表标题',
  'html.set.listTitleHint': '媒体名来自 TheTVDB 刮削',
  'html.set.titleOff': '只显示原始文件名',
  'html.set.titleMedia': '媒体名为主 · 原始文件名为副',
  'html.set.titleOriginal': '原始文件名为主 · 媒体名为副',
  'html.set.cache': '封面缓存',
  'html.set.clearScan': '清空扫描缓存',
  'html.set.clearTvdb': '清空 TVDB 缓存',
  'html.set.clearImages': '清空目录图片缓存',
  'html.set.cacheHint':
    '目录只扫一次：结果按种子状态缓存 6 小时（下载中的 1 分钟）并落盘，重启后仍生效；图片缩略图缓存在 <code>data/covers/</code>。「清空 TVDB 缓存」删掉联网刮削的海报和搜索记录，之后重新刮削；「清空目录图片缓存」删掉自动生成的缩略图，之后按目录内容重新生成。两者都不会删除你上传 / 挑选过的封面。',
  'html.set.tvdb': 'TheTVDB 刮削',
  'html.set.tvdbEnable': '启用在线海报刮削',
  'html.set.apiKey': 'API Key',
  'html.set.pin': '订阅者 PIN',
  'html.set.pinHint': '多数 key 不需要',
  'html.set.scrapeLang': '刮削语言',
  'html.set.langHint': '译名 / 简介',
  'html.set.langZho': '中文（简体优先，缺则繁体）',
  'html.set.langZhtw': '中文（臺灣繁體優先）',
  'html.set.langYue': '粵語',
  'html.set.langAny': '不限（用 TVDB 原名）',
  'html.set.autoScrape': '自动刮削',
  'html.set.autoOff': '仅手动',
  'html.set.autoNew': '新加入的影视种子',
  'html.set.tvdbSave': '保存并测试',
  'html.set.tvdbScan': '刮削全部影视种子',
  'html.set.stop': '停止',
  'html.set.tvdbHint':
    '元数据来自 <a href="https://www.thetvdb.com" target="_blank" rel="noreferrer">TheTVDB</a>。密钥只存在本机 <code>data/tvdb.json</code>（不会进仓库），也可以改用环境变量 <code>TVDB_API_KEY</code> / <code>TVDB_PIN</code>。默认按中文刮削：片名和剧情简介取 TheTVDB 的中文译名，英文名会一并保留（搜索结果副标题里能看到，写进 NFO 的 <code>originaltitle</code>），没有中文译名的作品自动回落到原名。TheTVDB 的服务条款要求展示来源，本项目已在封面弹窗给出链接。刮削成功后会把海报和 NFO 按媒体库约定写进种子自己的目录（电影 <code>视频名-poster.jpg</code> + <code>视频名.nfo</code>，剧集 <code>poster.jpg</code> + <code>tvshow.nfo</code>），Plex / Jellyfin / Kodi 可直接识别；放弃刮削或清空 TVDB 缓存时会一并删掉。',
  'html.set.traffic': '累计流量',
  'html.set.totalDl': '累计下载',
  'html.set.totalUp': '累计上传',
  'html.set.ratio': '全局分享率',
  'html.set.checkUpdate': '检查界面更新',
  'html.set.logout': '退出登录',
  'html.set.overview': '概览',
  'html.confirm.title': '确认操作',
  'html.path.history': '历史保存路径',
  'html.nav.torrents': '种子',
  'html.nav.filter': '筛选',
  'html.nav.stats': '概览',
  'html.nav.settings': '设置',
  'html.nav.add': '添加种子',
  'html.menu': '菜单',
  'html.theme.toggle': '切换主题',
  'html.thumbs.toggle': '显示 / 隐藏缩略图',
  'html.alt.toggle': '备用速度限制',
  'html.sidebar.collapse': '收起侧边栏',
  'html.sidebar.close': '关闭',
};

/* ── 语言状态 ─────────────────────────────────────────── */

let lang = detectLang();
const listeners = new Set();

function detectLang() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch { /* 隐私模式读不到 localStorage 就当没存过 */ }
  const nav = navigator.languages?.length ? navigator.languages : [navigator.language || ''];
  return nav.some((l) => /^zh\b/i.test(String(l))) ? 'zh' : 'en';
}

export const getLang = () => lang;
/** BCP 47 标签：日期 / 数字 / 排序都按它走 */
export const localeTag = () => (lang === 'en' ? 'en-US' : 'zh-CN');

/** 手动切换（顶栏按钮 / 设置里的下拉都走这里）。null = 跟随浏览器 */
export function setLang(next) {
  if (next === null) {
    try { localStorage.removeItem(LANG_KEY); } catch { /* 忽略 */ }
    lang = detectLang();
  } else {
    lang = next === 'en' ? 'en' : 'zh';
    try { localStorage.setItem(LANG_KEY, lang); } catch { /* 忽略 */ }
  }
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  document.documentElement.dataset.lang = lang;
  applyDom();
  listeners.forEach((fn) => { try { fn(lang); } catch (err) { console.error('[i18n]', err); } });
}

/** 语言变化时回调（app.js 用它重画列表 / 详情） */
export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 取译文。key 是中文原文；vars 里的 {name} 会被替换。
 * 英文缺失时回落中文原文，再回落 ZH 词典里的语义 key。
 */
export function t(key, vars) {
  if (key === null || key === undefined) return '';
  let out;
  if (lang === 'en') {
    const v = EN[key];
    if (typeof v === 'function') return v(vars || {});
    out = v ?? ZH[key] ?? key;
  } else {
    out = ZH[key] ?? key;
  }
  if (vars && typeof out === 'string') {
    out = out.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
  }
  return out;
}

/* ── DOM 批量替换 ─────────────────────────────────────── */

/*
 * 约定：属性值**就是 key**，静态页面的 key 统一是 html.*（中英都写在词典里）。
 *   data-i18n="key"              换 textContent（叶子节点）
 *   data-i18n-text="key"         只换最后一个文本节点（图标 + 文字并排的按钮，
 *                                直接写 textContent 会把前面那个 <svg> 抹掉）
 *   data-i18n-html="key"         换 innerHTML（带 <code> / <a> 的长段落）
 *   data-i18n-title="key"        title 属性
 *   data-i18n-placeholder="key"  placeholder 属性
 *   data-i18n-aria="key"         aria-label 属性
 * 由 JS 动态写入内容的节点不要标这些属性，否则切语言时会被静态文案盖掉。
 */

/** 只换元素里最后一个文本节点（保留两侧空白，图标和文字之间的间距靠它撑着） */
function swapLastText(el, next) {
  let node = null;
  for (let i = el.childNodes.length - 1; i >= 0; i--) {
    if (el.childNodes[i].nodeType === 3) { node = el.childNodes[i]; break; }
  }
  if (!node) {
    // 没有文本节点（例如只剩一个 <svg>）就补一个，至少别把文案丢了
    el.append(document.createTextNode(next));
    return;
  }
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(node.nodeValue) || ['', '', '', ''];
  const val = `${m[1]}${next}${m[3]}`;
  if (node.nodeValue !== val) node.nodeValue = val;
}

/** 把 root 范围内所有标了 data-i18n* 的节点刷一遍 */
export function applyDom(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const next = t(el.dataset.i18n);
    if (el.textContent !== next) el.textContent = next;
  }
  for (const el of root.querySelectorAll('[data-i18n-text]')) swapLastText(el, t(el.dataset.i18nText));
  for (const el of root.querySelectorAll('[data-i18n-html]')) {
    const next = t(el.dataset.i18nHtml);
    if (el.innerHTML !== next) el.innerHTML = next;
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    const next = t(el.dataset.i18nTitle);
    if (el.getAttribute('title') !== next) el.setAttribute('title', next);
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    const next = t(el.dataset.i18nPlaceholder);
    if (el.getAttribute('placeholder') !== next) el.setAttribute('placeholder', next);
  }
  for (const el of root.querySelectorAll('[data-i18n-aria]')) {
    const next = t(el.dataset.i18nAria);
    if (el.getAttribute('aria-label') !== next) el.setAttribute('aria-label', next);
  }
  // 粘贴框的占位文字走 data-placeholder（CSS 用 content: attr() 渲染）
  for (const el of root.querySelectorAll('[data-i18n-data-placeholder]')) {
    const next = t(el.dataset.i18nDataPlaceholder);
    if (el.getAttribute('data-placeholder') !== next) el.setAttribute('data-placeholder', next);
  }
}

/* 首屏：非中文界面先把 body 藏住，等翻译铺完再显示，避免闪一下中文 */
export function bootI18n() {
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  document.documentElement.dataset.lang = lang;
  const flush = () => {
    applyDom();
    document.documentElement.classList.remove('i18n-pending');
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', flush, { once: true });
  else flush();
}

export const LANGS = [
  { id: 'zh', label: '中文' },
  { id: 'en', label: 'English' },
];
