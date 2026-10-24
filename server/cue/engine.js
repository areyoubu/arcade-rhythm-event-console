/**
 * 模块 C —— 提示引擎。
 *
 * 需求：
 *   C-REQ-501  支持五种提示类型：countdown / alert / notice / persistent / ticker
 *   C-REQ-502  四级优先级 P0–P3，同一受众同一时刻最多 1 条 P0、1 条 P1、2 条 P2、若干 P3
 *   C-REQ-503  优先级仲裁：高优先级**不得被低优先级覆盖**；低优先级须排队或折叠
 *   C-REQ-504  ttlMs 到期自动 dismiss；null 表示须显式清除
 *   C-REQ-505  提示持久化到内存，客户端重连后全量下发当前活跃提示
 *   C-REQ-506  提示 ID 全局唯一，重复下发幂等（按 id 去重）
 *   C-REQ-507  publish() 通用接口，供模块 A/B 或外部系统发提示
 *   C-REQ-508  支持预设模板（附录 E），导播一键发送
 *   C-REQ-509  支持自由文本提示
 *   C-REQ-510  提示历史保留 ≥4 小时并可检索
 *   C-REQ-550 ~ 556  回执
 *   C-REQ-106  服务端按受众过滤，不得向 cast 推送 floor 的提示
 *   C-REQ-840  现场页仅接收 P0/P1，其余静默丢弃
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../config.js';
import { set } from '../state.js';
import * as log from '../logger.js';
import * as hub from '../ws-hub.js';

export const cueEvents = new EventEmitter();
cueEvents.setMaxListeners(50);

/** 优先级排序权重（数字越小越优先） */
const P_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };
/**
 * 各受众的优先级上限。现场页（floor）已随「改用 HDMI 输出」一并取消，
 * 目前没有受众需要限制；保留这个表是为了将来新增受众时能一行配置（C-REQ-001）。
 */
const AUDIENCE_MAX_PRIORITY = {};

/** @type {Map<string, Cue>} */
const cues = new Map();
/** 历史（≥4h） */
let history = [];
/** P0 未回执的重复提醒计数器 */
const ackReminders = new Map();
/** TTL 定时器 */
const ttlTimers = new Map();

/**
 * @typedef {object} Cue
 * @property {string} id
 * @property {'countdown'|'alert'|'notice'|'persistent'|'ticker'} kind
 * @property {'P0'|'P1'|'P2'|'P3'} priority
 * @property {string[]} audience
 * @property {string} title
 * @property {string} [body]
 * @property {'none'|'beep'|'triple'|'alarm'} sound
 * @property {string} state
 * @property {number} createdAt
 * @property {number|null} ttlMs
 * @property {boolean} dismissible
 * @property {boolean} requiresAck
 * @property {Record<string, number>} acks
 * @property {number} [ackRepeatMs]
 * @property {number} [atMonotonic]
 * @property {number} [leadMs]
 * @property {Array} [escalation]
 * @property {object} [onZero]
 * @property {string} source
 * @property {object|null} [playerSnapshot]
 */

// ─────────────────────────────────────────────────────────────
// 发布 / 取消
// ─────────────────────────────────────────────────────────────

/**
 * C-REQ-507 通用发布接口。
 * @param {Partial<Cue>} input
 * @returns {{cueId:string, cue:Cue}}
 */
