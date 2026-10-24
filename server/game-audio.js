/**
 * 本地游戏音频预览。
 *
 * 用户可在设置里指定游戏安装根目录；程序只读其中的 cueFile 目录：
 *
 *   <游戏根>/data/A000/cueFile/cueFile000123/*.awb
 *   <游戏根>/option/<资源目录>/cueFile/cueFile000123/*.awb
 *   <游戏根>/bin/option/<资源目录>/cueFile/cueFile000123/*.awb
 *
 * 按曲目 ID 找到 AWB（CRI AFS2）与 ACB，读取 ACB 内记录的游戏预览起止时间，
 * 在 worker 线程里解码 HCA 并裁剪成短 WAV 缓存。主线程不阻塞。
 *
 * 安全边界：
 *   · 只读用户配置的游戏目录，不写游戏目录；
 *   · 只接受 cueFile/cueFile<数字>/ 下的 .awb / .acb；
 *   · 用 realpath 校验最终文件仍在游戏目录内；
 *   · 缓存只写 <项目>/data/audio-cache。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { getConfig, ROOT } from './config.js';
import * as log from './logger.js';

const CACHE_DIR = path.join(ROOT, 'data', 'audio-cache');
const WORKER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'audio', 'hca-preview-worker.js');

// ACB 的 CRI 预览区间标记（见 CHUNITHM ACB 的序列命令结构）
const PREVIEW_MARKER = Buffer.from([
  0x07, 0xd0, 0x04, 0x00, 0x02, 0x00, 0x01, 0x07, 0xd1, 0x04,
]);

const EMPTY_INDEX = () => ({
  gameDir: '',
  at: 0,
  entries: new Map(),
  stats: { ids: 0, files: 0, roots: 0, duplicates: 0 },
  errors: [],
});

let index = EMPTY_INDEX();
let scanPromise = null;
let scanAt = 0;
const previewJobs = new Map();
// 失败 / 找不到的曲目短暂记忆，避免每次比赛刷新都重新扫描或解码
const failures = new Map();
const FAIL_TTL_MS = 5 * 60 * 1000;
let queueTail = Promise.resolve();

function cfg() { return getConfig().gameAudio || {}; }

function settingDir(value = cfg().gameDir) {
  const s = String(value || '').trim();
  return s ? path.resolve(s) : '';
}

export function enabled() {
  const c = cfg();
  return c.enabled === true && !!settingDir(c.gameDir);
}

function clamp(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

function previewSeconds() { return clamp(cfg().previewSeconds, 3, 120, 25); }
function previewVolume() { return clamp(cfg().volume, 0, 1, 0.8); }
function cacheLimitBytes() { return clamp(cfg().cacheLimitMB, 0, 8192, 512) * 1024 * 1024; }

function isDir(p) {
  return fsp.stat(p).then((s) => s.isDirectory()).catch(() => false);
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function realInside(root, target) {
  try {
    const [rr, rt] = await Promise.all([fsp.realpath(root), fsp.realpath(target)]);
    return isInside(rr, rt);
  } catch { return false; }
}

async function fileExists(p) {
  try { return (await fsp.stat(p)).isFile(); } catch { return false; }
}

function cueDirsIn(root) {
  return fsp.readdir(root, { withFileTypes: true }).catch(() => []);
}

/** 扫描选项目录，root 级 option 优先于 bin/option（与游戏目录的两种布局兼容） */
async function enumerateOptionRoots(gameDir) {
  const out = [];
  const seen = new Set();
  for (const rel of ['option', path.join('bin', 'option')]) {
    const root = path.join(gameDir, rel);
    const dirs = await cueDirsIn(root);
    for (const d of dirs.filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(root, d.name);
      const key = full.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ path: full, source: `option:${d.name}` });
    }
  }
  return out;
}

/**
 * 建立「曲目 ID → AWB/ACB」索引。只扫描 cueFile 目录，不解析 Music.xml。
 */
