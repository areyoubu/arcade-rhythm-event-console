#!/usr/bin/env node
/**
 * 内网 Agent —— 跑在没有公网 IP 的主控制台一侧。
 *
 * 它主动向公网 Edge 建立 WSS 长连接（出站），所以：
 *   · 内网路由器不需要给主控制台开任何入站端口；
 *   · Edge 不能直接访问主控制台；
 *   · 只有 Edge 转发过来的、通过白名单校验的公共请求才会打到本地主控制台。
 *
 * 安全：
 *   · 与 Edge 共享 token（Bearer）；
 *   · 再次校验路径白名单（纵深防御）；
 *   · 只转发 method/path/body，不转发 Cookie / Authorization；
 *   · 请求/响应都有大小上限、超时、并发上限；
 *   · 把 Edge 看到的真实客户端 IP 通过 x-remote-client-ip / X-Forwarded-For 转给主服务，
 *     主服务的 client-ip.js 只信任 token 匹配或 loopback 的转发。
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { isAllowed, normalizeIp } from './policy.mjs';
import { boolOf, numOf, loadJsonFile } from './common.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VERSION = 'arcade-agent/1.0';

export const DEFAULT_CONFIG = {
  edgeUrl: '',
  token: '',
  localUpstream: 'http://127.0.0.1:3000',
  remoteToken: '',
  tlsInsecure: false,
  timeoutMs: 12_000,
  maxBodyBytes: 32 * 1024,
  maxResponseBytes: 2 * 1024 * 1024,
  concurrency: 16,
  reconnectMinMs: 1_000,
  reconnectMaxMs: 30_000,
  quiet: false,
};

export function loadConfig(env = process.env) {
  const cfg = { ...DEFAULT_CONFIG };
  const explicit = env.AGENT_CONFIG;
  const file = explicit ? path.resolve(process.cwd(), explicit) : path.join(ROOT, 'agent.config.json');
  if (!fs.existsSync(file)) {
    if (explicit) throw new Error(`AGENT_CONFIG 指定的文件不存在：${file}`);
  } else {
    Object.assign(cfg, loadJsonFile(file));
  }

  if (env.AGENT_EDGE_URL !== undefined) cfg.edgeUrl = String(env.AGENT_EDGE_URL);
  else if (env.EDGE_URL !== undefined) cfg.edgeUrl = String(env.EDGE_URL);
  if (env.AGENT_TOKEN !== undefined) cfg.token = String(env.AGENT_TOKEN);
  else if (env.EDGE_AGENT_TOKEN !== undefined) cfg.token = String(env.EDGE_AGENT_TOKEN);
  if (env.AGENT_LOCAL_UPSTREAM !== undefined) cfg.localUpstream = String(env.AGENT_LOCAL_UPSTREAM);
  else if (env.LOCAL_UPSTREAM !== undefined) cfg.localUpstream = String(env.LOCAL_UPSTREAM);
  if (env.AGENT_REMOTE_TOKEN !== undefined) cfg.remoteToken = String(env.AGENT_REMOTE_TOKEN);
  else if (env.REMOTE_TOKEN !== undefined) cfg.remoteToken = String(env.REMOTE_TOKEN);
  if (env.AGENT_TLS_INSECURE !== undefined) cfg.tlsInsecure = boolOf(env.AGENT_TLS_INSECURE);
  if (env.AGENT_TIMEOUT_MS !== undefined) cfg.timeoutMs = numOf(env.AGENT_TIMEOUT_MS, cfg.timeoutMs);
  if (env.AGENT_MAX_BODY !== undefined) cfg.maxBodyBytes = numOf(env.AGENT_MAX_BODY, cfg.maxBodyBytes);
  if (env.AGENT_MAX_RESPONSE !== undefined) cfg.maxResponseBytes = numOf(env.AGENT_MAX_RESPONSE, cfg.maxResponseBytes);
  if (env.AGENT_CONCURRENCY !== undefined) cfg.concurrency = numOf(env.AGENT_CONCURRENCY, cfg.concurrency);
  if (env.AGENT_RECONNECT_MIN_MS !== undefined) cfg.reconnectMinMs = numOf(env.AGENT_RECONNECT_MIN_MS, cfg.reconnectMinMs);
  if (env.AGENT_RECONNECT_MAX_MS !== undefined) cfg.reconnectMaxMs = numOf(env.AGENT_RECONNECT_MAX_MS, cfg.reconnectMaxMs);
  if (env.AGENT_QUIET !== undefined) cfg.quiet = boolOf(env.AGENT_QUIET);
  return validateConfig(cfg);
}

export function validateConfig(input) {
  const cfg = { ...DEFAULT_CONFIG, ...(input || {}) };
  cfg.token = String(cfg.token || '').trim();
  if (!cfg.token) throw new Error('必须配置 token（与公网 Edge 的 agentToken 一致）');
  let edge;
  try { edge = new URL(String(cfg.edgeUrl)); }
  catch { throw new Error(`edgeUrl 不是合法 URL：${cfg.edgeUrl}`); }
  if (!['ws:', 'wss:'].includes(edge.protocol)) throw new Error('edgeUrl 只支持 ws:// 或 wss://');
  cfg.edgeUrl = edge.toString();

  let local;
  try { local = new URL(String(cfg.localUpstream)); }
  catch { throw new Error(`localUpstream 不是合法 URL：${cfg.localUpstream}`); }
  if (!['http:', 'https:'].includes(local.protocol)) throw new Error('localUpstream 只支持 http / https');
  cfg.localUpstream = local.toString().replace(/\/+$/, '');

  cfg.tlsInsecure = !!cfg.tlsInsecure;
  cfg.timeoutMs = Math.max(1000, Math.round(Number(cfg.timeoutMs) || DEFAULT_CONFIG.timeoutMs));
  cfg.maxBodyBytes = Math.max(1024, Math.round(Number(cfg.maxBodyBytes) || DEFAULT_CONFIG.maxBodyBytes));
  cfg.maxResponseBytes = Math.max(1024, Math.round(Number(cfg.maxResponseBytes) || DEFAULT_CONFIG.maxResponseBytes));
  cfg.concurrency = Math.max(1, Math.round(Number(cfg.concurrency) || DEFAULT_CONFIG.concurrency));
  cfg.reconnectMinMs = Math.max(200, Math.round(Number(cfg.reconnectMinMs) || DEFAULT_CONFIG.reconnectMinMs));
  cfg.reconnectMaxMs = Math.max(cfg.reconnectMinMs, Math.round(Number(cfg.reconnectMaxMs) || DEFAULT_CONFIG.reconnectMaxMs));
  cfg.quiet = !!cfg.quiet;
  return cfg;
}

/**
 * 启动 Agent。返回 { stop, status }，便于测试/优雅退出。
 */
