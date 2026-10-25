/**
 * 生成「直播间布局模板」：
 *   · 2 个屏幕采集区域（上，左右并排）
 *   · 2 个摄像头区域（下，左右并排）
 *   · 不含比分条 / 选手牌 —— 那些由 /render/score 浏览器源叠加
 *
 * 产出（assets/layouts/）：
 *   直播间模板.png            叠加用：四个窗口是**透明**的，其余是深色框
 *   直播间模板-预览.png       标注预览：窗口填深色并标出区域名称与尺寸
 *   直播间模板.svg            标注预览的可编辑源文件
 *   直播间模板-明亮.png       明亮风格叠加：浅色框（透明洞不变）
 *   直播间模板-明亮-降亮.png  明亮风格的低亮度版：灰蓝框，压在比赛画面上不刺眼
 *   直播间模板-明亮-预览.png  明亮版预览
 */
import fs from 'node:fs';
import sharp from 'sharp';

const W = 1920, H = 1080;

// ── 几何 ──
const M = 40;                       // 左右边距
const TOP = 296;                    // 上方留给浏览器比分叠加
const GAP = 24;                     // 两列之间的中缝
const SIDE = (W - M * 2 - GAP) / 2; // 908
const SH = 510;                     // 屏幕采集高（≈16:9）
const VGAP = 20;                    // 屏幕与摄像头之间的横缝
const CH = 196;                     // 摄像头高
const LX = M;
const RX = M + SIDE + GAP;
const SY = TOP;
const CY = TOP + SH + VGAP;
const FRAME = 12;                   // 深色框外扩
const FX = M - FRAME, FY = TOP - FRAME;
const FW = RX + SIDE + FRAME - FX;
const FH = CY + CH + FRAME - FY;
const R = 6;                        // 窗口圆角

const C = {
  frame: '#141519',
  frameEdge: '#2a2d32',
  win: '#0b0c0e',
  line: '#3a3d43',
  red: '#d0344e',
  blue: '#3d78c9',
  amber: '#c8913f',
  text: '#e8e8e8',
  dim: '#8d9199',
  mute: '#5f646c',
};
const DARK_TH = { fill: '#141519', edge: '#2a2d32', line: '#3a3d43' };
/** 明亮：浅色框，四个窗口仍然是透明的 */
const LIGHT_TH = { fill: '#f4f9fd', fillOpacity: 0.94, edge: '#b9ccda', line: 'rgba(18,52,80,.28)' };
/**
 * 明亮 · 降亮：整体压成灰蓝，亮度比纯白低一档。
 * 比赛场景里机台画面本身很亮，纯白框会抢注意力，这一版专门给比赛用。
 */
const LIGHT_DIM_TH = { fill: '#c3cfda', fillOpacity: 0.93, edge: '#9fb2c0', line: 'rgba(18,52,80,.32)' };

const FONT = "'Microsoft YaHei','Noto Sans SC',sans-serif";
const MONO = "'Consolas','Cascadia Mono',monospace";

const windows = [
  { x: LX, y: SY, w: SIDE, h: SH, color: C.red, side: '1P', kind: '屏幕采集' },
  { x: RX, y: SY, w: SIDE, h: SH, color: C.blue, side: '2P', kind: '屏幕采集' },
  { x: LX, y: CY, w: SIDE, h: CH, color: C.red, side: '1P', kind: '摄像头' },
  { x: RX, y: CY, w: SIDE, h: CH, color: C.blue, side: '2P', kind: '摄像头' },
];

function winRects(fill) {
  return windows.map((w) => `<rect x="${w.x}" y="${w.y}" width="${w.w}" height="${w.h}" rx="${R}" fill="${fill}"/>`).join('\n  ');
}

/**
 * 框体（带四个透明洞）—— 叠加版用。
 * @param {{fill:string, fillOpacity?:number, edge:string, line:string}} th 主题
 */
