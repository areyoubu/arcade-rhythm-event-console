/**
 * 模块 C —— 倒计时与渐进升级。
 *
 * 需求：
 *   C-REQ-520  倒计时计时器为**服务端权威**，基于**单调时钟**，不受客户端时间/时区影响
 *   C-REQ-521  支持提前量预设：T-60/30/15/10/5/3 秒（可配置）
 *   C-REQ-522  支持渐进升级：同一倒计时在多个时间点以递增优先级重复提示
 *   C-REQ-523  支持 hold() / resume()：暂停倒计时
 *   C-REQ-524  支持 extend(Δ)：目标时刻后移
 *   C-REQ-525  支持 cancel()：取消倒计时，不留残余提示
 *   C-REQ-526  广播 tick 粒度自适应：>60s 走 1s；≤10s 走 100ms。**不得**全程 100ms 广播
 *   C-REQ-527  倒计时显示误差 ≤ 100ms（以服务端时刻为准）
 *   C-REQ-528  客户端须做本地插值（tick 携带 serverAt）
 *   C-REQ-529  归零时按 onZero 执行：target='B' 时调用模块 B 的 execute(intent)
 *   C-REQ-530  ★ autoExecute 默认 false（半自动）：到点仅提示「现在切！」，须人工确认
 *   C-REQ-531  autoExecute=true 属高危配置
 *   G-REQ-107  所有倒计时以真实播出时刻为基准（服务端单调时钟），禁止以客户端画面为基准
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../config.js';
import { set } from '../state.js';
import * as log from '../logger.js';
import * as hub from '../ws-hub.js';
import * as cueEngine from './engine.js';

export const countdownEvents = new EventEmitter();

/** 单调时钟（毫秒，浮点）。process.hrtime.bigint() 不受系统时间调整影响。 */
const mono = () => Number(process.hrtime.bigint() / 1000n) / 1000;

/**
 * @typedef {object} Countdown
 * @property {string} id
 * @property {string} title
 * @property {string} kind            'replay' | 'backToLive' | 'generic'
 * @property {'running'|'held'|'fired'|'cancelled'} state
 * @property {number} createdAt
 * @property {number} targetMono      绝对单调目标时刻
 * @property {number} heldAt          暂停时的剩余量（ms）
 * @property {number} leadMs          初始提前量
 * @property {number} extendMs        累计延长
 * @property {string[]} audience
 * @property {Array} escalation
 * @property {Set<number>} firedSteps 已触发的升级档位
 * @property {object|null} onZero
 * @property {boolean} autoExecute
 * @property {boolean} dryRun
 * @property {number} cueId           主提示 cue 的 id
 */

/** @type {Map<string, Countdown>} */
const timers = new Map();
let tickTimer = null;

// ─────────────────────────────────────────────────────────────
// 创建
// ─────────────────────────────────────────────────────────────

/**
 * @param {{
 *   leadMs:number, title?:string, kind?:string, audience?:string[],
 *   escalation?:Array, onZero?:object, autoExecute?:boolean, dryRun?:boolean,
 *   playerSnapshot?:object, body?:string
 * }} opts
 */
