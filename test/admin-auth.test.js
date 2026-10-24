/**
 * 后台登录鉴权 —— 控制接口的保护层。
 *
 * 未配置 = 局域网信任模式（不拦）；配置后 = 写操作 / 读配置需要 Bearer 密码 / 令牌。
 * 密码以 scrypt 散列存储，明文不落盘。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  adminGate, adminAuthEnabled, isAdminAuthorized, hashPassword, verifyPassword,
  attemptAdminAuth, resetAuthFailuresForTest,
} from '../server/admin-auth.js';
import { getConfig } from '../server/config.js';

// 隔离：真实 config.json 里可能已设置密码散列，测试要能清空 / 复原它
const REAL_HASH = getConfig().server?.adminPasswordHash ?? '';

function mockReq({ path = '/api/config', method = 'GET', auth = '', ip = '203.0.113.9' } = {}) {
  return {
    path,
    method,
    headers: auth ? { authorization: auth } : {},
    socket: { remoteAddress: ip },
    get(name) { return name === 'authorization' ? auth : undefined; },
  };
}

function run(req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      jsonCode: 0,
      json: null,
      headers: {},
      setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
      status(c) { this.jsonCode = c; return this; },
      json: undefined,
    };
    res.json = function (obj) { this.json = obj; this.statusCode = this.jsonCode || 200; resolve({ next: false, res }); };
    adminGate(req, res, () => resolve({ next: true, res }));
  });
}

after(() => {
  delete process.env.LP_ADMIN_TOKEN;
  getConfig().server.adminPasswordHash = REAL_HASH;
});

test('★ 未设置密码 = 局域网信任模式，全部放行', async () => {
  delete process.env.LP_ADMIN_TOKEN;
  getConfig().server.adminPasswordHash = '';
  assert.equal(adminAuthEnabled(), false);
  for (const r of [mockReq({ path: '/api/config', method: 'POST' }), mockReq({ path: '/api/media/upload', method: 'POST' })]) {
    assert.equal((await run(r)).next, true);
  }
});

test('★ 密码散列：verifyPassword 正确 / 错误都判定正确，明文不落盘', () => {
  const hash = hashPassword('TestPass123');
  assert.match(hash, /^scrypt:[0-9a-f]+:[0-9a-f]+$/);
  assert.ok(!hash.includes('TestPass123'), '散列里不得出现明文');
  assert.equal(verifyPassword('TestPass123', hash), true);
  assert.equal(verifyPassword('wrong', hash), false);
  assert.equal(verifyPassword('TestPass123', 'garbage'), false);
});

test('★★ 设置明文令牌后，写操作无凭据 → 401，带凭据 → 放行', async () => {
  getConfig().server.adminPasswordHash = '';
  process.env.LP_ADMIN_TOKEN = 'secret-token';
  assert.equal(adminAuthEnabled(), true);

  const denied = await run(mockReq({ path: '/api/config', method: 'POST' }));
  assert.equal(denied.next, false);
  assert.equal(denied.res.jsonCode, 401);
  assert.equal(denied.res.json.nack.code, 'unauthorized');

  const ok = await run(mockReq({ path: '/api/config', method: 'POST', auth: 'Bearer secret-token' }));
  assert.equal(ok.next, true);

  assert.equal(isAdminAuthorized(mockReq({ auth: 'Bearer secret-token' })), true);
  assert.equal(isAdminAuthorized(mockReq({ auth: 'Bearer wrong' })), false);
});

test('★ 配置里存密码散列时，Bearer 密码验证（不存明文）', async () => {
  delete process.env.LP_ADMIN_TOKEN;
  getConfig().server.adminPasswordHash = hashPassword('TestPass123');
  assert.equal(adminAuthEnabled(), true);

  const denied = await run(mockReq({ path: '/api/config', method: 'POST', auth: 'Bearer wrong' }));
  assert.equal(denied.next, false);
  assert.equal(denied.res.jsonCode, 401);

  const ok = await run(mockReq({ path: '/api/config', method: 'POST', auth: 'Bearer TestPass123' }));
  assert.equal(ok.next, true);
});

test('★ 公开路径（签到 / 选曲）与渲染源只读接口无需令牌', async () => {
  process.env.LP_ADMIN_TOKEN = 'secret-token';
  for (const r of [
    mockReq({ path: '/api/lottery/join', method: 'POST' }),
    mockReq({ path: '/api/match/pick', method: 'POST' }),
    mockReq({ path: '/api/music', method: 'GET' }),
    mockReq({ path: '/api/match/public', method: 'GET' }),
    mockReq({ path: '/api/render/bootstrap', method: 'GET' }),
    mockReq({ path: '/api/match/pickUrl', method: 'GET' }),
    mockReq({ path: '/api/health', method: 'GET' }),
  ]) {
    assert.equal((await run(r)).next, true, `${r.method} ${r.path} 应放行`);
  }
});

test('★ 读配置（/api/config）即使 GET 也要令牌；静态页面不受影响', async () => {
  process.env.LP_ADMIN_TOKEN = 'secret-token';
  const denied = await run(mockReq({ path: '/api/config', method: 'GET' }));
  assert.equal(denied.next, false);
  assert.equal(denied.res.jsonCode, 401);

  const page = await run(mockReq({ path: '/settings', method: 'GET' }));
  assert.equal(page.next, true, '静态页面应放行，操作员才能打开页面输令牌');

  const data = await run(mockReq({ path: '/api/music/meta', method: 'GET' }));
  assert.equal(data.next, true, '公开只读接口应放行');
});

test('★★ 控制台只读数据（GET /api/entities 等）也要登录', async () => {
  process.env.LP_ADMIN_TOKEN = 'secret-token';
  for (const p of ['/api/entities', '/api/overlay/state', '/api/score/state', '/api/templates']) {
    const denied = await run(mockReq({ path: p, method: 'GET' }));
    assert.equal(denied.next, false, `GET ${p} 无令牌应 401`);
    assert.equal(denied.res.jsonCode, 401);

    const ok = await run(mockReq({ path: p, method: 'GET', auth: 'Bearer secret-token' }));
    assert.equal(ok.next, true, `GET ${p} 带令牌应放行`);
  }
});

test('★★ 大小写不敏感：/API/ 与 /Api/ 不能绕过鉴权', async () => {
  process.env.LP_ADMIN_TOKEN = 'secret-token';
  // Express 路由默认大小写不敏感，/API/media/upload 会命中 /api/media/upload，
  // 鉴权中间件必须按小写匹配，否则大写就能绕过。
  for (const p of ['/API/media/upload', '/Api/media/upload', '/API/ENTITIES', '/API/config']) {
    const denied = await run(mockReq({ path: p, method: p.includes('upload') ? 'POST' : 'GET' }));
    assert.equal(denied.next, false, `${p} 无令牌应 401（不能靠改大小写绕过）`);
    assert.equal(denied.res.jsonCode, 401);
  }
});

test('★★ 防爆破：同一 IP 连续错 5 次锁定，正确密码也进不来；其他 IP 不受影响', async () => {
  getConfig().server.adminPasswordHash = '';
  process.env.LP_ADMIN_TOKEN = 'secret-token';
  resetAuthFailuresForTest();

  const ip = '198.51.100.7';
  // 前 4 次：401；第 5 次触发锁定：429
  for (let i = 1; i <= 4; i += 1) {
    const r = attemptAdminAuth(mockReq({ path: '/api/config', method: 'POST', auth: `Bearer wrong-${i}`, ip }));
    assert.equal(r.ok, false);
    assert.equal(r.status, 401, `第 ${i} 次失败应 401`);
  }
  const fifth = attemptAdminAuth(mockReq({ path: '/api/config', method: 'POST', auth: 'Bearer wrong-5', ip }));
  assert.equal(fifth.ok, false);
  assert.equal(fifth.status, 429, '第 5 次失败应触发锁定');
  assert.ok(fifth.retryAfterSec > 0);

  // 锁定期内即使密码正确也拒绝
  const correctWhileLocked = attemptAdminAuth(mockReq({ path: '/api/config', method: 'POST', auth: 'Bearer secret-token', ip }));
  assert.equal(correctWhileLocked.ok, false);
  assert.equal(correctWhileLocked.status, 429);

  // 通过 adminGate 也应是 429（带 Retry-After）
  const gate = await run(mockReq({ path: '/api/config', method: 'POST', auth: 'Bearer secret-token', ip }));
  assert.equal(gate.next, false);
  assert.equal(gate.res.jsonCode, 429);

  // 另一个 IP 不受连累
  const other = attemptAdminAuth(mockReq({ path: '/api/config', method: 'POST', auth: 'Bearer secret-token', ip: '198.51.100.8' }));
  assert.equal(other.ok, true);

  resetAuthFailuresForTest();
});

test('★ 登录成功后清除失败计数', () => {
  process.env.LP_ADMIN_TOKEN = 'secret-token';
  resetAuthFailuresForTest();
  const ip = '198.51.100.9';
  for (let i = 0; i < 4; i += 1) {
    attemptAdminAuth(mockReq({ method: 'POST', auth: 'Bearer wrong', ip }));
  }
  const ok = attemptAdminAuth(mockReq({ method: 'POST', auth: 'Bearer secret-token', ip }));
  assert.equal(ok.ok, true, '第 5 次之前输对应该成功并清零');
  // 清零后再错 4 次不应立刻锁
  for (let i = 0; i < 4; i += 1) {
    const r = attemptAdminAuth(mockReq({ method: 'POST', auth: 'Bearer wrong', ip }));
    assert.equal(r.status, 401);
  }
  resetAuthFailuresForTest();
});
