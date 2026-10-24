/**
 * 配置服务 —— 加载 / 校验 / 分节 patch / 落盘 / 变更通知。
 *
 * 需求：
 *   G-REQ-101  vMix 与 OBS 的地址必须完全配置化，不得硬编码
 *   G-REQ-102  切换单机/双机部署只允许修改配置文件，不得改动代码
 *   A-REQ-215  非法配置拒绝加载并指明字段路径
 *   B-REQ-305  启动时预检 config.json schema 合法性
 *
 * config/config.json 是唯一真源；首次启动时由 DEFAULT_CONFIG 物化生成。
 */
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  DEFAULT_CONFIG, CONFIG_GROUPS, FIELD_SCHEMA,
  deepMerge, getPath, setPath, deletePath, extractKnownFields,
  validateConfig, normalizeConfig, RESTART_PATHS, SENSITIVE_PATHS,
} from './config-schema.js';

export const ROOT = path.resolve(process.cwd());

/**
 * 把配置里的相对/绝对路径解析后，强制落在项目根目录内。
 * 越界（`..`、绝对路径指向别处、跨盘符、Windows 保留设备名）返回 null。
 * 用于防止把媒体 / 模板 / 实体目录指到程序之外，借本进程读写/删除任意文件。
 */
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

export function withinRoot(p) {
  const s = String(p ?? '').trim();
  if (!s) return null;
  const segments = s.split(/[\\/]+/).filter(Boolean);
  // 路径穿越段（即使能折叠回根目录内，也是可疑输入）一律拒绝
  if (segments.includes('..')) return null;
  // Windows 保留设备名（nul / con / aux / prn / com1-9 / lpt1-9）不能作为路径段
  if (segments.some((seg) => WIN_RESERVED.test(seg))) return null;

  const abs = path.isAbsolute(s) ? path.normalize(s) : path.resolve(ROOT, s);
  const rel = path.relative(ROOT, abs);
  // rel === ''（即 ROOT 本身）、或是 ROOT 内的相对子路径 → 允许
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return abs;
  return null;
}

/** 这些字段决定 fs 读写/删除的目标，必须落在项目根目录内 */
const WITHIN_ROOT_FIELDS = ['media.dir', 'templates.builtinDir', 'templates.customDir', 'entities.file'];

const CONFIG_DIR = path.join(ROOT, 'config');
/**
 * 配置文件路径。可用环境变量 `LP_CONFIG` 指向另一份配置 ——
 * 端到端自检靠它跑在隔离配置上：绝不能让自检读到现场的
 * obs.host / vmix.host 然后对着真实设备发指令。
 */
const CONFIG_FILE = process.env.LP_CONFIG
  ? path.resolve(process.env.LP_CONFIG)
  : path.join(CONFIG_DIR, 'config.json');

/** 单例变更事件总线：'change' (patch, changedPaths) */
export const configEvents = new EventEmitter();

let current = null;
let lastErrors = {};
let lastLoadedAt = 0;

function ensureDirs() {
  for (const d of [CONFIG_DIR, path.join(ROOT, 'data'), path.join(ROOT, 'media'), path.join(ROOT, 'logs')]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* 已存在 */ }
  }
}

/** 掩码敏感值，供 API 返回与日志使用 */
export function maskSecrets(cfg) {
  const out = structuredClone(cfg);
  for (const p of SENSITIVE_PATHS) {
    const v = getPath(out, p);
    if (typeof v === 'string' && v.length > 0) {
      // 保留首尾各 2 字符便于确认填对了哪一个
      setPath(out, p, v.length <= 6 ? '••••' : `${v.slice(0, 2)}••••${v.slice(-2)}`);
    }
  }
  return out;
}

/** 读取（未掩码的）当前配置对象。调用方**不得**直接修改返回对象。 */
export function getConfig() {
  if (!current) loadConfig();
  return current;
}

export function getConfigErrors() { return lastErrors; }
export function getConfigMeta() {
  return { file: CONFIG_FILE, loadedAt: lastLoadedAt, errors: lastErrors };
}

