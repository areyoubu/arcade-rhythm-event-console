/**
 * OBS 转场控制。
 *
 * 需求：
 *   B-REQ-3001 ★ 场景转场覆盖的变更**无法通过事件感知**（`SceneTransitionOverrideChanged` 不存在 ✅），
 *                须在以下时机主动重读：① 预检；② 用户打开转场设置面板；③ 每 60s 低频轮询。
 *                不得假定覆盖值恒定。
 *   B-REQ-3002  转场控制须在**非演播室模式**下也能工作（直接 SetCurrentProgramScene）
 *   B-REQ-3003  演播室模式开关须显示当前状态并给出模式差异说明
 *   B-REQ-3004  SetCurrentPreviewScene 在非演播室模式调用会失败，须前置检查
 *   B-REQ-3006  SetTBarPosition 须标注「官方将废弃」，不作为主流程依赖
 *   B-REQ-3007  转场时长输入须校验 50–20000ms
 *   B-REQ-3008  转场切换后须**立即重读**确认生效（防静默失败）
 *   B-REQ-1103  stinger 的 Transition Point 是实例自身属性，obs-websocket 无法修改
 */
import { getConfig } from './config.js';
import { set, getState } from './state.js';
import * as log from './logger.js';
import * as obs from './obs.js';

let pollTimer = null;
/** 面板是否打开 —— 打开时提高重读频率 */
let panelOpen = false;

export function startPolling() {
  stopPolling();
  const tick = async () => {
    if (obs.isConnected()) {
      try { await refreshOverrides(); } catch (e) { log.debug('transitions', '覆盖重读失败', { err: e.message }); }
    }
    const interval = panelOpen
      ? Math.min(8000, getConfig().transitions.pollOverrideIntervalMs)
      : getConfig().transitions.pollOverrideIntervalMs;
    pollTimer = setTimeout(tick, Math.max(3000, interval));
    pollTimer.unref?.();
  };
  pollTimer = setTimeout(tick, 2000);
  pollTimer.unref?.();
}

export function stopPolling() { if (pollTimer) clearTimeout(pollTimer); pollTimer = null; }

export function setPanelOpen(open) {
  panelOpen = !!open;
  if (open && obs.isConnected()) refreshOverrides().catch(() => { /* ignore */ });
}

/** B-REQ-3001：重读全部相关场景的转场覆盖 */
export async function refreshOverrides() {
  const cfg = getConfig();
  const names = [...new Set([cfg.scenes.live, cfg.scenes.replay, cfg.scenes.clean, getState().transitions.programScene].filter(Boolean))];
  const out = await obs.readAllSceneOverrides(names);
  // 与配置中的期望值对比，偏差要显式提示（不静默）
  const expected = cfg.transitions.sceneOverrides || {};
  const drift = [];
  for (const [scene, want] of Object.entries(expected)) {
    const got = out[scene];
    if (!got) continue;
    if (got.transitionName !== want.transitionName || got.transitionDuration !== want.transitionDuration) {
      drift.push({ scene, expected: want, actual: got });
    }
  }
  if (drift.length) {
    log.warn('transitions', '场景转场覆盖与配置不一致（可能是有人在 OBS 里手改过）',
      { drift: drift.map((d) => `${d.scene}: 期望 ${d.expected.transitionName}/${d.expected.transitionDuration} 实际 ${d.actual.transitionName}/${d.actual.transitionDuration}`) });
    set('transitions.drift', drift);
  } else {
    set('transitions.drift', []);
  }
  return out;
}

/** 把配置中的覆盖值下发到 OBS（设置页「同步覆盖」按钮） */
export async function applyOverridesFromConfig() {
  const cfg = getConfig();
  const results = [];
  for (const [scene, v] of Object.entries(cfg.transitions.sceneOverrides || {})) {
    try {
      await obs.setSceneOverride(scene, v.transitionName, v.transitionDuration);
      results.push({ scene, ok: true });
    } catch (e) {
      results.push({ scene, ok: false, error: e.message });
      log.warn('transitions', `场景转场覆盖下发失败：${scene}`, { err: e.message });
    }
  }
  await refreshOverrides();
  log.audit('transitions', 'applyOverridesFromConfig', { results });
  return results;
}

/** 拉取转场列表与当前转场（转场面板打开时调用） */
export async function refreshList() {
  await obs.listTransitions();
  await obs.getCurrentTransition().catch(() => { /* 忽略 */ });
  await refreshOverrides();
  return {
    list: getState().transitions.list,
    current: getState().transitions.current,
    overrides: getState().transitions.overrides,
    studioMode: getState().transitions.studioMode,
  };
}

