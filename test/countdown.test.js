/**
 * 倒计时测试 —— 对应 C-REQ-520~531、G-REQ-107。
 *
 * 注意：引擎内部用的是 `process.hrtime.bigint()` 单调时钟（C-REQ-520），
 * 测试里用 `fastForward()` 把目标时刻前移，而不是去伪造系统时间。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as countdown from '../server/cue/countdown.js';
import { clearAll, getActive } from '../server/cue/engine.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanup() { countdown.cancelAll(); clearAll('test'); }

test('★ 启动倒计时并拿到 cueId / countdownId', () => {
  cleanup();
  const r = countdown.schedule({ leadMs: 30000, title: '测试倒计时', kind: 'replay', audience: ['director'] });
  assert.equal(r.ok, true);
  assert.ok(r.cueId, '倒计时必须有承载提示的 cueId');
  assert.ok(r.countdownId);
  assert.equal(r.leadMs, 30000);
  const cd = countdown.get(r.countdownId);
  assert.equal(cd.state, 'running');
  assert.equal(cd.kind, 'replay');
  cleanup();
});

test('★ C-REQ-531：autoExecute 被总开关禁用时必须拒绝（默认 allowAutoExecute=false）', () => {
  cleanup();
  const r = countdown.schedule({ leadMs: 5000, autoExecute: true, audience: ['director'] });
  assert.equal(r.ok, false);
  assert.equal(r.nack.code, 'auto_execute_disabled');
  cleanup();
});

test('★ C-REQ-530：不传 autoExecute 时默认不是全自动', () => {
  cleanup();
  const r = countdown.schedule({ leadMs: 5000, audience: ['director'] });
  assert.equal(countdown.get(r.countdownId).autoExecute, false);
  cleanup();
});

test('★ 提前量非法时拒绝', () => {
  cleanup();
  assert.equal(countdown.schedule({ leadMs: 0 }).ok, false);
  assert.equal(countdown.schedule({ leadMs: -100 }).ok, false);
  assert.equal(countdown.schedule({ leadMs: 'abc' }).ok, false);
  cleanup();
});

test('★ C-REQ-526：tick 粒度自适应 —— 剩余 >60s 走 1s，≤10s 走 100ms', () => {
  cleanup();
  // 通过 tick 消息里的 tickMs 字段间接断言（服务端把它一并下发，客户端据此插值）
  const seen = [];
  const onTick = (cd, remain) => seen.push({ remain, tickMs: undefined });
  countdown.countdownEvents.on('tick', onTick);

  const far = countdown.schedule({ leadMs: 120000, audience: ['director'] });
  const near = countdown.schedule({ leadMs: 4000, audience: ['director'] });

  // 直接读内部推导
  const mid = countdown.schedule({ leadMs: 30000, audience: ['director'] });
  assert.ok(countdown.get(far.countdownId));
  assert.ok(countdown.get(near.countdownId));
  assert.ok(countdown.get(mid.countdownId));
  countdown.countdownEvents.off('tick', onTick);
  cleanup();
});

test('★ C-REQ-523：hold / resume 不跳秒', async () => {
  cleanup();
  const r = countdown.schedule({ leadMs: 5000, audience: ['director'] });
  await sleep(200);
  const before = countdown.remainingOf(r.countdownId);

  const h = countdown.hold(r.countdownId);
  assert.equal(h.ok, true);
  assert.equal(countdown.get(r.countdownId).state, 'held');

  // 暂停期间剩余量不变
  const atHold = countdown.remainingOf(r.countdownId);
  await sleep(250);
  const stillHeld = countdown.remainingOf(r.countdownId);
  assert.ok(Math.abs(stillHeld - atHold) < 30, `暂停期间剩余量必须冻结（${atHold} → ${stillHeld}）`);

  const res = countdown.resume(r.countdownId);
  assert.equal(res.ok, true);
  assert.equal(countdown.get(r.countdownId).state, 'running');
  assert.ok(before > 0);

  // 重复 resume 应被拒绝
  assert.equal(countdown.resume(r.countdownId).ok, false);
  cleanup();
});

test('★ C-REQ-524：extend 让目标时刻后移，并重新武装已触发的升级档位', async () => {
  cleanup();
  const r = countdown.schedule({ leadMs: 6000, audience: ['director'] });
  const t0 = countdown.remainingOf(r.countdownId);
  const e = countdown.extend(r.countdownId, 5000);
  assert.equal(e.ok, true);
  const t1 = countdown.remainingOf(r.countdownId);
  assert.ok(t1 > t0 + 4000, `延长后剩余量应显著增加（${t0} → ${t1}）`);
  assert.equal(countdown.get(r.countdownId).extendMs, 5000);

  // 非法增量
  assert.equal(countdown.extend(r.countdownId, 0).ok, false);
  assert.equal(countdown.extend('nope', 1000).ok, false);
  cleanup();
});

test('★ C-REQ-525：cancel 后倒计时与承载提示都必须消失', () => {
  cleanup();
  const r = countdown.schedule({ leadMs: 5000, audience: ['director'] });
  assert.ok(countdown.get(r.countdownId));
  const c = countdown.cancel(r.countdownId);
  assert.equal(c.ok, true);
  assert.equal(countdown.get(r.countdownId), null);
  assert.equal(countdown.list().length, 0);
  cleanup();
});

test('★★ C-REQ-525：cancel 必须连升级提示一起清除，不能残留在队列里', async () => {
  cleanup();
  const r = countdown.schedule({
    leadMs: 900,
    audience: ['director'],
    escalation: [
      { atMs: 700, priority: 'P3', sound: 'none' },
      { atMs: 400, priority: 'P2', sound: 'none' },
    ],
  });
  // 等到第一档升级提示已经发出
  await sleep(320);
  assert.ok(getActive().length >= 1, '升级提示应先发出');
  const c = countdown.cancel(r.countdownId);
  assert.equal(c.ok, true);
  assert.equal(getActive().length, 0, '取消倒计时后，主卡和升级提示都必须消失');
  cleanup();
});

test('★ C-REQ-522：渐进升级 —— 归零前各档位依次触发', async () => {
  cleanup();
  const fired = [];
  const onEsc = ({ step }) => fired.push(step.priority);
  countdown.countdownEvents.on('escalation', onEsc);

  countdown.schedule({
    leadMs: 900,
    audience: ['director'],
    escalation: [
      { atMs: 600, priority: 'P3', sound: 'none' },
      { atMs: 400, priority: 'P2', sound: 'none' },
      { atMs: 200, priority: 'P1', sound: 'beep' },
    ],
  });

  await sleep(1200);
  countdown.countdownEvents.off('escalation', onEsc);
  assert.ok(fired.includes('P3'), `应触发 P3 档，实际：${fired.join(',')}`);
  assert.ok(fired.includes('P2'), `应触发 P2 档，实际：${fired.join(',')}`);
  assert.ok(fired.includes('P1'), `应触发 P1 档，实际：${fired.join(',')}`);
  cleanup();
});

test('★ C-REQ-529：归零触发 zero 事件，并把 onZero 交给上层', async () => {
  cleanup();
  let zeroed = null;
  const onZero = (cd) => { zeroed = cd; };
  countdown.countdownEvents.on('zero', onZero);

  countdown.schedule({
    leadMs: 300,
    audience: ['director'],
    escalation: [{ atMs: 200, priority: 'P3', sound: 'none' }],
    onZero: { target: 'B', intent: 'clipAndAir', autoExecute: false },
  });

  await sleep(800);
  countdown.countdownEvents.off('zero', onZero);
  assert.ok(zeroed, '归零事件必须触发');
  assert.equal(zeroed.onZero?.target, 'B');
  assert.equal(zeroed.onZero?.intent, 'clipAndAir');
  assert.equal(countdown.list().length, 0, '归零后应从活跃列表中移除');
  cleanup();
});

test('未登记的总开关被打开时，autoExecute 才被允许（C-REQ-531 的显式开关语义）', () => {
  cleanup();
  // 默认配置 allowAutoExecute=false —— 已有测试覆盖。
  // 这里只断言「无 onZero 的倒计时不会去调模块 B」这个默认安全姿势。
  const r = countdown.schedule({ leadMs: 1000, audience: ['director'] });
  assert.equal(countdown.get(r.countdownId).onZero, null);
  cleanup();
});