export async function scan(dirOverride = null) {
  if (scanPromise) return scanPromise;
  const gameDir = settingDir(dirOverride || cfg().gameDir);
  scanPromise = (async () => {
    const started = Date.now();
    failures.clear();
    const next = EMPTY_INDEX();
    next.gameDir = gameDir;
    next.at = Date.now();

    if (!gameDir) {
      scanAt = Date.now();
      index = next;
      return statusSnapshot(gameDir);
    }
    if (!(await isDir(gameDir))) {
      next.errors.push(`游戏目录不存在：${gameDir}`);
      scanAt = Date.now();
      index = next;
      return statusSnapshot(gameDir);
    }

    const roots = [];
    const base = path.join(gameDir, 'data', 'A000');
    if (await isDir(base)) roots.push({ path: base, source: 'A000' });
    roots.push(...await enumerateOptionRoots(gameDir));
    next.stats.roots = roots.length;

    for (const root of roots) {
      const cueRoot = path.join(root.path, 'cueFile');
      const dirs = await cueDirsIn(cueRoot);
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const m = /^cueFile(\d{1,9})$/i.exec(d.name);
        if (!m) continue;
        const id = Number(m[1]);
        if (!Number.isSafeInteger(id) || id <= 0) continue;
        const dir = path.join(cueRoot, d.name);

        let files = [];
        try { files = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
        const awbFiles = files
          .filter((f) => f.isFile() && /\.awb$/i.test(f.name))
          .map((f) => f.name)
          .sort((a, b) => a.localeCompare(b));
        if (!awbFiles.length) continue;

        const acbFiles = files
          .filter((f) => f.isFile() && /\.acb$/i.test(f.name))
          .map((f) => f.name)
          .sort((a, b) => a.localeCompare(b));

        const awbName = awbFiles[0];
        const awbPath = path.join(dir, awbName);
        const stem = awbName.replace(/\.awb$/i, '');
        const acbName = acbFiles.find((n) => n.replace(/\.acb$/i, '').toLowerCase() === stem.toLowerCase())
          || acbFiles[0] || '';
        const acbPath = acbName ? path.join(dir, acbName) : '';

        if (!next.entries.has(id)) next.entries.set(id, []);
        next.entries.get(id).push({ awbPath, acbPath, source: root.source });
        next.stats.files++;
      }
    }

    next.stats.ids = next.entries.size;
    for (const list of next.entries.values()) if (list.length > 1) next.stats.duplicates += list.length - 1;
    next.stats.scanMs = Date.now() - started;
    index = next;
    scanAt = Date.now();
    log.info('game-audio', '游戏音频目录扫描完成', {
      ids: next.stats.ids,
      awbFiles: next.stats.files,
      roots: next.stats.roots,
      duplicates: next.stats.duplicates,
      scanMs: next.stats.scanMs,
    });
    return statusSnapshot(gameDir);
  })().finally(() => { scanPromise = null; });
  return scanPromise;
}

export function resetIndex() {
  index = EMPTY_INDEX();
  failures.clear();
  scanAt = 0;
}

/** 配置保存后调用：目录变化时重建索引，并尽量在后台先扫一遍 */
export function afterConfigChange() {
  resetIndex();
  if (enabled()) {
    scan().catch((e) => log.warn('game-audio', '游戏音频目录自动扫描失败', { err: e.message }));
  }
}

async function ensureIndex() {
  const dir = settingDir();
  if (!dir) throw new Error('尚未配置游戏目录');
  if (index.gameDir === dir && index.at) return index;
  await scan(dir);
  if (!index.gameDir || index.gameDir !== dir) throw new Error('游戏目录索引不可用');
  return index;
}

async function cacheStats() {
  const files = await fsp.readdir(CACHE_DIR, { withFileTypes: true }).catch(() => []);
  let bytes = 0;
  let count = 0;
  for (const f of files) {
    if (!f.isFile() || !/\.wav$/i.test(f.name)) continue;
    try {
      const st = await fsp.stat(path.join(CACHE_DIR, f.name));
      bytes += st.size;
      count++;
    } catch { /* ignore */ }
  }
  return { files: count, bytes };
}

