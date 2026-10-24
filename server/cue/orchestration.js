/**
 * 模块 C —— 编排（与模块 B 的协同）+ B/OBS 事件联动。
 *
 * 需求：
 *   C-REQ-540  scheduleReplay({leadMs, autoExecute, preflight})
 *   C-REQ-541  scheduleBackToLive({leadMs, autoExecute})
 *   C-REQ-542  ★ 编排启动时**必须**调用 B 的 preflight()，结果 !ok 时**立即**告警且**不启动**倒计时
 *              （避免无效等待 15s 才发现执行不了 —— AC-C02）
 *   C-REQ-543  编排期间订阅 B 的事件流，实时更新倒计时卡片旁的状态
 *   C-REQ-544  编排失败时在导播页**红色告警**并提示手动补救步骤
 *   C-REQ-545  编排与手动触发不得冲突：B 非 ARMED 时 scheduleReplay 须拒绝并说明原因
 *   C-REQ-546  「预演模式」：走完流程但不调用 B 的写接口
 *   C-REQ-547  编排须支持「一次性」与「重复」两种模式
 *   C-REQ-548  导播页须显示当前所有待执行的编排队列及其剩余时间
 *   C-REQ-590 ~ 597  与 A / B 的协同
 *   C-REQ-582/583  转场大提醒：订阅 OBS 事件自动触发 + 意图对账
 *   G-REQ-112  任一模块崩溃不得影响其余模块（这里对 B 的调用全部包 try/catch）
 */
import { EventEmitter } from 'node:events';
import { getConfig } from '../config.js';
import { set, getState, getCurrentPlayer, snapshotPlayer } from '../state.js';
import * as log from '../logger.js';
import * as hub from '../ws-hub.js';
import * as cue from './engine.js';
import * as countdown from './countdown.js';

export const orchestrationEvents = new EventEmitter();

/** B 的引用 —— 由 index.js 注入，避免循环导入 */
let replay = null;
let obs = null;

export function bindReplayEngine(engine) { replay = engine; }
export function bindObs(o) { obs = o; }

/** 我方意图触发的转场静默窗口（C-REQ-583 意图对账） */
let silenceTransitionUntil = 0;
/** 最近一次编排结果，供导播页展示 */
let lastResult = null;

// ─────────────────────────────────────────────────────────────
// 编排
// ─────────────────────────────────────────────────────────────

/**
 * C-REQ-542：先 preflight，再决定是否启动倒计时。
 * @param {{leadMs?:number, autoExecute?:boolean, dryRun?:boolean, lookbackMs?:number, repeat?:boolean, audience?:string[]}} opts
 */
export async function scheduleReplay(opts = {}) {
  const cfg = getConfig();
  if (!cfg.orchestration.enable) {
    return { ok: false, nack: { code: 'orchestration_disabled', msg: '编排功能已在设置中关闭' } };
  }
  if (!replay) {
    return { ok: false, nack: { code: 'module_b_absent', msg: '模块 B 未就绪' } };
  }

  const xx = opts.lookbackMs ?? cfg.clip.defaultLookbackMs;

  // ★ C-REQ-542 / C-REQ-545：启动前必须预检，不 OK 就**立刻**告警，绝不启动倒计时
  let pf;
  try {
    pf = await replay.preflight({ for: 'clipAndAir', lookbackMs: xx });
  } catch (e) {
    cue.notifyAlert(`编排启动失败：预检异常 —— ${e.message}`, { hint: '请检查模块 B 与 vMix 连接' });
    return { ok: false, nack: { code: 'preflight_error', msg: e.message } };
  }

  if (!pf.ok) {
    const msg = `回放编排未启动：${pf.blockers.join('；')}`;
    log.warn('orchestration', msg, { blockers: pf.blockers });
    cue.notifyAlert(msg, {
      blockers: pf.blockers,
      hint: '补救步骤：① 在回放面板确认已开始回放录制；② 检查 vMix / OBS 连接；③ 确认 OBS 中目标场景存在。',
    });
    hub.toAudience(['director'], { t: 'orchestration:blocked', blockers: pf.blockers, for: 'replay' });
    lastResult = { at: Date.now(), kind: 'replay', ok: false, blockers: pf.blockers };
    set('countdown.lastResult', lastResult);
    return { ok: false, nack: { code: 'preflight_failed', msg, blockers: pf.blockers } };
  }

  if (pf.warn?.length) {
    log.warn('orchestration', '编排预检告警', { warn: pf.warn });
    hub.toAudience(['director'], { t: 'orchestration:warn', warn: pf.warn });
  }

  const leadMs = Number(opts.leadMs ?? cfg.countdown.defaultLeadMs);
  const snapshot = getCurrentPlayer();

  const res = countdown.schedule({
    leadMs,
    kind: 'replay',
    title: '回放',
    body: opts.title,
    audience: opts.audience || ['director', 'cast'],
    escalation: cfg.countdown.escalation,
    autoExecute: !!opts.autoExecute,
    dryRun: opts.dryRun ?? cfg.orchestration.dryRun,
    playerSnapshot: snapshot,
    onZero: { target: 'B', intent: 'clipAndAir', autoExecute: !!opts.autoExecute, lookbackMs: xx, repeat: !!opts.repeat },
  });

  if (!res.ok) return res;

  log.audit('orchestration', 'scheduleReplay', {
    leadMs, lookbackMs: xx, autoExecute: !!opts.autoExecute, dryRun: !!(opts.dryRun ?? cfg.orchestration.dryRun),
    preflightWarn: pf.warn, player: snapshot?.playerName || null,
  });
  set('countdown.lastResult', { at: Date.now(), kind: 'replay', ok: true, leadMs, lookbackMs: xx });
  return { ok: true, ...res, preflight: pf };
}

