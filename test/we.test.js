/**
 * WORLD'S END 特殊谱面。
 *
 * WE 是单独难度：默认不出现、不参与随机；勾选后才可用。
 * WE 曲目只作为特殊谱面存在时，不影响普通曲池。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), `lp-we-test-${process.pid}.json`);
process.env.LP_MUSIC_FILE = TMP;

fs.writeFileSync(TMP, JSON.stringify({
  generatedAt: '2026-01-01T00:00:00.000Z',
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
    { id: 1, name: '普通曲', artist: 'A', genre: 'ORIGINAL', cn: true, difficulties: { master: 13 }, cover: '/covers/1.webp' },
    { id: 2, name: 'WE 特殊曲', artist: 'B', genre: 'ORIGINAL', cn: true, difficulties: {}, we: { kanji: '止', star: 3 } },
  ],
}), 'utf8');

const music = await import('../server/music.js');
await music.load();

test.after(() => { try { fs.unlinkSync(TMP); } catch { /* ignore */ } });

test('★ meta 带 WE 分类；view / describe / difficultiesOf 都能识别', () => {
  assert.equal(music.meta().we.key, 'we');
  assert.equal(music.meta().counts.we, 1);

  const v = music.getView(2);
  assert.equal(v.we.kanji, '止');
  assert.equal(v.we.star, 3);
  assert.equal(v.weText, '止★3');

  const d = music.describe(2, 'we');
  assert.equal(d.difficulty, 'we');
  assert.equal(d.difficultyName, "WORLD'S END");
  assert.equal(d.level, 3);
  assert.equal(d.levelText, '止★3');

  const diffs = music.difficultiesOf(2);
  assert.ok(diffs.some((x) => x.key === 'we' && x.special === true));
});

test('★★ 默认搜索不返回 WE-only 曲目；勾选 includeWe 后才出现', () => {
  assert.equal(music.search({ q: 'WE 特殊' }).total, 0);
  assert.equal(music.search({ q: 'WE 特殊', includeWe: true }).total, 1);

  assert.equal(music.search({ difficulty: 'we' }).total, 0);
  assert.equal(music.search({ difficulty: 'we', includeWe: true }).total, 1);

  // 普通曲目不受影响
  assert.equal(music.search({ q: '普通曲' }).total, 1);
});

test('★★ 随机池默认排除 WE；显式请求 WE 时必须 includeWe', () => {
  assert.equal(music.random({ difficulty: 'we' }), null);
  const pick = music.random({ difficulty: 'we', includeWe: true });
  assert.ok(pick);
  assert.equal(pick.difficulty, 'we');
  assert.equal(pick.level, 3);
  assert.equal(pick.levelText, '止★3');
});

test('★ 普通曲目没有 WE 时，describe(we) 返回 null', () => {
  assert.equal(music.describe(1, 'we'), null);
});
