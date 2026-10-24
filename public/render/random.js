/**
 * 全屏随机选曲渲染端（OBS target=random）。
 *
 * 收到 random.state 后：生成曲目条 → 从右向左滑到 targetIndex → 缓停 →
 * 背景曲目条模糊/变暗 → 放大选中曲目的曲绘与详细信息。
 *
 * 页面刷新时若已有结果，直接展示结果，不重新播放整段滚动。
 */
(function () {
  'use strict';

  const Q = new URLSearchParams(location.search);
  const PREVIEW = Q.get('preview') === '1';
  const CANVAS = { width: 1920, height: 1080 };
  const DIFF_ORDER = ['basic', 'advanced', 'expert', 'master', 'ultima'];
  const DIFF_NAME = { basic: 'BASIC', advanced: 'ADVANCED', expert: 'EXPERT', master: 'MASTER', ultima: 'ULTIMA' };

  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const el = {
    phase: $('phase'),
    reelWrap: $('reelWrap'), viewport: $('reelViewport'), strip: $('reelStrip'),
    pointer: $('pointer'),
    idle: $('idle'), result: $('result'),
    cover: $('resultCover'), title: $('resultTitle'), artist: $('resultArtist'),
    meta: $('resultMeta'), diffs: $('resultDiffs'), note: $('resultNote'),
    video: $('bgVideo'),
    audio: $('previewAudio'),
  };

  // 公共控制器负责：浏览器自动播放被拦截时的「点击启用声音」提示 + 缓入缓出
  const previewAudio = window.createPreviewAudio(el.audio);
  function stopPreviewAudio() { previewAudio.stop(); }
  function playPreviewAudio(audio) { previewAudio.play(audio); }

  if (Q.get('static') === '1' && el.video) {
    el.video.hidden = true;
    // 静态背景模式彻底停掉视频加载，避免 OBS 里白白解码一路用不到的视频
    for (const s of el.video.querySelectorAll('source')) s.remove();
    try { el.video.pause(); el.video.removeAttribute('src'); el.video.load(); } catch { /* ignore */ }
  }
  if (el.video && Q.get('static') !== '1') {
    const hide = () => { el.video.hidden = true; };
    el.video.addEventListener('error', hide);
    for (const s of el.video.querySelectorAll('source')) s.addEventListener('error', hide);
    const p = el.video.play?.();
    if (p && typeof p.catch === 'function') p.catch(() => { /* poster / 静态背景 */ });
  }

  (function fit() {
    if (Q.get('fit') !== '1') return;
    const s = Math.min(window.innerWidth / CANVAS.width, window.innerHeight / CANVAS.height, 1);
    stage.style.transformOrigin = 'top left';
    stage.style.transform = s < 1 ? `scale(${s})` : 'none';
    window.addEventListener('resize', () => location.reload());
  })();

  // ── DOM helpers ──────────────────────────────────────
  function div(cls, text) {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    if (text !== undefined) d.textContent = text;
    return d;
  }
  function setText(node, v) { if (node) node.textContent = v == null ? '' : String(v); }
  function setPhase(text, live) {
    setText(el.phase, text);
    el.phase.classList.toggle('live', !!live);
  }
  function coverNode(item, cls) {
    if (item.cover) {
      const img = document.createElement('img');
      img.className = cls;
      img.alt = '';
      // 不要 lazy：OBS 源里卡片会快速滑入，懒加载会导致「曲目到了、曲绘过一会才出现」
      img.loading = 'eager';
      img.src = item.cover;
      img.onerror = () => {
        const ph = div(`${cls} ph`, '♪');
        img.replaceWith(ph);
      };
      return img;
    }
    return div(`${cls} ph`, '♪');
  }

  const preloaded = new Set();
  function preloadCovers(state) {
    const urls = new Set();
    for (const item of state.reel || []) if (item.cover) urls.add(item.cover);
    if (state.picked?.cover) urls.add(state.picked.cover);
    for (const url of urls) {
      if (preloaded.has(url)) continue;
      preloaded.add(url);
      const img = new Image();
      img.src = url;
    }
  }

  /**
   * 停止后把目标卡「吸」到指针正下方。
   * 即使因缩放、字体/图片加载或过渡尚未完全结束导致偏差，也会在显示结果前校正。
   */
  function snapTarget(state) {
    const target = el.strip.children[state.targetIndex];
    if (!target || !el.pointer) return;
    const t = target.getBoundingClientRect();
    const p = el.pointer.getBoundingClientRect();
    const deltaVisual = (p.left + p.width / 2) - (t.left + t.width / 2);
    if (Math.abs(deltaVisual) < 0.5) return;

    const stageRect = stage.getBoundingClientRect();
    const scale = stage.offsetWidth ? stageRect.width / stage.offsetWidth : 1;
    const deltaLayout = deltaVisual / (scale || 1);

    let x = 0;
    const tf = getComputedStyle(el.strip).transform;
    if (tf && tf !== 'none') {
      try { x = new DOMMatrixReadOnly(tf).m41; }
      catch {
        const m = /matrix\(([^)]+)\)/.exec(tf);
        if (m) x = Number(m[1].split(',')[4]) || 0;
      }
    }
    el.strip.style.transition = 'none';
    el.strip.style.transform = `translateX(${x + deltaLayout}px)`;
  }

  function buildCard(item, index) {
    // 抽中前不标出目标卡，避免滚动过程中提前暴露答案
    const card = div('reel-card');
    card.append(coverNode(item, 'cover'));
    card.append(div('t', item.title || '未命名曲目'));
    card.append(div('a', item.artist || '—'));
    const meta = div('m');
    const chip = document.createElement('span');
    chip.className = 'diff-chip';
    chip.textContent = `${item.difficultyName || '—'} ${item.levelText || ''}`.trim();
    chip.style.background = item.difficultyColor || '#4a4e56';
    meta.append(chip);
    const genre = document.createElement('span');
    genre.className = 'a';
    genre.textContent = item.genreLabel || item.genre || '';
    meta.append(genre);
    card.append(meta);
    return card;
  }

  function renderReel(state) {
    const frag = document.createDocumentFragment();
    (state.reel || []).forEach((item, i) => frag.append(buildCard(item, i)));
    el.strip.replaceChildren(frag);
  }

  function markTarget(state) {
    const card = el.strip.children[state.targetIndex];
    if (card) card.classList.add('target');
  }

  function measure() {
    const first = el.strip.firstElementChild;
    // 必须用 offsetWidth（布局像素）而不是 getBoundingClientRect（会被 stage 的
    // fit 缩放影响）。否则 ?fit=1 时用缩放后的卡宽去算偏移，指针停下的卡片会错位。
    const cardW = first ? first.offsetWidth : 240;
    const gap = parseFloat(getComputedStyle(el.strip).columnGap || getComputedStyle(el.strip).gap) || 18;
    return { cardW, stride: cardW + gap };
  }

  function finalOffset(state) {
    const { cardW, stride } = measure();
    return -(state.targetIndex * stride + cardW / 2 - el.viewport.clientWidth / 2);
  }

  // ── Result ───────────────────────────────────────────
  function renderResult(picked) {
    el.cover.replaceChildren(coverNode(picked, ''));
    setText(el.title, picked.title || '未命名曲目');
    setText(el.artist, picked.artist || '—');

    const meta = document.createDocumentFragment();
    const cn = document.createElement('span');
    cn.className = `tag ${picked.cn ? 'cn' : ''}`;
    cn.textContent = picked.cn ? '国服' : '日服';
    meta.append(cn);
    if (picked.genreLabel || picked.genre) {
      const g = document.createElement('span');
      g.className = 'tag';
      g.textContent = picked.genreLabel || picked.genre;
      meta.append(g);
    }
    if (picked.we) {
      const w = document.createElement('span');
      w.className = 'tag we';
      w.textContent = `WORLD'S END ${picked.weText || ''}`.trim();
      meta.append(w);
    }
    const chosen = document.createElement('span');
    chosen.className = 'result-level';
    chosen.textContent = `${picked.difficultyName || ''} ${picked.levelText || ''}`.trim();
    meta.append(chosen);
    el.meta.replaceChildren(meta);

    const diffs = document.createDocumentFragment();
    for (const key of DIFF_ORDER) {
      const lv = picked.difficulties?.[key];
      if (!lv) continue;
      const pill = document.createElement('span');
      pill.className = `diff-pill${picked.difficulty === key ? ' active' : ''}`;
      pill.textContent = `${DIFF_NAME[key]} ${lv}`;
      diffs.append(pill);
    }
    if (picked.we) {
      const pill = document.createElement('span');
      pill.className = `diff-pill${picked.difficulty === 'we' ? ' active' : ''}`;
      pill.textContent = `WE ${picked.weText || ''}`.trim();
      pill.style.color = '#d7b6ff';
      diffs.append(pill);
    }
    el.diffs.replaceChildren(diffs);
    setText(el.note, 'RANDOM SELECT · 曲目信息来自本地曲库');
  }

  // ── State machine ────────────────────────────────────
  let lastAt = 0;
  let spinTimer = null;
  let spinToken = 0;
  let applying = false;

  /**
   * 等滚动条里的曲绘真正 decode 完再开始移动。
   * 只 load 不够：OBS / CEF 在长距离 transform 动画期间可能还没把图片
   * 解码/上传到合成层，于是出现「卡片滑过来了，停稳后才显示曲绘」。
   */
  function decodeReelImages(timeoutMs = 1200) {
    const imgs = [...el.strip.querySelectorAll('img')];
    if (!imgs.length) return Promise.resolve();
    const each = imgs.map((img) => new Promise((res) => {
      const done = () => res();
      if (img.complete && img.naturalWidth > 0) {
        if (typeof img.decode === 'function') img.decode().then(done, done);
        else done();
        return;
      }
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    }));
    return Promise.race([
      Promise.all(each),
      new Promise((r) => setTimeout(r, timeoutMs)),
    ]);
  }

  function resetIdle() {
    spinToken++;
    clearTimeout(spinTimer);
    spinTimer = null;
    applying = false;
    stopPreviewAudio();
    stage.classList.remove('spinning', 'done');
    el.result.classList.remove('show');
    el.strip.replaceChildren();
    el.strip.style.transition = 'none';
    el.strip.style.transform = 'translateX(0)';
    setPhase('READY', false);
  }

  function finish(state) {
    clearTimeout(spinTimer);
    spinTimer = null;
    snapTarget(state);
    markTarget(state);
    stage.classList.remove('spinning');
    stage.classList.add('done');
    setPhase('SELECTED', true);
    renderResult(state.picked || {});
    // 强制回流后立即切到 show，避免依赖 rAF（OBS 后台源可能被节流）
    void el.result.offsetWidth;
    el.result.classList.add('show');
    playPreviewAudio(state.audio);
  }

  async function runSpin(state) {
    const token = ++spinToken;
    clearTimeout(spinTimer);
    spinTimer = null;
    applying = true;
    stopPreviewAudio();
    stage.classList.remove('done');
    el.result.classList.remove('show');
    preloadCovers(state);
    renderReel(state);

    el.strip.style.transition = 'none';
    el.strip.style.transform = 'translateX(0)';
    setPhase('SPINNING', true);

    // 先把曲绘解码好，再开始移动
    await decodeReelImages(1200);
    if (token !== spinToken) return;

    // 强制回流后再启动 transition，否则部分浏览器会跳过动画。
    // 这里不用 requestAnimationFrame：OBS 后台源可能被节流，rAF 不触发会让转盘卡住。
    void el.strip.offsetWidth;
    const offset = finalOffset(state);
    el.strip.style.transition = `transform ${state.spinMs || 6400}ms cubic-bezier(.10,.72,.08,1)`;
    void el.strip.offsetWidth;
    el.strip.style.transform = `translateX(${offset}px)`;
    stage.classList.add('spinning');

    spinTimer = setTimeout(() => {
      applying = false;
      finish(state);
    }, (state.spinMs || 6400) + 220);
  }

  function showResultNow(state) {
    clearTimeout(spinTimer);
    applying = false;
    preloadCovers(state);
    renderReel(state);
    el.strip.style.transition = 'none';
    el.strip.style.transform = `translateX(${finalOffset(state)}px)`;
    snapTarget(state);
    markTarget(state);
    stage.classList.remove('spinning');
    stage.classList.add('done');
    setPhase('SELECTED', true);
    renderResult(state.picked || {});
    el.result.classList.add('show');
    // 刷新 / 切场景后重载：结果还新鲜时补播预览，过旧则静默
    if (state.at && Date.now() - state.at < 12_000) playPreviewAudio(state.audio);
    else stopPreviewAudio();
  }

  function applyState(state, { initial = false } = {}) {
    if (!state || typeof state !== 'object' || !state.picked) {
      if (applying || stage.classList.contains('done')) resetIdle();
      return;
    }
    if (state.at && state.at === lastAt) return;
    lastAt = state.at || Date.now();

    if (initial) showResultNow(state);
    else runSpin(state);
  }

  // ── WS ───────────────────────────────────────────────
  const TARGET = PREVIEW ? 'random-preview' : 'random';

  arcadeWS.on('hello', (m) => applyState(m?.state?.random?.state, { initial: true }));
  arcadeWS.watch('random.state', (v) => applyState(v, { initial: false }));
  if (!PREVIEW) arcadeWS.on('open', () => arcadeWS.notify('overlay:ready', { target: TARGET }));

  // 先渲染待机态；hello 很快会补上最近结果
  resetIdle();
  arcadeWS.start({ target: TARGET });
  console.log('[random] ready');
})();
