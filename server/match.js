/**
 * 模块 F —— 比赛计分（曲目 / 小局 / 总分）。
 *
 * 一场比赛（本局）最多 4 首曲目：
 *   · 总分制：把每首曲目的双方得分相加，总分高者获胜；
 *   · 小局制：每首曲目单独比高低，赢的曲目多者获胜。
 *
 * 与比分条的关系：
 *   score.js 通过 summary() 读取本模块的聚合分。比分条切到 `source: 'match'`
 *   后显示这里的「总分 / 胜局」，不再显示手动 ±1 的分数。
 *
 * 空行规则：
 *   · 控制页固定给 4 个输入位；
 *   · 只要一行既没有选曲、也没有任何一方分数，就视为空行 ——
 *     总比分叠加不渲染它，面板高度自动收缩。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ROOT } from './config.js';
import { set } from './state.js';
import * as overlay from './overlay.js';
import * as music from './music.js';
import * as hub from './ws-hub.js';
import * as log from './logger.js';

export const MAX_SONGS = 4;
export const SCORE_MAX = 10_000_000;
export const MODES = ['total', 'wins'];
export const matchEvents = new EventEmitter();

const HISTORY_LIMIT = 200;
const PICK_LIMIT = 30;
const BAN_LIMIT = 500;

const st = {
  current: null,
  history: [],
  picks: [],           // 当前局的待确认选曲
  upcomingPicks: [],   // 「即将进行」赛程的选曲（可跨当前局结束保留）
  revision: 0,
};

// 模块被 score.snapshot() 提前问到时也要有一场空比赛
st.current = blankMatch();

let colorProvider = () => ({ left: '#d0344e', right: '#3d78c9' });
let teamProvider = null;

function filePath() {
  return process.env.LP_MATCH_FILE || path.join(ROOT, 'data', 'match.json');
}

function now() { return Date.now(); }

/** 模块可能在 load() 之前被 score.snapshot() 问到 —— 始终保证有一场空比赛 */
function ensure() {
  if (!st.current) st.current = blankMatch();
  return st.current;
}

// ─────────────────────────────────────────────────────────────
// 数据结构
// ─────────────────────────────────────────────────────────────

function blankSong(index) {
  return {
    index,
    musicId: null,
    title: '',
    artist: '',
    cover: '',
    genre: '',
    genreLabel: '',
    cn: null,
    difficulty: null,
    difficultyName: '',
    difficultyColor: '',
    level: null,
    levelText: '',
    scoreLeft: null,
    scoreRight: null,
  };
}

function blankMatch({ name = '', mode = 'total' } = {}) {
  return {
    id: `m-${now().toString(36)}-${randomUUID().slice(0, 4)}`,
    name: normalizeName(name) || defaultName(),
    // 赛程的「即将进行」：与当前局名称一起持久化，解说摄像头叠加底部提示条读取。
    upcoming: '',
    mode: MODES.includes(mode) ? mode : 'total',
    status: 'live',
    createdAt: now(),
    finishedAt: null,
    winner: null,
    songs: Array.from({ length: MAX_SONGS }, (_, i) => blankSong(i)),
    currentIndex: 0,
    bans: [],
    // 已经写进曲目表的扫码选曲结果（按 P1 / P2 分侧）。
    // 选曲展示用它持续显示「已确认」的结果 —— 待确认队列被应用后会清空，
    // 只靠 picks 的话大屏会在导播确认的瞬间变回「等待选曲」。
    selections: { left: [], right: [] },
  };
}

function defaultName() {
  const n = st.history.length + 1;
  return `第 ${n} 局`;
}

function normalizeName(s) {
  return String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
}

function normalizeMode(m) {
  return MODES.includes(m) ? m : null;
}

export function setColorProvider(fn) {
  if (typeof fn === 'function') colorProvider = fn;
}

/** 队伍解析由 score.js 注入，避免 match ↔ score 循环导入 */
export function setTeamProvider(fn) {
  if (typeof fn === 'function') teamProvider = fn;
}

function colors() {
  try {
    const c = colorProvider() || {};
    return {
      left: /^#[0-9a-f]{6}$/i.test(c.left || '') ? c.left : '#d0344e',
      right: /^#[0-9a-f]{6}$/i.test(c.right || '') ? c.right : '#3d78c9',
    };
  } catch { return { left: '#d0344e', right: '#3d78c9' }; }
}

// ─────────────────────────────────────────────────────────────
// 持久化
// ─────────────────────────────────────────────────────────────

export function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    if (raw?.current) st.current = normalizeMatch(raw.current);
    if (Array.isArray(raw?.history)) {
      st.history = raw.history.filter((h) => h && h.id && h.name).slice(0, HISTORY_LIMIT);
    }
  } catch { /* 首次启动没有文件 */ }
  if (!st.current) st.current = blankMatch();
  // 待处理的扫码选曲不跨重启保留：上一场的请求不应该弹到下一场
  st.picks = [];
  st.upcomingPicks = [];
  broadcast();
  return snapshot();
}

function save() {
  try {
    const dir = path.dirname(filePath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath(), `${JSON.stringify({
      current: st.current,
      history: st.history.slice(0, HISTORY_LIMIT),
      savedAt: now(),
    }, null, 2)}\n`, 'utf8');
  } catch (e) {
    log.warn('match', '比赛数据写盘失败（不影响本次直播）', { err: e.message, file: filePath() });
  }
}

