/**
 * vMix HTTP API 客户端。
 *
 * 需求：
 *   B-REQ-1001  所有调用走 http://{host}:{port}/api/?Function=X&Param=Y，UTF-8 编码
 *   B-REQ-1002  单次请求超时 4s；超时计入失败计数
 *   B-REQ-1003  成功判定为 HTTP 200（官方：成功 200，出错 500）
 *   B-REQ-1004  连续失败 ≥3 标记链路不健康，≥5 停用回放宏并告警
 *   B-REQ-1005  vMix HTTP API 无鉴权 —— 代码层面不做认证，部署层面靠防火墙限定远程 IP
 *   B-REQ-1006  所有 None 参数函数必须先 ReplaySelectChannel{A|B}（见 callOnChannel）
 *   B-REQ-301   每 2s 心跳（不带参数的 GET /api/），失败计数 ≥3 转 disconnected
 *   B-REQ-808   vMix 无出站 webhook → 回放状态只能靠轮询 XML 获取
 */
import { EventEmitter } from 'node:events';
import { getConfig } from '../config.js';
import { set } from '../state.js';
import * as log from '../logger.js';
import { FN_MAP, NEEDS_CHANNEL, REPLAY_STOP_IS_NOT_A_FUNCTION } from './functions.js';

export const vmixEvents = new EventEmitter();

let lastOk = 0;
let lastErr = null;
let failCount = 0;
let connected = false;
let heartbeatTimer = null;
let lastRttMs = 0;
/** 连续失败达到此值后停用回放宏（B-REQ-1004） */
const UNHEALTHY_AT = 3;
const DISABLED_AT = 5;

// ─────────────────────────────────────────────────────────────
// 底层调用
// ─────────────────────────────────────────────────────────────

function baseUrl() {
  const c = getConfig();
  return `http://${c.vmix.host}:${c.vmix.port}`;
}

/**
 * 执行一次 vMix API 调用（**对外入口**，带安全闸）。
 *
 * ⚠️ 这里的两道闸只拦「裸调」；`callOnChannel()` 走的是内部 `performCall()`，
 * 因此它才能合法地发出这些函数。曾经把闸设在传输层，结果 callOnChannel 自己也被拦住。
 *
 * @param {string} fn vMix 函数名
 * @param {Record<string, string|number>} [params]
 * @param {{timeoutMs?:number, silent?:boolean, actor?:string}} [opts]
 */
export async function call(fn, params = {}, opts = {}) {
  // ✅ B-REQ-405 防误用：ReplayStop 不是有效函数，拦在发出去之前
  if (fn === REPLAY_STOP_IS_NOT_A_FUNCTION.wrong) {
    const e = new Error(
      `"${REPLAY_STOP_IS_NOT_A_FUNCTION.wrong}" 不是有效的 vMix 函数；停止播放请用 ` +
      `"${REPLAY_STOP_IS_NOT_A_FUNCTION.correct}"。（已核验官方函数列表）`,
    );
    e.code = 'invalid_function';
    log.error('vmix', e.message, { op: fn });
    throw e;
  }

  // B-REQ-1006：None 参数函数禁止裸调
  if (NEEDS_CHANNEL.includes(fn)) {
    const e = new Error(
      `函数 ${fn} 的官方参数为 None，作用于**当前选中通道**，必须先 ReplaySelectChannel{A|B}。` +
      `请改用 vmix.callOnChannel()（B-REQ-1006 / 陷阱 #18）`,
    );
    e.code = 'needs_channel';
    log.error('vmix', e.message, { op: fn });
    throw e;
  }

  return performCall(fn, params, opts);
}

/**
 * 真正发请求的地方 —— 不做安全闸，只负责构造 URL、超时、失败计数与审计。
 * **不要直接导出**：绕过闸门就等于放弃陷阱 #6 / #18 的防护。
 */
