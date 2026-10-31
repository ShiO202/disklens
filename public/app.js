/* DiskLens 前端逻辑 */

const $ = (s) => document.querySelector(s);

const el = {
  driveChip: $('#driveChip'), meterFill: $('#meterFill'), driveNum: $('#driveNum'),
  rootSelect: $('#rootSelect'), btnScan: $('#btnScan'), btnCancel: $('#btnCancel'), btnScanBig: $('#btnScanBig'),
  crumbs: $('#crumbs'), wrap: $('#canvasWrap'),
  tm: $('#treemap'), ov: $('#overlay'),
  tooltip: $('#tooltip'), emptyState: $('#emptyState'), scanState: $('#scanState'),
  scanTitle: $('#scanTitle'), scanPath: $('#scanPath'), scanStats: $('#scanStats'), scanBarFill: $('#scanBarFill'),
  legend: $('#legend'), statline: $('#statline'),
  detailEmpty: $('#detailEmpty'), detailBody: $('#detailBody'),
  detailBadges: $('#detailBadges'), detailName: $('#detailName'), detailPath: $('#detailPath'),
  detailMetrics: $('#detailMetrics'), ruleCard: $('#ruleCard'),
  btnAI: $('#btnAI'), aiBtnText: $('#aiBtnText'), aiResult: $('#aiResult'),
  cleanSummary: $('#cleanSummary'), cleanList: $('#cleanList'), cleanFilters: $('#cleanFilters'),
  cleanBadge: $('#cleanBadge'), btnExportPlan: $('#btnExportPlan'),
  toast: $('#toast'), ruleCount: $('#ruleCount'),
  setBaseURL: $('#setBaseURL'), setModel: $('#setModel'), setApiKey: $('#setApiKey'), setApiKeyEnv: $('#setApiKeyEnv'),
  setDepth: $('#setDepth'), setAgg: $('#setAgg'), depthVal: $('#depthVal'), aggVal: $('#aggVal'),
  btnSaveSettings: $('#btnSaveSettings'), btnTestAI: $('#btnTestAI'), btnPresetDSH: $('#btnPresetDSH'),
  testResult: $('#testResult'),
  // 删除弹窗
  deleteModal: $('#deleteModal'), delTitle: $('#delTitle'), delName: $('#delName'), delPath: $('#delPath'),
  delMetrics: $('#delMetrics'), delWarn: $('#delWarn'), delNote: $('#delNote'),
  delConfirmBtn: $('#delConfirmBtn'),
  delProgress: $('#delProgress'), delProgressText: $('#delProgressText'),
  // 多选 / 追问 / 动态按钮
  detailActions: $('#detailActions'),
  multiBar: $('#multiBar'), multiCount: $('#multiCount'), multiSize: $('#multiSize'),
  multiDelete: $('#multiDelete'), multiClear: $('#multiClear'), multiIgnore: $('#multiIgnore'),
  followup: $('#followup'), fuHistory: $('#fuHistory'), fuInput: $('#fuInput'), fuSend: $('#fuSend'),
  ignoreInput: $('#ignoreInput'), ignoreAddBtn: $('#ignoreAddBtn'), ignoreList: $('#ignoreList'),
};

// ── 配色策略 ──────────────────────────────────────────────
// 色相：按「目录族」分配，同族继承同一色相、只在明度上分层
//       （单一 safety 着色会让 95GB 的目录整块死红，再好的色板也难看）
// 饱和度：按安全等级衰减，越危险越柔和，避免大面积刺眼
// 语义：每个大块左上角保留一枚 safety 色点
const FAMILY_HUES = [205, 168, 42, 286, 340, 108, 18, 252, 186, 320, 66, 228];
const SAT_BY_SAFETY = { safe: 74, caution: 64, danger: 48, keep: 58, unknown: 30 };
const SAFETY_LABEL = { safe: '可直接清理', caution: '可清理有代价', danger: '含数据需确认', keep: '关键勿删', unknown: '未知' };
const SAFETY_COLOR = {
  safe: '#34d399', caution: '#fbbf24', danger: '#fb7185', keep: '#60a5fa', unknown: '#94a3b8',
};

const state = {
  scanId: null, root: null, path: null, node: null,
  children: [], rects: [], selected: null, hover: null,
  scanning: false, status: null, viewW: 0, viewH: 0, dpr: 1,
  candidates: null, cleanFilter: 'all', es: null,
  drive: null, aiCache: new Map(), pendingDbl: null,
  selection: new Map(),      // 多选：path -> node
  chatContext: null,         // 当前分析对象的上下文
  chatHistory: [],           // 追问历史
};

// ================================================================ 工具
function fmtSize(b) {
  if (b == null || isNaN(b)) return '—';
  if (b < 1024) return `${b} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let n = b, i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)} ${u[i]}`;
}
function fmtNum(n) { return n == null ? '—' : n.toLocaleString('zh-CN'); }
function fmtDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const days = Math.floor((Date.now() - ms) / 86400000);
  const s = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (days < 1) return `${s}（今天）`;
  if (days < 30) return `${s}（${days} 天前）`;
  if (days < 365) return `${s}（${Math.floor(days / 30)} 个月前）`;
  return `${s}（${Math.floor(days / 365)} 年前）`;
}
const basename = (p) => { const s = String(p).replace(/[\\/]+$/, ''); const i = s.lastIndexOf('\\'); return i >= 0 ? s.slice(i + 1) : s; };
function toast(msg, ms = 2000) {
  el.toast.textContent = msg;
  el.toast.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.toast.classList.add('hidden'), ms);
}

async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const j = await r.json().catch(() => ({ error: 'bad json' }));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

// ================================================================ 布局：squarified treemap
function squarify(items, x, y, w, h) {
  const out = [];
  if (!items.length || w <= 0 || h <= 0) return out;
  const total = items.reduce((a, b) => a + b.value, 0);
  if (total <= 0) return out;

  const area = w * h;
  const nodes = items.map((it) => ({ ...it, area: (it.value / total) * area }))
    .sort((a, b) => b.area - a.area);

  let cx = x, cy = y, cw = w, ch = h;
  let i = 0;

  while (i < nodes.length) {
    const shortSide = Math.min(cw, ch);
    if (shortSide <= 0.01) break;

    const row = [nodes[i]];
    let best = worstRatio(row, shortSide);
    let j = i + 1;
    while (j < nodes.length) {
      const trial = row.concat(nodes[j]);
      const r = worstRatio(trial, shortSide);
      if (r <= best + 1e-9) { row.push(nodes[j]); best = r; j++; } else break;
    }

    const rowArea = row.reduce((s, n) => s + n.area, 0);
    // squarify 的行必须沿着容器的「短边」延伸，厚度沿长边增长。
    // （之前这里写成了 cw >= ch，方向反了，导致所有块都被拉成长条）
    const horizontal = cw <= ch;
    const thickness = horizontal ? rowArea / cw : rowArea / ch;
    let off = 0;
    for (const n of row) {
      const len = thickness > 0 ? n.area / thickness : 0;
      if (horizontal) {
        out.push({ ...n, x: cx + off, y: cy, w: Math.max(0, len), h: Math.max(0, thickness) });
      } else {
        out.push({ ...n, x: cx, y: cy + off, w: Math.max(0, thickness), h: Math.max(0, len) });
      }
      off += len;
    }
    if (horizontal) { cy += thickness; ch -= thickness; } else { cx += thickness; cw -= thickness; }
    i += row.length;
  }
  return out;
}

function worstRatio(row, shortSide) {
  if (!row.length || shortSide <= 0) return Infinity;
  let sum = 0, mx = -Infinity, mn = Infinity;
  for (const n of row) { sum += n.area; if (n.area > mx) mx = n.area; if (n.area < mn) mn = n.area; }
  if (sum <= 0 || mn <= 0) return Infinity;
  const s2 = shortSide * shortSide;
  return Math.max((s2 * mx) / (sum * sum), (sum * sum) / (s2 * mn));
}

