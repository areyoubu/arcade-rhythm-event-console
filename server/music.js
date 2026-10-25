/**
 * 曲目库 —— 由 tools/import-music.mjs 从 ChunithmMusicData.xlsx 生成。
 *
 * 负责：
 *   1. 读 data/music.json（缺失时自动从 data/source xlsx 生成一次）；
 *   2. 搜索 / 过滤 / 随机选曲；
 *   3. 提供难度名与官方难度色；
 *   4. 管理端写入：单曲增改删、上传 xlsx 全量替换。
 *
 * 手工修改会直接写回 data/music.json；xlsx 只是导入源，不是唯一真源。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { ROOT, getConfig } from './config.js';
import * as log from './logger.js';

export const DIFFICULTY_ORDER = ['basic', 'advanced', 'expert', 'master', 'ultima'];
export const DIFFICULTY_NAMES = {
  basic: 'BASIC', advanced: 'ADVANCED', expert: 'EXPERT', master: 'MASTER', ultima: 'ULTIMA',
};
/** 定数来源：jp = 游戏 / 日服；cn = 公共 API / 国服 */
export const LEVEL_SOURCES = ['jp', 'cn'];
export const LEVEL_SOURCE_LABELS = { jp: '日服（游戏）', cn: '国服（API）' };
/** 特殊谱面：WORLD'S END。默认不进随机池，需显式勾选。 */
export const WE_KEY = 'we';
export const WE_NAME = "WORLD'S END";
export const WE_COLOR = '#b04ad9';
const FALLBACK_COLORS = {
  basic: '#3fb950', advanced: '#f0a000', expert: '#e53935', master: '#8e44e8', ultima: '#e11d74',
};

const collator = new Intl.Collator('zh-Hans', { numeric: true, sensitivity: 'base' });

const db = {
  loaded: false,
  file: '',
  generatedAt: '',
  updatedAt: '',
  source: '',
  sourceSheet: '',
  levelSource: 'jp',
  cnSync: null,
  songs: [],
  byId: new Map(),
  difficulties: {},
  genres: [],
  counts: { songs: 0, cn: 0, covers: 0, we: 0, jpLevels: 0, cnLevels: 0 },
};

function filePath() {
  return process.env.LP_MUSIC_FILE || path.join(ROOT, 'data', 'music.json');
}

function applyData(raw) {
  const songs = Array.isArray(raw?.songs) ? raw.songs : [];
  db.levelSource = LEVEL_SOURCES.includes(raw?.levelSource) ? raw.levelSource : 'jp';
  db.cnSync = normalizeCnSync(raw?.cnSync);
  db.songs = songs
    .filter((s) => s && Number.isFinite(Number(s.id)) && s.name)
    .map((s) => {
      const legacy = normalizeDiffs(s.difficulties);
      const levels = normalizeLevels(s.levels, legacy);
      const effective = pickLevels(levels, db.levelSource, legacy);
      const we = normalizeWe(s.we, db.levelSource);
      return {
        id: Number(s.id),
        name: String(s.name),
        artist: String(s.artist || ''),
        genre: String(s.genre || ''),
        cn: s.cn !== false,
        cnReleaseDate: cleanDate(s.cnReleaseDate),
        cnVersion: s.cnVersion === null || s.cnVersion === undefined || s.cnVersion === ''
          ? null
          : (Number.isFinite(Number(s.cnVersion)) ? Number(s.cnVersion) : null),
        levels,
        difficulties: effective,
        cover: safeCover(s.cover),
        we,
        game: normalizeGame(s.game),
        _name: norm(s.name),
        _artist: norm(s.artist || ''),
      };
    })
    .sort((a, b) => collator.compare(a.name, b.name) || a.id - b.id);
  db.byId = new Map(db.songs.map((s) => [s.id, s]));
  db.difficulties = {};
  for (const key of DIFFICULTY_ORDER) {
    const d = raw?.difficulties?.[key];
    db.difficulties[key] = {
      key,
      name: d?.name || DIFFICULTY_NAMES[key],
      color: /^#[0-9a-f]{6}$/i.test(d?.color || '') ? d.color : FALLBACK_COLORS[key],
    };
  }
  const genreMap = new Map();
  for (const g of raw?.genres || []) {
    if (!g?.name) continue;
    genreMap.set(g.name, { name: g.name, label: g.label || g.name, count: Number(g.count) || 0 });
  }
  // 老数据 / 手写数据没有 genres 时现算
  if (!genreMap.size) {
    for (const s of db.songs) {
      if (!s.genre) continue;
      const cur = genreMap.get(s.genre) || { name: s.genre, label: s.genre, count: 0 };
      cur.count++;
      genreMap.set(s.genre, cur);
    }
  }
  db.genres = [...genreMap.values()].sort((a, b) => collator.compare(a.label, b.label) || a.name.localeCompare(b.name));
  db.generatedAt = raw?.generatedAt || '';
  db.updatedAt = raw?.updatedAt || '';
  db.source = raw?.source || '';
  db.sourceSheet = raw?.sourceSheet || '';
  db.counts = {
    songs: db.songs.length,
    cn: db.songs.filter((s) => s.cn).length,
    covers: db.songs.filter((s) => s.cover).length,
    we: db.songs.filter((s) => s.we).length,
    jpLevels: db.songs.filter((s) => Object.keys(s.levels.jp || {}).length).length,
    cnLevels: db.songs.filter((s) => Object.keys(s.levels.cn || {}).length).length,
  };
  db.file = filePath();
  db.loaded = true;
}

