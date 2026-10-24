/**
 * 模块 A —— 实体库（选手 / 解说 / 队伍 / 赞助商）。
 *
 * 需求：
 *   A-REQ-301  实体须支持增删改查，存于 data/entities.json（可读可 diff）
 *   A-REQ-302  实体须支持**图片绑定**（指向媒体库资源）
 *   A-REQ-303  实体须支持**标签**，用于致谢列表批量选取（如"全部金牌赞助商"）
 *   A-REQ-304  选手实体须支持快速导入（CSV / 粘贴列表），适配多轮赛制
 *   A-REQ-305  实体变更须实时广播，控制端列表同步更新
 *   A-REQ-004  currentPlayer 的写入只允许来自控制端的显式操作，禁止自动推断
 *   G-REQ-109  currentPlayer 只能由模块 A 写入
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { getConfig, ROOT, withinRoot } from './config.js';
import { set, snapshotPlayer, getState } from './state.js';
import * as log from './logger.js';

export const entityEvents = new EventEmitter();

/** @type {Array<object>} */
let entities = [];
let filePath = null;
let watcher = null;
let suppressWatch = false;

const KINDS = ['player', 'talent', 'sponsor', 'team'];

function resolveFile() {
  // 测试 / 隔离：受信的环境变量优先（由启动进程设置，可指向项目外的临时文件）
  if (process.env.LP_ENTITIES_FILE) return path.resolve(process.env.LP_ENTITIES_FILE);
  const cfg = getConfig();
  const p = cfg.entities?.file || './data/entities.json';
  // 配置来源的路径强制落在项目目录内，防止实体库文件被指到程序之外读写
  return withinRoot(p) || path.join(ROOT, 'data', 'entities.json');
}

export function load() {
  filePath = resolveFile();
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = raw.trim() ? JSON.parse(raw) : [];
      entities = Array.isArray(parsed) ? parsed : (parsed.entities || []);
      log.info('entities', `实体库已加载`, { count: entities.length, file: filePath });
    } catch (e) {
      log.error('entities', '实体库解析失败，已重置为空', { err: e.message, file: filePath });
      backupBroken();
      entities = [];
    }
  } else {
    entities = [];
    save();
    log.info('entities', '实体库文件不存在，已创建空库', { file: filePath });
  }
  broadcast();
  startWatch();
  return entities;
}

function backupBroken() {
  try {
    const bak = `${filePath}.broken-${Date.now()}`;
    fs.copyFileSync(filePath, bak);
    log.warn('entities', '损坏的实体库已备份', { backup: bak });
  } catch { /* ignore */ }
}

export function save() {
  if (!filePath) filePath = resolveFile();
  const cfg = getConfig();
  if (cfg.entities?.autoBackup && fs.existsSync(filePath)) {
    try { fs.copyFileSync(filePath, `${filePath}.bak`); } catch { /* ignore */ }
  }
  suppressWatch = true;
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(entities, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
  setTimeout(() => { suppressWatch = false; }, 300).unref?.();
}

/** A-REQ-305：变更实时广播 */
function broadcast() {
  set('overlay.entities', entities.map(publicView));
  entityEvents.emit('change', entities);
}

function publicView(e) {
  return {
    id: e.id, kind: e.kind, name: e.name, image: e.image, tags: e.tags || [],
    team: e.team, teamId: e.teamId, side: e.side, handle: e.handle,
    role: e.role, twitch: e.twitch,
    tier: e.tier, url: e.url,
  };
}

// ─────────────────────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────────────────────

export function list(filter = {}) {
  let out = entities;
  if (filter.kind) out = out.filter((e) => e.kind === filter.kind);
  if (filter.tag) out = out.filter((e) => (e.tags || []).includes(filter.tag));
  if (filter.q) {
    const q = String(filter.q).toLowerCase();
    out = out.filter((e) => `${e.name} ${e.team || ''} ${e.handle || ''} ${(e.tags || []).join(' ')}`.toLowerCase().includes(q));
  }
  if (filter.ids) {
    const set0 = new Set(filter.ids);
    out = out.filter((e) => set0.has(e.id));
  }
  return out.map(publicView);
}

export function get(id) { return entities.find((e) => e.id === id) || null; }

export function create(input) {
  const errs = validate(input);
  if (Object.keys(errs).length) return { ok: false, errors: errs };

  const entity = {
    id: input.id || randomUUID(),
    kind: input.kind,
    name: String(input.name).trim(),
    image: input.image || undefined,
    tags: normalizeTags(input.tags),
    team: input.team || undefined,
    teamId: input.teamId || undefined,
    side: input.side === 'H' || input.side === 'A' ? input.side : undefined,
    handle: input.handle || undefined,
    role: input.role || undefined,
    twitch: input.twitch || undefined,
    tier: input.tier || undefined,
    url: input.url || undefined,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  if (entities.some((e) => e.id === entity.id)) return { ok: false, errors: { id: 'id 已存在' } };

  entities.push(entity);
  save();
  broadcast();
  log.audit('entities', 'create', { id: entity.id, kind: entity.kind, name: entity.name });
  return { ok: true, entity: publicView(entity) };
}

export function update(id, patch) {
  const i = entities.findIndex((e) => e.id === id);
  if (i === -1) return { ok: false, errors: { id: '实体不存在' } };
  const next = { ...entities[i], ...patch, id, updatedAt: Date.now() };
  if (next.tags) next.tags = normalizeTags(next.tags);
  // 显式传 null 表示移出队伍 —— 要真的删掉字段，而不是留一个 null
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'teamId') && (patch.teamId === null || patch.teamId === '')) {
    delete next.teamId;
  }
  const errs = validate(next);
  if (Object.keys(errs).length) return { ok: false, errors: errs };
  entities[i] = next;
  save();
  broadcast();
  log.audit('entities', 'update', { id, fields: Object.keys(patch) });
  return { ok: true, entity: publicView(next) };
}

