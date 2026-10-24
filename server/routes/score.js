/**
 * 模块 D —— 比分条 / 选手牌 HTTP API。
 * 加一 / 减一只走 /stage（暂存），/confirm 才真正改分。
 */
import express from 'express';
import { respond } from './http.js';
import * as score from '../score.js';

export default function scoreRoutes() {
  const r = express.Router();

  r.get('/score/state', (req, res) => res.json({ ok: true, state: score.snapshot() }));

  r.post('/score/stage', (req, res) => {
    const { side, delta } = req.body || {};
    respond(res, score.stage(side, delta));
  });

  r.post('/score/confirm', (req, res) => respond(res, score.confirm(req.body?.actor || 'operator')));
  r.post('/score/cancel', (req, res) => respond(res, score.cancel(req.body?.actor || 'operator')));

  r.post('/score/set', (req, res) => {
    const { side, value, actor } = req.body || {};
    respond(res, score.setScore(side, value, actor || 'operator'));
  });

  r.post('/score/reset', (req, res) => respond(res, score.resetScores(req.body?.actor || 'operator')));

  r.post('/score/source', (req, res) => respond(res, score.setSource(req.body?.source, req.body?.actor || 'operator')));
  r.post('/score/label', (req, res) => respond(res, score.setLabel(req.body?.label)));
  r.post('/score/team', (req, res) => respond(res, score.setTeam(req.body?.side, req.body?.teamId, req.body?.actor || 'operator')));
  r.post('/score/color', (req, res) => respond(res, score.setColor(req.body?.side, req.body?.color, req.body?.actor || 'operator')));
  r.post('/score/visible', (req, res) => respond(res, score.setVisible(req.body || {})));
  r.post('/score/player', (req, res) => respond(res, score.setPlayer(req.body?.side, req.body?.entityId, req.body?.actor || 'scoreboard')));
  r.post('/score/players/clear', (req, res) => respond(res, score.clearPlayers(req.body?.actor || 'scoreboard')));

  r.post('/score/layout', (req, res) => {
    const { part, x, y, scale, actor } = req.body || {};
    respond(res, score.setLayout(part, { x, y, scale }, actor || 'operator'));
  });
  r.post('/score/layout/reset', (req, res) => respond(res, score.resetLayout(req.body?.actor || 'operator')));

  return r;
}

