#!/usr/bin/env node
/**
 * 公网远端入口 —— 独立进程，只把「现场签到 / 扫码选曲」暴露到公网。
 *
 * 架构：
 *
 *   手机（公网） ──HTTPS/HTTP──► 本进程（remote/） ──内网 HTTP──► 主控制台 127.0.0.1:3000
 *                                      │
 *                                      └─ 只转发白名单路径，其余 404 / 405 / 429
 *
 * 为什么单独跑：
 *   · 主控制台有大量无鉴权的控制接口（OBS/vMix/比分/设置），绝不能直接暴露公网；
 *   · 本进程只依赖 Node 内置模块，可以放在同机或另一台内网机器；
 *   · 主控制台可以继续绑定 0.0.0.0 给局域网，但路由器只把本进程的端口转发出去。
 *
 * 配置优先级：remote/config.json < REMOTE_* 环境变量。
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transform } from 'node:stream';
import { isAllowed, isApiPath, getClientIp, PUBLIC_GET, PUBLIC_POST } from './policy.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_CONFIG = {
  host: '0.0.0.0',
  port: 8787,
  upstream: 'http://127.0.0.1:3000',
  token: '',
  tlsCert: '',
  tlsKey: '',
  trustProxy: false,
  rateGeneral: 180,
  rateJoin: 10,
  ratePick: 30,
  rateWindowMs: 60_000,
  maxBodyBytes: 32 * 1024,
  timeoutMs: 15_000,
  quiet: false,
};

const HOP_BY_HOP = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
];

const SECURITY_OVERRIDES = [
  'content-security-policy', 'x-frame-options', 'x-content-type-options',
  'referrer-policy', 'permissions-policy', 'cross-origin-opener-policy',
  'strict-transport-security',
];

function boolOf(v) {
  return /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
}

function numOf(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 读配置：remote/config.json（或 REMOTE_CONFIG 指定文件）+ REMOTE_* 环境变量 */
export function loadConfig(env = process.env) {
  const cfg = { ...DEFAULT_CONFIG };
  const explicit = env.REMOTE_CONFIG;
  const file = explicit
    ? path.resolve(process.cwd(), explicit)
    : path.join(ROOT, 'config.json');
  if (!fs.existsSync(file)) {
    if (explicit) throw new Error(`REMOTE_CONFIG 指定的文件不存在：${file}`);
  } else {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { throw new Error(`配置文件解析失败（${file}）：${e.message}`); }
    Object.assign(cfg, raw || {});
  }

  if (env.REMOTE_HOST !== undefined) cfg.host = String(env.REMOTE_HOST);
  if (env.REMOTE_PORT !== undefined) cfg.port = numOf(env.REMOTE_PORT, cfg.port);
  if (env.REMOTE_UPSTREAM !== undefined) cfg.upstream = String(env.REMOTE_UPSTREAM);
  if (env.REMOTE_TOKEN !== undefined) cfg.token = String(env.REMOTE_TOKEN);
  if (env.REMOTE_TLS_CERT !== undefined) cfg.tlsCert = String(env.REMOTE_TLS_CERT);
  if (env.REMOTE_TLS_KEY !== undefined) cfg.tlsKey = String(env.REMOTE_TLS_KEY);
  if (env.REMOTE_TRUST_PROXY !== undefined) cfg.trustProxy = boolOf(env.REMOTE_TRUST_PROXY);
  if (env.REMOTE_RATE_GENERAL !== undefined) cfg.rateGeneral = numOf(env.REMOTE_RATE_GENERAL, cfg.rateGeneral);
  if (env.REMOTE_RATE_JOIN !== undefined) cfg.rateJoin = numOf(env.REMOTE_RATE_JOIN, cfg.rateJoin);
  if (env.REMOTE_RATE_PICK !== undefined) cfg.ratePick = numOf(env.REMOTE_RATE_PICK, cfg.ratePick);
  if (env.REMOTE_RATE_WINDOW_MS !== undefined) cfg.rateWindowMs = numOf(env.REMOTE_RATE_WINDOW_MS, cfg.rateWindowMs);
  if (env.REMOTE_MAX_BODY !== undefined) cfg.maxBodyBytes = numOf(env.REMOTE_MAX_BODY, cfg.maxBodyBytes);
  if (env.REMOTE_TIMEOUT_MS !== undefined) cfg.timeoutMs = numOf(env.REMOTE_TIMEOUT_MS, cfg.timeoutMs);
  if (env.REMOTE_QUIET !== undefined) cfg.quiet = boolOf(env.REMOTE_QUIET);

  return validateConfig(cfg);
}

