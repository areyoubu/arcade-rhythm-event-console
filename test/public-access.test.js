/**
 * 外网访问 OBS 输出的总开关。
 *
 * 默认只允许内网访问 /render /assets /media 等无鉴权输出；
 * 现场签到 / 选曲等公共页面不受影响。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../server/config.js';
import { configureLogging, networkRecent } from '../server/logger.js';
import { isProtectedOutputPath, outputAccessGate } from '../server/public-access.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-pubaccess-'));
const REAL_ALLOW = getConfig().server.allowPublicOutputs;

before(() => {
  configureLogging({ dir: TMP, level: 'info', retain: 30 });
});

after(() => {
  getConfig().server.allowPublicOutputs = REAL_ALLOW;
  fs.rmSync(TMP, { recursive: true, force: true });
});

function mockReq(pathname, ip, method = 'GET') {
  return {
    path: pathname,
    method,
    socket: { remoteAddress: ip },
    ip,
    headers: {},
    get() { return ''; },
  };
}

function run(req) {
  return new Promise((resolve) => {
    const res = {
      code: 200,
      body: null,
      status(c) { this.code = c; return this; },
      type() { return this; },
      send(b) { this.body = b; resolve({ next: false, res: this }); },
    };
    outputAccessGate(req, res, () => resolve({ next: true, res }));
  });
}

test('★ 输出路径识别（大小写不敏感）', () => {
  for (const p of ['/render/score', '/RENDER/match', '/assets/liveroom-background.png',
    '/media/abc.png', '/covers/3.webp', '/COVERS/3.webp', '/api/render/bootstrap',
    '/API/MATCH/PICKURL', '/api/match/qr', '/API/LOTTERY/QR']) {
    assert.equal(isProtectedOutputPath(p), true, `${p} 应受保护`);
  }
  for (const p of ['/join', '/pick', '/shared/style.css', '/api/music', '/api/match/public', '/']) {
    assert.equal(isProtectedOutputPath(p), false, `${p} 不应被当成 OBS 输出`);
  }
});

test('★★ 默认禁止外网访问 OBS 输出，内网正常', async () => {
  getConfig().server.allowPublicOutputs = false;

  const external = await run(mockReq('/render/score', '203.0.113.9'));
  assert.equal(external.next, false);
  assert.equal(external.res.code, 403);

  const lan = await run(mockReq('/render/score', '192.168.1.30'));
  assert.equal(lan.next, true, '内网机器应正常访问');

  const lanV6 = await run(mockReq('/media/a.png', 'fd12:3456::1'));
  assert.equal(lanV6.next, true, 'IPv6 ULA 内网应正常访问');
});

test('★★ 公共签到 / 选曲不受外网开关影响', async () => {
  getConfig().server.allowPublicOutputs = false;
  for (const p of ['/join', '/pick', '/shared/style.css', '/api/music', '/api/match/public']) {
    const r = await run(mockReq(p, '203.0.113.9'));
    assert.equal(r.next, true, `公网 ${p} 应放行`);
  }
});

test('★★ 打开开关后外网可访问；关闭后立即恢复拦截', async () => {
  getConfig().server.allowPublicOutputs = true;
  assert.equal((await run(mockReq('/render/score', '203.0.113.9'))).next, true);

  getConfig().server.allowPublicOutputs = false;
  assert.equal((await run(mockReq('/render/score', '203.0.113.9'))).next, false);
});

test('★ 外网访问被拦会写入风险日志（external-blocked）', async () => {
  getConfig().server.allowPublicOutputs = false;
  await run(mockReq('/assets/liveroom-background.png', '198.51.100.5'));
  await new Promise((r) => setTimeout(r, 30));
  const hit = networkRecent(20).find((r) => r.kind === 'external-blocked' && r.ip === '198.51.100.5');
  assert.ok(hit, '应记录 external-blocked 风险日志');
  assert.equal(hit.path, '/assets/liveroom-background.png');
});