// ================================================================ 绘制
function setupCanvas() {
  const rect = el.wrap.getBoundingClientRect();
  state.dpr = window.devicePixelRatio || 1;
  state.viewW = Math.max(10, Math.round(rect.width));
  state.viewH = Math.max(10, Math.round(rect.height));
  for (const c of [el.tm, el.ov]) {
    c.width = Math.round(state.viewW * state.dpr);
    c.height = Math.round(state.viewH * state.dpr);
    c.style.width = state.viewW + 'px';
    c.style.height = state.viewH + 'px';
    const ctx = c.getContext('2d');
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  }
}

function colorFor(hue, safety, depth, dL = 0) {
  const sat = SAT_BY_SAFETY[safety] ?? 30;
  const d = Math.min(depth, 3);
  const s = Math.max(7, sat - d * 4);
  const l = Math.max(9, Math.min(78, 33 + d * 8 + dL));
  return `hsl(${hue}, ${s}%, ${l}%)`;
}

/** 是否"整体功能单元"：整块显示，不再细分 */
function isAtomic(node) {
  return !!(node.an?.atomic || node.atomic);
}

function roundRectPath(ctx, x, y, w, h, r) {
  if (w <= 0 || h <= 0) return false;
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, rr);
    return true;
  }
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
  return true;
}

function drawHatch(ctx, r) {
  if (r.w * r.h < 900) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.strokeStyle = 'rgba(255,255,255,0.065)';
  ctx.lineWidth = 1;
  const step = 9;
  for (let i = -r.h; i < r.w; i += step) {
    ctx.beginPath();
    ctx.moveTo(r.x + i, r.y + r.h);
    ctx.lineTo(r.x + i + r.h, r.y);
    ctx.stroke();
  }
  ctx.restore();
}

const MAX_RENDER_DEPTH = 4;

function render() {
  const ctx = el.tm.getContext('2d');
  ctx.clearRect(0, 0, state.viewW, state.viewH);
  ctx.fillStyle = '#080b11';
  ctx.fillRect(0, 0, state.viewW, state.viewH);

  state.rects = [];
  if (!state.children.length) { el.legend.innerHTML = ''; return; }

  const items = state.children.filter((c) => c.s > 0).map((c) => ({ node: c, value: c.s }));
  const top = squarify(items, 0, 0, state.viewW, state.viewH);
  top.forEach((r, i) => {
    if (r.w < 1 || r.h < 1) return;
    drawNode(ctx, r, r.node, 0, null, FAMILY_HUES[i % FAMILY_HUES.length]);
  });

  renderLegend();
  renderStatline();
  drawOverlay();
}

/** 递归绘制一个节点（含其内部预览子树） */
function drawNode(ctx, r, node, depth, parentPath, hue) {
  if (r.w < 1 || r.h < 1) return;

  const nodePath = node.p || (parentPath ? parentPath + '\\' + node.n : node.n);
  const safety = node.an?.safety || node.safety || 'unknown';
  const atomic = isAtomic(node);
  const h = hue ?? FAMILY_HUES[0];

  // 块之间留 1px 缝隙，配合圆角显得精致
  const gap = depth === 0 ? 1.2 : 0.7;
  const bx = r.x + gap / 2;
  const by = r.y + gap / 2;
  const bw = Math.max(0.5, r.w - gap);
  const bh = Math.max(0.5, r.h - gap);
  const radius = depth === 0 ? 3 : 2;

  // 底色：同族同色相，明度随层级递进
  const grad = ctx.createLinearGradient(bx, by, bx + bw, by + bh);
  grad.addColorStop(0, colorFor(h, safety, depth, 6));
  grad.addColorStop(1, colorFor(h, safety, depth, -7));
  ctx.fillStyle = grad;
  if (roundRectPath(ctx, bx, by, bw, bh, radius)) ctx.fill();

  if (depth === 0 && bw > 20 && bh > 20) {
    const g = ctx.createLinearGradient(bx, by, bx, by + bh);
    g.addColorStop(0, 'rgba(255,255,255,0.07)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.015)');
    g.addColorStop(1, 'rgba(0,0,0,0.13)');
    ctx.fillStyle = g;
    if (roundRectPath(ctx, bx, by, bw, bh, radius)) ctx.fill();
  }

  // 整体功能单元：画斜纹，表示"这里不再拆"
  if (atomic && depth >= 1) drawHatch(ctx, { x: bx, y: by, w: bw, h: bh });

  // 记入命中表（父先入，子后入 → 反向遍历时子优先）
  state.rects.push({ x: r.x, y: r.y, w: r.w, h: r.h, node, depth, path: nodePath });

  // 亮边
  if (bw > 6 && bh > 6) {
    ctx.strokeStyle = depth === 0 ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    if (roundRectPath(ctx, bx + 0.5, by + 0.5, bw - 1, bh - 1, radius)) ctx.stroke();
  }

  // 递归子项
  const pv = node.pv;
  if (!atomic && pv && pv.length && depth < MAX_RENDER_DEPTH && r.w > 14 && r.h > 14) {
    const lh = labelHeight(r, depth);
    const inner = { x: bx + 1.5, y: by + 1.5 + lh, w: bw - 3, h: bh - 3 - lh };
    if (inner.w > 7 && inner.h > 7) {
      const subs = squarify(pv.filter((c) => c.s > 0).map((c) => ({ node: c, value: c.s })), inner.x, inner.y, inner.w, inner.h);
      // 子项沿用父色相，但同一父下的兄弟做细微色相偏移，避免完全糊成一片
      subs.forEach((s, i) => {
        if (s.w < 2.5 || s.h < 2.5) return;
        const childHue = h + ((i % 3) - 1) * 6;
        drawNode(ctx, s, s.node, depth + 1, nodePath, childHue);
      });
    }
  }

  drawLabel(ctx, r, node, depth, atomic, safety, h);
}

function labelHeight(r, depth) {
  if (depth === 0) return r.h > 26 && r.w > 64 ? 15 : 0;
  if (depth === 1) return r.h > 24 && r.w > 52 ? 12 : 0;
  return 0;
}

function drawLabel(ctx, r, node, depth, atomic, safety, hue) {
  if (depth > 1) return;
  if (depth === 0 && (r.w < 44 || r.h < 17)) return;
  if (depth === 1 && (r.w < 52 || r.h < 20)) return;

  const pad = depth === 0 ? 5 : 3;
  if (r.w - pad * 2 < 12) return;
  let size = depth === 0 ? Math.min(12.5, Math.max(9.5, r.w / 12)) : 9.5;
  if (depth === 0 && r.h < 26) size = 9.5;

  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, Math.min(r.h, 34));
  ctx.clip();

  ctx.textBaseline = 'top';

  // 左上角 safety 色点：颜色用于美观，语义靠这个点传达
  let textX = r.x + pad;
  if (depth === 0 && r.w > 78) {
    ctx.beginPath();
    ctx.arc(r.x + pad + 3.4, r.y + pad + size * 0.56, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = SAFETY_COLOR[safety] || SAFETY_COLOR.unknown;
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 3;
    ctx.fill();
    ctx.shadowBlur = 0;
    textX = r.x + pad + 11;
  }

  ctx.font = `600 ${size}px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.96)';
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = 3.5;

  const availW = r.x + r.w - pad - textX;
  const name = truncate(ctx, (atomic ? '▣ ' : '') + node.n, availW);
  ctx.fillText(name, textX, r.y + pad);

  if (depth === 0 && r.h > 33 && r.w > 62) {
    ctx.font = `500 ${size - 0.5}px -apple-system, "Segoe UI", sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.62)';
    ctx.fillText(fmtSize(node.s), textX, r.y + pad + size + 2);
  }
  ctx.restore();
}

function truncate(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid; else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + '…' : '';
}

