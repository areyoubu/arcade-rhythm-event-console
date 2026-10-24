/**
 * 媒体库上传 —— 只收图片、单张、内容校验。
 *
 * 背景：媒体库曾被做成「通用文件库」，config.media.allowedTypes 允许
 * mp3 / wav / mp4 / exe / sh / txt / zip，配合批量上传可以当成网盘 / 马场。
 * 这里钉住：媒体库只收图片，且 config 无法放宽；非图片一律拒绝。
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../server/config.js';
import * as media from '../server/media.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_PNG = fs.readFileSync(path.join(ROOT, 'assets', '直播间模板.png'));

// 媒体目录受 withinRoot 钳制，测试目录必须落在项目目录内，否则会退回真实 media/
const TMP = fs.mkdtempSync(path.join(ROOT, 'data', '_test-media-'));
const REAL_DIR = getConfig().media.dir;
const REAL_SCAN = getConfig().media.scanOnBoot;
const REAL_WATCH = getConfig().media.watchDir;
const REAL_ALLOWED = getConfig().media.allowedTypes;
const REAL_INDEX = process.env.LP_MEDIA_INDEX;

function tempFile(name, content) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, content);
  return p;
}

before(async () => {
  // 故意把 allowedTypes 塞满非图片，证明代码层面不再信任它
  getConfig().media.dir = TMP;
  getConfig().media.scanOnBoot = false;
  getConfig().media.watchDir = false;
  getConfig().media.allowedTypes = ['mp3', 'wav', 'mp4', 'exe', 'sh', 'txt', 'zip', 'png'];
  process.env.LP_MEDIA_INDEX = path.join(TMP, 'media-index.json');
  await media.load();
});

after(() => {
  getConfig().media.dir = REAL_DIR;
  getConfig().media.scanOnBoot = REAL_SCAN;
  getConfig().media.watchDir = REAL_WATCH;
  getConfig().media.allowedTypes = REAL_ALLOWED;
  if (REAL_INDEX === undefined) delete process.env.LP_MEDIA_INDEX;
  else process.env.LP_MEDIA_INDEX = REAL_INDEX;
  fs.rmSync(TMP, { recursive: true, force: true });
});

function fakeMulterFile(name, content) {
  const p = tempFile(name, content);
  return { path: p, originalname: name, size: Buffer.byteLength(content) };
}

test('★★ 非图片（mp3 / wav / exe）即使 allowedTypes 允许也被拒绝', async () => {
  for (const [name, content] of [
    ['song.mp3', Buffer.from('ID3' + '\u0000'.repeat(200))],
    ['voice.wav', Buffer.from('RIFF' + '\u0000'.repeat(200))],
    ['evil.exe', Buffer.from('MZ' + '\u0000'.repeat(200))],
    ['note.txt', Buffer.from('hello world')],
    ['archive.zip', Buffer.from('PK\u0003\u0004' + '\u0000'.repeat(200))],
  ]) {
    const r = await media.addUpload(fakeMulterFile(name, content), { ip: '203.0.113.66' });
    assert.equal(r.ok, false, `${name} 不应被接受`);
    assert.match(r.error, /只接受图片/, `${name} 的错误信息应明确是「只接受图片」`);
  }
});

test('★★ 伪装成 .png 的 mp3 内容也要被拒绝（内容校验）', async () => {
  // 扩展名是 png，但内容不是图片
  const fake = fakeMulterFile('song.png', Buffer.from('ID3' + '\u0000'.repeat(200)));
  const r = await media.addUpload(fake, { ip: '203.0.113.66' });
  assert.equal(r.ok, false, 'png 扩展名但内容是 mp3 应被内容校验拒绝');
});

test('★★ SVG 一律拒绝（可携带脚本，属可执行内容）', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>');
  const r = await media.addUpload(fakeMulterFile('logo.svg', svg), { ip: '203.0.113.66' });
  assert.equal(r.ok, false);
  assert.match(r.error, /SVG/);
});

test('★ 真实 PNG 正常入库，并记录上传 IP / 时间', async () => {
  const r = await media.addUpload(fakeMulterFile('avatar.png', REAL_PNG), { ip: '203.0.113.66' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.asset.uploaderIp, '203.0.113.66');
  assert.ok(r.asset.uploadedAt > 0);
});

test('★ 上传接口只允许单张（不再用 array 批量）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'library.js'), 'utf8');
  assert.ok(!/upload\.array\(/.test(src), 'library 路由仍在使用 upload.array 批量接收');
  assert.match(src, /upload\.single\(['"]file['"]\)/, '应改为 upload.single("file")');
  assert.match(src, /files:\s*1/, 'multer 必须限制 files:1');
});

test('★★ 目录直投扫描：扩展名是图片、内容不是图片 → 丢弃并清除', async () => {
  // 直接往媒体目录丢一个「.png 扩展名、SVG 内容」的假图片
  const fake = path.join(TMP, 'fake.png');
  fs.writeFileSync(fake, '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect/></svg>');
  await media.scan();
  assert.equal(fs.existsSync(fake), false, '扫描应清掉内容非图片的假文件');
  assert.equal(media.list({ q: 'fake' }).total, 0, '不应被索引');
});
