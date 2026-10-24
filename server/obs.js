/**
 * OBS WebSocket 客户端（obs-websocket v5, rpcVersion 1）—— 自实现。
 *
 * 为什么不直接用 obs-websocket-js：
 *   B-REQ-306 ✅ 该库**不提供自动重连**（只发 ConnectionOpened/Closed/Error 事件），
 *   必须自行实现；且不可用「轮询写命令」探测连接（会污染操作日志与状态）。
 *   自实现可完全掌控握手、重连退避、请求配对与事件订阅位图。
 *
 * 需求：
 *   B-REQ-302  自动重连，退避 1s→2s→4s→8s→上限 10s
 *   B-REQ-303  连接状态经 WS 广播，延迟 ≤1s
 *   B-REQ-305  启动预检：场景存在性、源存在性
 *   B-REQ-1101 转场完成判定「事件 + 超时兜底」双保险（事件源在此）
 *   C-REQ-587  订阅 SceneTransitionStarted/Ended/CurrentProgramSceneChanged/InputMuteStateChanged
 */
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { getConfig } from './config.js';
import { set } from './state.js';
import * as log from './logger.js';

export const obsEvents = new EventEmitter();

/** obs-websocket v5 事件订阅位图 */
export const EventSubscription = {
  None: 0,
  General: 1 << 0,
  Config: 1 << 1,
  Scenes: 1 << 2,
  Inputs: 1 << 3,
  Transitions: 1 << 4,
  Filters: 1 << 5,
  Outputs: 1 << 6,
  SceneItems: 1 << 7,
  MediaInputs: 1 << 8,
  Vendors: 1 << 9,
  Ui: 1 << 10,
  All: (1 << 11) - 1,
};

/** 本项目实际需要的事件位（够用且省带宽） */
const NEEDED_SUBS =
  EventSubscription.General | EventSubscription.Config | EventSubscription.Scenes |
  EventSubscription.Inputs | EventSubscription.Transitions | EventSubscription.Outputs |
  EventSubscription.SceneItems;

const REQUEST_TIMEOUT_MS = 5000;
const BACKOFF = [1000, 2000, 4000, 8000, 10000];   // B-REQ-302
const CLOSE_AUTH_FAILED = 4009;

let ws = null;
let connected = false;
let identified = false;
let identifiedResolve = null;
let attempt = 0;
let reconnectTimer = null;
let intentionalClose = false;
let lastErr = null;
let obsVersion = null;

const pending = new Map();   // requestId -> { resolve, reject, timer, requestType }

// ─────────────────────────────────────────────────────────────
// 连接管理
// ─────────────────────────────────────────────────────────────

export function isConnected() { return connected && identified; }
export function getVersion() { return obsVersion; }
export function getLastError() { return lastErr; }

export function start() {
  intentionalClose = false;
  // 幂等：功能开关重复应用（保存设置、地址变更）时不能叠出第二条连接
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  connect();
}

export function stop() {
  intentionalClose = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (ws) { try { ws.close(1000, 'client shutdown'); } catch { /* ignore */ } }
  ws = null;
  setConnected(false);
}

function connect() {
  clearTimeout(reconnectTimer);
  const cfg = getConfig();
  const url = `ws://${cfg.obs.host}:${cfg.obs.port}`;

  try {
    ws = new WebSocket(url, { handshakeTimeout: 5000 });
  } catch (e) {
    scheduleReconnect(`无法创建连接：${e.message}`);
    return;
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
    handleOp(msg).catch((e) => log.warn('obs', 'OBS 消息处理异常', { err: String(e?.message) }));
  });

  ws.on('close', (code, reasonBuf) => {
    const reason = reasonBuf?.toString?.('utf8') || '';
    const wasIdentified = identified;

    // 关闭前把所有在途请求拒掉，避免调用方永久挂起
    for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error('OBS 连接已断开'), { code: 'obs_disconnected' })); pending.delete(id); }

    setConnected(false);

    if (intentionalClose) return;

    // obs-websocket 的鉴权失败用 4009 关闭 —— 重连无意义，但仍要退避避免刷日志
    if (code === CLOSE_AUTH_FAILED) {
      lastErr = 'OBS 鉴权失败：密码不正确（OBS → 工具 → WebSocket 服务器设置）';
      log.error('obs', lastErr, { code });
    } else {
      lastErr = `连接关闭（code=${code}${reason ? ` ${reason}` : ''}）`;
      if (wasIdentified) log.warn('obs', 'OBS 连接断开，将自动重连', { code, reason });
    }
    scheduleReconnect(lastErr);
  });

  ws.on('error', (e) => {
    lastErr = e?.message || String(e);
    log.debug('obs', 'OBS 连接错误', { err: lastErr });
  });
}