export function validateConfig(input) {
  const cfg = { ...DEFAULT_CONFIG, ...(input || {}) };
  let upstream;
  try { upstream = new URL(String(cfg.upstream)); }
  catch { throw new Error(`upstream 不是合法 URL：${cfg.upstream}`); }
  if (!['http:', 'https:'].includes(upstream.protocol)) throw new Error('upstream 只支持 http / https');
  cfg.upstream = upstream.toString().replace(/\/+$/, '');

  cfg.port = Math.round(Number(cfg.port));
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) throw new Error('port 必须是 0–65535');
  const rate = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.round(n)) : fallback;
  };
  cfg.maxBodyBytes = Math.max(1024, Math.round(Number(cfg.maxBodyBytes) || DEFAULT_CONFIG.maxBodyBytes));
  cfg.timeoutMs = Math.max(1000, Math.round(Number(cfg.timeoutMs) || DEFAULT_CONFIG.timeoutMs));
  cfg.rateWindowMs = Math.max(1000, Math.round(Number(cfg.rateWindowMs) || DEFAULT_CONFIG.rateWindowMs));
  cfg.rateGeneral = rate(cfg.rateGeneral, DEFAULT_CONFIG.rateGeneral);
  cfg.rateJoin = rate(cfg.rateJoin, DEFAULT_CONFIG.rateJoin);
  cfg.ratePick = rate(cfg.ratePick, DEFAULT_CONFIG.ratePick);
  cfg.trustProxy = !!cfg.trustProxy;
  cfg.quiet = !!cfg.quiet;
  if (!!cfg.tlsCert !== !!cfg.tlsKey) throw new Error('TLS 必须同时配置证书和私钥（tlsCert / tlsKey）');
  return cfg;
}

/** 极简内存限流（0 / 负数 = 关闭） */
function createLimiter(max, windowMs) {
  if (!max) return () => true;
  const hits = new Map();
  return function allow(ip) {
    const key = String(ip || 'unknown');
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) { hits.set(key, arr); return false; }
    arr.push(now);
    hits.set(key, arr);
    if (hits.size > 2000) hits.clear();
    return true;
  };
}

function securityHeaders(isHttps) {
  const h = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'permissions-policy': 'geolocation=(), camera=(), microphone=()',
    'cross-origin-opener-policy': 'same-origin',
    'content-security-policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "font-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  };
  if (isHttps) h['strict-transport-security'] = 'max-age=15552000; includeSubDomains';
  return h;
}

function json(res, code, body, extra = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    ...securityHeaders(false),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': payload.length,
    ...extra,
  });
  res.end(payload);
}