export function publish(input = {}) {
  const cfg = getConfig();
  const id = input.id || randomUUID();

  // C-REQ-506：按 id 去重（幂等）
  if (cues.has(id)) {
    const cue = cues.get(id);
    log.debug('cue', '重复下发提示（幂等忽略）', { cueId: id });
    return { cueId: id, cue };
  }

  const priority = normalizePriority(input.priority);
  const audience = normalizeAudience(input.audience);

  // C-REQ-551：P0 强制 requiresAck
  const requiresAck = priority === 'P0' ? true : !!input.requiresAck;

  const ttl = input.ttlMs !== undefined
    ? input.ttlMs
    : (cfg.cue.defaultTtlMs?.[priority] ?? null);

  const cue = {
    id,
    kind: input.kind || 'notice',
    priority,
    audience,
    title: String(input.title ?? ''),
    body: input.body,
    sound: input.sound || 'none',
    state: input.atMonotonic && input.atMonotonic > monotonicNow() ? 'pending' : 'active',
    createdAt: Date.now(),
    ttlMs: ttl === undefined ? null : ttl,
    dismissible: input.dismissible !== false,
    requiresAck,
    acks: {},
    ackRepeatMs: input.ackRepeatMs ?? cfg.cue.ack.repeatMs,
    atMonotonic: input.atMonotonic,
    leadMs: input.leadMs,
    escalation: input.escalation,
    onZero: input.onZero,
    source: input.source || 'manual',
    playerSnapshot: input.playerSnapshot || null,
    /**
     * 内部分组标签 —— 用于成批清除同一逻辑链条上的提示。
     * 倒计时用它清理自己产生的全部升级提示（`countdown:<id>`），
     * 模块 B 协作用它清理「回放中」常驻提示（`replay-persistent`）。
     */
    tag: input.tag || null,
    broadcastAt: 0,
  };

  cues.set(id, cue);
  log.info('cue', `发布提示：${cue.title}`, {
    cueId: id, kind: cue.kind, priority, audience: audience.join(','), sound: cue.sound, source: cue.source, requiresAck,
  });

  if (cue.state !== 'pending') scheduleTtl(cue);
  syncState();
  broadcastSets();
  cueEvents.emit('publish', cue);
  if (cue.state === 'active' && cue.sound && cue.sound !== 'none') sendSound(cue);
  if (cue.requiresAck) startAckReminders(cue);

  return { cueId: id, cue };
}

export function cancel(cueId, reason = 'cancelled') {
  const cue = cues.get(cueId);
  if (!cue) return { ok: false, nack: { code: 'not_found', msg: `提示不存在：${cueId}` } };
  removeCue(cue, reason);
  return { ok: true };
}

/** 导播强制清除（C-REQ-556：可无视未 ack 直接清除） */
export function forceClear(cueId) { return cancel(cueId, 'dismissed'); }

export function clearAll(reason = 'dismissed') {
  for (const cue of [...cues.values()]) removeCue(cue, reason);
  return { ok: true };
}

/** C-REQ-592/595：按来源批量清（模块 B 联动用） */
export function clearBySource(source, reason = 'dismissed') {
  let n = 0;
  for (const cue of [...cues.values()]) if (cue.source === source) { removeCue(cue, reason); n++; }
  return n;
}

export function clearByTag(tag, reason = 'dismissed') {
  let n = 0;
  for (const cue of [...cues.values()]) if (cue.tag === tag) { removeCue(cue, reason); n++; }
  return n;
}

function removeCue(cue, reason) {
  cue.state = reason;
  cue.removedAt = Date.now();
  cues.delete(cue.id);
  clearTimeout(ttlTimers.get(cue.id));
  ttlTimers.delete(cue.id);
  stopAckReminders(cue.id);
  pushHistory(cue);
  log.info('cue', `提示移除：${cue.title}`, { cueId: cue.id, reason, priority: cue.priority });
  hub.toAudience(cue.audience, { t: 'cue:remove', cueId: cue.id, reason });
  syncState();
  broadcastSets();
  cueEvents.emit('remove', cue, reason);
}

// ─────────────────────────────────────────────────────────────
// 生命周期
// ─────────────────────────────────────────────────────────────

/** C-REQ-504：TTL 到期自动 dismiss */
function scheduleTtl(cue) {
  if (cue.ttlMs === null || cue.ttlMs === undefined) return;   // null = 须显式清除
  const delay = Math.max(0, cue.ttlMs);
  const t = setTimeout(() => expire(cue.id), delay);
  t.unref?.();
  ttlTimers.set(cue.id, t);
}

function expire(cueId) {
  const cue = cues.get(cueId);
  if (!cue) return;
  removeCue(cue, 'expired');
}

/** 把 pending 提升为 active（倒计时到点由 countdown.js 调用） */
export function activate(cueId) {
  const cue = cues.get(cueId);
  if (!cue) return null;
  cue.state = 'active';
  scheduleTtl(cue);
  syncState();
  broadcastSets();
  if (cue.sound && cue.sound !== 'none') sendSound(cue);
  if (cue.requiresAck) startAckReminders(cue);
  return cue;
}

