/**
 * 总比分画面：曲绘显示 + 长文本滚动。
 *
 * 用 jsdom 加载真实 render/match.html + match.js，模拟 WS 推送一局比赛。
 * 布局尺寸在 jsdom 里是 0，测试里手动伪造 scrollWidth / clientWidth 触发滚动逻辑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const HTML = fs.readFileSync(path.join('public', 'render', 'match.html'), 'utf8');
const JS = fs.readFileSync(path.join('public', 'render', 'match.js'), 'utf8');

function makeWindow() {
  const dom = new JSDOM(HTML, {
    url: 'http://localhost/render/match',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const handlers = new Map();
  w.arcadeWS = {
    on(type, fn) { handlers.set(type, fn); },
    start() {},
    notify() {},
  };
  // jsdom 不实现媒体播放，避免未实现错误干扰
  w.HTMLMediaElement.prototype.play = () => Promise.resolve();
  w.eval(JS);
  return { w, handlers };
}

function stateWith(songPatch = {}) {
  return {
    name: '测试局',
    status: 'live',
    currentIndex: 0,
    winner: null,
    songs: [{
      index: 0, filled: true, hasSong: true,
      title: '普通曲目', artist: '曲师', cover: '/covers/2823.webp',
      difficultyName: 'MASTER', levelText: '14.2', difficultyColor: '#7030a0',
      scoreLeft: 1000000, scoreRight: 990000, winner: 'left',
      ...songPatch,
    }],
    players: { left: { name: 'P1' }, right: { name: 'P2' } },
    colors: { left: '#d0344e', right: '#3d78c9' },
    derived: {
      filledCount: 1, completeRows: 1, modeLabel: '总分制',
      displayLeft: 1000000, displayRight: 990000, scoreLabel: '总分', leader: 'left',
    },
  };
}

test('★★ 曲目行显示封面；没有封面时隐藏占位', async () => {
  const { w, handlers } = makeWindow();
  handlers.get('match:state')({ match: stateWith() });
  await new Promise((r) => setTimeout(r, 20));

  const img = w.document.querySelector('.song-cover');
  assert.ok(img, '应存在封面节点');
  assert.equal(img.classList.contains('hidden'), false);
  assert.match(img.getAttribute('src') || '', /\/covers\/2823\.webp$/);

  handlers.get('match:state')({ match: stateWith({ cover: '' }) });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(img.classList.contains('hidden'), true, '无封面时应隐藏');
});

test('★★ 过长曲名先缩小字号，超出时启用滚动', async () => {
  const { w, handlers } = makeWindow();
  const longTitle = `这是一个${'非常'.repeat(20)}长的曲目名称用来测试滚动`;
  handlers.get('match:state')({ match: stateWith({ title: longTitle }) });
  await new Promise((r) => setTimeout(r, 20));

  const title = w.document.querySelector('.song-title');
  const wrap = title.parentElement;
  assert.equal(title.textContent, longTitle);
  assert.ok(title.classList.contains('very-long'), '超长标题应使用更小字号');

  Object.defineProperty(title, 'scrollWidth', { configurable: true, value: 600 });
  Object.defineProperty(wrap, 'clientWidth', { configurable: true, value: 300 });
  handlers.get('match:state')({ match: stateWith({ title: longTitle, scoreLeft: 1000001 }) });
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(wrap.classList.contains('scrolling'), true, '超出容器时应启用滚动');
  assert.equal(wrap.style.getPropertyValue('--shift'), '-300px');
});

test('★ 曲绘紧贴文字左侧，右侧配平块保证文字严格居中', async () => {
  const { w, handlers } = makeWindow();
  handlers.get('match:state')({ match: stateWith() });
  await new Promise((r) => setTimeout(r, 20));

  const center = w.document.querySelector('.song-row .song-center');
  assert.ok(center, '应存在曲目中间列');
  assert.equal(center.children[0].classList.contains('song-cover'), true, '曲绘在文字左侧');
  assert.equal(center.children[1].classList.contains('song-text'), true, '中间是文字');
  assert.equal(center.children[2].classList.contains('song-cover-spacer'), true, '右侧是等宽配平块');

  const spacer = center.children[2];
  assert.equal(spacer.classList.contains('hidden'), false, '有曲绘时配平块生效');
  // 配平块宽度必须与曲绘一致，否则文字仍会偏
  assert.match(HTML, /\.song-cover\s*\{[^}]*width:\s*76px[^}]*height:\s*76px/s);
  assert.match(HTML, /\.song-cover-spacer\s*\{[^}]*flex:\s*0 0 76px[^}]*width:\s*76px/s);

  // 曲名块至少占满文字列，短曲名居中；超宽时按 max-content 滚动
  assert.match(HTML, /\.song-title\s*\{[^}]*width:\s*max-content;[^}]*min-width:\s*100%/s);

  handlers.get('match:state')({ match: stateWith({ cover: '' }) });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(spacer.classList.contains('hidden'), true, '无曲绘时配平块一并隐藏');
});

test('★ 短标题不滚动，分数列文字仍对齐', async () => {
  const { w, handlers } = makeWindow();
  handlers.get('match:state')({ match: stateWith({ title: '短歌名' }) });
  await new Promise((r) => setTimeout(r, 20));

  const title = w.document.querySelector('.song-title');
  assert.equal(title.classList.contains('long'), false);
  assert.equal(title.classList.contains('very-long'), false);
  assert.equal(title.parentElement.classList.contains('scrolling'), false);

  const left = w.document.querySelector('.side-score.left .score-num');
  const right = w.document.querySelector('.side-score.right .score-num');
  assert.equal(left.textContent, '1000000');
  assert.equal(right.textContent, '990000');
});