function frameSvg(th = DARK_TH) {
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <mask id="holes">
      <rect width="${W}" height="${H}" fill="#fff"/>
      ${winRects('#000')}
    </mask>
  </defs>

  <!-- 框体（四个窗口透明） -->
  <rect x="${FX}" y="${FY}" width="${FW}" height="${FH}" rx="10" fill="${th.fill}" fill-opacity="${th.fillOpacity ?? 1}" mask="url(#holes)"/>
  <rect x="${FX}" y="${FY}" width="${FW}" height="${FH}" rx="10" fill="none" stroke="${th.edge}" stroke-width="1" mask="url(#holes)"/>

  <!-- 窗口描边 + 两侧色条 -->
  ${windows.map((w) => `
  <rect x="${w.x}" y="${w.y}" width="${w.w}" height="${w.h}" rx="${R}" fill="none" stroke="${th.line}" stroke-width="1"/>
  ${w.x === LX
    ? `<rect x="${w.x}" y="${w.y + 8}" width="4" height="${w.h - 16}" rx="2" fill="${w.color}"/>`
    : `<rect x="${w.x + w.w - 4}" y="${w.y + 8}" width="4" height="${w.h - 16}" rx="2" fill="${w.color}"/>`}
  <path d="M ${w.x + 14} ${w.y + 1} H ${w.x + 64}" stroke="${w.color}" stroke-width="2"/>
  <path d="M ${w.x + w.w - 14} ${w.y + 1} H ${w.x + w.w - 64}" stroke="${w.color}" stroke-width="2"/>`).join('')}
</svg>`;
}

/** 标注预览版（不透明窗口 + 区域文字） */
function previewSvg() {
  const labels = windows.map((w) => {
    const isScreen = w.h > 300;
    return `
  <rect x="${w.x}" y="${w.y}" width="${w.w}" height="${w.h}" rx="${R}" fill="${C.win}"/>
  <rect x="${w.x}" y="${w.y}" width="${w.w}" height="${w.h}" rx="${R}" fill="none" stroke="${C.line}" stroke-width="1"/>
  ${w.x === LX
    ? `<rect x="${w.x}" y="${w.y + 8}" width="4" height="${w.h - 16}" rx="2" fill="${w.color}"/>`
    : `<rect x="${w.x + w.w - 4}" y="${w.y + 8}" width="4" height="${w.h - 16}" rx="2" fill="${w.color}"/>`}
  <path d="M ${w.x + 14} ${w.y + 1} H ${w.x + 64}" stroke="${w.color}" stroke-width="2"/>
  <path d="M ${w.x + w.w - 14} ${w.y + 1} H ${w.x + w.w - 64}" stroke="${w.color}" stroke-width="2"/>
  <text x="${w.x + w.w / 2}" y="${w.y + w.h / 2 - (isScreen ? 8 : 0)}" font-family="${FONT}" font-size="${isScreen ? 54 : 38}" font-weight="700" fill="#e0556c" text-anchor="middle" dominant-baseline="central">${w.kind} ${w.side}</text>
  <text x="${w.x + w.w / 2}" y="${w.y + w.h / 2 + (isScreen ? 38 : 30)}" font-family="${MONO}" font-size="${isScreen ? 18 : 15}" fill="${C.mute}" text-anchor="middle" dominant-baseline="central">${w.w} × ${w.h}</text>
  <text x="${w.x + w.w / 2}" y="${w.y + w.h - 16}" font-family="${MONO}" font-size="13" fill="#3f444b" text-anchor="middle">SOURCE PLACEHOLDER</text>`;
  }).join('');

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#181a1e"/>
      <stop offset="1" stop-color="#101114"/>
    </linearGradient>
    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#ffffff" stroke-opacity="0.022" stroke-width="1"/>
    </pattern>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#grid)"/>

  <!-- 上方：留给浏览器叠加（本模板不包含） -->
  <rect x="${M}" y="26" width="${W - M * 2}" height="238" rx="8" fill="none" stroke="#33363c" stroke-width="1.5" stroke-dasharray="10 8"/>
  <text x="${W / 2}" y="140" font-family="${FONT}" font-size="26" font-weight="700" fill="#4a4f57" text-anchor="middle" dominant-baseline="central">浏览器叠加区（比分条 + 选手牌）</text>
  <text x="${W / 2}" y="178" font-family="${MONO}" font-size="15" fill="#3f444b" text-anchor="middle" dominant-baseline="central">/render/score · 不包含在本模板内</text>

  <!-- 框体背景 -->
  <rect x="${FX}" y="${FY}" width="${FW}" height="${FH}" rx="10" fill="#141519" stroke="${C.frameEdge}" stroke-width="1"/>

  ${labels}

  <!-- 列标识 -->
  <text x="${LX}" y="${FY - 12}" font-family="${MONO}" font-size="14" letter-spacing="2" fill="${C.red}">CHANNEL 1P</text>
  <text x="${RX + SIDE}" y="${FY - 12}" font-family="${MONO}" font-size="14" letter-spacing="2" fill="${C.blue}" text-anchor="end">CHANNEL 2P</text>
</svg>`;
}

fs.mkdirSync('assets/layouts', { recursive: true });
fs.writeFileSync('assets/layouts/直播间模板.svg', previewSvg(), 'utf8');

const jobs = [
  ['直播间模板.png', frameSvg(DARK_TH)],
  ['直播间模板-预览.png', previewSvg()],
  ['直播间模板-明亮.png', frameSvg(LIGHT_TH)],
  ['直播间模板-明亮-降亮.png', frameSvg(LIGHT_DIM_TH)],
];
for (const [name, svg] of jobs) {
  const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
  fs.writeFileSync(`assets/layouts/${name}`, png);
  console.log(`generated: assets/layouts/${name}`);
}