export async function scheduleBackToLive(opts = {}) {
  const cfg = getConfig();
  if (!cfg.orchestration.enable) {
    return { ok: false, nack: { code: 'orchestration_disabled', msg: '编排功能已在设置中关闭' } };
  }
  if (!replay) return { ok: false, nack: { code: 'module_b_absent', msg: '模块 B 未就绪' } };

  const pf = await replay.preflight({ for: 'backToLive' }).catch((e) => ({ ok: false, blockers: [`预检异常：${e.message}`] }));
  if (!pf.ok) {
    const msg = `回直播编排未启动：${pf.blockers.join('；')}`;
    cue.notifyAlert(msg, { blockers: pf.blockers, hint: '补救步骤：确认通道已处于 AIR（回放已上屏）且 OBS 连接正常。' });
    hub.toAudience(['director'], { t: 'orchestration:blocked', blockers: pf.blockers, for: 'backToLive' });
    lastResult = { at: Date.now(), kind: 'backToLive', ok: false, blockers: pf.blockers };
    set('countdown.lastResult', lastResult);
    return { ok: false, nack: { code: 'preflight_failed', msg, blockers: pf.blockers } };
  }

  const leadMs = Number(opts.leadMs ?? 10000);
  const res = countdown.schedule({
    leadMs,
    kind: 'backToLive',
    title: '回直播',
    audience: opts.audience || ['director', 'cast'],
    escalation: cfg.countdown.escalation,
    autoExecute: !!opts.autoExecute,
    dryRun: opts.dryRun ?? cfg.orchestration.dryRun,
    playerSnapshot: getCurrentPlayer(),
    onZero: { target: 'B', intent: 'backToLive', autoExecute: !!opts.autoExecute },
  });
  if (!res.ok) return res;

  log.audit('orchestration', 'scheduleBackToLive', { leadMs, autoExecute: !!opts.autoExecute });
  set('countdown.lastResult', { at: Date.now(), kind: 'backToLive', ok: true, leadMs });
  return { ok: true, ...res, preflight: pf };
}

/**
 * 到点执行（半自动时由导播点「确认执行」触发；全自动时由 timer 触发）。
 * C-REQ-544：失败时红色告警 + 手动补救步骤。
 */
export async function confirmExecute(countdownId, opts = {}) {
  const cfg = getConfig();
  const cd = countdown.get(countdownId);
  const onZero = cd?.onZero || opts.onZero || null;
  const intent = onZero?.intent || 'clipAndAir';
  const dryRun = cd?.dryRun ?? cfg.orchestration.dryRun;

  if (dryRun) {
    log.info('orchestration', '预演模式：跳过对模块 B 的调用（C-REQ-546）', { intent, countdownId });
    cue.publish({
      kind: 'notice', priority: 'P2', audience: ['director'],
      title: `预演完成：${intent}（未调用模块 B）`,
      sound: 'none', ttlMs: 6000, source: 'scheduler',
    });
    return { ok: true, dryRun: true };
  }

  if (!replay) return { ok: false, nack: { code: 'module_b_absent', msg: '模块 B 未就绪' } };

  const lookbackMs = onZero?.lookbackMs ?? cfg.clip.defaultLookbackMs;
  const t0 = Date.now();
  let res;
  try {
    res = await replay.execute(intent, { lookbackMs, actor: opts.actor || 'orchestration' });
  } catch (e) {
    res = { ok: false, nack: { code: 'execute_error', msg: e.message } };
  }

  if (!res.ok) {
    log.error('orchestration', `编排执行失败：${res.nack?.msg}`, { intent, code: res.nack?.code });
    cue.notifyAlert(`编排执行失败：${res.nack?.msg || '未知错误'}`, {
      code: res.nack?.code,
      hint: remedyHint(res.nack?.code),
    });
    lastResult = { at: Date.now(), kind: 'execute', ok: false, intent, msg: res.nack?.msg };
  } else {
    lastResult = { at: Date.now(), kind: 'execute', ok: true, intent, durationMs: Date.now() - t0 };
  }
  set('countdown.lastResult', lastResult);
  log.audit('orchestration', 'confirmExecute', { intent, ok: res.ok, durationMs: Date.now() - t0, actor: opts.actor });
  return res;
}

