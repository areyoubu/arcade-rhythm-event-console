/**
 * 远端入口共用的小工具：安全头、错误页、限流、配置解析、body 读取。
 * 不依赖 Express；edge / agent / 直连模式都可以用。
 */
import fs from 'node:fs';

export const HOP_BY_HOP = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
];

export const SECURITY_OVERRIDES = [
  'content-security-policy', 'x-frame-options', 'x-content-type-options',
  'referrer-policy', 'permissions-policy', 'cross-origin-opener-policy',
  'strict-transport-security',
];

export function boolOf(v) {
  return /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
}

export function numOf(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function securityHeaders(isHttps = false) {
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

export function isHttpsRequest(req, trustProxy = false) {
  if (req.socket?.encrypted) return true;
  if (trustProxy) {
    return String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  }
  return false;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function json(res, code, body, extra = {}) {
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

export function page(res, code, title, message, extra = {}) {
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

export function landingHtml() {
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
  else {dot.className='dot err';s.textContent='本体暂未连接，请稍后再试';}
}).catch(function(){document.getElementById('dot').className='dot err';document.getElementById('status').textContent='无法连接公共入口';});
</script>
</body>
</html>`;
}

export function createLimiter(max, windowMs) {
  if (!max) return () => true;
  const hits = new Map();
  return function allow(ip) {
    const key = String(ip || 'unknown');
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) { hits.set(key, arr); return false; }
    arr.push(now);
    hits.set(key, arr);
    if (hits.size > 4000) hits.clear();
    return true;
  };
}

/**
 * 读取 HTTP body，带硬上限。
 * @returns {Promise<{ok:boolean, code?:string, body?:Buffer}>}
 */
export function readBody(req, maxBytes) {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > maxBytes) {
      resolve({ ok: false, code: 'body_too_large' });
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (r) => { if (done) return; done = true; resolve(r); };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        finish({ ok: false, code: 'body_too_large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ ok: true, body: Buffer.concat(chunks) }));
    req.on('error', () => finish({ ok: false, code: 'body_error' }));
    req.on('aborted', () => finish({ ok: false, code: 'aborted' }));
  });
}

/** 载入 JSON 配置（可选） */
export function loadJsonFile(file) {
  if (!file) return {};
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { throw new Error(`配置读取失败（${file}）：${e.message}`); }
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`配置解析失败（${file}）：${e.message}`); }
}
