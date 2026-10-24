/**
 * vMix 函数表测试 —— 对应 AC-21 / B-REQ-1006 / B-REQ-405 / 陷阱 #17 #18 #19 #21。
 *
 * 这些断言的价值在于：它们拦住的每一个问题，在现场都会表现为
 * 「静默失败」或「砍掉了另一个通道的事件」，极难排查。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VMIX_FUNCTIONS, FN_MAP, ZONES, NEEDS_CHANNEL, TO_OUTPUT, DESTRUCTIVE,
  MOVES_PLAYHEAD, functionCatalog, REPLAY_STOP_IS_NOT_A_FUNCTION,
} from '../server/vmix/functions.js';

test('函数表总数必须是 151（SRS §5.12.1 的合计值）', () => {
  assert.equal(VMIX_FUNCTIONS.length, 151);
});

test('函数名不得重复', () => {
  assert.equal(FN_MAP.size, VMIX_FUNCTIONS.length, '存在重名函数');
});

test('分区的函数数量必须与 §5.12.1 一致', () => {
  const byZone = {};
  for (const f of VMIX_FUNCTIONS) byZone[f.zone] = (byZone[f.zone] || 0) + 1;
  const expected = {
    1: 3,     // 录制
    2: 6,     // 通道
    3: 22,    // 事件库
    4: 4,     // 事件选择
    5: 16,    // 打点 / 裁切
    6: 18,    // 播放控制
    7: 10,    // 速度与方向
    8: 5,     // 逐帧 / 时间码
    9: 3,     // Live / 回放模式
    10: 46,   // 机位
    11: 4,    // 文字标注
    12: 11,   // 事件管理
    13: 3,    // UI / 其他
  };
  assert.deepEqual(byZone, expected);
  assert.equal(ZONES.length, 13);
});

test('★ ReplayStop 不得出现在函数表中（B-REQ-405 / 陷阱 #6）', () => {
  assert.equal(FN_MAP.has('ReplayStop'), false, 'ReplayStop 不是有效函数，收录它会导致静默失败');
  assert.equal(REPLAY_STOP_IS_NOT_A_FUNCTION.wrong, 'ReplayStop');
  assert.equal(REPLAY_STOP_IS_NOT_A_FUNCTION.correct, 'ReplayStopEvents');
  assert.ok(FN_MAP.has('ReplayStopEvents'), '正确的停止函数必须存在');
});

test('★ None 参数函数必须正好是那 6 个，且都标记 needsChannel（B-REQ-1006 / 陷阱 #18）', () => {
  assert.deepEqual(
    [...NEEDS_CHANNEL].sort(),
    ['ReplayMarkCancel', 'ReplayMarkIn', 'ReplayMarkInLive', 'ReplayMarkInRecorded', 'ReplayMarkInRecordedNow', 'ReplayMarkOut'].sort(),
  );
  // 反向：这 6 个之外不得有 needsChannel
  const unexpected = VMIX_FUNCTIONS.filter((f) => f.needsChannel).map((f) => f.fn).filter((n) => !NEEDS_CHANNEL.includes(n));
  assert.deepEqual(unexpected, []);
});

test('★ 单位必须严格区分秒与帧（陷阱 #19 / B-REQ-526）', () => {
  const secFns = ['ReplayMarkInOut', 'ReplayMarkInOutLive', 'ReplayMarkInOutRecorded', 'ReplayMarkInOutLiveFuture'];
  for (const fn of secFns) assert.equal(FN_MAP.get(fn).unit, 'sec', `${fn} 的 Value 单位是秒`);

  assert.equal(FN_MAP.get('ReplayMoveSelectedInPoint').unit, 'frame', '微调入点的单位是帧');
  assert.equal(FN_MAP.get('ReplayMoveSelectedOutPoint').unit, 'frame', '微调出点的单位是帧');
  assert.equal(FN_MAP.get('ReplayJumpFrames').unit, 'frame-ambig', 'ReplayJumpFrames 单位存疑（R14），须标为待实测');
});

test('★ ReplayMarkInOutLiveFuture 必须标记 future 且带警示（B-REQ-535 / 陷阱 #21）', () => {
  const f = FN_MAP.get('ReplayMarkInOutLiveFuture');
  assert.equal(f.future, true);
  assert.match(f.hint, /不可用于即时上屏/);
});

test('★ 上屏类函数必须与预览类区分（B-REQ-2003）', () => {
  assert.equal(TO_OUTPUT.length, 5, '附录 A.6 实际标注了 5 个 ★ 上屏函数（SRS 正文写 6 个，以函数表为准）');
  for (const fn of TO_OUTPUT) assert.match(fn, /ToOutput$/);
  // 预览对应项必须存在且未被标记为 output
  assert.equal(FN_MAP.get('ReplayPlayLastEvent').target, 'preview');
  assert.equal(FN_MAP.get('ReplayPlayLastEventToOutput').target, 'output');
});

test('★ ReplayLive 必须标记为 dangerous（B-REQ-602 / 陷阱 #4）', () => {
  const f = FN_MAP.get('ReplayLive');
  assert.equal(f.dangerous, true);
  assert.match(f.hint, /禁止/);
  assert.ok(DESTRUCTIVE.includes('ReplayLive'));
});

test('★ 会移动播放头的函数必须可识别，且 ReplayJumpToNow 标为关键（陷阱 #20 / B-REQ-527）', () => {
  assert.deepEqual(
    [...MOVES_PLAYHEAD].sort(),
    ['ReplayJumpToSelectedInPoint', 'ReplayJumpToSelectedOutPoint'].sort(),
  );
  assert.equal(FN_MAP.get('ReplayJumpToNow').critical, true);
});

test('每个函数都必须有中文标签，且参数定义完整', () => {
  for (const f of VMIX_FUNCTIONS) {
    assert.ok(f.label && f.label.length > 0, `${f.fn} 缺少中文标签`);
    assert.ok(ZONES.some((z) => z.id === f.zone), `${f.fn} 的 zone 非法`);
    for (const a of f.args) {
      assert.ok(a.name && a.type, `${f.fn} 的参数定义不完整`);
    }
  }
});

test('catalog（供 /replay 页渲染）结构正确', () => {
  const cat = functionCatalog();
  assert.equal(cat.length, 13);
  const total = cat.reduce((n, z) => n + z.functions.length, 0);
  assert.equal(total, 151);
  const mark = cat.find((z) => z.key === 'mark');
  assert.ok(mark.functions.some((f) => f.fn === 'ReplayMarkInOut' && f.primary));
  const cam = cat.find((z) => z.key === 'camera');
  assert.equal(cam.functions.length, 46, '机位 46 个函数必须完整保留（B-REQ-2001）');
});
