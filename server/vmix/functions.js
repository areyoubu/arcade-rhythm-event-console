/**
 * vMix 回放函数全表（SRS 附录 A：13 个功能区 / 151 个函数）。
 *
 * ⚠️⚠️⚠️  §5.6 陷阱 #18 / B-REQ-1006 / B-REQ-523  ⚠️⚠️⚠️
 *
 *   下面这些函数的官方参数列是 **None**，它们作用于「当前选中通道」：
 *       ReplayMarkIn        ReplayMarkOut        ReplayMarkCancel
 *       ReplayMarkInLive    ReplayMarkInRecorded ReplayMarkInRecordedNow
 *   直接调用会砍掉**别的通道**上的事件。它们在表中一律标记 needsChannel:true，
 *   client 层会拒绝裸调，必须走 callOnChannel()（内部先发 ReplaySelectChannel{A|B}）。
 *
 * ✅ B-REQ-405：**`ReplayStop` 不是有效函数**（已核验官方函数列表，不存在）。
 *    停止播放要用 `ReplayStopEvents`。本表不收录 `ReplayStop`，且 client 层显式拦截。
 *
 * ✅ 陷阱 #19：`ReplayMarkInOut*` 的 Value 单位是**秒**；
 *    `ReplayMoveSelectedIn/OutPoint` 与 `ReplayJumpFrames` 的单位是**帧**。
 *    混用会错位数个数量级 —— 表中 unit 字段已固化，UI 必须据此换算展示。
 *
 * ✅ 陷阱 #21：`ReplayMarkInOutLiveFuture` 创建的事件在 N 秒后才完整，
 *    **不可用于即时上屏**。标记 future:true。
 */

/** 功能区（对应 §5.12.1 的 13 个区） */
export const ZONES = [
  { id: 1,  key: 'record',    label: '录制' },
  { id: 2,  key: 'channel',   label: '通道' },
  { id: 3,  key: 'library',   label: '事件库' },
  { id: 4,  key: 'select',    label: '事件选择' },
  { id: 5,  key: 'mark',      label: '打点 / 裁切' },
  { id: 6,  key: 'play',      label: '播放控制' },
  { id: 7,  key: 'speed',     label: '速度与方向' },
  { id: 8,  key: 'frame',     label: '逐帧 / 时间码' },
  { id: 9,  key: 'mode',      label: 'Live / 回放模式' },
  { id: 10, key: 'camera',    label: '机位（1–8）' },
  { id: 11, key: 'text',      label: '文字标注' },
  { id: 12, key: 'manage',    label: '事件管理' },
  { id: 13, key: 'ui',        label: 'UI / 其他' },
];

const Z = Object.fromEntries(ZONES.map((z) => [z.key, z.id]));

/** 参数类型简写 */
const CH = { name: 'Channel', type: 'channel', required: true };
const VAL = (min, max) => ({ name: 'Value', type: 'number', min, max, required: true });

/** @type {Array<object>} */
export const VMIX_FUNCTIONS = [];
function def(o) { VMIX_FUNCTIONS.push(o); return o; }

// ══════════════ 1. 录制（3） ══════════════
def({ fn: 'ReplayStartRecording',     zone: Z.record, label: '开始回放录制', args: [], readback: 'recording', target: 'record' });
def({ fn: 'ReplayStopRecording',      zone: Z.record, label: '停止回放录制', args: [], readback: 'recording', target: 'record' });
def({ fn: 'ReplayStartStopRecording', zone: Z.record, label: '启停切换（硬件映射）', args: [], readback: 'recording', target: 'record' });

