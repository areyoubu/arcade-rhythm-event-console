/**
 * vMix XML 状态解析（`GET /api/` 的响应）。
 *
 * 需求：
 *   B-REQ-801  以 150ms 间隔轮询 GET /api/（不带参数），解析 <input type="Replay"> 节点
 *   B-REQ-802  判定「正在回放」= live === false
 *   B-REQ-807  state / position / duration 须用于裁切面板的实时时长估算与时间轴可视化
 *   B-REQ-404  录制状态须来自 XML 回读，不得仅依赖指令成功响应
 *   (R12)      XML position / duration 单位与精度须实测回填
 *
 * 实现说明：这里自写一个宽容的轻量 XML 解析器，而不是引入 XML 库 ——
 * vMix 的 XML 结构固定且简单，自写可避免依赖、便于处理 vMix 的
 * 「属性大小写混杂」「自闭合与成对混用」「文本里带转义」等实际情况。
 */

const ENTITY_MAP = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITY_MAP[e] ?? m;
  });
}

function parseAttrs(raw) {
  const out = {};
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(raw))) out[m[1]] = decodeEntities(m[2] ?? m[3] ?? '');
  return out;
}

/**
 * 解析为通用节点树。节点：{ name, attrs, children, text }
 * 对畸形 XML 尽量容错，不抛异常（现场万一 vMix 改了格式，宁可少解析也不要崩）。
 */
export function parseXml(src) {
  if (typeof src !== 'string' || src.length === 0) return null;

  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      stack[stack.length - 1].text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) stack[stack.length - 1].text += decodeEntities(src.slice(i, lt));

    // 注释 / 声明 / CDATA
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt); i = e === -1 ? src.length : e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt);
      const body = e === -1 ? src.slice(lt + 9) : src.slice(lt + 9, e);
      stack[stack.length - 1].text += body;
      i = e === -1 ? src.length : e + 3;
      continue;
    }
    if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) { const e = src.indexOf('>', lt); i = e === -1 ? src.length : e + 1; continue; }

    const gt = src.indexOf('>', lt);
    if (gt === -1) break;
    let tag = src.slice(lt + 1, gt);

    if (tag.startsWith('/')) {                       // 闭合标签
      const name = tag.slice(1).trim();
      for (let d = stack.length - 1; d > 0; d--) {
        if (stack[d].name === name) { stack.length = d; break; }
      }
      i = gt + 1;
      continue;
    }

    const selfClosing = tag.endsWith('/');
    if (selfClosing) tag = tag.slice(0, -1);

    const space = tag.search(/\s/);
    const name = space === -1 ? tag.trim() : tag.slice(0, space).trim();
    const attrRaw = space === -1 ? '' : tag.slice(space);
    const node = { name, attrs: parseAttrs(attrRaw), children: [], text: '' };

    stack[stack.length - 1].children.push(node);
    if (!selfClosing && name) stack.push(node);

    i = gt + 1;
  }

  return root;
}

