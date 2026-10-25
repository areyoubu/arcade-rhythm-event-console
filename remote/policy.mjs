/**
 * 公网远端入口的「白名单」和客户端 IP 解析（纯函数，便于测试）。
 *
 * 原则：公网只开放「现场签到」和「扫码选曲」，其余一律不转发。
 * 只暴露具体路径，不做 /api 前缀放行 —— 否则哪天新增控制接口会意外漏到公网。
 */

export const PUBLIC_GET = new Set([
  '/join',                 // 现场签到页
  '/pick',                 // 手机扫码选曲页
  '/shared/style.css',     // 签到页使用的基础样式
  '/shared/font.css',      // 页面统一字体（字由文艺黑）
  '/api/music',            // 选曲搜索（页面内部使用）
  '/api/music/meta',       // 分类 / 难度元信息
  '/api/match/public',     // 已选曲目 / ban 列表（无分数、无选手）
]);

/**
 * 前缀放行的只读静态资源。只允许固定前缀，且必须是 GET / HEAD ——
 * 选曲页的曲绘 <img> 和页面字体必须能加载，否则手机端曲绘 / 文字会缺。
 * 曲绘只是专辑封面（数据本就在 /api/music 里公开返回），不涉及控制数据。
 */
export const PUBLIC_GET_PREFIX = [
  '/covers/',              // 曲目封面（选曲页 <img src="/covers/…">）
  '/fonts/',               // 字体文件（font.css 里的 @font-face）
];

export const PUBLIC_POST = new Set([
  '/api/match/pick',       // 提交选曲（进入导播确认队列）
  '/api/lottery/join',     // 提交现场签到
]);

export function isApiPath(pathname) {
  return pathname === '/api' || String(pathname).startsWith('/api/');
}

/** @param {string} method @param {string} pathname 不含 query 的路径 */
export function isAllowed(method, pathname) {
  const m = String(method || '').toUpperCase();
  const p = String(pathname || '');
  if (m === 'GET' || m === 'HEAD') {
    if (PUBLIC_GET.has(p)) return true;
    return PUBLIC_GET_PREFIX.some((prefix) => p.startsWith(prefix));
  }
  if (m === 'POST') return PUBLIC_POST.has(p);
  return false;
}

export function normalizeIp(ip) {
  return String(ip || '').trim()
    .replace(/^::ffff:/i, '')
    .replace(/^\[|\]$/g, '');
}

/**
 * 远端看到的客户端 IP。
 * trustProxy 只应在「前面有自己可信的反代（Caddy / nginx / Cloudflare）」时开启；
 * 直接暴露公网时保持 false，否则任何人都能伪造 X-Forwarded-For 绕过限流。
 */
export function getClientIp(req, trustProxy = false) {
  if (trustProxy) {
    const h = req.headers || {};
    const first = String(h['x-forwarded-for'] || '').split(',')[0];
    const ip = normalizeIp(first || h['cf-connecting-ip'] || h['x-real-ip'] || '');
    if (ip) return ip;
  }
  return normalizeIp(req.socket?.remoteAddress || '') || 'unknown';
}
