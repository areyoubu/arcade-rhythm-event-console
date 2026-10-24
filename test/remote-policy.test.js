/**
 * 公网远端入口白名单 —— 控制接口绝不能漏出去。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowed, isApiPath, getClientIp } from '../remote/policy.mjs';

test('★★ 只放行签到 / 选曲所需的公共路径', () => {
  for (const p of ['/join', '/pick', '/shared/style.css', '/api/music', '/api/music/meta', '/api/match/public']) {
    assert.equal(isAllowed('GET', p), true, `GET ${p} 应放行`);
    assert.equal(isAllowed('HEAD', p), true, `HEAD ${p} 应放行`);
  }
  for (const p of ['/api/match/pick', '/api/lottery/join']) {
    assert.equal(isAllowed('POST', p), true, `POST ${p} 应放行`);
  }
});

test('★★ 控制接口 / OBS 源 / 设置 / WebSocket 一律不放行', () => {
  const denied = [
    '/ws', '/outputs', '/match', '/scoreboard', '/settings', '/overlay',
    '/render/match', '/render/score', '/api/match/state', '/api/lottery/state',
    '/api/config', '/api/entities', '/api/score/state', '/api/match/pickUrl',
    '/api/match/qr', '/api/lottery/qr', '/api/overlay/state',
    '/api/music/songs', '/api/music/import', '/api/music/1',
  ];
  for (const p of denied) assert.equal(isAllowed('GET', p), false, `GET ${p} 不应放行`);
  assert.equal(isAllowed('POST', '/api/music/import'), false, '曲目库导入是控制端接口，不能走公网');
  assert.equal(isAllowed('POST', '/api/music/songs'), false, '曲目增改删不能走公网');
  assert.equal(isAllowed('GET', '/api/match/pick'), false, '选曲提交只允许 POST');
  assert.equal(isAllowed('POST', '/api/match/public'), false, '公开状态只允许 GET');
  assert.equal(isApiPath('/api/match/state'), true);
});

test('★ 客户端 IP：直连取 socket；可信反代才读 XFF', () => {
  const req = {
    socket: { remoteAddress: '::ffff:203.0.113.9' },
    headers: { 'x-forwarded-for': '198.51.100.1, 10.0.0.1' },
  };
  assert.equal(getClientIp(req, false), '203.0.113.9', '直连不能信任客户端自带的 XFF');
  assert.equal(getClientIp(req, true), '198.51.100.1', '可信反代取第一个 XFF');
});
