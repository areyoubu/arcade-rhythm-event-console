/**
 * 极简内存限流器（签到 / 扫码选曲共用）。
 *
 * 现场是内网单进程，不需要 Redis / 滑动窗口库；这里按 IP 记录一个时间窗口内的
 * 请求时间戳，超过上限就拒绝。Map 到 2000 个 IP 时整体清空，避免长期运行膨胀。
 */
export function createRateLimiter({ max = 20, windowMs = 60_000, maxKeys = 2000 } = {}) {
  const hits = new Map();
  return function allow(ip) {
    const key = String(ip || 'unknown');
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) { hits.set(key, arr); return false; }
    arr.push(now);
    hits.set(key, arr);
    if (hits.size > maxKeys) hits.clear();
    return true;
  };
}
