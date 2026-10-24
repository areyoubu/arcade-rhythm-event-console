/**
 * 结构化日志 —— JSONL，含时间戳/级别/来源/操作者/操作/结果/耗时。
 *
 * 需求：
 *   S-REQ-201  日志为结构化 JSONL，含时间戳/操作者/操作/结果/耗时
 *   S-REQ-202  须记录：所有 vMix 函数调用、OBS 请求、提示投递与回执、裁切参数、编排执行
 *   S-REQ-203  须支持按时间 / 级别 / 来源检索
 *   S-REQ-204  保留期默认 30 天
 *   S-REQ-205  任何降级不得静默 —— 每次降级必须同时改 UI 状态 + 写日志 + WS 广播
 *   B-NFR-07   结构化 JSONL
 *   B-REQ-536  裁切操作须全部记入审计日志
 */
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export const logEvents = new EventEmitter();
/** 最近日志的内存环形缓冲 —— 供 /logs 页与 /api/logs/recent 秒开，避免读盘 */
const RING_SIZE = 2000;
const ring = [];

let logDir = path.resolve('logs');
let minLevel = LEVELS.info;
let retainDays = 30;
let stream = null;
let currentDay = null;

function dayStamp(d = new Date()) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function ensureStream() {
  const day = dayStamp();
  if (stream && day === currentDay) return stream;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    if (stream) stream.end();
    stream = fs.createWriteStream(path.join(logDir, `console-${day}.jsonl`), { flags: 'a' });
    stream.on('error', () => { stream = null; });
    currentDay = day;
  } catch {
    stream = null;
  }
  return stream;
}

export function configureLogging({ dir, level, retain }) {
  if (dir) logDir = path.resolve(dir);
  if (level && LEVELS[level] !== undefined) minLevel = LEVELS[level];
  if (typeof retain === 'number' && retain > 0) retainDays = retain;
}

/**
 * 写一条日志。
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} source 来源：vmix | obs | cue | replay | overlay | media | templates | config | server
 * @param {string} msg 人类可读描述
 * @param {object} [data] 结构化字段：{ op, actor, result, durationMs, ... }
 */
export function log(level, source, msg, data = {}) {
  const rec = {
    at: Date.now(),
    ts: new Date().toISOString(),
    level,
    source,
    msg,
    ...sanitize(data),
  };

  ring.push(rec);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);

  if ((LEVELS[level] ?? 20) >= minLevel) {
    const s = ensureStream();
    if (s) {
      try { s.write(`${JSON.stringify(rec)}\n`); } catch { /* 磁盘满等，忽略 */ }
    }
    // 控制台同步输出，现场排查用
    const tag = `[${level.toUpperCase().padEnd(5)}] [${source}]`;
    const extra = data.op ? ` op=${data.op}` : '';
    const res = data.result ? ` => ${data.result}` : '';
    const dur = data.durationMs != null ? ` (${data.durationMs}ms)` : '';
    /* eslint-disable no-console */
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`${tag} ${msg}${extra}${res}${dur}`);
    /* eslint-enable no-console */
  }

  logEvents.emit('log', rec);
  return rec;
}

export const debug = (src, msg, d) => log('debug', src, msg, d);
export const info = (src, msg, d) => log('info', src, msg, d);
export const warn = (src, msg, d) => log('warn', src, msg, d);
export const error = (src, msg, d) => log('error', src, msg, d);

/**
 * 审计日志 —— 与普通日志同盘，但固定带 audit:true，便于检索。
 * B-REQ-536 / S-REQ-202 要求的操作留痕统一走这里。
 */
export function audit(source, op, data = {}) {
  return log('info', source, `AUDIT ${op}`, { ...data, op, audit: true });
}

/** 最近的日志（内存环形缓冲，倒序） */
export function recent(limit = 200, filter = {}) {
  let out = ring.slice().reverse();
  if (filter.source) out = out.filter((r) => r.source === filter.source);
  if (filter.level) out = out.filter((r) => r.level === filter.level);
  if (filter.since) out = out.filter((r) => r.at >= filter.since);
  return out.slice(0, limit);
}

/**
 * 从磁盘检索（按天文件），支持时间/级别/来源过滤。
 * S-REQ-203。
 */
export async function query({ from, to, level, source, limit = 500 } = {}) {
  const files = listLogFiles(from, to);
  const out = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (from && r.at < from) continue;
      if (to && r.at > to) continue;
      if (level && r.level !== level) continue;
      if (source && r.source !== source) continue;
      out.push(r);
    }
    if (out.length >= limit * 4) break;
  }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, limit);
}

