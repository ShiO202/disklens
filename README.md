# DiskLens

> 把硬盘摊开给你看 —— 矩形面积就是真实占用，一眼看出空间被谁吃掉了。

Windows 磁盘空间可视化分析与清理辅助工具。本地运行，扫描全程只读。

```
┌──────────────────────────────────────────────────────────────┐
│  ▦ DiskLens            C: ▓▓▓▓▓▓▓▓░░  151 GB 可用 / 476 GB   │
├───────────────────────────────────┬──────────────────────────┤
│  C:\ › Users › AppData            │  详情 │ 清理建议 │ 设置  │
│  ┌─────────────────────────────┐  │ ──────────────────────── │
│  │  ┌──────┬────────┬────────┐ │  │  ● 可直接清理             │
│  │  │      │        │        │ │  │  uv 包缓存                │
│  │  │ 大块 │  缓存  │  模型  │ │  │  6.04 GB · 占上层 11.8%   │
│  │  │  =    │        │        │ │  │                          │
│  │  │ 大文件│       ├────────┤ │  │  体积集中 100% 在         │
│  │  │      │        │  日志   │ │  │  archive-v0               │
│  │  └──────┴────────┴────────┘ │  │  最后修改 3 天前          │
│  └─────────────────────────────┘  │                          │
│  ● 可直接清理  ● 有代价  ● 需确认    │  [✦ 深度分析] [⚠ 删除]    │
└───────────────────────────────────┴──────────────────────────┘
```

## 特性

**可视化**
- Squarified 矩形树图，块尽量接近正方形
- 递归 4 层：外层文件夹展开显示内部构成
- 斜纹标记「整体功能单元」（`node_modules`、`.venv`、游戏本体这类拆开没意义的目录）
- 点击选中、双击下钻、面包屑回退、悬停预览

**判断力**
- 内置 **105 条 Windows 清理规则**，覆盖系统缓存、开发工具链、AI 模型、应用数据、虚拟化等
- **证据驱动分析**：现测体积构成、文件类型、修改时间分布，结论里的每个数字都是实数
- 可选 **AI 深度分析**：接入任意 OpenAI 兼容接口，并支持在分析结果上继续追问

**操作**
- 安全删除（回收站 / 永久删除，多重护栏）
- 多选批量删除（`Ctrl + 点击`）
- 忽略列表（支持通配符），矩形视图不再显示无关目录
- 单目录重扫，不用全盘重来

---

## 快速开始

### 方式一：桌面应用（推荐）

```bash
npm install
npm run dist          # 产物在 dist/DiskLens-win32-x64/
```

双击 `DiskLens.exe` 即可，无需浏览器、无需命令行。用户数据存在 `%APPDATA%\DiskLens\data`。

### 方式二：本地 Web

```bash
npm install
node server.mjs --open
```

浏览器访问 `http://127.0.0.1:7788/`。

> 运行期零依赖，`node server.mjs` 不装 node_modules 也能跑；`npm install` 只有打包桌面版时才需要。

首次点「扫描」，全盘约 1~3 分钟（取决于文件数量）。结果自动缓存，下次秒开。

---

## 它怎么判断

三层，从硬到软：

### 1. 内置规则库（`lib/rules.mjs`）

按路径模式匹配 105 条规则，给出用途、安全等级、建议动作。覆盖：

| 类别 | 例子 |
| --- | --- |
| 系统 | `Windows\Temp`、`SoftwareDistribution\Download`、`WinSxS`、`Installer`、`Prefetch`、`LiveKernelReports`、`Minidump`、`Windows.old`、回收站、卷影副本、`hiberfil.sys` |
| 浏览器 | Chrome / Edge / Firefox 的 Cache、Code Cache、GPUCache、Service Worker |
| 开发链 | `node_modules`、npm / pnpm / yarn / pip / uv / conda / gradle / maven / nuget / cargo 缓存、`__pycache__`、`venv`、`target`、`dist`、`.git`、JetBrains 索引、Android SDK |
| AI | HuggingFace Hub、PyTorch Hub、Whisper、Ollama、ComfyUI、Stable Diffusion |
| 应用 | 微信 / QQ / 钉钉 / Office / Teams / Discord / Adobe 媒体缓存 / 百度网盘 |
| 游戏 | Steam（本体 / 下载残留 / 创意工坊）、Epic、战网 |
| 虚拟化 | WSL `ext4.vhdx`、Docker、VirtualBox / VMware / Hyper-V 镜像、ISO |

安全等级分四档：`safe`（删了自动重建）、`caution`（要重新下载/编译）、`danger`（含用户数据）、`keep`（系统关键，勿删）。

### 2. 证据驱动分析（`lib/localanalyze.mjs`）

点「深度分析」时，会先对目标做一次真实浅扫，拿到：

- **体积构成** —— 最大子项占多少
- **文件类型** —— 以什么为主（`.mp4` / `.dll` / `.whl`…）
- **时间分布** —— 多少体积超过 90 天没动过

