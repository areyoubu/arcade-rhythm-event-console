/**
 * WS 广播中枢 —— 实现 SRS §7.1 统一 WebSocket 协议。
 *
 * 需求：
 *   S-REQ-101  连接后立即下发 hello，携带全量状态，客户端无需额外请求
 *   S-REQ-102  状态变更走 patch 增量，禁止全量广播
 *   S-REQ-103  所有 cmd 必须有唯一 id 并回 ack/nack（超时 5s 视为失败）
 *   S-REQ-104  断线重连后须重新 hello 全量同步，服务端保留 30s 内的 patch 队列
 *   S-REQ-105  客户端连接后须先发 client:hello 声明受众频道
 *   S-REQ-106  服务端按受众过滤 cue 消息，不得向 cast 推送 floor 的提示
 *   S-REQ-107  cue:tick 须携带 serverAt
 *   S-REQ-108  提示删除须走显式 cue:remove
 *   S-REQ-109  截图模式帧走二进制通道，不得 base64 塞进 JSON
 *   S-REQ-110  所有消息须 UTF-8 安全
 *   B-REQ-303  连接状态经 WS 广播至所有控制台页面，延迟 ≤1s
 *   A-REQ-603  渲染端须上报 overlay:ready，控制端据此显示"渲染端已连接"
 *   A-REQ-604  控制端须能区分「指令已发」与「已渲染」
 *   C-REQ-1002 / G-REQ-112  任一模块崩溃不得影响其余模块
 */
import { WebSocketServer } from 'ws';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { getState, stateEvents } from './state.js';
import { getConfig } from './config.js';
import { adminAuthEnabled, verifyAdminSecret } from './admin-auth.js';
import * as log from './logger.js';

export const hubEvents = new EventEmitter();

const PATCH_QUEUE_TTL_MS = 30_000;   // S-REQ-104
const CMD_TIMEOUT_MS = 5_000;        // S-REQ-103
const HEARTBEAT_MS = 15_000;

/** @type {Set<Client>} */
const clients = new Set();
/** 30s 内的 patch 队列，供重连客户端补发 */
const patchQueue = [];
/** 命令处理器注册表：op -> { handler, audience?, minRole? } */
const ops = new Map();

let seq = 0;
let heartbeatTimer = null;

/**
 * 注册一个命令处理器。
 * handler(ctx, args) 返回值约定：
 *   正常 → 任意可序列化值（作为 ack.data）
 *   失败 → 抛 Error，或用 { __nack: code, msg } 返回
 * 需求 B-REQ-5110：对外命令必须返回明确 ok / nack{code,msg}
 */
export function registerOp(op, handler, meta = {}) {
  if (typeof handler !== 'function') throw new TypeError(`registerOp(${op}) 需要一个函数`);
  ops.set(op, { handler, ...meta });
}

export function listOps() { return [...ops.keys()]; }

/**
 * 一次性初始化 —— 共享事件订阅与心跳。
 *
 * ⚠️ 本函数**必须**只执行一次。服务同时监听两个端口（SRS §2.1 的 :3000 / :3001），
 * 早期实现把订阅写在 attach() 里，结果每多监听一个端口就多注册一份监听器：
 * 每条 patch 被广播 2 次、心跳定时器泄漏一个、客户端白白处理一倍消息。
 */
let sharedReady = false;
function initShared() {
  if (sharedReady) return;
  sharedReady = true;

  // 订阅共享状态源 → 广播 patch
  stateEvents.on('patch', (path, value) => broadcastPatch(path, value));
  stateEvents.on('batch', (entries) => { for (const [p, v] of entries) broadcastPatch(p, v); });

  // 日志实时下发给所有页面（/logs 页用）
  log.logEvents.on('log', (rec) => {
    if (rec.level === 'debug') return;
    broadcast({ t: 'log', level: rec.level, msg: rec.msg, at: rec.at, source: rec.source, op: rec.op, result: rec.result, durationMs: rec.durationMs });
  });

  heartbeatTimer = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) { try { c.ws.terminate(); } catch { /* ignore */ } clients.delete(c); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch { /* ignore */ }
    }
    updateClientCounts();
  }, HEARTBEAT_MS);
  heartbeatTimer.unref?.();

  log.debug('server', 'WS 广播中枢已初始化（共享订阅只注册一次）');
}

