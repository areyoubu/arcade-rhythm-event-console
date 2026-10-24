/**
 * 模块 B —— vMix 回放引擎（状态机 + 宏序列 + 状态回读 + 只读预检）。
 *
 * 覆盖需求：
 *   §5.2  状态机 IDLE/ARMED/MARKING/CUED/AIR/RETURNING/FAULT
 *   B-REQ-202  MARKING / RETURNING 瞬态期间锁定宏触发（busy 锁）
 *   B-REQ-203  瞬态最长存活 4s，超时强制 FAULT 并写日志
 *   B-REQ-204 ★ CUED 分「瞬态」与「持久」：clip() 进入的持久 CUED **不受**超时约束
 *                 （陷阱 #22：把 CUED 当瞬态处理，预裁模式会被 4s 超时误判为 FAULT）
 *   B-REQ-205  持久 CUED 期间主按钮语义变为「上屏」，并须同时呈现「丢弃」
 *   B-REQ-206  裁切微调在 CUED 与 AIR 两态均可用
 *   §5.7  一键回放宏 17 步（含 markDelayMs 补偿与 cutPoint 双保险）
 *   §5.8  回程 6 步（严禁 ReplayLive）
 *   §5.10 XML 轮询 + 稳定性过滤 + 意图对账
 *   §5.11 事件上报（fire-and-forget）
 *   B-REQ-5101 ~ 5111
 */
import { EventEmitter } from 'node:events';
import { getConfig } from '../config.js';
import { getState, set, snapshotPlayer, getCurrentPlayer } from '../state.js';
import * as log from '../logger.js';
import * as vmix from '../vmix/client.js';
import { parseReplay } from '../vmix/xml.js';
import { FN_MAP, NEEDS_CHANNEL, MOVES_PLAYHEAD } from '../vmix/functions.js';
import * as obs from '../obs.js';

export const replayEvents = new EventEmitter();
/** 事件总线最大监听者数量（订阅者多时避免 Node 警告） */
replayEvents.setMaxListeners(50);

export const PHASES = Object.freeze(['IDLE', 'ARMED', 'MARKING', 'CUED', 'AIR', 'RETURNING', 'FAULT']);
/** 瞬态相位 —— 期间锁定宏触发 */
const TRANSIENT_PHASES = new Set(['MARKING', 'RETURNING']);

// ─────────────────────────────────────────────────────────────
// 内部状态
// ─────────────────────────────────────────────────────────────
const st = {
  phase: 'IDLE',
  /** 当前是否处于瞬态（MARKING/RETURNING，或「瞬态 CUED」） */
  transient: false,
  transientSince: 0,
  /** CUED 是否由 clipAndAir() 产生的瞬态 */
  cuedTransient: false,

  recording: false,
  channel: 'A',
  eventList: 1,
  speed: 1.0,
  lastEventDurationMs: 0,
  lastMarkMs: null,
  since: Date.now(),

  busy: false,
  fault: null,

  // 回放中
  airStartedAt: 0,
  airEnded: false,
  airEndingFired: false,
  airPlayer: null,
  lastProgressAt: 0,

  /**
   * 裁切参数（B-REQ-537：须持久化）。
   *
   * 初值一律用 `null` 而不是硬编码的数字/字符串 —— 这样所有读取点上的
   * `?? cfg.clip.xxx` 才会真正回落到配置默认值。
   * （曾经把 fixedLengthMs 写成 0、outPointMode 写成 'follow-now'：
   *  0 不是 nullish，`??` 不会回落，于是「固定长度」模式下拿到 0ms 直接报错。）
   */
  clip: {
    lookbackMs: null,
    outPointMode: null,
    fixedLengthMs: null,
    inPointOffsetFrames: 0,
    outPointOffsetFrames: 0,
    estimatedDurationMs: 0,
    selectedEventId: null,
    clippedAt: 0,
  },

  // 回读
  observed: { live: true, recording: false, position: 0, duration: 0, state: 'Paused', channelMode: 'A', events: 0, eventsA: 0, eventsB: 0, speed: 1, eventList: [] },

  /**
   * 意图对账（B-REQ-804）—— 用**意图**而非时间窗过滤。
   *
   * `expectedLive` 记的是「按我方的指令，vMix 的 <replay live> 现在应该是几」。
   * 之所以不用「是否正在回放」这一个布尔量：`live` 反映的是通道的显示模式，
   * 而**裁切本身**就会把 live 拉成 false（通道切到缓冲位置），
   * 这时候我们并没有上屏。用单一布尔量对账会把「我方裁切」误判成「外部操作」，
   * 于是导播页会莫名弹出「检测到外部操作」告警（B-REQ-806 误报）。
   *
   * `expectedLive === null` 表示基线尚未建立 —— 下一次稳定观测会静默采纳，不判定为外部变化。
   */
  intent: { expectedLive: null, settleUntil: 0, pending: null, armed: false },
};

let pollTimer = null;
let transientTimer = null;
let stableRaw = null;
let stableCount = 0;
let lastStable = null;
let overlayCtl = null;
/** 上一次「跳转核对」是否已回位（陷阱 #20） */
let playheadDisplaced = false;

export function setOverlayController(ctl) { overlayCtl = ctl; }
export function getInternal() { return st; }
export function getPhase() { return st.phase; }
export function isBusy() { return st.busy; }

// ─────────────────────────────────────────────────────────────
// 相位迁移
// ─────────────────────────────────────────────────────────────

function setPhase(next, why = '') {
  const prev = st.phase;
  if (prev === next) return false;
  st.phase = next;
  st.since = Date.now();
  set('replay.phase', next);
  set('replay.since', st.since);
  log.info('replay', `相位 ${prev} → ${next}`, { from: prev, to: next, reason: why });
  emit({ t: 'phase', phase: next, at: st.since, from: prev });
  return true;
}

