#!/usr/bin/env node
/**
 * 清理媒体库里的非图片文件（mp3 / wav / mp4 等）。
 *
 * 历史遗留：媒体库曾被做成通用文件库，公网 IP 曾上传过 mp3/mp4/wav。
 * 现在上传已硬性只收图片，但已经进库的非图片文件仍在 index 与磁盘上。
 *
 * 用法（先停掉主服务再运行）：
 *   node tools/purge-nonimage.mjs           # 只列出会删什么
 *   node tools/purge-nonimage.mjs --apply   # 真正删除并回写索引
 *
 * 运行前会自动把 data/media-index.json 备份为 .bak。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = process.env.LP_MEDIA_INDEX
  ? path.resolve(process.env.LP_MEDIA_INDEX)
  : path.join(ROOT, 'data', 'media-index.json');
const MEDIA_DIR = process.env.LP_MEDIA_DIR || path.join(ROOT, 'media');

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']);
const APPLY = process.argv.includes('--apply');

if (!fs.existsSync(INDEX)) {
  console.error(`找不到媒体索引：${INDEX}`);
  process.exit(1);
}

const idx = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
const assets = idx.assets || {};
const entries = Object.entries(assets);
const nonImage = entries.filter(([, a]) => !IMAGE.has(String(a.ext || '').toLowerCase()));

console.log(`索引共 ${entries.length} 项，其中非图片 ${nonImage.length} 项：\n`);

const paths = [];
for (const [hash, a] of nonImage) {
  const filename = a.filename || '';
  const targets = [
    path.join(MEDIA_DIR, filename),
    path.join(MEDIA_DIR, 'thumbs', `${hash}.webp`),
    path.join(MEDIA_DIR, '1x', `${hash}.webp`),
    path.join(MEDIA_DIR, '2x', `${hash}.webp`),
  ];
  const exist = targets.filter((p) => fs.existsSync(p));
  console.log(`  ${String(a.ext || '?').toUpperCase().padEnd(5)} ${a.originalName || filename}${exist.length ? `（磁盘 ${exist.length} 个文件）` : '（磁盘无文件）'}`);
  paths.push(...exist);
}

if (!APPLY) {
  console.log('\n未加 --apply，只做预览。确认后用：node tools/purge-nonimage.mjs --apply');
  process.exit(0);
}

// 备份索引
const bak = `${INDEX}.bak`;
fs.copyFileSync(INDEX, bak);
console.log(`\n已备份索引：${bak}`);

let removedFiles = 0;
for (const p of paths) {
  try { fs.unlinkSync(p); removedFiles++; }
  catch (e) { console.error(`  删除失败 ${p}: ${e.message}`); }
}

const kept = Object.fromEntries(entries.filter(([, a]) => IMAGE.has(String(a.ext || '').toLowerCase())));
idx.assets = kept;
fs.writeFileSync(INDEX, `${JSON.stringify(idx, null, 2)}\n`, 'utf8');

console.log(`完成：删除磁盘文件 ${removedFiles} 个，索引移除 ${nonImage.length} 项，剩余 ${kept.length ? Object.keys(kept).length : 0} 项。`);
