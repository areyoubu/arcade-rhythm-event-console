/**
 * 街机音游赛事控制软件 —— 服务入口（共享壳层 + A/B/C 三模块装配）。
 *
 * 架构（SRS §2.1）：
 *   单进程，同时监听 overlayPort(:3000) 与 controlPort(:3001)，两者serve同一套应用。
 *   WebSocket 挂在两个端口上，共用同一个广播中枢。
 *
 * 解耦（G-REQ-112 / C-REQ-1002）：任一模块内部抛异常都被就地捕获并写日志，
 * 不影响其余模块；B/C 之间的调用全部包 try/catch。
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { fileURLToPath } from 'node:url';

import { getConfig, loadConfig, configEvents, needsReconnect, getConfigErrors, patchConfig, ROOT } from './config.js';
import { PAGES } from './pages.js';
import * as log from './logger.js';
import { clientIp, isLanRequest } from './client-ip.js';
import { adminGate, adminAuthEnabled } from './admin-auth.js';
import { outputAccessGate } from './public-access.js';
import { getState, set } from './state.js';
import * as hub from './ws-hub.js';
import * as obs from './obs.js';
import * as vmix from './vmix/client.js';
import * as transitions from './transitions.js';
import * as replay from './replay/engine.js';
import * as overlay from './overlay.js';
import * as match from './match.js';
import * as music from './music.js';
import * as score from './score.js';
import * as lottery from './lottery.js';
import * as randomScene from './random-scene.js';
import * as pickshow from './pickshow.js';
import * as gameAudio from './game-audio.js';
import * as cnMusic from './cn-music.js';
import * as cue from './cue/engine.js';
import * as countdown from './cue/countdown.js';
import * as orchestration from './cue/orchestration.js';
import * as entities from './entities.js';
import * as templates from './templates.js';
import * as media from './media.js';

import configRoutes from './routes/config.js';
import overlayRoutes, { wireMediaReferences } from './routes/overlay.js';
import replayRoutes from './routes/replay.js';
import cueRoutes from './routes/cues.js';
import libraryRoutes from './routes/library.js';
import scoreRoutes from './routes/score.js';
import musicRoutes from './routes/music.js';
import matchRoutes from './routes/match.js';
import lotteryRoutes from './routes/lottery.js';
import randomRoutes from './routes/random.js';
import pickshowRoutes from './routes/pickshow.js';
import gameAudioRoutes from './routes/game-audio.js';
import sysRoutes from './routes/sys.js';
import adminRoutes from './routes/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const STARTED_AT = Date.now();

// ═══════════════════════════════════════════════════════════════
// 1. 配置与日志
// ═══════════════════════════════════════════════════════════════
loadConfig();
const cfg0 = getConfig();
log.configureLogging({ dir: path.join(ROOT, 'logs'), level: cfg0.logging.level, retain: cfg0.logging.retainDays });
log.prune();
log.info('server', '街机音游赛事控制软件启动中', {
  root: ROOT,
  identity: cfg0.server.identity || '(未设置)',
  node: process.version,
});

// 把状态源暴露给 media.js 的引用检查（避免循环导入）
globalThis.__getState = getState;

// ═══════════════════════════════════════════════════════════════
// 2. 数据层
// ═══════════════════════════════════════════════════════════════
entities.load();
templates.load();
await media.load();
wireMediaReferences();

// 曲目库（比赛计分 / 扫码选曲都要用）
await music.load();
// 国服曲目 / 定数的待确认状态 + 自动同步计时器（默认关闭）
cnMusic.init();

// 比分条先读回手动比分与队色（比赛画面的颜色从这里取）
score.load();

// 比赛计分：读回当前局与历史；读取后再刷新一次比分条，让 source=match 立刻生效
match.setColorProvider(score.getSideColors);
match.setTeamProvider(score.getSideTeams);
match.load();
score.refresh();
pickshow.refresh();
gameAudio.warmUp();

// 抽奖：读回签到池与中奖记录，并启动第三方中继轮询（若配置了）
lottery.load();
lottery.startRelay();

// ═══════════════════════════════════════════════════════════════
// 3. HTTP 应用
// ═══════════════════════════════════════════════════════════════
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '12mb' }));          // 粘贴导入 / 配置导入
app.use(express.urlencoded({ extended: true }));

// 全局异常兜底 —— 任何路由抛错都不能拖垮进程
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// 管理令牌鉴权：令牌非空时，控制接口（/api/* 写操作）需要 Authorization: Bearer <token>
app.use(adminGate);

// OBS 输出外网开关：默认只允许内网访问 /render /assets /media 等无鉴权输出
app.use(outputAccessGate);

// 网络操作日志：每个 HTTP 请求都记进 logs/network-*.jsonl（IP / 方法 / 路径 / 状态 / 耗时 / UA）
app.use((req, res, next) => {
  const t0 = process.hrtime.bigint();
  const pathOnly = (req.path || '/').slice(0, 2048);
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    log.netlog({
      kind: 'http',
      ip: clientIp(req),
      method: req.method,
      path: pathOnly,
      status: res.statusCode,
      durationMs: Math.round(ms * 100) / 100,
      ua: String(req.get('user-agent') || '').slice(0, 300),
      bodyBytes: Number(req.get('content-length')) || 0,
    });
  });
  next();
});

app.use('/api', sysRoutes());
app.use('/api', adminRoutes());
app.use('/api', configRoutes());
app.use('/api', overlayRoutes());
app.use('/api', replayRoutes());
app.use('/api', cueRoutes());
app.use('/api', libraryRoutes());
app.use('/api', scoreRoutes());
app.use('/api', musicRoutes());
app.use('/api', matchRoutes());
app.use('/api', lotteryRoutes());
app.use('/api', randomRoutes());
app.use('/api', pickshowRoutes());
app.use('/api', gameAudioRoutes());

/**
 * 后台密码设置页 —— 只对内网开放。
 * 必须放在静态服务之前，否则公网也能直接拿到这个页面。
 */