/** 进入瞬态并挂超时（B-REQ-203） */
function enterTransient(phase, why) {
  st.transient = true;
  st.transientSince = Date.now();
  setPhase(phase, why);
  setBusy(true);
  clearTimeout(transientTimer);
  const limit = getConfig().replay.faultTimeoutMs;
  transientTimer = setTimeout(() => {
    if (st.transient) {
      const stuck = Date.now() - st.transientSince;
      fail('transient_timeout', `相位 ${st.phase} 停留 ${stuck}ms 超过 faultTimeoutMs=${limit}，强制转 FAULT`);
    }
  }, limit);
  transientTimer.unref?.();
}

function leaveTransient() {
  st.transient = false;
  st.cuedTransient = false;
  clearTimeout(transientTimer);
  transientTimer = null;
  setBusy(false);
}

function setBusy(v) {
  st.busy = v;
  set('replay.busy', v);
}

function fail(code, msg) {
  leaveTransient();
  st.fault = { code, msg, at: Date.now() };
  set('replay.fault', st.fault);
  setPhase('FAULT', `${code}: ${msg}`);
  log.error('replay', `回放故障：${msg}`, { code });
  emit({ t: 'error', code, msg });
}

export function reset() {
  if (st.phase !== 'FAULT') return { ok: false, nack: { code: 'not_fault', msg: '当前不在 FAULT 相位' } };
  st.fault = null;
  set('replay.fault', null);
  setPhase(st.recording ? 'ARMED' : 'IDLE', 'reset');
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// 事件上报（B-REQ-5107 fire-and-forget）
// ─────────────────────────────────────────────────────────────

/**
 * ★ B-REQ-5107 / G-REQ-111：事件发射必须 fire-and-forget。
 * 订阅者（模块 C）抛异常**不得**中断 B 的主流程。
 *
 * 实现要点：**逐个监听器** try/catch，且每个事件只派发一次。
 * （EventEmitter 的 emit 不隔离异常 —— 一个订阅者抛错会打断同事件上的其余订阅者；
 *  而「既 emit(evt.t) 又手工遍历 listeners」会让订阅者收到两次，模块 C 会重复投递提示。）
 */
function emit(evt) {
  // ① 通用 'event' 通道（内部转发给 WS 用），异常在这里就地吞掉
  for (const fn of replayEvents.listeners('event')) {
    try { fn(evt); } catch (e) {
      log.warn('replay', '事件订阅者抛异常（已忽略，不影响 B 主流程）', { t: evt.t, subscriber: 'event', err: String(e?.message) });
    }
  }
  // ② 具体事件类型通道 —— 只手工遍历，不再走 emit()，避免重复派发
  for (const fn of replayEvents.listeners(evt.t)) {
    try { fn(evt); } catch (e) {
      log.warn('replay', '事件订阅者抛异常（已忽略）', { t: evt.t, err: String(e?.message) });
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 只读预检 ★ B-REQ-5101
// ─────────────────────────────────────────────────────────────

let preflightCache = null;

/**
 * ★★ B-REQ-5101 / 5102 / 5103 —— 严格只读预检。
 *
 * 绝不允许在本函数内：sleep(markDelayMs)、发送任何 vMix 写指令、改变状态机。
 * 结果缓存 preflightCacheMs（默认 3s）—— 长倒计时期间须重新校验。
 *
 * @param {{ for:'clip'|'clipAndAir'|'air'|'backToLive', lookbackMs?:number }} opts
 * @returns {Promise<{ok:boolean, blockers:string[], warn:string[], detail:object, at:number, cached:boolean}>}
 */
export async function preflight(opts = {}) {
  const cfg = getConfig();
  const ttl = cfg.replay.preflightCacheMs;
  const key = `${opts.for || 'clip'}:${opts.lookbackMs ?? ''}:${st.phase}:${st.recording}:${vmix.isConnected()}:${obs.isConnected()}`;

  if (preflightCache && preflightCache.key === key && Date.now() - preflightCache.at < ttl) {
    return { ...preflightCache.value, cached: true };
  }

  const blockers = [];
  const warnList = [];
  const detail = {};

  // ① 相位
  detail.phase = st.phase;
  if (st.busy) blockers.push('回放宏正在执行中（busy 锁）');
  if (opts.for !== 'backToLive') {
    if (st.phase === 'IDLE') blockers.push('回放未录制');
    else if (st.phase !== 'ARMED' && !(opts.for === 'air' && st.phase === 'CUED')) {
      blockers.push(`当前相位为 ${st.phase}，须处于 ARMED${opts.for === 'air' ? ' 或 CUED' : ''}`);
    }
  } else if (st.phase !== 'AIR') {
    blockers.push(`回直播须处于 AIR 相位，当前为 ${st.phase}`);
  }

  // ② vMix 连接
  detail.vmix = vmix.getStatus();
  if (!vmix.isConnected()) blockers.push(`vMix 未连接（${vmix.getStatus().lastErr || '无响应'}）`);
  else if (!vmix.isMacroEnabled()) blockers.push(`vMix 链路连续失败 ${vmix.getStatus().failCount} 次，回放宏已停用`);

  // ③ OBS 连接（裁切不触 OBS，只有 clipAndAir / air / backToLive 需要）
  const needsObs = ['clipAndAir', 'air', 'backToLive'].includes(opts.for);
  if (needsObs) {
    const ok = obs.isConnected();
    detail.obs = { connected: ok, lastErr: obs.getLastError() };
    if (!ok) blockers.push(`OBS 未连接（${obs.getLastError() || '无响应'}）`);
  }

  // ④ recording
  detail.recording = st.recording;
  if (opts.for !== 'backToLive' && !st.recording) blockers.push('recording=false：回放录制未启动');

  // ⑤ 目标场景存在
  if (needsObs) {
    try {
      const scenes = getState().health.obs.scenes || [];
      const target = opts.for === 'backToLive' ? cfg.scenes.live : cfg.scenes.replay;
      detail.targetScene = target;
      if (scenes.length && !scenes.includes(target)) blockers.push(`OBS 中不存在目标场景「${target}」`);
    } catch { /* 场景列表拿不到不阻断，由 OBS 请求本身报错 */ }
  }

  // ⑥ XX ≤ 缓冲容量（B-REQ-521 / 539）
  if (opts.for !== 'backToLive') {
    const xx = opts.lookbackMs ?? st.clip.lookbackMs ?? cfg.clip.defaultLookbackMs;
    detail.lookbackMs = xx;
    detail.maxLookbackMs = cfg.clip.maxLookbackMs;
    if (xx > cfg.clip.maxLookbackMs) {
      blockers.push(`回溯量 ${(xx / 1000).toFixed(1)}s 超过回放会话缓冲容量 ${(cfg.clip.maxLookbackMs / 1000).toFixed(1)}s（R10 须实测回填）`);
    } else if (xx > cfg.clip.maxLookbackMs * cfg.clip.warnThreshold) {
      warnList.push(`回溯量已达缓冲容量的 ${Math.round((xx / cfg.clip.maxLookbackMs) * 100)}%，接近上限`);
    }
  }

  // ⑦ 明确提示尚未验证的项（G-REQ：任何不确定都要说清，不许静默）
  if (st.phase === 'AIR' && !st.observed.live && !st.recording) {
    warnList.push('通道处于回放态且 recording=false —— 请核对 R1（通道回放态下 recording 是否仍为 True）');
  }

  const value = { ok: blockers.length === 0, blockers, warn: warnList, detail, at: Date.now() };
  preflightCache = { key, at: Date.now(), value };
  set('replay.preflight', value);
  if (!value.ok) {
    log.warn('replay', '预检未通过', { for: opts.for, blockers });
  }
  return { ...value, cached: false };
}

// ─────────────────────────────────────────────────────────────
// 状态轮询 §5.10
// ─────────────────────────────────────────────────────────────

async function fetchXml() {
  const cfg = getConfig();
  const url = `http://${cfg.vmix.host}:${cfg.vmix.port}/api/`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), cfg.replay.vmixTimeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(t); }
}

export function startPolling() {
  stopPolling();
  const tick = async () => {
    try { await pollOnce(); } catch (e) {
      log.debug('replay', '轮询异常', { err: String(e?.message) });
    }
    const interval = Math.max(50, getConfig().replay.pollIntervalMs);
    pollTimer = setTimeout(tick, interval);
    pollTimer.unref?.();
  };
  pollTimer = setTimeout(tick, 300);
  pollTimer.unref?.();
}

export function stopPolling() { if (pollTimer) clearTimeout(pollTimer); pollTimer = null; }

async function pollOnce() {
  if (!vmix.isConnected()) return;
  const xml = await fetchXml();
  const r = parseReplay(xml);
  if (!r) return;

  // ── 稳定性过滤（B-REQ-803）：连续 N 次同一值才认账 ──
  const rawKey = `${r.live}|${r.recording}|${r.channelMode}|${r.state}`;
  if (rawKey !== stableRaw) { stableRaw = rawKey; stableCount = 1; return; }
  stableCount++;
  if (stableCount < getConfig().replay.stableSamples) return;

  lastStable = r;
  const observedOnAir = !r.live;

  st.observed = {
    live: r.live,
    recording: r.recording,
    position: r.position,
    duration: r.duration,
    state: r.state,
    channelMode: r.channelMode,
    events: r.events,
    eventsA: r.eventsA,
    eventsB: r.eventsB,
    speed: r.speed,
    eventList: r.eventList,
  };

  // ── 录制状态回读（B-REQ-404：不得仅依赖指令响应） ──
  if (r.recording !== st.recording) {
    st.recording = r.recording;
    set('replay.recording', r.recording);
    log.info('replay', `录制状态变化：${r.recording ? '录制中' : '已停止'}`, { recording: r.recording });
    if (!r.recording) {
      if (st.phase === 'ARMED') setPhase('IDLE', 'recording=false');
      if (st.phase === 'AIR' || st.phase === 'CUED' || st.phase === 'MARKING') {
        // R1 相关：通道回放态下录制可能为 false —— 只告警，不擅自改相位
        log.warn('replay', '录制已停止，但通道处于回放相关相位（见 R1 待验证项）', { phase: st.phase });
      }
    } else if (st.phase === 'IDLE') {
      setPhase('ARMED', 'recording=true');
    }
    // B-REQ-5111：arm() 后状态失效 → 主动发 error 事件并 disarm()
    if (!r.recording && st.intent.armed) {
      const intentName = st.intent.pending;
      st.intent.armed = false;
      st.intent.pending = null;
      log.warn('replay', '已登记的待执行意图失效（recording 转 false）', { intent: intentName });
      emit({ t: 'error', code: 'intent_invalidated', msg: `待执行意图 ${intentName} 失效：回放录制已停止` });
    }
  }
  if (st.phase === 'IDLE' && r.recording) setPhase('ARMED', 'recording=true');

  // ── 通道 / 事件库回读 ──
  if (r.channelMode && r.channelMode !== st.channel) {
    st.channel = r.channelMode === 'B' ? 'B' : 'A';
    set('replay.channel', st.channel);
  }
  set('replay.live', r.live);
  set('replay.positionMs', r.position);
  set('replay.durationMs', r.duration);
  set('replay.events', r.eventList);
  set('replay.speed', r.speed);

  // ── 意图对账（B-REQ-804）★ 用意图而非时间窗过滤，避免外部触发被误吞 ──
  if (Date.now() > st.intent.settleUntil) {
    if (st.intent.expectedLive === null) {
      // 基线未建立（刚启动 / 刚做过丢弃 / 刚手动切过 Live）→ 静默采纳，不算外部变化
      st.intent.expectedLive = r.live;
      log.debug('replay', `建立 live 基线：live=${r.live}`, {});
    } else if (r.live !== st.intent.expectedLive) {
      handleExternalChange(r.live, r);
    }
  }

  // ── AIR 相位：progress / air:ending / air:ended（B-REQ-5104/5105/5106） ──
  if (st.phase === 'AIR') {
    const now = Date.now();
    if (now - st.lastProgressAt >= getConfig().replay.progressIntervalMs) {
      st.lastProgressAt = now;
      if (getConfig().replay.reportProgress) {
        emit({ t: 'progress', positionMs: r.position, durationMs: r.duration, remainingMs: r.remainingMs });
      }
    }

    // B-REQ-5106：每次回放仅触发一次（去重，防 XML 抖动重复触发）
    if (!st.airEndingFired && r.remainingMs > 0 && r.remainingMs <= getConfig().replay.endingThresholdMs) {
      st.airEndingFired = true;
      log.info('replay', `回放即将结束（剩余 ${r.remainingMs}ms）`, { remainingMs: r.remainingMs });
      emit({ t: 'air:ending', remainingMs: r.remainingMs });
    }

    // 自然播完：位置到达末尾，或 vMix 自己退出了回放态
    // （我方上屏后 expectedLive=false；若它变回 true，说明通道自己回了 Live）
    const finished = (r.remainingMs <= 0 && r.duration > 0)
      || (st.intent.expectedLive === false && r.live === true && now > st.intent.settleUntil);
    if (!st.airEnded && finished) {
      st.airEnded = true;
      log.info('replay', '回放自然结束', { position: r.position, duration: r.duration });
      emit({ t: 'air:ended', at: now, reason: r.remainingMs <= 0 ? 'eof' : 'channel-left-air' });
      // AC-26：状态不得卡在 AIR 里出不来 —— 保持 AIR（画面仍在节目上）但标记已播完，
      // 并解除 busy，使「回直播 / 丢弃」立即可用。
      setBusy(false);
      set('replay.airEnded', true);
    }
  }
}

/**
 * B-REQ-805 / 806：检测到外部变化。
 * 更新 UI 状态、写日志、广播，**不清空玩家上下文**（G-REQ-109）。
 */
function handleExternalChange(observedLive, r) {
  const prev = st.intent.expectedLive;
  const observedOnAir = !observedLive;
  log.warn('replay', '检测到外部操作：通道 live 状态与意图不符', {
    expectedLive: prev, observedLive, state: r.state, source: 'vMix 界面 / 外部触发',
  });
  set('replay.externalChange', {
    at: Date.now(),
    expectedLive: prev,
    observedLive,
    state: r.state,
    msg: observedLive ? '检测到外部操作：通道已切回 Live' : '检测到外部操作：通道已进入回放态',
  });
  // 注意：**不清空** st.airPlayer / 玩家上下文（B-REQ-805）
  st.intent.expectedLive = observedLive;

  if (observedOnAir && st.phase === 'ARMED') setPhase('AIR', '外部触发进入回放');
  if (!observedOnAir && st.phase === 'AIR') {
    setPhase('ARMED', '外部触发退出回放');
    leaveTransient();
  }
}

export function clearExternalChange() {
  set('replay.externalChange', null);
}

/**
 * 明确声明「按我方的指令，vMix 的 live 接下来应该是几」—— 避免自己的指令回声被当成外部触发。
 * @param {boolean} expectedLive
 */
function declareLive(expectedLive) {
  st.intent.expectedLive = !!expectedLive;
  st.intent.settleUntil = Date.now() + 1500;
}

/**
 * 放弃当前基线，下一次稳定观测静默重新采纳。
 * 用于「我方发了指令，但结果取决于 vMix 内部状态」的操作（丢弃片段、手动切 Live 模式）。
 */
function rebaselineLive() {
  st.intent.expectedLive = null;
  st.intent.settleUntil = Date.now() + 1500;
}

// ─────────────────────────────────────────────────────────────
// 低层命令（供完整面板调用 151 函数表）
// ─────────────────────────────────────────────────────────────

/**
 * 执行任意 vMix 回放函数。自动处理：
 *   - None 参数函数必须走 callOnChannel（B-REQ-1006）
 *   - 破坏性 / 危险函数要求显式确认
 *   - 会移动播放头的函数置 playheadDisplaced，提醒回位（陷阱 #20）
 */
export async function execFunction(fn, params = {}, opts = {}) {
  const def = FN_MAP.get(fn);
  if (!def) return { ok: false, nack: { code: 'unknown_function', msg: `未登记的函数：${fn}` } };

  if (def.dangerous && !opts.confirmed) {
    return { ok: false, nack: { code: 'confirm_required', msg: `${fn} 属高危操作，须二次确认（${def.hint || ''}）` } };
  }
  if (def.destructive && !opts.confirmed) {
    return { ok: false, nack: { code: 'confirm_required', msg: `${fn} 不可撤销，须二次确认` } };
  }
  if (opts.speed !== undefined && opts.speed < 0.5 && !opts.confirmed) {
    return { ok: false, nack: { code: 'confirm_required', msg: '速度低于 0.5 会使画面与本地音乐严重失步，须二次确认' } };
  }

  const channel = params.Channel || params.channel || st.channel;
  const clean = {};
  for (const [k, v] of Object.entries(params)) {
    const key = k[0].toUpperCase() + k.slice(1);
    if (key === 'Channel') continue;   // 通道由 callOnChannel 处理
    clean[key] = v;
  }

  try {
    if (def.needsChannel) {
      // ★ 强制走 callOnChannel：先 ReplaySelectChannel{A|B}
      await vmix.callOnChannel(fn, channel, clean, { actor: opts.actor || 'panel' });
      log.audit('replay', `callOnChannel:${fn}`, { channel, params: clean, actor: opts.actor || 'panel' });
    } else {
      await vmix.call(fn, clean, { actor: opts.actor || 'panel' });
    }
  } catch (e) {
    return { ok: false, nack: { code: e.code || 'vmix_error', msg: e.message } };
  }

  if (def.movesPlayhead) {
    playheadDisplaced = true;
    set('replay.playheadDisplaced', true);
    log.warn('replay', `${fn} 已移动播放头 —— 核对完成后必须按「跳回直播点」（陷阱 #20）`, { fn });
  }
  // 这几个函数会改变通道的 Live/回放模式，对账基线随之更新
  if (fn === 'ReplayJumpToNow') {
    playheadDisplaced = false;
    set('replay.playheadDisplaced', false);
    declareLive(true);                 // 跳回直播点 = 通道回到 Live
  } else if (fn === 'ReplayLive' || fn === 'ReplayLiveToggle' || fn === 'ReplayRecorded') {
    // 手动切模式：结果取决于切换前的状态，放弃基线让下次观测重新采纳
    rebaselineLive();
  }
  if (def.fn === 'ReplaySetSpeed' && getConfig().replay.slowMotionMute) {
    await applySlowMotionMute(Number(clean.Value));
  }
  return { ok: true };
}

/** B-REQ-702：慢放时自动静音游戏音轨（默认关闭） */
async function applySlowMotionMute(speed) {
  const cfg = getConfig();
  if (!cfg.replay.slowMotionMute || !cfg.sources.gameAudio) return;
  const shouldMute = Number.isFinite(speed) && speed < cfg.replay.slowMotionThreshold;
  try {
    const cur = await obs.getInputMute(cfg.sources.gameAudio);
    if (cur !== shouldMute) {
      await obs.setInputMute(cfg.sources.gameAudio, shouldMute);
      log.info('replay', `慢放自动静音${shouldMute ? '开启' : '解除'}`, { input: cfg.sources.gameAudio, speed });
    }
  } catch (e) {
    log.warn('replay', '慢放自动静音失败', { err: e.message });
  }
}

// ─────────────────────────────────────────────────────────────
// 宏序列 §5.6 / §5.7
// ─────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

/** 等待 OBS 转场 cutPoint，或超时兜底 —— B-REQ-1101 双保险 */
function waitCutPoint(timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (via) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      obs.obsEvents.off('SceneTransitionEnded', onEnded);
      obs.obsEvents.off('CurrentProgramSceneChanged', onScene);
      resolve(via);
    };
    const onEnded = () => finish('event');
    // 兜底二：节目场景确实变了也算
    const onScene = () => finish('scene-changed');
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    timer.unref?.();
    obs.obsEvents.once('SceneTransitionEnded', onEnded);
    obs.obsEvents.once('CurrentProgramSceneChanged', onScene);
  });
}

