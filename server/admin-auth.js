/**
 * 管理后台登录鉴权 —— 控制接口的保护层。
 *
 * 背景：主控制台原本是「局域网无鉴权」设计，一旦把 :3000 暴露到公网，
 * `/api/config`、媒体上传、实体/模板等控制接口全部裸奔，谁都能改配置 / 传文件。
 *
 * 现在用「登录密码」保护控制接口：
 *   · 密码**只存散列**（scrypt + 随机盐），不存明文 —— 配置泄露也拿不到密码；
 *   · 环境变量 `LP_ADMIN_TOKEN`（明文，用于脚本/自动化，可选）优先；
 *   · 未配置 = 保持原来的局域网信任模式（什么都不拦）；
 *   · 登录失败按 IP 计数：10 分钟内错 5 次 → 锁 15 分钟，继续错翻倍，最长 24 小时。
 *
 * 公开路径（现场签到 / 扫码选曲，remote edge 会转发给主服务的那些）与
 * OBS 渲染源需要的只读接口不受影响，手机和浏览器源照常工作。
 */
import crypto from 'node:crypto';
import { PUBLIC_GET, PUBLIC_POST } from '../remote/policy.mjs';
import { getConfig } from './config.js';
import * as log from './logger.js';

/** 对密码做 scrypt 散列，格式 `scrypt:<salt-hex>:<hash-hex>` */
export function hashPassword(password, saltHex = '') {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

/** 校验密码是否匹配已存的散列（恒定时间比较） */
export function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt:')) return false;
  const parts = stored.split(':');
  if (parts.length !== 3) return false;
  const [, saltHex, hashHex] = parts;
  if (!saltHex || !hashHex) return false;
  let hash;
  try { hash = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 64); }
  catch { return false; }
  const a = Buffer.from(hash);
  const b = Buffer.from(hashHex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** 当前生效的鉴权凭据：环境变量明文令牌优先，其次配置里的密码散列 */
function configuredSecret() {
  const env = String(process.env.LP_ADMIN_TOKEN || '').trim();
  if (env) return { kind: 'plain', value: env };
  const hash = String(getConfig().server?.adminPasswordHash || '').trim();
  if (hash) return { kind: 'hash', value: hash };
  return null;
}

/** 是否启用了后台鉴权（启动日志 / 告警用） */
export function adminAuthEnabled() {
  return configuredSecret() !== null;
}

/** 当前是否由环境变量令牌接管（此时配置里的密码散列不会生效） */
export function adminEnvTokenEnabled() {
  return !!String(process.env.LP_ADMIN_TOKEN || '').trim();
}

/** 校验一个明文凭据（密码 / 令牌）是否正确；未启用鉴权时恒为 true */
export function verifyAdminSecret(value) {
  const secret = configuredSecret();
  if (!secret) return true;
  const got = String(value || '');
  if (!got) return false;
  if (secret.kind === 'plain') return safeEqual(got, secret.value);
  return verifyPassword(got, secret.value);
}

/** 请求是否携带了正确的凭据（Bearer 密码 或 明文令牌） */
export function isAdminAuthorized(req) {
  if (!adminAuthEnabled()) return true;
  const auth = String(req.get?.('authorization') || req.headers?.authorization || '');
  const got = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return verifyAdminSecret(got);
}

// ─────────────────────────────────────────────────────────────
// 登录失败限流（防爆破）
// ─────────────────────────────────────────────────────────────

const FAIL_WINDOW_MS = 10 * 60_000;      // 统计窗口：10 分钟
const MAX_FAILS = 5;                     // 窗口内错 5 次触发锁定
const BASE_LOCK_MS = 15 * 60_000;        // 首次锁 15 分钟
const MAX_LOCK_MS = 24 * 60 * 60_000;    // 连续触发最长锁 24 小时
const RESET_AFTER_MS = 24 * 60 * 60_000; // 一天没动静就清掉记录
const MAX_TRACKED = 5000;

/** ip -> { fails:number[], lockUntil:number, strikes:number, lastAt:number } */
const attempts = new Map();

function authIpOf(req) {
  // 限流键必须用 socket 地址：XFF 可伪造，不能拿来决定锁谁
  return String(req.socket?.remoteAddress || req.ip || 'unknown').replace(/^::ffff:/i, '');
}

function pruneAttempts(now) {
  if (attempts.size <= MAX_TRACKED) return;
  for (const [ip, st] of attempts) {
    if (now - st.lastAt > RESET_AFTER_MS && st.lockUntil <= now) attempts.delete(ip);
  }
  // 还是太多就清掉最早的一半，避免内存无限增长
  if (attempts.size > MAX_TRACKED) {
    const sorted = [...attempts.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt);
    for (const [ip] of sorted.slice(0, Math.floor(sorted.length / 2))) attempts.delete(ip);
  }
}

/** 当前 IP 是否处于锁定中 */
export function authLockStatus(req) {
  const ip = authIpOf(req);
  const st = attempts.get(ip);
  const now = Date.now();
  if (!st || st.lockUntil <= now) return { locked: false, retryAfterSec: 0 };
  return { locked: true, retryAfterSec: Math.ceil((st.lockUntil - now) / 1000) };
}

/** 记一次失败；达到阈值返回锁定信息 */
export function noteAuthFailure(req) {
  const ip = authIpOf(req);
  const now = Date.now();
  pruneAttempts(now);
  const st = attempts.get(ip) || { fails: [], lockUntil: 0, strikes: 0, lastAt: now };
  st.fails = st.fails.filter((t) => now - t < FAIL_WINDOW_MS);
  st.fails.push(now);
  st.lastAt = now;

  let locked = false;
  if (st.fails.length >= MAX_FAILS) {
    st.strikes += 1;
    const lockMs = Math.min(MAX_LOCK_MS, BASE_LOCK_MS * (2 ** (st.strikes - 1)));
    st.lockUntil = now + lockMs;
    st.fails = [];
    locked = true;
    log.netlog({ kind: 'auth-lock', ip, strikes: st.strikes, lockMs });
    log.warn('auth', '登录失败次数过多，已锁定该 IP', { ip, strikes: st.strikes, lockMs });
  } else {
    log.netlog({ kind: 'auth-fail', ip, fails: st.fails.length, path: req.path });
  }
  attempts.set(ip, st);
  return {
    locked,
    retryAfterSec: locked ? Math.ceil((st.lockUntil - now) / 1000) : 0,
    fails: st.fails.length,
    remaining: Math.max(0, MAX_FAILS - st.fails.length),
  };
}

/** 登录成功 / 改密成功后清除失败记录 */
export function clearAuthFailures(req) {
  attempts.delete(authIpOf(req));
}

/** 手动解除某个 IP 的锁定（后台安全面板用） */
export function clearAuthFailuresByIp(ip) {
  const key = String(ip || '').replace(/^::ffff:/i, '');
  if (key) attempts.delete(key);
}

/**
 * 当前被跟踪的登录失败 / 锁定 IP（后台安全面板展示用）。
 * @returns {Array<{ip:string, fails:number, locked:boolean, lockUntil:number, retryAfterSec:number, strikes:number, lastAt:number}>}
 */
export function listAuthFailures(limit = 100) {
  const now = Date.now();
  return [...attempts.entries()]
    .map(([ip, st]) => ({
      ip,
      fails: st.fails.length,
      locked: st.lockUntil > now,
      lockUntil: st.lockUntil || 0,
      retryAfterSec: st.lockUntil > now ? Math.ceil((st.lockUntil - now) / 1000) : 0,
      strikes: st.strikes,
      lastAt: st.lastAt,
    }))
    .filter((x) => x.fails > 0 || x.locked)
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, Math.max(1, limit));
}

