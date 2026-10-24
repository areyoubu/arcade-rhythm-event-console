/**
 * 公共接口限流（签到 / 扫码选曲共用）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../server/rate-limit.js';

test('★ 限流按 IP 独立计数，超过窗口上限后拒绝', () => {
  const allow = createRateLimiter({ max: 2, windowMs: 60_000 });
  assert.equal(allow('a'), true);
  assert.equal(allow('a'), true);
  assert.equal(allow('a'), false, '第三次应被拒绝');
  assert.equal(allow('b'), true, '另一个 IP 不受影响');
});