function remedyHint(code) {
  switch (code) {
    case 'preflight_failed': return '手动补救：改用手动回放按钮，或修复预检列出的阻断项后重试。';
    case 'busy': return '手动补救：等待当前宏执行完成（或按「复位」清除卡死状态）后重试。';
    case 'bad_phase': return '手动补救：在回放面板确认相位（需 ARMED / CUED / AIR）。';
    case 'obs_disconnected': return '手动补救：检查 OBS 是否运行、端口 4455 是否可达；也可在 vMix 侧手动上屏。';
    case 'vmix_error': return '手动补救：检查 vMix 是否运行、端口 8088 是否可达。';
    default: return '手动补救：请到 /replay 面板手动执行一次，并查看 /logs 日志。';
  }
}

// ─────────────────────────────────────────────────────────────
// 与模块 B 的协同 C-REQ-590 ~ 597
// ─────────────────────────────────────────────────────────────

export function bindReplayEvents(events) {
  const cfg = () => getConfig().integration;

  // C-REQ-592：air:start → 自动投递「回放中」常驻提示给 cast + director
  events.on('air:start', (evt) => {
    if (!cfg().autoCueOnAirStart) return;
    const name = evt.player?.playerName || '';
    cue.publish({
      kind: 'persistent', priority: 'P3', audience: ['cast', 'director'],
      title: name ? `回放中 · ${name}` : '回放中',
      body: '请解说保持安静，等待回放结束',
      sound: 'none', ttlMs: null, dismissible: true, requiresAck: false,
      source: 'module-b', tag: 'replay-persistent', playerSnapshot: evt.player || null,
    });
    silenceTransitionUntil = Date.now() + 4000;   // 我方触发的转场自己知道，不再弹大提醒
    log.info('orchestration', '已投递「回放中」常驻提示', { player: name });
  });

  // C-REQ-593：air:ending → P1「回放 Xs 结束，准备接话」给 cast
  events.on('air:ending', (evt) => {
    if (!cfg().autoCueOnAirEnding) return;
    const secs = Math.max(1, Math.round(evt.remainingMs / 1000));
    cue.publish({
      kind: 'alert', priority: 'P1', audience: ['cast', 'director'],
      title: `回放 ${secs}s 结束，准备接话`,
      sound: 'beep', ttlMs: secs * 1000 + 2000, dismissible: true, requiresAck: false,
      source: 'module-b', tag: 'replay-ending',
    });
  });

  // C-REQ-594：air:ended → P2「回放结束，可回直播」给 director
  events.on('air:ended', (evt) => {
    if (!cfg().autoCueOnAirEnded) return;
    cue.publish({
      kind: 'notice', priority: 'P2', audience: ['director'],
      title: '回放结束，可回直播',
      sound: 'none', ttlMs: 10000, dismissible: true, requiresAck: false,
      source: 'module-b', tag: 'replay-ended',
    });
    cue.clearByTag('replay-ending');
    log.info('orchestration', '回放结束', { reason: evt.reason });
  });

  // C-REQ-595：air:returned → 清除所有回放相关常驻提示
  events.on('air:returned', () => {
    cue.clearByTag('replay-persistent');
    cue.clearByTag('replay-ending');
    cue.clearByTag('replay-ended');
    cue.publish({
      kind: 'notice', priority: 'P2', audience: ['cast', 'director'],
      title: '已回直播', sound: 'none', ttlMs: 5000, source: 'module-b',
    });
    silenceTransitionUntil = Date.now() + 4000;
    log.info('orchestration', '已回直播，回放相关提示已清除');
  });

  // C-REQ-596：error → P0 告警给 director
  events.on('error', (evt) => {
    if (!cfg().autoCueOnError) return;
    cue.publish({
      kind: 'alert', priority: 'P0', audience: ['director'],
      title: `回放失败：${evt.msg}`, body: evt.code,
      sound: 'alarm', ttlMs: null, dismissible: true, requiresAck: true,
      source: 'module-b', tag: 'replay-error',
    });
    cue.notifyAlert(`模块 B 报错：${evt.msg}`, { code: evt.code, hint: remedyHint(evt.code) });
  });

  // C-REQ-597：镜像 B 的 phase（只读显示，不据此改变 B 状态）
  events.on('phase', (evt) => {
    set('cue.bPhase', evt.phase);
    log.debug('orchestration', `镜像模块 B 相位：${evt.phase}`);
  });

  events.on('clip:ready', (evt) => {
    cue.publish({
      kind: 'notice', priority: 'P3', audience: ['director'],
      title: `片段已裁切：回溯 ${(evt.lookbackMs / 1000).toFixed(1)}s`,
      sound: 'none', ttlMs: 4000, source: 'module-b', tag: 'clip-ready',
    });
  });

  // 全自动执行（仅当 autoExecute=true 且总开关允许）
  countdown.countdownEvents.on('execute', (cd) => {
    confirmExecute(cd.id, { onZero: cd.onZero, actor: 'auto' }).catch((e) => {
      log.error('orchestration', '自动执行异常', { err: e.message });
    });
  });

  log.info('orchestration', '已订阅模块 B 事件流（C-REQ-590~597）');
}

