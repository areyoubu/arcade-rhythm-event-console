/**
 * WS 广播中枢测试 —— 对应 S-REQ-101 / 102 / 103 / 106 / 109、G-REQ-112。
 *
 * 这里守的主要是「同一个 patch 只广播一次」这条不变量：
 * 服务同时监听两个端口（SRS §2.1 的 :3000 / :3001），早期把共享事件订阅写在
 * 每个端口的 attach() 里，导致消息翻倍、心跳定时器泄漏。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import * as hub from '../server/ws-hub.js';
import { stateEvents } from '../server/state.js';
import { getConfig } from '../server/config.js';

// 真实 config.json 可能已设置后台密码；WS 鉴权会让这些「不带 token」的用例全部 nack。
// 本文件只测广播协议，先把鉴权关掉，结束后复原。
const REAL_HASH = getConfig().server?.adminPasswordHash ?? '';
delete process.env.LP_ADMIN_TOKEN;
getConfig().server.adminPasswordHash = '';
after(() => { getConfig().server.adminPasswordHash = REAL_HASH; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起两个端口（模拟 overlay + control），返回一个已握手的客户端与收到的消息数组 */
async function withTwoPorts(fn) {
  const app = () => http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  const s1 = app();
  const s2 = app();
  hub.attach(s1, { path: '/ws' });
  hub.attach(s2, { path: '/ws' });
  await new Promise((r) => s1.listen(0, '127.0.0.1', r));
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));

  const p1 = s1.address().port;
  const p2 = s2.address().port;

  const sock = new WebSocket(`ws://127.0.0.1:${p1}/ws`);
  const msgs = [];
  sock.on('message', (raw) => { try { msgs.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
  await new Promise((r) => sock.on('open', r));
  await sleep(120);

  try {
    await fn({ msgs, sock, p1, p2 });
  } finally {
    try { sock.close(); } catch { /* ignore */ }
    await new Promise((r) => s1.close(r));
    await new Promise((r) => s2.close(r));
    hub.closeAll();
  }
}

test('★ 连接后立即收到 hello 全量状态（S-REQ-101）', async () => {
  await withTwoPorts(async ({ msgs, sock }) => {
    sock.send(JSON.stringify({ t: 'client:hello', audience: 'director' }));
    await sleep(250);
    const hello = msgs.find((m) => m.t === 'hello');
    assert.ok(hello, '必须收到 hello');
    assert.ok(hello.state, 'hello 必须携带全量状态');
    assert.ok(hello.state.health, '状态里必须有 health');
    assert.ok(hello.state.replay, '状态里必须有 replay');
    assert.ok(hello.state.overlay, '状态里必须有 overlay');
  });
});

test('★ 两个端口时，一条 patch 只广播一次（回归：曾因 attach 被调两次而翻倍）', async () => {
  await withTwoPorts(async ({ msgs, sock }) => {
    sock.send(JSON.stringify({ t: 'client:hello', audience: 'director' }));
    await sleep(250);
    msgs.length = 0;

    stateEvents.emit('patch', 'replay.testPath', 42);
    await sleep(300);

    const hits = msgs.filter((m) => m.t === 'patch' && m.path === 'replay.testPath');
    assert.equal(hits.length, 1, `同一条 patch 必须只下发一次，实际 ${hits.length} 次`);
    assert.equal(hits[0].value, 42);
  });
});

test('★ hello 之后不得再回放历史 patch（否则会用旧增量盖掉新快照）', async () => {
  await withTwoPorts(async ({ msgs, sock }) => {
    // 在客户端接入之前先制造一些历史 patch
    stateEvents.emit('patch', 'replay.stalePath', 'old-value');
    await sleep(150);

    msgs.length = 0;
    sock.send(JSON.stringify({ t: 'client:hello', audience: 'director' }));
    await sleep(300);

    const stale = msgs.filter((m) => m.t === 'patch' && m.path === 'replay.stalePath');
    assert.equal(stale.length, 0,
      'hello 是权威全量快照，不得再回放 30s 内的旧 patch —— 否则新连接会被旧值覆盖');
  });
});

test('★ cmd 必须回 ack，未注册的 op 回 nack（S-REQ-103）', async () => {
  await withTwoPorts(async ({ msgs, sock }) => {
    sock.send(JSON.stringify({ t: 'client:hello', audience: 'director' }));
    await sleep(200);
    msgs.length = 0;

    hub.registerOp('test.echo', (_c, args) => ({ echoed: args }));
    sock.send(JSON.stringify({ t: 'cmd', id: 'c1', op: 'test.echo', args: { x: 1 } }));
    await sleep(250);

    const ack = msgs.find((m) => m.t === 'ack' && m.id === 'c1');
    assert.ok(ack, '必须回 ack');
    assert.deepEqual(ack.data, { echoed: { x: 1 } });

    msgs.length = 0;
    sock.send(JSON.stringify({ t: 'cmd', id: 'c2', op: 'definitely.not.registered' }));
    await sleep(250);
    const nack = msgs.find((m) => m.t === 'nack' && m.id === 'c2');
    assert.ok(nack, '未知 op 必须回 nack');
    assert.equal(nack.code, 'unknown_op');
  });
});

test('★★ 启用后台密码后：WS 命令不带 token 一律 nack unauthorized，带 token 才 ack', async () => {
  const { hashPassword } = await import('../server/admin-auth.js');
  getConfig().server.adminPasswordHash = hashPassword('WsTestPass123');
  try {
    await withTwoPorts(async ({ msgs, sock }) => {
      hub.registerOp('test.wsAuth', (_c, args) => ({ ok: true, args }));
      sock.send(JSON.stringify({ t: 'client:hello', audience: 'director' }));
      await sleep(200);
      msgs.length = 0;

      sock.send(JSON.stringify({ t: 'cmd', id: 'ca1', op: 'test.wsAuth' }));
      await sleep(250);
      const denied = msgs.find((m) => m.t === 'nack' && m.id === 'ca1');
      assert.ok(denied, '无 token 的 WS 命令必须被拒绝');
      assert.equal(denied.code, 'unauthorized');

      msgs.length = 0;
      sock.send(JSON.stringify({ t: 'client:hello', audience: 'director', token: 'WsTestPass123' }));
      await sleep(150);
      sock.send(JSON.stringify({ t: 'cmd', id: 'ca2', op: 'test.wsAuth', args: { x: 2 } }));
      await sleep(250);
      const ack = msgs.find((m) => m.t === 'ack' && m.id === 'ca2');
      assert.ok(ack, '带正确 token 后应 ack');
      assert.deepEqual(ack.data, { ok: true, args: { x: 2 } });
    });
  } finally {
    getConfig().server.adminPasswordHash = '';
  }
});

test('cmd 处理器返回 { __nack } 时转成 nack 而不是 ack', async () => {
  await withTwoPorts(async ({ msgs, sock }) => {
    sock.send(JSON.stringify({ t: 'client:hello', audience: 'director' }));
    await sleep(200);
    msgs.length = 0;

    hub.registerOp('test.fail', () => ({ __nack: 'busy', msg: '正忙' }));
    sock.send(JSON.stringify({ t: 'cmd', id: 'c3', op: 'test.fail' }));
    await sleep(250);

    const nack = msgs.find((m) => m.t === 'nack' && m.id === 'c3');
    assert.ok(nack);
    assert.equal(nack.code, 'busy');
    assert.equal(nack.msg, '正忙');
  });
});

test('★ cmd 处理器抛出的异常被转成 nack，且不影响后续消息（B-REQ-5110 / G-REQ-112）', async () => {
  await withTwoPorts(async ({ msgs, sock }) => {
    sock.send(JSON.stringify({ t: 'client:hello', audience: 'director' }));
    await sleep(200);
    msgs.length = 0;

    hub.registerOp('test.throw', () => { throw Object.assign(new Error('炸了'), { code: 'boom' }); });
    sock.send(JSON.stringify({ t: 'cmd', id: 'c4', op: 'test.throw' }));
    await sleep(250);
    const nack = msgs.find((m) => m.t === 'nack' && m.id === 'c4');
    assert.ok(nack, '抛异常必须回 nack 而不是静默');
    assert.equal(nack.code, 'boom');

    // 连接仍然可用
    msgs.length = 0;
    sock.send(JSON.stringify({ t: 'cmd', id: 'c5', op: 'test.echo', args: 'ok' }));
    await sleep(250);
    assert.ok(msgs.find((m) => m.t === 'ack' && m.id === 'c5'), '异常之后连接仍必须可用');
  });
});

test('★ 受众过滤：只发给 cast 的消息不会到达 director 客户端（S-REQ-106）', async () => {
  await withTwoPorts(async ({ msgs, sock }) => {
    sock.send(JSON.stringify({ t: 'client:hello', audience: 'director' }));
    await sleep(200);
    msgs.length = 0;

    hub.toAudience(['cast'], { t: 'cue', cue: { id: 'x', title: '只给解说' } });
    await sleep(250);
    assert.equal(msgs.filter((m) => m.t === 'cue').length, 0, 'director 不得收到 cast 的提示');

    hub.toAudience(['director'], { t: 'cue', cue: { id: 'y', title: '给导播' } });
    await sleep(250);
    assert.equal(msgs.filter((m) => m.t === 'cue').length, 1, '给 director 的必须收到');
  });
});

test('★ cue.active 不下发 patch —— 防止现场页看到别的受众的提示内容', async () => {
  await withTwoPorts(async ({ msgs, sock }) => {
    sock.send(JSON.stringify({ t: 'client:hello', audience: 'floor' }));
    await sleep(200);
    msgs.length = 0;

    stateEvents.emit('patch', 'cue.active', { secret: { title: '导播专用提示' } });
    await sleep(250);

    const leaked = msgs.filter((m) => m.t === 'patch' && m.path === 'cue.active');
    assert.equal(leaked.length, 0,
      'cue.active 是跨受众的完整集合，整体下发会泄漏；各受众的可见集由 cue:set 单独推送');
  });
});

test('未指定受众的连接（尚未 client:hello）不会收到定向消息，但能收到 hello', async () => {
  await withTwoPorts(async ({ msgs }) => {
    await sleep(200);
    assert.equal(msgs.filter((m) => m.t === 'hello').length, 0, '未发 client:hello 前不应收到 hello');

    hub.toAudience(['director'], { t: 'cue', cue: { id: 'z' } });
    await sleep(150);
    assert.equal(msgs.filter((m) => m.t === 'cue').length, 0, '未声明受众的连接不应收到定向消息');
  });
});

test('★ 渲染端只收 overlay.* 相关 patch，不收无关状态（省带宽、避免无关重绘）', async () => {
  await withTwoPorts(async ({ msgs, sock }) => {
    sock.send(JSON.stringify({ t: 'client:hello', target: 'main' }));
    sock.send(JSON.stringify({ t: 'overlay:ready', target: 'main' }));
    await sleep(250);
    msgs.length = 0;

    stateEvents.emit('patch', 'replay.positionMs', 1234);       // 渲染端不关心
    stateEvents.emit('patch', 'overlay.mode', 'replay');         // 渲染端关心
    await sleep(300);

    assert.equal(msgs.filter((m) => m.t === 'patch' && m.path === 'replay.positionMs').length, 0,
      '渲染端不应收到回放状态');
    assert.equal(msgs.filter((m) => m.t === 'patch' && m.path === 'overlay.mode').length, 1,
      '渲染端必须收到 overlay.mode');
  });
});

test('toRenderers 可以按 target 精确投递', async () => {
  await withTwoPorts(async ({ msgs, sock }) => {
    sock.send(JSON.stringify({ t: 'overlay:ready', target: 'credits' }));
    await sleep(200);
    msgs.length = 0;

    hub.toRenderers({ t: 'only-main' }, 'main');
    await sleep(150);
    assert.equal(msgs.filter((m) => m.t === 'only-main').length, 0, 'credits 实例不应收到发给 main 的消息');

    hub.toRenderers({ t: 'only-credits' }, 'credits');
    await sleep(150);
    assert.equal(msgs.filter((m) => m.t === 'only-credits').length, 1);
  });
});
