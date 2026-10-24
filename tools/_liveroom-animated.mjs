/**
 * 生成「动态直播间背景」MP4（12 秒无缝循环，1920×1080 / 30fps）。
 *
 * 与静态背景同一套视觉语言：
 *   · 深灰蓝渐变 + 48/192px 技术网格（缓慢滚动）
 *   · 左侧红 / 右侧蓝氛围光（呼吸 + 漂移）
 *   · 一条极淡的扫描光带、边缘流动高光
 *   · 细小的漂浮尘点（椭圆轨迹，确保无缝循环）
 *
 * 用法：
 *   node tools/_liveroom-animated.mjs          # 生成完整 MP4
 *   node tools/_liveroom-animated.mjs --test   # 只渲染一帧到 tools/_frame.png
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import sharp from 'sharp';

const W = 1920, H = 1080;
const FPS = 30;
const DURATION = 12;                 // 秒
const FRAMES = FPS * DURATION;       // 360
const C = {
  red: '#d0344e',
  blue: '#3d78c9',
  dim: '#4a4e56',
  mute: '#33363c',
  line: '#2a2d32',
};
const MONO = "'Consolas','Cascadia Mono',monospace";

// ── 确定性随机（保证每次生成一致）──
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261024);
const DUST = Array.from({ length: 46 }, () => {
  const tint = rand();
  return {
    cx: 60 + rand() * (W - 120),
    cy: 70 + rand() * (H - 140),
    rx: 14 + rand() * 78,
    ry: 8 + rand() * 46,
    phase: rand() * Math.PI * 2,
    r: 0.7 + rand() * 1.7,
    o: 0.035 + rand() * 0.075,
    color: tint < 0.42 ? C.red : tint < 0.84 ? C.blue : '#ffffff',
  };
});

function frameSvg(t) {
  const T = DURATION;
  const ang = (2 * Math.PI * t) / T;

  // 网格：12 秒正好滚动一个 192px 大格 → 首尾无缝
  const gridOff = (t / T) * 192;

  // 扫描光带：6 秒一次，从上方扫到下方；首尾都在画面外
  const scanY = -260 + ((t % 6) / 6) * (H + 520);

  // 边缘流动高光：12 秒走完一屏，起点/终点都在画面外；右侧错开半周期
  const segL = -180 + (t / T) * (H + 180);
  const segR = -180 + (((t / T) + 0.5) % 1) * (H + 180);

  // 氛围光：缓慢漂移 + 呼吸
  const lcx = 0.21 + 0.045 * Math.sin(ang);
  const lcy = 0.5 + 0.055 * Math.sin(ang + Math.PI / 3);
  const lr = 0.52 + 0.05 * Math.sin(2 * ang);
  const rcx = 0.79 - 0.045 * Math.sin(ang);
  const rcy = 0.5 + 0.055 * Math.sin(ang + Math.PI + Math.PI / 3);
  const rr = 0.52 + 0.05 * Math.sin(2 * ang + Math.PI);
  const glowOpL = 0.82 + 0.18 * Math.sin(ang);
  const glowOpR = 0.82 + 0.18 * Math.sin(ang + Math.PI);
  const barOpL = 0.42 + 0.12 * Math.sin(2 * ang);
  const barOpR = 0.42 + 0.12 * Math.sin(2 * ang + Math.PI);

  const dust = DUST.map((p) => {
    const a = p.phase + ang;
    const x = p.cx + p.rx * Math.cos(a);
    const y = p.cy + p.ry * Math.sin(a);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${p.r.toFixed(2)}" fill="${p.color}" opacity="${p.o.toFixed(3)}"/>`;
  }).join('');

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#181a1f"/>
      <stop offset="0.55" stop-color="#111216"/>
      <stop offset="1" stop-color="#0b0c0e"/>
    </linearGradient>

    <radialGradient id="glowL" cx="${lcx.toFixed(3)}" cy="${lcy.toFixed(3)}" r="${lr.toFixed(3)}">
      <stop offset="0" stop-color="${C.red}" stop-opacity="0.17"/>
      <stop offset="0.45" stop-color="${C.red}" stop-opacity="0.055"/>
      <stop offset="1" stop-color="${C.red}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowR" cx="${rcx.toFixed(3)}" cy="${rcy.toFixed(3)}" r="${rr.toFixed(3)}">
      <stop offset="0" stop-color="${C.blue}" stop-opacity="0.17"/>
      <stop offset="0.45" stop-color="${C.blue}" stop-opacity="0.055"/>
      <stop offset="1" stop-color="${C.blue}" stop-opacity="0"/>
    </radialGradient>

    <radialGradient id="vignette" cx="0.5" cy="0.48" r="0.75">
      <stop offset="0.55" stop-color="#000000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.55"/>
    </radialGradient>

    <pattern id="grid" x="0" y="${(-gridOff).toFixed(2)}" width="48" height="48" patternUnits="userSpaceOnUse">
      <path d="M 48 0 L 0 0 0 48" fill="none" stroke="#ffffff" stroke-opacity="0.035" stroke-width="1"/>
    </pattern>
    <pattern id="gridBig" x="0" y="${(-gridOff).toFixed(2)}" width="192" height="192" patternUnits="userSpaceOnUse">
      <path d="M 192 0 L 0 0 0 192" fill="none" stroke="#ffffff" stroke-opacity="0.05" stroke-width="1"/>
    </pattern>

    <linearGradient id="topFade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#08090b" stop-opacity="0.72"/>
      <stop offset="0.78" stop-color="#08090b" stop-opacity="0.32"/>
      <stop offset="1" stop-color="#08090b" stop-opacity="0"/>
    </linearGradient>

    <linearGradient id="scan" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="0.45" stop-color="#ffffff" stop-opacity="0.05"/>
      <stop offset="0.55" stop-color="#ffffff" stop-opacity="0.05"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>

    <linearGradient id="edgeSeg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>

  <rect width="${W / 2}" height="${H}" fill="url(#glowL)" opacity="${glowOpL.toFixed(3)}"/>
  <rect x="${W / 2}" width="${W / 2}" height="${H}" fill="url(#glowR)" opacity="${glowOpR.toFixed(3)}"/>

  <rect width="${W}" height="${H}" fill="url(#grid)"/>
  <rect width="${W}" height="${H}" fill="url(#gridBig)"/>

  <!-- 漂浮尘点 -->
  <g>${dust}</g>

  <!-- 扫描光带 -->
  <rect x="0" y="${scanY.toFixed(1)}" width="${W}" height="260" fill="url(#scan)"/>

  <!-- 顶部比分叠加区压暗 -->
  <rect width="${W}" height="300" fill="url(#topFade)"/>
  <line x1="0" y1="288" x2="${W / 2}" y2="288" stroke="${C.red}" stroke-width="1" stroke-opacity="0.32"/>
  <line x1="${W / 2}" y1="288" x2="${W}" y2="288" stroke="${C.blue}" stroke-width="1" stroke-opacity="0.32"/>

  <!-- 边缘色条 + 流动高光 -->
  <rect x="0" y="0" width="4" height="${H}" fill="${C.red}" opacity="${barOpL.toFixed(3)}"/>
  <rect x="${W - 4}" y="0" width="4" height="${H}" fill="${C.blue}" opacity="${barOpR.toFixed(3)}"/>
  <rect x="0" y="${segL.toFixed(1)}" width="4" height="180" fill="url(#edgeSeg)"/>
  <rect x="${W - 4}" y="${segR.toFixed(1)}" width="4" height="180" fill="url(#edgeSeg)"/>

  <rect width="${W}" height="${H}" fill="url(#vignette)"/>

  <!-- 角落刻度 -->
  <g stroke="${C.mute}" stroke-width="1.5" fill="none">
    <path d="M 22 40 V 22 H 40"/>
    <path d="M ${W - 40} 22 H ${W - 22} V 40"/>
    <path d="M 22 ${H - 40} V ${H - 22} H 40"/>
    <path d="M ${W - 40} ${H - 22} H ${W - 22} V ${H - 40}"/>
  </g>

  <!-- 标识 -->
  <rect x="40" y="28" width="7" height="7" fill="${C.red}"/>
  <text x="56" y="36" font-family="${MONO}" font-size="13" letter-spacing="3" fill="${C.dim}">CHUNITHM · LIVE ROOM</text>
  <text x="${W - 40}" y="36" font-family="${MONO}" font-size="13" letter-spacing="2" fill="${C.dim}" text-anchor="end">STAGE 01 · 1920 × 1080</text>
  <text x="40" y="${H - 26}" font-family="${MONO}" font-size="11" letter-spacing="2" fill="${C.mute}">LIVE BROADCAST LAYOUT</text>
  <text x="${W - 40}" y="${H - 26}" font-family="${MONO}" font-size="11" letter-spacing="2" fill="${C.mute}" text-anchor="end">OBS BROWSER · NDI / HDMI</text>
</svg>`;
}

async function renderFrame(t) {
  return sharp(Buffer.from(frameSvg(t))).png({ compressionLevel: 1 }).toBuffer();
}

const TEST = process.argv.includes('--test');
if (TEST) {
  const t0 = Date.now();
  const buf = await renderFrame(3);
  fs.writeFileSync('tools/_frame.png', buf);
  console.log(`frame rendered in ${Date.now() - t0}ms, ${buf.length} bytes`);
  process.exit(0);
}

fs.mkdirSync('assets', { recursive: true });
const out = 'assets/直播间背景-动态.mp4';
const ff = spawn('ffmpeg', [
  '-y',
  '-f', 'image2pipe',
  '-framerate', String(FPS),
  '-i', '-',
  '-vf', 'format=yuv420p,noise=alls=2:allf=t+u',
  '-c:v', 'libx264',
  '-preset', 'medium',
  '-crf', '18',
  '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart',
  out,
], { stdio: ['pipe', 'inherit', 'inherit'] });

function writeAsync(stream, buf) {
  return new Promise((resolve, reject) => {
    if (stream.write(buf)) return resolve();
    stream.once('drain', resolve);
    stream.once('error', reject);
  });
}

const started = Date.now();
for (let i = 0; i < FRAMES; i++) {
  const t = i / FPS;
  const buf = await renderFrame(t);
  await writeAsync(ff.stdin, buf);
  if (i % 30 === 0) {
    process.stdout.write(`\rframe ${i + 1}/${FRAMES}  ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
}
ff.stdin.end();
await new Promise((resolve) => ff.on('close', resolve));
console.log(`\ndone: ${out}  (${FRAMES} frames, ${(Date.now() - started) / 1000}s)`);
