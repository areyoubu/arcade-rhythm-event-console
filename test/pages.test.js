/**
 * 前端页面完整性测试。
 *
 * 这一组测的是「页面能不能真的跑起来」里**静态可判定的那部分**：
 *   · 每个页面的业务脚本语法正确
 *   · 只调用共享库真实存在的成员（防 `ui.mountX` 这类拼写错误）
 *   · 该引的共享库都引了、顺序正确
 *   · 受众页面声明了正确的 audience
 *   · 引用的 /api 路径与 WS op 在服务端确实注册了
 *
 * 真实浏览器的渲染效果不在此列 —— 那部分只能人工目检（见 README「已知取舍」）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { PAGES as SERVER_PAGES } from '../server/pages.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const SHARED = path.join(PUBLIC, 'shared');

const PAGES = fs.readdirSync(PUBLIC).filter((n) => n.endsWith('.html'));

// ─────────────────────────────────────────────────────────────
// 用最小 DOM 桩真正加载共享库，读出真实 API 面
// ─────────────────────────────────────────────────────────────
function loadSharedSurface() {
  const noop = () => {};
  const stubNode = () => ({
    style: { setProperty: noop }, dataset: {}, className: '', id: '', value: '', checked: false, disabled: false,
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    append: noop, appendChild: noop, addEventListener: noop, setAttribute: noop,
    getAttribute: () => null, removeAttribute: noop, remove: noop, replaceChildren: noop,
    querySelector: () => null, querySelectorAll: () => [], children: [], innerHTML: '', textContent: '',
    firstElementChild: null, firstChild: null, closest: () => null,
  });
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, URL, Blob,
    fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
    navigator: { userAgent: 'test-stub' },
    location: { protocol: 'http:', host: '127.0.0.1:3000', href: 'http://127.0.0.1:3000/' },
    performance: { now: () => Date.now() },
    requestAnimationFrame: () => 0, cancelAnimationFrame: noop,
    document: {
      createElement: stubNode, head: { append: noop }, body: { append: noop, addEventListener: noop },
      addEventListener: noop, removeEventListener: noop,
      querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
    },
    WebSocket: function WebSocket() { this.readyState = 0; },
    Image: function Image() {},
    AudioContext: function AudioContext() {},
    RTCPeerConnection: function RTCPeerConnection() { this.addTransceiver = noop; },
    MediaStream: function MediaStream() {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  // whep.js 已随「改用 OBS 浏览器源 + NDI/HDMI」一并移除
  for (const f of ['format.js', 'ui.js', 'ws.js', 'audio.js']) {
    vm.runInContext(fs.readFileSync(path.join(SHARED, f), 'utf8'), sandbox, { filename: f });
  }
  return {
    ui: Object.keys(sandbox.ui || {}),
    fmt: Object.keys(sandbox.fmt || {}),
    audioCue: Object.keys(sandbox.audioCue || {}),
    catalog: sandbox.ui?.CATALOG || [],
    // arcadeWS 是 IIFE 暴露的对象，getter 不会出现在 Object.keys 里，手工补全
    arcadeWS: Object.keys(sandbox.arcadeWS || {})
      .concat(['state', 'path', 'connected', 'helloAt', 'lastPatchAt', 'clientInfo']),
  };
}

const RAW_SURFACE = loadSharedSurface();
const CATALOG = RAW_SURFACE.catalog;
delete RAW_SURFACE.catalog;
const SURFACE = RAW_SURFACE;

function scriptsOf(html) {
  // 取不含 src 的内联 <script> 块（即业务脚本）
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

function externalScriptsOf(html) {
  return [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
}

const readPage = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');

/** 跳转页（旧的 /players、/talent 已合并到 /people，保留为 meta refresh 重定向）不需要共享库 */
const isRedirect = (html) => /http-equiv=["']refresh["']/i.test(html);
const FULL_PAGES = () => PAGES.filter((f) => !isRedirect(readPage(f)));

// ─────────────────────────────────────────────────────────────

test('至少要有 15 个页面（README 里承诺的全部路由）', () => {
  assert.ok(PAGES.length >= 15, `只有 ${PAGES.length} 个页面：${PAGES.join(', ')}`);
});

test('★ 服务端页面清单：路径唯一、每个都有对应 HTML', () => {
  const seen = new Set();
  const missing = [];
  for (const p of SERVER_PAGES) {
    assert.ok(p.path && p.file, `页面登记缺少 path/file：${JSON.stringify(p)}`);
    assert.ok(p.path.startsWith('/'), `页面路径必须以 / 开头：${p.path}`);
    assert.ok(!seen.has(p.path), `重复登记页面：${p.path}`);
    seen.add(p.path);
    const file = path.join(PUBLIC, p.file);
    if (!fs.existsSync(file)) missing.push(`${p.path} → public/${p.file}`);
  }
  assert.deepEqual(missing, [], '页面清单指向了不存在的 HTML');
  // 首页由静态 index.html 提供，其余页面必须能从清单打开
  for (const p of ['/match', '/scoreboard', '/outputs', '/lottery', '/render/match', '/pick', '/join']) {
    assert.ok(seen.has(p), `页面清单缺少 ${p}`);
  }
});

test('★ 前端功能目录（CATALOG）指向的页面都已在服务端登记', () => {
  const serverPaths = new Set(SERVER_PAGES.map((p) => p.path));
  const missing = [];
  for (const group of CATALOG) {
    for (const item of group.items || []) {
      if (!item.href) continue;
      if (!serverPaths.has(item.href)) missing.push(`${group.id} → ${item.href}`);
    }
  }
  assert.deepEqual(missing, [], '前端目录与服务端页面清单不一致');
});

test('★ 每个页面的内联与外部业务脚本都必须语法正确', () => {
  const broken = [];
  const checked = new Set();
  for (const f of PAGES) {
    const html = readPage(f);
    for (const [i, code] of scriptsOf(html).entries()) {
      try { new vm.Script(code, { filename: `${f}#script${i}` }); }
      catch (e) { broken.push(`${f} 第 ${i + 1} 段脚本：${e.message}`); }
    }
    // 外部脚本（render/*.js 等）同样要能解析 —— 一个 SyntaxError 会让整页 JS 静默停摆
    for (const src of externalScriptsOf(html)) {
      const clean = src.split(/[?#]/)[0];
      if (/^https?:/i.test(clean) || !clean.endsWith('.js')) continue;
      const rel = clean.replace(/^\/+/, '');
      const file = path.join(PUBLIC, rel);
      if (!fs.existsSync(file)) { broken.push(`${f} 引用了不存在的脚本 ${src}`); continue; }
      if (checked.has(file)) continue;
      checked.add(file);
      try { new vm.Script(fs.readFileSync(file, 'utf8'), { filename: rel }); }
      catch (e) { broken.push(`${rel}：${e.message}`); }
    }
  }
  assert.deepEqual(broken, [], broken.join('\n'));
});

test('★ 页面不得调用共享库上不存在的成员', () => {
  // 前置字符不能是标识符字符，也不能是 `.`（排除 monitor.whep.url 这类配置路径）
  const before = '(?:^|[^A-Za-z0-9_$/.])';
  const name = '([A-Za-z_$][A-Za-z0-9_$]*)';
  // 文件名后缀不是方法调用
  const FILE_EXT = new Set(['js', 'css', 'html', 'json', 'mjs']);
  const bad = [];
  for (const f of PAGES) {
    const html = readPage(f);
    for (const [ns, members] of Object.entries(SURFACE)) {
      const set = new Set(members);
      // 用 [.] 表示字面点 —— 避免任何需要转义的元字符在字符串里被处理掉
      const re = new RegExp(`${before}${ns}[.]${name}`, 'g');
      for (const m of html.matchAll(re)) {
        if (FILE_EXT.has(m[1])) continue;
        if (!set.has(m[1])) bad.push(`${f}: ${ns}.${m[1]}`);
      }
    }
  }
  assert.deepEqual([...new Set(bad)], [],
    '页面调用了共享库不存在的成员 —— 在真实浏览器里会是 TypeError');
});

test('★ 每个页面都必须引入必需的共享库，且顺序正确', () => {
  for (const f of FULL_PAGES()) {
    // 公共签到页（/join）、手机选曲页（/pick）与后台密码设置页（admin-setup）是独立表单：
    // 不接 WS、不用控制端组件
    if (f === 'join.html' || f === 'pick.html' || f === 'admin-setup.html') continue;
    const html = readPage(f);
    const srcs = externalScriptsOf(html);
    // ws.js 是所有页面都需要的（状态同步 / 命令）
    assert.ok(srcs.some((s) => s.endsWith('/shared/ws.js')), `${f} 缺少 <script src="/shared/ws.js">`);

    const usesUi = /ui\./.test(html);
    const iFmt = srcs.findIndex((s) => s.endsWith('/shared/format.js'));
    const iUi = srcs.findIndex((s) => s.endsWith('/shared/ui.js'));
    const iWs = srcs.findIndex((s) => s.endsWith('/shared/ws.js'));

    if (usesUi) {
      assert.ok(iUi !== -1, `${f} 用到了 ui.* 却没有引入 ui.js`);
      if (iFmt !== -1) assert.ok(iFmt < iUi, `${f}: format.js 必须在 ui.js 之前（ui.js 加载时就要读 window.fmt）`);
      assert.ok(iUi < iWs, `${f}: ui.js 必须在 ws.js 之前`);
    } else {
      // 纯叠加/渲染页（如 /cast、/render/*）不需要控制端的 ui.js
      assert.ok(iFmt === -1 || iFmt < iWs, `${f}: format.js 应在 ws.js 之前`);
    }
  }
});

test('★ 渲染端页面必须保持透明背景、不引共享样式、不含错误文案（A-REQ-530 / 537）', () => {
  // /cast 也是一路透明叠加（解说端监视器用），一并检查
  for (const f of ['render/main.html', 'render/credits.html', 'render/score.html', 'render/pick.html', 'render/lottery.html', 'render/castcam.html', 'cast.html']) {
    const html = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
    assert.match(html, /background:\s*transparent/i, `${f} 必须显式声明透明背景`);
    assert.ok(!externalScriptsOf(html).some((s) => s.includes('/shared/style.css')),
      `${f} 不得引入控制端的设计系统样式`);
    assert.ok(!externalScriptsOf(html).some((s) => s.includes('whep')),
      `${f} 不应再引入已删除的 WHEP 播放器`);
    // 去掉 HTML 注释后再找可见的错误文案
    const visible = html.replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(!/(渲染失败|加载失败|出错了|Error:)/.test(visible),
      `${f} 出现用户可见的错误文案 —— 观众会看到（A-REQ-537）`);
  }
});

test('★ 总比分画面是整屏场景，复用直播间动态背景（不再是透明叠加）', () => {
  const html = readPage('render/match.html');
  const visible = html.replace(/<!--[\s\S]*?-->/g, '');
  assert.match(visible, /liveroom-background\.mp4/, '必须引用直播间动态背景');
  assert.match(visible, /liveroom-background\.png/, '必须有静态 PNG 兜底');
  assert.match(visible, /<video[^>]*autoplay[^>]*muted[^>]*loop/i,
    '背景视频必须自动播放、静音、循环');
  assert.match(visible, /background:\s*#0a0b0d/i, '整屏场景必须有不透明底色');
  assert.ok(!/background\s*:\s*transparent/i.test(visible),
    '总比分画面是独立场景，不应再声明透明背景');
  assert.ok(!/(渲染失败|加载失败|出错了|Error:)/.test(visible),
    '画面里不能出现用户可见的错误文案');
});

test('★ 奖品大屏是整屏场景：动态背景 + contain 图片', () => {
  const html = readPage('render/prize.html');
  const visible = html.replace(/<!--[\s\S]*?-->/g, '');
  assert.match(visible, /liveroom-background\.mp4/, '必须引用直播间动态背景');
  assert.match(visible, /liveroom-background\.png/, '必须有静态 PNG 兜底');
  assert.match(visible, /<video[^>]*autoplay[^>]*muted[^>]*loop/i,
    '背景视频必须自动播放、静音、循环');
  assert.match(visible, /background:\s*#0a0b0d/i, '整屏场景必须有不透明底色');
  assert.match(visible, /object-fit:\s*contain/i, '奖品图片必须完整显示（contain）');
  assert.ok(!/background\s*:\s*transparent/i.test(visible), '奖品大屏不是透明叠加');
});

test('★ 受众页面必须声明正确的 audience（S-REQ-105）', () => {
  const expect = { 'director.html': 'director', 'cast.html': 'cast' };
  for (const [f, aud] of Object.entries(expect)) {
    const html = readPage(f);
    assert.match(html, new RegExp(`audience:\\s*'${aud}'`), `${f} 未声明 audience: '${aud}'`);
  }
});

test('★ 页面引用的所有 /api 路径都必须在服务端注册过', () => {
  let serverSrc = '';
  const routesDir = path.join(ROOT, 'server', 'routes');
  for (const f of fs.readdirSync(routesDir)) serverSrc += fs.readFileSync(path.join(routesDir, f), 'utf8');
  serverSrc += fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');

  const registered = new Set();
  for (const m of serverSrc.matchAll(/[.](get|post|put|delete|use)\(\s*['"`](\/[^'"`]*)/g)) registered.add(m[2]);

  const normalize = (p) => p
    .replace(/\/\$\{[^}]*\}/g, '/:id')
    .replace(/\/(:[A-Za-z]+)/g, '/:id');

  const missing = [];
  for (const f of PAGES) {
    const html = readPage(f);
    for (const m of html.matchAll(/['"`](\/api\/[A-Za-z0-9_/:${}.-]*)/g)) {
      const raw = m[1];
      if (raw.includes('${') && !raw.includes('/api/')) continue;
      const want = normalize(raw);
      const hit = [...registered].some((sp) => {
        const s = normalize(sp);
        return s === want || want.startsWith(`${s}/`) || s.startsWith(`${want}/`);
      });
      if (!hit) missing.push(`${f}: ${raw}`);
    }
  }
  assert.deepEqual([...new Set(missing)], [], '页面引用了服务端不存在的接口');
});

test('★ 页面使用的所有 WS op 都必须在服务端注册过（S-REQ-103）', () => {
  const indexSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  // H = 普通注册；R / T 是带功能开关的别名（feature: replay / transitions），
  // 同样走 hub.registerOp，所以扫描时一并算作「已注册」。
  const registered = new Set([...indexSrc.matchAll(/[HRT]\(\s*['"]([A-Za-z0-9_.:]+)['"]/g)].map((m) => m[1]));

  const used = new Set();
  for (const f of PAGES) {
    const html = readPage(f);
    for (const m of html.matchAll(/cmd\(\s*['"]([A-Za-z0-9_.:]+)['"]/g)) used.add(m[1]);
    // 也覆盖 cmd(cond ? 'a' : 'b', ...) 这种写法
    for (const m of html.matchAll(/cmd\([^)]*\?\s*['"]([A-Za-z0-9_.:]+)['"]\s*:\s*['"]([A-Za-z0-9_.:]+)['"]/g)) {
      used.add(m[1]); used.add(m[2]);
    }
  }
  const missing = [...used].filter((op) => !registered.has(op));
  assert.deepEqual(missing, [], `页面调用了未注册的 WS op：${missing.join(', ')}`);
  assert.ok(used.size > 20, `只扫描到 ${used.size} 个 op，可能正则失效了`);
});

test('★ 浏览器端不得直连 obs-websocket（G-REQ-110 / A-REQ-003）', () => {
  // 模块 A 不依赖 obs-websocket；所有 OBS 交互都必须经过中转服务。
  // 判定的是「有没有真的去连」而不是「有没有提到这个词」——
  // 首页的架构图里会写到 obs-websocket，那只是说明文字。
  for (const f of PAGES) {
    const html = readPage(f);
    assert.ok(!/new\s+WebSocket\s*\(\s*[`'"]ws/i.test(html),
      `${f} 直接构造了外部 WebSocket —— 浏览器端只允许连 /ws`);
    for (const m of html.matchAll(/new\s+WebSocket\(([^)]*)\)/g)) {
      assert.match(m[1], /ws|location/i, `${f} 的 WebSocket 目标不是中转服务：${m[1]}`);
    }
    // OBS WebSocket 默认端口不得出现在连接语境里
    assert.ok(!/4455/.test(html) || !/WebSocket/.test(html),
      `${f} 同时出现 4455 与 WebSocket —— 疑似直连 OBS`);
  }
});

test('渲染端页面必须引入渲染引擎，且不得引用控制端的 ui.js', () => {
  for (const f of ['render/main.html', 'render/credits.html']) {
    const srcs = externalScriptsOf(fs.readFileSync(path.join(PUBLIC, f), 'utf8'));
    assert.ok(srcs.some((s) => s.includes('renderer.js')), `${f} 缺少 renderer.js`);
    assert.ok(srcs.some((s) => s.includes('/shared/ws.js')), `${f} 缺少 ws.js`);
    assert.ok(!srcs.some((s) => s.includes('/shared/ui.js')),
      `${f} 不应引入控制端的 ui.js —— 渲染端要保持极简，且 ui.js 会往 body 里插 DOM`);
  }
});

test('所有页面的 charset 都是 UTF-8（S-REQ-110：中日英混排与 emoji）', () => {
  for (const f of FULL_PAGES()) {
    assert.match(readPage(f), /<meta\s+charset=["']?utf-8["']?/i, `${f} 缺少 <meta charset="utf-8">`);
  }
});

test('每个页面都必须有 <title> 与 viewport（移动端/浏览器源都要）', () => {
  for (const f of FULL_PAGES()) {
    const html = readPage(f);
    assert.match(html, /<title>[^<]+<\/title>/, `${f} 缺少 <title>`);
    assert.match(html, /name=["']viewport["']/, `${f} 缺少 viewport`);
  }
});