/** 让 OBS 切场景（转场由场景覆盖决定，不在此处硬设） */
async function obsSwitchScene(sceneName) {
  const cfg = getConfig();
  const isReplayIn = sceneName === cfg.scenes.replay;
  // 用场景转场覆盖保证每次切换行为一致；OBS 无变更事件，故每次切换前重读（B-REQ-3001）
  try {
    const ov = await obs.readSceneOverride(sceneName);
    const want = isReplayIn
      ? cfg.transitions.replayEnter
      : cfg.transitions.replayExit;
    if (ov.transitionName !== want.transitionName || ov.transitionDuration !== want.durationMs) {
      await obs.setSceneOverride(sceneName, want.transitionName, want.durationMs);
      log.info('transitions', `已同步场景转场覆盖：${sceneName}`, { transition: want.transitionName, duration: want.durationMs });
    }
  } catch (e) {
    log.warn('transitions', '场景转场覆盖同步失败（继续切场景）', { scene: sceneName, err: e.message });
  }
  await obs.setProgramScene(sceneName);
}

/**
 * 裁切（不触 OBS）。
 * §5.6.2 即时裁切序列：SelectChannel → sleep(markDelayMs) → SelectEvents → MarkInOut{XX秒} → CUED(持久)
 * B-REQ-528：裁切 ≠ 上屏，两者必须解耦。
 */
