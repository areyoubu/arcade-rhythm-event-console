/**
 * 内网判定 —— 后台密码设置页 / 管理接口只对内网开放。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isLanAddress, isLanRequest } from '../server/client-ip.js';

test('★ 回环 / RFC1918 / 链路本地都算内网', () => {
  for (const ip of [
    '127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1',
    '10.0.0.5', '10.255.255.254',
    '192.168.1.20', '192.168.255.255',
    '172.16.0.1', '172.20.10.2', '172.31.255.1',
    '169.254.10.20',
    'fc00::1', 'fd12:3456::1', 'fe80::1',
  ]) {
    assert.equal(isLanAddress(ip), true, `${ip} 应判定为内网`);
  }
});

test('★★ 公网地址一律不算内网（不做 XFF 信任）', () => {
  for (const ip of [
    '8.8.8.8', '1.1.1.1', '203.0.113.9',
    '172.15.0.1', '172.32.0.1',
    '2001:4860:4860::8888',
    '', null, undefined, 'not-an-ip',
  ]) {
    assert.equal(isLanAddress(ip), false, `${ip} 不应判定为内网`);
  }
});

test('★★ isLanRequest 只看 socket 地址，伪造 X-Forwarded-For 无效', () => {
  const publicReq = {
    socket: { remoteAddress: '203.0.113.9' },
    headers: { 'x-forwarded-for': '127.0.0.1' },
    get() { return '127.0.0.1'; },
  };
  assert.equal(isLanRequest(publicReq), false, '公网 socket + 伪造 XFF 仍应拒绝');

  const lanReq = { socket: { remoteAddress: '192.168.1.30' }, headers: {}, get() { return null; } };
  assert.equal(isLanRequest(lanReq), true);
});
