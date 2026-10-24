/**
 * 模块 A —— 媒体库 / 实体库 / 模板库 HTTP API。
 * 需求：A-REQ-301~306（实体）、A-REQ-401~412（媒体）、A-REQ-210~215（模板）
 */
import express from 'express';
import { respond } from './http.js';
import multer from 'multer';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { getConfig } from '../config.js';
import { clientIp } from '../client-ip.js';
import * as media from '../media.js';
import * as entities from '../entities.js';
import * as templates from '../templates.js';
import * as hub from '../ws-hub.js';
import * as log from '../logger.js';

/** 上传先落到临时目录，内容 hash 计算完再搬进媒体库（A-REQ-405） */
const upload = multer({
  dest: path.join(os.tmpdir(), 'arcade-live-uploads'),
  // ★ 单张图片上传；fileSize 实际上限仍在 addUpload 按配置二次校验
  limits: { fileSize: 32 * 1024 * 1024, files: 1 },
});

export default function libraryRoutes() {
  const r = express.Router();

  // ═══════════════ 媒体库 ═══════════════

  r.get('/media', (req, res) => {
    const { q, tag, group, ext, limit, offset } = req.query;
    res.json({
      ok: true,
      ...media.list({ q, tag, group, ext, limit: limit ? Number(limit) : 200, offset: offset ? Number(offset) : 0 }),
      tags: media.allTags(),
      groups: media.allGroups(),
      stats: media.stats(),
    });
  });

  r.get('/media/stats', (req, res) => res.json({ ok: true, ...media.stats() }));

  /** 单张图片上传 —— 只收一张，超出一张直接拒绝 */
  r.post('/media/upload', (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ ok: false, nack: { code: 'too_many_files', msg: '一次只能上传一张图片' } });
      }
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ ok: false, nack: { code: 'too_large', msg: '图片不能超过 32MB' } });
      }
      return res.status(400).json({ ok: false, nack: { code: 'bad_upload', msg: err.message } });
    });
  }, async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, nack: { code: 'no_file', msg: '没有收到文件' } });
    const out = await media.addUpload(req.file, { ip: clientIp(req), source: 'media' });
    log.netlog({
      kind: 'upload',
      ip: clientIp(req),
      target: 'media',
      name: String(req.file.originalname || '').slice(0, 160),
      bytes: req.file.size || 0,
      ok: !!out.ok,
      deduped: !!out.deduped,
      error: out.error || '',
    });
    if (!out.ok) {
      return res.status(400).json({ ok: false, nack: { code: 'bad_file', msg: out.error }, error: out.error });
    }
    log.audit('media', 'upload', {
      hash: out.asset.hash, name: out.asset.originalName, ip: out.asset.uploaderIp, deduped: !!out.deduped,
    });
    res.json({ ok: true, deduped: !!out.deduped, asset: out.asset, uploaded: 1, failed: 0 });
  });

  /** A-REQ-412 手动触发目录扫描（只索引图片） */
  r.post('/media/scan', async (req, res) => {
    const result = await media.scan();
    res.json({ ok: true, ...result });
  });

  /** A-REQ-408 删除前引用检查 */
  r.get('/media/:hash/refs', (req, res) => {
    const r2 = media.checkReferences(req.params.hash);
    if (!r2.exists) return res.status(404).json({ ok: false, errors: { hash: '资源不存在' } });
    res.json({ ok: true, refs: r2.refs, blocked: r2.refs.length > 0 });
  });

  r.delete('/media/:hash', (req, res) => {
    const force = req.query.force === '1' || req.query.force === 'true';
    const r2 = media.remove(req.params.hash, { force });
    res.status(r2.ok ? 200 : 409).json(r2);
  });

  r.post('/media/bulkDelete', (req, res) => {
    const { hashes = [], force = false } = req.body || {};
    const results = media.bulkRemove(hashes, { force });
    const blocked = results.filter((x) => !x.ok);
    res.status(blocked.length && !force ? 409 : 200).json({
      ok: true,
      removed: results.filter((x) => x.ok).length,
      blocked: blocked.map((b) => ({ hash: b.hash, refs: b.refs, errors: b.errors })),
    });
  });

  r.post('/media/tags', (req, res) => respond(res, media.setTags(req.body?.hash, req.body?.tags)));
  r.post('/media/group', (req, res) => respond(res, media.setGroup(req.body?.hash, req.body?.group)));
  r.get('/media/:hash/url', (req, res) => {
    const url = media.renderUrl(req.params.hash, { derivative: req.query.derivative, thumb: req.query.thumb === '1' });
    if (!url) return res.status(404).json({ ok: false, errors: { hash: '资源不存在' } });
    res.json({ ok: true, url });
  });

  // ═══════════════ 实体库 ═══════════════

  r.get('/entities', (req, res) => {
    const { kind, tag, q } = req.query;
    res.json({ ok: true, items: entities.list({ kind, tag, q }), tags: entities.allTags(), stats: entities.stats() });
  });

  r.post('/entities', (req, res) => {
    const r2 = entities.create(req.body || {});
    res.status(r2.ok ? 200 : 400).json(r2);
  });

  r.put('/entities/:id', (req, res) => {
    const r2 = entities.update(req.params.id, req.body || {});
    res.status(r2.ok ? 200 : 400).json(r2);
  });

  r.delete('/entities/:id', (req, res) => {
    // 删除队伍时会自动把成员解绑，响应里带 clearedMembers
    const r2 = entities.removeWithRefs(req.params.id);
    res.status(r2.ok ? 200 : 400).json(r2);
  });

  /** 队伍列表（供选手表单的下拉、叠加填充时解析队伍名/Logo） */
  r.get('/entities/teams', (req, res) => {
    res.json({ ok: true, items: entities.teams() });
  });

  /** 某队伍下的选手 */
  r.get('/entities/teams/:id/members', (req, res) => {
    const items = entities.list({ kind: 'player' }).filter((e) => e.teamId === req.params.id);
    res.json({ ok: true, items, count: items.length });
  });

  r.post('/entities/bulkDelete', (req, res) => respond(res, entities.bulkRemove(req.body?.ids || [])));

  /** A-REQ-304 CSV / 粘贴列表快速导入 */
  r.post('/entities/import', (req, res) => {
    const { text, kind, hasHeader, delimiter } = req.body || {};
    if (!text) return res.status(400).json({ ok: false, errors: { text: '缺少 text' } });
    const r2 = entities.importText(text, { kind: kind || 'player', hasHeader: hasHeader !== false, delimiter });
    res.status(r2.ok ? 200 : 400).json(r2);
  });

  /** G-REQ-109 / A-REQ-004：currentPlayer 只能由模块 A 显式设置 */
  r.post('/entities/current', (req, res) => {
    const { id } = req.body || {};
    respond(res, id ? entities.setCurrent(id) : entities.clearCurrent());
  });

  r.get('/entities/current', (req, res) => res.json({ ok: true, player: entities.getCurrent() }));

  /** A-REQ-520：按标签批量取赞助商（致谢用） */
  r.get('/entities/sponsors/byTier', (req, res) => {
    const tags = req.query.tags ? String(req.query.tags).split(',').filter(Boolean) : [];
    res.json({ ok: true, items: entities.sponsorsByTier(tags) });
  });

  // ═══════════════ 模板库 ═══════════════

  r.get('/templates', (req, res) => {
    res.json({ ok: true, items: templates.publicList(), stats: templates.stats() });
  });

  /** 完整定义（含 html / css）—— 模板编辑页用 */
  r.get('/templates/full', (req, res) => res.json({ ok: true, items: templates.fullList() }));

  r.get('/templates/:id', (req, res) => {
    const t = templates.get(req.params.id);
    if (!t) return res.status(404).json({ ok: false, errors: { id: '模板不存在' } });
    res.json({ ok: true, template: templates.fullList().find((x) => x.id === t.id) });
  });

  r.post('/templates', (req, res) => {
    const r2 = templates.saveCustom(req.body || {});
    res.status(r2.ok ? 200 : 400).json(r2);
  });

  /** 校验但不保存 —— 模板编辑页的实时校验 */
  r.post('/templates/validate', (req, res) => {
    const errors = templates.validateTemplate(req.body || {});
    res.json({ ok: Object.keys(errors).length === 0, errors });
  });

  /** A-REQ-210：基于内置模板复制一份自定义副本 */
  r.post('/templates/:id/duplicate', (req, res) => {
    const base = templates.get(req.params.id);
    if (!base) return res.status(404).json({ ok: false, errors: { id: '模板不存在' } });
    const newId = req.body?.newId || `${base.id}Copy`;
    if (templates.get(newId)) return res.status(400).json({ ok: false, errors: { newId: `模板 id ${newId} 已存在（id 必须唯一且稳定）` } });
    const copy = { ...templates.fullList().find((x) => x.id === base.id), id: newId, name: req.body?.newName || `${base.name} 副本` };
    const r2 = templates.saveCustom(copy);
    res.status(r2.ok ? 200 : 400).json(r2);
  });

  r.delete('/templates/:id', (req, res) => {
    const t = templates.get(req.params.id);
    if (t?.builtin && !t.overridden) {
      return res.status(400).json({ ok: false, errors: { id: '内置模板不可删除；可先「复制为自定义」再改' } });
    }
    const r2 = templates.removeCustom(req.params.id);
    res.status(r2.ok ? 200 : 400).json(r2);
  });

  /** A-REQ-213 手动触发热重载 */
  r.post('/templates/reload', (req, res) => {
    templates.reloadNow('手动');
    respond(res, { ok: true, count: templates.all().length });
  });

  // ═══════════════ 渲染端资源（模板 / 实体全量，供渲染端首次拉取兜底） ═══════════════

  r.get('/render/bootstrap', (req, res) => {
    const cfg = getConfig();
    res.json({
      ok: true,
      templates: templates.fullList(),
      entities: entities.list(),
      canvas: cfg.render.canvas,
      render: cfg.render,
      animations: cfg.animations,
      credits: cfg.credits,
      media: media.list({ limit: 2000 }).items.map((a) => ({ url: a.url, thumbnail: a.thumbnail, derivatives: a.derivatives, width: a.width, height: a.height, hash: a.hash })),
    });
  });

  return r;
}

