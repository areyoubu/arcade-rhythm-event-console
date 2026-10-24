/**
 * Mock obs-websocket v5 服务端 —— 无 OBS 环境下的验证用。
 *
 * 实现 obs-websocket 的 op 协议（Hello / Identify / Identified / Request / RequestResponse / Event），
 * 支持本项目用到的全部请求，并在切换节目场景时按真实行为派发事件：
 *   SceneTransitionStarted → SceneTransitionEnded（cut point）→ CurrentProgramSceneChanged
 *
 * 用途：
 *   · 验证「事件 + 超时兜底」双保险（B-REQ-1101）：可通过 env 关掉事件派发来强制走超时路径
 *   · 验证转场控制、场景覆盖重读、演播室模式、截图监看
 */
import { WebSocketServer } from 'ws';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';

const PORT = Number(process.env.MOCK_OBS_PORT || 4455);
const PASSWORD = process.env.MOCK_OBS_PASSWORD || '';
/** 设为 0 可关闭转场事件派发，用来验证超时兜底路径（AC-10） */
const EMIT_TRANSITION_EVENTS = process.env.MOCK_OBS_NO_EVENTS !== '1';
/** 转场“耗时”的模拟值（毫秒）—— 事件在此之前派发 SceneTransitionStarted */
const TRANSITION_MS = Number(process.env.MOCK_OBS_TRANSITION_MS || 300);

const scenes = ['CLEAN', 'LIVE', 'REPLAY', '待机', '采访'];
const inputs = ['游戏采集', '选手摄像头', '浮窗-主', 'vMix 回放', 'REPLAY 标识', '浮窗-致谢'];

const state = {
  programScene: 'LIVE',
  previewScene: 'CLEAN',
  studioMode: false,
  currentTransition: 'Cut',
  transitionDuration: 0,
  transitions: [
    { transitionName: 'Cut', transitionKind: 'cut_transition', transitionFixed: true, transitionConfigurable: false },
    { transitionName: 'Fade', transitionKind: 'fade_transition', transitionFixed: false, transitionConfigurable: true, defaultDuration: 300 },
    { transitionName: 'REPLAY-IN', transitionKind: 'obs_stinger_transition', transitionFixed: true, transitionConfigurable: false },
  ],
  overrides: {
    LIVE: { transitionName: null, transitionDuration: null },
    REPLAY: { transitionName: 'REPLAY-IN', transitionDuration: 600 },
    CLEAN: { transitionName: null, transitionDuration: null },
  },
  inputMutes: { 游戏采集: false, 'vMix 回放': true },
};

const requests = [];

function ok(requestId, requestType, responseData = {}) {
  return { op: 7, d: { requestType, requestId, requestStatus: { result: true, code: 100 }, responseData } };
}
function err(requestId, requestType, code = 604, comment = 'Request failed') {
  return { op: 7, d: { requestType, requestId, requestStatus: { result: false, code, comment } } };
}

