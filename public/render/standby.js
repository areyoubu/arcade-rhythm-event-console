/**
 * 直播待机画面渲染端（OBS 整屏场景）。
 *
 * 数据来源：
 *   · config.standby —— 设置 → 待机画面（比赛名称 / 比赛时间 / 滚动文案 / 开关）
 *   · match.state    —— 勾选「跟随比赛计分」时，直接用当前局名称
 *
 * 只改文字与显隐，不重建 DOM；所有动效都在 CSS 里，避免 OBS 源里跑 rAF。
 */
(function () {
  'use strict';

  const Q = new URLSearchParams(location.search);
  const CANVAS = { width: 1920, height: 1080 };

  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const el = {
    video: $('bgVideo'),
    eventName: $('eventName'),
    statusText: $('statusText'),
    clock: $('clock'),
    matchName: $('matchName'),
    matchTime: $('matchTime'),
    metaRow: $('metaRow'),
    chipState: $('chipState'),
    chipEvent: $('chipEvent'),
    mascotZone: $('mascotZone'),
    mascot: $('mascot'),
    ticker: $('ticker'),
    tickTrack: $('tickTrack'),
  };

  // ── 背景视频 ───────────────────────────────────────────
  if (el.video) {
    if (Q.get('static') === '1') {
      // 静态模式：彻底停掉视频，省 OBS 里的解码开销
      el.video.hidden = true;
      for (const s of el.video.querySelectorAll('source')) s.remove();
      try { el.video.pause(); el.video.removeAttribute('src'); el.video.load(); } catch { /* ignore */ }
    } else {
      const hide = () => {
        el.video.hidden = true;
        stage.classList.add('video-dead');
      };
      el.video.addEventListener('error', hide);
      for (const s of el.video.querySelectorAll('source')) s.addEventListener('error', hide);
      const p = el.video.play?.();
      if (p && typeof p.catch === 'function') p.catch(hide);
      // 兜底：有些情况下既不报错也不播（自动播放被策略拦下），
      // 1.8s 后仍然没画面就把静态背景露出来，避免直播时看到纯色
      setTimeout(() => {
        if (el.video.hidden) return;
        if (el.video.paused || el.video.readyState < 2) stage.classList.add('video-dead');
      }, 1800);
    }
  }

  // ── 缩放（控制台预览用） ────────────────────────────────
  function fit() {
    if (Q.get('fit') !== '1') return;
    const s = Math.min(window.innerWidth / CANVAS.width, window.innerHeight / CANVAS.height, 1);
    stage.style.transformOrigin = 'top left';
    stage.style.transform = s < 1 ? `scale(${s})` : 'none';
  }
  window.addEventListener('resize', fit);
  fit();

  // ── 配色：把主题强调色变成浅色底上能用的几个派生色 ──────
  function applyAccent() {
    const theme = window.renderTheme;
    if (!theme) return;
    const accent = theme.accentOf();
    const root = document.documentElement;
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--accent-ink', theme.shade(accent, 0.42));
    root.style.setProperty('--accent-soft', theme.alpha(accent, 0.16));
  }
  applyAccent();

  // ── 时钟 ───────────────────────────────────────────────
  let clockTimer = null;
  function tickClock() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    el.clock.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function setClockVisible(on) {
    el.clock.hidden = !on;
    if (on && !clockTimer) {
      tickClock();
      clockTimer = setInterval(tickClock, 1000);
    } else if (!on && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  }
  setClockVisible(true);

  // ── 长标题自动缩字：先按设计字号量，放不下就逐级缩 ────
  const TITLE_MAX = 96;
  const TITLE_MIN = 46;
  const TITLE_BOX = 900;   // 文字区可用宽度（.content 1000 - 左右内边距）
  function fitTitle() {
    const node = el.matchName;
    /*
     * 量宽时先切成 inline-block + nowrap：
     * 直接读块级元素的 scrollWidth，拿到的是「容器宽度」而不是「文字宽度」，
     * 于是无论标题多短都会一路缩到最小字号。
     */
    node.classList.add('measuring');
    let size = TITLE_MAX;
    node.style.fontSize = `${size}px`;
    while (size > TITLE_MIN && node.scrollWidth > TITLE_BOX) {
      size -= 4;
      node.style.fontSize = `${size}px`;
    }
    node.classList.remove('measuring');
  }

  // ── 滚动文案：两份内容 + -50% 位移动画，接缝无跳变 ──────
  function setTicker(text) {
    const t = String(text || '').trim();
    el.ticker.hidden = !t;
    if (!t) return;
    const track = el.tickTrack;
    track.replaceChildren();
    for (let i = 0; i < 2; i++) {
      const span = document.createElement('span');
      // 用「」分隔每段，纯文字也能读出分隔感
      span.textContent = t.replace(/\s*[·•|]\s*/g, '　·　');
      track.append(span);
    }
    // 时长跟着文本长度走，长文案不会滚得像飞一样
    const dur = Math.max(18, Math.min(60, [...t].length * 0.42));
    track.style.setProperty('--marquee-dur', `${dur}s`);
  }

  let CFG = {};
  function apply(cfg, { matchName = null } = {}) {
    CFG = cfg && typeof cfg === 'object' ? cfg : {};

    el.eventName.textContent = String(CFG.eventName || 'TOURNAMENT').trim() || 'TOURNAMENT';
    el.statusText.textContent = String(CFG.statusText || 'STANDBY').trim() || 'STANDBY';
    el.chipEvent.textContent = String(CFG.eventName || 'TOURNAMENT').trim().toUpperCase().slice(0, 24);
    el.chipState.textContent = String(CFG.statusText || 'READY').trim().toUpperCase().slice(0, 16);

    // 比赛名称：跟随比赛计分时优先用当前局名称
    const followed = CFG.followMatch ? String(matchName || '').trim() : '';
    const name = followed || String(CFG.matchName || '').trim() || '比赛即将开始';
    if (el.matchName.textContent !== name) {
      el.matchName.textContent = name;
      fitTitle();
    }

    const time = String(CFG.matchTime || '').trim();
    el.matchTime.textContent = time || '待定';
    el.metaRow.hidden = false;

    el.mascotZone.hidden = CFG.showMascot === false;
    setClockVisible(CFG.showClock !== false);
    setTicker(CFG.note);
  }

  function currentMatchName() {
    return window.arcadeWS?.path?.('match.state.current.name') || null;
  }

  // ── WS ─────────────────────────────────────────────────
  function sync() {
    if (document.activeElement) { /* 渲染端没有输入框，无需保护焦点 */ }
    apply(window.arcadeWS?.path?.('config.standby'), { matchName: currentMatchName() });
  }

  arcadeWS.on('hello', () => { sync(); applyAccent(); });
  arcadeWS.watch('config.standby', () => sync());
  arcadeWS.watch('match.state.current.name', () => {
    if (CFG.followMatch) sync();
  });
  arcadeWS.on('open', () => arcadeWS.notify('overlay:ready', { target: 'standby' }));

  // 主题切换时重算浅色底上的强调色
  window.arcadeWS?.watch?.('config.theme.scheme', () => applyAccent());

  apply({});
  arcadeWS.start({ target: 'standby' });
  console.log('[standby] ready');
})();