/** 画选中/悬停框：选中用粗亮框 + 四角角标，悬停用细线 */
function drawRing(ctx, r, { strong }) {
  if (!r || r.w < 2 || r.h < 2) return;
  ctx.save();
  if (strong) {
    // 半透明白色蒙层，让选中块整体提亮
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    // 外发光 + 亮框
    ctx.shadowColor = 'rgba(255,255,255,0.9)';
    ctx.shadowBlur = 16;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.strokeRect(r.x + 1.5, r.y + 1.5, Math.max(0, r.w - 3), Math.max(0, r.h - 3));
    ctx.shadowBlur = 0;
    // 内圈细线，强化对比
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x + 4.5, r.y + 4.5, Math.max(0, r.w - 9), Math.max(0, r.h - 9));

    // 四角角标
    const arm = Math.min(18, Math.max(7, Math.min(r.w, r.h) * 0.28));
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    const x0 = r.x + 1.5, y0 = r.y + 1.5, x1 = r.x + r.w - 1.5, y1 = r.y + r.h - 1.5;
    const corners = [
      [x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1],
    ];
    for (const [cx, cy, dx, dy] of corners) {
      ctx.beginPath();
      ctx.moveTo(cx + dx * arm, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + dy * arm);
      ctx.stroke();
    }
  } else {
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 1.6;
    ctx.strokeRect(r.x + 0.8, r.y + 0.8, Math.max(0, r.w - 1.6), Math.max(0, r.h - 1.6));
  }
  ctx.restore();
}

function drawOverlay() {
  const ctx = el.ov.getContext('2d');
  ctx.clearRect(0, 0, state.viewW, state.viewH);

  // 1) 多选项：琥珀色描边 + 淡填充
  if (state.selection.size) {
    for (const p of state.selection.keys()) {
      const r = state.rects.find((x) => x.path === p);
      if (!r) continue;
      ctx.save();
      ctx.fillStyle = 'rgba(251,191,36,0.16)';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x + 1, r.y + 1, Math.max(0, r.w - 2), Math.max(0, r.h - 2));
      ctx.restore();
    }
  }

  // 2) 选中项：始终绘制，不会被 hover 顶掉
  if (state.selectedPath) {
    drawRing(ctx, state.rects.find((x) => x.path === state.selectedPath), { strong: true });
  }

  // 3) 悬停项：只在和选中项不同时画细线
  if (state.hover?.p && state.hover.p !== state.selectedPath) {
    drawRing(ctx, state.rects.find((x) => x.path === state.hover.p), { strong: false });
  }
}

// ================================================================ 多选
function updateMultiBar() {
  const n = state.selection.size;
  el.multiBar.classList.toggle('hidden', n === 0);
  if (!n) return;
  let total = 0;
  let files = 0;
  for (const node of state.selection.values()) {
    total += node.s || 0;
    files += node.fc || 0;
  }
  el.multiCount.textContent = `已选 ${n} 项`;
  el.multiSize.textContent = `${fmtSize(total)}${files ? ' · ' + fmtNum(files) + ' 个文件' : ''}`;
}

function toggleSelection(node) {
  const key = node.p;
  if (state.selection.has(key)) state.selection.delete(key);
  else state.selection.set(key, node);
  updateMultiBar();
  drawOverlay();
}

function clearSelection() {
  if (!state.selection.size) return;
  state.selection.clear();
  updateMultiBar();
  drawOverlay();
}

el.multiClear.addEventListener('click', clearSelection);
el.multiDelete.addEventListener('click', () => {
  if (state.selection.size) openBatchDeleteModal();
});
el.multiIgnore.addEventListener('click', async () => {
  const paths = [...state.selection.keys()];
  if (!paths.length) return;
  try {
    const r = await api('/api/ignore', { method: 'POST', body: JSON.stringify({ paths }) });
    toast(`已忽略 ${r.added} 项，矩形视图中不再显示`, 3200);
    clearSelection();
    await loadDir(state.path);
  } catch (err) {
    toast('忽略失败：' + err.message, 5000);
  }
});

// Esc 清空选择
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.selection.size && el.deleteModal.classList.contains('hidden')) {
    clearSelection();
  }
});

function renderLegend() {
  const counts = {};
  let total = 0;
  for (const c of state.children) {
    const s = c.an?.safety || 'unknown';
    counts[s] = (counts[s] || 0) + c.s;
    total += c.s;
  }
  el.legend.innerHTML = ['safe', 'caution', 'danger', 'keep', 'unknown']
    .filter((k) => counts[k] && (counts[k] > total * 0.001 || k === 'safe'))
    .map((k) => `<span class="legend-item"><i class="legend-dot" style="background:${SAFETY_COLOR[k]}"></i>${SAFETY_LABEL[k]} · ${fmtSize(counts[k])}</span>`)
    .join('');
}

function renderStatline() {
  const n = state.node;
  if (!n) { el.statline.textContent = ''; return; }
  const parts = [`本层 ${state.children.length} 项`, `合计 ${fmtSize(n.s)}`];
  if (n.fc) parts.push(`${fmtNum(n.fc)} 个文件`);
  if (n.a) parts.push(`另有 ${fmtNum(n.a.count)} 个小项已聚合`);
  if (state.hiddenInfo?.count) parts.push(`已忽略 ${state.hiddenInfo.count} 项 · ${fmtSize(state.hiddenInfo.size)}`);
  el.statline.textContent = parts.join(' · ');
}

// ================================================================ 交互
function hitTest(x, y) {
  for (let i = state.rects.length - 1; i >= 0; i--) {
    const r = state.rects[i];
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r;
  }
  return null;
}