function handleRequest(type, data, send) {
  // 便于 selftest 断言
  requests.push({ at: Date.now(), requestType: type, requestData: data });
  if (requests.length > 5000) requests.splice(0, requests.length - 5000);

  switch (type) {
    case 'GetVersion':
      return {
        obsVersion: '31.1.2',
        obsWebSocketVersion: '5.5.2',
        rpcVersion: 1,
        platform: 'windows',
        supportedImageFormats: ['jpg', 'jpeg', 'png', 'bmp', 'webp'],
        availableRequests: [],
      };
    case 'GetSceneList':
      return {
        currentProgramSceneName: state.programScene,
        currentPreviewSceneName: state.previewScene,
        scenes: [...scenes].reverse().map((n, i) => ({ sceneName: n, sceneIndex: i })),
      };
    case 'GetInputList':
      return { inputs: inputs.map((n) => ({ inputName: n, inputKind: 'mock' })) };
    case 'GetCurrentProgramScene':
      return { currentProgramSceneName: state.programScene };
    case 'SetCurrentProgramScene': {
      const next = data.sceneName;
      if (!scenes.includes(next)) return { __err: [600, `场景不存在：${next}`] };
      transitionTo(next, send);
      return {};
    }
    case 'SetCurrentPreviewScene':
      if (!state.studioMode) return { __err: [506, '演播室模式未启用'] };
      state.previewScene = data.sceneName;
      send(5, 'CurrentPreviewSceneChanged', { sceneName: state.previewScene });
      return {};
    case 'GetCurrentPreviewScene':
      return { currentPreviewSceneName: state.previewScene };
    case 'GetStudioModeEnabled':
      return { studioModeEnabled: state.studioMode };
    case 'SetStudioModeEnabled':
      state.studioMode = !!data.studioModeEnabled;
      send(5, 'StudioModeStateChanged', { studioModeEnabled: state.studioMode });
      return {};
    case 'TriggerStudioModeTransition': {
      const from = state.programScene;
      state.programScene = state.previewScene;
      state.previewScene = from;
      transitionTo(state.programScene, send);
      return {};
    }
    case 'GetSceneTransitionList':
      return {
        currentSceneTransitionName: state.currentTransition,
        currentSceneTransitionKind: state.transitions.find((t) => t.transitionName === state.currentTransition)?.transitionKind || '',
        transitions: state.transitions,
      };
    case 'GetCurrentSceneTransition': {
      const t = state.transitions.find((x) => x.transitionName === state.currentTransition) || {};
      return {
        transitionName: state.currentTransition,
        transitionKind: t.transitionKind || '',
        transitionFixed: !!t.transitionFixed,
        transitionDuration: state.transitionDuration,
        transitionConfigurable: !!t.transitionConfigurable,
        transitionSettings: {},
      };
    }
    case 'GetTransitionKindList':
      return { transitionKinds: ['cut_transition', 'fade_transition', 'obs_stinger_transition', 'luma_wipe_transition'] };
    case 'SetCurrentSceneTransition':
      if (!state.transitions.some((t) => t.transitionName === data.transitionName)) {
        return { __err: [600, `转场不存在：${data.transitionName}`] };
      }
      state.currentTransition = data.transitionName;
      return {};
    case 'SetCurrentSceneTransitionDuration':
      if (data.transitionDuration < 50 || data.transitionDuration > 20000) {
        return { __err: [402, '转场时长必须在 50–20000ms 之间'] };
      }
      state.transitionDuration = data.transitionDuration;
      return {};
    case 'SetCurrentSceneTransitionSettings':
      return {};
    case 'GetSceneSceneTransitionOverride': {
      const o = state.overrides[data.sceneName] || { transitionName: null, transitionDuration: null };
      return { transitionName: o.transitionName, transitionDuration: o.transitionDuration };
    }
    case 'SetSceneSceneTransitionOverride': {
      const cur = state.overrides[data.sceneName] || { transitionName: null, transitionDuration: null };
      state.overrides[data.sceneName] = {
        transitionName: data.transitionName !== undefined ? data.transitionName : cur.transitionName,
        transitionDuration: data.transitionDuration !== undefined ? data.transitionDuration : cur.transitionDuration,
      };
      // ✅ 真实 obs-websocket **没有** SceneTransitionOverrideChanged 事件 —— mock 也不发
      return {};
    }
    case 'GetInputMute':
      return { inputMuted: !!state.inputMutes[data.inputName] };
    case 'SetInputMute': {
      const before = !!state.inputMutes[data.inputName];
      state.inputMutes[data.inputName] = !!data.inputMuted;
      if (before !== state.inputMutes[data.inputName]) {
        send(5, 'InputMuteStateChanged', { inputName: data.inputName, inputMuted: state.inputMutes[data.inputName] });
      }
      return {};
    }
    case 'ToggleInputMute': {
      const v = !state.inputMutes[data.inputName];
      state.inputMutes[data.inputName] = v;
      send(5, 'InputMuteStateChanged', { inputName: data.inputName, inputMuted: v });
      return { inputMuted: v };
    }
    case 'GetSourceActive':
      return { sourceActive: true };
    case 'GetSourceScreenshot': {
      // 返回一张 1×1 的 JPEG（S-REQ-109 的二进制通道验证够用了）
      const jpeg = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
      return { imageData: `data:image/jpeg;base64,${jpeg}` };
    }
    // ── 结构自检相关（供 /api/checklist 的自动核验路径用）──
    case 'GetSceneItemList': {
      // CLEAN 里只有内容源，**不含浮窗**（G-REQ-104）。浮窗在 LIVE / REPLAY 里。
      const map = {
        CLEAN: ['游戏采集', '选手摄像头'],
        LIVE: ['CLEAN', '浮窗-主'],
        REPLAY: ['vMix 回放', '浮窗-主', 'REPLAY 标识'],
      };
      const names = map[data.sceneName] || [];
      return { sceneItems: names.map((n, i) => ({ sceneItemId: i + 1, sourceName: n, sceneItemEnabled: true, sceneItemIndex: i })) };
    }
    case 'GetInputSettings': {
      if (/^浮窗/.test(data.inputName)) {
        return {
          inputSettings: {
            url: data.inputName === '浮窗-致谢' ? 'http://127.0.0.1:3000/render/credits' : 'http://127.0.0.1:3000/render/main',
            width: 1920,
            height: 1080,
            fps_custom: true,
            fps: 60,
            // G-REQ-204：这两个必须是 false
            shutdown: false,
            restart_when_active: false,
          },
        };
      }
      return { inputSettings: {} };
    }
    case 'SetInputSettings':
      return {};
    case 'GetSourceFilterList': {
      // CLEAN 场景上挂 DistroAV 的 NDI Dedicated Output（G-REQ-103）
      if (data.sourceName === 'CLEAN') {
        return {
          filters: [{
            filterName: 'NDI Dedicated Output',
            filterKind: 'ndi_output_filter',
            filterEnabled: true,
            filterIndex: 0,
            filterSettings: {},
          }],
        };
      }
      return { filters: [] };
    }
    case 'GetSourceFilterKindList':
      return {
        sourceFilterKinds: [
          { sourceFilterKind: 'ndi_output_filter', displayName: 'NDI Dedicated Output' },
          { sourceFilterKind: 'ndi_filter', displayName: 'NDI Output (DistroAV)' },
        ],
      };
    case 'GetSourceFilterKindListLegacy':
      return {};
    case 'GetInputAudioTracks':
      // vMix 回传 NDI 源按 video-only 原则关闭全部音轨
      return { inputAudioTracks: { '1': false, '2': false, '3': false, '4': false, '5': false, '6': false } };
    case 'SetInputAudioTracks':
      return {};
    case 'GetRecordStatus':
      return { outputActive: true, outputTimecode: '00:00:10.000' };
    case 'GetStreamStatus':
      return { outputActive: false };
    case 'GetVirtualCamStatus':
      return { outputActive: false };
    case 'GetGroupList':
      return { groups: [] };
    case 'SetTBarPosition':
      return {};
    default:
      return { __err: [204, `未实现的请求：${type}`] };
  }
}

