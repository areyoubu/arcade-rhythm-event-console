/**
 * OBS 输出配色主题 —— 所有输出给 OBS 的场景共用。
 *
 * 主题由 config.theme.scheme 驱动（设置页 → 输出配色），渲染端通过 WS hello / patch
 * 拿到当前值；也可以给渲染源加 ?theme=official 临时预览某个主题。
 *
 * 主题只改「品牌色 + 面板/描边 + 文字」这一类全局观感，**不动**选手侧颜色
 * （--left-color / --right-color）与提示优先级色（--p0..p3），那些是语义色。
 *
 * 参考 CHUNITHM 官网与各版本视觉：
 *   default  —— 经典金（深灰 + 琥珀金，当前默认）
 *   official —— CHUNITHM 官网：青蓝霓虹 + 深海军蓝
 *   xverse   —— CHUNITHM X-VERSE-X：洋红 + 青霓虹
 */
(function () {
  'use strict';

  const THEMES = {
    default: {
      label: '经典金',
      accent: '#d9a441', accent2: '#b0812f', accentRgb: '217,164,65', accentBorder: '#5a4a22',
      ink: '#ffffff', inkDim: '#c7ccd6', inkMute: '#8c93a0',
      panel: 'rgba(10,11,14,.86)', panel2: 'rgba(16,17,21,.86)', card: 'rgba(10,10,12,.93)',
      line: 'rgba(255,255,255,.14)', lineSoft: 'rgba(255,255,255,.08)',
      bg: '#0a0b0d',
    },
    official: {
      label: 'CHUNITHM 官网',
      accent: '#00c8ff', accent2: '#ff4f9a', accentRgb: '0,200,255', accentBorder: '#0e4a5c',
      ink: '#ffffff', inkDim: '#c9eaff', inkMute: '#7fa8c0',
      panel: 'rgba(6,16,26,.88)', panel2: 'rgba(10,22,34,.88)', card: 'rgba(8,18,28,.93)',
      line: 'rgba(120,200,255,.18)', lineSoft: 'rgba(120,200,255,.10)',
      bg: '#050b12',
    },
    xverse: {
      label: 'X-VERSE-X',
      accent: '#ff3fa4', accent2: '#00e5ff', accentRgb: '255,63,164', accentBorder: '#5c1440',
      ink: '#ffffff', inkDim: '#ffd9ec', inkMute: '#b98ca8',
      panel: 'rgba(20,6,18,.88)', panel2: 'rgba(26,8,22,.88)', card: 'rgba(20,6,18,.93)',
      line: 'rgba(255,120,200,.18)', lineSoft: 'rgba(255,120,200,.10)',
      bg: '#0c0510',
    },
  };

  /** 根据底色亮度选黑/白字，保证色块上的文字在 OBS 里看得清（与 match.js 同口径）。 */
  function contrastInk(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return '#ffffff';
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.62 ? '#111111' : '#ffffff';
  }

  /** URL 上显式指定的主题：优先级最高，WS 后续下发也不能把它盖掉 */
  let FIXED_SCHEME = null;
  try {
    const q = new URLSearchParams(location.search).get('theme');
    if (q && THEMES[q]) FIXED_SCHEME = q;
  } catch { /* ignore */ }

  function resolveScheme() {
    if (FIXED_SCHEME) return FIXED_SCHEME;
    const fromState = window.arcadeWS?.path?.('config.theme.scheme');
    return THEMES[fromState] ? fromState : 'default';
  }

  /** 把颜色往黑色压暗 t（0–1），浅色底上的文字用 */
  function shade(hex, t = 0.4) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return '#000000';
    const n = parseInt(m[1], 16);
    const k = 1 - Math.max(0, Math.min(1, t));
    const to = (v) => Math.round(v * k).toString(16).padStart(2, '0');
    return `#${to((n >> 16) & 255)}${to((n >> 8) & 255)}${to(n & 255)}`;
  }

  /** 主题色 → rgba()，供浅色底上的柔和描边 / 阴影使用 */
  function alpha(hex, a = 1) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return `rgba(0,0,0,${a})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  /** 当前生效的主题名（含 ?theme= 覆盖） */
  function current() {
    return document.documentElement.dataset.theme || 'default';
  }

  function accentOf(scheme = current()) {
    return (THEMES[scheme] || THEMES.default).accent;
  }

  /**
   * 明亮风格下的中性色。
   *
   * 深色主题里 --ink 是白的、--panel 是近黑的；切成明亮后必须整体翻转，
   * 否则各场景里 `color: var(--ink)` 的文字会白底白字（随机选曲的标题就是这样看不见的）。
   * 面板不做到纯白：透明叠加类场景要压在机台画面上。
   */
  const LIGHT_VARS = {
    '--ink': '#0e1b26',
    '--ink-dim': '#3a566e',
    '--ink-mute': '#6b8299',
    '--dim': '#3a566e',
    '--mute': '#6b8299',
    '--panel': 'rgba(255,255,255,.88)',
    '--panel-2': 'rgba(255,255,255,.94)',
    '--card': 'rgba(255,255,255,.92)',
    '--line': 'rgba(18,52,80,.16)',
    '--line-soft': 'rgba(18,52,80,.10)',
    '--bg': '#eef6fb',
  };

  let STYLE_MODE = 'dark';

  function apply(scheme) {
    const t = THEMES[scheme] || THEMES.default;
    const root = document.documentElement;
    root.dataset.theme = scheme;
    const vars = {
      '--accent': t.accent,
      '--gold': t.accent,            // 兼容用 --gold 命名的场景（比分 / 抽奖 / 奖品 / 选曲二维码）
      '--cam-accent': t.accent,      // 解说摄像头叠加
      '--accent-2': t.accent2,
      '--accent-rgb': t.accentRgb,   // 供 rgba(var(--accent-rgb), a) 派生发光色
      '--accent-border': t.accentBorder, // 与强调色搭配的深色描边（原 #5a4a22）
      '--ink': t.ink,
      '--ink-dim': t.inkDim,
      '--ink-mute': t.inkMute,
      '--dim': t.inkDim,             // 抽奖 / 奖品场景用 --dim / --mute
      '--mute': t.inkMute,
      '--panel': t.panel,
      '--panel-2': t.panel2,
      '--card': t.card,
      '--line': t.line,
      '--line-soft': t.lineSoft,
      '--bg': t.bg,
    };
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    // 主题重设会把中性色写回深色值，明亮风格要再盖一次
    if (STYLE_MODE === 'light') applyStyleVars();
  }

  /** 把中性色切换成明亮风格的一套（或恢复主题自带的深色值） */
  function applyStyleVars() {
    const root = document.documentElement;
    if (STYLE_MODE === 'light') {
      for (const [k, v] of Object.entries(LIGHT_VARS)) root.style.setProperty(k, v);
    } else {
      // 回到深色：清掉覆盖，让 apply() 设定的主题值重新生效
      for (const k of Object.keys(LIGHT_VARS)) root.style.removeProperty(k);
      const t = THEMES[current()] || THEMES.default;
      const restore = {
        '--ink': t.ink, '--ink-dim': t.inkDim, '--ink-mute': t.inkMute,
        '--dim': t.inkDim, '--mute': t.inkMute,
        '--panel': t.panel, '--panel-2': t.panel2, '--card': t.card,
        '--line': t.line, '--line-soft': t.lineSoft, '--bg': t.bg,
      };
      for (const [k, v] of Object.entries(restore)) root.style.setProperty(k, v);
    }
  }

  // ── 输出风格：明亮 / 暗 ───────────────────────────────
  /*
   * 场景页面靠 `html[data-style="light"]` 切换浅色遮罩等观感；
   * ?style=light|dark 可以临时预览，优先级高于服务端配置。
   */
  const FIXED_STYLE = (() => {
    try {
      const q = new URLSearchParams(location.search).get('style');
      return q === 'light' || q === 'dark' ? q : null;
    } catch { return null; }
  })();

  function applyStyle(style) {
    const next = FIXED_STYLE || (style === 'light' ? 'light' : 'dark');
    if (next === STYLE_MODE && document.documentElement.dataset.style === next) return;
    STYLE_MODE = next;
    document.documentElement.dataset.style = next;
    applyStyleVars();
  }

  // 先同步应用当前（默认）主题，避免 OBS 源首帧闪成未定义变量
  apply(resolveScheme());
  applyStyle(window.arcadeWS?.path?.('config.theme.style') || 'dark');

  if (window.arcadeWS) {
    // 主题是全局配置，任何端都能从 hello / patch 里读到，无需登录
    arcadeWS.watch('config.theme.scheme', (v) => {
      if (FIXED_SCHEME) return;   // ?theme= 预览固定，不被服务端值覆盖
      apply(v || 'default');
    });
    arcadeWS.watch('config.theme.style', (v) => applyStyle(v));
  }

  // 供场景脚本给难度色块等取黑白字 / 在浅色底上派生强调色
  window.renderTheme = { THEMES, apply, contrastInk, shade, alpha, current, accentOf };
})();
