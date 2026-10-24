/**
 * 选曲二维码大屏（OBS 浏览器源）。
 * 只负责展示二维码和最近的选曲请求；不提供任何操作按钮。
 */
(function () {
  'use strict';

  const Q = new URLSearchParams(location.search);
  if (Q.get('preview') === '1') document.body.classList.add('preview');
  if (Q.get('window') === '1') document.body.classList.add('windowed');

  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const el = {
    name: $('matchName'), status: $('status'),
    qr: $('qr'), qrUrl: $('qrUrl'),
    pickList: $('pickList'), pickCount: $('pickCount'),
    footMode: $('footMode'),
  };

  function setText(node, v) { if (node && node.textContent !== String(v)) node.textContent = String(v); }
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function fit() {
    if (Q.get('fit') === '0') return;
    const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080, 1);
    stage.style.transformOrigin = 'top left';
    stage.style.transform = s < 1 ? `scale(${s})` : 'none';
  }
  window.addEventListener('resize', fit);
  fit();

  // 二维码地址：公网 > 局域网配置 > 当前 origin / 自动探测局域网 IP（服务端解析）
  (async function loadQr() {
    const origin = encodeURIComponent(location.origin);
    try {
      const res = await fetch(`/api/match/pickUrl?origin=${origin}`);
      const info = await res.json();
      if (info?.url) {
        el.qr.src = `/api/match/qr?size=460&origin=${origin}`;
        setText(el.qrUrl, info.url);
      } else {
        setText(el.qrUrl, '—');
      }
    } catch {
      setText(el.qrUrl, '—');
    }
  })();

  function renderPicks(picks) {
    const list = Array.isArray(picks) ? picks.slice(-6).reverse() : [];
    setText(el.pickCount, list.length ? `· ${list.length}` : '');
    el.pickList.textContent = '';
    if (!list.length) {
      const d = document.createElement('div');
      d.className = 'pick-empty';
      d.textContent = '等待选手扫码提交…';
      el.pickList.append(d);
      return;
    }
    for (const p of list) {
      const row = document.createElement('div');
      row.className = 'pick';
      row.innerHTML = `<span class="side ${p.side === 'right' ? 'right' : 'left'}">${p.side === 'right' ? 'P2' : 'P1'}</span>`
        + (p.cover ? `<img class="cover" src="${esc(p.cover)}" alt="" />` : '')
        + `<span class="t">${esc(p.title)}</span>`
        + `<span class="d">${esc(p.difficultyName || '')} ${esc(p.levelText || p.level || '')}</span>`;
      el.pickList.append(row);
    }
  }

  function apply(state) {
    if (!state || typeof state !== 'object') return;
    setText(el.name, state.name || '比赛');
    const finished = state.status === 'finished';
    el.status.className = `status ${finished ? 'finished' : 'live'}`;
    setText(el.status, finished ? '已结束' : '进行中');
    setText(el.footMode, finished ? '本局已结束' : '选曲中');
    renderPicks(state.picks);
  }

  arcadeWS.on('hello', (m) => {
    const s = m?.state?.match?.state;
    apply(s?.current || s);
  });
  arcadeWS.on('match:state', (m) => apply(m.match));
  arcadeWS.on('open', () => arcadeWS.notify('overlay:ready', { target: 'matchpick' }));

  arcadeWS.start({ target: 'matchpick' });
  console.log('[pick] ready');
})();
