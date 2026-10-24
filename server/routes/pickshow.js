/**
 * 选手选曲展示 API。
 *
 *   GET  /api/pickshow/state       当前展示数据
 *   POST /api/pickshow/options     设置输出选项（side / count / source）
 *   POST /api/pickshow/refresh     强制重算并广播
 *   POST /api/pickshow/reveal      播放 / 重播 3D 展示动画
 *   POST /api/pickshow/reset       回到待展示画面（不泄露选曲）
 *   POST /api/pickshow/upcoming/clear 清空「即将进行」选曲队列
 */
import express from 'express';
import { respond } from './http.js';
import * as pickshow from '../pickshow.js';

export default function pickshowRoutes() {
  const r = express.Router();

  r.get('/pickshow/state', (req, res) => {
    res.json({ ok: true, state: pickshow.snapshot(), options: pickshow.getOptions() });
  });

  r.post('/pickshow/options', (req, res) => {
    respond(res, pickshow.setOptions(req.body || {}, req.body?.actor || 'operator'));
  });

  r.post('/pickshow/refresh', (req, res) => {
    res.json({ ok: true, state: pickshow.refresh() });
  });

  r.post('/pickshow/reveal', (req, res) => {
    respond(res, pickshow.revealShow(req.body?.actor || 'operator'));
  });

  r.post('/pickshow/reset', (req, res) => {
    respond(res, pickshow.resetReveal(req.body?.actor || 'operator'));
  });

  r.post('/pickshow/upcoming/clear', (req, res) => {
    respond(res, pickshow.clearUpcoming(req.body?.actor || 'operator'));
  });

  return r;
}
