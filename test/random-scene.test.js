/**
 * 全屏随机选曲场景（服务端部分）。
 *
 * 只测「抽一首 + 生成滚动条 + 写入 random.state」，不涉及 DOM 动画。
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as music from '../server/music.js';
import * as randomScene from '../server/random-scene.js';
import { getState } from '../server/state.js';

const TMP_MUSIC = path.join(os.tmpdir(), `lp-random-music-${process.pid}.json`);

process.env.LP_MUSIC_FILE = TMP_MUSIC;

const FIXTURE = {
  sourceSheet: '原数据',
  difficulties: {
    basic: { key: 'basic', name: 'BASIC', color: '#00b050' },
    advanced: { key: 'advanced', name: 'ADVANCED', color: '#e46c0a' },
    expert: { key: 'expert', name: 'EXPERT', color: '#ff0000' },
    master: { key: 'master', name: 'MASTER', color: '#7030a0' },
    ultima: { key: 'ultima', name: 'ULTIMA', color: '#262626' },
  },
  difficultyOrder: ['basic', 'advanced', 'expert', 'master', 'ultima'],
  genres: [],
  songs: [
    { id: 1, name: 'Alpha', artist: 'A', genre: 'ORIGINAL', cn: true, cover: '/covers/1.webp', difficulties: { basic: 3, master: 12.5 } },
    { id: 2, name: 'Beta', artist: 'B', genre: 'ORIGINAL', cn: true, cover: '/covers/2.webp', difficulties: { advanced: 5, master: 13.7 } },
    { id: 3, name: 'Gamma', artist: 'C', genre: 'VARIETY', cn: false, cover: '/covers/3.webp', difficulties: { expert: 9.5, master: 14 } },
    { id: 4, name: 'Delta', artist: 'D', genre: 'VARIETY', cn: true, cover: '/covers/4.webp', difficulties: { basic: 2, expert: 8 } },
    {
      id: 5, name: 'Epsilon', artist: 'E', genre: 'ORIGINAL', cn: true, cover: '/covers/5.webp',
      difficulties: { master: 15 },
      we: { kanji: '止', star: 4, noteDesigner: 'N', originId: 5, chartId: 5001 },
    },
  ],
};

before(async () => {
  fs.writeFileSync(TMP_MUSIC, JSON.stringify(FIXTURE), 'utf8');
  await music.load();
});

after(() => {
  try { fs.unlinkSync(TMP_MUSIC); } catch { /* ignore */ }
});

beforeEach(() => {
  randomScene.clear('test');
});

test('★★ 随机抽取：目标曲放在滚动条固定位置，结果写入 random.state', () => {
  const r = randomScene.spin({ difficulty: 'master' }, 'test');
  assert.equal(r.ok, true);
  const s = r.state;
  assert.equal(s.reelSize, randomScene.REEL_SIZE);
  assert.equal(s.reel.length, randomScene.REEL_SIZE);
  assert.equal(s.targetIndex, randomScene.TARGET_INDEX);

  const target = s.reel[s.targetIndex];
  assert.equal(target.id, s.picked.id, '目标位置的卡片必须是最终抽中的曲目');
  assert.equal(target.title, s.picked.title);
  assert.equal(s.picked.difficulty, 'master');
  assert.ok(s.picked.cover);
  assert.ok(s.picked.difficulties && typeof s.picked.difficulties === 'object');
  assert.equal(getState().random.state.at, s.at, 'shared state 必须同步给渲染端/控制页');
});

test('★ WE：只有勾选 includeWe 才能抽到 WE 难度', () => {
  const no = randomScene.spin({ difficulty: 'we', includeWe: false }, 'test');
  assert.equal(no.ok, false);
  assert.equal(no.nack.code, 'empty_pool');

  const yes = randomScene.spin({ difficulty: 'we', includeWe: true }, 'test');
  assert.equal(yes.ok, true);
  assert.equal(yes.state.picked.id, 5);
  assert.equal(yes.state.picked.difficulty, 'we');
  assert.ok(yes.state.picked.weText);
});

test('★★ 「全部难度 + 等级范围」：滚动条里的每一首也必须在范围内', () => {
  const r = randomScene.spin({ difficulty: '', minLevel: 13, maxLevel: 14.5 }, 'test');
  assert.equal(r.ok, true);
  const p = r.state.picked;
  assert.ok(p.level >= 13 && p.level <= 14.5, `结果等级 ${p.level} 应在 13–14.5`);
  for (const item of r.state.reel) {
    assert.ok(item.level >= 13 && item.level <= 14.5, `${item.title} 的 ${item.difficultyName} ${item.level} 超出范围`);
  }
});

test('★ 筛选分类 / 国服：结果必须满足条件', () => {
  const r = randomScene.spin({ genre: 'VARIETY', cnOnly: true }, 'test');
  assert.equal(r.ok, true);
  assert.equal(r.state.picked.genre, 'VARIETY');
  assert.equal(r.state.picked.cn, true);
  assert.equal(r.state.picked.id, 4);
});

test('★ clear 会清空共享状态', () => {
  randomScene.spin({}, 'test');
  assert.ok(getState().random.state);
  randomScene.clear('test');
  assert.equal(getState().random.state, null);
  assert.equal(randomScene.snapshot(), null);
});
