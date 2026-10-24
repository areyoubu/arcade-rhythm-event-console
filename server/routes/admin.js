/**
 * 后台自身管理接口 —— 只对内网开放。
 *
 *   GET  /api/admin/status    当前是否已设密码、是否由环境变量接管
 *   POST /api/admin/password  修改 / 初始化后台登录密码
 *
 * 安全边界：
 *   · 只接受内网（回环 / RFC1918 / 链路本地）请求，不走 XFF；
 *   · 改密码必须提供当前密码（未设置密码时除外）；
 *   · 与登录共用失败计数，密码错也会被锁定；
 *   · 新密码只以 scrypt 散列写入 config.json，明文不落盘、不写日志。
 */
import express from 'express';
import { isLanRequest } from '../client-ip.js';
import {
  adminAuthEnabled, adminEnvTokenEnabled, verifyAdminSecret,
  hashPassword, authLockStatus, noteAuthFailure, clearAuthFailures,
  clearAuthFailuresByIp, listAuthFailures,
} from '../admin-auth.js';
import { getConfig, patchConfig } from '../config.js';
import * as hub from '../ws-hub.js';
import * as log from '../logger.js';

function lanOnly(req, res, next) {
  if (isLanRequest(req)) return next();
  log.netlog({ kind: 'admin-api-blocked', ip: req.socket?.remoteAddress || '', path: req.path });
  return res.status(403).json({
    ok: false,
    nack: { code: 'lan_only', msg: '该接口只允许内网访问' },
  });
}

function validateNextPassword(next) {
  const s = String(next ?? '');
  if (!s) return '新密码不能为空';
  if (s.length < 8) return '新密码至少 8 位（建议 12 位以上）';
  if (s.length > 128) return '新密码不能超过 128 位';
  if (/^\s+$/.test(s)) return '新密码不能全是空白';
  return null;
}

function reqIp(req) {
  return String(req.socket?.remoteAddress || '').replace(/^::ffff:/i, '');
}

function tooMany(res, retryAfterSec) {
  res.setHeader('Retry-After', String(retryAfterSec));
  return res.status(429).json({
    ok: false,
    nack: {
      code: 'too_many_attempts',
      msg: `尝试次数过多，请 ${Math.ceil(retryAfterSec / 60)} 分钟后再试`,
    },
    retryAfterSec,
  });
}

/**
 * 校验当前密码（未设密码时直接放行），并处理锁定 / 失败计数。
 * @returns {boolean} true = 可以继续；false = 已经写了响应
 */
function requireCurrentPassword(req, res) {
  if (!adminAuthEnabled()) return true;
  const lock = authLockStatus(req);
  if (lock.locked) { tooMany(res, lock.retryAfterSec); return false; }

  if (verifyAdminSecret(String(req.body?.current ?? ''))) {
    clearAuthFailures(req);
    return true;
  }

  const st = noteAuthFailure(req);
  if (st.locked) { tooMany(res, st.retryAfterSec); return false; }
  res.status(401).json({
    ok: false,
    nack: { code: 'bad_current', msg: '当前密码不正确' },
    remaining: st.remaining,
  });
  return false;
}

function statusPayload(req) {
  return {
    ok: true,
    passwordSet: adminAuthEnabled(),
    envToken: adminEnvTokenEnabled(),
    editable: !adminEnvTokenEnabled(),
    lan: true,
    ip: reqIp(req),
    allowPublicOutputs: getConfig().server?.allowPublicOutputs === true,
    blocked: listAuthFailures(50),
    risks: log.networkRiskRecent(80),
  };
}

export default function adminRoutes() {
  const r = express.Router();

  r.get('/admin/status', lanOnly, (req, res) => res.json(statusPayload(req)));

  r.post('/admin/password', lanOnly, (req, res) => {
    if (adminEnvTokenEnabled()) {
      return res.status(409).json({
        ok: false,
        nack: {
          code: 'env_token_active',
          msg: '当前由环境变量 LP_ADMIN_TOKEN 鉴权；请先移除该环境变量并重启，再设置密码',
        },
      });
    }

    if (!requireCurrentPassword(req, res)) return;

    const next = String(req.body?.next ?? '');
    const err = validateNextPassword(next);
    if (err) return res.status(400).json({ ok: false, nack: { code: 'weak_password', msg: err } });

    const hash = hashPassword(next);
    const out = patchConfig({ 'server.adminPasswordHash': hash });
    if (!out.ok) {
      return res.status(400).json({ ok: false, errors: out.errors, nack: { code: 'config_write_failed', msg: '密码写入配置失败' } });
    }

    clearAuthFailures(req);
    // 旧密码签发的 WS 会话立即失效（渲染源只读，不动）
    hub.invalidateAuth();
    log.audit('auth', 'admin-password-change', { ip: reqIp(req) });
    log.netlog({ kind: 'admin-password-change', ip: reqIp(req), path: req.path });
    return res.json({ ok: true, message: '密码已更新，其他已登录的浏览器需要重新输入新密码' });
  });

  /** 是否允许外网访问 OBS 输出（默认禁止） */
  r.post('/admin/public-access', lanOnly, (req, res) => {
    if (!requireCurrentPassword(req, res)) return;
    const allow = req.body?.allow === true;
    const out = patchConfig({ 'server.allowPublicOutputs': allow });
    if (!out.ok) {
      return res.status(400).json({ ok: false, errors: out.errors, nack: { code: 'config_write_failed', msg: '写入配置失败' } });
    }
    log.audit('auth', 'public-access-change', { allow, ip: reqIp(req) });
    log.netlog({ kind: 'public-access-change', ip: reqIp(req), allow, path: req.path });
    return res.json({
      ...statusPayload(req),
      message: allow ? '已允许外网访问 OBS 输出' : '已禁止外网访问 OBS 输出（仅内网可访问）',
    });
  });

  /** 手动解除某个 IP 的登录锁定 */
  r.post('/admin/unblock', lanOnly, (req, res) => {
    if (!requireCurrentPassword(req, res)) return;
    const ip = String(req.body?.ip || '').trim().replace(/^::ffff:/i, '');
    if (!ip) return res.status(400).json({ ok: false, nack: { code: 'bad_ip', msg: '缺少要解除的 IP' } });
    clearAuthFailuresByIp(ip);
    log.audit('auth', 'unblock-ip', { ip, actorIp: reqIp(req) });
    log.netlog({ kind: 'unblock-ip', ip, actorIp: reqIp(req) });
    return res.json({ ...statusPayload(req), message: `已解除 ${ip} 的锁定` });
  });

  return r;
}
