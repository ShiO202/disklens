/**
 * DiskLens HTTP 服务
 * 零依赖：仅使用 Node 内置模块
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { scanTree, scanShallow } from './lib/scanner.mjs';
import { analyzePath, SAFETY_META, priorityScore, RULE_COUNT } from './lib/rules.mjs';
import { analyzeWithEvidence } from './lib/localanalyze.mjs';
import {
  defaultAIConfig, aiAvailable, analyzeTarget, analyzeBatch,
  ruleOnlyAnalysis, testConnection, human, resolveApiKey,
  chatFollowUp, localFollowUp,
} from './lib/ai.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
// 桌面版由主进程指定用户数据目录（%APPDATA%\DiskLens\data），Web 版用程序目录
const DATA_DIR = process.env.DISKLENS_DATA || path.join(__dirname, 'data');
const SCAN_DIR = path.join(DATA_DIR, 'scans');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const PORT = Number(process.env.DISKLENS_PORT || 7788);
const HOST = '127.0.0.1';

await fsp.mkdir(SCAN_DIR, { recursive: true });

// ---------------------------------------------------------------- 设置
const DEFAULT_SETTINGS = {
  ai: defaultAIConfig(),
  scan: { maxDepth: 16, maxChildren: 512, aggThreshold: 48 * 1024 },
  lastRoot: null,
};

let settings = structuredClone(DEFAULT_SETTINGS);
try {
  const raw = await fsp.readFile(SETTINGS_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  settings = {
    ...DEFAULT_SETTINGS,
    ...parsed,
    ai: { ...DEFAULT_SETTINGS.ai, ...(parsed.ai || {}) },
    scan: { ...DEFAULT_SETTINGS.scan, ...(parsed.scan || {}) },
  };
} catch { /* 首次运行 */ }

async function saveSettings() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

// ---------------------------------------------------------------- 忽略列表
const IGNORE_FILE = path.join(DATA_DIR, 'ignore.json');
let ignoreList = [];
let ignoreRes = [];

