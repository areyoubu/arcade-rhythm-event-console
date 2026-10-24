/**
 * 叠加控制端测试 —— 对应 A-REQ-502 / 505 / 506 / 507 / 510 / 601 / 604、A-REQ-306。
 *
 * 重点是两条容易写错的语义：
 *   · 热改（update）必须**先快照再改状态**，否则撤销栈里存的是新值，撤销等于没撤销
 *   · 同模板再次 show 属于热改，不能重播入场动画（陷阱 #52）
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as overlay from '../server/overlay.js';
import * as templates from '../server/templates.js';
import * as entities from '../server/entities.js';
import { getConfig } from '../server/config.js';

templates.load();
const T = 'lowerThird';

/**
 * 把实体库切到一个临时文件 —— 测试**不得**污染用户真实的 data/entities.json。
 * `getConfig()` 返回的是活对象，这里临时改掉并在 after 里恢复。
 */
const REAL_FILE = getConfig().entities.file;
const TMP_FILE = path.join('data', '_test-entities.json');

before(() => {
  getConfig().entities.file = TMP_FILE;
  try { fs.writeFileSync(TMP_FILE, '[]\n'); } catch { /* ignore */ }
  entities.load();
});

after(() => {
  try { fs.unlinkSync(TMP_FILE); } catch { /* ignore */ }
  try { fs.unlinkSync(`${TMP_FILE}.bak`); } catch { /* ignore */ }
  getConfig().entities.file = REAL_FILE;
});

/**
 * 把 main 恢复到干净的初始态。
 * 先抽干撤销栈、再清空 —— 顺序反了的话，抽干过程中最后一次 undo 会把内容恢复回来。
 */
function reset() {
  for (let i = 0; i < 40; i++) {
    const r = overlay.undo('main');
    if (!r.ok) break;
  }
  overlay.clear({ target: 'main' });
  overlay.clearUndo('main');
}

test('★ 撤销必须真的回到上一个值（回归：曾因先改状态后快照而恒为新值）', () => {
  reset();
  overlay.show({ template: T, values: { name: 'A1', subtitle: 'S1' }, target: 'main' });
  overlay.update('name', 'A2', { target: 'main' });
  overlay.update('name', 'A3', { target: 'main' });

  assert.equal(overlay.getTarget('main').slotValues.name, 'A3');

  overlay.undo('main');
  assert.equal(overlay.getTarget('main').slotValues.name, 'A2', '第一次撤销应回到 A2');

  overlay.undo('main');
  assert.equal(overlay.getTarget('main').slotValues.name, 'A1', '第二次撤销应回到 A1');
});

test('★ 撤销可以回到「无内容」状态', () => {
  reset();
  overlay.show({ template: T, values: { name: 'A1' }, target: 'main' });
  overlay.clear({ target: 'main' });
  assert.equal(overlay.getTarget('main').activeTemplate, null);

  overlay.undo('main');
  assert.equal(overlay.getTarget('main').activeTemplate, T, '撤销清空应恢复模板');
});

test('★ 撤销栈深度上限为 10（A-REQ-510）', () => {
  reset();
  overlay.show({ template: T, values: { name: 'n0' }, target: 'main' });
  for (let i = 1; i <= 25; i++) overlay.update('name', `n${i}`, { target: 'main' });
  const depth = overlay.undoDepth('main');
  assert.ok(depth <= 10, `撤销栈不应超过 10 步，实际 ${depth}`);
  assert.equal(depth, 10);
});

test('★ 空栈时撤销返回明确 nack 而不是抛异常', () => {
  reset();
  const r = overlay.undo('main');
  assert.equal(r.ok, false);
  assert.equal(r.nack.code, 'nothing_to_undo');
});

test('★ 被拒绝的 show 不得污染撤销栈', () => {
  reset();
  const before = overlay.undoDepth('main');
  const r = overlay.show({ template: T, values: { name: '' }, target: 'main' });
  assert.equal(r.ok, false, '必填槽位为空必须被拒绝');
  assert.equal(r.nack.code, 'invalid_values');
  assert.equal(overlay.undoDepth('main'), before, '被拒绝的请求不该留下撤销记录');
});

test('未知模板被拒绝并给出明确错误码', () => {
  const r = overlay.show({ template: 'noSuchTemplate', values: {}, target: 'main' });
  assert.equal(r.ok, false);
  assert.equal(r.nack.code, 'unknown_template');
});

test('未知槽位被拒绝', () => {
  reset();
  overlay.show({ template: T, values: { name: 'x' }, target: 'main' });
  const r = overlay.update('nope', 'v', { target: 'main' });
  assert.equal(r.ok, false);
  assert.equal(r.nack.code, 'unknown_slot');
});