export async function clip(opts = {}) {
  const cfg = getConfig();
  const xx = Number(opts.lookbackMs ?? st.clip.lookbackMs ?? cfg.clip.defaultLookbackMs);
  const channel = opts.channel || st.channel;

  const pf = await preflight({ for: 'clip', lookbackMs: xx });
  if (!pf.ok) return { ok: false, nack: { code: 'preflight_failed', msg: pf.blockers.join('；') } };

  if (st.busy) return { ok: false, nack: { code: 'busy', msg: '回放宏正在执行中' } };
  if (st.phase !== 'ARMED') return { ok: false, nack: { code: 'bad_phase', msg: `须处于 ARMED，当前 ${st.phase}` } };

  const t0 = Date.now();
  enterTransient('MARKING', 'clip');

  try {
    // ① 显式选通道（B-REQ-523）
    await vmix.selectChannel(channel, { actor: opts.actor });

    // ② 打点补偿回路延迟 L（B-REQ-509）
    const delay = opts.markDelayMs ?? cfg.replay.markDelayMs;
    if (delay > 0) await sleep(delay);

    // ③ 选事件库
    const list = opts.eventList ?? st.eventList ?? cfg.replay.eventList;
    await vmix.call(`ReplaySelectEvents${list}`, { Channel: channel }, { silent: true, actor: opts.actor });

    // ④ 一步建立 [now−XX, now] 并选中
    const variant = cfg.clip.markVariant || 'ReplayMarkInOut';
    await vmix.call(variant, { Value: (xx / 1000).toFixed(3) }, { actor: opts.actor });

    // ★ 裁切本身会把通道的 live 拉成 false（通道切到缓冲位置），但我们**并没有上屏**。
    //   声明这是我方意图，否则轮询会把这次变化误判成「外部操作」并强行把相位推成 AIR。
    declareLive(false);

    // ⑤ 按出点模式修正出点（§5.6.1 的「固定长度」）
    //    MarkInOut 建出来的永远是 [now−XX, now]；固定长度要的是
    //    [now−XX, now−XX+L]，所以把出点往回挪 (XX−L)。
    //    「开放出点 / manual」在**建片段这一刻**与即时裁切是一样的，
    //    区别在于之后由操作员反复调 extendTail()（ReplayUpdateSelectedOutPoint）去锚定尾部 —— 所以这里不动。
    const outMode = opts.outPointMode || st.clip.outPointMode || cfg.clip.defaultOutPointMode;
    const fixedLen = Number(opts.fixedLengthMs ?? st.clip.fixedLengthMs ?? cfg.clip.fixedLengthMs);
    let effectiveDurationMs = xx;
    let outPointAdjusted = null;

    if (outMode === 'fixed-length') {
      if (!Number.isFinite(fixedLen) || fixedLen <= 0) {
        throw Object.assign(
          new Error(`固定长度无效：${fixedLen}ms（请在设置页的 clip.fixedLengthMs 配置，或在请求里带上 fixedLengthMs）`),
          { code: 'bad_fixed_length' },
        );
      }
      const frameRate = cfg.clip.frameRate || 60;
      const deltaMs = fixedLen - xx;                       // 负数 = 出点往回挪
      const frames = Math.round((deltaMs / 1000) * frameRate);
      if (frames !== 0) {
        await vmix.call('ReplayMoveSelectedOutPoint', { Value: frames, Channel: channel }, { actor: opts.actor });
      }
      effectiveDurationMs = fixedLen;
      st.clip.fixedLengthMs = fixedLen;      // B-REQ-537：记住本次用的长度，下次直接复用
      outPointAdjusted = { mode: 'fixed-length', frames, deltaMs, frameRate };
      log.info('replay', `固定长度模式：出点修正 ${frames} 帧（${deltaMs}ms）`, { xx, fixedLen, frames, frameRate });
    }

    const durationMs = Date.now() - t0;
    st.lastMarkMs = Date.now();
    st.lastEventDurationMs = durationMs;
    st.clip.lookbackMs = xx;
    st.clip.outPointMode = outMode;
    st.clip.clippedAt = Date.now();
    st.clip.estimatedDurationMs = effectiveDurationMs;
    st.clip.selectedEventId = `ev-${st.lastMarkMs}`;
    st.clip.lastOutPointAdjust = outPointAdjusted;

    set('replay.lastMarkMs', st.lastMarkMs);
    set('replay.lastEventDurationMs', durationMs);
    set('replay.clip', { ...st.clip });

    // ⑤ → CUED（**持久**，不受瞬态超时约束 —— B-REQ-204 / 陷阱 #22）
    st.transient = false;
    st.cuedTransient = false;
    clearTimeout(transientTimer);
    transientTimer = null;
    setBusy(false);
    setPhase('CUED', 'clip 完成（持久）');

    log.audit('replay', 'clip', {
      lookbackMs: xx, channel, eventList: list, variant,
      durationMs, actor: opts.actor,
    });
    emit({ t: 'clip:ready', durationMs: st.clip.estimatedDurationMs, lookbackMs: xx });
    if (durationMs > 500) {
      log.warn('replay', `裁切耗时 ${durationMs}ms 超过 B-NFR-10 的 500ms 指标`, { durationMs });
    }
    return { ok: true, clip: { ...st.clip } };
  } catch (e) {
    log.error('replay', '裁切失败', { err: e.message, code: e.code });
    emit({ t: 'error', code: e.code || 'clip_failed', msg: `裁切失败：${e.message}` });
    st.transient = false;
    clearTimeout(transientTimer);
    setBusy(false);
    setPhase(st.recording ? 'ARMED' : 'IDLE', '裁切失败回退');
    return { ok: false, nack: { code: e.code || 'clip_failed', msg: e.message } };
  }
}

