/**
 * 比分条 / 选手牌渲染端（OBS 浏览器源）。
 *
 * 尺寸约定（与 server/score.js 的 LAYER_BASE 保持一致）：
 *   比分条 1180×104，选手牌 470×116（设计尺寸，1920×1080 画布里的 1:1 像素）。
 *   合并输出按 layout 摆放 + 缩放；分件输出按同一个 scale 1:1 渲染，
 *   所以同一个元件在预览、合并输出、分件输出里看起来一样大。
 *
 * 性能取舍：
 *   · 不引模板引擎、不建 Shadow DOM、不做动画循环；
 *   · 每次状态更新只改发生变化的 textContent / img.src / 位置；
 *   · 只建一条 WS 连接。
 */
(function () {
  'use strict';

  const Q = new URLSearchParams(location.search);
  if (Q.get('preview') === '1') document.body.classList.add('preview');
  if (Q.get('window') === '1') document.body.classList.add('windowed');

  const $ = (id) => document.getElementById(id);
  const el = {
    stage: $('stage'),
    bar: $('bar'), plates: $('plates'),
    leftPlate: document.querySelector('.plate-left'),
    rightPlate: document.querySelector('.plate-right'),
    leftTeamBox: document.querySelector('.team-left'),
    rightTeamBox: document.querySelector('.team-right'),
    leftScore: $('leftScore'), rightScore: $('rightScore'),
    leftTeam: $('leftTeam'), rightTeam: $('rightTeam'),
    leftTeamText: $('leftTeamText'), rightTeamText: $('rightTeamText'),
    leftLogo: $('leftLogo'), rightLogo: $('rightLogo'),
    label: $('label'), meta: $('meta'),
    leftPlayerName: $('leftPlayerName'), rightPlayerName: $('rightPlayerName'),
    leftTeamName: $('leftTeamName'), rightTeamName: $('rightTeamName'),
    leftPlayerImg: $('leftPlayerImg'), rightPlayerImg: $('rightPlayerImg'),
  };

  const PART = Q.get('part') || 'all';
  const EDIT = Q.get('edit') === '1';
  document.body.classList.add(PART === 'all' ? 'part-all' : 'part', `part-${PART}`);

  /** 设计尺寸（必须与 score.html 的 CSS 和 server/score.js 的 LAYER_BASE 一致） */
  const BASE = {
    bar: { w: 1180, h: 104 },
    left: { w: 470, h: 116 },
    right: { w: 470, h: 116 },
  };
  const DEFAULT_LAYOUT = {
    bar: { x: 370, y: 44, scale: 1 },
    left: { x: 64, y: 172, scale: 1 },
    right: { x: 1386, y: 172, scale: 1 },
  };
  const nodes = { bar: el.bar, left: el.leftPlate, right: el.rightPlate };
  let layoutState = JSON.parse(JSON.stringify(DEFAULT_LAYOUT));
  let fitScale = 1;

  /**
   * 合并输出：1920×1080，窗口比它小时整体等比缩小（预览用）。
   * 分件输出：画布 = 设计尺寸，整张画布按该元件的 layout.scale 缩放并居中；
   *           所以只要 OBS 源尺寸 = 设计尺寸 × scale，就和合并输出完全一致。
   */
  function layout() {
    if (PART !== 'all') {
      const b = BASE[PART] || BASE.bar;
      const sc = (layoutState[PART] || DEFAULT_LAYOUT[PART]).scale || 1;
      el.stage.style.width = `${b.w}px`;
      el.stage.style.height = `${b.h}px`;
      el.stage.style.left = '50%';
      el.stage.style.top = '50%';
      el.stage.style.transformOrigin = 'center center';
      el.stage.style.transform = `translate(-50%, -50%) scale(${sc})`;
      return;
    }
    if (Q.get('fit') === '0') return;
    fitScale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080, 1);
    el.stage.style.transformOrigin = 'top left';
    el.stage.style.transform = fitScale < 1 ? `scale(${fitScale})` : 'none';
  }

  function applyLayout() {
    if (PART === 'all') {
      for (const part of Object.keys(nodes)) {
        const l = layoutState[part] || DEFAULT_LAYOUT[part];
        const n = nodes[part];
        if (!n) continue;
        n.style.left = `${l.x}px`;
        n.style.top = `${l.y}px`;
        n.style.transformOrigin = 'top left';
        n.style.transform = `scale(${l.scale})`;
      }
    }
    layout();
  }

  function setText(node, value) {
    const s = value === null || value === undefined ? '' : String(value);
    if (node && node.textContent !== s) node.textContent = s;
  }

  /**
   * 队伍名：放得下就按边对齐，放不下就左右滚动。
   * 与总比分画面的曲名滚动同一套做法：文本没变不重启动画，量出溢出量后
   * 用 CSS 变量驱动 translateX 往返，不跑 JS 动画循环。
   */
  function setTeamName(wrap, node, value) {
    if (!wrap || !node) return;
    const text = value === null || value === undefined ? '' : String(value);
    if (node.dataset.text !== text) {
      node.dataset.text = text;
      node.textContent = text;
      wrap.classList.remove('scrolling');
      wrap.style.removeProperty('--shift');
      wrap.style.removeProperty('--dur');
    }
    const measure = () => {
      if (node.dataset.text !== text) return;
      const overflow = node.scrollWidth - wrap.clientWidth;
      if (overflow > 4) {
        wrap.classList.add('scrolling');
        wrap.style.setProperty('--shift', `${-overflow}px`);
        wrap.style.setProperty('--dur', `${Math.max(5, Math.min(16, overflow / 30))}s`);
      } else {
        wrap.classList.remove('scrolling');
        wrap.style.removeProperty('--shift');
        wrap.style.removeProperty('--dur');
      }
    };
    // 先量一次（读 scrollWidth 会强制同步布局），再下一帧补一次：
    // 即便页面被 OBS 判定为后台、rAF 被节流，滚动也能正常启用。
    measure();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(measure);
  }

  /** 只在 URL 变化时重新赋值，避免反复触发图片解码；加载完成前不显示 */
  function setImage(node, src) {
    if (!node) return;
    const next = src || '';
    if (node.dataset.src === next) return;
    node.dataset.src = next;
    if (!next) {
      node.classList.remove('is-ready');
      node.removeAttribute('src');
      return;
    }
    node.classList.remove('is-ready');
    node.onload = () => node.classList.add('is-ready');
    node.onerror = () => node.classList.remove('is-ready');
    node.src = next;
  }

  function applySide(prefix, side) {
    if (!side) return;
    const scoreText = String(side.score ?? 0);
    setText(el[`${prefix}Score`], scoreText);
    // 总分会到 7 位，按位数缩字号（CSS 里定义 4–8 位）
    const scoreNode = el[`${prefix}Score`];
    if (scoreNode) scoreNode.dataset.digits = String(scoreText.length);
    // 没选队伍时用 A / B 兜底，比分条不会只剩一个数字；过长时自动滚动
    setTeamName(el[`${prefix}Team`], el[`${prefix}TeamText`], side.teamName || side.side || '');
    setText(el[`${prefix}TeamName`], side.teamName || '');
    // 选手条常驻：没人时显示「待选」，不要整块消失
    setText(el[`${prefix}PlayerName`], side.playerName || '待选');
    setImage(el[`${prefix}Logo`], side.teamImage);
    setImage(el[`${prefix}PlayerImg`], side.playerImage);

    const teamBox = el[`${prefix}TeamBox`];
    const plate = el[`${prefix}Plate`];
    for (const node of [teamBox, plate]) {
      if (!node) continue;
      node.classList.toggle('is-winner', side.isWinner === true);
      node.classList.toggle('is-draw', side.isDraw === true);
    }
  }

  function apply(state) {
    if (!state || typeof state !== 'object') return;

    if (state.layout) {
      for (const part of Object.keys(DEFAULT_LAYOUT)) {
        const l = state.layout[part];
        if (l) layoutState[part] = { ...DEFAULT_LAYOUT[part], ...l };
      }
    }

    document.body.classList.toggle('is-hidden', state.visible === false);
    document.documentElement.style.setProperty('--left-color', state.left?.color || '#d0344e');
    document.documentElement.style.setProperty('--right-color', state.right?.color || '#3d78c9');

    el.bar.classList.toggle('hidden-part', state.barVisible === false);
    // 1P / 2P 选手条常驻：只受开关控制，不因为没选人而隐藏
    el.plates.classList.toggle('hidden-part', state.platesVisible === false);

    applySide('left', state.left);
    applySide('right', state.right);
    setText(el.label, state.label || '');
    setText(el.meta, state.meta || '');
    applyLayout();
  }

  // ── 控制台预览里的拖动（?edit=1） ──
  // 拖动只改位置，不改变缩放；松手后把画布坐标回传给父页面保存。
  function enableDrag() {
    if (!EDIT || PART !== 'all') return;
    document.body.classList.add('edit');
    for (const [part, node] of Object.entries(nodes)) {
      if (!node) continue;
      node.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const startX = e.clientX;
        const startY = e.clientY;
        const origin = { ...(layoutState[part] || DEFAULT_LAYOUT[part]) };
        const move = (ev) => {
          const nx = Math.round(origin.x + (ev.clientX - startX) / (fitScale || 1));
          const ny = Math.round(origin.y + (ev.clientY - startY) / (fitScale || 1));
          layoutState[part] = { ...layoutState[part], x: nx, y: ny };
          node.style.left = `${nx}px`;
          node.style.top = `${ny}px`;
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          const l = layoutState[part];
          try { parent.postMessage({ type: 'score-layout', part, x: l.x, y: l.y }, location.origin); } catch { /* ignore */ }
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
    }
  }

  window.addEventListener('resize', layout);
  enableDrag();

  // ── WS ──
  // 先注册监听，再连接：避免 open/hello 在注册之前到达而漏掉首帧
  arcadeWS.on('hello', (m) => apply(m?.state?.score?.state));
  arcadeWS.on('score:state', (m) => apply(m.score));
  /**
   * 必须声明自己是渲染端，否则服务端的 toRenderers(..., 'score') 找不到这个连接，
   * 比分变化只会进控制端的 patch，不会推到这个浏览器源（表现：首帧正常，之后永不更新）。
   */
  arcadeWS.on('open', () => arcadeWS.notify('overlay:ready', { target: 'score' }));

  arcadeWS.start({ target: 'score' });

  console.log('[score] ready');
})();