function normalizeMatch(raw) {
  const m = blankMatch({ name: raw.name, mode: raw.mode });
  m.id = String(raw.id || m.id).slice(0, 80);
  m.upcoming = normalizeName(raw.upcoming);
  m.status = raw.status === 'finished' ? 'finished' : 'live';
  m.createdAt = Number(raw.createdAt) || now();
  m.finishedAt = Number(raw.finishedAt) || null;
  m.winner = ['left', 'right', 'draw'].includes(raw.winner) ? raw.winner : null;
  m.bans = Array.isArray(raw.bans)
    ? [...new Set(raw.bans.map(Number).filter((n) => Number.isFinite(n)))].slice(0, BAN_LIMIT)
    : [];
  m.songs = Array.from({ length: MAX_SONGS }, (_, i) => normalizeSong(raw.songs?.[i], i));
  m.selections = normalizeSelections(raw.selections);
  m.currentIndex = clampIndex(raw.currentIndex);
  // 结束时冻结的选手 / 队色：赛后改阵容不会改掉已经播出的结果
  if (raw.players && typeof raw.players === 'object') {
    m.players = {
      left: { ...blankPlayer(), ...raw.players.left },
      right: { ...blankPlayer(), ...raw.players.right },
    };
  }
  if (raw.colors && typeof raw.colors === 'object') {
    m.colors = {
      left: /^#[0-9a-f]{6}$/i.test(raw.colors.left || '') ? raw.colors.left : '#d0344e',
      right: /^#[0-9a-f]{6}$/i.test(raw.colors.right || '') ? raw.colors.right : '#3d78c9',
    };
  }
  return m;
}

function normalizeSelections(raw) {
  const out = { left: [], right: [] };
  for (const side of ['left', 'right']) {
    const list = Array.isArray(raw?.[side]) ? raw[side] : [];
    out[side] = list
      .filter((p) => p && Number.isFinite(Number(p.musicId)) && Number(p.musicId) > 0)
      .slice(-8)
      .map((p, i) => ({
        id: String(p.id || `sel-${side}-${i}`).slice(0, 80),
        side,
        target: 'current',
        index: clampIndex(p.index),
        musicId: Number(p.musicId),
        title: String(p.title || `#${p.musicId}`).slice(0, 120),
        artist: String(p.artist || '').slice(0, 120),
        cover: String(p.cover || ''),
        difficulty: p.difficulty || null,
        difficultyName: String(p.difficultyName || ''),
        difficultyColor: String(p.difficultyColor || ''),
        level: Number(p.level) || null,
        levelText: String(p.levelText || ''),
        source: 'pick',
        player: normalizePlayer(p.player),
        at: Number(p.at) || null,
      }));
  }
  return out;
}

function normalizeSong(raw, index) {
  const row = blankSong(index);
  if (!raw || typeof raw !== 'object') return row;
  const musicId = Number(raw.musicId);
  if (Number.isFinite(musicId) && musicId > 0) {
    const desc = music.describe(musicId, raw.difficulty);
    if (desc) Object.assign(row, desc);
    else {
      row.musicId = musicId;
      row.title = String(raw.title || `#${musicId}`);
      row.artist = String(raw.artist || '');
      row.cover = String(raw.cover || '');
      row.difficulty = raw.difficulty || null;
      row.difficultyName = String(raw.difficultyName || '');
      row.difficultyColor = String(raw.difficultyColor || '');
      row.level = Number(raw.level) || null;
      row.levelText = String(raw.levelText || '');
    }
  }
  // 保存时的曲名 / 曲师作为兜底（曲目库换版本也不至于变成空行）
  if (!row.title && raw.title) row.title = String(raw.title);
  if (!row.artist && raw.artist) row.artist = String(raw.artist);
  row.scoreLeft = normalizeScore(raw.scoreLeft, { allowNull: true });
  row.scoreRight = normalizeScore(raw.scoreRight, { allowNull: true });
  return row;
}

function clampIndex(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_SONGS - 1, n)) : 0;
}

function normalizeScore(v, { allowNull = false } = {}) {
  if (v === null || v === undefined || v === '' || v === '-') return allowNull ? null : null;
  const cleaned = String(v).normalize('NFKC').replace(/[,，\s_]/g, '');
  if (!/^\d+$/.test(cleaned)) return { error: '分数必须是非负整数' };
  const n = Number(cleaned);
  if (!Number.isSafeInteger(n) || n < 0 || n > SCORE_MAX) {
    return { error: `分数必须在 0 – ${SCORE_MAX} 之间` };
  }
  return n;
}

// ─────────────────────────────────────────────────────────────
// 派生结果
// ─────────────────────────────────────────────────────────────

function rowView(raw) {
  const scoreLeft = Number.isFinite(raw.scoreLeft) ? raw.scoreLeft : null;
  const scoreRight = Number.isFinite(raw.scoreRight) ? raw.scoreRight : null;
  const both = scoreLeft !== null && scoreRight !== null;
  let winner = null;
  if (both) winner = scoreLeft > scoreRight ? 'left' : scoreLeft < scoreRight ? 'right' : 'draw';
  const meta = raw.difficulty ? music.difficultyMeta(raw.difficulty) : null;
  const hasSong = !!raw.musicId;
  return {
    index: raw.index,
    hasSong,
    filled: hasSong || scoreLeft !== null || scoreRight !== null,
    both,
    musicId: raw.musicId || null,
    title: raw.title || '',
    artist: raw.artist || '',
    cover: raw.cover || '',
    genre: raw.genre || '',
    genreLabel: raw.genreLabel || raw.genre || '',
    cn: raw.cn,
    difficulty: raw.difficulty || null,
    difficultyName: raw.difficultyName || meta?.name || '',
    difficultyColor: raw.difficultyColor || meta?.color || '',
    level: Number.isFinite(raw.level) ? raw.level : null,
    levelText: raw.levelText || (Number.isFinite(raw.level) ? music.fmtLevel(raw.level) : ''),
    difficulties: raw.musicId ? (music.difficultiesOf(raw.musicId) || []) : [],
    scoreLeft,
    scoreRight,
    winner,
  };
}

