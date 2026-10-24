/**
 * 模板系统测试 —— 对应 A-REQ-201 / 202 / 210 / 211 / 212 / 213 / 215、§4.3.2。
 *
 * 除 schema 校验外，这里还做一件很值的事：**把模板 HTML 与 slots 声明对照起来**。
 * 「声明了槽位但 HTML 里没绑」在运行时表现为「填了值但画面不变」——
 * 现场极难排查，必须在加载期就拦下。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as templates from '../server/templates.js';

templates.load();

const BUILTIN_IDS = [
  'lowerThird', 'versusCard', 'talentTwin', 'thanksRoll', 'thanksGrid', 'cornerBadge',
  // 风格变体（用户要求「内置几套不同风格的模板」）
  'lowerThirdNeon', 'lowerThirdMinimal', 'lowerThirdBold', 'lowerThirdWhite', 'lowerThirdGlass', 'lowerThirdArcade',
  'versusCardNeon', 'versusCardSplit', 'versusCardContrast', 'versusCardMinimal', 'talentTwinNeon', 'talentTwinJoined',
  // 新增图形
  'scoreBar',
];

/** 同一种图形可以有多个风格变体 —— 用于校验「每种图形至少两种风格」 */
const STYLE_VARIANTS = {
  lowerThird: ['lowerThird', 'lowerThirdNeon', 'lowerThirdMinimal', 'lowerThirdBold', 'lowerThirdWhite', 'lowerThirdGlass', 'lowerThirdArcade'],
  versusCard: ['versusCard', 'versusCardNeon', 'versusCardSplit', 'versusCardContrast', 'versusCardMinimal'],
  talentTwin: ['talentTwin', 'talentTwinNeon', 'talentTwinJoined'],
  thanksRoll: ['thanksRoll'],
  thanksGrid: ['thanksGrid'],
  cornerBadge: ['cornerBadge'],
  scoreBar: ['scoreBar'],
};

test('★ §4.3.2 要求的 6 套内置模板必须齐备', () => {
  const ids = templates.ids();
  for (const id of BUILTIN_IDS) {
    assert.ok(ids.includes(id), `缺少内置模板 ${id}`);
  }
  const stats = templates.stats();
  assert.equal(stats.total, BUILTIN_IDS.length);
  assert.equal(stats.builtin, BUILTIN_IDS.length);
});

test('★ 要有多种风格可选（用户要求「内置几套不同风格的模板」）', () => {
  const ids = new Set(templates.ids());
  for (const variants of Object.values(STYLE_VARIANTS)) {
    for (const id of variants) assert.ok(ids.has(id), `缺少风格变体 ${id}`);
  }
  // 风格变体主要用在「姓名条 / 对阵卡 / 双人名牌」这三类高频图形上；
  // 致谢与角标各一套即可（它们换风格的需求低）。
  const multiStyle = Object.entries(STYLE_VARIANTS).filter(([, v]) => v.length >= 2);
  assert.ok(multiStyle.length >= 3,
    `应该至少有三类图形提供多种风格，实际：${multiStyle.map(([k]) => k).join(', ') || '无'}`);
  assert.ok(ids.size >= 19, `内置模板总数应不少于 19，实际 ${ids.size}`);
});

test('★ 内置模板的分类必须与 SRS 一致', () => {
  const expect = {
    lowerThird: 'player',
    versusCard: 'player',
    talentTwin: 'talent',
    thanksRoll: 'credits',
    thanksGrid: 'credits',
    cornerBadge: 'custom',
    lowerThirdNeon: 'player',
    lowerThirdMinimal: 'player',
    lowerThirdBold: 'player',
    lowerThirdWhite: 'player',
    lowerThirdGlass: 'player',
    lowerThirdArcade: 'player',
    versusCardNeon: 'player',
    versusCardSplit: 'player',
    versusCardContrast: 'player',
    versusCardMinimal: 'player',
    talentTwinNeon: 'talent',
    talentTwinJoined: 'talent',
    scoreBar: 'custom',
  };
  for (const [id, cat] of Object.entries(expect)) {
    assert.equal(templates.get(id).category, cat, `${id} 的分类应为 ${cat}`);
  }
});

test('★ 每个模板的 id 稳定且符合命名规则（A-REQ-202）', () => {
  for (const t of templates.all()) {
    assert.match(t.id, /^[A-Za-z][A-Za-z0-9_-]*$/, `模板 id「${t.id}」命名不规范`);
  }
});

