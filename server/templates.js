/**
 * 模块 A —— 模板注册表与热重载。
 *
 * 需求：
 *   A-REQ-201  模板须支持变量插值（{{name}}），以便单模板适配多赛事文案
 *   A-REQ-202  模板 id 必须稳定（改名不得改 id）
 *   A-REQ-210  支持**基于内置模板复制并覆盖**：不改内置文件，覆盖存于 templates/custom/*.json
 *   A-REQ-211  模板须支持自定义 CSS 变量（字号、字体、圆角、配色）
 *   A-REQ-212  模板须支持自定义 CSS 片段注入（进阶用户）
 *   A-REQ-213  ★ 模板变更须**热重载**：保存后渲染端自动刷新该模板，**不得**整页 reload。
 *               实现：文件变更 → 服务端 diff → 仅推送受影响的模板定义 →
 *               渲染端替换 DOM 节点并保留当前数据
 *   A-REQ-214  模板编辑须有**实时预览**
 *   A-REQ-215  模板须通过 schema 校验，非法时拒绝加载并指明**字段路径**
 *   A-REQ-202  模板 id 必须稳定
 *   （陷阱 #53：模板热重载做整页 reload → 黑屏；#59：模板 id 随改名变化 → 已有配置全部失效）
 */
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { getConfig, ROOT, withinRoot } from './config.js';
import { set } from './state.js';
import * as log from './logger.js';

export const templateEvents = new EventEmitter();

/** @type {Map<string, object>} */
let registry = new Map();
let watchers = [];
let reloadTimer = null;

const CATEGORIES = ['player', 'talent', 'credits', 'custom'];

/**
 * 风格（style）—— 同一种图形可以有多种视觉风格，用户按风格挑选。
 * 新增风格时在这里登记一行，模板管理页与叠加控制台会自动出现对应分组。
 */
export const STYLE_META = [
  { id: 'broadcast', label: '转播', desc: '实心底板 + 发丝线，电视台转播最常见的克制样式' },
  { id: 'neon',      label: '霓虹', desc: '深色底 + 双色辉光与扫描线，赛博/街机赛事用' },
  { id: 'glass',     label: '磨砂', desc: '半透明底板 + 背景模糊，适合画面细节多的场景' },
  { id: 'arcade',    label: '街机', desc: '硬边斜切 + 重字重，节奏游戏的高张力样式' },
  { id: 'contrast',  label: '高对比', desc: '白底黑字或对抗双色，亮场地上更醒目' },
  { id: 'bold',      label: '粗排', desc: '大字号 + 粗底边，远处可读' },
  { id: 'minimal',   label: '极简', desc: '无底板，细字 + 强调线' },
  { id: 'split',     label: '斜切', desc: '斜切分屏色块' },
  { id: 'classic',   label: '标准（旧）', desc: '旧版默认风格，保留兼容' },
];
const STYLE_IDS = STYLE_META.map((x) => x.id);

/**
 * 图形族（family）—— 同一个「功能形状」的模板归为一族，
 * 例如 lowerThird / lowerThirdNeon / lowerThirdMinimal 都属于 lowerThird。
 * 叠加控制台按「类型 → 图形族 → 风格」三级展示，避免十几个模板堆在一起。
 */
export const FAMILY_LABEL = {
  lowerThird: '姓名条',
  versusCard: '对阵卡',
  talentTwin: '双人名牌',
  thanksRoll: '滚动致谢',
  thanksGrid: '网格致谢',
  cornerBadge: '角标',
};
const SLOT_TYPES = ['text', 'image', 'color', 'select', 'number'];
/**
 * 可用动画名 —— 必须与 `public/render/renderer.js` 里的 KEYFRAMES 表保持一致。
 * 出场动画是入场帧的逆放，所以 fadeIn / fadeOut 是同一套帧，只是名字不同。
 */
const ANIM_NAMES = [
  'none',
  'fadeIn', 'fadeOut', 'fadeUp', 'fadeDown',
  'slideLeft', 'slideRight', 'slideUp', 'slideDown',
  'scaleIn', 'wipeRight', 'blurIn',
];