export function derive(m = ensure()) {
  const rows = m.songs.map(rowView);
  const filledRows = rows.filter((r) => r.filled);
  const completeRows = rows.filter((r) => r.both);
  const leftWins = completeRows.filter((r) => r.winner === 'left').length;
  const rightWins = completeRows.filter((r) => r.winner === 'right').length;
  const draws = completeRows.filter((r) => r.winner === 'draw').length;
  const totalLeft = completeRows.reduce((a, r) => a + r.scoreLeft, 0);
  const totalRight = completeRows.reduce((a, r) => a + r.scoreRight, 0);
  const displayLeft = m.mode === 'wins' ? leftWins : totalLeft;
  const displayRight = m.mode === 'wins' ? rightWins : totalRight;

  let leader = null;
  if (completeRows.length) {
    leader = displayLeft > displayRight ? 'left' : displayLeft < displayRight ? 'right' : 'draw';
  }
  let winner = null;
  if (m.status === 'finished') {
    // 未完成就被放弃的局可能一首完整分数都没有 —— 这时不要假装是「平局」
    winner = m.winner || (completeRows.length
      ? (displayLeft > displayRight ? 'left' : displayLeft < displayRight ? 'right' : 'draw')
      : null);
  }

  return {
    rows,
    filledRows,
    completeRows: completeRows.length,
    filledCount: filledRows.length,
    leftWins,
    rightWins,
    draws,
    totalLeft,
    totalRight,
    displayLeft,
    displayRight,
    leader,
    winner,
    mode: m.mode,
    scoreKind: m.mode === 'wins' ? 'wins' : 'total',
    modeLabel: m.mode === 'wins' ? '小局制' : '总分制',
    scoreLabel: m.mode === 'wins' ? '胜局' : '总分',
    currentIndex: clampIndex(m.currentIndex),
    hasData: filledRows.length > 0,
  };
}

function blankPlayer() {
  return { entityId: null, name: '', image: '', teamId: null, teamName: '', teamImage: '', handle: '' };
}

function teamOverride(side, ln) {
  try {
    const t = teamProvider?.()?.[side];
    if (t && (t.name || t.image)) {
      return {
        teamId: t.id || ln?.teamId || null,
        teamName: t.name || ln?.teamName || '',
        teamImage: t.image || ln?.teamImage || '',
      };
    }
  } catch { /* 忽略 provider 异常，退回 lineup 自带队伍 */ }
  return {
    teamId: ln?.teamId || null,
    teamName: ln?.teamName || '',
    teamImage: ln?.teamImage || '',
  };
}

function playerView(ln, side = 'left') {
  if (!ln) {
    const t = teamOverride(side, null);
    return { ...blankPlayer(), ...t };
  }
  const team = teamOverride(side, ln);
  return {
    entityId: ln.entityId || null,
    name: ln.name || '',
    image: ln.image || '',
    teamId: team.teamId,
    teamName: team.teamName,
    teamImage: team.teamImage,
    handle: ln.handle || '',
  };
}

export function playersView() {
  const ln = overlay.getLineup();
  return { left: playerView(ln.A, 'left'), right: playerView(ln.B, 'right') };
}

/** 已结束的本局使用结束瞬间冻结的选手 / 队色；进行中才跟随当前 lineup */
function displayPlayers(m) {
  if (m.status === 'finished' && m.players) return m.players;
  return playersView();
}

function displayColors(m) {
  if (m.status === 'finished' && m.colors) return m.colors;
  return colors();
}

export function currentView(m = ensure()) {
  const d = derive(m);
  return {
    id: m.id,
    name: m.name,
    upcoming: m.upcoming || '',
    mode: m.mode,
    status: m.status,
    createdAt: m.createdAt,
    finishedAt: m.finishedAt,
    currentIndex: d.currentIndex,
    songs: d.rows,
    visibleSongs: d.filledRows,
    bans: banViews(m.bans),
    players: displayPlayers(m),
    colors: displayColors(m),
    derived: {
      filledCount: d.filledCount,
      completeRows: d.completeRows,
      leftWins: d.leftWins,
      rightWins: d.rightWins,
      draws: d.draws,
      totalLeft: d.totalLeft,
      totalRight: d.totalRight,
      displayLeft: d.displayLeft,
      displayRight: d.displayRight,
      leader: d.leader,
      winner: d.winner,
      modeLabel: d.modeLabel,
      scoreLabel: d.scoreLabel,
      scoreKind: d.scoreKind,
      hasData: d.hasData,
    },
    winner: d.winner,
    picks: picksView(),
    upcomingPicks: picksView(st.upcomingPicks),
    selections: {
      left: picksView(m.selections?.left || []),
      right: picksView(m.selections?.right || []),
    },
    revision: st.revision,
  };
}

