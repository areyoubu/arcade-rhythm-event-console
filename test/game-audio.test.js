/**
 * 本地游戏音频目录扫描 / ACB 预览区间解析。
 *
 * 不依赖真实游戏数据：在临时目录里构造 cueFile 结构，验证：
 *   · data/A000 与 option 两种布局都能按 ID 索引到 AWB；
 *   · 非 cueFile / 非数字目录被忽略；
 *   · ACB 预览标记能读出起止毫秒；
 *   · 扫描不会写游戏目录。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../server/config.js';
import * as gameAudio from '../server/game-audio.js';
import { parseAfs2, findHcaEntry } from '../server/audio/afs2.js';
import { sliceHca } from '../server/audio/hca-slice.js';
import { parseHca } from '@tootallnate/hca';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-game-audio-'));
const OLD = { ...(getConfig().gameAudio || {}) };

function write(base, rel, data = 'x') {
  const p = path.join(base, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  return p;
}

before(() => {
  // 曲目 1：基础 data/A000 布局
  write(TMP, path.join('data', 'A000', 'cueFile', 'cueFile000001', 'music0001.awb'));
  write(TMP, path.join('data', 'A000', 'cueFile', 'cueFile000001', 'music0001.acb'));
  // 曲目 2：option 布局
  write(TMP, path.join('option', 'A001', 'cueFile', 'cueFile000002', 'song002.awb'));
  write(TMP, path.join('option', 'A001', 'cueFile', 'cueFile000002', 'song002.acb'));
  // 干扰项：不是 cueFile 数字目录
  write(TMP, path.join('data', 'A000', 'cueFile', 'not-a-cue', 'noise.awb'));
  write(TMP, path.join('data', 'A000', 'music', 'music0009', 'Music.xml'), '<MusicData />');
});

after(() => {
  getConfig().gameAudio = OLD;
  gameAudio.resetIndex();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('★★ 按 data/A000 与 option 两种目录布局索引曲目 ID', async () => {
  getConfig().gameAudio = {
    ...OLD,
    enabled: true,
    gameDir: TMP,
    previewSeconds: 20,
    useGamePreview: true,
  };
  gameAudio.resetIndex();
  const s = await gameAudio.scan(TMP);
  assert.equal(s.index?.ids, 2);
  assert.equal(s.index?.roots, 2);
  assert.equal(s.index?.awbFiles, 2);
  assert.equal(s.errors.length, 0);
  assert.equal(fs.existsSync(path.join(TMP, 'data', 'A000', 'cueFile', 'cueFile000001', 'music0001.awb')), true);
});

test('★ 扫描不存在的目录时返回明确错误，不抛异常', async () => {
  const s = await gameAudio.scan(path.join(TMP, 'missing'));
  assert.equal(s.index?.ids, 0);
  assert.ok(s.errors[0]?.includes('不存在'));
});

test('★★ ACB 预览标记：读出起止毫秒', async () => {
  const marker = Buffer.from([0x07, 0xd0, 0x04, 0x00, 0x02, 0x00, 0x01, 0x07, 0xd1, 0x04]);
  const buf = Buffer.alloc(40);
  buf[0] = 0x03; buf[1] = 0xe7; buf[2] = 0x04;
  buf.writeUInt32BE(12345, 3);
  marker.copy(buf, 7);
  buf.writeUInt32BE(54321, 17);
  buf[21] = 0x0f; buf[22] = 0xa0;
  const p = write(TMP, 'preview-test.acb', buf);
  const r = await gameAudio.readAcbPreview(p);
  assert.equal(r.startMs, 12345);
  assert.equal(r.endMs, 54321);
});

test('★★ AFS2 / AWB：按条目表定位 HCA，而不是假定第一条', () => {
  const hca = Buffer.alloc(40);
  hca.write('HCA\0', 0, 'ascii');
  hca[4] = 0x02; hca[5] = 0x00; hca[6] = 0x00; hca[7] = 0x20;

  const align = 32;
  const headerSize = 16 + 2 + 4 + 4; // ids + offsets + 哨兵
  const dataAt = Math.ceil(headerSize / align) * align;
  const buf = Buffer.alloc(dataAt + hca.length);
  buf.write('AFS2', 0, 'ascii');
  buf.writeUInt32LE(1 | (4 << 8) | (2 << 16), 4); // type=1, posLen=4, idLen=2
  buf.writeUInt32LE(1, 8);                         // 1 条
  buf.writeUInt16LE(align, 12);
  buf.writeUInt16LE(0, 14);
  buf.writeUInt16LE(7, 16);                        // id
  buf.writeUInt32LE(dataAt, 18);                   // 条目位置
  buf.writeUInt32LE(dataAt + hca.length, 22);      // 哨兵
  hca.copy(buf, dataAt);

  const archive = parseAfs2(buf);
  assert.equal(archive.entries.length, 1);
  assert.equal(archive.entries[0].id, 7);
  assert.equal(archive.entries[0].pos, dataAt);
  assert.equal(archive.entries[0].length, hca.length);
  const entry = findHcaEntry(buf, archive);
  assert.equal(entry.pos, dataAt);
});

test('★★ HCA 区间切片：只保留预览附近的 block，并同步修 header / loop', () => {
  const dataOffset = 64;
  const blockSize = 512;
  const blockCount = 200;
  const buf = Buffer.alloc(dataOffset + blockCount * blockSize);
  buf.write('HCA\0', 0, 'ascii');
  buf.writeUInt16BE(0x0200, 4);
  buf.writeUInt16BE(dataOffset, 6);
  buf.write('fmt\0', 8, 'ascii');
  buf.writeUInt32BE((2 << 24) | 44100, 12); // channels=2, samplingRate=44100
  buf.writeUInt32BE(blockCount, 16);
  buf.writeUInt16BE(0, 20);                 // muteHeader
  buf.writeUInt16BE(0, 22);                 // muteFooter
  buf.write('comp', 24, 'ascii');
  buf.writeUInt16BE(blockSize, 28);
  buf[30] = 1; buf[31] = 1;                 // r01 / r02
  buf.write('loop', 40, 'ascii');
  buf.writeUInt32BE(0, 44);
  buf.writeUInt32BE(blockCount, 48);
  buf.writeUInt16BE(0, 52);

  const out = sliceHca(buf, 1000, 1000);
  const parsed = parseHca(out.bytes);
  assert.equal(parsed.blockCount, out.blocks);
  assert.equal(parsed.blockCount, 45);
  assert.equal(parsed.loopEnd, 45, 'loop 头必须夹到新 blockCount');
  assert.equal(out.baseSample, 42 * 1024);
  assert.equal(out.bytes.length, dataOffset + out.blocks * blockSize);
});

test('★ 无标记的 ACB 返回 null（回退到设置起点）', async () => {
  const p = write(TMP, 'plain.acb', Buffer.from('not a preview acb'));
  assert.equal(await gameAudio.readAcbPreview(p), null);
});
