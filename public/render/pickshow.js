/**
 * 选手选曲展示渲染端（OBS target=pickshow）。
 *
 * 只读 pickshow.state：
 *   side  = both | left | right
 *   count = 2 | 4
 *   source= current | upcoming
 * 数据来自对外网手机选歌器（/pick）提交到比赛模块的选曲队列。
 */
(function () {
  'use strict';

  const Q = new URLSearchParams(location.search);
  const PREVIEW = Q.get('preview') === '1';
  const CANVAS = { width: 1920, height: 1080 };

  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const el = {
    source: $('sourceChip'), count: $('countChip'),
    matchName: $('matchName'), matchSub: $('matchSub'),
    grid: $('showGrid'), video: $('bgVideo'),
    audio: $('previewAudio'),
  };

  // 展示动画：新的 revealSeq 会播放；OBS 在点击后 15 秒内重载页面（例如
  // 「切走时关闭源」后再切回来）也补播一次，之后重载则直接落到最终态。
  const REVEAL_LOAD_WINDOW = 15_000;
  let lastSeq = null;
  let animTimer = null;

  // 公共控制器负责：浏览器自动播放被拦截时的「点击启用声音」提示 + 缓入缓出
  const previewAudio = window.createPreviewAudio(el.audio);
  function stopPreviewAudio() { previewAudio.stop(); }
  function playPreviewAudio(audio) { previewAudio.play(audio); }

  if (Q.get('static') === '1' && el.video) {
    el.video.hidden = true;
    for (const s of el.video.querySelectorAll('source')) s.remove();
    try { el.video.pause(); el.video.removeAttribute('src'); el.video.load(); } catch { /* ignore */ }
  }
  if (el.video && Q.get('static') !== '1') {
    const hide = () => { el.video.hidden = true; };
    el.video.addEventListener('error', hide);
    for (const s of el.video.querySelectorAll('source')) s.addEventListener('error', hide);
    const p = el.video.play?.();
    if (p && typeof p.catch === 'function') p.catch(() => { /* poster */ });
  }

  (function fit() {
    if (Q.get('fit') !== '1') return;
    const s = Math.min(window.innerWidth / CANVAS.width, window.innerHeight / CANVAS.height, 1);
    stage.style.transformOrigin = 'top left';
    stage.style.transform = s < 1 ? `scale(${s})` : 'none';
    window.addEventListener('resize', () => location.reload());
  })();

  function div(cls, text) {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    if (text !== undefined) d.textContent = text;
    return d;
  }
  function setText(node, v) { if (node) node.textContent = v == null ? '' : String(v); }

  function coverNode(pick, cls) {
    if (pick && pick.cover) {
      const img = document.createElement('img');
      img.className = cls;
      img.alt = '';
      img.loading = 'eager';
      img.src = pick.cover;
      img.onerror = () => img.replaceWith(div(`${cls} ph`, '♪'));
      return img;
    }
    return div(`${cls} ph`, '♪');
  }

  function playerPanel(side, data, count) {
    const p = data.players?.[side] || {};
    const fallbackName = side === 'left' ? 'P1' : 'P2';
    const name = p.name || fallbackName;

    const panel = document.createElement('section');
    panel.className = `panel ${side}`;

    const avatar = div('avatar');
    if (p.image) {
      const img = document.createElement('img');
      img.alt = '';
      img.src = p.image;
      img.onload = () => img.classList.add('on');
      img.onerror = () => { img.remove(); };
      avatar.append(img);
    }
    avatar.append(div('fb', (name || '?').slice(0, 1)));

    const info = div('p-info');
    info.append(div('p-name', name));
    if (p.teamName) info.append(div('p-team', p.teamName));

    const head = div('p-head');
    head.append(avatar, info);
    panel.append(head);

    const cards = div('cards');
    const picks = Array.isArray(data[side]) ? data[side] : [];
    for (let i = 0; i < count; i++) {
      const pick = picks[i];
      const card = div(`card${pick ? '' : ' empty'}`);
      card.style.setProperty('--i', String(i));
      if (pick) {
        card.append(coverNode(pick, 'cover'));
        card.append(div('t', pick.title || '未命名曲目'));
        card.append(div('a', pick.artist || '—'));
        const meta = div('m');
        const chip = document.createElement('span');
        chip.className = 'diff-chip';
        chip.textContent = `${pick.difficultyName || ''} ${pick.levelText || pick.level || ''}`.trim();
        chip.style.background = pick.difficultyColor || '#4a4e56';
        chip.style.color = window.renderTheme?.contrastInk(pick.difficultyColor) || '#ffffff';
        meta.append(chip);
        card.append(meta);
      } else {
        card.append(div('cover ph', '♪'));
        card.append(div('t', '等待选曲'));
        card.append(div('a', '选手在手机选歌器提交后显示'));
      }
      cards.append(card);
    }
    panel.append(cards);
    return panel;
  }

  /**
   * 应用展示/收起状态。
   * animate=true 时先把元素放到 .pre 的 3D 初始位，下一帧移除 .pre，
   * 由 .animating 上的 transition 展开到正常位置。
   */
  function applyReveal(revealed, animate, seq) {
    clearTimeout(animTimer);
    stage.classList.remove('is-idle', 'pre', 'animating', 'revealed');
    delete stage.dataset.animSeq;
    if (!revealed) {
      stage.classList.add('is-idle');
      return;
    }
    if (!animate) {
      stage.classList.add('revealed');
      return;
    }
    stage.dataset.animSeq = String(seq);
    stage.classList.add('pre', 'animating');
    void stage.offsetWidth;                    // 强制回流，确保初始位生效
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        stage.classList.remove('pre');
        stage.classList.add('revealed');
        animTimer = setTimeout(() => {
          stage.classList.remove('animating');
          delete stage.dataset.animSeq;
        }, 1800);
      });
    });
  }

  function render(state) {
    const opts = state.options || {};
    const side = ['both', 'left', 'right'].includes(opts.side) ? opts.side : 'both';
    const n = Number(state.count);
    const count = n >= 4 ? 4 : n <= 1 ? 1 : 2;
    const colors = state.colors || {};

    for (const c of ['side-both', 'side-left', 'side-right', 'count-1', 'count-2', 'count-4']) stage.classList.remove(c);
    stage.classList.add(`side-${side}`, `count-${count}`);

    document.documentElement.style.setProperty('--left-color', colors.left || '#d0344e');
    document.documentElement.style.setProperty('--right-color', colors.right || '#3d78c9');

    setText(el.source, state.sourceLabel || (opts.source === 'upcoming' ? '即将进行' : '当前局'));
    setText(el.count, side === 'both' ? `每人 ${count} 首` : `${count} 首`);
    setText(el.matchName, state.matchName || '选手选曲');

    const totals = state.totals || { left: 0, right: 0 };
    const counts = side === 'both'
      ? `P1 ${totals.left || 0} 首 / P2 ${totals.right || 0} 首`
      : `${side === 'left' ? 'P1' : 'P2'} ${totals[side] || 0} 首`;
    setText(el.matchSub, `PLAYER PICKS · ${state.sourceLabel || '当前局'} · ${counts}`);

    const sides = side === 'both' ? ['left', 'right'] : [side];
    el.grid.replaceChildren(...sides.map((s) => playerPanel(s, state, count)));
    // 双人时右场稍晚入场，形成左右交替的 3D 展开节奏
    if (side === 'both' && el.grid.children[1]) {
      el.grid.children[1].style.setProperty('--side-delay', '150ms');
    }

    const seq = Number(state.revealSeq) || 0;
    const revealed = state.revealed === true;
    const freshLoad = lastSeq === null && revealed
      && Number(state.revealedAt) > 0
      && Date.now() - Number(state.revealedAt) < REVEAL_LOAD_WINDOW;
    const animate = revealed && seq !== lastSeq && (lastSeq !== null || freshLoad);

    // 动画进行中收到同一条状态（例如选手刚好提交了新选曲）：
    // 保留已排好的 .pre / .animating，新 DOM 会继续完成同一次展开。
    if (!animate && revealed && stage.classList.contains('pre')
      && stage.dataset.animSeq === String(seq)) {
      lastSeq = seq;
      return;
    }

    applyReveal(revealed, animate, seq);
    lastSeq = seq;

    // 音频只在「展开动画」时开始：待展示 / 普通状态更新不打断，
    // 重新播动画会从头播放当前默认曲目（双人默认 P1）。
    if (!revealed || state.options?.audio === false) stopPreviewAudio();
    else if (animate) playPreviewAudio(state.audio);
  }

  function emptyState() {
    return {
      options: { side: 'both', count: '2', source: 'current' },
      count: 2,
      sourceLabel: '当前局',
      matchName: '选手选曲',
      players: {},
      colors: {},
      left: [],
      right: [],
      totals: { left: 0, right: 0 },
      revealed: false,
      revealSeq: 0,
    };
  }

  const TARGET = PREVIEW ? 'pickshow-preview' : 'pickshow';

  // watch 自己会在 hello 时补一次当前值 —— 不要再额外监听 hello，
  // 否则同一次连接会 render 两遍，第二遍会把刚启动的 3D 动画直接跳到终点。
  arcadeWS.watch('pickshow.state', (v) => render(v || emptyState()));
  if (!PREVIEW) arcadeWS.on('open', () => arcadeWS.notify('overlay:ready', { target: TARGET }));

  // 首屏保持 HTML 里的 .idle，等 hello 的权威状态再决定展示 / 待展示。
  // 这样 OBS 重载已展开过的页面时不会重新播动画，也不会提前泄露选曲。
  arcadeWS.start({ target: TARGET });
  console.log('[pickshow] ready');
})();