test('★ 声明了槽位就必须在 HTML 里绑定 —— 否则「填了值画面不变」', () => {
  for (const t of templates.all()) {
    const html = t.html || '';
    for (const slot of t.slots || []) {
      // 四种合法绑定方式：
      //   ① data-slot="key"            —— 就地改 textContent / src / CSS 变量
      //   ② {{key}}                    —— 构建期插值
      //   ③ data-set-var="--v:key"     —— 把该槽位当作别的元素的 CSS 变量
      //   ④ runtime 标记               —— 由渲染端内置逻辑读取（如致谢滚动的 speed / mode）
      const bound = html.includes(`data-slot="${slot.key}"`)
        || html.includes(`{{${slot.key}}}`)
        || new RegExp(`data-set-var="[^"]*:${slot.key}(\\s|,|")`).test(html)
        || !!slot.runtime;
      assert.ok(bound,
        `模板 ${t.id} 声明了槽位「${slot.key}」但 HTML 里没有任何绑定`
        + '（data-slot / {{…}} / data-set-var / runtime 四者都没有）——'
        + ' 运行时会出现「填了值但画面不变」的静默故障');
    }
  }
});

test('★ 每个模板都必须至少有一个必填槽位或默认值，否则显示出来是空的', () => {
  for (const t of templates.all()) {
    const hasRequired = (t.slots || []).some((s) => s.required);
    const hasDefault = (t.slots || []).some((s) => s.default !== undefined);
    assert.ok(hasRequired || hasDefault, `模板 ${t.id} 既无必填槽位也无默认值，直接显示会是空白`);
  }
});

test('★ CSS 变量名必须以 -- 开头（A-REQ-211）', () => {
  for (const t of templates.all()) {
    for (const k of Object.keys(t.cssVars || {})) {
      assert.ok(k.startsWith('--'), `模板 ${t.id} 的 CSS 变量「${k}」必须以 -- 开头`);
    }
  }
});