export function schedule(opts = {}) {
  const cfg = getConfig();
  const leadMs = Number(opts.leadMs ?? cfg.countdown.defaultLeadMs);
  if (!Number.isFinite(leadMs) || leadMs <= 0) {
    return { ok: false, nack: { code: 'bad_lead', msg: `提前量无效：${opts.leadMs}` } };
  }

  // C-REQ-531：autoExecute 是高危配置，须显式开启总开关
  const autoExecute = !!opts.autoExecute;
  if (autoExecute && !cfg.countdown.allowAutoExecute) {
    return { ok: false, nack: { code: 'auto_execute_disabled', msg: '自动执行已被总开关禁用（countdown.allowAutoExecute=false）。请在设置页显式开启后再试。' } };
  }

  const id = randomUUID();
  const now = mono();
  const escalation = (opts.escalation || cfg.countdown.escalation || []).slice()
    .map((e) => ({ ...e, priority: String(e.priority || 'P3').toUpperCase() }))
    .filter((e) => Number.isFinite(e.atMs))
    .sort((a, b) => b.atMs - a.atMs);

  const cd = {
    id,
    title: opts.title || '倒计时',
    kind: opts.kind || 'generic',
    state: 'running',
    createdAt: Date.now(),
    startedMono: now,
    targetMono: now + leadMs,
    heldRemainingMs: null,
    leadMs,
    extendMs: 0,
    audience: opts.audience || ['director'],
    escalation,
    firedSteps: new Set(),
    onZero: opts.onZero || null,
    autoExecute,
    dryRun: !!opts.dryRun,
    playerSnapshot: opts.playerSnapshot || null,
    body: opts.body,
    cueId: null,
  };

  timers.set(id, cd);

  // 主提示 cue —— 提供「倒计时卡片」的载体
  const { cueId } = cueEngine.publish({
    kind: 'countdown',
    priority: 'P3',
    audience: cd.audience,
    title: cd.title,
    body: cd.body,
    sound: 'none',
    ttlMs: null,
    dismissible: true,
    requiresAck: false,
    source: 'scheduler',
    playerSnapshot: cd.playerSnapshot,
    leadMs,
  });
  cd.cueId = cueId;

  log.info('countdown', `启动倒计时：${cd.title}`, {
    countdownId: id, leadMs, audience: cd.audience.join(','), autoExecute, dryRun: cd.dryRun,
    escalation: escalation.map((e) => `T-${e.atMs / 1000}s→${e.priority}`).join(' '),
  });

  ensureTicker();
  broadcastTick(cd);
  countdownEvents.emit('start', cd);
  syncState();
  return { ok: true, cueId, countdownId: id, leadMs };
}

export function cancelAll() {
  for (const id of [...timers.keys()]) cancel(id);
}

// ─────────────────────────────────────────────────────────────
// 控制 C-REQ-523 / 524 / 525
// ─────────────────────────────────────────────────────────────

export function hold(id) {
  const cd = timers.get(id);
  if (!cd) return { ok: false, nack: { code: 'not_found', msg: '倒计时不存在' } };
  if (cd.state !== 'running') return { ok: false, nack: { code: 'bad_state', msg: `当前状态 ${cd.state}，无法暂停` } };
  cd.heldRemainingMs = Math.max(0, cd.targetMono - mono());
  cd.state = 'held';
  log.info('countdown', `暂停倒计时：${cd.title}`, { countdownId: id, remainingMs: Math.round(cd.heldRemainingMs) });
  broadcastTick(cd);
  syncState();
  return { ok: true, remainingMs: cd.heldRemainingMs };
}

export function resume(id) {
  const cd = timers.get(id);
  if (!cd) return { ok: false, nack: { code: 'not_found', msg: '倒计时不存在' } };
  if (cd.state !== 'held') return { ok: false, nack: { code: 'bad_state', msg: `当前状态 ${cd.state}，无法恢复` } };
  cd.targetMono = mono() + (cd.heldRemainingMs || 0);
  cd.heldRemainingMs = null;
  cd.state = 'running';
  log.info('countdown', `恢复倒计时：${cd.title}`, { countdownId: id });
  broadcastTick(cd);
  syncState();
  return { ok: true };
}

/** C-REQ-524：目标时刻后移 */
export function extend(id, deltaMs) {
  const cd = timers.get(id);
  if (!cd) return { ok: false, nack: { code: 'not_found', msg: '倒计时不存在' } };
  const d = Number(deltaMs);
  if (!Number.isFinite(d) || d === 0) return { ok: false, nack: { code: 'bad_delta', msg: `延长时间无效：${deltaMs}` } };

  if (cd.state === 'held') cd.heldRemainingMs = Math.max(0, (cd.heldRemainingMs || 0) + d);
  else cd.targetMono += d;
  cd.extendMs += d;

  // 目标后移后，已触发过的升级档位需要重新武装（否则延长后不会再提醒）
  if (d > 0) {
    const remain = remaining(cd);
    for (const step of cd.escalation) if (step.atMs > remain) cd.firedSteps.delete(step.atMs);
  }

  log.audit('countdown', 'extend', { countdownId: id, deltaMs: d, totalExtendMs: cd.extendMs });
  broadcastTick(cd);
  syncState();
  return { ok: true, targetAt: serverNow() + remaining(cd) };
}