// ══════════════ 2. 通道（6） ══════════════
def({ fn: 'ReplaySelectChannelA',  zone: Z.channel, label: '选择通道 A', args: [], target: 'select', selectsChannel: 'A' });
def({ fn: 'ReplaySelectChannelB',  zone: Z.channel, label: '选择通道 B', args: [], target: 'select', selectsChannel: 'B' });
def({ fn: 'ReplaySelectChannelAB', zone: Z.channel, label: '选择通道 A+B', args: [], target: 'select', selectsChannel: 'AB' });
def({ fn: 'ReplaySwapChannels',    zone: Z.channel, label: '交换通道', args: [], target: 'select' });
def({ fn: 'ReplaySetChannelAToBTimecode', zone: Z.channel, label: 'A 对齐到 B 时间码', args: [CH] });
def({ fn: 'ReplaySetChannelBToATimecode', zone: Z.channel, label: 'B 对齐到 A 时间码', args: [CH] });

// ══════════════ 3. 事件库（22） ══════════════
for (let i = 1; i <= 20; i++) {
  def({ fn: `ReplaySelectEvents${i}`, zone: Z.library, label: `选择事件库 ${i}`, args: [CH], eventList: i });
}
def({ fn: 'ReplayScrollSelectedEvent', zone: Z.library, label: '滚动事件列表', args: [VAL(-10, 10)] });
def({ fn: 'ReplaySelectAllEvents',     zone: Z.library, label: '选择全部事件', args: [] });

// ══════════════ 4. 事件选择（4） ══════════════
def({ fn: 'ReplaySelectFirstEvent',    zone: Z.select, label: '选中首个事件', args: [CH] });
def({ fn: 'ReplaySelectLastEvent',     zone: Z.select, label: '选中末尾事件', args: [CH] });
def({ fn: 'ReplaySelectNextEvent',     zone: Z.select, label: '选中下一事件', args: [CH] });
def({ fn: 'ReplaySelectPreviousEvent', zone: Z.select, label: '选中上一事件', args: [CH] });

// ══════════════ 5. 打点 / 裁切（16）★ ══════════════
def({ fn: 'ReplayMarkInOut',            zone: Z.mark, label: '即时裁切（回溯 N 秒）', args: [{ ...VAL(0, 3600), unit: 'sec' }], unit: 'sec', variant: true, primary: true });
def({ fn: 'ReplayMarkInOutLive',        zone: Z.mark, label: '即时裁切（Live 变体）',   args: [{ ...VAL(0, 3600), unit: 'sec' }], unit: 'sec', variant: true });
def({ fn: 'ReplayMarkInOutRecorded',    zone: Z.mark, label: '即时裁切（Recorded 变体）', args: [{ ...VAL(0, 3600), unit: 'sec' }], unit: 'sec', variant: true });
def({ fn: 'ReplayMarkInOutLiveFuture',  zone: Z.mark, label: '记录未来 N 秒', args: [{ ...VAL(0, 3600), unit: 'sec' }], unit: 'sec', variant: true, future: true,
      hint: '⚠️ 该函数创建的事件在 N 秒后才完整，**不可用于即时上屏**' });
def({ fn: 'ReplayMarkIn',           zone: Z.mark, label: '设入点', args: [], needsChannel: true, hint: '官方参数为 None，作用于当前选中通道' });
def({ fn: 'ReplayMarkOut',          zone: Z.mark, label: '设出点', args: [], needsChannel: true, hint: '官方参数为 None，作用于当前选中通道' });
def({ fn: 'ReplayMarkInLive',       zone: Z.mark, label: '设入点（Live）', args: [], needsChannel: true });
def({ fn: 'ReplayMarkInRecorded',   zone: Z.mark, label: '设入点（Recorded）', args: [], needsChannel: true });
def({ fn: 'ReplayMarkInRecordedNow', zone: Z.mark, label: '设入点（Recorded 立即）', args: [], needsChannel: true });
def({ fn: 'ReplayMarkCancel',       zone: Z.mark, label: '取消裁切 / 丢弃片段', args: [], needsChannel: true, destructive: true,
      hint: '⚠️ 无 Channel 参数，作用于当前选中通道，必须先 ReplaySelectChannel' });