async function performCall(fn, params = {}, opts = {}) {
  const cfg = getConfig();
  // 功能开关关闭时**一个请求都不发**：既避免现场误操作，也避免对着一台不存在的设备刷失败计数
  if (!cfg.features?.vmix) {
    throw Object.assign(new Error('vMix 控制未启用：请到 设置 → 功能开关 开启'), { code: 'feature_disabled', fn });
  }
  const timeoutMs = opts.timeoutMs ?? cfg.replay.vmixTimeoutMs;
  const url = new URL('/api/', baseUrl());
  url.searchParams.set('Function', fn);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, String(v));
  }

  const t0 = process.hrtime.bigint();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: '*/*' } });
    const body = await res.text();
    const durationMs = Number(process.hrtime.bigint() - t0) / 1e6;
    lastRttMs = durationMs;

    if (!res.ok) {
      // 官方：出错返回 500
      throw Object.assign(new Error(`vMix 返回 HTTP ${res.status}${body ? `：${body.slice(0, 200)}` : ''}`), { code: `http_${res.status}` });
    }

    markOk(durationMs);
    if (!opts.silent) {
      log.audit('vmix', fn, { params, result: 'ok', durationMs: Math.round(durationMs), actor: opts.actor });
    }
    vmixEvents.emit('call', { fn, params, ok: true, durationMs });
    return { ok: true, durationMs, body };
  } catch (e) {
    const durationMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const msg = e.name === 'AbortError' ? `请求超时（${timeoutMs}ms）` : e.message;
    markFail(msg);
    log.error('vmix', `vMix 调用失败：${fn}`, { op: fn, params, err: msg, durationMs: Math.round(durationMs), actor: opts.actor });
    vmixEvents.emit('call', { fn, params, ok: false, err: msg, durationMs });
    throw Object.assign(new Error(msg), { code: e.code || 'vmix_error', fn });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ★ B-REQ-1006 / B-REQ-523 的强制实现。
 *
 * 所有「官方参数为 None」的函数（ReplayMarkIn / ReplayMarkOut / ReplayMarkCancel /
 * ReplayMarkInLive / ReplayMarkInRecorded / ReplayMarkInRecordedNow）作用于**当前选中通道**。
 * 不先选通道就调用，会砍掉**另一个通道**上的事件 —— 陷阱 #18，本项目最高危陷阱之一。
 *
 * 本函数先发 ReplaySelectChannel{A|B}，再发目标函数，永不裸调。
 *
 * @param {string} fn
 * @param {'A'|'B'} channel
 * @param {Record<string,string|number>} [params]
 * @param {{actor?:string}} [opts]
 */
export async function callOnChannel(fn, channel, params = {}, opts = {}) {
  const ch = normalizeChannel(channel);
  if (!ch || ch === 'AB') {
    throw Object.assign(new Error(`callOnChannel 需要明确的通道 A 或 B，收到 "${channel}"`), { code: 'bad_channel' });
  }
  // 先选通道（这一步本身也必须绕过闸门，否则会自我阻断）
  await performCall(ch === 'A' ? 'ReplaySelectChannelA' : 'ReplaySelectChannelB', {}, { silent: true, actor: opts.actor });
  log.audit('vmix', `selectChannel:${ch}`, { reason: `为 ${fn} 显式选通道（B-REQ-523）`, actor: opts.actor });
  return performCall(fn, params, opts);
}

/** 把「当前选中通道」设为指定值（宏序列的第一步） */
export async function selectChannel(channel, opts = {}) {
  const ch = normalizeChannel(channel);
  const fn = ch === 'A' ? 'ReplaySelectChannelA' : ch === 'B' ? 'ReplaySelectChannelB' : 'ReplaySelectChannelAB';
  await call(fn, {}, { silent: true, ...opts });
  set('replay.channel', ch === 'AB' ? 'A' : ch);
  return ch;
}

function normalizeChannel(c) {
  const s = String(c || '').trim().toUpperCase();
  if (s === 'A' || s === 'B' || s === 'AB') return s;
  return null;
}

// ─────────────────────────────────────────────────────────────
// 健康 / 心跳
// ─────────────────────────────────────────────────────────────

function markOk(durationMs) {
  lastOk = Date.now();
  if (!connected) {
    connected = true;
    set('health.vmix.connected', true);
    set('health.vmix.lastOk', lastOk);
    set('health.vmix.lastErr', null);
    log.info('vmix', 'vMix 已连接', { rttMs: Math.round(durationMs) });
  }
  if (failCount > 0) {
    log.info('vmix', 'vMix 链路恢复', { previousFailures: failCount });
    failCount = 0;
    set('health.vmix.failCount', 0);
  }
  set('health.vmix.rttMs', Math.round(lastRttMs));
  set('health.vmix.lastOk', lastOk);
  lastErr = null;
}

function markFail(msg) {
  failCount++;
  lastErr = msg;
  set('health.vmix.failCount', failCount);
  set('health.vmix.lastErr', msg);
  if (failCount === UNHEALTHY_AT) {
    log.warn('vmix', 'vMix 链路标记为不健康', { failCount });
    vmixEvents.emit('unhealthy', failCount);
  }
  if (failCount >= DISABLED_AT && connected) {
    connected = false;
    set('health.vmix.connected', false);
    log.error('vmix', 'vMix 链路断开，回放宏已停用', { failCount, err: msg });
    vmixEvents.emit('disabled', failCount);
  }
}

export function isConnected() { return connected; }
export function isHealthy() { return connected && failCount < UNHEALTHY_AT; }
export function isMacroEnabled() { return connected && failCount < DISABLED_AT; }
export function getStatus() {
  return { connected, healthy: isHealthy(), failCount, lastOk, lastErr, rttMs: Math.round(lastRttMs) };
}

/** B-REQ-301：不带参数的 GET /api/ 心跳 */
export function startHeartbeat() {
  stopHeartbeat();
  const tick = async () => {
    const cfg = getConfig();
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), cfg.replay.vmixTimeoutMs);
      const t0 = process.hrtime.bigint();
      const res = await fetch(new URL('/api/', baseUrl()), { signal: controller.signal });
      clearTimeout(t);
      await res.text();
      lastRttMs = Number(process.hrtime.bigint() - t0) / 1e6;
      if (res.ok) markOk(lastRttMs);
      else markFail(`HTTP ${res.status}`);
    } catch (e) {
      markFail(e.name === 'AbortError' ? '心跳超时' : e.message);
    }
    const next = getConfig().replay.hwHeartbeatMs;
    if (heartbeatTimer) heartbeatTimer = setTimeout(tick, Math.max(500, next));
  };
  // 立即跑一次，让启动预检立刻拿到状态（B-REQ-305）
  tick();
  heartbeatTimer = setTimeout(tick, getConfig().replay.hwHeartbeatMs);
  heartbeatTimer.unref?.();
}

