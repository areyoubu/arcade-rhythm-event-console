/**
 * 抽奖大屏渲染端（OBS 浏览器源）。
 *
 * 状态由服务端驱动：
 *   phase=spinning → 名字滚动
 *   phase=revealed → 中奖卡 + 彩带
 *   idle          → 什么都不画（保持透明）
 *
 * 动画只在状态切换时启动，状态不变不重播。
 */
(function () {
  'use strict';

  const Q = new URLSearchParams(location.search);
  if (Q.get('preview') === '1') document.body.classList.add('preview');
  if (Q.get('window') === '1') document.body.classList.add('windowed');

  const stage = document.getElementById('stage');
  const spinCard = document.getElementById('spinCard');
  const winCard = document.getElementById('winCard');
  const spinName = document.getElementById('spinName');
  const winName = document.getElementById('winName');
  const winTeam = document.getElementById('winTeam');
  const winIndex = document.getElementById('winIndex');
  const winAvatar = document.getElementById('winAvatar');
  const winFb = document.getElementById('winFb');
  const canvas = document.getElementById('confetti');
  // jsdom / 极老浏览器可能没有 2D 上下文：没有就跳过彩带，不影响抽奖
  const ctx = canvas.getContext ? canvas.getContext('2d') : null;

  let flickerTimer = null;
  let confettiRaf = null;
  let lastRevision = -1;
  let lastPhase = '';

  function setText(node, value) {
    const s = value === null || value === undefined ? '' : String(value);
    if (node && node.textContent !== s) node.textContent = s;
  }

  function setImage(img, src) {
    const next = src || '';
    if (img.dataset.src === next) return;
    img.dataset.src = next;
    img.classList.remove('is-ready');
    if (!next) { img.removeAttribute('src'); return; }
    img.onload = () => img.classList.add('is-ready');
    img.onerror = () => img.classList.remove('is-ready');
    img.src = next;
  }

  function layout() {
    if (Q.get('fit') === '0') return;
    const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080, 1);
    stage.style.transformOrigin = 'top left';
    stage.style.transform = s < 1 ? `scale(${s})` : 'none';
    canvas.style.transformOrigin = 'top left';
    canvas.style.transform = s < 1 ? `scale(${s})` : 'none';
  }
  window.addEventListener('resize', layout);
  layout();

  // ── 滚动名字 ──
  function stopFlicker() {
    if (flickerTimer) clearTimeout(flickerTimer);
    flickerTimer = null;
  }

  function startFlicker(sample) {
    stopFlicker();
    const names = Array.isArray(sample) && sample.length ? sample : ['？？？'];
    let i = 0;
    const tick = () => {
      spinName.textContent = names[i % names.length];
      i = (i + 1 + Math.floor(Math.random() * 3)) % names.length;
      flickerTimer = setTimeout(tick, 55 + Math.random() * 45);
    };
    tick();
  }

  // ── 彩带 ──
  function stopConfetti() {
    if (confettiRaf) cancelAnimationFrame(confettiRaf);
    confettiRaf = null;
    if (ctx) ctx.clearRect(0, 0, 1920, 1080);
  }

  function burstConfetti() {
    if (!ctx) return;
    stopConfetti();
    canvas.width = 1920;
    canvas.height = 1080;
    const colors = ['#d9a441', '#ffffff', '#d0344e', '#3d78c9', '#c9c9c4'];
    const parts = [];
    for (let i = 0; i < 180; i++) {
      parts.push({
        x: 960 + (Math.random() - 0.5) * 760,
        y: 540 + (Math.random() - 0.5) * 160,
        vx: (Math.random() - 0.5) * 18,
        vy: -Math.random() * 16 - 4,
        g: 0.35 + Math.random() * 0.25,
        w: 8 + Math.random() * 10,
        h: 4 + Math.random() * 8,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.3,
        color: colors[Math.floor(Math.random() * colors.length)],
      });
    }
    const start = performance.now();
    const draw = (now) => {
      const t = now - start;
      ctx.clearRect(0, 0, 1920, 1080);
      const fade = Math.max(0, 1 - t / 4200);
      for (const p of parts) {
        p.vy += p.g;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (t < 4500) confettiRaf = requestAnimationFrame(draw);
      else { ctx.clearRect(0, 0, 1920, 1080); confettiRaf = null; }
    };
    confettiRaf = requestAnimationFrame(draw);
  }

  function renderWinner(w) {
    setText(winName, w.name || '');
    setText(winTeam, w.team || '');
    setText(winIndex, w.index || 1);
    setText(winFb, (w.name || '?').slice(0, 1));
    setImage(winAvatar, w.image || '');
  }

  function apply(state) {
    if (!state || typeof state !== 'object') return;
    if (state.revision === lastRevision && state.phase === lastPhase) return;
    lastRevision = state.revision;
    lastPhase = state.phase;

    stopFlicker();
    spinCard.classList.add('hidden');
    winCard.classList.add('hidden');
    stage.classList.remove('empty');

    if (state.phase === 'spinning') {
      spinCard.classList.remove('hidden');
      startFlicker(state.spin?.sample);
      stopConfetti();
      return;
    }

    if (state.phase === 'revealed' && state.winner) {
      winCard.classList.remove('hidden');
      renderWinner(state.winner);
      burstConfetti();
      return;
    }

    // idle：完全透明，只保留预览提示
    stage.classList.add('empty');
    stopConfetti();
  }

  // ── WS ──
  arcadeWS.on('hello', (m) => apply(m?.state?.lottery?.state));
  arcadeWS.on('lottery:state', (m) => apply(m.state));
  arcadeWS.on('open', () => arcadeWS.notify('overlay:ready', { target: 'lottery' }));
  arcadeWS.start({ target: 'lottery' });

  console.log('[lottery] ready');
})();
