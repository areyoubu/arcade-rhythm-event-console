/**
 * 曲目库管理端：手动增改删 + xlsx 全量导入。
 *
 * 用临时 LP_MUSIC_FILE，不碰真实 data/music.json。
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as music from '../server/music.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(os.tmpdir(), `lp-music-admin-${process.pid}.json`);
process.env.LP_MUSIC_FILE = TMP;

const FIXTURE = {
  generatedAt: '2026-01-01T00:00:00.000Z',
  sourceSheet: '原数据',
  counts: { songs: 2, cn: 2 },
  difficulties: {
    basic: { key: 'basic', name: 'BASIC', color: '#00b050' },
    advanced: { key: 'advanced', name: 'ADVANCED', color: '#e46c0a' },
    expert: { key: 'expert', name: 'EXPERT', color: '#ff0000' },
    master: { key: 'master', name: 'MASTER', color: '#7030a0' },
    ultima: { key: 'ultima', name: 'ULTIMA', color: '#262626' },
  },
  difficultyOrder: ['basic', 'advanced', 'expert', 'master', 'ultima'],
  genres: [{ name: 'ORIGINAL', label: '原创', count: 2 }],
  songs: [
    { id: 1, name: 'Alpha', artist: 'A', genre: 'ORIGINAL', cn: true, difficulties: { master: 12.5 } },
    { id: 2, name: 'Beta', artist: 'B', genre: 'ORIGINAL', cn: true, difficulties: { expert: 9.5 } },
  ],
};

before(async () => {
  fs.writeFileSync(TMP, JSON.stringify(FIXTURE), 'utf8');
  await music.load();
});

after(() => {
  for (const f of [TMP, `${TMP}.bak`]) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

test('★ 手动新增：自动分配 ID、写盘、分类计数更新', () => {
  const r = music.addSong({
    name: 'Gamma', artist: 'C', genre: 'ORIGINAL', cn: false,
    difficulties: { advanced: 6, master: 13.7 },
  }, 'test');
  assert.equal(r.ok, true);
  assert.equal(r.song.id, 3);
  assert.equal(r.song.difficulties.master, 13.7);

  const saved = JSON.parse(fs.readFileSync(TMP, 'utf8'));
  assert.equal(saved.songs.length, 3);
  assert.equal(saved.counts.cn, 2);
  assert.equal(saved.genres[0].count, 3);
  assert.equal(music.getView(3).name, 'Gamma');
});

test('★ 编辑：改名 / 改难度，旧难度不会残留', () => {
  const r = music.updateSong(3, {
    name: 'Gamma 改', artist: 'C2', difficulties: { expert: 10.2 },
  }, 'test');
  assert.equal(r.ok, true);
  assert.equal(r.song.name, 'Gamma 改');
  assert.equal(r.song.artist, 'C2');
  assert.deepEqual(r.song.difficulties, { expert: 10.2 });
  assert.ok(music.search({ q: 'gamma 改' }).total === 1);
});

test('★ 校验：重复 ID、空曲名、没有难度都必须拒绝', () => {
  assert.equal(music.addSong({ id: 1, name: 'Dup', difficulties: { master: 12 } }).nack.code, 'duplicate_id');
  assert.equal(music.addSong({ name: '', difficulties: { master: 12 } }).nack.code, 'empty_name');
  assert.equal(music.addSong({ name: 'NoDiff', difficulties: {} }).nack.code, 'no_difficulty');
  assert.equal(music.updateSong(999, { name: 'X' }).nack.code, 'not_found');
});

test('★ 删除：从库中移除并重算分类', () => {
  const r = music.removeSong(3, 'test');
  assert.equal(r.ok, true);
  assert.equal(music.getView(3), null);
  const saved = JSON.parse(fs.readFileSync(TMP, 'utf8'));
  assert.equal(saved.songs.length, 2);
  assert.equal(saved.genres[0].count, 2);
});

test('★★ xlsx 全量导入：解析真实源文件、备份旧库、更新 meta', async () => {
  const buf = fs.readFileSync(path.join(ROOT, 'data', 'source', 'ChunithmMusicData.xlsx'));
  const r = await music.importBuffer(buf, { actor: 'test' });
  assert.equal(r.ok, true);
  assert.ok(r.counts.songs > 1400, `曲目数 ${r.counts.songs}`);
  assert.ok(r.counts.cn > 1000, `国服数 ${r.counts.cn}`);
  assert.equal(music.meta().counts.songs, r.counts.songs);
  assert.ok(fs.existsSync(`${TMP}.bak`), '导入前必须备份旧曲目库');

  const saved = JSON.parse(fs.readFileSync(TMP, 'utf8'));
  assert.equal(saved.counts.songs, r.counts.songs);
  assert.ok(saved.updatedAt, '必须写入 updatedAt');
});

test('★ 导入失败（坏文件）不得破坏现有曲目库', async () => {
  const before = music.meta().counts.songs;
  const r = await music.importBuffer(Buffer.from('not a zip'), { actor: 'test' });
  assert.equal(r.ok, false);
  assert.equal(r.nack.code, 'bad_xlsx');
  assert.equal(music.meta().counts.songs, before);
});

test('★ 封面字段：正常地址保留，危险协议丢弃', async () => {
  const first = music.search({ limit: 1 }).items[0];
  assert.ok(first, '导入后应有曲目');
  const r = await music.updateSong(first.id, { cover: '/covers/1.webp' }, 'test');
  assert.equal(r.ok, true);
  assert.equal(r.song.cover, '/covers/1.webp');

  const bad = await music.updateSong(first.id, { cover: 'javascript:alert(1)' }, 'test');
  assert.equal(bad.ok, true);
  assert.equal(bad.song.cover, '', '非站内 / http(s) 的封面地址必须丢弃');
});
