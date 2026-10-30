/**
 * 证据驱动分析器
 *
 * 不依赖任何大模型：把「规则库的先验知识」和「这个目录的真实情况」结合起来，
 * 生成具体到文件名 / 类型 / 天数的结论。
 *
 * 真实情况来自 scanShallow：体积构成、文件类型、修改时间分布。
 * 这比套模板有参考价值得多 —— 因为结论里的每个数字都是现测的。
 */
import { analyzePath, SAFETY_META } from './rules.mjs';

function human(bytes) {
  if (!bytes || bytes < 1) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);

/** 常见扩展名 → 人话 */
const EXT_KIND = {
  bin: '二进制数据', dat: '数据文件', dll: '动态库', exe: '可执行文件', pdb: '调试符号',
  jar: 'Java 包', class: 'Java 类', so: '共享库', dylib: '动态库',
  whl: 'Python 轮子包', tar: '压缩包', gz: '压缩包', zip: '压缩包', '7z': '压缩包', rar: '压缩包',
  mp4: '视频文件', mkv: '视频文件', avi: '视频文件', mov: '视频文件', flv: '视频文件',
  jpg: '图片', jpeg: '图片', png: '图片', webp: '图片', psd: 'PSD 源文件',
  py: 'Python 源码', js: 'JS 源码', ts: 'TS 源码', cpp: 'C++ 源码', h: '头文件',
  log: '日志', tmp: '临时文件', bak: '备份', db: '数据库', sqlite: '数据库',
  safetensors: 'AI 模型权重', ckpt: 'AI 模型权重', pt: 'PyTorch 权重', pth: 'PyTorch 权重',
  gguf: '量化模型', vhdx: '虚拟磁盘', vmdk: '虚拟磁盘', iso: '光盘镜像',
  docx: 'Word 文档', xlsx: 'Excel 表格', pdf: 'PDF 文档',
};

/**
 * @param {{path:string,name:string,isDir:boolean,size:number}} item
 * @param {object} rule  analyzePath() 的结果
 * @param {object} ev    scanShallow() 的结果（可能为 null）
 */