function scheduleReconnect(reason) {
  if (intentionalClose) return;
  const delay = BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
  attempt++;
  set('health.obs.lastErr', reason);
  log.info('obs', `将在 ${delay}ms 后重连 OBS`, { attempt, reason });
  reconnectTimer = setTimeout(connect, delay);
  reconnectTimer.unref?.();
}

/**
 * 同步连接标志。**只有这里能改 `connected`** —— 任何绕过它的赋值都会让
 * `isConnected()` 与实际状态脱节（曾表现为：日志显示已连接，但预检一直报 OBS 未连接）。
 */
function setConnected(v) {
  if (connected === v) return;
  connected = v;
  if (!v) {
    identified = false;
    obsVersion = null;
    set('health.obs.version', null);
  }
  set('health.obs.connected', isConnected());
}

// ─────────────────────────────────────────────────────────────
// 握手
// ─────────────────────────────────────────────────────────────

async function handleOp(msg) {
  const { op, d } = msg;

  switch (op) {
    case 0: { // Hello
      const auth = d.authentication;
      const cfg = getConfig();
      const identify = { rpcVersion: 1, eventSubscriptions: NEEDED_SUBS };

      if (auth) {
        if (!cfg.obs.password) {
          lastErr = 'OBS 启用了鉴权，但配置中未填写密码';
          log.error('obs', lastErr);
        }
        identify.authentication = buildAuth(cfg.obs.password || '', auth.salt, auth.challenge);
      }

      log.debug('obs', '收到 OBS Hello', { version: d.obsWebSocketVersion, rpcVersion: d.rpcVersion, auth: !!auth });
      ws.send(JSON.stringify({ op: 1, d: identify }));
      return;
    }

    case 2: { // Identified
      if (d.negotiatedRpcVersion === undefined) return;
      identified = true;
      // 必须走 setConnected —— 它才是同步模块级 connected 标志的唯一入口，
      // 否则 isConnected()（= connected && identified）会一直是 false，
      // 表现为「日志说已连接，但所有依赖 OBS 的操作都被预检拦下」。
      setConnected(true);
      set('health.obs.lastOk', Date.now());
      set('health.obs.lastErr', null);
      lastErr = null;
      attempt = 0;
      log.info('obs', 'OBS 已连接', { rpcVersion: d.negotiatedRpcVersion });
      obsEvents.emit('identified');
      identifiedResolve?.();
      // 连接后立即拉一次版本与场景，供状态条与预检使用
      refreshBasics().catch(() => { /* 已在内部记录 */ });
      return;
    }

    case 5: { // Event
      handleEvent(d);
      return;
    }

    case 7: { // RequestResponse
      const p = pending.get(d.requestId);
      if (!p) return;
      pending.delete(d.requestId);
      clearTimeout(p.timer);
      if (d.requestStatus?.result) {
        p.resolve(d.responseData || {});
      } else {
        const err = new Error(`OBS 请求失败：${d.requestType}（code=${d.requestStatus?.code}）`);
        err.code = `obs_${d.requestStatus?.code}`;
        err.requestType = d.requestType;
        p.reject(err);
      }
      return;
    }

    default:
      return;
  }
}

/** obs-websocket v5 鉴权：base64( sha256( base64( sha256( password + salt ) ) + challenge ) ) */
function buildAuth(password, salt, challenge) {
  const secret = createHash('sha256').update(password + salt).digest('base64');
  return createHash('sha256').update(secret + challenge).digest('base64');
}