export function summary() {
  const m = ensure();
  const d = derive(m);
  return {
    id: m.id,
    name: m.name,
    upcoming: m.upcoming || '',
    mode: m.mode,
    status: m.status,
    finished: m.status === 'finished',
    modeLabel: d.modeLabel,
    scoreLabel: d.scoreLabel,
    scoreKind: d.scoreKind,
    leftScore: d.displayLeft,
    rightScore: d.displayRight,
    trophyLeft: d.leftWins,
    trophyRight: d.rightWins,
    totalLeft: d.totalLeft,
    totalRight: d.totalRight,
    winner: d.winner,
    leader: d.leader,
    currentIndex: d.currentIndex,
    filledCount: d.filledCount,
    completeRows: d.completeRows,
    hasData: d.hasData,
    colors: displayColors(m),
    players: displayPlayers(m),
    label: m.name,
  };
}

export function snapshot({ historyLimit = null } = {}) {
  const hist = historyLimit === null ? st.history : st.history.slice(0, historyLimit);
  return {
    current: currentView(),
    history: hist.map(historySummary),
    historyTotal: st.history.length,
    picks: picksView(),
    revision: st.revision,
  };
}

function rendererState(s) {
  return {
    ...s.current,
    picks: s.picks.slice(-10),
    history: undefined,
    revision: s.revision,
  };
}

export function broadcast() {
  st.revision++;
  // WS 状态只带最近 20 场：录入分数时每次都推全部历史会把控制端拖慢；
  // 完整历史仍在 data/match.json，HTTP /api/match/state 也返回全量。
  const s = snapshot({ historyLimit: 20 });
  s.revision = st.revision;
  s.current.revision = st.revision;
  set('match.state', s);
  // 解说摄像头叠加只需要赛程名称；单独放一个最小快照，渲染端也能安全接收
  set('match.ticker', {
    current: st.current?.name || '',
    upcoming: st.current?.upcoming || '',
    status: st.current?.status || 'live',
    updatedAt: now(),
  });
  const payload = { t: 'match:state', match: rendererState(s) };
  hub.toRenderers(payload, 'match');
  // 选曲二维码大屏是另一路浏览器源，单独注册 target，避免两个源的连接状态互相覆盖
  hub.toRenderers(payload, 'matchpick');
  matchEvents.emit('change', s);
}

function changed() {
  save();
  broadcast();
}

export function refresh() {
  broadcast();
  return snapshot();
}

// ─────────────────────────────────────────────────────────────
// 比赛生命周期
// ─────────────────────────────────────────────────────────────

function hasContent(m) {
  return m.songs.some((s) => s.musicId || Number.isFinite(s.scoreLeft) || Number.isFinite(s.scoreRight));
}

/** 已结束的本局已写进历史，不能再改，否则画面与记录会对不上 */
function locked() {
  if (st.current?.status === 'finished') {
    return { ok: false, nack: { code: 'already_finished', msg: '本局已结束并保存；要修改请开启新一轮（历史记录保留原结果）' } };
  }
  return null;
}

/**
 * 开启新一轮。
 * 当前局还在进行且已有内容时必须 force，先把它作为「未完成」存档，
 * 避免误点把刚录的比分直接冲掉。
 */
export function start({ name = '', mode = null, force = false, keepBans = false, applyPicks = false } = {}, actor = 'operator') {
  const m = ensure();
  const wantedMode = normalizeMode(mode) || m.mode;
  if (m.status === 'live' && hasContent(m) && !force) {
    return { ok: false, nack: { code: 'unfinished', msg: '当前局还有内容：先「结束本局」，或确认丢弃后再开启新一轮' } };
  }
  if (m.status === 'live' && hasContent(m) && force) {
    archiveCurrent('abandoned');
  }
  st.current = blankMatch({ name, mode: wantedMode });
  if (keepBans) st.current.bans = [...m.bans];
  // 「即将进行」阶段收到的选曲，进入新局后变成待确认队列
  const incoming = st.upcomingPicks.map((p) => ({ ...p, target: 'current' }));
  st.picks = incoming;
  st.upcomingPicks = [];
  // 选曲结果同步：新局直接把「即将进行」的选曲写进空行（不覆盖已有行）
  if (applyPicks) applyPendingToEmptyRows();
  // 选手在手机上认领的身份 → 新局阵容 + 默认霓虹对阵卡进队列
  prepareIncomingLineup(incoming, st.current.name);
  // 选曲展示如果正停在「即将进行」，开新局后自动跟着切到当前局
  matchEvents.emit('start');
  log.audit('match', 'start', { name: st.current.name, mode: st.current.mode, force, actor });
  changed();
  return { ok: true, state: snapshot() };
}

/** 新局开始时把待确认选曲写进空行（同步开启时使用；内部不额外广播） */
function applyPendingToEmptyRows() {
  for (const pick of [...st.picks]) {
    const row = st.current.songs.find((s) => !s.musicId
      && !Number.isFinite(s.scoreLeft) && !Number.isFinite(s.scoreRight));
    if (!row) break;
    dropSelectionAt(row.index);
    applySong(row, pick);
    recordSelection(pick, row.index);
    st.current.currentIndex = row.index;
    st.picks = st.picks.filter((p) => p.id !== pick.id);
  }
}

/** 取「即将进行」队列里每一侧最后一次认领身份的选手 */
function latestIncomingPlayers(picks) {
  const out = { left: null, right: null };
  const at = { left: -1, right: -1 };
  for (const p of picks) {
    if (!p?.player || (!p.player.id && !p.player.name)) continue;
    const side = p.side === 'right' ? 'right' : 'left';
    const t = Number(p.at) || 0;
    if (t >= at[side]) {
      at[side] = t;
      out[side] = p.player;
    }
  }
  return out;
}

