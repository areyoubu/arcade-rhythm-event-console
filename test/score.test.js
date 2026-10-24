/**
 * 模块 D —— 比分条 / 选手牌。
 *
 * 重点守住三件「赛场上出错代价很大」的事：
 *   1. 加一 / 减一只是暂存，**确认前不改正式比分**；
 *   2. 选手与叠加页共用 lineup：任一侧变化，两边一致；
 *   3. 切换模板不清空双人选手（切到单人模板不沿用阵容）。
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as score from '../server/score.js';
import * as overlay from '../server/overlay.js';
import * as entities from '../server/entities.js';
import * as templates from '../server/templates.js';
import { getConfig } from '../server/config.js';

const REAL_ENTITIES = getConfig().entities.file;
const TMP_ENTITIES = path.join('data', '_test-score-entities.json');
const TMP_SCORE = path.join(os.tmpdir(), `lp-score-test-${process.pid}.json`);
process.env.LP_SCORE_FILE = TMP_SCORE;

before(() => {
  getConfig().entities.file = TMP_ENTITIES;
  try { fs.writeFileSync(TMP_ENTITIES, '[]\n'); } catch { /* ignore */ }
  entities.load();
  templates.load();
  score.load();
});

after(() => {
  try { fs.unlinkSync(TMP_ENTITIES); } catch { /* ignore */ }
  try { fs.unlinkSync(`${TMP_ENTITIES}.bak`); } catch { /* ignore */ }
  try { fs.unlinkSync(TMP_SCORE); } catch { /* ignore */ }
  getConfig().entities.file = REAL_ENTITIES;
  entities.load();
  templates.load();
});

beforeEach(() => {
  score.resetScores('test');
  score.cancel('test');
  overlay.setLineupSide('A', null, { syncPreview: false });
  overlay.setLineupSide('B', null, { syncPreview: false });
  overlay.clear({ target: 'preview' });
  overlay.clearUndo('preview');
});

// ─────────────────────────────────────────────────────────────
// 暂存 / 确认
// ─────────────────────────────────────────────────────────────

test('★★ 加一只是暂存：确认前正式比分不动', () => {
  const before = score.snapshot();
  assert.equal(before.left.score, 0);

  const a = score.stage('left', 1);
  assert.equal(a.ok, true);
  const b = score.stage('left', 1);
  assert.equal(b.state.left.score, 0, '正式比分必须还是 0');
  assert.equal(b.state.left.pending, 2, '两次 +1 应累加成 +2');
  assert.equal(b.state.left.shownScore, 2, '控制端显示的是「确认后」的值');

  const c = score.confirm('test');
  assert.equal(c.state.left.score, 2, '确认后正式比分才变');
  assert.equal(c.state.left.pending, 0);
  assert.ok(c.state.log.some((l) => l.action === 'confirm'), '确认要写进操作日志');
});

test('★ 取消会丢掉全部暂存，不动正式比分', () => {
  score.stage('right', 1);
  const bad = score.stage('left', 0);
  assert.equal(bad.ok, false, 'delta=0 不应改变任何东西');
  const r = score.stage('right', 2);
  assert.equal(r.state.right.pending, 3);
  const c = score.cancel('test');
  assert.equal(c.state.right.score, 0);
  assert.equal(c.state.right.pending, 0);
});

test('★ 比分不能减到负数', () => {
  const zero = score.stage('left', -1);
  assert.equal(zero.ok, false, '0 分时不能再减');
  assert.equal(zero.nack.code, 'negative');

  score.stage('left', 1);
  const down = score.stage('left', -1);
  assert.equal(down.ok, true);
  assert.equal(down.state.left.pending, 0);
  const again = score.stage('left', -1);
  assert.equal(again.ok, false);
});

test('★ 没有暂存时确认会返回明确错误（不是静默成功）', () => {
  const r = score.confirm('test');
  assert.equal(r.ok, false);
  assert.equal(r.nack.code, 'no_pending');
});

test('★ 显隐开关分别控制比分条与选手牌', () => {
  const r = score.setVisible({ bar: false, plates: false });
  assert.equal(r.state.barVisible, false);
  assert.equal(r.state.platesVisible, false);
  const r2 = score.setVisible({ all: false });
  assert.equal(r2.state.visible, false);
  score.setVisible({ all: true, bar: true, plates: true });
});

