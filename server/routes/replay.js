/**
 * 模块 B —— 回放与转场 HTTP API。
 * 覆盖 §5.12 完整面板所需的全部动作，含 151 函数表的通用直调入口。
 */
import express from 'express';
import { respond } from './http.js';
import { getConfig } from '../config.js';
import * as replay from '../replay/engine.js';
import * as transitions from '../transitions.js';
import * as vmix from '../vmix/client.js';
import * as obs from '../obs.js';
import * as hub from '../ws-hub.js';
import { functionCatalog, VMIX_FUNCTIONS, ZONES, NEEDS_CHANNEL, TO_OUTPUT, DESTRUCTIVE, MOVES_PLAYHEAD, REPLAY_STOP_IS_NOT_A_FUNCTION } from '../vmix/functions.js';

export default function replayRoutes() {
  const r = express.Router();

  /**
   * 功能开关（默认全关）。
   *
   * 前端即使还开着旧标签页，未启用的功能也不能被这条 HTTP 通道绕过 ——
   * 一道 403 比在 vMix 上误发一条 ReplayMarkInOut 便宜得多。
   */
  r.use((req, res, next) => {
    const f = getConfig().features || {};
    const p = req.path;
    if (p.startsWith('/replay') && !f.replay) {
      return res.status(403).json({ ok: false, nack: { code: 'feature_disabled', msg: '「回放功能」未启用：请到 设置 → 功能开关 开启' } });
    }
    if (p.startsWith('/transitions') && !f.transitions) {
      return res.status(403).json({ ok: false, nack: { code: 'feature_disabled', msg: '「回放转场」未启用：请到 设置 → 功能开关 开启' } });
    }
    next();
  });

  // ── 面板元数据 ──
  r.get('/replay/catalog', (req, res) => {
    res.json({
      ok: true,
      zones: ZONES,
      catalog: functionCatalog(),
      totalFunctions: VMIX_FUNCTIONS.length,
      needsChannel: NEEDS_CHANNEL,
      toOutput: TO_OUTPUT,
      destructive: DESTRUCTIVE,
      movesPlayhead: MOVES_PLAYHEAD,
      stopIsNotAFunction: REPLAY_STOP_IS_NOT_A_FUNCTION,
    });
  });

  r.get('/replay/state', (req, res) => {
    const cfg = getConfig();
    res.json({
      ok: true,
      snapshot: replay.snapshot(),
      vmix: vmix.getStatus(),
      obs: { connected: obs.isConnected(), lastErr: obs.getLastError(), version: obs.getVersion() },
      clip: { ...replay.getInternal().clip },
      config: {
        clip: cfg.clip,
        replay: cfg.replay,
        scenes: cfg.scenes,
        sources: cfg.sources,
        transitions: cfg.transitions,
      },
      playheadDisplaced: replay.isPlayheadDisplaced(),
      armedIntent: replay.getArmedIntent(),
    });
  });

  // ── 预检（只读，B-REQ-5101） ──
  r.post('/replay/preflight', async (req, res) => {
    const { for: purpose, lookbackMs } = req.body || {};
    const pf = await replay.preflight({ for: purpose || 'clipAndAir', lookbackMs });
    res.json({ ok: true, preflight: pf });
  });

  // ── 录制控制 ──
  r.post('/replay/record', async (req, res) => {
    const mode = req.body?.mode || 'start';      // start | stop | toggle
    const fn = mode === 'start' ? 'ReplayStartRecording'
      : mode === 'stop' ? 'ReplayStopRecording' : 'ReplayStartStopRecording';
    respond(res, await vmix.call(fn, {}, { actor: 'replay-panel' }).then(() => ({ ok: true, fn })).catch((e) => ({ ok: false, nack: { code: e.code, msg: e.message } })));
  });

  // ── 状态机动作 ──
  r.post('/replay/clip', async (req, res) => respond(res, await replay.clip(req.body || {})));
  r.post('/replay/air', async (req, res) => respond(res, await replay.air(req.body || {})));
  r.post('/replay/clipAndAir', async (req, res) => respond(res, await replay.clipAndAir(req.body || {})));
  r.post('/replay/backToLive', async (req, res) => respond(res, await replay.backToLive(req.body || {})));
  r.post('/replay/discard', async (req, res) => respond(res, await replay.discard(req.body || {})));
  r.post('/replay/reset', (req, res) => respond(res, replay.reset()));
  r.post('/replay/extendTail', async (req, res) => respond(res, await replay.extendTail(req.body || {})));
  r.post('/replay/movePoint', async (req, res) => {
    const { which, frames, ...rest } = req.body || {};
    if (which !== 'in' && which !== 'out') return res.status(400).json({ ok: false, nack: { code: 'bad_which', msg: 'which 须为 in 或 out' } });
    respond(res, await replay.movePoint(which, frames, rest));
  });
  r.post('/replay/jumpToPoint', async (req, res) => {
    const { which, ...rest } = req.body || {};
    if (which !== 'in' && which !== 'out') return res.status(400).json({ ok: false, nack: { code: 'bad_which', msg: 'which 须为 in 或 out' } });
    respond(res, await replay.jumpToPoint(which, rest));
  });

  // ── 裁切参数（持久化到内存 + 广播；跨重启持久化由前端写 config） ──
  r.post('/replay/clipParams', (req, res) => respond(res, { ok: true, ...replay.setClipParams(req.body || {}) }));
  r.post('/replay/channel', (req, res) => respond(res, { ok: true, channel: replay.setChannel(req.body?.channel) }));
  r.post('/replay/eventList', (req, res) => respond(res, { ok: true, eventList: replay.setEventList(req.body?.eventList) }));

  // ── C 协同 ──
  r.post('/replay/arm', async (req, res) => respond(res, await replay.arm(req.body?.intent)));
  r.post('/replay/disarm', (req, res) => respond(res, replay.disarm()));
  r.post('/replay/execute', async (req, res) => {
    const { intent, ...rest } = req.body || {};
    respond(res, await replay.execute(intent, rest));
  });
  r.post('/replay/externalChange/clear', (req, res) => { replay.clearExternalChange(); respond(res, { ok: true }); });

  // ── 151 函数直调（B-REQ-2006 调试面板 + 完整面板的所有按钮） ──
  r.post('/replay/call', async (req, res) => {
    const { fn, params = {}, confirmed = false, speed } = req.body || {};
    if (!fn || typeof fn !== 'string') return res.status(400).json({ ok: false, nack: { code: 'bad_fn', msg: '缺少 fn' } });
    respond(res, await replay.execFunction(fn, params, { confirmed, speed, actor: req.body?.actor || 'panel-http' }));
  });

  // ── 通用 vMix 直调（开发模式函数直调面板） ──
  r.post('/replay/raw', async (req, res) => {
    const { fn, params = {} } = req.body || {};
    respond(res, await vmix.call(fn, params, { actor: 'dev-raw' }).then((x) => ({ ok: true, ...x })).catch((e) => ({ ok: false, nack: { code: e.code, msg: e.message } })));
  });

  // ── 转场 ──
  r.get('/transitions/state', async (req, res) => {
    respond(res, { ok: true, ...transitions.getSnapshot(), fallback: await transitions.ensureFallbackTransition().catch(() => null) });
  });
  r.post('/transitions/refresh', async (req, res) => respond(res, { ok: true, ...(await transitions.refreshList()) }));
  r.post('/transitions/set', async (req, res) => {
    const { transitionName, durationMs } = req.body || {};
    respond(res, await transitions.setTransition(transitionName, durationMs).catch((e) => ({ ok: false, nack: { code: e.code || 'error', msg: e.message } })));
  });
  r.post('/transitions/override', async (req, res) => {
    const { sceneName, transitionName, transitionDuration } = req.body || {};
    respond(res, await transitions.setOverride(sceneName, transitionName, transitionDuration).catch((e) => ({ ok: false, nack: { code: e.code, msg: e.message } })));
  });
  r.post('/transitions/applyOverrides', async (req, res) => {
    const results = await transitions.applyOverridesFromConfig().catch((e) => [{ ok: false, error: e.message }]);
    respond(res, { ok: true, results });
  });
  r.post('/transitions/studioMode', async (req, res) => respond(res, await transitions.setStudioMode(!!req.body?.enabled).catch((e) => ({ ok: false, nack: { code: e.code, msg: e.message } }))));
  r.post('/transitions/programScene', async (req, res) => respond(res, await transitions.setProgramScene(req.body?.sceneName).catch((e) => ({ ok: false, nack: { code: e.code, msg: e.message } }))));
  r.post('/transitions/previewScene', async (req, res) => respond(res, await transitions.setPreviewScene(req.body?.sceneName).catch((e) => ({ ok: false, nack: { code: e.code, msg: e.message } }))));
  r.post('/transitions/trigger', async (req, res) => respond(res, await transitions.triggerTransition().catch((e) => ({ ok: false, nack: { code: e.code, msg: e.message } }))));
  r.post('/transitions/tbar', async (req, res) => respond(res, await transitions.setTBar(req.body?.position).catch((e) => ({ ok: false, nack: { code: e.code, msg: e.message } }))));

  // 注：回路延迟校准页已按需求移除（不再做毫秒计时器与 L 值测量）。
  //     打点补偿改为在「设置 → 回放与时序 → 打点补偿 markDelayMs」直接填写。

  // ── 连接状态 ──
  r.get('/links', (req, res) => {
    res.json({
      ok: true,
      vmix: vmix.getStatus(),
      obs: { connected: obs.isConnected(), lastErr: obs.getLastError(), version: obs.getVersion(), probeUrl: `ws://${getConfig().obs.host}:${getConfig().obs.port}` },
      renderers: hub.getRenderers().length,
    });
  });

  return r;
}