// ─────────────────────────────────────────────────────────────
// 请求
// ─────────────────────────────────────────────────────────────

/**
 * 发送一个 OBS 请求。连接不可用时**立即** reject（不排队），
 * 让上层能马上禁用按钮并给出原因（B-REQ-304）。
 */
export function request(requestType, requestData = {}, { timeoutMs = REQUEST_TIMEOUT_MS, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    // 功能开关关闭时连都不连，任何请求都必须立刻失败并说清原因（而不是伪装成「未连接」）
    if (!getConfig().features?.obs) {
      return reject(Object.assign(new Error('OBS 控制未启用：请到 设置 → 功能开关 开启'), { code: 'feature_disabled' }));
    }
    if (!isConnected()) {
      return reject(Object.assign(new Error(`OBS 未连接${lastErr ? `：${lastErr}` : ''}`), { code: 'obs_disconnected' }));
    }
    const requestId = randomUUID();
    const t0 = process.hrtime.bigint();
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(Object.assign(new Error(`OBS 请求超时：${requestType}`), { code: 'obs_timeout' }));
    }, timeoutMs);
    timer.unref?.();

    pending.set(requestId, {
      requestType,
      timer,
      resolve: (data) => {
        const durationMs = Number(process.hrtime.bigint() - t0) / 1e6;
        log.debug('obs', `OBS 请求 ${requestType}`, { op: requestType, durationMs });
        obsEvents.emit('request', { requestType, requestData, ok: true, durationMs });
        resolve(data);
      },
      reject: (e) => {
        const durationMs = Number(process.hrtime.bigint() - t0) / 1e6;
        // quiet：预期内可能失败的探测（例如询问一个尚不存在的场景的转场覆盖）。
        // 这类失败每 60s 会轮询一次，用 warn 会把真正的告警淹没。
        const logFn = quiet ? log.debug : log.warn;
        logFn('obs', `OBS 请求失败 ${requestType}`, { op: requestType, err: e.message, durationMs });
        obsEvents.emit('request', { requestType, requestData, ok: false, err: e.message, durationMs });
        reject(e);
      },
    });

    try {
      ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    } catch (e) {
      pending.delete(requestId);
      clearTimeout(timer);
      reject(e);
    }
  });
}

// ─────────────────────────────────────────────────────────────
// 事件分发
// ─────────────────────────────────────────────────────────────

function handleEvent(d) {
  const { eventType, eventData, eventIntent } = d;
  obsEvents.emit('event', eventType, eventData, eventIntent);
  obsEvents.emit(eventType, eventData);

  switch (eventType) {
    case 'CurrentProgramSceneChanged':
      set('transitions.programScene', eventData.sceneName || '');
      break;
    case 'CurrentPreviewSceneChanged':
      set('transitions.previewScene', eventData.sceneName || '');
      break;
    case 'StudioModeStateChanged':
      set('transitions.studioMode', !!eventData.studioModeEnabled);
      break;
    case 'SceneTransitionStarted':
      log.info('obs', '转场开始', { op: 'SceneTransitionStarted', scene: eventData.sceneName, transition: eventData.transitionName });
      break;
    case 'SceneTransitionEnded':
      // ★ 官方描述：仅代表 **cut point**（遮罩盖满、场景已切换），不代表转场播完
      log.debug('obs', '转场 cut point（SceneTransitionEnded）', { scene: eventData.sceneName });
      break;
    case 'SceneTransitionVideoEnded':
      log.debug('obs', '转场视频真正播完（SceneTransitionVideoEnded）', { scene: eventData.sceneName });
      break;
    case 'SceneListChanged':
    case 'SceneCreated':
    case 'SceneRemoved':
    case 'SceneNameChanged':
      refreshScenes().catch(() => { /* ignore */ });
      break;
    default:
      break;
  }
}

// ─────────────────────────────────────────────────────────────
// 便捷封装
// ─────────────────────────────────────────────────────────────

