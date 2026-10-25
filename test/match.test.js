/**
 * 模块 F —— 比赛计分 / 曲目 / 扫码选曲 / 与比分条联动。
 *
 * 守住：
 *   · 1–4 首自适应：空行不进入「可见曲目」，但不影响控制页的 4 个输入位；
 *   · 总分制 / 小局制两种胜负判定；
 *   · 结束即存档，存档后不可再改（画面与历史必须一致）；
 *   · ban / 随机 / 扫码选曲的边界；
 *   · 比分条 source=match 时读的是本局聚合分，手动 ±1 被拒绝。
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as match from '../server/match.js';
import * as music from '../server/music.js';
import * as score from '../server/score.js';
import { getState } from '../server/state.js';

const TMP_MATCH = path.join(os.tmpdir(), `lp-match-test-${process.pid}.json`);
const TMP_SCORE = path.join(os.tmpdir(), `lp-match-score-test-${process.pid}.json`);
const TMP_MUSIC = path.join(os.tmpdir(), `lp-match-music-test-${process.pid}.json`);
process.env.LP_MATCH_FILE = TMP_MATCH;
process.env.LP_SCORE_FILE = TMP_SCORE;
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
  ],
};

before(async () => {
  fs.writeFileSync(TMP_MUSIC, JSON.stringify(FIXTURE), 'utf8');
  await music.load();
  match.load();
  score.load();
});

after(() => {
  try { match.shutdown(); } catch { /* ignore */ }
  for (const f of [TMP_MATCH, TMP_SCORE, TMP_MUSIC]) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

beforeEach(() => {
  match.start({ name: '测试局', mode: 'total', force: true }, 'test');
  match.clearHistory('test');
  match.clearBans('test');
  score.setSource('manual', 'test');
  score.resetScores('test');
});

const setScore = (i, l, r) => {
  match.setScore(i, 'left', l, 'test');
  match.setScore(i, 'right', r, 'test');
};

test('★ 新开一局：固定 4 个输入位，但全部是空行', () => {
  const s = match.snapshot();
  assert.equal(s.current.songs.length, 4);
  assert.equal(s.current.status, 'live');
  assert.equal(s.current.derived.filledCount, 0);
  assert.equal(s.current.derived.completeRows, 0);
  assert.ok(s.current.songs.every((r) => r.filled === false), '空行不应进入可见曲目');
  assert.ok(s.current.songs.every((r) => r.index >= 0 && r.index < 4));
});

test('★★ 总分制：按双方曲目得分相加，空行不参与', () => {
  match.setSong(0, { musicId: 1, difficulty: 'master' }, 'test');
  match.setSong(1, { musicId: 2, difficulty: 'advanced' }, 'test');
  setScore(0, 1_000_000, 900_000);
  setScore(1, 800_000, 850_000);

  const s = match.snapshot();
  const d = s.current.derived;
  assert.equal(d.filledCount, 2, '只应有两首可见');
  assert.equal(d.completeRows, 2);
  assert.equal(d.totalLeft, 1_800_000);
  assert.equal(d.totalRight, 1_750_000);
  assert.equal(d.displayLeft, 1_800_000);
  assert.equal(d.leftWins, 1);
  assert.equal(d.rightWins, 1);
  assert.equal(d.leader, 'left');
  assert.equal(s.current.songs[2].filled, false, '第三行仍是空行');
  assert.equal(s.current.songs[0].winner, 'left');
  assert.equal(s.current.songs[1].winner, 'right');
  assert.equal(s.current.songs[0].difficultyColor, '#7030a0');
});

test('★★ 小局制：比赢下的曲目数，平分不算任何一方获胜', () => {
  match.setMode('wins', 'test');
  match.setSong(0, { musicId: 1 }, 'test');
  match.setSong(1, { musicId: 2 }, 'test');
  match.setSong(2, { musicId: 3 }, 'test');
  setScore(0, 900_000, 800_000); // P1
  setScore(1, 700_000, 800_000); // P2
  setScore(2, 500_000, 500_000); // 平

  const d = match.snapshot().current.derived;
  assert.equal(d.leftWins, 1);
  assert.equal(d.rightWins, 1);
  assert.equal(d.draws, 1);
  assert.equal(d.displayLeft, 1);
  assert.equal(d.displayRight, 1);
  assert.equal(d.leader, 'draw');
  assert.equal(d.totalLeft, 2_100_000);
  assert.equal(d.totalRight, 2_100_000);
});

