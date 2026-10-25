/**
 * 最小 DDS 解码器（仅用于从游戏目录导入曲绘）。
 *
 * 支持：
 *   · DXT1 / DXT2 / DXT3 / DXT4 / DXT5（BC1/BC2/BC3）
 *   · 未压缩 32 位 RGB(A)
 *
 * 不支持的格式（例如 BC7）会抛错，由导入模块跳过该封面并保留旧封面。
 * 只解码顶层 mipmap；曲绘用不到更小层级。
 */

const DDS_MAGIC = 0x20534444; // 'DDS '

function rgb565(c) {
  const r = (c >>> 11) & 0x1f;
  const g = (c >>> 5) & 0x3f;
  const b = c & 0x1f;
  return [
    (r << 3) | (r >> 2),
    (g << 2) | (g >> 4),
    (b << 3) | (b >> 2),
  ];
}

function colorPalette(c0, c1, forceFour) {
  const a = rgb565(c0);
  const b = rgb565(c1);
  const out = [
    [a[0], a[1], a[2], 255],
    [b[0], b[1], b[2], 255],
  ];
  if (forceFour || c0 > c1) {
    out.push([
      Math.round((2 * a[0] + b[0]) / 3),
      Math.round((2 * a[1] + b[1]) / 3),
      Math.round((2 * a[2] + b[2]) / 3),
      255,
    ]);
    out.push([
      Math.round((a[0] + 2 * b[0]) / 3),
      Math.round((a[1] + 2 * b[1]) / 3),
      Math.round((a[2] + 2 * b[2]) / 3),
      255,
    ]);
  } else {
    out.push([
      Math.round((a[0] + b[0]) / 2),
      Math.round((a[1] + b[1]) / 2),
      Math.round((a[2] + b[2]) / 2),
      255,
    ]);
    out.push([0, 0, 0, 0]);
  }
  return out;
}

function decodeDxtColor(data, offset, forceFour) {
  const c0 = data.readUInt16LE(offset);
  const c1 = data.readUInt16LE(offset + 2);
  const bits = data.readUInt32LE(offset + 4);
  const palette = colorPalette(c0, c1, forceFour);
  const px = [];
  for (let i = 0; i < 16; i++) px.push(palette[(bits >>> (i * 2)) & 3]);
  return px;
}

function dxt1(data, offset) {
  return decodeDxtColor(data, offset, false);
}

function dxt3(data, offset) {
  const alpha = data.readBigUInt64LE(offset);
  const px = decodeDxtColor(data, offset + 8, true);
  for (let i = 0; i < 16; i++) {
    const a = Number((alpha >> BigInt(i * 4)) & 0xfn) * 17;
    px[i] = [px[i][0], px[i][1], px[i][2], a];
  }
  return px;
}

function dxt5(data, offset) {
  const a0 = data[offset];
  const a1 = data[offset + 1];
  const bits = data.readBigUInt64LE(offset + 2);
  const palette = [a0, a1];
  if (a0 > a1) {
    for (let i = 1; i <= 6; i++) palette.push(Math.round(((7 - i) * a0 + i * a1) / 7));
  } else {
    for (let i = 1; i <= 4; i++) palette.push(Math.round(((5 - i) * a0 + i * a1) / 5));
    palette.push(0, 255);
  }
  const color = decodeDxtColor(data, offset + 8, true);
  for (let i = 0; i < 16; i++) {
    const idx = Number((bits >> BigInt(i * 3)) & 0x7n);
    color[i] = [color[i][0], color[i][1], color[i][2], palette[idx] ?? 255];
  }
  return color;
}

