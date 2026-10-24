/**
 * 奖品大屏渲染端（OBS 浏览器源，整屏场景）。
 *
 * 数据来自 lottery.state：
 *   prize  本轮奖品 { name, image, note }
 *   phase  idle / spinning / revealed
 *   winner 揭晓后的中奖者
 *
 * 图片用 object-fit: contain 完整显示，背后再铺一层同图模糊填满屏幕；
 * 状态不变不重播动画，避免 OBS 里反复闪烁。
 */
(function () {
  'use strict';

  const Q = new URLSearchParams(location.search);
  if (Q.get('preview') === '1') document.body.classList.add('preview');

  const stage = document.getElementById('stage');
  const bgVideo = document.getElementById('bgVideo');
  const bgBlur = document.getElementById('bgBlur');
  const prizeImg = document.getElementById('prizeImg');
  const prizeName = document.getElementById('prizeName');
  const prizeNote = document.getElementById('prizeNote');
  const status = document.getElementById('status');
  const winnerBar = document.getElementById('winnerBar');
  const winnerName = document.getElementById('winnerName');
  const winnerTeam = document.getElementById('winnerTeam');

  // 静态背景模式：不加载 / 不播放视频，直接用 #stage 上的 PNG
  if (Q.get('static') === '1' && bgVideo) {
    bgVideo.pause();
    bgVideo.removeAttribute('src');
    bgVideo.style.display = 'none';
  }
  if (bgVideo) {
    bgVideo.addEventListener('error', () => { bgVideo.style.display = 'none'; }, { once: true });
  }

  function layout() {
    if (Q.get('fit') === '0') return;
    const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080, 1);
    stage.style.transformOrigin = 'top left';
    stage.style.transform = s < 1 ? `scale(${s})` : 'none';
  }
  window.addEventListener('resize', layout);
  layout();

  function setText(node, value) {
    const s = value === null || value === undefined ? '' : String(value);
    if (node && node.textContent !== s) node.textContent = s;
  }

  let lastImage = null;
  function setImage(src) {
    const next = String(src || '');
    if (next === lastImage) return;
    lastImage = next;

    prizeImg.classList.remove('is-ready');
    bgBlur.classList.remove('is-ready');

    if (!next) {
      prizeImg.removeAttribute('src');
      bgBlur.removeAttribute('src');
      return;
    }

    prizeImg.onload = () => prizeImg.classList.add('is-ready');
    prizeImg.onerror = () => { prizeImg.classList.remove('is-ready'); stage.classList.add('no-image'); };
    prizeImg.src = next;

    bgBlur.onload = () => bgBlur.classList.add('is-ready');
    bgBlur.onerror = () => bgBlur.classList.remove('is-ready');
    bgBlur.src = next;
  }

  function setPrizeName(name) {
    const next = String(name || '').trim();
    if (prizeName.textContent === next) return;
    prizeName.textContent = next;
    prizeName.classList.remove('pop');
    // 强制重排后再加动画类，保证改名时一定会重播
    void prizeName.offsetWidth;
    prizeName.classList.add('pop');
  }

  function renderStatus(phase, hasPrize) {
    status.className = 'status';
    if (phase === 'spinning') {
      status.classList.add('spinning');
      status.textContent = '抽奖中…';
    } else if (phase === 'revealed') {
      status.classList.add('revealed');
      status.textContent = '已揭晓';
    } else {
      status.textContent = hasPrize ? '本轮奖品' : '奖品待公布';
    }
  }

  let lastRevision = -1;
  let lastPhase = '';
  let lastPrizeKey = '';

  function apply(raw) {
    if (!raw || typeof raw !== 'object') return;
    const prize = raw.prize || raw.settings?.prize || {};
    const name = String(prize.name || '').trim();
    const image = String(prize.image || '').trim();
    const note = String(prize.note || '').trim();
    const key = `${name}|${image}|${note}`;
    const phase = raw.phase || 'idle';

    if (raw.revision === lastRevision && phase === lastPhase && key === lastPrizeKey) return;
    lastRevision = raw.revision;
    lastPhase = phase;
    lastPrizeKey = key;

    const hasPrize = !!(name || image);
    stage.classList.toggle('empty', !hasPrize);
    // 有名字没图时不要把图片区域留成一大块空白
    stage.classList.toggle('no-image', !image);

    setPrizeName(name || '奖品待公布');
    setText(prizeNote, note);
    setImage(image);
    renderStatus(phase, hasPrize);

    const winner = raw.winner;
    if (phase === 'revealed' && winner) {
      setText(winnerName, winner.name || '');
      setText(winnerTeam, winner.team || '');
      winnerBar.classList.add('show');
    } else {
      winnerBar.classList.remove('show');
    }
  }

  arcadeWS.on('hello', (m) => apply(m?.state?.lottery?.state));
  arcadeWS.on('lottery:state', (m) => apply(m.state));
  arcadeWS.on('open', () => arcadeWS.notify('overlay:ready', { target: 'lottery' }));
  arcadeWS.start({ target: 'lottery' });

  console.log('[prize] ready');
})();