function localPos(e) {
  const rect = el.wrap.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

/** 把命中矩形转成带完整路径的节点对象 */
function nodeFromHit(hit) {
  const n = hit.node;
  return { ...n, p: hit.path, isPreview: !n.p, __depth: hit.depth };
}

el.wrap.addEventListener('mousemove', (e) => {
  if (!state.rects.length) return;
  const { x, y } = localPos(e);
  const hit = hitTest(x, y);
  const node = hit ? nodeFromHit(hit) : null;
  if (node?.p !== state.hover?.p) {
    state.hover = node;
    drawOverlay();
    el.wrap.style.cursor = node && node.d ? 'pointer' : 'default';
  }
  if (node) {
    const pct = state.node?.s ? (node.s / state.node.s) * 100 : 0;
    const safety = node.an?.safety || node.safety || 'unknown';
    const title = node.an?.title || (node.atomic ? '整体功能单元' : '');
    el.tooltip.innerHTML = `
      <div class="tt-name">${escapeHtml(node.n)}</div>
      <div class="tt-size">${fmtSize(node.s)} <span style="color:#6b7a8f;font-weight:400">· ${pct.toFixed(1)}%</span></div>
      <div class="tt-meta">${node.d ? '文件夹' : '文件'}${node.fc ? ' · ' + fmtNum(node.fc) + ' 个文件' : ''}${node.t ? ' · ' + fmtDate(node.t) : ''}</div>
      <div class="tt-meta" style="color:${SAFETY_COLOR[safety]}">${SAFETY_LABEL[safety] || ''}${title ? ' · ' + escapeHtml(title) : ''}${isAtomic(node) ? ' · 整体' : ''}</div>
      ${hit && hit.depth > 0 ? `<div class="tt-meta" style="color:#5f6d80">双击进入 · 右键删除</div>` : ''}
    `;
    el.tooltip.classList.remove('hidden');
    const tw = el.tooltip.offsetWidth, th = el.tooltip.offsetHeight;
    let tx = x + 14, ty = y + 16;
    if (tx + tw > state.viewW - 8) tx = x - tw - 14;
    if (ty + th > state.viewH - 8) ty = y - th - 12;
    el.tooltip.style.left = Math.max(4, tx) + 'px';
    el.tooltip.style.top = Math.max(4, ty) + 'px';
  } else {
    el.tooltip.classList.add('hidden');
  }
});

el.wrap.addEventListener('mouseleave', () => {
  state.hover = null;
  el.tooltip.classList.add('hidden');
  drawOverlay();
});

el.wrap.addEventListener('click', (e) => {
  const { x, y } = localPos(e);
  const hit = hitTest(x, y);
  // 点空白处：取消多选
  if (!hit) { if (!e.ctrlKey && !e.metaKey) clearSelection(); return; }
  const node = nodeFromHit(hit);
  if (e.ctrlKey || e.metaKey) {
    toggleSelection(node);
    return;
  }
  clearSelection();
  selectNode(node, hit.depth);
});

el.wrap.addEventListener('dblclick', (e) => {
  const { x, y } = localPos(e);
  const hit = hitTest(x, y);
  if (!hit) return;
  const n = nodeFromHit(hit);
  if (n.d) loadDir(n.p);
  else toast('这是一个文件，可在详情里定位它');
});

el.wrap.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const { x, y } = localPos(e);
  const hit = hitTest(x, y);
  if (!hit) return;
  selectNode(nodeFromHit(hit), hit.depth);
  switchTab('detail');
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ================================================================ 导航
async function loadDir(p, { push = true } = {}) {
  if (!state.scanId) {
    toast('还没有扫描结果，请先点右上角「扫描」', 3000);
    return;
  }
  try {
    const r = await api(`/api/children?id=${state.scanId}&path=${encodeURIComponent(p)}`);
    // 服务端可能回退到了另一次扫描，同步一下 id
    if (r.scanId) state.scanId = r.scanId;
    state.path = p;
    state.node = r.node;
    state.children = r.children || [];
    state.hiddenInfo = r.hidden || null;
    state.selected = null;
    state.selectedPath = null;
    el.emptyState.classList.add('hidden');
    el.scanState.classList.add('hidden');
    renderCrumbs();
    render();
    clearDetail();
    document.title = `${basename(p) || p} · DiskLens`;
  } catch (e) {
    // 扫描结果失效时，尝试重新同步一次
    if (/扫描结果|不在当前扫描/.test(e.message)) {
      try {
        const st = await api('/api/status');
        if (st.latestScan?.id && st.latestScan.id !== state.scanId) {
          state.scanId = st.latestScan.id;
          state.root = st.latestScan.root;
          return loadDir(p, { push });
        }
      } catch { /* ignore */ }
    }
    toast('无法打开该目录：' + e.message, 4000);
  }
}

function enterDir(p) { loadDir(p); }

function splitPath(p) {
  const s = p.replace(/[\\/]+$/, '');
  const isRoot = /^[A-Za-z]:$/.test(s);
  const parts = s.split(/[\\/]/);
  return parts;
}

function renderCrumbs() {
  if (!state.path) { el.crumbs.innerHTML = '<span class="crumb-empty">扫描后显示目录结构</span>'; return; }
  const parts = splitPath(state.path);
  const html = [];
  let acc = '';
  parts.forEach((seg, i) => {
    acc = i === 0 ? seg : acc + '\\' + seg;
    const isLast = i === parts.length - 1;
    const label = i === 0 ? seg + '\\' : seg;
    html.push(`<span class="crumb${isLast ? ' current' : ''}" data-p="${escapeHtml(acc)}">${escapeHtml(label)}</span>`);
    if (!isLast) html.push('<span class="crumb-sep">›</span>');
  });
  el.crumbs.innerHTML = html.join('');
  el.crumbs.querySelectorAll('.crumb[data-p]').forEach((c) => {
    c.onclick = () => loadDir(c.dataset.p);
  });
}

// ================================================================ 详情
function clearDetail() {
  el.detailEmpty.classList.remove('hidden');
  el.detailBody.classList.add('hidden');
}

function selectNode(node, depth) {
  state.selected = node;
  state.selectedPath = node.p;
  drawOverlay();
  if (!node.an) {
    // 预览子项没有随层下发的规则结论，按需补一次（本地接口，很快）
    renderDetail({ ...node, an: { safety: node.safety || 'unknown', title: '识别中…', category: '', purpose: '正在匹配内置规则库…', action: '', confidence: 'none' } });
    api(`/api/rule?path=${encodeURIComponent(node.p)}&dir=${node.d ? 1 : 0}`)
      .then((r) => { node.an = r; if (state.selected === node) renderDetail(node); })
      .catch(() => { });
    return;
  }
  renderDetail(node);
}

function renderDetail(node) {
  el.detailEmpty.classList.add('hidden');
  el.detailBody.classList.remove('hidden');

  const an = node.an || { safety: 'unknown', title: '未知', purpose: '', action: '' };
  const safety = an.safety || 'unknown';
  const isPreview = !!node.isPreview;

  el.detailBadges.innerHTML = `
    <span class="badge" style="background:${SAFETY_COLOR[safety]}22;color:${SAFETY_COLOR[safety]};border:1px solid ${SAFETY_COLOR[safety]}55">${SAFETY_LABEL[safety]}</span>
    <span class="badge" style="background:#1c2331;color:#9aa8bd">${an.category || '未分类'}</span>
    ${isPreview ? '<span class="badge" style="background:#1a2436;color:#7f9cc9">子项预览</span>' : ''}
    ${an.confidence === 'rule' ? '<span class="badge" style="background:#16233a;color:#7fa8e8">规则库命中</span>' : ''}
    ${an.confidence === 'heuristic' ? '<span class="badge" style="background:#2a2318;color:#d2a94a">启发式推断</span>' : ''}
    ${an.confidence === 'none' ? '<span class="badge" style="background:#241a1a;color:#c98c88">未识别</span>' : ''}
  `;
  el.detailName.textContent = node.n;
  el.detailPath.textContent = node.p;
  el.detailPath.onclick = () => copyPath(node.p);

  const pct = state.node?.s ? (node.s / state.node.s) * 100 : 0;
  const metrics = [
    ['占用空间', fmtSize(node.s)],
    ['占上一层', pct.toFixed(1) + '%'],
  ];
  if (isPreview) {
    metrics.push(['类型', node.d === false ? '文件' : '文件夹']);
    metrics.push(['位置', '在下一层中']);
  } else {
    metrics.push(node.d ? ['内含文件', fmtNum(node.fc || 0)] : ['类型', node.x ? '.' + node.x : '文件']);
    metrics.push(['修改时间', fmtDate(node.t || node.mtime)]);
  }
  el.detailMetrics.innerHTML = metrics
    .map(([k, v]) => `<div class="metric"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');

  el.ruleCard.innerHTML = `
    <div class="rc-title"><i class="rc-dot" style="background:${SAFETY_COLOR[safety]}"></i>${escapeHtml(an.title || '（规则库未识别）')}</div>
    <div class="rc-purpose">${escapeHtml(an.purpose || '规则库没有覆盖这个路径，建议用 AI 分析或人工查看。')}</div>
    ${an.action ? `<div class="rc-action"><b>建议：</b>${escapeHtml(an.action)}</div>` : ''}
    <div class="rc-source">判断依据：${an.confidence === 'rule' ? '内置 Windows 清理规则库' : an.confidence === 'heuristic' ? '路径特征启发式推断' : '无'}${isPreview ? ' · 该子项来自上一层预览，可直接操作' : ''}</div>
  `;

  // AI 缓存
  const cached = state.aiCache.get(node.p);
  if (cached) {
    renderAI(cached);
    state.chatContext = buildChatContext(cached);
    el.aiBtnText.textContent = '重新分析';
  } else {
    el.aiResult.classList.add('hidden');
    el.aiResult.innerHTML = '';
    el.aiBtnText.textContent = '深度分析';
    state.chatContext = null;
    state.chatHistory = [];
  }
  renderFollowup();
  el.btnAI.disabled = false;

  renderActions(node, isPreview);
}

/** 把分析结果压成追问上下文 */
function buildChatContext(r) {
  return {
    path: r.path, size: r.size, verdict: r.verdict, safety: r.safety,
    estimatedFree: r.estimatedFree, purpose: r.purpose,
    actions: r.actions || [], risks: r.risks || [],
    findings: r.findings || [], evidence: r.evidence || null,
  };
}

/** 按钮按节点类型动态生成：文件 / 目录 / 预览项 都要给全操作 */
function renderActions(node, isPreview) {
  const isFile = node.d === false;
  const acts = [];

  if (isFile) {
    acts.push(['open', '打开所在文件夹']);
    acts.push(['reveal', '在资源管理器定位']);
    acts.push(['copy', '复制路径']);
    acts.push(['ignore', '🚫 忽略', 'ghost']);
    acts.push(['delete', '⚠ 删除', 'danger']);
  } else {
    acts.push(['open', '打开文件夹']);
    acts.push(['reveal', '在父目录定位']);
    acts.push(['copy', '复制路径']);
    acts.push(['enter', isPreview ? '进入并查看' : '进入此目录']);
    acts.push(['rescan', '⟳ 重扫此目录']);
    acts.push(['ignore', '🚫 忽略', 'ghost']);
    acts.push(['delete', '⚠ 删除', 'danger']);
  }

  el.detailActions.innerHTML = acts.map(([act, label, cls]) =>
    `<button class="btn sm ${cls || ''}" data-act="${act}">${label}</button>`).join('');
}

function renderAI(r) {
  el.aiResult.classList.remove('hidden');
  const safety = r.safety || 'unknown';
  const conf = { high: '高', medium: '中', low: '低' }[r.confidence] || '—';
  const isAI = r.source === 'ai';
  const srcLabel = isAI ? `AI 深度分析 · ${r.model || ''}` : '本地证据分析（现测数据）';

  const findingsHtml = (r.findings && r.findings.length)
    ? `<div class="ai-findings">${r.findings.map((f) => `
        <div class="finding">
          <span class="f-label">${escapeHtml(f.label)}</span>
          <span class="f-value">${escapeHtml(f.value)}</span>
          ${f.note ? `<span class="f-note">${escapeHtml(f.note)}</span>` : ''}
        </div>`).join('')}</div>`
    : '';

  el.aiResult.innerHTML = `
    <div class="ai-verdict">
      <span class="big" style="color:${SAFETY_COLOR[safety]}">${escapeHtml(r.verdict || '')}</span>
      <span class="badge" style="background:${SAFETY_COLOR[safety]}22;color:${SAFETY_COLOR[safety]}">${escapeHtml(r.estimatedFree || '')}</span>
    </div>
    ${findingsHtml}
    <div class="ai-block">
      <h4>这是什么</h4>
      <p>${escapeHtml(r.purpose || '')}</p>
    </div>
    ${r.actions?.length ? `<div class="ai-block"><h4>怎么处理</h4><ol>${r.actions.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}</ol></div>` : ''}
    ${r.risks?.length ? `<div class="ai-block"><h4>删除的影响</h4><ul>${r.risks.map((a) => `<li class="warn-li">${escapeHtml(a)}</li>`).join('')}</ul></div>` : ''}
    <div class="ai-block" style="padding:8px 12px">
      <p style="font-size:11px;color:#6b7a8f">来源：${escapeHtml(srcLabel)} · 置信度 ${conf}${r.aiError ? ' · ' + escapeHtml(r.aiError) : ''}</p>
    </div>
  `;
}

el.btnAI.addEventListener('click', async () => {
  const node = state.selected;
  if (!node) return;
  el.btnAI.disabled = true;
  el.aiBtnText.textContent = '分析中…';
  try {
    const r = await api('/api/analyze', {
      method: 'POST',
      body: JSON.stringify({
        path: node.p, scanId: state.scanId, size: node.s,
        disk: state.drive,
      }),
    });
    state.aiCache.set(node.p, r);
    renderAI(r);
    state.chatContext = buildChatContext(r);
    state.chatHistory = [];
    renderFollowup();
    el.aiBtnText.textContent = '重新分析';
    if (r.source !== 'ai') toast('已用本地实测数据生成分析（配置 API Key 可获得 AI 推理）', 3200);
  } catch (e) {
    toast('分析失败：' + e.message, 3200);
    el.aiBtnText.textContent = '深度分析';
  } finally {
    el.btnAI.disabled = false;
  }
});

// 事件委托：按钮是动态生成的，绑在容器上
el.detailActions.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const node = state.selected;
  if (!node) return;
  const act = b.dataset.act;

  if (act === 'copy') return copyPath(node.p);
  if (act === 'delete') return openDeleteModal(node);

  if (act === 'ignore') {
    try {
      const r = await api('/api/ignore', {
        method: 'POST',
        body: JSON.stringify({ paths: [node.p], note: node.an?.title || '' }),
      });
      if (r.added) {
        toast(`已忽略「${node.n}」，矩形视图中不再显示`);
        clearSelection();
        await loadDir(state.path);
      } else {
        toast('已经在忽略列表里了');
      }
    } catch (err) {
      toast('忽略失败：' + err.message, 5000);
    }
    return;
  }

  if (act === 'enter') {
    // 预览子项：先回到父目录再选中它本身
    if (node.isPreview) {
      const parentPath = state.path;
      const targetPath = node.p;
      await loadDir(parentPath);
      const target = state.children.find((c) => c.p.toLowerCase() === targetPath.toLowerCase());
      if (target) { selectNode(target, 0); switchTab('detail'); }
      else toast('该子项在上一层中已被聚合');
      return;
    }
    if (node.d) return enterDir(node.p);
    return toast('这是文件，无法进入');
  }

  if (act === 'rescan') {
    if (!node.d) return toast('只能重扫目录');
    b.disabled = true;
    const oldLabel = b.textContent;
    b.textContent = '⟳ 扫描中…';
    try {
      const r = await api('/api/rescan', {
        method: 'POST',
        body: JSON.stringify({ path: node.p, scanId: state.scanId }),
      });
      const delta = r.deltaSize || 0;
      const sign = delta > 0 ? '+' : '';
      toast(`重扫完成：${sign}${fmtSize(Math.abs(delta))}${delta < 0 ? '（变少了）' : delta > 0 ? '（变多了）' : '（无变化）'}`, 4000);
      await loadDir(state.path);
      loadCandidates();
      // 重新定位到该节点
      const fresh = state.children.find((c) => c.p.toLowerCase() === node.p.toLowerCase());
      if (fresh) { selectNode(fresh, 0); switchTab('detail'); }
    } catch (err) {
      toast('重扫失败：' + err.message, 5000);
    } finally {
      b.disabled = false;
      b.textContent = oldLabel;
    }
    return;
  }

  if (act === 'open') {
    try {
      await api('/api/reveal', { method: 'POST', body: JSON.stringify({ path: node.p, mode: 'open' }) });
      toast(node.d ? '已打开文件夹' : '已打开所在文件夹并选中该文件');
    } catch (err) {
      toast('打开失败：' + err.message, 5000);
    }
    return;
  }

  if (act === 'reveal') {
    try {
      await api('/api/reveal', { method: 'POST', body: JSON.stringify({ path: node.p }) });
      toast('已在资源管理器中定位');
    } catch (err) {
      toast('定位失败：' + err.message, 5000);
    }
  }
});

async function copyPath(p) {
  try { await navigator.clipboard.writeText(p); toast('已复制：' + p, 2200); }
  catch { toast('复制失败，请手动选择路径'); }
}

// ================================================================ 扫描
async function startScan(root, force = false) {
  if (state.scanning) return;
  state.scanning = true;
  el.btnScan.classList.add('hidden');
  el.btnCancel.classList.remove('hidden');
  el.emptyState.classList.add('hidden');
  el.scanState.classList.remove('hidden');
  el.scanTitle.textContent = `正在扫描 ${root}…`;
  el.scanPath.textContent = '';
  el.scanStats.textContent = '正在读取目录…';
  el.scanBarFill.style.width = '3%';
  state._scanStart = Date.now();

  try {
    const r = await api('/api/scan', { method: 'POST', body: JSON.stringify({ root, force }) });
    state.scanId = r.id;
    state.root = r.root;

    if (r.reused) {
      onScanDone(r.id);
      return;
    }
    followProgress(r.id);
  } catch (e) {
    toast('扫描启动失败：' + e.message, 4000);
    resetScanUI();
  }
}

function followProgress(id) {
  if (state.es) state.es.close();
  const es = new EventSource(`/api/scan/stream?id=${id}`);
  state.es = es;
  es.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'progress') {
      const usedTotal = state.drive?.used || 0;
      const pct = usedTotal ? Math.min(94, Math.max(3, (m.bytes / usedTotal) * 100)) : 50;
      el.scanBarFill.style.width = pct.toFixed(1) + '%';
      el.scanTitle.textContent = `正在扫描… ${fmtSize(m.bytes)} / ${fmtSize(usedTotal)}`;
      el.scanPath.textContent = m.current || '';
      el.scanStats.textContent = `${fmtNum(m.files)} 个文件 · ${fmtNum(m.dirs)} 个目录 · ${((Date.now() - state._scanStart) / 1000).toFixed(0)}s${m.errors ? ' · ' + fmtNum(m.errors) + ' 处跳过' : ''}`;
    } else if (m.type === 'done') {
      es.close();
      el.scanBarFill.style.width = '100%';
      onScanDone(id, m);
    } else if (m.type === 'error') {
      es.close();
      toast('扫描失败：' + m.error, 5000);
      resetScanUI();
    }
  };
  es.onerror = () => { es.close(); };
}

async function onScanDone(id, info) {
  state.scanId = id;
  try {
    const st = await api('/api/status');
    state.drive = st.drives?.find((d) => d.root[0].toLowerCase() === (state.root || 'C')[0].toLowerCase()) || st.drives?.[0];
    updateDriveChip();
  } catch { /* ignore */ }

  await loadDir(state.root || 'C:\\');
  resetScanUI();
  loadCandidates();
  const s = info?.stats;
  if (s) toast(`扫描完成：${fmtNum(s.files)} 个文件，用时 ${(s.elapsedMs / 1000).toFixed(1)}s`, 3200);
}

function resetScanUI() {
  state.scanning = false;
  el.btnScan.classList.remove('hidden');
  el.btnCancel.classList.add('hidden');
  el.scanState.classList.add('hidden');
  updateScanButton();
}

/** 按钮文案跟着状态走：没有结果时是「扫描」，已有结果时是「重新扫描」 */
function updateScanButton() {
  const has = !!state.scanId && !!state.node;
  el.btnScan.innerHTML = has
    ? '<span class="ico">⟳</span> 重新扫描'
    : '<span class="ico">◎</span> 扫描';
  el.btnScan.title = has
    ? '重新扫描当前盘（会重新读取所有文件，大目录约 1~3 分钟）'
    : '扫描所选位置';
}

el.btnScan.addEventListener('click', () => {
  const root = el.rootSelect.value || 'C:\\';
  // 已有结果 → 强制重扫；没有结果 → 普通扫描（服务端本来就没有可复用的）
  startScan(root, !!state.scanId);
});
el.btnScanBig.addEventListener('click', () => startScan('C:\\', !!state.scanId));
el.btnCancel.addEventListener('click', async () => {
  if (!state.scanId) return;
  try { await api('/api/scan/cancel', { method: 'POST', body: JSON.stringify({ id: state.scanId }) }); } catch { /* ignore */ }
  toast('正在停止…');
});

// ================================================================ 清理建议
async function loadCandidates() {
  if (!state.scanId) return;
  try {
    const r = await api(`/api/candidates?id=${state.scanId}`);
    state.candidates = r;
    renderCandidates();
    el.cleanFilters.classList.remove('hidden');
  } catch { /* ignore */ }
}

function renderCandidates() {
  const c = state.candidates;
  if (!c) return;
  const t = c.totals;
  const safeSize = t.safe || 0;
  const cautionSize = t.caution || 0;
  const dangerSize = t.danger || 0;
  const maxBar = Math.max(safeSize, cautionSize, dangerSize, 1);

  el.cleanSummary.innerHTML = `
    <div class="clean-total">
      <div class="ct-label">可安全回收（删了自动重建）</div>
      <div class="ct-num">${fmtSize(safeSize)}</div>
      <div class="ct-sub">另有约 ${fmtSize(cautionSize)} 属于「可删但需重新下载/重建」</div>
      <div class="clean-bars">
        <div class="clean-bar-row"><span class="lbl">可直接清理</span><span class="bar"><i style="width:${(safeSize / maxBar * 100).toFixed(1)}%;background:#3fb950"></i></span><span class="num">${fmtSize(safeSize)}</span></div>
        <div class="clean-bar-row"><span class="lbl">有代价</span><span class="bar"><i style="width:${(cautionSize / maxBar * 100).toFixed(1)}%;background:#d29922"></i></span><span class="num">${fmtSize(cautionSize)}</span></div>
        <div class="clean-bar-row"><span class="lbl">需确认</span><span class="bar"><i style="width:${(dangerSize / maxBar * 100).toFixed(1)}%;background:#f85149"></i></span><span class="num">${fmtSize(dangerSize)}</span></div>
      </div>
    </div>
  `;

  const badge = $('#cleanBadge');
  badge.classList.add('on');
  badge.textContent = String(c.list.length);

  const list = filterCandidates();
  el.cleanList.innerHTML = list.slice(0, 120).map((it) => `
    <div class="clean-item" data-path="${escapeHtml(it.path)}" style="border-left-color:${SAFETY_COLOR[it.safety]}">
      <div class="ci-top">
        <span class="ci-title">${escapeHtml(it.title)}</span>
        <span class="ci-size">${fmtSize(it.size)}</span>
      </div>
      <div class="ci-path">${escapeHtml(it.path)}</div>
      <div class="ci-purpose">${escapeHtml(it.purpose)}</div>
    </div>
  `).join('') || '<p class="muted small">没有符合条件的项目</p>';

  el.cleanList.querySelectorAll('.clean-item').forEach((node) => {
    node.onclick = () => {
      const target = c.list.find((x) => x.path === node.dataset.path);
      if (!target) return;
      goToPath(target.path);
    };
  });
}

function filterCandidates() {
  const c = state.candidates;
  if (!c) return [];
  if (state.cleanFilter === 'all') return c.list;
  if (state.cleanFilter === 'danger') return c.list.filter((x) => x.safety === 'danger');
  return c.list.filter((x) => x.safety === state.cleanFilter);
}

document.querySelectorAll('[data-filter]').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('[data-filter]').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    state.cleanFilter = b.dataset.filter;
    renderCandidates();
  });
});

async function goToPath(p) {
  if (!state.root) return;
  const rootNorm = state.root.replace(/[\\/]+$/, '').toLowerCase();
  const pNorm = p.replace(/[\\/]+$/, '').toLowerCase();
  if (!pNorm.startsWith(rootNorm)) { toast('该路径不在当前扫描范围内'); return; }
  const rel = pNorm.slice(rootNorm.length).replace(/^[\\/]+/, '');
  const segs = rel ? rel.split(/[\\/]/) : [];
  const parentSegs = segs.slice(0, -1);
  const parentPath = state.root.replace(/[\\/]+$/, '') + (parentSegs.length ? '\\' + parentSegs.join('\\') : '');
  await loadDir(parentPath);
  const target = state.children.find((ch) => ch.p.toLowerCase() === pNorm);
  if (target) {
    selectNode(target, 0);
    switchTab('detail');
  } else {
    toast('该项目在上一层中已被聚合，可尝试双击进入');
  }
}

el.btnExportPlan.addEventListener('click', exportPlan);

function exportPlan() {
  const c = state.candidates;
  if (!c) return;
  const t = c.totals;
  const lines = [];
  lines.push('# DiskLens 清理清单');
  lines.push('');
  lines.push(`- 扫描位置：${c.root}`);
  lines.push(`- 生成时间：${new Date().toLocaleString('zh-CN')}`);
  lines.push(`- 可直接清理：**${fmtSize(t.safe || 0)}**`);
  lines.push(`- 有代价清理：**${fmtSize(t.caution || 0)}**`);
  lines.push(`- 含数据需确认：**${fmtSize(t.danger || 0)}**`);
  lines.push('');
  lines.push('> 本清单只做建议，DiskLens 不会删除任何文件。删除前请确认路径。');
  lines.push('');
  const groups = [
    ['safe', '可直接清理（缓存/临时/日志）'],
    ['caution', '可清理但有代价（需重新下载或重建）'],
    ['danger', '含用户数据，必须人工确认'],
  ];
  for (const [key, title] of groups) {
    const items = c.list.filter((x) => x.safety === key);
    if (!items.length) continue;
    lines.push(`## ${title}（${fmtSize(items.reduce((a, b) => a + b.size, 0))}）`);
    lines.push('');
    lines.push('| 大小 | 路径 | 说明 |');
    lines.push('| --- | --- | --- |');
    for (const it of items.slice(0, 60)) {
      lines.push(`| ${fmtSize(it.size)} | \`${it.path}\` | ${it.title} |`);
    }
    lines.push('');
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `disklens-清理清单-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  toast('清单已导出');
}

// ================================================================ 删除（破坏性操作）
function basenameOf(p) {
  return String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
}

function syncDelModeStyles() {
  document.querySelectorAll('.del-mode').forEach((m) => {
    m.classList.toggle('active', m.querySelector('input').checked);
  });
}

function closeDeleteModal() {
  el.deleteModal.classList.add('hidden');
  el.delProgress.classList.add('hidden');
  el.delConfirmBtn.disabled = false;
  state.delTarget = null;
  state.batchTargets = null;
}

function openDeleteModal(node) {
  // 多选状态 → 走批量
  if (state.selection.size > 1) return openBatchDeleteModal();

  state.delTarget = node;
  state.batchTargets = null;
  const safety = node.an?.safety || node.safety || 'unknown';

  el.delTitle.textContent = isAtomic(node) ? '删除整体功能单元' : '确认删除';
  el.delName.textContent = node.n;
  el.delPath.textContent = node.p;
  el.delMetrics.innerHTML =
    `<span>占用 <b>${fmtSize(node.s)}</b></span>` +
    (node.fc ? `<span>文件 <b>${fmtNum(node.fc)}</b> 个</span>` : '') +
    (node.t ? `<span>最后修改 <b>${fmtDate(node.t).replace(/（.*）/, '')}</b></span>` : '');

  const warns = {
    safe: ['tone-safe', '✓ 缓存 / 临时 / 日志类数据。删除后系统或应用会自动重建，通常没有副作用。'],
    caution: ['tone-warn', '⚠ 删除后需要重新下载、重新编译或重新登录才能恢复。请确认相关项目近期用不到。'],
    danger: ['tone-danger', '⚠⚠ 这个目录可能包含你的个人数据（聊天记录、模型、项目源码、下载文件等）。删除后无法通过本工具恢复。'],
    keep: ['tone-keep', '⛔ 这是系统关键组件或项目源码。删除可能导致系统或项目损坏，强烈建议不要在这里删。'],
    unknown: ['tone-warn', '? 规则库无法确认这个目录的用途。建议先「打开文件夹」看看里面是什么，再决定。'],
  };
  const w = warns[safety] || warns.unknown;
  el.delWarn.className = 'del-warn ' + w[0];
  el.delWarn.textContent = w[1];

  el.delNote.textContent = `路径已在上方核对无误后，点「确认删除」即可。`;
  el.delConfirmBtn.disabled = false;
  el.delProgress.classList.add('hidden');

  const permRadio = document.querySelector('input[name=delmode][value=permanent]');
  const recRadio = document.querySelector('input[name=delmode][value=recycle]');
  const lockPerm = safety === 'danger' || safety === 'keep';
  permRadio.disabled = lockPerm;
  recRadio.checked = true;
  syncDelModeStyles();

  el.deleteModal.classList.remove('hidden');
}

/** 批量删除弹窗 */
function openBatchDeleteModal() {
  const items = [...state.selection.values()];
  if (!items.length) return;
  state.batchTargets = items;
  state.delTarget = null;

  const total = items.reduce((a, b) => a + (b.s || 0), 0);
  const files = items.reduce((a, b) => a + (b.fc || 0), 0);
  const hasRisky = items.some((n) => {
    const s = n.an?.safety || n.safety;
    return s === 'danger' || s === 'keep';
  });

  el.delTitle.textContent = `批量删除 ${items.length} 项`;
  el.delName.textContent = `共 ${fmtSize(total)}${files ? ' · ' + fmtNum(files) + ' 个文件' : ''}`;
  el.delPath.textContent = items.slice(0, 6).map((n) => n.p).join('\n') + (items.length > 6 ? `\n…等 ${items.length} 项` : '');
  el.delMetrics.innerHTML = `<span>选中 <b>${items.length}</b> 项</span><span>合计 <b>${fmtSize(total)}</b></span>`;

  el.delWarn.className = 'del-warn ' + (hasRisky ? 'tone-danger' : 'tone-warn');
  el.delWarn.textContent = hasRisky
    ? '⚠ 选中项里含有用户数据或系统关键目录。这些项只能移到回收站，不会被永久删除。'
    : '⚠ 批量删除会一次性处理所有选中项，请确认列表无误。';

  el.delNote.textContent = '批量操作逐项执行，失败的项目会单独列出。';
  el.delConfirmBtn.disabled = false;
  el.delProgress.classList.add('hidden');

  const permRadio = document.querySelector('input[name=delmode][value=permanent]');
  const recRadio = document.querySelector('input[name=delmode][value=recycle]');
  permRadio.disabled = hasRisky;
  recRadio.checked = true;
  syncDelModeStyles();

  el.deleteModal.classList.remove('hidden');
}

document.querySelectorAll('.del-mode').forEach((m) => {
  m.addEventListener('click', () => {
    const input = m.querySelector('input');
    if (input.disabled) return;
    input.checked = true;
    syncDelModeStyles();
  });
});

document.querySelectorAll('[data-close]').forEach((x) => { x.onclick = closeDeleteModal; });

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.deleteModal.classList.contains('hidden')) closeDeleteModal();
});

el.delConfirmBtn.addEventListener('click', async () => {
  const mode = document.querySelector('input[name=delmode]:checked')?.value || 'recycle';
  el.delConfirmBtn.disabled = true;
  el.delProgress.classList.remove('hidden');

  // ---------- 批量模式 ----------
  if (state.batchTargets?.length) {
    const items = state.batchTargets;
    el.delProgressText.textContent = `正在处理 ${items.length} 项…`;
    try {
      const r = await api('/api/delete/batch', {
        method: 'POST',
        body: JSON.stringify({ paths: items.map((n) => n.p), mode }),
      });
      closeDeleteModal();
      clearSelection();
      const failed = r.results.filter((x) => x.status !== 'done');
      if (failed.length) {
        toast(`完成 ${r.done} 项，${failed.length} 项未处理：${failed[0].error || failed[0].status}`, 6000);
      } else {
        toast(`${mode === 'recycle' ? '已移到回收站' : '已永久删除'} ${r.done} 项`, 3200);
      }
      await loadDir(state.path);
      loadCandidates();
    } catch (e) {
      el.delProgress.classList.add('hidden');
      el.delConfirmBtn.disabled = false;
      toast('批量删除失败：' + e.message, 6000);
    }
    return;
  }

  // ---------- 单项模式 ----------
  const node = state.delTarget;
  if (!node) return;
  el.delProgressText.textContent = mode === 'recycle' ? '正在移到回收站…' : '正在永久删除…（大目录可能要几分钟）';

  try {
    const r = await api('/api/delete', {
      method: 'POST',
      body: JSON.stringify({ path: node.p, mode, size: node.s }),
    });
    let st = { status: 'running' };
    for (let i = 0; i < 1200; i++) {
      await new Promise((res) => setTimeout(res, 500));
      st = await api(`/api/delete/status?id=${encodeURIComponent(r.id)}`);
      if (st.status !== 'running') break;
    }
    if (st.status === 'done') {
      closeDeleteModal();
      toast(`${mode === 'recycle' ? '已移到回收站' : '已永久删除'}：${fmtSize(node.s)}`, 3200);
      await loadDir(state.path);
      loadCandidates();
    } else {
      throw new Error(st.error || '删除超时或失败');
    }
  } catch (e) {
    el.delProgress.classList.add('hidden');
    el.delConfirmBtn.disabled = false;
    toast('删除失败：' + e.message, 6000);
  }
});

// ================================================================ 分析后追问
function renderFollowup() {
  const show = !!state.chatContext;
  el.followup.classList.toggle('hidden', !show);
  if (!show) { el.fuHistory.innerHTML = ''; return; }
  el.fuHistory.innerHTML = state.chatHistory.map((m) => {
    if (m.role === 'user') {
      return `<div class="fu-msg fu-user">${escapeHtml(m.content)}</div>`;
    }
    return `<div class="fu-msg fu-bot">${escapeHtml(m.content).replace(/\n/g, '<br>')}</div>`;
  }).join('');
  el.fuHistory.scrollTop = el.fuHistory.scrollHeight;
}

async function sendFollowup() {
  const q = el.fuInput.value.trim();
  if (!q) return;
  if (!state.chatContext) { toast('请先做一次深度分析'); return; }
  el.fuInput.value = '';
  state.chatHistory.push({ role: 'user', content: q });
  renderFollowup();
  el.fuSend.disabled = true;
  el.fuInput.disabled = true;

  try {
    const r = await api('/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        context: state.chatContext,
        messages: state.chatHistory.map((m) => ({ role: m.role, content: m.content })),
      }),
    });
    state.chatHistory.push({ role: 'assistant', content: r.answer || '(没有回答)' });
    renderFollowup();
    if (r.source !== 'ai' && r.aiError) toast('AI 调用失败，已用本地回答', 3000);
  } catch (e) {
    state.chatHistory.push({ role: 'assistant', content: '追问失败：' + e.message });
    renderFollowup();
  } finally {
    el.fuSend.disabled = false;
    el.fuInput.disabled = false;
    el.fuInput.focus();
  }
}

el.fuSend.addEventListener('click', sendFollowup);
el.fuInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendFollowup(); }
});

// ================================================================ 标签页
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  for (const k of ['detail', 'clean', 'settings']) {
    $(`#tab-${k}`).classList.toggle('hidden', k !== name);
  }
  if (name === 'clean' && !state.candidates && state.scanId) loadCandidates();
  if (name === 'settings') loadIgnoreList();
}
document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => switchTab(t.dataset.tab); });

