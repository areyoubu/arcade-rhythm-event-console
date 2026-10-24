/**
 * 致谢渲染的真实 DOM 测试（jsdom）。
 *
 * 这一组测试存在的理由：致谢曾经「网格全空白 / 滚动弹回去」，
 * 而这两个 bug 都只能靠真实 DOM 暴露 —— 纯数据断言是看不出来的。
 *
 * 做法：把 `public/render/renderer.js` 放进 jsdom 里跑，模拟服务端发来的
 * `overlay:show` 消息，然后直接检查 DOM 里渲染出了什么。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER = fs.readFileSync(path.join(ROOT, 'public', 'render', 'renderer.js'), 'utf8');
const WS_JS = fs.readFileSync(path.join(ROOT, 'public', 'shared', 'ws.js'), 'utf8');

/** 构造一个带渲染引擎的 jsdom 环境 */
function bootRenderer(templateDefs, { target = 'main' } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body></body></html>`,
    { url: `http://127.0.0.1:3000/render/${target}?preview=1`, pretendToBeVisual: true, runScripts: 'outside-only' },
  );
  const { window } = dom;

  // 渲染引擎依赖的浏览器能力，jsdom 里缺失或不足的补上
  window.requestAnimationFrame = window.requestAnimationFrame || ((cb) => window.setTimeout(() => cb(window.performance.now()), 16));
  window.cancelAnimationFrame = window.cancelAnimationFrame || ((id) => window.clearTimeout(id));
  // 图片预加载：jsdom 不会真的加载，这里让它同步成功，避免 1500ms 兜底拖慢测试
  window.Image = class {
    set src(v) { this._src = v; this.onload && setTimeout(() => this.onload(), 0); }
    get src() { return this._src; }
  };
  // 渲染端用 fetch 拉一次模板表兜底；测试里不需要真的联网
  window.fetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve({ ok: false }) });
  if (!window.Element.prototype.animate) {
    // Web Animations API 在 jsdom 里没有；渲染端会 try/catch，这里给个最小实现
    window.Element.prototype.animate = function animate() {
      return { cancel() {}, finished: Promise.resolve(), playState: 'finished' };
    };
  }
  if (!window.Element.prototype.attachShadow) {
    window.Element.prototype.attachShadow = function attachShadow() { return this; };
  }

  // 极简 WS 客户端替身：只负责把服务端消息转交给注册的处理器
  const handlers = new Map();
  const notes = [];
  window.arcadeWS = {
    start() { return this; },
    on(type, fn) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn); return () => {}; },
    off() {},
    notify(t, payload) { notes.push({ t, payload }); return true; },
    setIdentity() {}, cmd() { return Promise.resolve(); },
    connected: true, state: {}, path: () => undefined,
    get clientInfo() { return {}; },
  };

  window.eval(RENDERER);

  const fire = (type, payload) => {
    const m = { t: type, ...payload };
    for (const fn of handlers.get(type) || []) fn(m);
    // 引擎同时监听 hello 里的完整状态；这里只发模板与 show，够用了
  };

  const stage = window.document.getElementById('stage');
  /**
   * 必须显式关闭：渲染引擎里的滚动循环是 requestAnimationFrame 驱动的，
   * jsdom 下会一直排队，Node 测试进程就永远不会退出（表现为「测试挂住」）。
   */
  const close = () => { try { window.close(); } catch { /* ignore */ } };
  return { dom, window, fire, stage, notes, close, docs: window.document };
}