/** 供测试使用的重置 */
export function resetAuthFailuresForTest() {
  attempts.clear();
}

/**
 * 带限流的鉴权：先看是否锁定，再校验凭据；失败自动计数。
 * @returns {{ok:boolean, status?:number, retryAfterSec?:number, locked?:boolean, remaining?:number}}
 */
export function attemptAdminAuth(req) {
  if (!adminAuthEnabled()) return { ok: true };
  const lock = authLockStatus(req);
  if (lock.locked) {
    log.netlog({ kind: 'auth-blocked', ip: authIpOf(req), retryAfterSec: lock.retryAfterSec, path: req.path });
    return { ok: false, status: 429, locked: true, retryAfterSec: lock.retryAfterSec };
  }
  if (isAdminAuthorized(req)) {
    clearAuthFailures(req);
    return { ok: true };
  }
  const st = noteAuthFailure(req);
  if (st.locked) return { ok: false, status: 429, locked: true, retryAfterSec: st.retryAfterSec };
  return { ok: false, status: 401, remaining: st.remaining };
}

/**
 * 渲染源 / 监控需要无令牌访问的只读接口（全部小写，与路径归一化一致）。
 *
 * 二维码 PNG 必须放行：页面里是 `<img src="/api/.../qr">`，浏览器不会给
 * 图片请求带 Authorization 头；OBS 的选曲二维码源也无法登录。二维码内容
 * 只是公开的 /join 或 /pick 地址，不含控制数据。
 */
