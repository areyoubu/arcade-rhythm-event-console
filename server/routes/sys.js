/**
 * 共享壳层 —— 系统 / 健康 / 日志 / 自检 HTTP API。
 * 需求：S-REQ-201~205（日志与审计）、B-REQ-305（启动预检）、附录 C（开播检查清单）
 */
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { getConfig, getConfigMeta, ROOT, DEFAULT_CONFIG } from '../config.js';
import { getState } from '../state.js';
import * as log from '../logger.js';
import * as hub from '../ws-hub.js';
import * as obs from '../obs.js';
import * as vmix from '../vmix/client.js';
import * as templates from '../templates.js';
import * as entities from '../entities.js';
import * as media from '../media.js';
import { VMIX_FUNCTIONS, NEEDS_CHANNEL, TO_OUTPUT } from '../vmix/functions.js';
import * as transitions from '../transitions.js';

const STARTED_AT = Date.now();

export default function sysRoutes() {
  const r = express.Router();

  r.get('/health', (req, res) => {
    res.json({
      ok: true,
      uptimeMs: Date.now() - STARTED_AT,
      startedAt: STARTED_AT,
      version: '1.0.0',
      links: getState().health,
      renderers: hub.getRenderers().length,
      clients: hub.getClients().length,
      config: { file: getConfigMeta().file, errors: getConfigMeta().errors },
    });
  });

  /** 完整自检 —— 首页「系统自检」卡片 + 启动日志用 */
  r.get('/selfcheck', async (req, res) => {
    const checks = await runSelfCheck();
    res.json({ ok: checks.every((c) => c.level !== 'error'), checks });
  });

  r.get('/ops', (req, res) => {
    res.json({ ok: true, ops: hub.listOps() });
  });

  // ── 日志 S-REQ-203 ──
  r.get('/logs/recent', (req, res) => {
    const { limit, source, level, since } = req.query;
    res.json({ ok: true, items: log.recent(limit ? Number(limit) : 200, { source, level, since: since ? Number(since) : undefined }) });
  });

  r.get('/logs/query', async (req, res) => {
    const { from, to, level, source, limit } = req.query;
    const items = await log.query({
      from: from ? Number(from) : undefined,
      to: to ? Number(to) : undefined,
      level, source, limit: limit ? Number(limit) : 500,
    });
    res.json({ ok: true, items, count: items.length });
  });

  r.get('/logs/files', (req, res) => {
    res.json({ ok: true, files: log.listLogFiles().map((f) => ({ name: path.basename(f), size: safeSize(f) })) });
  });

  /** 网络操作日志（单独文件 logs/network-*.jsonl 的内存最近缓冲） */
  r.get('/logs/network', (req, res) => {
    const limit = Number(req.query.limit) || 300;
    res.json({ ok: true, items: log.networkRecent(Math.min(1000, limit)), files: log.listNetworkFiles() });
  });

  // ── 配置文件位置与目录（设置页「数据」区） ──
  r.get('/paths', (req, res) => {
    const cfg = getConfig();
    const abs = (p) => (path.isAbsolute(p || '') ? p : path.join(ROOT, p || ''));
    res.json({
      ok: true,
      root: ROOT,
      paths: {
        config: getConfigMeta().file,
        entities: abs(cfg.entities.file),
        media: abs(cfg.media.dir),
        templatesBuiltin: abs(cfg.templates.builtinDir),
        templatesCustom: abs(cfg.templates.customDir),
        logs: path.join(ROOT, 'logs'),
        data: path.join(ROOT, 'data'),
      },
    });
  });

  /** 开播检查清单（附录 C）—— 能程序检测的自动检测，检测不了的明确标注「须人工确认」 */
  r.get('/checklist', async (req, res) => {
    const cfg = getConfig();
    const st = getState();
    const items = [];

    const add = (id, name, status, detail, manual = false) => items.push({ id, name, status, detail, manual });

    // 功能开关关闭的设备不参与检查 —— 否则「未启用」会被误报成「无响应」
    const feats = cfg.features || {};

    // 程序可检测
    add(1, 'vMix HTTP API 可达', !feats.vmix ? 'ok' : (vmix.isConnected() ? 'ok' : 'error'),
      !feats.vmix ? '未启用（设置 → 功能开关）' : (vmix.isConnected() ? `RTT ${vmix.getStatus().rttMs}ms` : (vmix.getStatus().lastErr || '无响应')));
    add(2, 'OBS WebSocket 已连接', !feats.obs ? 'ok' : (obs.isConnected() ? 'ok' : 'error'),
      !feats.obs ? '未启用（设置 → 功能开关）' : (obs.isConnected() ? `obs-websocket ${obs.getVersion()?.obsWebSocketVersion || '?'}` : (obs.getLastError() || '无响应')));
    add(3, 'OBS 场景齐全', !feats.obs ? 'ok' : (() => {
      const scenes = st.health.obs.scenes || [];
      if (!scenes.length) return 'unknown';
      const missing = [cfg.scenes.live, cfg.scenes.replay, cfg.scenes.clean].filter((s) => !scenes.includes(s));
      return missing.length ? 'error' : 'ok';
    })(), !feats.obs ? '未启用（设置 → 功能开关）' : (() => {
      const scenes = st.health.obs.scenes || [];
      if (!scenes.length) return '未取到场景列表';
      const missing = [cfg.scenes.live, cfg.scenes.replay, cfg.scenes.clean].filter((s) => !scenes.includes(s));
      return missing.length ? `缺少：${missing.join('、')}` : `${cfg.scenes.live} / ${cfg.scenes.replay} / ${cfg.scenes.clean} 均存在`;
    })());
    add(4, '浮窗渲染端已连接', hub.getRenderers().length > 0 ? 'ok' : 'warn',
      `已连接 ${hub.getRenderers().length} 个渲染端（预期 2 个：浮窗-主 / 浮窗-致谢）`);
    add(5, 'vMix 回放录制中', !feats.replay ? 'ok' : (st.replay.recording ? 'ok' : 'warn'),
      !feats.replay ? '未启用（设置 → 功能开关）' : (st.replay.recording ? 'recording=true' : 'recording=false'));
    add(6, '回溯量在缓冲容量内', cfg.clip.defaultLookbackMs <= cfg.clip.maxLookbackMs ? 'ok' : 'error',
      `默认 ${cfg.clip.defaultLookbackMs / 1000}s / 上限 ${cfg.clip.maxLookbackMs / 1000}s（R10 须实测回填）`);
    add(7, '模板表加载正常', templates.stats().total > 0 ? 'ok' : 'error',
      `${templates.stats().total} 个模板（内置 ${templates.stats().builtin} / 覆盖 ${templates.stats().overridden} / 自定义 ${templates.stats().custom}）`);
    add(8, '媒体库索引正常', 'ok', `${media.stats().count} 项${media.stats().degraded ? ' · ⚠️ ' + media.stats().degradedNote : ''}`);
    add(9, '实体库正常', 'ok', `${entities.stats().total} 个实体`);
    // 监看改由 OBS 浏览器源 + NDI/HDMI 输出，这里改为核验「提示页面是否已接入」
    add(10, '导播端 / 解说端已接入',
      (st.cue.counts?.director ?? 0) + (st.cue.counts?.cast ?? 0) > 0 ? 'ok' : 'warn',
      `导播 ${st.cue.counts?.director ?? 0} · 解说 ${st.cue.counts?.cast ?? 0}`
      + '（把 /director 与 /cast 作为 OBS 浏览器源加入场景，再用 NDI 或 HDMI 送到监视器）');
    add(11, 'vMix 函数表完整', VMIX_FUNCTIONS.length === 151 ? 'ok' : 'error',
      `${VMIX_FUNCTIONS.length}/151 · 需选通道 ${NEEDS_CHANNEL.length} 个 · 上屏类 ${TO_OUTPUT.length} 个`);
    add(12, '场景转场覆盖无漂移', !feats.transitions ? 'ok' : ((st.transitions.drift || []).length === 0 ? 'ok' : 'warn'),
      !feats.transitions ? '未启用（设置 → 功能开关）'
        : ((st.transitions.drift || []).length ? `与配置不一致：${(st.transitions.drift || []).map((d) => d.scene).join('、')}` : '与配置一致'));

    // ── 附录 C 清单里原本标注「无法程序检测」的项目 ──
    // 其中相当一部分其实可以通过 obs-websocket 只读查出来，这里就地把它们从
    // 「须人工确认」升级为「自动核验」，减少现场漏配。
    const setup = obs.isConnected() ? await obs.inspectSetup(cfg).catch(() => null) : null;

    if (setup) {
      const main = setup.browserSources.find((b) => b.name === '浮窗-主');
      const cred = setup.browserSources.find((b) => b.name === '浮窗-致谢');

      // M1：浏览器源的 shutdown / restart_when_active（G-REQ-204）
      // 区分「确实配错了」（error）与「读不出来」（warn，请人工确认）——
      // 把后者报成 error 会让人在开播前误以为系统坏了。
      const bsErrors = [];
      const bsUnknown = [];
      let bsVerified = 0;
      for (const b of setup.browserSources) {
        if (!b.exists) { bsUnknown.push(`源「${b.name}」不存在 —— 请确认浏览器源已按附录 C 命名`); continue; }
        if (!b.settings) { bsUnknown.push(`源「${b.name}」设置读取失败（${b.error || '该 OBS 版本可能不支持 GetInputSettings'}），请手动确认`); continue; }
        bsVerified++;
        if (b.settings.shutdown === true) bsErrors.push(`「${b.name}」shutdown=true —— 必须为 false，否则源隐藏时 CEF 退出、再显示时重连丢状态`);
        if (b.settings.restart_when_active === true) bsErrors.push(`「${b.name}」restart_when_active=true —— 必须为 false`);
        if (b.settings.url && !/\/render\/(main|credits)/.test(b.settings.url)) {
          bsErrors.push(`「${b.name}」的 URL 不是 /render/*（当前 ${b.settings.url}）`);
        }
      }
      add('M1', 'OBS 浏览器源 shutdown=false / restart_when_active=false',
        bsErrors.length ? 'error' : (bsVerified ? 'ok' : 'warn'),
        bsErrors.length ? bsErrors.join('；')
          : (bsVerified ? `${bsVerified} 个浮窗源已核验：shutdown / restart_when_active 均为 false（A-REQ-002 / G-REQ-204）`
            : bsUnknown.join('；')),
        !bsVerified && !bsErrors.length);

      const resProblems = [];
      for (const b of [main, cred]) {
        if (b?.settings?.width && b.settings.width !== cfg.render.canvas.width) resProblems.push(`${b.name} 宽度 ${b.settings.width} ≠ 画布 ${cfg.render.canvas.width}`);
        if (b?.settings?.height && b.settings.height !== cfg.render.canvas.height) resProblems.push(`${b.name} 高度 ${b.settings.height} ≠ 画布 ${cfg.render.canvas.height}`);
      }
      add('M1b', '浏览器源分辨率与画布一致', resProblems.length ? 'warn' : (main?.settings ? 'ok' : 'unknown'),
        resProblems.length ? resProblems.join('；') : (main?.settings ? `${cfg.render.canvas.width}×${cfg.render.canvas.height}` : '未能读取浏览器源设置'));

      // M6：CLEAN 场景上的 NDI Dedicated Output 滤镜（G-REQ-103，陷阱 #1）
      const ndiFilter = setup.filters.find((f) => f.enabled
        && (/ndi/i.test(f.typeDisplay) || /ndi/i.test(f.kind))
        && /(output|dedicated)/i.test(`${f.typeDisplay} ${f.kind} ${f.name}`));
      const cleanEmpty = setup.cleanItems.length === 0;
      add('M6', 'NDI Dedicated Output 滤镜挂在 CLEAN 场景上',
        ndiFilter ? 'ok' : (cleanEmpty ? 'unknown' : 'warn'),
        ndiFilter
          ? `已挂载：${ndiFilter.name}（${ndiFilter.typeDisplay || ndiFilter.kind}）`
          : (cleanEmpty
            ? `CLEAN 场景当前没有任何源 —— 可能尚未搭建完成。按 SRS §3.4，CLEAN 里应有游戏采集 + 选手摄像头，并挂上 NDI Dedicated Output 滤镜`
            : `CLEAN 场景上未找到已启用的 NDI 输出滤镜（现有滤镜：${setup.filters.map((f) => `${f.name}[${f.typeDisplay || f.kind}]`).join('、') || '无'}）。`
              + '⚠️ 必须用「源 → 滤镜 → NDI Dedicated Output」，**不得**用「工具 → NDI 输出设置」的主输出，否则会形成无限镜像循环'),
        !ndiFilter && !cleanEmpty);

      // M7：浮窗不得放进 CLEAN（G-REQ-104，陷阱 #5）
      const leaked = setup.cleanItems.filter((i) => i.enabled && /浮窗|render/.test(i.source));
      add('M7', '浮窗源未放进 CLEAN 场景', leaked.length ? 'error' : 'ok',
        leaked.length
          ? `★ CLEAN 场景里有浮窗源：${leaked.map((x) => x.source).join('、')} —— 回放画面会被烧录浮窗，且出现两层浮窗`
          : `CLEAN 场景共 ${setup.cleanItems.length} 个源，无浮窗`);

      // M3 的一半：vMix 回传 NDI 的音频应关闭（video-only 原则）
      if (setup.replayAudio) {
        const a = setup.replayAudio;
        const audioOff = a.muted === true || (a.tracks && Object.values(a.tracks).every((v) => v === false));
        add('M3b', 'vMix 回传 NDI 源的音频已关闭', audioOff ? 'ok' : 'warn',
          `源「${a.input}」：muted=${a.muted}，音轨=${a.tracks ? JSON.stringify(a.tracks) : '未知'}（video-only 原则，避免直播音画偏移）`);
      } else {
        add('M3b', 'vMix 回传 NDI 源的音频已关闭', 'unknown', `未在 OBS 中找到名为「${cfg.sources.replayNdi}」的输入`);
      }
    } else {
      add('M1', 'OBS 浏览器源 shutdown=false / restart_when_active=false', 'unknown',
        'OBS 未连接，无法自动核验。请在 OBS 源属性中手动确认：shutdown 取消勾选、restart_when_active 取消勾选', true);
      add('M6', 'NDI Dedicated Output 滤镜挂在 CLEAN 场景上', 'unknown', 'OBS 未连接，无法自动核验', true);
      add('M7', '浮窗源未放进 CLEAN 场景', 'unknown', 'OBS 未连接，无法自动核验', true);
    }

    // ── 确实无法通过 API 检测的（附录 C 保留项）──
    add('M2', 'NDI 链路正常（帧率 / 分辨率 / 逐行一致）', 'manual',
      '⚠️ OBS 画布 / NDI 输出 / vMix 回放会话三者格式必须完全一致（含 59.94 vs 60）。'
      + 'obs-websocket 看不到 NDI 会话格式，须在 vMix 的回放输入属性里目视核对', true);
    add('M3', 'vMix Output 2 = 回放源且已开 NDI', 'manual', '请在 vMix 设置 → Outputs 中确认', true);
    add('M4', 'vMix 回放输出转场 = Cut', 'manual', '⚠️ vMix 不做任何可见转场，唯一的可见转场交给 OBS（§5.14）', true);
    add('M5', 'stinger 的 Transition Point 已手动设置', 'manual',
      '✅ obs-websocket **无法**修改该属性（B-REQ-1103），必须在 OBS 里手动设在不透明区正中', true);
    add('M8', '制作机未安装 VPN / Tailscale', 'manual', '✅ 官方明确警告会破坏 NDI 发现（G-REQ-203）', true);
    add('M9', 'Windows 网络配置文件为「专用网络」', 'manual', '「公用」会导致 NDI 源不出现 / 黑屏（G-REQ-201）', true);
    add('M10', 'vMix 8088 未暴露到公网', 'manual', '✅ vMix HTTP API 无鉴权；须用防火墙限定远程 IP（B-REQ-1005）', true);

    res.json({
      ok: true,
      items,
      summary: {
        ok: items.filter((i) => i.status === 'ok').length,
        warn: items.filter((i) => i.status === 'warn').length,
        error: items.filter((i) => i.status === 'error').length,
        unknown: items.filter((i) => i.status === 'unknown').length,
        manual: items.filter((i) => i.manual).length,
      },
    });
  });

  /** 默认配置（设置页「恢复默认」前的预览） */
  r.get('/defaults', (req, res) => res.json({ ok: true, defaults: DEFAULT_CONFIG }));

  return r;
}

