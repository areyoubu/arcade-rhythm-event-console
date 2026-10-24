/**
 * 模块 C —— 提示 / 倒计时 / 编排 / 监看 HTTP API。
 */
import express from 'express';
import { respond } from './http.js';
import { getConfig } from '../config.js';
import { getState } from '../state.js';
import * as cue from '../cue/engine.js';
import * as countdown from '../cue/countdown.js';
import * as orchestration from '../cue/orchestration.js';
import * as obs from '../obs.js';
import * as hub from '../ws-hub.js';
import * as log from '../logger.js';

export default function cueRoutes() {
  const r = express.Router();

  // ── 提示 ──
  r.get('/cues/state', (req, res) => {
    const cfg = getConfig();
    res.json({
      ok: true,
      active: cue.getActive().map((c) => ({
        id: c.id, kind: c.kind, priority: c.priority, audience: c.audience, title: c.title,
        body: c.body, sound: c.sound, state: c.state, createdAt: c.createdAt, ttlMs: c.ttlMs,
        requiresAck: c.requiresAck, acks: c.acks, source: c.source, playerSnapshot: c.playerSnapshot,
      })),
      channels: cfg.cue.channels,
      templates: cue.cueTemplates(),
      alert: getState().cue.alert || null,
      countdown: countdown.list().map((cd) => ({ id: cd.id, title: cd.title, kind: cd.kind, state: cd.state, remainingMs: countdown.remainingOf(cd.id), autoExecute: cd.autoExecute, dryRun: cd.dryRun })),
      clients: hub.clientRegistry(),
      audio: hub.audienceStats().audio,
      /** 镜像自模块 B 的相位（只读，C-REQ-597） */
      bPhase: getState().cue.bPhase,
      /** 最近一次编排执行结果 */
      lastResult: orchestration.getLastResult(),
    });
  });

  r.post('/cues/publish', (req, res) => {
    const { cueId, cue: c } = cue.publish(req.body || {});
    respond(res, { ok: true, cueId, cue: c });
  });

  r.post('/cues/cancel', (req, res) => respond(res, cue.cancel(req.body?.cueId, req.body?.reason || 'cancelled')));
  r.post('/cues/forceClear', (req, res) => respond(res, cue.forceClear(req.body?.cueId)));
  r.post('/cues/clearAll', (req, res) => respond(res, cue.clearAll()));
  r.post('/cues/alert/clear', (req, res) => { cue.clearAlert(); respond(res, { ok: true }); });

  /** 服务端代发 ack（导播在回执看板上替某客户端确认） */
  r.post('/cues/ack', (req, res) => {
    const { cueId, clientId } = req.body || {};
    respond(res, cue.ack(cueId, clientId || 'director-proxy'));
  });

  r.get('/cues/history', (req, res) => {
    const { from, to, audience, priority, source, limit } = req.query;
    res.json({
      ok: true,
      items: cue.queryHistory({
        from: from ? Number(from) : undefined,
        to: to ? Number(to) : undefined,
        audience, priority, source,
        limit: limit ? Number(limit) : 200,
      }),
    });
  });

  /** 按话术模板快速发送（C-REQ-508 / 附录 E） */
  r.post('/cues/fromTemplate', (req, res) => {
    const { templateId, vars = {}, overrides = {} } = req.body || {};
    const tpl = cue.cueTemplates().find((t) => t.id === templateId);
    if (!tpl) return res.status(400).json({ ok: false, nack: { code: 'unknown_template', msg: `话术模板不存在：${templateId}` } });
    const title = cue.interpolate(tpl.template, vars);
    const priority = typeof tpl.priority === 'string' ? tpl.priority : (vars.priority || 'P3');
    const out = cue.publish({
      kind: overrides.kind || 'notice',
      priority: overrides.priority || priority,
      audience: overrides.audience || tpl.audience,
      title: overrides.title || title,
      body: overrides.body,
      sound: overrides.sound || (typeof tpl.sound === 'string' ? tpl.sound : 'none'),
      ttlMs: overrides.ttlMs,
      requiresAck: overrides.requiresAck ?? tpl.requiresAck,
      source: overrides.source || 'manual',
      playerSnapshot: overrides.playerSnapshot,
      tag: overrides.tag,
    });
    respond(res, { ok: true, ...out, template: tpl.id, rendered: title });
  });

  /** 自由文本（C-REQ-509） */
  r.post('/cues/free', (req, res) => {
    const { text, audience, priority, sound, ttlMs, requiresAck } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ ok: false, nack: { code: 'empty', msg: '文本不能为空' } });
    const out = cue.publish({
      kind: 'notice', priority: priority || 'P2', audience,
      title: String(text).slice(0, 300), sound: sound || 'none',
      ttlMs: ttlMs ?? 8000, requiresAck: !!requiresAck, source: 'manual',
    });
    respond(res, { ok: true, ...out });
  });

  // ── 倒计时 ──
  r.get('/countdown/state', (req, res) => {
    res.json({
      ok: true,
      active: countdown.list().map((cd) => ({
        id: cd.id, title: cd.title, kind: cd.kind, state: cd.state,
        remainingMs: countdown.remainingOf(cd.id), autoExecute: cd.autoExecute, dryRun: cd.dryRun,
        audience: cd.audience, escalation: cd.escalation.map((e) => ({ atMs: e.atMs, priority: e.priority, sound: e.sound, fired: cd.firedSteps.has(e.atMs) })),
      })),
      queue: orchestration.pendingQueue(),
      config: getConfig().countdown,
      lastResult: orchestration.getLastResult(),
    });
  });

  r.post('/countdown/hold', (req, res) => respond(res, countdown.hold(req.body?.id)));
  r.post('/countdown/resume', (req, res) => respond(res, countdown.resume(req.body?.id)));
  r.post('/countdown/extend', (req, res) => respond(res, countdown.extend(req.body?.id, req.body?.deltaMs)));
  r.post('/countdown/cancel', (req, res) => respond(res, countdown.cancel(req.body?.id)));

  // ── 编排 ──
  r.post('/orchestration/scheduleReplay', async (req, res) => respond(res, await orchestration.scheduleReplay(req.body || {})));
  r.post('/orchestration/scheduleBackToLive', async (req, res) => respond(res, await orchestration.scheduleBackToLive(req.body || {})));
  r.post('/orchestration/confirm', async (req, res) => {
    const { countdownId, intent, lookbackMs } = req.body || {};
    respond(res, await orchestration.confirmExecute(countdownId, { onZero: intent ? { intent, lookbackMs } : undefined, actor: 'director' }));
  });


  return r;
}