function statusSnapshot(scannedDir = null) {
  const c = cfg();
  const configured = settingDir(c.gameDir);
  const target = scannedDir ? settingDir(scannedDir) : configured;
  const scanned = !!target && index.gameDir === target && index.at > 0;
  return {
    enabled: c.enabled === true,
    configuredDir: configured,
    gameDir: index.gameDir || target,
    scanned,
    index: scanned ? {
      ids: index.stats.ids,
      awbFiles: index.stats.files,
      roots: index.stats.roots,
      duplicates: index.stats.duplicates,
      scanMs: index.stats.scanMs || 0,
      scannedAt: index.at,
    } : null,
    errors: index.errors.slice(0, 20),
    previewSeconds: previewSeconds(),
    useGamePreview: c.useGamePreview !== false,
    fallbackStartSec: clamp(c.fallbackStartSec, 0, 3600, 0),
    volume: previewVolume(),
    scanAt,
  };
}

export async function status() {
  const s = statusSnapshot();
  s.cache = await cacheStats();
  return s;
}

export async function clearCache() {
  const files = await fsp.readdir(CACHE_DIR, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  let bytes = 0;
  for (const f of files) {
    if (!f.isFile() || !/\.(wav|tmp)$/i.test(f.name)) continue;
    const p = path.join(CACHE_DIR, f.name);
    try {
      const st = await fsp.stat(p);
      await fsp.unlink(p);
      removed++;
      bytes += st.size;
    } catch { /* ignore */ }
  }
  log.audit('game-audio', 'cache-clear', { removed, bytes });
  return { removed, bytes };
}

/** 解析 ACB 里的游戏预览起止（毫秒）。找不到标记时返回 null。 */
export async function readAcbPreview(acbPath) {
  if (!acbPath) return null;
  let buf;
  try { buf = await fsp.readFile(acbPath); } catch { return null; }
  const i = buf.indexOf(PREVIEW_MARKER);
  if (i < 7 || i + 16 > buf.length) return null;
  if (buf[i - 7] !== 0x03 || buf[i - 6] !== 0xe7 || buf[i - 5] !== 0x04) return null;
  if (buf[i + 14] !== 0x0f || buf[i + 15] !== 0xa0) return null;
  const startMs = buf.readUInt32BE(i - 4);
  const endMs = buf.readUInt32BE(i + 10);
  if (!(startMs >= 0 && endMs > startMs && endMs <= 6 * 60 * 60 * 1000)) return null;
  return { startMs, endMs };
}

function cacheKey(gameDir, id, startMs, durationMs) {
  const dirHash = createHash('sha1').update(gameDir).digest('hex').slice(0, 8);
  return `v1-${id}-${dirHash}-${Math.round(startMs)}-${Math.round(durationMs)}.wav`;
}

function enqueue(task) {
  const p = queueTail.then(task, task);
  queueTail = p.catch(() => { /* 队列继续 */ });
  return p;
}

async function pruneCache() {
  const limit = cacheLimitBytes();
  if (!limit) return;
  const files = await fsp.readdir(CACHE_DIR, { withFileTypes: true }).catch(() => []);
  const rows = [];
  let total = 0;
  for (const f of files) {
    if (!f.isFile() || !/\.wav$/i.test(f.name)) continue;
    const p = path.join(CACHE_DIR, f.name);
    try {
      const st = await fsp.stat(p);
      rows.push({ p, size: st.size, at: st.mtimeMs });
      total += st.size;
    } catch { /* ignore */ }
  }
  if (total <= limit) return;
  rows.sort((a, b) => a.at - b.at);
  for (const row of rows) {
    if (total <= limit) break;
    try {
      await fsp.unlink(row.p);
      total -= row.size;
    } catch { /* ignore */ }
  }
  log.info('game-audio', '预览缓存已按上限清理', { limitMB: Math.round(limit / 1024 / 1024) });
}

function decodeInWorker({ awbPath, outPath, startMs, durationMs }) {
  return new Promise((resolve, reject) => {
    let done = false;
    const worker = new Worker(WORKER_PATH, {
      workerData: {
        awbPath,
        outPath,
        tmpPath: `${outPath}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`,
        startMs,
        durationMs,
      },
    });
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn(v);
    };
    const timer = setTimeout(() => finish(reject, new Error('音频解码超时')), 90_000);
    worker.once('message', (msg) => {
      if (msg?.ok) finish(resolve, msg);
      else finish(reject, new Error(msg?.error || '音频解码失败'));
    });
    worker.once('error', (e) => finish(reject, e));
    worker.once('exit', (code) => {
      if (code !== 0) finish(reject, new Error(`音频解码线程退出：${code}`));
    });
  });
}