/**
 * 新局开始时，把「即将进行」选曲里认领的选手补进阵容，并把默认的
 * 霓虹对阵卡放进叠加队列（只入队，不自动上屏）。
 * 只有两侧都有名字时才排队列 —— 对手阵卡的两侧姓名都是必填。
 */
function prepareIncomingLineup(picks, matchName) {
  const pl = latestIncomingPlayers(picks);
  if (!pl.left && !pl.right) return;
  if (pl.left?.id) overlay.setLineupSide('A', pl.left.id, { syncPreview: false });
  if (pl.right?.id) overlay.setLineupSide('B', pl.right.id, { syncPreview: false });
  if (!pl.left?.name || !pl.right?.name) return;

  const values = {
    leftName: pl.left.name,
    rightName: pl.right.name,
    leftAvatar: pl.left.image || '',
    rightAvatar: pl.right.image || '',
    leftTeam: pl.left.teamName || '',
    rightTeam: pl.right.teamName || '',
    leftTeamAvatar: pl.left.teamImage || '',
    rightTeamAvatar: pl.right.teamImage || '',
    roundLabel: matchName || '',
  };
  const out = overlay.queueAdd({
    template: 'versusCardNeon',
    values,
    durationMs: 8000,
    label: `对阵卡 · ${pl.left.name} vs ${pl.right.name}`,
  });
  if (!out.ok) {
    log.warn('match', '默认对阵卡入队失败', { err: out.nack?.msg || '' });
  }
}

export function setName(name, actor = 'operator') {
  const no = locked();
  if (no) return no;
  const v = normalizeName(name);
  if (!v) return { ok: false, nack: { code: 'empty_name', msg: '比赛名称不能为空' } };
  st.current.name = v;
  log.audit('match', 'name', { name: v, actor });
  changed();
  return { ok: true, state: snapshot() };
}

/**
 * 赛程里的「即将进行」。与当前局名称分开保存：
 *   · 当前局名称是比赛计分的 name（结束后冻结）；
 *   · upcoming 只是解说摄像头底部提示条需要的信息，允许留空。
 */
export function setUpcoming(name, actor = 'operator') {
  // 赛程允许在本局结束后继续编辑：下一场名称和已结束的比分是两回事。
  const v = normalizeName(name);
  if (st.current.upcoming === v) return { ok: true, state: snapshot() };
  st.current.upcoming = v;
  log.audit('match', 'upcoming', { upcoming: v, actor });
  changed();
  return { ok: true, state: snapshot() };
}

export function setMode(mode, actor = 'operator') {
  const m = normalizeMode(mode);
  if (!m) return { ok: false, nack: { code: 'bad_mode', msg: 'mode 必须是 total 或 wins' } };
  if (st.current.status === 'finished') {
    return { ok: false, nack: { code: 'already_finished', msg: '本局已结束，不能再切换计分模式' } };
  }
  if (st.current.mode === m) return { ok: true, state: snapshot() };
  st.current.mode = m;
  log.audit('match', 'mode', { mode: m, actor });
  changed();
  return { ok: true, state: snapshot() };
}

export function finish(actor = 'operator') {
  const m = ensure();
  if (m.status === 'finished') {
    return { ok: false, nack: { code: 'already_finished', msg: '本局已经结束并保存过了' } };
  }
  const d = derive(m);
  if (!d.completeRows) {
    return { ok: false, nack: { code: 'no_scores', msg: '还没有任何一首曲目同时录入双方分数，无法结算' } };
  }
  m.status = 'finished';
  m.finishedAt = now();
  m.winner = d.winner || (d.displayLeft > d.displayRight ? 'left' : d.displayLeft < d.displayRight ? 'right' : 'draw');
  m.players = playersView();
  m.colors = colors();
  st.picks = [];
  pushHistory(m, 'finished');
  log.audit('match', 'finish', {
    name: m.name, mode: m.mode, winner: m.winner,
    left: d.displayLeft, right: d.displayRight, actor,
  });
  changed();
  return { ok: true, state: snapshot() };
}

function archiveCurrent(status) {
  const m = st.current;
  if (!hasContent(m)) return;
  m.status = 'finished';
  m.finishedAt = now();
  const d = derive(m);
  m.winner = d.leader === 'left' || d.leader === 'right' ? d.leader : (d.leader === 'draw' ? 'draw' : null);
  m.players = playersView();
  m.colors = colors();
  pushHistory(m, status);
}

function pushHistory(m, status) {
  const d = derive(m);
  const players = m.players || playersView();
  const entry = {
    id: m.id,
    name: m.name,
    mode: m.mode,
    status,
    createdAt: m.createdAt,
    finishedAt: m.finishedAt || now(),
    winner: m.winner,
    players,
    colors: m.colors || colors(),
    bans: banViews(m.bans),
    songs: m.songs.map((s) => ({ ...s })),
    result: {
      modeLabel: d.modeLabel,
      scoreKind: d.scoreKind,
      leftWins: d.leftWins,
      rightWins: d.rightWins,
      draws: d.draws,
      totalLeft: d.totalLeft,
      totalRight: d.totalRight,
      displayLeft: d.displayLeft,
      displayRight: d.displayRight,
      completeRows: d.completeRows,
    },
    savedAt: now(),
  };
  st.history.unshift(entry);
  if (st.history.length > HISTORY_LIMIT) st.history.length = HISTORY_LIMIT;
}

