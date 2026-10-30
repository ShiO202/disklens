/**
 * Windows 磁盘清理知识库
 * 纯规则引擎：路径 / 目录名 / 扩展名 → 用途说明 + 安全等级 + 建议动作
 *
 * 安全等级：
 *   safe    删除无副作用，系统或应用会自动重建（缓存、临时文件、日志）
 *   caution 可删但要有代价：需要重新下载 / 重新编译 / 功能暂时失效
 *   danger  可能包含你的数据，必须先确认（聊天记录、模型、项目、下载）
 *   keep    系统关键，不要手动删（用系统自带工具处理）
 *   unknown 规则未覆盖，交给 AI / 人工判断
 */

const RULES = [
  // ============================ 系统缓存 / 临时 ============================
  {
    id: 'win-temp', cat: '系统缓存', safety: 'safe',
    title: 'Windows 临时文件夹',
    purpose: '系统与应用程序运行时产生的临时文件，安装包解压残留、驱动安装中间文件等。重启后大部分失效。',
    action: '整体删除，正在占用的文件会自动跳过。',
    startsWith: ['c:\\windows\\temp'],
  },
  {
    id: 'win-update-download', cat: '系统缓存', safety: 'safe',
    title: 'Windows 更新下载缓存',
    purpose: 'Windows Update 下载的补丁包，安装完成后即可清理。装完的下次还会重下但通常已装好。',
    action: '停止 wuauserv 服务后删除 SoftwareDistribution\\Download。',
    startsWith: ['c:\\windows\\softwaredistribution\\download'],
  },
  {
    id: 'win-softwaredistribution', cat: '系统缓存', safety: 'caution',
    title: 'Windows 更新组件数据',
    purpose: '更新组件的元数据与失败补丁残留。清理可解决"更新卡住"，但会清空更新历史。',
    action: '优先用「磁盘清理 → 清理系统文件」。',
    startsWith: ['c:\\windows\\softwaredistribution'],
  },
  {
    id: 'win-installer', cat: '系统安装缓存', safety: 'danger',
    title: 'Windows Installer 安装缓存',
    purpose: 'MSI 安装包的本地副本，卸载 / 修复 / 更新任何 MSI 程序都要用它。删了会导致程序无法卸载或修复。',
    action: '不要手动删。仅在用 PatchCleaner 等工具识别出"孤儿补丁"时清理。',
    startsWith: ['c:\\windows\\installer'],
  },
  {
    id: 'win-winsxs', cat: '系统组件', safety: 'keep',
    title: 'WinSxS 组件存储',
    purpose: '系统组件与更新备份，支撑系统回滚与功能启用。绝对不要手动删除（会导致系统无法更新/启动）。',
    action: '只能用：DISM /Online /Cleanup-Image /StartComponentCleanup /ResetBase',
    startsWith: ['c:\\windows\\winsxs'],
  },
  {
    id: 'win-prefetch', cat: '系统缓存', safety: 'safe',
    title: 'Prefetch 预读缓存',
    purpose: '记录程序启动时的磁盘访问模式，用于加速下次启动。删除只会让首次启动略慢。',
    action: '可整体删除。',
    startsWith: ['c:\\windows\\prefetch'],
  },
  {
    id: 'win-logs', cat: '系统日志', safety: 'safe',
    title: 'Windows 日志目录',
    purpose: '系统与组件运行日志（CBS、DISM、驱动安装等）。排障时才有用。',
    action: '可删除，正在被写入的文件跳过。',
    startsWith: ['c:\\windows\\logs'],
  },
  {
    id: 'win-livekernel', cat: '系统转储', safety: 'safe',
    title: '内核实时转储',
    purpose: '蓝屏 / 驱动崩溃时抓取的内核内存转储，单个可达数百 MB 到数 GB。',
    action: '若近期没有排查蓝屏的需求，可全部删除。',
    startsWith: ['c:\\windows\\livekernelreports'],
  },
  {
    id: 'win-minidump', cat: '系统转储', safety: 'safe',
    title: '蓝屏小转储 (Minidump)',
    purpose: '蓝屏时保存的最小内存转储，用于分析崩溃原因。',
    action: '排查完可删。建议保留最近一次。',
    startsWith: ['c:\\windows\\minidump'],
  },
  {
    id: 'win-memorydmp', cat: '系统转储', safety: 'safe',
    title: '完整内存转储 MEMORY.DMP',
    purpose: '蓝屏时导出的完整物理内存，通常等于内存条容量（可能 8~64 GB）。',
    action: '可直接删除；如需保留排查，改系统设置中的转储类型为「小内存转储」。',
    startsWith: ['c:\\windows\\memory.dmp'],
  },
  {
    id: 'win-driverstore', cat: '系统组件', safety: 'keep',
    title: 'DriverStore 驱动仓库',
    purpose: '所有已安装驱动的备份文件，设备回滚依赖它。',
    action: '不要手动删。可用 pnputil /enum-drivers 清理旧版第三方驱动。',
    startsWith: ['c:\\windows\\system32\\driverstore'],
  },
  {
    id: 'win-driverstore-file', cat: '系统组件', safety: 'keep',
    title: '驱动安装文件',
    purpose: '系统的驱动安装组件。',
    action: '不要手动删除。',
    startsWith: ['c:\\windows\\system32\\drivers'],
  },
  {
    id: 'win-old', cat: '系统备份', safety: 'caution',
    title: 'Windows.old 旧系统备份',
    purpose: '系统升级后保留的旧版本文件，用于「回到上一个版本」。通常 10~30 GB。',
    action: '确认新系统稳定后，用「磁盘清理 → 以前的 Windows 安装」删除（不要手删）。',
    startsWith: ['c:\\windows.old'],
  },
  {
    id: 'win-csc', cat: '系统缓存', safety: 'caution',
    title: '离线文件缓存 (CSC)',
    purpose: '脱机文件 / 网络共享同步缓存。',
    action: '若不用「脱机文件」，可通过控制面板清理。',
    startsWith: ['c:\\windows\\csc'],
  },
  {
    id: 'win-servicing', cat: '系统组件', safety: 'keep',
    title: 'Windows 服务组件',
    purpose: '系统更新服务的工作目录。',
    action: '不要手动删除。',
    startsWith: ['c:\\windows\\servicing'],
  },
  {
    id: 'win-assembly', cat: '系统组件', safety: 'keep',
    title: '.NET 程序集缓存',
    purpose: '.NET GAC 全局程序集缓存。',
    action: '不要手动删除。',
    includes: ['\\windows\\assembly\\', '\\microsoft.net\\assembly\\'],
  },
  {
    id: 'win-fonts', cat: '系统资源', safety: 'keep',
    title: '系统字体',
    purpose: '系统与软件共用的字体文件。',
    action: '不要删除（可卸载自己安装的第三方字体）。',
    startsWith: ['c:\\windows\\fonts'],
  },
  {
    id: 'recycle-bin', cat: '回收站', safety: 'safe',
    title: '回收站',
    purpose: '已删除但尚未彻底清除的文件。是否可清取决于你是否还需要找回。',
    action: '确认无需找回后清空回收站。',
    startsWith: ['c:\\$recycle.bin'],
  },
  {
    id: 'system-volume-info', cat: '系统还原', safety: 'keep',
    title: '卷影副本 / 系统还原点',
    purpose: '系统还原点、文件历史版本（Previous Versions）。占用常常高达数十 GB。',
    action: '不要手删。用「系统属性 → 系统保护 → 配置 → 删除」或调小最大使用量。',
    startsWith: ['c:\\system volume information'],
  },
  {
    id: 'hiberfil', cat: '系统文件', safety: 'caution',
    title: '休眠文件 hiberfil.sys',
    purpose: '休眠 / 快速启动时把内存写入磁盘的文件，大小约等于物理内存的 40%~100%。',
    action: '不用休眠可在管理员 CMD 执行：powercfg /h off（顺带关闭快速启动）。',
    startsWith: ['c:\\hiberfil.sys'],
  },
  {
    id: 'pagefile', cat: '系统文件', safety: 'keep',
    title: '虚拟内存 pagefile.sys',
    purpose: '物理内存不足时的交换空间。',
    action: '不建议删。可调小或移到别的盘（系统属性 → 高级 → 性能 → 虚拟内存）。',
    startsWith: ['c:\\pagefile.sys', 'c:\\swapfile.sys'],
  },
  {
    id: 'programdata-package-cache', cat: '系统安装缓存', safety: 'caution',
    title: 'Package Cache 安装包缓存',
    purpose: 'VS、VC++ 运行库等安装程序的本地缓存，修复/卸载时可能需要。',
    action: '保守做法：保留。确认没有需要修复的软件后可删（会导致修复失效）。',
    startsWith: ['c:\\programdata\\package cache'],
  },
  {
    id: 'wer', cat: '错误报告', safety: 'safe',
    title: 'Windows 错误报告 (WER)',
    purpose: '程序崩溃时生成的诊断报告与转储。',
    action: '可整体删除。',
    includes: ['\\windows\\wer\\', '\\programdata\\microsoft\\windows\\wer\\'],
  },
  {
    id: 'defender-scans', cat: '安全软件缓存', safety: 'safe',
    title: 'Defender 扫描缓存',
    purpose: '杀毒扫描的临时数据。',
    action: '可删，下次扫描会重建。',
    startsWith: ['c:\\programdata\\microsoft\\windows defender\\scans'],
  },

  // ============================ 用户级临时 / 缓存 ============================
  {
    id: 'user-temp', cat: '系统缓存', safety: 'safe',
    title: '用户临时文件夹',
    purpose: '当前用户与程序产生的临时文件，安装程序解压残留最多。',
    action: '整体删除，占用中的跳过。',
    includes: ['\\appdata\\local\\temp'],
  },
  {
    id: 'inetcache', cat: '浏览器缓存', safety: 'safe',
    title: 'IE / 系统网络缓存',
    purpose: '系统级网页缓存与 Cookie 数据库。',
    action: '可删（会退出部分登录态）。',
    includes: ['\\appdata\\local\\microsoft\\windows\\inetcache'],
  },
  {
    id: 'thumbcache', cat: '缩略图缓存', safety: 'safe',
    title: '缩略图 / 图标缓存',
    purpose: '资源管理器为图片、视频生成的预览图数据库（thumbcache_*.db、iconcache.db）。',
    action: '可删，系统会自动重建（第一次打开文件夹会慢一点）。',
    includes: ['\\appdata\\local\\microsoft\\windows\\explorer'],
  },
  {
    id: 'webcache', cat: '系统缓存', safety: 'caution',
    title: 'WebCache 网络缓存',
    purpose: '系统组件的 HTTP 缓存与 Cookie。',
    action: '可删，个别应用登录态可能丢失。',
    includes: ['\\appdata\\local\\microsoft\\windows\\webcache'],
  },
  {
    id: 'crashdumps', cat: '崩溃转储', safety: 'safe',
    title: '应用崩溃转储',
    purpose: '程序崩溃瞬间的内存快照，单个几十 MB 到数 GB。',
    action: '可整体删除。',
    includes: ['\\appdata\\local\\crashdumps'],
  },
  {
    id: 'uwp-localcache', cat: '应用缓存', safety: 'safe',
    title: 'UWP 应用缓存',
    purpose: '微软商店应用（含系统自带应用）的本地缓存。',
    action: '可删。若某个应用异常，可用设置里的「重置」更彻底。',
    includes: ['\\appdata\\local\\packages\\'],
    endsWith: ['\\localcache', '\\tempstate', '\\ac\\temp'],
  },
  {
    id: 'd3dscache', cat: '显卡缓存', safety: 'safe',
    title: 'DirectX 着色器缓存',
    purpose: 'GPU 编译好的着色器缓存，加速游戏/应用启动。',
    action: '可删，游戏首次加载会重新编译（略慢）。',
    includes: ['\\d3dscache'],
  },
  {
    id: 'nvidia-cache', cat: '显卡缓存', safety: 'safe',
    title: 'NVIDIA 着色器缓存',
    purpose: 'NVIDIA 驱动的 DXCache/GLCache 着色器缓存，常占用数 GB。',
    action: '可删，可同时在 NVIDIA 控制面板限制缓存大小。',
    includes: ['\\appdata\\local\\nvidia\\'],
  },
  {
    id: 'amd-cache', cat: '显卡缓存', safety: 'safe',
    title: 'AMD 着色器缓存',
    purpose: 'AMD 驱动的 DxCache/VkCache 缓存。',
    action: '可删。',
    includes: ['\\appdata\\local\\amd\\'],
  },
  {
    id: 'chrome-cache', cat: '浏览器缓存', safety: 'safe',
    title: 'Chrome 缓存',
    purpose: '网页资源缓存、GPU 缓存、Service Worker 脚本。删了只影响加载速度，不影响书签和历史。',
    action: '可整体删除（建议先关闭 Chrome）。',
    includes: ['\\google\\chrome\\user data\\'],
    endsWith: ['\\cache', '\\code cache', '\\gpucache', '\\service worker', '\\shadercache', '\\grshadercache'],
  },
  {
    id: 'edge-cache', cat: '浏览器缓存', safety: 'safe',
    title: 'Edge 缓存',
    purpose: 'Edge 浏览器的网页与着色器缓存。',
    action: '可整体删除（建议先关闭 Edge）。',
    includes: ['\\microsoft\\edge\\user data\\'],
    endsWith: ['\\cache', '\\code cache', '\\gpucache', '\\service worker', '\\shadercache'],
  },
  {
    id: 'firefox-cache', cat: '浏览器缓存', safety: 'safe',
    title: 'Firefox 缓存',
    purpose: 'Firefox 的 cache2 缓存目录。',
    action: '可删。',
    includes: ['\\mozilla\\firefox\\profiles\\'],
    endsWith: ['\\cache2', '\\startupcache'],
  },
  {
    id: 'browser-profile', cat: '应用数据', safety: 'danger',
    title: '浏览器用户数据（书签/密码/历史）',
    purpose: '浏览器的完整用户配置：书签、密码、扩展、登录态。',
    action: '不要删除！只清里面的 Cache 子目录。',
    includes: ['\\google\\chrome\\user data', '\\microsoft\\edge\\user data', '\\mozilla\\firefox\\profiles'],
  },

  // ============================ 开发工具链 ============================
  {
    id: 'node-modules', cat: '开发依赖', safety: 'caution',
    title: 'node_modules 依赖目录',
    purpose: 'Node.js 项目的第三方依赖。通常每个项目 100 MB~2 GB，且删了可以 npm install 完全重建。这是最容易回收的空间之一。',
    action: '按「多久没用」筛选后删除；重建命令：npm install / pnpm install。建议用工具批量列出 3 个月未访问的项目。',
    nameIn: ['node_modules'],
  },
  {
    id: 'npm-cache', cat: '开发缓存', safety: 'safe',
    title: 'npm 下载缓存',
    purpose: 'npm 下载过的包压缩包缓存（_cacache）。删了只是下次装包要重新下载。',
    action: 'npm cache clean --force，或直接删目录。',
    includes: ['\\npm-cache', '\\.npm\\_cacache', '\\.npm-cache'],
  },
  {
    id: 'pnpm-store', cat: '开发缓存', safety: 'caution',
    title: 'pnpm 全局存储',
    purpose: 'pnpm 的内容寻址仓库，所有项目的依赖硬链接到这里。删了所有 pnpm 项目都要重装。',
    action: 'pnpm store prune 清理未被引用的包，比整删安全得多。',
    includes: ['\\pnpm-store', '\\.pnpm-store', '\\appdata\\local\\pnpm\\store'],
  },
  {
    id: 'yarn-cache', cat: '开发缓存', safety: 'safe',
    title: 'Yarn 缓存',
    purpose: 'yarn 下载的包缓存。',
    action: 'yarn cache clean。',
    includes: ['\\yarn\\cache', '\\.yarn\\cache'],
  },
  {
    id: 'pip-cache', cat: '开发缓存', safety: 'safe',
    title: 'pip 下载缓存',
    purpose: 'pip 下载的 wheel/sdist 缓存，动辄几个 GB。',
    action: 'pip cache purge。',
    includes: ['\\appdata\\local\\pip\\cache', '\\.cache\\pip'],
  },
  {
    id: 'uv-cache', cat: '开发缓存', safety: 'safe',
    title: 'uv 包缓存',
    purpose: 'uv 的 Python 包缓存。',
    action: 'uv cache clean。',
    includes: ['\\appdata\\local\\uv\\cache', '\\.cache\\uv'],
  },
  {
    id: 'conda-pkgs', cat: '开发缓存', safety: 'safe',
    title: 'Conda 包缓存',
    purpose: 'conda 下载并解压过的包（pkgs 目录），常达数 GB。',
    action: 'conda clean --all。',
    includes: ['\\conda\\pkgs', '\\anaconda3\\pkgs', '\\miniconda3\\pkgs', '\\appdata\\local\\conda\\pkgs'],
  },
  {
    id: 'gradle-cache', cat: '开发缓存', safety: 'safe',
    title: 'Gradle 缓存',
    purpose: 'Gradle 依赖与构建缓存。',
    action: 'gradle --stop 后删除 caches 目录。',
    includes: ['\\.gradle\\caches', '\\.gradle\\wrapper\\dists'],
  },
  {
    id: 'm2-repo', cat: '开发依赖', safety: 'caution',
    title: 'Maven 本地仓库',
    purpose: 'Maven 下载的全部 jar 包。删了下次构建要重新下载（可能很久）。',
    action: '可删，但建议保留常用的；或删 \\.m2\\repository\\ 下不常用 groupId。',
    includes: ['\\.m2\\repository'],
  },
  {
    id: 'nuget-packages', cat: '开发依赖', safety: 'caution',
    title: 'NuGet 包缓存',
    purpose: '.NET 项目依赖包。',
    action: 'dotnet nuget locals all --clear。',
    includes: ['\\.nuget\\packages'],
  },
  {
    id: 'cargo-registry', cat: '开发依赖', safety: 'caution',
    title: 'Rust Cargo 缓存',
    purpose: 'crates.io 下载的 crate 源码与编译产物（target 目录更占空间）。',
    action: 'cargo cache 清理，或删 registry/cache。',
    includes: ['\\.cargo\\registry'],
  },
  {
    id: 'rust-target', cat: '构建产物', safety: 'caution',
    title: 'Rust 构建产物 target',
    purpose: 'debug/release 编译中间产物与二进制，单个项目可占 5~50 GB。',
    action: 'cargo clean，或删除 target 目录（下次编译会慢）。',
    nameIn: ['target'],
    includes: ['\\target\\'],
  },
  {
    id: 'go-mod-cache', cat: '开发缓存', safety: 'caution',
    title: 'Go 模块缓存',
    purpose: 'GOPATH\pkg\mod 下载的模块源码。',
    action: 'go clean -modcache。',
    includes: ['\\go\\pkg\\mod'],
  },
  {
    id: 'pycache', cat: '构建产物', safety: 'safe',
    title: '__pycache__ 字节码缓存',
    purpose: 'Python 编译后的 .pyc 缓存。删了会自动重建，完全无副作用。',
    action: '可批量删除。',
    nameIn: ['__pycache__'],
  },
  {
    id: 'venv', cat: '开发环境', safety: 'caution',
    title: 'Python 虚拟环境',
    purpose: '项目独立的 Python 环境，含 torch 等大包时可达数 GB。',
    action: '项目不用了可删；要重建用 requirements.txt。注意含 CUDA 的 torch 环境动辄 5 GB+。',
    nameIn: ['.venv', 'venv'],
  },
  {
    id: 'site-packages', cat: '开发环境', safety: 'caution',
    title: 'Python site-packages 依赖',
    purpose: '已安装的 Python 第三方库。',
    action: '谨慎：属于运行环境，删除会导致程序无法运行。',
    nameIn: ['site-packages'],
  },
  {
    id: 'build-dist', cat: '构建产物', safety: 'caution',
    title: '构建输出目录',
    purpose: '前端/后端项目的打包产物（dist、build、out、.next）。',
    action: '可删，重新构建即可（npm run build）。',
    nameIn: ['dist', 'build', '.next', 'out', 'release', 'coverage'],
  },
  {
    id: 'vscode-ext', cat: '开发工具', safety: 'caution',
    title: 'VS Code 扩展',
    purpose: '已安装的编辑器扩展。',
    action: '不需要的扩展可在编辑器内卸载（不要手删目录）。',
    includes: ['\\.vscode\\extensions'],
  },
  {
    id: 'jetbrains-cache', cat: '开发缓存', safety: 'safe',
    title: 'JetBrains IDE 缓存',
    purpose: 'IntelliJ/PyCharm 的索引与本地历史缓存，经常几十 GB。',
    action: '可删，IDE 下次启动会重建索引（AppData\\Local\\JetBrains）。注意别删 Roaming 下的配置。',
    includes: ['\\appdata\\local\\jetbrains'],
  },
  {
    id: 'android-sdk', cat: '开发工具', safety: 'caution',
    title: 'Android SDK / NDK',
    purpose: 'Android 开发工具链，每个 SDK/NDK 版本数百 MB~数 GB。',
    action: '用 SDK Manager 卸载不用的 API 版本与 NDK；system-images 尤其占地。',
    includes: ['\\appdata\\local\\android\\sdk', '\\android\\sdk'],
  },
  {
    id: 'android-avd', cat: '虚拟机镜像', safety: 'danger',
    title: 'Android 模拟器镜像 (AVD)',
    purpose: '模拟器实例的磁盘镜像，每个 8~32 GB。',
    action: '不用就删（在 AVD Manager 里删更干净）。',
    includes: ['\\.android\\avd'],
  },
  {
    id: 'gradle-home', cat: '开发工具', safety: 'caution',
    title: 'Gradle 本机目录',
    purpose: 'Gradle 发行版与构建缓存。',
    action: '可删 caches / wrapper\\dists。',
    includes: ['\\.gradle'],
  },

  // ============================ AI / 模型 ============================
  {
    id: 'hf-hub', cat: 'AI 模型', safety: 'caution',
    title: 'HuggingFace 模型缓存',
    purpose: '通过 transformers / diffusers 下载的模型权重（models--* 下的 blobs）。单个大模型 2~20 GB，通常是这台机器上最占地的目录之一。',
    action: '按模型查看：不用的模型直接删；常用模型可设 HF_HOME 到别的盘。注意删除后再次下载需要联网+时间。',
    includes: ['\\huggingface\\hub', '\\.cache\\huggingface'],
  },
  {
    id: 'torch-hub', cat: 'AI 模型', safety: 'caution',
    title: 'PyTorch Hub 模型',
    purpose: 'torch.hub 下载的预训练权重（RVC、语音合成、检测模型常放这里）。',
    action: '不用的模型可删。',
    includes: ['\\torch\\hub'],
  },
  {
    id: 'whisper-cache', cat: 'AI 模型', safety: 'caution',
    title: 'Whisper 语音模型',
    purpose: 'faster-whisper / whisper 的模型权重。',
    action: '保留常用尺寸（small/medium），大模型不常用可删。',
    includes: ['\\.cache\\whisper', '\\whisper\\models'],
  },
  {
    id: 'ollama-models', cat: 'AI 模型', safety: 'danger',
    title: 'Ollama 本地大模型',
    purpose: 'Ollama 下载的 LLM 权重，一个模型 2~40 GB。',
    action: 'ollama rm <模型名> 删除不用的模型。',
    includes: ['\\.ollama\\models', '\\ollama\\models'],
  },
  {
    id: 'comfyui-models', cat: 'AI 模型', safety: 'danger',
    title: 'ComfyUI 模型目录',
    purpose: 'SD 大模型、LoRA、VAE、ControlNet 等权重，是你主动下载的核心资产。',
    action: '按需保留。不用的 checkpoint / LoRA 建议移到移动硬盘。',
    includes: ['\\comfyui\\models'],
  },
  {
    id: 'comfyui-temp', cat: 'AI 缓存', safety: 'safe',
    title: 'ComfyUI 临时文件',
    purpose: '生成过程中的中间图、预览帧、上传缓存。',
    action: '可删（temp 目录）。',
    includes: ['\\comfyui\\temp'],
  },
  {
    id: 'comfyui-output', cat: 'AI 产出', safety: 'danger',
    title: 'ComfyUI 生成结果',
    purpose: '你生成的所有图片/视频成品。',
    action: '不建议直接删，先挑出要保留的。',
    includes: ['\\comfyui\\output'],
  },
  {
    id: 'stable-diffusion', cat: 'AI 模型', safety: 'danger',
    title: 'Stable Diffusion 模型与产出',
    purpose: 'SD WebUI / 相关工具的大模型与输出。',
    action: '按需保留。',
    includes: ['\\stable-diffusion', '\\sd-webui', '\\sd.webui'],
  },
  {
    id: 'ai-venv', cat: 'AI 环境', safety: 'caution',
    title: 'AI 项目虚拟环境',
    purpose: '带 CUDA 的 PyTorch 环境，单个 5~15 GB。',
    action: '不同项目可共用环境，重复的删掉。',
    includes: ['\\rvc\\', '\\voice\\', '\\ace-step', '\\yue2'],
    nameIn: ['.venv', 'venv'],
  },

  // ============================ 通讯 / 办公应用 ============================
  {
    id: 'wechat-files', cat: '聊天数据', safety: 'danger',
    title: '微信聊天文件',
    purpose: '微信接收/发送的图片、视频、文件、语音缓存。几年不清理可达几十 GB。',
    action: '不要整删。在微信「设置 → 文件管理 → 存储空间」里按类型清理，或删 3 年前的视频。',
    includes: ['\\wechat files', '\\weixin\\', '\\xwechat_files'],
  },
  {
    id: 'tencent-files', cat: '聊天数据', safety: 'danger',
    title: 'QQ / 腾讯系聊天文件',
    purpose: 'QQ 接收的图片视频、聊天记录缓存、表情包。',
    action: '在 QQ 内清理，或按目录大小挑着删。',
    includes: ['\\tencent files', '\\tencent\\', '\\qq\\'],
  },
  {
    id: 'dingtalk', cat: '聊天数据', safety: 'danger',
    title: '钉钉 / 企业微信数据',
    purpose: '办公 IM 的文件与聊天缓存。',
    action: '在应用内清理缓存。',
    includes: ['\\dingtalk', '\\wxwork'],
  },
  {
    id: 'wechat-cache', cat: '应用缓存', safety: 'safe',
    title: '微信 / QQ 程序缓存',
    purpose: '客户端自身的缓存数据（非聊天内容）。',
    action: '可删，应用会重建。',
    includes: ['\\appdata\\roaming\\tencent\\', '\\appdata\\local\\tencent\\'],
    endsWith: ['\\cache', '\\temp', '\\crashpad'],
  },
  {
    id: 'office-cache', cat: '应用缓存', safety: 'safe',
    title: 'Office 文档缓存',
    purpose: 'Word/Excel/PPT 的最近文档缓存、剪贴板、自动恢复临时文件。',
    action: '可删（确认没有正在编辑的文档）。',
    includes: ['\\appdata\\local\\microsoft\\office'],
  },
  {
    id: 'teams', cat: '应用缓存', safety: 'safe',
    title: 'Teams 缓存',
    purpose: 'Teams 客户端的媒体与日志缓存。',
    action: '可删。',
    includes: ['\\appdata\\roaming\\microsoft\\teams'],
  },
  {
    id: 'discord', cat: '应用缓存', safety: 'safe',
    title: 'Discord 缓存',
    purpose: '聊天图片与语音缓存。',
    action: '可删。',
    includes: ['\\discord\\cache'],
  },
  {
    id: 'music-cache', cat: '应用缓存', safety: 'safe',
    title: '音乐/视频客户端缓存',
    purpose: '网易云、QQ音乐、B站等客户端的下载缓存。',
    action: '可删（已下载的歌会被清掉，缓存则无影响）。',
    includes: ['\\cloudmusic\\cache', '\\qqmusic\\cache', '\\bilibili\\'],
  },
  {
    id: 'adobe-cache', cat: '应用缓存', safety: 'safe',
    title: 'Adobe 媒体缓存',
    purpose: 'PR/AE 的媒体缓存与预览文件，经常几十 GB。',
    action: '在 PR 首选项里「清理媒体缓存」，或直接删 Common\\Media Cache Files。',
    includes: ['\\adobe\\common\\media cache', '\\adobe\\common\\media cache files'],
  },
  {
    id: 'adobe-app', cat: '应用数据', safety: 'danger',
    title: 'Adobe 应用数据',
    purpose: 'Adobe 全家桶的配置与自动保存文件。',
    action: '不要整删，只清 cache 子目录。',
    includes: ['\\adobe\\'],
  },
  {
    id: 'baidu-netdisk', cat: '应用缓存', safety: 'danger',
    title: '百度网盘缓存/下载',
    purpose: '网盘的本地缓存与已下载文件。',
    action: '在客户端清理，或挑大文件删。',
    includes: ['\\baidunetdisk', '\\baidu\\baidunetdisk'],
  },

  // ============================ 游戏 ============================
  {
    id: 'steam-common', cat: '游戏', safety: 'danger',
    title: 'Steam 游戏本体',
    purpose: '已安装的游戏文件。',
    action: '在 Steam 里卸载（不要手删），或迁移到其他盘。',
    includes: ['\\steamapps\\common'],
  },
  {
    id: 'steam-downloading', cat: '游戏', safety: 'safe',
    title: 'Steam 下载缓存与残留',
    purpose: '更新包的临时下载、着色器预缓存。',
    action: '可删 downloading / shadercache。',
    includes: ['\\steamapps\\downloading', '\\steamapps\\shadercache', '\\steamapps\\temp'],
  },
  {
    id: 'steam-workshop', cat: '游戏', safety: 'caution',
    title: 'Steam 创意工坊内容',
    purpose: '订阅的 MOD 与地图，常达数 GB~数十 GB。',
    action: '在 Steam 里取消订阅，或删 workshop\\content。',
    includes: ['\\steamapps\\workshop'],
  },
  {
    id: 'epic-games', cat: '游戏', safety: 'danger',
    title: 'Epic 游戏',
    purpose: 'Epic 平台安装的游戏。',
    action: '在启动器里卸载。',
    includes: ['\\epic games\\'],
  },
  {
    id: 'game-cache', cat: '游戏', safety: 'safe',
    title: '游戏缓存',
    purpose: '游戏平台的着色器/更新缓存。',
    action: '可删。',
    includes: ['\\riot games\\', '\\battle.net\\', '\\ubisoft\\'],
    endsWith: ['\\cache', '\\logs', '\\temp'],
  },

  // ============================ 虚拟化 / 容器 ============================
  {
    id: 'wsl-vhdx', cat: '虚拟机镜像', safety: 'danger',
    title: 'WSL 发行版磁盘镜像',
    purpose: 'Linux 子系统的 ext4.vhdx，只增不减，很容易涨到几十 GB（Docker 数据也在里面）。',
    action: '压缩：wsl --shutdown 后用 diskpart/Optimize-VHD 压缩；不用则 wsl --unregister。',
    includes: ['\\packages\\', '\\wsl\\'],
    endsWith: ['\\ext4.vhdx', '\\docker_data.vhdx'],
  },
  {
    id: 'docker-data', cat: '容器', safety: 'caution',
    title: 'Docker 数据',
    purpose: '镜像、容器、卷的数据。',
    action: 'docker system prune -a --volumes（会删掉所有未使用镜像）。',
    includes: ['\\docker\\', '\\docker-desktop'],
  },
  {
    id: 'vm-images', cat: '虚拟机镜像', safety: 'danger',
    title: '虚拟机磁盘镜像',
    purpose: 'VMware / VirtualBox / Hyper-V 的虚拟磁盘。',
    action: '不用就删；要先在虚拟化软件里删，避免残留。',
    endsWith: ['.vmdk', '.vhd', '.vhdx', '.vdi', '.qcow2'],
  },
  {
    id: 'iso', cat: '安装镜像', safety: 'caution',
    title: '系统安装镜像 ISO',
    purpose: 'Windows/Linux 安装盘镜像，单个 4~7 GB。',
    action: '装完系统后可删或归档到移动硬盘。',
    extIn: ['iso', 'img'],
  },

  // ============================ 下载 / 用户数据 ============================
  {
    id: 'downloads', cat: '下载', safety: 'danger',
    title: '下载文件夹',
    purpose: '你浏览器/工具下载的文件。里面常混着安装包、临时素材、重复下载。',
    action: '重点看：> 500 MB 的安装包、3 个月没打开过的文件。删前逐个确认。',
    includes: ['\\downloads'],
  },
  {
    id: 'desktop', cat: '用户数据', safety: 'danger',
    title: '桌面',
    purpose: '桌面上的文件。',
    action: '自行整理。注意大文件常被临时放在桌面。',
    includes: ['\\desktop'],
  },
  {
    id: 'documents', cat: '用户数据', safety: 'danger',
    title: '文档',
    purpose: '文档目录，含项目、报告、聊天软件默认接收目录。',
    action: '人工确认。',
    includes: ['\\documents'],
  },
  {
    id: 'pictures', cat: '用户数据', safety: 'danger',
    title: '图片',
    purpose: '照片与截图。',
    action: '人工确认，建议归档到移动硬盘/云盘。',
    includes: ['\\pictures'],
  },
  {
    id: 'videos', cat: '用户数据', safety: 'danger',
    title: '视频',
    purpose: '视频文件，单项常是几百 MB~几 GB。',
    action: '人工确认，优先看最大的几个。',
    includes: ['\\videos'],
  },
  {
    id: 'music', cat: '用户数据', safety: 'danger',
    title: '音乐',
    purpose: '本地音乐文件。',
    action: '人工确认。',
    includes: ['\\music'],
  },
  {
    id: 'onedrive', cat: '云同步', safety: 'caution',
    title: 'OneDrive 本地副本',
    purpose: '云盘同步到本地的文件，可设为「仅在线」释放空间。',
    action: '右键文件夹 →「释放空间」即可腾出本地占用而保留云端。',
    includes: ['\\onedrive'],
  },

  // ============================ 项目 / 工作目录 ============================
  {
    id: 'git-objects', cat: '版本控制', safety: 'keep',
    title: 'Git 仓库对象',
    purpose: '仓库的完整版本历史。删了仓库就废了。',
    action: '不要手删。大仓库可用 git gc 压缩；旧分支可删。',
    nameIn: ['.git'],
  },
  {
    id: 'project-src', cat: '项目源码', safety: 'keep',
    title: '项目源码',
    purpose: '你的代码与工程文件。',
    action: '保留。只清理其中的缓存/构建产物子目录。',
    includes: ['\\src', '\\workspace', '\\projects'],
  },
  {
    id: 'backup-dir', cat: '备份', safety: 'caution',
    title: '备份目录',
    purpose: '旧版本/迁移前的备份副本。',
    action: '确认不再需要后删除；重要的移到外部存储。',
    includes: ['\\backup', '\\bak', '-backup', '_backup', '备份'],
  },

  // ============================ 按扩展名兜底 ============================
  {
    id: 'ext-log', cat: '日志文件', safety: 'safe',
    title: '日志文件',
    purpose: '运行日志，通常只用于排查问题。',
    action: '确认近期没在排障后可删。',
    extIn: ['log', 'log1', 'log2', 'etl', 'trace'],
  },
  {
    id: 'ext-tmp', cat: '临时文件', safety: 'safe',
    title: '临时文件',
    purpose: '安装/编辑过程产生的 .tmp/.temp/.bak 残留。',
    action: '可删。',
    extIn: ['tmp', 'temp', 'bak', 'old', 'dmp', 'chk'],
  },
  {
    id: 'ext-archive', cat: '压缩包', safety: 'danger',
    title: '压缩包',
    purpose: '可能是安装包、备份或素材。',
    action: '解压过一次的压缩包通常可删；确认内容后再决定。',
    extIn: ['zip', '7z', 'rar', 'tar', 'gz', 'xz', 'zst'],
  },
  {
    id: 'ext-installer', cat: '安装包', safety: 'caution',
    title: '安装程序',
    purpose: '软件安装包。装完后剩下的副本基本没用了。',
    action: '软件已安装成功的，可删。',
    extIn: ['msi', 'msix', 'appx', 'apk', 'deb', 'rpm'],
  },
  {
    id: 'ext-video', cat: '视频文件', safety: 'danger',
    title: '视频文件',
    purpose: '录屏、下载的视频、生成的视频。',
    action: '单个文件最容易腾空间，优先挑 1 GB 以上的。',
    extIn: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'ts', 'm4v'],
  },
  {
    id: 'ext-image', cat: '图片文件', safety: 'danger',
    title: '图片文件',
    purpose: '截图、素材、生成结果。',
    action: '按目录批量换算，不用的删。',
    extIn: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff', 'psd', 'svg'],
  },
  {
    id: 'ext-code', cat: '源码文件', safety: 'keep',
    title: '源代码文件',
    purpose: '程序源码。',
    action: '保留。',
    extIn: ['js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs', 'py', 'c', 'cpp', 'h', 'hpp', 'java', 'kt', 'go', 'rs', 'cs', 'rb', 'php', 'swift', 'lua', 'vue', 'html', 'css', 'scss', 'json', 'yaml', 'yml', 'toml', 'md'],
  },
];