function sendAdminSetup(req, res) {
  if (!isLanRequest(req)) {
    const html = '<!doctype html><meta charset="utf-8"><title>仅限内网</title>'
      + '<body style="font-family:system-ui;background:#17181b;color:#e3e5e9;padding:40px">'
      + '<h1 style="font-size:20px">403 · 仅限内网访问</h1>'
      + '<p style="color:#9aa0a8">后台密码设置页只接受局域网 / 本机请求。</p></body>';
    return res.status(403).type('html').send(html);
  }
  const file = path.join(PUBLIC_DIR, 'admin-setup.html');
  if (!fs.existsSync(file)) return res.status(404).end();
  res.sendFile(file);
}
app.get(['/admin-setup', '/admin-setup.html'], sendAdminSetup);
app.head(['/admin-setup', '/admin-setup.html'], sendAdminSetup);

// 静态资源
app.use('/', express.static(PUBLIC_DIR, { index: 'index.html', extensions: ['html'] }));
app.use('/media', express.static(media.rootDir(), { maxAge: '7d', immutable: false }));
// 曲目封面（本地 data/covers/，不提交到仓库）
app.use('/covers', express.static(path.join(ROOT, 'data', 'covers'), { maxAge: '7d', immutable: false }));

/**
 * assets/ 里的直播间背景素材。
 * 总比分画面（/render/match）作为独立整屏场景时复用它，
 * 所以这里显式暴露三个文件，而不是把整个项目目录静态化。
 */
/**
 * assets/ 已按用途分目录（backgrounds / transitions / layouts / mascot），
 * 但**对外 URL 保持不变** —— 现场 OBS 里可能已经填好了这些地址，
 * 改 URL 等于让所有浏览器源一起失效。
 */
const ROOT_ASSETS = [
  // 深色整屏背景（总比分 / 随机选曲 / 选曲展示 / 奖品大屏）
  ['/assets/liveroom-background.mp4', path.join('assets', 'backgrounds', 'dark', '直播间背景-动态.mp4'), 'video/mp4'],
  ['/assets/liveroom-background.png', path.join('assets', 'backgrounds', 'dark', '直播间背景.png'), 'image/png'],
  ['/assets/liveroom-background.svg', path.join('assets', 'backgrounds', 'dark', '直播间背景.svg'), 'image/svg+xml'],
  // 直播待机画面：动态背景（12s 循环）+ 静帧兜底 + 看板娘立绘（透明 PNG）
  ['/assets/standby-bg.mp4', path.join('assets', 'backgrounds', 'light', 'standby-bg.mp4'), 'video/mp4'],
  ['/assets/standby-bg.png', path.join('assets', 'backgrounds', 'light', 'standby-bg.png'), 'image/png'],
  ['/assets/standby-mascot.png', path.join('assets', 'mascot', 'standby-mascot.png'), 'image/png'],
  // 明亮风格：整屏场景的动态背景（由 shared/scene-bg.js 按主题切换）
  ['/assets/light-background.mp4', path.join('assets', 'backgrounds', 'light', 'light-bg.mp4'), 'video/mp4'],
  ['/assets/light-background.png', path.join('assets', 'backgrounds', 'light', 'light-bg.png'), 'image/png'],
  // 同一条动画的压暗版：放在游戏画面 / 摄像头后面当直播底色（纯白太亮会盖过机台）
  ['/assets/light-background-dim.mp4', path.join('assets', 'backgrounds', 'light', 'light-bg-dim.mp4'), 'video/mp4'],
  ['/assets/light-background-dim.png', path.join('assets', 'backgrounds', 'light', 'light-bg-dim.png'), 'image/png'],
];
for (const [url, filename, type] of ROOT_ASSETS) {
  const send = (req, res) => {
    const file = path.join(ROOT, filename);
    if (!fs.existsSync(file)) return res.status(404).end();
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.type(type);
    res.sendFile(file);
  };
  app.get(url, send);
  app.head(url, send);
}

/** 页面路由：清单集中在 server/pages.js（控制页 / 手机页 / OBS 源统一登记） */
for (const p of PAGES) {
  app.get(p.path, (req, res) => {
    const f = path.join(PUBLIC_DIR, p.file);
    if (fs.existsSync(f)) return res.sendFile(f);
    res.status(404).type('html').send(notFoundPage(p.path));
  });
}

app.use((req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ ok: false, errors: { __path__: `未知接口 ${req.path}` } });
  res.status(404).type('html').send(notFoundPage(req.path));
});

// 错误处理中间件：必须放在所有路由之后
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  log.error('server', 'HTTP 请求异常', { path: req.path, err: err.message });
  if (res.headersSent) return;
  res.status(err.status || 500).json({ ok: false, errors: { __server__: err.message } });
});

