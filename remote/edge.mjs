#!/usr/bin/env node
/**
 * 公网 Edge —— 跑在有公网 IP 的机器上。
 *
 * 与「本体」（无公网 IP 的主控制台）不在同一网络时使用：
 *
 *   公网手机 ──HTTPS──► Edge（本文件） ──WSS 长连接（由内网主动发起）──► Agent（内网）
 *                                                                          │ 127.0.0.1
 *                                                                          ▼
 *                                                                     主控制台 :3000
 *
 * 关键安全边界：
 *   · 公网只接受白名单路径，控制接口 / OBS 源 / 设置 / WebSocket 一律不转发；
 *   · 内网 Agent 只主动出站连 Edge，不需要在路由器上给内网开任何入站端口；
 *   · Edge 与 Agent 用共享 token 认证；Edge 只允许一个 Agent；
 *   · Edge 有每 IP 请求/提交限流、body 上限、并发上限、连接数上限、超时与安全头；
 *   · Edge 不缓存/不排队控制指令，只转发已允许的公共请求；
 *   · Agent 侧会再次校验白名单（纵深防御）。
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { isAllowed, isApiPath, getClientIp, normalizeIp, PUBLIC_GET, PUBLIC_POST, PUBLIC_GET_PREFIX } from './policy.mjs';
import {
  boolOf, numOf, securityHeaders, isHttpsRequest, json, page, landingHtml,
  createLimiter, readBody, loadJsonFile,
} from './common.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_CONFIG = {
  host: '0.0.0.0',
  port: 8790,
  tlsCert: '',
  tlsKey: '',
  agentToken: '',
  trustProxy: false,
  rateGeneral: 240,
  rateJoin: 10,
  ratePick: 30,
  rateWindowMs: 60_000,
  maxBodyBytes: 32 * 1024,
  maxResponseBytes: 2 * 1024 * 1024,
  timeoutMs: 15_000,
  maxInflight: 64,
  maxConnections: 512,
  blockIps: [],
  heartbeatMs: 20_000,
  quiet: false,
};

export function loadConfig(env = process.env) {
  const cfg = { ...DEFAULT_CONFIG };
  const explicit = env.EDGE_CONFIG;
  const file = explicit ? path.resolve(process.cwd(), explicit) : path.join(ROOT, 'edge.config.json');
  if (!fs.existsSync(file)) {
    if (explicit) throw new Error(`EDGE_CONFIG 指定的文件不存在：${file}`);
  } else {
    Object.assign(cfg, loadJsonFile(file));
  }

  if (env.EDGE_HOST !== undefined) cfg.host = String(env.EDGE_HOST);
  if (env.EDGE_PORT !== undefined) cfg.port = numOf(env.EDGE_PORT, cfg.port);
  if (env.EDGE_TLS_CERT !== undefined) cfg.tlsCert = String(env.EDGE_TLS_CERT);
  if (env.EDGE_TLS_KEY !== undefined) cfg.tlsKey = String(env.EDGE_TLS_KEY);
  if (env.EDGE_AGENT_TOKEN !== undefined) cfg.agentToken = String(env.EDGE_AGENT_TOKEN);
  if (env.EDGE_TRUST_PROXY !== undefined) cfg.trustProxy = boolOf(env.EDGE_TRUST_PROXY);
  if (env.EDGE_RATE_GENERAL !== undefined) cfg.rateGeneral = numOf(env.EDGE_RATE_GENERAL, cfg.rateGeneral);
  if (env.EDGE_RATE_JOIN !== undefined) cfg.rateJoin = numOf(env.EDGE_RATE_JOIN, cfg.rateJoin);
  if (env.EDGE_RATE_PICK !== undefined) cfg.ratePick = numOf(env.EDGE_RATE_PICK, cfg.ratePick);
  if (env.EDGE_RATE_WINDOW_MS !== undefined) cfg.rateWindowMs = numOf(env.EDGE_RATE_WINDOW_MS, cfg.rateWindowMs);
  if (env.EDGE_MAX_BODY !== undefined) cfg.maxBodyBytes = numOf(env.EDGE_MAX_BODY, cfg.maxBodyBytes);
  if (env.EDGE_MAX_RESPONSE !== undefined) cfg.maxResponseBytes = numOf(env.EDGE_MAX_RESPONSE, cfg.maxResponseBytes);
  if (env.EDGE_TIMEOUT_MS !== undefined) cfg.timeoutMs = numOf(env.EDGE_TIMEOUT_MS, cfg.timeoutMs);
  if (env.EDGE_MAX_INFLIGHT !== undefined) cfg.maxInflight = numOf(env.EDGE_MAX_INFLIGHT, cfg.maxInflight);
  if (env.EDGE_MAX_CONNECTIONS !== undefined) cfg.maxConnections = numOf(env.EDGE_MAX_CONNECTIONS, cfg.maxConnections);
  if (env.EDGE_BLOCK_IPS !== undefined) cfg.blockIps = String(env.EDGE_BLOCK_IPS).split(',');
  if (env.EDGE_HEARTBEAT_MS !== undefined) cfg.heartbeatMs = numOf(env.EDGE_HEARTBEAT_MS, cfg.heartbeatMs);
  if (env.EDGE_QUIET !== undefined) cfg.quiet = boolOf(env.EDGE_QUIET);
  return validateConfig(cfg);
}

export function validateConfig(input) {
  const cfg = { ...DEFAULT_CONFIG, ...(input || {}) };
  cfg.agentToken = String(cfg.agentToken || '').trim();
  if (!cfg.agentToken) throw new Error('必须配置 agentToken（Edge 与 Agent 共享的随机长字符串）');
  cfg.port = Math.round(Number(cfg.port));
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) throw new Error('port 必须是 0–65535');
  const rate = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.round(n)) : fallback;
  };
  cfg.rateGeneral = rate(cfg.rateGeneral, DEFAULT_CONFIG.rateGeneral);
  cfg.rateJoin = rate(cfg.rateJoin, DEFAULT_CONFIG.rateJoin);
  cfg.ratePick = rate(cfg.ratePick, DEFAULT_CONFIG.ratePick);
  cfg.rateWindowMs = Math.max(1000, Math.round(Number(cfg.rateWindowMs) || DEFAULT_CONFIG.rateWindowMs));
  cfg.maxBodyBytes = Math.max(1024, Math.round(Number(cfg.maxBodyBytes) || DEFAULT_CONFIG.maxBodyBytes));
  cfg.maxResponseBytes = Math.max(1024, Math.round(Number(cfg.maxResponseBytes) || DEFAULT_CONFIG.maxResponseBytes));
  cfg.timeoutMs = Math.max(1000, Math.round(Number(cfg.timeoutMs) || DEFAULT_CONFIG.timeoutMs));
  cfg.maxInflight = Math.max(1, Math.round(Number(cfg.maxInflight) || DEFAULT_CONFIG.maxInflight));
  cfg.maxConnections = Math.max(1, Math.round(Number(cfg.maxConnections) || DEFAULT_CONFIG.maxConnections));
  cfg.heartbeatMs = Math.max(5000, Math.round(Number(cfg.heartbeatMs) || DEFAULT_CONFIG.heartbeatMs));
  cfg.trustProxy = !!cfg.trustProxy;
  cfg.quiet = !!cfg.quiet;
  if (!!cfg.tlsCert !== !!cfg.tlsKey) throw new Error('TLS 必须同时配置证书和私钥（tlsCert / tlsKey）');
  cfg.blockIps = (Array.isArray(cfg.blockIps) ? cfg.blockIps : String(cfg.blockIps || '').split(','))
    .map((s) => normalizeIp(String(s).trim()))
    .filter(Boolean);
  return cfg;
}

function tokenMatches(got, expected) {
  const a = Buffer.from(String(got || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function safeHeader(v, max = 300) {
  const s = String(v ?? '').replace(/[\r\n]/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * 创建 Edge 服务（不自动 listen，便于测试）。
 * @returns {import('node:http').Server}
 */
