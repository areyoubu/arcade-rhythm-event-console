/**
 * 国服曲目 / 定数同步（LXNS 公共 API）。
 *
 * 只做两件事：
 *   1. 拉取国服曲目列表与谱面定数；
 *   2. 和本地曲目库比较，生成「待确认补丁」。
 *
 * 不在拉取时直接改库：有差异时通过 WS 广播 music.cnSync，由 /music 页面
 * 弹窗让操作员确认后才写入。这样 API 临时异常 / 版本变更不会悄悄改掉现场曲库。
 */
import { getConfig } from './config.js';
import { set } from './state.js';
import * as music from './music.js';
import * as log from './logger.js';

const API_BASE_DEFAULT = 'https://maimai.lxns.net';
const API_PATH = '/api/v0/chunithm/song/list';
const DIFF_INDEX = ['basic', 'advanced', 'expert', 'master', 'ultima'];
const UA = 'arcade-rhythm-event-console/1.0 (+https://github.com/areyoubu/arcade-rhythm-event-console)';
const MIN_INTERVAL_H = 1;

let pending = null;       // { id, at, ...public, full: patch }
let pendingSeq = 0;
let syncing = null;
let autoTimer = null;
let autoKick = null;

function cfg() { return getConfig().cnMusic || {}; }

function apiBase() {
  const s = String(cfg().apiBase || API_BASE_DEFAULT).trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(s) ? s : API_BASE_DEFAULT;
}

function apiVersion() {
  const n = Math.round(Number(cfg().version));
  return Number.isInteger(n) && n > 0 ? n : 24000;
}

function timeoutMs() {
  const n = Math.round(Number(cfg().timeoutMs));
  return n >= 1000 && n <= 120000 ? n : 20_000;
}

function intervalHours() {
  return Math.max(MIN_INTERVAL_H, Math.round(Number(cfg().intervalHours) || 24));
}