/**
 * 上屏（已裁切片段 → 输出 + 切场景）。
 * §5.7 步骤 9–17。
 */
export async function air(opts = {}) {
  const cfg = getConfig();
  const channel = opts.channel || st.channel;

  const pf = await preflight({ for: 'air' });
  if (!pf.ok) return { ok: false, nack: { code: 'preflight_failed', msg: pf.blockers.join('；') } };
  if (st.busy) return { ok: false, nack: { code: 'busy', msg: '回放宏正在执行中' } };
  if (st.phase !== 'CUED' && st.phase !== 'ARMED') {
    return { ok: false, nack: { code: 'bad_phase', msg: `须处于 CUED 或 ARMED，当前 ${st.phase}` } };
  }

  const snapshot = opts.playerSnapshot || getCurrentPlayer() || st.airPlayer;
  enterTransient('MARKING', 'air');

  try {
    // ⑧ 速度
    const speed = opts.speed ?? cfg.replay.speed;
    await vmix.call('ReplaySetSpeed', { Value: speed, Channel: channel }, { silent: true, actor: opts.actor });
    st.speed = speed;

    // ⑨ 送专用回放输出
    await vmix.call('ReplayPlayLastEventToOutput', { Channel: channel }, { actor: opts.actor });

    // ⑩ 定格首帧（若 holdFirstFrame）
    if (opts.holdFirstFrame ?? cfg.replay.holdFirstFrame) {
      await vmix.call('ReplayPause', { Channel: channel }, { silent: true, actor: opts.actor });
    }

    // ⑪ 状态转 CUED（等待 cutPoint）
    declareLive(false);            // 上屏后通道 live 变 false（我方意图，不是外部操作）
    setPhase('CUED', 'air 已送输出，等待转场');

    // ⑫ 挂载 cutPoint 监听，同时下发 OBS 切场景指令
    const timeoutMs = cfg.replay.transitionTimeoutMs;
    const waiting = waitCutPoint(timeoutMs);
    await obsSwitchScene(cfg.scenes.replay);

    // ⑬ await cutPoint 或超时兜底
    const via = await waiting;
    log.info('replay', `转场驱动来源：${via}`, { via, timeoutMs });   // B-REQ-1102

    // ⑭ 遮罩退场时开始播放
    await vmix.call('ReplayPlay', { Channel: channel }, { silent: true, actor: opts.actor });

    // ⑮ 状态 → AIR
    st.airStartedAt = Date.now();
    st.airEnded = false;
    st.airEndingFired = false;
    st.airPlayer = snapshot;
    st.lastProgressAt = 0;
    st.cuedTransient = false;
    leaveTransient();
    setBusy(false);
    setPhase('AIR', 'air 完成');
    set('replay.airEnded', false);

    // ⑯ 浮窗切回放态（含选手名）
    pushOverlay('replay', snapshot?.playerName);
    emit({ t: 'air:start', player: snapshot, at: st.airStartedAt });

    // 记入历史
    pushHistory({ at: st.airStartedAt, player: snapshot, lookbackMs: st.clip.lookbackMs, via });
    return { ok: true, via };
  } catch (e) {
    log.error('replay', '上屏失败', { err: e.message });
    emit({ t: 'error', code: e.code || 'air_failed', msg: `上屏失败：${e.message}` });
    // B-REQ-508：失败时不得停留在瞬态
    st.transient = false;
    clearTimeout(transientTimer);
    setBusy(false);
    setPhase(st.recording ? 'ARMED' : 'IDLE', '上屏失败回退');
    return { ok: false, nack: { code: e.code || 'air_failed', msg: e.message } };
  }
}