function buildIgnoreMatcher() {
  ignoreRes = ignoreList.map((it) => {
    const pat = String(it.pattern || '').trim().toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
    if (!pat) return null;
    if (pat.includes('*') || pat.includes('?')) {
      const esc = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      return { it, re: new RegExp('^' + esc.replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i') };
    }
    return { it, exact: pat };
  }).filter(Boolean);
}

try {
  const raw = await fsp.readFile(IGNORE_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  ignoreList = Array.isArray(parsed.items) ? parsed.items : [];
} catch { /* 首次运行 */ }
buildIgnoreMatcher();

async function saveIgnore() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(IGNORE_FILE, JSON.stringify({ items: ignoreList }, null, 2), 'utf8');
  buildIgnoreMatcher();
}

function normAbs(p) {
  return String(p || '').toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
}

/** 命中则返回对应忽略规则，否则 null */
function matchIgnore(absPath) {
  const lp = normAbs(absPath);
  for (const m of ignoreRes) {
    if (m.exact) { if (lp === m.exact) return m.it; }
    else if (m.re.test(lp)) return m.it;
  }
  return null;
}

// ---------------------------------------------------------------- 扫描任务
const jobs = new Map();

function newJobId() { return crypto.randomBytes(6).toString('hex'); }

/** 统一根路径写法：'c:' / 'C:\' / 'C:/' 都归一成 'C:\' */
function normalizeRoot(input) {
  let r = String(input || '').trim();
  if (!r) return 'C:\\';
  if (/^[A-Za-z]:$/.test(r)) return r[0].toUpperCase() + ':\\';
  if (/^[A-Za-z]:[\\/]+$/.test(r)) return r[0].toUpperCase() + ':\\';
  r = r.replace(/\//g, '\\').replace(/\\+$/, '');
  if (/^[a-z]:/.test(r)) r = r[0].toUpperCase() + r.slice(1);
  return r;
}

async function startScan(root, opts = {}) {
  const cleanRoot = normalizeRoot(root);
  const id = newJobId();
  const job = {
    id, root: cleanRoot, status: 'running', progress: { files: 0, dirs: 0, bytes: 0, current: cleanRoot, elapsedMs: 0 },
    tree: null, error: null, startedAt: Date.now(), finishedAt: null, listeners: new Set(),
    candidates: null,
  };
  jobs.set(id, job);

  // 只保留最近 3 个任务，避免内存堆积
  if (jobs.size > 3) {
    for (const [k, v] of jobs) {
      if (k !== id && v.status !== 'running') { jobs.delete(k); break; }
    }
  }

  const controller = new AbortController();
  job.abort = controller;

  const broadcast = (msg) => {
    for (const res of job.listeners) {
      try { res.write(`data: ${JSON.stringify(msg)}\n\n`); } catch { /* ignore */ }
    }
  };

  (async () => {
    try {
      const tree = await scanTree(cleanRoot, { ...settings.scan, ...opts }, {
        signal: controller.signal,
        onProgress: (p) => {
          job.progress = p;
          broadcast({ type: 'progress', ...p });
        },
      });
      job.tree = tree;
      job.status = 'done';
      job.finishedAt = Date.now();
      job.candidates = buildCandidates(tree);
      broadcast({ type: 'done', stats: tree.stats, size: tree.s, elapsedMs: job.finishedAt - job.startedAt });
      saveScanCache(job).catch(() => {});
    } catch (e) {
      job.status = e.code === 'ABORTED' ? 'aborted' : 'error';
      job.error = String(e.message || e);
      job.finishedAt = Date.now();
      broadcast({ type: 'error', error: job.error });
    } finally {
      for (const res of job.listeners) { try { res.end(); } catch { /* ignore */ } }
      job.listeners.clear();
    }
  })();

  return job;
}

/** 遍历树，挑出"可清理"候选，按优先级排序 */
function buildCandidates(tree) {
  const all = [];
  const listed = [];
  const MIN = 20 * 1024 * 1024; // 只关心 20MB 以上

  // 这些是"容器"目录：本身没有清理意义，真正的内容在子目录里
  const CONTAINER_PATHS = new Set([
    'c:\\program files', 'c:\\program files (x86)', 'c:\\programdata',
    'c:\\windows', 'c:\\users',
  ]);
  const CONTAINER_RE = /^c:\\users\\[^\\]+\\appdata(\\local|\\roaming|\\locallow)?$/i;

  function dfs(n, parentSafety, parentRule, depth, ancestorListed) {
    if (!n || !n.d) return;
    let mySafety = parentSafety;
    let myRule = parentRule;
    let listedAnc = ancestorListed;

    if (n.s >= MIN) {
      const r = analyzePath(n.p, { isDir: true, name: n.n });
      const lp = n.p.replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '');
      const sameRule = parentRule && r.ruleId === parentRule;
      const container =
        depth === 0 ||
        CONTAINER_PATHS.has(lp) ||
        CONTAINER_RE.test(lp) ||
        (r.safety === 'unknown' && depth <= 1) ||
        (r.confidence === 'heuristic' && depth <= 1);
      const dup = parentSafety === r.safety;
      // 已被列出的祖先覆盖（占其 85% 以上）→ 同一块空间，不重复列
      const covered = listedAnc && n.s >= listedAnc.size * 0.85;

      const self = {
        path: n.p, name: n.n, size: n.s, files: n.fc, depth,
        mtime: n.t, safety: r.safety, title: r.title, category: r.category,
        purpose: r.purpose, action: r.action, ruleId: r.ruleId,
        confidence: r.confidence, matched: r.matched,
        dup, container, sameRule, covered,
        score: priorityScore(n.s, r.safety) * (r.safety === 'unknown' ? 0.35 : 1),
      };
      all.push(self);
      if (!container && !sameRule && !covered) {
        listed.push(self);
        listedAnc = self;
      }
      mySafety = r.safety;
      myRule = r.ruleId;
    }
    if (n.c) for (const k of n.c) if (k.d) dfs(k, mySafety, myRule, depth + 1, listedAnc);
  }
  dfs(tree, 'unknown', null, 0, null);

  const list = listed.sort((a, b) => b.score - a.score);
  const totals = summarize(all.filter((x) => !x.dup));
  return { list: list.slice(0, 400), totals };
}

function summarize(list) {
  const t = { safe: 0, caution: 0, danger: 0, keep: 0, unknown: 0, count: list.length };
  for (const it of list) t[it.safety] = (t[it.safety] || 0) + it.size;
  t.reclaimableSafe = t.safe;
  t.reclaimableLikely = t.safe + t.caution * 0.6;
  return t;
}

async function saveScanCache(job) {
  const file = path.join(SCAN_DIR, `${job.id}.json.gz`);
  const payload = JSON.stringify({
    id: job.id, root: job.root, finishedAt: job.finishedAt,
    stats: job.tree.stats, tree: job.tree,
  });
  const gz = zlib.gzipSync(Buffer.from(payload), { level: 6 });
  await fsp.writeFile(file, gz);
  await fsp.writeFile(path.join(SCAN_DIR, 'latest.txt'), `${job.id}\n${job.root}\n${job.finishedAt}`, 'utf8');
}

async function loadLatestCache() {
  try {
    const meta = await fsp.readFile(path.join(SCAN_DIR, 'latest.txt'), 'utf8');
    const [id, root] = meta.trim().split('\n');
    const file = path.join(SCAN_DIR, `${id}.json.gz`);
    const buf = await fsp.readFile(file);
    const data = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
    const job = {
      id, root, status: 'done', progress: { files: data.stats.files, dirs: data.stats.dirs, bytes: data.stats.bytes, current: root, elapsedMs: data.stats.elapsedMs },
      tree: data.tree, error: null, startedAt: data.finishedAt - (data.stats.elapsedMs || 0),
      finishedAt: data.finishedAt, listeners: new Set(),
      candidates: buildCandidates(data.tree),
    };
    jobs.set(id, job);
    return job;
  } catch { return null; }
}

// ---------------------------------------------------------------- 工具
function findNode(root, absPath) {
  if (!root || !absPath) return null;
  const rp = root.p.replace(/[\\/]+$/, '').toLowerCase();
  const tp = String(absPath).replace(/[\\/]+$/, '').toLowerCase();
  if (tp === rp) return root;
  if (!tp.startsWith(rp)) return null;
  const rel = tp.slice(rp.length).replace(/^[\\/]+/, '');
  if (!rel) return root;
  const segs = rel.split(/[\\/]/).filter(Boolean);
  let cur = root;
  for (const seg of segs) {
    if (!cur.c) return null;
    const lower = seg.toLowerCase();
    cur = cur.c.find((k) => k.n.toLowerCase() === lower) || null;
    if (!cur) return null;
  }
  return cur;
}

/** 递归构建预览树（供前端多层嵌套渲染）；atomic 节点在此处截断 */
function previewTree(n, depth, branch) {
  const a = analyzePath(n.p, { isDir: n.d, name: n.n });
  const out = { n: n.n, s: n.s, d: n.d, x: n.x, safety: a.safety, atomic: !!a.atomic };
  if (depth > 0 && !a.atomic && n.c && n.c.length) {
    out.pv = n.c.slice(0, branch).map((k) => previewTree(k, depth - 1, branch));
  }
  return out;
}

/** 取最近一次完成的扫描任务 */
function latestDoneJob() {
  return [...jobs.values()]
    .filter((j) => j.tree && j.status === 'done')
    .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))[0] || null;
}

