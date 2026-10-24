/**
 * 格式化工具 —— 全前端共用。
 * 重点：**帧 / 秒单位换算**必须集中在这里（陷阱 #19：混淆秒与帧会错位数个数量级）。
 */
(function () {
  'use strict';

  /** HH:MM:SS.mmm */
  function timecode(ms, { showMs = false } = {}) {
    if (!Number.isFinite(ms) || ms < 0) ms = 0;
    const t = Math.floor(ms);
    const h = Math.floor(t / 3600000);
    const m = Math.floor((t % 3600000) / 60000);
    const s = Math.floor((t % 60000) / 1000);
    const f = t % 1000;
    const base = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return showMs ? `${base}.${String(f).padStart(3, '0')}` : base;
  }

  /** 01:23 / 1:23.4 —— 时长显示 */
  function duration(ms) {
    if (!Number.isFinite(ms) || ms < 0) ms = 0;
    const total = ms / 1000;
    const m = Math.floor(total / 60);
    const s = total % 60;
    if (m === 0) return `${s.toFixed(1)}s`;
    return `${m}:${String(Math.floor(s)).padStart(2, '0')}`;
  }

  /** 秒数（保留 1 位） */
  function secs(ms, digits = 1) {
    if (!Number.isFinite(ms)) return '—';
    return `${(ms / 1000).toFixed(digits)}s`;
  }

  function clock(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  }

  function datetime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${clock(ts)}`;
  }

  function relTime(ts) {
    if (!ts) return '—';
    const diff = Date.now() - ts;
    if (diff < 0) return `${Math.round(-diff / 1000)}s 后`;
    if (diff < 1000) return '刚刚';
    if (diff < 60000) return `${Math.floor(diff / 1000)}s 前`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m 前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h 前`;
    return `${Math.floor(diff / 86400000)}d 前`;
  }

  function bytes(n) {
    if (!Number.isFinite(n)) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1073741824) return `${(n / 1048576).toFixed(2)} MB`;
    return `${(n / 1073741824).toFixed(2)} GB`;
  }

  /** ★ 陷阱 #19：帧 ↔ 秒 换算的唯一入口 */
  function framesToMs(frames, frameRate) {
    const fr = Number(frameRate) || 60;
    return Math.round((Number(frames) || 0) / fr * 1000);
  }
  function msToFrames(ms, frameRate) {
    const fr = Number(frameRate) || 60;
    return Math.round((Number(ms) || 0) / 1000 * fr);
  }
  /** 微调量的展示：同时给帧与等价值（B-REQ-526 要求 UI 须换算并显示等价值） */
  function framesLabel(frames, frameRate) {
    const fr = Number(frameRate) || 60;
    const ms = framesToMs(frames, fr);
    return `${frames > 0 ? '+' : ''}${frames} 帧（${ms > 0 ? '+' : ''}${Math.round(ms)}ms @${fr}fps）`;
  }

  function priorityClass(p) { return ['P0', 'P1', 'P2', 'P3'].includes(p) ? p : 'P3'; }

  function phaseLabel(phase) {
    return {
      IDLE: '未录制', ARMED: '就绪', MARKING: '裁切中', CUED: '已裁切',
      AIR: '回放中', RETURNING: '回程中', FAULT: '故障',
    }[phase] || phase || '—';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  window.fmt = { timecode, duration, secs, clock, datetime, relTime, bytes, framesToMs, msToFrames, framesLabel, priorityClass, phaseLabel, escapeHtml };
})();