async function runSelfCheck() {
  const checks = [];
  const push = (name, level, msg, hint) => checks.push({ name, level, msg, hint });

  const cfgMeta = getConfigMeta();
  if (Object.keys(cfgMeta.errors || {}).length) {
    push('配置校验', 'error', `config.json 有 ${Object.keys(cfgMeta.errors).length} 处问题`, JSON.stringify(cfgMeta.errors));
  } else {
    push('配置校验', 'ok', 'config.json 通过 schema 校验');
  }

  push('vMix API', vmix.isConnected() ? 'ok' : 'warn',
    vmix.isConnected() ? `可达（RTT ${vmix.getStatus().rttMs}ms）` : `${vmix.getStatus().lastErr || '不可达'} —— 回放功能不可用`,
    `目标 http://${getConfig().vmix.host}:${getConfig().vmix.port}/api/`);

  push('OBS WebSocket', obs.isConnected() ? 'ok' : 'warn',
    obs.isConnected() ? '已连接' : `${obs.getLastError() || '未连接'} —— 上屏类动作不可用（裁切仍可用）`,
    `目标 ws://${getConfig().obs.host}:${getConfig().obs.port}`);


  push('模板表', templates.all().length ? 'ok' : 'error', `${templates.all().length} 个模板`);
  push('媒体库', 'ok', `${media.stats().count} 项${media.stats().degraded ? '（已降级）' : ''}`);
  push('vMix 函数表', VMIX_FUNCTIONS.length === 151 ? 'ok' : 'error', `${VMIX_FUNCTIONS.length}/151`);

  const ov = await transitions.ensureFallbackTransition().catch((e) => ({ ok: false, msg: e.message }));
  push('回放入场转场', ov.ok ? (ov.degraded ? 'warn' : 'ok') : 'error',
    ov.ok ? `使用「${ov.transition}」${ov.degraded ? '（stinger 不可用，已降级为 Fade + ≥600ms）' : ''}` : ov.msg);

  return checks;
}

function safeSize(f) { try { return fs.statSync(f).size; } catch { return 0; } }