function nodeBrief(n, opts = {}) {
  const an = analyzePath(n.p, { isDir: n.d, name: n.n });
  const b = {
    n: n.n, p: n.p, d: n.d, s: n.s, fc: n.fc, dc: n.dc, t: n.t,
    x: n.x, a: n.a || null, e: n.e || null,
    hasChildren: !!(n.c && n.c.length),
    childCount: n.c ? n.c.length : 0,
    an: {
      safety: an.safety, title: an.title, category: an.category,
      purpose: an.purpose, action: an.action,
      confidence: an.confidence, matched: an.matched, atomic: !!an.atomic,
    },
  };
  if (opts.previewDepth && n.c && n.c.length && !an.atomic) {
    b.pv = n.c.slice(0, opts.branch || 8)
      .map((k) => previewTree(k, opts.previewDepth - 1, opts.branch || 8));
  }
  return b;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) {
    chunks.push(c);
    if (chunks.reduce((a, b) => a + b.length, 0) > 4 * 1024 * 1024) throw new Error('body too large');
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------- 驱动信息
function driveInfo() {
  const out = [];
  const letters = [];
  for (let c = 65; c <= 90; c++) {
    const root = String.fromCharCode(c) + ':\\';
    try {
      if (fs.existsSync(root)) letters.push(root);
    } catch { /* ignore */ }
  }
  for (const root of letters) {
    try {
      const s = fs.statfsSync(root);
      const total = s.bsize * s.blocks;
      const free = s.bsize * s.bavail;
      out.push({ root, total, free, used: total - free });
    } catch { /* ignore */ }
  }
  return out;
}

// ---------------------------------------------------------------- 删除（破坏性操作，多重护栏）
const deleteJobs = new Map();

/** 绝对不该在这个工具里删的东西 */
const FORBIDDEN_DELETE = [
  /^[a-z]:\\?$/i,                                       // 盘根
  /^[a-z]:\\windows(\\|$)/i,
  /^[a-z]:\\program files( \(x86\))?(\\|$)/i,
  /^[a-z]:\\programdata$/i,
  /^[a-z]:\\users(\\[^\\]+)?$/i,                         // 用户根目录
  /^[a-z]:\\users\\[^\\]+\\appdata(\\local|\\roaming|\\locallow)?$/i,
  /^[a-z]:\\users\\[^\\]+\\documents$/i,
  /^[a-z]:\\users\\[^\\]+\\desktop$/i,
  /^[a-z]:\\system volume information/i,
  /^[a-z]:\\\$recycle\.bin$/i,
  /^[a-z]:\\recovery(\\|$)/i,
  /^[a-z]:\\pagefile\.sys$/i,
  /^[a-z]:\\hiberfil\.sys$/i,
  /^[a-z]:\\swapfile\.sys$/i,
];

/** 调起资源管理器：目录且 openDir 时打开它；文件一律「打开所在文件夹并选中」 */
function openInExplorer(target, openDir) {
  return new Promise((resolve, reject) => {
    let isDir = false;
    try { isDir = fs.statSync(target).isDirectory(); } catch { /* ignore */ }
    // 文件永远走 /select（打开所在目录并选中该文件）
    const useSelect = !isDir || !openDir;
    const args = useSelect ? [`/select,"${target}"`] : [target];

    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve();
    };
    let child;
    try {
      child = spawn('explorer.exe', args, { detached: true, stdio: 'ignore' });
    } catch (e) {
      return done(new Error(e.message));
    }
    child.on('error', (e) => {
      const msg = e.code === 'EPERM' || e.code === 'EACCES'
        ? '系统拒绝了启动外部程序的请求（权限受限）'
        : e.message;
      done(new Error(msg));
    });
    child.on('spawn', () => {
      try { child.unref(); } catch { /* ignore */ }
      setTimeout(() => done(), 250);
    });
    setTimeout(() => done(), 3000);
  });
}

