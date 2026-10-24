/**
 * HCA 预览区间切片。
 *
 * HCA 固定块大小（blockSize）时，不必解码整首歌：
 *   1. 复制文件头，把 fmt.blockCount 改成本次实际截取的块数；
 *   2. 把 loop 头夹到新范围（否则解码器的 header 校验会拒绝）；
 *   3. 只保留覆盖预览区间的那一段 block 数据（额外带上前一块，保留重叠状态）。
 *
 * blockSize 为 0（VBR）时退回整文件解码，由调用方裁剪。
 */
import { parseHca } from '@tootallnate/hca';

function patchLoopHeader(headerBytes, blockCount) {
  for (let i = 0; i + 16 <= headerBytes.length; i++) {
    const tag = headerBytes.readUInt32LE(i) & 0x7f7f7f7f;
    if (tag !== 0x706f6f6c) continue; // 'loop'
    const dv = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);
    dv.setUint32(i + 4, 0, false);
    dv.setUint32(i + 8, blockCount, false);
    dv.setUint16(i + 12, 0, false);
    return;
  }
}

export function sliceHca(hca, startMs, durationMs) {
  const header = parseHca(hca);
  const totalSamples = header.blockCount * 0x400;
  const rate = header.samplingRate;
  let startSample = Math.floor((Math.max(0, startMs) * rate) / 1000);
  if (!Number.isFinite(startSample) || startSample >= Math.max(0, totalSamples - 0x400)) {
    startSample = 0;
  }
  const want = Math.max(0x200, Math.ceil((Math.max(0.1, durationMs) * rate) / 1000));
  const endSample = Math.min(totalSamples, startSample + want);

  if (!header.blockSize || header.blockSize <= 0) {
    return {
      bytes: hca, header, startSample, endSample, baseSample: 0, blocks: header.blockCount,
    };
  }

  const startBlock = Math.max(0, Math.floor(startSample / 0x400) - 1);
  const endBlock = Math.min(header.blockCount - 1, Math.floor(Math.max(startSample, endSample - 1) / 0x400));
  const blocks = endBlock - startBlock + 1;
  if (blocks <= 0) throw new Error('预览区间超出音频范围');

  if (startBlock === 0 && endBlock === header.blockCount - 1) {
    return {
      bytes: hca, header, startSample, endSample, baseSample: 0, blocks,
    };
  }

  const headerBytes = Buffer.from(hca.subarray(0, header.dataOffset));
  headerBytes.writeUInt32BE(blocks, 16);
  patchLoopHeader(headerBytes, blocks);

  const dataStart = header.dataOffset + startBlock * header.blockSize;
  const dataEnd = header.dataOffset + (endBlock + 1) * header.blockSize;
  if (dataStart < 0 || dataEnd > hca.length) throw new Error('HCA 数据块越界');

  return {
    bytes: Buffer.concat([headerBytes, hca.subarray(dataStart, dataEnd)]),
    header,
    startSample,
    endSample,
    baseSample: startBlock * 0x400,
    blocks,
  };
}
