/**
 * 提示引擎测试 —— 对应 C-REQ-502 / 503 / 504 / 506 / 550~556 / 840 / 1101。
 * 这些是「导播以为解说收到了，实际没有」类事故的防线。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  publish, cancel, forceClear, clearAll, visibleFor, getActive, getCue,
  ack, interpolate, cueTemplates, queryHistory, clearByTag, BUILTIN_CUE_TEMPLATES,
} from '../server/cue/engine.js';

function cleanup() { clearAll('test-cleanup'); }

test('发布与查询：ID 唯一，active 中可查', () => {
  cleanup();
  const { cueId } = publish({ title: '测试提示', priority: 'P2', audience: ['director'] });
  assert.ok(cueId);
  assert.ok(getCue(cueId));
  assert.equal(getCue(cueId).title, '测试提示');
  cleanup();
});

test('★ C-REQ-506：重复下发同一 id 必须幂等', () => {
  cleanup();
  const a = publish({ id: 'fixed-id-1', title: '第一次', priority: 'P2', audience: ['cast'] });
  const b = publish({ id: 'fixed-id-1', title: '第二次', priority: 'P0', audience: ['floor'] });
  assert.equal(a.cueId, b.cueId);
  assert.equal(getActive().length, 1, '不得产生第二条');
  assert.equal(getCue('fixed-id-1').title, '第一次', '首次内容保留');
  cleanup();
});

test('★ C-REQ-551：P0 强制 requiresAck，即使调用方没要求', () => {
  cleanup();
  const { cueId } = publish({ title: 'P0 告警', priority: 'P0', audience: ['director'] });
  assert.equal(getCue(cueId).requiresAck, true);
  cleanup();
});

test('非 P0 时 requiresAck 跟随调用方', () => {
  cleanup();
  const { cueId: a } = publish({ title: 'A', priority: 'P2', audience: ['cast'] });
  assert.equal(getCue(a).requiresAck, false);
  cleanup();
  const { cueId: b } = publish({ title: 'B', priority: 'P2', audience: ['cast'], requiresAck: true });
  assert.equal(getCue(b).requiresAck, true);
  cleanup();
});

test('★ C-REQ-502/503：优先级仲裁 —— 每级最多 maxVisible 条，高优先级先占位', () => {
  cleanup();
  const a = publish({ title: 'P3-1', priority: 'P3', audience: ['cast'] }).cueId;
  const b = publish({ title: 'P3-2', priority: 'P3', audience: ['cast'] }).cueId;
  const c = publish({ title: 'P1', priority: 'P1', audience: ['cast'] }).cueId;
  const d = publish({ title: 'P0', priority: 'P0', audience: ['cast'] }).cueId;

  const visible = visibleFor('cast').map((x) => x.id);
  assert.ok(visible.includes(d), 'P0 必须在可见集里');
  assert.ok(visible.includes(c), 'P1 必须在可见集里');
  assert.equal(visible.filter((id) => id === a || id === b).length, 2, 'P3 配额为 5，两条都应可见');
  // P0/P1 各只有 1 条时不会被挤掉
  assert.equal(visible.filter((id) => id === d).length, 1);
  cleanup();
});

test('★ C-REQ-502：同级超出配额时被折叠（不进入可见集，但仍在 active 中）', () => {
  cleanup();
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(publish({ title: `P2-${i}`, priority: 'P2', audience: ['cast'] }).cueId);
  const visible = visibleFor('cast').map((x) => x.id);
  assert.equal(visible.filter((id) => ids.includes(id)).length, 2, 'P2 配额默认 2');
  assert.equal(getActive().filter((x) => ids.includes(x.id)).length, 4, '被折叠的仍在活跃集中，等高位清除后会自动浮上来');
  cleanup();
});

test('★ 提示按受众隔离（cast 只看到发给 cast 的）', () => {
  cleanup();
  const p0 = publish({ title: 'C-P0', priority: 'P0', audience: ['cast'] }).cueId;
  const p3 = publish({ title: 'C-P3', priority: 'P3', audience: ['cast'] }).cueId;
  const visible = visibleFor('cast').map((x) => x.id);
  assert.ok(visible.includes(p0));
  assert.ok(visible.includes(p3), '默认配额下 P3 也应可见');
  assert.equal(visibleFor('director').length, 0, 'director 不应看到 cast 的提示');
  cleanup();
});

test('★ C-REQ-106：受众隔离 —— 两个受众互不可见对方的提示', () => {
  cleanup();
  const d = publish({ title: '只给导播', priority: 'P0', audience: ['director'] }).cueId;
  const c = publish({ title: '只给解说', priority: 'P0', audience: ['cast'] }).cueId;
  assert.ok(!visibleFor('cast').map((x) => x.id).includes(d), 'cast 不得收到 director 的提示');
  assert.ok(!visibleFor('director').map((x) => x.id).includes(c), 'director 不得收到 cast 的提示');
  cleanup();
});

test('★ C-REQ-504：ttlMs=null 表示须显式清除，不会被自动过期', () => {
  cleanup();
  const { cueId } = publish({ title: '常驻', priority: 'P3', audience: ['director'], ttlMs: null });
  assert.equal(getCue(cueId).ttlMs, null);
  assert.ok(getCue(cueId), '不应因 TTL 过期而被移除');
  cleanup();
});

test('★ C-REQ-556：强制清除可无视未 ack 直接删除', () => {
  cleanup();
  const { cueId } = publish({ title: '需要回执', priority: 'P0', audience: ['cast'] });
  assert.ok(getCue(cueId));
  const r = forceClear(cueId);
  assert.equal(r.ok, true);
  assert.equal(getCue(cueId), undefined, '强制清除后必须不存在');
  cleanup();
});

test('★ C-REQ-554：ack 记录时间戳；对不存在的提示 ack 返回明确 nack', () => {
  cleanup();
  const { cueId } = publish({ title: '待确认', priority: 'P0', audience: ['cast'] });
  const ok = ack(cueId, 'client-1');
  assert.equal(ok.ok, true);
  assert.ok(getCue(cueId).acks['client-1'] > 0, '必须记录 ack 时间戳');

  const bad = ack('no-such-cue', 'client-1');
  assert.equal(bad.ok, false);
  assert.equal(bad.nack.code, 'not_found');
  cleanup();
});

test('★ 按 tag 批量清除（C-REQ-592/595 的回放常驻提示用）', () => {
  cleanup();
  publish({ title: '回放中', priority: 'P3', audience: ['cast'], tag: 'replay-persistent' });
  publish({ title: '回放中2', priority: 'P3', audience: ['cast'], tag: 'replay-persistent' });
  publish({ title: '无关', priority: 'P3', audience: ['cast'], tag: 'other' });
  const n = clearByTag('replay-persistent');
  assert.equal(n, 2);
  assert.equal(getActive().length, 1);
  cleanup();
});

test('★ C-REQ-510：历史可检索', () => {
  cleanup();
  const { cueId } = publish({ title: '历史项', priority: 'P1', audience: ['cast'] });
  cancel(cueId, 'dismissed');
  const hist = queryHistory({ audience: 'cast' });
  assert.ok(hist.some((h) => h.title === '历史项'), '移除后的提示必须进入历史');
  const byPriority = queryHistory({ priority: 'P1' });
  assert.ok(byPriority.some((h) => h.title === '历史项'));
  cleanup();
});

test('★ C-REQ-1101：话术模板的变量插值', () => {
  assert.equal(interpolate('回放 {n}s 结束，准备接话', { n: 8 }), '回放 8s 结束，准备接话');
  assert.equal(interpolate('{选手名} 准备上场', { 选手名: '选手A' }), '选手A 准备上场');
  assert.equal(interpolate('即将进入 {场景名}', { 场景名: 'REPLAY' }), '即将进入 REPLAY');
  // 未知变量原样保留（便于发现模板写错）
  assert.equal(interpolate('T-{n}s / {未知}', { n: 5 }), 'T-5s / {未知}');
  // 不改动没有变量的文本
  assert.equal(interpolate('技术暂停', {}), '技术暂停');
});

test('★ 附录 E 的 14 条内置话术必须齐全，且字段完整', () => {
  const tpls = cueTemplates();
  assert.equal(BUILTIN_CUE_TEMPLATES.length, 14);
  const ids = tpls.map((t) => t.id);
  for (const id of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11', 'T12', 'T13', 'T14']) {
    assert.ok(ids.includes(id), `缺少话术模板 ${id}`);
  }
  for (const t of BUILTIN_CUE_TEMPLATES) {
    assert.ok(t.name && t.template && Array.isArray(t.audience) && t.priority && t.sound, `${t.id} 字段不完整`);
    assert.ok(['director', 'cast', 'floor'].some((a) => t.audience.includes(a)), `${t.id} 受众非法`);
  }
  // 附录 E 明确要求 ack 的两条
  assert.equal(BUILTIN_CUE_TEMPLATES.find((t) => t.id === 'T8').requiresAck, true);
  assert.equal(BUILTIN_CUE_TEMPLATES.find((t) => t.id === 'T12').requiresAck, true);
  assert.equal(BUILTIN_CUE_TEMPLATES.find((t) => t.id === 'T12').priority, 'P0');
});

test('未登记的受众频道被保留（C-REQ-001 允许扩展），但会记日志', () => {
  cleanup();
  const { cueId } = publish({ title: '自定义受众', priority: 'P2', audience: ['custom-channel'] });
  assert.deepEqual(getCue(cueId).audience, ['custom-channel']);
  cleanup();
});

test('优先级非法值回落到 P2，不抛异常', () => {
  cleanup();
  const { cueId } = publish({ title: 'x', priority: 'P9', audience: ['cast'] });
  assert.equal(getCue(cueId).priority, 'P2');
  cleanup();
  const { cueId: c2 } = publish({ title: 'y', priority: undefined, audience: ['cast'] });
  assert.equal(getCue(c2).priority, 'P2');
  cleanup();
});
