/**
 * 直播待机画面 · 动态背景生成器。
 *
 * 输出（assets/）：
 *   backgrounds/light/standby-bg.mp4   1920×1080 / 30fps / 12s 无缝循环 / H.264
 *   backgrounds/light/standby-bg.png   首帧静帧，OBS 视频解码失败或 ?static=1 时兜底
 *
 * 视觉口径：明亮、冷色、科技感（CHUNITHM 官网那种白 + 冰蓝，加一点金色点缀），
 * 给前景的标题 / 看板娘让位 —— 背景只做「氛围」，不抢主体。
 *
 * 所有动画都以 LOOP_SECONDS 为周期，保证首尾帧能接上：
 *   · 网格平移 = 恰好一个格距；
 *   · 圆环旋转 = 整数圈；
 *   · 粒子用 sin 漂移；
 *   · 光带在循环开头/结尾都在画面之外。
 *
 * 用法：node tools/make-standby-bg.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import sharp from 'sharp';

const W = 1920;
const H = 1080;
const FPS = 30;
const LOOP_SECONDS = 12;
const FRAMES = FPS * LOOP_SECONDS;

const ASSETS = path.join(process.cwd(), 'assets', 'backgrounds', 'light');
const MP4 = path.join(ASSETS, 'standby-bg.mp4');
const POSTER = path.join(ASSETS, 'standby-bg.png');

/** 简单的确定性伪随机，保证每次生成结果一致 */
function rand(seed) {
  let x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

const PARTICLES = Array.from({ length: 46 }, (_, i) => ({
  x: rand(i + 1) * W,
  y: rand(i + 91) * H,
  r: 1.2 + rand(i + 31) * 3.4,
  amp: 14 + rand(i + 61) * 46,
  phase: rand(i + 121) * Math.PI * 2,
  drift: 26 + rand(i + 151) * 54,
  hue: rand(i + 181) > 0.72 ? '#e8c07a' : '#5fadd6',
}));

/** 一大块径向光晕 */
function glow(cx, cy, r, color, opacity) {
  return `<radialGradient id="g${cx}${cy}" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${color}" stop-opacity="${opacity}"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </radialGradient>
    <rect x="${cx - r}" y="${cy - r}" width="${r * 2}" height="${r * 2}" fill="url(#g${cx}${cy})"/>`;
}

function frameSvg(t) {
  const p = t / LOOP_SECONDS;            // 0 → 1
  const a = p * Math.PI * 2;

  // 网格：一格格距 / 一圈
  const gridShift = p * 140;
  const diag = [];
  for (let i = -30; i < 60; i++) {
    const x = i * 140 + gridShift;
    diag.push(`<line x1="${x}" y1="-200" x2="${x + 1400}" y2="1280" stroke="#2f7fa8" stroke-opacity=".085" stroke-width="1"/>`);
  }

  // 右侧同心圆环（看板娘背后的「目标环」）
  const rings = [];
  const cx = 1560;
  const cy = 560;
  for (let i = 0; i < 3; i++) {
    const r = 360 + i * 92;
    const rot = (p * 360 * (i % 2 === 0 ? 1 : -1)) + i * 30;
    rings.push(`<g transform="rotate(${rot.toFixed(3)} ${cx} ${cy})">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#4f9cc4" stroke-opacity="${0.3 - i * 0.06}"
        stroke-width="${i === 0 ? 2 : 1}" stroke-dasharray="${8 + i * 6} ${14 + i * 10} ${i === 1 ? '60 22' : ''}"/>
    </g>`);
    rings.push(`<circle cx="${cx}" cy="${cy}" r="${r - 6}" fill="none" stroke="#ffffff" stroke-opacity=".28" stroke-width="1"/>`);
  }

  // 粒子：上下 sin 漂移 + 左右 sin 摇摆
  const dots = PARTICLES.map((d, i) => {
    const dx = Math.sin(a + d.phase) * d.amp;
    const dy = Math.cos(a + d.phase * 1.7) * d.drift;
    const o = 0.22 + 0.26 * (0.5 + 0.5 * Math.sin(a * 2 + d.phase));
    return `<circle cx="${(d.x + dx).toFixed(2)}" cy="${(d.y + dy).toFixed(2)}" r="${d.r.toFixed(2)}"
      fill="${d.hue}" fill-opacity="${o.toFixed(3)}"/>`;
  }).join('');

  // 斜向光带：一整个循环扫过一次，首尾都在画外
  const sweepX = -700 + p * (W + 1500);
  const sweep = `<g transform="rotate(-18 ${W / 2} ${H / 2})">
      <rect x="${sweepX}" y="-500" width="260" height="2100" fill="url(#sweep)"/>
    </g>`;

  /*
   * 扫描带：一条柔光缓慢向下扫过。
   * 不用 1px 实线 —— 在 1080p 上那条线更像画错的横纹，而不是设计元素。
   */
  const scanY = ((p * 1.0) % 1) * (H + 200) - 100;
  const scan = `<g opacity="${(0.85 * Math.sin(Math.PI * ((p * 1.0) % 1))).toFixed(3)}">
      <rect x="0" y="${scanY - 90}" width="${W}" height="180" fill="url(#scanGlow)"/>
    </g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="base" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="42%" stop-color="#f2f9fe"/>
      <stop offset="78%" stop-color="#e6f2fb"/>
      <stop offset="100%" stop-color="#dcecf8"/>
    </linearGradient>
    <linearGradient id="sweep" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="50%" stop-color="#ffffff" stop-opacity=".55"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="scanGlow" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#9ad6f0" stop-opacity="0"/>
      <stop offset="50%" stop-color="#9ad6f0" stop-opacity=".18"/>
      <stop offset="100%" stop-color="#9ad6f0" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#base)"/>
  ${glow(420, 120, 900, '#cbeaff', 0.75)}
  ${glow(1520, 980, 760, '#bfe0f2', 0.55)}
  ${glow(1700, 160, 520, '#ffffff', 0.9)}

  <g>${diag.join('')}</g>
  ${rings.join('')}
  ${dots}
  ${sweep}
  ${scan}
</svg>`;
}

async function main() {
  fs.mkdirSync(ASSETS, { recursive: true });

  // 首帧静帧（兜底 / OBS 视频解码失败时用）
  const first = await sharp(Buffer.from(frameSvg(0))).png({ compressionLevel: 9 }).toBuffer();
  fs.writeFileSync(POSTER, first);
  console.log(`已写出 ${path.basename(POSTER)} · ${(first.length / 1024).toFixed(0)} KB`);

  const ff = spawn('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '21',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an',
    MP4,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });

  const done = new Promise((resolve, reject) => {
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}`))));
  });

  for (let i = 0; i < FRAMES; i++) {
    const buf = await sharp(Buffer.from(frameSvg(i / FPS)))
      .resize(W, H)
      .removeAlpha()
      .raw()
      .toBuffer();
    // ffmpeg 要 rgba，这里补一个不透明的 alpha 通道
    const rgba = Buffer.alloc(W * H * 4);
    for (let p = 0, q = 0; p < buf.length; p += 3, q += 4) {
      rgba[q] = buf[p];
      rgba[q + 1] = buf[p + 1];
      rgba[q + 2] = buf[p + 2];
      rgba[q + 3] = 255;
    }
    if (!ff.stdin.write(rgba)) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % 60 === 0) process.stdout.write(`\r渲染 ${i}/${FRAMES} 帧`);
  }
  ff.stdin.end();
  await done;

  const size = fs.statSync(MP4).size;
  console.log(`\n已写出 ${path.basename(MP4)} · ${(size / 1024 / 1024).toFixed(2)} MB · ${W}×${H} @${FPS}fps · ${LOOP_SECONDS}s 循环`);
}

main().catch((e) => { console.error(e); process.exit(1); });