def({ fn: 'ReplayUpdateSelectedInPoint',  zone: Z.mark, label: '入点 = 当前位置', args: [CH] });
def({ fn: 'ReplayUpdateSelectedOutPoint', zone: Z.mark, label: '延长尾部（出点 = 当前位置）', args: [CH], primary: true });
def({ fn: 'ReplayMoveSelectedInPoint',    zone: Z.mark, label: '微调入点', args: [{ ...VAL(-600, 600), unit: 'frame' }, CH], unit: 'frame' });
def({ fn: 'ReplayMoveSelectedOutPoint',   zone: Z.mark, label: '微调出点', args: [{ ...VAL(-600, 600), unit: 'frame' }, CH], unit: 'frame' });
def({ fn: 'ReplayJumpToSelectedInPoint',  zone: Z.mark, label: '跳到入点核对', args: [CH], movesPlayhead: true });
def({ fn: 'ReplayJumpToSelectedOutPoint', zone: Z.mark, label: '跳到出点核对', args: [CH], movesPlayhead: true });

// ══════════════ 6. 播放控制（18）★ ══════════════
def({ fn: 'ReplayPlay',           zone: Z.play, label: '播放', args: [CH] });
def({ fn: 'ReplayPause',          zone: Z.play, label: '暂停', args: [CH] });
def({ fn: 'ReplayPlayPause',      zone: Z.play, label: '播放 / 暂停', args: [CH] });
def({ fn: 'ReplayStopEvents',     zone: Z.play, label: '停止播放', args: [CH],
      hint: '★ 停止播放用此函数。ReplayStop 不存在（B-REQ-405）' });
def({ fn: 'ReplayPlayForward',    zone: Z.play, label: '正向播放', args: [CH] });
def({ fn: 'ReplayPlayBackward',   zone: Z.play, label: '反向播放', args: [CH] });
def({ fn: 'ReplayPlayPrevious',   zone: Z.play, label: '播上一事件', args: [CH] });
def({ fn: 'ReplayPlayNext',       zone: Z.play, label: '播下一事件', args: [CH] });
def({ fn: 'ReplayPlayLastEvent',           zone: Z.play, label: '播最近事件（预览）', args: [CH], target: 'preview' });
def({ fn: 'ReplayPlayLastEventToOutput',   zone: Z.play, label: '播最近事件 → 输出', args: [CH], target: 'output' });
def({ fn: 'ReplayPlaySelectedEvent',          zone: Z.play, label: '播选中事件（预览）', args: [CH], target: 'preview' });
def({ fn: 'ReplayPlaySelectedEventToOutput',  zone: Z.play, label: '播选中事件 → 输出', args: [CH], target: 'output' });
def({ fn: 'ReplayPlayEvent',                  zone: Z.play, label: '播指定事件（预览）', args: [VAL(0, 1000)], target: 'preview' });
def({ fn: 'ReplayPlayEventToOutput',          zone: Z.play, label: '播指定事件 → 输出', args: [CH], target: 'output' });
def({ fn: 'ReplayPlayAllEvents',              zone: Z.play, label: '播全部事件（预览）', args: [CH], target: 'preview' });
def({ fn: 'ReplayPlayAllEventsToOutput',      zone: Z.play, label: '播全部事件 → 输出', args: [CH], target: 'output' });
def({ fn: 'ReplayPlayEventsByID',             zone: Z.play, label: '按 ID 播事件（预览）', args: [{ name: 'Value', type: 'idlist', required: true }], target: 'preview' });
def({ fn: 'ReplayPlayEventsByIDToOutput',     zone: Z.play, label: '按 ID 播事件 → 输出', args: [{ name: 'Value', type: 'idlist', required: true }, CH], target: 'output' });

