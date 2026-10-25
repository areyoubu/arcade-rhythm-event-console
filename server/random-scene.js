/**
 * 全屏随机选曲场景。
 *
 * 复用曲库的 random 逻辑抽一首，再生成一条足够长的「滚动条」：
 *   目标曲固定放在 TARGET_INDEX，渲染端从右向左滑到它，缓停后放大曲绘。
 *
 * 结果放在共享状态 random.state：控制页 / 预览 / OBS 渲染源都能收到，
 * 不需要渲染源登录（hello 全量 + patch 都发给所有端）。
 */
import { set } from './state.js';
import * as music from './music.js';
import * as gameAudio from './game-audio.js';
import * as log from './logger.js';

// 卡片越少，OBS 里那条超宽合成层的压力越小，曲绘更容易在滚动过程中就画出来。
// 21 号为目标位，后面还留 6 张填满右侧视口。
export const REEL_SIZE = 28;
export const TARGET_INDEX = 21;
export const SPIN_MS = 6400;

let last = null;

function metaOf(difficulty) {
  return music.difficultyMeta(difficulty) || {};
}

function reelItem(pick) {
  const m = metaOf(pick.difficulty);
  return {
    id: pick.song.id,
    title: pick.song.name,
    artist: pick.song.artist,
    cover: pick.song.cover || '',
    genre: pick.song.genre,
    genreLabel: pick.song.genreLabel || pick.song.genre,
    cn: pick.song.cn,
    difficulty: pick.difficulty,
    difficultyName: m.name || pick.difficulty,
    difficultyColor: m.color || '#7030a0',
    level: pick.level,
    levelText: pick.levelText || '',
  };
}

function pickedView(target) {
  const item = reelItem(target);
  return {
    ...item,
    difficulties: { ...(target.song.difficulties || {}) },
    difficultyColors: music.difficultyColors(),
    we: target.song.we ? { ...target.song.we } : null,
    weText: target.song.weText || '',
  };
}

function normalizeFilters(raw = {}) {
  return {
    q: String(raw.q || ''),
    genre: String(raw.genre || ''),
    difficulty: String(raw.difficulty || ''),
    minLevel: raw.minLevel === null || raw.minLevel === undefined || raw.minLevel === '' ? null : Number(raw.minLevel),
    maxLevel: raw.maxLevel === null || raw.maxLevel === undefined || raw.maxLevel === '' ? null : Number(raw.maxLevel),
    cnOnly: !!raw.cnOnly,
    includeWe: !!raw.includeWe,
  };
}

function randomOne(filters, exclude) {
  return music.random({ ...filters, excludeIds: [...exclude] })
    || music.random({ ...filters });
}

/**
 * 抽一首并生成滚动条。
 * @param {object} rawFilters 与 /api/music/random 相同的过滤参数
 * @param {string} actor
 */
export function spin(rawFilters = {}, actor = 'operator', opts = {}) {
  const filters = normalizeFilters(rawFilters);
  const target = music.random(filters);
  if (!target) {
    return { ok: false, nack: { code: 'empty_pool', msg: '当前筛选条件下没有可随机曲目（可能都被 ban 或范围过窄）' } };
  }

  const reel = [];
  const exclude = new Set([target.song.id]);
  for (let i = 0; i < REEL_SIZE; i++) {
    if (i === TARGET_INDEX) {
      reel.push(reelItem(target));
      continue;
    }
    const pick = randomOne(filters, exclude);
    if (!pick) {
      return { ok: false, nack: { code: 'empty_pool', msg: '可随机曲目不足，无法生成完整滚动条' } };
    }
    exclude.add(pick.song.id);
    reel.push(reelItem(pick));
  }

  const picked = pickedView(target);
  // 音频描述在抽中时就放进状态；解码在后台进行，渲染端等结果动画结束再播。
  const audio = opts.audio === false ? null : gameAudio.descriptor(picked.id);
  last = {
    at: Date.now(),
    reelSize: REEL_SIZE,
    targetIndex: TARGET_INDEX,
    spinMs: SPIN_MS,
    reel,
    picked,
    audio,
    filters,
    actor,
  };

  set('random.state', last);
  log.audit('random', 'spin', {
    musicId: picked.id,
    music: picked.title,
    difficulty: picked.difficulty,
    level: picked.level,
    filters,
    actor,
  });
  return { ok: true, state: last };
}

export function clear(actor = 'operator') {
  last = null;
  set('random.state', null);
  log.audit('random', 'clear', { actor });
  return { ok: true };
}

export function snapshot() {
  return last;
}
