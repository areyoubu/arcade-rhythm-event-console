#!/usr/bin/env node
/**
 * Edge / Agent 本地图形配置台。
 *
 * 只监听 127.0.0.1，不对外网开放；用于：
 *   · 可视化编辑 edge.config.json / agent.config.json（含字段说明与校验）；
 *   · 一键生成随机密钥；
 *   · 启动 / 停止 / 重启 Edge、Agent、主控，并查看实时日志；
 *   · 展示密钥规则、配对步骤和当前隧道状态。
 *
 * 用法：
 *   node remote/setup.mjs --role=edge  [--config 路径] [--port 8788] [--no-open] [--auto-start]
 *   node remote/setup.mjs --role=agent [--config 路径] [--port 8789] [--no-open] [--auto-start]
 *
 * 安全：
 *   · 仅绑定 127.0.0.1；
 *   · 校验 Host（防 DNS rebinding）；
 *   · 所有 POST 需要启动时生成的一次性 setup token（页面里内嵌，跨站拿不到）；
 *   · 无 CORS，不接受跨站预检。
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { json, securityHeaders } from './common.mjs';
import { DEFAULT_CONFIG as EDGE_DEFAULT, validateConfig as validateEdge } from './edge.mjs';
import { DEFAULT_CONFIG as AGENT_DEFAULT, validateConfig as validateAgent } from './agent.mjs';

const REMOTE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(REMOTE_DIR, '..');
const MAX_BODY = 256 * 1024;
const TOKEN_BYTES = 32;

// ───────────────────────── 字段定义 ─────────────────────────

const EDGE_FIELDS = [
  {
    key: 'host', group: '基础', label: '监听地址', type: 'text', placeholder: '0.0.0.0',
    help: '公网机器一般填 0.0.0.0；只允许本机访问时填 127.0.0.1。',
  },
  {
    key: 'port', group: '基础', label: '公网端口', type: 'number', min: 1, max: 65535, step: 1,
    help: '路由器 / 云安全组把 TCP 这个端口转发到本机。主控的 3000 / 3001 不要映射出去。',
  },
  {
    key: 'agentToken', group: '密钥', label: 'Agent 隧道密钥', type: 'password',
    secret: true, generate: true, required: true,
    help: '与内网 Agent 的 token 必须逐字符完全一致。建议用右侧「生成」，然后整串复制到 Agent 的配置台。',
  },
  {
    key: 'tlsCert', group: 'TLS 与代理', label: 'TLS 证书路径', type: 'text',
    placeholder: 'C:\\certs\\fullchain.pem',
    help: '可选，PEM 证书绝对路径。与私钥必须同时填写；放在 Caddy / nginx 后面时留空。',
  },
  {
    key: 'tlsKey', group: 'TLS 与代理', label: 'TLS 私钥路径', type: 'text',
    placeholder: 'C:\\certs\\privkey.pem',
    help: '可选，PEM 私钥绝对路径。与证书必须同时填写。',
  },
  {
    key: 'trustProxy', group: 'TLS 与代理', label: '信任前置代理', type: 'checkbox',
    help: '只有确实放在 Cloudflare / Caddy / nginx 后面才打开。直连公网时打开会让访客伪造 X-Forwarded-For。',
  },
  {
    key: 'rateGeneral', group: '限流与防护', label: '普通请求 / 窗口', type: 'number',
    min: 0, max: 1000000, step: 1,
    help: '每个 IP 在一个窗口内最多访问多少次页面 / 公共接口。0 = 不限制（不推荐）。',
  },
  {
    key: 'rateJoin', group: '限流与防护', label: '签到请求 / 窗口', type: 'number',
    min: 0, max: 1000000, step: 1,
    help: '每个 IP 的签到提交上限。默认 10 次 / 分钟。',
  },
  {
    key: 'ratePick', group: '限流与防护', label: '选曲请求 / 窗口', type: 'number',
    min: 0, max: 1000000, step: 1,
    help: '每个 IP 的选曲提交上限。默认 30 次 / 分钟。',
  },
  {
    key: 'rateWindowMs', group: '限流与防护', label: '限流窗口（毫秒）', type: 'number',
    min: 1000, max: 3600000, step: 1000,
    help: '默认 60000（1 分钟）。三个限流共用这个窗口。',
  },
  {
    key: 'maxBodyBytes', group: '限流与防护', label: '请求体上限（字节）', type: 'number',
    min: 1024, max: 1048576, step: 1024,
    help: '超过直接 413。签到 / 选曲 JSON 很小，32KB 足够。',
  },
  {
    key: 'maxResponseBytes', group: '限流与防护', label: '响应上限（字节）', type: 'number',
    min: 1024, max: 10485760, step: 1024,
    help: '主控返回超过这个大小会被 Edge 拒绝，防止误把大文件代理出去。',
  },
  {
    key: 'timeoutMs', group: '限流与防护', label: '隧道超时（毫秒）', type: 'number',
    min: 1000, max: 120000, step: 500,
    help: '公网请求经 Agent 转给主控的最长等待时间，超时返回 504。',
  },
  {
    key: 'maxInflight', group: '限流与防护', label: '并发请求上限', type: 'number',
    min: 1, max: 100000, step: 1,
    help: '同时等待主控响应的请求数上限，超出立即 503，避免把内网打满。',
  },
  {
    key: 'maxConnections', group: '限流与防护', label: 'TCP 连接上限', type: 'number',
    min: 1, max: 1000000, step: 1,
    help: 'Edge 同时保持的连接数上限。现场几百人扫码，512 足够。',
  },
  {
    key: 'heartbeatMs', group: '高级', label: '心跳间隔（毫秒）', type: 'number',
    min: 5000, max: 300000, step: 1000,
    help: 'Edge 与 Agent 的保活间隔；超过一个间隔没有 pong 会断开重连。',
  },
  {
    key: 'blockIps', group: '高级', label: '封禁 IP', type: 'list',
    help: '逗号或换行分隔。命中的 IP 直接 403。留空表示不封禁。',
  },
  {
    key: 'quiet', group: '高级', label: '安静模式', type: 'checkbox',
    help: '不打印每个请求的访问日志，只保留启动 / 错误信息。',
  },
];

const AGENT_FIELDS = [
  {
    key: 'edgeUrl', group: '基础', label: 'Edge 隧道地址', type: 'text', required: true,
    placeholder: 'wss://event.example.com/tunnel',
    help: '只支持 ws:// 或 wss://，且必须以 /tunnel 结尾。有域名和证书用 wss://；纯 IP 暂无证书时只能 ws://。',
  },
  {
    key: 'localUpstream', group: '基础', label: '本地主控地址', type: 'text', required: true,
    placeholder: 'http://127.0.0.1:3000',
    help: '主控服务地址。Agent 和主控在同一台机器时通常是 http://127.0.0.1:3000。',
  },
  {
    key: 'token', group: '密钥', label: 'Edge 隧道密钥', type: 'password',
    secret: true, generate: true, required: true,
    help: '必须与公网 Edge 的 agentToken 逐字符一致。最稳的做法：在 Edge 配置台生成，然后整串复制到这里。',
  },
  {
    key: 'remoteToken', group: '密钥', label: '真实客户端 IP 密钥', type: 'password',
    secret: true, generate: true,
    help: '必须与主控环境变量 LP_REMOTE_TOKEN 一致。留空时主控会把所有公网访客都看成 127.0.0.1，限流会误伤。',
  },
  {
    key: 'tlsInsecure', group: 'TLS 与代理', label: '跳过证书校验', type: 'checkbox', danger: true,
    help: '只用于本地调试自签证书。公网必须关闭，否则任何人都能中间人冒充 Edge。',
  },
  {
    key: 'concurrency', group: '限流与防护', label: '本地并发上限', type: 'number',
    min: 1, max: 1000, step: 1,
    help: 'Agent 同时向主控转发多少请求。建议 16–64。',
  },
  {
    key: 'timeoutMs', group: '限流与防护', label: '上游超时（毫秒）', type: 'number',
    min: 1000, max: 120000, step: 500,
    help: 'Agent 等待主控响应的最长时间。',
  },
  {
    key: 'maxBodyBytes', group: '限流与防护', label: '请求体上限（字节）', type: 'number',
    min: 1024, max: 1048576, step: 1024,
    help: '与 Edge 保持一致即可。',
  },
  {
    key: 'maxResponseBytes', group: '限流与防护', label: '响应上限（字节）', type: 'number',
    min: 1024, max: 10485760, step: 1024,
    help: '与 Edge 保持一致即可。',
  },
  {
    key: 'reconnectMinMs', group: '高级', label: '重连最小间隔（毫秒）', type: 'number',
    min: 200, max: 60000, step: 100,
    help: '断线后的首次重连等待，之后指数退避。',
  },
  {
    key: 'reconnectMaxMs', group: '高级', label: '重连最大间隔（毫秒）', type: 'number',
    min: 200, max: 300000, step: 500,
    help: '指数退避的上限。',
  },
  {
    key: 'quiet', group: '高级', label: '安静模式', type: 'checkbox',
    help: '不打印每次请求的转发日志。',
  },
];

// ───────────────────────── 密钥规则 ─────────────────────────

const RULES_COMMON = [
  '两把密钥分工不同：隧道密钥（Edge 的 agentToken = Agent 的 token）只负责 Edge ↔ Agent 的准入；IP 密钥（Agent 的 remoteToken = 主控的 LP_REMOTE_TOKEN）只负责把真实访客 IP 转给主控。不要混用，也不要两把填同一个值。',
  '隧道密钥必须在两台机器上逐字符一致；IP 密钥必须在 Agent 与主控上逐字符一致。差一个字符都会导致连不上或限流失效。',
  '长度至少 24 位，推荐 32 字节随机数（base64url 后 43 位）。本页「生成」按钮使用 crypto.randomBytes(32).toString("base64url")。',
  '字符只用 A–Z a–z 0–9 - _。不要用空格、引号、% ! ^ & | < >，这些字符会让 .bat / 环境变量截断或展开。',
  '密钥一旦泄露立即轮换：先改 Edge 并保存重启，再把同一个新值填到 Agent 并保存重启；改 IP 密钥时，主控和 Agent 都要重启。轮换期间公网入口会有短暂断线。',
  '密钥不要写进 URL、二维码、截图、聊天记录或版本库；配置文件本身就是敏感文件。',
  '公网只开放 Edge 的端口（默认 8790），不要把主控的 3000 / 3001 映射出去；Edge 与主控之间只由 Agent 出站连接。',
  '没有域名和证书时，Edge ↔ Agent 只能走 ws://，密钥在公网链路上是明文。拿到域名后请套 Caddy / nginx / Cloudflare，改用 wss://。',
];

const RULES_EDGE = [
  'agentToken 是 Edge 的唯一准入凭证：没有它（或值不对）的 Agent 无法建立隧道，Edge 会返回 503。',
  '放在 Cloudflare / Caddy / nginx 后面时才把「信任前置代理」打开，并且只信任你自己的代理；直连公网时打开会允许伪造 IP。',
  '启用内置 TLS 必须同时填写证书与私钥；只填一个会拒绝保存。',
  '可以先用「生成」产生隧道密钥，保存后把整串复制到内网 Agent 配置台的「Edge 隧道密钥」里。',
];

const RULES_AGENT = [
  'edgeUrl 必须以 /tunnel 结尾，否则握手会被 Edge 拒绝。',
  'remoteToken 留空不会导致启动失败，但主控会把所有访客当成 127.0.0.1，限流会误伤整场活动 —— 正式使用必须填。',
  '「跳过证书校验」只用于本地自签证书调试；公网开启等于放弃身份验证。',
  '内网端一键启动会同时管理主控与 Agent：先起主控，再把 Agent 的 remoteToken 通过 LP_REMOTE_TOKEN 传给主控。',
];

const STEPS_EDGE = [
  '填写监听端口（默认 8790），确认路由器 / 云安全组已把该 TCP 端口转发到本机。',
  '在「Agent 隧道密钥」点「生成」，保存配置。',
  '点「启动 Edge」，日志出现「等待内网 Agent…」即正常。',
  '把同一串密钥复制到内网 Agent 配置台；Agent 接入后，本页会显示「Agent 已连接」。',
  '把 http(s)://公网IP:8790 填进主控「设置 → 公网签到地址 / 公网选曲地址」。',
];

const STEPS_AGENT = [
  '填写 Edge 的隧道地址，必须以 /tunnel 结尾。',
  '把公网 Edge 配置台生成的隧道密钥粘贴到「Edge 隧道密钥」。',
  '填写 remoteToken，并确保与主控的 LP_REMOTE_TOKEN 完全一致。',
  '保存配置，点「启动主控」，再点「启动 Agent」。',
  'Agent 日志出现「已连接 Edge」/「Agent 就绪」即成功。',
];

// ───────────────────────── 服务定义 ─────────────────────────

const SERVICE_DEFS = {
  edge: {
    label: 'Edge 公网入口',
    note: '公网访客只接触这个进程；它通过隧道把签到 / 选曲请求交给内网 Agent。',
    script: path.join(REMOTE_DIR, 'edge.mjs'),
    cwd: REMOTE_DIR,
  },
  agent: {
    label: 'Agent 隧道',
    note: '主动出站连接 Edge，内网不需要开放任何入站端口。断线会自动重连。',
    script: path.join(REMOTE_DIR, 'agent.mjs'),
    cwd: REMOTE_DIR,
  },
  main: {
    label: '主控服务',
    note: '本体的控制台与 OBS 源。启动时会把 remoteToken 作为 LP_REMOTE_TOKEN 注入。',
    script: path.join(ROOT, 'server', 'index.js'),
    cwd: ROOT,
  },
};

const ROLES = {
  edge: {
    key: 'edge',
    label: '公网端 · Edge',
    short: 'Edge',
    file: path.join(REMOTE_DIR, 'edge.config.json'),
    defaults: EDGE_DEFAULT,
    fields: EDGE_FIELDS,
    rules: [...RULES_EDGE, ...RULES_COMMON],
    steps: STEPS_EDGE,
    services: ['edge'],
    validate: validateEdge,
    guiPort: 8788,
    title: '公网端 · Edge 配置台',
  },
  agent: {
    key: 'agent',
    label: '内网端 · Agent',
    short: 'Agent',
    file: path.join(REMOTE_DIR, 'agent.config.json'),
    defaults: AGENT_DEFAULT,
    fields: AGENT_FIELDS,
    rules: [...RULES_AGENT, ...RULES_COMMON],
    steps: STEPS_AGENT,
    services: ['main', 'agent'],
    validate: validateAgent,
    guiPort: 8789,
    title: '内网端 · Agent 配置台',
  },
};

// ───────────────────────── 工具 ─────────────────────────

function newToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function isLoopbackHost(host) {
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(host || '').trim());
}

function asNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function normalizeList(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[\n,，;；]+/);
  return arr.map((s) => String(s).trim()).filter(Boolean);
}

function coerceField(field, value) {
  if (field.type === 'number') {
    const n = asNumber(value);
    return Number.isFinite(n) ? n : value;
  }
  if (field.type === 'checkbox') return !!value;
  if (field.type === 'list') return normalizeList(value);
  return String(value ?? '').trim();
}

/** 只取已知字段，避免把 GUI 的脏数据写进配置 */
function pickConfig(fields, raw) {
  const out = {};
  for (const f of fields) out[f.key] = coerceField(f, raw?.[f.key]);
  return out;
}