export function stopHeartbeat() {
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  heartbeatTimer = null;
}

/**
 * 功能开关关闭时调用：停止心跳并把链路状态复位。
 * stopHeartbeat 只停定时器，connected 可能还是 true（上个 tick 成功过）；
 * 这里必须把它改成 false，否则首页会一直显示「已连接」而实际已不再探测。
 */
export function stop() {
  stopHeartbeat();
  connected = false;
  failCount = 0;
  lastErr = null;
  set('health.vmix.connected', false);
  set('health.vmix.failCount', 0);
}

/** 地址变更后立即用新地址重连（设置页保存时调用） */
export function reconnect() {
  log.info('vmix', 'vMix 地址变更，重新探测', { host: getConfig().vmix.host, port: getConfig().vmix.port });
  connected = false;
  failCount = 0;
  set('health.vmix.connected', false);
  set('health.vmix.failCount', 0);
  startHeartbeat();
}

// ─────────────────────────────────────────────────────────────
// 探测（供设置页「测试连接」）
// ─────────────────────────────────────────────────────────────

export async function probe({ host, port } = {}) {
  const cfg = getConfig();
  const h = host || cfg.vmix.host;
  const p = port || cfg.vmix.port;
  const t0 = process.hrtime.bigint();
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`http://${h}:${p}/api/`, { signal: controller.signal });
    const xml = await res.text();
    clearTimeout(t);
    const rttMs = Number(process.hrtime.bigint() - t0) / 1e6;
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, rttMs };

    // 顺带探测回放输入，给用户更明确的反馈
    const replayMatch = /<input\b[^>]*type="Replay"[^>]*>/i.exec(xml);
    let replayInfo = null;
    if (replayMatch) {
      const attrs = parseAttrs(replayMatch[0]);
      replayInfo = {
        title: attrs.title || '',
        number: attrs.number || '',
        state: attrs.state || '',
        duration: attrs.duration || '',
      };
    }
    const version = (/<version>([^<]*)<\/version>/i.exec(xml) || [])[1] || '';
    return { ok: true, rttMs, version, replayInput: replayInfo, hasReplay: !!replayMatch };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '请求超时（4s）' : e.message };
  }
}

function parseAttrs(tag) {
  const out = {};
  const re = /([\w-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(tag))) out[m[1]] = m[2];
  return out;
}
