/**
 * 解说摄像头叠加（OBS 全屏透明 UI，target=castcam）。
 *
 * OBS：摄像头画面源在下面，本页作为浏览器源叠在上面。
 * 只画比赛 Logo、图片轮播位、底部赛程条；赛程来自 match.ticker（与比赛计分同步）。
 */
(function () {
  'use strict';

  const Q = new URLSearchParams(location.search);
  const PREVIEW = Q.get('preview') === '1';
  const BARE = Q.get('bare') === '1';
  if (PREVIEW) document.body.classList.add('preview');
  if (BARE) document.body.classList.add('bare');

  const LOGO_POS = ['top-left', 'top-right'];
  const CAR_POS = ['top-right', 'top-left', 'bottom-right', 'bottom-left'];
  const TICKER_POS = ['bottom', 'top'];

  const DEFAULT_CFG = {
    camLogo: '',
    camLogoWidth: 220,
    camLogoPosition: 'top-left',
    camEventTitle: '解说机位',
    camEventSub: 'COMMENTARY',
    camCarouselImages: [],
    camCarouselWidth: 300,
    camCarouselPosition: 'top-right',
    camCarouselIntervalMs: 6000,
    camTickerShow: true,
    camTickerPosition: 'bottom',
    camTickerOpacity: 0.88,
    camTickerCurrentLabel: '正在进行',
    camTickerUpcomingLabel: '即将进行',
    camTickerShowUpcoming: true,
    camTickerShowLive: true,
    camAccent: '#d9a441',
  };

  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const el = {
    logoBlock: $('logoBlock'), logoMark: $('logoMark'), logo: $('camLogo'),
    logoText: $('logoText'), eventTitle: $('camEventTitle'), eventSub: $('camEventSub'),
    carousel: $('carousel'), carouselImg: $('carouselImg'),
    ticker: document.querySelector('.ticker'),
    nowLabel: $('nowLabel'), nowName: $('nowName'),
    nextLabel: $('nextLabel'), nextName: $('nextName'),
    tickSep: $('tickSep'), tickNext: $('tickNext'), tickLive: $('tickLive'),
  };

  let currentCfg = { ...DEFAULT_CFG };

  function clamp(n, min, max, fallback) {
    const v = Number(n);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  }

  function safeImageUrl(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    if (/^\/(media|assets|covers)\//.test(s)) return s;
    return '';
  }

  function coerce(raw) {
    const out = { ...DEFAULT_CFG };
    if (!raw || typeof raw !== 'object') return out;
    out.camLogo = safeImageUrl(raw.camLogo);
    out.camLogoWidth = Math.round(clamp(raw.camLogoWidth, 80, 480, out.camLogoWidth) / 10) * 10;
    if (LOGO_POS.includes(raw.camLogoPosition)) out.camLogoPosition = raw.camLogoPosition;
    if (typeof raw.camEventTitle === 'string') out.camEventTitle = raw.camEventTitle.trim().slice(0, 40);
    if (typeof raw.camEventSub === 'string') out.camEventSub = raw.camEventSub.trim().slice(0, 40);

    const images = Array.isArray(raw.camCarouselImages)
      ? raw.camCarouselImages
      : String(raw.camCarouselImages || '').split(/[\n,]/);
    out.camCarouselImages = images.map(safeImageUrl).filter(Boolean).slice(0, 20);
    out.camCarouselWidth = Math.round(clamp(raw.camCarouselWidth, 120, 600, out.camCarouselWidth) / 10) * 10;
    if (CAR_POS.includes(raw.camCarouselPosition)) out.camCarouselPosition = raw.camCarouselPosition;
    out.camCarouselIntervalMs = clamp(raw.camCarouselIntervalMs, 1000, 60000, out.camCarouselIntervalMs);

    if (typeof raw.camTickerShow === 'boolean') out.camTickerShow = raw.camTickerShow;
    if (TICKER_POS.includes(raw.camTickerPosition)) out.camTickerPosition = raw.camTickerPosition;
    out.camTickerOpacity = clamp(raw.camTickerOpacity, 0.35, 1, out.camTickerOpacity);
    if (typeof raw.camTickerCurrentLabel === 'string') out.camTickerCurrentLabel = raw.camTickerCurrentLabel.trim().slice(0, 20);
    if (typeof raw.camTickerUpcomingLabel === 'string') out.camTickerUpcomingLabel = raw.camTickerUpcomingLabel.trim().slice(0, 20);
    if (typeof raw.camTickerShowUpcoming === 'boolean') out.camTickerShowUpcoming = raw.camTickerShowUpcoming;
    if (typeof raw.camTickerShowLive === 'boolean') out.camTickerShowLive = raw.camTickerShowLive;
    if (/^#[0-9a-f]{6}$/i.test(String(raw.camAccent || ''))) out.camAccent = raw.camAccent;
    return out;
  }

  // ── Logo ─────────────────────────────────────────────
  const CAR_CLASS = {
    'top-right': 'car-tr', 'top-left': 'car-tl',
    'bottom-right': 'car-br', 'bottom-left': 'car-bl',
  };
  let logoLoaded = '';

  function syncLogoBlock() {
    const hasText = !!(el.eventTitle.textContent || el.eventSub.textContent);
    const hasLogo = el.logoMark.classList.contains('on');
    el.logoBlock.classList.toggle('hidden', !hasText && !hasLogo);
  }

  function applyLogo(cfg) {
    const url = cfg.camLogo;
    const hasText = !!(cfg.camEventTitle || cfg.camEventSub);
    el.logoText.classList.toggle('hidden', !hasText);
    el.eventTitle.textContent = cfg.camEventTitle;
    el.eventSub.textContent = cfg.camEventSub;

    if (url) {
      if (logoLoaded !== url) {
        logoLoaded = url;
        el.logoMark.classList.add('on');
        el.logo.onload = () => { el.logoMark.classList.add('on'); syncLogoBlock(); };
        el.logo.onerror = () => { el.logoMark.classList.remove('on'); syncLogoBlock(); };
        el.logo.src = url;
      }
    } else {
      logoLoaded = '';
      el.logo.removeAttribute('src');
      el.logoMark.classList.remove('on');
    }
    syncLogoBlock();
  }

  // ── 图片轮播 ─────────────────────────────────────────
  let carTimer = null;
  let carSig = '';
  let carIndex = 0;
  let carList = [];

  function showCarouselImage(src) {
    const img = el.carouselImg;
    img.classList.add('fade');
    img.onload = () => img.classList.remove('fade');
    img.onerror = () => { el.carousel.classList.add('hidden'); clearInterval(carTimer); };
    img.src = src;
    // 缓存命中时 onload 可能不再触发
    if (img.complete && img.naturalWidth > 0) img.classList.remove('fade');
  }

  function applyCarousel(cfg) {
    carList = cfg.camCarouselImages;
    el.carousel.classList.toggle('hidden', !carList.length);
    if (!carList.length) { clearInterval(carTimer); carTimer = null; carSig = ''; return; }

    const sig = `${cfg.camCarouselIntervalMs}|${carList.join('\u0000')}`;
    if (sig === carSig) return;
    carSig = sig;
    clearInterval(carTimer);
    carIndex = 0;
    el.carousel.classList.remove('hidden');
    showCarouselImage(carList[0]);

    if (carList.length > 1) {
      carTimer = setInterval(() => {
        if (!carList.length) return;
        carIndex = (carIndex + 1) % carList.length;
        showCarouselImage(carList[carIndex]);
      }, cfg.camCarouselIntervalMs);
    } else {
      carTimer = null;
    }
  }

  // ── 赛程条 ───────────────────────────────────────────
  let tickerState = { current: '', upcoming: '', status: 'live' };

  function applyTickerState() {
    const cfg = currentCfg;
    el.nowLabel.textContent = tickerState.status === 'finished'
      ? '本局已结束'
      : cfg.camTickerCurrentLabel;
    el.nextLabel.textContent = cfg.camTickerUpcomingLabel;
    el.nowName.textContent = tickerState.current || '等待比赛';
    el.nextName.textContent = tickerState.upcoming || '待定';

    const showNext = cfg.camTickerShowUpcoming;
    el.tickSep.classList.toggle('hidden', !showNext);
    el.tickNext.classList.toggle('hidden', !showNext);
    el.tickLive.classList.toggle('hidden', !cfg.camTickerShowLive);
    el.ticker.classList.toggle('hidden', !cfg.camTickerShow);
  }

  function applyConfig(raw) {
    const cfg = coerce(raw);
    currentCfg = cfg;
    const body = document.body;
    body.classList.toggle('logo-tl', cfg.camLogoPosition === 'top-left');
    body.classList.toggle('logo-tr', cfg.camLogoPosition === 'top-right');
    for (const [pos, cls] of Object.entries(CAR_CLASS)) {
      body.classList.toggle(cls, cfg.camCarouselPosition === pos);
    }
    body.classList.toggle('ticker-bottom', cfg.camTickerPosition === 'bottom');
    body.classList.toggle('ticker-top', cfg.camTickerPosition === 'top');

    const root = document.documentElement.style;
    root.setProperty('--cam-accent', cfg.camAccent);
    root.setProperty('--logo-w', `${cfg.camLogoWidth}px`);
    root.setProperty('--car-w', `${cfg.camCarouselWidth}px`);
    root.setProperty('--ticker-alpha', String(cfg.camTickerOpacity));

    applyLogo(cfg);
    applyCarousel(cfg);
    applyTickerState();
  }

  function applyMatchTicker(t) {
    tickerState = {
      current: String(t?.current || ''),
      upcoming: String(t?.upcoming || ''),
      status: String(t?.status || 'live'),
    };
    applyTickerState();
  }

  // ── 画布缩放 ─────────────────────────────────────────
  (function fit() {
    const sc = Q.get('scale');
    const wantFit = Q.get('fit') === '1';
    let s = sc ? Number(sc) || 1 : 1;
    if (!sc && wantFit) s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080, 1);
    if (s !== 1) { stage.style.transformOrigin = 'top left'; stage.style.transform = `scale(${s})`; }
    window.addEventListener('resize', () => { if (wantFit) location.reload(); });
  })();

  // 预览页用独立 target，避免控制台把预览误判成 OBS 摄像头源已接入
  const TARGET = PREVIEW ? 'castcam-preview' : 'castcam';

  arcadeWS.on('hello', (m) => {
    applyConfig(m?.state?.config?.cast);
    applyMatchTicker(m?.state?.match?.ticker);
  });
  arcadeWS.watch('config.cast', (v) => { if (v && typeof v === 'object') applyConfig(v); });
  arcadeWS.watch('match.ticker', (v) => applyMatchTicker(v));
  // 预览页不登记为渲染端，避免把控制台里的预览计入 OBS 源连接数
  if (!PREVIEW) arcadeWS.on('open', () => arcadeWS.notify('overlay:ready', { target: TARGET }));

  arcadeWS.start({ target: TARGET });
  applyConfig(arcadeWS.state?.config?.cast);
  applyMatchTicker(arcadeWS.state?.match?.ticker);
  console.log('[castcam] ready');
})();