/**
 * 取得曲目预览 WAV。重复请求会复用同一个生成任务；生成结果长期缓存。
 */
export async function getPreview(musicId) {
  if (!enabled()) throw new Error('游戏音频未启用');
  const id = Number(musicId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('曲目 ID 无效');

  const failed = failures.get(id);
  if (failed && Date.now() - failed.at < FAIL_TTL_MS) throw new Error(failed.msg);

  try {
    const out = await getPreviewInner(id);
    failures.delete(id);
    return out;
  } catch (e) {
    failures.set(id, { at: Date.now(), msg: e.message || '预览不可用' });
    throw e;
  }
}

async function getPreviewInner(id) {
  const ix = await ensureIndex();
  const candidates = ix.entries.get(id);
  if (!candidates?.length) throw new Error('游戏目录中找不到该曲目 ID 的音频');

  const c = cfg();
  const useGamePreview = c.useGamePreview !== false;
  const seconds = previewSeconds();
  const fallbackMs = clamp(c.fallbackStartSec, 0, 3600, 0) * 1000;
  const durMs = Math.round(seconds * 1000);

  let lastErr = null;
  for (const cand of candidates.slice(0, 6)) {
    try {
      if (!(await realInside(ix.gameDir, cand.awbPath))) throw new Error('音频路径越界');
      let acb = null;
      if (cand.acbPath && await realInside(ix.gameDir, cand.acbPath)) {
        acb = await readAcbPreview(cand.acbPath);
      }

      let startMs = fallbackMs;
      let durationMs = durMs;
      if (useGamePreview && acb) {
        startMs = acb.startMs;
        // 游戏预览标记通常比设置时长长；取设置上限，至少保留 1 秒
        durationMs = Math.max(1000, Math.min(acb.endMs - acb.startMs, durMs));
      }

      const name = cacheKey(ix.gameDir, id, startMs, durationMs);
      const outPath = path.join(CACHE_DIR, name);
      if (await fileExists(outPath)) {
        return {
          musicId: id,
          path: outPath,
          url: `/api/audio/preview?id=${id}`,
          startMs,
          durationMs,
          cached: true,
        };
      }

      if (!previewJobs.has(name)) {
        const job = enqueue(async () => {
          await fsp.mkdir(CACHE_DIR, { recursive: true });
          const r = await decodeInWorker({
            awbPath: cand.awbPath,
            outPath,
            startMs,
            durationMs,
          });
          log.info('game-audio', '预览音频已生成', {
            musicId: id, bytes: r.bytes, durationMs: r.durationMs, source: cand.source,
          });
          pruneCache().catch(() => { /* ignore */ });
          return r;
        }).finally(() => previewJobs.delete(name));
        previewJobs.set(name, job);
      }
      const r = await previewJobs.get(name);
      return {
        musicId: id,
        path: outPath,
        url: `/api/audio/preview?id=${id}`,
        startMs: r.startMs ?? startMs,
        durationMs: r.durationMs ?? durationMs,
        cached: false,
      };
    } catch (e) {
      lastErr = e;
      log.debug('game-audio', '该 AWB 候选解码失败，尝试下一个', { musicId: id, err: e.message });
    }
  }
  throw lastErr || new Error('预览音频生成失败');
}

/** 随机选曲 / 选曲展示共用：返回可直接放进 state 的音频描述 */
export function descriptor(musicId, extra = {}) {
  if (!enabled()) return null;
  const id = Number(musicId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  // 提前解码，等大屏动画结束时通常已经能播
  getPreview(id).catch(() => { /* 找不到音频时静默，不影响画面 */ });
  return {
    musicId: id,
    url: `/api/audio/preview?id=${id}`,
    volume: previewVolume(),
    ...extra,
  };
}

/** 清理超过上限的缓存（启动时调用一次即可） */
export function warmUp() {
  if (!enabled()) return;
  fsp.mkdir(CACHE_DIR, { recursive: true })
    .then(() => pruneCache())
    .catch(() => { /* ignore */ });
  scan().catch((e) => log.warn('game-audio', '启动扫描失败', { err: e.message }));
}

export function cacheDir() { return CACHE_DIR; }
