/**
 * 选手选曲展示场景。
 *
 * 数据来自比赛模块的两条选曲队列：
 *   · current  —— 当前局待确认（/pick 提交、导播尚未写入曲目表）
 *   · upcoming —— 即将进行（当前局结束后仍可继续提交，开始新局时转入 current）
 *
 * 输出选项（side / count / source / sync）由 /pickshow 控制台设置，结果通过
 * pickshow.state 广播给控制页和 OBS 渲染源。
 */
import { set } from './state.js';
import * as match from './match.js';
import * as gameAudio from './game-audio.js';
import * as log from './logger.js';

const DEFAULTS = {
  side: 'both',     // both | left | right
  count: 'auto',    // auto | 1 | 2 | 4
  source: 'current',// current | upcoming
  sync: true,       // 选曲结果自动写入比赛曲目表（默认开）
  audio: true,      // 展示动画播放游戏曲目预览音频
  audioSide: 'auto',// auto（双人默认 P1）| left | right
};

let options = { ...DEFAULTS };
let last = null;

/**
 * 展示动画状态。
 *   revealed=false —— 渲染端停在待展示画面，不提前泄露选的歌；
 *   revealSeq      —— 每次点击「播放展示动画」自增，渲染端据此重播 3D 展开。
 */
let reveal = { revealed: false, seq: 0, at: null };

function normalize(patch = {}) {
  const next = { ...options };
  if (['both', 'left', 'right'].includes(patch.side)) next.side = patch.side;
  if (['auto', 1, '1', 2, '2', 4, '4'].includes(patch.count)) next.count = String(patch.count);
  if (['current', 'upcoming'].includes(patch.source)) next.source = patch.source;
  if (typeof patch.sync === 'boolean') next.sync = patch.sync;
  if (typeof patch.audio === 'boolean') next.audio = patch.audio;
  if (['auto', 'left', 'right'].includes(patch.audioSide)) next.audioSide = patch.audioSide;
  return next;
}

function pickView(p) {
  return {
    id: p.id,
    side: p.side,
    index: p.index ?? null,
    musicId: p.musicId,
    title: p.title,
    artist: p.artist,
    cover: p.cover || '',
    difficulty: p.difficulty,
    difficultyName: p.difficultyName,
    difficultyColor: p.difficultyColor,
    level: p.level,
    levelText: p.levelText || '',
    player: p.player || null,
    at: p.at,
  };
}

/** 同一首歌 / 难度只显示一次；后提交的（待确认）优先 */
function mergePicks(primary = [], secondary = []) {
  const map = new Map();
  for (const p of primary) map.set(`${p.musicId}:${p.difficulty}`, p);
  for (const p of secondary) map.set(`${p.musicId}:${p.difficulty}`, p);
  return [...map.values()];
}

/** 最近一次认领身份，用于「即将进行」在比赛开始前就显示真实姓名 */
function playerFromPicks(list = []) {
  let best = null;
  let bestAt = -1;
  for (const p of list) {
    if (!p?.player?.name) continue;
    const t = Number(p.at) || 0;
    if (t >= bestAt) {
      bestAt = t;
      best = p.player;
    }
  }
  return best;
}