export function analyzeWithEvidence(item, rule, ev) {
  const findings = [];
  const actions = [];
  const risks = [];
  const size = item.size || ev?.totalSize || 0;
  const safety = rule?.safety || 'unknown';

  /* ---------------- 1. 体积构成（优先用扫描树的准确数据） ---------------- */
  let dominant = null;
  let dominantShare = 0;

  const treeKids = (item.topChildren || [])
    .filter((c) => c.size > 0)
    .sort((a, b) => b.size - a.size);

  const dirs = ev ? (ev.topDirs || []).filter((d) => d.size > 0) : [];
  const files = ev ? (ev.topFiles || []).filter((f) => f.size > 0) : [];

  if (treeKids.length) {
    // 树数据是精确的，直接拿来算构成比
    const top = treeKids[0];
    if (size > 0 && top.size / size > 0.42) {
      dominant = { type: top.isDir ? 'dir' : 'file', name: top.name, size: top.size };
      dominantShare = top.size / size;
    }
    if (dominant) {
      findings.push({
        label: '体积集中',
        value: `${pct(dominant.size, size)}% 在「${dominant.name}」`,
        note: human(dominant.size),
      });
    } else if (treeKids.length >= 2) {
      const sum3 = treeKids.slice(0, 3).reduce((a, b) => a + b.size, 0);
      findings.push({
        label: '前三项',
        value: `${pct(sum3, size)}%`,
        note: treeKids.slice(0, 3).map((d) => d.name).join(' · '),
      });
    }
  } else if (dirs.length && dirs[0].size / size > 0.45) {
    dominant = { type: 'dir', name: dirs[0].name, size: dirs[0].size };
    dominantShare = dirs[0].size / size;
    findings.push({ label: '体积集中', value: `${pct(dominant.size, size)}% 在「${dominant.name}」`, note: human(dominant.size) });
  } else if (files.length && files[0].size / size > 0.3) {
    dominant = { type: 'file', name: files[0].name, size: files[0].size };
    dominantShare = files[0].size / size;
    findings.push({ label: '体积集中', value: `${pct(dominant.size, size)}% 在「${dominant.name}」`, note: human(dominant.size) });
  }

  /* ---------------- 2. 类型构成 ---------------- */
  let mainKinds = '';
  if (ev?.exts?.length) {
    const top = ev.exts.slice(0, 3);
    const share = pct(top.reduce((a, b) => a + b.size, 0), size);
    mainKinds = top.map((e) => `.${e.ext}`).join(' ');
    const kinds = top.map((e) => EXT_KIND[e.ext]).filter(Boolean);
    findings.push({
      label: '主要类型',
      value: mainKinds,
      note: share >= 1
        ? `${kinds.join('、') || '按体积排序'} · 占 ${share}%`
        : (kinds.join('、') || '按文件数排序'),
    });
  }

  /* ---------------- 3. 时间 ---------------- */
  let stalePct = 0;
  let newestDays = null;
  if (ev?.age && ev.age.newestDays != null) {
    stalePct = Math.round((ev.age.staleRatio || 0) * 100);
    newestDays = ev.age.newestDays;
    findings.push({
      label: '最后写入',
      value: newestDays <= 0 ? '今天' : `${newestDays} 天前`,
      note: ev.age.newestName ? `最近的是 ${ev.age.newestName}` : '',
    });
    if (stalePct > 0 || ev.age.newestDays > 90) {
      findings.push({
        label: '陈旧度',
        value: `${stalePct}% 超 90 天未动`,
        note: stalePct > 70 ? '基本可以认定为死数据' : stalePct > 30 ? '部分内容长期未用' : '近期还在用',
      });
    }
  } else if (item.mtime) {
    // 浅扫够不到深层时，用扫描树里的最新修改时间兜底
    newestDays = Math.max(0, Math.floor((Date.now() - item.mtime) / 86400000));
    findings.push({
      label: '最后修改',
      value: newestDays <= 0 ? '今天' : `${newestDays} 天前`,
      note: '来自扫描树',
    });
  }

  /* ---------------- 4. 判断 ---------------- */
  let verdict = '需要判断';
  let confidence = 'low';
  let estimatedFree = '—';

  const isStale = stalePct >= 70;
  const isFresh = newestDays != null && newestDays <= 14;
  const isFile = item.isDir === false;

  // ---- 单个文件：措辞完全不同，文件删了不会"重建" ----
  if (isFile) {
    const kind = ev?.exts?.[0]?.ext || (item.name || '').split('.').pop() || '';
    const kindName = EXT_KIND[kind] || `${kind} 文件`;
    if (safety === 'safe') {
      verdict = '可以直接删除';
      confidence = 'high';
      estimatedFree = `约 ${human(size)}`;
      actions.push(`这是临时/日志类文件，删除没有副作用`);
    } else if (safety === 'danger') {
      verdict = '需要你确认';
      confidence = 'medium';
      estimatedFree = `约 ${human(size)}（确认后）`;
      actions.push(`这是${kindName}，删掉就找不回来了；先确认不再需要`);
      if (newestDays != null) {
        actions.push(newestDays > 90 ? `已经 ${newestDays} 天没有改动过` : `${newestDays} 天前刚改过，可能是近期要用的`);
      }
    } else if (safety === 'keep') {
      verdict = '不要删除';
      confidence = 'high';
      actions.push('这是程序源码或系统文件，删除会导致项目或系统损坏');
    } else {
      verdict = '需要判断';
      confidence = 'medium';
      actions.push(`这是一个${kindName}，根据文件名判断是否还需要`);
    }
    risks.length = 0;
    risks.push(size > 1024 ** 3 ? `单个文件就有 ${human(size)}，删除后无法恢复` : '删除后无法通过本工具恢复');
  } else if (safety === 'safe') {
    verdict = '安全删除';
    confidence = 'high';
    estimatedFree = `约 ${human(size)}`;
    actions.push(ev?.fileCount ? `删除这 ${ev.fileCount.toLocaleString('zh-CN')} 个缓存文件，系统或应用会自动重建` : '直接删除，系统或应用会自动重建');
    if (rule?.action) actions.push(rule.action);
  } else if (safety === 'caution') {
    confidence = ev ? 'high' : 'medium';
    if (isStale) {
      verdict = '可以删除';
      estimatedFree = `约 ${human(size)}`;
      actions.push(`${stalePct}% 的内容超过 90 天没动过，删掉不会影响正在用的东西`);
    } else if (isFresh) {
      verdict = '谨慎删除';
      estimatedFree = `约 ${human(size)}（需要重建）`;
      actions.push(`最近 ${newestDays} 天还在写入，确认相关项目当前没在跑再删`);
    } else {
      verdict = '可以删除';
      estimatedFree = `约 ${human(size)}（需要重建）`;
      actions.push('删掉后需要重新下载或重新编译才能恢复');
    }
    if (rule?.action) actions.push(rule.action);
  } else if (safety === 'danger') {
    verdict = '需要你确认';
    confidence = ev ? 'medium' : 'low';
    if (isStale) {
      actions.push(`内容已经 ${stalePct}% 超过 90 天没用，如果确认不需要可以腾出 ${human(size)}`);
      estimatedFree = `约 ${human(size)}（确认后）`;
    } else {
      actions.push(`近期（${newestDays ?? '?'} 天前）还在使用，先确认不是正在进行的工作`);
      estimatedFree = '确认后再决定';
    }
    if (dominant) {
      actions.push(`如果只想腾一部分，可以先看「${dominant.name}」（${human(dominant.size)}）`);
    }
  } else if (safety === 'keep') {
    verdict = '不要删除';
    confidence = 'high';
    actions.push('这是系统组件或项目源码，手动删除会破坏系统或项目');
    if (rule?.action) actions.push(rule.action);
  } else {
    // 未识别：靠证据说话
    confidence = ev ? 'medium' : 'low';
    if (ev && dominantShare > 0.6) {
      verdict = '建议先查看';
      actions.push(`体积集中在「${dominant.name}」，先打开看看它是什么再决定`);
    } else {
      actions.push('规则库没覆盖这个路径，建议点「打开文件夹」看一眼');
    }
    estimatedFree = '待确认';
  }

  /* ---------------- 5. 风险 ---------------- */
  if (safety === 'danger') {
    risks.push('可能包含你的个人数据（聊天记录、模型、项目源码、下载文件等），删除后无法通过本工具恢复');
  } else if (safety === 'caution') {
    risks.push('删除后需要重新下载 / 重新编译 / 重新登录才能恢复');
    if (isFresh) risks.push(`最近 ${newestDays} 天有写入，可能正在被某个程序使用`);
  } else if (safety === 'safe') {
    if (ev?.fileCount > 100000) risks.push(`文件数量很大（${ev.fileCount.toLocaleString('zh-CN')} 个），删除会占用一段时间磁盘 IO`);
  } else if (safety === 'keep') {
    risks.push('删除会导致系统组件缺失或项目无法运行');
  }

  /* ---------------- 6. 用途描述（结合证据） ---------------- */
  // 文件数优先用扫描树的准确值（树的 fc 是全量统计，ev.fileCount 只是采样）
  const realFiles = item.fileCount ?? ev?.fileCount ?? 0;
  let purpose = rule?.purpose || '';
  if (isFile) {
    const k = (item.name || '').split('.').pop().toLowerCase();
    const kindName = EXT_KIND[k] || `${k} 文件`;
    purpose = `${item.name} —— ${kindName}，${human(size)}${newestDays != null ? `，最后修改于 ${newestDays} 天前` : ''}。${rule?.purpose || ''}`;
  } else if (ev) {
    const bits = [];
    if (realFiles) bits.push(`${realFiles.toLocaleString('zh-CN')} 个文件`);
    if (ev.dirCount) bits.push(`${ev.dirCount} 个子目录`);
    if (mainKinds) bits.push(`以 ${mainKinds} 为主`);
    if (bits.length) {
      purpose = `${rule?.title || '这个目录'}：${bits.join('、')}。${rule?.purpose || ''}`;
    }
  }
  if (ev?.errorCount > 0) {
    risks.push(`有 ${ev.errorCount} 个条目因权限不足没能读取，实际大小可能略大于统计值`);
  }
  // 采样截断时降置信度，避免把采样结论当全量事实
  if (ev?.truncated) {
    if (confidence === 'high') confidence = 'medium';
    findings.push({
      label: '采样范围',
      value: `已检查 ${ev.fileCount.toLocaleString('zh-CN')} 个文件`,
      note: '目录很大，类型与时间分布基于采样',
    });
  }

  return {
    source: 'evidence',
    path: item.path,
    isDir: item.isDir,
    size,
    title: rule?.title || '未识别',
    category: rule?.category || '未识别',
    ruleId: rule?.ruleId || 'unknown',
    safety,
    verdict,
    purpose,
    action: actions[0] || '',
    actions: actions.slice(0, 4),
    risks: risks.slice(0, 3),
    estimatedFree,
    confidence,
    findings,
    evidence: ev ? {
      totalSize: ev.totalSize,
      fileCount: ev.fileCount,
      dirCount: ev.dirCount,
      topDirs: (ev.topDirs || []).slice(0, 6),
      topFiles: (ev.topFiles || []).slice(0, 6),
      exts: (ev.exts || []).slice(0, 8),
      age: ev.age,
    } : null,
    categoryColor: SAFETY_META[safety]?.color,
  };
}