/**
 * 从磁盘加载配置；文件不存在则以默认值生成。
 * 磁盘上的非法值**不会**导致启动失败 —— 会保留默认值并把错误登记到 lastErrors，
 * 供设置页高亮显示（避免一处手滑就整套系统起不来）。
 */
export function loadConfig() {
  ensureDirs();

  /**
   * 首次运行：没有 config.json 时，用同目录的 config.example.json 作为初始值
   * （开源仓库只带 example，里面是默认管理员密码散列 / 回环地址，不含任何现场数据）。
   */
  const EXAMPLE_FILE = path.join(path.dirname(CONFIG_FILE), 'config.example.json');
  const sourceFile = fs.existsSync(CONFIG_FILE)
    ? CONFIG_FILE
    : (fs.existsSync(EXAMPLE_FILE) ? EXAMPLE_FILE : null);

  let disk = {};
  let parseError = null;
  if (sourceFile) {
    try {
      const raw = fs.readFileSync(sourceFile, 'utf8');
      disk = raw.trim() === '' ? {} : JSON.parse(raw);
    } catch (e) {
      parseError = e.message;
      disk = {};
    }
  }

  const merged = normalizeConfig(deepMerge(structuredClone(DEFAULT_CONFIG), disk));
  const errors = validateConfig(merged);

  // 路径字段越界同样回退默认值（防止配置文件被改成指向程序之外）
  for (const p of WITHIN_ROOT_FIELDS) {
    const v = getPath(merged, p);
    if (typeof v === 'string' && v.trim() !== '' && !withinRoot(v)) {
      errors[p] = `路径必须位于项目目录内（已回退到默认值 ${JSON.stringify(getPath(DEFAULT_CONFIG, p))}）`;
    }
  }

  // 非法字段回退到默认值，其余照常生效
  const effective = structuredClone(merged);
  for (const [p, msg] of Object.entries(errors)) {
    const def = getPath(DEFAULT_CONFIG, p);
    if (def === undefined) deletePath(effective, p);
    else setPath(effective, p, def);
    errors[p] = `${msg}（已回退到默认值 ${JSON.stringify(def)}）`;
  }
  if (parseError) {
    errors['__file__'] = `config.json 解析失败：${parseError}（已使用全量默认值启动）`;
  }

  current = effective;
  lastErrors = errors;
  lastLoadedAt = Date.now();

  if (!fs.existsSync(CONFIG_FILE) || parseError) persist(current);
  return current;
}

function persist(cfg) {
  ensureDirs();
  // LP_CONFIG 可能指向项目外的临时目录，确保其父目录存在
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
}

/**
 * 应用一次配置 patch。
 * @param {object} patch 形如 { 'obs.host': '192.168.10.11', 'replay.markDelayMs': 250 } 或嵌套对象
 * @returns {{ok:boolean, errors:object, changed:string[]}}
 */
