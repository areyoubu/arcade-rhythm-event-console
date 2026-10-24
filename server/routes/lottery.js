/**
 * 模块 E —— 抽奖 / 签到 HTTP API。
 *
 * 公共接口（手机扫码）：
 *   GET  /join                签到页面（页面路由在 index.js）
 *   POST /api/lottery/join    提交签到
 *
 * 控制接口：
 *   GET  /api/lottery/state
 *   GET  /api/lottery/joinUrl 解析二维码地址
 *   GET  /api/lottery/qr      生成二维码 PNG
 *   POST /api/lottery/draw | reset | settings
 *   POST /api/lottery/guests | guests/clear | import
 *   PUT  /api/lottery/guests/:id   编辑签到
 *   DELETE /api/lottery/guests/:id 删除签到
 */
import express from 'express';
import multer from 'multer';
import { respond } from './http.js';
import { getConfig } from '../config.js';
import { qrPng, resolvePublicUrl } from '../public-url.js';
import { createRateLimiter } from '../rate-limit.js';
import { clientIp } from '../client-ip.js';
import * as lottery from '../lottery.js';
import * as media from '../media.js';
import * as log from '../logger.js';

// 每 IP 每分钟最多提交次数
const allowJoin = createRateLimiter({ max: 10, windowMs: 60_000 });

/** 奖品图片：只收一张，内存里校验后交给媒体库（不落用户可控扩展名） */
const prizeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

function prizeUploadOne(req, res, next) {
  prizeUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE' ? '图片不能超过 10MB'
      : (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') ? '一次只能上传一张图片'
        : err.message;
    return res.status(400).json({ ok: false, nack: { code: 'bad_upload', msg } });
  });
}

/** 二维码指向的地址：公网地址 > 局域网基础地址 > 当前访问地址 > 自动探测局域网 IP */
function resolveJoinUrl(req) {
  const cfg = getConfig();
  return resolvePublicUrl({
    origin: String(req.query.origin || '').trim(),
    publicUrl: cfg.lottery?.publicJoinUrl,
    baseUrl: cfg.lottery?.joinBaseUrl,
    path: '/join',
    port: cfg.server?.overlayPort || 3000,
    label: '签到',
    configHint: '公网签到地址 / 局域网签到地址',
  });
}

export default function lotteryRoutes() {
  const r = express.Router();

  r.get('/lottery/state', (req, res) => res.json({ ok: true, state: lottery.snapshot() }));

  r.get('/lottery/joinUrl', (req, res) => {
    const info = resolveJoinUrl(req);
    res.json({ ok: true, ...info });
  });

  r.get('/lottery/qr', async (req, res) => {
    const info = resolveJoinUrl(req);
    try {
      const png = await qrPng(info.url, req.query.size);
      res.set('Cache-Control', 'no-store');
      res.type('png').send(png);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── 公共签到（手机扫码）──
  r.post('/lottery/join', (req, res) => {
    const ip = clientIp(req);
    if (!allowJoin(ip)) {
      return res.status(429).json({ ok: false, nack: { code: 'rate_limited', msg: '提交太频繁，请稍后再试' } });
    }
    const out = lottery.addGuest(req.body || {}, { source: 'join' });
    if (!out.ok) return res.status(400).json(out);
    res.json({ ok: true, ticket: out.ticket, count: out.count, guest: { name: out.guest.name } });
  });

  // ── 控制端 ──
  r.post('/lottery/draw', (req, res) => respond(res, lottery.draw(req.body?.actor || 'operator')));
  r.post('/lottery/reset', (req, res) => {
    const scope = req.body?.scope === 'all' ? 'all' : 'round';
    respond(res, lottery.reset(scope, req.body?.actor || 'operator'));
  });
  r.post('/lottery/settings', (req, res) => {
    const { actor, ...patch } = req.body || {};
    respond(res, lottery.setSettings(patch, actor || 'operator'));
  });
  r.post('/lottery/guests', (req, res) => respond(res, lottery.addGuest(req.body || {}, { source: 'manual' })));
  r.put('/lottery/guests/:id', (req, res) => {
    const { actor, ...patch } = req.body || {};
    respond(res, lottery.updateGuest(req.params.id, patch, actor || 'operator'));
  });
  r.delete('/lottery/guests/:id', (req, res) => respond(res, lottery.removeGuest(req.params.id, req.body?.actor || 'operator')));
  r.post('/lottery/guests/clear', (req, res) => respond(res, lottery.clearGuests(req.body?.actor || 'operator')));
  r.post('/lottery/import', (req, res) => respond(res, lottery.importText(req.body?.text, req.body?.actor || 'operator')));

  /**
   * 奖品图片上传：单张、只接受真实光栅图片（PNG / JPEG / GIF / WebP），
   * 记录上传 IP 与时间。返回的 asset 可以直接用于 prize.image。
   */
  r.post('/lottery/prize/image', prizeUploadOne, async (req, res) => {
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ ok: false, nack: { code: 'no_file', msg: '没有收到图片' } });
    }
    const ip = clientIp(req);
    const out = await media.addImageBuffer(req.file.buffer, {
      originalName: req.file.originalname,
      ip,
      source: 'lottery-prize',
    });
    log.netlog({
      kind: 'upload',
      ip,
      target: 'lottery-prize',
      name: String(req.file.originalname || '').slice(0, 160),
      bytes: req.file.size || 0,
      ok: !!out.ok,
      error: out.nack?.msg || '',
    });
    if (!out.ok) return res.status(400).json(out);
    res.json({
      ok: true,
      deduped: !!out.deduped,
      asset: out.asset,
      meta: {
        // 重复内容：记录本次上传者；新文件：记录首次上传者
        ip: (out.deduped ? out.asset.lastUploaderIp : out.asset.uploaderIp) || ip,
        at: (out.deduped ? out.asset.lastUploadedAt : out.asset.uploadedAt) || Date.now(),
        hash: out.asset.hash,
      },
    });
  });

  return r;
}