// ══════════════ 7. 速度与方向（10） ══════════════
def({ fn: 'ReplaySetSpeed',      zone: Z.speed, label: '设置速度', args: [VAL(0, 1), CH], unit: 'ratio' });
def({ fn: 'ReplayChangeSpeed',   zone: Z.speed, label: '增减速度', args: [{ ...VAL(-1, 1), unit: 'delta' }, CH], unit: 'delta' });
def({ fn: 'ReplayFastForward',   zone: Z.speed, label: '快进', args: [VAL(1, 30), CH], hint: '单位：倍速 1–30x' });
def({ fn: 'ReplayFastBackward',  zone: Z.speed, label: '快退', args: [VAL(1, 30), CH], hint: '单位：倍速 1–30x' });
def({ fn: 'ReplaySetDirectionForward',  zone: Z.speed, label: '设为正向', args: [CH] });
def({ fn: 'ReplaySetDirectionBackward', zone: Z.speed, label: '设为反向', args: [CH] });
def({ fn: 'ReplayChangeDirection',      zone: Z.speed, label: '反转方向', args: [CH] });
def({ fn: 'ReplayUpdateSelectedSpeed',        zone: Z.speed, label: '速度 = 当前速度', args: [CH] });
def({ fn: 'ReplayUpdateSelectedSpeedDefault', zone: Z.speed, label: '速度 = 默认值', args: [CH] });
def({ fn: 'ReplayUpdateSelectedSpeedFromValue', zone: Z.speed, label: '速度 = 指定值', args: [VAL(0, 1), CH] });

// ══════════════ 8. 逐帧 / 时间码（5） ══════════════
def({ fn: 'ReplayJumpFrames', zone: Z.frame, label: '跳帧', args: [{ ...VAL(-600, 600), unit: 'frame-ambig' }, CH], unit: 'frame-ambig',
      hint: '⚠️ R14：官方描述「默认单位是秒，开启 FastOn 后才是帧」，与直觉相反，须实测' });
def({ fn: 'ReplayJumpFramesFastOn',  zone: Z.frame, label: '逐帧模式：快', args: [CH], hint: 'R14：开启后 ReplayJumpFrames 的 Value 才按帧解释' });
def({ fn: 'ReplayJumpFramesFastOff', zone: Z.frame, label: '逐帧模式：慢', args: [CH] });
def({ fn: 'ReplayJumpToNow',         zone: Z.frame, label: '跳回直播点', args: [CH], critical: true,
      hint: '★ 用 ReplayJumpToSelected*Point 核对后**必须**回位，否则后续所有裁切起点全部错误（陷阱 #20）' });
def({ fn: 'ReplaySetTimecode', zone: Z.frame, label: '跳到时间码', args: [{ name: 'Value', type: 'timecode', required: true, placeholder: 'yyyy-MM-ddTHH:mm:ss.fff' }, CH] });

// ══════════════ 9. Live / 回放模式（3） ══════════════
def({ fn: 'ReplayLive',       zone: Z.mode, label: '切到 Live 直通', args: [], dangerous: true,
      hint: '⚠️ B-REQ-602：回程**禁止**调用。ReplayLive 使通道变为落后 L≈200ms 的直播直通，下一次硬切会造成画面倒退' });
def({ fn: 'ReplayLiveToggle', zone: Z.mode, label: 'Live / 回放互换', args: [], dangerous: true });
def({ fn: 'ReplayRecorded',   zone: Z.mode, label: '切到回放态', args: [] });