export function remove(id) {
  const i = entities.findIndex((e) => e.id === id);
  if (i === -1) return { ok: false, errors: { id: '实体不存在' } };
  const [gone] = entities.splice(i, 1);
  save();
  broadcast();
  log.audit('entities', 'delete', { id, name: gone.name });
  return { ok: true };
}

/**
 * 删除实体，并处理引用关系。
 *
 * 目前只有一种引用：**选手 → 队伍**（player.teamId）。
 * 删除队伍时必须把成员解绑，否则选手会指向一个不存在的队伍，
 * 界面上显示为「有队伍但查不到」的幽灵状态。
 *
 * @returns {{ok:boolean, clearedMembers:number, entity:object}}
 */
export function removeWithRefs(id) {
  const target = entities.find((e) => e.id === id);
  if (!target) return { ok: false, errors: { id: '实体不存在' }, clearedMembers: 0 };

  let clearedMembers = 0;
  if (target.kind === 'team') {
    for (const e of entities) {
      if (e.teamId === id) {
        // 若选手同时还存着旧的自由文本队伍名，保留它作为兜底；否则彻底清掉
        delete e.teamId;
        e.updatedAt = Date.now();
        clearedMembers++;
      }
    }
  }

  const r = remove(id);
  if (r.ok && clearedMembers) {
    save();
    broadcast();
    log.audit('entities', 'teamMembersCleared', { teamId: id, teamName: target.name, clearedMembers });
  }
  return { ...r, clearedMembers, entity: target };
}

export function bulkRemove(ids) {
  const set0 = new Set(ids);
  const before = entities.length;
  entities = entities.filter((e) => !set0.has(e.id));
  save(); broadcast();
  log.audit('entities', 'bulkRemove', { requested: ids.length, removed: before - entities.length });
  return { ok: true, removed: before - entities.length };
}

/** A-REQ-304：CSV / 粘贴列表快速导入 */
export function importText(text, { kind = 'player', hasHeader = true, delimiter = null } = {}) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { ok: false, errors: { text: '没有可导入的内容' } };

  const delim = delimiter || (lines[0].includes('\t') ? '\t' : lines[0].includes(',') ? ',' : /\s{2,}/);
  const split = (l) => (delim instanceof RegExp ? l.split(delim) : l.split(delim)).map((s) => s.trim());

  let rows = lines.map(split);
  let header = null;
  if (hasHeader && rows.length) {
    const first = rows[0].map((h) => h.toLowerCase());
    if (first.some((h) => ['name', '名字', '姓名', '选手', 'id'].includes(h))) {
      header = rows[0];
      rows = rows.slice(1);
    }
  }

  const idx = (names, fallback) => {
    if (!header) return fallback;
    for (const n of names) {
      const i = header.findIndex((h) => h.toLowerCase() === n.toLowerCase());
      if (i !== -1) return i;
    }
    return fallback;
  };

  const iName = idx(['name', '名字', '姓名', '选手'], 0);
  const iHandle = idx(['handle', '游戏id', 'id', '昵称'], 1);
  const iTeam = idx(['team', '队伍', '战队'], 2);
  const iSide = idx(['side', '位置', '方位'], 3);
  const iTags = idx(['tags', '标签'], 4);
  const iImage = idx(['image', '头像', '图片'], 5);

  const created = [];
  const errors = [];
  for (const [n, row] of rows.entries()) {
    const name = (row[iName] || '').trim();
    if (!name) { errors.push({ line: n + 1, msg: '缺少名字' }); continue; }
    const rawSide = (row[iSide] || '').trim().toUpperCase();
    const r = create({
      kind,
      name,
      handle: row[iHandle] || undefined,
      team: row[iTeam] || undefined,
      side: rawSide === 'H' || rawSide === 'A' ? rawSide : undefined,
      tags: row[iTags] ? row[iTags].split(/[|;\/]/).map((s) => s.trim()).filter(Boolean) : undefined,
      image: row[iImage] || undefined,
    });
    if (r.ok) created.push(r.entity);
    else errors.push({ line: n + 1, msg: JSON.stringify(r.errors) });
  }

  log.audit('entities', 'importText', { kind, created: created.length, errors: errors.length });
  return { ok: true, created: created.length, entities: created, errors };
}

