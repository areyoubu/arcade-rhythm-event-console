/**
 * 队伍归属 + 比赛模式 + 预览/输出分离。
 *
 * 这三块是用户明确新增的需求，且都属于「操作员会天天用、出错很难发现」的部分：
 *   · 队伍必须能选、能删且不留幽灵引用
 *   · 单人赛时要真的把队伍槽位清空（否则画面上会挂着上一个队的名字）
 *   · 预览绝不能影响直播（否则试排版会直接播出去）
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as overlay from '../server/overlay.js';
import * as entities from '../server/entities.js';
import * as templates from '../server/templates.js';
import { getConfig } from '../server/config.js';

const REAL_FILE = getConfig().entities.file;
const TMP_FILE = path.join('data', '_test-preview-team.json');
// 直接用内置模板：它已包含 teamName / teamAvatar 槽位。
// （不写 templates/custom/ —— 那会污染并行运行的其它测试进程）
const TEST_TPL = 'lowerThird';

before(() => {
  getConfig().entities.file = TMP_FILE;
  try { fs.writeFileSync(TMP_FILE, '[]\n'); } catch { /* ignore */ }
  entities.load();
  templates.load();

});

after(() => {
  try { fs.unlinkSync(TMP_FILE); } catch { /* ignore */ }
  try { fs.unlinkSync(`${TMP_FILE}.bak`); } catch { /* ignore */ }
  getConfig().entities.file = REAL_FILE;
  entities.load();
  templates.load();
});

function setMode(mode) {
  // 直接改内存里的配置对象（测试不走持久化路径）
  getConfig().competition = { mode };
}

function reset() {
  overlay.clear({ target: 'preview' });
  overlay.clear({ target: 'main' });
  for (const t of ['preview', 'main']) overlay.clearUndo(t);
}

// ─────────────────────────────────────────────────────────────
// 队伍
// ─────────────────────────────────────────────────────────────
test('★ 队伍可以创建、带名称与 Logo，也可以不设 Logo', () => {
  entities.load();
  const withLogo = entities.create({ kind: 'team', name: '有Logo队', image: '/media/team.png' });
  const noLogo = entities.create({ kind: 'team', name: '无Logo队' });
  assert.equal(withLogo.ok, true, JSON.stringify(withLogo.errors || {}));
  assert.equal(noLogo.ok, true);

  assert.equal(withLogo.entity.image, '/media/team.png');
  assert.equal(noLogo.entity.image, undefined, '不设 Logo 时不应造出一个空的 image 字段');

  const teamList = entities.teams();
  assert.ok(teamList.some((t) => t.name === '有Logo队'));
  assert.ok(teamList.some((t) => t.name === '无Logo队'));
});

test('★ 选手可以归属到队伍（teamId），并能解析出队伍名与 Logo', () => {
  const team = entities.create({ kind: 'team', name: '解析队', image: '/media/t2.png' }).entity;
  const p = entities.create({ kind: 'player', name: '队员甲', teamId: team.id });
  assert.equal(p.ok, true, JSON.stringify(p.errors || {}));

  const resolved = entities.resolveTeam(entities.get(p.entity.id));
  assert.equal(resolved.name, '解析队');
  assert.equal(resolved.image, '/media/t2.png');
  assert.equal(resolved.id, team.id);
});

test('★ 没有 Logo 的队伍也能正常解析（image 为空串，不是 undefined）', () => {
  const team = entities.create({ kind: 'team', name: '素队' }).entity;
  const p = entities.create({ kind: 'player', name: '素队队员', teamId: team.id }).entity;
  const r = entities.resolveTeam(entities.get(p.id));
  assert.equal(r.name, '素队');
  assert.equal(r.image, '', '空 Logo 应解析成空串，渲染端据此不显示 img');
});

test('★ 没有队伍归属的选手，resolveTeam 返回 null', () => {
  const p = entities.create({ kind: 'player', name: '自由人' }).entity;
  assert.equal(entities.resolveTeam(entities.get(p.id)), null);
});

test('★ 旧数据兼容：只有自由文本 team 字段的选手也能解析出队伍名', () => {
  const p = entities.create({ kind: 'player', name: '老数据选手', team: '老队伍' }).entity;
  const r = entities.resolveTeam(entities.get(p.id));
  assert.equal(r.name, '老队伍');
  assert.equal(r.image, '', '自由文本没有 Logo');
  assert.equal(r.id, null);
});