// ═══════════════════════════════════════════════════════════════
// 4. 监听（双端口）
// ═══════════════════════════════════════════════════════════════
const cfg = getConfig();
const servers = [];

/**
 * 监听一个端口。
 *
 * 地址是用户可配的，而「配错地址」不应该让整个服务起不来 ——
 * 比如填了当前机器上没有的 IP（换了网络/DHCP 变了）会得到 EADDRNOTAVAIL，
 * 地址里带了不可见字符会得到 ENOTFOUND。这两种情况自动退回 0.0.0.0 并**醒目告警**，
 * 现场至少还能用，而不是控制台直接白屏。
 */
function listen(port, label, hostOverride = null) {
  return new Promise((resolve, reject) => {
    const host = hostOverride ?? cfg.server.host;
    const server = http.createServer(app);

    server.on('error', (e) => {
      const recoverable = e.code === 'ENOTFOUND' || e.code === 'EADDRNOTAVAIL';
      if (recoverable && host !== '0.0.0.0') {
        log.warn('server', `监听地址「${host}」不可用（${e.code}），自动回退到 0.0.0.0`, {
          port, hint: '请到设置页把「监听地址」改成 0.0.0.0（或本机真实 IP），否则每次启动都会走回退',
        });
        listen(port, label, '0.0.0.0').then(resolve, reject);
        return;
      }
      if (e.code === 'EADDRINUSE') {
        log.error('server', `${label} 端口 ${port} 已被占用`, { hint: '请关闭占用进程，或在设置页修改 server.overlayPort / server.controlPort' });
      } else {
        log.error('server', `${label} 监听失败（${e.code || 'ERR'}：${e.message}）`, { port, code: e.code, err: e.message });
      }
      reject(e);
    });

    server.listen(port, host, () => {
      hub.attach(server, { path: '/ws' });
      servers.push({ server, port, label, host });
      log.info('server', `${label} 已监听`, { url: `http://${host}:${port}`, label });
      resolve(port);
    });
  });
}

const ports = [...new Set([cfg.server.overlayPort, cfg.server.controlPort])];
for (const p of ports) {
  const label = p === cfg.server.overlayPort ? 'Overlay' : 'Control';
  try { await listen(p, label); } catch { /* 已在 listen 内记录 */ }
}
if (!servers.length) {
  log.error('server', '没有任何端口监听成功，进程退出');
  process.exit(1);
}
set('health.servers', { overlay: cfg.server.overlayPort, control: cfg.server.controlPort, listening: servers.map((s) => s.port) });

// ═══════════════════════════════════════════════════════════════
// 5. 模块接线
// ═══════════════════════════════════════════════════════════════

// ── 模块 A：浮窗控制器交给模块 B 调用（A-REQ-511） ──
replay.setOverlayController(overlay.controller);

// ── 模块 B/C 协同 ──
orchestration.bindReplayEngine(replay);
orchestration.bindReplayEvents(replay.replayEvents);
orchestration.bindObsEvents(obs);

/**
 * B-REQ-5104：模块 B 必须上报 phase / clip:ready / air:start / progress /
 * air:ending / air:ended / air:returned / error 事件。
 *
 * 这些事件原本只走服务端内部总线（供模块 C 订阅），控制端页面拿不到。
 * 回放面板需要它们来做实时提示（「回放即将结束」「回放已结束」），
 * 所以这里原样转发给所有控制端 —— **不含渲染端**，渲染端只关心 overlay.*。
 */
replay.replayEvents.on('event', (evt) => {
  if (!evt || !evt.t) return;
  // patch 已经承载了相位等标量状态，事件通道只发事件本身，避免双份数据
  hub.toControllers({ t: 'replay:event', event: evt.t, data: evt, at: Date.now() });
});

// ── 渲染端接入 / 断开 ──
hub.hubEvents.on('overlay:ready', (client, msg) => {
  overlay.markRendererConnected(client.target || msg.target || 'main', { ua: client.ua, ip: client.ip });
  log.info('overlay', '渲染端已连接', { target: client.target, ua: String(client.ua).slice(0, 60) });
});
hub.hubEvents.on('overlay:rendered', (client, msg) => {
  const latency = overlay.markRendered(client.target || msg.target || 'main', msg.template, msg.at);
  log.debug('overlay', '渲染端已渲染', { target: client.target, template: msg.template, latencyMs: latency });
});
hub.hubEvents.on('client:gone', (client) => {
  if (client.isRenderer) overlay.markRendererDisconnected(client.target || 'main');
});
hub.hubEvents.on('client:hello', (client, msg) => {
  if (msg.audience) {
    // C-REQ-505 / AC-C10：客户端重连后全量下发当前活跃提示
    cue.sendAllTo(client);
    log.info('cue', '受众端接入', { audience: msg.audience, ua: String(client.ua).slice(0, 60) });
  }
});
hub.hubEvents.on('cue:ack', (client, msg) => {
  const r = cue.ack(msg.cueId, client.id);
  if (!r.ok) log.debug('cue', '回执被拒', { cueId: msg.cueId, reason: r.nack?.msg });
});
hub.hubEvents.on('audio:unlocked', (client) => {
  log.info('cue', `受众端音频${client.audioUnlocked ? '已解锁' : '未解锁'}`, {
    audience: client.audience,
    unackedNote: client.audioUnlocked ? undefined : '该端将听不到声音提示，视觉提示仍生效（C-REQ-564）',
  });
  // C-REQ-567：某受众全部客户端音频未解锁 → 导播页降级建议
  const { audio } = hub.audienceStats();
  for (const [aud, a] of Object.entries(audio)) {
    if (a.total > 0 && a.unlocked === 0 && !a.warned) {
      a.warned = true;
      hub.toAudience(['director'], {
        t: 'cue:alert',
        msg: `${aud} 端全部未启用声音（${a.total} 个客户端）—— 建议改用对讲机`,
        severity: 'warn',
      });
      log.warn('cue', `${aud} 端全部未启用声音`, { total: a.total });
    }
  }
});

