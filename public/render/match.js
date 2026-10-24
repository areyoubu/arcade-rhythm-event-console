/**
 * 总比分画面渲染端（OBS 浏览器源）。
 *
 * 只建一次 DOM；每次状态更新只改文字 / 颜色 / 显隐，不重建节点、不做动画循环。
 * 空行（没有选曲、也没有任何分数）直接隐藏，面板高度随 1–4 首自适应。
 */
(function () {
  'use strict';

  const Q = new URLSearchParams(location.search);
  if (Q.get('preview') === '1') document.body.classList.add('preview');
  if (Q.get('window') === '1') document.body.classList.add('windowed');

  const $ = (id) => document.getElementById(id);

  /*
   * 背景视频：
   *   · ?static=1 强制用静态 PNG（省性能 / 视频编码不兼容时的兜底）；
   *   · 视频加载失败时隐藏 video，露出 CSS 里的静态背景；
   *   · muted + autoplay 才能让 OBS 浏览器源自动播放。
   */
  const bgVideo = $('bgVideo');
  if (bgVideo) {
    if (Q.get('static') === '1') bgVideo.hidden = true;
    const hideVideo = () => { bgVideo.hidden = true; };
    bgVideo.addEventListener('error', hideVideo);
    for (const s of bgVideo.querySelectorAll('source')) s.addEventListener('error', hideVideo);
    const p = bgVideo.play?.();
    if (p && typeof p.catch === 'function') p.catch(() => { /* 交给 poster / 静态背景 */ });
  }
  const stage = $('stage');
  const el = {
    board: $('board'),
    name: $('matchName'), status: $('matchStatus'),
    mode: $('modeChip'), count: $('countChip'),
    leftPlayer: $('leftPlayer'), rightPlayer: $('rightPlayer'),
    leftImg: $('leftImg'), rightImg: $('rightImg'),
    leftFb: $('leftFb'), rightFb: $('rightFb'),
    leftName: $('leftName'), rightName: $('rightName'),
    leftTeam: $('leftTeam'), rightTeam: $('rightTeam'),
    leftTeamLogo: $('leftTeamLogo'), rightTeamLogo: $('rightTeamLogo'),
    leftAgg: $('leftAgg'), rightAgg: $('rightAgg'),
    leftAggLabel: $('leftAggLabel'), rightAggLabel: $('rightAggLabel'),
    centerMode: $('centerMode'), centerState: $('centerState'),
    songsWrap: $('songsWrap'), songs: $('songs'), empty: $('empty'),
    footLeft: $('footLeft'), footRight: $('footRight'),
  };

  const MAX_ROWS = 4;

  function div(cls, text) {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    if (text !== undefined) d.textContent = text;
    return d;
  }
  function span(cls, text) {
    const s = document.createElement('span');
    if (cls) s.className = cls;
    if (text !== undefined) s.textContent = text;
    return s;
  }
  function setText(node, value) {
    const s = value === null || value === undefined ? '' : String(value);
    if (node && node.textContent !== s) node.textContent = s;
  }
  function setHidden(node, hidden) {
    if (node) node.classList.toggle('hidden', !!hidden);
  }
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

  /** 根据难度底色选择黑/白字，保证在 OBS 里看得清 */
  function contrastInk(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return '#ffffff';
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.62 ? '#111111' : '#ffffff';
  }

  // ── 4 行曲目表只建一次：左成绩 / 中曲目 / 右成绩 ──
  const rows = [];
  for (let i = 0; i < MAX_ROWS; i++) {
    const row = div('song-row hidden');

    const left = div('side-score left');
    const leftNum = div('score-num');
    const leftFlag = span('score-flag hidden', '胜');
    left.append(leftNum, leftFlag);

    const center = div('song-center');
    const tags = div('song-tags');
    const no = span('row-no', String(i + 1).padStart(2, '0'));
    const now = span('now hidden', 'NOW');
    const draw = span('draw-flag hidden', '平');
    const diff = span('diff');
    tags.append(no, now, draw, diff);
    const title = div('song-title');
    const artist = div('song-artist');
    const cover = document.createElement('img');
    cover.className = 'song-cover hidden';
    cover.alt = '';
    cover.loading = 'lazy';
    const text = div('song-text');
    text.append(tags, title, artist);
    center.append(cover, text);

    const right = div('side-score right');
    const rightFlag = span('score-flag hidden', '胜');
    const rightNum = div('score-num');
    right.append(rightFlag, rightNum);

    row.append(left, center, right);
    el.songs.append(row);
    rows.push({ row, no, now, draw, diff, title, artist, cover, leftNum, rightNum, leftFlag, rightFlag });
  }

  function applyPlayer(side, p, colors) {
    const key = side === 'left' ? 'left' : 'right';
    const name = p?.name || (side === 'left' ? 'P1' : 'P2');
    setText(el[`${key}Name`], name);
    setText(el[`${key}Team`], p?.teamName || '');
    setText(el[`${key}Fb`], (name || '?').slice(0, 1));
    setImage(el[`${key}Img`], p?.image || '');
    setImage(el[`${key}TeamLogo`], p?.teamImage || '');
    document.documentElement.style.setProperty(`--${key}-color`, colors?.[key] || (side === 'left' ? '#d0344e' : '#3d78c9'));
  }

  function applyPlayerAgg(side, value) {
    const node = side === 'left' ? el.leftAgg : el.rightAgg;
    const text = String(value ?? 0);
    setText(node, text);
    if (node) node.dataset.digits = String(text.length);
  }

  function applyRow(i, data, state) {
    const node = rows[i];
    if (!node) return;
    if (!data || !data.filled) {
      setHidden(node.row, true);
      return;
    }
    setHidden(node.row, false);
    setText(node.no, String(i + 1).padStart(2, '0'));
    setText(node.title, data.title || '未命名曲目');
    setText(node.artist, data.artist || '');
    setImage(node.cover, data.cover || '');
    setHidden(node.cover, !data.cover);

    const color = data.difficultyColor || '#4a4e56';
    node.diff.style.background = color;
    node.diff.style.color = contrastInk(color);
    node.diff.style.borderColor = data.difficulty === 'ultima' ? 'rgba(255,255,255,.55)' : 'rgba(255,255,255,.18)';
    node.diff.textContent = '';
    node.diff.append(document.createTextNode(`${data.difficultyName || '—'} `));
    const lv = document.createElement('b');
    lv.textContent = data.levelText || '';
    node.diff.append(lv);

    const isCurrent = state.status === 'live' && data.index === state.currentIndex;
    node.row.classList.toggle('is-current', isCurrent);
    setHidden(node.now, !isCurrent);

    const left = data.scoreLeft;
    const right = data.scoreRight;
    setText(node.leftNum, left === null || left === undefined ? '—' : left);
    setText(node.rightNum, right === null || right === undefined ? '—' : right);
    node.leftNum.classList.toggle('empty', left === null || left === undefined);
    node.rightNum.classList.toggle('empty', right === null || right === undefined);
    node.leftNum.classList.toggle('win', data.winner === 'left');
    node.rightNum.classList.toggle('win', data.winner === 'right');

    setHidden(node.leftFlag, data.winner !== 'left');
    setHidden(node.rightFlag, data.winner !== 'right');
    setHidden(node.draw, data.winner !== 'draw');
  }

  function apply(state) {
    if (!state || typeof state !== 'object') return;
    const d = state.derived || {};
    const colors = state.colors || {};

    document.documentElement.style.setProperty('--left-color', colors.left || '#d0344e');
    document.documentElement.style.setProperty('--right-color', colors.right || '#3d78c9');

    setText(el.name, state.name || '比赛');
    const finished = state.status === 'finished';
    setText(el.status, finished ? '已结束' : '进行中');
    el.status.className = `status ${finished ? 'finished' : 'live'}`;
    setText(el.mode, d.modeLabel || '总分制');
    setText(el.count, `${d.filledCount || 0} / ${MAX_ROWS} 首`);

    applyPlayer('left', state.players?.left, colors);
    applyPlayer('right', state.players?.right, colors);

    applyPlayerAgg('left', d.displayLeft);
    applyPlayerAgg('right', d.displayRight);
    setText(el.leftAggLabel, d.scoreLabel || '总分');
    setText(el.rightAggLabel, d.scoreLabel || '总分');
    setText(el.centerMode, d.modeLabel || '总分制');

    const songs = Array.isArray(state.songs) ? state.songs : [];
    for (let i = 0; i < MAX_ROWS; i++) applyRow(i, songs[i], state);

    const visible = songs.some((r) => r && r.filled);
    setHidden(el.songsWrap, !visible);
    setHidden(el.empty, visible);

    // 结算 / 领先提示
    const leftName = state.players?.left?.name || 'P1';
    const rightName = state.players?.right?.name || 'P2';
    let centerText = '';
    let centerWin = false;
    if (finished) {
      if (state.winner === 'left') { centerText = `${leftName} 获胜`; centerWin = true; }
      else if (state.winner === 'right') { centerText = `${rightName} 获胜`; centerWin = true; }
      else if (state.winner === 'draw') { centerText = '平局'; centerWin = true; }
      else { centerText = '已结束'; }
    } else if ((d.completeRows || 0) > 0) {
      if (d.leader === 'left') centerText = `${leftName} 领先`;
      else if (d.leader === 'right') centerText = `${rightName} 领先`;
      else centerText = '暂时持平';
    }
    setText(el.centerState, centerText);
    el.centerState.classList.toggle('win', centerWin);

    el.leftPlayer.classList.toggle('is-winner', finished && state.winner === 'left');
    el.rightPlayer.classList.toggle('is-winner', finished && state.winner === 'right');
    el.board.classList.toggle('is-finished', finished);

    // 底部：录入进度 + 当前曲目
    const current = songs[state.currentIndex];
    const currentTitle = current && current.filled ? current.title : '';
    setText(el.footLeft, `已录入 ${d.completeRows || 0} / ${MAX_ROWS} 首`);
    setText(el.footRight, currentTitle ? `当前 · ${currentTitle}` : '等待选曲');
  }

  // ── 预览 / 独立窗口缩放 ──
  function fit() {
    if (Q.get('fit') === '0') return;
    const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080, 1);
    stage.style.transformOrigin = 'top left';
    stage.style.transform = s < 1 ? `scale(${s})` : 'none';
  }
  window.addEventListener('resize', fit);
  fit();

  // ── WS ──
  arcadeWS.on('hello', (m) => {
    const s = m?.state?.match?.state;
    apply(s?.current || s);
  });
  arcadeWS.on('match:state', (m) => apply(m.match));
  arcadeWS.on('open', () => arcadeWS.notify('overlay:ready', { target: 'match' }));

  arcadeWS.start({ target: 'match' });
  console.log('[match] ready');
})();