export function attach(server, { path = '/ws' } = {}) {
  initShared();
  const wss = new WebSocketServer({ server, path, perMessageDeflate: false });

  wss.on('connection', (ws, req) => {
    /** @type {Client} */
    const client = {
      id: randomUUID(),
      ws,
      audience: null,
      target: null,          // 渲染端：main | credits
      ua: req.headers['user-agent'] || '',
      ip: req.socket.remoteAddress,
      connectedAt: Date.now(),
      audioUnlocked: false,
      lastAckAt: null,
      alive: true,
    };
    clients.add(client);
    log.debug('server', 'WS 客户端接入', { clientId: client.id.slice(0, 8), ip: client.ip });
    log.netlog({
      kind: 'ws-connect',
      ip: String(client.ip || '').replace(/^::ffff:/, ''),
      ua: String(client.ua || '').slice(0, 300),
      clientId: client.id.slice(0, 8),
    });

    ws.on('pong', () => { client.alive = true; });

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return; // 现阶段客户端不上行二进制
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return sendNack(client, null, 'bad_json', '消息不是合法 JSON'); }
      handleMessage(client, msg).catch((e) => {
        log.warn('server', 'WS 消息处理异常', { clientId: client.id.slice(0, 8), err: String(e && e.message) });
      });
    });

    ws.on('close', () => {
      clients.delete(client);
      hubEvents.emit('client:gone', client);
      updateClientCounts();
      log.debug('server', 'WS 客户端断开', { clientId: client.id.slice(0, 8), audience: client.audience, target: client.target });
      log.netlog({
        kind: 'ws-close',
        ip: String(client.ip || '').replace(/^::ffff:/, ''),
        audience: client.audience || '',
        target: client.target || '',
        clientId: client.id.slice(0, 8),
        durationMs: Date.now() - client.connectedAt,
      });
    });

    ws.on('error', () => { /* close 会跟着来 */ });
  });

  return wss;
}

export function detach() { if (heartbeatTimer) clearInterval(heartbeatTimer); }

/**
 * 密码变更后让已连接的控制端重新鉴权。
 * 渲染源（target 已声明）只需要读状态，不受影响。
 */
export function invalidateAuth() {
  for (const c of clients) {
    if (!c.authOk) continue;
    if (c.isRenderer || c.target) continue; // OBS 浏览器源不执行控制命令
    c.authOk = false;
  }
}

// ─────────────────────────────────────────────────────────────
// 消息处理
// ─────────────────────────────────────────────────────────────

async function handleMessage(client, msg) {
  if (!msg || typeof msg.t !== 'string') return;

  switch (msg.t) {
    case 'client:hello': {                 // S-REQ-105
      client.audience = typeof msg.audience === 'string' ? msg.audience : null;
      client.target = typeof msg.target === 'string' ? msg.target : null;
      client.ua = msg.ua || client.ua;
      client.role = msg.role || null;
      // ★ 控制命令鉴权：渲染源不需要 token；控制页面必须带后台密码
      client.authOk = verifyAdminSecret(msg.token);
      updateClientCounts();
      hubEvents.emit('client:hello', client, msg);
      sendHello(client);                   // S-REQ-101：全量快照即权威状态，无需再补历史增量
      return;
    }

    case 'sub':                            // 订阅（当前实现为全量订阅，保留接口）
      return;

    case 'cmd':                            // S-REQ-103
      return handleCmd(client, msg);

    // ── 模块 A：渲染端上行 ──
    case 'overlay:ready':                  // A-REQ-603
      client.target = typeof msg.target === 'string' ? msg.target : client.target;
      client.isRenderer = true;
      hubEvents.emit('overlay:ready', client, msg);
      updateClientCounts();
      return;

    case 'overlay:rendered':               // A-REQ-604
      hubEvents.emit('overlay:rendered', client, msg);
      return;

    case 'overlay:error':
      log.warn('overlay', '渲染端上报错误', { code: msg.code, msg: msg.msg, target: msg.target });
      return;

    // ── 模块 C：受众端上行 ──
    case 'ack':                            // C-REQ-550
      client.lastAckAt = Date.now();
      hubEvents.emit('cue:ack', client, msg);
      return;

    case 'audio:unlocked':                 // C-REQ-565
      client.audioUnlocked = !!msg.ok;
      hubEvents.emit('audio:unlocked', client, msg);
      updateClientCounts();
      return;

    case 'audience:claim':
      client.audience = msg.audience;
      updateClientCounts();
      return;

    default:
      log.debug('server', '未知 WS 消息类型', { t: msg.t });
  }
}