/** 国服日期（UTC+8），用于判断 release_date 是否已配信 */
export function cnToday(now = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

function availableSong(song, today) {
  if (!song || song.disabled === true) return false;
  return isDate(song.release_date) && String(song.release_date) <= today;
}

function availableDifficulty(diff, song, today) {
  if (song?.disabled === true) return false;
  const rd = diff?.release_date || song?.release_date;
  if (!isDate(rd)) return availableSong(song, today);
  return String(rd) <= today;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(Math.min(20, n) * 100) / 100 : null;
}

function sameLevel(a, b) {
  const na = num(a);
  const nb = num(b);
  if (na === null && nb === null) return true;
  return na !== null && nb !== null && Math.abs(na - nb) < 0.001;
}

function levelsOf(song, today) {
  const out = {};
  for (const d of song?.difficulties || []) {
    if (![0, 1, 2, 3, 4].includes(Number(d.difficulty))) continue;
    if (!availableDifficulty(d, song, today)) continue;
    const key = DIFF_INDEX[Number(d.difficulty)];
    const v = num(d.level_value);
    // level_value 是定数；level 是展示等级（如 12+）
    if (key && v !== null) out[key] = v;
  }
  return out;
}

function pickWe(list, currentChartId, today) {
  if (!list?.length) return null;
  const withAvail = list.map((x) => ({
    ...x,
    available: x.available && isDate(x.releaseDate) && x.releaseDate <= today,
  }));
  const current = currentChartId ? withAvail.find((x) => x.chartId === Number(currentChartId)) : null;
  if (current) return current;
  return withAvail.find((x) => x.available) || withAvail[0];
}

function diffMap(before, after) {
  const out = {};
  for (const key of DIFF_INDEX) {
    if (!sameLevel(before?.[key], after?.[key])) {
      out[key] = { from: before?.[key] ?? null, to: after?.[key] ?? null };
    }
  }
  return out;
}

/**
 * 比较 API 数据和本地库，返回待确认补丁。
 * 纯函数：不写库、不发网络，方便测试。
 */
export function buildPatch(apiSongs, {
  today = cnToday(), version = apiVersion(), fetchedAt = Date.now(), localSongs = music.getRawSongs(),
} = {}) {
  const byId = new Map();
  for (const s of apiSongs || []) {
    const id = Number(s?.id);
    if (Number.isInteger(id) && id > 0) byId.set(id, s);
  }

  const weByOrigin = new Map();
  for (const s of apiSongs || []) {
    for (const d of s.difficulties || []) {
      if (Number(d.difficulty) !== 5) continue;
      const origin = Number(d.origin_id);
      if (!Number.isInteger(origin) || origin <= 0) continue;
      if (!weByOrigin.has(origin)) weByOrigin.set(origin, []);
      weByOrigin.get(origin).push({
        chartId: Number(s.id),
        kanji: String(d.kanji || '').slice(0, 8),
        star: Math.round(Number(d.star)) || null,
        releaseDate: isDate(d.release_date) ? d.release_date : (isDate(s.release_date) ? s.release_date : ''),
        available: availableDifficulty(d, s, today),
      });
    }
  }

  const entries = [];
  let cnAdded = 0;
  let cnRemoved = 0;
  let levelChanged = 0;
  let weChanged = 0;
  let apiOnly = 0;
  let matched = 0;
  const localIds = new Set();

  for (const song of localSongs) {
    const id = Number(song.id);
    localIds.add(id);
    const api = byId.get(id);
    if (!api) continue;
    matched++;

    // release_date 为 null 表示 API 无法确定国服配信日；此时保留本地已有判断，
    // 避免把一首实际可玩的国服曲误标成日服。
    const releaseKnown = isDate(api.release_date);
    const cn = releaseKnown ? availableSong(api, today) : (song.cn === true);
    const levelsCn = releaseKnown ? levelsOf(api, today) : { ...(song.levels?.cn || {}) };
    const releaseDate = releaseKnown ? api.release_date : (song.cnReleaseDate || '');
    const cnVersion = releaseKnown && Number.isFinite(Number(api.version)) ? Number(api.version) : (song.cnVersion ?? null);

    const levelDiff = diffMap(song.levels?.cn || {}, levelsCn);
    if (Object.keys(levelDiff).length) levelChanged++;

    let we = null;
    if (song.we && releaseKnown) {
      const candidate = pickWe(weByOrigin.get(id), song.we.chartId, today);
      const before = {
        cn: song.we.cn === true,
        cnStar: song.we.cnStar ?? null,
        cnKanji: song.we.cnKanji || '',
        cnReleaseDate: song.we.cnReleaseDate || '',
      };
      const after = candidate
        ? {
          cn: cn && candidate.available === true,
          cnStar: candidate.available ? candidate.star : (before.cnStar ?? null),
          cnKanji: candidate.available ? candidate.kanji : (before.cnKanji || ''),
          cnReleaseDate: candidate.releaseDate || '',
        }
        : { ...before, cn: false };
      if (before.cn !== after.cn
        || !sameLevel(before.cnStar, after.cnStar)
        || before.cnKanji !== after.cnKanji
        || before.cnReleaseDate !== after.cnReleaseDate) {
        we = { before, after };
        weChanged++;
      }
    }

    const cnChanged = cn !== (song.cn === true);
    const releaseChanged = releaseDate !== (song.cnReleaseDate || '');
    const versionChanged = cnVersion !== (song.cnVersion ?? null);
    if (!cnChanged && !releaseChanged && !versionChanged && !Object.keys(levelDiff).length && !we) continue;

    if (cnChanged) (cn ? cnAdded++ : cnRemoved++);
    entries.push({
      id,
      name: song.name,
      cn: { from: song.cn === true, to: cn },
      releaseDate: { from: song.cnReleaseDate || '', to: releaseDate },
      cnVersion: { from: song.cnVersion ?? null, to: cnVersion },
      levels: levelDiff,
      we,
      proposed: {
        cn,
        cnReleaseDate: releaseDate,
        cnVersion,
        levelsCn,
        we: we?.after || null,
      },
    });
  }

  // API 中存在、本地库没有的曲目（通常是没有安装对应游戏资源），只统计不新增
  for (const id of byId.keys()) if (!localIds.has(id)) apiOnly++;

  const summary = {
    songs: localSongs.length,
    apiSongs: byId.size,
    matched,
    apiOnly,
    entries: entries.length,
    cnAdded,
    cnRemoved,
    levelChanged,
    weChanged,
  };

  return {
    version,
    today,
    fetchedAt,
    summary,
    entries,
  };
}

/** 拉取公共 API 曲目列表（不写库） */
export async function fetchSongList() {
  const version = apiVersion();
  const url = new URL(API_PATH, `${apiBase()}/`);
  url.searchParams.set('version', String(version));
  url.searchParams.set('notes', 'false');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs());
  timer.unref?.();
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: {
        accept: 'application/json',
        'user-agent': UA,
        'cache-control': 'no-cache',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data?.songs)) throw new Error('响应缺少 songs 数组');
    return { songs: data.songs, genres: data.genres || [], versions: data.versions || [], version, url: url.toString() };
  } finally {
    clearTimeout(timer);
  }
}