然后结合规则给结论。比如同样是 `.venv`：

- 最近 3 天还在写入 → 「谨慎删除，先确认项目没在跑」
- 90% 超过 90 天没动 → 「可以删除，不会影响正在用的东西」

### 3. AI 深度分析（可选）

配置 API Key 后，把实测证据一起喂给模型，返回结构化结论并可继续追问。

支持任意 OpenAI 兼容接口：OpenAI、火山方舟、通义、DeepSeek、本地 vLLM / Ollama 都行。

---

## 安全设计

**扫描是只读的。** 只读取大小和时间戳，不修改任何文件。

删除是独立功能，四层护栏：

| 护栏 | 说明 |
| --- | --- |
| ① 路径黑名单 | 盘根、`Windows`、`Program Files`、`Users` 根、`AppData` 根、`System Volume Information`、`pagefile.sys` 等在**服务端**直接拒绝，前端绕不过去 |
| ② 等级限制 | `danger` / `keep` 级别**禁止永久删除**，只能进回收站 |
| ③ 二次确认 | 弹窗里完整列出路径、大小、文件数，需手动点确认 |
| ④ 默认回收站 | 默认走回收站，可恢复；永久删除要主动切换 |

另外：

- 所有删除写入 `data/deletions.jsonl`（时间、路径、模式、结果）
- 删除成功后从内存树摘除节点，统计立刻更新
- 服务只监听 `127.0.0.1`

对于 `keep` 级别的系统组件（WinSxS、DriverStore、Installer），工具会明确提示**只能用 DISM / pnputil 等系统工具处理**。

---

## AI 配置

设置页 → AI 分析：

| 字段 | 说明 |
| --- | --- |
| 接口地址 | OpenAI 兼容的 base URL，如 `https://api.openai.com/v1` |
| 模型 | 如 `gpt-4o-mini` |
| API Key | 存在本地 `data/settings.json`，不上传任何地方 |
| 环境变量名 | 也可以把 Key 放环境变量，工具自动读取（密钥不落盘） |

不配 AI 也完全可用 —— 规则库 + 证据分析覆盖了绝大多数场景，而且更确定、更快、不花钱。

---

## 技术栈

零运行时依赖，只用 Node 内置模块。

```
disk-analyzer/
├── server.mjs              # HTTP 服务 + API + 删除/忽略/重扫
├── lib/
│   ├── scanner.mjs         # 递归扫描（并发限流、小项聚合、时间分布统计）
│   ├── rules.mjs           # 105 条 Windows 清理规则 + 启发式兜底
│   ├── localanalyze.mjs    # 证据驱动分析
│   └── ai.mjs              # OpenAI 兼容调用 + 多轮追问 + 本地兜底
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js              # Squarified Treemap 渲染 + 交互
├── electron/
│   ├── main.cjs            # 桌面版主进程
│   └── make-icon.ps1       # 图标生成
└── build/icon.ico
```

**几个设计取舍：**

- **小项聚合**：小于 48 KB 的项不单独建节点，每层最多 512 个子项。20 万节点的树压到 2 万，前端不掉帧
- **双 Canvas**：底图只在数据变化时重绘，鼠标交互只重绘 overlay 层
- **预览树**：后端下发 3 层预览，前端递归渲染 4 层，大块内部有结构
- **SSE 进度**：扫描进度实时推送，不轮询

---

## API

想在脚本里调用也可以（服务默认监听 `127.0.0.1:7788`）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/status` | 磁盘容量、规则数、AI 状态、上次扫描 |
| POST | `/api/scan` | `{root}` 启动扫描 |
| GET | `/api/scan/stream?id=` | SSE 进度流 |
| GET | `/api/children?id=&path=` | 某目录的子层数据 |
| GET | `/api/candidates?id=` | 清理候选清单 |
| POST | `/api/analyze` | `{path}` 深度分析 |
| POST | `/api/chat` | `{context, messages}` 分析后追问 |
| POST | `/api/rescan` | `{path}` 单目录重扫 |
| POST | `/api/delete` | `{path, mode}` 删除（`recycle` / `permanent`） |
| POST | `/api/delete/batch` | `{paths[], mode}` 批量删除 |
| GET/POST | `/api/ignore` | 忽略列表 |
| GET | `/api/rule?path=` | 只查规则库结论（不调 AI） |
| POST | `/api/reveal` | `{path, mode}` 在资源管理器打开/定位 |

---

## 常见问题

**扫描慢？**
全盘要读几十万文件的大小，1~3 分钟正常。可以在设置里调大「小项聚合阈值」提速，或者只扫重点目录。

**有些目录扫不到？**
系统保护目录需要管理员权限。用管理员身份运行可以扫得更全。

**树图里有些块点不进去？**
那些是被聚合的小项。底部会提示「另有 N 个小项已聚合」。

**AI 分析结果靠谱吗？**
当第二意见，不是判决。规则库的判断更硬（基于实际目录约定），AI 更擅长解释和归纳。两者冲突时倾向保守。

---

## License

MIT
