/**
 * 生成直播间背景（与 直播间模板.png 同一套视觉语言）。
 * 输出：assets/直播间背景.png（1920×1080 不透明背景）
 */
import fs from 'node:fs';
import sharp from 'sharp';

const W = 1920, H = 1080;
const C = {
  red: '#d0344e',
  blue: '#3d78c9',
  line: '#2a2d32',
  dim: '#4a4e56',
  mute: '#33363c',
};
const FONT = "'Microsoft YaHei','Noto Sans SC',sans-serif";
const MONO = "'Consolas','Cascadia Mono',monospace";

const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#181a1f"/>
      <stop offset="0.55" stop-color="#111216"/>
      <stop offset="1" stop-color="#0b0c0e"/>
    </linearGradient>

    <radialGradient id="glowL" cx="0" cy="0.5" r="0.55">
      <stop offset="0" stop-color="${C.red}" stop-opacity="0.16"/>
      <stop offset="0.45" stop-color="${C.red}" stop-opacity="0.05"/>
      <stop offset="1" stop-color="${C.red}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowR" cx="1" cy="0.5" r="0.55">
      <stop offset="0" stop-color="${C.blue}" stop-opacity="0.16"/>
      <stop offset="0.45" stop-color="${C.blue}" stop-opacity="0.05"/>
      <stop offset="1" stop-color="${C.blue}" stop-opacity="0"/>
    </radialGradient>

    <radialGradient id="vignette" cx="0.5" cy="0.48" r="0.75">
      <stop offset="0.55" stop-color="#000000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.55"/>
    </radialGradient>

    <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
      <path d="M 48 0 L 0 0 0 48" fill="none" stroke="#ffffff" stroke-opacity="0.035" stroke-width="1"/>
    </pattern>
    <pattern id="gridBig" width="192" height="192" patternUnits="userSpaceOnUse">
      <path d="M 192 0 L 0 0 0 192" fill="none" stroke="#ffffff" stroke-opacity="0.05" stroke-width="1"/>
    </pattern>

    <linearGradient id="topFade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#08090b" stop-opacity="0.72"/>
      <stop offset="0.78" stop-color="#08090b" stop-opacity="0.32"/>
      <stop offset="1" stop-color="#08090b" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <!-- 底 -->
  <rect width="${W}" height="${H}" fill="url(#bg)"/>

  <!-- 左右两侧的队伍色氛围光 -->
  <rect width="${W / 2}" height="${H}" fill="url(#glowL)"/>
  <rect x="${W / 2}" width="${W / 2}" height="${H}" fill="url(#glowR)"/>

  <!-- 技术网格 -->
  <rect width="${W}" height="${H}" fill="url(#grid)"/>
  <rect width="${W}" height="${H}" fill="url(#gridBig)"/>

  <!-- 顶部给比分叠加的压暗带 -->
  <rect width="${W}" height="300" fill="url(#topFade)"/>
  <line x1="0" y1="288" x2="${W / 2}" y2="288" stroke="${C.red}" stroke-width="1" stroke-opacity="0.32"/>
  <line x1="${W / 2}" y1="288" x2="${W}" y2="288" stroke="${C.blue}" stroke-width="1" stroke-opacity="0.32"/>

  <!-- 边缘色条（与模板的 1P/2P 侧条呼应） -->
  <rect x="0" y="0" width="4" height="${H}" fill="${C.red}" opacity="0.5"/>
  <rect x="${W - 4}" y="0" width="4" height="${H}" fill="${C.blue}" opacity="0.5"/>

  <!-- 暗角 -->
  <rect width="${W}" height="${H}" fill="url(#vignette)"/>

  <!-- 角落刻度 -->
  <g stroke="${C.mute}" stroke-width="1.5" fill="none">
    <path d="M 22 40 V 22 H 40"/>
    <path d="M ${W - 40} 22 H ${W - 22} V 40"/>
    <path d="M 22 ${H - 40} V ${H - 22} H 40"/>
    <path d="M ${W - 40} ${H - 22} H ${W - 22} V ${H - 40}"/>
  </g>

  <!-- 顶部标识 -->
  <rect x="40" y="28" width="7" height="7" fill="${C.red}"/>
  <text x="56" y="36" font-family="${MONO}" font-size="13" letter-spacing="3" fill="${C.dim}">CHUNITHM · LIVE ROOM</text>
  <text x="${W - 40}" y="36" font-family="${MONO}" font-size="13" letter-spacing="2" fill="${C.dim}" text-anchor="end">STAGE 01 · 1920 × 1080</text>

  <!-- 底部标识 -->
  <text x="40" y="${H - 26}" font-family="${MONO}" font-size="11" letter-spacing="2" fill="${C.mute}">LIVE BROADCAST LAYOUT</text>
  <text x="${W - 40}" y="${H - 26}" font-family="${MONO}" font-size="11" letter-spacing="2" fill="${C.mute}" text-anchor="end">OBS BROWSER · NDI / HDMI</text>

</svg>`;

fs.mkdirSync('assets', { recursive: true });
fs.writeFileSync('assets/backgrounds/dark/直播间背景.svg', svg, 'utf8');
const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
fs.writeFileSync('assets/backgrounds/dark/直播间背景.png', png);
console.log('generated: assets/直播间背景.png / assets/直播间背景.svg');
