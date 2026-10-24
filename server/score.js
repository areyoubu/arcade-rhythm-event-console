/**
 * 模块 D —— 比赛比分条 + 选手牌（常驻叠加组件）。
 *
 * 为什么单独成模块：
 *   · 比分条是**常驻**的，不应该跟着叠加模板 show/hide；
 *   · 它与两块选手牌放在**同一个浏览器源**里（/render/score），
 *     OBS 里只多开一个源，而不是三个；
 *   · 加一 / 减一只进入「待确认」，必须按确认才真正改分 —— 直播里误触一次代价太大。
 *
 * 选手从 `overlay.getLineup()` 取（A ↔ 左 / B ↔ 右），与叠加页双向同步。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { set } from './state.js';
import * as entities from './entities.js';
import * as overlay from './overlay.js';
import * as match from './match.js';
import * as hub from './ws-hub.js';
import * as log from './logger.js';

const LOG_LIMIT = 50;

/** 允许用环境变量覆盖存储位置（自检 / 测试不污染真实数据） */
function filePath() {
  return process.env.LP_SCORE_FILE || path.join(ROOT, 'data', 'scoreboard.json');
}

/**
 * 三个元件的**设计尺寸**（1920×1080 画布里的 1:1 像素）。
 *
 * 分件输出按「设计尺寸 × 缩放」1:1 渲染，合并输出里也用同一个尺寸和缩放，
 * 所以两边看起来大小完全一致 —— 不会再出现「推荐分辨率与预览对不上」。
 * 改这里要同步改 public/render/score.html 的对应 CSS 尺寸。
 */
export const LAYER_BASE = {
  bar: { w: 1180, h: 104 },
  left: { w: 470, h: 116 },
  right: { w: 470, h: 116 },
};

/** 默认布局：比分条居中靠上，选手牌在比分条下方左右两侧 */
export const DEFAULT_LAYOUT = {
  bar: { x: 370, y: 44, scale: 1 },
  left: { x: 64, y: 172, scale: 1 },
  right: { x: 1920 - 64 - 470, y: 172, scale: 1 },
};

const st = {
  visible: true,
  barVisible: true,
  platesVisible: true,
  /**
   * 比分来源：
   *   manual —— 手动 ±1（原来的用法）
   *   match  —— 跟随「比赛计分」模块的总分 / 胜局
   */
  source: 'manual',
  label: '',
  sides: {
    left: { score: 0, teamId: null, color: '#d0344e' },
    right: { score: 0, teamId: null, color: '#3d78c9' },
  },
  /** 待确认的增量：+1 / -1 累加，确认时才落到 score */
  pending: { left: 0, right: 0 },
  log: [],
  revision: 0,
  /** 合并输出中每个元件的位置与缩放（分件输出复用 scale） */
  layout: JSON.parse(JSON.stringify(DEFAULT_LAYOUT)),
};

// ─────────────────────────────────────────────────────────────
// 持久化（赛中重启不至于丢分）
// ─────────────────────────────────────────────────────────────

export function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    if (raw && typeof raw === 'object') {
      if (raw.source === 'match' || raw.source === 'manual') st.source = raw.source;
      if (typeof raw.label === 'string') st.label = raw.label;
      if (typeof raw.barVisible === 'boolean') st.barVisible = raw.barVisible;
      if (typeof raw.platesVisible === 'boolean') st.platesVisible = raw.platesVisible;
      for (const k of ['left', 'right']) {
        const s = raw.sides?.[k];
        if (!s) continue;
        if (Number.isFinite(s.score)) st.sides[k].score = Math.max(0, Math.round(s.score));
        if (s.teamId) st.sides[k].teamId = s.teamId;
        if (/^#[0-9a-f]{6}$/i.test(s.color || '')) st.sides[k].color = s.color;
      }
      if (Array.isArray(raw.log)) {
        st.log = raw.log.filter((x) => x && typeof x === 'object' && Number.isFinite(x.at)).slice(-LOG_LIMIT);
      }
      if (raw.layout && typeof raw.layout === 'object') {
        for (const part of Object.keys(DEFAULT_LAYOUT)) {
          const l = raw.layout[part];
          if (!l) continue;
          if (Number.isFinite(l.x)) st.layout[part].x = Math.round(l.x);
          if (Number.isFinite(l.y)) st.layout[part].y = Math.round(l.y);
          if (Number.isFinite(l.scale)) st.layout[part].scale = clampScale(l.scale);
        }
      }
    }
  } catch { /* 首次启动没有文件，正常 */ }
  broadcast();
  return snapshot();
}