// ── 媒体库 / 模板 / 实体变更 → 广播（A-REQ-213 / 305 / 412） ──
media.mediaEvents.on('change', ({ added, removed }) => {
  hub.broadcast({ t: 'overlay:assets', added, removed });
});
media.mediaEvents.on('degraded', ({ feature, msg }) => {
  hub.broadcast({ t: 'degraded', feature, msg, at: Date.now() });
  set('health.degraded', { feature, msg, at: Date.now() });
});
templates.templateEvents.on('change', ({ changed, removedIds }) => {
  if (!changed.length && !removedIds.length) return;
  // ★ A-REQ-213：只推送**受影响的模板定义**，绝不做整页 reload
  for (const t of changed) {
    hub.toRenderers({ t: 'overlay:templates', templates: [templates.fullList().find((x) => x.id === t.id)] });
    log.info('templates', `热重载推送模板 ${t.id}`, { id: t.id });
  }
  if (removedIds.length) hub.toRenderers({ t: 'overlay:templates', removed: removedIds });
  hub.toControllers({ t: 'templates:changed', ids: changed.map((c) => c.id), removed: removedIds });
});
entities.entityEvents.on('change', () => {
  hub.toControllers({ t: 'entities:changed' });
  // 队名 / Logo / 选手头像改了：比赛画面刷新后，比分条会跟着 match.change 一起刷新
  match.refresh();
  // 实体库变了，抽奖池也要重算
  lottery.broadcast();
});

// 叠加页填充选手 → 比分条 / 比赛画面的选手同步（双向：任一侧改都会写回 lineup）
overlay.overlayEvents.on('lineup', () => { match.refresh(); });

// 比赛计分变化 → 比分条（若 source=match）同步聚合分
match.matchEvents.on('change', () => { score.refresh(); pickshow.refresh(); });

// ── 功能开关 ──
/**
 * 按 `features.*` 启停各模块。
 *
 * 关闭时**不只是隐藏页面**，而是真的不建立连接、不轮询 ——
 * 没有 vMix / OBS 的部署不该每 2 秒往一台不存在的设备发一次心跳。
 * 这个函数是幂等的，可以反复调用（保存配置、启动时各调一次）。
 */
function applyFeatures() {
  const f = getConfig().features || {};
  const wantObs = !!f.obs;
  const wantVmix = !!f.vmix;
  const wantReplay = !!f.replay && wantVmix;          // 回放依赖 vMix
  const wantTransitions = !!f.transitions && wantObs; // 转场依赖 OBS

  // 状态镜像给前端（导航与页面据此判断）
  set('config.features', {
    replay: !!f.replay, vmix: wantVmix, obs: wantObs, transitions: !!f.transitions,
  });

  if (wantObs) obs.start(); else obs.stop();
  if (wantVmix) vmix.startHeartbeat(); else vmix.stop();

  if (wantReplay) replay.startPolling(); else replay.stopPolling();
  if (wantTransitions) transitions.startPolling(); else transitions.stopPolling();

  if (!wantObs) {
    set('health.obs', { connected: false, lastOk: 0, lastErr: null, version: null, scenes: [] });
  }
  if (!wantVmix) {
    set('health.vmix', { connected: false, lastOk: 0, lastErr: null, rttMs: 0, failCount: 0 });
  }
  log.info('config', '功能开关已应用', {
    replay: wantReplay, vmix: wantVmix, obs: wantObs, transitions: wantTransitions,
    note: (!f.replay && (f.vmix || f.obs)) || (!f.transitions && f.obs) ? '回放依赖 vMix、转场依赖 OBS，依赖未开时对应功能不会启动' : undefined,
  });
}

