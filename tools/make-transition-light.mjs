/**
 * 明亮风格 · 转场（stinger）。
 *
 * 输出（assets/transitions/）：
 *   transition-light.webm          VP9 + alpha / 1920×1080 / 60fps / 1.3s
 *   transition-light-preview.png   中间帧叠在深色底上的预览图
 *
 * 设计：
 *   · 斜向光幕从左扫入 → 在 0.65s 处整屏铺满（OBS 的 Transition Point 设在这里）→ 向右扫出；
 *   · 光幕本身是白 + 冰蓝，边缘带一道金色细线，和明亮风格的面板描边呼应；
 *   · 全程背景透明，只有光幕不透明 —— 不能做成一块白底蒙版。
 *
 * 用法：node tools/make-transition-light.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import sharp from 'sharp';

const W = 1920;
const H = 1080;
const FPS = 60;
const DURATION = 1.3;
const FRAMES = Math.round(FPS * DURATION);
const CUT_POINT = 0.65;        // 满屏时刻（秒）

const OUT_DIR = path.join(process.cwd(), 'assets', 'transitions');
const OUT = path.join(OUT_DIR, 'transition-light.webm');
const PREVIEW = path.join(OUT_DIR, 'transition-light-preview.png');

const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

function frameSvg(t) {
  const p = t / DURATION;                 // 0 → 1
  const inPhase = Math.min(1, t / CUT_POINT);
  const outPhase = Math.max(0, (t - CUT_POINT) / (DURATION - CUT_POINT));

  // 前缘 / 后缘在旋转坐标系里的位置（旋转 -14°，斜着扫更像「光」）
  const span = W + 900;
  const front = -450 + ease(inPhase) * span;
  const back = -450 + ease(outPhase) * span;

  // 满屏瞬间再加一层白场，压住缝隙
  const flash = Math.max(0, 1 - Math.abs(t - CUT_POINT) / 0.10);
  const flashAlpha = Math.max(0, Math.min(1, flash)) * 0.9;

  const streak = (x, color, opacity, width) => (
    `<rect x="${x.toFixed(1)}" y="-700" width="${width}" height="2500" fill="${color}" fill-opacity="${opacity}"/>`
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="curtain" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="1"/>
      <stop offset="62%" stop-color="#f4fbff" stop-opacity="1"/>
      <stop offset="86%" stop-color="#d8eeff" stop-opacity=".96"/>
      <stop offset="100%" stop-color="#9fd6f5" stop-opacity=".72"/>
    </linearGradient>
    <linearGradient id="trail" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#8ecdf0" stop-opacity="0"/>
      <stop offset="70%" stop-color="#cfeeff" stop-opacity=".55"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity=".95"/>
    </linearGradient>
  </defs>

  <g transform="rotate(-14 ${W / 2} ${H / 2})">
    <!-- 主光幕：从左侧铺到前缘；后缘之后开始清出画面 -->
    <rect x="${back.toFixed(1)}" y="-700" width="${Math.max(0, front - back).toFixed(1)}" height="2500" fill="url(#curtain)"/>
    <!-- 前缘拖尾：给硬边一点光晕 -->
    <rect x="${(front - 90).toFixed(1)}" y="-700" width="90" height="2500" fill="url(#trail)" transform="translate(${front > 0 ? 0 : 0} 0)"/>
    <!-- 入场时的引导细线：金色 + 冰蓝，与明亮皮肤同语言 -->
    ${streak(front - 220, '#e0b26a', 0.85, 6)}
    ${streak(front - 250, '#4f9cc4', 0.5, 2)}
    ${outPhase > 0 ? streak(back - 6, '#e0b26a', 0.8 * (1 - outPhase * 0.6), 5) : ''}
  </g>

  <!-- 满屏瞬间的白场 -->
  <rect width="${W}" height="${H}" fill="#ffffff" fill-opacity="${flashAlpha.toFixed(3)}"/>
</svg>`;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 预览：扫入中途的帧叠在深色底上
  // 预览用扫入中途的帧（切点那一帧是纯白，看不出设计）
  const midFrame = Buffer.from(frameSvg(CUT_POINT * 0.45));
  await sharp({ create: { width: W, height: H, channels: 4, background: '#12161c' } })
    .composite([{ input: await sharp(midFrame).png().toBuffer() }])
    .png({ compressionLevel: 9 })
    .toFile(PREVIEW);
  console.log(`已写出 ${path.basename(PREVIEW)}`);

  const ff = spawn('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-',
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p',
    '-b:v', '0', '-crf', '26', '-row-mt', '1', '-auto-alt-ref', '0',
    '-an', OUT,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });

  const done = new Promise((resolve, reject) => {
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}`))));
  });

  for (let i = 0; i < FRAMES; i++) {
    const buf = await sharp(Buffer.from(frameSvg(i / FPS))).ensureAlpha().raw().toBuffer();
    if (buf.length !== W * H * 4) throw new Error(`帧尺寸不对：${buf.length}`);
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
  await done;

  const size = fs.statSync(OUT).size;
  console.log(`已写出 ${path.basename(OUT)} · ${(size / 1024).toFixed(0)} KB · ${W}×${H} @${FPS}fps · ${DURATION}s · 转场点 ${CUT_POINT}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