/** 切换当前转场 + B-REQ-3008 立即重读确认 */
export async function setTransition(transitionName, durationMs) {
  // B-REQ-3007：时长校验 50–20000ms，越界前端与本层双拦截
  if (durationMs !== undefined && durationMs !== null) {
    const n = Number(durationMs);
    if (!Number.isFinite(n) || n < 50 || n > 20000) {
      return { ok: false, nack: { code: 'bad_duration', msg: `转场时长须在 50–20000ms 之间，收到 ${durationMs}` } };
    }
  }
  await obs.setSceneTransition(transitionName, durationMs);
  const readback = await obs.getCurrentTransition();
  const ok = readback.transitionName === transitionName;
  if (!ok) {
    log.warn('transitions', '转场切换后重读不一致（静默失败）', { requested: transitionName, actual: readback.transitionName });
  }
  log.audit('transitions', 'setTransition', { transitionName, durationMs, confirmed: ok });
  return { ok, requested: transitionName, actual: readback.transitionName, duration: readback.transitionDuration };
}

/** 设置某场景的转场覆盖 */
export async function setOverride(sceneName, transitionName, transitionDuration) {
  if (transitionDuration !== undefined && transitionDuration !== null && transitionDuration !== 0) {
    const n = Number(transitionDuration);
    if (!Number.isFinite(n) || n < 50 || n > 20000) {
      return { ok: false, nack: { code: 'bad_duration', msg: `转场时长须在 50–20000ms 之间（0 表示 Cut）` } };
    }
  }
  const r = await obs.setSceneOverride(sceneName, transitionName, transitionDuration);
  await refreshOverrides();
  log.audit('transitions', 'setOverride', { sceneName, transitionName, transitionDuration });
  return { ok: true, override: r };
}

/** 演播室模式开关（B-REQ-3002/3003） */
export async function setStudioMode(enabled) {
  await obs.setStudioMode(enabled);
  log.audit('transitions', 'setStudioMode', { enabled });
  return { ok: true, studioMode: getState().transitions.studioMode };
}

/** 直接切节目场景（非演播室模式下的主路径） */
export async function setProgramScene(sceneName) {
  const cfg = getConfig();
  const known = [cfg.scenes.live, cfg.scenes.replay, cfg.scenes.clean];
  if (!known.includes(sceneName)) {
    log.warn('transitions', '切换到非标准场景', { sceneName });
  }
  await obs.setProgramScene(sceneName);
  log.audit('transitions', 'setProgramScene', { sceneName });
  return { ok: true };
}

/** 触发演播室转场 */
export async function triggerTransition() {
  await obs.triggerStudioTransition();
  log.audit('transitions', 'triggerStudioTransition', {});
  return { ok: true };
}

/** 设预览场景（仅演播室模式，B-REQ-3004） */
export async function setPreviewScene(sceneName) {
  const on = await obs.getStudioModeEnabled();
  if (!on) return { ok: false, nack: { code: 'studio_mode_off', msg: 'SetCurrentPreviewScene 仅在演播室模式下可用；当前为直接切节目模式' } };
  await obs.setPreviewScene(sceneName);
  log.audit('transitions', 'setPreviewScene', { sceneName });
  return { ok: true };
}

/**
 * T-Bar（B-REQ-3006）
 * ⚠️ 官方标注 `SetTBarPosition` **将被废弃**，不作为主流程依赖，仅作兼容保留。
 */
export async function setTBar(position) {
  const p = Number(position);
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    return { ok: false, nack: { code: 'bad_position', msg: 'T-Bar 位置须在 0.0–1.0 之间' } };
  }
  await obs.request('SetTBarPosition', { position: p });
  log.warn('transitions', '使用了将被废弃的 SetTBarPosition', { position: p });
  return { ok: true, deprecated: true, note: 'SetTBarPosition 官方标注将废弃，仅兼容保留' };
}

/** 降级方案检查（B-REQ-1106）：stinger 不可用时用 Fade + ≥600ms */
export async function ensureFallbackTransition() {
  const cfg = getConfig();
  let list = getState().transitions.list.map((t) => t.transitionName);

  // 转场列表只在「打开转场面板」时才会被拉取；启动预检与首次切场景时它是空的。
  // 这里补一次**只读**的 GetSceneTransitionList，否则会误报「没有可降级的转场」。
  if (list.length === 0 && obs.isConnected()) {
    try {
      await obs.listTransitions();
      list = getState().transitions.list.map((t) => t.transitionName);
    } catch (e) {
      log.warn('transitions', '读取转场列表失败', { err: e.message });
    }
  }

  const want = cfg.transitions.replayEnter.transitionName;
  if (list.includes(want)) return { ok: true, transition: want };
  log.warn('transitions', `OBS 中不存在转场「${want}」，降级为 Fade`, { available: list });
  const fade = list.find((n) => /fade/i.test(n));
  if (!fade) return { ok: false, msg: `OBS 中没有名为「${want}」的转场，也没有 Fade 可降级`, available: list };
  return {
    ok: true,
    transition: fade,
    degraded: true,
    note: `stinger「${want}」不可用，已降级为 ${fade}；请把时长设为 ≥600ms 以保证遮罩窗口（B-REQ-1106）`,
  };
}

export function getSnapshot() { return getState().transitions; }