async function handleCmd(client, msg) {
  const { id, op, args } = msg;
  if (typeof id !== 'string' || !id) return;          // 无 id 不回，避免协议噪声
  if (typeof op !== 'string') return sendNack(client, id, 'bad_op', 'op 必须是字符串');

  // ★ 启用后台密码后，WS 控制命令也必须先通过 client:hello 携带正确密码。
  //   否则公网只需连 WebSocket 就能绕开 HTTP 鉴权控制直播。
  if (adminAuthEnabled() && !client.authOk) {
    log.netlog({ kind: 'ws-unauthorized', ip: String(client.ip || '').replace(/^::ffff:/, ''), op });
    return sendNack(client, id, 'unauthorized', '需要后台登录密码');
  }

  const entry = ops.get(op);
  if (!entry) return sendNack(client, id, 'unknown_op', `未注册的命令：${op}`);

  if (entry.audience && client.audience && !entry.audience.includes(client.audience)) {
    return sendNack(client, id, 'forbidden', `受众 ${client.audience} 无权执行 ${op}`);
  }

  // 功能开关（默认全关）：未启用的功能一律 nack，避免前端残留按钮误触
  if (entry.feature && !getConfig().features?.[entry.feature]) {
    return sendNack(client, id, 'feature_disabled',
      `「${entry.featureLabel || entry.feature}」未启用：请到 设置 → 功能开关 开启`);
  }

  const t0 = process.hrtime.bigint();
  try {
    const data = await Promise.race([
      Promise.resolve(entry.handler(client, args)),
      new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('命令超时'), { code: 'timeout' })), CMD_TIMEOUT_MS).unref?.()),
    ]);
    const durationMs = Number(process.hrtime.bigint() - t0) / 1e6;
    if (data && data.__nack) return sendNack(client, id, data.__nack, data.msg);
    send(client, { t: 'ack', id, ok: true, op, data: data === undefined ? null : data, durationMs });
  } catch (e) {
    const durationMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const code = e?.code || 'error';
    sendNack(client, id, code, e?.message || String(e));
    log.warn('server', `命令失败：${op}`, { op, code, msg: e?.message, durationMs });
  }
}

// ─────────────────────────────────────────────────────────────
// 下发
// ─────────────────────────────────────────────────────────────

export function send(client, msg) {
  if (!client?.ws || client.ws.readyState !== 1) return false;
  try { client.ws.send(JSON.stringify(msg)); return true; } catch { return false; }
}

export function sendNack(client, id, code, msg) {
  if (!id) return;
  send(client, { t: 'nack', id, ok: false, code, msg });
}

/** 全量状态下发（S-REQ-101） */
function sendHello(client) {
  send(client, {
    t: 'hello',
    state: getState(),
    serverAt: Date.now(),
    ops: [...ops.entries()].map(([op, e]) => ({ op, audience: e.audience || null })).filter((x) => !x.audience || !client.audience || x.audience.includes(client.audience)).map((x) => x.op),
  });
}

function broadcastPatch(path, value) {
  const msg = { t: 'patch', path, value };
  patchQueue.push({ msg, at: Date.now() });
  const cutoff = Date.now() - PATCH_QUEUE_TTL_MS;
  while (patchQueue.length && patchQueue[0].at < cutoff) patchQueue.shift();

  // S-REQ-106：cue.* 按受众过滤；其余状态广播给所有非渲染端
  const { filtered, targets } = filterPatchForClients(path, value);
  if (filtered === null || !targets.length) return;
  broadcastTo(targets, filtered);
}

/**
 * patch 过滤：模块 C 的提示状态只发给对应受众。
 * 渲染端（OBS 浏览器源）只关心 overlay.* 与 config.render.*。
 */
function filterPatchForClients(path, value) {
  const all = [...clients];

  // 渲染端只收 overlay 相关（省带宽、避免无关重绘）
  const nonRenderers = all.filter((c) => !c.isRenderer);

  if (!path.startsWith('cue.')) {
    if (path.startsWith('overlay.')) {
      // 比分条渲染端只认 score:state，不需要叠加模板的 patch —— 省一点带宽与解码
      const targets = all.filter((c) => c.target !== 'score');
      return { filtered: { t: 'patch', path, value }, targets };
    }
    return { filtered: { t: 'patch', path, value }, targets: nonRenderers };
  }

  // §C-REQ-106：cue.active 是跨受众的完整 map，**不能**整体下发 ——
  // 否则 cast 会在自己的状态镜像里看到 floor 的提示内容。
  // 各受众的真实可见集由 cue:set 单独推送（服务端已做仲裁与过滤），
  // 所以这里直接跳过，而不是发一个占位值污染客户端状态。
  if (path === 'cue.active' || path === 'cue.alert') {
    return { filtered: null, targets: [] };
  }
  return { filtered: { t: 'patch', path, value }, targets: nonRenderers };
}