// ══════════════ 10. 机位（46）—— 本项目单机位，UI 可折叠但封装必须存在 ══════════════
for (let i = 1; i <= 8; i++) def({ fn: `ReplayCamera${i}`,  zone: Z.camera, label: `机位 ${i}`, args: [] });
for (let i = 1; i <= 8; i++) def({ fn: `ReplayACamera${i}`, zone: Z.camera, label: `通道 A 机位 ${i}`, args: [] });
for (let i = 1; i <= 8; i++) def({ fn: `ReplayBCamera${i}`, zone: Z.camera, label: `通道 B 机位 ${i}`, args: [] });
def({ fn: 'ReplayLastEventCameraOn',           zone: Z.camera, label: '最近事件机位：开', args: [VAL(1, 8)] });
def({ fn: 'ReplayLastEventCameraOff',          zone: Z.camera, label: '最近事件机位：关', args: [VAL(1, 8)] });
def({ fn: 'ReplayLastEventSingleCameraOn',     zone: Z.camera, label: '最近事件单机位：开', args: [VAL(1, 8)] });
def({ fn: 'ReplaySelectedEventCameraOn',       zone: Z.camera, label: '选中事件机位：开', args: [VAL(1, 8)] });
def({ fn: 'ReplaySelectedEventCameraOff',      zone: Z.camera, label: '选中事件机位：关', args: [VAL(1, 8)] });
def({ fn: 'ReplaySelectedEventSingleCameraOn', zone: Z.camera, label: '选中事件单机位：开', args: [VAL(1, 8)] });
for (let i = 1; i <= 8; i++) def({ fn: `ReplayToggleLastEventCamera${i}`,     zone: Z.camera, label: `最近事件机位 ${i} 切换`, args: [] });
for (let i = 1; i <= 8; i++) def({ fn: `ReplayToggleSelectedEventCamera${i}`, zone: Z.camera, label: `选中事件机位 ${i} 切换`, args: [] });

// ══════════════ 11. 文字标注（4） ══════════════
def({ fn: 'ReplaySetLastEventText',             zone: Z.text, label: '最近事件文字', args: [{ name: 'Value', type: 'text', required: true, maxLength: 80 }] });
def({ fn: 'ReplaySetSelectedEventText',         zone: Z.text, label: '选中事件文字', args: [{ name: 'Value', type: 'text', required: true, maxLength: 80 }] });
def({ fn: 'ReplaySetLastEventTextCamera',       zone: Z.text, label: '最近事件机位文字', args: [{ name: 'Value', type: 'compound', required: true, placeholder: '机位号,标签' }] });
def({ fn: 'ReplaySetSelectedEventTextCamera',   zone: Z.text, label: '选中事件机位文字', args: [{ name: 'Value', type: 'compound', required: true, placeholder: '机位号,标签' }] });

// ══════════════ 12. 事件管理（11） ══════════════
def({ fn: 'ReplayCopyLastEvent',             zone: Z.manage, label: '复制最近事件到库', args: [VAL(0, 19)] });
def({ fn: 'ReplayCopySelectedEvent',         zone: Z.manage, label: '复制选中事件到库', args: [VAL(0, 19)] });
def({ fn: 'ReplayDuplicateLastEvent',        zone: Z.manage, label: '克隆最近事件', args: [CH] });
def({ fn: 'ReplayDuplicateSelectedEvent',    zone: Z.manage, label: '克隆选中事件', args: [CH] });
def({ fn: 'ReplayMoveLastEvent',             zone: Z.manage, label: '移动最近事件到库', args: [VAL(0, 19)] });
def({ fn: 'ReplayMoveSelectedEvent',         zone: Z.manage, label: '移动选中事件到库', args: [VAL(0, 19)] });
def({ fn: 'ReplayMoveSelectedEventUp',       zone: Z.manage, label: '上移事件', args: [] });
def({ fn: 'ReplayMoveSelectedEventDown',     zone: Z.manage, label: '下移事件', args: [] });
def({ fn: 'ReplayDeleteLastEvent',           zone: Z.manage, label: '删除最近事件', args: [CH], destructive: true });
def({ fn: 'ReplayDeleteSelectedEvent',       zone: Z.manage, label: '删除选中事件', args: [CH], destructive: true });
def({ fn: 'ReplayExportLastEvent',           zone: Z.manage, label: '导出最近事件', args: [{ name: 'Value', type: 'folder', required: true }, CH] });

// ══════════════ 13. UI / 其他（3） ══════════════
def({ fn: 'Replay',              zone: Z.ui, label: '打开回放面板', args: [] });
def({ fn: 'ReplayShowHide',      zone: Z.ui, label: '显示 / 隐藏回放', args: [] });
def({ fn: 'ReplaySetAudioSource', zone: Z.ui, label: '设置回放音频源', args: [] });