// ─────────────────────────────────────────────────────────────
// 加载
// ─────────────────────────────────────────────────────────────

function dirs() {
  const cfg = getConfig();
  const b = cfg.templates?.builtinDir || './templates/builtin';
  const c = cfg.templates?.customDir || './templates/custom';
  // 强制落在项目目录内，防止模板目录被指到程序之外读/写/删任意 JSON
  return {
    builtin: withinRoot(b) || path.join(ROOT, 'templates', 'builtin'),
    custom: withinRoot(c) || path.join(ROOT, 'templates', 'custom'),
  };
}

export function load() {
  const { builtin, custom } = dirs();
  const next = new Map();
  const errors = [];

  // ① 内置模板
  for (const f of listJson(builtin)) {
    const r = readTemplate(f, true);
    if (r.ok) next.set(r.tpl.id, r.tpl);
    else errors.push({ file: f, errors: r.errors });
  }

  // ② 自定义模板（覆盖同名内置 —— A-REQ-210）
  for (const f of listJson(custom)) {
    const r = readTemplate(f, false);
    if (!r.ok) { errors.push({ file: f, errors: r.errors }); continue; }
    const base = next.get(r.tpl.id);
    if (base) {
      // 「基于内置模板复制并覆盖」：深合并，未覆盖的槽位 / CSS 沿用内置
      next.set(r.tpl.id, mergeTemplate(base, r.tpl));
      log.info('templates', `自定义模板覆盖内置：${r.tpl.id}`, { file: path.basename(f) });
    } else {
      next.set(r.tpl.id, r.tpl);
    }
  }

  const prev = registry;
  registry = next;

  // 非法模板：拒绝加载但**保留上一份可用版本**（AC-A11：渲染端不受影响）
  for (const e of errors) {
    log.error('templates', `模板校验失败，已拒绝加载（保留上一版本）`, {
      file: path.basename(e.file),
      paths: Object.keys(e.errors).join(', '),
      detail: e.errors,
    });
  }

  set('overlay.templates', publicList());
  templateEvents.emit('change', diff(prev, next));
  log.info('templates', '模板表已加载', { count: registry.size, errors: errors.length });
  return { ok: true, count: registry.size, errors };
}

function listJson(dir) {
  try {
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); return []; }
    return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => path.join(dir, n));
  } catch { return []; }
}

function readTemplate(file, builtin) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, errors: { __file__: `读取失败：${e.message}` } }; }

  let json;
  try { json = JSON.parse(raw); } catch (e) {
    return { ok: false, errors: { __file__: `JSON 解析失败：${e.message}` } };
  }

  const tpl = { ...json, builtin: builtin || !!json.builtin, sourceFile: file };
  const errors = validateTemplate(tpl);
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, tpl };
}

/**
 * ★ A-REQ-215：校验必须指明**字段路径**。
 * 例：`slots[2].key: 必须是字符串`、`defaultAnim.in: 未知动画 noSuchAnim`
 */
