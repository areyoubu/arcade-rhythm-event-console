/**
 * 解说视角模板页（/cast）。
 *
 * 用 jsdom 加载真实 cast.html 的内联脚本，验证：
 *   · 默认模板是「提示预览面板」，提示卡渲染在面板里而不是铺满整屏；
 *   · 比赛条读取当前局 / 双方总分 / 当前曲目；
 *   · ?config=1 会打开右侧配置抽屉，字段与服务端默认值一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const HTML = fs.readFileSync(path.join('public', 'cast.html'), 'utf8');
const INLINE = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1]).join('\n');

function makeWindow(query = '?preview=1&demo=1') {
  const dom = new JSDOM(HTML, {
    url: `http://localhost/cast${query}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const handlers = new Map();
  w.arcadeWS = {
    on(type, fn) { handlers.set(type, fn); },
    watch() {},
    start() {},
    notify() {},
    state: {},
    connected: true,
  };
  w.audioCue = {
    unlock: () => Promise.resolve(),
    status: () => ({ unlocked: false }),
    play: () => false,
  };
  w.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, changed: [] }) });
  w.HTMLMediaElement.prototype.play = () => Promise.resolve();
  w.HTMLMediaElement.prototype.pause = () => {};
  w.eval(INLINE);
  return { w, handlers, dom };
}

const text = (w, sel) => w.document.querySelector(sel)?.textContent || '';

test('★★ 默认模板：提示卡渲染在「提示预览」面板里，比赛条显示当前局与曲目', async () => {
  const { w, dom } = makeWindow();
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(w.document.body.classList.contains('tpl-panel'), true);
  assert.equal(w.document.body.classList.contains('pos-bottom'), true);
  assert.equal(w.document.body.classList.contains('bg-transparent'), true);

  const panel = w.document.querySelector('.cue-preview');
  const cards = w.document.querySelectorAll('.cue-preview .cue-card');
  assert.equal(cards.length, 2, '示例应渲染两条提示');
  assert.ok(panel.contains(cards[0]), '提示卡必须在预览面板内，而不是铺满整屏');

  assert.equal(text(w, '#msLeftName'), 'P1');
  assert.equal(text(w, '#msLeftScore'), '258955');
  assert.equal(text(w, '#msRightScore'), '1691612');
  assert.equal(text(w, '#msSong'), 'アイ情劣等生');
  assert.equal(w.document.querySelector('#matchStrip').classList.contains('hidden'), false);

  // 倒计时数字在卡片里
  const cd = w.document.querySelector('.cue-card.P0 .cue-count-wrap .num');
  assert.ok(cd, 'P0 倒计时应显示秒数');
  assert.match(cd.textContent, /^\d+$/);

  dom.window.close();
});

test('★ ?config=1 打开配置抽屉，字段与服务端默认值一致', async () => {
  const { w, dom } = makeWindow('?preview=1&config=1&demo=1');
  await new Promise((r) => setTimeout(r, 30));

  const drawer = w.document.querySelector('#cfgDrawer');
  assert.ok(drawer, '应存在配置抽屉');
  assert.equal(drawer.classList.contains('hidden'), false, 'config=1 时抽屉应打开');

  const selects = [...drawer.querySelectorAll('select')];
  assert.equal(selects[0].value, 'panel', '默认模板 panel');
  assert.equal(selects[1].value, 'bottom', '默认位置 bottom');
  assert.equal(selects[2].value, '2', '默认最多显示 2 条');

  const checks = [...drawer.querySelectorAll('input[type="checkbox"]')];
  assert.equal(checks.length, 5);
  assert.equal(checks[0].checked, true, '默认显示比赛条');
  assert.equal(checks[4].checked, false, '默认不显示 ack 按钮');

  dom.window.close();
});
