/**
 * Edge / Agent 本地图形配置台（remote/setup.mjs）。
 *
 * 覆盖：
 *   · 页面与状态接口可用，setup token 不泄漏到页面源码之外；
 *   · 只允许 127.0.0.1 / localhost 的 Host（防 DNS rebinding）；
 *   · 无 token 的 POST 被拒绝；
 *   · 配置校验（必填、端口、TLS 成对）与保存；
 *   · 密钥生成格式；
 *   · 服务启动 / 停止（真实 spawn Agent 进程）。
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSetupServer } from '../remote/setup.mjs';

const SETUP_TOKEN = 'setup-test-token-123456';
let dir;
let configFile;
let setup;
let base;
let agentSetup;
let agentBase;
let agentFile;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function request(urlBase, pathname, { method = 'GET', body, token, host } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = payload.length;
    }
    if (token) headers['x-setup-token'] = token;
    if (host) headers.host = host;
    const req = http.request(urlBase + pathname, { method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(text); } catch { /* html */ }
        resolve({ status: res.statusCode, headers: res.headers, text, data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function post(pathname, body, token = SETUP_TOKEN, urlBase = base) {
  return request(urlBase, pathname, { method: 'POST', body, token });
}

async function waitFor(fn, ms = 8000, label = '') {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return; } catch { /* ignore */ }
    if (Date.now() - t0 > ms) throw new Error(`超时：${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const VALID_EDGE = {
  host: '127.0.0.1',
  port: 18791,
  agentToken: 'E'.repeat(43),
  tlsCert: '',
  tlsKey: '',
  trustProxy: false,
  rateGeneral: 240,
  rateJoin: 10,
  ratePick: 30,
  rateWindowMs: 60000,
  maxBodyBytes: 32768,
  maxResponseBytes: 2097152,
  timeoutMs: 15000,
  maxInflight: 64,
  maxConnections: 512,
  heartbeatMs: 20000,
  blockIps: ['1.2.3.4', '5.6.7.8'],
  quiet: true,
};

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arcade-setup-'));
  configFile = path.join(dir, 'edge.config.json');
  setup = createSetupServer({ role: 'edge', configFile, setupToken: SETUP_TOKEN, quiet: true });
  base = `http://127.0.0.1:${await listen(setup.server)}`;

  agentFile = path.join(dir, 'agent.config.json');
  agentSetup = createSetupServer({ role: 'agent', configFile: agentFile, setupToken: SETUP_TOKEN, quiet: true });
  agentBase = `http://127.0.0.1:${await listen(agentSetup.server)}`;
});

after(async () => {
  await setup.stopAll();
  await agentSetup.stopAll();
  await new Promise((r) => setup.server.close(r));
  await new Promise((r) => agentSetup.server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('★ 配置台页面可打开，安全头齐全，令牌不泄漏', async () => {
  const r = await request(base, '/');
  assert.equal(r.status, 200);
  assert.match(r.text, /配置台/);
  assert.ok(r.headers['content-security-policy'], '必须有 CSP');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.ok(r.text.includes(SETUP_TOKEN), '页面需要内嵌令牌供本页调用');
  assert.ok(!r.text.includes('__SETUP_TOKEN__'), '模板占位符必须被替换');
});

test('★★ 只允许本机 Host（防 DNS rebinding）', async () => {
  const bad = await request(base, '/', { host: 'evil.example.com' });
  assert.equal(bad.status, 403);
  const badApi = await request(base, '/api/state', { host: 'evil.example.com' });
  assert.equal(badApi.status, 403);
});

test('★ 状态接口返回字段、规则、服务与默认配置', async () => {
  const r = await request(base, '/api/state?since=0', { token: SETUP_TOKEN });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.role, 'edge');
  assert.ok(r.data.fields.length >= 15);
  assert.ok(r.data.rules.length >= 5, '密钥规则必须下发到界面');
  assert.equal(r.data.services.length, 1);
  assert.equal(r.data.services[0].id, 'edge');
  assert.equal(r.data.services[0].running, false);
  assert.ok(Object.hasOwn(r.data.config, 'agentToken'));
});

test('★★ 读写接口都必须带配置台令牌', async () => {
  const noToken = await post('/api/config', { config: VALID_EDGE }, '');
  assert.equal(noToken.status, 403);
  const wrong = await post('/api/config', { config: VALID_EDGE }, 'wrong-token');
  assert.equal(wrong.status, 403);
  assert.ok(!fs.existsSync(configFile), '未授权请求不应写盘');

  const read = await request(base, '/api/state?since=0');
  assert.equal(read.status, 403, '状态里含密钥，未授权也不能读');
});

test('★ 配置校验：必填与 TLS 成对', async () => {
  const empty = await post('/api/config', { config: { agentToken: '' } });
  assert.equal(empty.status, 400);
  assert.ok(empty.data.errors.some((e) => e.field === 'agentToken'));

  const tls = await post('/api/config', { config: { ...VALID_EDGE, tlsCert: 'C:/certs/a.pem' } });
  assert.equal(tls.status, 400);
  assert.match(tls.data.error, /TLS/);

  const badPort = await post('/api/config', { config: { ...VALID_EDGE, port: 99999 } });
  assert.equal(badPort.status, 400);
});

test('★★ 保存配置：归一化、写入磁盘、丢弃未知字段', async () => {
  const r = await post('/api/config', {
    config: { ...VALID_EDGE, blockIps: '1.2.3.4\n5.6.7.8', evil: 'should-not-be-saved' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.deepEqual(r.data.config.blockIps, ['1.2.3.4', '5.6.7.8']);

  const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(saved.agentToken, VALID_EDGE.agentToken);
  assert.deepEqual(saved.blockIps, ['1.2.3.4', '5.6.7.8']);
  assert.ok(!Object.hasOwn(saved, 'evil'));

  const state = await request(base, '/api/state?since=0', { token: SETUP_TOKEN });
  assert.equal(state.data.config.agentToken, VALID_EDGE.agentToken);
  assert.equal(state.data.configExists, true);
});

test('★ 生成密钥：32 字节 base64url（43 位）', async () => {
  const r = await post('/api/generate', { field: 'agentToken' });
  assert.equal(r.status, 200);
  assert.match(r.data.token, /^[A-Za-z0-9_-]{43}$/);

  const denied = await post('/api/generate', { field: 'host' });
  assert.equal(denied.status, 400, '只允许给密钥字段生成');
});

test('★★ 主控已在外部运行时，配置台不重复启动', async () => {
  const fake = http.createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const fakePort = await listen(fake);
  try {
    const cfg = {
      edgeUrl: 'ws://127.0.0.1:1/tunnel',
      token: 'A'.repeat(43),
      localUpstream: `http://127.0.0.1:${fakePort}`,
      remoteToken: 'B'.repeat(43),
    };
    const saved = await post('/api/config', { config: cfg }, SETUP_TOKEN, agentBase);
    assert.equal(saved.status, 200);

    const r = await post('/api/service/start', { id: 'main' }, SETUP_TOKEN, agentBase);
    assert.equal(r.status, 200);
    assert.equal(r.data.alreadyRunning, true);

    const rr = await post('/api/service/restart', { id: 'main' }, SETUP_TOKEN, agentBase);
    assert.equal(rr.status, 200);
    assert.equal(rr.data.alreadyRunning, true);
    assert.equal(rr.data.external, true, '外部进程无法被配置台重启，必须明确告知');

    const s = await request(agentBase, '/api/state?since=0', { token: SETUP_TOKEN });
    assert.equal(s.data.services.find((x) => x.id === 'main').running, false, '不应 spawn 第二个主控');
  } finally {
    await new Promise((res) => fake.close(res));
  }
});

test('★★ 内网端：保存配置并真实启动 / 停止 Agent', async () => {
  const validAgent = {
    edgeUrl: 'ws://127.0.0.1:1/tunnel',
    token: 'A'.repeat(43),
    localUpstream: 'http://127.0.0.1:3000',
    remoteToken: 'B'.repeat(43),
    tlsInsecure: false,
    quiet: true,
  };
  const saved = await post('/api/config', { config: validAgent }, SETUP_TOKEN, agentBase);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));

  const started = await post('/api/service/start', { id: 'agent' }, SETUP_TOKEN, agentBase);
  assert.equal(started.status, 200);
  await waitFor(async () => {
    const s = await request(agentBase, '/api/state?since=0', { token: SETUP_TOKEN });
    return s.data.services.find((x) => x.id === 'agent').running === true;
  }, 8000, 'Agent 进程启动');

  const stopped = await post('/api/service/stop', { id: 'agent' }, SETUP_TOKEN, agentBase);
  assert.equal(stopped.status, 200);
  await waitFor(async () => {
    const s = await request(agentBase, '/api/state?since=0', { token: SETUP_TOKEN });
    return s.data.services.find((x) => x.id === 'agent').running === false;
  }, 8000, 'Agent 进程停止');

  const logs = await request(agentBase, '/api/state?since=0', { token: SETUP_TOKEN });
  assert.ok(logs.data.logs.lines.some((l) => l.text.includes('启动')), '应能看到启动日志');
});