function historySummary(h) {
  return {
    id: h.id,
    name: h.name,
    mode: h.mode,
    status: h.status,
    createdAt: h.createdAt,
    finishedAt: h.finishedAt,
    winner: h.winner,
    players: h.players,
    result: h.result,
    songsCount: (h.songs || []).filter((s) => s.musicId || Number.isFinite(s.scoreLeft) || Number.isFinite(s.scoreRight)).length,
  };
}

export function getHistory(id) {
  return st.history.find((h) => h.id === id) || null;
}

export function clearHistory(actor = 'operator') {
  st.history = [];
  log.audit('match', 'history-clear', { actor });
  changed();
  return { ok: true, state: snapshot() };
}

// ─────────────────────────────────────────────────────────────
// 曲目行
// ─────────────────────────────────────────────────────────────

function rowAt(index) {
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= MAX_SONGS) return null;
  return st.current.songs[i];
}

/**
 * 把曲库里的展示字段同步到比赛行；返回是否真的改动了内容。
 * 不动分数 —— 重新选择同一首曲目时要用它补齐封面等元数据。
 */
function applySongMeta(row, desc) {
  let changed = false;
  const set = (key, value) => {
    if (row[key] !== value) { row[key] = value; changed = true; }
  };
  set('musicId', desc.musicId);
  set('title', desc.title);
  set('artist', desc.artist);
  set('cover', desc.cover || '');
  set('genre', desc.genre || '');
  set('genreLabel', desc.genreLabel || '');
  set('cn', desc.cn);
  set('difficulty', desc.difficulty);
  set('difficultyName', desc.difficultyName);
  set('difficultyColor', desc.difficultyColor);
  set('level', desc.level);
  set('levelText', desc.levelText || '');
  return changed;
}

function applySong(row, desc) {
  applySongMeta(row, desc);
  row.scoreLeft = null;
  row.scoreRight = null;
}

/**
 * 为某一行选曲。musicId 为空 = 清空该行（曲目与分数一起清）。
 * 换曲或换难度都会清空这一行的分数 —— 分数只对具体谱面有意义。
 */
export function setSong(index, { musicId = null, difficulty = null } = {}, actor = 'operator') {
  const no = locked();
  if (no) return no;
  const row = rowAt(index);
  if (!row) return { ok: false, nack: { code: 'bad_index', msg: `index 必须是 0–${MAX_SONGS - 1}` } };

  if (musicId === null || musicId === '' || musicId === undefined) {
    st.current.songs[row.index] = blankSong(row.index);
    dropSelectionAt(row.index);
    log.audit('match', 'song-clear', { index: row.index, actor });
    changed();
    return { ok: true, state: snapshot() };
  }

  const desc = music.describe(musicId, difficulty);
  if (!desc) return { ok: false, nack: { code: 'unknown_music', msg: '曲目不存在，或这个难度没有谱面' } };
  if (row.musicId === desc.musicId && row.difficulty === desc.difficulty) {
    // 同一曲目 / 难度再点一次：保留已录分数，但补齐封面等元数据。
    // 旧行可能是在曲库还没有封面、或曲库后来补了封面时保存的。
    if (applySongMeta(row, desc)) changed();
    return { ok: true, state: snapshot() };
  }
  dropSelectionAt(row.index);
  applySong(row, desc);
  st.current.currentIndex = row.index;
  log.audit('match', 'song', {
    index: row.index, music: `${desc.title} [${desc.difficultyName}]`, level: desc.level, actor,
  });
  changed();
  return { ok: true, state: snapshot() };
}

export function setScore(index, side, value, actor = 'operator') {
  const no = locked();
  if (no) return no;
  const row = rowAt(index);
  if (!row) return { ok: false, nack: { code: 'bad_index', msg: `index 必须是 0–${MAX_SONGS - 1}` } };
  const key = side === 'left' ? 'scoreLeft' : side === 'right' ? 'scoreRight' : null;
  if (!key) return { ok: false, nack: { code: 'bad_side', msg: 'side 必须是 left 或 right' } };

  const parsed = normalizeScore(value);
  if (parsed && typeof parsed === 'object') {
    return { ok: false, nack: { code: 'bad_score', msg: parsed.error } };
  }
  const from = row[key];
  row[key] = parsed;
  if (parsed !== from) {
    log.audit('match', 'score', { index: row.index, side, from, to: parsed, actor });
    changed();
  }
  return { ok: true, state: snapshot() };
}

export function setCurrent(index) {
  const no = locked();
  if (no) return no;
  const i = clampIndex(index);
  if (st.current.currentIndex === i) return { ok: true, state: snapshot() };
  st.current.currentIndex = i;
  log.audit('match', 'current', { index: i });
  changed();
  return { ok: true, state: snapshot() };
}

export function clearRow(index, actor = 'operator') {
  const no = locked();
  if (no) return no;
  const row = rowAt(index);
  if (!row) return { ok: false, nack: { code: 'bad_index', msg: `index 必须是 0–${MAX_SONGS - 1}` } };
  st.current.songs[row.index] = blankSong(row.index);
  dropSelectionAt(row.index);
  log.audit('match', 'row-clear', { index: row.index, actor });
  changed();
  return { ok: true, state: snapshot() };
}