/** 把底层错误翻译成人话 */
function friendlyError(e) {
  const msg = String(e?.message || e);
  if (/EPERM|EACCES|operation not permitted/i.test(msg)) {
    return `权限不足或文件被占用。常见原因：① 文件正被别的程序使用；② 需要管理员权限；③ 目录受系统保护。（${msg}）`;
  }
  if (/EBUSY/i.test(msg)) return `文件正被占用，请先关闭相关程序。（${msg}）`;
  if (/ENOENT/i.test(msg)) return '路径不存在，可能已经被删除或移动。';
  if (/ENOTEMPTY/i.test(msg)) return `目录非空（可能有文件正在写入）。（${msg}）`;
  return msg;
}

function normalizeDeletePath(input) {
  if (!input || typeof input !== 'string') throw new Error('缺少路径');
  let s = input.trim().replace(/\//g, '\\');
  if (!/^[a-zA-Z]:\\/.test(s)) throw new Error('只接受绝对路径');
  s = path.resolve(s);
  if (path.parse(s).root === s) throw new Error('不能删除磁盘根目录');
  if (s.split('\\').filter(Boolean).length < 2) throw new Error('路径层级过浅，拒绝执行');
  return s;
}

function checkDeletable(abs) {
  const lp = abs.toLowerCase();
  for (const re of FORBIDDEN_DELETE) {
    if (re.test(lp)) throw new Error(`该路径受保护，禁止在 DiskLens 中删除：${abs}`);
  }
  return true;
}

/** 移到回收站（可恢复）——通过 .NET 的 VisualBasic.FileIO */
function recycleToBin(target) {
  return new Promise((resolve, reject) => {
    const b64 = Buffer.from(target, 'utf8').toString('base64');
    const errFile = path.join(process.env.TEMP || 'C:\\Windows\\Temp', `disklens-del-${Date.now()}.log`);
    const cmd = [
      "$ErrorActionPreference='Stop'",
      'Add-Type -AssemblyName Microsoft.VisualBasic',
      `$p=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}'))`,
      'try {',
      '  if (Test-Path -LiteralPath $p -PathType Container) {',
      "    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,'OnlyErrorDialogs','SendToRecycleBin')",
      '  } else {',
      "    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin')",
      '  }',
      '  exit 0',
      `} catch { $_.Exception.Message | Out-File -FilePath '${errFile.replace(/'/g, "''")}' -Encoding utf8; exit 1 }`,
    ].join('\n');
    // stdio 用 ignore：沙箱环境禁止管道式 spawn（EPERM），错误详情走临时文件
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], {
      windowsHide: true,
      stdio: 'ignore',
    });
    ps.on('close', async (code) => {
      if (code === 0) return resolve();
      let detail = '';
      try { detail = (await fsp.readFile(errFile, 'utf8')).trim(); await fsp.unlink(errFile); } catch { /* ignore */ }
      reject(new Error(detail.slice(0, 300) || `PowerShell 退出码 ${code}（文件可能正被占用）`));
    });
    ps.on('error', (e) => reject(new Error(`无法调用 PowerShell：${e.message}`)));
  });
}

/** 从根到某路径的节点链 */
function chainTo(root, absPath) {
  const rp = root.p.replace(/[\\/]+$/, '').toLowerCase();
  const tp = String(absPath).replace(/[\\/]+$/, '').toLowerCase();
  const chain = [root];
  if (tp === rp) return chain;
  if (!tp.startsWith(rp)) return null;
  const rel = tp.slice(rp.length).replace(/^[\\/]+/, '');
  let cur = root;
  for (const seg of rel.split(/[\\/]/).filter(Boolean)) {
    if (!cur.c) return null;
    cur = cur.c.find((k) => k.n.toLowerCase() === seg.toLowerCase());
    if (!cur) return null;
    chain.push(cur);
  }
  return chain;
}

/** 删除成功后把节点从内存树里摘掉，保证统计不虚高 */
function removeFromTree(tree, absPath) {
  const target = absPath.replace(/[\\/]+$/, '');
  const parentPath = path.dirname(target);
  const chain = chainTo(tree, parentPath);
  if (!chain) return false;
  const parent = chain[chain.length - 1];
  if (!parent.c) return false;
  const idx = parent.c.findIndex((k) => k.p.replace(/[\\/]+$/, '').toLowerCase() === target.toLowerCase());
  if (idx < 0) return false;
  const [removed] = parent.c.splice(idx, 1);
  for (const nd of chain) {
    nd.s = Math.max(0, nd.s - removed.s);
    nd.fc = Math.max(0, (nd.fc || 0) - (removed.fc || 0));
  }
  return true;
}

async function logDeletion(job) {
  try {
    await fsp.appendFile(path.join(DATA_DIR, 'deletions.jsonl'), JSON.stringify({
      ts: new Date().toISOString(), path: job.path, mode: job.mode,
      status: job.status, error: job.error, elapsedMs: job.elapsedMs, estSize: job.estSize,
    }) + '\n');
  } catch { /* ignore */ }
}

