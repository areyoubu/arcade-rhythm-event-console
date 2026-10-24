/**
 * OBS 渲染源里的预览音频控制器。
 *
 * 浏览器默认禁止「没有用户操作」的自动播放；OBS 浏览器源也可能受同一策略影响。
 * 这里做三件事：
 *   1. 正常播放时做缓入 / 缓出；
 *   2. play() 被浏览器拦截时，显示一个很小的「点击启用声音」提示；
 *   3. 页面任意点击 / 按键后重试播放（OBS 里用浏览器源的「交互」点一下即可），
 *      之后同一页面内的后续音频就可以正常自动播放。
 */
(function () {
  'use strict';

  const FADE_IN_MS = 650;
  const FADE_OUT_MS = 420;
  const FADE_STEP_MS = 20;

  function injectStyle() {
    if (document.getElementById('pa-unlock-style')) return;
    const style = document.createElement('style');
    style.id = 'pa-unlock-style';
    style.textContent = `
      .pa-unlock {
        position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%);
        z-index: 2147483647;
        display: inline-flex; align-items: center; gap: 8px;
        padding: 9px 18px; border-radius: 999px;
        border: 1px solid rgba(217, 164, 65, .72);
        background: rgba(9, 10, 13, .92);
        color: #f1e4c3; cursor: pointer;
        font: 600 14px/1.2 'Noto Sans SC', 'Microsoft YaHei', system-ui, sans-serif;
        letter-spacing: .5px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, .55);
        backdrop-filter: blur(6px);
      }
      .pa-unlock:hover { border-color: #f1d08a; color: #fff; }
      .pa-unlock[hidden] { display: none !important; }
      .pa-unlock .ico { font-size: 16px; }
    `;
    document.head.append(style);
  }

  /**
   * @param {HTMLAudioElement} audioEl
   * @param {{label?:string}} [opts]
   */
  window.createPreviewAudio = function createPreviewAudio(audioEl, opts = {}) {
    if (!audioEl) {
      return { play() {}, stop() {}, unlock() {} };
    }
    injectStyle();

    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'pa-unlock';
    pill.hidden = true;
    pill.innerHTML = `<span class="ico">🔊</span><span>${opts.label || '点击启用声音'}</span>`;
    document.body.append(pill);

    let pending = null;
    let targetVolume = 0.8;
    let fadeTimer = null;
    let pendingStop = null;
    let blocked = false;
    let unlocked = false;
    let ending = false;

    function cancelFade() {
      if (fadeTimer) {
        clearInterval(fadeTimer);
        fadeTimer = null;
      }
    }

    function fadeTo(to, ms, done) {
      cancelFade();
      const target = Math.max(0, Math.min(1, Number(to) || 0));
      const from = Number(audioEl.volume) || 0;
      if (ms <= 0) {
        audioEl.volume = target;
        if (done) done();
        return;
      }
      const started = performance.now();
      fadeTimer = setInterval(() => {
        const p = Math.min(1, (performance.now() - started) / ms);
        const eased = 1 - Math.pow(1 - p, 3);       // easeOutCubic
        audioEl.volume = Math.max(0, Math.min(1, from + (target - from) * eased));
        if (p >= 1) {
          cancelFade();
          audioEl.volume = target;
          if (done) done();
        }
      }, FADE_STEP_MS);
    }

    function showPill() {
      pill.hidden = false;
    }
    function hidePill() {
      pill.hidden = true;
    }

    function startPlayback() {
      if (pendingStop) {
        clearTimeout(pendingStop);
        pendingStop = null;
      }
      cancelFade();
      ending = false;
      audioEl.volume = 0;
      let p;
      try { p = audioEl.play(); } catch (e) {
        blocked = true;
        showPill();
        return;
      }
      if (!p || typeof p.then !== 'function') {
        unlocked = true;
        blocked = false;
        hidePill();
        fadeTo(targetVolume, FADE_IN_MS);
        return;
      }
      p.then(() => {
        unlocked = true;
        blocked = false;
        hidePill();
        fadeTo(targetVolume, FADE_IN_MS);
      }).catch((e) => {
        if (e && e.name === 'NotAllowedError') {
          // 自动播放被拦截：先停在 0 音量，等用户点一下再起播
          blocked = true;
          audioEl.volume = 0;
          showPill();
          return;
        }
        // 404 / 解码失败等：不把「点击启用声音」误导成音频可用
        hidePill();
      });
    }

    function play(desc) {
      if (!desc || !desc.url) {
        stop();
        return;
      }
      pending = desc;
      targetVolume = Number.isFinite(Number(desc.volume))
        ? Math.max(0, Math.min(1, Number(desc.volume)))
        : 0.8;

      const changed = audioEl.dataset.previewSrc !== desc.url;
      if (changed) {
        audioEl.dataset.previewSrc = desc.url;
        audioEl.src = desc.url;
      } else {
        try { audioEl.currentTime = 0; } catch { /* ignore */ }
      }
      startPlayback();
    }

    function stop({ immediate = false } = {}) {
      pending = null;
      blocked = false;
      hidePill();
      cancelFade();
      if (pendingStop) {
        clearTimeout(pendingStop);
        pendingStop = null;
      }
      if (immediate) {
        try {
          audioEl.pause();
          audioEl.removeAttribute('src');
          delete audioEl.dataset.previewSrc;
          audioEl.load();
        } catch { /* ignore */ }
        return;
      }
      if (!audioEl.dataset.previewSrc) return;
      fadeTo(0, FADE_OUT_MS, () => {
        pendingStop = setTimeout(() => {
          pendingStop = null;
          // 淡出期间可能已经开始下一首，只有仍是同一 src 才真正卸载
          try {
            audioEl.pause();
            audioEl.removeAttribute('src');
            delete audioEl.dataset.previewSrc;
            audioEl.load();
          } catch { /* ignore */ }
        }, 30);
      });
    }

    function unlock() {
      if (!pending) return;
      // 这个函数由 pointerdown / keydown 调用，处于用户手势上下文
      if (!audioEl.dataset.previewSrc) audioEl.src = pending.url;
      startPlayback();
    }

    function onGesture() {
      if (blocked) unlock();
    }
    document.addEventListener('pointerdown', onGesture, true);
    document.addEventListener('keydown', onGesture, true);

    // 预览片段自然结束前也做一次缓出（timeupdate 在 OBS 后台源里比定时器可靠）
    audioEl.addEventListener('timeupdate', () => {
      const duration = Number(audioEl.duration);
      if (!Number.isFinite(duration) || duration <= 2) return;
      if (audioEl.currentTime < duration - 0.85) {
        ending = false;
        return;
      }
      if (ending) return;
      ending = true;
      fadeTo(0, 700);
    });

    return {
      play,
      stop,
      unlock,
      get blocked() { return blocked; },
      get unlocked() { return unlocked; },
    };
  };
})();
