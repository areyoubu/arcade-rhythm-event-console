/**
 * 图片内容校验 —— 不信任扩展名 / Content-Type。
 *
 * 守住：
 *   · 真实 PNG 能通过并拿到尺寸（sharp 可用时）；
 *   · HTML / EXE / 截断的 PNG 一律拒绝；
 *   · SVG 的脚本 / 事件属性被拒绝，奖品上传直接不允许 SVG；
 *   · 扩展名与真实格式不一致能被识别。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRIZE_FORMATS, sniffImage, validateImageBuffer, extMatchesImage, validateSvg, safeOriginalName,
} from '../server/image-validate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_PNG = fs.readFileSync(path.join(ROOT, 'assets', '直播间模板.png'));

test('★ 真实 PNG：magic、结构、解码尺寸都通过', async () => {
  assert.deepEqual(sniffImage(REAL_PNG), { format: 'png', ext: 'png', mime: 'image/png' });
  const r = await validateImageBuffer(REAL_PNG);
  assert.equal(r.ok, true);
  assert.equal(r.format, 'png');
  // sharp 可用时应该能拿到尺寸；缺失时允许为 null（降级）
  if (r.width != null) {
    assert.ok(r.width > 0 && r.height > 0);
  }
});

test('★★ HTML / EXE / 截断 PNG 都不能冒充图片', async () => {
  const html = Buffer.from('<!doctype html><html><script>alert(1)</script></html>');
  assert.equal((await validateImageBuffer(html)).nack.code, 'not_image');

  const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(128, 0)]);
  assert.equal((await validateImageBuffer(exe)).nack.code, 'not_image');

  const truncated = REAL_PNG.subarray(0, 80);
  const r = await validateImageBuffer(truncated);
  assert.equal(r.ok, false);
  assert.equal(r.nack.code, 'broken_image');
});

test('★★ 扩展名与真实格式不一致必须能识别', () => {
  const png = sniffImage(REAL_PNG);
  assert.equal(extMatchesImage('png', png), true);
  assert.equal(extMatchesImage('jpg', png), false, 'PNG 内容不能命名为 .jpg');
  assert.equal(extMatchesImage('jpeg', { format: 'jpeg' }), true);
  assert.equal(extMatchesImage('jpg', { format: 'jpeg' }), true);
});

test('★★ SVG 一律拒绝（可携带脚本，属可执行内容）', async () => {
  const safe = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>');
  const evil = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>');

  // 无论多「干净」的 SVG，内容校验都直接拒绝
  for (const buf of [safe, evil]) {
    const r = await validateImageBuffer(buf);
    assert.equal(r.ok, false, 'SVG 必须被拒绝');
    assert.equal(r.nack.code, 'svg_forbidden');
  }

  // 奖品图片明确只允许光栅格式，同样拒绝 SVG
  const r = await validateImageBuffer(safe, { formats: PRIZE_FORMATS });
  assert.equal(r.nack.code, 'svg_forbidden');

  // 独立的 validateSvg 黑名单仍保留（用于参考 / 其它调用），能识别脚本
  assert.equal(validateSvg(evil).nack.code, 'unsafe_svg');
});

test('★ 大小上限与原始文件名裁剪', async () => {
  const r = await validateImageBuffer(REAL_PNG, { maxBytes: 100 });
  assert.equal(r.nack.code, 'too_large');
  assert.equal(safeOriginalName('C:\\Users\\a\\奖品.png'), '奖品.png');
  assert.equal(safeOriginalName('a\u0000b.png'), 'ab.png');
});
