/**
 * 分离网络拓扑：公网 Edge ↔ 内网 Agent ↔ 主控制台。
 *
 * 用真实 WebSocket 跑通：
 *   · Agent 主动出站连接 Edge（测试里是 127.0.0.1）；
 *   · 公网请求经 Edge 隧道到 Agent，再打到本地 mock 主服务；
 *   · 控制接口不转发；
 *   · Agent 断开时 Edge 503，重连后恢复；
 *   · token 错误时 Agent 无法接入；
 *   · 安全头 / set-cookie 剥离 / body 上限 / 方法限制。
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createEdgeServer } from '../remote/edge.mjs';
import { startAgent } from '../remote/agent.mjs';

const EDGE_TOKEN = 'edge-test-secret-123456';
const LOCAL_TOKEN = 'local-test-secret-123456';

let mock;
let edge;
let agent;
let edgeBase;
let mockUrl;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
function closeServer(server) {
  return new Promise((resolve) => {
    try { server.closeAllConnections?.(); } catch { /* ignore */ }
    server.close(() => resolve());
  });
}
function sendJson(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': buf.length });
  res.end(buf);
}
async function waitFor(fn, ms = 8000, label = '') {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return; } catch { /* ignore */ }
    if (Date.now() - t0 > ms) throw new Error(`超时：${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function req(pathname, opts = {}) {
  const res = await fetch(edgeBase + pathname, opts);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* text */ }
  return { status: res.status, headers: res.headers, text, data };
}
function startTestAgent(extra = {}) {
  return startAgent({
    edgeUrl: `${edgeBase.replace('http://', 'ws://')}/tunnel`,
    token: EDGE_TOKEN,
    localUpstream: mockUrl,
    remoteToken: LOCAL_TOKEN,
    timeoutMs: 3000,
    reconnectMinMs: 200,
    reconnectMaxMs: 1000,
    concurrency: 8,
    quiet: true,
    ...extra,
  });
}

before(async () => {
  mock = http.createServer((rq, rs) => {
    let body = '';
    rq.on('data', (c) => { body += c; });
    rq.on('end', () => {
      const u = new URL(rq.url, 'http://mock');
      if (u.pathname === '/api/health') return sendJson(rs, 200, { ok: true });
      if (u.pathname === '/api/match/public') {
        return sendJson(rs, 200, {
          ok: true, marker: 'public',
          token: rq.headers['x-remote-token'] || '',
          ip: rq.headers['x-remote-client-ip'] || '',
          fwd: rq.headers['x-forwarded-for'] || '',
          proto: rq.headers['x-forwarded-proto'] || '',
        });
      }
      if (u.pathname === '/api/match/pick') {
        return sendJson(rs, 200, {
          ok: true,
          echo: {
            token: rq.headers['x-remote-token'] || '',
            ip: rq.headers['x-remote-client-ip'] || '',
            body: body ? JSON.parse(body) : null,
          },
        });
      }
      if (u.pathname === '/api/lottery/join') return sendJson(rs, 200, { ok: true, ticket: 1 });
      if (u.pathname === '/shared/style.css') {
        rs.writeHead(200, { 'content-type': 'text/css', 'set-cookie': 'should=not-leak' });
        return rs.end('body{}');
      }
      if (u.pathname === '/join') {
        rs.writeHead(200, { 'content-type': 'text/html' });
        return rs.end('<!doctype html><title>join</title>');
      }
      if (u.pathname === '/api/match/state') return sendJson(rs, 200, { ok: true, secret: 'CONTROL_ONLY' });
      return sendJson(rs, 404, { ok: false });
    });
  });
  const mockPort = await listen(mock);
  mockUrl = `http://127.0.0.1:${mockPort}`;

  edge = createEdgeServer({
    host: '127.0.0.1',
    port: 0,
    agentToken: EDGE_TOKEN,
    trustProxy: false,
    rateGeneral: 1000,
    rateJoin: 1000,
    ratePick: 1000,
    maxBodyBytes: 2048,
    maxResponseBytes: 2 * 1024 * 1024,
    timeoutMs: 3000,
    maxInflight: 16,
    quiet: true,
  });
  const edgePort = await listen(edge);
  edgeBase = `http://127.0.0.1:${edgePort}`;
  agent = startTestAgent();
  await waitFor(async () => {
    const r = await req('/healthz');
    return r.status === 200 && r.data?.agentConnected === true;
  }, 8000, 'Agent 接入');
});

after(async () => {
  try { agent?.stop(); } catch { /* ignore */ }
  await closeServer(edge);
  await closeServer(mock);
});