export async function refreshBasics() {
  const [v, scenes] = await Promise.all([
    request('GetVersion'),
    request('GetSceneList'),
  ]);
  obsVersion = {
    obsVersion: v.obsVersion,
    obsWebSocketVersion: v.obsWebSocketVersion,
    platform: v.platform,
    availableRequests: Array.isArray(v.availableRequests) ? v.availableRequests.length : 0,
    // RC7：截图可用格式需要从这里读
    imageFormats: v.supportedImageFormats || [],
  };
  set('health.obs.version', obsVersion);
  set('health.obs.scenes', (scenes.scenes || []).map((s) => s.sceneName));
  set('transitions.programScene', scenes.currentProgramSceneName || '');
  set('transitions.previewScene', scenes.currentPreviewSceneName || '');
  log.info('obs', 'OBS 基础信息已刷新', { obs: v.obsVersion, scenes: (scenes.scenes || []).length, formats: obsVersion.imageFormats.join(',') });
  return obsVersion;
}

export async function refreshScenes() {
  const scenes = await request('GetSceneList');
  set('health.obs.scenes', (scenes.scenes || []).map((s) => s.sceneName));
  return scenes;
}

export async function getSceneList() {
  return request('GetSceneList');
}

export async function getInputList() {
  return request('GetInputList');
}

export async function sceneExists(name) {
  try {
    const { scenes } = await request('GetSceneList');
    return (scenes || []).some((s) => s.sceneName === name);
  } catch { return false; }
}

export async function inputExists(name) {
  try {
    const { inputs } = await request('GetInputList');
    return (inputs || []).some((i) => i.inputName === name);
  } catch { return false; }
}

export async function setProgramScene(sceneName, { forceCut = false } = {}) {
  if (forceCut) {
    // 需要硬切时临时把当前转场设为 Cut，再恢复 —— 但更稳妥的是用场景覆盖，这里只做兜底
    const cur = await request('GetCurrentSceneTransition').catch(() => null);
    await request('SetCurrentSceneTransition', { transitionName: 'Cut' }).catch(() => { /* 忽略 */ });
    await request('SetCurrentProgramScene', { sceneName });
    if (cur?.transitionName) {
      await request('SetCurrentSceneTransition', { transitionName: cur.transitionName }).catch(() => { /* 忽略 */ });
    }
    return;
  }
  await request('SetCurrentProgramScene', { sceneName });
}

export async function getStudioModeEnabled() {
  const r = await request('GetStudioModeEnabled');
  set('transitions.studioMode', !!r.studioModeEnabled);
  return !!r.studioModeEnabled;
}

export async function triggerStudioTransition() {
  return request('TriggerStudioModeTransition');
}

export async function setSceneTransition(transitionName, durationMs) {
  await request('SetCurrentSceneTransition', { transitionName });
  if (Number.isFinite(durationMs)) {
    await request('SetCurrentSceneTransitionDuration', { transitionDuration: clampDuration(durationMs) });
  }
  // B-REQ-3008：切换后立即重读确认生效（防静默失败）
  const cur = await request('GetCurrentSceneTransition');
  set('transitions.current', normalizeTransition(cur));
  return cur;
}

export async function getCurrentTransition() {
  const cur = await request('GetCurrentSceneTransition');
  set('transitions.current', normalizeTransition(cur));
  return cur;
}

export async function listTransitions() {
  const [list, kinds] = await Promise.all([
    request('GetSceneTransitionList'),
    request('GetTransitionKindList').catch(() => ({ transitionKinds: [] })),
  ]);
  set('transitions.list', list.transitions || []);
  set('transitions.kinds', kinds.transitionKinds || []);
  set('transitions.current', normalizeTransition({
    transitionName: list.currentSceneTransitionName,
    transitionUuid: list.currentSceneTransitionUuid,
    transitionKind: list.currentSceneTransitionKind,
  }));
  return list;
}