function page(res, code, title, message, extra = {}) {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#1e1f22;color:#dfe1e5;font-family:'Noto Sans SC','Microsoft YaHei',system-ui,sans-serif;padding:24px}
.box{max-width:520px;border:1px solid #3a3d43;border-left:3px solid #4a9eff;background:#25272b;padding:24px 26px;border-radius:4px}
h1{margin:0 0 8px;font-size:20px}p{margin:0;color:#aeb2b8;line-height:1.7;font-size:14px}a{color:#4a9eff}</style>
</head><body><div class="box"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div></body></html>`;
  const buf = Buffer.from(html);
  res.writeHead(code, {
    ...securityHeaders(false),
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': buf.length,
    ...extra,
  });
  res.end(buf);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function landingHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>赛事公共入口</title>
<style>
  *{box-sizing:border-box}
  :root{--bg:#1e1f22;--surface:#25272b;--surface2:#2b2e33;--line:#3a3d43;--text:#dfe1e5;--dim:#aeb2b8;--mute:#858a92;--accent:#4a9eff;--gold:#d9a441;--mono:ui-monospace,Consolas,monospace}
  html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text);font-family:'Noto Sans SC','Microsoft YaHei',system-ui,sans-serif}
  body{display:flex;align-items:center;justify-content:center;padding:22px}
  .wrap{width:100%;max-width:620px}
  .brand{display:flex;align-items:center;gap:9px;font-family:var(--mono);font-size:11px;letter-spacing:3px;color:var(--mute)}
  .brand i{width:8px;height:8px;background:var(--gold);display:block}
  h1{font-size:26px;margin:12px 0 6px;letter-spacing:.5px}
  .lead{color:var(--dim);font-size:13.5px;line-height:1.7;margin:0 0 20px}
  .cards{display:grid;gap:10px;grid-template-columns:1fr 1fr}
  @media(max-width:520px){.cards{grid-template-columns:1fr}}
  a.card{display:block;text-decoration:none;background:var(--surface);border:1px solid var(--line);border-radius:5px;padding:18px 18px 16px;color:var(--text);transition:border-color .12s,background .12s}
  a.card:hover{border-color:#5a5f68;background:var(--surface2)}
  .card .k{font-family:var(--mono);font-size:10.5px;letter-spacing:2px;color:var(--mute)}
  .card .t{font-size:18px;font-weight:800;margin:7px 0 4px}
  .card .d{font-size:12.5px;color:var(--dim);line-height:1.6}
  .card .go{margin-top:12px;font-family:var(--mono);font-size:11px;letter-spacing:1px;color:var(--accent)}
  .foot{margin-top:18px;padding-top:12px;border-top:1px solid var(--line);display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--mute)}
  .dot{width:7px;height:7px;border-radius:50%;background:#6b7078;display:inline-block}
  .dot.ok{background:#4f9a6a}.dot.err{background:#c04c4c}
</style>
</head>
<body>
<div class="wrap">
  <div class="brand"><i></i>CHUNITHM · PUBLIC ENTRY</div>
  <h1>赛事公共入口</h1>
  <p class="lead">这里只开放现场签到与扫码选曲。控制台、比分、OBS / vMix、设置等页面均不在此入口提供。</p>
  <div class="cards">
    <a class="card" href="/join">
      <div class="k">CHECK-IN</div>
      <div class="t">现场签到</div>
      <div class="d">填写姓名，加入现场抽奖池。重复提交会自动忽略。</div>
      <div class="go">打开签到页 →</div>
    </a>
    <a class="card" href="/pick">
      <div class="k">SONG PICK</div>
      <div class="t">扫码选曲</div>
      <div class="d">选择 P1 / P2，搜索曲目与难度，提交给导播确认。</div>
      <div class="go">打开选曲页 →</div>
    </a>
  </div>
  <div class="foot"><span class="dot" id="dot"></span><span id="status">正在检查服务…</span><span style="flex:1"></span><span>仅公共入口</span></div>
</div>
<script>
fetch('/healthz',{cache:'no-store'}).then(function(r){return r.json()}).then(function(d){
  var dot=document.getElementById('dot'), s=document.getElementById('status');
  if(d && d.ok){dot.className='dot ok';s.textContent='服务正常 · 可以扫码';}
  else {dot.className='dot err';s.textContent='上游服务暂不可用，请稍后再试';}
}).catch(function(){document.getElementById('dot').className='dot err';document.getElementById('status').textContent='无法连接公共入口';});
</script>
</body>
</html>`;
}

function isHttpsRequest(req, config) {
  if (req.socket?.encrypted) return true;
  if (config.trustProxy) {
    return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  }
  return false;
}

/**
 * 创建远端 HTTP(S) 服务（不自动 listen，方便测试）。
 * @returns {import('node:http').Server}
 */
export function createRemoteServer(input) {
  const config = validateConfig(input);
  const upstream = new URL(config.upstream);
  const upstreamHost = upstream.hostname.replace(/^\[|\]$/g, '');
  const upstreamIsHttps = upstream.protocol === 'https:';
  const agent = new (upstreamIsHttps ? https : http).Agent({ keepAlive: true, maxSockets: 32 });
  const limitGeneral = createLimiter(config.rateGeneral, config.rateWindowMs);
  const limitJoin = createLimiter(config.rateJoin, config.rateWindowMs);
  const limitPick = createLimiter(config.ratePick, config.rateWindowMs);
  const startedAt = Date.now();
  let healthCache = { at: 0, ok: false };

  function log(...args) {
    if (!config.quiet) console.log('[remote]', ...args);
  }
  function logErr(...args) {
    if (!config.quiet) console.error('[remote]', ...args);
  }

  function healthCheck() {
    const now = Date.now();
    if (now - healthCache.at < 5000) return Promise.resolve(healthCache.ok);
    return new Promise((resolve) => {
      const url = new URL('/api/health', upstream);
      const client = url.protocol === 'https:' ? https : http;
      const req = client.request({
        protocol: url.protocol,
        hostname: upstreamHost,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        timeout: 2500,
        headers: { 'user-agent': 'remote-health' },
      }, (r) => {
        r.resume();
        const ok = r.statusCode >= 200 && r.statusCode < 500;
        healthCache = { at: Date.now(), ok };
        resolve(ok);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', () => { healthCache = { at: Date.now(), ok: false }; resolve(false); });
      req.end();
    });
  }

  function rateLimited(req, res, pathname) {
    const isApi = isApiPath(pathname);
    if (isApi) {
      json(res, 429, { ok: false, nack: { code: 'rate_limited', msg: '提交太频繁，请稍后再试' } }, { 'retry-after': '60' });
    } else {
      page(res, 429, '请求太频繁', '请稍后再试。', { 'retry-after': '60' });
    }
  }

  function notAllowed(res, pathname) {
    const known = PUBLIC_GET.has(pathname) || PUBLIC_POST.has(pathname);
    if (known) {
      if (isApiPath(pathname)) {
        json(res, 405, { ok: false, nack: { code: 'method_not_allowed', msg: '该接口只允许 GET / POST 中对应的方法' } });
      } else {
        page(res, 405, '方法不允许', '这个页面只支持 GET。');
      }
      return;
    }
    if (isApiPath(pathname)) {
      json(res, 404, { ok: false, nack: { code: 'not_found', msg: '该接口不在公网开放范围' } });
    } else {
      page(res, 404, '页面不存在', '这个地址不在公网开放范围。本入口只提供现场签到与扫码选曲。');
    }
  }

  function proxy(req, res, { ip, pathname, url }) {
    const basePath = upstream.pathname.replace(/\/+$/, '');
    // 用解析后的 pathname + search，不直接拼接可能带绝对形式的 req.url
    const targetPath = `${basePath}${url.pathname}${url.search}`;
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (HOP_BY_HOP.includes(k.toLowerCase())) continue;
      if (['host', 'cookie', 'authorization', 'x-remote-token', 'x-remote-client-ip'].includes(k.toLowerCase())) continue;
      headers[k] = v;
    }
    const edgeHttps = isHttpsRequest(req, config);
    headers.host = upstream.host;
    headers['x-forwarded-for'] = ip;
    headers['x-remote-client-ip'] = ip;
    headers['x-forwarded-proto'] = edgeHttps ? 'https' : 'http';
    headers['x-forwarded-host'] = (config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host || '';
    if (config.token) headers['x-remote-token'] = config.token;

    // 先看 Content-Length，超限直接拒绝，避免白连一次上游 / 发出截断请求
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > config.maxBodyBytes) {
      if (isApiPath(pathname)) json(res, 413, { ok: false, nack: { code: 'body_too_large', msg: '提交内容过大' } });
      else page(res, 413, '提交内容过大', '这个表单的数据超出了大小限制。');
      req.resume();
      return;
    }

    const client = upstreamIsHttps ? https : http;
    const proxyReq = client.request({
      protocol: upstream.protocol,
      hostname: upstreamHost,
      port: upstream.port || (upstreamIsHttps ? 443 : 80),
      method: req.method,
      path: targetPath,
      headers,
      agent,
      timeout: config.timeoutMs,
    }, (upRes) => {
      const out = { ...upRes.headers };
      for (const h of HOP_BY_HOP) delete out[h];
      for (const h of SECURITY_OVERRIDES) delete out[h];
      delete out['set-cookie'];
      Object.assign(out, securityHeaders(edgeHttps));
      res.writeHead(upRes.statusCode || 502, out);
      upRes.pipe(res);
      res.on('close', () => { if (!res.writableEnded) upRes.destroy(); });
      upRes.on('error', () => res.destroy());
    });

    proxyReq.on('timeout', () => proxyReq.destroy(Object.assign(new Error('upstream timeout'), { code: 'timeout' })));
    proxyReq.on('error', (e) => {
      logErr('upstream error', e.code || '', e.message || '');
      if (!res.headersSent) {
        if (isApiPath(pathname)) json(res, 502, { ok: false, nack: { code: 'upstream_unavailable', msg: '上游服务暂不可用，请稍后再试' } });
        else page(res, 502, '服务暂不可用', '上游服务暂时无法连接，请稍后再试。');
      } else {
        res.destroy();
      }
    });
    req.on('aborted', () => proxyReq.destroy());

    if (req.method === 'GET' || req.method === 'HEAD') {
      proxyReq.end();
      return;
    }

    let size = 0;
    const guard = new Transform({
      transform(chunk, enc, cb) {
        size += chunk.length;
        if (size > config.maxBodyBytes) return cb(Object.assign(new Error('body too large'), { code: 'body_too_large' }));
        cb(null, chunk);
      },
    });
    guard.on('error', (e) => {
      logErr('body error', e.code || '', e.message || '');
      if (!res.headersSent) {
        if (isApiPath(pathname)) json(res, 413, { ok: false, nack: { code: 'body_too_large', msg: '提交内容过大' } });
        else page(res, 413, '提交内容过大', '这个表单的数据超出了大小限制。');
      }
      proxyReq.destroy();
      req.resume();
    });
    req.pipe(guard).pipe(proxyReq);
  }

  function handler(req, res) {
    const started = Date.now();
    let url;
    try { url = new URL(req.url || '/', 'http://remote.local'); }
    catch {
      json(res, 400, { ok: false, nack: { code: 'bad_request', msg: '请求地址不合法' } });
      return;
    }
    const pathname = url.pathname;
    const ip = getClientIp(req, config.trustProxy);
    const isHttps = isHttpsRequest(req, config);
    if (isHttps) res.setHeader('strict-transport-security', 'max-age=15552000; includeSubDomains');
    res.on('finish', () => {
      if (config.quiet) return;
      log(`${ip} ${req.method} ${String(req.url || '').slice(0, 180)} -> ${res.statusCode} ${Date.now() - started}ms`);
    });

    if (!limitGeneral(ip)) return rateLimited(req, res, pathname);

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (pathname === '/') {
        const html = Buffer.from(landingHtml());
        res.writeHead(200, {
          ...securityHeaders(isHttpsRequest(req, config)),
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': html.length,
        });
        return res.end(req.method === 'HEAD' ? undefined : html);
      }
      if (pathname === '/healthz') {
        return healthCheck().then((ok) => {
          json(res, ok ? 200 : 503, {
            ok,
            service: 'remote',
            upstreamOk: ok,
            uptimeSec: Math.round((Date.now() - startedAt) / 1000),
            time: new Date().toISOString(),
          });
        });
      }
      if (pathname === '/favicon.ico') { res.writeHead(204, securityHeaders(false)); return res.end(); }
    }

    if (!isAllowed(req.method, pathname)) return notAllowed(res, pathname);

    if (pathname === '/api/lottery/join' && !limitJoin(ip)) return rateLimited(req, res, pathname);
    if (pathname === '/api/match/pick' && !limitPick(ip)) return rateLimited(req, res, pathname);

    proxy(req, res, { ip, pathname, url });
  }

  const tls = config.tlsCert
    ? { cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) }
    : null;
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  server.requestTimeout = Math.max(10_000, config.timeoutMs + 5_000);
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  server.on('close', () => { try { agent.destroy(); } catch { /* ignore */ } });
  return server;
}

// ── CLI ──
function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`公网远端入口

用法：
  node remote/index.mjs               # 读取 remote/config.json + REMOTE_* 环境变量
  REMOTE_UPSTREAM=http://127.0.0.1:3000 REMOTE_PORT=8787 node remote/index.mjs

常用环境变量：
  REMOTE_HOST / REMOTE_PORT / REMOTE_UPSTREAM / REMOTE_TOKEN
  REMOTE_TLS_CERT / REMOTE_TLS_KEY / REMOTE_TRUST_PROXY
  REMOTE_RATE_GENERAL / REMOTE_RATE_JOIN / REMOTE_RATE_PICK
  REMOTE_MAX_BODY / REMOTE_TIMEOUT_MS / REMOTE_QUIET

只开放：/join /pick /shared/style.css /api/music /api/music/meta
        /api/match/public /api/match/pick /api/lottery/join
详见 remote/README.md。`);
    process.exit(0);
  }

  let config;
  try { config = loadConfig(); }
  catch (e) { console.error(`[remote] 配置错误：${e.message}`); process.exit(1); }

  let server;
  try { server = createRemoteServer(config); }
  catch (e) { console.error(`[remote] 启动失败：${e.message}`); process.exit(1); }

  server.listen(config.port, config.host, () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : config.port;
    const scheme = config.tlsCert ? 'https' : 'http';
    console.log(`[remote] 公网入口已启动：${scheme}://${config.host}:${port}`);
    console.log(`[remote] 上游：${config.upstream}`);
    console.log('[remote] 开放：/join /pick /shared/style.css /api/music /api/music/meta /api/match/public /api/match/pick /api/lottery/join');
    console.log('[remote] 控制台 / OBS / vMix / 设置等路径不会经过这里。');
    if (!config.token) {
      console.log('[remote] 提示：未设置 REMOTE_TOKEN；若远端不在主控同一台机器，主控可能把所有公网请求当成同一个 IP。');
    } else if (/^CHANGE-ME/i.test(config.token)) {
      console.log('[remote] ⚠ 还在使用示例 token，请改成随机长字符串，并与主服务 LP_REMOTE_TOKEN 一致。');
    }
    if (!config.tlsCert && !config.trustProxy) {
      console.log('[remote] 提示：未启用内置 TLS，也没有声明 trustProxy；公网访问建议用 Caddy/nginx 或配置证书。');
    }
  });
  server.on('error', (e) => {
    console.error(`[remote] 监听失败：${e.message}`);
    process.exit(1);
  });

  let closing = false;
  const shutdown = (sig) => {
    if (closing) return;
    closing = true;
    console.log(`[remote] 收到 ${sig}，正在关闭…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
