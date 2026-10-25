/**
 * 看板娘抠图 —— 把纯灰底的角色立绘转成透明 PNG。
 *
 * 做法（纯 sharp，不依赖任何在线服务）：
 *   1. 从四周边界做**泛洪填充**，只把和边界连通的灰底去掉 ——
 *      角色身上的白 / 灰部件（武器、护甲）都封闭在轮廓里，不会被误伤；
 *   2. 轮廓一圈做 alpha 反混合：抗锯齿边缘本来是「角色色 × a + 灰 × (1-a)」，
 *      按到灰底的色差反推 a，再把灰分量减掉，避免在浅色背景上留下灰边；
 *   3. 手臂与缎带围出来的**封闭空洞**边界填不到，用 INTERIOR_SEEDS 里的种子点
 *      逐个灌掉 —— 不能用「所有灰色区域一律删除」：她武器上的散热孔、衣服上的
 *      灰绿拼色恰好也是这个灰度，一刀切会把角色挖出洞；
 *   4. 裁掉四周多余的透明像素，输出 assets/mascot/standby-mascot.png。
 *
 * 用法：
 *   node tools/make-mascot-cutout.mjs <输入图片>
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const SRC = process.argv[2];
if (!SRC) {
  console.error('用法：node tools/make-mascot-cutout.mjs <输入图片>');
  process.exit(1);
}

const OUT = path.join(process.cwd(), 'assets', 'mascot', 'standby-mascot.png');

/** 画布在截图里的位置（左, 上, 宽, 高）——仅用于把 UI 边框裁掉 */
const CROP = { left: 69, top: 91, width: 1100, height: 1195 };

/** 泛洪填充的灰色容差（每通道最大差） */
const FLOOD_TOLERANCE = 20;
/** 轮廓反混合：色差 → alpha 的映射区间 */
const EDGE_NEAR = 6;    // ≤ 该差值视为纯背景
const EDGE_FULL = 54;   // ≥ 该差值视为完全不透明
/** 输出图四周留白（px） */
const PAD = 12;

/**
 * 封闭空洞的种子点 —— 坐标系与最终输出图一致（含 PAD 的 962×1119）。
 * 每个种子会把它所在的整块灰色连通区域灌成透明。
 *   610,300  右臂与长剑之间的大空隙
 *   560,540  缎带环里的大空洞上部
 *   530,600  同一条空洞的细长下半段
 *   490,690  缎带在腿边绕出的小环
 */
const INTERIOR_SEEDS = [
  [610, 300],
  [557, 548],
  [530, 600],
  [490, 690],
  [364, 599],
  [509, 604],
  [600, 432],
  [270, 319],
  [430, 140],
];

