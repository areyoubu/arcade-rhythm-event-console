/**
 * 明亮风格 · 整屏场景动态背景。
 *
 * 输出（assets/backgrounds/light/）：
 *   light-bg.mp4       1920×1080 / 30fps / 12s 无缝循环 / H.264（整屏场景用）
 *   light-bg.png       首帧静帧（`?static=1` 或视频解码失败时兜底）
 *   light-bg-dim.mp4   同一条动画压暗版：放在「游戏画面 / 摄像头」后面当直播底色用，
 *   light-bg-dim.png   纯白底会盖过机台画面，这一版整体亮度 ×0.72
 *
 * 和待机画面那张背景的区别：
 *   · 待机画面是「空场」，所以极淡极净；
 *   · 这张要垫在比分画面 / 随机选曲 / 奖品大屏后面，得有明显的运动感和层次，
 *     但整体仍要亮、要克制 —— 面板与文字始终是主角。
 *
 * 所有动画以 LOOP_SECONDS 为周期，首尾帧能接上。
 *
 * 用法：node tools/make-light-bg.mjs
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

const OUT_DIR = path.join(process.cwd(), 'assets', 'backgrounds', 'light');
const VARIANTS = [
  { name: 'light-bg', brightness: 1 },
  { name: 'light-bg-dim', brightness: 0.72 },
];

function rand(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

const SPARKS = Array.from({ length: 54 }, (_, i) => ({
  x: rand(i + 3) * W,
  y: rand(i + 57) * H,
  r: 1 + rand(i + 101) * 2.6,
  amp: 18 + rand(i + 149) * 54,
  phase: rand(i + 211) * Math.PI * 2,
  warm: rand(i + 263) > 0.76,
}));

const BOKEH = Array.from({ length: 14 }, (_, i) => ({
  x: 120 + rand(i + 5) * (W - 240),
  y: 120 + rand(i + 71) * (H - 240),
  r: 90 + rand(i + 131) * 190,
  dx: 40 + rand(i + 181) * 90,
  dy: 26 + rand(i + 233) * 70,
  phase: rand(i + 307) * Math.PI * 2,
  hue: rand(i + 359) > 0.5 ? '120,200,240' : '255,208,150',
}));

function frameSvg(t) {
  const p = t / LOOP_SECONDS;
  const a = p * Math.PI * 2;

  // 斜向细网格：一个循环刚好平移一格
  const grid = [];
  const spacing = 150;
  const shift = p * spacing;
  for (let i = -20; i < 60; i++) {
    const x = i * spacing + shift;
    grid.push(`<line x1="${x}" y1="-260" x2="${x + 1500}" y2="1340" stroke="#2b7ea6" stroke-opacity=".07" stroke-width="1"/>`);
  }
  for (let i = -6; i < 26; i++) {
    const y = i * spacing + shift;
    grid.push(`<line x1="-200" y1="${y}" x2="2120" y2="${y}" stroke="#e0b26a" stroke-opacity=".045" stroke-width="1"/>`);
  }

  // 光斑：缓慢游走的柔光团，给画面「厚度」
  const bokeh = BOKEH.map((b, i) => {
    const x = b.x + Math.sin(a + b.phase) * b.dx;
    const y = b.y + Math.cos(a + b.phase * 1.3) * b.dy;
    const o = 0.16 + 0.12 * (0.5 + 0.5 * Math.sin(a * 2 + b.phase));
    // 用径向渐变画光团：实心圆在浅色底上会变成一颗颗「圆点」，很假
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${b.r.toFixed(0)}" fill="url(#${b.hue.startsWith('120') ? 'bokehBlue' : 'bokehWarm'})" fill-opacity="${o.toFixed(3)}"/>`;
  }).join('');

  // 右侧同心环（与待机画面同语言）
  const rings = [];
  const cx = 1480;
  const cy = 560;
  for (let i = 0; i < 3; i++) {
    const r = 330 + i * 96;
    const rot = p * 360 * (i % 2 ? -1 : 1) + i * 24;
    rings.push(`<g transform="rotate(${rot.toFixed(2)} ${cx} ${cy})">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#4f9cc4" stroke-opacity="${(0.18 - i * 0.045).toFixed(3)}"
        stroke-width="${i === 0 ? 2 : 1}" stroke-dasharray="${9 + i * 5} ${16 + i * 9} ${i === 1 ? '56 20' : ''}"/>
    </g>`);
  }

  // 横贯的细数据线：整条缓慢上下浮动
  const lines = [];
  for (let i = 0; i < 3; i++) {
    const y = 180 + i * 190 + Math.sin(a + i * 1.1) * 34;
    const w = 380 + Math.sin(a * 2 + i) * 120;
    const x = (i % 2 ? W - 120 - w : 120) + Math.sin(a + i) * 40;
    lines.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(0)}" height="1.5" fill="#2f8fbc" fill-opacity=".14"/>`);
    lines.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="46" height="1.5" fill="#e0b26a" fill-opacity=".5"/>`);
  }

  // 斜向扫光：一整个循环走一遍，首尾都在画外
  const sweepX = -900 + p * (W + 1800);
  const sweep = `<g transform="rotate(-16 ${W / 2} ${H / 2})">
      <rect x="${sweepX}" y="-700" width="460" height="2500" fill="url(#sweep)"/>
    </g>`;

  const sparks = SPARKS.map((s, i) => {
    const x = s.x + Math.sin(a + s.phase) * s.amp;
    const y = s.y + Math.cos(a + s.phase * 1.6) * (s.amp * 0.8);
    const o = 0.12 + 0.3 * (0.5 + 0.5 * Math.sin(a * 3 + i));
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${s.r.toFixed(1)}" fill="${s.warm ? '#e9b975' : '#63b4d8'}" fill-opacity="${o.toFixed(3)}"/>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="base" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="36%" stop-color="#f3fafe"/>
      <stop offset="72%" stop-color="#e6f2fa"/>
      <stop offset="100%" stop-color="#d9ebf6"/>
    </linearGradient>
    <linearGradient id="sweep" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="46%" stop-color="#ffffff" stop-opacity=".46"/>
      <stop offset="54%" stop-color="#bfe6ff" stop-opacity=".22"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="bokehBlue" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#7cc3e8" stop-opacity=".9"/>
      <stop offset="55%" stop-color="#9fd6f2" stop-opacity=".35"/>
      <stop offset="100%" stop-color="#c8ebfb" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="bokehWarm" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#f6cf94" stop-opacity=".85"/>
      <stop offset="55%" stop-color="#f8ddb0" stop-opacity=".32"/>
      <stop offset="100%" stop-color="#fdf0d8" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="vig" cx="50%" cy="46%" r="72%">
      <stop offset="60%" stop-color="#0a2540" stop-opacity="0"/>
      <stop offset="100%" stop-color="#0a2540" stop-opacity=".12"/>
    </radialGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#base)"/>
  ${bokeh}
  <g>${grid.join('')}</g>
  ${rings.join('')}
  ${lines.join('')}
  ${sparks}
  ${sweep}
  <rect width="${W}" height="${H}" fill="url(#vig)"/>
</svg>`;
}

/** 一条变体：渲染 360 帧 → 编码 mp4，并写一张首帧静帧 */
async function renderVariant({ name, brightness }) {
  const mp4 = path.join(OUT_DIR, `${name}.mp4`);
  const poster = path.join(OUT_DIR, `${name}.png`);
  const grade = (img) => (brightness === 1 ? img : img.modulate({ brightness }));

  const first = await grade(sharp(Buffer.from(frameSvg(0)))).png({ compressionLevel: 9 }).toBuffer();
  fs.writeFileSync(poster, first);
  console.log(`已写出 ${path.basename(poster)} · ${(first.length / 1024).toFixed(0)} KB`);

  const ff = spawn('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '21',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an',
    mp4,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });

  const done = new Promise((resolve, reject) => {
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}`))));
  });

  for (let i = 0; i < FRAMES; i++) {
    let img = sharp(Buffer.from(frameSvg(i / FPS)));
    img = grade(img);
    const buf = await img.removeAlpha().raw().toBuffer();
    const rgba = Buffer.alloc(W * H * 4);
    for (let p = 0, q = 0; p < buf.length; p += 3, q += 4) {
      rgba[q] = buf[p]; rgba[q + 1] = buf[p + 1]; rgba[q + 2] = buf[p + 2]; rgba[q + 3] = 255;
    }
    if (!ff.stdin.write(rgba)) await new Promise((r) => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
  await done;

  const size = fs.statSync(mp4).size;
  console.log(`已写出 ${path.basename(mp4)} · ${(size / 1024 / 1024).toFixed(2)} MB · 亮度 ×${brightness}`);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const v of VARIANTS) {
    console.log(`
▶ 渲染 ${v.name}`);
    await renderVariant(v);
  }
  console.log(`
完成：${W}×${H} @${FPS}fps · ${LOOP_SECONDS}s 循环`);
}

main().catch((e) => { console.error(e); process.exit(1); });