const thanksGrid = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates/builtin/thanksGrid.json'), 'utf8'));
const thanksRoll = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates/builtin/thanksRoll.json'), 'utf8'));
const lowerThird = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates/builtin/lowerThird.json'), 'utf8'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ═════════════════════════════════════════════════════════════
// 网格致谢：这次最重要的回归
// ═════════════════════════════════════════════════════════════
test('★ 网格致谢必须把每个条目都渲染出来（不能是一片空白格子）', async (t) => {
  const { fire, stage, close } = bootRenderer();
  t.after(close);
  fire('overlay:show', {
    target: 'main',
    templateDef: thanksGrid,
    template: 'thanksGrid',
    values: {
      heading: '感谢以下合作伙伴',
      items: [
        { image: '/media/aaa.png', name: '赞助商甲', tier: '金牌' },
        { image: '/media/bbb.png', name: '赞助商乙', tier: '银牌' },
        { image: '/media/ccc.png', name: '赞助商丙', tier: '' },
      ],
      columns: 3,
    },
  });
  await sleep(60);

  const host = stage.querySelector('.ov-tpl');
  assert.ok(host, '模板宿主应已挂载');
  const root = host.shadowRoot || host;

  const cells = root.querySelectorAll('.tg-cell');
  assert.equal(cells.length, 3, `应渲染 3 个单元格，实际 ${cells.length}`);

  // 名字必须出现 —— 这是「空白」最直观的判据
  const names = [...root.querySelectorAll('.tg-name')].map((n) => n.textContent);
  assert.deepEqual(names, ['赞助商甲', '赞助商乙', '赞助商丙']);

  // 图片必须被绑定（不是空 src）
  const imgs = [...root.querySelectorAll('.tg-logo img')];
  assert.equal(imgs.length, 3);
  assert.deepEqual(imgs.map((i) => i.getAttribute('src')), ['/media/aaa.png', '/media/bbb.png', '/media/ccc.png']);

  // 分层标签
  const tiers = [...root.querySelectorAll('.tg-tier')].map((n) => n.textContent);
  assert.deepEqual(tiers, ['金牌', '银牌', '']);
});

test('★ 网格致谢：条目数变化时能正确重渲染（不残留、不重复）', async (t) => {
  const { fire, stage, close } = bootRenderer();
  t.after(close);
  fire('overlay:show', {
    target: 'main', templateDef: thanksGrid, template: 'thanksGrid',
    values: { items: [{ image: '/a.png', name: 'A' }, { image: '/b.png', name: 'B' }] },
  });
  await sleep(40);

  let root = stage.querySelector('.ov-tpl');
  root = root.shadowRoot || root;
  assert.equal(root.querySelectorAll('.tg-cell').length, 2);

  // 热改条目：换成 4 条
  fire('overlay:update', {
    target: 'main', slot: 'items',
    value: [
      { image: '/1.png', name: '一' }, { image: '/2.png', name: '二' },
      { image: '/3.png', name: '三' }, { image: '/4.png', name: '四' },
    ],
  });
  await sleep(40);

  const names = [...root.querySelectorAll('.tg-name')].map((n) => n.textContent);
  assert.deepEqual(names, ['一', '二', '三', '四'], '热改后必须完全替换，不能残留旧行');
});

test('★ 网格致谢：行原型不会被上一次的渲染结果污染', async (t) => {
  const { fire, stage, close } = bootRenderer();
  t.after(close);
  fire('overlay:show', {
    target: 'main', templateDef: thanksGrid, template: 'thanksGrid',
    values: { items: [{ image: '/a.png', name: '第一项' }] },
  });
  await sleep(40);
  // 再热改一次：如果行原型变成了「第一项」那一行，新数据就会全是「第一项」
  fire('overlay:update', { target: 'main', slot: 'items', value: [{ image: '/b.png', name: '第二项' }] });
  await sleep(40);

  let root = stage.querySelector('.ov-tpl');
  root = root.shadowRoot || root;
  const names = [...root.querySelectorAll('.tg-name')].map((n) => n.textContent);
  assert.deepEqual(names, ['第二项'], `行原型被污染了：${names.join(' / ')}`);
});

// ═════════════════════════════════════════════════════════════
// 滚动致谢
// ═════════════════════════════════════════════════════════════
test('★ 滚动致谢必须渲染出所有条目，并启动滚动引擎', async (t) => {
  const { fire, stage, window, close } = bootRenderer();
  t.after(close);
  fire('overlay:show', {
    target: 'main', templateDef: thanksRoll, template: 'thanksRoll',
    values: {
      heading: '特别感谢',
      lines: [
        { group: '技术支持', text: 'XXX 工作室' },
        { group: '', text: 'YYY 团队' },
      ],
      logoRow: [{ src: '/media/l1.png', alt: 'L1' }],
      speed: 40,
      mode: 'loop',
    },
  });
  await sleep(60);

  let root = stage.querySelector('.ov-tpl');
  root = root.shadowRoot || root;

  const rows = [...root.querySelectorAll('.tr-row')];
  assert.equal(rows.length, 2, `应渲染 2 条致谢，实际 ${rows.length}`);
  assert.equal(rows[0].querySelector('.tr-group').textContent, '技术支持');
  assert.equal(rows[0].querySelector('.tr-text').textContent, 'XXX 工作室');
  assert.equal(rows[1].querySelector('.tr-text').textContent, 'YYY 团队');

  const logos = [...root.querySelectorAll('.tr-logo img')];
  assert.equal(logos.length, 1);
  assert.equal(logos[0].getAttribute('src'), '/media/l1.png');

  // 引擎接管后，CSS animation 必须被关掉（否则和 rAF 抢 transform）
  const track = root.querySelector('[data-credits-track]');
  assert.ok(track.classList.contains('tr-js-driven'), '滚动轨道应标记为 JS 驱动');
  assert.equal(track.style.animation, 'none', '必须显式关闭 CSS animation');
});

