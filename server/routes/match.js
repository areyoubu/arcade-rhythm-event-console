/**
 * 模块 F —— 比赛计分 / 扫码选曲 HTTP API。
 *
 * 手机端只开放两个接口：
 *   GET  /api/match/public   当前局名称、已选曲目、ban 列表（无分数、无选手）
 *   POST /api/match/pick     提交选曲（限流 30 次 / 分钟 / IP）
 *
 * 其余都是控制端接口。选曲请求不会直接改曲目表，必须由导播在比赛页点「应用」，
 * 避免选手误点或重复提交把比赛画面改掉。
 */
import express from 'express';
import { respond } from './http.js';
import { getConfig } from '../config.js';
import { qrPng, resolvePublicUrl } from '../public-url.js';
import { createRateLimiter } from '../rate-limit.js';
import { clientIp } from '../client-ip.js';
import * as match from '../match.js';
import * as score from '../score.js';

// 每 IP 每分钟最多提交次数
const allowPick = createRateLimiter({ max: 30, windowMs: 60_000 });

/** 二维码指向的地址：公网 > 局域网配置 > 当前访问地址 > 自动探测局域网 IP */
function resolvePickUrl(req) {
  const cfg = getConfig();
  return resolvePublicUrl({
    origin: String(req.query.origin || '').trim(),
    publicUrl: cfg.match?.publicPickBaseUrl,
    baseUrl: cfg.match?.pickBaseUrl,
    path: '/pick',
    port: cfg.server?.overlayPort || 3000,
    label: '选曲',
    configHint: '局域网选曲地址 / 公网选曲地址',
  });
}

export default function matchRoutes() {
  const r = express.Router();

  r.get('/match/state', (req, res) => res.json({ ok: true, state: match.snapshot() }));
  r.get('/match/history/:id', (req, res) => {
    const h = match.getHistory(req.params.id);
    if (!h) return res.status(404).json({ ok: false, nack: { code: 'not_found', msg: '比赛记录不存在' } });
    res.json({ ok: true, match: h });
  });
  r.get('/match/public', (req, res) => res.json({ ok: true, ...match.publicState() }));

  // ── 二维码 ──
  r.get('/match/pickUrl', (req, res) => res.json({ ok: true, ...resolvePickUrl(req) }));

  r.get('/match/qr', async (req, res) => {
    const info = resolvePickUrl(req);
    try {
      const png = await qrPng(info.url, req.query.size);
      res.set('Cache-Control', 'no-store');
      res.type('png').send(png);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── 手机选曲（公开，限流）──
  r.post('/match/pick', (req, res) => {
    const ip = clientIp(req);
    if (!allowPick(ip)) {
      return res.status(429).json({ ok: false, nack: { code: 'rate_limited', msg: '提交太频繁，请稍后再试' } });
    }
    const body = req.body || {};
    const out = match.createPick({
      side: body.side,
      musicId: body.musicId,
      difficulty: body.difficulty,
      source: 'pick',
    });
    if (!out.ok) return res.status(400).json(out);
    res.json({ ok: true, pick: out.pick, duplicate: !!out.duplicate });
  });

  // ── 比赛生命周期 ──
  r.post('/match/start', (req, res) => {
    const out = match.start(req.body || {}, req.body?.actor || 'operator');
    if (out.ok) score.setSource('match', req.body?.actor || 'operator');
    respond(res, out);
  });
  r.post('/match/name', (req, res) => respond(res, match.setName(req.body?.name, req.body?.actor || 'operator')));
  r.post('/match/mode', (req, res) => respond(res, match.setMode(req.body?.mode, req.body?.actor || 'operator')));
  r.post('/match/finish', (req, res) => respond(res, match.finish(req.body?.actor || 'operator')));
  r.post('/match/history/clear', (req, res) => respond(res, match.clearHistory(req.body?.actor || 'operator')));

  // ── 曲目行 ──
  r.post('/match/song', (req, res) => {
    const { index, musicId, difficulty, actor } = req.body || {};
    respond(res, match.setSong(index, { musicId, difficulty }, actor || 'operator'));
  });
  r.post('/match/score', (req, res) => {
    const { index, side, value, actor } = req.body || {};
    respond(res, match.setScore(index, side, value, actor || 'operator'));
  });
  r.post('/match/current', (req, res) => respond(res, match.setCurrent(req.body?.index)));
  r.post('/match/row/clear', (req, res) => respond(res, match.clearRow(req.body?.index, req.body?.actor || 'operator')));
  r.post('/match/random', (req, res) => {
    const body = req.body || {};
    respond(res, match.randomPick({
      index: body.index ?? null,
      difficulty: body.difficulty || null,
      genre: body.genre || '',
      minLevel: Number.isFinite(Number(body.minLevel)) && body.minLevel !== '' ? Number(body.minLevel) : null,
      maxLevel: Number.isFinite(Number(body.maxLevel)) && body.maxLevel !== '' ? Number(body.maxLevel) : null,
      cnOnly: !!body.cnOnly,
      includeWe: !!body.includeWe,
    }, body.actor || 'operator'));
  });

  // ── Ban ──
  r.post('/match/ban', (req, res) => {
    const { musicId, banned = true, actor } = req.body || {};
    respond(res, match.ban(musicId, banned !== false, actor || 'operator'));
  });
  r.post('/match/bans/clear', (req, res) => respond(res, match.clearBans(req.body?.actor || 'operator')));

  // ── 扫码选曲的处理 ──
  r.post('/match/pick/apply', (req, res) => {
    const { id, index, actor } = req.body || {};
    respond(res, match.applyPick(id, index ?? null, actor || 'operator'));
  });
  r.post('/match/pick/dismiss', (req, res) => {
    const { id, actor } = req.body || {};
    respond(res, match.dismissPick(id, actor || 'operator'));
  });

  return r;
}