test('★★ 赛程：「即将进行」独立于当前局名称，结束后仍可修改', () => {
  const a = match.setUpcoming('第 12 局', 'test');
  assert.equal(a.ok, true);
  assert.equal(match.snapshot().current.upcoming, '第 12 局');
  assert.equal(match.snapshot().current.name, '测试局');
  assert.equal(getState().match.ticker.upcoming, '第 12 局');
  assert.equal(getState().match.ticker.current, '测试局');

  match.setUpcoming('', 'test');
  assert.equal(match.snapshot().current.upcoming, '', '允许清空');

  match.setSong(0, { musicId: 1 }, 'test');
  setScore(0, 1000, 900);
  match.finish('test');
  assert.equal(match.snapshot().current.status, 'finished');
  // 当前局名称已冻结，但赛程的「即将进行」仍要能改（下一场不依赖上一场状态）
  assert.equal(match.setName('改不了', 'test').ok, false);
  const b = match.setUpcoming('第 13 局', 'test');
  assert.equal(b.ok, true);
  assert.equal(match.snapshot().current.upcoming, '第 13 局');
});

test('★★ 结束本局：胜负写入历史；结束后不能再改，画面冻结', () => {
  match.setSong(0, { musicId: 1 }, 'test');
  setScore(0, 1_000_000, 950_000);
  const r = match.finish('test');
  assert.equal(r.ok, true);
  assert.equal(r.state.current.status, 'finished');
  assert.equal(r.state.current.winner, 'left');
  assert.equal(r.state.history.length, 1);
  const h = r.state.history[0];
  assert.equal(h.status, 'finished');
  assert.equal(h.result.totalLeft, 1_000_000);
  assert.equal(h.result.totalRight, 950_000);
  assert.equal(r.state.current.players.left.name, '', '选手快照存在（本测试为空）');

  const again = match.finish('test');
  assert.equal(again.ok, false);
  assert.equal(again.nack.code, 'already_finished');

  const edit = match.setScore(0, 'left', 1, 'test');
  assert.equal(edit.ok, false, '已结束的局不能再改分数');
  assert.equal(edit.nack.code, 'already_finished');

  const detail = match.getHistory(h.id);
  assert.ok(detail);
  assert.equal(detail.result.displayLeft, 1_000_000);
});

test('★ 换曲 / 换难度会清空该行分数（分数只对具体谱面有意义）', () => {
  match.setSong(0, { musicId: 1, difficulty: 'master' }, 'test');
  setScore(0, 100, 200);
  assert.equal(match.snapshot().current.songs[0].scoreLeft, 100);

  match.setSong(0, { musicId: 2, difficulty: 'master' }, 'test');
  let row = match.snapshot().current.songs[0];
  assert.equal(row.musicId, 2);
  assert.equal(row.scoreLeft, null, '换曲后分数应清空');
  assert.equal(row.scoreRight, null);

  setScore(0, 300, 400);
  match.setSong(0, { musicId: 2, difficulty: 'advanced' }, 'test');
  row = match.snapshot().current.songs[0];
  assert.equal(row.difficulty, 'advanced');
  assert.equal(row.scoreLeft, null, '换难度后分数也应清空');
});

test('★★ 随机选曲必须写入封面，控制页与总比分画面才能显示曲绘', () => {
  const r = match.randomPick({ index: 0 }, 'test');
  assert.equal(r.ok, true);
  const row = match.snapshot().current.songs[0];
  assert.ok(row.cover, '随机选曲后不应丢封面');
  assert.match(row.cover, /^\/covers\/\d+\.webp$/);
  assert.equal(row.title, r.pick.song.name);
});

test('★★ 重新选择同一曲目：补齐封面，但保留已录分数', () => {
  match.setSong(0, { musicId: 1, difficulty: 'master' }, 'test');
  setScore(0, 111, 222);
  // 模拟旧数据：曲库后补/更新了封面，比赛行里仍是旧值
  assert.equal(music.updateSong(1, { cover: '/covers/1-new.webp' }, 'test').ok, true);
  try {
    const r = match.setSong(0, { musicId: 1, difficulty: 'master' }, 'test');
    assert.equal(r.ok, true);
    const row = match.snapshot().current.songs[0];
    assert.equal(row.cover, '/covers/1-new.webp', '同一曲目重选应同步曲库封面');
    assert.equal(row.scoreLeft, 111, '重选同一谱面不能清空分数');
    assert.equal(row.scoreRight, 222);
  } finally {
    music.updateSong(1, { cover: '/covers/1.webp' }, 'test');
  }
});