function save() {
  try {
    const dir = path.dirname(filePath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath(), `${JSON.stringify(serializeRaw(), null, 2)}\n`, 'utf8');
  } catch (e) {
    log.warn('score', '比分数据写盘失败（不影响本次直播）', { err: e.message, file: filePath() });
  }
}

function serializeRaw() {
  return {
    source: st.source,
    label: st.label,
    barVisible: st.barVisible,
    platesVisible: st.platesVisible,
    sides: {
      left: { score: st.sides.left.score, teamId: st.sides.left.teamId, color: st.sides.left.color },
      right: { score: st.sides.right.score, teamId: st.sides.right.teamId, color: st.sides.right.color },
    },
    layout: st.layout,
    log: st.log.slice(-LOG_LIMIT),
    savedAt: Date.now(),
  };
}

// ─────────────────────────────────────────────────────────────
// 快照
// ─────────────────────────────────────────────────────────────

function resolveTeam(sideKey, ln, { frozen = false } = {}) {
  // 已结束的比赛使用结束瞬间冻结的选手 / 队伍，赛后改队伍覆盖不能改掉已播出的结果
  if (!frozen) {
    const ov = st.sides[sideKey].teamId ? entities.get(st.sides[sideKey].teamId) : null;
    if (ov && ov.kind === 'team') return { id: ov.id, name: ov.name, image: ov.image || '' };
  }
  return { id: ln?.teamId || null, name: ln?.teamName || '', image: ln?.teamImage || '' };
}

function sideView(sideKey, ln, sideLetter, { useMatch = false, m = null, frozen = false } = {}) {
  const team = resolveTeam(sideKey, ln, { frozen });
  const s = st.sides[sideKey];
  const matchScore = sideKey === 'left' ? m?.leftScore : m?.rightScore;
  const score = useMatch ? Math.max(0, Math.round(Number(matchScore) || 0)) : s.score;
  const pending = useMatch ? 0 : st.pending[sideKey];
  const winnerSide = useMatch && m?.finished ? m?.winner : null;
  const color = frozen
    ? (sideKey === 'left' ? m?.colors?.left : m?.colors?.right) || s.color
    : s.color;
  return {
    side: sideLetter,
    score,
    manualScore: s.score,
    pending,
    shownScore: Math.max(0, score + pending),
    color,
    teamId: team.id,
    teamName: team.name,
    teamImage: team.image,
    playerId: ln?.entityId || null,
    playerName: ln?.name || '',
    playerImage: ln?.image || '',
    playerRole: ln?.role || '',
    isWinner: !!winnerSide && winnerSide === sideKey,
    isDraw: winnerSide === 'draw',
    wins: useMatch ? (sideKey === 'left' ? m?.trophyLeft : m?.trophyRight) || 0 : 0,
    totalScore: useMatch ? (sideKey === 'left' ? m?.totalLeft : m?.totalRight) || 0 : s.score,
  };
}

function outputs() {
  const out = {};
  for (const part of Object.keys(LAYER_BASE)) {
    const b = LAYER_BASE[part];
    const sc = st.layout[part].scale;
    out[part] = { w: Math.round(b.w * sc), h: Math.round(b.h * sc) };
  }
  return out;
}

export function snapshot() {
  const lineup = overlay.getLineup();
  const m = match.summary();
  const useMatch = st.source === 'match';
  // 比赛结束后选手快照已经冻结在记录里，比分条也跟着冻结，避免赛后改阵容改掉结果
  const leftLn = useMatch && m.players?.left ? m.players.left : lineup.A;
  const rightLn = useMatch && m.players?.right ? m.players.right : lineup.B;
  const meta = useMatch
    ? `${m.modeLabel}${m.finished ? ' · 已结束' : ''}`
    : '';
  return {
    base: LAYER_BASE,
    layout: JSON.parse(JSON.stringify(st.layout)),
    outputs: outputs(),
    source: st.source,
    visible: st.visible,
    barVisible: st.barVisible,
    platesVisible: st.platesVisible,
    label: useMatch ? (m.name || '') : st.label,
    meta,
    match: m,
    matchWinner: useMatch ? m.winner : null,
    pending: { left: st.pending.left, right: st.pending.right },
    hasPending: st.pending.left !== 0 || st.pending.right !== 0,
    left: sideView('left', leftLn, 'A', { useMatch, m, frozen: useMatch && m.finished }),
    right: sideView('right', rightLn, 'B', { useMatch, m, frozen: useMatch && m.finished }),
    log: st.log.slice(-30),
    revision: st.revision,
  };
}

