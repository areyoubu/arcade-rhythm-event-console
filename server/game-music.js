/**
 * 从本地游戏目录导入曲目信息 / 难度 / 曲绘。
 *
 * 目录结构与音频模块一致：
 *   <root>/data/A000/music/musicXXXX/Music.xml
 *   <root>/option/<资源>/music/musicXXXX/Music.xml
 *   <root>/bin/option/<资源>/music/musicXXXX/Music.xml
 *
 * 这里读取的是游戏内的日服定数；国服定数由 cn-music.js 从公共 API 拉取后
 * 写入 levels.cn。游戏目录只读，曲绘会转存到 <项目>/data/covers。
 *
 * 曲绘：游戏原图通常是 DDS（BC1/BC2/BC3）。优先用 sharp 转 WebP，
 * sharp 不可用时用内置 DDS 解码 + PNG 编码兜底。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { getConfig, ROOT } from './config.js';
import * as music from './music.js';
import * as log from './logger.js';
import { decodeDds } from './image/dds.js';
import { encodePng } from './image/png.js';

function coversDir() {
  return process.env.LP_COVERS_DIR
    ? path.resolve(process.env.LP_COVERS_DIR)
    : path.join(ROOT, 'data', 'covers');
}
const IMAGE_EXT = new Set(['.dds', '.png', '.jpg', '.jpeg', '.webp']);

let sharp = null;
let sharpTried = false;
async function getSharp() {
  if (sharpTried) return sharp;
  sharpTried = true;
  try {
    const mod = await import('sharp');
    sharp = mod.default || mod;
  } catch {
    sharp = null;
  }
  return sharp;
}

function gameRoot() {
  const c = getConfig();
  return String(c.gameAudio?.gameDir || c.music?.gameDir || '').trim();
}

function isDir(p) {
  return fs.stat(p).then((s) => s.isDirectory()).catch(() => false);
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function asArray(v) { return Array.isArray(v) ? v : (v == null ? [] : [v]); }
function text(v) {
  if (v == null) return '';
  if (typeof v === 'object') return String(v['#text'] ?? '');
  return String(v);
}
function str(v) { return String(v?.str ?? v ?? '').trim(); }
function num(v) {
  const n = Number(text(v?.id ?? v));
  return Number.isFinite(n) ? n : null;
}
function clipText(v, max) { return String(v || '').trim().slice(0, max); }
function levelValue(level, decimal) {
  const n = Number(level) + (Number(decimal) || 0) / 100;
  return Number.isFinite(n) && n > 0 ? Math.round(Math.min(20, n) * 100) / 100 : null;
}
function bool(v) {
  const s = String(v?.id ?? v ?? '').trim().toLowerCase();
  return s === 'true' || s === '1';
}

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => name === 'MusicFumenData' || name === 'StringID',
});

export function parseMusicXml(xml) {
  const root = asArray(xml?.MusicData)[0];
  if (!root) return null;
  const id = num(root.name?.id);
  const name = str(root.name?.str);
  if (!Number.isInteger(id) || id <= 0 || !name) return null;

  const genres = asArray(root.genreNames?.list?.StringID)
    .map((g) => str(g?.str))
    .filter(Boolean);
  const fumens = asArray(root.fumens?.MusicFumenData);
  const levels = {};
  let weFumen = null;
  let ultimaEnabled = false;
  const exType = num(root.exType);
  const isWe = exType === 2;

  for (const f of fumens) {
    if (!bool(f?.enable)) continue;
    const type = num(f.type?.id);
    const lv = levelValue(num(f.level), num(f.levelDecimal));
    if (!Number.isInteger(type)) continue;
    if (type >= 0 && type <= 3) {
      if (lv !== null) levels[['basic', 'advanced', 'expert', 'master'][type]] = lv;
      continue;
    }
    if (type === 4) {
      if (isWe) weFumen = f;
      else if (lv !== null) {
        levels.ultima = lv;
        ultimaEnabled = true;
      }
      continue;
    }
    if (type === 5) weFumen = f;
  }

  const weTag = str(root.worldsEndTagName?.str);
  const weKanji = weTag && weTag.toLowerCase() !== 'invalid' ? weTag.slice(0, 8) : '';
  const star = num(root.starDifType);
  const we = (isWe || weFumen) && weKanji
    ? {
      kanji: weKanji,
      star: star >= 1 && star <= 10 ? Math.round(star) : null,
      noteDesigner: str(weFumen?.notesDesigner),
    }
    : null;

  return {
    id,
    name: clipText(name, 120),
    artist: clipText(str(root.artistName?.str), 120),
    genre: clipText(genres[0] || str(root.genreName?.str), 40),
    jacket: clipText(str(root.jaketFile?.path), 200),
    cueFile: clipText(str(root.cueFileName?.str), 120),
    // WE 谱面的 cueFileName.id 指向原曲；普通谱面通常等于自身 ID
    cueFileId: num(root.cueFileName?.id),
    releaseDate: clipText(str(root.releaseDate), 10),
    versionTitle: clipText(str(root.releaseTagName?.str), 80),
    exType,
    disabled: bool(root.disableFlag),
    enableUltima: ultimaEnabled,
    levels,
    we,
  };
}

async function collectMusicDirs(gameDir) {
  const roots = [];
  const seenData = new Set();
  // 游戏更新可能落在 data/A001、A010 等目录；按名称倒序扫描，较新的 AXXX 优先。
  for (const rel of ['data', path.join('bin', 'data')]) {
    const parent = path.join(gameDir, rel);
    const dirs = await fs.readdir(parent, { withFileTypes: true }).catch(() => []);
    const assets = dirs
      .filter((d) => d.isDirectory() && /^A[0-9A-Za-z]{3}$/.test(d.name))
      .sort((a, b) => b.name.localeCompare(a.name));
    for (const d of assets) {
      const full = path.join(parent, d.name);
      const key = full.toLowerCase();
      if (seenData.has(key)) continue;
      seenData.add(key);
      if (await isDir(path.join(full, 'music'))) {
        roots.push({ dir: full, source: `${d.name}${rel.includes('bin') ? '(bin)' : ''}` });
      }
    }
  }
  // 兼容极端目录结构：只有 data/A000 且没有匹配 AXXX 命名时
  if (!roots.length) {
    const base = path.join(gameDir, 'data', 'A000');
    if (await isDir(path.join(base, 'music'))) roots.push({ dir: base, source: 'A000' });
  }

  const optionRoots = [
    path.join(gameDir, 'option'),
    path.join(gameDir, 'bin', 'option'),
  ];
  const seen = new Set();
  for (const oroot of optionRoots) {
    const dirs = await fs.readdir(oroot, { withFileTypes: true }).catch(() => []);
    for (const d of dirs.filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(oroot, d.name);
      const key = full.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (await isDir(path.join(full, 'music'))) {
        roots.push({ dir: full, source: `option:${d.name}` });
      }
    }
  }
  return roots;
}

function coverFileFromUrl(url) {
  const m = /^\/covers\/([A-Za-z0-9_.-]+)/.exec(String(url || ''));
  return m ? path.join(coversDir(), m[1]) : null;
}

async function convertCover(gameDir, musicDir, id, jacket, existing) {
  if (!jacket) return { cover: existing?.cover || '', changed: false, skipped: true };
  const raw = path.join(musicDir, jacket);
  const ext = path.extname(raw).toLowerCase();
  if (!IMAGE_EXT.has(ext)) return { cover: existing?.cover || '', changed: false, skipped: true };
  if (!isInside(musicDir, raw)) throw new Error('封面路径越界');

  let src;
  try { src = await fs.realpath(raw); } catch { return { cover: existing?.cover || '', changed: false, skipped: true }; }
  const realRoot = await fs.realpath(gameDir).catch(() => gameDir);
  if (!isInside(realRoot, src)) throw new Error('封面路径越界');

  const srcStat = await fs.stat(src);
  const oldCoverFile = existing?.cover ? coverFileFromUrl(existing.cover) : null;
  if (oldCoverFile && existing?.game?.jacket === jacket) {
    const oldStat = await fs.stat(oldCoverFile).catch(() => null);
    if (oldStat && oldStat.mtimeMs >= srcStat.mtimeMs) {
      return { cover: existing.cover, changed: false, skipped: true };
    }
  }

  await fs.mkdir(coversDir(), { recursive: true });
  const sharpMod = await getSharp();
  let target;
  let url;
  if (ext === '.dds') {
    const dds = decodeDds(await fs.readFile(src));
    if (sharpMod) {
      target = path.join(coversDir(), `${id}.webp`);
      await sharpMod(dds.rgba, { raw: { width: dds.width, height: dds.height, channels: 4 } })
        .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 88, effort: 4 })
        .toFile(target);
    } else {
      target = path.join(coversDir(), `${id}.png`);
      await fs.writeFile(target, encodePng(dds.rgba, dds.width, dds.height));
    }
  } else if (sharpMod) {
    target = path.join(coversDir(), `${id}.webp`);
    await sharpMod(src)
      .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 88, effort: 4 })
      .toFile(target);
  } else {
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
      return { cover: existing?.cover || '', changed: false, skipped: true };
    }
    target = path.join(coversDir(), `${id}${ext}`);
    await fs.copyFile(src, target);
  }

  const st = await fs.stat(target);
  url = `/covers/${path.basename(target)}?v=${Math.round(st.mtimeMs)}`;
  return { cover: url, changed: true, skipped: false };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * 扫描游戏目录并合并到曲目库。
 * 合并策略：游戏里有的曲目更新 id / 曲名 / 曲师 / 分类 / 日服定数 / 曲绘；
 * 国服标记与国服定数保留，等待 API 同步；游戏里不存在的旧曲目保留。
 */
