/**
 * 声音提示 —— Web Audio API 振荡器合成（C-REQ-560：不依赖音频文件）。
 *
 * 需求：
 *   C-REQ-560  使用 Web Audio API 合成
 *   C-REQ-561  预置音型：beep（单短音）/ triple（三短音）/ alarm（急促交替）
 *   C-REQ-562  音量可配置，默认 0.7
 *   C-REQ-563  ★ 须处理浏览器自动播放策略：页面显示「🔊 点击启用声音」，交互后 AudioContext.resume()
 *   C-REQ-564  ★ 音频未解锁时，**视觉提示必须仍然生效** —— P0 不得只依赖声音
 *   C-REQ-565  音频解锁状态须上报服务端
 *   C-REQ-566  页面失去焦点 / 最小化时，声音提示**仍须播放**
 *   RC4        各浏览器自动播放策略实际行为须实测
 */
(function () {
  'use strict';

  let ctx = null;
  let master = null;
  let unlocked = false;
  let volume = 0.7;
  let enabled = true;

  function ensureCtx() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
    } catch (e) {
      console.warn('[audio] 无法创建 AudioContext', e);
      ctx = null;
    }
    return ctx;
  }

  /**
   * 尝试解锁。**必须**由用户手势（click / keydown / touch）触发。
   * @returns {Promise<boolean>}
   */
  async function unlock() {
    const c = ensureCtx();
    if (!c) return false;
    try {
      if (c.state !== 'running') await c.resume();
      unlocked = c.state === 'running';
    } catch (e) {
      console.warn('[audio] resume 失败', e);
      unlocked = false;
    }
    // 播一个近乎无声的短音，确保 iOS 上真正解锁
    if (unlocked) {
      try { tone(880, 0.02, 0.0001); } catch { /* ignore */ }
    }
    report();
    return unlocked;
  }

  function report() {
    try { window.arcadeWS?.notify('audio:unlocked', { ok: unlocked }); } catch { /* ignore */ }
  }

  /** 单个振荡器音符 */
  function tone(freq, durSec, gain = 1, type = 'sine', delaySec = 0) {
    const c = ensureCtx();
    if (!c || c.state !== 'running') return;
    const t0 = c.currentTime + delaySec;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    // 短促的 ADSR —— 直接起停会有咔哒声
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + durSec);
    osc.connect(g); g.connect(master);
    osc.start(t0);
    osc.stop(t0 + durSec + 0.03);
  }

  /** C-REQ-561 预置音型 */
  const PATTERNS = {
    none: () => {},
    beep: () => tone(880, 0.14, 0.9, 'sine'),
    triple: () => {
      tone(784, 0.1, 0.85, 'sine', 0);
      tone(988, 0.1, 0.85, 'sine', 0.14);
      tone(1319, 0.16, 0.9, 'sine', 0.28);
    },
    alarm: () => {
      for (let i = 0; i < 4; i++) {
        tone(1046, 0.09, 0.95, 'square', i * 0.19);
        tone(784, 0.09, 0.95, 'square', i * 0.19 + 0.095);
      }
    },
  };

  function play(sound) {
    if (!enabled) return false;
    const fn = PATTERNS[sound] || PATTERNS.none;
    if (!unlocked) {
      // C-REQ-564：不阻断、不报错；视觉提示另行独立生效
      return false;
    }
    try { fn(); return true; } catch (e) { console.warn('[audio] 播放失败', e); return false; }
  }

  function setVolume(v) {
    volume = Math.max(0, Math.min(1, Number(v) || 0));
    if (master) master.gain.value = volume;
  }
  function setEnabled(v) { enabled = !!v; }

  /**
   * 解锁提示条 —— C-REQ-563 / 824。
   * 未解锁时显示醒目的按钮；解锁后隐藏。
   * @param {HTMLElement} host 挂载位置
   * @param {{compact?:boolean}} opts
   */
  function mountUnlockButton(host, opts = {}) {
    const btn = document.createElement('button');
    const render = () => {
      btn.className = `btn ${unlocked ? 'ghost sm' : 'warn lg'} audio-unlock`;
      btn.textContent = unlocked ? '🔊 声音已启用' : '🔊 点击启用声音';
      btn.title = unlocked ? '点击可重新检测' : '浏览器要求先有用户交互才允许播放声音；未启用声音时视觉提示仍会正常显示';
      btn.style.display = unlocked && opts.compact ? 'none' : '';
    };
    btn.addEventListener('click', async () => {
      const r = await unlock();
      render();
      window.ui?.[r ? 'ok' : 'warn'](r ? '声音已启用' : '声音启用失败：请检查浏览器设置或系统音量');
    });
    // 任意一次用户交互都尝试解锁（页面首次点击即可）
    const auto = () => { unlock().then(render); document.removeEventListener('click', auto); document.removeEventListener('keydown', auto); };
    document.addEventListener('click', auto, { once: true });
    document.addEventListener('keydown', auto, { once: true });

    render();
    if (host) host.append(btn);
    return { btn, render, unlock };
  }

  function status() { return { unlocked, state: ctx?.state || 'closed', volume, enabled }; }

  window.audioCue = { unlock, play, setVolume, setEnabled, mountUnlockButton, status, PATTERNS };
})();