// ── 配置变更 → 广播 + 副作用 ──
configEvents.on('change', (patch, changed) => {
  for (const p of changed) {
    const val = pathGet(getConfig(), p);
    hub.broadcast({ t: 'patch', path: `config.${p}`, value: val });
  }
  log.audit('config', 'changed', { changed });

  // 功能开关变更：先应用（可能断开/建立连接），后续的地址重连逻辑据此判断
  if (changed.some((p) => p.startsWith('features.'))) applyFeatures();
  const f = getConfig().features || {};

  const reconnect = needsReconnect(changed);
  if (reconnect) {
    if (f.obs && changed.some((p) => p.startsWith('obs.'))) { obs.stop(); obs.start(); log.info('config', 'OBS 地址变更，已重连'); }
    if (f.vmix && changed.some((p) => p.startsWith('vmix.'))) vmix.reconnect();
    if (changed.some((p) => p.startsWith('server.overlayPort') || p.startsWith('server.controlPort') || p.startsWith('server.host'))) {
      set('config.restartPending', true);
      hub.broadcast({ t: 'config:restartRequired', msg: '服务端口已变更，需重启服务后生效' });
      log.warn('config', '服务端口已变更，需重启进程后生效');
    }
  }
  if (changed.some((p) => p.startsWith('logging.'))) {
    log.configureLogging({ level: getConfig().logging.level, retain: getConfig().logging.retainDays });
  }
  if (f.transitions && f.obs && changed.some((p) => p.startsWith('transitions.'))) {
    transitions.applyOverridesFromConfig().catch(() => { /* 已内部记录 */ });
  }
  if (changed.some((p) => p.startsWith('clip.') || p.startsWith('replay.'))) {
    replay.setClipParams({});
  }
  // 团队赛 / 单人赛切换会影响比分条上的队伍信息
  if (changed.some((p) => p.startsWith('competition.'))) match.refresh();
  // 解说页模板：整节镜像到共享状态，/cast 无需登录也能在 hello 里拿到
  if (changed.some((p) => p.startsWith('cast.'))) {
    set('config.cast', structuredClone(getConfig().cast || {}));
  }
  // 输出配色主题：变更后广播给所有渲染源，OBS 场景即时换色
  if (changed.some((p) => p.startsWith('theme.'))) {
    set('config.theme', structuredClone(getConfig().theme || {}));
  }
  // 待机画面文案：同上，渲染源热更新
  if (changed.some((p) => p.startsWith('standby.'))) {
    set('config.standby', structuredClone(getConfig().standby || {}));
  }
  // 抽奖中继地址 / 令牌 / 轮询间隔变更后立刻重新轮询
  if (changed.some((p) => p.startsWith('lottery.relay'))) lottery.startRelay();
  // 游戏音频目录 / 开关变化：重建索引（后台扫描）；其他音频参数变化只刷新展示信息
  if (changed.some((p) => p.startsWith('gameAudio.'))) {
    if (changed.some((p) => p === 'gameAudio.enabled' || p === 'gameAudio.gameDir')) {
      gameAudio.afterConfigChange();
    }
    pickshow.refresh();
  }
  // 国服 API 自动同步配置变化：重排计时器
  if (changed.some((p) => p.startsWith('cnMusic.'))) cnMusic.startAutoSync();
  set('config.loadedAt', Date.now());
  set('config.errors', {});
});

// ═══════════════════════════════════════════════════════════════
// 6. 注册 WS 命令（cmd 通道）—— 与 HTTP API 同一批能力
// ═══════════════════════════════════════════════════════════════
registerOps();

