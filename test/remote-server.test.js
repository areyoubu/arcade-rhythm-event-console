/**
 * 公网远端入口的代理行为。
 *
 * 用真实 HTTP mock 上游 + 真实远端服务验证：
 *   · 公共路径能转发；
 *   · 控制接口不会被转发；
 *   · token / 真实 IP 会带给上游；
 *   · 安全头、body 上限、限流生效。
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRemoteServer } from '../remote/index.mjs';

let mock;
let remote;
let base;
let mockPort;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
function close(server) {
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
async function req(pathname, opts = {}) {
  const res = await fetch(base + pathname, opts);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* text */ }
  return { status: res.status, headers: res.headers, text, data };
}

before(async () => {
  mock = http.createServer((rq, rs) => {
    let body = '';
    rq.on('data', (c) => { body += c; });
    rq.on('end', () => {
      const u = new URL(rq.url, 'http://mock');
      if (u.pathname === '/api/health') return sendJson(rs, 200, { ok: true });
      if (u.pathname === '/api/match/public') {
        return sendJson(rs, 200, { ok: true, marker: 'public', token: rq.headers['x-remote-token'] || '' });
      }
      if (u.pathname === '/api/match/pick') {
        return sendJson(rs, 200, {
          ok: true,
          echo: {
            token: rq.headers['x-remote-token'] || '',
            ip: rq.headers['x-remote-client-ip'] || '',
            fwd: rq.headers['x-forwarded-for'] || '',
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
  mockPort = await listen(mock);
  remote = createRemoteServer({
    upstream: `http://127.0.0.1:${mockPort}`,
    token: 'test-secret',
    trustProxy: false,
    rateGeneral: 1000,
    rateJoin: 1000,
    ratePick: 1000,
    maxBodyBytes: 2048,
    timeoutMs: 3000,
    quiet: true,
  });
  base = `http://127.0.0.1:${await listen(remote)}`;
});

after(async () => {
  await close(remote);
  await close(mock);
});

test('★ 公共首页 / 签到页 / 样式 / 健康检查', async () => {
  const land = await req('/');
  assert.equal(land.status, 200);
  assert.match(land.text, /现场签到/);
  assert.match(land.text, /赛事公共入口/);

  const join = await req('/join');
  assert.equal(join.status, 200);
  assert.match(join.text, /join/);

  const css = await req('/shared/style.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') || '', /text\/css/);
  assert.equal(css.headers.get('set-cookie'), null, '不能把上游 Cookie 漏给公网');
  assert.ok(css.headers.get('content-security-policy'), '必须有 CSP');

  const health = await req('/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true);
});

test('★★ 公共 API 转发，控制 API 不转发', async () => {
  const pub = await req('/api/match/public');
  assert.equal(pub.status, 200);
  assert.equal(pub.data.marker, 'public');
  assert.equal(pub.data.token, 'test-secret', '远端 token 要带给上游');

  const denied = await req('/api/match/state');
  assert.equal(denied.status, 404);
  assert.equal(denied.data.nack.code, 'not_found');
  assert.ok(!denied.text.includes('CONTROL_ONLY'), '控制数据绝对不能经过公网入口');
});

test('★ POST 选曲 / 签到转发，并带上真实客户端 IP', async () => {
  const pick = await req('/api/match/pick', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ musicId: 3, difficulty: 'master' }),
  });
  assert.equal(pick.status, 200);
  assert.equal(pick.data.echo.token, 'test-secret');
  assert.equal(pick.data.echo.ip, '127.0.0.1', '测试客户端从本机连入');
  assert.equal(pick.data.echo.body.musicId, 3);

  const join = await req('/api/lottery/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '测试' }),
  });
  assert.equal(join.status, 200);
  assert.equal(join.data.ticket, 1);
});

test('★ body 上限 / 方法限制 / 非白名单页面', async () => {
  const tooBig = await req('/api/match/pick', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x: 'a'.repeat(3000) }),
  });
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.data.nack.code, 'body_too_large');

  const wrongMethod = await req('/api/match/pick');
  assert.equal(wrongMethod.status, 405);

  const outputs = await req('/outputs');
  assert.equal(outputs.status, 404);
  assert.match(outputs.text, /不在公网开放范围/);
});

test('★ 选曲 POST 限流按 IP 独立生效', async () => {
  const limited = createRemoteServer({
    upstream: `http://127.0.0.1:${mockPort}`,
    rateGeneral: 1000,
    rateJoin: 1000,
    ratePick: 1,
    quiet: true,
  });
  const port = await listen(limited);
  const b = `http://127.0.0.1:${port}`;
  try {
    const one = await fetch(`${b}/api/match/pick`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    const two = await fetch(`${b}/api/match/pick`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(one.status, 200);
    assert.equal(two.status, 429);
    assert.equal((await two.json()).nack.code, 'rate_limited');
  } finally {
    await close(limited);
  }
});