function publicPending(p) {
  if (!p) return null;
  return {
    id: p.id,
    at: p.at,
    version: p.version,
    today: p.today,
    summary: { ...p.summary },
    entries: p.entries.slice(0, 300),
    truncated: p.entries.length > 300,
  };
}

function publish() {
  set('music.cnSync', publicPending(pending));
  return publicPending(pending);
}

function clearPending(actor = 'operator', reason = 'discard') {
  const had = !!pending;
  pending = null;
  publish();
  if (had) log.audit('music', 'cn-pending-clear', { reason, actor });
}

/**
 * 手动 / 自动同步。有差异时只生成待确认补丁，不写库。
 * @returns {Promise<{ok:boolean, changed:boolean, pending?:object, meta?:object, nack?:object}>}
 */
export async function syncNow({ actor = 'operator', source = 'manual' } = {}) {
  if (syncing) return { ok: false, nack: { code: 'busy', msg: '国服数据正在同步，请稍后' } };
  if (source === 'auto' && pending) {
    return { ok: true, changed: false, skipped: 'pending', pending: publicPending(pending) };
  }

  syncing = (async () => {
    const fetchedAt = Date.now();
    log.info('music', '开始拉取国服曲目 API', { source, version: apiVersion() });
    const data = await fetchSongList();
    const patch = buildPatch(data.songs, {
      today: cnToday(),
      version: data.version || apiVersion(),
      fetchedAt,
    });

    const syncMeta = {
      lastSyncAt: fetchedAt,
      apiVersion: data.version || apiVersion(),
      source: 'lxns',
      songs: data.songs.length,
      updatedAt: fetchedAt,
    };

    if (!patch.entries.length) {
      clearPending(actor, 'no-change');
      const out = music.setCnSync(syncMeta, { actor });
      log.audit('music', 'cn-sync-no-change', { actor, source, songs: data.songs.length });
      return { ok: true, changed: false, summary: patch.summary, meta: out.meta };
    }

    pendingSeq++;
    pending = {
      id: `cn-${fetchedAt.toString(36)}-${pendingSeq}`,
      at: fetchedAt,
      ...patch,
      full: patch,
      source,
      syncMeta,
    };
    publish();
    log.audit('music', 'cn-sync-pending', {
      actor, source, entries: patch.entries.length, added: patch.summary.cnAdded, removed: patch.summary.cnRemoved,
      levelChanged: patch.summary.levelChanged,
    });
    return { ok: true, changed: true, pending: publicPending(pending), summary: patch.summary };
  })();

  try {
    return await syncing;
  } catch (e) {
    log.warn('music', '国服曲目 API 同步失败', { err: e.message });
    return { ok: false, nack: { code: 'api_failed', msg: `国服数据同步失败：${e.message}` } };
  } finally {
    syncing = null;
  }
}

