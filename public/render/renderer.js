/**
 * 渲染端引擎 —— OBS 浏览器源（浮窗）。
 *
 * ★ 硬约束（G-REQ-205 / A-REQ-530）：页面必须 background: transparent; margin: 0; overflow: hidden
 * ★ A-REQ-001：模块 A **不依赖 obs-websocket**。显隐完全由本页面内部 DOM 状态决定，
 *   绝不通过 SetSceneItemEnabled 控制。理由：避免 OBS 硬切导致动画中断、避免切场景时闪一下。
 *
 * 需求覆盖：
 *   A-REQ-003  只接收，不发起任何业务请求
 *   A-REQ-505  ★ 热改：显示中修改槽位 → 原地更新，**不重播动画**
 *   A-REQ-213  ★ 模板热重载：仅替换结构并**保留当前数据**，不得整页 reload
 *   A-REQ-511  回放模式联动：切文案，不中断动画、不重建 DOM
 *   A-REQ-534  WS 断开自动重连（退避 1s→2s→4s→上限 10s），重连后全量同步
 *   A-REQ-535  ★ WS 断开期间**保持当前画面**，不得清空（避免直播空屏）
 *   A-REQ-536  须内置 console.log('[overlay] ready')
 *   A-REQ-537  ★ 离线兜底：服务不可达时显示默认内容或空白，**不得显示错误信息**
 *   A-REQ-531  ?preview=1    控制端 iframe 预览模式
 *   A-REQ-532  ?scale=       适配非 1920×1080 画布
 *   A-REQ-533  ?guides=1     安全区参考线（仅预览可见，OBS 中不可见）
 *   A-REQ-409  图片预加载完成前不显示（避免半张图）
 *   A-REQ-410  图片加载失败显示占位符
 *   A-REQ-602  模板热重载保留当前数据
 *   A-REQ-604  渲染完成后上报 overlay:rendered
 *   A-REQ-605  所有文案 UTF-8 安全
 */