function registerOps() {
  const H = hub.registerOp;
  /** 带功能开关的命令：未启用时由 ws-hub 统一回 feature_disabled（见 features 配置节） */
  const R = (op, fn, meta = {}) => H(op, fn, { feature: 'replay', featureLabel: '回放功能', ...meta });
  const T = (op, fn, meta = {}) => H(op, fn, { feature: 'transitions', featureLabel: '回放转场', ...meta });

  // ── 模块 A ──
  H('overlay.show', (c, a) => nackOr(overlay.show(a || {})));
  H('overlay.update', (c, a) => nackOr(overlay.update(a?.slot, a?.value, a || {})));
  H('overlay.updateMany', (c, a) => nackOr(overlay.updateMany(a?.values, a || {})));
  H('overlay.hide', (c, a) => nackOr(overlay.hide(a || {})));
  H('overlay.clear', (c, a) => nackOr(overlay.clear(a || {})));
  H('overlay.pin', (c, a) => nackOr(overlay.setPinned(!!a?.pinned, a || {})));
  H('overlay.mode', (c, a) => nackOr(overlay.setMode(a?.mode, a || {})));
  H('overlay.undo', (c, a) => nackOr(overlay.undo(a?.target || 'main')));
  H('overlay.commit', (c, a) => nackOr(overlay.commitPreview(a || {})));
  H('overlay.revert', (c, a) => nackOr(overlay.revertPreview(a || {})));
  H('competition.setMode', (c, a) => {
    const mode = a?.mode;
    if (!['team', 'solo'].includes(mode)) return { __nack: 'bad_mode', msg: 'mode 必须是 team 或 solo' };
    const r = patchConfig({ 'competition.mode': mode });
    if (!r.ok) return { __nack: 'config_invalid', msg: JSON.stringify(r.errors) };
    return { mode: getConfig().competition.mode };
  });
  H('overlay.fill', (c, a) => {
    if (Array.isArray(a?.entityIds) && a.entityIds.length) return nackOr(overlay.fillFromEntities(a.entityIds, a || {}));
    return nackOr(overlay.fillFromEntity(a?.entityId, a || {}));
  });
  H('overlay.queue.add', (c, a) => nackOr(overlay.queueAdd(a || {})));
  H('overlay.queue.clear', () => nackOr(overlay.queueClear()));
  H('overlay.queue.start', (c, a) => nackOr(overlay.queueStart(a || {})));
  H('overlay.queue.pause', () => nackOr(overlay.queuePause()));
  H('overlay.queue.resume', (c, a) => nackOr(overlay.queueResume(a || {})));
  H('overlay.credits.control', (c, a) => nackOr(overlay.creditsControl(a?.action, a || {})));
  H('entity.setCurrent', (c, a) => nackOr(a?.id ? entities.setCurrent(a.id) : entities.clearCurrent()), { audience: null });

  // ── 模块 B ──
  R('replay.clip', async (c, a) => nackOr(await replay.clip(a || {})));
  R('replay.air', async (c, a) => nackOr(await replay.air(a || {})));
  R('replay.clipAndAir', async (c, a) => nackOr(await replay.clipAndAir(a || {})));
  R('replay.backToLive', async (c, a) => nackOr(await replay.backToLive(a || {})));
  R('replay.discard', async (c, a) => nackOr(await replay.discard(a || {})));
  R('replay.reset', () => nackOr(replay.reset()));
  R('replay.extendTail', async (c, a) => nackOr(await replay.extendTail(a || {})));
  R('replay.movePoint', async (c, a) => nackOr(await replay.movePoint(a?.which, a?.frames, a || {})));
  R('replay.jumpToPoint', async (c, a) => nackOr(await replay.jumpToPoint(a?.which, a || {})));
  R('replay.preflight', async (c, a) => ({ preflight: await replay.preflight(a || {}) }));
  R('replay.record', async (c, a) => {
    const mode = a?.mode || 'start';
    const fn = mode === 'start' ? 'ReplayStartRecording' : mode === 'stop' ? 'ReplayStopRecording' : 'ReplayStartStopRecording';
    await vmix.call(fn, {}, { actor: 'ws' });
    return { fn };
  });
  R('replay.call', async (c, a) => nackOr(await replay.execFunction(a?.fn, a?.params || {}, a || {})));
  R('replay.clipParams', (c, a) => nackOr({ ok: true, ...replay.setClipParams(a || {}) }));
  R('replay.channel', (c, a) => ({ channel: replay.setChannel(a?.channel) }));
  R('replay.eventList', (c, a) => ({ eventList: replay.setEventList(a?.eventList) }));
  R('replay.arm', async (c, a) => nackOr(await replay.arm(a?.intent)));
  R('replay.disarm', () => nackOr(replay.disarm()));
  R('replay.execute', async (c, a) => nackOr(await replay.execute(a?.intent, a || {})));

  // ── 转场 ──
  T('transitions.set', async (c, a) => nackOr(await transitions.setTransition(a?.transitionName, a?.durationMs)));
  T('transitions.override', async (c, a) => nackOr(await transitions.setOverride(a?.sceneName, a?.transitionName, a?.transitionDuration)));
  T('transitions.refresh', async () => ({ ...(await transitions.refreshList()) }));
  T('transitions.studioMode', async (c, a) => nackOr(await transitions.setStudioMode(!!a?.enabled)));
  T('transitions.programScene', async (c, a) => nackOr(await transitions.setProgramScene(a?.sceneName)));
  T('transitions.previewScene', async (c, a) => nackOr(await transitions.setPreviewScene(a?.sceneName)));
  T('transitions.trigger', async () => nackOr(await transitions.triggerTransition()));
  T('transitions.tbar', async (c, a) => nackOr(await transitions.setTBar(a?.position)));

  // ── 模块 C：提示 ──
  H('cue.publish', (c, a) => { const { cueId, cue: cc } = cue.publish(a || {}); return { cueId, cue: cc }; });
  H('cue.cancel', (c, a) => nackOr(cue.cancel(a?.cueId, a?.reason)));
  H('cue.forceClear', (c, a) => nackOr(cue.forceClear(a?.cueId)));
  H('cue.clearAll', () => nackOr(cue.clearAll()));
  H('cue.ack', (c, a) => nackOr(cue.ack(a?.cueId, a?.clientId || c.id)));
  H('cue.clearAlert', () => { cue.clearAlert(); return { ok: true }; }, { audience: ['director'] });

  // ── 模块 C：倒计时与编排 ──
  H('countdown.hold', (c, a) => nackOr(countdown.hold(a?.id)), { audience: ['director'] });
  H('countdown.resume', (c, a) => nackOr(countdown.resume(a?.id)), { audience: ['director'] });
  H('countdown.extend', (c, a) => nackOr(countdown.extend(a?.id, a?.deltaMs)), { audience: ['director'] });
  H('countdown.cancel', (c, a) => nackOr(countdown.cancel(a?.id)), { audience: ['director'] });
  R('orchestration.scheduleReplay', async (c, a) => nackOr(await orchestration.scheduleReplay(a || {})), { audience: ['director'] });
  R('orchestration.scheduleBackToLive', async (c, a) => nackOr(await orchestration.scheduleBackToLive(a || {})), { audience: ['director'] });
  R('orchestration.confirm', async (c, a) => nackOr(await orchestration.confirmExecute(a?.countdownId, {
    onZero: a?.intent ? { intent: a.intent, lookbackMs: a.lookbackMs } : undefined, actor: 'director',
  })), { audience: ['director'] });

  // ── 模块 C：监看 ──

  // ── 模块 E：抽奖 ──
  H('lottery.draw', (c, a) => nackOr(lottery.draw(a?.actor || 'ws')));
  H('lottery.reset', (c, a) => nackOr(lottery.reset(a?.scope === 'all' ? 'all' : 'round', a?.actor || 'ws')));
  H('lottery.settings', (c, a) => nackOr(lottery.setSettings(a || {}, a?.actor || 'ws')));

  // ── 模块 D：比分条 / 选手牌 ──
  H('score.stage', (c, a) => nackOr(score.stage(a?.side, a?.delta)));
  H('score.confirm', (c, a) => nackOr(score.confirm(a?.actor || 'ws')));
  H('score.cancel', (c, a) => nackOr(score.cancel(a?.actor || 'ws')));
  H('score.set', (c, a) => nackOr(score.setScore(a?.side, a?.value, a?.actor || 'ws')));
  H('score.reset', (c, a) => nackOr(score.resetScores(a?.actor || 'ws')));
  H('score.label', (c, a) => nackOr(score.setLabel(a?.label)));
  H('score.team', (c, a) => nackOr(score.setTeam(a?.side, a?.teamId, a?.actor || 'ws')));
  H('score.color', (c, a) => nackOr(score.setColor(a?.side, a?.color, a?.actor || 'ws')));
  H('score.visible', (c, a) => nackOr(score.setVisible(a || {})));
  H('score.player', (c, a) => nackOr(score.setPlayer(a?.side, a?.entityId, a?.actor || 'ws')));
  H('score.clearPlayers', (c, a) => nackOr(score.clearPlayers(a?.actor || 'ws')));
  H('score.layout', (c, a) => nackOr(score.setLayout(a?.part, a || {}, a?.actor || 'ws')));
  H('score.layoutReset', (c, a) => nackOr(score.resetLayout(a?.actor || 'ws')));
  H('score.source', (c, a) => nackOr(score.setSource(a?.source, a?.actor || 'ws')));

  // ── 模块 F：比赛计分 / 选曲 ──
  H('match.start', (c, a) => {
    const r = match.start(a || {}, a?.actor || 'ws');
    if (r.ok) score.setSource('match', a?.actor || 'ws');
    return nackOr(r);
  });
  H('match.name', (c, a) => nackOr(match.setName(a?.name, a?.actor || 'ws')));
  H('match.upcoming', (c, a) => nackOr(match.setUpcoming(a?.name, a?.actor || 'ws')));
  H('match.mode', (c, a) => nackOr(match.setMode(a?.mode, a?.actor || 'ws')));
  H('match.song', (c, a) => nackOr(match.setSong(a?.index, a || {}, a?.actor || 'ws')));
  H('match.score', (c, a) => nackOr(match.setScore(a?.index, a?.side, a?.value, a?.actor || 'ws')));
  H('match.current', (c, a) => nackOr(match.setCurrent(a?.index)));
  H('match.clearRow', (c, a) => nackOr(match.clearRow(a?.index, a?.actor || 'ws')));
  H('match.random', (c, a) => nackOr(match.randomPick(a || {}, a?.actor || 'ws')));
  H('match.ban', (c, a) => nackOr(match.ban(a?.musicId, a?.banned !== false, a?.actor || 'ws')));
  H('match.clearBans', (c, a) => nackOr(match.clearBans(a?.actor || 'ws')));
  H('match.finish', (c, a) => nackOr(match.finish(a?.actor || 'ws')));
  H('match.resetSeq', (c, a) => nackOr(match.resetRoundSeq(a?.next ?? a?.start ?? 1, a?.actor || 'ws')));
  H('match.pickApply', (c, a) => nackOr(match.applyPick(a?.id, a?.index ?? null, a?.actor || 'ws')));
  H('random.spin', (c, a) => nackOr(randomScene.spin(a?.filters || a || {}, a?.actor || 'ws')));
  H('random.clear', (c, a) => nackOr(randomScene.clear(a?.actor || 'ws')));
  H('match.pickDismiss', (c, a) => nackOr(match.dismissPick(a?.id, a?.actor || 'ws')));

  // ── 配置测试（设置页的按钮也走这里，页面无需自己 fetch） ──
  H('config.test.vmix', async () => vmix.probe({}));
  H('config.test.obs', async () => {
    if (!getConfig().features.obs) {
      return { ok: false, error: 'OBS 控制未启用：请先在上面勾选「OBS 控制」并保存，保存后会自动连接' };
    }
    return obs.isConnected()
      ? { ok: true, message: 'OBS 已连接（活动连接）', version: obs.getVersion() }
      : { ok: false, error: obs.getLastError() || '未连接' };
  });

  log.info('server', 'WS 命令已注册', { count: hub.listOps().length });
}