/** 深度优先查找所有匹配 name 的节点 */
export function findAll(node, name, out = []) {
  if (!node) return out;
  for (const c of node.children || []) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

export function first(node, name) {
  return findAll(node, name)[0] || null;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(v) {
  // vMix 用 "True" / "False"（首字母大写），也见过 "true"
  return String(v).trim().toLowerCase() === 'true';
}

// ─────────────────────────────────────────────────────────────
// vMix 专用提取
// ─────────────────────────────────────────────────────────────

/** 解析 `<inputs>` 下的全部 input 节点 */
export function parseInputs(xmlOrTree) {
  const tree = typeof xmlOrTree === 'string' ? parseXml(xmlOrTree) : xmlOrTree;
  if (!tree) return [];
  return findAll(tree, 'input').map((n) => ({
    key: n.attrs.key || '',
    number: num(n.attrs.number, 0),
    type: n.attrs.type || '',
    title: n.attrs.title || '',
    state: n.attrs.state || '',                 // Running | Paused | ...
    position: num(n.attrs.position, 0),
    duration: num(n.attrs.duration, 0),
    muted: bool(n.attrs.muted),
    volume: num(n.attrs.volume, 100),
    raw: n,
  }));
}

/**
 * 从 XML 中提取回放输入状态。
 * B-REQ-802：判定「正在回放」= live === false。
 * @returns {null | {
 *   inputNumber, title, state, position, duration,
 *   live:boolean, recording:boolean, channelMode:'A'|'B', events:number,
 *   eventsA:number, eventsB:number, cameraA:number, cameraB:number,
 *   speed:number, speedA:number, speedB:number,
 *   timecode, timecodeA, timecodeB, eventList:Array
 * }}
 */
export function parseReplay(xmlOrTree) {
  const tree = typeof xmlOrTree === 'string' ? parseXml(xmlOrTree) : xmlOrTree;
  if (!tree) return null;

  const input = findAll(tree, 'input').find((n) => (n.attrs.type || '').toLowerCase() === 'replay');
  if (!input) return null;

  const replay = first(input, 'replay');
  const attrs = replay?.attrs || {};

  // 事件库条目：vMix 在 <replay> 下用 <event .../> 描述，字段名各版本略有差异，宽容读取
  const eventNodes = replay ? findAll(replay, 'event') : [];
  const eventList = eventNodes.map((e, idx) => ({
    index: idx,
    id: e.attrs.id || e.attrs.key || `e${idx}`,
    text: e.attrs.name || e.attrs.text || e.attrs.title || '',
    duration: num(e.attrs.duration, 0),
    selected: bool(e.attrs.selected),
    start: num(e.attrs.start, 0),
    end: num(e.attrs.end, 0),
  }));

  const pos = num(input.attrs.position, 0);
  const dur = num(input.attrs.duration, 0);

  return {
    inputNumber: num(input.attrs.number, 0),
    title: input.attrs.title || '',
    state: input.attrs.state || '',
    position: pos,
    duration: dur,

    // B-REQ-802：live === false 即「正在回放」
    live: attrs.live === undefined ? true : bool(attrs.live),
    recording: bool(attrs.recording),
    channelMode: (attrs.channelMode || 'A').toUpperCase(),

    events: num(attrs.events, 0),
    eventsA: num(attrs.eventsA, 0),
    eventsB: num(attrs.eventsB, 0),
    cameraA: num(attrs.cameraA, 1),
    cameraB: num(attrs.cameraB, 1),
    speed: num(attrs.speed, 1),
    speedA: num(attrs.speedA, 1),
    speedB: num(attrs.speedB, 1),

    timecode: text(first(replay, 'timecode')),
    timecodeA: text(first(replay, 'timecodeA')) || text(first(replay, 'timecodea')),
    timecodeB: text(first(replay, 'timecodeB')) || text(first(replay, 'timecodeb')),

    eventList,

    // 便捷派生
    playing: (input.attrs.state || '').toLowerCase() === 'running',
    /** 剩余时长（估算，R12：单位与精度须实测） */
    remainingMs: Math.max(0, dur - pos),
  };
}

function text(node) { return node ? (node.text || '').trim() : ''; }

/** 顶层信息（版本号、版次 —— 用于预检提示「回放功能需 Pro/4K/Max」） */
export function parseHeader(xmlOrTree) {
  const tree = typeof xmlOrTree === 'string' ? parseXml(xmlOrTree) : xmlOrTree;
  if (!tree) return { version: '', edition: '', preset: '' };
  return {
    version: text(first(tree, 'version')),
    edition: text(first(tree, 'edition')),
    preset: text(first(tree, 'preset')),
  };
}

/** 音轨静音状态（slowMotionMute 用，B-REQ-702） */
export function parseInputMute(xmlOrTree, inputTitle) {
  const inputs = parseInputs(xmlOrTree);
  const hit = inputs.find((i) => i.title === inputTitle);
  return hit ? hit.muted : null;
}

/** 一站式：从原始 XML 文本解析出引擎需要的全部信息 */
export function parseState(xmlText) {
  const tree = parseXml(xmlText);
  return {
    header: parseHeader(tree),
    inputs: parseInputs(tree).map(({ raw, ...rest }) => rest),
    replay: parseReplay(tree),
  };
}