(function () {
  'use strict';

  // ── URL 参数 ─────────────────────────────────────────────
  const Q = new URLSearchParams(location.search);
  const TARGET = window.__FORCE_TARGET
    || Q.get('target')
    || (location.pathname.includes('credits') ? 'credits' : 'main');
  const IS_PREVIEW = Q.get('preview') === '1';
  const SCALE_PARAM = Q.get('scale');
  const FIT = Q.get('fit') === '1';
  const SHOW_GUIDES = Q.get('guides') === '1';

  const CANVAS = { width: Number(Q.get('w')) || 1920, height: Number(Q.get('h')) || 1080 };

  /** A-REQ-410：加载失败时的占位符（内联 SVG，不依赖任何外部资源） */
  const PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">'
    + '<rect width="120" height="120" fill="#1a1a1a"/>'
    + '<path d="M28 84l22-28 15 18 12-14 15 24z" fill="#2f3648"/>'
    + '<circle cx="44" cy="40" r="9" fill="#2f3648"/>'
    + '</svg>',
  );

  // ── 状态 ─────────────────────────────────────────────────
  let templates = new Map();          // id -> 模板定义
  let current = null;                 // { id, values, host, shadow, body, visible }
  let mode = 'live';
  let modeLabel = null;
  let disconnectedAt = 0;
  let lastRenderedAt = 0;

  // ── DOM 骨架 ─────────────────────────────────────────────
  const stage = document.createElement('div');
  stage.id = 'stage';
  document.body.append(stage);

  const chrome = document.createElement('div');
  chrome.className = 'ov-chrome';
  stage.append(chrome);

  const badge = document.createElement('div');
  badge.className = 'ov-replay-badge';
  badge.style.display = 'none';
  chrome.append(badge);

  const styleEl = document.createElement('style');
  styleEl.textContent = RENDERER_CSS();
  document.head.append(styleEl);

  if (IS_PREVIEW) document.body.classList.add('preview');
  if (SHOW_GUIDES && IS_PREVIEW) mountGuides();
  applyScale();

  // ══════════════════════════════════════════════════════════
  // WS 接入（A-REQ-003：只接收）
  // ══════════════════════════════════════════════════════════
  const ws = window.arcadeWS;

  ws.start({ target: TARGET });

  ws.on('open', () => {
    // A-REQ-603：渲染端须上报 overlay:ready
    ws.notify('overlay:ready', { target: TARGET, ua: navigator.userAgent });
    if (disconnectedAt) {
      console.log(`[overlay] reconnected after ${Date.now() - disconnectedAt}ms（画面保持不变）`);
      disconnectedAt = 0;
    }
  });

  ws.on('close', () => {
    disconnectedAt = Date.now();
    // ★ A-REQ-535：什么都不做。画面保持原样，不清空、不报错。
  });

  // A-REQ-536：握手日志，便于在 OBS 日志里排查
  console.log('[overlay] ready');

  // ══════════════════════════════════════════════════════════
  // 输出风格：明亮 / 暗（config.theme.style）
  //
  // 模板是「各写各的 CSS」的，所以这里不做 19 份重复模板，而是在生成模板 CSS 时
  // 按颜色亮度 + 属性种类重映射：深色面板 → 半透明白面板，浅色文字 → 深色墨字，
  // 强调色（高饱和）原样保留。模板热重载 / 新增模板都会自动获得明亮版。
  // ══════════════════════════════════════════════════════════
  const STYLE_FORCED = Q.get('style') === 'light' ? 'light'
    : Q.get('style') === 'dark' ? 'dark' : null;
  let STYLE_MODE = STYLE_FORCED || 'dark';
  document.documentElement.dataset.style = STYLE_MODE;

  /** 明亮皮肤的墨色 / 面板色（刻意不做纯白：叠加在机台画面上不能太抢） */
  const LIGHT_INK = '#0d1a24';
  const LIGHT_INK2 = '#33506a';
  const LIGHT_INK3 = '#4a6579';
  const LIGHT_HAIR = { r: 18, g: 52, b: 80 };
  const LIGHT_SURFACE = { r: 252, g: 254, b: 255 };

  const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;

  function parseColor(raw) {
    const s = String(raw || '').trim();
    let m = /^#([0-9a-fA-F]{3,8})$/.exec(s);
    if (m) {
      let hex = m[1];
      if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
      if (hex.length !== 6 && hex.length !== 8) return null;
      const n = (i) => parseInt(hex.slice(i, i + 2), 16);
      return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) / 255 : 1 };
    }
    m = /^rgba?\(([^)]+)\)$/.exec(s);
    if (m) {
      const p = m[1].split(',').map((x) => x.trim());
      if (p.length < 3) return null;
      const num = (x) => Number.parseFloat(x);
      if ([p[0], p[1], p[2]].some((x) => !Number.isFinite(num(x)))) return null;
      return { r: num(p[0]), g: num(p[1]), b: num(p[2]), a: p[3] === undefined ? 1 : Math.max(0, Math.min(1, num(p[3]))) };
    }
    return null;
  }
  function cssColor(c) {
    const r = Math.round(Math.max(0, Math.min(255, c.r)));
    const g = Math.round(Math.max(0, Math.min(255, c.g)));
    const b = Math.round(Math.max(0, Math.min(255, c.b)));
    const a = Math.round(Math.max(0, Math.min(1, c.a ?? 1)) * 1000) / 1000;
    return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`;
  }
  const hexToRgb = (hex) => parseColor(hex) || { r: 13, g: 26, b: 36, a: 1 };
  const lumOf = (c) => (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
  const satOf = (c) => (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)) / 255;

  /**
   * 单个颜色的明亮化。
   * @param {'bg'|'ink'|'line'|'shadow'|'glowText'} kind
   */
  function lightenColor(c, kind) {
    if (!c || c.a < 0.03) return c;
    const L = lumOf(c);
    const S = satOf(c);
    // 高饱和 = 品牌色 / 选手色 / 霓虹光，一律保留（只把过亮的文字色压一点）
    const accent = S > 0.24 && L > 0.12 && L < 0.97;

    if (kind === 'bg') {
      if (accent) return c;
      if (L >= 0.78) return c;                                  // 本来就是浅色面板
      return { ...LIGHT_SURFACE, a: Math.min(0.90, Math.max(0.82, c.a || 0.88)) };
    }
    if (kind === 'ink') {
      if (accent) return c;
      const a = Math.max(0.82, c.a);
      if (L >= 0.84) return { ...hexToRgb(LIGHT_INK), a };
      if (L >= 0.58) return { ...hexToRgb(LIGHT_INK2), a };
      if (L >= 0.34) return { ...hexToRgb(LIGHT_INK3), a };
      return c;
    }
    if (kind === 'line') {
      if (accent) return c;
      return { ...LIGHT_HAIR, a: 0.22 };
    }
    if (kind === 'shadow') {
      // 深色投影 → 冷灰柔影（不要黑糊糊一片）
      if (L < 0.5 && S < 0.22) return { ...LIGHT_HAIR, a: Math.min(0.16, Math.max(0.06, c.a * 0.4)) };
      return { ...c, a: Math.min(0.6, c.a * 0.55) };
    }
    if (kind === 'glowText') {
      // 深色文字阴影 → 白色描边光：亮底与机台画面上都能读
      if (L < 0.5 && S < 0.22) return { r: 255, g: 255, b: 255, a: 0.85 };
      return { ...c, a: Math.min(0.55, c.a * 0.5) };
    }
    return c;
  }

  function replaceColors(value, kind) {
    return String(value).replace(COLOR_RE, (raw) => {
      const c = parseColor(raw);
      if (!c) return raw;
      return cssColor(lightenColor(c, kind));
    });
  }

  /** 属性 → 颜色角色 */
  function kindOfProp(prop) {
    if (prop === 'background' || prop === 'background-color' || prop === 'background-image') return 'bg';
    if (prop === 'color') return 'ink';
    if (prop === 'box-shadow') return 'shadow';
    if (prop === 'text-shadow') return 'glowText';
    if (/^border(-(top|right|bottom|left))?$/.test(prop) || /^border-(top|right|bottom|left)-color$/.test(prop) || prop === 'outline' || prop === 'outline-color') return 'line';
    return null;
  }

  /**
   * 模板是不是「直接压在画面上」的（没有底板）。
   *
   * 判据：给文字配了**深色** text-shadow —— 这是模板作者为了让白字在任意画面上
   * 都读得清而加的描边光，只有无底板的样式才会这么写。
   * 这类模板在明亮风格下必须保持白字 + 深色描边，改成深色字反而看不清。
   */
  function isOverVideoCss(css) {
    const shadows = String(css).match(/text-shadow:[^;}]*/g) || [];
    for (const decl of shadows) {
      for (const raw of decl.match(COLOR_RE) || []) {
        const c = parseColor(raw);
        if (c && c.a > 0.25 && lumOf(c) < 0.45 && satOf(c) < 0.25) return true;
      }
    }
    return false;
  }

  /** 把一段模板 CSS 变成明亮版（逐条声明重映射颜色） */
  function lightenCss(css, { keepInk = false } = {}) {
    return String(css).replace(/([^{}]+)\{([^{}]*)\}/g, (whole, sel, decls) => {
      const out = decls.split(';').map((decl) => {
        const i = decl.indexOf(':');
        if (i < 0) return decl;
        const prop = decl.slice(0, i).trim().toLowerCase();
        const kind = kindOfProp(prop);
        if (!kind) return decl;
        // 无底板模板：文字与描边光保持原样（白字 + 深色描边在任何画面上都成立）
        if (keepInk && (kind === 'ink' || kind === 'glowText')) return decl;
        return `${decl.slice(0, i + 1)}${replaceColors(decl.slice(i + 1), kind)}`;
      }).join(';');
      return `${sel}{${out}}`;
    });
  }

  /**
   * cssVars 里的近白色强调色（默认 #d9d9d9）在亮底上会糊掉，
   * 只把「很亮且不太饱和」的值压到中等明度，选手色 / 品牌色不动。
   */
  function lightenVars(vars) {
    const out = {};
    for (const [k, v] of Object.entries(vars || {})) {
      const c = parseColor(v);
      if (!c || c.a < 0.5) { out[k] = v; continue; }
      const L = lumOf(c);
      const S = satOf(c);
      if (S < 0.3 && L > 0.76) {
        const k2 = 0.45 / L;
        out[k] = cssColor({ r: c.r * k2, g: c.g * k2, b: c.b * k2, a: c.a });
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  function setStyleMode(mode) {
    const next = STYLE_FORCED || (mode === 'light' ? 'light' : 'dark');
    const changed = next !== STYLE_MODE;
    STYLE_MODE = next;
    document.documentElement.dataset.style = next;
    if (changed) refreshAllTemplateCss();
  }

  /**
   * 槽位值直接写进 CSS 变量时（强调色 / 选手色），近白色在亮底上会糊成一片，
   * 明亮风格下压到中等明度；品牌色 / 选手色（有饱和度）保持原样。
   */
  function adaptiveVarValue(value) {
    if (STYLE_MODE !== 'light') return String(value ?? '');
    const c = parseColor(value);
    if (!c) return String(value ?? '');
    const L = lumOf(c);
    const S = satOf(c);
    if (S >= 0.3 || L <= 0.7) return String(value);
    const k = 0.45 / Math.max(L, 0.001);
    return cssColor({ r: c.r * k, g: c.g * k, b: c.b * k, a: c.a });
  }

  /** 风格切换后：全部模板样式 + 当前上屏模板的 shadow 样式都要重算 */
  function refreshAllTemplateCss() {
    for (const [id, t] of templates) {
      const s = document.querySelector(`style[data-tpl="${cssEscape(id)}"]`);
      if (s) s.textContent = buildTemplateCss(t);
    }
    const sr = current?.host?.shadowRoot;
    if (sr && current?.tpl) {
      const s = sr.querySelector('style');
      if (s) s.textContent = buildTemplateCss(current.tpl);
      // 强调色是写在行内样式里的，样式表换了也得重新套一遍
      applyValues(current.shadow, current.tpl, current.values);
    }
  }

  // ── 服务端 → 渲染端 ──────────────────────────────────────
  ws.on('overlay:hello', (m) => {
    if (m.templates) applyTemplateList(m.templates);
  });

  ws.on('overlay:templates', (m) => {
    // ★ A-REQ-213 / A-REQ-602：只替换**受影响的模板结构**，保留当前数据
    if (Array.isArray(m.templates)) applyTemplateList(m.templates, { hot: true });
    if (Array.isArray(m.removed)) {
      for (const id of m.removed) {
        templates.delete(id);
        removeStyle(id);
        if (current && current.id === id) clear({ animate: false });
      }
    }
  });

  ws.on('overlay:show', (m) => {
    if (m.target && m.target !== TARGET) return;
    if (m.templateDef) upsertTemplate(m.templateDef);
    show(m.template, m.values || {}, m.anim, { rebuild: m.rebuild !== false, mode: m.mode });
  });

  ws.on('overlay:update', (m) => {
    if (m.target && m.target !== TARGET) return;
    // ★ A-REQ-505 / A-REQ-601：局部更新，不得重渲染或动画重播
    updateSlot(m.slot, m.value);
  });

  ws.on('overlay:updateMany', (m) => {
    if (m.target && m.target !== TARGET) return;
    for (const [slot, value] of Object.entries(m.values || {})) updateSlot(slot, value);
    reportRendered();
  });

  ws.on('overlay:hide', (m) => {
    if (m.target && m.target !== TARGET) return;
    hide(m.anim);
  });

  ws.on('overlay:clear', (m) => {
    if (m.target && m.target !== TARGET) return;
    clear({ animate: false });
  });

  ws.on('overlay:pin', (m) => {
    if (m.target && m.target !== TARGET) return;
    if (m.pinned) stage.dataset.pinned = '1'; else delete stage.dataset.pinned;
  });

  // ★ A-REQ-511：只换文案，不重建 DOM、不中断动画
  ws.on('overlay:mode', (m) => {
    if (m.target && m.target !== TARGET) return;
    setMode(m.mode, m.label);
  });

  ws.on('overlay:credits', (m) => creditsControl(m));

  ws.on('hello', (m) => {
    const st = m.state || {};
    if (st.overlay?.mode) setMode(st.overlay.mode, st.overlay.modeLabel);
    setStyleMode(st.config?.theme?.style || 'dark');
  });
  ws.watch?.('config.theme.style', (v) => setStyleMode(v || 'dark'));

  // 兜底：HTTP 拉一次模板表（WS 尚未连上时也能先渲染）
  if (IS_PREVIEW) {
    fetch('/api/render/bootstrap').then((r) => r.json()).then((d) => {
      if (d && d.ok && Array.isArray(d.templates)) applyTemplateList(d.templates, { hot: true });
    }).catch(() => { /* A-REQ-537：静默 */ });
  }

  // ══════════════════════════════════════════════════════════
  // 模板管理
  // ══════════════════════════════════════════════════════════

  function applyTemplateList(list, { hot = false } = {}) {
    let activeChanged = false;
    for (const t of list) {
      const changed = upsertTemplate(t);
      if (changed && hot && current && current.id === t.id) activeChanged = true;
    }
    if (activeChanged) {
      // A-REQ-213：替换 DOM 节点，保留当前数据，**不重播动画**
      rebuildActivePreservingValues();
    }
  }

  function upsertTemplate(t) {
    if (!t || !t.id) return false;
    const prev = templates.get(t.id);
    const changed = !prev || prev.__rev !== revOf(t);
    templates.set(t.id, { ...t, __rev: revOf(t) });
    // CSS 单独放一个 <style data-tpl>，热重载时整体替换即可（不触碰 DOM 结构）
    let s = document.querySelector(`style[data-tpl="${cssEscape(t.id)}"]`);
    if (!s) {
      s = document.createElement('style');
      s.dataset.tpl = t.id;
      document.head.append(s);
    }
    const cssText = buildTemplateCss(t);
    if (s.textContent !== cssText) s.textContent = cssText;
    return changed;
  }

  function revOf(t) {
    return `${hash(t.html || '')}|${hash(t.css || '')}|${hash(JSON.stringify(t.cssVars || {}))}|${hash(JSON.stringify(t.slots || []))}`;
  }
  function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  /** A-REQ-211 CSS 变量 + A-REQ-212 自定义 CSS 片段注入 + 自定义动画 */
  function buildTemplateCss(t) {
    const light = STYLE_MODE === 'light';
    const vars = Object.entries(light ? lightenVars(t.cssVars) : (t.cssVars || {}))
      .map(([k, v]) => `${k}:${v};`).join('');
    const baseCss = t.css || '';
    const caster = keyframesCss(t);
    if (!light) return `${caster}\n[tpl="${t.id}"]{${vars}}\n${baseCss}`;
    /*
     * 明亮风格额外补一条「无阴影面板」的柔影。
     * :where() = 零优先级，模板自己写了 box-shadow（霓虹发光等）时不会被覆盖，
     * 只给原本没有任何阴影的白面板一个边界，避免叠在亮画面上糊成一片。
     */
    const skin = ':where([class$="-panel"],[class$="-card"]){box-shadow:0 10px 26px rgba(18,52,80,.16);}';
    return `${caster}\n[tpl="${t.id}"]{${vars}}\n${lightenCss(baseCss, { keepInk: isOverVideoCss(baseCss) })}\n${skin}`;
  }

  function removeStyle(id) {
    const s = document.querySelector(`style[data-tpl="${cssEscape(id)}"]`);
    if (s) s.remove();
  }

  function cssEscape(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  function keyframesCss() { return ''; }

  // ══════════════════════════════════════════════════════════
  // 显示 / 热改 / 隐藏
  // ══════════════════════════════════════════════════════════

  /**
   * @param {string} templateId
   * @param {object} values
   * @param {{in:string,out:string,durationMs:number}|null} anim
   * @param {{rebuild:boolean, mode?:string}} opts
   */
  async function show(templateId, values, anim, opts = {}) {
    const tpl = templates.get(templateId);
    if (!tpl) {
      // 模板未知（服务端刚改过、消息乱序）—— 保持当前画面，静默丢弃
      console.warn('[overlay] 未知模板，已忽略：', templateId);
      return;
    }

    const rebuild = opts.rebuild !== false;
    const sameTemplate = current && current.id === templateId;

    if (sameTemplate && !rebuild) {
      // ★ A-REQ-505 / 陷阱 #52：同一模板再次 show = 热改语义。
      //   只更新槽位值，不重建 DOM，**也不重播入场动画**（重播会让画面"闪一下"）。
      const wasVisible = current.visible;
      for (const [k, v] of Object.entries(values || {})) updateSlot(k, v);
      current.visible = true;
      // 只有从「隐藏 → 显示」这一种情况才播入场动画
      if (!wasVisible) playIn();
      reportRendered();
      return;
    }

    if (!rebuild && current) {
      // 服务端认为不必重建（同模板），但这里没有可复用的 DOM —— 走完整构建
    }

    // ── 完整构建 ──
    const host = document.createElement('div');
    host.className = 'ov-tpl';
    host.setAttribute('tpl', templateId);

    let root = host;
    try {
      const shadow = host.attachShadow({ mode: 'open' });
      const styleNode = document.createElement('style');
      styleNode.textContent = buildTemplateCss(tpl);
      shadow.append(styleNode);
      const body = document.createElement('div');
      body.className = 'ov-tpl-body';
      shadow.append(body);
      root = body;
    } catch {
      // 环境不支持 shadow DOM（极旧 CEF）→ 退回 light DOM
      const styleNode = document.createElement('style');
      styleNode.textContent = buildTemplateCss(tpl);
      document.head.append(styleNode);
    }

    // ★ 先在**未插值**的原始模板上抽取行原型，再做插值 —— 顺序反了会让多值槽位渲染成空白
    const multiProtos = extractMultiPrototypes(tpl.html || '');

    // 先放进一个**游离**容器，等图片预加载完再挂载（A-REQ-409：不显示半张图）
    const body = root;
    root.innerHTML = interpolateHtml(tpl.html || '', values);

    const prevHost = current?.host || null;
    current = { id: templateId, values: { ...values }, host, shadow: body, tpl, visible: true, multiProtos };

    await preloadImages(root, values);

    applyValues(root, tpl, values);

    // 交接：旧节点移除，新节点挂上（同一帧内，不会闪）
    if (prevHost && prevHost !== host) prevHost.remove();
    stage.append(host);
    stage.dataset.tpl = templateId;
    maybeStartRoll();

    // 入场动画
    playIn(anim || tpl.defaultAnim);
    reportRendered();
  }

  function playIn(anim) {
    if (!current?.host) return;
    const a = anim || current.tpl?.defaultAnim || {};
    const spec = KEYFRAMES[a.in] || KEYFRAMES.fadeIn;
    const duration = Number(a.durationMs) || 400;
    if (!spec || a.in === 'none' || duration === 0) {
      current.host.style.opacity = '1';
      return;
    }
    try {
      // Web Animations API：可被 cancel，能干净地处理"打断"
      if (current.anim) current.anim.cancel();
      current.anim = current.host.animate(spec.from, {
        duration, easing: spec.easing || 'cubic-bezier(.22,.9,.3,1)', fill: 'both',
      });
      current.anim.finished?.catch(() => { /* 被打断属正常 */ });
    } catch {
      current.host.style.opacity = '1';
    }
  }

  async function hide(anim) {
    if (!current) return;
    rollStop();
    const c = current;
    const a = anim || c.tpl?.defaultAnim || {};
    const spec = KEYFRAMES[a.out] || KEYFRAMES.fadeIn;
    const duration = Number(a.durationMs) || 400;

    if (!spec || a.out === 'none' || duration === 0) {
      c.host.remove();
      current = null;
      delete stage.dataset.tpl;
      reportRendered();
      return;
    }

    try {
      // 出场 = 入场关键帧的逆放：从末帧回到首帧
      const frames = [spec.from[spec.from.length - 1], spec.from[0]];
      const a2 = c.host.animate(frames, { duration, easing: 'cubic-bezier(.4,0,1,1)', fill: 'both' });
      await a2.finished.catch(() => { /* 忽略打断 */ });
    } catch { /* 动画不可用就直接移除 */ }

    // 动画期间如果已经 show 了新内容，不要误删
    if (current === c) {
      c.host.remove();
      current = null;
      delete stage.dataset.tpl;
    }
    reportRendered();
  }

  function clear() {
    rollStop();
    if (current?.host) current.host.remove();
    current = null;
    delete stage.dataset.tpl;
    reportRendered();
  }

  /** 当前是滚动致谢时启动滚动引擎；其它模板则确保引擎已停 */
  function maybeStartRoll() {
    if (current?.id !== 'thanksRoll') { rollStop(); return; }
    const track = current.shadow?.querySelector('[data-credits-track]');
    if (track) rollStart(track);
    else rollStop();
  }

  // ══════════════════════════════════════════════════════════
  // ★ 热改：就地更新槽位（A-REQ-505 / A-REQ-601）
  // ══════════════════════════════════════════════════════════

  function updateSlot(slot, value) {
    if (!current) return;
    current.values[slot] = value;
    const tpl = current.tpl;
    const def = (tpl.slots || []).find((s) => s.key === slot);
    const root = current.shadow;

    // ① 元素级绑定 data-slot="<slot>"
    const nodes = root.querySelectorAll(`[data-slot="${cssAttr(slot)}"]`);
    for (const node of nodes) applyOne(node, value, def);

    // ② 声明为「别人的 CSS 变量」的槽位（data-set-var="--x:slotKey"）
    //    例：thanksGrid 的 columns 槽位 → --tg-cols。
    //    ★ 必须在「找不到 data-slot」的兜底之前处理：否则这类槽位每次改动都会
    //      掉进「重建整个结构」的分支，白白重建 DOM（A-REQ-505 要求就地更新）。
    let varHits = 0;
    for (const node of root.querySelectorAll('[data-set-var]')) {
      const pairs = String(node.dataset.setVar).split(',').map((s) => s.trim()).filter(Boolean);
      for (const p of pairs) {
        const [varName, key] = p.split(':').map((s) => s.trim());
        if (key === slot && varName?.startsWith('--')) {
          node.style.setProperty(varName, adaptiveVarValue(value));
          varHits++;
        }
      }
    }

    // ③ 两种绑定都没有 → 模板只在 {{slot}} 里用到它（少见），只能重建结构，但**不重播动画**
    if (!nodes.length && !varHits) {
      rebuildActivePreservingValues();
      return;
    }

    reportRendered();
  }

  function applyOne(node, value, def) {
    const kind = node.dataset.slotType || (def?.type === 'image' ? 'image' : 'text');

    if (kind.startsWith('stylevar:')) {
      const varName = kind.slice('stylevar:'.length);
      node.style.setProperty(varName, adaptiveVarValue(value));
      return;
    }
    if (kind.startsWith('attr:')) {
      const attr = kind.slice('attr:'.length);
      if (value === '' || value == null) node.removeAttribute(attr);
      else node.setAttribute(attr, String(value));
      return;
    }

    // ★ 多值槽位：**与槽位类型无关**都要走行渲染。
    //   之前只在 `kind === 'image'` 里判断 multi，导致 `text + multi` 的
    //   致谢条目（lines）被当成普通文本，整个数组被塞进 textContent，
    //   行原型被覆盖 —— 表现为滚动致谢一条都渲染不出来。
    if (node.dataset.slotMulti !== undefined || def?.multi) {
      renderMulti(node, value, def);
      return;
    }

    if (kind === 'image') { setImage(node, value); return; }
    if (kind === 'html') { node.innerHTML = String(value ?? ''); return; }

    // 默认：textContent（不解析 HTML，天然防注入，也保证 UTF-8 安全 —— A-REQ-605）
    node.textContent = value == null ? '' : String(value);
  }

  function applyValues(root, tpl, values) {
    for (const def of tpl.slots || []) {
      const nodes = root.querySelectorAll(`[data-slot="${cssAttr(def.key)}"]`);
      for (const node of nodes) applyOne(node, values[def.key], def);
    }
    // data-set-var 的元素（跨槽位的 CSS 变量引用）
    for (const node of root.querySelectorAll('[data-set-var]')) {
      const pairs = String(node.dataset.setVar).split(',').map((s) => s.trim()).filter(Boolean);
      for (const p of pairs) {
        const [varName, key] = p.split(':').map((s) => s.trim());
        if (varName?.startsWith('--')) node.style.setProperty(varName, adaptiveVarValue(values[key]));
      }
    }
  }

  /**
   * 从**未插值的**模板 HTML 里抽出每个多值槽位的「行原型」。
   *
   * ★ 这一步必须发生在插值之前。
   * 行原型里的 `{{image}}` / `{{name}}` 是**逐行数据**的占位符，不是槽位值；
   * 如果先跑 interpolateHtml，它们会被替换成空串，之后无论有多少条数据，
   * 渲染出来都是一个个空白格子（线上表现：网格致谢整片空白）。
   *
   * @returns {Map<string, string>} slotKey -> 行原型 HTML（仍含 {{…}} 占位符）
   */
  function extractMultiPrototypes(html) {
    const map = new Map();
    if (!html) return map;
    const probe = document.createElement('div');
    probe.innerHTML = html;
    for (const host of probe.querySelectorAll('[data-slot][data-slot-multi]')) {
      const row = host.firstElementChild;
      if (row) map.set(host.getAttribute('data-slot'), row.outerHTML);
    }
    return map;
  }

  /** 多值槽位（致谢条目 / Logo 行 / 赞助商网格） */
  function renderMulti(container, value, def) {
    if (!current) return;
    const key = def?.key || container.getAttribute('data-slot');
    // 行原型缓存来自**原始模板**，第二次及以后的渲染也不会退化成「拿上次渲染结果当模板」
    const tplHtml = current.multiProtos?.get(key) || (container.firstElementChild?.outerHTML ?? '');
    if (!tplHtml) return;

    const items = Array.isArray(value) ? value : (value ? [value] : []);
    const frag = document.createDocumentFragment();
    items.forEach((item, i) => {
      // 字符串项按「既当文字又当图片地址」处理，兼容 lines / logoRow 两种用法
      const obj = typeof item === 'string'
        ? { index: i, item, text: item, image: item, src: item, name: item, alt: item, url: item }
        : { index: i, ...item };
      // 字段别名：不同模板作者可能写 {{src}} / {{image}} / {{url}}，统一补齐
      const s = obj.src || obj.image || obj.url || '';
      obj.src = s; obj.image = s; obj.url = s;
      obj.item = obj.text ?? obj.name ?? s;
      obj.alt = obj.alt ?? obj.name ?? '';

      const html = tplHtml.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_m, k) => escapeHtml(pick(obj, k)));
      const wrap = document.createElement('div');
      wrap.innerHTML = html;
      while (wrap.firstElementChild) frag.append(wrap.firstElementChild);
    });
    container.replaceChildren(frag);
    // 新插入的图片也要走预加载流程
    preloadImages(container, {});
  }

  // ══════════════════════════════════════════════════════════
  // 图片：预加载 + 占位符（A-REQ-409 / 410）
  // ══════════════════════════════════════════════════════════

  function preloadImages(root, values) {
    const imgs = [...root.querySelectorAll('img')];
    if (!imgs.length) return Promise.resolve();

    const jobs = imgs.map((img) => new Promise((resolve) => {
      // data-slot 的 img 值由 applyValues 稍后写入；这里只处理模板里硬编码的 src
      const src = img.getAttribute('src');
      if (!src || src.includes('{{')) { resolve(); return; }
      const probe = new Image();
      probe.onload = () => { img.src = src; img.classList.add('is-ready'); resolve(); };
      probe.onerror = () => { img.src = PLACEHOLDER; img.classList.add('is-ready'); resolve(); };
      probe.src = src;
    }));

    const timeout = new Promise((r) => setTimeout(r, 1500));   // 兜底：不让坏图卡住整块画面
    return Promise.race([Promise.all(jobs), timeout]);
  }

  function setImage(node, value) {
    const src = typeof value === 'string' ? value : (value?.src || value?.url || value?.image || '');
    if (!src) {
      node.removeAttribute('src');
      node.classList.remove('is-ready');
      return;
    }
    // 先预加载再替换，避免半张图
    const probe = new Image();
    probe.onload = () => { node.src = src; node.classList.add('is-ready'); };
    probe.onerror = () => { node.src = PLACEHOLDER; node.classList.add('is-ready'); };
    probe.src = src;
  }

  // ══════════════════════════════════════════════════════════
  // 回放态角标（A-REQ-511）—— 由渲染端自身绘制，不占模板 DOM
  // ══════════════════════════════════════════════════════════

  function setMode(m, label) {
    const next = m === 'replay' ? 'replay' : 'live';
    const changed = mode !== next || modeLabel !== (label || null);
    mode = next;
    modeLabel = label || null;
    if (!changed && badge.dataset.label === String(label || '')) return;

    if (next === 'replay') {
      badge.style.display = '';
      badge.dataset.label = String(label || '');
      // 就地改文本，不重建节点 —— 角标自身也不播动画
      const dot = badge.querySelector('.dot') || badge.appendChild(Object.assign(document.createElement('span'), { className: 'dot' }));
      const txt = badge.querySelector('.txt') || badge.appendChild(Object.assign(document.createElement('span'), { className: 'txt' }));
      dot.textContent = '';
      txt.textContent = label ? `回放中 · ${label}` : '回放中';
    } else {
      badge.style.display = 'none';
    }
  }

  // ══════════════════════════════════════════════════════════
  // 致谢滚动引擎（A-REQ-522 / 523 / 526）
  // ══════════════════════════════════════════════════════════

  /**
   * 用 requestAnimationFrame 驱动，而不是 CSS animation。
   *
   * 为什么换掉 CSS animation：滚动速度是可调的，而修改运行中动画的
   * `animation-duration` 会按新时长**重新计算当前进度** —— 表现为
   * 「滚了一下突然弹回去」。而且时长是从内容高度算出来的，内容一变高度就变，
   * 于是每改一次速度/条目就会跳一次。
   *
   * rAF 方案里位置是一个我们自己维护的像素值：速度改了只是改变增量，
   * 位置不跳；暂停/继续/重播/跳到分组都是直接改这个值，精确可控。
   */
  const roll = {
    track: null,
    pos: 0,          // 已经滚过的像素
    total: 0,        // 滚完全程需要的像素 = 内容高 + 视口高
    speed: 40,
    mode: 'loop',
    paused: false,
    ended: false,
    raf: null,
    lastTs: 0,
  };

  function rollMeasure() {
    if (!roll.track) return;
    const h = roll.track.scrollHeight || 0;
    roll.total = h + CANVAS.height;      // 从视口下方开始，到内容完全离开
  }

  function rollApply() {
    if (!roll.track) return;
    roll.track.style.transform = `translate3d(0, ${-roll.pos.toFixed(2)}px, 0)`;
  }

  function rollStart(track) {
    rollStop();
    roll.track = track;
    roll.pos = 0;
    roll.paused = false;
    roll.ended = false;
    roll.lastTs = 0;
    roll.speed = Number(current?.values?.speed) || 40;
    roll.mode = current?.values?.mode === 'once' ? 'once' : 'loop';
    // 先把 CSS 动画彻底关掉，避免和 rAF 的 transform 打架
    track.style.animation = 'none';
    track.classList.add('tr-js-driven');
    track.style.transform = 'translate3d(0, 0, 0)';
    // 等一帧让布局稳定，再量高度（刚插入 DOM 时 scrollHeight 可能是 0）
    requestAnimationFrame(() => {
      rollMeasure();
      rollTick(performance.now());
    });
  }

  function rollStop() {
    if (roll.raf) cancelAnimationFrame(roll.raf);
    roll.raf = null;
    roll.track = null;
  }

  function rollTick(ts) {
    if (!roll.track) return;
    const dt = roll.lastTs ? Math.min(100, ts - roll.lastTs) : 16;
    roll.lastTs = ts;

    if (!roll.paused && !roll.ended && roll.total > 0) {
      roll.pos += (roll.speed * dt) / 1000;
      if (roll.pos >= roll.total) {
        if (roll.mode === 'once') {
          roll.pos = roll.total;
          roll.ended = true;              // 单次模式：停在末尾，不弹回
        } else {
          roll.pos = 0;                    // 循环模式：无缝回首（内容已在视口外）
        }
      }
      rollApply();
    }
    roll.raf = requestAnimationFrame(rollTick);
  }

  /** 值变更后重新测量（内容/速度/模式可能都变了），但**不重置位置** */
  function rollSync() {
    if (!roll.track) return;
    const prevSpeed = roll.speed;
    const prevMode = roll.mode;
    roll.speed = Number(current?.values?.speed) || prevSpeed;
    roll.mode = current?.values?.mode === 'once' ? 'once' : 'loop';
    if (roll.mode !== prevMode) roll.ended = false;
    rollMeasure();
  }

  function creditsControl(m) {
    if (!current || current.id !== 'thanksRoll') return;
    // 模板刚上屏时 track 可能还没就绪
    if (!roll.track) {
      const t = current?.shadow?.querySelector('[data-credits-track]');
      if (t) rollStart(t);
    }
    const track = roll.track;
    switch (m.action) {
      case 'pause':
        roll.paused = true;
        track?.classList.add('tr-paused');
        break;
      case 'resume':
        roll.paused = false;
        roll.ended = false;
        roll.lastTs = 0;                   // 避免恢复时把暂停期间的时间一次性补上
        track?.classList.remove('tr-paused');
        break;
      case 'restart':
        roll.pos = 0;
        roll.ended = false;
        roll.paused = false;
        roll.lastTs = 0;
        rollMeasure();
        rollApply();
        break;
      case 'jumpTo': {
        // 跳到某分组：用该行相对轨道顶部的位置直接定位
        const groupName = String(m.group || '').trim();
        if (!track) break;
        const rows = [...track.querySelectorAll('.tr-row')];
        const node = rows.find((n) => (n.querySelector('.tr-group')?.textContent || '').trim() === groupName);
        if (!node) {
          // 找不到就退化为按序号估算
          const idx = rows.findIndex((n) => (n.textContent || '').trim() === groupName);
          if (idx < 0) break;
          roll.pos = Math.max(0, (track.scrollHeight * idx) / Math.max(1, rows.length));
        } else {
          roll.pos = Math.max(0, node.offsetTop - 120);   // 稍留一点上边距
        }
        roll.ended = false;
        roll.paused = true;
        rollApply();
        track?.classList.add('tr-paused');
        break;
      }
      default: break;
    }
    reportRendered();
  }

  /** 兼容旧调用点（was: 重算 CSS 时长） */
  function recalcRollDuration() {
    if (current?.id === 'thanksRoll') rollSync();
  }

  // ══════════════════════════════════════════════════════════
  // 模板热重载：保持数据地重建（不播动画）
  // ══════════════════════════════════════════════════════════

  function rebuildActivePreservingValues() {
    if (!current) return;
    const { id, values, host, shadow } = current;
    const tpl = templates.get(id);
    if (!tpl) return;

    // 结构变了，行原型也要跟着重新抽取（同样必须在插值之前）
    current.multiProtos = extractMultiPrototypes(tpl.html || '');

    // 在**同一个宿主**里原地替换内容 —— 动画进度不中断（A-REQ-213 / 602）
    shadow.innerHTML = interpolateHtml(tpl.html || '', values);
    current.tpl = tpl;
    preloadImages(shadow, values).then(() => {
      applyValues(shadow, tpl, values);
      // 滚动轨道节点被替换了，引擎要重新挂到新节点上（位置无法保留，从头播更符合预期）
      maybeStartRoll();
    });
    host.setAttribute('tpl', id);
    const styleNode = host.shadowRoot?.querySelector('style');
    if (styleNode) styleNode.textContent = buildTemplateCss(tpl);
    reportRendered();
  }

  // ══════════════════════════════════════════════════════════
  // 动画关键帧
  // ══════════════════════════════════════════════════════════

  /**
   * 动画关键帧表。
   * 出场动画是**入场关键帧的逆放**，所以 `fadeOut` 与 `fadeIn` 用同一套帧；
   * `fadeOut` / `slideDown` 这两个别名是为了让模板作者能写自然的名字。
   */
  const KEYFRAMES = {
    none: null,
    fadeIn: { from: [{ opacity: 0 }, { opacity: 1 }], easing: 'ease-out' },
    fadeOut: { from: [{ opacity: 0 }, { opacity: 1 }], easing: 'ease-out' },
    fadeUp: { from: [{ opacity: 0, transform: 'translateY(28px)' }, { opacity: 1, transform: 'none' }] },
    fadeDown: { from: [{ opacity: 0, transform: 'translateY(-28px)' }, { opacity: 1, transform: 'none' }] },
    slideLeft: { from: [{ opacity: 0, transform: 'translateX(-56px)' }, { opacity: 1, transform: 'none' }] },
    slideRight: { from: [{ opacity: 0, transform: 'translateX(56px)' }, { opacity: 1, transform: 'none' }] },
    slideUp: { from: [{ opacity: 0, transform: 'translateY(48px)' }, { opacity: 1, transform: 'none' }] },
    slideDown: { from: [{ opacity: 0, transform: 'translateY(-48px)' }, { opacity: 1, transform: 'none' }] },
    scaleIn: { from: [{ opacity: 0, transform: 'scale(.94)' }, { opacity: 1, transform: 'none' }] },
    wipeRight: { from: [{ clipPath: 'inset(0 100% 0 0)', opacity: 1 }, { clipPath: 'inset(0 0 0 0)', opacity: 1 }] },
    blurIn: { from: [{ opacity: 0, filter: 'blur(10px)' }, { opacity: 1, filter: 'none' }] },
  };

  // ══════════════════════════════════════════════════════════
  // 工具
  // ══════════════════════════════════════════════════════════

  /** A-REQ-201：变量插值 {{key}}（构建期一次性求值） */
  function interpolateHtml(html, values) {
    if (!html) return '';
    return html.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_m, k) => {
      const v = pick(values, k);
      return escapeHtml(v);
    });
  }

  function pick(obj, path) {
    if (obj == null) return '';
    return String(path).split('.').reduce((o, k) => (o == null ? '' : o[k]), obj) ?? '';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function cssAttr(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  function reportRendered() {
    const now = performance.now();
    if (now - lastRenderedAt < 16) { lastRenderedAt = now; }
    lastRenderedAt = now;
    try { ws.notify('overlay:rendered', { target: TARGET, template: current?.id || null, at: Date.now() }); } catch { /* ignore */ }
    if (current && current.id === 'thanksRoll') recalcRollDuration();
  }

  // ── 画布缩放（A-REQ-532） ────────────────────────────────
  function applyScale() {
    let s = 1;
    if (SCALE_PARAM) s = Number(SCALE_PARAM) || 1;
    stage.style.width = `${CANVAS.width}px`;
    stage.style.height = `${CANVAS.height}px`;
    if (!SCALE_PARAM && FIT) {
      s = Math.min(window.innerWidth / CANVAS.width, window.innerHeight / CANVAS.height);
    }
    if (s !== 1) {
      stage.style.transformOrigin = 'top left';
      stage.style.transform = `scale(${s})`;
    }
  }
  window.addEventListener('resize', () => { if (FIT) applyScale(); });

  // ── 安全区参考线（A-REQ-533，仅预览可见） ────────────────
  function mountGuides() {
    const g = document.createElement('div');
    g.className = 'ov-guides';
    g.innerHTML = `
      <div class="g-action">动作安全区 90%</div>
      <div class="g-title">字幕安全区 80%</div>
      <div class="g-cross-x"></div><div class="g-cross-y"></div>
      <div class="g-info">${TARGET} · ${CANVAS.width}×${CANVAS.height} · 参考线仅预览可见</div>`;
    document.body.append(g);
  }

  // ── 渲染端自身样式 ───────────────────────────────────────
  function RENDERER_CSS() {
    return `
    html,body{margin:0;padding:0;background:transparent !important;overflow:hidden;width:100%;height:100%;}
    #stage{position:fixed;left:0;top:0;overflow:hidden;pointer-events:none;}
    .ov-tpl{position:absolute;inset:0;}
    .ov-tpl-body{position:absolute;inset:0;}
    .ov-chrome{position:absolute;inset:0;pointer-events:none;}
    .ov-replay-badge{
      position:absolute;left:50%;top:40px;transform:translateX(-50%);
      display:flex;align-items:center;gap:10px;
      padding:10px 24px;border-radius:999px;
      background:rgba(12,12,12,.9);border:2px solid #c04c4c;
      color:#ffd9c8;font:700 26px/1 'Noto Sans SC','Microsoft YaHei',system-ui,sans-serif;
      letter-spacing:2px;box-shadow:0 0 26px rgba(255,107,53,.4);white-space:nowrap;
    }
    .ov-replay-badge .dot{width:10px;height:10px;border-radius:50%;background:#c04c4c;
      animation:ov-blink 1.2s ease-in-out infinite;}
    /* 明亮风格下，回放标识也要在白底上读得清 */
    html[data-style="light"] .ov-replay-badge{
      background:rgba(255,255,255,.92);border-color:#c0392b;color:#8f1f14;
      box-shadow:0 10px 30px rgba(18,52,80,.18);}
    @keyframes ov-blink{0%,100%{opacity:1}50%{opacity:.25}}
    .ov-guides{position:fixed;inset:0;pointer-events:none;z-index:9999;
      font:12px/1.4 ui-monospace,Consolas,monospace;color:rgba(255,255,255,.5);}
    .ov-guides .g-action,.ov-guides .g-title{position:absolute;border:1px dashed rgba(255,90,90,.45);}
    .ov-guides .g-action{inset:5%;}
    .ov-guides .g-title{inset:10%;border-color:rgba(255,255,90,.42);}
    .ov-guides .g-cross-x,.ov-guides .g-cross-y{position:absolute;background:rgba(120,200,255,.35);}
    .ov-guides .g-cross-x{left:50%;top:0;bottom:0;width:1px;}
    .ov-guides .g-cross-y{top:50%;left:0;right:0;height:1px;}
    .ov-guides .g-info{position:absolute;left:8px;bottom:8px;color:rgba(160,220,255,.8);
      background:rgba(0,0,0,.55);padding:3px 8px;border-radius:5px;}
    body.preview{background:
      repeating-conic-gradient(#191d28 0% 25%, #141821 0% 50%) 50%/32px 32px !important;}
    body.preview #stage{outline:1px solid rgba(120,160,255,.25);}
    `;
  }

  // 供控制端 iframe 调试用
  window.__overlay = {
    get state() { return { target: TARGET, mode, modeLabel, template: current?.id || null, values: current?.values || {}, visible: !!current?.visible, disconnectedAt }; },
    get templates() { return [...templates.values()]; },
    setMode, recalcRollDuration,
  };
})();