test('★ 滚动位置随时间推进，且不会被改速度打断（不弹回）', async (t) => {
  const { fire, stage, close } = bootRenderer();
  t.after(close);
  fire('overlay:show', {
    target: 'main', templateDef: thanksRoll, template: 'thanksRoll',
    values: { heading: 'T', lines: [{ text: 'A' }, { text: 'B' }, { text: 'C' }], speed: 300, mode: 'loop' },
  });
  await sleep(80);

  let root = stage.querySelector('.ov-tpl');
  root = root.shadowRoot || root;
  const track = root.querySelector('[data-credits-track]');

  const posOf = () => {
    const m = /translate3d\(0,\s*(-?[\d.]+)px/.exec(track.style.transform || '');
    return m ? Number(m[1]) : 0;
  };

  // 让布局"有高度"：jsdom 里 scrollHeight 恒为 0，这里手工给一个值让引擎有得滚
  Object.defineProperty(track, 'scrollHeight', { value: 1200, configurable: true });
  await sleep(300);
  const p1 = posOf();
  await sleep(300);
  const p2 = posOf();
  assert.ok(p2 < p1, `滚动位置应持续变小（向上滚），实际 ${p1} → ${p2}`);

  // 改速度：位置必须连续，不能跳回 0
  fire('overlay:update', { target: 'main', slot: 'speed', value: 60 });
  await sleep(120);
  const p3 = posOf();
  assert.ok(p3 <= p1, `改速度后不应回弹到起点（p1=${p1} p3=${p3}）`);
  assert.ok(Math.abs(p3 - p2) < 300, `改速度不应造成位置跳变（p2=${p2} p3=${p3}）`);
});

test('★ 暂停 / 继续 / 重播：位置行为符合预期', async (t) => {
  const { fire, stage, close } = bootRenderer();
  t.after(close);
  fire('overlay:show', {
    target: 'main', templateDef: thanksRoll, template: 'thanksRoll',
    values: { heading: 'T', lines: [{ text: 'A' }, { text: 'B' }], speed: 300, mode: 'loop' },
  });
  await sleep(80);

  let root = stage.querySelector('.ov-tpl');
  root = root.shadowRoot || root;
  const track = root.querySelector('[data-credits-track]');
  Object.defineProperty(track, 'scrollHeight', { value: 1200, configurable: true });

  const posOf = () => {
    const m = /translate3d\(0,\s*(-?[\d.]+)px/.exec(track.style.transform || '');
    return m ? Number(m[1]) : 0;
  };

  await sleep(250);
  fire('overlay:credits', { target: 'main', action: 'pause' });
  await sleep(60);
  const paused = posOf();
  await sleep(250);
  const stillPaused = posOf();
  assert.ok(Math.abs(stillPaused - paused) < 1, `暂停后位置不应变化（${paused} → ${stillPaused}）`);

  fire('overlay:credits', { target: 'main', action: 'resume' });
  await sleep(250);
  assert.ok(posOf() < stillPaused, '继续后应重新开始滚动');

  fire('overlay:credits', { target: 'main', action: 'restart' });
  // 不能立刻断言「正好 0」—— 重播后滚动马上又开始推进了（300px/s）
  await sleep(30);
  assert.ok(Math.abs(posOf()) < Math.abs(stillPaused) / 2, `重播应回到起点附近（当前 ${posOf()}，重播前 ${stillPaused}）`);
});

// ═════════════════════════════════════════════════════════════
// 通用回归
// ═════════════════════════════════════════════════════════════
test('热改单个文字槽位：原地更新，不重建 DOM（A-REQ-505）', async (t) => {
  const { fire, stage, close } = bootRenderer();
  t.after(close);
  fire('overlay:show', {
    target: 'main', templateDef: lowerThird, template: 'lowerThird',
    values: { name: '选手A', subtitle: '中二节奏 / 1P' },
  });
  await sleep(40);

  let root = stage.querySelector('.ov-tpl');
  root = root.shadowRoot || root;
  const nameNode = root.querySelector('[data-slot="name"]');
  const before = nameNode;

  fire('overlay:update', { target: 'main', slot: 'name', value: '选手B' });
  await sleep(30);

  const after = root.querySelector('[data-slot="name"]');
  assert.equal(after.textContent, '选手B');
  assert.equal(before, after, '热改必须复用同一个节点，不能重建（否则动画会重播）');
});

test('渲染完成会上报 overlay:rendered（A-REQ-604）', async (t) => {
  const { fire, notes, close } = bootRenderer();
  t.after(close);
  fire('overlay:show', {
    target: 'main', templateDef: lowerThird, template: 'lowerThird',
    values: { name: 'X' },
  });
  await sleep(60);
  assert.ok(notes.some((n) => n.t === 'overlay:rendered'), '必须上报已渲染');
});

test('未知模板静默忽略，不破坏当前画面（A-REQ-537）', async (t) => {
  const { fire, stage, close } = bootRenderer();
  t.after(close);
  fire('overlay:show', { target: 'main', templateDef: lowerThird, template: 'lowerThird', values: { name: '保留' } });
  await sleep(40);
  fire('overlay:show', { target: 'main', template: 'noSuchTemplate', values: {} });
  await sleep(30);

  let root = stage.querySelector('.ov-tpl');
  root = root.shadowRoot || root;
  assert.equal(root.querySelector('[data-slot="name"]').textContent, '保留', '未知模板不应清空画面');
});

// ═════════════════════════════════════════════════════════════
// 队伍槽位（团队赛 / 单人赛）
// ═════════════════════════════════════════════════════════════
test('★ 团队赛：队伍名与队伍 Logo 都渲染到画面上', async (t) => {
  const { fire, stage, close } = bootRenderer();
  t.after(close);
  fire('overlay:show', {
    target: 'main', templateDef: lowerThird, template: 'lowerThird',
    values: { name: '选手A', teamName: 'NEON', teamAvatar: '/media/team.png' },
  });
  await sleep(60);

  let root = stage.querySelector('.ov-tpl');
  root = root.shadowRoot || root;

  const teamName = root.querySelector('[data-slot="teamName"]');
  assert.ok(teamName, '模板里应有队伍名槽位');
  assert.equal(teamName.textContent, 'NEON');

  const teamImg = root.querySelector('img[data-slot="teamAvatar"]');
  assert.ok(teamImg, '模板里应有队伍 Logo 槽位');
  assert.equal(teamImg.getAttribute('src'), '/media/team.png');
  assert.ok(teamImg.classList.contains('is-ready'), 'Logo 预加载完成后应标记 is-ready');
});

test('★ 单人赛：队伍槽位为空，不显示队名也不留破图', async (t) => {
  const { fire, stage, close } = bootRenderer();
  t.after(close);
  fire('overlay:show', {
    target: 'main', templateDef: lowerThird, template: 'lowerThird',
    values: { name: '选手A', teamName: '', teamAvatar: '' },
  });
  await sleep(60);

  let root = stage.querySelector('.ov-tpl');
  root = root.shadowRoot || root;

  assert.equal(root.querySelector('[data-slot="teamName"]').textContent, '', '单人赛队名应为空');
  const img = root.querySelector('img[data-slot="teamAvatar"]');
  assert.equal(img.hasAttribute('src'), false, '单人赛不应留下 src（否则会去加载一个空地址）');
  assert.equal(img.classList.contains('is-ready'), false);
  // 选手名照常显示
  assert.equal(root.querySelector('[data-slot="name"]').textContent, '选手A');
});

test('★ 团队赛 → 单人赛热切换时，队伍信息会被清掉（不残留上一队）', async (t) => {
  const { fire, stage, close } = bootRenderer();
  t.after(close);
  fire('overlay:show', {
    target: 'main', templateDef: lowerThird, template: 'lowerThird',
    values: { name: '选手A', teamName: '旧队', teamAvatar: '/media/old.png' },
  });
  await sleep(50);

  fire('overlay:updateMany', { target: 'main', values: { teamName: '', teamAvatar: '' } });
  await sleep(50);

  let root = stage.querySelector('.ov-tpl');
  root = root.shadowRoot || root;
  assert.equal(root.querySelector('[data-slot="teamName"]').textContent, '');
  assert.equal(root.querySelector('img[data-slot="teamAvatar"]').hasAttribute('src'), false);
});