/** 把 { ok:false, nack } 转成 hub 认识的 { __nack } 形状 */
function nackOr(r) {
  if (r && r.ok === false) return { __nack: r.nack?.code || 'error', msg: r.nack?.msg || '操作失败' };
  return r === undefined ? { ok: true } : r;
}

// ═══════════════════════════════════════════════════════════════
// 7. 启动各模块的后台任务
// ═══════════════════════════════════════════════════════════════
// 功能开关：默认全关 —— 只启动被显式启用的模块（见 applyFeatures）
applyFeatures();
// 解说页的显示模板（非敏感），随 hello 一起下发；OBS 浏览器源无法登录读取 /api/config
set('config.cast', structuredClone(getConfig().cast || {}));
// OBS 输出配色主题：同样随 hello 下发，渲染源无需登录即可换色
set('config.theme', structuredClone(getConfig().theme || {}));
// 待机画面文案：整屏场景由 OBS 直接打开，不能要求登录，所以也镜像进共享状态
set('config.standby', structuredClone(getConfig().standby || {}));
templates.startWatch();

log.info('server', '全部模块已启动', {
  overlay: `http://127.0.0.1:${cfg.server.overlayPort}`,
  control: `http://127.0.0.1:${cfg.server.controlPort}`,
  features: getConfig().features,
  obs: getConfig().features.obs ? `ws://${cfg.obs.host}:${cfg.obs.port}` : '未启用',
  vmix: getConfig().features.vmix ? `http://${cfg.vmix.host}:${cfg.vmix.port}` : '未启用',
  adminAuth: adminAuthEnabled() ? '已启用（需登录密码）' : '未启用（局域网信任模式）',
});

