/**
 * 从 ChunithmMusicData.xlsx 生成 data/music.json（零依赖）。
 *
 *   npm run music:import
 *
 * 数据来源：
 *   · 「原数据」页（旧版可能叫「源数据」）：id / name / artistName / genreName + 五个难度的
 *     大定数与小数位（例如 12 + 50 = 12.50）。jaketFile / releaseDate / stageName 不用。
 *   · 「国服数据」页：用来标记哪些曲目在国服可用；同页难度列的字色就是官方难度色。
 *
 * 不引第三方 xlsx 库：这里只需要读一张结构固定的表，自己解 ZIP + XML 更可控，
 * 也不会因为依赖升级在赛前突然装不上。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_XLSX = path.join(ROOT, 'data', 'source', 'ChunithmMusicData.xlsx');
export const DEFAULT_OUT = path.join(ROOT, 'data', 'music.json');

const DIFFS = [
  { key: 'basic', name: 'BASIC', level: 'Basic_level', decimal: 'Basic_levelDecimal', col: 'BASIC', fallback: '#00b050' },
  { key: 'advanced', name: 'ADVANCED', level: 'Advanced_level', decimal: 'Advanced_levelDecimal', col: 'ADVANCED', fallback: '#b97034' },
  { key: 'expert', name: 'EXPERT', level: 'Expert_level', decimal: 'Expert_levelDecimal', col: 'EXPERT', fallback: '#ff0000' },
  { key: 'master', name: 'MASTER', level: 'Master_level', decimal: 'Master_levelDecimal', col: 'MASTER', fallback: '#7030a0' },
  { key: 'ultima', name: 'ULTIMA', level: 'Ultima_level', decimal: 'Ultima_levelDecimal', col: 'ULTIMA', fallback: '#262626' },
];

const GENRE_LABELS = {
  'POPS & ANIME': '流行 & 动画',
  'niconico': 'niconico',
  'VARIETY': '综艺',
  '東方Project': '东方Project',
  'ORIGINAL': '原创',
  'ゲーム': '游戏',
  'Irodori': '彩',
  'SOUND VOLTEX': 'SOUND VOLTEX',
  'maimai': 'maimai',
  'CHUNITHM': 'CHUNITHM',
  'オンゲキ': 'オンゲキ',
  'WACCA': 'WACCA',
  'Muse Dash': 'Muse Dash',
  'Arcaea': 'Arcaea',
  'Cytus': 'Cytus',
  'Deemo': 'Deemo',
  'Touhou': '东方Project',
};

// ─────────────────────────────────────────────────────────────
// ZIP
// ─────────────────────────────────────────────────────────────

function findEocd(buf) {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('不是有效的 xlsx（找不到 ZIP 结束记录）');
}

/** 读取 ZIP 内所有文件，返回 Map<name, Buffer> */
export function readZip(buf) {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  let p = cdOffset;

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`不支持的 ZIP 压缩方式 ${method}（${name}）`);
    if (usize && data.length !== usize) throw new Error(`ZIP 解压长度不一致：${name}`);
    files.set(name, data);
  }
  return files;
}

// ─────────────────────────────────────────────────────────────
// XML（这张表结构固定，用轻量解析即可）
// ─────────────────────────────────────────────────────────────

function unescapeXml(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : '';
}

function parseSharedStrings(xml) {
  const out = [];
  const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml))) {
    const parts = [];
    const tr = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tr.exec(m[1]))) parts.push(unescapeXml(t[1]));
    out.push(parts.join(''));
  }
  return out;
}