// ================================================================ 设置
async function loadSettings() {
  try {
    const s = await api('/api/settings');
    el.setBaseURL.value = s.ai.baseURL || '';
    el.setModel.value = s.ai.model || '';
    el.setApiKeyEnv.value = s.ai.apiKeyEnv || '';
    el.setApiKey.placeholder = s.ai.hasKey ? '已配置（留空则不修改）' : '留空则读取环境变量';
    el.setDepth.value = s.scan.maxDepth || 16;
    el.depthVal.textContent = s.scan.maxDepth || 16;
    const aggKB = Math.round((s.scan.aggThreshold || 49152) / 1024);
    el.setAgg.value = String(Math.min(10, Math.max(1, Math.round(aggKB / 10))));
    el.aggVal.textContent = aggKB + ' KB';
  } catch { /* ignore */ }
}

// ================================================================ 忽略列表管理
async function loadIgnoreList() {
  try {
    const r = await api('/api/ignore');
    const items = r.items || [];
    if (!items.length) {
      el.ignoreList.innerHTML = '<p class="muted small">还没有忽略任何项</p>';
      return;
    }
    el.ignoreList.innerHTML = items.map((it) => `
      <div class="ignore-item">
        <div class="ig-main">
          <code>${escapeHtml(it.pattern)}</code>
          ${it.note ? `<span class="ig-note">${escapeHtml(it.note)}</span>` : ''}
        </div>
        <button class="btn sm ghost ig-remove" data-pattern="${escapeHtml(it.pattern)}">移除</button>
      </div>`).join('');

    el.ignoreList.querySelectorAll('.ig-remove').forEach((b) => {
      b.onclick = async () => {
        try {
          await api('/api/ignore/remove', { method: 'POST', body: JSON.stringify({ patterns: [b.dataset.pattern] }) });
          toast('已移出忽略列表');
          loadIgnoreList();
          if (state.scanId) loadDir(state.path);
        } catch (e) { toast('移除失败：' + e.message); }
      };
    });
  } catch { /* ignore */ }
}