function broadcast() {
  const s = snapshot();
  st.revision++;
  s.revision = st.revision;
  set('score.state', s);
  // 渲染端（浏览器源）不接收非 overlay 的 patch，这里是显式的定向推送。
  // 大屏不需要操作日志，去掉能少发一大截数据。
  const { log: _omit, ...forRenderer } = s;
  hub.toRenderers({ t: 'score:state', score: forRenderer }, 'score');
}

function addLog(entry) {
  st.log.push({ at: Date.now(), ...entry });
  if (st.log.length > LOG_LIMIT) st.log.splice(0, st.log.length - LOG_LIMIT);
}

function changed() {
  save();
  broadcast();
}

// ─────────────────────────────────────────────────────────────
// 比分：暂存 → 确认
// ─────────────────────────────────────────────────────────────

function normSide(side) {
  return side === 'right' ? 'right' : side === 'left' ? 'left' : null;
}

/**
 * 加一 / 减一 —— 只改 pending，不动正式比分。
 * @param {'left'|'right'} side
 * @param {number} delta
 */
export function stage(side, delta) {
  const k = normSide(side);
  if (!k) return { ok: false, nack: { code: 'bad_side', msg: 'side 必须是 left 或 right' } };
  if (st.source === 'match') {
    return { ok: false, nack: { code: 'match_source', msg: '比分条正在跟随比赛计分，请到「比赛」页修改曲目分数' } };
  }
  const d = Number(delta);
  if (!Number.isInteger(d) || d === 0) return { ok: false, nack: { code: 'bad_delta', msg: 'delta 必须是非零整数（通常是 +1 / -1）' } };

  const cur = st.sides[k].score + st.pending[k];
  const next = cur + d;
  if (next < 0) return { ok: false, nack: { code: 'negative', msg: '比分不能小于 0' } };

  st.pending[k] += d;
  log.audit('score', 'stage', { side: k, delta: d, from: cur, to: next });
  broadcast();
  return { ok: true, state: snapshot() };
}

/** 确认：把 pending 落到正式比分，并记一条可回溯的操作日志 */
export function confirm(actor = 'operator') {
  if (st.source === 'match') {
    return { ok: false, nack: { code: 'match_source', msg: '比分条正在跟随比赛计分，无需手动确认' } };
  }
  const changes = [];
  for (const k of ['left', 'right']) {
    const d = st.pending[k];
    if (!d) continue;
    const from = st.sides[k].score;
    const to = Math.max(0, from + d);
    st.sides[k].score = to;
    changes.push({ side: k, from, to, delta: d });
  }
  if (!changes.length) return { ok: false, nack: { code: 'no_pending', msg: '没有待确认的比分变化' } };

  st.pending = { left: 0, right: 0 };
  const text = changes.map((c) => `${c.side === 'left' ? '左' : '右'} ${c.from}→${c.to}`).join(' / ');
  addLog({ action: 'confirm', text, changes, actor });
  log.audit('score', 'confirm', { changes, actor });
  changed();
  return { ok: true, state: snapshot() };
}

export function cancel(actor = 'operator') {
  if (!st.pending.left && !st.pending.right) {
    return { ok: false, nack: { code: 'no_pending', msg: '没有待确认的比分变化' } };
  }
  addLog({ action: 'cancel', text: `取消待确认：左 ${st.pending.left >= 0 ? '+' : ''}${st.pending.left} / 右 ${st.pending.right >= 0 ? '+' : ''}${st.pending.right}`, actor });
  st.pending = { left: 0, right: 0 };
  log.audit('score', 'cancel', { actor });
  broadcast();
  return { ok: true, state: snapshot() };
}

/** 直接设定比分（含二次确认由调用方负责） */
export function setScore(side, value, actor = 'operator') {
  const k = normSide(side);
  if (!k) return { ok: false, nack: { code: 'bad_side', msg: 'side 必须是 left 或 right' } };
  if (st.source === 'match') {
    return { ok: false, nack: { code: 'match_source', msg: '比分条正在跟随比赛计分，请到「比赛」页修改曲目分数' } };
  }
  const v = Number(value);
  if (!Number.isInteger(v) || v < 0) return { ok: false, nack: { code: 'bad_value', msg: '比分必须是非负整数' } };
  const from = st.sides[k].score;
  if (from === v) return { ok: true, state: snapshot() };
  st.sides[k].score = v;
  st.pending[k] = 0;
  addLog({ action: 'set', text: `${k === 'left' ? '左' : '右'}队比分 ${from} → ${v}`, actor });
  log.audit('score', 'setScore', { side: k, from, to: v, actor });
  changed();
  return { ok: true, state: snapshot() };
}