export function validateTemplate(t) {
  const e = {};
  if (!t || typeof t !== 'object') return { __root__: '模板必须是对象' };

  if (typeof t.id !== 'string' || !t.id.trim()) e.id = 'id 不能为空（且必须稳定 —— 改名不得改 id，A-REQ-202）';
  else if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(t.id)) e.id = 'id 只能包含字母数字下划线连字符，且以字母开头';

  if (typeof t.name !== 'string' || !t.name.trim()) e.name = 'name 不能为空';
  if (!CATEGORIES.includes(t.category)) e.category = `category 必须是 ${CATEGORIES.join(' / ')} 之一`;

  // family / style 都是可选的；给了就必须合法
  if (t.family !== undefined && (typeof t.family !== 'string' || !t.family.trim())) {
    e.family = 'family 必须是非空字符串（图形族 id，如 lowerThird）';
  }
  if (t.style !== undefined && !STYLE_IDS.includes(t.style)) {
    e.style = `style 必须是 ${STYLE_IDS.join(' / ')} 之一`;
  }

  if (!Array.isArray(t.slots)) e.slots = 'slots 必须是数组';
  else {
    const seen = new Set();
    t.slots.forEach((s, i) => {
      const p = `slots[${i}]`;
      if (!s || typeof s !== 'object') { e[p] = '必须是对象'; return; }
      if (typeof s.key !== 'string' || !s.key.trim()) e[`${p}.key`] = 'key 不能为空';
      else if (seen.has(s.key)) e[`${p}.key`] = `key 重复：${s.key}`;
      else seen.add(s.key);
      if (typeof s.label !== 'string' || !s.label.trim()) e[`${p}.label`] = 'label 不能为空';
      if (!SLOT_TYPES.includes(s.type)) e[`${p}.type`] = `type 必须是 ${SLOT_TYPES.join(' / ')} 之一`;
      if (s.type === 'text' && s.maxLength !== undefined && (!Number.isInteger(s.maxLength) || s.maxLength <= 0)) {
        e[`${p}.maxLength`] = 'maxLength 必须是正整数';
      }
      if (s.type === 'select' && !Array.isArray(s.options)) e[`${p}.options`] = 'select 类型必须提供 options 数组';
      if (s.entitySource && !['player', 'talent', 'sponsor'].includes(s.entitySource)) {
        e[`${p}.entitySource`] = 'entitySource 必须是 player / talent / sponsor 之一';
      }
    });
  }

  if (t.defaultAnim !== undefined) {
    if (typeof t.defaultAnim !== 'object' || t.defaultAnim === null) e.defaultAnim = '必须是对象 { in, out, durationMs }';
    else {
      if (t.defaultAnim.in && !ANIM_NAMES.includes(t.defaultAnim.in)) e['defaultAnim.in'] = `未知动画 ${t.defaultAnim.in}；可用：${ANIM_NAMES.join('/')}`;
      if (t.defaultAnim.out && !ANIM_NAMES.includes(t.defaultAnim.out)) e['defaultAnim.out'] = `未知动画 ${t.defaultAnim.out}；可用：${ANIM_NAMES.join('/')}`;
      if (t.defaultAnim.durationMs !== undefined && (!Number.isFinite(t.defaultAnim.durationMs) || t.defaultAnim.durationMs < 0)) {
        e['defaultAnim.durationMs'] = 'durations 必须是 ≥0 的数字';
      }
    }
  }

  if (t.cssVars !== undefined && (typeof t.cssVars !== 'object' || Array.isArray(t.cssVars) || t.cssVars === null)) {
    e.cssVars = 'cssVars 必须是对象 { "--var": "value" }';
  } else if (t.cssVars) {
    for (const k of Object.keys(t.cssVars)) {
      if (!k.startsWith('--')) e[`cssVars.${k}`] = 'CSS 变量名必须以 -- 开头';
    }
  }

  if (t.css !== undefined && typeof t.css !== 'string') e.css = 'css 必须是字符串';
  if (t.html !== undefined && typeof t.html !== 'string') e.html = 'html 必须是字符串';
  if (!t.html && !t.render) e.html = '必须提供 html 或 render（否则渲染端无从绘制）';

  // 陷阱：html 里引用了未声明的槽位 → 渲染端永远拿不到值，属于静默故障，必须在加载期拦下。
  // 例外：**多值槽位**（multi:true）的元素是「行原型」，其内部引用的是**每个数据项的字段**
  //       而不是槽位本身，这些字段由 rowKeys 显式声明，外加通用的 item / alt。
  if (typeof t.html === 'string' && Array.isArray(t.slots)) {
    const declared = new Set(t.slots.map((s) => s.key));
    const rowFields = new Set(['item', 'alt', 'index']);
    for (const s of t.slots) {
      if (s.multi) for (const k of (s.rowKeys || [])) rowFields.add(k);
    }
    const allow = (k) => declared.has(k) || rowFields.has(k);

    for (const m of t.html.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) {
      if (!allow(m[1])) {
        const multi = t.slots.filter((s) => s.multi).map((s) => s.key);
        e['html'] = `html 中引用了未声明的槽位 {{${m[1]}}}（slots 里没有这个 key`
          + (multi.length ? `，也不是多值槽位 ${multi.join('/')} 的行字段；若是行字段请写进 rowKeys` : '')
          + '）';
      }
    }
    for (const m of t.html.matchAll(/data-slot="([^"]+)"/g)) {
      if (!declared.has(m[1])) e['html'] = `html 中的 data-slot="${m[1]}" 未在 slots 中声明`;
    }
  }

  return e;
}

