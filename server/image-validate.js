/**
 * 图片内容校验 —— 不信任扩展名 / Content-Type，只看文件本身。
 *
 * 用途：
 *   · 奖品图片上传（只允许单张 PNG / JPEG / GIF / WebP）；
 *   · 媒体库上传时的图片兜底检查。
 *
 * 校验顺序：
 *   1. 大小上限；
 *   2. magic bytes（PNG / JPEG / GIF / WebP；SVG 被识别后直接拒绝）；
 *   3. 结构完整性（IEND / EOI / GIF trailer / RIFF 长度）；
 *   4. 有 sharp 时真正解码一次，核对格式与尺寸，并限制像素总量防解压炸弹。
 *
 * SVG 属「可执行内容」（可携带脚本 / 事件属性 / 外链），一律拒绝上传。
 */
import path from 'node:path';

export const PRIZE_FORMATS = ['png', 'jpeg', 'gif', 'webp'];

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let sharpMod = null;
let sharpChecked = false;

async function getSharp() {
  if (sharpChecked) return sharpMod;
  sharpChecked = true;
  try { sharpMod = (await import('sharp')).default; }
  catch { sharpMod = null; }
  return sharpMod;
}

function fail(code, msg) {
  return { ok: false, nack: { code, msg } };
}

/** 只做 magic bytes 识别，不判断内容是否完整。 */
export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;

  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) {
    return { format: 'png', ext: 'png', mime: 'image/png' };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { format: 'jpeg', ext: 'jpg', mime: 'image/jpeg' };
  }
  const head6 = buf.subarray(0, 6).toString('ascii');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') {
    return { format: 'gif', ext: 'gif', mime: 'image/gif' };
  }
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF'
    && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { format: 'webp', ext: 'webp', mime: 'image/webp' };
  }

  // SVG 是文本；只取前 4KB 判断，避免大文件全量转字符串
  const text = buf.subarray(0, Math.min(buf.length, 4096)).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (/^<\?xml[\s\S]*?<svg[\s>]/i.test(text) || /^<svg[\s>]/i.test(text)) {
    return { format: 'svg', ext: 'svg', mime: 'image/svg+xml' };
  }
  return null;
}

function structureOk(buf, format) {
  if (format === 'png') return buf.includes(Buffer.from('IEND', 'ascii'));
  if (format === 'jpeg') return buf.length >= 4 && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
  if (format === 'gif') return buf[buf.length - 1] === 0x3b;
  if (format === 'webp') {
    const riffSize = buf.readUInt32LE(4);
    return riffSize + 8 <= buf.length && riffSize + 8 >= buf.length - 8;
  }
  return true;
}

/** 文件头与扩展名是否匹配（jpg / jpeg 视作同一格式）。 */
export function extMatchesImage(ext, sniff) {
  const e = String(ext || '').toLowerCase();
  if (!sniff) return false;
  if (sniff.format === 'jpeg') return e === 'jpg' || e === 'jpeg';
  return e === sniff.format;
}

/** SVG 基础黑名单：脚本、事件属性、外链嵌入一律拒绝。 */
export function validateSvg(buf) {
  const text = buf.toString('utf8');
  const bad = [
    /<script[\s>]/i,
    /<foreignObject[\s>]/i,
    /<iframe[\s>]/i,
    /<object[\s>]/i,
    /<embed[\s>]/i,
    /\son[a-z]+\s*=/i,
    /javascript\s*:/i,
    /data:text\/html/i,
  ];
  const hit = bad.find((re) => re.test(text));
  if (hit) return fail('unsafe_svg', 'SVG 含脚本或事件属性，已拒绝');
  return { ok: true, format: 'svg', ext: 'svg', mime: 'image/svg+xml' };
}

/**
 * @param {Buffer} buf
 * @param {object} [opts]
 * @param {string[]} [opts.formats] 允许的格式（默认 PNG/JPEG/GIF/WebP；SVG 一律拒绝）
 * @param {number} [opts.maxBytes]
 * @param {number} [opts.maxPixels]
 * @returns {Promise<{ok:boolean, format?:string, ext?:string, mime?:string, width?:number|null, height?:number|null, nack?:object}>}
 */
export async function validateImageBuffer(buf, {
  formats = ['png', 'jpeg', 'gif', 'webp'],
  maxBytes = 10 * 1024 * 1024,
  maxPixels = 40_000_000,
} = {}) {
  if (!Buffer.isBuffer(buf) || !buf.length) return fail('empty_file', '文件是空的');
  if (buf.length > maxBytes) {
    return fail('too_large', `图片不能超过 ${Math.round(maxBytes / 1048576)}MB`);
  }

  const sniff = sniffImage(buf);
  if (!sniff) return fail('not_image', '文件内容不是有效的图片');
  if (sniff.format === 'svg') return fail('svg_forbidden', 'SVG 属可执行内容（可携带脚本），禁止上传');
  if (!formats.includes(sniff.format)) {
    return fail('unsupported_type', `不支持 ${sniff.format.toUpperCase()}，请上传 PNG / JPG / WebP / GIF`);
  }
  if (!structureOk(buf, sniff.format)) {
    return fail('broken_image', '图片文件不完整或已损坏');
  }

  const sharp = await getSharp();
  if (sharp) {
    try {
      const meta = await sharp(buf, { animated: false, limitInputPixels: maxPixels }).metadata();
      if (!meta?.width || !meta?.height) return fail('broken_image', '图片无法解码');
      if (meta.width * meta.height > maxPixels) {
        return fail('too_many_pixels', `图片尺寸过大（${meta.width}×${meta.height}）`);
      }
      const decoded = meta.format === 'jpeg' ? 'jpeg' : meta.format;
      if (decoded !== sniff.format) {
        return fail('type_mismatch', '文件内容与扩展名不一致');
      }
      return { ok: true, ...sniff, width: meta.width, height: meta.height };
    } catch {
      return fail('broken_image', '图片无法解码，可能已损坏或不是图片');
    }
  }

  // sharp 不可用时退化为「magic + 结构」校验
  return { ok: true, ...sniff, width: null, height: null };
}

/** 给 multer 的原始文件名做个安全裁剪（只用于展示 / 记录）。 */
export function safeOriginalName(name, max = 120) {
  return path.basename(String(name || '')).replace(/[\u0000-\u001f]/g, '').slice(0, max);
}