async function startDelete(target, mode, estSize) {
  const id = crypto.randomBytes(5).toString('hex');
  const job = {
    id, path: target, mode, status: 'running', error: null,
    startedAt: Date.now(), elapsedMs: 0, estSize, treeUpdated: false,
  };
  deleteJobs.set(id, job);

  (async () => {
    const t0 = Date.now();
    try {
      if (mode === 'recycle') {
        await recycleToBin(target);
      } else {
        await fsp.rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 });
      }
      job.status = 'done';
      job.elapsedMs = Date.now() - t0;
      const scanJob = [...jobs.values()].find((j) => j.tree);
      if (scanJob) {
        job.treeUpdated = removeFromTree(scanJob.tree, target);
        if (job.treeUpdated) scanJob.candidates = buildCandidates(scanJob.tree);
      }
    } catch (e) {
      job.status = 'error';
      job.error = friendlyError(e);
      job.elapsedMs = Date.now() - t0;
    }
    await logDeletion(job);
    setTimeout(() => deleteJobs.delete(id), 10 * 60 * 1000);
  })();

  return job;
}

// ---------------------------------------------------------------- 路由
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = decodeURIComponent(url.pathname);

  try {
    // ---------- 静态文件 ----------
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const html = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (req.method === 'GET' && p.startsWith('/static/')) {
      const rel = p.slice('/static/'.length).replace(/\.\./g, '');
      const file = path.join(PUBLIC_DIR, rel);
      const data = await fsp.readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      return res.end(data);
    }

    // ---------- API ----------
    if (p === '/api/status') {
      const drives = driveInfo();
      const latest = [...jobs.values()].filter((j) => j.status === 'done').sort((a, b) => b.finishedAt - a.finishedAt)[0] || null;
      return json(res, 200, {
        drives,
        rules: RULE_COUNT,
        ai: {
          enabled: settings.ai.enabled !== false,
          available: aiAvailable(settings.ai),
          baseURL: settings.ai.baseURL,
          model: settings.ai.model,
          hasKey: !!resolveApiKey(settings.ai),
          keyFromEnv: !settings.ai.apiKey && !!process.env[settings.ai.apiKeyEnv || ''],
          apiKeyEnv: settings.ai.apiKeyEnv,
        },
        latestScan: latest ? { id: latest.id, root: latest.root, finishedAt: latest.finishedAt, size: latest.tree.s, stats: latest.tree.stats } : null,
        scan: settings.scan,
        lastRoot: settings.lastRoot,
      });
    }

    if (p === '/api/drives') return json(res, 200, { drives: driveInfo() });

    if (p === '/api/settings' && req.method === 'GET') {
      const { apiKey, ...rest } = settings.ai;
      return json(res, 200, {
        ai: { ...rest, hasKey: !!resolveApiKey(settings.ai), keyPreview: apiKey ? apiKey.slice(0, 4) + '****' : '' },
        scan: settings.scan, lastRoot: settings.lastRoot,
      });
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.ai) {
        const next = { ...settings.ai };
        for (const k of ['enabled', 'baseURL', 'model', 'apiKeyEnv', 'timeoutMs', 'temperature']) {
          if (body.ai[k] !== undefined) next[k] = body.ai[k];
        }
        if (typeof body.ai.apiKey === 'string') next.apiKey = body.ai.apiKey.trim();
        if (body.ai.clearKey) next.apiKey = '';
        settings.ai = next;
      }
      if (body.scan) settings.scan = { ...settings.scan, ...body.scan };
      if (body.lastRoot) settings.lastRoot = body.lastRoot;
      await saveSettings();
      return json(res, 200, { ok: true, aiAvailable: aiAvailable(settings.ai) });
    }

    if (p === '/api/settings/test' && req.method === 'POST') {
      const r = await testConnection(settings.ai);
      return json(res, 200, r);
    }

    if (p === '/api/scan' && req.method === 'POST') {
      const body = await readBody(req);
      const root = normalizeRoot(body.root || settings.lastRoot || 'C:\\');
      settings.lastRoot = root;
      saveSettings().catch(() => {});
      // 同一根目录且已完成的扫描直接复用
      if (!body.force) {
        const existing = [...jobs.values()].find((j) => normalizeRoot(j.root) === root && j.status === 'done');
        if (existing) {
          return json(res, 200, { id: existing.id, reused: true, root: existing.root });
        }
      }
      const job = await startScan(root);
      return json(res, 200, { id: job.id, reused: false, root: job.root });
    }

    if (p === '/api/scan/stream') {
      const id = url.searchParams.get('id');
      const job = jobs.get(id);
      if (!job) return json(res, 404, { error: '任务不存在' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`data: ${JSON.stringify({ type: 'progress', ...job.progress })}\n\n`);
      if (job.status === 'done') {
        res.write(`data: ${JSON.stringify({ type: 'done', stats: job.tree.stats, size: job.tree.s })}\n\n`);
        return res.end();
      }
      if (job.status === 'error') {
        res.write(`data: ${JSON.stringify({ type: 'error', error: job.error })}\n\n`);
        return res.end();
      }
      job.listeners.add(res);
      const ka = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { /* ignore */ } }, 15000);
      req.on('close', () => { clearInterval(ka); job.listeners.delete(res); });
      return;
    }

    if (p === '/api/scan/cancel' && req.method === 'POST') {
      const body = await readBody(req);
      const job = jobs.get(body.id);
      if (job?.abort) job.abort.abort();
      return json(res, 200, { ok: true });
    }

    if (p === '/api/children') {
      const id = url.searchParams.get('id');
      const target = url.searchParams.get('path');
      // id 可能失效（服务重启 / 旧页面），自动回退到最近一次完成的扫描
      let job = id ? jobs.get(id) : null;
      if (!job || !job.tree) job = latestDoneJob();
      if (!job || !job.tree) return json(res, 404, { error: '还没有扫描结果，请先点右上角「扫描」', noScan: true });
      const node = findNode(job.tree, target);
      if (!node) {
        return json(res, 404, {
          error: `路径不在当前扫描结果中（可能已被聚合，或扫描后又新增了）`,
          path: target,
          scanId: job.id,
          root: job.root,
        });
      }
      // 前 90 大的子项给 3 层预览（2 层下钻），其余只给 1 层，控制 JSON 体积
      // 先按忽略列表过滤
      const all = node.c || [];
      const shown = [];
      let hiddenCount = 0;
      let hiddenSize = 0;
      for (const k of all) {
        if (matchIgnore(k.p)) { hiddenCount++; hiddenSize += k.s || 0; }
        else shown.push(k);
      }
      const children = shown.map((k, i) => nodeBrief(k, {
        previewDepth: i < 90 ? 3 : 1,
        branch: i < 90 ? 8 : 6,
      }));
      return json(res, 200, {
        node: nodeBrief(node),
        total: node.s,
        children,
        agg: node.a || null,
        scanId: job.id,
        hidden: hiddenCount ? { count: hiddenCount, size: hiddenSize } : null,
        ignoreCount: ignoreList.length,
      });
    }

    if (p === '/api/expand') {
      const target = url.searchParams.get('path');
      if (!target) return json(res, 400, { error: '缺少 path' });
      const shallow = await scanShallow(target, { depth: 1, limit: 300 });
      return json(res, 200, shallow);
    }

    if (p === '/api/rule') {
      const target = url.searchParams.get('path');
      if (!target) return json(res, 400, { error: '缺少 path' });
      const isDir = url.searchParams.get('dir') !== '0';
      const r = analyzePath(target, { isDir, name: path.basename(target) });
      return json(res, 200, r);
    }

    if (p === '/api/analyze' && req.method === 'POST') {
      const body = await readBody(req);
      const { path: target, scanId } = body;
      if (!target) return json(res, 400, { error: '缺少 path' });
      const job = scanId ? jobs.get(scanId) : latestDoneJob();
      const node = job ? findNode(job.tree, target) : null;

      const item = {
        path: target,
        name: node?.n || path.basename(target),
        isDir: node ? node.d : !/\.\w{1,8}$/.test(target),
        size: node?.s ?? body.size ?? 0,
        fileCount: node?.fc ?? null,
        mtime: node?.t || null,
        topChildren: node?.c ? node.c.slice(0, 12).map((c) => ({ name: c.n, size: c.s, isDir: c.d })) : [],
        exts: node?.c ? summarizeExts(node.c) : [],
      };
      const ctx = { disk: body.disk || null };
      const rule = analyzePath(target, { isDir: item.isDir, name: item.name });

      // 采集真实证据：体积构成、文件类型、时间分布（大目录有文件数上限，保证响应速度）
      let evidence = null;
      if (item.isDir && fs.existsSync(target)) {
        try {
          evidence = await scanShallow(target, { depth: 2, maxFiles: 30000 });
        } catch { /* 权限不足时降级 */ }
      }

      if (aiAvailable(settings.ai)) {
        const result = await analyzeTarget({ ...item, evidence, rule }, ctx, settings.ai);
        return json(res, 200, { ...result, item, evidence: evidence ? slimEvidence(evidence) : null });
      }
      // 无 AI：用「规则 + 实测证据」推理，结论里的每个数字都是现测的
      const result = analyzeWithEvidence(item, rule, evidence);
      return json(res, 200, { ...result, item });
    }

    if (p === '/api/analyze/batch' && req.method === 'POST') {
      const body = await readBody(req);
      const { paths, scanId } = body;
      if (!Array.isArray(paths) || !paths.length) return json(res, 400, { error: '缺少 paths' });
      const job = scanId ? jobs.get(scanId) : latestDoneJob();
      const items = [];
      for (const target of paths.slice(0, 24)) {
        const node = job ? findNode(job.tree, target) : null;
        items.push({
          path: target,
          name: node?.n || path.basename(target),
          isDir: node ? node.d : true,
          size: node?.s ?? 0,
          fileCount: node?.fc ?? null,
          mtime: node?.t || null,
          topChildren: node?.c ? node.c.slice(0, 10).map((c) => ({ name: c.n, size: c.s, isDir: c.d })) : [],
          exts: node?.c ? summarizeExts(node.c) : [],
        });
      }
      const results = await analyzeBatch(items, { disk: body.disk || null }, settings.ai);
      return json(res, 200, { results, aiAvailable: aiAvailable(settings.ai) });
    }

    if (p === '/api/candidates') {
      const id = url.searchParams.get('id');
      const job = jobs.get(id) || latestDoneJob();
      if (!job?.candidates) return json(res, 404, { error: '暂无扫描结果' });
      const minSize = Number(url.searchParams.get('min') || 0);
      const safetyFilter = url.searchParams.get('safety');
      let list = job.candidates.list.filter((c) => c.size >= minSize);
      if (safetyFilter) {
        const set = new Set(safetyFilter.split(','));
        list = list.filter((c) => set.has(c.safety));
      }
      return json(res, 200, {
        list: list.slice(0, 300),
        totals: job.candidates.totals,
        scanId: job.id,
        root: job.root,
      });
    }

    // ---------- 忽略列表 ----------
    if (p === '/api/ignore' && req.method === 'GET') {
      return json(res, 200, { items: ignoreList });
    }

    if (p === '/api/ignore' && req.method === 'POST') {
      const body = await readBody(req);
      const paths = Array.isArray(body.paths) ? body.paths.slice(0, 500) : (body.path ? [body.path] : []);
      const note = String(body.note || '').slice(0, 120);
      let added = 0;
      for (const raw of paths) {
        const pattern = String(raw || '').trim();
        if (!pattern) continue;
        if (ignoreList.some((x) => normAbs(x.pattern) === normAbs(pattern))) continue;
        ignoreList.push({ pattern, note, addedAt: Date.now() });
        added++;
      }
      if (added) await saveIgnore();
      return json(res, 200, { ok: true, added, total: ignoreList.length });
    }

    if (p === '/api/ignore/remove' && req.method === 'POST') {
      const body = await readBody(req);
      const patterns = Array.isArray(body.patterns) ? body.patterns : (body.pattern ? [body.pattern] : []);
      const before = ignoreList.length;
      ignoreList = ignoreList.filter((x) => !patterns.some((p2) => normAbs(p2) === normAbs(x.pattern)));
      await saveIgnore();
      return json(res, 200, { ok: true, removed: before - ignoreList.length, total: ignoreList.length });
    }

    if (p === '/api/reveal' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.path) return json(res, 400, { error: '缺少 path' });
      if (!fs.existsSync(body.path)) return json(res, 404, { error: '路径不存在' });
      try {
        await openInExplorer(body.path, body.mode === 'open');
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 500, { error: friendlyError(e) });
      }
    }

    // ---------- 删除 ----------
    if (p === '/api/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const mode = body.mode === 'permanent' ? 'permanent' : 'recycle';
      let target;
      try {
        target = normalizeDeletePath(body.path);
        checkDeletable(target);
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
      if (!fs.existsSync(target)) return json(res, 404, { error: '路径不存在（可能已被删除）' });

      // 含用户数据的目录/文件只允许进回收站，不允许永久删除
      let isDir = true;
      try { isDir = fs.statSync(target).isDirectory(); } catch { /* ignore */ }
      const rule = analyzePath(target, { isDir, name: path.basename(target) });
      if (rule.safety === 'danger' && mode === 'permanent') {
        return json(res, 403, { error: '该路径包含用户数据，只允许移到回收站', safety: rule.safety });
      }
      if (rule.safety === 'keep' && mode === 'permanent') {
        return json(res, 403, { error: '该路径属于系统关键组件，禁止在此删除', safety: rule.safety });
      }

      const job = await startDelete(target, mode, body.size);
      return json(res, 200, { id: job.id, path: target, mode, status: 'started' });
    }

    // 批量删除（多选）
    if (p === '/api/delete/batch' && req.method === 'POST') {
      const body = await readBody(req);
      const mode = body.mode === 'permanent' ? 'permanent' : 'recycle';
      const list = Array.isArray(body.paths) ? body.paths.slice(0, 200) : [];
      if (!list.length) return json(res, 400, { error: '没有选中任何项' });

      const results = [];
      for (const raw of list) {
        let target;
        try {
          target = normalizeDeletePath(raw);
          checkDeletable(target);
          if (!fs.existsSync(target)) { results.push({ path: raw, status: 'missing' }); continue; }
          let isDir = true;
          try { isDir = fs.statSync(target).isDirectory(); } catch { /* ignore */ }
          const rule = analyzePath(target, { isDir, name: path.basename(target) });
          if (mode === 'permanent' && (rule.safety === 'danger' || rule.safety === 'keep')) {
            results.push({ path: raw, status: 'skipped', error: rule.safety === 'keep' ? '系统关键路径，已跳过' : '含用户数据，只能移到回收站' });
            continue;
          }
          if (mode === 'recycle') await recycleToBin(target);
          else await fsp.rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 });
          removeFromTree([...jobs.values()].find((j) => j.tree)?.tree, target);
          results.push({ path: raw, status: 'done' });
        } catch (e) {
          results.push({ path: raw, status: 'error', error: friendlyError(e) });
        }
      }
      const scanJob = [...jobs.values()].find((j) => j.tree);
      if (scanJob) scanJob.candidates = buildCandidates(scanJob.tree);
      const done = results.filter((r) => r.status === 'done').length;
      return json(res, 200, { results, done, failed: results.length - done });
    }

    // 单独重扫某个子目录
    if (p === '/api/rescan' && req.method === 'POST') {
      const body = await readBody(req);
      let target;
      try { target = normalizeDeletePath(body.path); } catch (e) { return json(res, 400, { error: e.message }); }
      const job = body.scanId ? jobs.get(body.scanId) : latestDoneJob();
      if (!job?.tree) return json(res, 404, { error: '还没有扫描结果' });
      if (!fs.existsSync(target)) return json(res, 404, { error: '路径不存在' });

      const parentPath = path.dirname(target);
      const chain = chainTo(job.tree, parentPath);
      if (!chain) return json(res, 400, { error: '该目录不在当前扫描范围内（或层级太深已被合并）' });
      const parent = chain[chain.length - 1];
      const idx = parent.c ? parent.c.findIndex((k) => k.p.replace(/[\\/]+$/, '').toLowerCase() === target.toLowerCase()) : -1;
      if (idx < 0) return json(res, 400, { error: '该目录不在当前层的展开结果中' });

      const oldNode = parent.c[idx];
      const fresh = await scanTree(target, settings.scan, {});
      const deltaS = fresh.s - oldNode.s;
      const deltaF = (fresh.fc || 0) - (oldNode.fc || 0);
      fresh.n = oldNode.n;
      parent.c[idx] = fresh;
      for (const nd of chain) {
        nd.s = Math.max(0, nd.s + deltaS);
        nd.fc = Math.max(0, (nd.fc || 0) + deltaF);
      }
      job.candidates = buildCandidates(job.tree);
      return json(res, 200, {
        ok: true,
        deltaSize: deltaS,
        node: nodeBrief(fresh, { previewDepth: 3, branch: 8 }),
        stats: fresh.stats,
      });
    }

    // 分析后追问
    if (p === '/api/chat' && req.method === 'POST') {
      const body = await readBody(req);
      const { messages, context } = body;
      if (!Array.isArray(messages) || !messages.length) return json(res, 400, { error: '缺少消息' });
      if (aiAvailable(settings.ai)) {
        try {
          const answer = await chatFollowUp(context || {}, messages, settings.ai);
          return json(res, 200, { source: 'ai', answer, model: settings.ai.model });
        } catch (e) {
          return json(res, 200, { source: 'local', answer: localFollowUp(context || {}, messages), aiError: String(e.message || e) });
        }
      }
      return json(res, 200, { source: 'local', answer: localFollowUp(context || {}, messages) });
    }

    if (p === '/api/delete/status') {
      const job = deleteJobs.get(url.searchParams.get('id'));
      if (!job) return json(res, 404, { error: '任务不存在或已过期' });
      return json(res, 200, {
        id: job.id, path: job.path, mode: job.mode, status: job.status,
        error: job.error, elapsedMs: job.elapsedMs, estSize: job.estSize,
        treeUpdated: job.treeUpdated,
      });
    }

    if (p === '/api/ping') return json(res, 200, { ok: true, ts: Date.now() });

    return json(res, 404, { error: 'Not Found', path: p });
  } catch (e) {
    if (!res.headersSent) return json(res, 500, { error: String(e.message || e) });
    try { res.end(); } catch { /* ignore */ }
  }
});