function fieldErrors(fields, cfg) {
  const errors = [];
  for (const f of fields) {
    const v = cfg[f.key];
    if (f.required && String(v ?? '').trim() === '') {
      errors.push({ field: f.key, message: `${f.label}不能为空` });
      continue;
    }
    if (f.type === 'number' && v !== '' && v !== null && v !== undefined) {
      const n = asNumber(v);
      if (!Number.isFinite(n)) {
        errors.push({ field: f.key, message: `${f.label}必须是数字` });
      } else if (f.min != null && n < f.min) {
        errors.push({ field: f.key, message: `${f.label}不能小于 ${f.min}` });
      } else if (f.max != null && n > f.max) {
        errors.push({ field: f.key, message: `${f.label}不能大于 ${f.max}` });
      }
    }
  }
  return errors;
}

function warningsFor(role, cfg) {
  const warnings = [];
  const token = role === 'edge' ? cfg.agentToken : cfg.token;
  if (token && String(token).length < 24) {
    warnings.push('隧道密钥偏短（< 24 位），建议重新生成。');
  }
  if (token && !/^[A-Za-z0-9_-]+$/.test(String(token))) {
    warnings.push('隧道密钥含有 A–Z a–z 0–9 - _ 以外的字符；写进 .bat / 环境变量时可能被截断。');
  }
  if (role === 'edge') {
    if (!cfg.tlsCert && !cfg.trustProxy) {
      warnings.push('未启用 TLS，也未信任前置代理：公网链路是明文。建议有域名后套 Caddy / nginx / Cloudflare。');
    }
    if (cfg.rateGeneral === 0 && cfg.rateJoin === 0 && cfg.ratePick === 0) {
      warnings.push('三项限流都为 0：公网入口没有频率保护。');
    }
  } else {
    if (!String(cfg.remoteToken || '').trim()) {
      warnings.push('remoteToken 为空：主控会把所有公网访客当成 127.0.0.1，限流会误伤。正式使用必须填。');
    }
    if (cfg.tlsInsecure) {
      warnings.push('已开启「跳过证书校验」：只适合本地调试，公网必须关闭。');
    }
    if (/^ws:\/\//i.test(String(cfg.edgeUrl || '')) && !/^ws:\/\/(localhost|127\.0\.0\.1|\[::1\])\//i.test(String(cfg.edgeUrl || ''))) {
      warnings.push('edgeUrl 使用明文 ws:// 连接公网；拿到域名和证书后请改成 wss://。');
    }
    if (!/\/tunnel\/?$/i.test(String(cfg.edgeUrl || ''))) {
      warnings.push('edgeUrl 没有以 /tunnel 结尾，Agent 将无法接入。');
    }
  }
  return warnings;
}