test('★ 分数校验：负数 / 非整数 / 超上限都要拒绝', () => {
  assert.equal(match.setScore(0, 'left', '-1', 'test').ok, false);
  assert.equal(match.setScore(0, 'left', '12.5', 'test').ok, false);
  assert.equal(match.setScore(0, 'left', String(match.SCORE_MAX + 1), 'test').ok, false);
  assert.equal(match.setScore(0, 'left', '1,234,567', 'test').ok, true, '带千分位应能识别');
  assert.equal(match.snapshot().current.songs[0].scoreLeft, 1_234_567);
});

test('★★ Ban：在用的曲目不能 ban；随机选曲会避开 ban 和已用曲目', () => {
  match.setSong(0, { musicId: 1 }, 'test');
  const inUse = match.ban(1, true, 'test');
  assert.equal(inUse.ok, false);
  assert.equal(inUse.nack.code, 'in_use');

  assert.equal(match.ban(2, true, 'test').ok, true);
  const r = match.randomPick({ index: 1 }, 'test');
  assert.equal(r.ok, true);
  assert.ok(![1, 2].includes(r.pick.song.id), `不应选到已用/已 ban：${r.pick.song.id}`);
  assert.equal(match.snapshot().current.bans.length, 1);

  assert.equal(match.clearBans('test').ok, true);
  assert.equal(match.snapshot().current.bans.length, 0);
});

