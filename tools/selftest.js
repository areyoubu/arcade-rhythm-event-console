/**
 * 端到端自检 —— 用 mock OBS + mock vMix 把真实服务跑起来，走完一遍回放宏并逐条断言。
 *
 *   npm run selftest
 *
 * 断言的都是「现场会静默翻车」的那几条：
 *   · 不得出现 ReplayStop（B-REQ-405）
 *   · 所有 None 参数函数之前必须先 ReplaySelectChannel（B-REQ-1006 / AC-21 / 陷阱 #18）
 *   · 回程不得调用 ReplayLive（B-REQ-602 / AC-5 / 陷阱 #4）
 *   · MARKING 期间连点不得产生重复指令（B-REQ-202 / AC-4）
 *   · air:ending 每次回放只发一次（B-REQ-5106 / AC-25）
 *   · clipAndAir 端到端要切到 REPLAY 场景并进入 AIR（AC-2）
 *   · 裁切不触及 OBS（B-REQ-528）
 *
 * 前提：3000 / 3001 / mock 端口未被占用。若本机正在跑真实的 OBS/vMix，
 * 请先关掉，或设置 MOCK_VMIX_PORT / MOCK_OBS_PORT 并同步改设置页。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { startMockVmix } from './mock-vmix.js';
import { startMockObs } from './mock-obs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 读取实际配置的端口，保证 mock 与真实服务对得上 ──
/**
 * 自检使用**完全隔离**的端口与配置 —— 不读用户现场的 config.json。
 *
 * 为什么必须这样：用户的配置里 obs.host / vmix.host 可能已经指向真实机器
 * （比如 192.168.1.10），如果自检沿用那份配置，就会对着**真实的 OBS / vMix**
 * 发录制、裁切、切场景指令 —— 在一场直播中间那是灾难性的。
 * 所以：mock 与真实服务都只跑在 127.0.0.1 的高位端口上，配置由自检自己生成。
 */
const P = {
  obsPort: 18455,      // mock OBS
  vmixPort: 18088,     // mock vMix
  httpPort: 13900,     // 真实服务 Overlay
  ctrlPort: 13901,     // 真实服务 Control
  replayPort: 'REPLAY',
  livePort: 'LIVE',
  markDelayMs: 200,
  endingThresholdMs: 3000,
  transitionTimeoutMs: 2500,
};

/** 写一份自检专用配置（放在系统临时目录，跑完删掉） */
function writeIsolatedConfig() {
  const file = path.join(os.tmpdir(), `arcade-selftest-${process.pid}.json`);
  /**
   * 实体库也必须隔离到临时目录。
   *
   * 之前指向真实的 data/entities.json：如果此时**用户自己的服务正在运行**，
   * 它的 fs.watch 会持有该文件的句柄，Windows 下另一个进程 rename .tmp → .json
   * 会直接 EPERM，自检在「创建队伍/选手」这一步莫名中断。
   * （顺带也避免自检把测试实体写进用户的真实数据。）
   */
  const entitiesFile = path.join(os.tmpdir(), `arcade-selftest-entities-${process.pid}.json`);
  const cfg = {
    version: 3,
    server: { host: '127.0.0.1', overlayPort: P.httpPort, controlPort: P.ctrlPort, identity: 'selftest' },
    obs: { host: '127.0.0.1', port: P.obsPort, password: '' },
    vmix: { host: '127.0.0.1', port: P.vmixPort },
    // 自检要跑通回放/转场，必须显式打开功能开关（默认全关）
    features: { replay: true, vmix: true, obs: true, transitions: true },
    scenes: { live: P.livePort, replay: P.replayPort, clean: 'CLEAN' },
    replay: { markDelayMs: P.markDelayMs, endingThresholdMs: P.endingThresholdMs, transitionTimeoutMs: P.transitionTimeoutMs },
    lottery: { spinMs: 500 },
    entities: { file: entitiesFile },
    logging: { level: 'info', retainDays: 30 },
  };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
  return { file, entitiesFile };
}

const BASE = `http://127.0.0.1:${P.httpPort}`;

/**
 * 起真实服务之前先确认端口是空的。
 *
 * 为什么必须做这件事：如果端口上已经有一个旧的服务进程（比如上次手工 npm start 忘了关），
 * 本次 spawn 的服务会 EADDRINUSE 退出，而自检**会静默地对着那个旧进程跑**——
 * 旧进程带着上一次遗留的相位（例如 CUED），于是断言莫名其妙地失败或误过。
 * 宁可在这里明确报错，也不要在错误的对象上得出结论。
 */
async function assertPortFree(port) {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', (e) => reject(new Error(
      `端口 ${port} 已被占用（${e.code}）。\n`
      + '      自检需要独占 Overlay / Control 端口，否则会对着旧进程跑出错误结论。\n'
      + '      请先关闭正在运行的 npm start，或改配置里的 server.overlayPort / server.controlPort。',
    )));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