/**
 * ★ 一键回放宏 §5.7（裁切 + 上屏串联）。
 */
export async function clipAndAir(opts = {}) {
  const xx = Number(opts.lookbackMs ?? st.clip.lookbackMs ?? getConfig().clip.defaultLookbackMs);

  const pf = await preflight({ for: 'clipAndAir', lookbackMs: xx });
  if (!pf.ok) return { ok: false, nack: { code: 'preflight_failed', msg: pf.blockers.join('；'), blockers: pf.blockers } };
  if (st.busy) return { ok: false, nack: { code: 'busy', msg: '回放宏正在执行中，请勿连点' } };
  if (st.phase !== 'ARMED') return { ok: false, nack: { code: 'bad_phase', msg: `须处于 ARMED，当前 ${st.phase}` } };

  // ② 取 PlayerSnapshot（快照，非实时引用 —— A-REQ-306 / C-REQ-591）
  const snapshot = opts.playerSnapshot || getCurrentPlayer();
  const t0 = Date.now();

  const c = await clip({ ...opts, lookbackMs: xx });
  if (!c.ok) return c;

  const a = await air({ ...opts, channel: opts.channel || st.channel, playerSnapshot: snapshot });
  if (!a.ok) return a;

  log.audit('replay', 'clipAndAir', {
    lookbackMs: xx, channel: opts.channel || st.channel,
    player: snapshot?.playerName || null,
    totalMs: Date.now() - t0, actor: opts.actor,
  });
  return { ok: true, clip: c.clip, via: a.via, totalMs: Date.now() - t0 };
}