/** 解析一个 worksheet，返回 [{ row, cells: { [col]: { v, s } } }] */
function parseSheet(xml, shared) {
  const rows = [];
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const rowNo = Number(attr(rm[1], 'r')) || rows.length + 1;
    const cells = {};
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(rm[2]))) {
      const ref = attr(cm[1], 'r');
      const col = (ref.match(/^[A-Z]+/) || [''])[0];
      if (!col) continue;
      const type = attr(cm[1], 't');
      const style = Number(attr(cm[1], 's')) || 0;
      const inner = cm[2] || '';
      let v = '';
      if (type === 'inlineStr') {
        const t = inner.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/);
        v = t ? unescapeXml(t[1]) : '';
      } else {
        const vm = inner.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/);
        const raw = vm ? unescapeXml(vm[1]) : '';
        if (type === 's') v = shared[Number(raw)] ?? '';
        else if (type === 'b') v = raw === '1' ? 'TRUE' : 'FALSE';
        else v = raw;
      }
      cells[col] = { v, s: style };
    }
    rows.push({ row: rowNo, cells });
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────
// 样式 / 主题色
// ─────────────────────────────────────────────────────────────

function grabBlocks(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${tag}>)`, 'g');
  let m;
  while ((m = re.exec(xml))) out.push({ attrs: m[1] || '', inner: m[2] || '' });
  return out;
}

function parseThemeColors(xml) {
  const block = xml.slice(xml.indexOf('<a:clrScheme'), xml.indexOf('</a:clrScheme>'));
  const order = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
  const colors = {};
  for (const name of order) {
    const m = block.match(new RegExp(`<a:${name}>([\\s\\S]*?)</a:${name}>`));
    if (!m) continue;
    const srgb = m[1].match(/<a:srgbClr val="([0-9A-Fa-f]{6})"/);
    const sys = m[1].match(/<a:sysClr[^>]*lastClr="([0-9A-Fa-f]{6})"/);
    const hex = srgb?.[1] || sys?.[1];
    if (hex) colors[name] = `#${hex.toLowerCase()}`;
  }
  return colors;
}

function hexToHsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h, s, l };
}