// ─────────────────────────────────────────────────────────────
// ★ currentPlayer —— 模块 A 唯一写入方（G-REQ-109 / A-REQ-004）
// ─────────────────────────────────────────────────────────────

/**
 * 显式设置当前玩家。**禁止自动推断** —— 只允许控制端的显式操作调用。
 * B-REQ-591 / A-REQ-306：生成**快照**，回放旧片段时浮窗显示当时的选手。
 */
export function setCurrent(id) {
  const e = get(id);
  if (!e) return { ok: false, errors: { id: '实体不存在' } };
  const snap = snapshotPlayer(e);
  set('overlay.playerSnapshot', snap);
  log.audit('overlay', 'setCurrentPlayer', { id, name: e.name, side: e.side });
  entityEvents.emit('current', snap);
  return { ok: true, player: snap };
}

export function clearCurrent() {
  set('overlay.playerSnapshot', null);
  log.audit('overlay', 'clearCurrentPlayer', {});
  return { ok: true };
}

export function getCurrent() {
  return getState().overlay.playerSnapshot || null;
}

// ─────────────────────────────────────────────────────────────
// 校验与工具
// ─────────────────────────────────────────────────────────────

function validate(input) {
  const errs = {};
  if (!input || typeof input !== 'object') return { __root__: '必须是对象' };
  if (!KINDS.includes(input.kind)) errs.kind = `kind 必须是 ${KINDS.join(' / ')} 之一`;
  if (!input.name || typeof input.name !== 'string' || !input.name.trim()) errs.name = '名字不能为空';
  if (input.name && input.name.length > 64) errs.name = '名字不能超过 64 字符';
  if (input.tags && !Array.isArray(input.tags) && typeof input.tags !== 'string') errs.tags = '标签必须是数组或逗号分隔字符串';

  // teamId 必须指向一个存在的队伍（null / 空字符串 = 移出队伍）
  if (input.teamId !== undefined && input.teamId !== null && input.teamId !== '') {
    if (typeof input.teamId !== 'string') errs.teamId = 'teamId 必须是字符串';
    else {
      const team = entities.find((x) => x.id === input.teamId);
      if (!team) errs.teamId = `队伍不存在：${input.teamId}`;
      else if (team.kind !== 'team') errs.teamId = `实体「${team.name}」不是队伍（kind=${team.kind}）`;
    }
  }
  return errs;
}

function normalizeTags(t) {
  if (!t) return [];
  const arr = Array.isArray(t) ? t : String(t).split(',');
  return [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))];
}

/** 队伍列表（按名称排序） */
export function teams() {
  return entities.filter((e) => e.kind === 'team')
    .map(publicView)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

/**
 * 解析某个实体所属的队伍。
 * 优先用 teamId 指向的队伍实体（有 Logo）；没有则回落到旧的自由文本 team 字段。
 * @returns {{id:string|null, name:string, image:string}|null}
 */
export function resolveTeam(entity) {
  if (!entity) return null;
  if (entity.teamId) {
    const t = entities.find((x) => x.id === entity.teamId);
    if (t && t.kind === 'team') return { id: t.id, name: t.name, image: t.image || '' };
  }
  if (entity.team) return { id: null, name: entity.team, image: '' };
  return null;
}

/** 全部标签（供致谢页按标签筛选，A-REQ-520） */
export function allTags() {
  const out = new Set();
  for (const e of entities) for (const t of e.tags || []) out.add(t);
  return [...out].sort();
}

/** 按层级排序（A-REQ-521：冠名→金牌→银牌→合作） */
const TIER_RANK = { 冠名: 0, 金牌: 1, 银牌: 2, 合作: 3 };

export function sponsorsByTier(tags = []) {
  return list({ kind: 'sponsor' })
    .filter((s) => tags.length === 0 || tags.some((t) => (s.tags || []).includes(t)))
    .sort((a, b) => (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9) || a.name.localeCompare(b.name, 'zh'));
}

/** 图片引用计数（A-REQ-408：删除媒体前提示被哪些实体引用） */
export function referencingImage(url) {
  if (!url) return [];
  return entities.filter((e) => e.image === url).map((e) => ({ id: e.id, name: e.name, kind: e.kind }));
}

// ─────────────────────────────────────────────────────────────
// 文件监视（手动编辑 entities.json 也能热更新）
// ─────────────────────────────────────────────────────────────

function startWatch() {
  stopWatch();
  try {
    watcher = fs.watch(filePath, { persistent: false }, () => {
      if (suppressWatch) return;
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        entities = Array.isArray(parsed) ? parsed : (parsed.entities || []);
        broadcast();
        log.info('entities', '实体库已热重载（检测到文件变更）', { count: entities.length });
      } catch (e) {
        log.warn('entities', '实体库热重载失败，保留内存中的旧数据', { err: e.message });
      }
    });
  } catch { /* 某些平台可能不支持 */ }
}

function stopWatch() { if (watcher) { try { watcher.close(); } catch { /* ignore */ } watcher = null; } }

export function stats() {
  const byKind = {};
  for (const e of entities) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  return { total: entities.length, byKind, tags: allTags().length, file: filePath };
}