function mergeTemplate(base, custom) {
  const out = {
    ...base,
    ...custom,
    id: base.id,                       // ★ id 永远以内置为准，绝不让改名改 id
    builtin: true,
    overridden: true,
    baseName: base.name,
    slots: custom.slots && custom.slots.length ? custom.slots : base.slots,
    cssVars: { ...(base.cssVars || {}), ...(custom.cssVars || {}) },
    defaultAnim: { ...(base.defaultAnim || {}), ...(custom.defaultAnim || {}) },
  };
  return out;
}

/** 仅推送发生变化的模板（A-REQ-213：不得整页 reload） */
function diff(prev, next) {
  const changed = [];
  for (const [id, t] of next) {
    const p = prev.get(id);
    if (!p || JSON.stringify(stripVolatile(p)) !== JSON.stringify(stripVolatile(t))) changed.push(t);
  }
  const removed = [...prev.keys()].filter((id) => !next.has(id));
  return { changed, removed, removedIds: removed };
}

/** 剔除不该参与 diff 的字段（文件路径等） */
function stripVolatile(t) {
  const { sourceFile, ...rest } = t;
  return rest;
}

// ─────────────────────────────────────────────────────────────
// 查询
// ─────────────────────────────────────────────────────────────

/** 图形族：显式声明优先；老模板（没有 family 字段）回落到 id */
export function familyOf(t) {
  return (t && (t.family || t.id)) || '';
}
/** 风格：显式声明优先，默认 classic */
export function styleOf(t) {
  return (t && STYLE_IDS.includes(t.style)) ? t.style : 'classic';
}

export function get(id) { return registry.get(id) || null; }
export function all() { return [...registry.values()]; }
export function ids() { return [...registry.keys()]; }

/** 下发渲染端的完整模板定义（含 html / css，供渲染用） */
export function fullList() {
  return all().map((t) => ({
    id: t.id, name: t.name, category: t.category, builtin: !!t.builtin,
    family: familyOf(t), style: styleOf(t),
    slots: t.slots, defaultAnim: t.defaultAnim || {}, cssVars: t.cssVars || {},
    css: t.css || '', html: t.html || '', render: t.render || null,
    preview: t.preview || '', overridden: !!t.overridden, baseName: t.baseName || null,
  }));
}

/** 控制端用的精简列表（不含 html/css 大块，省带宽） */
export function publicList() {
  return all().map((t) => ({
    id: t.id, name: t.name, category: t.category, builtin: !!t.builtin,
    overridden: !!t.overridden,
    family: familyOf(t), style: styleOf(t),
    familyLabel: FAMILY_LABEL[familyOf(t)] || familyOf(t),
    styleLabel: (STYLE_META.find((x) => x.id === styleOf(t)) || {}).label || styleOf(t),
    slots: t.slots,
    defaultAnim: t.defaultAnim || { in: 'fadeUp', out: 'fadeDown', durationMs: 400 },
    hasCss: !!t.css, cssVarCount: Object.keys(t.cssVars || {}).length,
    preview: t.preview || '',
  }));
}

export function byCategory(cat) { return all().filter((t) => t.category === cat); }

// ─────────────────────────────────────────────────────────────
// 写入 / 热重载
// ─────────────────────────────────────────────────────────────