function cleanDate(v) {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // 游戏 Music.xml 的 releaseDate 常见格式是 YYYYMMDD
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return '';
}

function normalizeLevels(input, legacy) {
  const jp = normalizeDiffs(input?.jp);
  const cn = normalizeDiffs(input?.cn);
  return {
    jp: Object.keys(jp).length ? jp : { ...(legacy || {}) },
    cn,
  };
}

/** 当前来源的定数；缺失时回退到另一侧，避免切到国服后整库不可用 */
function pickLevels(levels, source, legacy = {}) {
  const primary = levels?.[source] || {};
  if (Object.keys(primary).length) return { ...primary };
  const other = source === 'cn' ? levels?.jp : levels?.cn;
  if (other && Object.keys(other).length) return { ...other };
  return { ...(legacy || {}) };
}

function normalizeCnSync(v) {
  if (!v || typeof v !== 'object') return null;
  return {
    lastSyncAt: Number(v.lastSyncAt) || 0,
    apiVersion: Number(v.apiVersion) || null,
    source: String(v.source || 'lxns'),
    songs: Number(v.songs) || 0,
    updatedAt: Number(v.updatedAt) || 0,
  };
}

function normalizeGame(v) {
  if (!v || typeof v !== 'object') return null;
  const source = String(v.source || '').slice(0, 60);
  const musicDir = String(v.musicDir || '').slice(0, 300);
  if (!source && !musicDir) return null;
  return {
    source,
    musicDir,
    jacket: String(v.jacket || '').slice(0, 200),
    cueFile: String(v.cueFile || '').slice(0, 120),
    releaseDate: cleanDate(v.releaseDate),
    versionTitle: String(v.versionTitle || '').slice(0, 80),
    exType: Number.isFinite(Number(v.exType)) ? Number(v.exType) : null,
    disabled: v.disabled === true,
  };
}

/**
 * WORLD'S END 特殊谱面：汉字 + 星数（1–10）。
 *
 * 日服 / 国服的星级与汉字可能不同（国服可能晚开或不同版本），因此分别保存
 * jpStar / cnStar / jpKanji / cnKanji；`kanji` / `star` 是当前来源的展示值。
 */
function normalizeWe(v, source = 'jp') {
  if (!v || typeof v !== 'object') return null;
  const jpKanji = String(v.jpKanji ?? v.kanji ?? '').trim().slice(0, 8);
  const cnKanji = String(v.cnKanji ?? '').trim().slice(0, 8);
  const jpStar = Math.round(Number(v.jpStar ?? v.star));
  const cnStarRaw = Math.round(Number(v.cnStar));
  const cnStar = Number.isFinite(cnStarRaw) && cnStarRaw >= 1 && cnStarRaw <= 10 ? cnStarRaw : null;
  if (!jpKanji || !Number.isFinite(jpStar) || jpStar < 1 || jpStar > 10) return null;

  const useCn = source === 'cn';
  const kanji = (useCn && cnKanji) || jpKanji;
  const star = (useCn && cnStar) || jpStar;
  return {
    kanji,
    star,
    jpKanji,
    cnKanji,
    jpStar,
    cnStar,
    cn: v.cn === true,
    cnReleaseDate: cleanDate(v.cnReleaseDate),
    noteDesigner: String(v.noteDesigner || '').slice(0, 120),
    originId: Number.isFinite(Number(v.originId)) ? Number(v.originId) : null,
    chartId: Number.isFinite(Number(v.chartId)) ? Number(v.chartId) : null,
  };
}