// ─────────────────────────────────────────────────────────────
// 派生索引与断言
// ─────────────────────────────────────────────────────────────

/** fn 名 -> 定义 */
export const FN_MAP = new Map(VMIX_FUNCTIONS.map((f) => [f.fn, f]));

/** 需要「先选通道」的 None 参数函数（B-REQ-1006） */
export const NEEDS_CHANNEL = VMIX_FUNCTIONS.filter((f) => f.needsChannel).map((f) => f.fn);

/**
 * 「→ 输出」类函数（B-REQ-2003：UI 须与预览类视觉区分）。
 *
 * ⚠️ 与 SRS 的一处不一致：B-REQ-2003 写「→ 输出」类函数共 **6 个**，
 * 但附录 A.6 实际只标注了 **5 个** ★ 上屏函数（PlayLast/PlaySelected/PlayEvent/
 * PlayAllEvents/PlayEventsByID 的 ToOutput 变体）。
 * 本实现以**附录 A 的实际函数表**为准（5 个），不虚构第 6 个。
 * 播放控制区共 18 个函数，其余 13 个均为预览类。
 */
export const TO_OUTPUT = VMIX_FUNCTIONS.filter((f) => f.target === 'output').map((f) => f.fn);
export const PREVIEW_ONLY = VMIX_FUNCTIONS.filter((f) => f.target === 'preview').map((f) => f.fn);

/** 破坏性函数（B-REQ-2009：须二次确认） */
export const DESTRUCTIVE = VMIX_FUNCTIONS.filter((f) => f.destructive || f.dangerous).map((f) => f.fn);

/** 会移动播放头的函数（陷阱 #20：用完必须 ReplayJumpToNow 回位） */
export const MOVES_PLAYHEAD = VMIX_FUNCTIONS.filter((f) => f.movesPlayhead).map((f) => f.fn);

/**
 * ✅ B-REQ-405：`ReplayStop` 不是有效函数。
 * 保留本常量是为了让任何试图引用它的代码立刻在测试里炸掉，而不是在直播中静默失败。
 */
export const REPLAY_STOP_IS_NOT_A_FUNCTION = Object.freeze({
  wrong: 'ReplayStop',
  correct: 'ReplayStopEvents',
  note: '已核验 vMix 官方函数列表不存在 ReplayStop；停止播放请用 ReplayStopEvents。',
});

export function getFunctionDef(fn) { return FN_MAP.get(fn) || null; }

export function functionsByZone(zoneId) {
  return VMIX_FUNCTIONS.filter((f) => f.zone === zoneId);
}

/** 供 /replay 页渲染用的完整表（含分区结构） */
export function functionCatalog() {
  return ZONES.map((z) => ({
    ...z,
    functions: VMIX_FUNCTIONS.filter((f) => f.zone === z.id).map((f) => ({
      fn: f.fn,
      label: f.label,
      args: f.args,
      unit: f.unit || null,
      target: f.target || 'channel',
      needsChannel: !!f.needsChannel,
      destructive: !!(f.destructive || f.dangerous),
      dangerous: !!f.dangerous,
      future: !!f.future,
      movesPlayhead: !!f.movesPlayhead,
      critical: !!f.critical,
      hint: f.hint || null,
      primary: !!f.primary,
    })),
  }));
}

// 自检：表大小必须正好 151（§5.12.1 的合计值）
if (VMIX_FUNCTIONS.length !== 151) {
  // 用 throw 而不是 log —— 表不完整属于开发期错误，必须在启动阶段暴露
  throw new Error(`vMix 函数表数量错误：期望 151，实际 ${VMIX_FUNCTIONS.length}（§5.12.1）`);
}
if (FN_MAP.has('ReplayStop')) {
  throw new Error('vMix 函数表误收录了不存在的 ReplayStop（B-REQ-405）');
}
