/**
 * 前端 WS 客户端 —— 实现 SRS §7.1 协议的客户端侧。
 *
 * 需求：
 *   S-REQ-101  连接后立即收到 hello 全量状态，客户端无需额外请求
 *   S-REQ-102  状态变更走 patch 增量
 *   S-REQ-103  cmd 有唯一 id 并等 ack/nack（超时 5s 视为失败）
 *   S-REQ-104  断线重连后重新 hello 全量同步
 *   S-REQ-105  连接后须先发 client:hello 声明受众频道
 *   S-REQ-110  所有消息 UTF-8 安全
 *   A-REQ-534  WS 断开须自动重连（退避 1s→2s→4s→上限 10s），重连后全量同步状态
 *   A-REQ-535  WS 断开期间**保持当前画面**（渲染端）
 *   C-REQ-528  收到 cue:tick 后在本地按单调时钟平滑推进显示
 */
(function () {
  'use strict';

  const BACKOFF = [1000, 2000, 4000, 8000, 10000];
  const CMD_TIMEOUT = 5000;

  const listeners = new Map();     // type -> Set<fn>
  const pending = new Map();       // id -> {resolve, reject, timer}
  let socket = null;
  let attempt = 0;
  let reconnectTimer = null;
  let closedByUs = false;
  let connected = false;
  let clientInfo = { audience: null, target: null, role: null };

  /** 全量状态镜像（hello + patch 累积） */
  const state = {};
  let helloAt = 0;
  let lastPatchAt = 0;

  /** 后台密码（与 ui.js 共用同一个 localStorage 键）；渲染源没有也无妨 */
  function adminToken() {
    try { return localStorage.getItem('lp_admin_token') || ''; } catch { return ''; }
  }

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  function emit(type, payload) {
    const set = listeners.get(type);
    if (set) for (const fn of [...set]) {
      try { fn(payload); } catch (e) { console.error('[ws] 监听器异常', type, e); }
    }
    const all = listeners.get('*');
    if (all) for (const fn of [...all]) {
      try { fn(type, payload); } catch (e) { console.error('[ws] 通配监听器异常', e); }
    }
  }

  function connect() {
    clearTimeout(reconnectTimer);
    try {
      socket = new WebSocket(wsUrl());
    } catch (e) {
      scheduleReconnect();
      return;
    }

    socket.onopen = () => {
      attempt = 0;
      connected = true;
      emit('open');
      // S-REQ-105：声明受众 / 角色；启用后台密码时同时携带 token 供控制命令鉴权
      send({
        t: 'client:hello',
        audience: clientInfo.audience,
        target: clientInfo.target,
        role: clientInfo.role,
        token: adminToken(),
        ua: navigator.userAgent,
      });
    };

    socket.onmessage = (ev) => {
      if (typeof ev.data !== 'string') { emit('binary', ev.data); return; }
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handle(msg);
    };

    socket.onclose = () => {
      connected = false;
      emit('close');
      // 所有在途命令立即失败，避免调用方永久挂起
      for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new Error('连接已断开')); pending.delete(id); }
      if (!closedByUs) scheduleReconnect();
    };

    socket.onerror = () => { /* onclose 会跟着来 */ };
  }

  function scheduleReconnect() {
    const delay = BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
    attempt++;
    emit('reconnecting', { attempt, delay });
    reconnectTimer = setTimeout(connect, delay);
  }

  function handle(msg) {
    switch (msg.t) {
      case 'hello':
        replaceState(msg.state || {});
        helloAt = Date.now();
        emit('hello', msg);
        break;

      case 'patch':
        setPath(state, msg.path, msg.value);
        lastPatchAt = Date.now();
        emit('patch', msg);
        emit(`patch:${msg.path}`, msg.value);
        break;

      case 'ack': {
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); clearTimeout(p.timer); p.resolve(msg.data); }
        emit('ack', msg);
        break;
      }

      case 'nack': {
        const p = pending.get(msg.id);
        const err = new Error(msg.msg || '命令失败');
        err.code = msg.code;
        if (p) { pending.delete(msg.id); clearTimeout(p.timer); p.reject(err); }
        emit('nack', msg);
        break;
      }

      default:
        emit(msg.t, msg);
        break;
    }
  }

  function replaceState(next) {
    for (const k of Object.keys(state)) delete state[k];
    Object.assign(state, next);
  }

  function setPath(obj, path, value) {
    if (!path) return;
    const keys = String(path).split('.');
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (cur[keys[i]] == null || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
      cur = cur[keys[i]];
    }
    cur[keys[keys.length - 1]] = value;
  }

  function getPath(path) {
    return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), state);
  }

  function send(obj) {
    if (!socket || socket.readyState !== 1) return false;
    try { socket.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  let cmdSeq = 0;
  /**
   * 发送命令并等待 ack/nack（S-REQ-103）。
   * @returns {Promise<any>} 成功时 resolve ack.data；失败时 reject 带 code 的 Error
   */
  function cmd(op, args) {
    return new Promise((resolve, reject) => {
      if (!socket || socket.readyState !== 1) {
        const e = new Error('未连接到服务端'); e.code = 'offline'; return reject(e);
      }
      const id = `c${Date.now().toString(36)}${(cmdSeq++).toString(36)}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        const e = new Error(`命令超时（${CMD_TIMEOUT}ms）：${op}`); e.code = 'timeout'; reject(e);
      }, CMD_TIMEOUT);
      pending.set(id, { resolve, reject, timer, op });
      send({ t: 'cmd', id, op, args });
    });
  }

  /** 上报（不需要 ack 的轻量消息） */
  function notify(t, payload) { return send(Object.assign({ t }, payload || {})); }

  function on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => off(type, fn);
  }
  function off(type, fn) {
    const s = listeners.get(type);
    if (s) s.delete(fn);
  }

  /** 声明受众（可在连接后随时切换） */
  function setIdentity(info) {
    Object.assign(clientInfo, info || {});
    if (connected) send({ t: 'client:hello', ...clientInfo, token: adminToken(), ua: navigator.userAgent });
  }

  /**
   * 幂等初始化：页面引入本脚本后调用一次。
   *
   * ui.mount 会自动先 start({})，导播 / 解说页随后再 start({audience})；
   * 如果此时连接已经建立，必须补发一次 client:hello，否则服务端仍把它当成
   * 「未声明受众」的连接，定向提示与权限都会丢。
   */
  function start(identity) {
    if (identity) Object.assign(clientInfo, identity);
    if (!socket) connect();
    else if (identity && connected) {
      send({ t: 'client:hello', ...clientInfo, token: adminToken(), ua: navigator.userAgent });
    }
    return api;
  }

  const api = {
    start, cmd, notify, on, off, setIdentity,
    get state() { return state; },
    get path() { return getPath; },
    get connected() { return connected; },
    get helloAt() { return helloAt; },
    get lastPatchAt() { return lastPatchAt; },
    get clientInfo() { return { ...clientInfo }; },
    /** 供页面把「订阅路径」集中声明的语法糖 */
    watch(path, fn) {
      const prev = { v: undefined };
      const run = () => { const v = getPath(path); if (v !== prev.v) { prev.v = v; fn(v, path); } };
      on('hello', run);
      on(`patch:${path}`, (v) => { prev.v = v; fn(v, path); });
      // 路径前缀变化（如 config.cue.templates 整体替换）
      on('patch', (m) => { if (m.path && (m.path.startsWith(path + '.') || path.startsWith(m.path + '.'))) run(); });
      // ui.mount 会先建立连接；如果 watch 注册时 hello 已经到了，补一次当前值
      if (helloAt && getPath(path) !== undefined) run();
      return run;
    },
  };

  window.arcadeWS = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
