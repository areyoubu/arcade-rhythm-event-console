/**
 * 公共接口真实 IP —— 远端入口（remote/）转发时必须把真实客户端 IP 带给主服务，
 * 否则所有公网用户会共用 127.0.0.1 的限流额度。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { clientIp, isTrustedRemote } from '../server/client-ip.js';

const OLD = process.env.LP_REMOTE_TOKEN;

function fakeReq({ socketIp = '192.168.1.9', ip = '', headers = {} } = {}) {
  return {
    socket: { remoteAddress: socketIp },
    ip: ip || socketIp,
    headers,
    get(name) { return this.headers[String(name).toLowerCase()]; },
  };
}

test('★ 带匹配 token 的远程请求：采用 x-remote-client-ip', () => {
  process.env.LP_REMOTE_TOKEN = 'secret-123';
  const req = fakeReq({
    socketIp: '127.0.0.1',
    headers: {
      'x-remote-token': 'secret-123',
      'x-remote-client-ip': '203.0.113.7',
      'x-forwarded-for': '198.51.100.2',
    },
  });
  assert.equal(isTrustedRemote(req), true);
  assert.equal(clientIp(req), '203.0.113.7');
});

test('★ token 不匹配：不信任转发头，普通局域网请求不能被伪造 XFF 绕过限流', () => {
  process.env.LP_REMOTE_TOKEN = 'secret-123';
  const req = fakeReq({
    socketIp: '192.168.1.9',
    headers: { 'x-remote-token': 'wrong', 'x-forwarded-for': '1.2.3.4' },
  });
  assert.equal(isTrustedRemote(req), false);
  assert.equal(clientIp(req), '192.168.1.9');
});

test('★ 远端在主机的 loopback 上：没有 token 也信任它写的 XFF', () => {
  process.env.LP_REMOTE_TOKEN = '';
  const req = fakeReq({
    socketIp: '127.0.0.1',
    headers: { 'x-forwarded-for': '203.0.113.99, 10.0.0.1' },
  });
  assert.equal(clientIp(req), '203.0.113.99');
});

test('普通请求：直接返回 req.ip', () => {
  process.env.LP_REMOTE_TOKEN = '';
  const req = fakeReq({ socketIp: '10.0.0.5', ip: '10.0.0.5' });
  assert.equal(clientIp(req), '10.0.0.5');
});

after(() => {
  if (OLD === undefined) delete process.env.LP_REMOTE_TOKEN;
  else process.env.LP_REMOTE_TOKEN = OLD;
});
