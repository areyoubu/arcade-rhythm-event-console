/**
 * 本地游戏音频预览 API。
 *
 *   GET  /api/game-audio/status        扫描状态 / 缓存占用（控制端）
 *   POST /api/game-audio/scan          扫描指定或已保存的游戏目录
 *   POST /api/game-audio/cache/clear   清理预览 WAV 缓存
 *   GET  /api/audio/preview?id=<id>    输出预览 WAV（OBS 浏览器源，无鉴权）
 *
 * `/api/audio/preview` 与 OBS 渲染源同级别：只允许内网访问，除非在
 * 后台显式开启「允许外网访问 OBS 输出」。
 */
import express from 'express';
import * as gameAudio from '../game-audio.js';
import { createRateLimiter } from '../rate-limit.js';
import { clientIp } from '../client-ip.js';
import * as log from '../logger.js';

// 预览音频是给 OBS 浏览器源用的无鉴权输出；限制单 IP 请求频率，
// 避免被同一网段或公网（开启输出时）批量枚举曲目 ID 消耗解码 CPU。
const allowPreview = createRateLimiter({ max: 120, windowMs: 60_000 });

export default function gameAudioRoutes() {
  const r = express.Router();

  r.get('/game-audio/status', async (req, res) => {
    try {
      res.json({ ok: true, ...await gameAudio.status() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  r.post('/game-audio/scan', async (req, res) => {
    const raw = req.body?.gameDir;
    if (raw !== undefined && (typeof raw !== 'string' || raw.length > 600 || raw.includes('\0'))) {
      return res.status(400).json({ ok: false, error: '游戏目录路径不合法' });
    }
    try {
      const status = await gameAudio.scan(raw || null);
      log.audit('game-audio', 'scan', {
        gameDir: status.gameDir,
        ids: status.index?.ids || 0,
        awbFiles: status.index?.awbFiles || 0,
        errors: status.errors?.length || 0,
      });
      res.json({ ok: true, ...status });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  r.post('/game-audio/cache/clear', async (req, res) => {
    try {
      const out = await gameAudio.clearCache();
      res.json({ ok: true, ...out });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /**
   * OBS 浏览器源 / 预览 iframe 直接播放这个地址，无法携带 Bearer。
   * 只接受数字 ID，不会把任意文件路径暴露出去。
   */
  r.get('/audio/preview', async (req, res) => {
    if (!allowPreview(clientIp(req))) {
      return res.status(429).type('text').send('too many requests');
    }
    const id = Number(req.query.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).type('text').send('bad music id');
    }
    try {
      const p = await gameAudio.getPreview(id);
      res.set('Cache-Control', 'private, max-age=3600');
      res.set('Accept-Ranges', 'bytes');
      res.type('audio/wav');
      res.sendFile(p.path, (err) => {
        if (err && !res.headersSent) {
          res.status(404).type('text').send('preview unavailable');
        }
      });
    } catch (e) {
      log.debug('game-audio', '预览音频不可用', { musicId: id, err: e.message });
      if (!res.headersSent) res.status(404).type('text').send('preview unavailable');
    }
  });

  return r;
}
