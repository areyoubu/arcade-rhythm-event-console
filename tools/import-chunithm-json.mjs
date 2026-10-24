#!/usr/bin/env node
/**
 * 用本地 chunithm_songs.json 更新曲目库：
 *   · 国服标记：文件里存在的曲目 cn=true，其余 cn=false；
 *   · WORLD'S END 特殊谱面：difficulty=5 的条目挂到 origin_id 对应的曲目上；
 *   · 补齐文件里有、本地库里没有的普通曲目；
 *   · 保留本地封面（data/covers/<id>.*）和已校对的数据。
 *
 * 用法：
 *   node tools/import-chunithm-json.mjs
 *   node tools/import-chunithm-json.mjs --file=chunithm_songs.json
 *
 * 该工具只读本地文件，不访问任何网站。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const SONG_FILE = path.resolve(ROOT, argValue('file', 'chunithm_songs.json'));
const MUSIC_FILE = process.env.LP_MUSIC_FILE || path.join(ROOT, 'data', 'music.json');
const COVERS_DIR = path.join(ROOT, 'data', 'covers');

const DIFF_BY_INDEX = { 0: 'basic', 1: 'advanced', 2: 'expert', 3: 'master', 4: 'ultima' };
const DIFF_ORDER = ['basic', 'advanced', 'expert', 'master', 'ultima'];
const GENRE_MAP = {
  '其他游戏': 'VARIETY',
  niconico: 'niconico',
  '东方Project': '東方Project',
  原创: 'ORIGINAL',
  音击舞萌: 'ゲキマイ',
  彩绿: 'イロドリミドリ',
  '流行 & 动漫': 'POPS & ANIME',
};
const FALLBACK_COLORS = {
  basic: '#00b050', advanced: '#e46c0a', expert: '#ff0000', master: '#7030a0', ultima: '#262626',
};
const DIFF_NAMES = { basic: 'BASIC', advanced: 'ADVANCED', expert: 'EXPERT', master: 'MASTER', ultima: 'ULTIMA' };

const collator = new Intl.Collator('zh-Hans', { numeric: true, sensitivity: 'base' });

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function diffFromChart(chart) {
  const key = DIFF_BY_INDEX[Number(chart.difficulty)];
  if (!key) return null;
  const level = Number(chart.level_value);
  if (!Number.isFinite(level) || level <= 0) return null;
  return [key, Math.round(level * 100) / 100];
}

function weFromChart(chart) {
  const star = Math.round(Number(chart.star));
  const kanji = String(chart.kanji || '').trim();
  if (!kanji || !Number.isFinite(star) || star < 1) return null;
  return {
    kanji,
    star,
    noteDesigner: String(chart.note_designer || '').slice(0, 120),
    originId: Number.isFinite(Number(chart.origin_id)) ? Number(chart.origin_id) : null,
    chartId: null,
  };
}

function coverFor(id) {
  for (const ext of ['webp', 'jpg', 'jpeg', 'png']) {
    const file = path.join(COVERS_DIR, `${id}.${ext}`);
    if (fs.existsSync(file)) return `/covers/${id}.${ext}`;
  }
  return '';
}

function countGenres(songs, oldLabels) {
  const labels = new Map(oldLabels || []);
  const map = new Map();
  for (const s of songs) {
    if (!s.genre) continue;
    const cur = map.get(s.genre) || {
      name: s.genre,
      label: labels.get(s.genre) || s.genre,
      count: 0,
    };
    cur.count += 1;
    map.set(s.genre, cur);
  }
  return [...map.values()].sort((a, b) => collator.compare(a.label, b.label) || a.name.localeCompare(b.name));
}

function main() {
  if (!fs.existsSync(SONG_FILE)) throw new Error(`找不到 ${SONG_FILE}（把它放在项目根目录，或用 --file= 指定）`);
  if (!fs.existsSync(MUSIC_FILE)) throw new Error(`找不到 ${MUSIC_FILE}，请先启动一次服务或运行 npm run music:import`);

  const source = readJson(SONG_FILE);
  if (!Array.isArray(source)) throw new Error('chunithm_songs.json 应该是数组');
  const old = readJson(MUSIC_FILE);
  const oldById = new Map((old.songs || []).map((s) => [Number(s.id), s]));

  const byId = new Map();
  for (const s of old.songs || []) {
    if (!s || !Number.isFinite(Number(s.id))) continue;
    byId.set(Number(s.id), {
      ...s,
      id: Number(s.id),
      name: String(s.name || ''),
      artist: String(s.artist || ''),
      genre: String(s.genre || ''),
      cn: s.cn !== false,
      cover: String(s.cover || ''),
      difficulties: { ...(s.difficulties || {}) },
      we: s.we || null,
    });
  }

  // 先清空 WE，随后以本地国服数据为准重建
  for (const s of byId.values()) s.we = null;

  let added = 0;
  let weCount = 0;
  const cnIds = new Set();

  for (const s of source) {
    const id = Number(s.id);
    if (!Number.isFinite(id)) continue;
    const normalCharts = (s.difficulties || [])
      .map(diffFromChart)
      .filter(Boolean);
    const weChart = (s.difficulties || [])
      .map(weFromChart)
      .find(Boolean);

    if (weChart) {
      weChart.chartId = id;
      const originId = weChart.originId || id;
      cnIds.add(originId);
      let base = byId.get(originId);
      if (!base) {
        base = {
          id: originId,
          name: String(s.title || `#${originId}`),
          artist: String(s.artist || ''),
          genre: GENRE_MAP[s.genre] || String(s.genre || ''),
          cn: true,
          cover: coverFor(originId),
          difficulties: {},
          we: null,
        };
        byId.set(originId, base);
        added += 1;
      }
      base.we = weChart;
      weCount += 1;
      continue;
    }

    cnIds.add(id);
    let song = byId.get(id);
    if (!song) {
      song = {
        id,
        name: String(s.title || `#${id}`),
        artist: String(s.artist || ''),
        genre: GENRE_MAP[s.genre] || String(s.genre || ''),
        cn: true,
        cover: coverFor(id),
        difficulties: {},
        we: null,
      };
      byId.set(id, song);
      added += 1;
    }
    for (const [key, level] of normalCharts) {
      if (!song.difficulties[key]) song.difficulties[key] = level;
    }
  }

  const songs = [...byId.values()]
    .filter((s) => s.name && (Object.keys(s.difficulties).length || s.we))
    .map((s) => ({
      ...s,
      cn: cnIds.has(s.id),
      cover: coverFor(s.id) || s.cover || '',
      difficulties: Object.fromEntries(DIFF_ORDER
        .filter((k) => Number(s.difficulties[k]) > 0)
        .map((k) => [k, Math.round(Number(s.difficulties[k]) * 100) / 100])),
    }))
    .sort((a, b) => collator.compare(a.name, b.name) || a.id - b.id);

  const counts = {
    songs: songs.length,
    cn: songs.filter((s) => s.cn).length,
    covers: songs.filter((s) => s.cover).length,
    we: songs.filter((s) => s.we).length,
  };

  const oldLabels = (old.genres || []).map((g) => [g.name, g.label]);
  const difficulties = Object.fromEntries(DIFF_ORDER.map((k) => {
    const prev = old.difficulties?.[k];
    return [k, prev && /^#[0-9a-f]{6}$/i.test(prev.color || '')
      ? { key: k, name: prev.name || DIFF_NAMES[k], color: prev.color }
      : { key: k, name: DIFF_NAMES[k], color: FALLBACK_COLORS[k] }];
  }));

  const out = {
    generatedAt: old.generatedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: old.source || 'local',
    sourceSheet: old.sourceSheet || '',
    counts,
    difficulties,
    difficultyOrder: [...DIFF_ORDER],
    genres: countGenres(songs, oldLabels),
    songs,
  };

  try {
    fs.copyFileSync(MUSIC_FILE, `${MUSIC_FILE}.bak`);
  } catch { /* ignore */ }
  fs.writeFileSync(MUSIC_FILE, `${JSON.stringify(out)}\n`, 'utf8');

  console.log(`已更新 ${path.relative(ROOT, MUSIC_FILE)}`);
  console.log(`  曲目 ${counts.songs}（国服 ${counts.cn}）· 封面 ${counts.covers} · WE ${counts.we}`);
  console.log(`  新增曲目 ${added} 首（含 WE 基础曲）`);
  console.log(`  旧文件备份为 ${path.basename(MUSIC_FILE)}.bak`);
}

try {
  main();
} catch (e) {
  console.error(`更新失败：${e.message}`);
  process.exit(1);
}
