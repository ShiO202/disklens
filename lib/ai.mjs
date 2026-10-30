/**
 * AI 分析模块
 * - 兼容 OpenAI /v1/chat/completions 的任何网关（默认预填 DSH 使用的火山方舟网关）
 * - 没配 API Key 时自动退化为本地规则引擎结论（工具照样可用）
 * - 批量分析：一次分析多个大目录，产出清理清单
 */
import { analyzePath, SAFETY_META } from './rules.mjs';
import { analyzeWithEvidence } from './localanalyze.mjs';

const DSH_GATEWAY = {
  baseURL: '',
  model: '',
  apiKeyEnv: 'OPENAI_API_KEY',
};

export function defaultAIConfig() {
  return {
    enabled: true,
    baseURL: DSH_GATEWAY.baseURL,
    model: DSH_GATEWAY.model,
    apiKey: '',
    apiKeyEnv: DSH_GATEWAY.apiKeyEnv,
    timeoutMs: 45000,
    temperature: 0.2,
  };
}

export function resolveApiKey(cfg) {
  if (cfg?.apiKey && String(cfg.apiKey).trim()) return String(cfg.apiKey).trim();
  const envName = cfg?.apiKeyEnv || DSH_GATEWAY.apiKeyEnv;
  if (envName && process.env[envName]) return process.env[envName];
  return '';
}

export function aiAvailable(cfg) {
  return !!(cfg?.enabled !== false && cfg?.baseURL && resolveApiKey(cfg));
}

const SAFETY_LABEL = Object.fromEntries(
  Object.entries(SAFETY_META).map(([k, v]) => [k, v.label])
);

function human(bytes) {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 2)} ${u[i]}`;
}

const SYSTEM_PROMPT = `你是资深 Windows 系统与软件工程专家，正在帮用户清理快要写满的硬盘。
用户会给你一个目录或文件的真实信息（路径、大小、文件数、修改时间、子项、扩展名分布），你要判断：
1. 它到底是什么（具体到在系统里扮演什么角色，不要泛泛而谈）
2. 能不能删、删了会怎样
3. 怎么删最安全