export function fire(cueId) {
  const cue = cues.get(cueId);
  if (!cue) return null;
  cue.state = 'fired';
  log.info('cue', `提示归零触发：${cue.title}`, { cueId, priority: cue.priority });
  cueEvents.emit('fired', cue);
  return cue;
}

// ─────────────────────────────────────────────────────────────
// 回执 C-REQ-550 ~ 556
// ─────────────────────────────────────────────────────────────

export function ack(cueId, clientId) {
  const cue = cues.get(cueId);
  if (!cue) return { ok: false, nack: { code: 'not_found', msg: '提示不存在或已清除' } };
  cue.acks[clientId] = Date.now();            // C-REQ-554 记录时间戳
  log.debug('cue', '收到回执', { cueId, clientId: String(clientId).slice(0, 8) });
  if (allAudiencesAcked(cue)) stopAckReminders(cue.id);
  syncState();
  broadcastSets();
  hub.toAudience(['director'], { t: 'cue:ack', cueId, clientId, at: cue.acks[clientId] });
  cueEvents.emit('ack', cue, clientId);
  return { ok: true, acks: cue.acks };
}

/** 该受众下所有已连接客户端都 ack 了吗 */
function allAudiencesAcked(cue) {
  let total = 0;
  let acked = 0;
  for (const a of cue.audience) {
    const clients = hub.getClients().filter((c) => c.audience === a);
    for (const c of clients) { total++; if (cue.acks[c.id]) acked++; }
  }
  return total > 0 && acked >= total;
}

function startAckReminders(cue) {
  if (!cue.ackRepeatMs) return;
  const max = getConfig().cue.ack.maxRepeats;
  ackReminders.set(cue.id, { count: 0, max, timer: null });
  const tick = () => {
    const rec = ackReminders.get(cue.id);
    if (!rec) return;
    if (!cues.has(cue.id)) { stopAckReminders(cue.id); return; }
    if (allAudiencesAcked(cue)) { stopAckReminders(cue.id); return; }
    if (rec.count >= rec.max) {
      // C-REQ-553：上限 6 次后停止并升级为导播页告警
      log.warn('cue', `P0 提示未回执达 ${rec.max} 次上限，升级为导播页告警`, { cueId: cue.id, unacked: unackedList(cue) });
      hub.toAudience(['director'], {
        t: 'cue:alert',
        cueId: cue.id,
        msg: `「${cue.title}」未获回执（已重复 ${rec.max} 次）`,
        unacked: unackedList(cue),
      });
      notifyAlert(`未获回执：${cue.title}`, unackedList(cue));
      stopAckReminders(cue.id);
      return;
    }
    rec.count++;
    sendSound(cue);
    log.debug('cue', `未回执重复提醒（${rec.count}/${rec.max}）`, { cueId: cue.id });
    rec.timer = setTimeout(tick, cue.ackRepeatMs);
    rec.timer.unref?.();
  };
  const rec = ackReminders.get(cue.id);
  rec.timer = setTimeout(tick, cue.ackRepeatMs);
  rec.timer.unref?.();
}

function stopAckReminders(cueId) {
  const rec = ackReminders.get(cueId);
  if (!rec) return;
  clearTimeout(rec.timer);
  ackReminders.delete(cueId);
}

