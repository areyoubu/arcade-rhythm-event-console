/**
 * 解说摄像头叠加（/render/castcam）—— 全屏 UI。
 *
 * 用 jsdom 加载真实 render/castcam.html + castcam.js，验证：
 *   · 全屏透明层：默认显示 Logo 文字、底部赛程条，不画摄像头小窗；
 *   · 比赛 Logo / 轮播位 / 赛程条配置能实时应用；
 *   · 赛程（match.ticker）与比赛计分同步。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const HTML = fs.readFileSync(path.join('public', 'render', 'castcam.html'), 'utf8');
const JS = fs.readFileSync(path.join('public', 'render', 'castcam.js'), 'utf8');

function makeWindow(query = '?preview=1') {
  const dom = new JSDOM(HTML, {
    url: `http://localhost/render/castcam${query}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const handlers = new Map();
  const watchers = new Map();
  const config = {
    camLogo: '',
    camLogoWidth: 220,
    camLogoPosition: 'top-left',
    camEventTitle: '解说机位',
    camEventSub: 'COMMENTARY',
    camCarouselImages: [],
    camCarouselWidth: 300,
    camCarouselPosition: 'top-right',
    camCarouselIntervalMs: 6000,
    camTickerShow: true,
    camTickerPosition: 'bottom',
    camTickerOpacity: 0.88,
    camTickerCurrentLabel: '正在进行',
    camTickerUpcomingLabel: '即将进行',
    camTickerShowUpcoming: true,
    camTickerShowLive: true,
    camAccent: '#d9a441',
  };
  w.arcadeWS = {
    on(type, fn) { handlers.set(type, fn); },
    watch(p, fn) { watchers.set(p, fn); },
    start() {},
    notify() {},
    state: { config: { cast: config }, match: { ticker: { current: '第 11 局', upcoming: '第 12 局', status: 'live' } } },
    connected: true,
  };
  w.eval(JS);
  return { w, handlers, watchers, dom };
}

const txt = (w, sel) => w.document.querySelector(sel)?.textContent || '';
const hidden = (w, sel) => w.document.querySelector(sel)?.classList.contains('hidden');

test('★★ 全屏 UI：默认显示 Logo 文字与底部赛程条，没有摄像头小窗', () => {
  const { w, dom } = makeWindow();
  assert.equal(w.document.body.classList.contains('logo-tl'), true);
  assert.equal(w.document.body.classList.contains('car-tr'), true);
  assert.equal(w.document.body.classList.contains('ticker-bottom'), true);

  // 默认没有 Logo 图片，但赛事标题仍显示
  assert.equal(hidden(w, '#logoBlock'), false);
  assert.equal(w.document.getElementById('logoMark').classList.contains('on'), false, '没有 Logo 地址时不显示图片');
  assert.equal(txt(w, '#camEventTitle'), '解说机位');
  assert.equal(txt(w, '#camEventSub'), 'COMMENTARY');

  // 底部赛程条：正在进行 / 即将进行
  assert.equal(txt(w, '#nowLabel'), '正在进行');
  assert.equal(txt(w, '#nowName'), '第 11 局');
  assert.equal(txt(w, '#nextLabel'), '即将进行');
  assert.equal(txt(w, '#nextName'), '第 12 局');
  assert.equal(hidden(w, '.ticker'), false);
  assert.equal(hidden(w, '#tickLive'), false);

  // 轮播位没有图片时隐藏
  assert.equal(hidden(w, '#carousel'), true);

  // 页面只能引 ws.js，不能引控制端的 ui.js
  const srcs = [...HTML.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(srcs.some((s) => s.includes('/shared/ws.js')));
  assert.ok(!srcs.some((s) => s.includes('/shared/ui.js')));

  dom.window.close();
});

test('★★ 配置热更新：Logo / 轮播 / 赛程条文案与位置', () => {
  const { w, handlers, dom } = makeWindow();
  handlers.get('hello')({
    state: {
      config: {
        cast: {
          camLogo: '/media/logo.png',
          camLogoWidth: 320,
          camLogoPosition: 'top-right',
          camEventTitle: 'CHUNITHM 赛事',
          camEventSub: 'LIVE COMMENTARY',
          camCarouselImages: ['/covers/1.webp', '/covers/2.webp'],
          camCarouselWidth: 420,
          camCarouselPosition: 'bottom-left',
          camCarouselIntervalMs: 4000,
          camTickerShow: true,
          camTickerPosition: 'top',
          camTickerOpacity: 0.7,
          camTickerCurrentLabel: 'NOW',
          camTickerUpcomingLabel: 'NEXT',
          camTickerShowUpcoming: true,
          camTickerShowLive: false,
          camAccent: '#3d78c9',
        },
      },
      match: { ticker: { current: '决赛', upcoming: '颁奖仪式', status: 'live' } },
    },
  });

  assert.equal(w.document.body.classList.contains('logo-tr'), true);
  assert.equal(w.document.body.classList.contains('logo-tl'), false);
  assert.equal(w.document.body.classList.contains('car-bl'), true);
  assert.equal(w.document.body.classList.contains('ticker-top'), true);
  assert.equal(w.document.body.classList.contains('ticker-bottom'), false);
  assert.equal(w.document.documentElement.style.getPropertyValue('--logo-w'), '320px');
  assert.equal(w.document.documentElement.style.getPropertyValue('--car-w'), '420px');
  assert.equal(w.document.documentElement.style.getPropertyValue('--ticker-alpha'), '0.7');
  assert.equal(w.document.documentElement.style.getPropertyValue('--cam-accent'), '#3d78c9');

  assert.equal(txt(w, '#camEventTitle'), 'CHUNITHM 赛事');
  assert.equal(txt(w, '#camEventSub'), 'LIVE COMMENTARY');
  assert.equal(txt(w, '#nowLabel'), 'NOW');
  assert.equal(txt(w, '#nowName'), '决赛');
  assert.equal(txt(w, '#nextLabel'), 'NEXT');
  assert.equal(txt(w, '#nextName'), '颁奖仪式');
  assert.equal(hidden(w, '#tickLive'), true, 'LIVE 可关闭');
  assert.equal(hidden(w, '#carousel'), false, '有轮播图片时显示');
  assert.equal(w.document.getElementById('carouselImg').getAttribute('src'), '/covers/1.webp');

  // 隐藏「即将进行」和赛程条
  handlers.get('hello')({
    state: {
      config: { cast: { camTickerShow: false, camTickerShowUpcoming: false } },
      match: { ticker: { current: '决赛', upcoming: '颁奖仪式', status: 'live' } },
    },
  });
  assert.equal(hidden(w, '.ticker'), true);
  assert.equal(hidden(w, '#tickNext'), true);
  assert.equal(hidden(w, '#tickSep'), true);

  dom.window.close();
});

test('★ match.ticker 更新：名称变化实时反映到赛程条', () => {
  const { w, watchers, dom } = makeWindow();
  assert.ok(watchers.has('match.ticker'));
  watchers.get('match.ticker')({ current: '败者组决赛', upcoming: '总决赛', status: 'live' });
  assert.equal(txt(w, '#nowName'), '败者组决赛');
  assert.equal(txt(w, '#nextName'), '总决赛');
  dom.window.close();
});