test('★ 模板 CSS 必须作用于自己命名空间的前缀类名，避免互相污染', () => {
  // 内置模板使用各自的前缀（lt- / vc- / tt- / tr- / tg- / cb-），
  // 渲染端把每个模板放在独立的 Shadow DOM 里，双保险
  for (const t of templates.all()) {
    const html = t.html || '';
    const css = t.css || '';
    const prefixes = [...html.matchAll(/class="([a-z]{2})-/g)].map((m) => m[1]);
    if (!prefixes.length) continue;
    const p = prefixes[0];
    assert.ok(new RegExp(`\\.${p}-`).test(css), `模板 ${t.id} 的 CSS 未使用与 HTML 一致的 .${p}- 前缀`);
  }
});

test('★ validateTemplate 必须返回**字段路径级**错误（A-REQ-215）', () => {
  const bad = {
    id: 'ok',
    name: '测试',
    category: 'nope',
    slots: [
      { key: '', label: '', type: 'invalid' },
      { key: 'a', label: 'A', type: 'text', maxLength: -1 },   // 类型合法，但 maxLength 非法
    ],
    defaultAnim: { in: 'noSuchAnim', durationMs: -5 },
    cssVars: { 'not-a-var': '1' },
    html: '<div data-slot="ghost"></div><div data-slot="a"></div>',
  };
  const e = templates.validateTemplate(bad);
  assert.ok(e.category, 'category 非法必须报错');
  assert.ok(e['slots[0].key'], '空 key 必须报到 slots[0].key');
  assert.ok(e['slots[0].label']);
  assert.ok(e['slots[0].type']);
  assert.ok(e['slots[1].maxLength'], 'maxLength 非法必须报到 slots[1].maxLength');
  assert.ok(e['defaultAnim.in'], '未知动画名必须报到 defaultAnim.in');
  assert.ok(e['defaultAnim.durationMs']);
  assert.ok(e['cssVars.not-a-var'], '非法 CSS 变量名必须报到 cssVars.<name>');
  assert.ok(e.html, '未声明的 data-slot 必须报到 html');
  // 错误消息里必须包含足够定位的信息
  assert.match(e['slots[0].type'], /text|image|color|select|number/);
  assert.match(e['defaultAnim.in'], /noSuchAnim/);
});

test('★ maxLength 只对 text 槽位生效（非 text 类型不应报这条）', () => {
  const e = templates.validateTemplate({
    id: 'x', name: 'x', category: 'custom',
    slots: [{ key: 'n', label: 'N', type: 'number', maxLength: -1 }],
    html: '<div data-slot="n"></div>',
  });
  assert.equal(e['slots[0].maxLength'], undefined, 'number 槽位不该被 maxLength 规则拦下');
});

test('重复的槽位 key 必须被拒绝', () => {
  const e = templates.validateTemplate({
    id: 'x', name: 'x', category: 'custom',
    slots: [{ key: 'a', label: 'A', type: 'text' }, { key: 'a', label: 'B', type: 'text' }],
    html: '<div data-slot="a"></div>',
  });
  assert.ok(e['slots[1].key']);
});

test('select 类型必须提供 options', () => {
  const e = templates.validateTemplate({
    id: 'x', name: 'x', category: 'custom',
    slots: [{ key: 'a', label: 'A', type: 'select' }],
    html: '<div data-slot="a"></div>',
  });
  assert.ok(e['slots[0].options']);
});

test('★ 多值槽位的行字段必须写进 rowKeys（否则校验会拒绝）', () => {
  const okTpl = {
    id: 'multi', name: '多值', category: 'credits',
    slots: [{ key: 'items', label: '条目', type: 'image', multi: true, rowKeys: ['image', 'name'] }],
    html: '<div data-slot="items" data-slot-multi><div><img src="{{image}}"/><span>{{name}}</span></div></div>',
  };
  assert.deepEqual(templates.validateTemplate(okTpl), {});

  const badTpl = { ...okTpl, slots: [{ key: 'items', label: '条目', type: 'image', multi: true }] };
  const e = templates.validateTemplate(badTpl);
  assert.ok(e.html, '未在 rowKeys 里声明的行字段必须被拒绝');
  assert.match(e.html, /rowKeys/);
});

test('★ 热重载只推送受影响的模板（A-REQ-213）', () => {
  // diff 是模板变更 → 推送批次的唯一来源；这里验证「未变更的模板不进 changed」
  const before = templates.all();
  const changed = [];
  templates.templateEvents.once('change', (d) => changed.push(...d.changed));
  // 原样再 load 一次：没有任何模板被改动
  templates.load();
  assert.equal(changed.length, 0, '没有任何模板变更时，changed 必须为空 —— 否则会做无意义的整表重推');
  assert.deepEqual(templates.ids().sort(), before.map((t) => t.id).sort());
});

test('★ 保存一个非法自定义模板必须被拒绝且**不影响**已加载的模板（AC-A11）', async () => {
  const countBefore = templates.all().length;
  const r = templates.saveCustom({ id: 'brokenTpl', name: '坏的', category: 'player', slots: [], html: '' });
  assert.equal(r.ok, false, '缺 html 的模板必须被拒绝');
  assert.equal(templates.all().length, countBefore, '被拒绝的保存不得改变模板表');
  assert.equal(templates.get('brokenTpl'), null);
});

test('★ 内置模板不可删除（只能复制为自定义再改）', () => {
  const r = templates.removeCustom('lowerThird');
  assert.equal(r.ok, false, '内置模板不在 custom 目录里，删除应当失败');
  assert.ok(templates.get('lowerThird'), '内置模板必须仍在');
});

test('★★ 模板 id 路径穿越：删除/保存都必须拒绝 ../ 与绝对路径', async () => {
  for (const evil of ['../config', '..\\..\\config', '../../config/config', '/etc/passwd', 'a/b']) {
    const del = templates.removeCustom(evil);
    assert.equal(del.ok, false, `删除 ${evil} 必须被拒绝（防止删任意 .json 文件）`);
    assert.equal(del.errors?.id, 'id 只能包含字母数字下划线连字符，且以字母开头');

    const save = templates.saveCustom({ id: evil, name: 'x', category: 'player', slots: [], html: '<div></div>' });
    assert.equal(save.ok, false, `保存 ${evil} 必须被拒绝（validateTemplate 校验 id）`);
  }
});

test('fullList 携带渲染所需的完整字段，publicList 不含大块 HTML/CSS', () => {
  const full = templates.fullList();
  const pub = templates.publicList();
  assert.equal(full.length, pub.length);
  for (const f of full) {
    assert.ok('html' in f, 'fullList 必须带 html');
    assert.ok('css' in f, 'fullList 必须带 css');
    assert.ok(Array.isArray(f.slots));
    assert.ok(f.defaultAnim);
  }
  for (const p of pub) {
    assert.equal('html' in p, false, 'publicList 不应带 html（控制端用不到，白占带宽）');
    assert.equal('css' in p, false, 'publicList 不应带 css');
    assert.ok(Array.isArray(p.slots), '但槽位定义必须保留 —— 控制端据此生成编辑器');
  }
});

test('每个模板的 defaultAnim 都必须是合法动画名', () => {
  for (const t of templates.all()) {
    const a = t.defaultAnim || {};
    if (a.in) assert.ok(templates.ANIM_NAMES.includes(a.in), `${t.id} 的入场动画 ${a.in} 非法`);
    if (a.out) assert.ok(templates.ANIM_NAMES.includes(a.out), `${t.id} 的出场动画 ${a.out} 非法`);
  }
});

test('byCategory 分组与统计一致', () => {
  const stats = templates.stats();
  let total = 0;
  for (const cat of templates.CATEGORIES) {
    const n = templates.byCategory(cat).length;
    assert.equal(n, stats.byCategory[cat], `分类 ${cat} 的统计数字对不上`);
    total += n;
  }
  assert.equal(total, stats.total);
});