function decodeUncompressed(data, offset, width, height, pf) {
  const bits = Number(pf.rgbBitCount);
  if (![16, 24, 32].includes(bits)) throw new Error(`不支持的未压缩 DDS 位深：${bits}`);
  const bytesPer = bits / 8;
  const rgba = Buffer.alloc(width * height * 4);
  const rMask = Number(pf.rMask) >>> 0;
  const gMask = Number(pf.gMask) >>> 0;
  const bMask = Number(pf.bMask) >>> 0;
  const aMask = Number(pf.aMask) >>> 0;
  const shift = (mask) => (mask ? 31 - Math.clz32(mask & -mask) : 0);
  const maxOf = (mask) => (mask ? mask >>> shift(mask) : 0);
  const rs = shift(rMask); const gs = shift(gMask); const bs = shift(bMask); const as = shift(aMask);
  const rm = maxOf(rMask); const gm = maxOf(gMask); const bm = maxOf(bMask); const am = maxOf(aMask);
  for (let i = 0; i < width * height; i++) {
    const at = offset + i * bytesPer;
    if (at + bytesPer > data.length) throw new Error('DDS 数据不完整');
    const v = bytesPer === 2 ? data.readUInt16LE(at)
      : bytesPer === 3 ? data.readUIntLE(at, 3)
        : data.readUInt32LE(at);
    rgba[i * 4] = rm ? Math.round((((v & rMask) >>> rs) / rm) * 255) : 0;
    rgba[i * 4 + 1] = gm ? Math.round((((v & gMask) >>> gs) / gm) * 255) : 0;
    rgba[i * 4 + 2] = bm ? Math.round((((v & bMask) >>> bs) / bm) * 255) : 0;
    rgba[i * 4 + 3] = am ? Math.round((((v & aMask) >>> as) / am) * 255) : 255;
  }
  return rgba;
}

/**
 * @param {Buffer} buf
 * @returns {{width:number,height:number,rgba:Buffer,format:string}}
 */
export function decodeDds(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 128) throw new Error('DDS 文件太小');
  if (buf.readUInt32LE(0) !== DDS_MAGIC) throw new Error('不是 DDS 文件');

  const height = buf.readUInt32LE(12);
  const width = buf.readUInt32LE(16);
  if (!width || !height || width > 8192 || height > 8192) throw new Error('DDS 尺寸异常');

  const pf = {
    size: buf.readUInt32LE(76),
    flags: buf.readUInt32LE(80),
    fourCC: buf.toString('ascii', 84, 88),
    rgbBitCount: buf.readUInt32LE(88),
    rMask: buf.readUInt32LE(92),
    gMask: buf.readUInt32LE(96),
    bMask: buf.readUInt32LE(100),
    aMask: buf.readUInt32LE(104),
  };

  const block = (() => {
    switch (pf.fourCC) {
      case 'DXT1': return { size: 8, fn: dxt1 };
      case 'DXT2':
      case 'DXT3': return { size: 16, fn: dxt3 };
      case 'DXT4':
      case 'DXT5': return { size: 16, fn: dxt5 };
      default: return null;
    }
  })();

  const rgba = Buffer.alloc(width * height * 4);

  if (!block) {
    if ([16, 24, 32].includes(pf.rgbBitCount) && (pf.flags & 0x40)) {
      return {
        width, height, format: `RGB${pf.rgbBitCount}`,
        rgba: decodeUncompressed(buf, 128, width, height, pf),
      };
    }
    if (pf.fourCC && pf.fourCC !== '\0\0\0\0') {
      throw new Error(`不支持的 DDS 压缩格式：${pf.fourCC}`);
    }
    throw new Error('不支持的 DDS 像素格式');
  }

  const bx = Math.ceil(width / 4);
  const by = Math.ceil(height / 4);
  let offset = 128;
  for (let byi = 0; byi < by; byi++) {
    for (let bxi = 0; bxi < bx; bxi++) {
      if (offset + block.size > buf.length) throw new Error('DDS 数据不完整');
      const px = block.fn(buf, offset);
      offset += block.size;
      for (let py = 0; py < 4; py++) {
        for (let pxX = 0; pxX < 4; pxX++) {
          const x = bxi * 4 + pxX;
          const y = byi * 4 + py;
          if (x >= width || y >= height) continue;
          const src = px[py * 4 + pxX];
          const dst = (y * width + x) * 4;
          rgba[dst] = src[0];
          rgba[dst + 1] = src[1];
          rgba[dst + 2] = src[2];
          rgba[dst + 3] = src[3];
        }
      }
    }
  }

  return { width, height, rgba, format: pf.fourCC || 'DDS' };
}