function summarizeExts(children) {
  const m = new Map();
  for (const c of children) {
    if (c.d) continue;
    const ext = c.x || '(none)';
    m.set(ext, (m.get(ext) || 0) + c.s);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([ext, size]) => ({ ext, size }));
}

/** 证据瘦身：只保留前端要用到的部分 */
function slimEvidence(ev) {
  return {
    totalSize: ev.totalSize,
    fileCount: ev.fileCount,
    dirCount: ev.dirCount,
    errorCount: ev.errorCount,
    topDirs: (ev.topDirs || []).slice(0, 8),
    topFiles: (ev.topFiles || []).slice(0, 8),
    exts: (ev.exts || []).slice(0, 10),
    age: ev.age,
  };
}

// ---------------------------------------------------------------- 启动
const loaded = await loadLatestCache();

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/`;
  console.log('');
  console.log('  ┌───────────────────────────────────────────────┐');
  console.log('  │   DiskLens · 磁盘空间分析器                    │');
  console.log('  └───────────────────────────────────────────────┘');
  console.log(`  地址:   ${url}`);
  console.log(`  规则库: ${RULE_COUNT} 条`);
  console.log(`  AI:     ${aiAvailable(settings.ai) ? `已启用 (${settings.ai.model})` : '未配置 Key（使用内置规则库）'}`);
  if (loaded) console.log(`  缓存:   已载入上次扫描 ${loaded.root} (${human(loaded.tree.s)})`);
  console.log('  按 Ctrl+C 退出');
  console.log('');
  if (process.argv.includes('--open')) {
    spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
});

process.on('SIGINT', () => {
  console.log('\n正在退出…');
  process.exit(0);
});