export function resetScores(actor = 'operator') {
  if (st.source === 'match') {
    return { ok: false, nack: { code: 'match_source', msg: '比分条正在跟随比赛计分；如需清零请到「比赛」页清空曲目分数' } };
  }
  const from = `${st.sides.left.score}:${st.sides.right.score}`;
  st.sides.left.score = 0;
  st.sides.right.score = 0;
  st.pending = { left: 0, right: 0 };
  addLog({ action: 'reset', text: `比分归零（原 ${from}）`, actor });
  log.audit('score', 'reset', { from, actor });
  changed();
  return { ok: true, state: snapshot() };
}

// ─────────────────────────────────────────────────────────────
// 布局（合并输出位置 + 分件缩放）
// ─────────────────────────────────────────────────────────────

const LAYOUT_PARTS = new Set(Object.keys(DEFAULT_LAYOUT));
function clampScale(v) { return Math.min(4, Math.max(0.3, Math.round(Number(v) * 100) / 100)); }
function clampX(v) { return Math.max(-600, Math.min(3000, Math.round(Number(v)))); }
function clampY(v) { return Math.max(-400, Math.min(1600, Math.round(Number(v)))); }

/**
 * 调整某个元件的位置 / 缩放。
 * 位置只影响合并输出；缩放同时决定分件输出的像素尺寸（设计尺寸 × scale），
 * 所以合并里看到的元件大小 = 分件源放到 OBS 里的大小。
 */
export function setLayout(part, patch = {}, actor = 'operator') {
  if (!LAYOUT_PARTS.has(part)) {
    return { ok: false, nack: { code: 'bad_part', msg: 'part 必须是 bar / left / right' } };
  }
  const cur = st.layout[part];
  const next = { ...cur };
  if (patch.x !== undefined && Number.isFinite(Number(patch.x))) next.x = clampX(patch.x);
  if (patch.y !== undefined && Number.isFinite(Number(patch.y))) next.y = clampY(patch.y);
  if (patch.scale !== undefined && Number.isFinite(Number(patch.scale))) next.scale = clampScale(patch.scale);
  if (next.x === cur.x && next.y === cur.y && next.scale === cur.scale) {
    return { ok: true, state: snapshot() };
  }
  st.layout[part] = next;
  const name = part === 'bar' ? '比分条' : part === 'left' ? 'P1 选手牌' : 'P2 选手牌';
  addLog({ action: 'layout', text: `布局：${name} (${next.x}, ${next.y}) ${next.scale.toFixed(2)}×`, actor });
  log.audit('score', 'layout', { part, ...next, actor });
  changed();
  return { ok: true, state: snapshot() };
}

export function resetLayout(actor = 'operator') {
  st.layout = JSON.parse(JSON.stringify(DEFAULT_LAYOUT));
  addLog({ action: 'layout', text: '布局已恢复默认', actor });
  log.audit('score', 'layout-reset', { actor });
  changed();
  return { ok: true, state: snapshot() };
}

// ─────────────────────────────────────────────────────────────
// 展示项
// ─────────────────────────────────────────────────────────────

/**
 * 比分来源切换。
 * 切到 match 时清掉手动暂存，避免「看不见的 +2」在切回手动后突然生效。
 */
export function setSource(source, actor = 'operator') {
  const s = source === 'match' ? 'match' : source === 'manual' ? 'manual' : null;
  if (!s) return { ok: false, nack: { code: 'bad_source', msg: 'source 必须是 manual 或 match' } };
  if (st.source === s) return { ok: true, state: snapshot() };
  st.source = s;
  st.pending = { left: 0, right: 0 };
  addLog({ action: 'source', text: s === 'match' ? '比分条改为跟随比赛计分' : '比分条改回手动比分', actor });
  log.audit('score', 'source', { source: s, actor });
  changed();
  return { ok: true, state: snapshot() };
}

export function setLabel(label) {
  st.label = String(label ?? '').slice(0, 40);
  addLog({ action: 'label', text: `中间标签：${st.label || '（空）'}` });
  log.audit('score', 'label', { label: st.label });
  changed();
  return { ok: true, state: snapshot() };
}