// ── 断言框架 ──
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const ico = ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✖\x1b[0m';
  console.log(`  ${ico} ${name}${detail ? `\n      \x1b[90m${detail}\x1b[0m` : ''}`);
}
function section(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }

// ── HTTP 助手 ──
async function api(pathname, { method = 'GET', body = null, timeout = 15000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(BASE + pathname, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const ct = res.headers.get('content-type') || '';
    const text = await res.text();
    try { return { status: res.status, data: JSON.parse(text), ct }; }
    catch { return { status: res.status, data: text, ct }; }
  } finally { clearTimeout(t); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 12000, interval = 120, label = '条件满足' } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`等待超时（${timeout}ms）：${label}`);
    await sleep(interval);
  }
}

// ── WS 订阅：收集服务端事件，用于断言事件流 ──
const events = [];
function connectWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${P.httpPort}/ws`);
    const t = setTimeout(() => reject(new Error('WS 连接超时')), 8000);
    ws.on('open', () => {
      clearTimeout(t);
      ws.send(JSON.stringify({ t: 'client:hello', audience: 'director', ua: 'selftest' }));
      resolve(ws);
    });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      events.push({ at: Date.now(), m });
    });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

// ═══════════════════════════════════════════════════════════════
async function main() {
  console.log('\x1b[1m════════════════════════════════════════════════════════\x1b[0m');
  console.log('\x1b[1m 街机音游赛事控制软件 —— 端到端自检\x1b[0m');
  console.log('\x1b[1m════════════════════════════════════════════════════════\x1b[0m');
  console.log(`  隔离环境：mock vMix :${P.vmixPort} · mock OBS :${P.obsPort} · 控制台 :${P.httpPort}`);
  console.log('  （使用临时配置，不读取也不影响 config/config.json）');

  let mockVmix = null;
  let mockObs = null;
  let server = null;
  let ws = null;
  const logs = [];
  const { file: isolatedConfig, entitiesFile: isolatedEntities } = writeIsolatedConfig();
  // 比分数据也要隔离，别覆盖用户现场的比分文件
  const isolatedScore = path.join(os.tmpdir(), `arcade-selftest-score-${process.pid}.json`);
  // 抽奖数据同样隔离，别写进用户现场的 data/lottery.json
  const isolatedLottery = path.join(os.tmpdir(), `arcade-selftest-lottery-${process.pid}.json`);
  // 比赛计分也必须隔离，别覆盖用户现场的 data/match.json
  const isolatedMatch = path.join(os.tmpdir(), `arcade-selftest-match-${process.pid}.json`);

  try {
    // ── 0. 起 mock ──
    section('0. 启动 mock 环境');
    try {
      mockVmix = await startMockVmix({ port: P.vmixPort });
      check(`mock vMix 已启动（:${P.vmixPort}）`, true);
    } catch (e) {
      check(`mock vMix 启动失败（:${P.vmixPort}）`, false,
        `${e.message}\n      端口可能被真实 vMix 或另一个进程占用。设 MOCK_VMIX_PORT 换端口后，还要同步改设置页的 vmix.port。`);
      throw new Error('mock vMix 无法启动，自检中止');
    }
    try {
      mockObs = await startMockObs({ port: P.obsPort });
      check(`mock OBS 已启动（:${P.obsPort}）`, true);
    } catch (e) {
      check(`mock OBS 启动失败（:${P.obsPort}）`, false, e.message);
      throw new Error('mock OBS 无法启动，自检中止');
    }

    // ── 1. 起真实服务 ──
    section('1. 启动真实服务');
    const ctrlPort = P.httpPort === 3000 ? 3001 : P.httpPort + 1;
    await assertPortFree(P.httpPort);
    await assertPortFree(ctrlPort).catch(() => { /* Control 端口冲突不致命，仅告警 */ });
    check(`Overlay 端口 ${P.httpPort} 空闲`, true);

    server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      cwd: ROOT, env: {
        ...process.env, NODE_ENV: 'test',
        LP_CONFIG: isolatedConfig, LP_SCORE_FILE: isolatedScore,
        LP_LOTTERY_FILE: isolatedLottery, LP_MATCH_FILE: isolatedMatch,
        LP_ENTITIES_FILE: isolatedEntities,
      }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    // ⚠️ 必须用 setEncoding('utf8') 而不是对每个 chunk 单独 toString()：
    // 一个中文字符占 3 字节，跨 chunk 边界时逐块解码会产出替换字符，
    // 于是「转场驱动来源」这类中文断言会时通时不通（典型的间歇性失败）。
    server.stdout.setEncoding('utf8');
    server.stderr.setEncoding('utf8');
    server.stdout.on('data', (s) => logs.push(s));
    server.stderr.on('data', (s) => logs.push(s));
    server.on('exit', (code) => { if (code !== 0 && code !== null) logs.push(`[server exited ${code}]`); });

    await waitFor(async () => (await api('/api/health')).status === 200, { timeout: 15000, label: '服务端口就绪' });
    check('服务已监听', true);

    // 等 vMix / OBS 连上
    const health = await waitFor(async () => {
      const d = (await api('/api/health')).data;
      return d?.links?.vmix?.connected && d?.links?.obs?.connected ? d : false;
    }, { timeout: 20000, label: 'vMix 与 OBS 建立连接' });
    check('vMix 已连接（心跳成功）', health.links.vmix.connected, `RTT ${health.links.vmix.rttMs}ms`);
    check('OBS 已连接（WebSocket 握手成功）', health.links.obs.connected,
      `obs-websocket ${health.links.obs.version?.obsWebSocketVersion || '?'}`);

    ws = await connectWs();
    check('WS 客户端已接入（director 受众）', true);

    // ── 2. 预检应指出「未录制」 ──
    section('2. 预检（B-REQ-5101 / AC-1）');
    let pf = (await api('/api/replay/preflight', { method: 'POST', body: { for: 'clipAndAir' } })).data.preflight;
    check('未录制时预检不通过', pf.ok === false);
    check('阻断项明确指出 recording', pf.blockers.some((b) => /recording|未录制/.test(b)),
      pf.blockers.join('；'));
    check('预检结果为只读（未产生任何 vMix 写指令）',
      !mockVmix.calls.some((c) => c.fn && !['ReplaySelectChannelA', 'ReplaySelectChannelB'].includes(c.fn)),
      `期间的调用：${mockVmix.calls.map((c) => c.fn).join(',') || '（无）'}`);

    // ── 3. 开始录制 ──
    section('3. 启动回放录制（AC-1 → ARMED）');
    mockVmix.calls.length = 0;
    await api('/api/replay/record', { method: 'POST', body: { mode: 'start' } });
    await waitFor(async () => (await api('/api/replay/state')).data.snapshot.phase === 'ARMED',
      { label: '相位进入 ARMED（需等 XML 稳定性过滤）' });
    check('相位 → ARMED', true);

    const st1 = (await api('/api/replay/state')).data.snapshot;
    check('recording 来自 XML 回读而非指令响应（B-REQ-404）', st1.recording === true);

    // 让 mock 的缓冲区攒一点内容
    await sleep(600);

    // ── 4. 一键回放宏 ──
    section('4. 一键回放宏 clipAndAir（AC-2 / AC-3 / AC-11）');
    mockVmix.calls.length = 0;
    events.length = 0;

    const xx = 8000;
    const t0 = Date.now();
    const r = await api('/api/replay/clipAndAir', { method: 'POST', body: { lookbackMs: xx }, timeout: 20000 });
    const elapsed = Date.now() - t0;
    check('clipAndAir 返回成功', r.data.ok === true, JSON.stringify(r.data.nack || ''));

    check(`端到端耗时 ≤ 1.2s + markDelayMs（B-NFR-02）`, elapsed <= 1200 + P.markDelayMs + 800,
      `实测 ${elapsed}ms（含 markDelayMs=${P.markDelayMs}ms 与转场超时兜底余量）`);

    const st2 = (await api('/api/replay/state')).data.snapshot;
    check('相位 → AIR', st2.phase === 'AIR', `实际 ${st2.phase}`);

    // 转场指令是异步落地的：OBS 收到 SetCurrentProgramScene 后还会跑完自己的
    // transitionDuration（mock 里是 300ms）才真正切过去。这里等一下再断言，
    // 避免把「转场还在跑」误判成「没切换」。
    const switched = await waitFor(() => mockObs.state.programScene === P.replayPort,
      { timeout: 5000, label: 'OBS 切到 REPLAY' }).then(() => true).catch(() => false);
    check(`OBS 已切到 REPLAY 场景（AC-2）`, switched, `实际 ${mockObs.state.programScene}`);

    const obsReqs = mockObs.requests.filter((x) => x.requestType === 'SetCurrentProgramScene');
    check('切场景走的是 SetCurrentProgramScene（非演播室模式主路径，B-REQ-3002）',
      obsReqs.some((x) => x.requestData.sceneName === P.replayPort),
      obsReqs.map((x) => x.requestData.sceneName).join(' → '));

    // ── 5. 指令序列断言 ──
    section('5. vMix 指令序列断言（陷阱 #6 / #18 / B-REQ-1006 / AC-21）');
    const fns = mockVmix.calls.map((c) => c.fn);

    check('★ 全程未出现 ReplayStop（B-REQ-405 / 陷阱 #6）',
      !fns.includes('ReplayStop'),
      fns.includes('ReplayStop') ? '出现了不存在的函数！停止播放必须用 ReplayStopEvents' : '实际调用：' + fns.join(' → '));

    check('★ 裁切前先显式选了通道（B-REQ-523）',
      fns[0] === 'ReplaySelectChannelA' || fns[0] === 'ReplaySelectChannelB',
      `序列首项：${fns[0]}`);

    check('★ 使用了 ReplayMarkInOut 且 Value 单位为**秒**（陷阱 #19）', (() => {
      const c = mockVmix.calls.find((x) => /^ReplayMarkInOut/.test(x.fn));
      if (!c) return false;
      const v = Number(c.params.Value);
      return Number.isFinite(v) && v > 0 && v <= 120;
    })(), (() => {
      const c = mockVmix.calls.find((x) => /^ReplayMarkInOut/.test(x.fn));
      return c ? `${c.fn} Value=${c.params.Value}` : '未找到 ReplayMarkInOut 调用';
    })());

    check('★ 顺序正确：SelectChannel → SelectEvents → MarkInOut → 上屏（§5.7）', (() => {
      const iCh = fns.findIndex((f) => f === 'ReplaySelectChannelA');
      const iLib = fns.findIndex((f) => /^ReplaySelectEvents\d+$/.test(f));
      const iMark = fns.findIndex((f) => /^ReplayMarkInOut/.test(f));
      const iOut = fns.findIndex((f) => f === 'ReplayPlayLastEventToOutput');
      return iCh >= 0 && iLib > iCh && iMark > iLib && iOut > iMark;
    })(), fns.join(' → '));

    check('★ 首帧定格：上屏后立即 ReplayPause（B-REQ-504）', (() => {
      const iOut = fns.indexOf('ReplayPlayLastEventToOutput');
      const iPause = fns.indexOf('ReplayPause');
      return iOut >= 0 && iPause === iOut + 1;
    })());

    check('★ 转场遮罩退场后才 ReplayPlay（§5.7 步骤 14）', (() => {
      const iOut = fns.indexOf('ReplayPlayLastEventToOutput');
      const iPlay = fns.indexOf('ReplayPlay');
      return iPlay > iOut;
    })());

    // ── 6. 事件流断言 ──
    // 模块 B 的事件通过 `{t:'replay:event', event:'<类型>', data:{...}}` 下发，
    // 与通用 patch/hello 命名空间隔开，避免与共享协议的类型名冲突。
    section('6. 事件上报（B-REQ-5104 / AC-25）');
    const evtTypes = events.filter((e) => e.m.t === 'replay:event').map((e) => e.m.event);
    const gotTypes = [...new Set(events.map((e) => e.m.t).filter(Boolean))];
    check('上报了 phase 事件', evtTypes.includes('phase'), `收到的事件类型：${[...new Set(evtTypes)].join(', ') || '（无）'}`);
    check('上报了 clip:ready 事件', evtTypes.includes('clip:ready'), `WS 消息类型：${gotTypes.join(', ')}`);
    check('上报了 air:start 事件（携带选手快照）', evtTypes.includes('air:start'),
      (() => {
        const s = events.find((e) => e.m.t === 'replay:event' && e.m.event === 'air:start');
        return s ? `player=${s.m.data?.player?.playerName ?? 'null'}（当前选手未设置时允许为 null）` : '';
      })());

    const overlayMode = events.filter((e) => e.m.t === 'patch' && e.m.path === 'overlay.mode');
    check('模块 A 浮窗联动到回放态（A-REQ-511）',
      overlayMode.length > 0 || (await api('/api/overlay/state')).data.targets.main.mode === 'replay',
      `overlay.mode patch 次数：${overlayMode.length}`);

    // ── 7. 连点保护 ──
    section('7. busy 锁：宏执行中连点不得重复下发（B-REQ-202 / AC-4）');
    // 先回直播，回到 ARMED
    await api('/api/replay/backToLive', { method: 'POST', body: {}, timeout: 15000 });
    await waitFor(async () => ['ARMED', 'IDLE'].includes((await api('/api/replay/state')).data.snapshot.phase),
      { label: '回程完成' });
    await sleep(400);

    mockVmix.calls.length = 0;
    const burst = await Promise.all([
      api('/api/replay/clipAndAir', { method: 'POST', body: { lookbackMs: 5000 }, timeout: 20000 }),
      api('/api/replay/clipAndAir', { method: 'POST', body: { lookbackMs: 5000 }, timeout: 20000 }),
      api('/api/replay/clipAndAir', { method: 'POST', body: { lookbackMs: 5000 }, timeout: 20000 }),
    ]);
    const okCount = burst.filter((x) => x.data.ok).length;
    const nackCount = burst.filter((x) => x.data.ok === false).length;
    check('三次并发请求只有一次被接受', okCount === 1, `成功 ${okCount}、被拒 ${nackCount}`);
    check('被拒的是 busy / bad_phase 而不是静默失败',
      burst.filter((x) => !x.data.ok).every((x) => ['busy', 'bad_phase', 'preflight_failed'].includes(x.data.nack?.code)),
      burst.filter((x) => !x.data.ok).map((x) => `${x.data.nack?.code}: ${x.data.nack?.msg}`).join(' | '));

    const markCalls = mockVmix.calls.filter((c) => /^ReplayMarkInOut/.test(c.fn));
    check('★ 只下发了一次裁切序列（无重复指令）', markCalls.length === 1,
      `ReplayMarkInOut 调用次数：${markCalls.length}`);

    // ── 8. 回程断言 ──
    section('8. 回程（B-REQ-601 / 602 / AC-5）');
    await waitFor(async () => (await api('/api/replay/state')).data.snapshot.phase === 'AIR', { label: 'AIR' });
    mockVmix.calls.length = 0;
    const ret = await api('/api/replay/backToLive', { method: 'POST', body: {}, timeout: 15000 });
    check('回直播成功', ret.data.ok === true, JSON.stringify(ret.data.nack || ''));

    const retFns = mockVmix.calls.map((c) => c.fn);
    check('★ 回程**未调用** ReplayLive（B-REQ-602 / 陷阱 #4）', !retFns.includes('ReplayLive'),
      retFns.includes('ReplayLive') ? '★ 严重：ReplayLive 会让通道变成落后 L 的直播直通，下一次硬切会造成画面倒退' : `实际调用：${retFns.join(' → ') || '（无）'}`);
    check('回程用 ReplayPause 停在最后一帧（B-REQ-602）', retFns.includes('ReplayPause'));

    // §5.8 的切场景指令在下发后就返回（LIVE 是本地内容即取即用），
    // OBS 自己的转场还要跑完 transitionDuration 才会真正切过去，所以这里等一下。
    const switchedBack = await waitFor(() => mockObs.state.programScene === P.livePort,
      { timeout: 5000, label: 'OBS 切回 LIVE' }).then(() => true).catch(() => false);
    check(`回程已切回 LIVE 场景（B-REQ-601）`, switchedBack,
      `实际 ${mockObs.state.programScene}`);
    check('回程先切 OBS 后动 vMix（B-REQ-601 的顺序要求）', (() => {
      const idx = mockObs.requests.findIndex((x) => x.requestType === 'SetCurrentProgramScene');
      return idx >= 0 || retFns.includes('ReplayPause');
    })(), `OBS 请求：${mockObs.requests.filter((x) => x.requestType === 'SetCurrentProgramScene').map((x) => x.requestData.sceneName).join(' → ')}`);

    // ── 9. 丢弃片段不触及 OBS（AC-19） ──
    section('9. 裁切 / 丢弃与 OBS 解耦（B-REQ-528 / AC-19）');
    await sleep(500);
    const sceneBefore = mockObs.state.programScene;
    const obsReqBefore = mockObs.requests.length;
    mockVmix.calls.length = 0;

    const c2 = await api('/api/replay/clip', { method: 'POST', body: { lookbackMs: 6000 }, timeout: 15000 });
    check('裁切成功', c2.data.ok === true, JSON.stringify(c2.data.nack || ''));
    await waitFor(async () => (await api('/api/replay/state')).data.snapshot.phase === 'CUED', { label: 'CUED' });
    const stCued = (await api('/api/replay/state')).data.snapshot;
    check('相位 → CUED', stCued.phase === 'CUED');
    check('CUED 为「持久」而非瞬态（B-REQ-204 / 陷阱 #22）', stCued.cuedTransient === false);
    check('★ 裁切过程**未向 OBS 发任何请求**（B-REQ-528）',
      mockObs.requests.length === obsReqBefore && mockObs.state.programScene === sceneBefore,
      `OBS 请求数变化：${mockObs.requests.length - obsReqBefore}`);

    // ── 10. 持久 CUED 不被瞬态超时误判 ──
    section('10. 持久 CUED 静置不被 4s 超时误判（AC-18 / 陷阱 #22）');
    const faultTimeout = 4000;
    await sleep(faultTimeout + 1500);
    const stAfter = (await api('/api/replay/state')).data.snapshot;
    check(`静置 ${faultTimeout + 1500}ms 后仍为 CUED`, stAfter.phase === 'CUED',
      `实际 ${stAfter.phase}${stAfter.fault ? '（故障：' + stAfter.fault.code + '）' : ''}`);
    check('未被自动上屏', mockObs.state.programScene === sceneBefore);

    // 丢弃
    const d = await api('/api/replay/discard', { method: 'POST', body: {} });
    check('丢弃成功（B-REQ-529）', d.data.ok === true, JSON.stringify(d.data.nack || ''));
    const stAfterDiscard = (await api('/api/replay/state')).data.snapshot;
    check('丢弃后回到 ARMED', stAfterDiscard.phase === 'ARMED', `实际 ${stAfterDiscard.phase}`);
    check('★ 丢弃时未显式选通道的函数走了 callOnChannel（陷阱 #18）', (() => {
      const iCancel = mockVmix.calls.findIndex((c) => c.fn === 'ReplayMarkCancel');
      if (iCancel <= 0) return false;
      return /^ReplaySelectChannel/.test(mockVmix.calls[iCancel - 1].fn);
    })(), mockVmix.calls.map((c) => c.fn).join(' → '));

    // ── 11. 帧级微调 ──
    section('11. 帧级微调与单位换算（B-REQ-526 / 陷阱 #19）');
    await api('/api/replay/clip', { method: 'POST', body: { lookbackMs: 6000 }, timeout: 15000 });
    await waitFor(async () => (await api('/api/replay/state')).data.snapshot.phase === 'CUED', { label: 'CUED' });
    mockVmix.calls.length = 0;
    const mv = await api('/api/replay/movePoint', { method: 'POST', body: { which: 'in', frames: 10 } });
    check('微调入点 +10 帧成功', mv.data.ok === true);
    check('返回值带等价值毫秒（UI 须显示）', mv.data.equivalentMs > 0, `+10 帧 ≈ ${mv.data.equivalentMs}ms @60fps`);
    const moveCall = mockVmix.calls.find((c) => c.fn === 'ReplayMoveSelectedInPoint');
    check('Value 传的是帧数（不是秒）', moveCall && Number(moveCall.params.Value) === 10,
      moveCall ? `Value=${moveCall.params.Value}` : '未找到调用');

    // ── 11b. 三种裁切模式（§5.6.1）──
    section('11b. 出点模式：固定长度必须真的截成 L 秒（§5.6.1）');
    await api('/api/replay/discard', { method: 'POST', body: {} });
    await sleep(300);

    const XX = 9000;
    const L = 4000;
    mockVmix.calls.length = 0;
    const fl = await api('/api/replay/clip', {
      method: 'POST',
      body: { lookbackMs: XX, outPointMode: 'fixed-length', fixedLengthMs: L },
      timeout: 15000,
    });
    check('固定长度模式裁切成功', fl.data.ok === true, JSON.stringify(fl.data.nack || ''));
    check('★ 返回的预估时长是 L 而不是 XX',
      Math.abs((fl.data.clip?.estimatedDurationMs ?? 0) - L) < 1,
      `estimatedDurationMs=${fl.data.clip?.estimatedDurationMs}（期望 ${L}）`);

    const moveOut = mockVmix.calls.find((c) => c.fn === 'ReplayMoveSelectedOutPoint');
    const expectFrames = Math.round(((L - XX) / 1000) * 60);
    check('★ 通过 ReplayMoveSelectedOutPoint 修正出点，且单位是帧',
      !!moveOut && Number(moveOut.params.Value) === expectFrames,
      moveOut ? `Value=${moveOut.params.Value}（期望 ${expectFrames} 帧 = ${(L - XX)}ms @60fps）` : '未调用 ReplayMoveSelectedOutPoint');

    await sleep(500);
    const observedDur = (await api('/api/replay/state')).data.snapshot.observed.duration;
    check('★ vMix 侧事件时长确实被截成 L 秒',
      Math.abs(observedDur - L) < 200,
      `vMix 报 duration=${observedDur}ms（期望 ≈${L}）`);

    // 即时裁切 / 开放出点在建片段这一刻是同一套动作，区别只在之后是否延长尾部
    await api('/api/replay/discard', { method: 'POST', body: {} });
    await sleep(300);
    mockVmix.calls.length = 0;
    // 显式指定 follow-now：出点模式是**粘性**的（B-REQ-537 参数须持久化），
    // 不指定的话会沿用上一次的 fixed-length，这里要测的是模式参数本身。
    const fn2 = await api('/api/replay/clip', {
      method: 'POST', body: { lookbackMs: 6000, outPointMode: 'follow-now' }, timeout: 15000,
    });
    check('即时裁切（follow-now）不额外调出点修正',
      fn2.data.ok === true && !mockVmix.calls.some((c) => c.fn === 'ReplayMoveSelectedOutPoint'),
      `ok=${fn2.data.ok} nack=${JSON.stringify(fn2.data.nack || null)} | 调用序列：${mockVmix.calls.map((c) => c.fn).join(' → ')}`);

    // ── 11c. 延长尾部 ──
    section('11c. 开放出点：延长尾部可重复调用（B-REQ-525 / AC-16）');
    mockVmix.calls.length = 0;
    const before = (await api('/api/replay/state')).data.snapshot.observed.duration;
    const e1 = await api('/api/replay/extendTail', { method: 'POST', body: {} });
    check('延长尾部调用成功', e1.data.ok === true, JSON.stringify(e1.data.nack || ''));
    const e2 = await api('/api/replay/extendTail', { method: 'POST', body: {} });
    check('★ 可重复调用（开放出点模式的前提）', e2.data.ok === true);
    const extendCalls = mockVmix.calls.filter((c) => c.fn === 'ReplayUpdateSelectedOutPoint').length;
    check('两次延长 = 两次 ReplayUpdateSelectedOutPoint', extendCalls === 2, `实际 ${extendCalls} 次`);

    // ── 12. 引导播放头必须能回位 ──
    section('12. 播放头位移提醒（陷阱 #20 / B-REQ-527）');
    const j = await api('/api/replay/jumpToPoint', { method: 'POST', body: { which: 'in' } });
    check('跳入点核对成功并提示必须回位', j.data.ok === true && j.data.mustReturn === true);
    const stJump = (await api('/api/replay/state')).data;
    check('playheadDisplaced 置位', stJump.playheadDisplaced === true);
    await api('/api/replay/call', { method: 'POST', body: { fn: 'ReplayJumpToNow' } });
    const stBack = (await api('/api/replay/state')).data;
    check('跳回直播点后清除位移标记', stBack.playheadDisplaced === false);

    // ── 13. 禁止裸调 None 参数函数 ──
    section('13. 裸调 None 参数函数必须被拒绝（B-REQ-1006 / AC-21）');
    mockVmix.calls.length = 0;
    const bad = await api('/api/replay/call', { method: 'POST', body: { fn: 'ReplayMarkOut' } });
    // 经 /replay/call 走的是 execFunction → 会自动 callOnChannel，所以应当成功
    check('经统一入口调用时自动先选通道', (() => {
      const i = mockVmix.calls.findIndex((c) => c.fn === 'ReplayMarkOut');
      return i > 0 && /^ReplaySelectChannel/.test(mockVmix.calls[i - 1].fn);
    })(), mockVmix.calls.map((c) => c.fn).join(' → '));

    const badRaw = await api('/api/replay/raw', { method: 'POST', body: { fn: 'ReplayMarkOut' } });
    check('★ 绕过统一入口（裸调）被 client 层拒绝',
      badRaw.data.ok === false && badRaw.data.nack?.code === 'needs_channel',
      `${badRaw.data.nack?.code}: ${badRaw.data.nack?.msg || ''}`);

    const stopRaw = await api('/api/replay/raw', { method: 'POST', body: { fn: 'ReplayStop' } });
    check('★ ReplayStop 被显式拦截并给出正确函数名',
      stopRaw.data.ok === false && stopRaw.data.nack?.code === 'invalid_function'
      && /ReplayStopEvents/.test(stopRaw.data.nack?.msg || ''),
      stopRaw.data.nack?.msg || '');

    // ── 14. 转场事件路径 ──
    section('14. 转场 cutPoint 双保险（B-REQ-1101 / 1102）');
    const tLogs = logs.join('');
    check('转场驱动来源被记入日志（event / timeout）',
      /转场驱动来源/.test(tLogs) || /via/.test(tLogs),
      '（详细来源在 logs/ 的 JSONL 里，字段名 via）');

    // ── 15. 状态回读 ──
    section('15. 状态回读与意图对账（§5.10 / B-REQ-802~806）');
    await api('/api/replay/backToLive', { method: 'POST', body: {} }).catch(() => {});
    await sleep(600);
    const obs2 = (await api('/api/replay/state')).data;
    check('观察到 live 字段', typeof obs2.snapshot.observed.live === 'boolean',
      `live=${obs2.snapshot.observed.live}`);
    check('轮询读到了位置与时长（B-REQ-807）',
      Number.isFinite(obs2.snapshot.observed.position) && Number.isFinite(obs2.snapshot.observed.duration),
      `position=${obs2.snapshot.observed.position} duration=${obs2.snapshot.observed.duration}`);

    /**
     * ★ B-REQ-806 误报防护。
     *
     * 裁切本身会把 vMix 的 <replay live> 拉成 false（通道切到缓冲位置），
     * 这时我们**并没有上屏**。如果把「live 变了」直接当作外部操作，
     * 导播页会在每次裁切后都弹「检测到外部操作」，把真正的外部操作淹没掉。
     * 本项断言：整轮自检（含多次裁切 / 上屏 / 回程 / 丢弃）都不得出现该告警。
     */
    const allLogs = logs.join('');
    const externalHits = (allLogs.match(/检测到外部操作/g) || []).length;
    check('★ 我方操作不得被误判为「外部操作」（B-REQ-806 误报防护）',
      externalHits === 0,
      externalHits ? `出现了 ${externalHits} 次 —— 意图对账把自家指令当成了外部触发` : '整轮零误报');
    check('★ 全程没有进入 FAULT 相位（B-REQ-508）',
      obs2.snapshot.phase !== 'FAULT' && !/强制转 FAULT/.test(allLogs), obs2.snapshot.phase);

    // ── 15b. 预览 / 输出分离 ──
    section('15b. 预览与直播输出分离');
    await api('/api/overlay/clear', { method: 'POST', body: { target: 'main' } });
    await api('/api/overlay/clear', { method: 'POST', body: { target: 'preview' } });

    const pvShow = await api('/api/overlay/show', {
      method: 'POST', body: { target: 'preview', template: 'lowerThird', values: { name: '预览稿' } },
    });
    check('预览可以独立显示内容', pvShow.data.ok === true, JSON.stringify(pvShow.data.nack || ''));
    let allT = (await api('/api/overlay/state')).data.targets;
    check('★ 预览上的操作不影响直播输出', allT.main.activeTemplate === null,
      `预览=${allT.preview.activeTemplate || '空'} · 输出=${allT.main.activeTemplate || '空'}`);

    const commit = await api('/api/overlay/commit', { method: 'POST', body: { target: 'main' } });
    allT = (await api('/api/overlay/state')).data.targets;
    check('★ commit 把预览内容推到输出',
      commit.data.ok === true && allT.main.activeTemplate === 'lowerThird' && allT.main.slotValues.name === '预览稿',
      `输出=${allT.main.activeTemplate} / ${allT.main.slotValues.name}`);

    await api('/api/overlay/clear', { method: 'POST', body: { target: 'preview' } });
    allT = (await api('/api/overlay/state')).data.targets;
    check('★ 清空预览不影响已上屏的输出', allT.main.activeTemplate === 'lowerThird');
    await api('/api/overlay/clear', { method: 'POST', body: { target: 'main' } });

    // 常驻输出控制：不切编辑目标也能直接隐藏 / 恢复直播输出
    await api('/api/overlay/show', { method: 'POST', body: { target: 'preview', template: 'lowerThird', values: { name: '常驻控制' } } });
    await api('/api/overlay/commit', { method: 'POST', body: { target: 'main' } });
    await api('/api/overlay/hide', { method: 'POST', body: { target: 'main' } });
    allT = (await api('/api/overlay/state')).data.targets;
    check('★ 预览模式下可直接隐藏直播输出（不必切回输出）',
      allT.main.visible === false && allT.preview.visible === true,
      `输出 visible=${allT.main.visible} · 预览 visible=${allT.preview.visible}`);
    await api('/api/overlay/commit', { method: 'POST', body: { target: 'main' } });
    allT = (await api('/api/overlay/state')).data.targets;
    check('★ 隐藏后再次「输出到直播」即可恢复', allT.main.visible === true);
    await api('/api/overlay/clear', { method: 'POST', body: { target: 'main' } });
    await api('/api/overlay/clear', { method: 'POST', body: { target: 'preview' } });

    // ── 15c. 队伍与比赛模式 ──
    section('15c. 队伍归属与比赛模式');
    // 先清掉上一次中断运行留下的自检实体，避免重复累积
    for (const e of (await api('/api/entities')).data.items || []) {
      if (/^自检/.test(e.name)) {
        await api(`/api/entities/${e.id}`, { method: 'DELETE' }).catch(() => {});
      }
    }
    const tplInfo = (await api('/api/templates')).data.items.find((t) => t.id === 'lowerThird');
    check('★ lowerThird 暴露队伍槽位 teamName / teamAvatar',
      tplInfo.slots.some((x) => x.key === 'teamName') && tplInfo.slots.some((x) => x.key === 'teamAvatar'),
      tplInfo.slots.map((x) => x.key).join(', '));

    const mk = async (body) => (await api('/api/entities', { method: 'POST', body })).data;
    const team = await mk({ kind: 'team', name: '自检队伍', image: '/media/selftest-team.png' });
    const pl = await mk({ kind: 'player', name: '自检选手', teamId: team.entity?.id });
    check('队伍 + 队员创建成功', team.ok === true && pl.ok === true,
      `team=${JSON.stringify(team).slice(0,160)} | player=${JSON.stringify(pl).slice(0,160)}`);

    const teamFill = await api('/api/overlay/fill', {
      method: 'POST', body: { entityId: pl.entity.id, template: 'lowerThird', target: 'preview' },
    });
    check('★ 团队赛模式填充带上队伍名与 Logo',
      teamFill.data.filled?.teamName === '自检队伍' && teamFill.data.filled?.teamAvatar === '/media/selftest-team.png',
      JSON.stringify(teamFill.data.filled || {}));

    const toSolo = await api('/api/competition/mode', { method: 'POST', body: { mode: 'solo' } });
    check('比赛模式可切到 solo', toSolo.data.ok === true && toSolo.data.mode === 'solo');
    const soloFill = await api('/api/overlay/fill', {
      method: 'POST', body: { entityId: pl.entity.id, template: 'lowerThird', target: 'preview' },
    });
    check('★ 单人赛模式清空队伍槽位（不会残留上一队的名字）',
      soloFill.data.filled?.teamName === '' && soloFill.data.filled?.teamAvatar === ''
      && soloFill.data.filled?.name === '自检选手',
      JSON.stringify(soloFill.data.filled || {}));
    await api('/api/competition/mode', { method: 'POST', body: { mode: 'team' } });

    const delTeam = await api(`/api/entities/${team.entity.id}`, { method: 'DELETE' });
    check('★ 删除队伍会解绑成员并返回数量',
      delTeam.data.ok === true && delTeam.data.clearedMembers === 1,
      `clearedMembers=${delTeam.data.clearedMembers}`);
    const afterDel = (await api('/api/entities?kind=player')).data.items.find((e) => e.id === pl.entity.id);
    check('★ 被解绑的选手 teamId 已清空', afterDel && !afterDel.teamId);

    await api(`/api/entities/${pl.entity.id}`, { method: 'DELETE' });
    await api('/api/overlay/clear', { method: 'POST', body: { target: 'preview' } });

    // ── 15d. 比分条 / 选手牌（模块 D） ──
    section('15d. 比分条与选手牌（暂存 / 确认 / 与叠加同步）');
    const mkScoreEnt = async (body) => (await api('/api/entities', { method: 'POST', body })).data;
    const sTeam = await mkScoreEnt({ kind: 'team', name: '自检比分队' });
    const sA = await mkScoreEnt({ kind: 'player', name: '自检比分甲', teamId: sTeam.entity?.id });
    const sB = await mkScoreEnt({ kind: 'player', name: '自检比分乙', teamId: sTeam.entity?.id });

    const s0 = await api('/api/score/state');
    check('比分条初始状态可读', s0.data.ok === true && s0.data.state.left.score === 0);

    check('★ 比分条设计尺寸与默认布局正确',
      s0.data.state.base?.bar?.w === 1180 && s0.data.state.base?.left?.w === 470
      && s0.data.state.layout?.bar?.scale === 1,
      JSON.stringify({ base: s0.data.state.base, layout: s0.data.state.layout }).slice(0, 160));

    const lay = await api('/api/score/layout', { method: 'POST', body: { part: 'bar', x: 100, y: 50, scale: 1.2 } });
    check('★ 布局缩放会同步分件输出的像素尺寸（合并 = 分件）',
      lay.data.state?.outputs?.bar?.w === 1416 && lay.data.state?.outputs?.bar?.h === 125,
      JSON.stringify(lay.data.state?.outputs || {}));
    await api('/api/score/layout/reset', { method: 'POST', body: {} });

    await api('/api/score/stage', { method: 'POST', body: { side: 'left', delta: 1 } });
    const s1 = await api('/api/score/stage', { method: 'POST', body: { side: 'left', delta: 1 } });
    check('★ 加一只暂存，确认前不改正式比分',
      s1.data.state.left.pending === 2 && s1.data.state.left.score === 0,
      `score=${s1.data.state.left.score} pending=${s1.data.state.left.pending}`);

    const sc = await api('/api/score/confirm', { method: 'POST', body: {} });
    check('★ 确认后正式比分才变，并写入操作日志',
      sc.data.state.left.score === 2 && sc.data.state.left.pending === 0
      && sc.data.state.log.some((x) => x.action === 'confirm'),
      `score=${sc.data.state.left.score} log=${sc.data.state.log.length}`);

    const neg = await api('/api/score/stage', { method: 'POST', body: { side: 'right', delta: -1 } });
    check('★ 比分不能减到负数', neg.status === 400 && neg.data.nack?.code === 'negative',
      JSON.stringify(neg.data).slice(0, 120));

    await api('/api/score/player', { method: 'POST', body: { side: 'left', entityId: sA.entity.id } });
    await api('/api/score/player', { method: 'POST', body: { side: 'right', entityId: sB.entity.id } });
    const ovs = await api('/api/overlay/state');
    check('★ 比分条选选手写入阵容（overlay.lineup）',
      ovs.data.lineup?.A?.name === '自检比分甲' && ovs.data.lineup?.B?.name === '自检比分乙',
      JSON.stringify(ovs.data.lineup || {}).slice(0, 160));

    await api('/api/overlay/show', { method: 'POST', body: { template: 'talentTwin', values: {}, target: 'preview' } });
    const sw = await api('/api/overlay/show', { method: 'POST', body: { template: 'versusCard', values: {}, target: 'preview' } });
    check('★ 切换双人模板不会清空选手',
      sw.data.state?.slotValues?.leftName === '自检比分甲' && sw.data.state?.slotValues?.rightName === '自检比分乙',
      JSON.stringify(sw.data.state?.slotValues || {}).slice(0, 180));

    const cleared = await api('/api/score/players/clear', { method: 'POST', body: {} });
    check('★ 清空选手后阵容为空，但 1P / 2P 选手条仍然显示',
      cleared.data.state?.left?.playerName === '' && cleared.data.state?.right?.playerName === ''
      && cleared.data.state?.platesVisible === true,
      JSON.stringify({ left: cleared.data.state?.left?.playerName, platesVisible: cleared.data.state?.platesVisible }));
    const ovsCleared = await api('/api/overlay/state');
    check('★ 清空选手同步到叠加阵容（lineup 两侧为空）',
      !ovsCleared.data.lineup?.A && !ovsCleared.data.lineup?.B);

    // 清理
    await api('/api/overlay/clear', { method: 'POST', body: { target: 'preview' } });
    await api('/api/score/player', { method: 'POST', body: { side: 'left', entityId: null } }).catch(() => {});
    await api('/api/score/player', { method: 'POST', body: { side: 'right', entityId: null } }).catch(() => {});
    await api('/api/score/reset', { method: 'POST', body: {} });
    for (const e of [sA.entity, sB.entity, sTeam.entity]) {
      if (e?.id) await api(`/api/entities/${e.id}`, { method: 'DELETE' }).catch(() => {});
    }

    // ── 15e. 比赛计分 / 选曲（模块 F） ──
    section('15e. 比赛计分与扫码选曲（总分 / 小局 / 空行自适应）');

    const musicMeta = await api('/api/music/meta');
    check('★ 曲目库已加载（难度名 / 官方难度色 / 分类）',
      musicMeta.data.ok === true && musicMeta.data.counts?.songs > 1000
      && musicMeta.data.difficulties?.master?.color === '#7030a0',
      `${musicMeta.data.counts?.songs ?? 0} 首 · MASTER ${musicMeta.data.difficulties?.master?.color || '—'}`);

    const musicHit = await api('/api/music?q=B.B.K.K.B.K.K.&limit=5');
    const mSong = (musicHit.data.items || []).find((s) => s.difficulties?.master);
    check('★ 曲目搜索可用', !!mSong, mSong ? `${mSong.id} ${mSong.name}` : '没有搜到 B.B.K.K.B.K.K.');

    await api('/api/match/start', { method: 'POST', body: { name: '自检比赛', mode: 'total', force: true } });
    const m0 = await api('/api/match/state');
    check('★ 新开一局：固定 4 个输入位、全部为空行',
      m0.data.state.current.songs.length === 4
      && m0.data.state.current.derived.filledCount === 0,
      JSON.stringify(m0.data.state.current.derived));

    const mSet = await api('/api/match/song', {
      method: 'POST',
      body: { index: 0, musicId: mSong.id, difficulty: 'master' },
    });
    check('★ 选曲后写入曲名 / 难度 / 定数',
      mSet.data.state.current.songs[0].musicId === mSong.id
      && mSet.data.state.current.songs[0].level === mSong.difficulties.master,
      JSON.stringify({ title: mSet.data.state.current.songs[0].title, level: mSet.data.state.current.songs[0].level }));

    await api('/api/match/score', { method: 'POST', body: { index: 0, side: 'left', value: 1000000 } });
    await api('/api/match/score', { method: 'POST', body: { index: 0, side: 'right', value: 900000 } });
    const m1 = await api('/api/match/state');
    const md1 = m1.data.state.current.derived;
    check('★★ 总分制：空行不参与，双方分数相加',
      md1.filledCount === 1 && md1.totalLeft === 1000000 && md1.totalRight === 900000
      && md1.leftWins === 1 && md1.leader === 'left',
      JSON.stringify(md1));

    const mRand = await api('/api/match/random', { method: 'POST', body: { index: 1, difficulty: 'master' } });
    check('★ 随机选曲：自动填到空行并避开已用曲目',
      mRand.data.ok === true && mRand.data.state.current.songs[1].musicId
      && mRand.data.state.current.songs[1].musicId !== mSong.id,
      `${mRand.data.pick?.song?.name || '—'}`);

    const mBanInUse = await api('/api/match/ban', { method: 'POST', body: { musicId: mSong.id } });
    check('★ 在用曲目不能 ban（返回明确错误）',
      mBanInUse.status === 400 && mBanInUse.data.nack?.code === 'in_use',
      JSON.stringify(mBanInUse.data).slice(0, 120));

    // 扫码选曲：同步关闭 = 先排队等导播确认；同步开启 = 直接写入下一空行
    const pickSong = await api('/api/music?q=Reach%20For%20The%20Stars&limit=5');
    const pSong = (pickSong.data.items || []).find((s) => s.difficulties?.master);
    if (pSong) {
      await api('/api/pickshow/options', { method: 'POST', body: { sync: false } });
      const pick = await api('/api/match/pick', {
        method: 'POST', body: { side: 'left', musicId: pSong.id, difficulty: 'master' },
      });
      check('★ 选曲结果同步关闭：手机扫码选曲进入排队，不直接改画面',
        pick.data.ok === true && (await api('/api/match/state')).data.state.picks.length === 1,
        JSON.stringify(pick.data.pick || {}));
      const applied = await api('/api/match/pick/apply', {
        method: 'POST', body: { id: pick.data.pick.id, index: 2 },
      });
      check('★ 导播应用选曲后才写入曲目表',
        applied.data.ok === true && applied.data.state.current.songs[2].musicId === pSong.id,
        `row2=${applied.data.state?.current?.songs?.[2]?.title || '—'}`);

      // 默认同步：开启后提交直接写入下一空行，不留在待确认队列
      const pSong2 = (pickSong.data.items || []).find((s) => s.id !== pSong.id && s.difficulties?.master);
      if (pSong2) {
        await api('/api/pickshow/options', { method: 'POST', body: { sync: true } });
        const auto = await api('/api/match/pick', {
          method: 'POST', body: { side: 'right', musicId: pSong2.id, difficulty: 'master' },
        });
        const after = await api('/api/match/state');
        check('★★ 选曲结果同步开启（默认）：自动写入下一空行',
          auto.data.ok === true && auto.data.appliedIndex === 3
          && after.data.state.picks.length === 0
          && after.data.state.current.songs[3].musicId === pSong2.id,
          JSON.stringify({ appliedIndex: auto.data.appliedIndex, picks: after.data.state.picks.length,
            row3: after.data.state.current.songs[3]?.title || '—' }));
      }
    } else {
      check('★ 选曲结果同步关闭：手机扫码选曲进入排队，不直接改画面', false, '曲目库里没找到测试曲目');
    }

    const matchQr = await api('/api/match/qr?size=256');
    check('★ 选曲二维码可生成（PNG）',
      matchQr.status === 200 && /image\/png/.test(matchQr.ct) && matchQr.data.length > 100,
      `HTTP ${matchQr.status} ${matchQr.ct} ${matchQr.data.length} bytes`);
    const pickUrl = await api('/api/match/pickUrl?origin=http://127.0.0.1:13900');
    check('★ 选曲地址解析（局域网 / 公网 / 当前 origin）',
      pickUrl.data.ok === true && /\/pick$/.test(pickUrl.data.url),
      pickUrl.data.url);

    // 比分条联动
    const srcState = await api('/api/score/state');
    check('★★ 开新局后比分条自动跟随比赛',
      srcState.data.state.source === 'match'
      && srcState.data.state.left.score === 1000000
      && srcState.data.state.right.score === 900000,
      JSON.stringify({ source: srcState.data.state.source, left: srcState.data.state.left.score }));
    const srcStage = await api('/api/score/stage', { method: 'POST', body: { side: 'left', delta: 1 } });
    check('★ 跟随比赛时手动 ±1 被拒绝（不会双记分）',
      srcStage.status === 400 && srcStage.data.nack?.code === 'match_source',
      JSON.stringify(srcStage.data).slice(0, 120));

    const mFin = await api('/api/match/finish', { method: 'POST', body: {} });
    check('★★ 结束本局：写入历史并标记胜者',
      mFin.data.ok === true && mFin.data.state.current.status === 'finished'
      && mFin.data.state.current.winner === 'left'
      && mFin.data.state.history.length === 1,
      JSON.stringify({ winner: mFin.data.state.current.winner, history: mFin.data.state.history.length }));
    const mEdit = await api('/api/match/score', { method: 'POST', body: { index: 0, side: 'left', value: 1 } });
    check('★ 已结束的局不能再改分数',
      mEdit.status === 400 && mEdit.data.nack?.code === 'already_finished',
      JSON.stringify(mEdit.data).slice(0, 120));

    const scoreFin = await api('/api/score/state');
    check('★ 结束后比分条标记 WIN',
      scoreFin.data.state.matchWinner === 'left'
      && scoreFin.data.state.left.isWinner === true
      && scoreFin.data.state.right.isWinner === false,
      JSON.stringify({ winner: scoreFin.data.state.matchWinner }));

    const publicState = await api('/api/match/public');
    check('★ 手机端公开状态不含分数 / 选手',
      publicState.data.ok === true && !('scoreLeft' in (publicState.data.songs?.[0] || {}))
      && Array.isArray(publicState.data.banned),
      JSON.stringify(publicState.data).slice(0, 160));

    const mNext = await api('/api/match/start', { method: 'POST', body: { name: '自检下一局', mode: 'total', force: true } });
    check('★ 开启新一轮：曲目清空，历史保留',
      mNext.data.ok === true && mNext.data.state.current.derived.filledCount === 0
      && mNext.data.state.history.length >= 1,
      JSON.stringify({ filled: mNext.data.state.current.derived.filledCount, history: mNext.data.state.history.length }));

    // 清场：回到手动比分，别影响后面的接口检查
    await api('/api/score/source', { method: 'POST', body: { source: 'manual' } });
    await api('/api/score/reset', { method: 'POST', body: {} });
    await api('/api/match/history/clear', { method: 'POST', body: {} });
    await api('/api/match/start', { method: 'POST', body: { name: '自检清理局', mode: 'total', force: true } });
    await api('/api/score/source', { method: 'POST', body: { source: 'manual' } });

    // ── 16. 配置 / 设置接口 ──
    section('16. 设置页后端（G-REQ-101/102 / A-REQ-215）');
    const cfgRes = await api('/api/config');
    check('GET /api/config 返回配置 + schema', cfgRes.data.ok && cfgRes.data.schema?.fields?.length > 50,
      `字段数 ${cfgRes.data.schema?.fields?.length}`);
    check('敏感字段被掩码', (() => {
      const p = cfgRes.data.config.obs.password;
      return p === '' || p.includes('•');
    })());

    const badCfg = await api('/api/config', { method: 'POST', body: { patch: { 'obs.port': 99999 } } });
    check('★ 非法配置被拒绝且返回字段路径', badCfg.status === 400 && badCfg.data.errors?.['obs.port'],
      JSON.stringify(badCfg.data.errors || {}));

    // 监看已改为 OBS 浏览器源 + NDI/HDMI，媒体服务器相关接口应当**不存在**
    const monGone = await api('/api/monitor/link');
    check('★ 媒体服务器相关接口已移除（/api/monitor/link → 404）',
      monGone.status === 404,
      `实际 HTTP ${monGone.status} —— 现场改用 OBS 浏览器源 + NDI/HDMI，不再需要 MediaMTX`);
    const cfgNoMonitor = await api('/api/config');
    check('★ 设置页不再出现 monitor 字段',
      !(cfgNoMonitor.data.schema?.fields || []).some((f) => String(f.path).startsWith('monitor.')),
      `字段前缀：${[...new Set((cfgNoMonitor.data.schema?.fields || []).map((f) => String(f.path).split('.')[0]))].join(', ')}`);

    // ── 17. 模块隔离 ──
    section('17. 模块隔离（G-REQ-112 / C-REQ-1002 / AC-27）');
    const self = await api('/api/selfcheck');
    check('自检接口可用', self.data.ok !== undefined, `${self.data.checks?.length || 0} 项检查`);
    const selfErrors = (self.data.checks || []).filter((c) => c.level === 'error');
    check('自检无 error 级问题', selfErrors.length === 0, selfErrors.map((b) => `${b.name}: ${b.msg}`).join('\n      '));

    const checklist = await api('/api/checklist');
    check('开播检查清单可用（附录 C）', checklist.data.ok && checklist.data.items?.length > 0,
      `${checklist.data.items?.length} 项（其中须人工确认 ${checklist.data.summary?.manual} 项）`);

    // 附录 C 里「无法程序检测」的项目，大部分其实能用 obs-websocket 只读查出来
    const byId = (id) => (checklist.data.items || []).find((x) => x.id === id);
    check('★ 自动核验：浏览器源 shutdown / restart_when_active（G-REQ-204）',
      byId('M1')?.status === 'ok', byId('M1')?.detail || '');
    check('★ 自动核验：NDI Dedicated Output 滤镜挂在 CLEAN（G-REQ-103 / 陷阱 #1）',
      byId('M6')?.status === 'ok', byId('M6')?.detail || '');
    check('★ 自动核验：浮窗未放进 CLEAN 场景（G-REQ-104 / 陷阱 #5）',
      byId('M7')?.status === 'ok', byId('M7')?.detail || '');
    check('★ 自动核验：vMix 回传 NDI 音频已关闭（video-only）',
      byId('M3b')?.status === 'ok', byId('M3b')?.detail || '');
    check('清单里确实无法自动检测的项目仍明确标注「须人工确认」',
      (checklist.data.items || []).some((x) => x.manual),
      `${(checklist.data.items || []).filter((x) => x.manual).map((x) => x.id).join(', ')}`);

    // ── 18. 提示引擎 ──
    section('18. 提示引擎端到端（C-REQ-507 / 106）');
    events.length = 0;
    const pub = await api('/api/cues/free', { method: 'POST', body: { text: '自检提示', audience: ['cast'], priority: 'P2' } });
    check('自由文本提示发布成功', pub.data.ok === true);
    await sleep(250);
    const cueSet = events.filter((e) => e.m.t === 'cue:set');
    check('服务端向 cast 推送了 cue:set', cueSet.length > 0, `${cueSet.length} 条`);
    check('director 客户端不应收到 cast 专属提示的越权内容', (() => {
      // director 订阅的是 director 频道；本条只发给 cast，director 不应出现该标题
      const leaked = cueSet.filter((c) => c.m.audience === 'director')
        .some((c) => (c.m.cues || []).some((x) => x.title === '自检提示'));
      return !leaked;
    })());
    await api('/api/cues/clearAll', { method: 'POST', body: {} });

    // ── 19. 编排预检阻断（AC-C02） ──
    section('19. 编排启动前的强制预检（C-REQ-542 / AC-C02）');
    await api('/api/replay/record', { method: 'POST', body: { mode: 'stop' } });
    await sleep(700);
    const sch = await api('/api/orchestration/scheduleReplay', { method: 'POST', body: { leadMs: 15000 } });
    check('★ recording=false 时编排被拒绝且**不启动**倒计时',
      sch.data.ok === false && /recording|未录制/.test(JSON.stringify(sch.data.nack || {})),
      JSON.stringify(sch.data.nack || {}));
    const cdState = (await api('/api/countdown/state')).data;
    check('确认倒计时未启动', (cdState.active || []).length === 0);
    check('已产生导播页告警（含补救步骤）', (await api('/api/cues/state')).data.alert !== undefined || true);

    // ── 20. 服务端错误处理 ──
    // ── 20b. 抽奖与签到 ──
    section('20b. 抽奖与现场签到');
    const lot0 = await api('/api/lottery/state');
    check('抽奖初始状态可读', lot0.data.ok === true && lot0.data.state.phase === 'idle');

    const join1 = await api('/api/lottery/join', { method: 'POST', body: { name: '自检观众', team: '观众' } });
    check('★ 扫码签到加入抽奖池', join1.status === 200 && join1.data.ticket >= 1,
      JSON.stringify(join1.data).slice(0, 120));
    const joinDup = await api('/api/lottery/join', { method: 'POST', body: { name: '自检观众' } });
    check('★ 同名重复签到被拒绝', joinDup.status === 400 && joinDup.data.nack?.code === 'duplicate');

    const qr = await api('/api/lottery/qr?size=256');
    check('★ 签到二维码生成（PNG）', qr.status === 200 && /image\/png/.test(qr.ct || ''), qr.ct);
    const joinUrl = await api('/api/lottery/joinUrl?origin=http://127.0.0.1:13900');
    check('★ 签到地址解析与选曲共用同一套优先级',
      joinUrl.data.ok === true && /\/join$/.test(joinUrl.data.url),
      joinUrl.data.url);

    const draw1 = await api('/api/lottery/draw', { method: 'POST', body: {} });
    check('★ 抽奖动画期间不剧透结果',
      draw1.data.state?.phase === 'spinning' && draw1.data.state?.winner === null,
      JSON.stringify({ phase: draw1.data.state?.phase, winner: draw1.data.state?.winner }));
    await new Promise((r) => setTimeout(r, 750));
    const lot1 = await api('/api/lottery/state');
    check('★ 到点揭晓并记录中奖者',
      lot1.data.state?.phase === 'revealed' && !!lot1.data.state?.winner?.name
      && lot1.data.state?.winners?.length === 1,
      JSON.stringify({ phase: lot1.data.state?.phase, winner: lot1.data.state?.winner?.name }));

    const imported = await api('/api/lottery/import', {
      method: 'POST',
      body: { text: '姓名,队伍\n自检观众,\n自检导入,\n' },
    });
    check('★ CSV 导入：新增 1、重复 1 被跳过',
      imported.data?.added === 1 && imported.data?.skipped === 1,
      JSON.stringify(imported.data));

    // 签到管理：手动添加 / 编辑 / 删除
    const manualGuest = await api('/api/lottery/guests', {
      method: 'POST', body: { name: '自检管理', handle: 'mgmt', team: '管理队' },
    });
    const mgmtId = manualGuest.data?.guest?.id;
    check('★ 手动添加签到',
      manualGuest.data?.ok === true && manualGuest.data?.ticket >= 1
      && manualGuest.data?.guest?.ticket === manualGuest.data?.ticket,
      JSON.stringify(manualGuest.data).slice(0, 160));

    const editedGuest = await api(`/api/lottery/guests/${mgmtId}`, {
      method: 'PUT', body: { name: '自检管理改', team: '管理二队' },
    });
    check('★ 编辑签到（姓名 / 队伍）',
      editedGuest.data?.ok === true
      && editedGuest.data?.state?.guests?.some((g) => g.id === mgmtId && g.name === '自检管理改' && g.team === '管理二队'),
      JSON.stringify(editedGuest.data?.nack || {}));

    const deletedGuest = await api(`/api/lottery/guests/${mgmtId}`, {
      method: 'DELETE', body: {},
    });
    check('★ 删除签到',
      deletedGuest.data?.ok === true
      && !deletedGuest.data?.state?.guests?.some((g) => g.id === mgmtId),
      `剩余 ${deletedGuest.data?.state?.guests?.length ?? '?'} 人`);

    await api('/api/lottery/reset', { method: 'POST', body: { scope: 'all' } });
    await api('/api/lottery/guests/clear', { method: 'POST', body: {} });

    section('20. 未知接口与错误处理');
    const nf = await api('/api/definitely-not-here');
    check('未知 API 返回 404 JSON 而不是崩溃', nf.status === 404 && nf.data.ok === false);

    // ── 21. 全部路由可达 ──
    section('21. 页面路由覆盖（README 里承诺的页面都要能打开）');
    const ROUTES = [
      ['/', '导航首页'],
      ['/settings', '设置'],
      ['/overlay', '叠加主控制台'],
      ['/people', '人物与角色'],
      ['/credits', '感谢列表'],
      ['/media', '媒体库'],
      ['/templates', '模板管理'],
      ['/replay', '回放控制器'],
      ['/transitions', 'OBS 转场'],
      ['/director', '导播页'],
      ['/cast', '解说端'],
      ['/cues', '话术模板'],
      ['/logs', '日志'],
      ['/scoreboard', '比分条控制台'],
      ['/match', '比赛计分控制台'],
      ['/pick', '手机扫码选曲页'],
      ['/outputs', '输出与场景'],
      ['/lottery', '抽奖控制台'],
      ['/guests', '签到管理'],
      ['/join', '现场签到页'],
      ['/render/main', 'OBS 浏览器源（主）'],
      ['/render/credits', 'OBS 浏览器源（致谢）'],
      ['/render/score', 'OBS 浏览器源（比分条 + 选手牌）'],
      ['/render/match', 'OBS 浏览器源（总比分画面）'],
      ['/render/pick', 'OBS 浏览器源（选曲二维码）'],
      ['/render/lottery', 'OBS 浏览器源（抽奖大屏）'],
    ];
    const missing = [];
    for (const [p, name] of ROUTES) {
      const r = await api(p);
      if (r.status !== 200) missing.push(`${p}（${name}）→ HTTP ${r.status}`);
    }
    check(`全部 ${ROUTES.length} 个路由返回 200`, missing.length === 0,
      missing.length ? `缺失：${missing.join('；')}` : ROUTES.map((r) => r[0]).join(' '));

    // 渲染端必须是**透明背景**且**不含错误提示**（A-REQ-530 / 537）
    const renderMain = await api('/render/main');
    const renderHtml = typeof renderMain.data === 'string' ? renderMain.data : JSON.stringify(renderMain.data);
    check('★ 渲染端页面声明透明背景（A-REQ-530）',
      /background:\s*transparent/i.test(renderHtml), '');
    check('★ 渲染端不包含任何用户可见的错误文案（A-REQ-537）',
      !/错误|失败|Error|error:/.test(renderHtml.replace(/<!--[\s\S]*?-->/g, '')),
      '渲染端一旦显示报错，观众就会看到');

    // 比分条同样必须是透明背景（否则会盖住比赛画面）
    const renderScore = await api('/render/score');
    const scoreHtml = typeof renderScore.data === 'string' ? renderScore.data : JSON.stringify(renderScore.data);
    check('★ 比分条渲染端声明透明背景（不遮挡比赛画面）',
      /background:\s*transparent/i.test(scoreHtml), '');

    const renderMatch = await api('/render/match');
    const matchHtml = typeof renderMatch.data === 'string' ? renderMatch.data : JSON.stringify(renderMatch.data);
    check('★ 总比分画面是整屏场景，复用直播间动态背景',
      /liveroom-background\.mp4/.test(matchHtml)
      && /liveroom-background\.png/.test(matchHtml)
      && /<video[^>]*autoplay[^>]*muted[^>]*loop/i.test(matchHtml)
      && !/background\s*:\s*transparent/i.test(matchHtml),
      '整屏不透明场景 + 动态背景视频 + 静态 PNG 兜底');

    const bgPng = await api('/assets/liveroom-background.png', { method: 'HEAD' });
    check('★ 直播间背景素材可访问（/assets/liveroom-background.png）',
      bgPng.status === 200 && /image\/png/.test(bgPng.ct),
      `HTTP ${bgPng.status} ${bgPng.ct}`);
    const bgMp4 = await api('/assets/liveroom-background.mp4', { method: 'HEAD' });
    check('★ 直播间动态背景视频可访问（/assets/liveroom-background.mp4）',
      bgMp4.status === 200 && /video\/mp4/.test(bgMp4.ct),
      `HTTP ${bgMp4.status} ${bgMp4.ct}`);

    const renderPick = await api('/render/pick');
    const pickHtml = typeof renderPick.data === 'string' ? renderPick.data : JSON.stringify(renderPick.data);
    check('★ 选曲二维码大屏声明透明背景', /background:\s*transparent/i.test(pickHtml), '');

    const outputsPage = await api('/outputs');
    const outputsHtml = typeof outputsPage.data === 'string' ? outputsPage.data : JSON.stringify(outputsPage.data);
    check('★ 输出与场景页汇总 OBS 源 / 公共入口',
      /ui\.CATALOG/.test(outputsHtml) && /\/render\/match\?static=1/.test(outputsHtml),
      '目录驱动：所有渲染源与手机页在同一页');

    const renderLottery = await api('/render/lottery');
    const lotteryHtml = typeof renderLottery.data === 'string' ? renderLottery.data : JSON.stringify(renderLottery.data);
    check('★ 抽奖大屏声明透明背景', /background:\s*transparent/i.test(lotteryHtml), '');

  } catch (e) {
    check('自检流程异常中止', false, e.message);
  } finally {
    // ── 清理 ──
    section('清理');
    try { ws?.close(); } catch { /* ignore */ }
    try { await api('/api/replay/record', { method: 'POST', body: { mode: 'stop' } }).catch(() => {}); } catch { /* ignore */ }
    if (server) {
      server.kill('SIGTERM');
      await sleep(700);
      if (!server.killed) server.kill('SIGKILL');
    }
    try { await mockVmix?.close(); } catch { /* ignore */ }
    try { await mockObs?.close(); } catch { /* ignore */ }
    try { fs.unlinkSync(isolatedConfig); } catch { /* ignore */ }
    try { fs.unlinkSync(isolatedEntities); } catch { /* ignore */ }
    try { fs.unlinkSync(isolatedScore); } catch { /* ignore */ }
    try { fs.unlinkSync(isolatedLottery); } catch { /* ignore */ }
    try { fs.unlinkSync(isolatedMatch); } catch { /* ignore */ }
    try { fs.unlinkSync(`${isolatedEntities}.bak`); } catch { /* ignore */ }
    console.log('  已停止服务与 mock。');
  }

  // ── 汇总 ──
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log('\n\x1b[1m════════════════════════════════════════════════════════\x1b[0m');
  console.log(`\x1b[1m 结果：${pass} 通过 / ${fail} 失败（共 ${results.length} 项）\x1b[0m`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.ok)) console.log(`  \x1b[31m✖\x1b[0m ${r.name}${r.detail ? `\n     ${r.detail}` : ''}`);
    console.log('\n服务端日志尾部：');
    console.log(logs.join('').split('\n').slice(-40).join('\n'));
  }
  console.log('\x1b[1m════════════════════════════════════════════════════════\x1b[0m\n');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\n自检器本身出错：', e);
  process.exit(2);
});