export function createEdgeServer(input) {
  const config = validateConfig(input);
  const block = new Set(config.blockIps);
  const limitGeneral = createLimiter(config.rateGeneral, config.rateWindowMs);
  const limitJoin = createLimiter(config.rateJoin, config.rateWindowMs);
  const limitPick = createLimiter(config.ratePick, config.rateWindowMs);
  const limitAuth = createLimiter(20, 60_000);
  const startedAt = Date.now();

  /** @type {Map<string,{res:import('node:http').ServerResponse,timer:NodeJS.Timeout,api:boolean,ip:string,method:string,path:string,started:number}>} */
  const pending = new Map();
  let agent = null;
  let agentReady = false;
  let agentSince = 0;
  let agentVersion = '';

  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    // 响应在 WS 里是 base64，约为原文的 4/3；再留 256KB 给 JSON 字段
    maxPayload: Math.max(config.maxBodyBytes, config.maxResponseBytes) * 2 + 256 * 1024,
  });

  function log(...args) { if (!config.quiet) console.log('[edge]', ...args); }
  function logErr(...args) { if (!config.quiet) console.error('[edge]', ...args); }

  function respondError(res, api, status, code, msg) {
    if (!res || res.headersSent || res.writableEnded) return;
    if (api) json(res, status, { ok: false, nack: { code, msg } });
    else page(res, status, status === 503 ? '服务暂不可用' : '请求失败', msg);
  }

  function failAll(code, msg) {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(id);
      respondError(p.res, p.api, 503, code, msg);
    }
  }

  function sendAgent(obj) {
    if (!agent || agent.readyState !== 1) return false;
    try { agent.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  function cancel(id) {
    sendAgent({ type: 'cancel', id });
  }

  function finishPending(id, msg) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    if (p.res.writableEnded || p.res.destroyed) return;

    let body;
    try { body = Buffer.from(String(msg.body || ''), 'base64'); }
    catch { return respondError(p.res, p.api, 502, 'bad_response', '本体返回了无法解析的数据'); }
    if (body.length > config.maxResponseBytes) {
      return respondError(p.res, p.api, 502, 'response_too_large', '本体返回内容过大');
    }
    const status = Number.isInteger(Number(msg.status)) && Number(msg.status) >= 100 && Number(msg.status) <= 599
      ? Number(msg.status) : 502;
    const ct = safeHeader(msg.headers?.['content-type'] || 'application/octet-stream');
    const cc = safeHeader(msg.headers?.['cache-control'] || 'no-store');
    const out = {
      ...securityHeaders(!!p.res.__edgeHttps),
      'content-type': ct,
      'cache-control': cc,
      'content-length': body.length,
    };
    p.res.writeHead(status, out);
    if (p.method === 'HEAD') return p.res.end();
    p.res.end(body);
  }

  wss.on('connection', (ws, req) => {
    // 只保留一个 Agent；新的连接替换旧的，便于断线重连
    if (agent && agent.readyState === 1) {
      try { agent.close(4002, 'replaced by new agent'); } catch { /* ignore */ }
    }
    agent = ws;
    agentReady = false;
    agentSince = Date.now();
    agentVersion = '';
    const agentIp = getClientIp(req, config.trustProxy);
    log(`Agent 已连接（${agentIp}）`);

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const hb = setInterval(() => {
      if (ws.isAlive === false) { try { ws.terminate(); } catch { /* ignore */ } return; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }, config.heartbeatMs);
    hb.unref?.();

    const readyTimer = setTimeout(() => {
      if (agent === ws && !agentReady) {
        try { ws.close(4003, 'agent not ready'); } catch { /* ignore */ }
      }
    }, 10_000);
    readyTimer.unref?.();

    ws.send(JSON.stringify({
      type: 'hello',
      protocol: 1,
      maxBodyBytes: config.maxBodyBytes,
      maxResponseBytes: config.maxResponseBytes,
      serverTime: Date.now(),
    }));

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ready') {
        agentReady = true;
        agentSince = Date.now();
        agentVersion = String(msg.version || '').slice(0, 40);
        clearTimeout(readyTimer);
        log(`Agent 就绪${agentVersion ? ` · ${agentVersion}` : ''}`);
        return;
      }
      if (msg.type === 'response') {
        if (typeof msg.id === 'string') finishPending(msg.id, msg);
        return;
      }
      if (msg.type === 'error') {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        const status = Number.isInteger(Number(msg.status)) && Number(msg.status) >= 400 && Number(msg.status) <= 599
          ? Number(msg.status) : 502;
        respondError(p.res, p.api, status, safeHeader(msg.code || 'agent_error', 60) || 'agent_error', safeHeader(msg.message || '本体处理失败'));
        return;
      }
      if (msg.type === 'ping') { try { ws.send(JSON.stringify({ type: 'pong', at: Date.now() })); } catch { /* ignore */ } }
    });

    ws.on('close', () => {
      clearInterval(hb);
      clearTimeout(readyTimer);
      if (agent === ws) {
        agent = null;
        agentReady = false;
        log('Agent 已断开；当前公网请求将返回 503');
        failAll('agent_offline', '本体暂未连接，请稍后再试');
      }
    });
    ws.on('error', (e) => logErr('Agent WebSocket 错误', e.message));
  });

  function publicHandler(req, res) {
    const started = Date.now();
    let url;
    try { url = new URL(req.url || '/', 'http://edge.local'); }
    catch { return json(res, 400, { ok: false, nack: { code: 'bad_request', msg: '请求地址不合法' } }); }
    const pathname = url.pathname;
    const ip = getClientIp(req, config.trustProxy);
    const api = isApiPath(pathname);
    const isHttps = isHttpsRequest(req, config);
    res.__edgeHttps = isHttps;
    if (isHttps) res.setHeader('strict-transport-security', 'max-age=15552000; includeSubDomains');
    res.on('finish', () => {
      if (config.quiet) return;
      log(`${ip} ${req.method} ${String(req.url || '').slice(0, 180)} -> ${res.statusCode} ${Date.now() - started}ms`);
    });

    if (block.has(ip)) return respondError(res, api, 403, 'blocked', '该地址已被限制访问');
    if (req.url && req.url.length > 2048) return respondError(res, api, 414, 'uri_too_long', '请求地址过长');
    if (!limitGeneral(ip)) {
      return respondError(res, api, 429, 'rate_limited', '请求太频繁，请稍后再试');
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (pathname === '/') {
        const html = Buffer.from(landingHtml());
        res.writeHead(200, {
          ...securityHeaders(isHttps),
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': html.length,
        });
        return res.end(req.method === 'HEAD' ? undefined : html);
      }
      if (pathname === '/healthz') {
        return json(res, agentReady ? 200 : 503, {
          ok: agentReady,
          service: 'edge',
          agentConnected: agentReady,
          agentVersion: agentVersion || null,
          agentSince: agentSince || null,
          pending: pending.size,
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          time: new Date().toISOString(),
        });
      }
      if (pathname === '/favicon.ico') { res.writeHead(204, securityHeaders(isHttps)); return res.end(); }
    }

    if (!isAllowed(req.method, pathname)) {
      const known = PUBLIC_GET.has(pathname) || PUBLIC_POST.has(pathname)
        || ((req.method === 'GET' || req.method === 'HEAD')
          && PUBLIC_GET_PREFIX.some((prefix) => pathname.startsWith(prefix)));
      if (known) return respondError(res, api, 405, 'method_not_allowed', '该地址只支持 GET / POST 中对应的方法');
      return respondError(res, api, 404, 'not_found', '该地址不在公网开放范围');
    }

    if (!agentReady || !agent || agent.readyState !== 1) {
      return respondError(res, api, 503, 'agent_offline', '本体暂未连接，请稍后再试');
    }
    if (pending.size >= config.maxInflight) {
      return respondError(res, api, 429, 'busy', '当前请求过多，请稍后再试');
    }
    if (pathname === '/api/lottery/join' && !limitJoin(ip)) {
      return respondError(res, api, 429, 'rate_limited', '提交太频繁，请稍后再试');
    }
    if (pathname === '/api/match/pick' && !limitPick(ip)) {
      return respondError(res, api, 429, 'rate_limited', '提交太频繁，请稍后再试');
    }

    return tunnelRequest(req, res, { ip, pathname, url, api, isHttps });
  }

  async function tunnelRequest(req, res, { ip, pathname, url, api, isHttps }) {
    let body = Buffer.alloc(0);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const read = await readBody(req, config.maxBodyBytes);
      if (!read.ok) {
        return respondError(res, api, read.code === 'body_too_large' ? 413 : 400, read.code || 'bad_body', '提交内容不合法');
      }
      body = read.body;
    }
    if (!agentReady || !agent || agent.readyState !== 1) {
      return respondError(res, api, 503, 'agent_offline', '本体暂未连接，请稍后再试');
    }

    const id = crypto.randomUUID();
    const headers = {};
    for (const h of ['accept', 'content-type', 'user-agent']) {
      if (req.headers[h]) headers[h] = safeHeader(req.headers[h]);
    }
    const msg = {
      type: 'request',
      id,
      method: req.method,
      path: `${url.pathname}${url.search}`,
      ip,
      https: isHttps,
      headers,
      body: body.toString('base64'),
      at: Date.now(),
    };
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      cancel(id);
      respondError(res, api, 504, 'upstream_timeout', '本体响应超时，请稍后再试');
    }, config.timeoutMs);
    timer.unref?.();
    pending.set(id, { res, timer, api, ip, method: req.method, path: pathname, started: Date.now() });

    const onClose = () => {
      if (!pending.has(id)) return;
      if (res.writableEnded) return;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      clearTimeout(p.timer);
      cancel(id);
    };
    res.on('close', onClose);
    req.on('aborted', onClose);

    if (!sendAgent(msg)) {
      pending.delete(id);
      clearTimeout(timer);
      respondError(res, api, 503, 'agent_offline', '本体暂未连接，请稍后再试');
    }
  }

  const serverHandler = (req, res) => {
    try {
      const ret = publicHandler(req, res);
      if (ret && typeof ret.catch === 'function') ret.catch((e) => {
        logErr('请求处理异常', e.message);
        respondError(res, isApiPath(String(req.url || '')), 500, 'internal_error', '公网入口内部错误');
      });
    } catch (e) {
      logErr('请求处理异常', e.message);
      respondError(res, false, 500, 'internal_error', '公网入口内部错误');
    }
  };

  const tls = config.tlsCert
    ? { cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) }
    : null;
  const server = tls ? https.createServer(tls, serverHandler) : http.createServer(serverHandler);
  server.maxConnections = config.maxConnections;
  server.requestTimeout = Math.max(10_000, config.timeoutMs + 5_000);
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;

  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url || '/', 'http://edge.local'); }
    catch { socket.destroy(); return; }
    if (url.pathname !== '/tunnel') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const ip = getClientIp(req, config.trustProxy);
    if (block.has(ip) || !limitAuth(ip)) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      socket.destroy();
      logErr('Agent 认证尝试过多', ip);
      return;
    }
    const auth = String(req.headers.authorization || '');
    const got = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!tokenMatches(got, config.agentToken)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      logErr('Agent 认证失败', ip);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  server.on('connect', (req, socket) => {
    socket.write('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  server.on('close', () => {
    failAll('edge_closed', '公网入口正在关闭');
    try { wss.close(); } catch { /* ignore */ }
    try { agent?.close(1001, 'edge closing'); } catch { /* ignore */ }
  });

  return server;
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`公网 Edge（独立网络拓扑）

用法：
  node remote/edge.mjs
  EDGE_AGENT_TOKEN=<token> EDGE_PORT=8790 node remote/edge.mjs

配置：remote/edge.config.json 或 EDGE_CONFIG；环境变量 EDGE_* 覆盖。
关键项：
  EDGE_AGENT_TOKEN   必填，与内网 Agent 的 token 一致
  EDGE_PORT          默认 8790
  EDGE_TLS_CERT/KEY  内置 HTTPS（也可放在 Caddy/nginx 后面）
  EDGE_TRUST_PROXY   只有前面有可信反代时开
  EDGE_RATE_*        限流；EDGE_MAX_BODY / EDGE_MAX_RESPONSE / EDGE_MAX_INFLIGHT
  EDGE_BLOCK_IPS     逗号分隔的封禁 IP

公网只开放：/join /pick /shared/style.css /shared/font.css /fonts/* /covers/*
            /api/music /api/music/meta /api/match/public /api/match/pick /api/lottery/join
Agent 通过 /tunnel（WSS + Bearer token）主动出站连接。`);
    process.exit(0);
  }
  let config;
  try { config = loadConfig(); }
  catch (e) { console.error(`[edge] 配置错误：${e.message}`); process.exit(1); }
  let server;
  try { server = createEdgeServer(config); }
  catch (e) { console.error(`[edge] 启动失败：${e.message}`); process.exit(1); }
  server.listen(config.port, config.host, () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : config.port;
    const scheme = config.tlsCert ? 'https' : 'http';
    console.log(`[edge] 公网入口已启动：${scheme}://${config.host}:${port}`);
    console.log('[edge] 等待内网 Agent 通过 /tunnel（WSS）接入…');
    console.log('[edge] 只开放签到 / 选曲相关路径；控制接口不会经过这里。');
    if (!config.tlsCert && !config.trustProxy) {
      console.log('[edge] 提示：未启用内置 TLS；公网建议用 Caddy/nginx 或配置证书。');
    }
    if (config.agentToken.length < 16) {
      console.log('[edge] ⚠ Agent token 偏短；建议使用 32 字节以上的随机字符串。');
    }
  });
  server.on('error', (e) => { console.error(`[edge] 监听失败：${e.message}`); process.exit(1); });
  let closing = false;
  const shutdown = (sig) => {
    if (closing) return;
    closing = true;
    console.log(`[edge] 收到 ${sig}，正在关闭…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
