/**
 * 磁盘扫描引擎
 * - 递归遍历目录，构建"大小树"
 * - 小项自动聚合，避免节点爆炸
 * - 支持进度回调、取消、并发限流
 *
 * 节点字段（短名是为了减小缓存体积）：
 *   n  名称      p  绝对路径   d  是否目录
 *   s  总字节    fc 文件数     dc 子目录数   t  最新修改时间(ms)
 *   c  子节点数组（目录）      a  {count,size} 被省略项的聚合
 *   e  错误码（无法访问时）
 */
import fs from 'node:fs/promises';
import path from 'node:path';

class Semaphore {
  constructor(n) { this.n = n; this.q = []; }
  async acquire() {
    if (this.n > 0) { this.n--; return; }
    await new Promise((r) => this.q.push(r));
  }
  release() {
    const r = this.q.shift();
    if (r) r(); else this.n++;
  }
}

const DEFAULT_OPTS = {
  maxDepth: 16,            // 超过此深度只累加大小，不建节点
  maxChildren: 512,        // 每层最多保留的子项数
  aggThreshold: 48 * 1024, // 小于此大小的项聚合进 a
  concurrency: 48,         // 文件系统并发数
  maxNodes: 4_000_000,     // 全局节点上限保护
};

function safePath(p) {
  if (process.platform === 'win32' && p.length >= 250 && !p.startsWith('\\\\?\\')) {
    return '\\\\?\\' + p;
  }
  return p;
}

