/**
 * 后台密码设置接口 —— 只对内网开放、改密需要当前密码、失败有防爆破。
 *
 * 用临时 LP_CONFIG，绝不碰真实 config.json。
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-admin-pw-'));
const CONFIG = path.join(TMP, 'config.json');
process.env.LP_CONFIG = CONFIG;
delete process.env.LP_ADMIN_TOKEN;

fs.writeFileSync(CONFIG, JSON.stringify({
  server: { host: '127.0.0.1', overlayPort: 13900, controlPort: 13901, adminPasswordHash: '' },
}, null, 2));

const express = (await import('express')).default;
const { default: adminRoutes } = await import('../server/routes/admin.js');
const { getConfig } = await import('../server/config.js');
const { verifyPassword, resetAuthFailuresForTest } = await import('../server/admin-auth.js');

let server;
let base;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', adminRoutes());
  server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
  delete process.env.LP_CONFIG;
});

async function call(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(base + pathname, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, headers: res.headers };
}

test('★ 初始状态：未设密码、可编辑、识别为内网', async () => {
  const r = await call('/api/admin/status');
  assert.equal(r.status, 200);
  assert.equal(r.data.passwordSet, false);
  assert.equal(r.data.editable, true);
  assert.equal(r.data.lan, true);
});

test('★★ 初始化密码：太短拒绝，正常密码写入 scrypt 散列', async () => {
  resetAuthFailuresForTest();
  const weak = await call('/api/admin/password', { method: 'POST', body: { next: '123' } });
  assert.equal(weak.status, 400);
  assert.equal(weak.data.nack.code, 'weak_password');

  const ok = await call('/api/admin/password', { method: 'POST', body: { next: 'InitPass1234' } });
  assert.equal(ok.status, 200);
  const hash = getConfig().server.adminPasswordHash;
  assert.match(hash, /^scrypt:/);
  assert.equal(verifyPassword('InitPass1234', hash), true);
  assert.ok(!hash.includes('InitPass1234'));

  const status = await call('/api/admin/status');
  assert.equal(status.data.passwordSet, true);
});

test('★★ 改密码必须验证当前密码；错误计入防爆破', async () => {
  resetAuthFailuresForTest();
  const wrong = await call('/api/admin/password', {
    method: 'POST', body: { current: 'wrong', next: 'AnotherPass123' },
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.data.nack.code, 'bad_current');

  const ok = await call('/api/admin/password', {
    method: 'POST', body: { current: 'InitPass1234', next: 'AnotherPass123' },
  });
  assert.equal(ok.status, 200);
  assert.equal(verifyPassword('AnotherPass123', getConfig().server.adminPasswordHash), true);
  assert.equal(verifyPassword('InitPass1234', getConfig().server.adminPasswordHash), false);
});

test('★ 后台状态包含外网开关、被锁定 IP 与风险操作', async () => {
  const r = await call('/api/admin/status');
  assert.equal(r.status, 200);
  assert.equal(typeof r.data.allowPublicOutputs, 'boolean');
  assert.ok(Array.isArray(r.data.blocked));
  assert.ok(Array.isArray(r.data.risks));
  assert.ok(r.data.risks.some((x) => x.kind === 'admin-password-change'), '改密操作应出现在风险列表');
});

test('★★ 修改外网访问开关：需要当前密码，写盘并立即生效', async () => {
  resetAuthFailuresForTest();
  const wrong = await call('/api/admin/public-access', {
    method: 'POST', body: { allow: true, current: 'wrong' },
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.data.nack.code, 'bad_current');

  const ok = await call('/api/admin/public-access', {
    method: 'POST', body: { allow: true, current: 'AnotherPass123' },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.allowPublicOutputs, true);
  assert.equal(getConfig().server.allowPublicOutputs, true);

  const disk = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  assert.equal(disk.server.allowPublicOutputs, true, '必须持久化到配置文件');

  // 恢复默认：禁止
  const back = await call('/api/admin/public-access', {
    method: 'POST', body: { allow: false, current: 'AnotherPass123' },
  });
  assert.equal(back.status, 200);
  assert.equal(back.data.allowPublicOutputs, false);
  assert.equal(getConfig().server.allowPublicOutputs, false);
});

test('★★ 同一 IP 连续错 5 次后锁定：429 + Retry-After，正确密码也拒绝', async () => {
  resetAuthFailuresForTest();
  let last;
  for (let i = 0; i < 5; i += 1) {
    last = await call('/api/admin/password', {
      method: 'POST', body: { current: `wrong-${i}`, next: 'AnotherPass456' },
    });
  }
  assert.equal(last.status, 429);
  assert.equal(last.data.nack.code, 'too_many_attempts');
  assert.ok(Number(last.headers.get('retry-after')) > 0);

  const correctWhileLocked = await call('/api/admin/password', {
    method: 'POST', body: { current: 'AnotherPass123', next: 'AnotherPass456' },
  });
  assert.equal(correctWhileLocked.status, 429, '锁定期内正确密码也不能改密');
  resetAuthFailuresForTest();
});