/** B-REQ-3001：场景转场覆盖无变更事件，须按需重读 */
export async function readSceneOverride(sceneName) {
  try {
    const r = await request('GetSceneSceneTransitionOverride', { sceneName }, { quiet: true });
    return { transitionName: r.transitionName ?? null, transitionDuration: r.transitionDuration ?? null };
  } catch {
    // 场景可能还没建好（例如配置里写了「待机」但 OBS 里没有），这是常态，不算故障
    return { transitionName: null, transitionDuration: null, error: true };
  }
}

export async function readAllSceneOverrides(sceneNames) {
  const out = {};
  for (const n of sceneNames) out[n] = await readSceneOverride(n);
  set('transitions.overrides', out);
  set('transitions.overridesAt', Date.now());
  return out;
}

export async function setSceneOverride(sceneName, transitionName, transitionDuration) {
  const data = { sceneName };
  if (transitionName !== undefined) data.transitionName = transitionName;
  if (transitionDuration !== undefined) data.transitionDuration = clampDuration(transitionDuration);
  await request('SetSceneSceneTransitionOverride', data);
  return readSceneOverride(sceneName);
}

export async function setStudioMode(enabled) {
  await request('SetStudioModeEnabled', { studioModeEnabled: !!enabled });
  set('transitions.studioMode', !!enabled);
  return !!enabled;
}

export async function setPreviewScene(sceneName) {
  // B-REQ-3004：非演播室模式调用会失败，须前置检查
  const on = await getStudioModeEnabled();
  if (!on) throw Object.assign(new Error('SetCurrentPreviewScene 仅在演播室模式下可用'), { code: 'studio_mode_off' });
  await request('SetCurrentPreviewScene', { sceneName });
  set('transitions.previewScene', sceneName);
}

export async function getInputMute(inputName) {
  const r = await request('GetInputMute', { inputName });
  return !!r.inputMuted;
}

export async function setInputMute(inputName, muted) {
  await request('SetInputMute', { inputName, inputMuted: !!muted });
  return !!muted;
}

export async function toggleInputMute(inputName) {
  const r = await request('ToggleInputMute', { inputName });
  return !!r.inputMuted;
}

/** 模块 C 监看用：截图模式（C-REQ-403 / RC7） */
export async function getSourceScreenshot({ sourceName, imageFormat = 'jpg', imageWidth, imageHeight, imageCompressionQuality = 55 }) {
  const data = { sourceName, imageFormat };
  if (imageWidth) data.imageWidth = imageWidth;
  if (imageHeight) data.imageHeight = imageHeight;
  if (imageCompressionQuality !== undefined) data.imageCompressionQuality = imageCompressionQuality;
  const r = await request('GetSourceScreenshot', data, { timeoutMs: 4000 });
  return r.imageData;   // "data:image/jpeg;base64,...."
}

export async function getSourceActive(sourceName) {
  try {
    const r = await request('GetSourceActive', { sourceName });
    return !!r.sourceActive;
  } catch { return false; }
}

function normalizeTransition(r) {
  const name = r.transitionName ?? r.currentSceneTransitionName ?? '';
  const kind = r.transitionKind ?? r.currentSceneTransitionKind ?? '';
  const uuid = r.transitionUuid ?? r.currentSceneTransitionUuid ?? '';
  const duration = r.transitionDuration ?? r.transitionFixed ?? 0;
  return {
    name, kind, uuid,
    duration: typeof duration === 'number' ? duration : 0,
    fixed: !!r.transitionFixed,
    configurable: !!r.transitionConfigurable,
    settings: r.transitionSettings || {},
  };
}

function clampDuration(ms) {
  // B-REQ-3007：转场时长须校验 50–20000ms
  const n = Number(ms);
  if (!Number.isFinite(n)) return 50;
  return Math.max(50, Math.min(20000, Math.round(n)));
}

/**
 * OBS 侧结构自检 —— 附录 C 清单里「无法程序检测」的几项，其实大部分可以通过 obs-websocket 查出来：
 *   · 浏览器源的 shutdown / restart_when_active（G-REQ-204 / A-REQ-002）
 *   · CLEAN 场景上是否挂了 NDI Dedicated Output **滤镜**（而不是用了主输出）
 *   · CLEAN 场景里有没有混进浮窗源（G-REQ-104）
 *   · vMix 回传 NDI 源的音频是否已关闭（video-only 原则）
 *
 * 全部为**只读**请求；任何一步失败只记 unknown，不误报成错误。
 *
 * @returns {Promise<{browserSources:Array, filters:Array, cleanItems:Array, replayAudio:object|null, notes:string[]}>}
 */