export async function scanTree(rootAbs, options = {}, hooks = {}) {
  const opts = { ...DEFAULT_OPTS, ...options };
  const sem = new Semaphore(opts.concurrency);
  const signal = hooks.signal;

  const stats = {
    files: 0, dirs: 0, bytes: 0,
    errors: 0, denied: 0, skippedLinks: 0,
    startedAt: Date.now(), current: '',
  };

  let lastEmit = 0;
  const emit = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < 200) return;
    lastEmit = now;
    hooks.onProgress?.({
      files: stats.files, dirs: stats.dirs, bytes: stats.bytes,
      errors: stats.errors, denied: stats.denied,
      skippedLinks: stats.skippedLinks,
      current: stats.current, elapsedMs: now - stats.startedAt,
    });
  };

  const checkCancel = () => {
    if (signal?.aborted) {
      const err = new Error('扫描已取消');
      err.code = 'ABORTED';
      throw err;
    }
  };

  async function readDir(abs) {
    await sem.acquire();
    try {
      return await fs.readdir(safePath(abs), { withFileTypes: true });
    } finally { sem.release(); }
  }

  async function statOf(abs) {
    await sem.acquire();
    try { return await fs.lstat(safePath(abs)); }
    finally { sem.release(); }
  }

  /** 深扫一个目录仅求总大小与文件数（不建树） */
  async function quickSize(abs, maxEntries = 500_000) {
    let total = 0, files = 0, dirs = 0, guard = 0;
    const stack = [abs];
    while (stack.length) {
      checkCancel();
      const cur = stack.pop();
      let ents;
      try { ents = await readDir(cur); } catch { stats.errors++; continue; }
      files -= 0; // noop
      for (const ent of ents) {
        if (++guard > maxEntries) break;
        if (ent.isSymbolicLink()) continue;
        const p = path.join(cur, ent.name);
        if (ent.isDirectory()) { dirs++; stack.push(p); continue; }
        if (!ent.isFile()) continue;
        try {
          const st = await statOf(p);
          total += st.size || 0;
          stats.files++; stats.bytes += st.size || 0;
          files++;
          emit();
        } catch { stats.errors++; }
      }
    }
    return { size: total, files, dirs };
  }

  async function walk(abs, name, depth) {
    checkCancel();
    const node = { n: name, p: abs, d: true, s: 0, fc: 0, dc: 0, t: 0 };
    stats.nodes = (stats.nodes || 0) + 1;

    let entries;
    try {
      stats.current = abs;
      entries = await readDir(abs);
    } catch (e) {
      stats.errors++;
      if (['EACCES', 'EPERM', 'EBUSY'].includes(e.code)) stats.denied++;
      node.e = e.code || 'ERR';
      return node;
    }
    stats.dirs++;

    const real = [];       // 真实节点
    let aggSize = 0;       // 被省略项的字节数
    let aggFiles = 0;      // 被省略的文件数
    let aggDirs = 0;       // 被省略的目录数
    let aggSeconds = 0;

    const tasks = entries.map(async (ent) => {
      if (ent.isSymbolicLink()) { stats.skippedLinks++; return; }
      const childAbs = path.join(abs, ent.name);

      if (ent.isDirectory()) {
        if (depth + 1 > opts.maxDepth) {
          const q = await quickSize(childAbs);
          aggSize += q.size; aggFiles += q.files; aggDirs += q.dirs + 1;
          return;
        }
        const sub = await walk(childAbs, ent.name, depth + 1);
        real.push(sub);
        return;
      }
      if (!ent.isFile()) return;

      try {
        const st = await statOf(childAbs);
        const size = st.size || 0;
        stats.files++; stats.bytes += size;
        if (depth >= 1 && size < opts.aggThreshold) {
          aggSize += size; aggFiles += 1;
        } else {
          real.push({
            n: ent.name, p: childAbs, d: false, s: size,
            fc: 0, dc: 0, t: st.mtimeMs || 0, x: extOf(ent.name),
          });
        }
        emit();
      } catch (e) {
        stats.errors++;
        if (e.code === 'EACCES' || e.code === 'EPERM') stats.denied++;
      }
    });

    await Promise.all(tasks);

    // ---- 汇总 ----
    for (const k of real) {
      node.s += k.s;
      node.fc += k.d ? k.fc : 1;
      node.dc += k.d ? (1 + k.dc) : 0;
      if (k.t > node.t) node.t = k.t;
    }
    node.s += aggSize;
    node.fc += aggFiles;
    node.dc += aggDirs;

    // ---- 控制子节点数量 ----
    if (real.length) {
      real.sort((a, b) => b.s - a.s);
      let kept = real;
      if (real.length > opts.maxChildren) {
        kept = real.slice(0, opts.maxChildren);
        for (let i = opts.maxChildren; i < real.length; i++) {
          const k = real[i];
          aggSize += k.s;
          aggFiles += k.d ? k.fc : 1;
          aggDirs += k.d ? (1 + k.dc) : 0;
        }
      }
      // 深度 >= 2 处再聚合掉看不见的微小项，减少节点数
      const final = [];
      for (const k of kept) {
        if (depth >= 2 && k.s < opts.aggThreshold) {
          aggSize += k.s;
          aggFiles += k.d ? k.fc : 1;
          aggDirs += k.d ? (1 + k.dc) : 0;
        } else final.push(k);
      }
      node.c = final.length ? final : null;
      node.s = aggSize + final.reduce((a, b) => a + b.s, 0);
    } else {
      node.c = null;
    }

    if (aggFiles || aggDirs) {
      node.a = { count: aggFiles + aggDirs, files: aggFiles, dirs: aggDirs, size: aggSize };
    }

    // 内存剪枝：小目录的子树在父级本来就会被聚合掉，这里提前释放引用，
    // 避免深递归时把整棵小目录树都留在内存里（全盘扫描峰值可降 60%+）
    if (depth >= 1 && node.s < opts.aggThreshold && node.c) {
      node.c = null;
    }
    return node;
  }

  const rootName = rootAbs.replace(/[\\/]+$/, '') || rootAbs;
  const root = await walk(rootAbs, path.basename(rootName) || rootName, 0);
  emit(true);
  root.stats = {
    files: stats.files, dirs: stats.dirs, errors: stats.errors,
    denied: stats.denied, skippedLinks: stats.skippedLinks,
    elapsedMs: Date.now() - stats.startedAt,
  };
  return root;
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return '';
  return name.slice(i + 1).toLowerCase();
}