严格输出 JSON，不要 markdown 代码块，不要任何解释文字。字段定义：
{
  "purpose": "用途说明，1-3 句中文，必须具体（例如：这是 PyTorch 通过 transformers 下载的模型权重缓存，按 models--组织者--名称 存放）",
  "verdict": "安全删除 | 可以删除 | 谨慎删除 | 不要删除",
  "safety": "safe | caution | danger | keep",
  "reclaim": "全部 | 部分 | 无",
  "actions": ["具体操作步骤，每条 ≤ 40 字，最多 4 条"],
  "risks": ["删除后的具体影响，最多 3 条；没有就写空数组"],
  "estimatedFree": "预计可释放空间，例如 约 12.4 GB 或 约 800 MB（保留最近 3 个月）",
  "confidence": "high | medium | low"
}
safety 判定标准：
- safe：纯粹缓存/临时/日志，删除后系统或应用会自动重建，无功能损失
- caution：可删但需要重新下载、重新编译或重新登录，有时间和流量代价
- danger：可能包含用户数据（聊天记录、模型权重、项目源码、下载的文件），删除前必须人工确认
- keep：系统关键组件或正在进行中的项目，不要手动删除
判断要基于用户提到的事实与常见软件约定，不要编造不存在的文件。`;

function buildUserPrompt(item, ctx = {}) {
  const rule = item.rule || analyzePath(item.path, { isDir: item.isDir, name: item.name });
  const ev = item.evidence;
  const lines = [];
  lines.push(`路径：${item.path}`);
  lines.push(`类型：${item.isDir ? '目录' : '文件'}`);
  lines.push(`大小：${human(item.size)}（${item.size} 字节）`);

  // 优先用实测证据（比树里的聚合数据准）
  const fileCount = ev?.fileCount ?? item.fileCount;
  if (fileCount != null) lines.push(`包含文件数：${fileCount}`);
  if (ctx.disk) lines.push(`所在磁盘：总 ${human(ctx.disk.total)}，可用 ${human(ctx.disk.free)}`);

  if (ev) {
    if (ev.topDirs?.length) {
      lines.push('主要子目录（实测）：');
      for (const c of ev.topDirs.slice(0, 8)) lines.push(`  - ${c.name}/  ${human(c.size)}`);
    }
    if (ev.topFiles?.length) {
      lines.push('最大的文件（实测）：');
      for (const f of ev.topFiles.slice(0, 8)) lines.push(`  - ${f.name}  ${human(f.size)}`);
    }
    if (ev.exts?.length) {
      lines.push('文件类型分布（实测）：');
      for (const e of ev.exts.slice(0, 8)) lines.push(`  - .${e.ext}: ${human(e.size)}`);
    }
    if (ev.age) {
      const a = ev.age;
      lines.push(`最后写入：${a.newestDays == null ? '未知' : a.newestDays + ' 天前'}（${a.newestName || ''}）`);
      lines.push(`陈旧度：${Math.round((a.staleRatio || 0) * 100)}% 的体积超过 90 天未修改`);
      lines.push(`时间分布：<30天 ${a.buckets.fresh} 个 / 30-90天 ${a.buckets.mid} 个 / 90-365天 ${a.buckets.old} 个 / >1年 ${a.buckets.ancient} 个`);
    }
  } else if (item.topChildren?.length) {
    lines.push('主要子项（按大小排序）：');
    for (const c of item.topChildren.slice(0, 10)) {
      lines.push(`  - ${c.name}${c.isDir ? '/' : ''}  ${human(c.size)}`);
    }
  }

  if (rule.matched) {
    lines.push(`内置规则库初判：${rule.title}｜建议等级 ${rule.safety}（${SAFETY_LABEL[rule.safety]}）`);
    lines.push(`  规则说明：${rule.purpose}`);
  } else {
    lines.push('内置规则库初判：未覆盖此路径，请根据路径与文件构成自行判断。');
  }
  lines.push('');
  lines.push('请结合上面的实测数据判断，不要泛泛而谈。输出 JSON。');
  return lines.join('\n');
}

function extractJSON(text) {
  if (!text) throw new Error('模型返回为空');
  let t = String(text).trim();
  // 去 markdown 围栏
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

async function chat(cfg, messages, { jsonMode = true } = {}) {
  const key = resolveApiKey(cfg);
  if (!key) throw new Error('未配置 API Key');
  const base = String(cfg.baseURL || '').replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  const body = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature ?? 0.2,
    max_tokens: 1200,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs || 45000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`网关返回 ${res.status}：${text.slice(0, 300)}`);
  }
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`网关返回非 JSON：${text.slice(0, 200)}`); }
  const content = data?.choices?.[0]?.message?.content ?? '';
  return content;
}

/** 规则兜底结果（AI 不可用或失败时使用） */
export function ruleOnlyAnalysis(item, ctx = {}) {
  const rule = analyzePath(item.path, { isDir: item.isDir, name: item.name });
  return {
    source: 'rules',
    path: item.path,
    isDir: item.isDir,
    size: item.size,
    title: rule.title,
    category: rule.category,
    safety: rule.safety,
    verdict: {
      safe: '安全删除', caution: '可以删除', danger: '谨慎删除', keep: '不要删除', unknown: '需要判断',
    }[rule.safety] || '需要判断',
    purpose: rule.purpose,
    action: rule.action,
    actions: [rule.action],
    risks: rule.safety === 'danger' ? ['该目录可能包含你的个人数据，删除前请确认'] : [],
    reclaim: rule.safety === 'safe' ? '全部' : rule.safety === 'caution' ? '部分' : '无',
    estimatedFree: ['safe', 'caution'].includes(rule.safety) ? `约 ${human(item.size)}` : '不建议自动清理',
    confidence: rule.confidence === 'rule' ? 'high' : 'low',
    ruleId: rule.ruleId,
    categoryColor: SAFETY_META[rule.safety]?.color,
  };
}

/** 单个目标分析 */
export async function analyzeTarget(item, ctx, cfg) {
  const rule = item.rule || analyzePath(item.path, { isDir: item.isDir, name: item.name });
  // 兜底也走证据分析，不再退回模板
  const fallback = analyzeWithEvidence(item, rule, item.evidence || null);
  if (!aiAvailable(cfg)) {
    return { ...fallback, aiError: '未配置 API Key，使用本地证据分析' };
  }
  try {
    const content = await chat(cfg, [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(item, ctx) },
    ]);
    const j = extractJSON(content);
    return {
      ...fallback,
      source: 'ai',
      model: cfg.model,
      safety: normalizeSafety(j.safety, fallback.safety),
      verdict: j.verdict || fallback.verdict,
      purpose: j.purpose || fallback.purpose,
      action: (j.actions && j.actions[0]) || fallback.action,
      actions: Array.isArray(j.actions) && j.actions.length ? j.actions : fallback.actions,
      risks: Array.isArray(j.risks) && j.risks.length ? j.risks : fallback.risks,
      reclaim: j.reclaim || fallback.reclaim,
      estimatedFree: j.estimatedFree || fallback.estimatedFree,
      confidence: j.confidence || fallback.confidence,
      categoryColor: SAFETY_META[normalizeSafety(j.safety, fallback.safety)]?.color,
    };
  } catch (e) {
    return { ...fallback, aiError: String(e.message || e) };
  }
}

function normalizeSafety(s, dflt) {
  const v = String(s || '').toLowerCase().trim();
  if (['safe', 'caution', 'danger', 'keep'].includes(v)) return v;
  return dflt || 'unknown';
}

/** 批量分析：一次请求分析多个目录，节省 token 与时间 */
export async function analyzeBatch(items, ctx, cfg) {
  if (!aiAvailable(cfg)) return items.map((it) => ruleOnlyAnalysis(it, ctx));
  const CHUNK = 6;
  const out = [];
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    try {
      const prompt = `下面有 ${chunk.length} 个待分析目标，请逐个分析，输出一个 JSON 对象：
{"results":[{"index":0,"purpose":"...","verdict":"...","safety":"safe|caution|danger|keep","reclaim":"全部|部分|无","actions":["..."],"risks":["..."],"estimatedFree":"...","confidence":"high|medium|low"}, ...]}