test('没有活动模板时 update 被拒绝', () => {
  reset();
  const r = overlay.update('name', 'v', { target: 'main' });
  assert.equal(r.ok, false);
  assert.equal(r.nack.code, 'nothing_active');
});

test('★ text 槽位按 maxLength 截断（防超长文案撑破版面）', () => {
  reset();
  overlay.show({ template: T, values: { name: 'x' }, target: 'main' });
  const long = 'A'.repeat(200);
  const r = overlay.update('name', long, { target: 'main' });
  assert.equal(r.ok, true);
  const def = templates.get(T).slots.find((s) => s.key === 'name');
  assert.equal(r.value.length, def.maxLength);
});

test('★ color 槽位只接受合法十六进制，非法时回落默认值', () => {
  reset();
  overlay.show({ template: T, values: { name: 'x' }, target: 'main' });
  const ok = overlay.update('accentColor', '#00ff88', { target: 'main' });
  assert.equal(ok.value, '#00ff88');
  const bad = overlay.update('accentColor', 'red; drop table', { target: 'main' });
  assert.match(bad.value, /^#[0-9a-f]{3,8}$/i, '非法颜色必须被替换为合法值（防注入）');
});

test('★ setPinned 会让画面保持可见（A-REQ-507）', () => {
  reset();
  overlay.show({ template: T, values: { name: 'x' }, target: 'main' });
  overlay.hide({ target: 'main' });
  assert.equal(overlay.getTarget('main').visible, false);
  const r = overlay.setPinned(true, { target: 'main' });
  assert.equal(r.ok, true);
  assert.equal(overlay.getTarget('main').visible, true, '常驻后必须可见');
});

test('★ 回放模式切换只改文案字段，不改变模板与槽位（A-REQ-511）', () => {
  reset();
  overlay.show({ template: T, values: { name: '选手A' }, target: 'main' });
  const r = overlay.setMode('replay', { target: 'main', label: '选手A' });
  assert.equal(r.ok, true);
  assert.equal(overlay.getTarget('main').mode, 'replay');
  assert.equal(overlay.getTarget('main').modeLabel, '选手A');
  assert.equal(overlay.getTarget('main').activeTemplate, T, '切模式不得影响模板');
  assert.equal(overlay.getTarget('main').slotValues.name, '选手A', '切模式不得影响槽位');
});

test('★ 模式切换非法值一律归为 live，不产生第三种状态', () => {
  reset();
  overlay.setMode('garbage', { target: 'main' });
  assert.equal(overlay.getTarget('main').mode, 'live');
});

test('★ 每个 target 的状态互相独立（main / credits 是两个实例，A-REQ-002）', () => {
  reset();
  overlay.getTarget('credits');
  overlay.show({ template: T, values: { name: 'main-name' }, target: 'main' });
  overlay.show({ template: T, values: { name: 'credits-name' }, target: 'credits' });
  assert.equal(overlay.getTarget('main').slotValues.name, 'main-name');
  assert.equal(overlay.getTarget('credits').slotValues.name, 'credits-name');
  overlay.clear({ target: 'main' });
  assert.equal(overlay.getTarget('credits').slotValues.name, 'credits-name', '清空 main 不得影响 credits');
});

test('allTargets 始终包含 main 与 credits（否则控制端首次打开会读到空）', () => {
  const all = overlay.allTargets();
  assert.ok(all.main, 'main 必须始终存在');
  assert.ok(all.credits, 'credits 必须始终存在');
});

test('★ 渲染延迟统计：markRendered 返回「已发 → 已渲染」的耗时（A-REQ-604）', () => {
  reset();
  overlay.show({ template: T, values: { name: 'x' }, target: 'main' });
  const sentAt = overlay.getTarget('main').sentAt;
  assert.ok(sentAt > 0, 'show 之后应有 sentAt');
  const latency = overlay.markRendered('main', T, sentAt + 42);
  assert.equal(latency, 42);
  assert.equal(overlay.getTarget('main').renderedAt, sentAt + 42);
  // 未渲染时 pending 为 true（控制端据此显示「指令已发」）
  const s = overlay.allTargets().main;
  assert.equal(s.pending, false, '渲染后 pending 应为 false');
});

test('★ 队列：添加 / 排序 / 移除', () => {
  overlay.queueClear();
  const a = overlay.queueAdd({ template: T, values: { name: 'q1' } });
  const b = overlay.queueAdd({ template: T, values: { name: 'q2' } });
  assert.equal(a.ok, true);
  assert.equal(overlay.allTargets() && true, true);
  const reordered = overlay.queueReorder([b.item.id, a.item.id]);
  assert.equal(reordered.queue[0].id, b.item.id, '重排后顺序应生效');
  overlay.queueRemove(b.item.id);
  overlay.queueClear();
});

test('未知模板入队被拒绝', () => {
  const r = overlay.queueAdd({ template: 'nope', values: {} });
  assert.equal(r.ok, false);
  assert.equal(r.nack.code, 'unknown_template');
});

test('★ 队列：必填槽位为空时明确拒绝，而不是入队后静默卡住', () => {
  overlay.queueClear();
  const r = overlay.queueAdd({ template: 'versusCardNeon', values: {} });
  assert.equal(r.ok, false);
  assert.equal(r.nack.code, 'invalid_values');
  assert.match(r.nack.msg, /必填/);
});

test('★ 队列：空队列开始播放返回明确错误', () => {
  overlay.queueClear();
  const r = overlay.queueStart({ target: 'main' });
  assert.equal(r.ok, false);
  assert.equal(r.nack.code, 'queue_empty');
});

test('★ 队列：有效条目会依次播放并推进', async () => {
  overlay.queueClear();
  overlay.queueAdd({ template: T, values: { name: 'q1' }, durationMs: 120, target: 'preview' });
  overlay.queueAdd({ template: T, values: { name: 'q2' }, durationMs: 120, target: 'preview' });
  const started = overlay.queueStart({ target: 'preview' });
  assert.equal(started.ok, true);
  assert.equal(overlay.getTarget('preview').slotValues.name, 'q1');

  // durationMs 下限 300ms：第一条 300ms 后隐藏，再等 500ms 接第二条
  await new Promise((r) => setTimeout(r, 380));
  assert.equal(overlay.getTarget('preview').visible, false, '第一条结束后应隐藏');

  await new Promise((r) => setTimeout(r, 520));
  assert.equal(overlay.getTarget('preview').slotValues.name, 'q2', '第二条应自动接上');
  overlay.queueClear();
});

test('★ 时长预估：行数越多越长，速度越快越短（A-REQ-523）', () => {
  const a = overlay.estimateCreditsDuration({ lines: new Array(5), speed: 40 });
  const b = overlay.estimateCreditsDuration({ lines: new Array(20), speed: 40 });

  assert.ok(b.seconds > a.seconds, `20 行应长于 5 行（${a.seconds}s → ${b.seconds}s）`);
  // 多出的 15 行 × 76px/行 ÷ 40px/s = 28.5s —— 精确断言比"×3"更能反映公式
  const expectedDelta = (15 * 76) / 40;
  assert.ok(Math.abs((b.seconds - a.seconds) - expectedDelta) < 0.2,
    `时长增量应等于新增行高÷速度（实际 ${(b.seconds - a.seconds).toFixed(1)}s，期望 ${expectedDelta}s）`);

  const fast = overlay.estimateCreditsDuration({ lines: new Array(20), speed: 120 });
  assert.ok(fast.seconds < b.seconds, '速度越快时长越短');
  assert.ok(Math.abs(fast.seconds - b.seconds / 3) < 0.3, '速度 ×3 时长应 ≈ ÷3');
});

test('★ 实体一键填充：从选手实体填 name / avatar（A-REQ-502）', () => {
  reset();
  const created = entities.create({ kind: 'player', name: '填充测试选手', team: '队伍X', handle: 'HANDLE', image: '/media/abc.png', side: 'H' });
  assert.equal(created.ok, true);
  const r = overlay.fillFromEntity(created.entity.id, { template: T, target: 'main' });
  assert.equal(r.ok, true);
  assert.equal(r.filled.name, '填充测试选手');
  assert.equal(r.filled.avatar, '/media/abc.png');
  // 显式设置 currentPlayer（A-REQ-004）
  const cur = entities.getCurrent();
  assert.ok(cur, '选选手后 currentPlayer 应被显式设置');
  assert.equal(cur.playerName, '填充测试选手');
  assert.ok(cur.at > 0, '必须带时间戳以支持「快照」语义（A-REQ-306）');
  entities.remove(created.entity.id);
});

test('★ 非选手实体不设置 currentPlayer（A-REQ-004：禁止自动推断）', () => {
  reset();
  const sp = entities.create({ kind: 'sponsor', name: '某赞助商', tier: '金牌' });
  entities.clearCurrent();
  overlay.fillFromEntity(sp.entity.id, { template: 'thanksGrid' });
  assert.equal(entities.getCurrent(), null, '赞助商不应成为 currentPlayer');
  entities.remove(sp.entity.id);
});

test('填充不存在的实体返回明确错误', () => {
  const r = overlay.fillFromEntity('no-such-id', { template: T });
  assert.equal(r.ok, false);
  assert.equal(r.nack.code, 'unknown_entity');
});