export function unackedList(cue) {
  const out = [];
  for (const a of cue.audience) {
    for (const c of hub.getClients().filter((x) => x.audience === a)) {
      if (!cue.acks[c.id]) out.push({ audience: a, clientId: c.id, audioUnlocked: c.audioUnlocked });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 仲裁与广播
// ─────────────────────────────────────────────────────────────

/**
 * C-REQ-502/503：按受众计算可见提示集合。
 * 高优先级先占位；同优先级按创建时间**新者优先**；超出配额的低优先级被折叠（仍在 active，
 * 只是不进入可见集），一旦高优先级被清除就会自动浮上来。
 */
export function visibleFor(audience) {
  const cfg = getConfig();
  const maxVisible = cfg.cue.maxVisible || { P0: 1, P1: 1, P2: 2, P3: 5 };
  const cap = AUDIENCE_MAX_PRIORITY[audience];

  const mine = [...cues.values()]
    .filter((c) => c.state === 'active' || c.state === 'running' || c.state === 'held' || c.state === 'fired')
    .filter((c) => c.audience.includes(audience))
    .filter((c) => !cap || P_RANK[c.priority] <= P_RANK[cap]);   // C-REQ-840：floor 只收 P0/P1

  const sorted = mine.sort((a, b) => (P_RANK[a.priority] - P_RANK[b.priority]) || (b.createdAt - a.createdAt));

  const used = { P0: 0, P1: 0, P2: 0, P3: 0 };
  const out = [];
  for (const c of sorted) {
    const limit = maxVisible[c.priority] ?? 1;
    if (used[c.priority] >= limit) continue;
    used[c.priority]++;
    out.push(c);
  }
  return out;
}

function broadcastSets() {
  const audiences = getConfig().cue.channels || ['director', 'cast', 'floor'];
  for (const a of audiences) {
    hub.toAudience([a], { t: 'cue:set', audience: a, cues: visibleFor(a).map(serialize) });
  }
}

function syncState() {
  const active = {};
  for (const [id, c] of cues) active[id] = serialize(c);
  set('cue.active', active);
  set('cue.pendingCount', [...cues.values()].filter((c) => c.state === 'pending').length);
}

function serialize(c) {
  return {
    id: c.id, kind: c.kind, priority: c.priority, audience: c.audience,
    title: c.title, body: c.body, sound: c.sound, state: c.state,
    createdAt: c.createdAt, ttlMs: c.ttlMs, dismissible: c.dismissible,
    requiresAck: c.requiresAck, acks: c.acks, source: c.source,
    playerSnapshot: c.playerSnapshot, leadMs: c.leadMs, tag: c.tag,
  };
}

/** C-REQ-553 之外的独立声音下发（客户端只负责发音） */
export function sendSound(cue) {
  if (!getConfig().cue.sound.enabled) return;
  hub.toAudience(cue.audience, { t: 'cue:sound', cueId: cue.id, sound: cue.sound, priority: cue.priority });
}

/** 直接给某受众播一次声音（不产生提示） */
export function soundTo(audience, sound = 'beep') {
  hub.toAudience(audience, { t: 'cue:sound', cueId: `snd-${Date.now()}`, sound, priority: 'P1' });
}

// ─────────────────────────────────────────────────────────────
// 历史 C-REQ-510
// ─────────────────────────────────────────────────────────────

function pushHistory(cue) {
  history.push({ ...serialize(cue), removedAt: cue.removedAt || Date.now() });
  pruneHistory();
}

function pruneHistory() {
  const retainMs = (getConfig().cue.history.retainHours || 4) * 3600_000;
  const cutoff = Date.now() - retainMs;
  if (history.length && history[0].createdAt < cutoff) history = history.filter((h) => h.createdAt >= cutoff);
}

/** 检索（AC-C25：按时间/受众/优先级） */
export function queryHistory({ from, to, audience, priority, limit = 200, source } = {}) {
  pruneHistory();
  let out = history;
  if (from) out = out.filter((h) => h.createdAt >= from);
  if (to) out = out.filter((h) => h.createdAt <= to);
  if (audience) out = out.filter((h) => h.audience.includes(audience));
  if (priority) out = out.filter((h) => h.priority === priority);
  if (source) out = out.filter((h) => h.source === source);
  return out.slice(-limit).reverse();
}

// ─────────────────────────────────────────────────────────────
// 告警（导播页红色横幅）C-REQ-544 / 553
// ─────────────────────────────────────────────────────────────

export function notifyAlert(msg, extra = null) {
  const alert = { at: Date.now(), msg, extra };
  set('cue.alert', alert);
  hub.toAudience(['director'], { t: 'cue:alert', ...alert });
  cueEvents.emit('alert', alert);
  return alert;
}

export function clearAlert() { set('cue.alert', null); }

// ─────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────

function normalizePriority(p) {
  const s = String(p || 'P2').toUpperCase();
  return P_RANK[s] !== undefined ? s : 'P2';
}

function normalizeAudience(a) {
  const cfg = getConfig();
  const all = cfg.cue.channels || ['director', 'cast', 'floor'];
  if (!a) return [...all];
  const list = (Array.isArray(a) ? a : [a]).map(String);
  const unknown = list.filter((x) => !all.includes(x));
  if (unknown.length) log.warn('cue', '提示包含未登记的受众频道（已保留，C-REQ-001 允许扩展）', { unknown, registered: all });
  return list;
}

/** 单调时钟（C-REQ-520：不受客户端时间/时区影响） */
export function monotonicNow() { return Number(process.hrtime.bigint() / 1000n) / 1000; }

export function getActive() { return [...cues.values()]; }
export function getCue(id) { return cues.get(id); }

/** 客户端重连时补发（C-REQ-505 / S-REQ-101 的 hello 已含 cue.active，这里作为事件同步兜底） */
export function sendAllTo(client) {
  if (!client.audience) return;
  hub.send(client, { t: 'cue:set', audience: client.audience, cues: visibleFor(client.audience).map(serialize) });
}

/** 附录 E：内置话术模板库（C-REQ-508 / 1101 / 1102） */
export const BUILTIN_CUE_TEMPLATES = [
  { id: 'T1',  name: '解说倒计时',      template: '解说 T-{n}s',              audience: ['cast'],             priority: '渐变', sound: '渐变', requiresAck: false },
  { id: 'T2',  name: '回放倒计时',      template: '回放 T-{n}s',              audience: ['cast', 'director'], priority: '渐变', sound: '渐变', requiresAck: false },
  { id: 'T3',  name: '回放中',          template: '回放中 · 剩余 {n}s',       audience: ['cast', 'director'], priority: 'P3',  sound: 'none',  requiresAck: false },
  { id: 'T4',  name: '回放将结束',      template: '回放 {n}s 结束，准备接话',  audience: ['cast'],             priority: 'P1',  sound: 'beep',  requiresAck: false },
  { id: 'T5',  name: '回放结束',        template: '回放结束，可回直播',        audience: ['director'],         priority: 'P2',  sound: 'none',  requiresAck: false },
  { id: 'T6',  name: '已回直播',        template: '已回直播',                 audience: ['cast', 'floor'],    priority: 'P2',  sound: 'none',  requiresAck: false },
  { id: 'T7',  name: '即将上镜',        template: '{n} 秒后上镜',             audience: ['floor'],            priority: '渐变', sound: 'triple', requiresAck: false },
  { id: 'T8',  name: '上镜',            template: '3 · 2 · 1 上镜！',         audience: ['floor'],            priority: 'P0',  sound: 'alarm', requiresAck: true },
  { id: 'T9',  name: '技术暂停',        template: '技术暂停',                 audience: ['director', 'cast', 'floor'], priority: 'P1', sound: 'beep', requiresAck: false },
  { id: 'T10', name: '即将进入场景',    template: '即将进入 {场景名}',         audience: ['director'],         priority: 'P3',  sound: 'none',  requiresAck: false },
  { id: 'T11', name: '游戏音轨已静音',  template: '游戏音轨已静音',            audience: ['director'],         priority: 'P3',  sound: 'none',  requiresAck: false },
  { id: 'T12', name: '回放失败',        template: '回放失败：{原因}',          audience: ['director'],         priority: 'P0',  sound: 'alarm', requiresAck: true },
  { id: 'T13', name: '选手准备上场',    template: '{选手名} 准备上场',         audience: ['floor'],            priority: 'P1',  sound: 'beep',  requiresAck: true },
  { id: 'T14', name: '比赛进行中',      template: '比赛进行中 · 第 {n} 局',    audience: ['cast'],             priority: 'P3',  sound: 'none',  requiresAck: false },
];

export function cueTemplates() {
  const custom = getConfig().cue.templates || {};
  const customList = Object.entries(custom).map(([id, t]) => ({ id, ...t, custom: true }));
  return [...BUILTIN_CUE_TEMPLATES, ...customList];
}

/** C-REQ-1101：变量插值 {n} / {选手名} / {场景名} */
export function interpolate(tpl, vars = {}) {
  return String(tpl).replace(/\{([^}]+)\}/g, (m, k) => {
    const key = k.trim();
    return vars[key] !== undefined ? String(vars[key]) : m;
  });
}