async function main() {
  const { data, info } = await sharp(SRC)
    .extract(CROP)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels } = info;
  if (channels !== 3) throw new Error(`期望 RGB，实际 ${channels} 通道`);

  // 背景色：取四条边像素的中位数（截图里灰底有极轻微的渐变）
  const samples = [];
  const push = (x, y) => {
    const i = (y * W + x) * 3;
    samples.push([data[i], data[i + 1], data[i + 2]]);
  };
  for (let x = 0; x < W; x += 3) { push(x, 0); push(x, H - 1); }
  for (let y = 0; y < H; y += 3) { push(0, y); push(W - 1, y); }
  const med = (k) => samples.map((s) => s[k]).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
  const BG = [med(0), med(1), med(2)];
  console.log(`背景色 ≈ rgb(${BG.join(', ')})`);

  const dist = (i) => Math.max(
    Math.abs(data[i] - BG[0]),
    Math.abs(data[i + 1] - BG[1]),
    Math.abs(data[i + 2] - BG[2]),
  );

  // ── 1. 从边界泛洪 ──
  const bg = new Uint8Array(W * H);          // 1 = 判为背景
  const stack = [];
  const seedAt = (x, y) => {
    const p = y * W + x;
    if (bg[p]) return;
    if (dist(p * 3) > FLOOD_TOLERANCE) return;
    bg[p] = 1;
    stack.push(p);
  };
  const floodFrom = (startPixels) => {
    for (const p of startPixels) { bg[p] = 1; stack.push(p); }
    while (stack.length) {
      const p = stack.pop();
      const x = p % W;
      const y = (p - x) / W;
      if (x > 0) seedAt(x - 1, y);
      if (x < W - 1) seedAt(x + 1, y);
      if (y > 0) seedAt(x, y - 1);
      if (y < H - 1) seedAt(x, y + 1);
    }
  };
  const borderSeeds = [];
  for (let x = 0; x < W; x++) { const a = x; const b = (H - 1) * W + x; if (dist(a * 3) <= FLOOD_TOLERANCE) borderSeeds.push(a); if (dist(b * 3) <= FLOOD_TOLERANCE) borderSeeds.push(b); }
  for (let y = 0; y < H; y++) { const a = y * W; const b = y * W + W - 1; if (dist(a * 3) <= FLOOD_TOLERANCE) borderSeeds.push(a); if (dist(b * 3) <= FLOOD_TOLERANCE) borderSeeds.push(b); }
  floodFrom([...new Set(borderSeeds)]);

  // ── 2. 生成 RGBA + 轮廓反混合 ──
  const out = Buffer.alloc(W * H * 4);
  let minX = W; let minY = H;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      const o = p * 4;
      if (bg[p]) continue;                   // 全透明

      const i = p * 3;
      let r = data[i], g = data[i + 1], b = data[i + 2];
      let a = 1;

      // 只有紧贴背景的一圈才需要反混合，内部像素保持原样（避免整体掉饱和度）
      const onEdge = (x > 0 && bg[p - 1]) || (x < W - 1 && bg[p + 1])
        || (y > 0 && bg[p - W]) || (y < H - 1 && bg[p + W]);
      if (onEdge) {
        const d = dist(i);
        if (d <= EDGE_NEAR) continue;                         // 其实就是背景色
        a = Math.min(1, (d - EDGE_NEAR) / (EDGE_FULL - EDGE_NEAR));
        if (a < 1) {
          // 还原前景色：P = a·F + (1-a)·BG  →  F = (P - (1-a)·BG) / a
          const k = 1 - a;
          r = (r - k * BG[0]) / a;
          g = (g - k * BG[1]) / a;
          b = (b - k * BG[2]) / a;
        }
      }

      out[o] = Math.max(0, Math.min(255, Math.round(r)));
      out[o + 1] = Math.max(0, Math.min(255, Math.round(g)));
      out[o + 2] = Math.max(0, Math.min(255, Math.round(b)));
      out[o + 3] = Math.round(a * 255);
      if (a > 0) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
      }
    }
  }

  // ── 3. 灌掉封闭空洞（种子坐标 → 裁剪坐标） ──
  // 种子是在「裁剪 + 留白」之后的输出图上量的，这里换算回本次的裁剪坐标
  for (const [sx, sy] of INTERIOR_SEEDS) {
    const cx = sx - PAD + minX;
    const cy = sy - PAD + minY;
    if (cx < 0 || cy < 0 || cx >= W || cy >= H) {
      console.warn(`种子 (${sx},${sy}) 换算后越界，已跳过`);
      continue;
    }
    const p0 = cy * W + cx;
    if (bg[p0]) { console.log(`种子 (${sx},${sy}) 已在背景里，跳过`); continue; }
    if (dist(p0 * 3) > FLOOD_TOLERANCE) {
      console.warn(`种子 (${sx},${sy}) 不在灰底上（色差 ${dist(p0 * 3)}），跳过`);
      continue;
    }
    const before = bg.reduce((n, v) => n + v, 0);
    floodFrom([p0]);
    const after = bg.reduce((n, v) => n + v, 0);
    // 把新灌掉的部分从 RGBA 里抹成透明
    for (let p = 0; p < bg.length; p++) if (bg[p]) out[p * 4 + 3] = 0;
    console.log(`种子 (${sx},${sy})：清掉 ${after - before} px`);
  }

  /*
   * 4. 吃掉贴在边缘上的灰色薄带。
   *
   * 轮廓外侧常有一条 2–4px 的纯灰细带（抗锯齿把它和背景隔开了，泛洪进不去），
   * 在浅色底上会显出一条脏边。这里只从「已经有透明邻居」的灰像素往里啃，
   * 啃 HALO_PASSES 轮：薄带会被吃干净，而武器上离边缘很远的灰色散热孔
   * （同样是 rgb 126）不会被碰到。
   */
  const HALO_PASSES = 4;
  let haloPixels = 0;
  for (let pass = 0; pass < HALO_PASSES; pass++) {
    const kill = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        if (out[p * 4 + 3] === 0) continue;                  // 已透明
        if (dist(p * 3) > FLOOD_TOLERANCE) continue;         // 不是灰底
        if ((x > 0 && out[(p - 1) * 4 + 3] === 0)
          || (x < W - 1 && out[(p + 1) * 4 + 3] === 0)
          || (y > 0 && out[(p - W) * 4 + 3] === 0)
          || (y < H - 1 && out[(p + W) * 4 + 3] === 0)) {
          kill.push(p);
        }
      }
    }
    if (!kill.length) break;
    for (const p of kill) out[p * 4 + 3] = 0;
    haloPixels += kill.length;
  }
  if (haloPixels) console.log(`边缘灰带清理：${haloPixels} px`);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const png = sharp(out, { raw: { width: W, height: H, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: true });

  // ── 4. 裁掉多余透明边 + 留白 ──
  const trimmed = await png.trim({ threshold: 1 }).toBuffer({ resolveWithObject: true });
  const padded = await sharp(trimmed.data)
    .extend({ top: PAD, bottom: PAD, left: PAD, right: PAD, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer({ resolveWithObject: true });

  fs.writeFileSync(OUT, padded.data);
  console.log(`已写出 ${path.relative(process.cwd(), OUT)} · ${padded.info.width}×${padded.info.height} · ${(padded.data.length / 1024).toFixed(0)} KB`);
}

main().catch((e) => { console.error(e); process.exit(1); });
