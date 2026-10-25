/**
 * 曲目库 API。
 *
 * 公开（比赛页 / 手机选曲页）：
 *   GET  /api/music/meta          分类、难度名/颜色、曲目总数
 *   GET  /api/music?q=&genre=...  搜索（分页）
 *   GET  /api/music/:id           单曲详情
 *
 * 控制端（/music 管理页）：
 *   POST   /api/music/songs       手动新增
 *   PUT    /api/music/songs/:id   编辑
 *   DELETE /api/music/songs/:id   删除
 *   POST   /api/music/import      上传 xlsx 全量替换
 *
 * 公开路径只有前三项；管理接口不在 remote/policy 的白名单里，不会暴露到公网。
 */
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { respond } from './http.js';
import { ROOT } from '../config.js';
import * as music from '../music.js';
import * as cnMusic from '../cn-music.js';
import * as gameMusic from '../game-music.js';
import * as log from '../logger.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 64 * 1024 * 1024 },
});

function uploadOne(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, errors: { file: err.message } });
    next();
  });
}

export default function musicRoutes() {
  const r = express.Router();

  r.get('/music/meta', (req, res) => {
    // 这是公开接口（手机选曲页也会读）：不带待确认补丁内容，避免把内部 diff 发到公网
    res.json({ ok: true, ...music.meta(), cn: cnMusic.status() });
  });

  r.get('/music', (req, res) => {
    const {
      q = '', genre = '', difficulty = '', minLevel = '', maxLevel = '',
      cnOnly = '', includeWe = '', exclude = '', limit = 60, offset = 0,
    } = req.query;
    const excludeIds = String(exclude || '')
      .split(',')
      .map((x) => Number(x.trim()))
      .filter((x) => Number.isFinite(x) && x > 0);
    const out = music.search({
      q: String(q),
      genre: String(genre),
      difficulty: String(difficulty),
      minLevel: minLevel === '' ? null : Number(minLevel),
      maxLevel: maxLevel === '' ? null : Number(maxLevel),
      cnOnly: cnOnly === '1' || cnOnly === 'true',
      includeWe: includeWe === '1' || includeWe === 'true',
      excludeIds,
      limit: Number(limit) || 60,
      offset: Number(offset) || 0,
    });
    res.json({ ok: true, ...out, meta: { ...music.meta(), cn: cnMusic.status() } });
  });

  r.get('/music/:id', (req, res) => {
    const song = music.getView(req.params.id);
    if (!song) return res.status(404).json({ ok: false, nack: { code: 'not_found', msg: '曲目不存在' } });
    res.json({ ok: true, song, difficulties: music.difficultiesOf(song.id) });
  });

  // ── 管理端 ──
  r.post('/music/level-source', (req, res) => {
    const body = req.body || {};
    respond(res, music.setLevelSource(body.source, body.actor || 'operator'));
  });

  /** 从本地游戏目录导入曲目信息 / 日服定数 / 曲绘 */
  r.post('/music/game/import', async (req, res) => {
    const body = req.body || {};
    try {
      respond(res, await gameMusic.importGameMusic({ actor: body.actor || 'operator' }));
    } catch (e) {
      log.warn('music', '游戏曲目导入失败', { err: e.message });
      res.status(500).json({ ok: false, nack: { code: 'game_import_failed', msg: e.message } });
    }
  });

  /** 拉取国服曲目/定数；有变化时只返回待确认补丁 */
  r.post('/music/cn/sync', async (req, res) => {
    const body = req.body || {};
    respond(res, await cnMusic.syncNow({ actor: body.actor || 'operator', source: 'manual' }));
  });

  r.post('/music/cn/confirm', (req, res) => {
    respond(res, cnMusic.confirmPending(req.body?.actor || 'operator'));
  });

  r.post('/music/cn/discard', (req, res) => {
    respond(res, cnMusic.discardPending(req.body?.actor || 'operator'));
  });

  r.get('/music/cn/status', (req, res) => {
    res.json({ ok: true, ...cnMusic.status({ includePending: true }) });
  });

  r.post('/music/songs', (req, res) => {
    const { actor, ...input } = req.body || {};
    respond(res, music.addSong(input, actor || 'operator'));
  });

  r.put('/music/songs/:id', (req, res) => {
    const { actor, ...patch } = req.body || {};
    respond(res, music.updateSong(req.params.id, patch, actor || 'operator'));
  });

  r.delete('/music/songs/:id', (req, res) => {
    respond(res, music.removeSong(req.params.id, req.body?.actor || 'operator'));
  });

  /** 上传 xlsx：解析成功才替换；同时更新 data/source 的源文件，方便下次重建 */
  r.post('/music/import', uploadOne, async (req, res) => {
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ ok: false, errors: { file: '没有收到 xlsx 文件' } });
    }
    log.netlog({
      kind: 'upload',
      ip: req.ip || req.socket?.remoteAddress || '',
      target: 'music-xlsx',
      name: String(req.file.originalname || '').slice(0, 160),
      bytes: req.file.size || 0,
    });
    const out = await music.importBuffer(req.file.buffer, { actor: req.body?.actor || 'operator' });
    if (!out.ok) return res.status(400).json(out);
    try {
      const source = path.join(ROOT, 'data', 'source', 'ChunithmMusicData.xlsx');
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.writeFileSync(source, req.file.buffer);
    } catch (e) {
      // 曲目库已经导入成功；源文件写失败只影响下次「从源文件重建」
      out.sourceWarning = `源文件保存失败：${e.message}`;
    }
    res.json({ ...out, uploaded: req.file.originalname });
  });

  return r;
}