test('★ 不能把 teamId 指向一个非队伍实体', () => {
  const p = entities.create({ kind: 'player', name: '某人' }).entity;
  const r = entities.update(p.id, { teamId: p.id });
  assert.equal(r.ok, false);
  assert.ok(r.errors.teamId, '应指出 teamId 字段有问题');
});

test('★ 删除队伍会把成员解绑，并返回被解绑人数', () => {
  const team = entities.create({ kind: 'team', name: '待解散队' }).entity;
  const a = entities.create({ kind: 'player', name: '队员1', teamId: team.id }).entity;
  const b = entities.create({ kind: 'player', name: '队员2', teamId: team.id }).entity;

  const r = entities.removeWithRefs(team.id);
  assert.equal(r.ok, true);
  assert.equal(r.clearedMembers, 2);

  assert.equal(entities.get(team.id), null, '队伍应已删除');
  assert.equal(entities.get(a.id).teamId, undefined, '成员1 的 teamId 应被清空');
  assert.equal(entities.get(b.id).teamId, undefined, '成员2 的 teamId 应被清空');
  assert.equal(entities.resolveTeam(entities.get(a.id)), null, '解绑后不应再解析出队伍');
});

test('★ update 传 teamId: null 表示移出队伍', () => {
  const team = entities.create({ kind: 'team', name: '移出测试队' }).entity;
  const p = entities.create({ kind: 'player', name: '要移出的', teamId: team.id }).entity;
  assert.ok(entities.get(p.id).teamId);

  const r = entities.update(p.id, { teamId: null });
  assert.equal(r.ok, true);
  assert.equal(entities.get(p.id).teamId, undefined, 'teamId 字段应被删除而不是留 null');
});

// ─────────────────────────────────────────────────────────────
// 比赛模式
// ─────────────────────────────────────────────────────────────
test('★ 团队赛模式：填充时带上队伍名与 Logo', () => {
  reset();
  setMode('team');
  const team = entities.create({ kind: 'team', name: 'NEON队', image: '/media/neon.png' }).entity;
  const p = entities.create({ kind: 'player', name: '选手X', teamId: team.id }).entity;

  const r = overlay.fillFromEntity(p.id, { template: TEST_TPL, target: 'preview' });
  assert.equal(r.ok, true, JSON.stringify(r.nack || {}));
  assert.equal(r.filled.name, '选手X');
  assert.equal(r.filled.teamName, 'NEON队');
  assert.equal(r.filled.teamAvatar, '/media/neon.png');
});

test('★ 单人赛模式：队伍槽位必须被**清空**（否则画面会挂着上一个队）', () => {
  reset();
  // 先以团队赛填一次，让预览里已有队伍信息
  setMode('team');
  const team = entities.create({ kind: 'team', name: '残留队' }).entity;
  const p = entities.create({ kind: 'player', name: '选手Y', teamId: team.id }).entity;
  overlay.fillFromEntity(p.id, { template: TEST_TPL, target: 'preview' });
  assert.equal(overlay.getTarget('preview').slotValues.teamName, '残留队');

  // 切到单人赛再填
  setMode('solo');
  const r = overlay.fillFromEntity(p.id, { template: TEST_TPL, target: 'preview' });
  assert.equal(r.ok, true);
  assert.equal(r.filled.teamName, '', '单人赛必须把队伍名清空');
  assert.equal(r.filled.teamAvatar, '', '单人赛必须把队伍 Logo 清空');
  assert.equal(r.filled.name, '选手Y', '选手名照常显示');
});

test('★ 单人赛模式下没有队伍的人也不报错', () => {
  reset();
  setMode('solo');
  const p = entities.create({ kind: 'player', name: '散户' }).entity;
  const r = overlay.fillFromEntity(p.id, { template: TEST_TPL, target: 'preview' });
  assert.equal(r.ok, true);
  assert.equal(r.filled.teamName, '');
  assert.equal(r.filled.name, '散户');
});

