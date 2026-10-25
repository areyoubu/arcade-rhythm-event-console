/**
 * 整屏场景的动态背景切换 —— 跟随「输出配色 → 输出风格」。
 *
 * dark  → assets/liveroom-background.{mp4,png}（原来的深色背景）
 * light → assets/light-background.{mp4,png}（明亮背景）
 *
 * 两种兜底都要管：
 *   · 视频在播 → 换 <source> 的地址；
 *   · `?static=1` / 视频解码失败 → 页面靠 CSS 的背景图兜底，这里把所有
 *     「背景图指向旧背景」的元素改成新的地址。
 *
 * 之前用「改写样式表规则」的做法，在 `background` 简写里拿不到 url（CSSOM 对简写的
 * 序列化不可靠），静态模式下背景不会跟着换。改成按**计算样式**找元素、写行内
 * background-image —— 只覆盖图片地址，尺寸 / 位置 / 底色仍由原规则决定。
 */
(function () {
  'use strict';

  const DARK = { mp4: '/assets/liveroom-background.mp4', png: '/assets/liveroom-background.png', key: 'liveroom-background' };
  const LIGHT = { mp4: '/assets/light-background.mp4', png: '/assets/light-background.png', key: 'light-background' };

  const video = document.getElementById('bgVideo') || document.querySelector('video.bg-video');
  let current = null;

  /**
   * 把页面里所有「背景图指向另一套背景」的元素改成目标背景。
   * 只改 background-image，尺寸 / 位置 / 底色仍由原规则决定。
   */
  function swapBackgroundImages(fromKey, toKey) {
    for (const el of document.querySelectorAll('body, body *')) {
      let bg = '';
      try { bg = getComputedStyle(el).backgroundImage || ''; } catch { continue; }
      if (!bg.includes(fromKey)) continue;
      el.style.backgroundImage = bg.split(fromKey).join(toKey);
    }
  }

  function apply(style) {
    const light = style === 'light';
    const conf = light ? LIGHT : DARK;
    if (current === conf.key) return;
    current = conf.key;

    swapBackgroundImages(
      light ? DARK.key : LIGHT.key,
      light ? LIGHT.key : DARK.key,
    );

    if (!video) return;
    if (video.poster) video.poster = conf.png;
    const source = video.querySelector('source');
    if (source) source.src = conf.mp4; else video.src = conf.mp4;
    if (!video.hidden && video.style.display !== 'none') {
      try {
        video.load();
        const p = video.play?.();
        if (p && typeof p.catch === 'function') p.catch(() => { /* 静态兜底，忽略 */ });
      } catch { /* ignore */ }
    }
  }

  const ws = window.arcadeWS;
  const initial = ws?.path?.('config.theme.style') || 'dark';
  apply(initial);
  ws?.on?.('hello', (m) => apply(m?.state?.config?.theme?.style || initial));
  ws?.watch?.('config.theme.style', (v) => apply(v || 'dark'));

  window.sceneBackground = { apply };
})();