function transitionTo(nextScene, send) {
  const from = state.programScene;
  if (EMIT_TRANSITION_EVENTS) {
    send(5, 'SceneTransitionStarted', { transitionName: state.currentTransition, sceneName: nextScene });
    // 真实行为：SceneTransitionEnded 代表 **cut point**（遮罩盖满、场景已切换），
    // 在转场进行到一半时派发，**不是**视频播完。
    setTimeout(() => {
      state.programScene = nextScene;
      send(5, 'SceneTransitionEnded', { transitionName: state.currentTransition, sceneName: nextScene });
      send(5, 'CurrentProgramSceneChanged', { sceneName: nextScene });
      if (state.currentTransition === 'REPLAY-IN') {
        setTimeout(() => send(5, 'SceneTransitionVideoEnded', { transitionName: state.currentTransition, sceneName: nextScene }), 200);
      }
    }, Math.max(0, TRANSITION_MS));
  } else {
    // 事件被关掉：直接切场景，不派发任何事件 —— 用来验证超时兜底（AC-10）
    state.programScene = nextScene;
  }
  return from;
}

/**
 * 只在 startMockObs() 里 listen —— 模块加载**不得**有副作用，
 * 否则「import 本文件」与「startMockObs()」会抢同一个端口（EADDRINUSE）。
 */
