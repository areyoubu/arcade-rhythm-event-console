/**
 * 渲染端结构回归测试。
 *
 * 这里守的是两个**已经真实发生过**的线上故障：
 *  ① 网格致谢整片空白 —— 行原型在插值阶段就被清空
 *  ② 滚动致谢「滚一下弹回去」—— 改 CSS animation-duration 会重算进度
 *
 * 渲染端是浏览器里的 IIFE，没法在 Node 里跑真实 DOM，所以用两种手段：
 *  · 结构断言：读源码确认关键调用顺序没被改回去
 *  · 数据断言：验证服务端发给渲染端的数据里字段别名齐全
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as overlay from '../server/overlay.js';
import * as templates from '../server/templates.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public', 'render', 'renderer.js'), 'utf8');

const idx = (needle) => SRC.indexOf(needle);

test('★ 行原型必须在插值**之前**抽取（否则网格致谢全空白）', () => {
  const iExtract = idx('const multiProtos = extractMultiPrototypes(tpl.html');
  const iInterp = idx('root.innerHTML = interpolateHtml(tpl.html');
  assert.ok(iExtract > 0, 'show() 里找不到 extractMultiPrototypes 调用');
  assert.ok(iInterp > 0, 'show() 里找不到 interpolateHtml 调用');
  assert.ok(iExtract < iInterp,
    'extractMultiPrototypes 必须在 interpolateHtml 之前执行 —— '
    + '顺序反了会把行原型里的 {{image}}/{{name}} 替换成空串，渲染出来就是一片空白格子');
});

test('★ 多值槽位必须使用**原始模板**的行原型，而不是上次渲染结果', () => {
  assert.match(SRC, /current\s*\.\s*multiProtos|multiProtos\?\.get/,
    'renderMulti 应读取 current.multiProtos（原始模板里抽出的行原型）');
  assert.ok(!/container\.__proto/.test(SRC),
    '不得用 __proto__ 当缓存 —— 它是原型访问器，赋值不会保存字符串，读回来是原型对象');
});

test('★ 滚动致谢必须用 rAF 驱动，不得依赖 CSS animation 的时长变更', () => {
  assert.match(SRC, /requestAnimationFrame\(rollTick\)/, '应存在 rAF 驱动的滚动循环');
  assert.match(SRC, /roll\.pos\s*\+=/, '滚动位置应是一个由我们自己维护的像素累加值');
  // 关键：不得再通过修改 CSS 变量去改变滚动时长（那会让运行中的动画重算进度）
  assert.ok(!/setProperty\(\s*'--tr-duration'/.test(SRC),
    '不得再通过 --tr-duration 控制滚动 —— 修改运行中动画的 duration 会让画面跳回去');
  assert.ok(!/animationPlayState\s*=/.test(SRC),
    '暂停/继续应改 roll.paused，而不是 animationPlayState');
});

test('★ 滚动支持暂停 / 继续 / 重播 / 跳到分组（A-REQ-526）', () => {
  for (const action of ['pause', 'resume', 'restart', 'jumpTo']) {
    assert.ok(new RegExp(`case '${action}'`).test(SRC), `creditsControl 缺少 ${action} 分支`);
  }
  assert.match(SRC, /roll\.ended\s*=\s*true/, '单次模式应在末尾停住，而不是回弹');
  assert.match(SRC, /roll\.pos\s*=\s*0/, '循环模式应回首，重播应归零');
});

test('★ 渲染端不得直接依赖可被删除的外部文件', () => {
  assert.ok(!/whep|WhepPlayer/.test(SRC), '渲染引擎不应引用已移除的 WHEP 播放器');
  assert.ok(!/monitor/.test(SRC), '渲染引擎不应引用已移除的监看模块');
});

// ─────────────────────────────────────────────────────────────
// 数据侧：服务端发给渲染端的多值项，字段别名必须齐全
// ─────────────────────────────────────────────────────────────

templates.load();

test('★ 多值图片项必须同时提供 src / image / url 三个别名', () => {
  // 模板作者写 {{image}}、{{src}}、{{url}} 的都有，只给一个就会「填了图显示空白」
  const r = overlay.show({
    template: 'thanksGrid',
    target: 'credits',
    values: {
      heading: '测试',
      items: [
        { src: '/media/aaa.png', name: '赞助商甲', tier: '金牌' },
        '/media/bbb.png',
        { image: '/media/ccc.png', name: '赞助商丙' },
      ],
    },
  });
  assert.equal(r.ok, true, JSON.stringify(r.nack || ''));

  const items = overlay.getTarget('credits').slotValues.items;
  assert.equal(items.length, 3);

  assert.equal(items[0].src, '/media/aaa.png');
  assert.equal(items[0].image, '/media/aaa.png', '缺 image 别名 → 模板里的 {{image}} 会渲染成空');
  assert.equal(items[0].url, '/media/aaa.png');
  assert.equal(items[0].name, '赞助商甲');
  assert.equal(items[0].tier, '金牌');

  // 字符串项：既当文字又当图片地址
  assert.equal(items[1].image, '/media/bbb.png');
  assert.equal(items[1].name, '');

  // 用 image 字段传进来的，也要补齐 src
  assert.equal(items[2].src, '/media/ccc.png');
  assert.equal(items[2].image, '/media/ccc.png');

  overlay.clear({ target: 'credits' });
});

test('★ 滚动致谢的多值行原型字段同样齐全（lines / logoRow）', () => {
  const r = overlay.show({
    template: 'thanksRoll',
    target: 'credits',
    values: {
      heading: '特别感谢',
      lines: [{ group: '技术支持', text: 'XXX 工作室' }, '纯字符串条目'],
      logoRow: ['/media/logo1.png', { src: '/media/logo2.png', alt: '赞助商' }],
    },
  });
  assert.equal(r.ok, true, JSON.stringify(r.nack || ''));
  const v = overlay.getTarget('credits').slotValues;
  assert.equal(v.lines.length, 2);
  assert.equal(v.lines[0].text, 'XXX 工作室');
  assert.equal(v.lines[0].group, '技术支持');
  assert.equal(v.lines[1].text, '纯字符串条目');
  assert.equal(v.logoRow[0].image, '/media/logo1.png');
  assert.equal(v.logoRow[1].image, '/media/logo2.png');
  overlay.clear({ target: 'credits' });
});

test('★ 网格致谢的 columns 槽位必须能被热改（data-set-var 路径）', () => {
  // 渲染端用 data-set-var="--tg-cols:columns" 把它映射成 CSS 变量；
  // 这里验证服务端接受并保存该值，且它是 number 类型（渲染端会 String() 后塞进 CSS 变量）
  overlay.show({ template: 'thanksGrid', target: 'credits', values: { items: [] } });
  const r = overlay.update('columns', '3', { target: 'credits' });
  assert.equal(r.ok, true);
  assert.equal(r.value, 3, 'columns 应被归一化成 number');
  overlay.clear({ target: 'credits' });
});
