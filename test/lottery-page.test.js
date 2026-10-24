/**
 * 抽奖页「编辑奖品」—— 回归测试。
 *
 * 曾经漏了 `modal` 的解构，点击按钮直接 ReferenceError，
 * 页面完全没反应。这里用真实 DOM 点击把它钉住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const UI_SRC = fs.readFileSync(path.join('public', 'shared', 'ui.js'), 'utf8');
const FMT_SRC = fs.readFileSync(path.join('public', 'shared', 'format.js'), 'utf8');
const WS_SRC = fs.readFileSync(path.join('public', 'shared', 'ws.js'), 'utf8');
const PAGE = fs.readFileSync(path.join('public', 'lottery.html'), 'utf8');
const PAGE_JS = [...PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');

const STATE = {
  phase: 'idle', spin: null, winner: null,
  poolSize: 0, pool: [], poolTruncated: false,
  settings: {
    kinds: ['player'], tags: [], includeGuests: true, removeWinners: true,
    prize: { name: '机械键盘', image: '/assets/liveroom-background.png', note: '87 键' },
  },
  guests: [], winners: [], history: [], revision: 1,
};

function makeWindow() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  class FakeWS { constructor() { this.readyState = 0; } send() {} close() {} }
  w.WebSocket = FakeWS;
  w.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/api/lottery/state')) return { ok: true, json: async () => ({ ok: true, state: STATE }) };
    if (u.includes('/api/lottery/joinUrl')) return { ok: true, json: async () => ({ ok: true, url: 'http://localhost/join' }) };
    if (u.includes('/api/lottery/prize/image')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          asset: { url: '/media/uploaded.png', width: 1280, height: 720, hash: 'h1' },
          meta: { ip: '203.0.113.7', at: 1790000000000, hash: 'h1' },
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  w.eval(FMT_SRC);
  w.eval(UI_SRC);
  w.eval(WS_SRC);
  w.eval(PAGE_JS);
  return w;
}

function click(w, text) {
  const btn = [...w.document.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
  assert.ok(btn, `找不到按钮：${text}`);
  btn.click();
  return btn;
}

test('★★ 点「编辑奖品」必须打开奖品编辑弹窗', async () => {
  const w = makeWindow();
  await new Promise((r) => setTimeout(r, 30));

  click(w, '编辑奖品');
  const modal = w.document.querySelector('.modal');
  assert.ok(modal, '点击后没有任何弹窗 —— 大概率是 modal 没解构');
  assert.match(modal.textContent, /编辑本轮奖品/);
  // 名称 / 图片地址应回填
  const inputs = [...modal.querySelectorAll('input')];
  assert.ok(inputs.some((i) => i.value === '机械键盘'), '奖品名称应回填');
  assert.ok(inputs.some((i) => i.value === '/assets/liveroom-background.png'), '图片地址应回填');

  // 单张图片上传：只能选一个文件，成功后显示 IP / 时间
  const fileInput = modal.querySelector('input[type=file]');
  assert.ok(fileInput, '必须有图片文件输入');
  assert.equal(fileInput.multiple, false, '不允许一次上传多张');
  assert.match(fileInput.accept, /image\/png/, '只接受光栅图片');
  const file = new w.File([Buffer.from('fake')], 'prize.png', { type: 'image/png' });
  Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
  fileInput.dispatchEvent(new w.Event('change'));
  await new Promise((r) => setTimeout(r, 30));
  assert.match(modal.textContent, /IP 203\.0\.113\.7/);
  assert.match(modal.textContent, /1280×720/);
  assert.equal(modal.querySelector('.prize-upload-preview')?.getAttribute('src'), '/media/uploaded.png');

  // 取消后关闭
  click(w, '取消');
  assert.equal(w.document.querySelector('.modal-back'), null);
});