/** C-REQ-525：取消倒计时，不留残余提示 */
export function cancel(id) {
  const cd = timers.get(id);
  if (!cd) return { ok: false, nack: { code: 'not_found', msg: '倒计时不存在' } };
  cd.state = 'cancelled';
  timers.delete(id);
  if (cd.cueId) cueEngine.cancel(cd.cueId, 'cancelled');
  log.info('countdown', `取消倒计时：${cd.title}`, { countdownId: id });
  hub.toAudience(cd.audience, { t: 'countdown:cancel', countdownId: id });
  countdownEvents.emit('cancel', cd);
  syncState();
  return { ok: true };
}

export function get(id) { return timers.get(id) || null; }
export function list() { return [...timers.values()]; }

// ─────────────────────────────────────────────────────────────
// tick 循环 C-REQ-526
// ─────────────────────────────────────────────────────────────

function ensureTicker() {
  if (tickTimer) return;
  tickTimer = setInterval(onTick, 50);   // 内部 50ms 心跳，按需决定是否广播
  tickTimer.unref?.();
}

function stopTickerIfIdle() {
  if (timers.size === 0 && tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

let lastBroadcastAt = 0;

function onTick() {
  if (timers.size === 0) { stopTickerIfIdle(); return; }
  const now = mono();

  for (const cd of [...timers.values()]) {
    if (cd.state === 'held') continue;

    const remain = cd.targetMono - now;

    // C-REQ-522：渐进升级 —— 跨过某档位就发一条递增优先级的提示
    for (const step of cd.escalation) {
      if (cd.firedSteps.has(step.atMs)) continue;
      if (remain <= step.atMs) {
        cd.firedSteps.add(step.atMs);
        fireEscalation(cd, step, remain);
      }
    }

    if (remain <= 0) {
      onZeroReached(cd);
    }
  }

  // 自适应广播粒度（C-REQ-526）
  const granularity = pickGranularity();
  if (now - lastBroadcastAt >= granularity) {
    lastBroadcastAt = now;
    for (const cd of timers.values()) broadcastTick(cd, granularity);
  }
}

/**
 * C-REQ-526：剩余 >60s → 1s 粒度；≤10s → 100ms 粒度；中间 250ms。
 * **不得**全程 100ms 广播。
 */
function pickGranularity() {
  if (!getConfig().countdown.tickAdaptive) return 100;
  let minRemain = Infinity;
  for (const cd of timers.values()) {
    if (cd.state !== 'running') continue;
    minRemain = Math.min(minRemain, Math.max(0, cd.targetMono - mono()));
  }
  if (!Number.isFinite(minRemain)) return 1000;
  if (minRemain > 60000) return 1000;
  if (minRemain > 10000) return 250;
  return 100;
}

function fireEscalation(cd, step, remain) {
  const secs = Math.max(0, Math.ceil(remain / 1000));
  const title = cueEngine.interpolate(
    cd.body || guessTitle(cd, secs),
    { n: secs, 选手名: cd.playerSnapshot?.playerName || '', 场景名: '' },
  );

  log.info('countdown', `渐进升级：T-${step.atMs / 1000}s → ${step.priority}`, {
    countdownId: cd.id, priority: step.priority, sound: step.sound, remainMs: Math.round(remain),
  });

  const { cueId } = cueEngine.publish({
    kind: 'countdown',
    priority: step.priority,
    audience: cd.audience,
    title,
    body: cd.title,
    sound: step.sound || 'none',
    ttlMs: null,               // 由 cancel/归零统一清理
    dismissible: true,
    requiresAck: step.priority === 'P0' && (getConfig().cue.ack.required || []).includes('P0'),
    source: 'scheduler',
    playerSnapshot: cd.playerSnapshot,
    tag: `countdown:${cd.id}`,
    leadMs: step.atMs,
  });
  countdownEvents.emit('escalation', { countdown: cd, step, cueId, remainMs: remain });
}

function guessTitle(cd, secs) {
  if (cd.kind === 'replay') return `回放 T-${secs}s`;
  if (cd.kind === 'backToLive') return `回直播 T-${secs}s`;
  return `${cd.title} T-${secs}s`;
}

/**
 * C-REQ-529 / 530：归零。
 * autoExecute=false（默认）时**只提示「现在切！」**，须人工确认；
 * autoExecute=true 时直接调用模块 B 的 execute(intent)。
 */
function onZeroReached(cd) {
  cd.state = 'fired';
  timers.delete(cd.id);

  const cfg = getConfig();
  log.info('countdown', `倒计时归零：${cd.title}`, {
    countdownId: cd.id, kind: cd.kind, autoExecute: cd.autoExecute, dryRun: cd.dryRun, target: cd.onZero?.target || 'local',
  });

  // 清除这条倒计时的全部升级提示（它们已完成使命）
  cueEngine.clearByTag(`countdown:${cd.id}`);
  if (cd.cueId) cueEngine.cancel(cd.cueId, 'fired');

  const shouldAuto = cd.autoExecute && cfg.orchestration.enable;
  const cueTitle = shouldAuto
    ? `正在执行：${cd.title}`
    : (cd.onZero?.target === 'B' ? '现在切！' : `${cd.title} 到点`);

  cueEngine.publish({
    kind: 'alert',
    priority: 'P0',
    audience: ['director'],
    title: cueTitle,
    body: cd.dryRun ? '（预演模式：不会调用模块 B）' : undefined,
    sound: 'triple',
    ttlMs: shouldAuto ? 6000 : null,
    requiresAck: !shouldAuto,
    source: 'scheduler',
    tag: `countdown-zero:${cd.id}`,
    playerSnapshot: cd.playerSnapshot,
  });

  countdownEvents.emit('zero', cd);

  if (cd.onZero?.target === 'B') {
    // 半自动：交由导播在页面上点确认（execute 由 WS 命令触发）
    if (shouldAuto) {
      countdownEvents.emit('execute', cd);
    } else {
      log.info('countdown', '半自动模式：已提示「现在切！」，等待人工确认', { countdownId: cd.id, intent: cd.onZero.intent });
    }
  }

  hub.toAudience(cd.audience, { t: 'countdown:zero', countdownId: cd.id, title: cd.title, autoExecute: shouldAuto });
  syncState();
  stopTickerIfIdle();
}

// ─────────────────────────────────────────────────────────────
// 广播
// ─────────────────────────────────────────────────────────────

function remaining(cd) {
  if (cd.state === 'held') return cd.heldRemainingMs || 0;
  return Math.max(0, cd.targetMono - mono());
}

/**
 * C-REQ-107：tick 携带 serverAt，客户端据此校正本地显示并做**本地插值**（C-REQ-528）。
 */
function broadcastTick(cd, granularity = null) {
  const remainMs = remaining(cd);
  const msg = {
    t: 'cue:tick',
    cueId: cd.cueId,
    countdownId: cd.id,
    remainingMs: Math.round(remainMs),
    serverAt: serverNow(),
    state: cd.state,
    /** 下一次 tick 的预期间隔，客户端据此插值（避免网络抖动导致跳秒） */
    tickMs: granularity ?? pickGranularity(),
    title: cd.title,
    targetAt: serverNow() + remainMs,
  };
  hub.toAudience(cd.audience, msg);
  countdownEvents.emit('tick', cd, remainMs);
}

/** 服务端墙钟（仅用于跨端对齐显示基准，计时本身一律用单调时钟） */
export function serverNow() { return Date.now(); }

function syncState() {
  const active = list();
  set('countdown.active', active.length ? {
    id: active[0].id,
    title: active[0].title,
    kind: active[0].kind,
    state: active[0].state,
    remainingMs: Math.round(remaining(active[0])),
    targetAt: serverNow() + remaining(active[0]),
    autoExecute: active[0].autoExecute,
    dryRun: active[0].dryRun,
    audience: active[0].audience,
    playerSnapshot: active[0].playerSnapshot,
  } : null);
  set('countdown.queue', active.map((cd) => ({
    id: cd.id, title: cd.title, kind: cd.kind, state: cd.state,
    remainingMs: Math.round(remaining(cd)), autoExecute: cd.autoExecute,
  })));
}

/** 供外部（WS 命令 / 测试）读取当前剩余 */
export function remainingOf(id) {
  const cd = timers.get(id);
  return cd ? Math.round(remaining(cd)) : null;
}

/** 测试用：把时钟快进（仅影响指定倒计时的目标时刻） */
export function fastForward(id, ms) {
  const cd = timers.get(id);
  if (!cd) return { ok: false, nack: { code: 'not_found', msg: '倒计时不存在' } };
  cd.targetMono -= ms;
  return { ok: true };
}