el.ignoreAddBtn.addEventListener('click', async () => {
  const v = el.ignoreInput.value.trim();
  if (!v) return;
  try {
    const r = await api('/api/ignore', { method: 'POST', body: JSON.stringify({ paths: [v], note: '手动添加' }) });
    if (r.added) {
      toast('已添加');
      el.ignoreInput.value = '';
      loadIgnoreList();
      if (state.scanId) loadDir(state.path);
    } else toast('已经在列表里了');
  } catch (e) { toast('添加失败：' + e.message); }
});
el.ignoreInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el.ignoreAddBtn.click();
});

el.setDepth.addEventListener('input', () => { el.depthVal.textContent = el.setDepth.value; });
const AGG_MAP = { 1: 8192, 2: 16384, 3: 24576, 4: 32768, 5: 49152, 6: 65536, 7: 131072, 8: 262144, 9: 524288, 10: 1048576 };
el.setAgg.addEventListener('input', () => {
  const v = AGG_MAP[el.setAgg.value] || 49152;
  el.aggVal.textContent = fmtSize(v);
});

el.btnSaveSettings.addEventListener('click', async () => {
  const body = {
    ai: {
      baseURL: el.setBaseURL.value.trim(),
      model: el.setModel.value.trim(),
      apiKeyEnv: el.setApiKeyEnv.value.trim(),
    },
    scan: {
      maxDepth: Number(el.setDepth.value),
      aggThreshold: AGG_MAP[el.setAgg.value] || 49152,
    },
  };
  if (el.setApiKey.value.trim()) body.ai.apiKey = el.setApiKey.value.trim();
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify(body) });
    toast('已保存（下次扫描生效）');
    el.setApiKey.value = '';
    loadSettings();
  } catch (e) { toast('保存失败：' + e.message); }
});