// --- 预编译 ---
const LC = (s) => s.toLowerCase();
const compiled = RULES.map((r, idx) => {
  const norm = { ...r, _idx: idx, _score: 0 };
  norm.startsWith = (r.startsWith || []).map(LC);
  norm.includes = (r.includes || []).map(LC);
  norm.endsWith = (r.endsWith || []).map(LC);
  norm.nameIn = (r.nameIn || []).map(LC);
  norm.extIn = (r.extIn || []).map(LC);
  for (const a of [norm.startsWith, norm.includes, norm.endsWith, norm.nameIn, norm.extIn]) {
    for (const s of a) norm._score = Math.max(norm._score, s.length);
  }
  return norm;
});

function normPath(p) {
  if (!p) return '';
  return p.replace(/\//g, '\\').toLowerCase();
}

function basenameOf(p) {
  const n = normPath(p).replace(/\\+$/, '');
  const i = n.lastIndexOf('\\');
  return i >= 0 ? n.slice(i + 1) : n;
}

function extOf(p) {
  const b = basenameOf(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1) : '';
}

/**
 * 判断一个路径（文件或目录）
 * @param {string} absPath
 * @param {{isDir?:boolean, name?:string}} [meta]
 */
export function analyzePath(absPath, meta = {}) {
  const lp = normPath(absPath);
  const bn = (meta.name ? LC(meta.name) : basenameOf(absPath)).replace(/\\+$/, '');
  const ext = extOf(absPath);
  const isDir = meta.isDir ?? true;

  let best = null;
  let bestScore = -1;
  for (const r of compiled) {
    if (r.startsWith.length) {
      let hit = false;
      for (const s of r.startsWith) if (lp === s || lp.startsWith(s + '\\') || lp.startsWith(s)) { hit = true; break; }
      if (!hit) continue;
    }
    if (r.includes.length) {
      let hit = false;
      for (const s of r.includes) if (lp.includes(s)) { hit = true; break; }
      if (!hit) continue;
    }
    if (r.endsWith.length) {
      let hit = false;
      for (const s of r.endsWith) if (lp.endsWith(s) || bn.endsWith(s.replace(/^\\/, ''))) { hit = true; break; }
      if (!hit) continue;
    }
    // 目录本名命中要优先于"路径中段命中"
    let nameHit = false;
    if (r.nameIn.length) {
      if (r.nameIn.includes(bn)) nameHit = true;
      else {
        let mid = false;
        for (const s of r.nameIn) if (lp.split('\\').includes(s)) { mid = true; break; }
        if (!mid) continue;
      }
    }
    if (r.extIn.length) {
      if (!r.extIn.includes(ext)) continue;
    }
    // 评分：base = 最长模式长度；本名精确命中 +100；扩展名命中 +30
    let score = r._score;
    if (nameHit) score += 100;
    if (r.extIn.length) score += 30;
    if (r.startsWith.length) score += 25;
    if (score > bestScore) { bestScore = score; best = r; }
  }

  if (best) {
    return {
      ruleId: best.id,
      title: best.title,
      category: best.cat,
      safety: best.safety,
      purpose: best.purpose,
      action: best.action,
      confidence: 'rule',
      matched: true,
      // 是否"整体功能单元"：树图里整块显示，不再往下拆分
      atomic: ATOMIC_CATEGORIES.has(best.cat),
    };
  }

  // 兜底启发式
  return heuristic(absPath, bn, ext, isDir);
}

function heuristic(absPath, bn, ext, isDir) {
  const lc = normPath(absPath);
  const isUserApp = lc.includes('\\appdata\\');
  const isProgram = lc.includes('\\program files');
  const isCacheish = /cache|caches|temp|tmp|log|logs|backup|bak|dump|crash|update|installer|download/.test(bn);

  if (isCacheish) {
    return {
      ruleId: 'heuristic-cache', title: '疑似缓存 / 临时目录', category: '未归类缓存',
      safety: 'caution',
      purpose: '目录名包含 cache/temp/log/backup 等特征，很可能是可重建的缓存或临时数据，但不在已知清单里。',
      action: '先看里面是什么，再决定。若只是缓存，删除后应用会自动重建。',
      confidence: 'heuristic', matched: false, atomic: false,
    };
  }
  if (isUserApp) {
    return {
      ruleId: 'heuristic-appdata', title: '应用数据目录', category: '未归类应用',
      safety: 'danger',
      purpose: '某个应用程序在 AppData 下的数据。可能包含配置、登录态、离线数据。',
      action: '不要整删。只清其中的 Cache/Temp/Logs 子目录。',
      confidence: 'heuristic', matched: false, atomic: false,
    };
  }
  if (isProgram) {
    return {
      ruleId: 'heuristic-program', safety: 'danger', category: '已安装程序',
      title: '已安装的软件',
      purpose: '安装在系统程序目录下的软件本体。',
      action: '不要直接删。用「设置 → 应用」或程序自带卸载器卸载。',
      confidence: 'heuristic', matched: false, atomic: false,
    };
  }
  if (!isDir && ext) {
    return {
      ruleId: 'heuristic-file', safety: 'caution', category: '文件',
      title: `.${ext} 文件`, purpose: '普通数据文件。',
      action: '根据文件名与所在目录判断是否需要。',
      confidence: 'heuristic', matched: false, atomic: true,
    };
  }
  return {
    ruleId: 'unknown', safety: 'unknown', category: '未识别',
    title: isDir ? '未识别的目录' : '未识别的文件',
    purpose: '规则库没有覆盖这个路径。',
    action: '建议用 AI 分析或人工查看。',
    confidence: 'none', matched: false, atomic: !isDir,
  };
}

/** 安全等级 → 展示用元信息 */
export const SAFETY_META = {
  safe: { label: '可直接清理', color: '#3fb950', order: 0 },
  caution: { label: '可清理但有代价', color: '#d29922', order: 1 },
  danger: { label: '含用户数据·需确认', color: '#f85149', order: 2 },
  keep: { label: '系统/项目关键·勿删', color: '#58a6ff', order: 3 },
  unknown: { label: '未知', color: '#8b949e', order: 4 },
};

/**
 * 「整体功能单元」分类：这类目录是一个不可再分的功能整体，
 * 在树图里应该整块显示（画斜纹标识），不再往下钻。
 * 比如 node_modules、.venv、WinSxS、游戏本体——拆开看没有意义。
 */
const ATOMIC_CATEGORIES = new Set([
  // 系统
  '系统缓存', '系统组件', '系统转储', '系统安装缓存', '系统备份',
  '回收站', '系统还原', '系统资源', '系统文件',
  // 缓存类
  '浏览器缓存', '缩略图缓存', '崩溃转储', '显卡缓存', '应用缓存',
  '安全软件缓存', '错误报告', 'AI 缓存',
  // 开发
  '开发缓存', '开发依赖', '构建产物', '版本控制', '开发环境', '开发工具',
  // AI / 游戏 / 虚拟化
  'AI 模型', 'AI 环境', '游戏', '安装镜像', '虚拟机镜像', '容器',
  // 聊天 / 媒体
  '聊天数据',
]);

/** 生成清理优先级分数（越大越值得先清） */
export function priorityScore(size, safety) {
  const w = { safe: 1.0, caution: 0.62, danger: 0.18, keep: 0, unknown: 0.1 }[safety] ?? 0.1;
  return size * w;
}

export const RULE_COUNT = RULES.length;
export { RULES };