// ─────────────────────────────────────────────────────────────
// OBS 事件 → 转场大提醒 C-REQ-582 / 583 / 587
// ─────────────────────────────────────────────────────────────

export function bindObsEvents(obsModule) {
  obs = obsModule;

  const subscribed = getConfig().obsEvents.subscribe || [];
  for (const evtName of subscribed) {
    obsModule.obsEvents.on(evtName, (data) => {
      hub.broadcast({ t: 'obs:event', event: evtName, data, at: Date.now() });
    });
  }

  // 转场大提醒：订阅 CurrentProgramSceneChanged + SceneTransitionStarted
  obsModule.obsEvents.on('SceneTransitionStarted', (data) => {
    maybeAlert(data.transitionName, data.sceneName, 'started');
  });
  obsModule.obsEvents.on('CurrentProgramSceneChanged', (data) => {
    maybeAlert(null, data.sceneName, 'program-changed');
  });

  log.info('orchestration', '已订阅 OBS 事件（含转场大提醒 + 意图对账）', { events: subscribed });
}

/**
 * ★ C-REQ-583 意图对账：区分「我方宏触发的转场」与「外部手动触发的转场」，避免重复提醒。
 * silenceTransitionUntil 由 air:start / air:returned 置位 —— 只有我方宏驱动的转场才会命中。
 */
function maybeAlert(transitionName, sceneName, via) {
  const rules = getConfig().obsEvents.transitionAlerts || [];
  const rule = rules.find((r) => r.scene === sceneName);
  if (!rule) return;

  if (Date.now() < silenceTransitionUntil) {
    log.debug('orchestration', '转场大提醒跳过（我方宏意图，已对账）', { scene: sceneName, via, transition: transitionName });
    return;
  }

  // C-REQ-584：大提醒的时长与是否需 ack 都可按场景配置
  const durationMs = Number.isFinite(Number(rule.durationMs)) ? Number(rule.durationMs) : 8000;
  const priority = rule.priority || 'P1';
  const requiresAck = !!rule.requiresAck;

  log.info('orchestration', '检测到外部转场，弹出大提醒', {
    scene: sceneName, via, transition: transitionName, priority, durationMs, requiresAck,
  });
  const { cueId } = cue.publish({
    kind: 'alert',
    priority,
    audience: rule.audience || ['director', 'cast'],
    title: rule.title || `即将进入 ${sceneName}`,
    body: '（检测到外部操作，非本系统宏触发）',
    sound: rule.sound || 'none',
    ttlMs: requiresAck ? null : durationMs,      // 需要回执时不能自动过期，否则没人确认就消失了
    dismissible: true,
    requiresAck,
    source: 'obs-event',
    tag: 'transition-alert',
  });
  set('cue.alert', {
    at: Date.now(),
    msg: rule.title || sceneName,
    big: true,                                  // 悬浮大提醒层（C-REQ-580/581）
    cueId,
    scene: sceneName,
    priority,
    durationMs,
    requiresAck,
  });
  hub.toAudience(['director', 'cast'], {
    t: 'bigAlert',
    cueId,
    title: rule.title || sceneName,
    scene: sceneName,
    priority,
    durationMs,
    requiresAck,
    at: Date.now(),
  });
}

/** 供测试与排障：手动放行/屏蔽一次转场提醒 */
export function silenceTransitions(ms) { silenceTransitionUntil = Date.now() + ms; }

export function getLastResult() { return lastResult; }

/** 待执行编排队列（C-REQ-548） */
export function pendingQueue() {
  return countdown.list().map((cd) => ({
    id: cd.id, title: cd.title, kind: cd.kind, state: cd.state,
    remainingMs: countdown.remainingOf(cd.id),
    autoExecute: cd.autoExecute,
    dryRun: cd.dryRun,
  }));
}

export { getState, snapshotPlayer };
