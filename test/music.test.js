/**
 * 曲目库 / xlsx 导入。
 *
 * 守住：
 *   · 原数据页的 大定数 + 小数位 要合成为 12.50 这样的数值；
 *   · 国服标记与官方难度色要从 国服数据 页读出来；
 *   · 搜索、等级过滤、随机选曲、ban 排除都要真的生效。
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as music from '../server/music.js';
import { parseWorkbook, importMusic } from '../tools/import-music.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP_MUSIC = path.join(os.tmpdir(), `lp-music-test-${process.pid}.json`);
process.env.LP_MUSIC_FILE = TMP_MUSIC;

const FIXTURE = {
  generatedAt: '2026-01-01T00:00:00.000Z',
  sourceSheet: '原数据',
  counts: { songs: 4, cn: 3 },
  difficulties: {
    basic: { key: 'basic', name: 'BASIC', color: '#00b050' },
    advanced: { key: 'advanced', name: 'ADVANCED', color: '#e46c0a' },
    expert: { key: 'expert', name: 'EXPERT', color: '#ff0000' },
    master: { key: 'master', name: 'MASTER', color: '#7030a0' },
    ultima: { key: 'ultima', name: 'ULTIMA', color: '#262626' },
  },
  difficultyOrder: ['basic', 'advanced', 'expert', 'master', 'ultima'],
  genres: [
    { name: 'ORIGINAL', label: '原创', count: 2 },
    { name: 'VARIETY', label: '综艺', count: 2 },
  ],
  songs: [
    { id: 1, name: 'Alpha', artist: 'Artist A', genre: 'ORIGINAL', cn: true, difficulties: { basic: 3, advanced: 6, master: 12.5 } },
    { id: 2, name: 'Beta', artist: 'Artist B', genre: 'VARIETY', cn: true, difficulties: { advanced: 5, master: 13.7 } },
    { id: 3, name: 'Gamma', artist: 'Artist C', genre: 'ORIGINAL', cn: false, difficulties: { expert: 9.5, master: 14 } },
    { id: 4, name: 'Delta', artist: 'Artist D', genre: 'VARIETY', cn: true, difficulties: { basic: 2, expert: 8 } },
  ],
};

before(async () => {
  fs.writeFileSync(TMP_MUSIC, JSON.stringify(FIXTURE), 'utf8');
  await music.load();
});

after(() => {
  try { fs.unlinkSync(TMP_MUSIC); } catch { /* ignore */ }
});

test('★ 搜索：按曲名 / 曲师 / ID 都能命中', () => {
  assert.equal(music.search({ q: 'alpha' }).total, 1);
  assert.equal(music.search({ q: 'artist b' }).items[0].id, 2);
  assert.equal(music.search({ q: '3' }).items[0].id, 3);
});

test('★ 分类 / 难度 / 等级范围 / 仅国服 过滤', () => {
  assert.equal(music.search({ genre: 'ORIGINAL' }).total, 2);
  assert.equal(music.search({ cnOnly: true }).total, 3);
  assert.equal(music.search({ difficulty: 'master' }).total, 3, '不填等级范围时不能变成 0–0');
  assert.equal(music.search({ difficulty: 'master', minLevel: 13, maxLevel: 14 }).total, 2);
  assert.equal(music.search({ difficulty: 'ultima' }).total, 0);
});

test('★ 随机选曲：排除 ban / 已使用，随机难度可用', () => {
  const pick = music.random({ excludeIds: [1, 2], bannedIds: [3] });
  assert.ok(pick);
  assert.equal(pick.song.id, 4, '只剩 Delta 可选');
  assert.ok(['basic', 'expert'].includes(pick.difficulty));

  const any = music.random({ difficulty: 'random', excludeIds: [] });
  assert.ok(any && any.song.difficulties[any.difficulty], '随机难度必须是该曲存在的谱面');

  const master = music.random({ difficulty: 'master', minLevel: null, maxLevel: null });
  assert.ok(master && master.difficulty === 'master', '指定难度 + 未填等级范围时仍应能选到');
});

test('★ describe：把 ID + 难度补齐成完整展示字段', () => {
  const d = music.describe(1, 'master');
  assert.equal(d.title, 'Alpha');
  assert.equal(d.difficultyName, 'MASTER');
  assert.equal(d.level, 12.5);
  assert.equal(d.difficultyColor, '#7030a0');
  assert.equal(d.cn, true);
  assert.equal(music.describe(1, 'ultima'), null, '不存在的谱面不能返回一条空记录');
});

test('★★ xlsx 导入：定数小数位、国服标记、官方难度色', () => {
  const buf = fs.readFileSync(path.join(ROOT, 'data', 'source', 'ChunithmMusicData.xlsx'));
  const data = parseWorkbook(buf);
  assert.ok(data.counts.songs > 1400, `曲目数 ${data.counts.songs}`);
  assert.ok(data.counts.cn > 1000, `国服曲目数 ${data.counts.cn}`);
  assert.equal(data.sourceSheet, '原数据');

  const song = data.songs.find((s) => s.id === 3);
  assert.equal(song.name, 'B.B.K.K.B.K.K.');
  assert.equal(song.difficulties.basic, 4);
  assert.equal(song.difficulties.master, 12.5);
  assert.equal(song.difficulties.ultima, 13.7);
  assert.equal(song.cn, true);

  const jpOnly = data.songs.find((s) => s.id === 2070);
  assert.ok(jpOnly, '应包含原数据里的日服限定曲');
  assert.equal(jpOnly.cn, false, '国服数据里没有的曲目标记为 false');

  assert.equal(data.difficulties.basic.color, '#00b050');
  assert.equal(data.difficulties.expert.color, '#ff0000');
  assert.equal(data.difficulties.master.color, '#7030a0');
  assert.ok(data.difficulties.advanced.color, 'ADVANCED 应有从主题色推导出的颜色');
  assert.ok(data.genres.some((g) => g.name === 'ORIGINAL'));

  // 文件生成路径也应该可用（写到临时目录，不碰仓库里的 data/music.json）
  const out = path.join(os.tmpdir(), `lp-music-import-${process.pid}.json`);
  try {
    const r = importMusic({ xlsx: path.join(ROOT, 'data', 'source', 'ChunithmMusicData.xlsx'), out });
    assert.equal(r.data.counts.songs, data.counts.songs);
    assert.ok(fs.existsSync(out));
  } finally {
    try { fs.unlinkSync(out); } catch { /* ignore */ }
  }
});
