/**
 * 公共接口的「真实客户端 IP」。
 *
 * 平时直接用 Express 的 req.ip。当请求经过本项目的远端公开入口（remote/）时：
 *   · 远端在本机（loopback）→ 信任它写的 X-Forwarded-For；
 *   · 远端在另一台机器 → 必须带匹配的 X-Remote-Token，才信任 X-Remote-Client-IP。
 *
 * 这样既不会因为「所有公网用户都变成 127.0.0.1」导致签到 / 选曲被全局限流，
 * 也不会让局域网里的普通请求靠伪造 XFF 绕过限流。
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function clean(ip) {
  return String(ip || '').trim().replace(/^::ffff:/i, '');
}

export function isTrustedRemote(req) {
  const token = String(process.env.LP_REMOTE_TOKEN || '').trim();
  if (!token) return false;
  const got = typeof req.get === 'function' ? req.get('x-remote-token') : req.headers?.['x-remote-token'];
  return got === token;
}

/**
 * @param {import('express').Request} req
 * @returns {string}
 */
export function clientIp(req) {
  if (isTrustedRemote(req)) {
    const got = typeof req.get === 'function' ? req.get('x-remote-client-ip') : req.headers?.['x-remote-client-ip'];
    const ip = clean(got);
    if (ip) return ip;
  }

  const socketIp = clean(req.socket?.remoteAddress || '');
  if (LOOPBACK.has(socketIp)) {
    const xff = typeof req.get === 'function' ? req.get('x-forwarded-for') : req.headers?.['x-forwarded-for'];
    const first = clean(String(xff || '').split(',')[0]);
    if (first) return first;
  }

  return clean(req.ip || socketIp) || 'unknown';
}

// ─────────────────────────────────────────────────────────────
// 内网判定（后台密码设置页 / 管理接口用）
// ─────────────────────────────────────────────────────────────

const IPV4_PRIVATE = [
  [/^10\./, true],
  [/^192\.168\./, true],
  [/^172\.(1[6-9]|2\d|3[01])\./, true],
  [/^127\./, true],
  [/^169\.254\./, true],
];

/** 是否是回环 / 私网 / 链路本地地址（不做 XFF 信任，直接看 socket） */
export function isLanAddress(raw) {
  let ip = clean(raw);
  if (!ip) return false;
  if (ip === '::1') return true;
  // IPv6 ULA fc00::/7、链路本地 fe80::/10
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true;
  // IPv4-mapped 已在 clean 里去掉 ::ffff:
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  const parts = ip.split('.').map(Number);
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return IPV4_PRIVATE.some(([re]) => re.test(ip));
}

/**
 * 请求是否来自内网。
 * ⚠️ 只看 socket 地址，不信任 X-Forwarded-For —— 否则公网请求伪造 XFF 就能进设置页。
 */
export function isLanRequest(req) {
  return isLanAddress(req.socket?.remoteAddress || req.ip || '');
}
