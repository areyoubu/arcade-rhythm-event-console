/**
 * 外网访问 OBS 输出的总开关。
 *
 * OBS 渲染源（/render/*）、背景素材（/assets/*）、媒体库（/media/*）、渲染端
 * 启动数据（/api/render/bootstrap、/api/match/pickUrl）以及二维码 PNG
 * （/api/match/qr、/api/lottery/qr）都不需要登录密码 —— 它们本身是给 OBS
 * 浏览器源 / 页面 `<img>` 读的。默认**只允许内网访问**，防止有人从公网
 * 直接拿走你的画面 / 素材。
 *
 * 现场签到（/join、/pick 及其公开 API）不受影响，公网照常可用。
 *
 * 开关在「后台密码设置」页（/admin-setup，仅内网）里，配置项：
 *   server.allowPublicOutputs = false（默认）
 */
import { getConfig } from './config.js';
import { isLanRequest } from './client-ip.js';
import * as log from './logger.js';

/** 需要保护的输出路径（小写；不含公共签到 / 选曲页） */
const OUTPUT_PATHS = [
  /^\/render(\/|$)/,                 // 所有 OBS 渲染源页面
  /^\/assets(\/|$)/,                 // 直播间背景 / 模板素材
  /^\/media(\/|$)/,                  // 媒体库原图 / 缩略图 / 派生
  /^\/covers(\/|$)/,                 // 曲目封面
  /^\/api\/render\/bootstrap$/,      // 渲染端首屏模板 / 实体数据
  /^\/api\/match\/pickurl$/,         // 选曲二维码大屏用的公开地址
  /^\/api\/match\/qr$/,              // 选曲二维码 PNG（页面 img / OBS 源）
  /^\/api\/lottery\/qr$/,            // 签到二维码 PNG（页面 img）
  /^\/api\/audio\/preview$/,         // 游戏曲目预览音频（OBS 浏览器源）
];

export function isProtectedOutputPath(pathname) {
  const p = String(pathname || '').toLowerCase();
  return OUTPUT_PATHS.some((re) => re.test(p));
}

export function publicOutputsAllowed() {
  return getConfig().server?.allowPublicOutputs === true;
}

// 控制台日志限频：同一 IP + 路径每分钟最多 warn 一次，避免被刷屏；
// 网络日志仍然逐条记录，供后台安全面板查看。
const lastWarn = new Map();
function warnOnce(ip, method, path) {
  const key = `${ip}|${method}|${path}`;
  const now = Date.now();
  if (now - (lastWarn.get(key) || 0) < 60_000) return;
  lastWarn.set(key, now);
  if (lastWarn.size > 2000) lastWarn.clear();
  log.warn('server', '已拦截外网访问 OBS 输出', { ip, method, path });
}

/** Express 中间件：未允许外网时，非内网请求访问输出路径一律 403 并记风险日志 */
export function outputAccessGate(req, res, next) {
  if (publicOutputsAllowed()) return next();
  const path = String(req.path || '');
  if (!isProtectedOutputPath(path)) return next();
  if (isLanRequest(req)) return next();

  const ip = String(req.socket?.remoteAddress || req.ip || '').replace(/^::ffff:/i, '');
  log.netlog({
    kind: 'external-blocked',
    ip,
    method: req.method,
    path: path.slice(0, 300),
    ua: String(req.get?.('user-agent') || '').slice(0, 200),
  });
  warnOnce(ip, req.method, path);
  return res.status(403).type('text').send('403 · 该输出仅允许内网访问');
}
