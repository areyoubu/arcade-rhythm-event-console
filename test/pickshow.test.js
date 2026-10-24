/**
 * 选手选曲展示：比赛选曲队列 → pickshow 输出状态。
 *
 * 只测服务端数据：P1/P2 过滤、2/4 首布局、当前局 / 即将进行来源。
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as match from '../server/match.js';
import * as music from '../server/music.js';
import * as pickshow from '../server/pickshow.js';
import { getState } from '../server/state.js';
import { getConfig } from '../server/config.js';

const TMP_MATCH = path.join(os.tmpdir(), `lp-pickshow-match-${process.pid}.json`);
const TMP_MUSIC = path.join(os.tmpdir(), `lp-pickshow-music-${process.pid}.json`);
process.env.LP_MATCH_FILE = TMP_MATCH;
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
    { id: 1, name: 'Alpha', artist: 'A', genre: 'ORIGINAL', cn: true, cover: '/covers/1.webp', difficulties: { master: 13 } },
    { id: 2, name: 'Beta', artist: 'B', genre: 'ORIGINAL', cn: true, cover: '/covers/2.webp', difficulties: { master: 13.5 } },
    { id: 3, name: 'Gamma', artist: 'C', genre: 'VARIETY', cn: false, cover: '/covers/3.webp', difficulties: { master: 14 } },
    { id: 4, name: 'Delta', artist: 'D', genre: 'VARIETY', cn: true, cover: '/covers/4.webp', difficulties: { master: 14.5 } },
  ],
};

before(async () => {
  fs.writeFileSync(TMP_MUSIC, JSON.stringify(FIXTURE), 'utf8');
  await music.load();
  match.load();
});

after(() => {
  for (const f of [TMP_MATCH, TMP_MUSIC]) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

beforeEach(() => {
  match.clearUpcomingPicks('test');
  match.start({ name: '测试局', force: true }, 'test');
  pickshow.setOptions({
    side: 'both', count: '2', source: 'current', sync: true, audio: true, audioSide: 'auto',
  }, 'test');
});

test('★★ 同时显示：P1/P2 分开取选曲，按每人 2 首输出', () => {
  match.createPick({ side: 'left', musicId: 1, difficulty: 'master' });
  match.createPick({ side: 'right', musicId: 2, difficulty: 'master' });
  const s = pickshow.refresh();
  assert.equal(s.options.side, 'both');
  assert.equal(s.count, 2);
  assert.equal(s.left.length, 1);
  assert.equal(s.right.length, 1);
  assert.equal(s.left[0].title, 'Alpha');
  assert.equal(s.right[0].title, 'Beta');
  assert.equal(getState().pickshow.state.left.length, 1);
});

test('★★ 只显示 P1 / P2：选项写入共享状态', () => {
  match.createPick({ side: 'left', musicId: 1, difficulty: 'master' });
  match.createPick({ side: 'right', musicId: 2, difficulty: 'master' });
  const l = pickshow.setOptions({ side: 'left' }, 'test').state;
  assert.equal(l.options.side, 'left');
  const r = pickshow.setOptions({ side: 'right' }, 'test').state;
  assert.equal(r.options.side, 'right');
});

test('★★ 4 首布局：自动在超过 2 首时切到 4，固定选项可强制 4', () => {
  for (const id of [1, 2, 3]) match.createPick({ side: 'left', musicId: id, difficulty: 'master' });
  const auto = pickshow.setOptions({ count: 'auto' }, 'test').state;
  assert.equal(auto.count, 4);
  const fixed = pickshow.setOptions({ count: '2' }, 'test').state;
  assert.equal(fixed.count, 2);
  assert.equal(fixed.left.length, 2, '每人只输出 2 首');
});

test('★★ 即将进行：当前局结束后仍可提交，展示来源与队列独立', () => {
  match.setUpcoming('第 12 局', 'test');
  match.setSong(0, { musicId: 1, difficulty: 'master' }, 'test');
  match.setScore(0, 'left', 1000, 'test');
  match.setScore(0, 'right', 900, 'test');
  match.finish('test');

  const up = match.createPick({ side: 'left', musicId: 2, difficulty: 'master', target: 'upcoming' });
  assert.equal(up.ok, true, '本局结束后仍可为即将进行提交');
  const cur = match.createPick({ side: 'left', musicId: 3, difficulty: 'master', target: 'current' });
  assert.equal(cur.ok, false);
  assert.equal(match.snapshot().current.upcomingPicks.length, 1);

  const s = pickshow.setOptions({ source: 'upcoming', side: 'both' }, 'test').state;
  assert.equal(s.source, 'upcoming');
  assert.equal(s.matchName, '第 12 局');
  assert.equal(s.left.length, 1);
  assert.equal(s.left[0].title, 'Beta');
  assert.equal(s.right.length, 0);
});

test('★ 开启新局：即将进行的选曲转入当前待确认队列', () => {
  match.createPick({ side: 'left', musicId: 2, difficulty: 'master', target: 'upcoming' });
  const r = match.start({ name: '下一局', force: true }, 'test');
  assert.equal(r.ok, true);
  assert.equal(r.state.current.name, '下一局');
  assert.equal(r.state.current.picks.length, 1);
  assert.equal(r.state.current.picks[0].title, 'Beta');
  assert.equal(r.state.current.upcomingPicks.length, 0);
});

test('★ 每人 1 首：固定选项输出单张卡', () => {
  pickshow.setOptions({ count: '1' }, 'test');
  match.createPick({ side: 'left', musicId: 1, difficulty: 'master' });
  match.createPick({ side: 'right', musicId: 2, difficulty: 'master' });
  const s = pickshow.refresh();
  assert.equal(s.count, 1);
  assert.equal(s.left.length, 1);
  assert.equal(s.right.length, 1);
});

test('★★ 选曲结果同步（默认开）：应用后仍按 P1/P2 显示，关闭后只看待确认队列', () => {
  pickshow.setOptions({ count: '2', source: 'current', sync: true }, 'test');
  const pk = match.createPick({ side: 'left', musicId: 1, difficulty: 'master' }).pick;
  const applied = match.applyPick(pk.id, null, 'test');
  assert.equal(applied.ok, true);
  assert.equal(applied.index, 0);

  const s = pickshow.refresh();
  assert.equal(s.options.sync, true);
  assert.equal(s.left.length, 1, '已写入曲目表的结果仍要显示');
  assert.equal(s.left[0].title, 'Alpha');
  assert.equal(s.left[0].index, 0);
  assert.equal(s.right.length, 0);

  pickshow.setOptions({ sync: false }, 'test');
  assert.equal(pickshow.snapshot().left.length, 0, '关闭同步后只显示待确认选曲');
});

test('★★ 即将进行：手机端认领的身份在开赛前就显示真实姓名', () => {
  pickshow.setOptions({ source: 'upcoming', sync: true }, 'test');
  match.createPick({
    side: 'right', musicId: 3, difficulty: 'master', target: 'upcoming',
    player: { id: 'p-demo', name: 'LC', image: '/media/demo.jpg' },
  });
  const s = pickshow.refresh();
  assert.equal(s.players.right.name, 'LC');
  assert.equal(s.players.right.image, '/media/demo.jpg');
  assert.equal(s.right[0].player.name, 'LC');
});

test('★★ 新局同步开启：即将进行的选曲直接写入空行，并保留分侧结果', () => {
  pickshow.setOptions({ source: 'upcoming', sync: true }, 'test');
  match.createPick({ side: 'left', musicId: 2, difficulty: 'master', target: 'upcoming' });
  const r = match.start({ name: '同步局', force: true, applyPicks: true }, 'test');
  assert.equal(r.state.current.picks.length, 0, '已同步的选曲不留在待确认队列');
  assert.equal(r.state.current.songs[0].musicId, 2);
  assert.equal(r.state.current.selections.left.length, 1);
  assert.equal(r.state.current.selections.left[0].index, 0);
  const s = pickshow.refresh();
  assert.equal(s.source, 'current');
  assert.equal(s.left.length, 1, '切换后当前局仍然显示刚同步的曲目');
  assert.equal(s.left[0].title, 'Beta');
});

test('★ 开新局后「即将进行」自动切回当前局', () => {
  pickshow.setOptions({ source: 'upcoming' }, 'test');
  match.start({ name: '下一局', force: true }, 'test');
  const s = pickshow.refresh();
  assert.equal(s.source, 'current');
  assert.equal(s.options.source, 'current');
});

test('★★ 展示动画：reveal 自增序号，reset 回到待展示', () => {
  const a = pickshow.resetReveal('test').state;
  assert.equal(a.revealed, false);
  const b = pickshow.revealShow('test').state;
  assert.equal(b.revealed, true);
  assert.ok(b.revealSeq >= 1);
  const c = pickshow.revealShow('test').state;
  assert.equal(c.revealSeq, b.revealSeq + 1, '再次点击应触发新一轮动画');
  assert.equal(pickshow.resetReveal('test').state.revealed, false);
});

test('★ 开新局后自动回到待展示', () => {
  pickshow.revealShow('test');
  match.start({ name: '动画测试局', force: true }, 'test');
  assert.equal(pickshow.refresh().revealed, false);
});

test('★★ 预览音频：双人默认 P1，单人跟随当前侧，指定侧优先', () => {
  const old = { ...(getConfig().gameAudio || {}) };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-pick-audio-'));
  try {
    getConfig().gameAudio = { ...old, enabled: true, gameDir: tmp };
    match.createPick({ side: 'left', musicId: 1, difficulty: 'master' });
    match.createPick({ side: 'right', musicId: 2, difficulty: 'master' });

    const both = pickshow.setOptions({ side: 'both', audio: true, audioSide: 'auto' }, 'test').state;
    assert.equal(both.audio?.musicId, 1, '双人默认输出 P1');
    assert.equal(both.audioSide, 'left');

    const left = pickshow.setOptions({ side: 'left' }, 'test').state;
    assert.equal(left.audio?.musicId, 1);

    const right = pickshow.setOptions({ side: 'right' }, 'test').state;
    assert.equal(right.audio?.musicId, 2);

    const fixed = pickshow.setOptions({ side: 'both', audioSide: 'right' }, 'test').state;
    assert.equal(fixed.audio?.musicId, 2, '可以指定固定输出 P2');

    const muted = pickshow.setOptions({ audio: false }, 'test').state;
    assert.equal(muted.audio, null, '关闭预览音频后不下发音频描述');
  } finally {
    getConfig().gameAudio = old;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('★ 清空即将进行队列后展示立即变空', () => {
  match.createPick({ side: 'left', musicId: 2, difficulty: 'master', target: 'upcoming' });
  pickshow.setOptions({ source: 'upcoming' }, 'test');
  assert.equal(pickshow.snapshot().left.length, 1);
  const out = pickshow.clearUpcoming('test');
  assert.equal(out.ok, true);
  assert.equal(pickshow.snapshot().left.length, 0);
});