/** 确认应用待处理补丁 */
export function confirmPending(actor = 'operator') {
  if (!pending) return { ok: false, nack: { code: 'no_pending', msg: '没有待确认的国服更新' } };
  const p = pending;
  const songs = music.getRawSongs();
  const byId = new Map(songs.map((s) => [s.id, s]));
  for (const entry of p.full.entries) {
    const s = byId.get(entry.id);
    if (!s) continue;
    s.cn = entry.proposed.cn === true;
    s.cnReleaseDate = entry.proposed.cnReleaseDate || '';
    s.cnVersion = entry.proposed.cnVersion ?? null;
    s.levels = { ...(s.levels || {}), cn: { ...(entry.proposed.levelsCn || {}) } };
    if (s.we && entry.proposed.we) {
      s.we = {
        ...s.we,
        cn: entry.proposed.we.cn === true,
        cnStar: entry.proposed.we.cnStar ?? null,
        cnKanji: entry.proposed.we.cnKanji || '',
        cnReleaseDate: entry.proposed.we.cnReleaseDate || '',
      };
    }
  }
  const out = music.replaceSongs(songs, {
    actor,
    reason: 'cn-apply',
    cnSync: p.syncMeta,
  });
  pending = null;
  publish();
  log.audit('music', 'cn-apply', { actor, entries: p.full.entries.length, ...p.summary });
  return { ...out, applied: p.full.entries.length };
}

export function discardPending(actor = 'operator') {
  if (!pending) return { ok: false, nack: { code: 'no_pending', msg: '没有待确认的国服更新' } };
  const id = pending.id;
  clearPending(actor, 'discard');
  return { ok: true, discarded: id };
}

export function pendingView() {
  return publicPending(pending);
}

export function status({ includePending = false } = {}) {
  const m = music.meta();
  return {
    source: 'lxns',
    apiBase: apiBase(),
    version: apiVersion(),
    autoSync: cfg().autoSync === true,
    intervalHours: intervalHours(),
    lastSyncAt: m.cnSync?.lastSyncAt || 0,
    lastSyncSongs: m.cnSync?.songs || 0,
    ...(includePending ? { pending: publicPending(pending) } : {}),
  };
}

async function autoSync() {
  if (!cfg().autoSync) return;
  if (pending) return;
  if (!music.meta().counts?.songs) return;
  await syncNow({ actor: 'auto', source: 'auto' });
}

/** 配置变更 / 启动时重排自动同步 */
export function startAutoSync() {
  clearTimeout(autoTimer);
  clearInterval(autoTimer);
  autoTimer = null;
  clearTimeout(autoKick);
  autoKick = null;
  if (!cfg().autoSync) return;

  const interval = intervalHours() * 3600_000;
  const last = Number(music.meta().cnSync?.lastSyncAt) || 0;
  const wait = last ? Math.max(10_000, Math.min(30_000, last + interval - Date.now())) : 15_000;
  if (!last || Date.now() - last >= interval) {
    autoKick = setTimeout(() => { autoSync().catch(() => { /* 内部已记录 */ }); }, wait);
    autoKick.unref?.();
  }
  autoTimer = setInterval(() => { autoSync().catch(() => { /* 内部已记录 */ }); }, interval);
  autoTimer.unref?.();
}

/** 启动时把 pending 状态推给已打开的控制页（hello 里带） */
export function init() {
  publish();
  startAutoSync();
}

export function shutdown() {
  clearTimeout(autoTimer);
  clearInterval(autoTimer);
  clearTimeout(autoKick);
}