export function broadcast(msg, filter) {
  for (const c of clients) {
    if (filter && !filter(c)) continue;
    send(c, msg);
  }
}

export function broadcastTo(targets, msg) {
  for (const c of targets) send(c, msg);
}

/** 只发给某受众（S-REQ-106） */
export function toAudience(audiences, msg) {
  const set = new Set(Array.isArray(audiences) ? audiences : [audiences]);
  for (const c of clients) if (c.audience && set.has(c.audience)) send(c, msg);
}

/** 只发给渲染端（模块 A 的 OBS 浏览器源） */
export function toRenderers(msg, target) {
  for (const c of clients) {
    if (!c.isRenderer) continue;
    if (target && c.target !== target) continue;
    send(c, msg);
  }
}

/** 只发给控制端（非渲染端、非受众端） */
export function toControllers(msg) {
  for (const c of clients) if (!c.isRenderer) send(c, msg);
}

/** S-REQ-109：截图帧走二进制通道 */
export function pushFrame(audience, buffer) {
  for (const c of clients) {
    if (c.audience !== audience) continue;
    if (c.ws.readyState !== 1 || c.ws.bufferedAmount > 2_000_000) continue; // 背压保护
    try { c.ws.send(buffer, { binary: true }); } catch { /* ignore */ }
  }
}

/**
 * S-REQ-104：「断线重连后须重新 hello 全量同步，服务端保留 30s 内的 patch 队列」。
 *
 * 实现取舍 —— **保留队列但不在重连时回放**：
 *
 * `hello` 携带的是**完整且权威**的当前状态快照。如果再叠加回放队列里的历史 patch，
 * 就等于「先应用最新快照，再往上盖 30s 内的旧增量」——队列里恰好含有某个路径
 * 的旧值时，会把客户端已经拿到的新状态改回旧值。实测表现为新建连接会收到
 * 每条 patch 两次（一次实时广播、一次队列回放），且值可能更旧。
 *
 * 需求真正要防的是「重连后漏掉更新」，而 hello 的全量同步已经完整覆盖了这一点，
 * 所以回放是多余且有害的。队列本身仍保留（有界、可观测），用于排障时回溯最近的变更序列。
 */
export function patchQueueSnapshot(limit = 50) {
  return patchQueue.slice(-limit).map((x) => ({ path: x.msg.path, at: x.at }));
}
export function patchQueueDepth() { return patchQueue.length; }

// ─────────────────────────────────────────────────────────────
// 客户端查询
// ─────────────────────────────────────────────────────────────

export function getClients() { return [...clients]; }
export function getRenderers() { return [...clients].filter((c) => c.isRenderer); }
export function countRenderers() { return getRenderers().length; }

export function audienceStats() {
  const out = {};
  const audio = {};
  for (const c of clients) {
    if (!c.audience) continue;
    out[c.audience] = (out[c.audience] || 0) + 1;
    audio[c.audience] = audio[c.audience] || { total: 0, unlocked: 0 };
    audio[c.audience].total++;
    if (c.audioUnlocked) audio[c.audience].unlocked++;
  }
  return { counts: out, audio };
}

/** 客户端注册表快照，供导播页回执看板与「哪些解说端未启用声音」使用 */
export function clientRegistry() {
  const out = {};
  for (const c of clients) {
    if (!c.audience) continue;
    (out[c.audience] ||= {})[c.id] = {
      clientId: c.id,
      audience: c.audience,
      connectedAt: c.connectedAt,
      audioUnlocked: c.audioUnlocked,
      lastAckAt: c.lastAckAt,
      ua: c.ua,
    };
  }
  return out;
}

function updateClientCounts() {
  const { counts, audio } = audienceStats();
  stateEvents.emit('patch', 'health.overlayClients', countRenderers());
  stateEvents.emit('patch', 'cue.counts', counts);
  stateEvents.emit('patch', 'cue.audio', audio);
  stateEvents.emit('patch', 'cue.clients', clientRegistry());
}

export function closeAll() {
  for (const c of clients) { try { c.ws.close(); } catch { /* ignore */ } }
  clients.clear();
}

export { CMD_TIMEOUT_MS, PATCH_QUEUE_TTL_MS };
