/**
 * CRI AFS2 / AWB 条目表解析。
 *
 * AWB 头布局：
 *   0x00  "AFS2"
 *   0x04  u32 LE info：低 8 位类型，bit8-15 offset 宽度，bit16-23 id 宽度
 *   0x08  u32 LE 条目数
 *   0x0C  u16 LE 对齐
 *   0x0E  u16 LE AWB 子密钥
 *   0x10  id 表 → offset 表 → 哨兵 offset → 数据
 *
 * 与游戏库的做法一致：位置按对齐值向上取整；每条长度 = 下一条未对齐位置 - 本条对齐位置。
 */
import { isHca } from '@tootallnate/hca';

export function alignUp(value, align) {
  if (!Number.isFinite(align) || align <= 1) return value;
  return Math.ceil(value / align) * align;
}

function readField(buf, offset, length) {
  if (length === 2) return buf.readUInt16LE(offset);
  if (length === 4) return buf.readUInt32LE(offset);
  if (length === 8) {
    const v = buf.readBigUInt64LE(offset);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('AFS2 字段超出安全整数范围');
    return Number(v);
  }
  throw new Error(`不支持的 AFS2 字段宽度：${length}`);
}

export function parseAfs2(buf) {
  if (buf.length < 16 || buf.toString('ascii', 0, 4) !== 'AFS2') {
    throw new Error('不是 AFS2 / AWB 文件');
  }
  const info = buf.readUInt32LE(4);
  const type = info & 0xff;
  if (type !== 1 && type !== 2) throw new Error(`未知 AFS2 类型：${type}`);
  const posLen = (info >>> 8) & 0xff;
  const idLen = (info >>> 16) & 0xff;
  const count = buf.readUInt32LE(8);
  const align = buf.readUInt16LE(12);
  const subKey = buf.readUInt16LE(14);

  if (count <= 0 || count > 100000) throw new Error(`AFS2 条目数异常：${count}`);
  const idsStart = 16;
  const posStart = idsStart + count * idLen;
  const sentinelAt = posStart + count * posLen;
  if (sentinelAt + posLen > buf.length) throw new Error('AFS2 条目表越界');

  const entries = [];
  let prev = null;
  for (let i = 0; i < count; i++) {
    const rawPos = readField(buf, posStart + i * posLen, posLen);
    const id = readField(buf, idsStart + i * idLen, idLen);
    if (prev) prev.length = rawPos - prev.pos;
    const entry = { id, rawPos, pos: alignUp(rawPos, align), length: 0 };
    entries.push(entry);
    prev = entry;
  }
  const sentinel = readField(buf, sentinelAt, posLen);
  if (prev) prev.length = sentinel - prev.pos;

  for (const entry of entries) {
    if (entry.pos < 0 || entry.pos >= buf.length) entry.length = 0;
    else entry.length = Math.max(0, Math.min(entry.length, buf.length - entry.pos));
  }
  return { entries, subKey };
}

/** AWB 里实际存放 HCA 的那一条；优先按 HCA 签名识别，而不是假定固定序号 */
export function findHcaEntry(buf, archive) {
  const usable = archive.entries.filter((e) => e.length > 16
    && isHca(buf.subarray(e.pos, Math.min(buf.length, e.pos + 4))));
  if (usable.length) return usable[0];
  return archive.entries.find((e) => e.length > 16) || null;
}