const OPEN_GET = new Set([
  '/api/health',
  '/api/render/bootstrap',
  '/api/match/pickurl',
  '/api/match/qr',
  '/api/lottery/qr',
  // 游戏音频预览：<audio> 与 OBS 渲染源一样无法携带 Bearer；只按数字 ID 出缓存文件
  '/api/audio/preview',
]);

/**
 * Express 中间件：启用鉴权时拦截未授权的控制接口。
 * 只保护 /api/*；静态页面照常（操作员要先打开页面才能输密码）。
 *
 * 启用密码后，/api/* 的所有读写（除公开路径与渲染源/监控的只读接口）
 * 都需要登录 —— 手机打开 3000 会立即在数据请求上拿到 401，从而弹出密码框。
 */
export function adminGate(req, res, next) {
  if (!adminAuthEnabled()) return next();

  // ★ 路径统一小写匹配：Express 路由默认大小写不敏感，
  //   `/API/media/upload` 也会命中 `/api/media/upload`。若这里按原样大小写判断，
  //   攻击者只要把 /api 改成 /API 就能绕过鉴权直接上传。
  const path = String(req.path || '').toLowerCase();
  if (!path.startsWith('/api/')) return next();

  // 后台自身的管理接口（改密码 / 外网开关 / 状态）：由路由自己校验内网 + 当前密码，
  // 这里放行，否则「忘记密码」时没有入口（它们仍受内网限制）。
  if (path.startsWith('/api/admin/')) return next();

  // 公开路径（remote edge 转发的签到 / 选曲）
  if (PUBLIC_GET.has(path) && req.method !== 'POST') return next();
  if (PUBLIC_POST.has(path) && req.method === 'POST') return next();

  // 渲染源 / 监控的只读接口（OBS 浏览器源无法输密码）
  if ((req.method === 'GET' || req.method === 'HEAD') && OPEN_GET.has(path)) return next();

  // 其余 /api/* 的读写一律要登录
  const r = attemptAdminAuth(req);
  if (r.ok) return next();
  if (r.status === 429) {
    res.setHeader('Retry-After', String(r.retryAfterSec || 60));
    return res.status(429).json({
      ok: false,
      nack: { code: 'too_many_attempts', msg: `登录失败次数过多，请 ${Math.ceil((r.retryAfterSec || 60) / 60)} 分钟后再试` },
      retryAfterSec: r.retryAfterSec,
    });
  }
  return deny(res, r.remaining);
}

function deny(res, remaining) {
  return res.status(401).json({
    ok: false,
    nack: { code: 'unauthorized', msg: '需要登录密码（Authorization: Bearer <密码>）' },
    remaining: remaining ?? null,
  });
}
