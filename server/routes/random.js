/**
 * 全屏随机选曲 API。
 *
 * 控制端（/random）：
 *   POST /api/random/spin    按筛选条件随机并广播到 random 大屏
 *   POST /api/random/clear   清空大屏
 *   GET  /api/random/state   最近一次结果（控制页回读）
 *
 * 渲染源 /render/random 不调用这些接口，直接通过 WS 的 random.state 接收。
 */
import express from 'express';
import { respond } from './http.js';
import * as randomScene from '../random-scene.js';

export default function randomRoutes() {
  const r = express.Router();

  r.get('/random/state', (req, res) => res.json({ ok: true, state: randomScene.snapshot() }));

  r.post('/random/spin', (req, res) => {
    const body = req.body || {};
    respond(res, randomScene.spin(body.filters || body, body.actor || 'operator', {
      audio: body.audio !== false,
    }));
  });

  r.post('/random/clear', (req, res) => {
    respond(res, randomScene.clear(req.body?.actor || 'operator'));
  });

  return r;
}