function build() {
  const snap = match.snapshot();
  const m = snap.current || {};
  const source = options.source === 'upcoming' ? 'upcoming' : 'current';
  const side = ['both', 'left', 'right'].includes(options.side) ? options.side : 'both';
  const pending = source === 'upcoming' ? (m.upcomingPicks || []) : (m.picks || []);
  const selected = source === 'current' ? (m.selections || {}) : {};

  // 同步开启时，已写进曲目表的结果和待确认选曲一起显示 ——
  // 导播点「应用」后大屏不会突然空掉。
  const leftAll = options.sync
    ? mergePicks(selected.left || [], pending.filter((p) => p.side === 'left'))
    : pending.filter((p) => p.side === 'left');
  const rightAll = options.sync
    ? mergePicks(selected.right || [], pending.filter((p) => p.side === 'right'))
    : pending.filter((p) => p.side === 'right');

  const max = Math.max(leftAll.length, rightAll.length);
  const count = options.count === 'auto'
    ? (max > 2 ? 4 : 2)
    : (Number(options.count) >= 4 ? 4 : Number(options.count) <= 1 ? 1 : 2);

  // 选手身份：优先用手机端认领的身份，其次用当前阵容
  const players = { ...(m.players || {}) };
  for (const side of ['left', 'right']) {
    const p = playerFromPicks(side === 'left' ? leftAll : rightAll);
    if (!p) continue;
    players[side] = {
      ...(players[side] || {}),
      name: p.name || players[side]?.name || '',
      image: p.image || players[side]?.image || '',
      teamName: p.teamName || players[side]?.teamName || '',
      teamImage: p.teamImage || players[side]?.teamImage || '',
    };
  }

  const shownLeft = leftAll.slice(-count);
  const shownRight = rightAll.slice(-count);

  // 预览音频：双人默认 P1 的第一首展示曲目；单人默认当前侧。
  // 指定的一侧没有选曲时自动退到另一侧，避免有画面却没声音。
  let audioSide = options.audioSide === 'left' || options.audioSide === 'right'
    ? options.audioSide
    : (side === 'both' ? 'left' : side);
  let audioPicks = audioSide === 'left' ? shownLeft : shownRight;
  if (!audioPicks.length) {
    audioSide = audioSide === 'left' ? 'right' : 'left';
    audioPicks = audioSide === 'left' ? shownLeft : shownRight;
  }
  const audioTrack = audioPicks[0] || null;
  const audio = options.audio && audioTrack
    ? gameAudio.descriptor(audioTrack.musicId, { side: audioSide, title: audioTrack.title || '' })
    : null;

  last = {
    at: Date.now(),
    options: { ...options },
    source,
    count,
    sourceLabel: source === 'upcoming' ? '即将进行' : '当前局',
    matchName: source === 'upcoming' ? (m.upcoming || '即将进行') : (m.name || '比赛'),
    players,
    colors: m.colors || {},
    left: shownLeft.map(pickView),
    right: shownRight.map(pickView),
    totals: { left: leftAll.length, right: rightAll.length },
    upcomingPickCount: (m.upcomingPicks || []).length,
    audio,
    audioSide: audio ? audioSide : null,
    revealed: reveal.revealed,
    revealSeq: reveal.seq,
    revealedAt: reveal.at,
  };

  set('pickshow.state', last);
  return last;
}

export function refresh() {
  return build();
}

export function setOptions(patch, actor = 'operator') {
  const next = normalize(patch);
  const changed = JSON.stringify(next) !== JSON.stringify(options);
  options = next;
  if (changed) log.audit('pickshow', 'options', { ...options, actor });
  const state = build();
  return { ok: true, state, options: { ...options } };
}

/** 播放展示动画：每次点击都自增序号，渲染端会重新播放 3D 展开 */
export function revealShow(actor = 'operator') {
  reveal = { revealed: true, seq: reveal.seq + 1, at: Date.now() };
  log.audit('pickshow', 'reveal', { seq: reveal.seq, actor });
  return { ok: true, state: build() };
}

/** 回到待展示画面（不泄露选曲），下次点击再播放动画 */
export function resetReveal(actor = 'operator') {
  reveal = { revealed: false, seq: reveal.seq, at: null };
  log.audit('pickshow', 'reveal-reset', { actor });
  return { ok: true, state: build() };
}

// 开新局：切回当前局，并重新进入待展示，下一次上屏由导播手动播放动画
match.matchEvents.on('start', () => {
  reveal = { revealed: false, seq: reveal.seq, at: null };
  if (options.source !== 'upcoming') return;
  options = { ...options, source: 'current' };
  log.info('pickshow', '新局开始，选曲展示来源切回当前局');
});

export function clearUpcoming(actor = 'operator') {
  const out = match.clearUpcomingPicks(actor);
  // match.change 订阅会刷新；这里再保证一次返回最新展示状态
  refresh();
  return { ok: out.ok !== false, state: last };
}

export function snapshot() {
  return last;
}

export function getOptions() {
  return { ...options };
}