export function setTeam(side, teamId, actor = 'operator') {
  const k = normSide(side);
  if (!k) return { ok: false, nack: { code: 'bad_side', msg: 'side 必须是 left 或 right' } };
  if (teamId) {
    const t = entities.get(teamId);
    if (!t || t.kind !== 'team') return { ok: false, nack: { code: 'unknown_team', msg: '队伍不存在' } };
    st.sides[k].teamId = t.id;
    addLog({ action: 'team', text: `${k === 'left' ? '左' : '右'}队：${t.name}`, actor });
  } else {
    st.sides[k].teamId = null;
    addLog({ action: 'team', text: `${k === 'left' ? '左' : '右'}队：跟随选手`, actor });
  }
  log.audit('score', 'team', { side: k, teamId: st.sides[k].teamId, actor });
  changed();
  // 总比分画面也显示队伍名 / Logo
  match.refresh();
  return { ok: true, state: snapshot() };
}

export function setColor(side, color, actor = 'operator') {
  const k = normSide(side);
  if (!k) return { ok: false, nack: { code: 'bad_side', msg: 'side 必须是 left 或 right' } };
  const c = String(color || '');
  if (!/^#[0-9a-f]{6}$/i.test(c)) return { ok: false, nack: { code: 'bad_color', msg: '颜色必须是 #RRGGBB' } };
  st.sides[k].color = c;
  addLog({ action: 'color', text: `${k === 'left' ? '左' : '右'}队颜色 → ${c}`, actor });
  log.audit('score', 'color', { side: k, color: c, actor });
  changed();
  // 总比分画面也用同一套队色
  match.refresh();
  return { ok: true, state: snapshot() };
}

/** all = 整体显隐；bar / plates 单独控制 */
export function setVisible(patch = {}) {
  if (typeof patch.all === 'boolean') {
    st.visible = patch.all;
    addLog({ action: 'visible', text: patch.all ? '显示比分组件' : '隐藏比分组件' });
  }
  if (typeof patch.bar === 'boolean') { st.barVisible = patch.bar; addLog({ action: 'visible', text: patch.bar ? '显示比分条' : '隐藏比分条' }); }
  if (typeof patch.plates === 'boolean') { st.platesVisible = patch.plates; addLog({ action: 'visible', text: patch.plates ? '显示选手牌' : '隐藏选手牌' }); }
  log.audit('score', 'visible', { visible: st.visible, bar: st.barVisible, plates: st.platesVisible });
  changed();
  return { ok: true, state: snapshot() };
}

// ─────────────────────────────────────────────────────────────
// 选手（与叠加共用 lineup）
// ─────────────────────────────────────────────────────────────

export function setPlayer(side, entityId, actor = 'scoreboard') {
  const k = normSide(side);
  if (!k) return { ok: false, nack: { code: 'bad_side', msg: 'side 必须是 left 或 right' } };
  const r = overlay.setLineupSide(k === 'left' ? 'A' : 'B', entityId || null, { target: 'preview' });
  if (!r.ok) return r;
  const e = entityId ? entities.get(entityId) : null;
  addLog({ action: 'player', text: `${k === 'left' ? 'P1（左）' : 'P2（右）'}：${e ? e.name : '（空）'}`, actor });
  // lineup 变化已经触发 overlay 状态；比分快照里的选手是从 lineup 现算的
  changed();
  return { ok: true, state: snapshot(), lineup: r.lineup };
}

/**
 * 一键清空两侧选手。
 * ⚠️ 只清选手信息，**不隐藏选手条** —— 台面上 1P / 2P 两块牌子常驻，
 * 空的时候显示「待选」，避免画面突然缺一块。
 */
export function clearPlayers(actor = 'scoreboard') {
  const cur = overlay.getLineup();
  if (!cur.A && !cur.B) return { ok: true, state: snapshot() };
  overlay.setLineupSide('A', null, { target: 'preview' });
  overlay.setLineupSide('B', null, { target: 'preview' });
  addLog({ action: 'player', text: '清空选手（选手条保留）', actor });
  log.audit('score', 'clearPlayers', { actor });
  changed();
  return { ok: true, state: snapshot() };
}

/** 比赛模式切换后队伍信息要重算 */
export function refresh() {
  broadcast();
  return snapshot();
}

export function getSideColors() {
  return { left: st.sides.left.color, right: st.sides.right.color };
}

/** 比赛画面用的两侧队伍（含手动指定的队伍覆盖） */
export function getSideTeams() {
  const ln = overlay.getLineup();
  return {
    left: resolveTeam('left', ln.A),
    right: resolveTeam('right', ln.B),
  };
}
