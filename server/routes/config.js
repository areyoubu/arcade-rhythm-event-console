/**
 * 配置相关的 HTTP API —— 设置页的全部后端支撑。
 *
 * 需求：
 *   G-REQ-101 / 102  地址完全配置化；单双机只改配置
 *   A-REQ-215        非法配置须指明字段路径
 *   B-REQ-305        启动预检 config.json schema 合法性
 *   设置页需要：读（掩码）、写（校验）、测试连接、导入导出、恢复默认
 */
import express from 'express';
import {
  getConfig, patchConfig, replaceConfig, resetConfig, maskSecrets,
  getSchemaForUI, getConfigMeta, CONFIG_FILE, SENSITIVE_PATHS,
} from '../config.js';
import { getPath } from '../config-schema.js';
import * as log from '../logger.js';
import * as obs from '../obs.js';
import * as vmix from '../vmix/client.js';

export default function configRoutes() {
  const r = express.Router();

  /** 完整配置（敏感字段掩码）+ schema —— 设置页据此渲染表单 */
  r.get('/config', (req, res) => {
    res.json({
      ok: true,
      config: maskSecrets(getConfig()),
      schema: getSchemaForUI(),
      meta: { file: CONFIG_FILE, ...getConfigMeta() },
      sensitive: SENSITIVE_PATHS,
    });
  });

  r.get('/config/schema', (req, res) => res.json({ ok: true, ...getSchemaForUI() }));

  r.get('/config/raw', (req, res) => {
    // 导出用：包含敏感字段，但只在本地管理界面用；仍走掩码以策安全
    res.setHeader('Content-Disposition', 'attachment; filename="config.json"');
    res.json(maskSecrets(getConfig()));
  });

  /**
   * 更新配置。body: { patch: { 'obs.host': '...' } } 或直接给嵌套对象。
   * 响应里 errors 是**字段路径 → 消息**的映射，设置页直接贴到对应输入框下。
   */
  r.post('/config', (req, res) => {
    const patch = req.body?.patch ?? req.body?.config ?? req.body;
    if (!patch || typeof patch !== 'object') return res.status(400).json({ ok: false, errors: { __body__: '缺少 patch 对象' } });

    // 敏感字段若为掩码值（含 •），说明用户没改，忽略之
    const cleaned = {};
    for (const [k, v] of Object.entries(flatten(patch))) {
      if (typeof v === 'string' && v.includes('•')) continue;
      cleaned[k] = v;
    }

    const result = patchConfig(cleaned);
    if (!result.ok) {
      log.warn('config', '配置保存被拒绝', { errors: result.errors });
      return res.status(400).json(result);
    }
    log.audit('config', 'patchConfig', { changed: result.changed });
    res.json({ ...result, config: maskSecrets(getConfig()), meta: getConfigMeta() });
  });

  /** 导入配置（整体替换） */
  r.post('/config/import', (req, res) => {
    const body = req.body?.config ?? req.body;
    const result = replaceConfig(body);
    if (!result.ok) return res.status(400).json(result);
    log.audit('config', 'importConfig', { changed: result.changed.length });
    res.json({ ...result, config: maskSecrets(getConfig()) });
  });

  /** 恢复默认 */
  r.post('/config/reset', (req, res) => {
    const result = resetConfig();
    log.audit('config', 'resetConfig', {});
    res.json({ ...result, config: maskSecrets(getConfig()) });
  });

  // ─────────────────────────────────────────────────────────
  // 测试连接（设置页的「测试连接」按钮）
  // ─────────────────────────────────────────────────────────

  r.post('/config/test/obs', async (req, res) => {
    const body = req.body || {};
    const host = body.host || getConfig().obs.host;
    const port = Number(body.port || getConfig().obs.port);
    const password = body.password && !body.password.includes('•') ? body.password : getConfig().obs.password;

    // 优先用当前活连接的结果；否则做一次独立握手探测
    if (obs.isConnected() && host === getConfig().obs.host && port === getConfig().obs.port) {
      const v = obs.getVersion();
      let scenes = [];
      try { scenes = (await obs.getSceneList()).scenes.map((s) => s.sceneName); } catch { /* ignore */ }
      return res.json({ ok: true, mode: 'live', version: v, scenes, message: 'OBS 已连接（当前活动连接）' });
    }
    const probe = await probeObs(host, port, password);
    res.json(probe);
  });

  r.post('/config/test/vmix', async (req, res) => {
    const body = req.body || {};
    const host = body.host || getConfig().vmix.host;
    const port = Number(body.port || getConfig().vmix.port);
    const p = await vmix.probe({ host, port });
    res.json(p);
  });


  return r;
}