export function startAgent(input) {
  const config = validateConfig(input);
  const local = new URL(config.localUpstream);
  const localHttps = local.protocol === 'https:';
  const localBase = local.pathname.replace(/\/+$/, '');
  const localHost = local.hostname.replace(/^\[|\]$/g, '');
  const inFlight = new Map(); // id -> { req, timer }
  let ws = null;
  let stopped = false;
  let reconnectTimer = null;
  let attempt = 0;
  let lastError = '';
  let connectedAt = 0;

  const log = (...a) => { if (!config.quiet) console.log('[agent]', ...a); };
  const logErr = (...a) => { if (!config.quiet) console.error('[agent]', ...a); };

  function send(obj) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  function abortAll() {
    for (const [id, item] of inFlight) {
      clearTimeout(item.timer);
      try { item.req.destroy(); } catch { /* ignore */ }
      inFlight.delete(id);
    }
  }

  function scheduleReconnect(minDelay = 0) {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    const base = Math.min(config.reconnectMaxMs, config.reconnectMinMs * (2 ** Math.min(attempt, 8)));
    let delay = Math.round(base * (0.8 + Math.random() * 0.4));
    // 4002 = 被另一个 Agent 顶替。立刻重连会和对方互相踢下线（无限抖动），
    // 先退避一段时间，让仍在线的那个 Agent 稳定工作。
    if (minDelay) delay = Math.max(delay, Math.round(minDelay));
    attempt++;
    log(`将在 ${delay}ms 后重连 Edge（第 ${attempt} 次）`);
    reconnectTimer = setTimeout(connect, delay);
    reconnectTimer.unref?.();
  }

  function connect() {
    if (stopped) return;
    let socket;
    try {
      socket = new WebSocket(config.edgeUrl, {
        headers: { authorization: `Bearer ${config.token}` },
        handshakeTimeout: 8000,
        perMessageDeflate: false,
        maxPayload: Math.max(config.maxBodyBytes, config.maxResponseBytes) * 2 + 256 * 1024,
        rejectUnauthorized: !config.tlsInsecure,
      });
    } catch (e) {
      lastError = e.message;
      logErr('创建 WebSocket 失败', e.message);
      scheduleReconnect();
      return;
    }
    ws = socket;

    socket.on('open', () => {
      attempt = 0;
      connectedAt = Date.now();
      lastError = '';
      log(`已连接 Edge：${config.edgeUrl}`);
      send({ type: 'ready', version: VERSION, protocol: 1 });
    });

    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'hello') {
        log(`Edge hello：protocol=${msg.protocol} maxBody=${msg.maxBodyBytes} maxResponse=${msg.maxResponseBytes}`);
        return;
      }
      if (msg.type === 'request') { handleRequest(msg); return; }
      if (msg.type === 'cancel') { cancel(msg.id); return; }
      if (msg.type === 'pong') return;
    });

    socket.on('close', (code, reason) => {
      if (ws === socket) ws = null;
      if (connectedAt) {
        log(`Edge 连接关闭：${code}${reason ? ` ${String(reason).slice(0, 80)}` : ''}`);
        connectedAt = 0;
      }
      abortAll();
      // 只在「被顶替」时额外退避，正常断线仍然快速重连
      scheduleReconnect(code === 4002 ? Math.max(15_000, config.reconnectMaxMs / 2) : 0);
    });

    socket.on('error', (e) => {
      lastError = e.code || e.message || 'error';
      // 连接错误通常紧跟 close；这里只记录一次，避免重连期间刷屏
      logErr('Edge 连接错误', lastError);
    });

    socket.on('unexpected-response', (req, res) => {
      lastError = `HTTP ${res.statusCode}`;
      logErr('Edge 拒绝连接', lastError);
      try { req.destroy(); } catch { /* ignore */ }
    });
  }

  function sendError(id, status, code, message) {
    if (!id) return;
    send({ type: 'error', id, status, code, message });
  }

  function cancel(id) {
    const item = inFlight.get(id);
    if (!item) return;
    clearTimeout(item.timer);
    try { item.req.destroy(); } catch { /* ignore */ }
    inFlight.delete(id);
  }

  function handleRequest(msg) {
    const id = typeof msg.id === 'string' ? msg.id : '';
    const method = String(msg.method || '').toUpperCase();
    const rawPath = String(msg.path || '');
    if (!id) return;
    if (!/^\/(?!\/)/.test(rawPath)) return sendError(id, 400, 'bad_path', '请求路径不合法');
    if (!['GET', 'HEAD', 'POST'].includes(method)) return sendError(id, 405, 'method_not_allowed', '方法不允许');

    let url;
    try { url = new URL(rawPath, 'http://local'); }
    catch { return sendError(id, 400, 'bad_path', '请求路径不合法'); }
    if (!isAllowed(method, url.pathname)) {
      return sendError(id, 404, 'not_allowed', '该路径不在公网开放范围');
    }
    if (inFlight.size >= config.concurrency) {
      return sendError(id, 429, 'busy', '本体并发已满');
    }

    let body = Buffer.alloc(0);
    if (method === 'POST' && msg.body) {
      try { body = Buffer.from(String(msg.body), 'base64'); }
      catch { return sendError(id, 400, 'bad_body', '请求体不是合法 base64'); }
      if (body.length > config.maxBodyBytes) {
        return sendError(id, 413, 'body_too_large', '提交内容过大');
      }
    }

    const forwardedIp = normalizeIp(msg.ip) || 'unknown';
    const headers = {
      host: local.host,
      accept: typeof msg.headers?.accept === 'string' ? String(msg.headers.accept).slice(0, 300) : '*/*',
      'user-agent': 'arcade-remote-agent',
      'x-forwarded-for': forwardedIp,
      'x-remote-client-ip': forwardedIp,
      'x-forwarded-proto': msg.https ? 'https' : 'http',
    };
    if (config.remoteToken) headers['x-remote-token'] = config.remoteToken;
    if (method === 'POST') {
      const ct = typeof msg.headers?.['content-type'] === 'string' ? msg.headers['content-type'] : '';
      headers['content-type'] = /^application\/json\b/i.test(ct) ? ct.slice(0, 120) : 'application/json';
      headers['content-length'] = body.length;
    }

    const client = localHttps ? https : http;
    let localReq;
    try {
      localReq = client.request({
        protocol: local.protocol,
        hostname: localHost,
        port: local.port || (localHttps ? 443 : 80),
        method,
        path: `${localBase}${url.pathname}${url.search}`,
        headers,
        timeout: config.timeoutMs,
      }, (res) => {
        const chunks = [];
        let size = 0;
        let settled = false;
        const done = () => {
          if (settled) return false;
          settled = true;
          clearTimeout(timer);
          inFlight.delete(id);
          return true;
        };
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > config.maxResponseBytes) {
            if (done()) {
              try { res.destroy(); localReq.destroy(); } catch { /* ignore */ }
              sendError(id, 502, 'response_too_large', '本体返回内容过大');
            }
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (!done()) return;
          const outHeaders = {};
          for (const h of ['content-type', 'cache-control']) {
            if (res.headers[h]) outHeaders[h] = String(res.headers[h]).slice(0, 300);
          }
          send({
            type: 'response',
            id,
            status: res.statusCode || 502,
            headers: outHeaders,
            body: method === 'HEAD' ? '' : Buffer.concat(chunks).toString('base64'),
          });
        });
        res.on('error', () => {
          if (done()) sendError(id, 502, 'upstream_error', '本体响应中断');
        });
      });
    } catch (e) {
      sendError(id, 502, 'upstream_unreachable', '本体不可达');
      return;
    }

    const timer = setTimeout(() => {
      if (!inFlight.has(id)) return;
      cancel(id);
      sendError(id, 504, 'upstream_timeout', '本体响应超时');
    }, config.timeoutMs);
    timer.unref?.();
    inFlight.set(id, { req: localReq, timer });

    localReq.on('error', (e) => {
      if (!inFlight.has(id)) return;
      clearTimeout(timer);
      inFlight.delete(id);
      sendError(id, 502, e.code === 'ETIMEDOUT' ? 'upstream_timeout' : 'upstream_unreachable', '本体不可达');
    });
    if (method === 'POST' && body.length) localReq.write(body);
    localReq.end();
  }

  connect();

  return {
    stop() {
      stopped = true;
      clearTimeout(reconnectTimer);
      abortAll();
      try { ws?.close(1000, 'agent stopping'); } catch { /* ignore */ }
    },
    status() {
      return {
        connected: !!ws && ws.readyState === 1,
        edgeUrl: config.edgeUrl,
        localUpstream: config.localUpstream,
        inFlight: inFlight.size,
        connectedSince: connectedAt || null,
        lastError: lastError || null,
      };
    },
  };
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`内网 Agent（无公网 IP 一侧）

用法：
  node remote/agent.mjs
  AGENT_EDGE_URL=wss://example.com/tunnel AGENT_TOKEN=<token> node remote/agent.mjs

配置：remote/agent.config.json 或 AGENT_CONFIG；环境变量 AGENT_* 覆盖。
关键项：
  AGENT_EDGE_URL      Edge 的 WSS 地址，必须以 /tunnel 结尾，例如 wss://event.example.com/tunnel
  AGENT_TOKEN         与 Edge 的 EDGE_AGENT_TOKEN 一致
  AGENT_LOCAL_UPSTREAM 主控制台地址，默认 http://127.0.0.1:3000
  AGENT_REMOTE_TOKEN  与主服务 LP_REMOTE_TOKEN 一致（用于真实客户端 IP 限流）
  AGENT_TLS_INSECURE  只用于本地调试！公网必须保持 0

Agent 只主动出站连接 Edge；内网不需要开放任何入站端口。`);
    process.exit(0);
  }
  let config;
  try { config = loadConfig(); }
  catch (e) { console.error(`[agent] 配置错误：${e.message}`); process.exit(1); }
  if (config.edgeUrl.startsWith('ws://') && !/^ws:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(config.edgeUrl)) {
    console.log('[agent] ⚠ 使用明文 ws:// 连接公网 Edge；建议改用 wss://。');
  }
  if (config.tlsInsecure) console.log('[agent] ⚠ AGENT_TLS_INSECURE=1：不校验证书，只适合本地调试。');
  const agent = startAgent(config);
  console.log(`[agent] 正在连接 Edge：${config.edgeUrl}`);
  console.log(`[agent] 本地主控制台：${config.localUpstream}`);
  console.log('[agent] 只出站连接，不需要在内网路由器上开放端口。');
  const shutdown = (sig) => {
    console.log(`[agent] 收到 ${sig}，正在关闭…`);
    agent.stop();
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