export async function importGameMusic({ actor = 'operator' } = {}) {
  const gameDir = gameRoot();
  if (!gameDir) {
    return { ok: false, nack: { code: 'no_game_dir', msg: '请先在「设置 → 游戏音频」填写游戏安装根目录' } };
  }
  if (!(await isDir(gameDir))) {
    return { ok: false, nack: { code: 'bad_game_dir', msg: `游戏目录不存在：${gameDir}` } };
  }

  const roots = await collectMusicDirs(gameDir);
  if (!roots.length) {
    return { ok: false, nack: { code: 'no_music_dir', msg: '游戏目录中没有找到 data/A000/music 或 option/*/music' } };
  }

  const errors = [];
  const records = [];
  let xmlCount = 0;
  let duplicates = 0;
  const seenIds = new Set();

  for (const root of roots) {
    const musicRoot = path.join(root.dir, 'music');
    const dirs = await fs.readdir(musicRoot, { withFileTypes: true }).catch(() => []);
    for (const d of dirs.filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const xmlPath = path.join(musicRoot, d.name, 'Music.xml');
      let xml;
      try { xml = await fs.readFile(xmlPath, 'utf8'); } catch { continue; }
      xmlCount++;
      let rec;
      try {
        rec = parseMusicXml(parser.parse(xml));
      } catch (e) {
        errors.push(`${d.name}: ${e.message}`);
        continue;
      }
      if (!rec) continue;
      if (rec.disabled) continue;
      // 没有任何启用谱面、也不是 WE 的空壳条目直接跳过，避免把已有定数清空
      if (!Object.keys(rec.levels).length && !rec.we) continue;
      if (seenIds.has(rec.id)) { duplicates++; continue; }
      seenIds.add(rec.id);
      const relDir = path.relative(gameDir, path.join(musicRoot, d.name)).split(path.sep).join('/');
      records.push({
        ...rec,
        sourceRoot: root.dir,
        source: root.source,
        musicDir: relDir,
        absMusicDir: path.join(musicRoot, d.name),
      });
    }
  }

  const oldSongs = music.getRawSongs();
  const oldById = new Map(oldSongs.map((s) => [s.id, s]));
  const weByChart = new Map();
  for (const s of oldSongs) {
    if (s.we?.chartId) weByChart.set(Number(s.we.chartId), s.id);
  }

  let added = 0;
  let updated = 0;
  let covers = 0;
  let coverSkipped = 0;
  let coverFailed = 0;
  let weUpdated = 0;
  let weUnmapped = 0;
  let noCover = 0;

  const normal = records.filter((r) => !(r.exType === 2 || (!Object.keys(r.levels).length && r.we)));
  const normalSet = new Set(normal);
  const weRecords = records.filter((r) => !normalSet.has(r));

  for (const rec of normal) {
    const prev = oldById.get(rec.id);
    let cover = prev?.cover || '';
    try {
      const c = await convertCover(gameDir, rec.absMusicDir, rec.id, rec.jacket, prev);
      cover = c.cover || cover;
      if (c.changed) covers++;
      else if (c.skipped) coverSkipped++;
    } catch (e) {
      coverFailed++;
      errors.push(`封面 #${rec.id}：${e.message}`);
    }
    if (!cover) noCover++;

    const levelsCn = { ...(prev?.levels?.cn || {}) };
    const song = {
      ...(prev || {}),
      id: rec.id,
      name: rec.name || prev?.name || `#${rec.id}`,
      artist: rec.artist || prev?.artist || '',
      genre: rec.genre || prev?.genre || '',
      cn: prev ? prev.cn === true : false,
      cnReleaseDate: prev?.cnReleaseDate || '',
      cnVersion: prev?.cnVersion ?? null,
      cover,
      levels: { jp: { ...rec.levels }, cn: levelsCn },
      difficulties: rec.levels,
      we: prev?.we || null,
      game: {
        source: rec.source,
        musicDir: rec.musicDir,
        jacket: rec.jacket,
        cueFile: rec.cueFile,
        releaseDate: rec.releaseDate,
        versionTitle: rec.versionTitle,
        exType: rec.exType,
        disabled: rec.disabled,
      },
    };
    if (!prev) added++;
    else updated++;
    oldById.set(rec.id, song);
  }

  for (const rec of weRecords) {
    const baseId = weByChart.get(rec.id)
      || (Number.isInteger(rec.cueFileId) && rec.cueFileId > 0 ? rec.cueFileId : null);
    if (!baseId) { weUnmapped++; continue; }
    const base = oldById.get(baseId);
    if (!base) { weUnmapped++; continue; }
    const star = rec.we?.star ?? base.we?.jpStar ?? base.we?.star ?? null;
    const kanji = rec.we?.kanji || base.we?.jpKanji || base.we?.kanji || '';
    if (!kanji || !star) { weUnmapped++; continue; }
    // 同一原曲可能有多个 WE 谱面；数据库当前只保存一个。
    // 若已有 chartId 且不是本条，保留星级更高的那个，避免来回覆盖。
    const currentChart = Number(base.we?.chartId) || null;
    if (currentChart && currentChart !== rec.id
      && Number(base.we?.jpStar || 0) >= Number(star || 0)) {
      continue;
    }
    base.we = {
      ...base.we,
      kanji,
      star,
      jpKanji: kanji,
      jpStar: star,
      chartId: rec.id,
      originId: base.we?.originId ?? baseId,
      noteDesigner: rec.we?.noteDesigner || base.we?.noteDesigner || '',
      cn: base.we?.cn === true,
      cnStar: base.we?.cnStar ?? null,
      cnKanji: base.we?.cnKanji || '',
      cnReleaseDate: base.we?.cnReleaseDate || '',
    };
    weUpdated++;
  }

  const songs = [...oldById.values()];
  const out = music.replaceSongs(songs, { actor, reason: 'game-import' });
  if (!out.ok) return out;

  const summary = {
    xmlCount,
    songs: records.length,
    normal: normal.length,
    we: weRecords.length,
    added,
    updated,
    duplicates,
    weUpdated,
    weUnmapped,
    covers,
    coverSkipped,
    coverFailed,
    noCover,
    errors: errors.slice(0, 30),
  };
  log.audit('music', 'game-import', { ...summary, errors: undefined, actor });
  return { ok: true, summary, meta: out.meta };
}

export function status() {
  const c = getConfig();
  return {
    gameDir: String(c.gameAudio?.gameDir || c.music?.gameDir || ''),
    coversDir: coversDir(),
  };
}
