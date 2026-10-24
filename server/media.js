/**
 * 模块 A —— 媒体库。
 *
 * 需求：
 *   A-REQ-401  支持上传图片：PNG / JPG / WebP / GIF（SVG 因脚本风险已禁用）
 *   A-REQ-402  单文件上限默认 5MB，可配置
 *   A-REQ-403  上传后须生成**缩略图**用于控制端列表展示
 *   A-REQ-404  须支持**透明通道保留**（PNG / WebP），队徽常用
 *   A-REQ-405  图片须按内容 hash 命名（sha256.ext），天然去重
 *   A-REQ-406  须支持**多分辨率派生**（1x / 2x）
 *   A-REQ-407  须支持目录 / 标签分组
 *   A-REQ-408  ★ 须支持**引用计数**：删除资源前提示被哪些实体/模板引用
 *   A-REQ-409  渲染端图片须**预加载**并在加载完成前不显示（渲染端实现）
 *   A-REQ-410  图片加载失败须显示占位符（渲染端实现）
 *   A-REQ-411  须支持**批量上传**
 *   A-REQ-412  ★ 媒体目录须可通过文件系统直接投放（无需 UI），服务端自动索引
 *   （陷阱 #58：媒体删除无引用检查 → 直播中图片 404）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { getConfig, ROOT, withinRoot } from './config.js';
import * as log from './logger.js';
import {
  PRIZE_FORMATS, validateImageBuffer, extMatchesImage, safeOriginalName,
} from './image-validate.js';

export const mediaEvents = new EventEmitter();

/** @type {Map<string, object>} hash -> 资源元数据 */
let index = new Map();
let indexFile = null;
let watcher = null;
let scanTimer = null;
/** sharp 可用性 —— 缺失时降级（缩略图 = 原图），且必须写日志 + 广播（S-REQ-205） */
let sharp = null;
let sharpChecked = false;

// ─────────────────────────────────────────────────────────────
// 路径
// ─────────────────────────────────────────────────────────────

function dirs() {
  const cfg = getConfig();
  const base = cfg.media?.dir || './media';
  // 强制落在项目目录内：防止把媒体目录指到程序之外，借上传/扫描/删除读写任意文件
  const root = withinRoot(base) || path.join(ROOT, 'media');
  return {
    root,
    thumbs: path.join(root, 'thumbs'),
    derivatives: (cfg.media?.derivatives || []).map((d) => ({ name: d.name, width: d.width, dir: path.join(root, d.name) })),
  };
}

/** 媒体根目录（已按 withinRoot 钳制）；index.js 的 /media 静态服务也用这个，保证同一口径 */
export function rootDir() { return dirs().root; }

function ensureDirs() {
  const d = dirs();
  fs.mkdirSync(d.root, { recursive: true });
  fs.mkdirSync(d.thumbs, { recursive: true });
  for (const der of d.derivatives) fs.mkdirSync(der.dir, { recursive: true });
  return d;
}

// ─────────────────────────────────────────────────────────────
// sharp 可选加载
// ─────────────────────────────────────────────────────────────

export async function ensureImageLib() {
  if (sharpChecked) return !!sharp;
  sharpChecked = true;
  try {
    const mod = await import('sharp');
    sharp = mod.default;
    log.info('media', '图像处理库 sharp 已就绪（缩略图 / 多分辨率派生可用）', { vips: sharp.versions?.vips });
  } catch (e) {
    sharp = null;
    const msg = '图像处理库 sharp 不可用 —— 缩略图与多分辨率派生已降级为「直接使用原图」。'
      + '控制端列表会变慢、OBS 浏览器源首次加载图片会变重。建议 npm i sharp 后重启。';
    log.warn('media', msg, { err: String(e?.message).split('\n')[0] });
    mediaEvents.emit('degraded', { feature: 'thumbnails', msg });
  }
  return !!sharp;
}

export function isSharpAvailable() { return !!sharp; }

// ─────────────────────────────────────────────────────────────
// 索引
// ─────────────────────────────────────────────────────────────

export async function load() {
  ensureDirs();
  indexFile = process.env.LP_MEDIA_INDEX
    ? path.resolve(process.env.LP_MEDIA_INDEX)
    : path.join(ROOT, 'data', 'media-index.json');
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });

  if (fs.existsSync(indexFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      index = new Map(Object.entries(raw.assets || {}));
      log.info('media', '媒体索引已加载', { count: index.size });
    } catch (e) {
      log.error('media', '媒体索引损坏，将从目录重建', { err: e.message });
      index = new Map();
    }
  }

  await ensureImageLib();
  if (getConfig().media.scanOnBoot) await scan();
  startWatch();
  return index.size;
}