// ─────────────────────────────────────────────────────────────
// 预览 / 输出分离
// ─────────────────────────────────────────────────────────────
test('★★ 预览上的操作绝不能影响直播输出', () => {
  reset();
  setMode('team');
  const tpl = templates.get('lowerThird');

  // 只推送到预览
  const r = overlay.show({ template: 'lowerThird', values: { name: '预览稿' }, target: 'preview' });
  assert.equal(r.ok, true, JSON.stringify(r.nack || {}));

  assert.equal(overlay.getTarget('preview').activeTemplate, tpl.id);
  assert.equal(overlay.getTarget('main').activeTemplate, null, '直播输出必须完全没变');
  assert.equal(overlay.getTarget('main').visible, false);
});

test('★★ commit 把预览内容一次性推到输出', () => {
  reset();
  overlay.show({ template: 'lowerThird', values: { name: '要播的', subtitle: '副标题' }, target: 'preview' });

  const r = overlay.commitPreview({ target: 'main' });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'show');

  const out = overlay.getTarget('main');
  assert.equal(out.activeTemplate, 'lowerThird');
  assert.equal(out.visible, true);
  assert.equal(out.slotValues.name, '要播的');
  assert.equal(out.slotValues.subtitle, '副标题');
});

test('★ commit 时预览是空的 → 输出也清空（所见即所得）', () => {
  reset();
  overlay.show({ template: 'lowerThird', values: { name: '先在播的' }, target: 'main' });
  assert.ok(overlay.getTarget('main').activeTemplate);

  overlay.clear({ target: 'preview' });
  const r = overlay.commitPreview({ target: 'main' });
  assert.equal(r.action, 'clear');
  assert.equal(overlay.getTarget('main').activeTemplate, null);
});

test('★ 预览里隐藏后再 commit，输出也应隐藏', () => {
  reset();
  overlay.show({ template: 'lowerThird', values: { name: 'X' }, target: 'main' });
  overlay.show({ template: 'lowerThird', values: { name: 'X' }, target: 'preview' });
  overlay.hide({ target: 'preview' });

  overlay.commitPreview({ target: 'main' });
  assert.equal(overlay.getTarget('main').activeTemplate, null, '预览不可见 → 输出清空');
});

test('★ revert 把直播输出的内容同步回预览', () => {
  reset();
  overlay.show({ template: 'lowerThird', values: { name: '正在播的' }, target: 'main' });
  overlay.clear({ target: 'preview' });

  overlay.revertPreview({ from: 'main' });
  const p = overlay.getTarget('preview');
  assert.equal(p.activeTemplate, 'lowerThird');
  assert.equal(p.slotValues.name, '正在播的');
  assert.equal(p.visible, true);
});

test('★ 预览与输出各自维护独立的 sent/rendered 状态（A-REQ-604）', () => {
  reset();
  overlay.show({ template: 'lowerThird', values: { name: 'A' }, target: 'preview' });
  overlay.markRendered('preview', 'lowerThird', Date.now());
  const pv = overlay.getTarget('preview');
  const out = overlay.getTarget('main');
  assert.ok(pv.renderedAt > 0);
  assert.equal(out.renderedAt, 0, '输出端的渲染状态不应被预览的操作改动');
});

test('★ 预览模式下可以直接隐藏直播输出，且不影响预览（常驻输出控制）', () => {
  reset();
  overlay.show({ template: 'lowerThird', values: { name: '要播的' }, target: 'preview' });
  overlay.commitPreview({ target: 'main' });
  assert.equal(overlay.getTarget('main').visible, true);

  // 操作员留在预览模式，直接对输出执行隐藏
  overlay.hide({ target: 'main' });
  assert.equal(overlay.getTarget('main').visible, false, '直播输出应已隐藏');
  assert.equal(overlay.getTarget('preview').visible, true, '预览必须保持可见');
  assert.equal(overlay.getTarget('main').activeTemplate, 'lowerThird', '隐藏保留内容，便于恢复');

  // 再次推送即可恢复
  overlay.commitPreview({ target: 'main' });
  assert.equal(overlay.getTarget('main').visible, true);
});

test('★ 隐藏输出后，预览的后续修改不会自动跟随到直播', () => {
  reset();
  overlay.show({ template: 'lowerThird', values: { name: 'A' }, target: 'preview' });
  overlay.commitPreview({ target: 'main' });
  overlay.hide({ target: 'main' });

  overlay.update('name', 'B', { target: 'preview' });
  assert.equal(overlay.getTarget('main').slotValues.name, 'A', '直播输出不应跟着预览变');
  assert.equal(overlay.getTarget('main').visible, false);
});