/** 随机选曲：默认填第一个空行；也可以指定替换某一行 */
export function randomPick({ index = null, difficulty = null, genre = '', minLevel = null, maxLevel = null, cnOnly = false, includeWe = false } = {}, actor = 'operator') {
  const no = locked();
  if (no) return no;
  let row = null;
  if (index !== null && index !== undefined) {
    row = rowAt(index);
    if (!row) return { ok: false, nack: { code: 'bad_index', msg: `index 必须是 0–${MAX_SONGS - 1}` } };
  }
  if (!row) {
    row = st.current.songs.find((s) => !s.musicId && !Number.isFinite(s.scoreLeft) && !Number.isFinite(s.scoreRight))
      || st.current.songs[clampIndex(st.current.currentIndex)];
  }
  if (!row) return { ok: false, nack: { code: 'no_row', msg: '没有可用的曲目行' } };

  const used = st.current.songs.filter((s) => s !== row && s.musicId).map((s) => s.musicId);
  const pick = music.random({
    difficulty: difficulty || undefined,
    genre,
    minLevel,
    maxLevel,
    cnOnly,
    includeWe,
    bannedIds: st.current.bans,
    excludeIds: used,
  });
  if (!pick) return { ok: false, nack: { code: 'empty_pool', msg: '当前过滤条件下没有可选的曲目（可能都被 ban 了）' } };

  // 从曲库统一取展示字段（含封面）；不要在这里手写对象，避免漏字段
  const desc = music.describe(pick.song.id, pick.difficulty);
  if (!desc) return { ok: false, nack: { code: 'unknown_music', msg: '曲目不存在，或这个难度没有谱面' } };
  dropSelectionAt(row.index);
  applySong(row, desc);
  st.current.currentIndex = row.index;
  log.audit('match', 'random', { index: row.index, music: pick.song.name, difficulty: pick.difficulty, level: pick.level, actor });
  changed();
  return { ok: true, state: snapshot(), pick };
}

// ─────────────────────────────────────────────────────────────
// Ban
// ─────────────────────────────────────────────────────────────

function banViews(ids) {
  return (ids || []).map((id) => {
    const s = music.getView(id);
    return { musicId: id, name: s?.name || `#${id}`, artist: s?.artist || '', genre: s?.genre || '' };
  });
}

export function ban(musicId, banned = true, actor = 'operator') {
  const no = locked();
  if (no) return no;
  const id = Number(musicId);
  const song = music.getView(id);
  if (!song) return { ok: false, nack: { code: 'unknown_music', msg: '曲目不存在' } };
  const list = st.current.bans;
  const has = list.includes(id);
  if (banned) {
    if (st.current.songs.some((s) => s.musicId === id)) {
      return { ok: false, nack: { code: 'in_use', msg: '这首曲目已经在曲目表里，先清空那一行再 ban' } };
    }
    if (!has) {
      if (list.length >= BAN_LIMIT) return { ok: false, nack: { code: 'ban_full', msg: `Ban 列表最多 ${BAN_LIMIT} 首` } };
      list.push(id);
    }
  } else if (has) {
    st.current.bans = list.filter((x) => x !== id);
  }
  log.audit('match', banned ? 'ban' : 'unban', { music: song.name, id, actor });
  changed();
  return { ok: true, state: snapshot() };
}

export function clearBans(actor = 'operator') {
  const no = locked();
  if (no) return no;
  if (!st.current.bans.length) return { ok: true, state: snapshot() };
  st.current.bans = [];
  log.audit('match', 'bans-clear', { actor });
  changed();
  return { ok: true, state: snapshot() };
}

// ─────────────────────────────────────────────────────────────
// 扫码选曲
// ─────────────────────────────────────────────────────────────

function normalizePlayer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim().slice(0, 80);
  const name = String(raw.name || '').trim().slice(0, 60);
  if (!id && !name) return null;
  return {
    id: id || null,
    name,
    image: String(raw.image || '').slice(0, 400),
    teamName: String(raw.teamName || '').slice(0, 60),
    teamImage: String(raw.teamImage || '').slice(0, 400),
  };
}

function picksView(list = st.picks) {
  return list.map((p) => ({
    id: p.id,
    side: p.side,
    target: p.target || 'current',
    index: Number.isInteger(p.index) ? p.index : null,
    musicId: p.musicId,
    title: p.title,
    artist: p.artist,
    cover: p.cover || '',
    difficulty: p.difficulty,
    difficultyName: p.difficultyName,
    difficultyColor: p.difficultyColor,
    level: p.level,
    levelText: p.levelText || '',
    source: p.source || 'pick',
    player: p.player || null,
    at: p.at,
    appliedAt: p.appliedAt || null,
  }));
}

export function createPick({ side = 'left', musicId = null, difficulty = null, source = 'pick', target = 'current', player = null } = {}) {
  const upcoming = target === 'upcoming';
  if (!upcoming && st.current.status !== 'live') {
    return { ok: false, nack: { code: 'match_finished', msg: '本局已结束，请切换到「即将进行」再提交选曲' } };
  }
  const sideKey = side === 'right' ? 'right' : side === 'left' ? 'left' : null;
  if (!sideKey) return { ok: false, nack: { code: 'bad_side', msg: '请选择 P1 或 P2' } };
  const desc = music.describe(musicId, difficulty);
  if (!desc) return { ok: false, nack: { code: 'unknown_music', msg: '曲目不存在，或这个难度没有谱面' } };
  if (st.current.bans.includes(Number(musicId))) {
    return { ok: false, nack: { code: 'banned', msg: '这首曲目已被 ban' } };
  }
  // 当前局已选曲目只限制当前局；即将进行是另一场，不应被当前曲目表挡住
  if (!upcoming && st.current.songs.some((s) => s.musicId === Number(musicId))) {
    return { ok: false, nack: { code: 'already_selected', msg: '这首曲目已经在曲目表里了' } };
  }

  const playerInfo = normalizePlayer(player);
  const list = upcoming ? st.upcomingPicks : st.picks;
  const dup = list.find((p) => p.side === sideKey && p.musicId === desc.musicId && p.difficulty === desc.difficulty);
  if (dup) {
    dup.at = now();
    if (playerInfo) dup.player = playerInfo;
    broadcast();
    return { ok: true, pick: picksView([dup])[0], duplicate: true };
  }

  if (list.length >= PICK_LIMIT) list.shift();
  const pick = {
    id: `pick-${randomUUID().slice(0, 8)}`,
    side: sideKey,
    target: upcoming ? 'upcoming' : 'current',
    ...desc,
    source,
    player: playerInfo,
    at: now(),
  };
  list.push(pick);
  log.info('match', upcoming ? '收到即将进行选曲' : '收到扫码选曲', {
    side: sideKey, music: desc.title, difficulty: desc.difficulty,
  });
  changed();
  return { ok: true, pick: picksView([pick])[0] };
}