export function patchConfig(patch) {
  if (!patch || typeof patch !== 'object') return { ok: false, errors: { __patch__: 'patch 必须是对象' }, changed: [] };

  const flat = flatten(patch);
  const before = structuredClone(getConfig());

  // 1) 逐字段校验（只校验被改动的字段，跨字段规则稍后整体再跑一遍）
  const draft = structuredClone(before);
  const fieldErrors = {};
  for (const [p, raw] of Object.entries(flat)) {
    const f = FIELD_SCHEMA.find((x) => x.path === p);
    if (!f) {
      // 允许未登记的路径（如 transitions.sceneOverrides 的子键），走 JSON 结构校验
      setPath(draft, p, raw);
      continue;
    }
    setPath(draft, p, raw);
    const errs = validateConfig(pick(draft, p));
    if (errs[p]) fieldErrors[p] = errs[p];
    // 路径字段必须落在项目根目录内，否则可借本进程读写/删除任意文件
    if (WITHIN_ROOT_FIELDS.includes(p) && typeof raw === 'string' && raw.trim() !== '' && !withinRoot(raw)) {
      fieldErrors[p] = '路径必须位于项目目录内，不能指向程序之外';
    }
  }

  const draftNorm = normalizeConfig(draft);
  const allErrors = validateConfig(draftNorm);
  const errors = { ...fieldErrors };
  for (const [p, m] of Object.entries(allErrors)) {
    if (!flat[p] && !Object.keys(flat).some((k) => p.startsWith(`${k}.`) || k.startsWith(`${p}.`))) {
      // 与本次改动无关的历史错误，不阻断本次保存
      continue;
    }
    errors[p] = m;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors, changed: [] };

  // 2) 应用
  const next = normalizeConfig(structuredClone(before));
  for (const [p, v] of Object.entries(flat)) setPath(next, p, v);

  const changed = diffPaths(before, next);
  // 按 DEFAULT_CONFIG 的形状裁剪：保留全部结构性节点（含未在设置页登记的整节），
  // 只丢弃真正未知的脏字段。
  current = extractKnownFields(deepMerge(structuredClone(DEFAULT_CONFIG), next));
  lastErrors = {};
  lastLoadedAt = Date.now();
  persist(current);

  if (changed.length) configEvents.emit('change', flat, changed);
  return { ok: true, errors: {}, changed };
}

/** 整体替换配置（导入用） */
export function replaceConfig(next) {
  const normalized = normalizeConfig(deepMerge(structuredClone(DEFAULT_CONFIG), next || {}));
  const errors = validateConfig(normalized);
  for (const p of WITHIN_ROOT_FIELDS) {
    const v = getPath(normalized, p);
    if (typeof v === 'string' && v.trim() !== '' && !withinRoot(v)) {
      errors[p] = '路径必须位于项目目录内，不能指向程序之外';
    }
  }
  if (Object.keys(errors).length) return { ok: false, errors, changed: [] };
  const before = structuredClone(getConfig());
  current = extractKnownFields(normalized);
  lastErrors = {};
  persist(current);
  const changed = diffPaths(before, current);
  if (changed.length) configEvents.emit('change', {}, changed);
  return { ok: true, errors: {}, changed };
}

/** 重置为默认值 */
export function resetConfig() {
  const before = structuredClone(getConfig());
  current = structuredClone(DEFAULT_CONFIG);
  lastErrors = {};
  persist(current);
  const changed = diffPaths(before, current);
  configEvents.emit('change', {}, changed);
  return { ok: true, errors: {}, changed };
}

/** 变更字段是否命中需要重连的路径 */
export function needsReconnect(changedPaths) {
  return changedPaths.some((p) => RESTART_PATHS.some((r) => p === r || p.startsWith(`${r}.`) || r.startsWith(`${p}.`)));
}

// ── 内部工具 ──

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && !FIELD_SCHEMA.some((f) => f.path === p && f.type === 'json')) {
      flatten(v, p, out);
    } else {
      out[p] = v;
    }
  }
  return out;
}

function diffPaths(a, b, prefix = '', out = []) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    const p = prefix ? `${prefix}.${k}` : k;
    const va = a?.[k]; const vb = b?.[k];
    const oa = va !== null && typeof va === 'object';
    const ob = vb !== null && typeof vb === 'object';
    if (oa && ob && !Array.isArray(va) && !Array.isArray(vb)) diffPaths(va, vb, p, out);
    else if (JSON.stringify(va) !== JSON.stringify(vb)) out.push(p);
  }
  return out;
}

function pick(cfg, p) {
  const out = {};
  setPath(out, p, getPath(cfg, p));
  return out;
}

/** schema 摘要，供设置页渲染 */
export function getSchemaForUI() {
  return {
    groups: CONFIG_GROUPS,
    fields: FIELD_SCHEMA.map((f) => ({
      ...f,
      value: getPath(current || DEFAULT_CONFIG, f.path),
    })),
  };
}

export { CONFIG_GROUPS, FIELD_SCHEMA, SENSITIVE_PATHS, RESTART_PATHS, CONFIG_FILE, DEFAULT_CONFIG };