test('★★ 扫码选曲：排队不直接改画面，导播应用后才写入；重复提交去重', () => {
  const a = match.createPick({ side: 'left', musicId: 3, difficulty: 'master' });
  assert.equal(a.ok, true);
  assert.equal(a.pick.title, 'Gamma');
  assert.equal(match.snapshot().picks.length, 1);
  assert.ok(!match.snapshot().current.songs.some((r) => r.musicId === 3), '请求阶段不能改曲目表');

  const dup = match.createPick({ side: 'left', musicId: 3, difficulty: 'master' });
  assert.equal(dup.ok, true);
  assert.equal(dup.duplicate, true);
  assert.equal(match.snapshot().picks.length, 1, '同一侧同一曲目不应重复排队');

  const applied = match.applyPick(a.pick.id, 2);
  assert.equal(applied.ok, true);
  assert.equal(applied.index, 2);
  assert.equal(match.snapshot().current.songs[2].musicId, 3);
  assert.equal(match.snapshot().picks.length, 0);

  match.setSong(0, { musicId: 1 }, 'test');
  const banned = match.ban(4, true, 'test');
  assert.equal(banned.ok, true);
  const rejected = match.createPick({ side: 'right', musicId: 4, difficulty: 'basic' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.nack.code, 'banned');

  setScore(0, 100, 200);
  match.finish('test');
  const afterFinish = match.createPick({ side: 'right', musicId: 2, difficulty: 'master' });
  assert.equal(afterFinish.ok, false);
  assert.equal(afterFinish.nack.code, 'match_finished');
});

test('★★ 比分条联动：source=match 时读聚合分，手动 ±1 被拒绝', () => {
  match.setSong(0, { musicId: 1 }, 'test');
  setScore(0, 1_234_567, 1_000_000);

  score.setSource('match', 'test');
  const s = score.snapshot();
  assert.equal(s.source, 'match');
  assert.equal(s.left.score, 1_234_567);
  assert.equal(s.right.score, 1_000_000);
  assert.equal(s.label, '测试局');
  assert.match(s.meta, /总分制/);
  assert.equal(s.matchWinner, null, '进行中不应提前标记胜者');

  const staged = score.stage('left', 1, 'test');
  assert.equal(staged.ok, false);
  assert.equal(staged.nack.code, 'match_source');

  match.finish('test');
  const done = score.snapshot();
  assert.equal(done.matchWinner, 'left');
  assert.equal(done.left.isWinner, true);
  assert.equal(done.right.isWinner, false);

  score.setSource('manual', 'test');
  const manual = score.snapshot();
  assert.equal(manual.source, 'manual');
  assert.equal(manual.left.score, 0, '手动比分没有被比赛分污染');
  assert.equal(manual.label, '');
});

test('★ 未结束就开新局：必须确认 force，旧局作为「未完成」存档', () => {
  match.setSong(0, { musicId: 1 }, 'test');
  setScore(0, 100, 200);

  const refused = match.start({ name: '第二局' }, 'test');
  assert.equal(refused.ok, false);
  assert.equal(refused.nack.code, 'unfinished');

  const forced = match.start({ name: '第二局', force: true }, 'test');
  assert.equal(forced.ok, true);
  assert.equal(forced.state.current.name, '第二局');
  assert.equal(forced.state.current.status, 'live');
  const abandoned = forced.state.history.find((h) => h.status === 'abandoned');
  assert.ok(abandoned, '未完成的旧局应留档');
  assert.equal(abandoned.name, '测试局');
});

test('★ 空行规则：只录一方分数也算「有内容」，但不参与胜负聚合', () => {
  match.setScore(0, 'left', 500_000, 'test');
  const s = match.snapshot();
  assert.equal(s.current.songs[0].filled, true, '有单边分数就应出现在总比分画面');
  assert.equal(s.current.songs[0].both, false);
  assert.equal(s.current.derived.completeRows, 0, '缺一方时不能计入胜负');
  assert.equal(s.current.derived.displayLeft, 0);
  assert.equal(s.current.songs[0].winner, null);
});

// ─────────────────────────────────────────────────────────────
// 局号重置（回归：自动局号只能随历史场次累加，彩排后回不到第 1 局）
// ─────────────────────────────────────────────────────────────

test('★ 自动局号：开局递增，且不依赖历史场次', () => {
  match.resetRoundSeq(1, 'test');
  assert.equal(match.snapshot().roundSeq, 1);
  match.start({ name: '', force: true }, 'test');
  assert.equal(match.snapshot().current.name, '第 1 局');
  assert.equal(match.snapshot().roundSeq, 2, '开局后局号应前进');
  match.start({ name: '', force: true }, 'test');
  assert.equal(match.snapshot().current.name, '第 2 局');
});

test('★★ 重置局号：当前进行中的自动命名局改名，历史不动', () => {
  match.start({ name: '', force: true }, 'test');
  // 造几场历史，制造「第 N 局」被顶到很大的情况
  for (let i = 0; i < 5; i++) {
    match.setScore(0, 'left', 100, 'test');
    match.finish('test');
    match.start({ name: '', force: true }, 'test');
  }
  const before = match.snapshot();
  assert.ok(before.historyTotal >= 5, '应有历史场次');
  const historyNames = before.history.map((h) => h.name);

  const r = match.resetRoundSeq(1, 'test');
  assert.equal(r.ok, true);
  assert.equal(r.renamed, true, '进行中的自动命名局应一并改名');
  assert.equal(r.state.current.name, '第 1 局');
  assert.equal(r.nextRoundNo, 2, '下一局顺延到第 2 局');
  assert.deepEqual(r.state.history.map((h) => h.name), historyNames, '历史名称不能被改写');
  assert.equal(r.state.historyTotal, before.historyTotal, '历史不能丢');
});

test('★ 重置局号：自定义名称 / 已结束的局不改名，只改下一个自动局号', () => {
  match.start({ name: '决赛 · 冠军战', force: true }, 'test');
  const custom = match.resetRoundSeq(5, 'test');
  assert.equal(custom.renamed, false);
  assert.equal(custom.state.current.name, '决赛 · 冠军战');
  assert.equal(custom.nextRoundNo, 5);

  match.setScore(0, 'left', 100, 'test');
  match.finish('test');
  const finished = match.resetRoundSeq(9, 'test');
  assert.equal(finished.renamed, false, '已结束的局不能改名（历史记录必须对得上）');
  assert.equal(finished.nextRoundNo, 9);
});

test('★ 重置局号：非法值拒绝；清空历史后局号回到 1', () => {
  assert.equal(match.resetRoundSeq(0, 'test').ok, false);
  assert.equal(match.resetRoundSeq(-3, 'test').ok, false);
  assert.equal(match.resetRoundSeq('abc', 'test').ok, false);
  assert.equal(match.resetRoundSeq(10_000, 'test').ok, false);

  match.resetRoundSeq(42, 'test');
  match.clearHistory('test');
  assert.equal(match.snapshot().roundSeq, 1, '清空历史 = 从头开始，局号回 1');
});