// ─────────────────────────────────────────────────────────────

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) flatten(v, p, out);
    else out[p] = v;
  }
  return out;
}

/** 独立 OBS 握手探测（不干扰当前连接） */
async function probeObs(host, port, password) {
  const { default: WebSocket } = await import('ws');
  const { createHash } = await import('node:crypto');
  const t0 = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    /** @type {import('ws').WebSocket|null} */
    let ws = null;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try { ws?.close(); } catch { /* ignore */ }
      resolve(v);
    };
    const timer = setTimeout(() => done({ ok: false, error: '连接超时（5s）', rttMs: Date.now() - t0 }), 5000);
    let serverVersion = null;

    try { ws = new WebSocket(`ws://${host}:${port}`, { handshakeTimeout: 5000 }); }
    catch (e) { clearTimeout(timer); return done({ ok: false, error: e.message }); }

    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.op === 0) {
        serverVersion = m.d?.obsWebSocketVersion || null;
        const needAuth = !!m.d?.authentication;
        if (needAuth && !password) {
          clearTimeout(timer);
          return done({ ok: false, error: 'OBS 启用了鉴权，但未提供密码', authRequired: true, rttMs: Date.now() - t0 });
        }
        const identify = { rpcVersion: 1, eventSubscriptions: 0 };
        if (needAuth) {
          const secret = createHash('sha256').update(password + m.d.authentication.salt).digest('base64');
          identify.authentication = createHash('sha256').update(secret + m.d.authentication.challenge).digest('base64');
        }
        ws.send(JSON.stringify({ op: 1, d: identify }));
      } else if (m.op === 2) {
        // 只做握手确认 —— 不自称已连接，避免与正式连接的状态混淆
        clearTimeout(timer);
        if (m.d?.error) return done({ ok: false, error: m.d.error, rttMs: Date.now() - t0 });
        done({
          ok: true,
          rttMs: Date.now() - t0,
          obsWebSocketVersion: serverVersion,
          authRequired: !!password,
          message: '握手成功（独立探测，未占用正式连接）',
        });
      }
    });
    ws.on('error', (e) => { clearTimeout(timer); done({ ok: false, error: e.message, rttMs: Date.now() - t0 }); });
    ws.on('close', (code) => {
      clearTimeout(timer);
      if (code === 4009) return done({ ok: false, error: '鉴权失败：密码不正确', authFailed: true, rttMs: Date.now() - t0 });
      done({ ok: false, error: `连接被关闭（code=${code}）`, rttMs: Date.now() - t0 });
    });
  });
}

/** 简单 HTTP 可达性探测（用于 MediaMTX 的两个端点） */
async function probeHttp(url, label, token) {
  if (!url) return { reachable: false, reason: 'empty', label, message: '未填写' };
  let u;
  try { u = new URL(url); } catch { return { reachable: false, reason: 'bad-url', label, message: '不是合法 URL' }; }

  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    // 用 OPTIONS / GET 探测：WHEP 是 POST 端点，GET 会返回 405，但足以证明服务在线
    const res = await fetch(url, { method: 'OPTIONS', signal: controller.signal, headers: token ? { Authorization: `Bearer ${token}` } : {} });
    clearTimeout(timer);
    return {
      reachable: true,
      status: res.status,
      rttMs: Date.now() - t0,
      label,
      host: u.host,
      message: `服务在线（OPTIONS ${res.status}）`,
      note: res.status === 401 || res.status === 403 ? '返回 401/403：MediaMTX 可能启用了认证，请填写承载令牌' : undefined,
    };
  } catch (e) {
    clearTimeout(timer);
    return { reachable: false, reason: 'unreachable', label, host: u.host, message: e.name === 'AbortError' ? '请求超时（4s）' : e.message };
  }
}