/** 封面地址只允许站内 /covers、/media、/assets 或 http(s)，防止 javascript: 等协议 */
function safeCover(v) {
  const s = String(v ?? '').trim().slice(0, 500);
  if (!s) return '';
  if (/^\/(covers|media|assets)\//.test(s)) return s;
  if (/^https?:\/\//i.test(s)) return s;
  return '';
}

function normalizeDiffs(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const key of DIFFICULTY_ORDER) {
    const v = Number(input[key]);
    if (Number.isFinite(v) && v > 0) out[key] = Math.round(v * 100) / 100;
  }
  return out;
}

function norm(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 读曲目库；文件不存在时从根目录 xlsx 自动生成一次 */
export async function load() {
  const file = filePath();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    applyData(raw);
    log.info('music', '曲目库已加载', { songs: db.counts.songs, cn: db.counts.cn, file });
    return meta();
  } catch {
    // 兼容旧版本：没有 data/music.json 时自动生成，避免「比赛页打不开」
    const xlsx = path.join(ROOT, 'data', 'source', 'ChunithmMusicData.xlsx');
    if (fs.existsSync(xlsx)) {
      try {
        const { importMusic } = await import('../tools/import-music.mjs');
        const { data } = await importMusic({ xlsx, out: file });
        applyData(data);
        log.info('music', '曲目库未找到，已从 xlsx 自动生成', { songs: db.counts.songs, file });
        return meta();
      } catch (e) {
        log.warn('music', '曲目库自动生成失败', { err: e.message });
      }
    }
    db.loaded = true;
    db.songs = [];
    db.byId.clear();
    db.counts = { songs: 0, cn: 0 };
    log.warn('music', '曲目库为空：请运行 npm run music:import', { file });
    return meta();
  }
}

export function isLoaded() { return db.loaded; }

export function meta() {
  return {
    loaded: db.loaded,
    generatedAt: db.generatedAt,
    updatedAt: db.updatedAt,
    source: db.source,
    sourceSheet: db.sourceSheet,
    levelSource: db.levelSource,
    levelSources: LEVEL_SOURCES.map((k) => ({ key: k, label: LEVEL_SOURCE_LABELS[k] })),
    cnSync: db.cnSync ? { ...db.cnSync } : null,
    counts: { ...db.counts },
    difficulties: Object.fromEntries(DIFFICULTY_ORDER.map((k) => [k, { ...db.difficulties[k] }])),
    difficultyOrder: [...DIFFICULTY_ORDER],
    we: { key: WE_KEY, name: WE_NAME, color: WE_COLOR, special: true },
    genres: db.genres.map((g) => ({ ...g })),
  };
}

/** 对外曲目结构（不带内部搜索字段） */
export function view(song) {
  if (!song) return null;
  return {
    id: song.id,
    name: song.name,
    artist: song.artist,
    genre: song.genre,
    genreLabel: db.genres.find((g) => g.name === song.genre)?.label || song.genre,
    cn: song.cn,
    cnReleaseDate: song.cnReleaseDate || '',
    cnVersion: song.cnVersion ?? null,
    cover: song.cover || '',
    levels: {
      jp: { ...(song.levels?.jp || {}) },
      cn: { ...(song.levels?.cn || {}) },
    },
    levelSource: db.levelSource,
    difficulties: { ...song.difficulties },
    we: song.we ? { ...song.we } : null,
    weText: song.we ? `${song.we.kanji}★${song.we.star}` : '',
    game: song.game ? { ...song.game } : null,
    levelText: DIFFICULTY_ORDER
      .filter((k) => song.difficulties[k])
      .map((k) => `${DIFFICULTY_NAMES[k]} ${fmtLevel(song.difficulties[k])}`)
      .join(' / '),
  };
}

export function fmtLevel(v) {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

export function get(id) {
  return db.byId.get(Number(id)) || null;
}

export function getView(id) {
  return view(get(id));
}

function matchQuery(song, q) {
  if (!q) return true;
  return song._name.includes(q) || song._artist.includes(q) || String(song.id) === q;
}

/**
 * 等级过滤参数。
 * ⚠️ 不能写 Number.isFinite(Number(v)) —— Number(null) 是 0，
 * 会把「没填等级范围」误判成 0–0，进而把所有带难度的搜索/随机都过滤空。
 */
function optLevel(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 搜索 / 过滤。
 * @param {object} opts
 * @param {string} [opts.q]
 * @param {string} [opts.genre]
 * @param {string} [opts.difficulty] basic..ultima / we
 * @param {number} [opts.minLevel]
 * @param {number} [opts.maxLevel]
 * @param {boolean} [opts.includeWe] 是否包含 WORLD'S END 特殊谱面
 * @param {boolean} [opts.cnOnly]
 * @param {number[]} [opts.excludeIds]
 * @param {number} [opts.limit]
 * @param {number} [opts.offset]
 */
export function search(opts = {}) {
  const q = norm(opts.q);
  const genre = String(opts.genre || '').trim();
  const includeWe = !!opts.includeWe;
  const diff = DIFFICULTY_ORDER.includes(opts.difficulty)
    ? opts.difficulty
    : (opts.difficulty === WE_KEY ? WE_KEY : '');
  const min = optLevel(opts.minLevel);
  const max = optLevel(opts.maxLevel);
  const cnOnly = !!opts.cnOnly;
  const exclude = new Set((opts.excludeIds || []).map(Number));
  const limit = Math.min(200, Math.max(1, Number(opts.limit) || 60));
  const offset = Math.max(0, Number(opts.offset) || 0);

  const all = filterSongs({ q, genre, diff, min, max, cnOnly, exclude, includeWe });
  return {
    total: all.length,
    limit,
    offset,
    items: all.slice(offset, offset + limit).map(view),
  };
}

function filterSongs({ q, genre, diff, min, max, cnOnly, exclude, includeWe = false }) {
  return db.songs.filter((s) => {
    if (exclude?.has(s.id)) return false;
    if (cnOnly && !s.cn) return false;
    if (genre && s.genre !== genre) return false;
    if (!matchQuery(s, q)) return false;
    if (diff === WE_KEY) {
      if (!includeWe || !s.we) return false;
      if (min !== null && s.we.star < min) return false;
      if (max !== null && s.we.star > max) return false;
      return true;
    }
    if (!diff && !includeWe && !DIFFICULTY_ORDER.some((k) => s.difficulties[k])) return false;
    if (diff) {
      const lv = s.difficulties[diff];
      if (!lv) return false;
      if (min !== null && lv < min) return false;
      if (max !== null && lv > max) return false;
    }
    return true;
  });
}

/**
 * 随机选曲。
 * @returns {{song:object, difficulty:string, level:number}|null}
 */
export function random(opts = {}) {
  const exclude = new Set((opts.excludeIds || []).map(Number));
  const banned = (opts.bannedIds || []).map(Number);
  for (const id of banned) exclude.add(id);

  const q = norm(opts.q);
  const genre = String(opts.genre || '').trim();
  const includeWe = !!opts.includeWe;
  const requestedWe = opts.difficulty === WE_KEY;
  if (requestedWe && !includeWe) return null;
  const requested = DIFFICULTY_ORDER.includes(opts.difficulty)
    ? opts.difficulty
    : (requestedWe ? WE_KEY : '');
  const min = optLevel(opts.minLevel);
  const max = optLevel(opts.maxLevel);
  // 「全部难度 + 等级范围」时，范围要落在任意可用谱面上；
  // 否则 filterSongs 在没有指定难度时会忽略 min/max，随机到范围外的曲目。
  const randomDiff = opts.difficulty === 'random'
    || (!requested && !requestedWe && (min !== null || max !== null));
  const cnOnly = !!opts.cnOnly;

  let pool = filterSongs({
    q, genre, diff: requested, min, max, cnOnly, exclude, includeWe,
  });
  // 「随机难度」时难度本身是变量，等级范围要落在任意一个可用谱面上
  if (randomDiff && (min !== null || max !== null)) {
    pool = pool.filter((s) => DIFFICULTY_ORDER.some((k) => {
      const lv = s.difficulties[k];
      return lv && (min === null || lv >= min) && (max === null || lv <= max);
    }) || (includeWe && s.we && (min === null || s.we.star >= min) && (max === null || s.we.star <= max)));
  }
  // 过滤条件没有可用曲目时明确返回 null；不要偷偷放宽条件
  // （例如勾了「仅国服」却随机到日服限定曲，现场会直接打不了）
  if (!pool.length) return null;

  const song = pool[randomInt(pool.length)];
  const available = DIFFICULTY_ORDER.filter((k) => song.difficulties[k]);
  let difficulty = requested;
  if (randomDiff) {
    const inRange = available.filter((k) => {
      const lv = song.difficulties[k];
      return (min === null || lv >= min) && (max === null || lv <= max);
    });
    if (includeWe && song.we && (min === null || song.we.star >= min) && (max === null || song.we.star <= max)) {
      inRange.push(WE_KEY);
    }
    const chooseFrom = inRange.length ? inRange : available;
    difficulty = chooseFrom[randomInt(chooseFrom.length)];
  }
  if (!difficulty) {
    const configured = getConfig().match?.defaultDifficulty;
    if (DIFFICULTY_ORDER.includes(configured) && song.difficulties[configured]) difficulty = configured;
  }
  if (!difficulty) {
    if (includeWe && song.we && !available.length) difficulty = WE_KEY;
    else difficulty = song.difficulties.master ? 'master' : available[available.length - 1];
  }
  if (difficulty === WE_KEY) {
    if (!song.we) return null;
    return {
      song: view(song),
      difficulty: WE_KEY,
      level: song.we.star,
      levelText: `${song.we.kanji}★${song.we.star}`,
    };
  }
  if (!difficulty || !song.difficulties[difficulty]) return null;
  return {
    song: view(song),
    difficulty,
    level: song.difficulties[difficulty],
    levelText: fmtLevel(song.difficulties[difficulty]),
  };
}

/** 用 id + 难度补齐展示字段（写入比赛曲目行时用） */
export function describe(id, difficulty) {
  const song = get(id);
  if (!song) return null;
  const v = view(song);

  if (difficulty === WE_KEY) {
    if (!song.we) return null;
    return {
      musicId: song.id,
      title: song.name,
      artist: song.artist,
      genre: song.genre,
      genreLabel: v.genreLabel,
      cn: song.cn,
      cover: song.cover || '',
      difficulty: WE_KEY,
      difficultyName: WE_NAME,
      difficultyColor: WE_COLOR,
      level: song.we.star,
      levelText: `${song.we.kanji}★${song.we.star}`,
      we: { ...song.we },
    };
  }

  const key = DIFFICULTY_ORDER.includes(difficulty)
    ? difficulty
    : (song.difficulties.master ? 'master' : DIFFICULTY_ORDER.filter((k) => song.difficulties[k]).pop());
  if (!key || !song.difficulties[key]) return null;
  return {
    musicId: song.id,
    title: song.name,
    artist: song.artist,
    genre: song.genre,
    genreLabel: v.genreLabel,
    cn: song.cn,
    cover: song.cover || '',
    difficulty: key,
    difficultyName: DIFFICULTY_NAMES[key],
    difficultyColor: db.difficulties[key]?.color || FALLBACK_COLORS[key],
    level: song.difficulties[key],
    levelText: fmtLevel(song.difficulties[key]),
  };
}

export function difficultyMeta(key) {
  if (key === WE_KEY) return { key: WE_KEY, name: WE_NAME, color: WE_COLOR, special: true };
  return db.difficulties[key] ? { ...db.difficulties[key] } : null;
}

/** 全部常规难度的官方色映射（供渲染端给「难度列表」上色）。 */
export function difficultyColors() {
  const out = {};
  for (const key of DIFFICULTY_ORDER) {
    out[key] = db.difficulties[key]?.color || FALLBACK_COLORS[key];
  }
  return out;
}

export function difficultiesOf(id) {
  const s = get(id);
  if (!s) return null;
  const out = DIFFICULTY_ORDER
    .filter((k) => s.difficulties[k])
    .map((k) => ({ key: k, name: DIFFICULTY_NAMES[k], level: s.difficulties[k], levelText: fmtLevel(s.difficulties[k]), color: db.difficulties[k]?.color }));
  if (s.we) {
    out.push({
      key: WE_KEY,
      name: WE_NAME,
      level: s.we.star,
      levelText: `${s.we.kanji}★${s.we.star}`,
      color: WE_COLOR,
      special: true,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 管理端写入（/music 页面）
// ─────────────────────────────────────────────────────────────

function nack(code, msg) {
  return { ok: false, nack: { code, msg } };
}

function cleanText(v, max) {
  return String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function plainSong(s) {
  return {
    id: s.id,
    name: s.name,
    artist: s.artist,
    genre: s.genre,
    cn: s.cn !== false,
    cnReleaseDate: s.cnReleaseDate || '',
    cnVersion: s.cnVersion ?? null,
    cover: s.cover || '',
    levels: {
      jp: { ...(s.levels?.jp || {}) },
      cn: { ...(s.levels?.cn || {}) },
    },
    // 兼容仍在读 difficulties 的旧页面 / 脚本：写入当前来源的生效值
    difficulties: { ...s.difficulties },
    we: s.we ? { ...s.we } : null,
    game: s.game ? { ...s.game } : null,
  };
}

/** 按当前曲目重算分类计数，同时保留已知分类的中文标签 */
function rebuildGenres(songs) {
  const labelOf = new Map(db.genres.map((g) => [g.name, g.label]));
  const map = new Map();
  for (const s of songs) {
    if (!s.genre) continue;
    const cur = map.get(s.genre) || { name: s.genre, label: labelOf.get(s.genre) || s.genre, count: 0 };
    cur.count += 1;
    map.set(s.genre, cur);
  }
  return [...map.values()].sort((a, b) => collator.compare(a.label, b.label) || a.name.localeCompare(b.name));
}

function buildRaw(songs) {
  const list = songs.map(plainSong);
  return {
    generatedAt: db.generatedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: db.source || 'manual',
    sourceSheet: db.sourceSheet || '',
    levelSource: db.levelSource,
    cnSync: db.cnSync ? { ...db.cnSync } : null,
    counts: {
      songs: list.length,
      cn: list.filter((s) => s.cn).length,
      covers: list.filter((s) => s.cover).length,
      we: list.filter((s) => s.we).length,
      jpLevels: list.filter((s) => Object.keys(s.levels?.jp || {}).length).length,
      cnLevels: list.filter((s) => Object.keys(s.levels?.cn || {}).length).length,
    },
    difficulties: Object.fromEntries(DIFFICULTY_ORDER.map((k) => [
      k,
      db.difficulties[k]
        ? { ...db.difficulties[k] }
        : { key: k, name: DIFFICULTY_NAMES[k], color: FALLBACK_COLORS[k] },
    ])),
    difficultyOrder: [...DIFFICULTY_ORDER],
    genres: rebuildGenres(list),
    songs: list,
  };
}

function persist(raw) {
  const file = filePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(raw)}\n`, 'utf8');
  applyData(raw);
}

// ─────────────────────────────────────────────────────────────
// 定数来源 / 外部导入（游戏曲库 + 国服 API）
// ─────────────────────────────────────────────────────────────

export function getLevelSource() { return db.levelSource; }

/** 切换日服 / 国服定数。只改生效值，不丢另一套数据。 */
export function setLevelSource(source, actor = 'operator') {
  if (!LEVEL_SOURCES.includes(source)) {
    return nack('bad_source', '定数来源必须是 jp 或 cn');
  }
  if (db.levelSource === source) return { ok: true, source, meta: meta() };
  db.levelSource = source;
  const songs = db.songs.map(plainSong);
  persist(buildRaw(songs));
  log.audit('music', 'level-source', { source, actor });
  return { ok: true, source, meta: meta() };
}

/** 所有曲目的原始记录（含 levels.jp / levels.cn / 国服元数据），供导入模块合并 */
export function getRawSongs() {
  return db.songs.map(plainSong);
}

/**
 * 用外部模块计算出的曲目列表整体写回。
 * 传入的每首歌应带 levels（jp/cn）；difficulties 会按当前来源重新计算。
 */
export function replaceSongs(songs, { actor = 'operator', reason = 'external', cnSync } = {}) {
  if (!Array.isArray(songs)) return nack('bad_songs', '曲目列表格式不正确');
  if (cnSync !== undefined) db.cnSync = normalizeCnSync(cnSync);
  persist(buildRaw(songs));
  log.audit('music', reason, { songs: songs.length, levelSource: db.levelSource, actor });
  return { ok: true, meta: meta() };
}

/** 只更新国服同步元信息（没有曲目差异时使用） */
export function setCnSync(patch, { actor = 'operator' } = {}) {
  db.cnSync = normalizeCnSync({ ...(db.cnSync || {}), ...(patch || {}) });
  const songs = db.songs.map(plainSong);
  persist(buildRaw(songs));
  log.audit('music', 'cn-sync-meta', { ...db.cnSync, actor });
  return { ok: true, meta: meta() };
}

/**
 * 手动新增曲目。
 * 不传 id 时自动取最大 id + 1；传了重复 id 会拒绝。
 */
export function addSong(input = {}, actor = 'operator') {
  if (!db.loaded) return nack('not_loaded', '曲目库尚未加载');
  const name = cleanText(input.name, 120);
  if (!name) return nack('empty_name', '曲名不能为空');

  let id;
  const rawId = input.id;
  if (rawId !== undefined && rawId !== null && String(rawId).trim() !== '') {
    id = Math.round(Number(rawId));
    if (!Number.isInteger(id) || id <= 0) return nack('bad_id', '曲目 ID 必须是正整数');
    if (db.byId.has(id)) return nack('duplicate_id', `曲目 ID ${id} 已存在`);
  } else {
    id = db.songs.reduce((max, s) => Math.max(max, s.id), 0) + 1;
  }

  const difficulties = normalizeDiffs(input.difficulties);
  if (!Object.keys(difficulties).length) return nack('no_difficulty', '至少填写一个难度定数');

  const source = LEVEL_SOURCES.includes(input.levelSource) ? input.levelSource : db.levelSource;
  const levels = { jp: {}, cn: {} };
  levels[source] = difficulties;
  const songs = db.songs.map(plainSong);
  songs.push({
    id,
    name,
    artist: cleanText(input.artist, 120),
    genre: cleanText(input.genre, 40),
    cn: input.cn !== false,
    cnReleaseDate: cleanDate(input.cnReleaseDate),
    cnVersion: input.cnVersion === null || input.cnVersion === undefined || input.cnVersion === ''
      ? null
      : (Number.isFinite(Number(input.cnVersion)) ? Number(input.cnVersion) : null),
    cover: safeCover(input.cover),
    levels,
    difficulties,
    we: normalizeWe(input.we, source),
    game: null,
  });
  persist(buildRaw(songs));
  log.audit('music', 'song-add', { id, name, actor });
  return { ok: true, song: getView(id), meta: meta() };
}

/** 编辑曲目；id 不可改。 */
export function updateSong(id, patch = {}, actor = 'operator') {
  const numericId = Math.round(Number(id));
  const cur = db.byId.get(numericId);
  if (!cur) return nack('not_found', '曲目不存在');

  const name = patch.name !== undefined ? cleanText(patch.name, 120) : cur.name;
  if (!name) return nack('empty_name', '曲名不能为空');

  const source = LEVEL_SOURCES.includes(patch.levelSource) ? patch.levelSource : db.levelSource;
  const levels = {
    jp: { ...(cur.levels?.jp || {}) },
    cn: { ...(cur.levels?.cn || {}) },
  };
  if (patch.difficulties !== undefined) levels[source] = normalizeDiffs(patch.difficulties);
  const difficulties = pickLevels(levels, db.levelSource, cur.difficulties);
  if (!Object.keys(difficulties).length) return nack('no_difficulty', '至少填写一个难度定数');

  const songs = db.songs.map(plainSong);
  const idx = songs.findIndex((s) => s.id === numericId);
  songs[idx] = {
    id: numericId,
    name,
    artist: patch.artist !== undefined ? cleanText(patch.artist, 120) : cur.artist,
    genre: patch.genre !== undefined ? cleanText(patch.genre, 40) : cur.genre,
    cn: patch.cn !== undefined ? !!patch.cn : cur.cn,
    cnReleaseDate: patch.cnReleaseDate !== undefined ? cleanDate(patch.cnReleaseDate) : cur.cnReleaseDate,
    cnVersion: patch.cnVersion !== undefined
      ? (patch.cnVersion === null || patch.cnVersion === ''
        ? null
        : (Number.isFinite(Number(patch.cnVersion)) ? Number(patch.cnVersion) : null))
      : cur.cnVersion,
    cover: patch.cover !== undefined ? safeCover(patch.cover) : (cur.cover || ''),
    levels,
    difficulties,
    we: patch.we !== undefined ? normalizeWe(patch.we, source) : (cur.we || null),
    game: cur.game || null,
  };
  persist(buildRaw(songs));
  log.audit('music', 'song-update', { id: numericId, name, actor });
  return { ok: true, song: getView(numericId), meta: meta() };
}

/** 删除曲目（只删曲目库，不改 xlsx 源文件）。 */
export function removeSong(id, actor = 'operator') {
  const numericId = Math.round(Number(id));
  if (!db.byId.has(numericId)) return nack('not_found', '曲目不存在');
  const songs = db.songs.filter((s) => s.id !== numericId).map(plainSong);
  persist(buildRaw(songs));
  log.audit('music', 'song-remove', { id: numericId, actor });
  return { ok: true, meta: meta() };
}

/**
 * 上传 xlsx 全量替换曲目库。
 * 解析失败不会动现有数据；成功前会把旧 data/music.json 备份为 .bak。
 */
export async function importBuffer(buffer, { actor = 'operator' } = {}) {
  if (!buffer || !buffer.length) return nack('empty_file', '文件是空的');
  let data;
  try {
    const { parseWorkbook } = await import('../tools/import-music.mjs');
    data = parseWorkbook(buffer);
  } catch (e) {
    return nack('bad_xlsx', `解析失败：${e.message}`);
  }
  if (!data?.songs?.length) return nack('empty_sheet', '没有解析到任何曲目');

  const file = filePath();
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  } catch (e) {
    log.warn('music', '旧曲目库备份失败', { err: e.message });
  }
  // 重新导入 xlsx 时保留已有封面 / 国服定数 / 国服标记 / 游戏元数据（按曲目 ID 合并）
  const old = new Map(db.songs.map((s) => [s.id, s]));
  const songs = data.songs.map((s) => {
    const prev = old.get(s.id);
    const jp = normalizeDiffs(s.difficulties);
    return {
      ...s,
      cn: prev ? prev.cn : s.cn !== false,
      cnReleaseDate: prev?.cnReleaseDate || '',
      cnVersion: prev?.cnVersion ?? null,
      cover: s.cover || prev?.cover || '',
      levels: { jp, cn: { ...(prev?.levels?.cn || {}) } },
      difficulties: jp,
      we: s.we || prev?.we || null,
      game: prev?.game || null,
    };
  });
  const counts = {
    songs: songs.length,
    cn: songs.filter((s) => s.cn).length,
    covers: songs.filter((s) => s.cover).length,
    we: songs.filter((s) => s.we).length,
    jpLevels: songs.filter((s) => Object.keys(s.levels?.jp || {}).length).length,
    cnLevels: songs.filter((s) => Object.keys(s.levels?.cn || {}).length).length,
  };
  persist({
    ...data,
    songs,
    counts,
    levelSource: db.levelSource,
    cnSync: db.cnSync ? { ...db.cnSync } : null,
    updatedAt: new Date().toISOString(),
  });
  log.audit('music', 'import', { songs: counts.songs, cn: counts.cn, covers: counts.covers, actor });
  return {
    ok: true,
    counts,
    genres: data.genres.length,
    sourceSheet: data.sourceSheet,
    generatedAt: data.generatedAt,
    meta: meta(),
  };
}