function saveIndex() {
  try {
    const obj = { version: 1, updatedAt: Date.now(), assets: Object.fromEntries(index) };
    fs.writeFileSync(indexFile, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  } catch (e) {
    log.warn('media', '媒体索引写盘失败', { err: e.message });
  }
}

/**
 * A-REQ-412：扫描目录，纳管所有直接投放的文件（赛前准备时直接往目录丢图即可）。
 */
export async function scan() {
  const d = ensureDirs();
  const added = [];
  const updated = [];

  let names = [];
  try { names = fs.readdirSync(d.root, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name); } catch { /* ignore */ }

  for (const name of names) {
    const ext = path.extname(name).slice(1).toLowerCase();
    if (!ALLOWED_IMAGE_EXTS.has(ext)) continue;
    const full = path.join(d.root, name);
    try {
      const stat = fs.statSync(full);
      const buf = fs.readFileSync(full);

      // ★ 内容校验：扩展名是图片、内容不是 → 跳过并清掉该垃圾文件（防止丢假图片进媒体库）
      const v = await verifyImage(buf, ext, Math.max(buf.length, 1));
      if (!v.ok) {
        log.warn('media', `丢弃非图片内容：${name}`, { err: v.error });
        try { fs.unlinkSync(full); } catch { /* ignore */ }
        continue;
      }

      const hash = sha256(buf);

      // 文件名不是 hash 的（人工投放）→ 重命名为 hash，保证去重与内容寻址
      let finalName = name;
      if (path.basename(name, `.${ext}`) !== hash) {
        finalName = `${hash}.${ext}`;
        const target = path.join(d.root, finalName);
        if (fs.existsSync(target)) {
          fs.unlinkSync(full);   // 内容相同，去重
        } else {
          fs.renameSync(full, target);
        }
      }

      const existing = index.get(hash);
      if (existing) {
        if (existing.size !== stat.size) {
          existing.size = stat.size;
          updated.push(hash);
        }
        continue;
      }

      const meta = await describeAsset(hash, ext, finalName, stat.size, d);
      index.set(hash, meta);
      added.push(meta);
    } catch (e) {
      log.warn('media', `扫描文件失败：${name}`, { err: e.message });
    }
  }

  if (added.length || updated.length) {
    saveIndex();
    log.info('media', '媒体库扫描完成', { added: added.length, updated: updated.length, total: index.size });
    emitAssets(added, []);
  }
  return { added: added.length, total: index.size };
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

async function describeAsset(hash, ext, filename, size, d, extra = {}) {
  const meta = {
    hash,
    ext,
    filename,
    size,
    url: `/media/${filename}`,
    thumbnail: `/media/${filename}`,     // sharp 缺失时的降级值
    derivatives: {},
    width: null,
    height: null,
    hasAlpha: ['png', 'webp'].includes(ext),
    tags: [],
    addedAt: Date.now(),
    degraded: false,
    ...extra,
  };

  if (sharp && ext !== 'gif') {
    try {
      const src = path.join(d.root, filename);
      const info = await sharp(src).metadata();
      meta.width = info.width ?? null;
      meta.height = info.height ?? null;
      meta.hasAlpha = !!info.hasAlpha;

      // A-REQ-403 缩略图
      const thumbName = `${hash}.webp`;
      const thumbPath = path.join(d.thumbs, thumbName);
      if (!fs.existsSync(thumbPath)) {
        await sharp(src).resize({ width: getConfig().media.thumbnailWidth || 320, withoutEnlargement: true })
          .webp({ quality: 82 }).toFile(thumbPath);
      }
      meta.thumbnail = `/media/thumbs/${thumbName}`;

      // A-REQ-406 多分辨率派生
      for (const der of d.derivatives) {
        const derName = `${hash}.webp`;
        const derPath = path.join(der.dir, derName);
        if (!fs.existsSync(derPath)) {
          await sharp(src).resize({ width: der.width, withoutEnlargement: true })
            .webp({ quality: 88, alphaQuality: 100 }).toFile(derPath);
        }
        meta.derivatives[der.name] = `/media/${der.name}/${derName}`;
      }
    } catch (e) {
      log.warn('media', `图像处理失败（保留原图）：${filename}`, { err: e.message });
      meta.degraded = true;
    }
  } else if (!sharp) {
    meta.degraded = true;                 // S-REQ-205：降级不静默，字段如实标注
  }

  return meta;
}

// ─────────────────────────────────────────────────────────────
// 上传
// ─────────────────────────────────────────────────────────────

const RASTER_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

/**
 * 媒体库只收静态位图（PNG / JPG / WebP / GIF）。
 * 安全边界：
 *   · 不接受 mp3 / wav / mp4 / exe / sh / txt / zip 等任何非图片；
 *   · 不接受 SVG（SVG 可携带脚本 / 外链，属可执行内容，能借同源做 XSS / 越权）；
 *   · 不受 config.media.allowedTypes 影响（防止被改配置放开）。
 */
const ALLOWED_IMAGE_EXTS = RASTER_EXTS;

function uploaderIpOf(ip) {
  return String(ip || '').replace(/^::ffff:/, '').slice(0, 64);
}

/**
 * 图片内容校验（不信任扩展名 / Content-Type）。
 * @returns {Promise<{ok:boolean, ext?:string, error?:string}>}
 */
async function verifyImage(buf, ext, maxBytes) {
  const v = await validateImageBuffer(buf, {
    formats: ['png', 'jpeg', 'gif', 'webp'],
    maxBytes,
  });
  if (!v.ok) return { ok: false, error: v.nack.msg };
  if (!extMatchesImage(ext, v)) {
    return { ok: false, error: `文件内容不是 .${ext} 图片（实际为 ${v.format.toUpperCase()}）` };
  }
  return { ok: true, ext: v.ext, width: v.width, height: v.height };
}

/** 处理 multer 上传的单个文件（只收图片） */
export async function addUpload(file, { ip = '', source = 'media' } = {}) {
  const cfg = getConfig();
  const d = ensureDirs();
  const ext = path.extname(file.originalname).slice(1).toLowerCase();
  // ★ 只接受静态位图扩展名；config.allowedTypes 不再决定能传什么，防止被改配置放开
  if (!ALLOWED_IMAGE_EXTS.has(ext)) {
    const kind = ext === 'svg' ? 'SVG 属可执行内容，禁止上传' : `只接受图片（PNG / JPG / WebP / GIF），不接受 .${ext || '无扩展名'}`;
    return { ok: false, name: file.originalname, error: kind };
  }
  const maxBytes = (cfg.media.maxFileSizeMB || 5) * 1024 * 1024;
  if (file.size > maxBytes) {
    return { ok: false, name: file.originalname, error: `文件超过 ${cfg.media.maxFileSizeMB}MB 上限` };
  }

  const buf = fs.readFileSync(file.path);
  const v = await verifyImage(buf, ext, maxBytes);
  if (!v.ok) {
    try { fs.unlinkSync(file.path); } catch { /* ignore */ }
    return { ok: false, name: file.originalname, error: v.error };
  }
  const storedExt = v.ext;
  const dims = { width: v.width ?? null, height: v.height ?? null };

  const hash = sha256(buf);
  // 内容寻址 ✓ 天然去重
  if (index.has(hash)) {
    try { fs.unlinkSync(file.path); } catch { /* ignore */ }
    const existing = index.get(hash);
    existing.lastUploaderIp = uploaderIpOf(ip);
    existing.lastUploadedAt = Date.now();
    saveIndex();
    return { ok: true, asset: existing, deduped: true, name: file.originalname, originalName: file.originalname };
  }

  const filename = `${hash}.${storedExt}`;
  const target = path.join(d.root, filename);
  try {
    fs.renameSync(file.path, target);
  } catch (e) {
    // multer 的临时目录可能在另一个盘（例如 C: → D:），rename 会报 EXDEV
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(file.path, target);
    try { fs.unlinkSync(file.path); } catch { /* ignore */ }
  }

  const meta = await describeAsset(hash, storedExt, filename, buf.length, d, {
    uploaderIp: uploaderIpOf(ip),
    uploadedAt: Date.now(),
    source: String(source || 'media').slice(0, 40),
  });
  meta.originalName = safeOriginalName(file.originalname);
  if (dims?.width) meta.width = dims.width;
  if (dims?.height) meta.height = dims.height;
  index.set(hash, meta);
  saveIndex();
  log.audit('media', 'upload', {
    hash, name: meta.originalName, size: buf.length, ext: storedExt, ip: meta.uploaderIp, deduped: false,
  });
  emitAssets([meta], []);
  return { ok: true, asset: meta, name: file.originalname, originalName: file.originalname };
}

/**
 * 奖品图片专用：单张、严格光栅图格式、记录上传 IP 与时间。
 * 不经过 multer 临时文件，直接写媒体库（内容 hash 命名）。
 */
export async function addImageBuffer(buffer, {
  originalName = 'prize',
  ip = '',
  source = 'lottery-prize',
  maxBytes = 10 * 1024 * 1024,
} = {}) {
  const v = await validateImageBuffer(buffer, {
    formats: PRIZE_FORMATS,
    maxBytes,
    maxPixels: 40_000_000,
  });
  if (!v.ok) return v;

  const d = ensureDirs();
  const hash = sha256(buffer);
  const existing = index.get(hash);
  if (existing) {
    existing.lastUploaderIp = uploaderIpOf(ip);
    existing.lastUploadedAt = Date.now();
    saveIndex();
    return { ok: true, asset: existing, deduped: true };
  }

  const filename = `${hash}.${v.ext}`;
  fs.writeFileSync(path.join(d.root, filename), buffer);
  const meta = await describeAsset(hash, v.ext, filename, buffer.length, d, {
    uploaderIp: uploaderIpOf(ip),
    uploadedAt: Date.now(),
    source: String(source || 'lottery-prize').slice(0, 40),
  });
  meta.originalName = safeOriginalName(originalName);
  if (v.width) meta.width = v.width;
  if (v.height) meta.height = v.height;
  index.set(hash, meta);
  saveIndex();
  log.audit('media', 'upload', {
    hash, name: meta.originalName, size: buffer.length, ext: v.ext, ip: meta.uploaderIp, source,
  });
  emitAssets([meta], []);
  return { ok: true, asset: meta };
}

// ─────────────────────────────────────────────────────────────
// 删除 / 引用检查 A-REQ-408
// ─────────────────────────────────────────────────────────────

/**
 * ★ A-REQ-408 / 陷阱 #58：删除前必须做**引用检查**。
 * 直播中图片 404 是最难排查的事故之一。
 */
export function checkReferences(hash) {
  const asset = index.get(hash);
  if (!asset) return { exists: false, refs: [] };
  const refs = [];

  // ① 实体引用
  try {
    // 延迟导入避免循环依赖
    const st = globalThis.__entityReferencingImage;
    if (typeof st === 'function') {
      for (const r of st(asset.url) || []) refs.push({ type: 'entity', ...r });
    }
  } catch { /* ignore */ }

  // ② 当前叠加状态引用
  try {
    const st = globalThis.__stateRef?.();
    const vals = st?.overlay?.slotValues || {};
    for (const [k, v] of Object.entries(vals)) if (String(v).includes(asset.url)) refs.push({ type: 'overlay', slot: k });

    const queues = st?.overlay?.queue || [];
    for (const q of queues) {
      for (const [k, v] of Object.entries(q.values || {})) if (String(v).includes(asset.url)) refs.push({ type: 'queue', slot: k });
    }
  } catch { /* ignore */ }

  // ③ 模板 CSS / html 引用
  try {
    const tl = globalThis.__templateList?.();
    for (const t of tl || []) {
      if (String(t.html || '').includes(asset.url) || String(t.css || '').includes(asset.url)) {
        refs.push({ type: 'template', id: t.id, name: t.name });
      }
    }
  } catch { /* ignore */ }

  // ④ 抽奖「本轮奖品」图片
  try {
    const fn = globalThis.__lotteryReferencingImage;
    for (const r of fn?.(asset.url) || []) refs.push({ type: 'lottery-prize', ...r });
  } catch { /* ignore */ }

  return { exists: true, asset, refs };
}

export function remove(hash, { force = false } = {}) {
  const asset = index.get(hash);
  if (!asset) return { ok: false, errors: { hash: '资源不存在' } };

  const { refs } = checkReferences(hash);
  if (refs.length && !force) {
    return {
      ok: false,
      errors: { hash: `该资源正被 ${refs.length} 处引用，未删除` },
      refs,
      hint: '直播中删除被引用的图片会导致画面 404。请先解除引用，或确认无误后强制删除。',
    };
  }

  const d = dirs();
  const tryUnlink = (p) => { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { log.warn('media', '删除文件失败', { file: p, err: e.message }); } };

  tryUnlink(path.join(d.root, asset.filename));
  tryUnlink(path.join(d.thumbs, `${hash}.webp`));
  for (const der of d.derivatives) tryUnlink(path.join(der.dir, `${hash}.webp`));

  index.delete(hash);
  saveIndex();
  log.audit('media', 'delete', { hash, filename: asset.filename, forced: force, refs: refs.length });
  emitAssets([], [hash]);
  return { ok: true, removedRefs: refs.length };
}

export function bulkRemove(hashes, opts = {}) {
  const results = [];
  for (const h of hashes) results.push({ hash: h, ...remove(h, opts) });
  return results;
}

export function setTags(hash, tags) {
  const a = index.get(hash);
  if (!a) return { ok: false, errors: { hash: '资源不存在' } };
  a.tags = [...new Set((tags || []).map((s) => String(s).trim()).filter(Boolean))];
  saveIndex();
  emitAssets([a], []);
  return { ok: true, asset: a };
}

/** A-REQ-407：目录 / 标签分组 */
export function setGroup(hash, group) {
  const a = index.get(hash);
  if (!a) return { ok: false, errors: { hash: '资源不存在' } };
  a.group = group || null;
  saveIndex();
  emitAssets([a], []);
  return { ok: true, asset: a };
}

// ─────────────────────────────────────────────────────────────
// 查询
// ─────────────────────────────────────────────────────────────

export function list({ q, tag, group, ext, limit = 200, offset = 0 } = {}) {
  let out = [...index.values()];
  if (q) {
    const s = String(q).toLowerCase();
    out = out.filter((a) => `${a.originalName || ''} ${a.filename} ${a.hash} ${(a.tags || []).join(' ')}`.toLowerCase().includes(s));
  }
  if (tag) out = out.filter((a) => (a.tags || []).includes(tag));
  if (group) out = out.filter((a) => a.group === group);
  if (ext) out = out.filter((a) => a.ext === ext);
  out.sort((a, b) => b.addedAt - a.addedAt);
  return { total: out.length, items: out.slice(offset, offset + limit), offset, limit };
}

export function get(hash) { return index.get(hash) || null; }
export function byUrl(url) {
  return [...index.values()].find((a) => a.url === url) || null;
}

export function allTags() {
  const s = new Set();
  for (const a of index.values()) for (const t of a.tags || []) s.add(t);
  return [...s].sort();
}

export function allGroups() {
  const s = new Set();
  for (const a of index.values()) if (a.group) s.add(a.group);
  return [...s].sort();
}

export function stats() {
  const items = [...index.values()];
  const totalBytes = items.reduce((n, a) => n + (a.size || 0), 0);
  return {
    count: items.length,
    totalMB: +(totalBytes / 1048576).toFixed(2),
    thumbs: fs.existsSync(dirs().thumbs) ? fs.readdirSync(dirs().thumbs).length : 0,
    degraded: !sharp,
    degradedNote: sharp ? null : 'sharp 不可用：缩略图与多分辨率派生已降级为使用原图',
    dir: dirs().root,
  };
}

// ─────────────────────────────────────────────────────────────
// 变更广播 A-REQ-412 / S-REQ-205
// ─────────────────────────────────────────────────────────────

function emitAssets(added, removed) {
  mediaEvents.emit('change', { added, removed });
}

/** 生成一段可直接贴进 OBS / 模板的 URL 列表（A-REQ-724 复制渲染端 URL） */
export function renderUrl(hash, { derivative = null, thumb = false } = {}) {
  const a = index.get(hash);
  if (!a) return null;
  if (thumb) return a.thumbnail;
  if (derivative && a.derivatives?.[derivative]) return a.derivatives[derivative];
  return a.url;
}

// ─────────────────────────────────────────────────────────────
// 目录监视 A-REQ-412
// ─────────────────────────────────────────────────────────────

function startWatch() {
  stopWatch();
  if (!getConfig().media.watchDir) return;
  const d = dirs();
  try {
    watcher = fs.watch(d.root, { persistent: false }, (_evt, filename) => {
      if (!filename) return;
      const name = String(filename);
      if (name.startsWith('thumbs') || name.startsWith('1x') || name.startsWith('2x')) return;
      // 防抖：批量拷贝文件会触发大量事件
      clearTimeout(scanTimer);
      scanTimer = setTimeout(() => {
        scan().catch((e) => log.warn('media', '目录变更扫描失败', { err: e.message }));
      }, 400);
      scanTimer.unref?.();
    });
    log.info('media', '媒体目录监视已启动（直接往目录丢图即可自动索引）', { dir: d.root });
  } catch (e) {
    log.warn('media', '媒体目录监视失败', { err: e.message });
  }
}

function stopWatch() {
  if (watcher) { try { watcher.close(); } catch { /* ignore */ } watcher = null; }
  clearTimeout(scanTimer);
}

export function restartWatch() { startWatch(); }

/** 供 index.js 注入（避免循环导入） */
export function wireReferences({ entityReferencingImage, stateRef, templateList, lotteryReferencingImage }) {
  globalThis.__entityReferencingImage = entityReferencingImage;
  globalThis.__stateRef = stateRef;
  globalThis.__templateList = templateList;
  globalThis.__lotteryReferencingImage = lotteryReferencingImage;
}