/**
 * 精确浅扫某个目录（用于展开聚合节点 / 给 AI 提供上下文）
 */
export async function scanShallow(dirAbs, { depth = 4, limit = 400, maxFiles = 60000 } = {}) {
  const extMap = new Map();
  const topFiles = [];
  let fileCount = 0, dirCount = 0, errorCount = 0;
  const topDirs = [];
  const nowMs = Date.now();
  const DAY = 86400000;
  const ageBuckets = { fresh: 0, mid: 0, old: 0, ancient: 0 };
  const ageBytes = { fresh: 0, mid: 0, old: 0, ancient: 0 };
  let newestMtime = 0, oldestMtime = Infinity, newestName = '', oldestName = '';

  async function rec(abs, d) {
    if (d > depth) return 0;
    if (fileCount > maxFiles) return 0;   // 超大目录提前收敛，保证响应速度
    let ents;
    try { ents = await fs.readdir(safePath(abs), { withFileTypes: true }); }
    catch { errorCount++; return 0; }
    let sum = 0;
    for (const ent of ents) {
      if (ent.isSymbolicLink()) continue;
      const p = path.join(abs, ent.name);
      if (ent.isDirectory()) {
        if (d === 0) {
          const sz = await rec(p, d + 1);
          dirCount++;
          topDirs.push({ name: ent.name, path: p, size: sz });
          sum += sz;
        } else {
          sum += await rec(p, d + 1);
        }
        continue;
      }
      if (!ent.isFile()) continue;
      try {
        const st = await fs.lstat(safePath(p));
        const s = st.size || 0;
        sum += s; fileCount++;
        // 时间分布是判断"还能不能用"最硬的证据
        const ageDays = (nowMs - (st.mtimeMs || nowMs)) / DAY;
        if (ageDays < 30) { ageBuckets.fresh++; ageBytes.fresh += s; }
        else if (ageDays < 90) { ageBuckets.mid++; ageBytes.mid += s; }
        else if (ageDays < 365) { ageBuckets.old++; ageBytes.old += s; }
        else { ageBuckets.ancient++; ageBytes.ancient += s; }
        if ((st.mtimeMs || 0) > newestMtime) { newestMtime = st.mtimeMs || 0; newestName = ent.name; }
        if ((st.mtimeMs || nowMs) < oldestMtime) { oldestMtime = st.mtimeMs || nowMs; oldestName = ent.name; }
        const e = extOf(ent.name) || '(none)';
        extMap.set(e, (extMap.get(e) || 0) + s);
        if (topFiles.length < limit) topFiles.push({ name: ent.name, path: p, size: s, mtime: st.mtimeMs });
        else {
          let minI = 0;
          for (let i = 1; i < topFiles.length; i++) if (topFiles[i].size < topFiles[minI].size) minI = i;
          if (s > topFiles[minI].size) topFiles[minI] = { name: ent.name, path: p, size: s, mtime: st.mtimeMs };
        }
      } catch { errorCount++; }
    }
    return sum;
  }

  const total = await rec(dirAbs, 0);
  topDirs.sort((a, b) => b.size - a.size);
  topFiles.sort((a, b) => b.size - a.size);
  const exts = [...extMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
    .map(([ext, size]) => ({ ext, size }));

  const daysSince = (ms) => (ms && isFinite(ms) ? Math.floor((nowMs - ms) / DAY) : null);
  const truncated = fileCount >= maxFiles;

  return {
    path: dirAbs, totalSize: total, fileCount, dirCount, errorCount, truncated,
    topDirs: topDirs.slice(0, 30), topFiles: topFiles.slice(0, 40), exts,
    age: {
      buckets: ageBuckets,
      bytes: ageBytes,
      newestDays: daysSince(newestMtime),
      newestName,
      oldestDays: daysSince(oldestMtime),
      oldestName,
      // 90 天以上未修改的体积占比 —— 判断"是否已陈旧"的关键指标
      staleRatio: total > 0 ? (ageBytes.old + ageBytes.ancient) / total : 0,
    },
  };
}