// ───────────────────────── 创建配置台 ─────────────────────────

/**
 * @param {object} options
 * @param {'edge'|'agent'} options.role
 * @param {string} [options.configFile]
 * @param {string} [options.setupToken]
 * @param {boolean} [options.quiet]
 */
export function createSetupServer(options = {}) {
  const role = options.role === 'agent' ? 'agent' : 'edge';
  const def = ROLES[role];
  const cfgFile = path.resolve(options.configFile || def.file);
  const setupToken = options.setupToken || crypto.randomBytes(18).toString('base64url');
  const quiet = !!options.quiet;

  /** @type {Map<string,{child:import('node:child_process').ChildProcess|null, startedAt:number, exitCode:number|null, lastError:string, partial:{stdout:string,stderr:string}}>} */
  const running = new Map();
  for (const id of def.services) {
    running.set(id, {
      id, child: null, startedAt: 0, exitCode: null, lastError: '',
      partial: { stdout: '', stderr: '' },
    });
  }

  const logs = [];
  let logSeq = 0;
  let autoStartNote = '';
  let inAutoStart = false;

  function pushLog(service, stream, text) {
    const line = stripAnsi(text).replace(/\s+$/, '');
    if (!line) return;
    logs.push({ seq: ++logSeq, t: Date.now(), service, stream, text: line.slice(0, 4000) });
    while (logs.length > 800) logs.shift();
    if (!quiet) {
      const prefix = `[setup:${service}]`;
      if (stream === 'stderr') console.error(prefix, line);
      else console.log(prefix, line);
    }
  }

  function pushChunk(state, stream, chunk) {
    const text = chunk.toString('utf8');
    const parts = (state.partial[stream] + text).split(/\r?\n/);
    state.partial[stream] = parts.pop() || '';
    for (const line of parts) pushLog(state.id, stream, line);
  }

  function readConfig() {
    const base = { ...def.defaults };
    if (!fs.existsSync(cfgFile)) return base;
    try {
      const raw = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      return { ...base, ...raw };
    } catch (e) {
      pushLog('setup', 'stderr', `读取配置失败：${e.message}`);
      return base;
    }
  }

  function saveConfig(raw) {
    autoStartNote = '';
    const cfg = pickConfig(def.fields, { ...readConfig(), ...(raw || {}) });
    const errors = fieldErrors(def.fields, cfg);
    if (errors.length) return { ok: false, error: '配置校验未通过', errors };
    let normalized;
    try {
      normalized = def.validate(cfg);
    } catch (e) {
      return { ok: false, error: e.message, errors: [{ field: '', message: e.message }] };
    }
    // Agent 的 remoteToken 不在 validate 里归一化，这里补上
    if (role === 'agent') normalized.remoteToken = String(normalized.remoteToken || '').trim();
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
    const tmp = `${cfgFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, cfgFile);
    try { fs.chmodSync(cfgFile, 0o600); } catch { /* Windows 忽略 */ }
    pushLog('setup', 'stdout', `已保存配置：${cfgFile}`);
    return { ok: true, config: normalized, warnings: warningsFor(role, normalized) };
  }

  function serviceList() {
    return def.services.map((id) => {
      const s = running.get(id);
      return {
        id,
        label: SERVICE_DEFS[id].label,
        note: SERVICE_DEFS[id].note,
        running: !!s.child,
        pid: s.child?.pid || 0,
        startedAt: s.startedAt,
        exitCode: s.exitCode,
        lastError: s.lastError,
      };
    });
  }

  function startService(id) {
    if (!inAutoStart) autoStartNote = '';
    if (!def.services.includes(id)) return { ok: false, status: 404, error: '未知服务' };
    const state = running.get(id);
    if (state.child) return { ok: false, status: 409, error: `${SERVICE_DEFS[id].label}已经在运行` };

    const cfg = readConfig();

    if (id === 'edge' || id === 'agent') {
      const errors = fieldErrors(def.fields, cfg);
      if (errors.length) return { ok: false, status: 400, error: '配置不完整，请先保存有效配置', errors };
      try { def.validate(cfg); } catch (e) { return { ok: false, status: 400, error: e.message }; }
    }

    const env = { ...process.env };
    // 环境变量会覆盖配置文件；清掉旧的 EDGE_* / AGENT_*，让 GUI 保存的配置成为唯一真源
    for (const key of Object.keys(env)) {
      if (/^(EDGE|AGENT)_/.test(key)) delete env[key];
    }
    delete env.LP_REMOTE_TOKEN;

    if (id === 'edge') env.EDGE_CONFIG = cfgFile;
    if (id === 'agent') env.AGENT_CONFIG = cfgFile;
    if (id === 'main') env.LP_REMOTE_TOKEN = String(cfg.remoteToken || '').trim();

    const serviceDef = SERVICE_DEFS[id];
    let child;
    try {
      child = spawn(process.execPath, [serviceDef.script], {
        cwd: serviceDef.cwd,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      state.lastError = e.message;
      return { ok: false, status: 500, error: `启动失败：${e.message}` };
    }

    state.child = child;
    state.startedAt = Date.now();
    state.exitCode = null;
    state.lastError = '';
    state.partial = { stdout: '', stderr: '' };
    pushLog(id, 'stdout', `── 启动 ${serviceDef.label}（pid ${child.pid}）──`);

    child.stdout.on('data', (c) => pushChunk(state, 'stdout', c));
    child.stderr.on('data', (c) => pushChunk(state, 'stderr', c));
    child.on('error', (e) => {
      state.lastError = e.message;
      pushLog(id, 'stderr', `进程错误：${e.message}`);
    });
    child.on('exit', (code, signal) => {
      for (const stream of ['stdout', 'stderr']) {
        if (state.partial[stream]) {
          pushLog(id, stream, state.partial[stream]);
          state.partial[stream] = '';
        }
      }
      state.child = null;
      state.exitCode = code;
      const how = signal ? `signal=${signal}` : `code=${code}`;
      pushLog(id, code === 0 ? 'stdout' : 'stderr', `── ${serviceDef.label} 已退出（${how}）──`);
    });

    return { ok: true, pid: child.pid };
  }

  function stopService(id) {
    autoStartNote = '';
    if (!def.services.includes(id)) return { ok: false, status: 404, error: '未知服务' };
    const state = running.get(id);
    if (!state.child) return { ok: true, alreadyStopped: true };
    const child = state.child;
    const pid = child.pid;
    try { child.kill('SIGTERM'); } catch (e) { state.lastError = e.message; }
    const timer = setTimeout(() => {
      if (state.child === child) {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }, 5000);
    timer.unref?.();
    pushLog(id, 'stdout', `── 正在停止 ${SERVICE_DEFS[id].label}（pid ${pid}）──`);
    return { ok: true, pid };
  }

  function stopAndWait(id, ms = 5000) {
    return new Promise((resolve) => {
      const state = running.get(id);
      if (!state?.child) return resolve();
      const child = state.child;
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(done, ms);
      child.once('exit', done);
      try { child.kill('SIGTERM'); } catch { done(); }
    });
  }

  async function restartService(id) {
    if (!def.services.includes(id)) return { ok: false, status: 404, error: '未知服务' };
    // 不是本配置台启动的进程，无法停止 / 重启；探测到在跑就直接说明
    if (!running.get(id)?.child) {
      if (id === 'edge' && (await probeEdgeHealth(readConfig())).reachable) {
        return { ok: true, alreadyRunning: true, external: true };
      }
      if (id === 'main' && (await probeMain(readConfig()))) {
        return { ok: true, alreadyRunning: true, external: true };
      }
    }
    pushLog(id, 'stdout', `── 重启 ${SERVICE_DEFS[id].label} ──`);
    await stopAndWait(id);
    return startService(id);
  }

  function probeEdgeHealth(cfg) {
    return new Promise((resolve) => {
      const useTls = !!cfg.tlsCert;
      const mod = useTls ? https : http;
      const port = Number(cfg.port) || 8790;
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      const req = mod.get({
        hostname: '127.0.0.1',
        port,
        path: '/healthz',
        timeout: 900,
        rejectUnauthorized: false,
        headers: { host: '127.0.0.1' },
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            done({ reachable: true, agentConnected: !!data.agentConnected, ok: !!data.ok });
          } catch {
            done({ reachable: true, agentConnected: false });
          }
        });
      });
      req.on('timeout', () => { req.destroy(); done({ reachable: false, error: 'timeout' }); });
      req.on('error', (e) => done({ reachable: false, error: e.code || e.message }));
    });
  }

  async function buildState(since = 0) {
    const cfg = readConfig();
    const sinceSeq = Number.isFinite(Number(since)) ? Math.max(0, Math.round(Number(since))) : 0;
    return {
      ok: true,
      role,
      roleLabel: def.label,
      title: def.title,
      configFile: cfgFile,
      configExists: fs.existsSync(cfgFile),
      config: cfg,
      fields: def.fields,
      rules: def.rules,
      steps: def.steps,
      services: serviceList(),
      health: role === 'edge' ? await probeEdgeHealth(cfg) : null,
      logs: { next: logSeq, lines: logs.filter((l) => l.seq > sinceSeq) },
      autoStartNote,
    };
  }

  async function probeMain(cfg) {
    try {
      const base = String(cfg.localUpstream || 'http://127.0.0.1:3000').replace(/\/+$/, '');
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(900) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function autoStart() {
    inAutoStart = true;
    try {
      const notes = [];
      if (role === 'edge') {
        const cfg = readConfig();
        if (!String(cfg.agentToken || '').trim()) {
          autoStartNote = '尚未配置 Agent 隧道密钥，已跳过自动启动。填好并保存后点「启动 Edge」。';
          return;
        }
        const health = await probeEdgeHealth(cfg);
        if (health.reachable) {
          autoStartNote = 'Edge 已经在运行，未重复启动。';
          return;
        }
        const r = startService('edge');
        autoStartNote = r.ok ? '已自动启动 Edge。' : `自动启动失败：${r.error}`;
        return;
      }
      // 内网端：主控先起；Agent 只在配置完整时起
      const cfg = readConfig();
      if (await probeMain(cfg)) {
        notes.push('主控已经在运行，未重复启动。');
      } else {
        const mainRes = startService('main');
        notes.push(mainRes.ok ? '已自动启动主控。' : `主控启动失败：${mainRes.error}`);
      }
      if (!String(cfg.token || '').trim() || !String(cfg.edgeUrl || '').trim()) {
        notes.push('Agent 配置不完整，已跳过自动启动。');
      } else {
        const agentRes = startService('agent');
        notes.push(agentRes.ok ? '已自动启动 Agent。' : `Agent 启动失败：${agentRes.error}`);
      }
      autoStartNote = notes.join(' ');
    } finally {
      inAutoStart = false;
    }
  }

  // ── HTTP ──

  function serveHtml(res) {
    let html;
    try {
      html = fs.readFileSync(path.join(REMOTE_DIR, 'setup.html'), 'utf8');
    } catch (e) {
      return json(res, 500, { ok: false, error: `缺少 setup.html：${e.message}` });
    }
    html = html.replace('__SETUP_TOKEN__', setupToken).replace('__ROLE__', role);
    const buf = Buffer.from(html);
    res.writeHead(200, {
      ...securityHeaders(false),
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': buf.length,
    });
    res.end(buf);
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          const err = new Error('请求体过大');
          err.status = 413;
          reject(err);
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { const err = new Error('请求体不是合法 JSON'); err.status = 400; reject(err); }
      });
      req.on('error', reject);
    });
  }

  function authorized(req) {
    return safeEqual(req.headers['x-setup-token'], setupToken);
  }

  async function handler(req, res) {
    if (!isLoopbackHost(req.headers.host)) {
      return json(res, 403, { ok: false, error: '只允许通过 127.0.0.1 / localhost 访问' });
    }
    const url = new URL(req.url || '/', 'http://setup.local');
    const pathname = url.pathname;

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return serveHtml(res);
    }

    if (req.method === 'GET' && pathname === '/api/state') {
      if (!authorized(req)) {
        return json(res, 403, { ok: false, error: '缺少或错误的配置台令牌，请刷新页面' });
      }
      return json(res, 200, await buildState(url.searchParams.get('since')));
    }

    if (req.method === 'POST') {
      if (!authorized(req)) {
        return json(res, 403, { ok: false, error: '缺少或错误的配置台令牌，请刷新页面' });
      }
      let body;
      try { body = await readJsonBody(req); }
      catch (e) { return json(res, e.status || 400, { ok: false, error: e.message }); }

      if (pathname === '/api/config') {
        const result = saveConfig(body.config);
        return json(res, result.ok ? 200 : 400, result);
      }

      if (pathname === '/api/generate') {
        const field = String(body.field || '');
        const allowed = def.fields.some((f) => f.key === field && f.generate);
        if (!allowed) return json(res, 400, { ok: false, error: '该字段不支持生成密钥' });
        return json(res, 200, { ok: true, token: newToken(), field });
      }

      if (pathname === '/api/service/start') {
        const id = String(body.id || '');
        // 已经在外部启动（例如用 start-edge.bat / start-main.bat）时不要重复 spawn
        if (id === 'edge' && !running.get('edge')?.child) {
          const health = await probeEdgeHealth(readConfig());
          if (health.reachable) return json(res, 200, { ok: true, alreadyRunning: true });
        }
        if (id === 'main' && !running.get('main')?.child) {
          if (await probeMain(readConfig())) return json(res, 200, { ok: true, alreadyRunning: true });
        }
        const r = startService(id);
        return json(res, r.ok ? 200 : (r.status || 400), r);
      }
      if (pathname === '/api/service/stop') {
        const r = stopService(String(body.id || ''));
        return json(res, r.ok ? 200 : (r.status || 400), r);
      }
      if (pathname === '/api/service/restart') {
        const r = await restartService(String(body.id || ''));
        return json(res, r.ok ? 200 : (r.status || 400), r);
      }

      return json(res, 404, { ok: false, error: '未知接口' });
    }

    return json(res, 405, { ok: false, error: '不支持的请求方法' });
  }

  const server = http.createServer((req, res) => {
    handler(req, res).catch((e) => {
      if (!res.headersSent) json(res, 500, { ok: false, error: e.message });
      else try { res.destroy(); } catch { /* ignore */ }
    });
  });
  server.on('upgrade', (req, socket) => socket.destroy());
  server.on('clientError', (err, socket) => { try { socket.destroy(); } catch { /* ignore */ } });

  return {
    role,
    configFile: cfgFile,
    setupToken,
    server,
    startService,
    stopService,
    restartService,
    autoStart,
    stopAll: () => Promise.all(def.services.map((id) => stopAndWait(id, 4000))),
    getLogs: () => logs.slice(),
    readConfig,
    saveConfig,
  };
}

// ───────────────────────── CLI ─────────────────────────

export function parseArgs(argv) {
  const out = { role: '', config: '', port: 0, open: true, autoStart: false, quiet: false, help: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--no-open') out.open = false;
    else if (arg === '--auto-start') out.autoStart = true;
    else if (arg === '--quiet') out.quiet = true;
    else if (arg.startsWith('--role=')) out.role = arg.slice(7);
    else if (arg === '--role') out.role = argv[argv.indexOf(arg) + 1] || '';
    else if (arg.startsWith('--config=')) out.config = arg.slice(9);
    else if (arg === '--config') out.config = argv[argv.indexOf(arg) + 1] || '';
    else if (arg.startsWith('--port=')) out.port = Number(arg.slice(7));
    else if (arg === '--port') out.port = Number(argv[argv.indexOf(arg) + 1]);
  }
  if (out.role !== 'edge' && out.role !== 'agent') out.role = '';
  return out;
}

function printHelp() {
  console.log(`Edge / Agent 本地配置台

用法：
  node remote/setup.mjs --role=edge  [选项]
  node remote/setup.mjs --role=agent [选项]

选项：
  --role=edge|agent   必填，选择公网端或内网端
  --config <路径>     配置文件位置（默认 remote/edge.config.json 或 remote/agent.config.json）
  --port <端口>       配置台本地端口（默认 Edge 8788 / Agent 8789）
  --auto-start        打开后自动启动对应服务（配置有效时）
  --no-open           不自动打开浏览器
  --quiet             不在控制台重复打印服务日志
  -h, --help          显示帮助

只监听 127.0.0.1，不会暴露到公网。
`);
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, () => {});
    } else if (process.platform === 'darwin') {
      execFile('open', [url], () => {});
    } else {
      execFile('xdg-open', [url], () => {});
    }
  } catch { /* 打不开浏览器不影响服务 */ }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (process.env.SETUP_NO_OPEN) args.open = false;
  if (args.help || !args.role) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }
  const def = ROLES[args.role];
  const port = Number.isFinite(args.port) && args.port > 0 ? args.port : def.guiPort;
  const setup = createSetupServer({
    role: args.role,
    configFile: args.config || def.file,
    quiet: args.quiet,
  });

  const url = `http://127.0.0.1:${port}/`;
  setup.server.on('error', (e) => {
    console.error(`[setup] 本地端口 ${port} 启动失败：${e.message}`);
    console.error('[setup] 可以用 --port 换一个端口，例如 --port 8799');
    process.exit(1);
  });
  setup.server.listen(port, '127.0.0.1', () => {
    console.log('');
    console.log(`  ${def.title}`);
    console.log(`  配置台：${url}`);
    console.log(`  配置文件：${setup.configFile}`);
    console.log('  只监听 127.0.0.1；关闭此窗口会停止由配置台启动的服务。');
    console.log('');
    if (args.autoStart) setup.autoStart();
    if (args.open) openBrowser(url);
  });

  let closing = false;
  const shutdown = async (sig) => {
    if (closing) return;
    closing = true;
    console.log(`\n[setup] 收到 ${sig}，正在停止服务…`);
    await setup.stopAll();
    setup.server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 6000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main();