test('★ Agent 出站接入后，公网页面 / API 通过隧道可达', async () => {
  const land = await req('/');
  assert.equal(land.status, 200);
  assert.match(land.text, /赛事公共入口/);

  const join = await req('/join');
  assert.equal(join.status, 200);
  assert.match(join.text, /join/);

  const css = await req('/shared/style.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') || '', /text\/css/);
  assert.equal(css.headers.get('set-cookie'), null, '上游 Cookie 不应漏到公网');
  assert.ok(css.headers.get('content-security-policy'), '必须有 CSP');

  const pub = await req('/api/match/public');
  assert.equal(pub.status, 200);
  assert.equal(pub.data.marker, 'public');
  assert.equal(pub.data.token, LOCAL_TOKEN, 'Agent 应把主服务的 remoteToken 带给本地主服务');
  assert.equal(pub.data.ip, '127.0.0.1');
  assert.equal(pub.data.fwd, '127.0.0.1');
});

test('★★ 控制接口不经过公网入口', async () => {
  const denied = await req('/api/match/state');
  assert.equal(denied.status, 404);
  assert.equal(denied.data.nack.code, 'not_found');
  assert.ok(!denied.text.includes('CONTROL_ONLY'));

  const outputs = await req('/outputs');
  assert.equal(outputs.status, 404);
});

test('★ POST 选曲 / 签到经隧道转发，body 上限与错误方法生效', async () => {
  const pick = await req('/api/match/pick', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ musicId: 3, difficulty: 'master' }),
  });
  assert.equal(pick.status, 200);
  assert.equal(pick.data.echo.token, LOCAL_TOKEN);
  assert.equal(pick.data.echo.body.musicId, 3);

  const join = await req('/api/lottery/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '隧道测试' }),
  });
  assert.equal(join.status, 200);
  assert.equal(join.data.ticket, 1);

  const tooBig = await req('/api/match/pick', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x: 'a'.repeat(3000) }),
  });
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.data.nack.code, 'body_too_large');

  const wrongMethod = await req('/api/match/pick');
  assert.equal(wrongMethod.status, 405);
});

test('★★ Agent 断开 → Edge 返回 503；重新接入后恢复', async () => {
  agent.stop();
  await waitFor(async () => (await req('/healthz')).status === 503, 8000, 'Edge 感知 Agent 断开');
  const offline = await req('/api/match/public');
  assert.equal(offline.status, 503);
  assert.equal(offline.data.nack.code, 'agent_offline');

  agent = startTestAgent();
  await waitFor(async () => {
    const r = await req('/healthz');
    return r.status === 200 && r.data?.agentConnected === true;
  }, 8000, 'Agent 重连');
  const back = await req('/api/match/public');
  assert.equal(back.status, 200);
});

test('★★ 公网限流：签到接口超过窗口次数返回 429，普通页面不受影响', async () => {
  const limited = createEdgeServer({
    host: '127.0.0.1', port: 0, agentToken: EDGE_TOKEN,
    rateGeneral: 1000, rateJoin: 2, ratePick: 1000,
    maxBodyBytes: 2048, timeoutMs: 3000, quiet: true,
  });
  const port = await listen(limited);
  const base = `http://127.0.0.1:${port}`;
  const a = startAgent({
    edgeUrl: `ws://127.0.0.1:${port}/tunnel`,
    token: EDGE_TOKEN,
    localUpstream: mockUrl,
    remoteToken: LOCAL_TOKEN,
    reconnectMinMs: 200,
    reconnectMaxMs: 500,
    quiet: true,
  });
  try {
    await waitFor(async () => (await fetch(`${base}/healthz`)).status === 200, 8000, '限流测试 Agent 接入');
    const codes = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await fetch(`${base}/api/lottery/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `限流${i}` }),
      });
      codes.push(r.status);
      await r.text();
    }
    assert.deepEqual(codes, [200, 200, 429]);
    const land = await fetch(`${base}/`);
    assert.equal(land.status, 200, '页面访问不应被签到限流牵连');
    await land.text();
  } finally {
    a.stop();
    await closeServer(limited);
  }
});

test('★ Agent token 不匹配时无法接入', async () => {
  const wrongEdge = createEdgeServer({
    host: '127.0.0.1', port: 0, agentToken: 'right-token-123456', quiet: true,
    rateGeneral: 1000, maxBodyBytes: 2048,
  });
  const port = await listen(wrongEdge);
  const base = `http://127.0.0.1:${port}`;
  const bad = startAgent({
    edgeUrl: `ws://127.0.0.1:${port}/tunnel`,
    token: 'wrong-token-123456',
    localUpstream: mockUrl,
    quiet: true,
    reconnectMinMs: 200,
    reconnectMaxMs: 500,
  });
  try {
    await new Promise((r) => setTimeout(r, 700));
    const h = await fetch(`${base}/healthz`);
    const d = await h.json();
    assert.equal(d.agentConnected, false);
    assert.equal(d.ok, false);
  } finally {
    bad.stop();
    await closeServer(wrongEdge);
  }
});