${chunk.map((it, idx) => `### 目标 ${idx}\n${buildUserPrompt(it, ctx)}`).join('\n\n')}`;
      const content = await chat(cfg, [
        { role: 'system', content: SYSTEM_PROMPT + '\n本次你会收到多个目标，请输出 {"results":[...]} 形式的 JSON，results 顺序与目标一致，index 从 0 开始。' },
        { role: 'user', content: prompt },
      ]);
      const j = extractJSON(content);
      const arr = Array.isArray(j) ? j : (j.results || []);
      chunk.forEach((it, idx) => {
        const r = arr[idx] || {};
        const fallback = ruleOnlyAnalysis(it, ctx);
        const safety = normalizeSafety(r.safety, fallback.safety);
        out.push({
          ...fallback,
          source: 'ai',
          safety,
          verdict: r.verdict || fallback.verdict,
          purpose: r.purpose || fallback.purpose,
          actions: Array.isArray(r.actions) && r.actions.length ? r.actions : fallback.actions,
          action: (r.actions && r.actions[0]) || fallback.action,
          risks: Array.isArray(r.risks) ? r.risks : fallback.risks,
          reclaim: r.reclaim || fallback.reclaim,
          estimatedFree: r.estimatedFree || fallback.estimatedFree,
          confidence: r.confidence || 'medium',
          categoryColor: SAFETY_META[safety]?.color,
          model: cfg.model,
        });
      });
    } catch (e) {
      for (const it of chunk) out.push({ ...ruleOnlyAnalysis(it, ctx), aiError: String(e.message || e) });
    }
    if (i + CHUNK < items.length) await new Promise((r) => setTimeout(r, 300));
  }
  return out;
}

/** 连通性自检 */
export async function testConnection(cfg) {
  const key = resolveApiKey(cfg);
  if (!key) return { ok: false, error: '未配置 API Key（可设置环境变量 ' + (cfg.apiKeyEnv || DSH_GATEWAY.apiKeyEnv) + '）' };
  try {
    const base = String(cfg.baseURL || '').replace(/\/+$/, '');
    const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const j = await res.json().catch(() => ({}));
      const ids = (j.data || []).map((m) => m.id).slice(0, 40);
      return { ok: true, models: ids, usingEnv: !cfg.apiKey };
    }
    return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export { human, DSH_GATEWAY };

/* ================================================================
 * 分析后追问
 * ================================================================ */

/** 把分析上下文压成一段可复用的提示词 */
function contextPrompt(ctx) {
  const lines = [];
  if (ctx.path) lines.push(`目标：${ctx.path}`);
  if (ctx.size) lines.push(`大小：${human(ctx.size)}`);
  if (ctx.verdict) lines.push(`已给出的判定：${ctx.verdict}（安全等级 ${ctx.safety || '?'}，预计释放 ${ctx.estimatedFree || '?'}）`);
  if (ctx.purpose) lines.push(`已说明的用途：${ctx.purpose}`);
  if (ctx.actions?.length) lines.push(`已建议的操作：${ctx.actions.join('；')}`);
  if (ctx.risks?.length) lines.push(`已提示的风险：${ctx.risks.join('；')}`);
  if (ctx.findings?.length) {
    lines.push('实测证据：');
    for (const f of ctx.findings) lines.push(`  - ${f.label}：${f.value}${f.note ? '（' + f.note + '）' : ''}`);
  }
  if (ctx.evidence?.topDirs?.length) {
    lines.push('子目录（实测）：' + ctx.evidence.topDirs.slice(0, 8).map((d) => `${d.name} ${human(d.size)}`).join('、'));
  }
  if (ctx.evidence?.exts?.length) {
    lines.push('文件类型：' + ctx.evidence.exts.slice(0, 8).map((e) => `.${e.ext} ${human(e.size)}`).join('、'));
  }
  return lines.join('\n');
}

const FOLLOWUP_SYSTEM = `你是 Windows 磁盘清理专家，正在和用户讨论一个具体的目录或文件。
用户已经看过你的初步分析，现在继续追问。请：
1. 直接回答问题，不要重复已经说过的内容
2. 需要引用事实时，只用给定的实测数据，不要编造
3. 如果问题涉及删除操作，明确说明后果和更安全的替代方案
4. 回答控制在 200 字以内，用中文，条理清晰（可用短列表）
5. 不确定就说不确定，不要硬编`;

/** 真·多轮对话（需要 AI） */
export async function chatFollowUp(ctx, messages, cfg) {
  const sys = `${FOLLOWUP_SYSTEM}\n\n【当前分析对象的实测数据】\n${contextPrompt(ctx)}`;
  const history = messages.slice(-8).map((m) => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: String(m.content || '').slice(0, 2000),
  }));
  const content = await chat(cfg, [{ role: 'system', content: sys }, ...history], { jsonMode: false });
  return String(content || '').trim();
}

/**
 * 本地问答（没有 AI 时也能继续对话）
 * 不是真对话，但能从证据里捞出一个像样的答案
 */
export function localFollowUp(ctx, messages) {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  const q = String(last?.content || '').toLowerCase();

  const size = ctx.size ? human(ctx.size) : '未知';
  const est = ctx.estimatedFree || '未知';
  const verdict = ctx.verdict || '需要判断';

  if (/多少|多大|占用|释放|腾出|空间/.test(q)) {
    const parts = [`这个目录占用 ${size}。`];
    if (ctx.estimatedFree) parts.push(`按当前判断，可以释放 ${ctx.estimatedFree}。`);
    if (ctx.findings?.length) {
      const conc = ctx.findings.find((f) => f.label === '体积集中');
      if (conc) parts.push(`其中 ${conc.value}${conc.note ? '（' + conc.note + '）' : ''}。`);
    }
    return parts.join('');
  }

  if (/怎么|如何|步骤|操作|命令|清理/.test(q)) {
    if (ctx.actions?.length) {
      return '建议这样处理：\n' + ctx.actions.map((a, i) => `${i + 1}. ${a}`).join('\n');
    }
    return '这个目录没有特别的操作建议，直接删除即可。';
  }

  if (/风险|影响|后果|会不会|安全/.test(q)) {
    if (ctx.risks?.length) {
      return '需要注意：\n' + ctx.risks.map((r) => `• ${r}`).join('\n');
    }
    return `风险较低。当前判定是「${verdict}」，删除前建议先打开看一眼。`;
  }

  if (/为什么|依据|怎么判断|凭什么/.test(q)) {
    const bits = [];
    if (ctx.purpose) bits.push(`用途判定：${ctx.purpose}`);
    if (ctx.findings?.length) {
      bits.push('实测依据：' + ctx.findings.map((f) => `${f.label}=${f.value}`).join('；'));
    }
    return bits.join('\n') || '依据来自内置规则库对这类目录的先验知识。';
  }

  if (/能删|可以删|该删|要不要|值得/.test(q)) {
    return `当前判定：${verdict}${ctx.estimatedFree ? '，预计可释放 ' + ctx.estimatedFree : ''}。${ctx.actions?.[0] || ''}`;
  }

  // 兜底：给出完整摘要
  const lines = [`${ctx.path || '这个目录'}：${size}，判定为「${verdict}」。`];
  if (ctx.purpose) lines.push(ctx.purpose);
  if (ctx.actions?.[0]) lines.push(`建议：${ctx.actions[0]}`);
  lines.push('');
  lines.push('（未配置 AI，以上是基于实测数据的固定回答；配置 AI Key 后可以自由追问）');
  return lines.join('\n');
}