export function listLogFiles(from, to) {
  try {
    const names = fs.readdirSync(logDir).filter((n) => n.endsWith('.jsonl'));
    return names
      .map((n) => path.join(logDir, n))
      .filter((f) => {
        const m = /console-(\d{8})\.jsonl$/.exec(f);
        if (!m) return true;
        const d = new Date(`${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}T00:00:00`).getTime();
        if (from && d + 86400000 < from) return false;
        if (to && d > to) return false;
        return true;
      })
      .sort();
  } catch { return []; }
}

/** 保留期清理 —— 启动时跑一次即可 */
export function prune() {
  const cutoff = Date.now() - retainDays * 86400000;
  let removed = 0;
  for (const f of listLogFiles()) {
    const m = /console-(\d{8})\.jsonl$/.exec(f);
    if (!m) continue;
    const d = new Date(`${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}T00:00:00`).getTime();
    if (d < cutoff) { try { fs.unlinkSync(f); removed++; } catch { /* ignore */ } }
  }
  if (removed) log('info', 'server', `日志清理完成`, { removed, retainDays });
  return removed;
}

/** 剔除敏感字段，避免密码 / 令牌进日志 */
function sanitize(data) {
  const SENSITIVE_KEYS = /^(password|token|passwd|secret|apikey|api_key|authorization)$/i;
  const out = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (SENSITIVE_KEYS.test(k)) { out[k] = '••••'; continue; }
    if (v && typeof v === 'object' && !Array.isArray(v)) { out[k] = sanitize(v); continue; }
    if (typeof v === 'string' && v.length > 2000) { out[k] = `${v.slice(0, 2000)}…(截断)`; continue; }
    out[k] = v;
  }
  return out;
}

/** 计时助手 —— 统一 durationMs 口径 */
export function timer() {
  const t0 = process.hrtime.bigint();
  return () => Number(process.hrtime.bigint() - t0) / 1e6;
}

// ─────────────────────────────────────────────────────────────
// 网络操作日志（单独文件，与普通控制台日志分开）
// ─────────────────────────────────────────────────────────────

let networkStream = null;
let networkDay = null;
const NET_RING_SIZE = 3000;
const netRing = [];

function ensureNetworkStream() {
  const day = dayStamp();
  if (networkStream && day === networkDay) return networkStream;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    if (networkStream) networkStream.end();
    networkStream = fs.createWriteStream(path.join(logDir, `network-${day}.jsonl`), { flags: 'a' });
    networkStream.on('error', () => { networkStream = null; });
    networkDay = day;
  } catch {
    networkStream = null;
  }
  return networkStream;
}

/**
 * 记一条网络操作日志（HTTP 请求 / WebSocket 连接 / 上传 / 限流 / 封禁）。
 * 只写 `logs/network-YYYYMMDD.jsonl`，不进 console 日志，避免刷屏。
 * @param {object} rec { kind, ip, method, path, status, durationMs, ua, ... }
 */
export function netlog(rec = {}) {
  const out = {
    at: Date.now(),
    ts: new Date().toISOString(),
    kind: rec.kind || 'http',
    ...sanitize(rec),
  };

  netRing.push(out);
  if (netRing.length > NET_RING_SIZE) netRing.splice(0, netRing.length - NET_RING_SIZE);

  const s = ensureNetworkStream();
  if (s) {
    try { s.write(`${JSON.stringify(out)}\n`); } catch { /* 磁盘满等，忽略 */ }
  }
  logEvents.emit('netlog', out);
  return out;
}

/** 最近网络日志（内存环形缓冲，倒序），供 /logs 页秒开 */
export function networkRecent(limit = 200) {
  return netRing.slice().reverse().slice(0, limit);
}

/** 网络日志文件清单（按天） */
export function listNetworkFiles() {
  try {
    return fs.readdirSync(logDir)
      .filter((n) => n.startsWith('network-') && n.endsWith('.jsonl'))
      .sort()
      .reverse();
  } catch { return []; }
}

/** 风险类网络事件（后台安全面板展示） */
const RISK_KINDS = new Set([
  'auth-fail', 'auth-lock', 'auth-blocked', 'admin-api-blocked',
  'ws-unauthorized', 'external-blocked', 'admin-password-change',
  'public-access-change',
]);

/**
 * 最近的风险操作：鉴权失败 / 锁定 / 外网访问输出被拦 / WS 未授权 / HTTP 4xx。
 * 倒序，最多返回 limit 条。
 */
export function networkRiskRecent(limit = 100) {
  const n = Math.min(500, Math.max(1, Number(limit) || 100));
  return netRing.slice().reverse()
    .filter((r) => RISK_KINDS.has(r.kind)
      || (r.kind === 'http' && Number(r.status) >= 400)
      || (r.kind === 'upload' && r.ok === false))
    .slice(0, n);
}