// 后台鉴权未启用且监听非回环地址时，明确告警
if (!adminAuthEnabled() && cfg.server.host !== '127.0.0.1' && cfg.server.host !== 'localhost') {
  log.warn('server', '⚠ 未设置登录密码且监听非回环地址：控制接口无鉴权，切勿把本机暴露到公网', {
    hint: '用 tools/set-admin-password.mjs 设置后台密码，或设置环境变量 LP_ADMIN_TOKEN，重启后生效',
  });
}

// 启动自检结果写日志（B-REQ-305）
setTimeout(async () => {
  try {
    const checks = await runStartupCheck();
    set('config.errors', getConfigErrors());
    for (const c of checks) {
      (c.level === 'error' ? log.error : c.level === 'warn' ? log.warn : log.info)('server', `[启动预检] ${c.name}：${c.msg}`, { hint: c.hint, level: c.level });
    }
  } catch (e) {
    log.warn('server', '启动预检异常', { err: e.message });
  }
}, 2500).unref?.();

async function runStartupCheck() {
  const out = [];
  const cf = getConfig();
  const cfgErrors = getConfigErrors();
  out.push({
    name: '配置 schema',
    level: Object.keys(cfgErrors).length ? 'error' : 'ok',
    msg: Object.keys(cfgErrors).length ? `有 ${Object.keys(cfgErrors).length} 处问题，已回退默认值` : '通过',
    hint: JSON.stringify(cfgErrors),
  });
  const f = cf.features || {};
  if (f.obs) {
    out.push({ name: 'OBS 连接', level: obs.isConnected() ? 'ok' : 'warn', msg: obs.isConnected() ? '已连接' : (obs.getLastError() || '未连接'), hint: '上屏类动作将不可用；裁切不受影响（B-REQ-528）' });
  } else {
    out.push({ name: 'OBS 连接', level: 'ok', msg: '未启用（设置 → 功能开关）', hint: '开启后会立即连接，无需重启' });
  }
  if (f.vmix) {
    out.push({ name: 'vMix 连接', level: vmix.isConnected() ? 'ok' : 'warn', msg: vmix.isConnected() ? `RTT ${vmix.getStatus().rttMs}ms` : (vmix.getStatus().lastErr || '不可达'), hint: `http://${cf.vmix.host}:${cf.vmix.port}/api/` });
  } else {
    out.push({ name: 'vMix 连接', level: 'ok', msg: '未启用（设置 → 功能开关）', hint: '回放需要先开启 vMix 控制' });
  }
  out.push({ name: '模板 / 媒体 / 实体', level: 'ok', msg: `${templates.all().length} 模板 / ${media.stats().count} 媒体 / ${entities.stats().total} 实体` });
  return out;
}

// ═══════════════════════════════════════════════════════════════
// 8. 优雅退出（B-NFR-06：进程重启后 ≤5s 恢复可用，不产生残留指令）
// ═══════════════════════════════════════════════════════════════
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('server', `收到 ${signal}，正在关闭…`, { uptimeMs: Date.now() - STARTED_AT });

  try { replay.stopPolling(); } catch { /* ignore */ }
  try { match.shutdown(); } catch { /* ignore */ }
  try { lottery.shutdown(); } catch { /* ignore */ }
  try { cnMusic.shutdown(); } catch { /* ignore */ }
  try { transitions.stopPolling(); } catch { /* ignore */ }
  try { vmix.stopHeartbeat(); } catch { /* ignore */ }
  try { templates.stopWatch(); } catch { /* ignore */ }
  try { countdown.cancelAll(); } catch { /* ignore */ }
  try { hub.closeAll(); } catch { /* ignore */ }
  try { obs.stop(); } catch { /* ignore */ }

  for (const { server, port } of servers) {
    try { server.close(); } catch { /* ignore */ }
    log.debug('server', `已关闭端口 ${port}`);
  }
  setTimeout(() => process.exit(0), 400).unref?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => {
  // G-REQ-112：单个模块的未捕获异常绝不能拖垮整个控制台
  log.error('server', '未捕获异常（进程继续运行）', { err: e.message, stack: String(e.stack).split('\n').slice(0, 6).join(' | ') });
});
process.on('unhandledRejection', (e) => {
  log.error('server', '未处理的 Promise 拒绝（进程继续运行）', { err: String(e?.message || e) });
});

// ═══════════════════════════════════════════════════════════════
// 内联页面
// ═══════════════════════════════════════════════════════════════

function notFoundPage(what) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>页面尚未就绪</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0d12;color:#e6e9f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{max-width:520px;padding:32px;border:1px solid #232838;border-radius:14px;background:#12151d;text-align:center}
code{background:#1b1f2b;padding:2px 6px;border-radius:5px}a{color:#69a7ff}</style></head>
<body><div class="card"><h2>页面尚未就绪</h2><p><code>${String(what).replace(/[<>&]/g, '')}</code> 还没有对应的前端文件。</p>
<p><a href="/">← 返回导航首页</a></p></div></body></html>`;
}

function pathGet(obj, p) { return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }

export { app, servers };
