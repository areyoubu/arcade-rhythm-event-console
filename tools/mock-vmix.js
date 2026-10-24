/**
 * Mock vMix HTTP API —— 无硬件验证用。
 *
 * 用途：
 *   · 在没有 vMix 的机器上跑通回放宏、状态机、意图对账、错误路径
 *   · selftest 断言「没有调用 ReplayStop」「None 参数函数之前一定先选了通道」
 *   · 为单元测试提供稳定的 XML 样本
 *
 * 行为尽量贴近真实 vMix：
 *   · `GET /api/?Function=X&Param=Y` → 成功 200，出错 500
 *   · `GET /api/`（不带参数）→ 返回整机 XML 状态
 *   · ReplayMarkInOut{Value:N} 建成事件后 live 转 false、duration 设为 N 秒
 *   · ReplayPlayLastEventToOutput 之后 state=Running
 */
import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.MOCK_VMIX_PORT || 8088);
const HOST = process.env.MOCK_VMIX_HOST || '127.0.0.1';

/** 回放会话的模拟状态 */
const st = {
  recording: false,
  live: true,                 // true = Live 直通；false = 正在回放
  state: 'Paused',            // Running | Paused
  channelMode: 'A',
  selectedChannel: 'A',
  position: 0,
  duration: 0,
  events: 0,
  eventsA: 0,
  eventsB: 0,
  speed: 1,
  speedA: 1,
  speedB: 1,
  cameraA: 1,
  cameraB: 1,
  lastEventText: '',
  bufferMs: 60000,            // 模拟的回放缓冲容量（R10 用）
  timecode: '2026-01-01T00:00:00.000',
  timecodeA: '2026-01-01T00:00:00.000',
  timecodeB: '2026-01-01T00:00:00.000',
};

/** 调用日志 —— selftest 直接读它做断言 */
const calls = [];
let positionTimer = null;

function startPositionClock() {
  if (positionTimer) return;
  positionTimer = setInterval(() => {
    if (st.recording && st.live) {
      // 录制中：缓冲区位置持续推进
      st.position += 150;
      if (st.position > st.bufferMs) st.position = st.bufferMs;
    } else if (st.state === 'Running' && !st.live) {
      st.position += Math.round(150 * st.speed);
      if (st.position >= st.duration) {
        st.position = st.duration;
        st.state = 'Paused';      // R13：自然播完 → Running 转 Paused
      }
    }
  }, 150);
  positionTimer.unref?.();
}

function xml() {
  const tc = new Date(Date.now() - (st.recording ? st.position : 0)).toISOString();
  return `<?xml version="1.0" encoding="utf-8"?>
<vmix>
  <version>27.0.0.42</version>
  <edition>Pro</edition>
  <preset>MockPreset</preset>
  <inputs>
    <input key="cam1" number="1" type="Capture" title="游戏采集" state="Running" position="0" duration="0" muted="False" volume="100" />
    <input key="replay1" number="2" type="Replay" title="Mock Replay - A" state="${st.state}" position="${Math.round(st.position)}" duration="${Math.round(st.duration)}">
      <replay live="${st.live ? 'True' : 'False'}" recording="${st.recording ? 'True' : 'False'}"
              channelMode="${st.channelMode}" events="${st.events}" eventsA="${st.eventsA}" eventsB="${st.eventsB}"
              cameraA="${st.cameraA}" cameraB="${st.cameraB}"
              speed="${st.speed}" speedA="${st.speedA}" speedB="${st.speedB}">
        <timecode>${tc}</timecode>
        <timecodeA>${st.timecodeA}</timecodeA>
        <timecodeB>${st.timecodeB}</timecodeB>
      </replay>
    </input>
    <input key="cam2" number="3" type="NDI" title="vMix 回放" state="Running" position="0" duration="0" />
  </inputs>
</vmix>`;
}