const wss = new WebSocketServer({ noServer: true });
const httpServer = http.createServer((req, res) => {
  // obs-websocket 是纯 WS 服务；HTTP 层面只回一个说明，方便用浏览器快速确认「端口是通的」
  res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('mock obs-websocket：请用 WebSocket 连接（ws://127.0.0.1:' + PORT + '）');
});
httpServer.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  const send = (op, eventType, eventData) => {
    try { ws.send(JSON.stringify({ op, d: { eventType, eventIntent: 1, eventData } })); } catch { /* ignore */ }
  };

  const hello = {
    op: 0,
    d: { obsWebSocketVersion: '5.5.2', rpcVersion: 1 },
  };
  if (PASSWORD) {
    hello.d.authentication = { challenge: randomUUID().replace(/-/g, ''), salt: randomUUID().replace(/-/g, '').slice(0, 32) };
  }
  ws.send(JSON.stringify(hello));

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.op !== 1) return;

    if (PASSWORD) {
      const secret = createHash('sha256').update(PASSWORD + hello.d.authentication.salt).digest('base64');
      const expected = createHash('sha256').update(secret + hello.d.authentication.challenge).digest('base64');
      if (msg.d.authentication !== expected) {
        ws.close(4009, 'Authentication failed');
        return;
      }
    }
    ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
    ws.authed = true;
  });

  // op 6 = Request
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.op !== 6 || !ws.authed) return;
    const { requestType, requestId, requestData } = msg.d;
    let result;
    try { result = handleRequest(requestType, requestData || {}, send); }
    catch (e) { result = { __err: [999, e.message] }; }

    if (result && result.__err) ws.send(JSON.stringify(err(requestId, requestType, result.__err[0], result.__err[1])));
    else ws.send(JSON.stringify(ok(requestId, requestType, result || {})));
  });
});

export function startMockObs({ port = PORT, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    if (httpServer.listening) {
      return resolve({ port: httpServer.address().port, close: () => closeAll(), state, requests });
    }
    httpServer.listen(port, host, () => {
      resolve({
        port,
        host,
        close: () => closeAll(),
        state,
        requests,
      });
    });
  });
}

function closeAll() {
  return new Promise((resolve) => {
    for (const c of wss.clients) { try { c.close(); } catch { /* ignore */ } }
    httpServer.close(() => resolve());
    setTimeout(resolve, 800).unref?.();
  });
}

// 直接运行本文件时自起
if (process.argv[1]?.endsWith('mock-obs.js')) {
  startMockObs().then(({ port }) => {
    console.log(`[mock-obs] 已启动 ws://127.0.0.1:${port}`);
    console.log(`[mock-obs] 鉴权：${PASSWORD ? '已启用' : '关闭'}｜转场事件：${EMIT_TRANSITION_EVENTS ? '开启' : '关闭（验证超时兜底）'}`);
    console.log(`[mock-obs] 场景：${scenes.join(', ')}`);
  }).catch((e) => {
    console.error(`[mock-obs] 启动失败：${e.message}`);
    console.error('提示：端口被占用时可用 MOCK_OBS_PORT=4466 指定其它端口；或在设置页把 OBS 端口改为该值。');
    process.exit(1);
  });
}

export { state as mockObsState, requests as mockObsRequests };