/**
 * 回程（回直播）§5.8。
 * B-REQ-601：**必须先切 OBS、后动 vMix**。
 * B-REQ-602：**默认不得调用 ReplayLive** —— 会让通道变成落后 L 的直通，下次硬切画面倒退。
 */
export async function backToLive(opts = {}) {
  if (st.phase !== 'AIR') return { ok: false, nack: { code: 'bad_phase', msg: `回直播须处于 AIR，当前 ${st.phase}` } };
  if (st.busy) return { ok: false, nack: { code: 'busy', msg: '回放宏正在执行中' } };

  const cfg = getConfig();
  const channel = opts.channel || st.channel;
  enterTransient('RETURNING', 'backToLive');

  try {
    declareLive(false);            // 回程只 ReplayPause 停在最后一帧，live 仍为 false（B-REQ-602）

    // ② OBS 切回 LIVE（本地内容，不依赖回路）
    await obsSwitchScene(cfg.scenes.live);

    // ③ 浮窗回 live 态
    pushOverlay('live', st.airPlayer?.playerName);

    // ④ 停在最后一帧 —— ★ 不用 ReplayLive（B-REQ-602），避免后续硬切画面倒退
    await vmix.call('ReplayPause', { Channel: channel }, { silent: true, actor: opts.actor });

    // ⑤ 状态 → RETURNING，⑥ sleep(200) → ARMED
    await sleep(200);
    st.airEnded = false;
    st.airEndingFired = false;
    set('replay.airEnded', false);
    st.airPlayer = null;
    leaveTransient();
    setPhase(st.recording ? 'ARMED' : 'IDLE', '回程完成');

    emit({ t: 'air:returned', at: Date.now() });
    log.audit('replay', 'backToLive', { channel, actor: opts.actor });
    return { ok: true };
  } catch (e) {
    log.error('replay', '回程失败', { err: e.message });
    emit({ t: 'error', code: e.code || 'return_failed', msg: `回程失败：${e.message}` });
    st.transient = false;
    clearTimeout(transientTimer);
    setBusy(false);
    setPhase('FAULT', '回程失败');
    st.fault = { code: 'return_failed', msg: e.message, at: Date.now() };
    set('replay.fault', st.fault);
    return { ok: false, nack: { code: e.code || 'return_failed', msg: e.message } };
  }
}

/** 丢弃片段：ReplayMarkCancel + 清理 UI → ARMED（B-REQ-529 / AC-19：不得触及 OBS） */
export async function discard(opts = {}) {
  if (st.phase !== 'CUED' && st.phase !== 'AIR') {
    return { ok: false, nack: { code: 'bad_phase', msg: `须处于 CUED 或 AIR，当前 ${st.phase}` } };
  }
  try {
    // ★ ReplayMarkCancel 参数为 None → 必须走 callOnChannel
    await vmix.callOnChannel('ReplayMarkCancel', opts.channel || st.channel, {}, { actor: opts.actor });
    // 丢弃后通道会回到什么模式由 vMix 决定，放弃基线让下次观测重新采纳
    rebaselineLive();
    st.clip.selectedEventId = null;
    st.clip.estimatedDurationMs = 0;
    st.clip.clippedAt = 0;
    set('replay.clip', { ...st.clip });
    st.cuedTransient = false;
    leaveTransient();
    if (st.phase !== 'AIR') setPhase(st.recording ? 'ARMED' : 'IDLE', 'discard');
    log.audit('replay', 'discard', { channel: opts.channel || st.channel, actor: opts.actor });
    return { ok: true };
  } catch (e) {
    return { ok: false, nack: { code: e.code || 'discard_failed', msg: e.message } };
  }
}

/** 延长尾部（开放出点模式）B-REQ-525 / B-REQ-533 */
export async function extendTail(opts = {}) {
  if (st.phase !== 'CUED' && st.phase !== 'AIR') {
    return { ok: false, nack: { code: 'bad_phase', msg: '延长尾部须处于 CUED 或 AIR' } };
  }
  try {
    await vmix.call('ReplayUpdateSelectedOutPoint', { Channel: opts.channel || st.channel }, { actor: opts.actor });
    log.audit('replay', 'extendTail', { channel: opts.channel || st.channel, actor: opts.actor });
    return { ok: true };
  } catch (e) {
    return { ok: false, nack: { code: e.code || 'extend_failed', msg: e.message } };
  }
}