/** 某一行的选曲结果已经失效（手改 / 清空曲目行）时，从展示结果里移除 */
function dropSelectionAt(index) {
  if (!st.current?.selections) return;
  for (const side of ['left', 'right']) {
    st.current.selections[side] = st.current.selections[side].filter((p) => p.index !== index);
  }
}

/** 把一条已写入曲目表的选曲记进分侧结果，供选曲展示持续显示 */
function recordSelection(pick, index) {
  const side = pick.side === 'right' ? 'right' : 'left';
  if (!st.current.selections) st.current.selections = { left: [], right: [] };
  const list = st.current.selections[side];
  const entry = {
    id: pick.id,
    side,
    target: 'current',
    index,
    musicId: pick.musicId,
    title: pick.title,
    artist: pick.artist,
    cover: pick.cover || '',
    difficulty: pick.difficulty,
    difficultyName: pick.difficultyName,
    difficultyColor: pick.difficultyColor,
    level: pick.level,
    levelText: pick.levelText || '',
    source: 'pick',
    player: pick.player || null,
    at: pick.at || now(),
    appliedAt: now(),
  };
  // 同一行只保留最后一次结果；同曲同难度也不重复
  const next = list.filter((p) => p.index !== index
    && !(p.musicId === entry.musicId && p.difficulty === entry.difficulty));
  next.push(entry);
  st.current.selections[side] = next.slice(-8);
}

export function applyPick(id, index = null, actor = 'operator', opts = {}) {
  const no = locked();
  if (no) return no;
  const pick = st.picks.find((p) => p.id === id);
  if (!pick) return { ok: false, nack: { code: 'not_found', msg: '这条选曲请求不存在（可能已被处理）' } };
  let row = null;
  if (index !== null && index !== undefined) {
    row = rowAt(index);
    if (!row) return { ok: false, nack: { code: 'bad_index', msg: `index 必须是 0–${MAX_SONGS - 1}` } };
  }
  if (!row) {
    row = st.current.songs.find((s) => !s.musicId && !Number.isFinite(s.scoreLeft) && !Number.isFinite(s.scoreRight));
    // 自动同步不能覆盖已经录了比分的行；没有空行就留在待确认队列里
    if (!row && opts.onlyEmpty) {
      return { ok: false, nack: { code: 'no_row', msg: '曲目表已满，选曲留在待确认队列' } };
    }
    if (!row) row = st.current.songs[clampIndex(st.current.currentIndex)];
  }
  if (!row) return { ok: false, nack: { code: 'no_row', msg: '没有可用的曲目行' } };

  dropSelectionAt(row.index);
  applySong(row, pick);
  recordSelection(pick, row.index);
  st.current.currentIndex = row.index;
  st.picks = st.picks.filter((p) => p.id !== id);
  log.audit('match', 'pick-apply', { side: pick.side, music: pick.title, index: row.index, actor });
  changed();
  return { ok: true, state: snapshot(), index: row.index };
}

export function dismissPick(id, actor = 'operator') {
  const pick = st.picks.find((p) => p.id === id);
  if (!pick) return { ok: false, nack: { code: 'not_found', msg: '这条选曲请求不存在' } };
  st.picks = st.picks.filter((p) => p.id !== id);
  log.audit('match', 'pick-dismiss', { side: pick.side, music: pick.title, actor });
  changed();
  return { ok: true, state: snapshot() };
}

/** 清空「即将进行」的选曲队列（不影响当前局待确认队列） */
export function clearUpcomingPicks(actor = 'operator') {
  if (!st.upcomingPicks.length) return { ok: true, state: snapshot() };
  const n = st.upcomingPicks.length;
  st.upcomingPicks = [];
  log.audit('match', 'upcoming-picks-clear', { count: n, actor });
  changed();
  return { ok: true, state: snapshot() };
}

/** 手机选曲页只拿得到这些：没有分数、没有选手信息 */
export function publicState() {
  const m = st.current;
  const d = derive(m);
  return {
    name: m.name,
    upcoming: m.upcoming || '',
    mode: m.mode,
    modeLabel: d.modeLabel,
    status: m.status,
    banned: [...m.bans],
    songs: d.filledRows.map((r) => ({
      musicId: r.musicId,
      title: r.title,
      difficulty: r.difficulty,
      difficultyName: r.difficultyName,
      level: r.level,
    })),
    pickCount: st.picks.length,
    upcomingPickCount: st.upcomingPicks.length,
    upcomingPickMusicIds: st.upcomingPicks.map((p) => p.musicId),
    canPickCurrent: m.status === 'live',
    canPickUpcoming: true,
  };
}

export function shutdown() {
  save();
}