/** 执行一个 vMix 函数，返回 { ok, status } */
function exec(fn, params) {
  const V = params.Value !== undefined ? Number(params.Value) : null;
  const ch = params.Channel || st.selectedChannel;

  switch (fn) {
    // ── 录制 ──
    case 'ReplayStartRecording': st.recording = true; st.live = true; return true;
    case 'ReplayStopRecording': st.recording = false; return true;
    case 'ReplayStartStopRecording': st.recording = !st.recording; return true;

    // ── 通道 ──
    case 'ReplaySelectChannelA': st.selectedChannel = 'A'; st.channelMode = 'A'; return true;
    case 'ReplaySelectChannelB': st.selectedChannel = 'B'; st.channelMode = 'B'; return true;
    case 'ReplaySelectChannelAB': st.selectedChannel = 'AB'; st.channelMode = 'A'; return true;
    case 'ReplaySwapChannels': st.channelMode = st.channelMode === 'A' ? 'B' : 'A'; return true;
    case 'ReplaySetChannelAToBTimecode': case 'ReplaySetChannelBToATimecode': return true;

    // ── 事件库 ──
    case 'ReplaySelectAllEvents': return true;
    case 'ReplayScrollSelectedEvent': return true;

    // ── 裁切 ──
    case 'ReplayMarkInOut':
    case 'ReplayMarkInOutLive':
    case 'ReplayMarkInOutRecorded':
    case 'ReplayMarkInOutLiveFuture': {
      if (!st.recording) return { fail: '未在录制' };
      const secs = V || 0;
      if ((secs * 1000) > st.bufferMs) {
        // R10：超出缓冲 → 入点被静默截断
        st.duration = st.bufferMs;
      } else {
        st.duration = secs * 1000;
      }
      st.position = 0;
      st.live = false;                  // ★ 建事件后脱离 Live
      st.state = 'Paused';
      st.events += 1;
      if (st.channelMode === 'B') st.eventsB += 1; else st.eventsA += 1;
      return true;
    }
    case 'ReplayMarkIn': case 'ReplayMarkOut': case 'ReplayMarkInLive':
    case 'ReplayMarkInRecorded': case 'ReplayMarkInRecordedNow':
      // ★ 这些函数**没有** Channel 参数，作用于当前选中通道 —— mock 据此记录
      calls[calls.length - 1].note = `applied to selectedChannel=${st.selectedChannel}`;
      return true;
    case 'ReplayMarkCancel':
      st.duration = 0; st.position = 0;
      calls[calls.length - 1].note = `applied to selectedChannel=${st.selectedChannel}`;
      return true;

    case 'ReplayUpdateSelectedInPoint': st.position = 0; return true;
    case 'ReplayUpdateSelectedOutPoint':
      // R9：延长到当前缓冲位置
      st.duration += Math.max(0, st.position);
      return true;
    case 'ReplayMoveSelectedInPoint': st.duration = Math.max(0, st.duration - (V || 0) * (1000 / 60)); return true;
    case 'ReplayMoveSelectedOutPoint': st.duration = Math.max(0, st.duration + (V || 0) * (1000 / 60)); return true;
    case 'ReplayJumpToSelectedInPoint': st.position = 0; return true;
    case 'ReplayJumpToSelectedOutPoint': st.position = st.duration; return true;

    // ── 播放 ──
    case 'ReplayPlayLastEventToOutput':
    case 'ReplayPlaySelectedEventToOutput':
    case 'ReplayPlayEventToOutput':
    case 'ReplayPlayAllEventsToOutput':
    case 'ReplayPlayEventsByIDToOutput':
      st.live = false; st.state = 'Running'; st.position = 0; return true;
    case 'ReplayPlay': st.state = 'Running'; return true;
    case 'ReplayPause': st.state = 'Paused'; return true;
    case 'ReplayPlayPause': st.state = st.state === 'Running' ? 'Paused' : 'Running'; return true;
    case 'ReplayStopEvents': st.state = 'Paused'; st.position = 0; return true;
    case 'ReplayPlayForward': st.state = 'Running'; st.speed = Math.abs(st.speed); return true;
    case 'ReplayPlayBackward': st.state = 'Running'; st.speed = -Math.abs(st.speed); return true;
    case 'ReplayPlayPrevious': case 'ReplayPlayNext': return true;

    // ── 速度 / 方向 ──
    case 'ReplaySetSpeed': case 'ReplayChangeSpeed': case 'ReplayUpdateSelectedSpeedFromValue':
      st.speed = V ?? 1; st.speedA = st.speed; st.speedB = st.speed; return true;
    case 'ReplayFastForward': case 'ReplayFastBackward': return true;
    case 'ReplaySetDirectionForward': st.speed = Math.abs(st.speed); return true;
    case 'ReplaySetDirectionBackward': st.speed = -Math.abs(st.speed); return true;
    case 'ReplayChangeDirection': st.speed = -st.speed; return true;
    case 'ReplayUpdateSelectedSpeed': case 'ReplayUpdateSelectedSpeedDefault': return true;

    // ── 逐帧 / 时间码 ──
    case 'ReplayJumpFrames': st.position = Math.max(0, st.position + (V || 0)); return true;
    case 'ReplayJumpFramesFastOn': case 'ReplayJumpFramesFastOff': return true;
    case 'ReplayJumpToNow': st.position = st.duration; st.live = true; return true;
    case 'ReplaySetTimecode': st.position = 0; return true;

    // ── Live / 回放模式 ──
    case 'ReplayLive': st.live = true; st.state = 'Paused'; return true;
    case 'ReplayLiveToggle': st.live = !st.live; return true;
    case 'ReplayRecorded': st.live = false; return true;

    // ── 文字 ──
    case 'ReplaySetLastEventText': case 'ReplaySetSelectedEventText':
      st.lastEventText = String(params.Value || ''); return true;
    case 'ReplaySetLastEventTextCamera': case 'ReplaySetSelectedEventTextCamera': return true;

    // ── 事件管理 ──
    case 'ReplayCopyLastEvent': case 'ReplayCopySelectedEvent':
    case 'ReplayDuplicateLastEvent': case 'ReplayDuplicateSelectedEvent':
      st.events += 1; return true;
    case 'ReplayMoveLastEvent': case 'ReplayMoveSelectedEvent':
    case 'ReplayMoveSelectedEventUp': case 'ReplayMoveSelectedEventDown': return true;
    case 'ReplayDeleteLastEvent': case 'ReplayDeleteSelectedEvent':
      st.events = Math.max(0, st.events - 1); return true;
    case 'ReplayExportLastEvent': return true;

    // ── 事件选择 ──
    case 'ReplaySelectFirstEvent': case 'ReplaySelectLastEvent':
    case 'ReplaySelectNextEvent': case 'ReplaySelectPreviousEvent': return true;

    // ── 机位 ──
    default:
      if (/^Replay(Toggle)?(A|B)?(Last|Selected)?(Event)?Camera\d$/.test(fn)
        || /^Replay(Camera|ACamera|BCamera)\d$/.test(fn)
        || fn === 'ReplayLastEventCameraOn' || fn === 'ReplayLastEventCameraOff'
        || fn === 'ReplayLastEventSingleCameraOn' || fn === 'ReplaySelectedEventCameraOn'
        || fn === 'ReplaySelectedEventCameraOff' || fn === 'ReplaySelectedEventSingleCameraOn') {
        return true;
      }
      if (/^ReplaySelectEvents([1-9]|1\d|20)$/.test(fn)) return true;
      if (fn === 'Replay' || fn === 'ReplayShowHide' || fn === 'ReplaySetAudioSource') return true;
      return { unknown: true };
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  res.setHeader('Access-Control-Allow-Origin', '*');

  // ── 测试辅助端点（真实 vMix 没有这些；仅 mock 提供）──
  if (url.pathname === '/__mock/calls') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, calls, state: st }));
  }
  if (url.pathname === '/__mock/reset') {
    calls.length = 0;
    Object.assign(st, {
      recording: false, live: true, state: 'Paused', channelMode: 'A', selectedChannel: 'A',
      position: 0, duration: 0, events: 0, eventsA: 0, eventsB: 0, speed: 1, lastEventText: '',
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (url.pathname !== '/api/' && url.pathname !== '/api') {
    res.writeHead(404); return res.end('not found');
  }

  const fn = url.searchParams.get('Function');

  // 不带参数 = 状态查询（心跳与轮询都用这个）
  if (!fn) {
    res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
    return res.end(xml());
  }

  const params = {};
  for (const [k, v] of url.searchParams) if (k !== 'Function') params[k] = v;

  const rec = { at: Date.now(), fn, params };
  calls.push(rec);
  if (calls.length > 5000) calls.splice(0, calls.length - 5000);

  const result = exec(fn, params);
  if (result === true) { res.writeHead(200); return res.end('OK'); }
  if (result && result.unknown) {
    rec.error = 'unknown function';
    res.writeHead(500); return res.end(`Function ${fn} not found`);
  }
  rec.error = result?.fail || 'error';
  res.writeHead(500); return res.end(result?.fail || 'Error');
});

export function startMockVmix({ port = PORT, host = HOST } = {}) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      startPositionClock();
      resolve({ port, host, close: () => new Promise((r) => server.close(r)), state: st, calls });
    });
  });
}

// 直接运行时自起
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('mock-vmix.js')) {
  startMockVmix().then(({ port }) => {
    console.log(`[mock-vmix] 已启动 http://127.0.0.1:${port}/api/`);
    console.log(`[mock-vmix] 调用日志： http://127.0.0.1:${port}/__mock/calls`);
  }).catch((e) => {
    console.error(`[mock-vmix] 启动失败：${e.message}`);
    console.error('提示：端口被占用时可用 MOCK_VMIX_PORT=8098 指定其它端口；或在设置页把 vMix 端口改为该值。');
    process.exit(1);
  });
}

export { st as mockState, calls as mockCalls, xml as buildXml };