// ─────────────────────────────────────────────────────────────
// 与叠加同步
// ─────────────────────────────────────────────────────────────

test('★★ 比分条选选手 → 写入 lineup，并同步到叠加的预览双人模板', () => {
  const team = entities.create({ kind: 'team', name: '同步队' }).entity;
  const p = entities.create({ kind: 'player', name: '同步选手', teamId: team.id }).entity;

  overlay.show({ template: 'versusCard', values: { leftName: '旧名字', rightName: '对面' }, target: 'preview' });

  const r = score.setPlayer('left', p.id, 'test');
  assert.equal(r.ok, true);
  assert.equal(overlay.getLineup().A.entityId, p.id, 'A 侧阵容应更新');

  const pv = overlay.getTarget('preview');
  assert.equal(pv.slotValues.leftName, '同步选手', '叠加预览里的左侧选手应同步');
  assert.equal(pv.slotValues.leftTeam, '同步队', '团队赛还应带上队伍名');
  assert.equal(pv.slotValues.rightName, '对面', '另一侧不能被顺带改掉');
});

test('★★ 叠加页填人 → 比分条对应侧立即显示该选手', () => {
  const team = entities.create({ kind: 'team', name: '反同步队' }).entity;
  const a = entities.create({ kind: 'player', name: '甲选手', teamId: team.id }).entity;
  const b = entities.create({ kind: 'player', name: '乙选手', teamId: team.id }).entity;

  overlay.fillFromEntity(a.id, { template: 'talentTwin', side: 'A', target: 'preview' });
  overlay.fillFromEntity(b.id, { template: 'talentTwin', side: 'B', target: 'preview' });

  const s = score.snapshot();
  assert.equal(s.left.playerId, a.id);
  assert.equal(s.left.playerName, '甲选手');
  assert.equal(s.right.playerId, b.id);
  assert.equal(s.right.teamName, '反同步队');
});

test('★★ 切换双人模板不会清空选手', () => {
  const team = entities.create({ kind: 'team', name: '保留队' }).entity;
  const a = entities.create({ kind: 'player', name: '保留甲', teamId: team.id }).entity;
  const b = entities.create({ kind: 'player', name: '保留乙', teamId: team.id }).entity;

  overlay.fillFromEntity(a.id, { template: 'talentTwin', side: 'A', target: 'preview' });
  overlay.fillFromEntity(b.id, { template: 'talentTwin', side: 'B', target: 'preview' });

  // 换到另一种双人模板（槽位名完全不同：aName/bName → leftName/rightName）
  const r = overlay.show({ template: 'versusCard', values: {}, target: 'preview' });
  assert.equal(r.ok, true, JSON.stringify(r.nack || {}));
  const pv = overlay.getTarget('preview');
  assert.equal(pv.slotValues.leftName, '保留甲');
  assert.equal(pv.slotValues.rightName, '保留乙');
});

test('★ 切到单人模板不沿用阵容（照样是空的）', () => {
  const p = entities.create({ kind: 'player', name: '单人选手' }).entity;
  overlay.setLineupSide('A', p.id, { syncPreview: false });

  // 单人模板只有 name 槽位；如果沿用阵容就会被自动填成「单人选手」
  const r = overlay.show({ template: 'lowerThird', values: { name: '' }, target: 'preview' });
  assert.equal(r.ok, false, '单人模板不应从 lineup 自动补人');
  assert.equal(r.nack.code, 'invalid_values');
});

test('★ 一键清空选手：阵容清空，但 1P / 2P 选手条仍然显示', () => {
  const p = entities.create({ kind: 'player', name: '清空测试' }).entity;
  score.setPlayer('left', p.id, 'test');
  assert.equal(score.snapshot().left.playerName, '清空测试');

  const r = score.clearPlayers('test');
  assert.equal(r.ok, true);
  assert.equal(overlay.getLineup().A, null, '阵容应被清空');
  assert.equal(r.state.left.playerName, '', '选手名应清空');
  assert.equal(r.state.platesVisible, true, '选手条必须保持显示，不能空一块');
  assert.equal(r.state.platesReady, undefined, '不再下发 platesReady：旧渲染端也不会据此隐藏选手条');
});

test('★ 比分条颜色只接受 #RRGGBB', () => {
  assert.equal(score.setColor('left', 'red').ok, false);
  assert.equal(score.setColor('left', '#112233').ok, true);
});
