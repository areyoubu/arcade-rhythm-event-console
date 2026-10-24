/**
 * 通用输入弹窗（ui.prompt）—— 回归测试。
 *
 * 背景：`modal.close()` 会**同步**调用 onClose。早期实现写成
 * `m.close(); resolve(input.value)`，于是 onClose 里的 `resolve(null)` 先兑现，
 * 「点确定」永远返回 null。表现为：
 *   · 话术库点「试发」→ 填了变量 → 什么都没发生（根本没有发出请求）
 *   · 导播页快速提示 → 选完选项 → 提示发不出去，解说页毫无反应
 *
 * 这个 bug 没有抛错、没有日志，只是「点了没反应」，最难从现场反馈里定位，
 * 所以必须用真实的 DOM 点击把它钉住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const UI_SRC = fs.readFileSync(path.join('public', 'shared', 'ui.js'), 'utf8');

function makeWindow() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  // ui.js 依赖的全局
  w.fmt = { escapeHtml: (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) };
  w.arcadeWS = { state: {}, connected: false, on() {}, start() {}, cmd: async () => null };
  w.eval(UI_SRC);
  return w;
}

test('★★ 点「确定」必须拿到输入值，而不是被 onClose 抢先解析成 null', async () => {
  const w = makeWindow();
  const p = w.ui.prompt({ title: '变量', value: '3' });

  const input = w.document.querySelector('.modal input');
  assert.ok(input, '应渲染出输入框');
  assert.equal(input.value, '3');

  [...w.document.querySelectorAll('.modal button')].find((b) => b.textContent === '确定').click();
  assert.equal(await p, '3', '点确定返回 null —— 所有「试发 / 快速提示」都会静默失效');

  // 弹窗必须关闭
  assert.equal(w.document.querySelector('.modal-back'), null);
});

test('★ 取消返回 null，且不会误触发确定分支', async () => {
  const w = makeWindow();
  const p = w.ui.prompt({ title: '变量', value: 'abc' });
  [...w.document.querySelectorAll('.modal button')].find((b) => b.textContent === '取消').click();
  assert.equal(await p, null);
});

test('★ 共享选手选择器：搜索、选中、清空该侧', () => {
  const w = makeWindow();
  let picked = 'unset';
  const opts = {
    title: '选择 P1 选手',
    players: [
      { id: 'a', name: '甲选手', teamId: 't1' },
      { id: 'b', name: '乙选手' },
    ],
    teams: [{ id: 't1', name: '红队' }],
    onPick: (id) => { picked = id; },
  };
  w.ui.playerPicker({ ...opts, selectedId: 'a' });

  const names = [...w.document.querySelectorAll('.player-pick-row .pp-name')].map((n) => n.textContent);
  assert.deepEqual(names, ['甲选手', '乙选手']);
  assert.equal(w.document.querySelector('.pp-current')?.textContent, '当前');

  const search = w.document.querySelector('.modal input');
  search.value = '红队';
  search.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.equal(w.document.querySelectorAll('.player-pick-row').length, 1, '按队伍名也能过滤');

  w.document.querySelector('.player-pick-row').click();
  assert.equal(picked, 'a', '点选手应把 id 交回页面');
  assert.equal(w.document.querySelector('.modal-back'), null, '选中后应关闭弹窗');

  w.ui.playerPicker(opts);
  [...w.document.querySelectorAll('.modal button')].find((b) => b.textContent === '清空该侧').click();
  assert.equal(picked, null, '清空该侧必须回传 null');
});

test('★ 回车确认与多行输入', async () => {
  const w = makeWindow();
  const p = w.ui.prompt({ title: '自由文本', multiline: true, value: '第一行' });
  const ta = w.document.querySelector('.modal textarea');
  assert.ok(ta, 'multiline 应渲染 textarea');
  [...w.document.querySelectorAll('.modal button')].find((b) => b.textContent === '确定').click();
  assert.equal(await p, '第一行');

  const w2 = makeWindow();
  const p2 = w2.ui.prompt({ title: '变量', value: '7' });
  const inp = w2.document.querySelector('.modal input');
  inp.dispatchEvent(new w2.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(await p2, '7', '回车应确认并带回输入值');
});
