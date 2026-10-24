/**
 * 模块 A —— 叠加控制 HTTP API。
 * 控制端页面（/overlay、/players、/talent、/credits）全部走这里 + WS。
 */
import express from 'express';
import { respond } from './http.js';
import { getConfig, patchConfig } from '../config.js';
import * as overlay from '../overlay.js';
import * as templates from '../templates.js';
import * as entities from '../entities.js';
import * as media from '../media.js';
import * as lottery from '../lottery.js';
import * as hub from '../ws-hub.js';
import * as log from '../logger.js';

export default function overlayRoutes() {
  const r = express.Router();

  // ── 状态 ──
  r.get('/overlay/state', (req, res) => {
    res.json({
      ok: true,
      targets: overlay.snapshot(),
      lineup: overlay.getLineup(),
      templates: templates.publicList(),
      entities: entities.list(),
      media: media.list({ limit: 500 }).items,
      undoDepth: overlay.undoDepth('main'),
      renderers: hub.getRenderers().map((c) => ({ target: c.target, ua: c.ua, connectedAt: c.connectedAt })),
    });
  });

  // ── 显隐 / 热改 ──
  r.post('/overlay/show', (req, res) => respond(res, overlay.show(req.body || {})));
  r.post('/overlay/update', (req, res) => {
    const { slot, value, ...rest } = req.body || {};
    respond(res, overlay.update(slot, value, rest));
  });
  r.post('/overlay/updateMany', (req, res) => {
    const { values, ...rest } = req.body || {};
    respond(res, overlay.updateMany(values, rest));
  });
  r.post('/overlay/hide', (req, res) => respond(res, overlay.hide(req.body || {})));
  r.post('/overlay/clear', (req, res) => respond(res, overlay.clear(req.body || {})));
  r.post('/overlay/pin', (req, res) => respond(res, overlay.setPinned(!!req.body?.pinned, req.body || {})));
  r.post('/overlay/mode', (req, res) => respond(res, overlay.setMode(req.body?.mode, req.body || {})));
  r.post('/overlay/undo', (req, res) => respond(res, overlay.undo(req.body?.target || 'main')));

  // ── 预览 / 输出分离 ──
  // 编辑默认落在 preview，确认后 commit 到直播输出（target=main）
  r.post('/overlay/commit', (req, res) => respond(res, overlay.commitPreview(req.body || {})));
  r.post('/overlay/revert', (req, res) => respond(res, overlay.revertPreview(req.body || {})));

  // ── 比赛模式（团队赛 / 单人赛） ──
  r.post('/competition/mode', (req, res) => {
    const mode = req.body?.mode;
    if (!['team', 'solo'].includes(mode)) {
      return res.status(400).json({ ok: false, errors: { mode: 'mode 必须是 team 或 solo' } });
    }
    const r2 = patchConfig({ 'competition.mode': mode });
    if (!r2.ok) return res.status(400).json(r2);
    log.audit('overlay', 'setCompetitionMode', { mode });
    res.json({ ok: true, mode: getConfig().competition.mode });
  });

  // ── 实体一键填充 ──
  // 单实体（entityId）用于姓名条 / 角标等单人模板；
  // 多实体（entityIds: [A, B]）用于对阵卡 / 双人解说名牌 —— 按槽位侧别前缀分派，不会填成两个人一样。
  r.post('/overlay/fill', (req, res) => {
    const { entityId, entityIds, ...rest } = req.body || {};
    if (Array.isArray(entityIds) && entityIds.length) {
      return respond(res, overlay.fillFromEntities(entityIds, rest));
    }
    respond(res, overlay.fillFromEntity(entityId, rest));
  });

  // ── 队列 ──
  r.post('/overlay/queue/add', (req, res) => respond(res, overlay.queueAdd(req.body || {})));
  r.post('/overlay/queue/set', (req, res) => respond(res, overlay.queueSet(req.body?.items)));
  r.post('/overlay/queue/remove', (req, res) => respond(res, overlay.queueRemove(req.body?.id)));
  r.post('/overlay/queue/reorder', (req, res) => respond(res, overlay.queueReorder(req.body?.ids || [])));
  r.post('/overlay/queue/start', (req, res) => respond(res, overlay.queueStart()));
  r.post('/overlay/queue/pause', (req, res) => respond(res, overlay.queuePause()));
  r.post('/overlay/queue/resume', (req, res) => respond(res, overlay.queueResume()));
  r.post('/overlay/queue/clear', (req, res) => respond(res, overlay.queueClear()));

  // ── 致谢专项 ──
  r.post('/overlay/credits/estimate', (req, res) => {
    const { lines = [], speed, viewportHeight } = req.body || {};
    const cfg = getConfig();
    respond(res, {
      ok: true,
      ...overlay.estimateCreditsDuration({
        lines,
        speed: speed ?? cfg.credits.defaultSpeedPxPerSec,
        viewportHeight: viewportHeight ?? cfg.render.canvas.height,
      }),
    });
  });

  r.post('/overlay/credits/fromTags', (req, res) => {
    const { tags = [], kind } = req.body || {};
    const items = overlay.creditsFromTags(tags, { kind });
    respond(res, { ok: true, items, count: items.length });
  });

  r.post('/overlay/credits/control', (req, res) => {
    const { action, ...rest } = req.body || {};
    if (!['pause', 'resume', 'jumpTo', 'restart'].includes(action)) {
      return res.status(400).json({ ok: false, nack: { code: 'bad_action', msg: `action 须为 pause / resume / jumpTo / restart` } });
    }
    respond(res, overlay.creditsControl(action, rest));
  });

  // ── 渲染端 URL 生成（A-REQ-724 复制渲染端 URL） ──
  r.get('/overlay/renderUrls', (req, res) => {
    const cfg = getConfig();
    const base = `http://${req.hostname}:${cfg.server.overlayPort}`;
    res.json({
      ok: true,
      urls: [
        { name: '浮窗-主（OBS 浏览器源）', url: `${base}/render/main`, obsName: '浮窗-主', note: 'shutdown=false、restart_when_active=false、1920×1080、60fps' },
        { name: '浮窗-致谢（OBS 浏览器源）', url: `${base}/render/credits`, obsName: '浮窗-致谢', note: '同上' },
        { name: '比分条 + 选手牌（OBS 浏览器源）', url: `${base}/render/score`, obsName: '比分条', note: '常驻；比分条与两块选手牌同一路，shutdown=false、1920×1080' },
        { name: '主实例预览', url: `${base}/render/main?preview=1`, note: '控制端 iframe 用' },
        { name: '主实例预览（含安全区参考线）', url: `${base}/render/main?preview=1&guides=1`, note: '仅预览可见，OBS 中不可见' },
        { name: '致谢预览', url: `${base}/render/credits?preview=1` },
      ],
    });
  });

  // ── 渲染端握手（HTTP 兜底；正常走 WS） ──
  r.post('/overlay/heartbeat', (req, res) => {
    const { target } = req.body || {};
    overlay.markRendererConnected(target, { via: 'http' });
    res.json({ ok: true, ts: Date.now() });
  });

  return r;
}


/** 让 media.js 的引用检查能拿到实体 / 状态 / 模板 / 抽奖奖品（避免循环导入） */
export function wireMediaReferences() {
  media.wireReferences({
    entityReferencingImage: (url) => entities.referencingImage(url),
    stateRef: () => (globalThis.__getState ? globalThis.__getState() : null),
    templateList: () => templates.fullList(),
    lotteryReferencingImage: (url) => lottery.referencingImage(url),
  });
  log.debug('overlay', '媒体引用检查已接线（实体 / 叠加状态 / 模板 / 抽奖奖品）');
}
