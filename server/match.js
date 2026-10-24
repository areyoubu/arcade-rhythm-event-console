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
  picks: [],
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
    mode: MODES.includes(mode) ? mode : 'total',
    status: 'live',
    createdAt: now(),
    finishedAt: null,
    winner: null,
    songs: Array.from({ length: MAX_SONGS }, (_, i) => blankSong(i)),
    currentIndex: 0,
    bans: [],
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
  m.status = raw.status === 'finished' ? 'finished' : 'live';
  m.createdAt = Number(raw.createdAt) || now();
  m.finishedAt = Number(raw.finishedAt) || null;
  m.winner = ['left', 'right', 'draw'].includes(raw.winner) ? raw.winner : null;
  m.bans = Array.isArray(raw.bans)
    ? [...new Set(raw.bans.map(Number).filter((n) => Number.isFinite(n)))].slice(0, BAN_LIMIT)
    : [];
  m.songs = Array.from({ length: MAX_SONGS }, (_, i) => normalizeSong(raw.songs?.[i], i));
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
    revision: st.revision,
  };
}

export function summary() {
  const m = ensure();
  const d = derive(m);
  return {
    id: m.id,
    name: m.name,
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
export function start({ name = '', mode = null, force = false, keepBans = false } = {}, actor = 'operator') {
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
  st.picks = [];
  log.audit('match', 'start', { name: st.current.name, mode: st.current.mode, force, actor });
  changed();
  return { ok: true, state: snapshot() };
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

function applySong(row, desc) {
  row.musicId = desc.musicId;
  row.title = desc.title;
  row.artist = desc.artist;
  row.cover = desc.cover || '';
  row.genre = desc.genre || '';
  row.genreLabel = desc.genreLabel || '';
  row.cn = desc.cn;
  row.difficulty = desc.difficulty;
  row.difficultyName = desc.difficultyName;
  row.difficultyColor = desc.difficultyColor;
  row.level = desc.level;
  row.levelText = desc.levelText || '';
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
    log.audit('match', 'song-clear', { index: row.index, actor });
    changed();
    return { ok: true, state: snapshot() };
  }

  const desc = music.describe(musicId, difficulty);
  if (!desc) return { ok: false, nack: { code: 'unknown_music', msg: '曲目不存在，或这个难度没有谱面' } };
  if (row.musicId === desc.musicId && row.difficulty === desc.difficulty) {
    return { ok: true, state: snapshot() };
  }
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

  applySong(row, {
    musicId: pick.song.id,
    title: pick.song.name,
    artist: pick.song.artist,
    genre: pick.song.genre,
    genreLabel: pick.song.genreLabel,
    cn: pick.song.cn,
    difficulty: pick.difficulty,
    difficultyName: music.DIFFICULTY_NAMES[pick.difficulty],
    difficultyColor: music.difficultyMeta(pick.difficulty)?.color || '',
    level: pick.level,
    levelText: pick.levelText || '',
  });
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

function picksView() {
  return st.picks.map((p) => ({
    id: p.id,
    side: p.side,
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
    at: p.at,
  }));
}

export function createPick({ side = 'left', musicId = null, difficulty = null, source = 'pick' } = {}) {
  if (st.current.status !== 'live') {
    return { ok: false, nack: { code: 'match_finished', msg: '本局已结束，不能再提交选曲' } };
  }
  const sideKey = side === 'right' ? 'right' : side === 'left' ? 'left' : null;
  if (!sideKey) return { ok: false, nack: { code: 'bad_side', msg: '请选择 P1 或 P2' } };
  const desc = music.describe(musicId, difficulty);
  if (!desc) return { ok: false, nack: { code: 'unknown_music', msg: '曲目不存在，或这个难度没有谱面' } };
  if (st.current.bans.includes(Number(musicId))) {
    return { ok: false, nack: { code: 'banned', msg: '这首曲目已被 ban' } };
  }
  if (st.current.songs.some((s) => s.musicId === Number(musicId))) {
    return { ok: false, nack: { code: 'already_selected', msg: '这首曲目已经在曲目表里了' } };
  }

  const dup = st.picks.find((p) => p.side === sideKey && p.musicId === desc.musicId && p.difficulty === desc.difficulty);
  if (dup) {
    dup.at = now();
    broadcast();
    return { ok: true, pick: picksView().find((p) => p.id === dup.id), duplicate: true };
  }

  if (st.picks.length >= PICK_LIMIT) st.picks.shift();
  const pick = {
    id: `pick-${randomUUID().slice(0, 8)}`,
    side: sideKey,
    ...desc,
    source,
    at: now(),
  };
  st.picks.push(pick);
  log.info('match', '收到扫码选曲', { side: sideKey, music: desc.title, difficulty: desc.difficulty });
  changed();
  return { ok: true, pick: picksView().find((p) => p.id === pick.id) };
}

export function applyPick(id, index = null, actor = 'operator') {
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
    row = st.current.songs.find((s) => !s.musicId && !Number.isFinite(s.scoreLeft) && !Number.isFinite(s.scoreRight))
      || st.current.songs[clampIndex(st.current.currentIndex)];
  }
  if (!row) return { ok: false, nack: { code: 'no_row', msg: '没有可用的曲目行' } };

  applySong(row, pick);
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

/** 手机选曲页只拿得到这些：没有分数、没有选手信息 */
export function publicState() {
  const m = st.current;
  const d = derive(m);
  return {
    name: m.name,
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
  };
}

export function shutdown() {
  save();
}
