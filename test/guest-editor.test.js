/**
 * 共用签到编辑器 / 删除确认（ui.guestEditor / ui.deleteGuest）。
 *
 * 抽奖页和签到管理页共用同一套逻辑，这里用真实 DOM 点击钉住：
 *   · 新增走 POST /api/lottery/guests，并补拉 state；
 *   · 编辑走 PUT /api/lottery/guests/:id；
 *   · 删除必须二次确认，DELETE 后把 state 交回页面；
 *   · 取消删除不发请求。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const UI_SRC = fs.readFileSync(path.join('public', 'shared', 'ui.js'), 'utf8');

function makeWindow() {
  const calls = [];
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.fmt = { escapeHtml: (s) => String(s) };
  w.arcadeWS = { state: {}, connected: false, on() {}, start() {}, cmd: async () => null };
  w.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method, body });
    const reply = (data) => ({ ok: true, status: 200, json: async () => data });

    if (url === '/api/lottery/guests' && method === 'POST') {
      return reply({ ok: true, guest: { id: 'g-new', name: body.name }, ticket: 8 });
    }
    if (url === '/api/lottery/state') {
      return reply({ ok: true, state: { guests: [{ id: 'g-new', name: body?.name || '丙', ticket: 8 }] } });
    }
    if (url.startsWith('/api/lottery/guests/') && method === 'PUT') {
      return reply({ ok: true, state: { guests: [{ id: 'g1', name: body.name }] } });
    }
    if (url.startsWith('/api/lottery/guests/') && method === 'DELETE') {
      return reply({ ok: true, state: { guests: [] } });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  };
  w.eval(UI_SRC);
  return { w, calls };
}

function clickButton(w, text) {
  const btn = [...w.document.querySelectorAll('.modal button')].find((b) => b.textContent === text);
  assert.ok(btn, `找不到按钮：${text}`);
  btn.click();
  return btn;
}

async function waitFor(fn, ms = 2500, label = '') {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > ms) throw new Error(`超时：${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('★ 新增签到：填写三个人字段，POST 后补拉 state', async () => {
  const { w, calls } = makeWindow();
  let saved = null;
  w.ui.guestEditor(null, { onSaved: (r) => { saved = r; } });

  const inputs = [...w.document.querySelectorAll('.modal input')];
  assert.equal(inputs.length, 3, '姓名 / 昵称 / 队伍三个输入框');
  inputs[0].value = '丙';
  inputs[1].value = 'bing';
  inputs[2].value = '蓝队';

  clickButton(w, '加入签到池');
  await waitFor(() => saved, 2500, '保存回调');

  const post = calls.find((c) => c.method === 'POST');
  assert.ok(post, '必须发出 POST');
  assert.deepEqual(post.body, { name: '丙', handle: 'bing', team: '蓝队' });
  assert.ok(calls.some((c) => c.url === '/api/lottery/state'), '接口没返回 state 时应补拉');
  assert.equal(saved.state.guests[0].name, '丙');
  assert.equal(w.document.querySelector('.modal-back'), null, '保存后弹窗关闭');
});

test('★ 编辑签到：显示来源和序号，走 PUT', async () => {
  const { w, calls } = makeWindow();
  let saved = null;
  w.ui.guestEditor(
    { id: 'g1', name: '甲', handle: 'a1', team: '红队', source: 'join', ticket: 3 },
    { sourceLabels: { join: '扫码' }, onSaved: (r) => { saved = r; } },
  );

  assert.match(w.document.querySelector('.modal').textContent, /来源：扫码 · 签到序号 #3/);
  const inputs = [...w.document.querySelectorAll('.modal input')];
  inputs[0].value = '甲改';
  clickButton(w, '保存修改');
  await waitFor(() => saved, 2500, '保存回调');

  const put = calls.find((c) => c.method === 'PUT');
  assert.ok(put, '必须发出 PUT');
  assert.equal(put.url, '/api/lottery/guests/g1');
  assert.equal(put.body.name, '甲改');
  assert.equal(saved.state.guests[0].name, '甲改');
});

test('★★ 删除签到：必须二次确认，取消不发请求', async () => {
  const { w, calls } = makeWindow();
  let deleted = null;

  const pending = w.ui.deleteGuest(
    { id: 'g1', name: '甲' },
    { isWinner: true, onDeleted: (r) => { deleted = r; } },
  );
  assert.match(w.document.querySelector('.modal').textContent, /已中奖/);
  clickButton(w, '取消');
  assert.equal(await pending, false);
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0, '取消后不得发 DELETE');

  const okPending = w.ui.deleteGuest(
    { id: 'g1', name: '甲' },
    { isWinner: true, onDeleted: (r) => { deleted = r; } },
  );
  clickButton(w, '删除');
  assert.equal(await okPending, true);
  await waitFor(() => deleted, 2500, '删除回调');
  const del = calls.find((c) => c.method === 'DELETE');
  assert.equal(del.url, '/api/lottery/guests/g1');
  assert.deepEqual(deleted.state.guests, []);
});