/** 帧级微调 —— 单位是**帧**（陷阱 #19） */
export async function movePoint(which, frames, opts = {}) {
  if (st.phase !== 'CUED' && st.phase !== 'AIR') {
    return { ok: false, nack: { code: 'bad_phase', msg: '微调须处于 CUED 或 AIR（B-REQ-206）' } };
  }
  const fn = which === 'in' ? 'ReplayMoveSelectedInPoint' : 'ReplayMoveSelectedOutPoint';
  const frameRate = getConfig().clip.frameRate || 60;
  try {
    await vmix.call(fn, { Value: Math.round(frames), Channel: opts.channel || st.channel }, { actor: opts.actor });
    if (which === 'in') st.clip.inPointOffsetFrames += Math.round(frames);
    else st.clip.outPointOffsetFrames += Math.round(frames);
    set('replay.clip', { ...st.clip });
    log.audit('replay', `move ${which} point`, {
      frames, equivalentMs: Math.round((frames / frameRate) * 1000), frameRate, actor: opts.actor,
    });
    return { ok: true, equivalentMs: Math.round((frames / frameRate) * 1000) };
  } catch (e) {
    return { ok: false, nack: { code: e.code || 'move_failed', msg: e.message } };
  }
}

/** 入/出点跳转核对 —— 之后**必须**提醒回位（陷阱 #20 / B-REQ-527） */
export async function jumpToPoint(which, opts = {}) {
  if (st.phase !== 'CUED' && st.phase !== 'AIR') {
    return { ok: false, nack: { code: 'bad_phase', msg: '核对须处于 CUED 或 AIR' } };
  }
  const fn = which === 'in' ? 'ReplayJumpToSelectedInPoint' : 'ReplayJumpToSelectedOutPoint';
  const r = await execFunction(fn, { Channel: opts.channel || st.channel }, { actor: opts.actor });
  if (r.ok) return { ok: true, mustReturn: true, hint: '核对完成后必须按「跳回直播点」（ReplayJumpToNow），否则后续所有裁切起点都会错位' };
  return r;
}

export function isPlayheadDisplaced() { return playheadDisplaced; }

// ─────────────────────────────────────────────────────────────
// C 协同：arm / disarm / execute §5.11
// ─────────────────────────────────────────────────────────────

/** B-REQ-5109：登记的意图必须参与意图对账 */
export async function arm(intent) {
  if (!intent) return { ok: false, nack: { code: 'bad_intent', msg: '缺少 intent' } };
  const pf = await preflight({ for: intent === 'backToLive' ? 'backToLive' : (intent === 'clipOnly' ? 'clip' : intent) });
  if (!pf.ok) return { ok: false, nack: { code: 'preflight_failed', msg: pf.blockers.join('；'), blockers: pf.blockers } };
  st.intent.armed = true;
  st.intent.pending = intent;
  log.info('replay', `已登记待执行意图：${intent}`, { intent });
  return { ok: true, intent };
}

export function disarm() {
  st.intent.armed = false;
  st.intent.pending = null;
  return { ok: true };
}

export function getArmedIntent() { return st.intent.armed ? st.intent.pending : null; }

const INTENTS = new Set(['clipAndAir', 'clipOnly', 'air', 'backToLive']);

export async function execute(intent, opts = {}) {
  if (!INTENTS.has(intent)) return { ok: false, nack: { code: 'bad_intent', msg: `未知意图：${intent}` } };
  disarm();
  switch (intent) {
    case 'clipAndAir': return clipAndAir(opts);
    case 'clipOnly': return clip(opts);
    case 'air': return air(opts);
    case 'backToLive': return backToLive(opts);
    default: return { ok: false, nack: { code: 'bad_intent', msg: intent } };
  }
}

// ─────────────────────────────────────────────────────────────
// 浮窗联动（A-REQ-511 / C-REQ-592）
// ─────────────────────────────────────────────────────────────

function pushOverlay(mode, label) {
  try {
    overlayCtl?.push(mode, { label });
  } catch (e) {
    // G-REQ-112：模块 A 出问题绝不能影响 B
    log.warn('replay', '浮窗联动失败（已忽略）', { err: String(e?.message) });
  }
}

function pushHistory(rec) {
  const s = getState();
  s.replay.history = [rec, ...(s.replay.history || [])].slice(0, 50);
  set('replay.history', s.replay.history);
}

/** 引擎自检：返回内部状态快照（供 /replay 页与测试使用） */
export function snapshot() {
  return {
    phase: st.phase,
    transient: st.transient,
    cuedTransient: st.cuedTransient,
    busy: st.busy,
    recording: st.recording,
    channel: st.channel,
    eventList: st.eventList,
    speed: st.speed,
    fault: st.fault,
    observed: { ...st.observed },
    intent: { ...st.intent },
    clip: { ...st.clip },
    airEnded: st.airEnded,
    playheadDisplaced,
  };
}

export function setClipParams(patch = {}) {
  const cfg = getConfig();
  Object.assign(st.clip, {
    lookbackMs: patch.lookbackMs ?? st.clip.lookbackMs ?? cfg.clip.defaultLookbackMs,
    outPointMode: patch.outPointMode ?? st.clip.outPointMode ?? cfg.clip.defaultOutPointMode,
    fixedLengthMs: patch.fixedLengthMs ?? st.clip.fixedLengthMs ?? cfg.clip.fixedLengthMs,
  });
  set('replay.clip', { ...st.clip });
  return { ...st.clip };
}

export function setChannel(ch) {
  const c = String(ch).toUpperCase() === 'B' ? 'B' : 'A';
  st.channel = c;
  set('replay.channel', c);
  return c;
}

export function setEventList(n) {
  const i = Math.min(20, Math.max(1, Number(n) || 1));
  st.eventList = i;
  set('replay.eventList', i);
  return i;
}