/** 保存自定义模板（新建或覆盖），随后自动热重载 */
export function saveCustom(tpl) {
  const { custom } = dirs();
  fs.mkdirSync(custom, { recursive: true });

  const id = tpl.id;
  if (!id) return { ok: false, errors: { id: '缺少 id' } };

  const clean = { ...tpl };
  delete clean.builtin;
  delete clean.sourceFile;
  delete clean.overridden;
  delete clean.baseName;

  const errors = validateTemplate({ ...clean, builtin: false });
  if (Object.keys(errors).length) return { ok: false, errors };

  const file = path.join(custom, `${id}.json`);
  try {
    fs.writeFileSync(file, `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
  } catch (e) {
    return { ok: false, errors: { __file__: `写入失败：${e.message}` } };
  }
  log.audit('templates', 'saveCustom', { id, file: path.basename(file) });
  reloadNow('保存自定义模板');
  return { ok: true, id, file, template: get(id) };
}

/** 删除自定义模板（内置模板不可删） */
export function removeCustom(id) {
  // ★ id 直接拼进文件路径，必须先校验格式，防止 ../ 路径穿越删除任意文件
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(String(id || ''))) {
    return { ok: false, errors: { id: 'id 只能包含字母数字下划线连字符，且以字母开头' } };
  }
  const { custom } = dirs();
  const file = path.join(custom, `${id}.json`);
  if (!fs.existsSync(file)) return { ok: false, errors: { id: '自定义模板不存在' } };
  try { fs.unlinkSync(file); } catch (e) { return { ok: false, errors: { __file__: e.message } }; }
  log.audit('templates', 'removeCustom', { id });
  reloadNow('删除自定义模板');
  return { ok: true };
}

/**
 * ★ A-REQ-213：非法模板拒绝加载并**回滚**，渲染端不受影响（AC-A11）。
 * 这里 reloadNow 内部保留上一份 registry 中未变更的条目。
 */
export function reloadNow(reason = '手动') {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    try {
      const before = new Map(registry);
      const r = load();
      if (r.errors.length) {
        // 回滚：把校验失败的 id 恢复成上一版本
        for (const e of r.errors) {
          const id = path.basename(e.file, '.json');
          if (before.has(id)) {
            registry.set(id, before.get(id));
            log.warn('templates', `模板 ${id} 校验失败，已回滚到上一可用版本`, { paths: Object.keys(e.errors) });
          }
        }
        set('overlay.templates', publicList());
      }
      log.info('templates', `模板热重载完成（${reason}）`, { count: registry.size });
    } catch (e) {
      log.error('templates', '模板热重载失败', { err: e.message, reason });
    }
  }, 150);
  reloadTimer.unref?.();
}

export function startWatch() {
  stopWatch();
  const cfg = getConfig();
  if (!cfg.templates?.hotReload) {
    log.info('templates', '模板热重载已在配置中关闭');
    return;
  }
  const { builtin, custom } = dirs();
  for (const d of [builtin, custom]) {
    try {
      fs.mkdirSync(d, { recursive: true });
      const w = fs.watch(d, { persistent: false }, (_evt, filename) => {
        if (!filename || !String(filename).endsWith('.json')) return;
        log.info('templates', '检测到模板文件变更', { file: String(filename), dir: path.basename(d) });
        reloadNow(`文件变更 ${filename}`);
      });
      watchers.push(w);
    } catch (e) {
      log.warn('templates', '模板目录监视失败', { dir: d, err: e.message });
    }
  }
  log.info('templates', '模板目录监视已启动', { dirs: [builtin, custom].map((d) => path.basename(d)) });
}

export function stopWatch() {
  for (const w of watchers) { try { w.close(); } catch { /* ignore */ } }
  watchers = [];
}

export function stats() {
  const all0 = all();
  return {
    total: all0.length,
    builtin: all0.filter((t) => t.builtin && !t.overridden).length,
    overridden: all0.filter((t) => t.overridden).length,
    custom: all0.filter((t) => !t.builtin).length,
    byCategory: CATEGORIES.reduce((acc, c) => { acc[c] = all0.filter((t) => t.category === c).length; return acc; }, {}),
    byStyle: STYLE_META.reduce((acc, st) => { acc[st.id] = all0.filter((t) => styleOf(t) === st.id).length; return acc; }, {}),
    families: [...new Set(all0.map((t) => familyOf(t)))],
  };
}

export { ANIM_NAMES, SLOT_TYPES, CATEGORIES };