el.btnTestAI.addEventListener('click', async () => {
  el.testResult.classList.remove('hidden', 'ok', 'err');
  el.testResult.textContent = '正在测试…';
  try {
    const r = await api('/api/settings/test', { method: 'POST' });
    if (r.ok) {
      el.testResult.classList.add('ok');
      el.testResult.textContent = `连接成功${r.usingEnv ? '（使用环境变量中的 Key）' : ''}。可用模型 ${r.models?.length || 0} 个${r.models?.length ? '：' + r.models.slice(0, 8).join(', ') : ''}`;
    } else {
      el.testResult.classList.add('err');
      el.testResult.textContent = '连接失败：' + r.error;
    }
  } catch (e) {
    el.testResult.classList.add('err');
    el.testResult.textContent = '连接失败：' + e.message;
  }
});

el.btnPresetDSH.addEventListener('click', () => {
  el.setBaseURL.value = 'https://api.openai.com/v1';
  el.setModel.value = 'gpt-4o-mini';
  el.setApiKeyEnv.value = 'OPENAI_API_KEY';
  toast('已填入 OpenAI 官方地址，点「保存」生效');
});

// ================================================================ 顶栏
function updateDriveChip() {
  const d = state.drive;
  if (!d) return;
  const usedPct = (d.used / d.total) * 100;
  el.meterFill.style.width = usedPct.toFixed(1) + '%';
  el.driveNum.textContent = `${fmtSize(d.free)} 可用 / ${fmtSize(d.total)}`;
  el.driveChip.title = `${d.root} 已用 ${fmtSize(d.used)}，可用 ${fmtSize(d.free)}`;
}

