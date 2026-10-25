/**
 * 共享状态源 —— WS 协议中 hello(全量) / patch(增量) 的数据源。
 *
 * 需求：
 *   S-REQ-101  连接后立即下发 hello，携带全量状态
 *   S-REQ-102  状态变更走 patch 增量，禁止全量广播
 *   G-REQ-109  currentPlayer 只能由模块 A 写入，B/C 只读
 *   A-REQ-004  currentPlayer 的写入只允许来自控制端的显式操作，禁止自动推断
 *   A-REQ-306  playerSnapshot 必须快照而非实时引用
 *   C-REQ-597  C 镜像 B 的 phase（只读显示）
 */
import { EventEmitter } from 'node:events';

export const stateEvents = new EventEmitter();

/**
 * 全量状态树。分模块隔离，任何模块崩溃不影响其余模块的子树。
 * 注意：这里只放**可序列化、值得广播**的状态；高频数据（截图帧）走二进制通道。
 */
const state = {
  // ── 链路健康（B-REQ-303 / S-REQ 通用） ──
  health: {
    vmix: { connected: false, lastOk: 0, lastErr: null, rttMs: 0, failCount: 0 },
    obs: { connected: false, lastOk: 0, lastErr: null, version: null, scenes: [] },
    overlayClients: 0,
    servers: { overlay: null, control: null },
  },

  // ── 模块 A ──
  overlay: {
    target: 'main',
    activeTemplate: null,
    slotValues: {},
    visible: false,
    mode: 'live',
    playerSnapshot: null,   // ★ 快照，不是实时引用（A-REQ-306）
    queue: [],
    renderedAt: 0,          // 最近一次 overlay:rendered 上报
    clients: {},            // { [target]: { ua, connectedAt, at } }
  },

  // ── 模块 B ──
  replay: {
    phase: 'IDLE',
    recording: false,
    channel: 'A',
    eventList: 1,
    speed: 1.0,
    lastEventDurationMs: 0,
    lastMarkMs: null,
    since: 0,
    live: true,                 // <replay live>：false = 正在回放
    positionMs: 0,
    durationMs: 0,
    externalChange: null,       // 检测到外部操作时置位（B-REQ-806）
    fault: null,
    busy: false,
    preflight: null,
    clip: {
      lookbackMs: 12000,
      outPointMode: 'follow-now',
      fixedLengthMs: 8000,
      inPointOffsetFrames: 0,
      outPointOffsetFrames: 0,
      estimatedDurationMs: 0,
      selectedEventId: null,
    },
    events: [],                 // 事件库 20 条
    history: [],                // 最近的回放记录
  },

  // ── 模块 B / 转场 ──
  transitions: {
    studioMode: false,
    current: { name: 'Cut', uuid: '', kind: '', duration: 0, configurable: false, settings: {} },
    list: [],
    kinds: [],
    programScene: '',
    previewScene: '',
    overrides: {},              // { sceneName: { transitionName, transitionDuration } }
    overridesAt: 0,
  },

  // ── 模块 C ──
  cue: {
    active: {},                 // { [cueId]: Cue } —— 只在服务端完整，不下发给受众端
    clients: {},                // { [audience]: { [clientId]: ClientInfo } }
    counts: { director: 0, cast: 0 },
    /** 每个受众的音频解锁情况：{ [audience]: { total, unlocked } }（C-REQ-565） */
    audio: {},
    /** 镜像自模块 B 的相位（只读，C-REQ-597） */
    bPhase: 'IDLE',
    pendingCount: 0,
    alert: null,                // 导播页告警 / 转场大提醒
  },

  countdown: {
    active: null,               // 当前倒计时快照
    queue: [],                  // 待执行编排
    lastResult: null,
  },

  // ── 模块 D：比分条 / 选手牌（常驻叠加） ──
  score: {
    state: null,                // score.snapshot()
  },

  // ── 模块 F：比赛计分 / 选曲 ──
  match: {
    state: null,                // match.snapshot()
    // 解说摄像头叠加用的最小赛程快照（渲染端也能收到）
    ticker: null,               // { current, upcoming, status, updatedAt }
  },

  // ── 模块 E：抽奖 / 现场签到 ──
  lottery: {
    state: null,                // lottery.snapshot()
  },

  // ── 曲目库同步（国服 API 待确认补丁） ──
  music: {
    cnSync: null,
  },

  // ── 随机选曲大屏（全屏场景） ──
  random: {
    state: null,                // 最近一次随机结果 + 转盘序列
  },

  // ── 选手选曲展示（全屏场景） ──
  pickshow: {
    state: null,                // 当前输出选项 + P1/P2 选曲
  },

  // ── 配置元信息（不含敏感值） ──
  config: {
    loadedAt: 0,
    errors: {},
    restartPending: false,
  },
};

export function getState() { return state; }

/** 当前玩家（唯一写入方 = 模块 A 控制端） */
export function getCurrentPlayer() {
  return state.overlay.playerSnapshot;
}

/** 生成快照 —— 深拷贝并把当时的值冻结下来（A-REQ-306 / C-REQ-590/591） */
export function snapshotPlayer(entity, at = Date.now()) {
  if (!entity) return null;
  return {
    playerId: entity.id,
    playerName: entity.name,
    side: entity.side,
    at,
    // 额外保留原文用于浮窗直接渲染
    entity: structuredClone(entity),
  };
}

/**
 * 写状态并按点分路径广播 patch。
 * @param {string} path 形如 'replay.phase'
 * @param {unknown} value
 * @param {{silent?:boolean}} [opts] silent = 只改内存不广播（批量更新时用，最后统一广播）
 */
export function set(path, value, opts = {}) {
  const keys = path.split('.');
  let cur = state;
  for (let i = 0; i < keys.length - 1; i++) cur = cur[keys[i]];

  const leaf = keys[keys.length - 1];
  const before = JSON.stringify(cur[leaf]);
  cur[leaf] = value;
  if (before === JSON.stringify(value)) return false;

  if (!opts.silent) stateEvents.emit('patch', path, value);
  return true;
}

/** 批量写：逐项 set(silent)，最后发一条 'batch' 让 WS 层合并广播 */
export function batch(entries) {
  const changed = [];
  for (const [p, v] of Object.entries(entries)) {
    if (set(p, v, { silent: true })) changed.push([p, v]);
  }
  if (changed.length) stateEvents.emit('batch', changed);
  return changed;
}

/** 模块 A 专用：设置当前玩家（其它模块不得调用） */
export function setCurrentPlayer(entity, at = Date.now()) {
  const snap = snapshotPlayer(entity, at);
  set('overlay.playerSnapshot', snap);
  return snap;
}