function hslToHex({ h, s, l }) {
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r;
  let g;
  let b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  const to = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** OOXML 的 tint：负值是压暗，正值是往白色提亮 */
function applyTint(hex, tint) {
  if (!tint) return hex;
  const hsl = hexToHsl(hex);
  if (tint < 0) hsl.l *= (1 + tint);
  else hsl.l = hsl.l * (1 - tint) + tint;
  return hslToHex(hsl);
}

function resolveColor(attrs, theme) {
  const rgb = attrs.match(/\brgb="([0-9A-Fa-f]{8})"/);
  if (rgb) return `#${rgb[1].slice(2).toLowerCase()}`;
  const indexed = attrs.match(/\bindexed="(\d+)"/);
  if (indexed) {
    const idx = Number(indexed[1]);
    if (idx === 64) return '#000000';
    if (idx === 65) return '#ffffff';
  }
  const themeIdx = attrs.match(/\btheme="(\d+)"/);
  if (themeIdx) {
    const order = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
    const name = order[Number(themeIdx[1])];
    const base = theme[name];
    if (base) {
      const tint = attrs.match(/\btint="(-?[0-9.]+)"/);
      return applyTint(base, tint ? Number(tint[1]) : 0);
    }
  }
  return '';
}

function parseDifficultiesColors(stylesXml, themeXml, cnSheetRows) {
  const theme = parseThemeColors(themeXml);
  const cellXfsBlock = stylesXml.slice(stylesXml.indexOf('<cellXfs'), stylesXml.indexOf('</cellXfs>') + 10);
  const xfs = grabBlocks(cellXfsBlock, 'xf');
  const fonts = grabBlocks(stylesXml.slice(stylesXml.indexOf('<fonts'), stylesXml.indexOf('</fonts>') + 9), 'font');

  const xfAt = (i) => xfs[i] || { attrs: '', inner: '' };
  const fontAt = (i) => fonts[i] || { attrs: '', inner: '' };

  const header = cnSheetRows[0]?.cells || {};
  const sample = cnSheetRows[1]?.cells || {};
  const out = {};
  for (const d of DIFFS) {
    const headerCol = Object.keys(header).find((c) => String(header[c].v).trim().toUpperCase() === d.col);
    const cell = headerCol ? sample[headerCol] : null;
    let color = '';
    if (cell) {
      const xf = xfAt(cell.s);
      const fontId = Number(attr(xf.attrs, 'fontId')) || 0;
      const font = fontAt(fontId);
      const colorTag = font.inner.match(/<color([^>]*)\/?>/);
      if (colorTag) color = resolveColor(colorTag[1], theme);
    }
    out[d.key] = { color: color || d.fallback, derived: !!color };
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 组装
// ─────────────────────────────────────────────────────────────

function sheetByName(files, name) {
  const workbook = files.get('xl/workbook.xml').toString('utf8');
  const rels = files.get('xl/_rels/workbook.xml.rels').toString('utf8');
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => ({
    name: attr(m[1], 'name'),
    rid: attr(m[1], 'r:id') || attr(m[1], 'id'),
  }));
  const relMap = {};
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    relMap[attr(m[1], 'Id')] = attr(m[1], 'Target');
  }
  const hit = name ? sheets.find((s) => s.name === name) : null;
  if (!hit) return null;
  const target = String(relMap[hit.rid] || '').replace(/^\/?xl\//, '');
  const file = files.get(`xl/${target}`) || files.get(target);
  return file ? file.toString('utf8') : null;
}

function allSheets(files) {
  const workbook = files.get('xl/workbook.xml').toString('utf8');
  const rels = files.get('xl/_rels/workbook.xml.rels').toString('utf8');
  const relMap = {};
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) relMap[attr(m[1], 'Id')] = attr(m[1], 'Target');
  return [...workbook.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => {
    const name = attr(m[1], 'name');
    const rid = attr(m[1], 'r:id') || attr(m[1], 'id');
    const target = String(relMap[rid] || '').replace(/^\/?xl\//, '');
    const file = files.get(`xl/${target}`) || files.get(target);
    return { name, file };
  }).filter((s) => s.file);
}

/**
 * 解析 xlsx，返回 { songs, meta }。
 * 可单独测试；不写文件。
 */
export function parseWorkbook(buf) {
  const files = readZip(buf);
  const shared = parseSharedStrings(files.get('xl/sharedStrings.xml')?.toString('utf8') || '');
  const stylesXml = files.get('xl/styles.xml')?.toString('utf8') || '';
  const themeXml = files.get('xl/theme/theme1.xml')?.toString('utf8') || '';

  const sheets = allSheets(files);
  const source = sheets.find((s) => s.name === '源数据' || s.name === '原数据')
    || sheets.find((s) => /Basic_level/i.test(s.file.toString('utf8').slice(0, 20000)));
  if (!source) throw new Error('找不到「原数据 / 源数据」工作表');
  const cnSheet = sheets.find((s) => s.name === '国服数据') || null;

  const rawRows = parseSheet(source.file.toString('utf8'), shared).filter((r) => Object.keys(r.cells).length);
  if (!rawRows.length) throw new Error('原始数据表是空的');
  const headerRow = rawRows[0];
  const colOf = (name) => Object.keys(headerRow.cells).find(
    (c) => String(headerRow.cells[c].v).trim().toLowerCase() === name.toLowerCase(),
  );
  const idCol = colOf('id');
  const nameCol = colOf('name');
  const artistCol = colOf('artistName');
  const genreCol = colOf('genreName');
  if (!idCol || !nameCol) throw new Error('原始数据表缺少 id / name 列');

  const diffCols = DIFFS.map((d) => ({
    ...d,
    levelCol: colOf(d.level),
    decimalCol: colOf(d.decimal),
  }));

  const cnIds = new Set();
  let cnRows = [];
  if (cnSheet) {
    cnRows = parseSheet(cnSheet.file.toString('utf8'), shared).filter((r) => Object.keys(r.cells).length);
    const cnHeader = cnRows[0]?.cells || {};
    const cnIdCol = Object.keys(cnHeader).find((c) => String(cnHeader[c].v).trim().toLowerCase() === 'id');
    if (cnIdCol) {
      for (const row of cnRows.slice(1)) {
        const id = Number(row.cells[cnIdCol]?.v);
        if (Number.isFinite(id)) cnIds.add(id);
      }
    }
  }

  const colors = (() => {
    try { return parseDifficultiesColors(stylesXml, themeXml, cnRows); }
    catch { return Object.fromEntries(DIFFS.map((d) => [d.key, { color: d.fallback, derived: false }])); }
  })();

  const songs = [];
  const seen = new Set();
  for (const row of rawRows.slice(1)) {
    const id = Number(row.cells[idCol]?.v);
    const name = String(row.cells[nameCol]?.v || '').trim();
    if (!Number.isFinite(id) || !name || seen.has(id)) continue;
    const difficulties = {};
    for (const d of diffCols) {
      if (!d.levelCol) continue;
      const lv = Number(row.cells[d.levelCol]?.v);
      const dec = d.decimalCol ? Number(row.cells[d.decimalCol]?.v) : 0;
      if (!Number.isFinite(lv) || lv <= 0) continue;
      const decimal = Number.isFinite(dec) && dec > 0 ? dec : 0;
      difficulties[d.key] = Math.round((lv + decimal / 100) * 100) / 100;
    }
    if (!Object.keys(difficulties).length) continue;
    seen.add(id);
    songs.push({
      id,
      name,
      artist: String(row.cells[artistCol]?.v || '').trim(),
      genre: String(row.cells[genreCol]?.v || '').trim(),
      cn: cnIds.has(id),
      difficulties,
    });
  }
  songs.sort((a, b) => a.id - b.id);

  const genreSet = [...new Set(songs.map((s) => s.genre).filter(Boolean))];
  const genres = genreSet.sort((a, b) => a.localeCompare(b, 'en')).map((g) => ({
    name: g,
    label: GENRE_LABELS[g] || g,
    count: songs.filter((s) => s.genre === g).length,
  }));

  return {
    generatedAt: new Date().toISOString(),
    source: 'ChunithmMusicData.xlsx',
    sourceSheet: source.name,
    counts: { songs: songs.length, cn: songs.filter((s) => s.cn).length },
    difficulties: Object.fromEntries(DIFFS.map((d) => [d.key, {
      key: d.key,
      name: d.name,
      color: colors[d.key]?.color || d.fallback,
    }])),
    difficultyOrder: DIFFS.map((d) => d.key),
    genres,
    songs,
  };
}

export function importMusic({ xlsx = DEFAULT_XLSX, out = DEFAULT_OUT } = {}) {
  if (!fs.existsSync(xlsx)) throw new Error(`找不到 ${xlsx}`);
  const buf = fs.readFileSync(xlsx);
  const data = parseWorkbook(buf);

  // 保留上一次导入 / 抓取的封面（按曲目 ID 合并），xlsx 本身没有封面字段
  const oldCovers = new Map();
  const oldWe = new Map();
  try {
    const old = JSON.parse(fs.readFileSync(out, 'utf8'));
    for (const s of old.songs || []) {
      if (!s || s.id == null) continue;
      if (s.cover) oldCovers.set(Number(s.id), s.cover);
      if (s.we) oldWe.set(Number(s.id), s.we);
    }
  } catch { /* 首次生成 */ }
  for (const s of data.songs) {
    if (!s.cover && oldCovers.has(Number(s.id))) s.cover = oldCovers.get(Number(s.id));
    if (!s.we && oldWe.has(Number(s.id))) s.we = oldWe.get(Number(s.id));
  }
  data.counts = {
    songs: data.songs.length,
    cn: data.songs.filter((s) => s.cn).length,
    covers: data.songs.filter((s) => s.cover).length,
    we: data.songs.filter((s) => s.we).length,
  };

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(data)}\n`, 'utf8');
  return { out, data };
}

// ── CLI ──
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { out, data } = importMusic();
    console.log(`已生成 ${path.relative(ROOT, out)}`);
    console.log(`  曲目 ${data.counts.songs} 首（国服 ${data.counts.cn} 首）· 分类 ${data.genres.length} 个`);
    console.log(`  难度色：${Object.values(data.difficulties).map((d) => `${d.name} ${d.color}`).join(' · ')}`);
    console.log(`  数据页：${data.sourceSheet}`);
  } catch (e) {
    console.error(`导入失败：${e.message}`);
    process.exitCode = 1;
  }
}