async function loadStatus() {
  try {
    const st = await api('/api/status');
    state.status = st;
    state.drive = st.drives?.[0] || null;
    updateDriveChip();
    el.ruleCount.textContent = st.rules;

    // 盘符下拉
    el.rootSelect.innerHTML = st.drives.map((d) => `<option value="${d.root}">${d.root.replace('\\', '')} 全盘 (${fmtSize(d.free)} 可用)</option>`).join('');
    const extra = ['C:\\Users', 'C:\\soft', 'C:\\Windows', 'C:\\Program Files', 'C:\\ProgramData'];
    for (const p of extra) {
      const o = document.createElement('option');
      o.value = p; o.textContent = p;
      el.rootSelect.appendChild(o);
    }
    el.rootSelect.value = st.lastRoot && st.drives.some((d) => d.root === st.lastRoot) ? st.lastRoot : (st.drives[0]?.root || 'C:\\');

    // 已有扫描结果？
    if (st.latestScan) {
      state.scanId = st.latestScan.id;
      state.root = st.latestScan.root;
      state.scanning = false;
      el.emptyState.classList.add('hidden');
      await loadDir(st.latestScan.root);
      loadCandidates();
      toast(`已载入上次扫描结果（${fmtSize(st.latestScan.size)}）`, 2600);
    }
    updateScanButton();
  } catch (e) {
    toast('无法连接本地服务：' + e.message, 5000);
  }
}

// ================================================================ 初始化
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    setupCanvas();
    if (state.children.length) render();
  }, 120);
});

(async function init() {
  setupCanvas();
  await loadStatus();
  await loadSettings();
  switchTab('detail');
})();