export async function inspectSetup(cfg) {
  const out = { browserSources: [], filters: [], cleanItems: [], replayAudio: null, notes: [] };
  if (!isConnected()) return out;

  // ① 输入列表 + 浏览器源设置
  let inputs = [];
  try { inputs = (await request('GetInputList')).inputs || []; } catch (e) { out.notes.push(`GetInputList 失败：${e.message}`); }

  const wantBrowser = ['浮窗-主', '浮窗-致谢'];
  for (const inName of wantBrowser) {
    const hit = inputs.find((i) => i.inputName === inName);
    if (!hit) { out.browserSources.push({ name: inName, exists: false }); continue; }
    const rec = { name: inName, exists: true, kind: hit.inputKind || '', settings: null };
    try {
      const s = (await request('GetInputSettings', { inputName: inName })).inputSettings || {};
      rec.settings = {
        url: s.url ?? null,
        width: s.width ?? null,
        height: s.height ?? null,
        /** ✅ G-REQ-204：必须为 false —— 否则源隐藏时 CEF 退出，再显示时重连丢状态 */
        shutdown: s.shutdown,
        restart_when_active: s.restart_when_active,
        fps_custom: s.fps_custom,
        fps: s.fps,
      };
    } catch (e) { rec.error = e.message; }
    out.browserSources.push(rec);
  }

  // ② CLEAN 场景上的滤镜（找 NDI Dedicated Output）
  const clean = cfg?.scenes?.clean || 'CLEAN';
  try {
    const list = (await request('GetSourceFilterList', { sourceName: clean })).filters || [];
    let kinds = {};
    try {
      const kl = (await request('GetSourceFilterKindList')).sourceFilterKinds || [];
      for (const k of kl) kinds[k.sourceFilterKind || k] = k;
    } catch { /* 拿不到类型表也能靠名字判断 */ }
    out.filters = list.map((f) => ({
      name: f.filterName,
      kind: f.filterKind,
      enabled: f.filterEnabled,
      typeDisplay: (kinds[f.filterKind] && (kinds[f.filterKind].displayName || kinds[f.filterKind].sourceFilterKind)) || '',
    }));
  } catch (e) { out.notes.push(`读取 CLEAN 场景滤镜失败：${e.message}`); }

  // ③ CLEAN 场景的场景项（不能包含浮窗）
  try {
    const items = (await request('GetSceneItemList', { sceneName: clean })).sceneItems || [];
    out.cleanItems = items.map((i) => ({ id: i.sceneItemId, source: i.sourceName, enabled: i.sceneItemEnabled }));
  } catch (e) { out.notes.push(`读取 CLEAN 场景项失败：${e.message}`); }

  // ④ vMix 回传 NDI 源的音频
  const ndi = cfg?.sources?.replayNdi;
  if (ndi && inputs.some((i) => i.inputName === ndi)) {
    const rec = { input: ndi, muted: null, tracks: null };
    try { rec.muted = (await request('GetInputMute', { inputName: ndi })).inputMuted; } catch { /* ignore */ }
    try { rec.tracks = (await request('GetInputAudioTracks', { inputName: ndi })).inputAudioTracks; } catch { /* ignore */ }
    out.replayAudio = rec;
  }

  return out;
}

/** 健康探测：不产生副作用，仅 GetVersion */
export async function probe() {
  const t0 = process.hrtime.bigint();
  try {
    const v = await request('GetVersion', {}, { timeoutMs: 3000 });
    return {
      ok: true,
      rttMs: Number(process.hrtime.bigint() - t0) / 1e6,
      obsVersion: v.obsVersion,
      obsWebSocketVersion: v.obsWebSocketVersion,
      imageFormats: v.supportedImageFormats || [],
    };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code };
  }
}
