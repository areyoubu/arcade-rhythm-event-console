/**
 * 模块 A —— 叠加控制端（服务端侧）。
 *
 * 需求：
 *   A-REQ-501  支持模板选择
 *   A-REQ-502  支持实体一键填充：点选手 → 自动填 name / avatar 槽位
 *   A-REQ-503  支持槽位手改
 *   A-REQ-504  支持显隐（show / hide），带进出场动画
 *   A-REQ-505  ★ 支持**热改**：显示中修改任意槽位，内容**原地更新**，**不重播动画**
 *   A-REQ-506  支持清空
 *   A-REQ-507  支持固定常驻（某模板可设为常驻，如角标）
 *   A-REQ-508  支持队列：多模板排队依次显示
 *   A-REQ-510  支持撤销（最近 10 步）
 *   A-REQ-511  支持回放模式联动（模块 B 切到回放时主实例切换到回放态文案）
 *   A-REQ-601  overlay:update 必须是局部更新，不得触发重渲染或动画重播
 *   A-REQ-604  控制端须能区分「指令已发」与「已渲染」
 *   A-REQ-002  主实例与回放态必须是同一个浏览器源（target 区分内容）
 *   A-REQ-003  渲染端不得发起任何业务请求，只接收
 */
import { EventEmitter } from 'node:events';
import { getConfig } from './config.js';
import { set, getState } from './state.js';
import * as log from './logger.js';
import * as hub from './ws-hub.js';
import * as templates from './templates.js';
import * as entities from './entities.js';

export const overlayEvents = new EventEmitter();

const UNDO_DEPTH = 10;

/** 每个 target 一份独立状态（main / credits —— A-REQ-002 允许同源两实例） */
const targets = new Map();

/**
 * 双人槽位当前选中的选手（A / B 侧）—— **跨模板保留**。
 *
 * 需求：切换模板不要把已选好的选手清空（切到单人模板仍然清空，因为单人模板没有对侧）。
 * 比分条也读写这份状态：任一侧变化，两边一起变。
 * 这里只存实体 id，展示用快照由 getLineup() 现算（队伍改名/换 Logo 能立刻反映）。
 */
const lineup = { A: null, B: null };
/** 撤销栈 */
const undoStacks = new Map();
/** 队列 */
let queue = [];
let queueTimer = null;
let queuePaused = false;

function blankState(target) {
  return {
    target,
    activeTemplate: null,
    slotValues: {},
    visible: false,
    pinned: false,
    mode: 'live',
    modeLabel: null,
    playerSnapshot: null,
    anim: null,
    updatedAt: 0,
    /** 指令已发 / 已渲染 双状态（A-REQ-604） */
    sentAt: 0,
    renderedAt: 0,
  };
}

export function getTarget(name = 'main') {
  if (!targets.has(name)) targets.set(name, blankState(name));
  return targets.get(name);
}

export function allTargets() {
  // 保证默认 target 一定存在 —— 否则控制端首次打开页面时读不到 overlay.all，
  // 「指令已发 / 已渲染」双状态与预览会一片空白。
  getTarget('main');
  getTarget('credits');
  getTarget('preview');
  return Object.fromEntries([...targets].map(([k, v]) => [k, serialize(v)]));
}

function serialize(s) {
  return {
    target: s.target, activeTemplate: s.activeTemplate, slotValues: s.slotValues,
    visible: s.visible, pinned: s.pinned, mode: s.mode, modeLabel: s.modeLabel,
    playerSnapshot: s.playerSnapshot, anim: s.anim, updatedAt: s.updatedAt,
    sentAt: s.sentAt, renderedAt: s.renderedAt,
    /** 已发但未渲染（供 A-REQ-708 双状态显示） */
    pending: s.sentAt > (s.renderedAt || 0),
  };
}

function syncState(target) {
  const s = getTarget(target);
  set('overlay.target', s.target);
  set('overlay.activeTemplate', s.activeTemplate);
  set('overlay.slotValues', s.slotValues);
  set('overlay.visible', s.visible);
  set('overlay.mode', s.mode);
  set('overlay.sentAt', s.sentAt);
  set('overlay.renderedAt', s.renderedAt);
  set('overlay.all', allTargets());
}

// ─────────────────────────────────────────────────────────────
// 撤销 A-REQ-510
// ─────────────────────────────────────────────────────────────

function pushUndo(target, label) {
  const s = getTarget(target);
  if (!undoStacks.has(target)) undoStacks.set(target, []);
  const stack = undoStacks.get(target);
  stack.push({ label, at: Date.now(), snapshot: JSON.parse(JSON.stringify({ ...s })) });
  if (stack.length > UNDO_DEPTH) stack.shift();
  set('overlay.undoDepth', stack.length);
}

/**
 * A-REQ-510 / A-REQ-706：撤销最近 10 步。
 *
 * 撤销允许重建 DOM（与 A-REQ-505 的热改不同 —— 热改是"改值不动结构"，
 * 撤销是"回到之前的状态"，结构本身就变了）。因此这里用一次完整的 show 重建，
 * 并把动画设为 none，避免撤销时画面又闪一下。
 */
export function undo(target = 'main') {
  const stack = undoStacks.get(target) || [];
  const step = stack.pop();
  if (!step) return { ok: false, nack: { code: 'nothing_to_undo', msg: '没有可撤销的操作' } };

  const restored = { ...step.snapshot, sentAt: Date.now(), renderedAt: 0 };
  targets.set(target, restored);

  const noAnim = { in: 'none', out: 'none', durationMs: 0 };
  if (restored.activeTemplate && restored.visible) {
    const tpl = templates.fullList().find((x) => x.id === restored.activeTemplate);
    send({
      t: 'overlay:show',
      target,
      template: restored.activeTemplate,
      templateDef: tpl || null,
      values: restored.slotValues,
      anim: noAnim,
      mode: restored.mode,
      rebuild: true,
      why: `undo:${step.label}`,
    }, target);
  } else {
    // 回滚到「无内容」或「已隐藏」：渲染端在 hide 时就移除了 DOM，这里直接清空即可
    restored.activeTemplate = restored.activeTemplate || null;
    restored.visible = false;
    send({ t: 'overlay:clear', target, why: `undo:${step.label}` }, target);
  }

  syncState(target);
  log.audit('overlay', 'undo', { target, label: step.label, remaining: stack.length });
  set('overlay.undoDepth', stack.length);
  return { ok: true, undone: step.label, state: serialize(getTarget(target)) };
}

export function undoDepth(target = 'main') { return (undoStacks.get(target) || []).length; }

/**
 * 清空撤销栈（不改动当前画面）。
 * 用途：切场景 / 换节目单之后，旧的操作历史已经没有回溯价值，
 * 留着只会让操作员按若干次「撤销」才回到当前状态。
 */
export function clearUndo(target = 'main') {
  undoStacks.set(target, []);
  set('overlay.undoDepth', 0);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// 显示 / 隐藏 / 清空
// ─────────────────────────────────────────────────────────────

/**
 * 显示模板。
 * @param {{template:string, values?:object, anim?:object, target?:string, actor?:string, rebuild?:boolean}} opts
 */
export function show(opts = {}) {
  const target = opts.target || getConfig().render.defaultTarget || 'main';
  const tpl = templates.get(opts.template);
  if (!tpl) return { ok: false, nack: { code: 'unknown_template', msg: `模板不存在：${opts.template}` } };

  const s = getTarget(target);

  const values = sanitizeValues(tpl, opts.values || s.slotValues || {});
  const switching = s.activeTemplate !== tpl.id;

  /**
   * 切换模板时保留人物：双人模板的空槽位用 lineup 里已选的选手补上。
   * 单人模板不补 —— 切到单人模板照常清空。
   */
  if (switching && isDualTemplate(tpl)) fillFromLineup(tpl, values);

  /**
   * 双人模板「点一个人填一侧」的场景要允许另一侧暂时为空 ——
   * 否则第一次点 A 位时，B 位的必填校验会直接把请求打回，
   * 操作员根本走不到「第二次点击填 B」这一步。
   * 只对显式的分侧填充放行（opts.skipRequired），常规 show 仍然严格校验。
   */
  const errs = opts.skipRequired ? {} : validateRequired(tpl, values);
  // 校验放前面：被拒绝的请求不该在撤销栈里留下一条空记录
  if (Object.keys(errs).length) return { ok: false, nack: { code: 'invalid_values', msg: Object.entries(errs).map(([k, v]) => `${k}: ${v}`).join('；') } };

  // ⚠️ 快照必须在改状态之前
  pushUndo(target, s.activeTemplate ? 'show(替换)' : 'show');

  s.activeTemplate = tpl.id;
  s.slotValues = values;
  s.visible = true;
  s.anim = opts.anim || tpl.defaultAnim || null;
  s.updatedAt = Date.now();

  const msg = {
    t: 'overlay:show',
    target,
    template: tpl.id,
    templateDef: templates.fullList().find((x) => x.id === tpl.id) || null,
    values,
    anim: s.anim,
    mode: s.mode,
    // 陷阱 #52：切换模板才重建 DOM；同一模板再次 show 只做热改，不重播动画
    rebuild: opts.rebuild ?? switching,
  };
  send(msg, target);
  syncState(target);
  log.audit('overlay', 'show', { target, template: tpl.id, rebuild: msg.rebuild, actor: opts.actor });
  return { ok: true, state: serialize(s) };
}

/** A-REQ-505 / A-REQ-601 ★ 热改：局部更新，绝不重播动画 */
export function update(slot, value, opts = {}) {
  const target = opts.target || getConfig().render.defaultTarget || 'main';
  const s = getTarget(target);
  if (!s.activeTemplate) return { ok: false, nack: { code: 'nothing_active', msg: '当前没有活动模板' } };

  const tpl = templates.get(s.activeTemplate);
  const def = tpl?.slots?.find((x) => x.key === slot);
  if (!def) return { ok: false, nack: { code: 'unknown_slot', msg: `模板 ${s.activeTemplate} 没有槽位 ${slot}` } };

  const v = sanitizeValue(def, value);
  // ⚠️ 必须先快照再改状态 —— 反过来会把「新值」存进撤销栈，撤销时恢复成新值，等价于没撤销
  pushUndo(target, `update:${slot}`);
  s.slotValues = { ...s.slotValues, [slot]: v };
  s.updatedAt = Date.now();

  // ★ 只发 slot + value —— 渲染端就地改 textContent / src，不重建 DOM、不重播动画
  send({ t: 'overlay:update', target, slot, value: v }, target);
  syncState(target);
  log.debug('overlay', `热改槽位 ${slot}`, { target, template: s.activeTemplate, slot });
  return { ok: true, slot, value: v, state: serialize(s) };
}

/** 批量热改（一次 DOM 往返改多个槽位） */
export function updateMany(values, opts = {}) {
  const target = opts.target || getConfig().render.defaultTarget || 'main';
  const s = getTarget(target);
  if (!s.activeTemplate) return { ok: false, nack: { code: 'nothing_active', msg: '当前没有活动模板' } };
  const tpl = templates.get(s.activeTemplate);
  const applied = {};
  for (const [k, v] of Object.entries(values || {})) {
    const def = tpl?.slots?.find((x) => x.key === k);
    if (!def) continue;
    applied[k] = sanitizeValue(def, v);
  }
  pushUndo(target, 'updateMany');
  s.slotValues = { ...s.slotValues, ...applied };
  s.updatedAt = Date.now();
  send({ t: 'overlay:updateMany', target, values: applied }, target);
  log.debug('overlay', '批量热改', { target, fields: Object.keys(applied) });
  syncState(target);
  return { ok: true, values: applied, state: serialize(s) };
}

export function hide(opts = {}) {
  const target = opts.target || getConfig().render.defaultTarget || 'main';
  const s = getTarget(target);
  pushUndo(target, 'hide');
  s.visible = false;
  s.updatedAt = Date.now();
  send({ t: 'overlay:hide', target, anim: opts.anim || s.anim }, target);
  syncState(target);
  log.audit('overlay', 'hide', { target, actor: opts.actor });
  return { ok: true, state: serialize(s) };
}

/** A-REQ-506 清空：清空所有槽位并隐藏 */
export function clear(opts = {}) {
  const target = opts.target || getConfig().render.defaultTarget || 'main';
  const s = getTarget(target);
  pushUndo(target, 'clear');
  s.activeTemplate = null;
  s.slotValues = {};
  s.visible = false;
  s.pinned = false;
  s.updatedAt = Date.now();
  send({ t: 'overlay:clear', target }, target);
  syncState(target);
  log.audit('overlay', 'clear', { target, actor: opts.actor });
  return { ok: true };
}

/** A-REQ-507 固定常驻 */
export function setPinned(pinned, opts = {}) {
  const target = opts.target || getConfig().render.defaultTarget || 'main';
  const s = getTarget(target);
  s.pinned = !!pinned;
  if (s.pinned) s.visible = true;
  send({ t: 'overlay:pin', target, pinned: s.pinned }, target);
  syncState(target);
  log.audit('overlay', 'setPinned', { target, pinned: s.pinned });
  return { ok: true, pinned: s.pinned };
}

// ─────────────────────────────────────────────────────────────
// 预览 / 输出分离
// ─────────────────────────────────────────────────────────────

/**
 * 预览是独立于直播输出的一个渲染目标（`preview`）。
 *
 * 控制台默认编辑 `preview`：操作员在网页里的 iframe 看到的、改的全部只影响预览，
 * **不会**碰到正在播出的 `main`。确认无误后按「输出到直播」一次性推过去。
 * 这样在节目进行中放心地试排版、试颜色，不会把半成品播出去。
 *
 * 实现上不需要额外的渲染端进程：`/render/main?target=preview` 就是一个
 * 独立声明的渲染端，`hub.toRenderers(msg, 'preview')` 只会发给它。
 */
export function commitPreview(opts = {}) {
  const p = getTarget('preview');
  const target = opts.target || 'main';
  const d = getTarget(target);

  // 预览是空的 → 输出也清空，保持「所见即所得」
  if (!p.activeTemplate || !p.visible) {
    d.activeTemplate = null;
    d.slotValues = {};
    d.visible = false;
    d.updatedAt = Date.now();
    send({ t: 'overlay:clear', target }, target);
    syncState(target);
    log.audit('overlay', 'commitPreview', { target, action: 'clear', actor: opts.actor });
    return { ok: true, action: 'clear', state: serialize(d) };
  }

  const tplDef = templates.fullList().find((x) => x.id === p.activeTemplate) || null;

  pushUndo(target, 'commitPreview');
  d.activeTemplate = p.activeTemplate;
  d.slotValues = structuredClone(p.slotValues);
  d.visible = true;
  d.mode = p.mode;
  d.modeLabel = p.modeLabel;
  d.anim = p.anim;
  d.pinned = p.pinned;
  d.playerSnapshot = p.playerSnapshot;
  d.updatedAt = Date.now();

  send({
    t: 'overlay:show',
    target,
    template: p.activeTemplate,
    templateDef: tplDef,
    values: d.slotValues,
    anim: p.anim || { in: 'none', out: 'none', durationMs: 0 },
    mode: d.mode,
    rebuild: true,
    why: 'commitPreview',
  }, target);
  syncState(target);

  log.audit('overlay', 'commitPreview', {
    target, template: p.activeTemplate, action: 'show', actor: opts.actor,
  });
  return { ok: true, action: 'show', template: p.activeTemplate, state: serialize(d) };
}

/** 把直播输出的当前内容同步回预览（用于「接着改刚才播出去的东西」） */
export function revertPreview(opts = {}) {
  const p = getTarget('preview');
  const srcTarget = opts.from || 'main';
  const src = getTarget(srcTarget);

  p.activeTemplate = src.activeTemplate;
  p.slotValues = structuredClone(src.slotValues);
  p.visible = src.visible;
  p.mode = src.mode;
  p.modeLabel = src.modeLabel;
  p.anim = src.anim;
  p.pinned = src.pinned;
  p.playerSnapshot = src.playerSnapshot;
  p.updatedAt = Date.now();

  if (p.activeTemplate && p.visible) {
    const tplDef = templates.fullList().find((x) => x.id === p.activeTemplate) || null;
    send({
      t: 'overlay:show', target: 'preview', template: p.activeTemplate, templateDef: tplDef,
      values: p.slotValues, anim: { in: 'none', out: 'none', durationMs: 0 }, mode: p.mode, rebuild: true,
    }, 'preview');
  } else {
    send({ t: 'overlay:clear', target: 'preview' }, 'preview');
  }
  syncState('preview');
  log.info('overlay', '已从直播输出同步到预览', { from: srcTarget });
  return { ok: true, state: serialize(p) };
}

// ─────────────────────────────────────────────────────────────
// 模式切换 A-REQ-511 / A-REQ-002
// ─────────────────────────────────────────────────────────────

/**
 * ★ A-REQ-511：模块 B 切到回放时，主实例切换到回放态文案。
 * 只发 mode 字段 —— 渲染端只换文案，**不重建 DOM、不中断动画**（AC-A15）。
 */
export function setMode(mode, opts = {}) {
  const target = opts.target || 'main';
  const s = getTarget(target);
  s.mode = mode === 'replay' ? 'replay' : 'live';
  s.modeLabel = opts.label || null;
  s.updatedAt = Date.now();
  send({ t: 'overlay:mode', target, mode: s.mode, label: s.modeLabel }, target);
  syncState(target);
  log.info('overlay', `叠加模式切换 → ${s.mode}`, { target, label: s.modeLabel });
  return { ok: true, mode: s.mode, label: s.modeLabel };
}

/** 供模块 B 调用的稳定接口（模块职责矩阵：浮窗渲染与显隐由 A 拥有） */
export const controller = {
  push(mode, payload = {}) {
    return setMode(mode, { label: payload.label });
  },
};

// ─────────────────────────────────────────────────────────────
// 实体一键填充 A-REQ-502
// ─────────────────────────────────────────────────────────────

/**
 * 槽位属于哪一侧。
 *   aXxx / leftXxx → 'A'
 *   bXxx / rightXxx → 'B'
 *   其它（副标题、轮次标签、颜色…）→ null
 *
 * 用「单个大写字母开头」而不是「以 a 开头」来判定：
 * accentColor 也以 a 开头，但它不是 A 位的名字槽位。
 */
export function slotSide(key) {
  if (/^a[A-Z]/.test(key) || /^left/.test(key)) return 'A';
  if (/^b[A-Z]/.test(key) || /^right/.test(key)) return 'B';
  return null;
}

/** 模板是否是双人（左右）型 —— 只要同时存在 A 侧与 B 侧槽位 */
export function isDualTemplate(tpl) {
  if (!tpl || !Array.isArray(tpl.slots)) return false;
  const sides = new Set(tpl.slots.map((s) => slotSide(s.key)).filter(Boolean));
  return sides.has('A') && sides.has('B');
}

// ─────────────────────────────────────────────────────────────
// 双人阵容（跨模板保留 + 与比分条互通）
// ─────────────────────────────────────────────────────────────

function lineupSnap(id) {
  const e = id ? entities.get(id) : null;
  if (!e) return null;
  const team = isTeamMode() ? entities.resolveTeam(e) : null;
  return {
    entityId: e.id,
    kind: e.kind,
    name: e.name,
    image: e.image || '',
    role: e.role || '',
    handle: e.handle || '',
    teamId: team?.id || null,
    teamName: team?.name || '',
    teamImage: team?.image || '',
  };
}

/** 当前 A / B 两侧的选手快照（null = 该侧为空） */
export function getLineup() {
  return { A: lineupSnap(lineup.A), B: lineupSnap(lineup.B) };
}

function syncLineupState() {
  set('overlay.lineup', getLineup());
}

/** 把 lineup 中该侧选手写进目标实例的当前双人模板（默认 preview） */
function applyLineupToTarget(side, target) {
  const s = getTarget(target);
  if (!s.activeTemplate) return;
  const tpl = templates.get(s.activeTemplate);
  if (!isDualTemplate(tpl)) return;

  const e = lineup[side] ? entities.get(lineup[side]) : null;
  const values = {};
  for (const slot of tpl.slots) {
    if (slotSide(slot.key) !== side) continue;
    if (e) {
      const v = mapEntityToSlot(e, slot, { teamMode: isTeamMode() });
      if (v !== undefined) values[slot.key] = v;
    } else {
      values[slot.key] = '';      // 清空该侧（比分条取消选手时同步清掉）
    }
  }
  if (Object.keys(values).length) updateMany(values, { target });
}

/**
 * 设置某一侧的选手。比分条与叠加页共用。
 * @param {'A'|'B'} side
 * @param {string|null} entityId null = 清空该侧
 * @param {{syncPreview?:boolean, target?:string}} opts
 */
export function setLineupSide(side, entityId, opts = {}) {
  const s = side === 'B' ? 'B' : 'A';
  const e = entityId ? entities.get(entityId) : null;
  if (entityId && !e) return { ok: false, nack: { code: 'unknown_entity', msg: '实体不存在' } };

  const next = e ? e.id : null;
  if (lineup[s] === next) return { ok: true, lineup: getLineup(), unchanged: true };

  lineup[s] = next;
  syncLineupState();
  overlayEvents.emit('lineup', getLineup());

  // 叠加那边默认改**预览**，绝不直接动直播输出
  if (opts.syncPreview !== false) applyLineupToTarget(s, opts.target || 'preview');
  log.audit('overlay', 'lineup', { side: s, entity: e ? e.name : null, target: opts.target || 'preview' });
  return { ok: true, lineup: getLineup() };
}

/**
 * 切换模板时，把 lineup 里已有的选手补进空的双人槽位。
 * 单人模板不调用 —— 保持「切到单人模板照常清空」。
 */
function fillFromLineup(tpl, values) {
  for (const slot of tpl.slots) {
    const side = slotSide(slot.key);
    if (!side) continue;
    const cur = values[slot.key];
    if (cur !== undefined && cur !== null && cur !== '') continue;
    const e = lineup[side] ? entities.get(lineup[side]) : null;
    if (!e) continue;
    const v = mapEntityToSlot(e, slot, { teamMode: isTeamMode() });
    if (v !== undefined) values[slot.key] = v;
  }
}

// 启动时把空的阵容写进状态，前端与比分条不必等第一次填充
syncLineupState();

/**
 * 依据槽位的 entitySource，把实体字段映射到槽位。
 * 这是**显式操作**触发的（用户点选手），不是自动推断 —— 符合 A-REQ-004。
 *
 * ★ 双人模板必须指定 `side`（'A' | 'B'），**只填那一侧**。
 * 不指定时默认 'A'。
 * 早期实现会把这个人的姓名同时写进 aName 和 bName，
 * 表现就是「点一下，两个槽位都变成同一个人」。
 */
export function fillFromEntity(entityId, opts = {}) {
  const e = entities.get(entityId);
  if (!e) return { ok: false, nack: { code: 'unknown_entity', msg: '实体不存在' } };

  const target = opts.target || getConfig().render.defaultTarget || 'main';
  const s = getTarget(target);
  const tplId = opts.template || s.activeTemplate;
  const tpl = tplId ? templates.get(tplId) : null;
  if (!tpl) return { ok: false, nack: { code: 'unknown_template', msg: '未指定模板且当前没有活动模板' } };

  const dual = isDualTemplate(tpl);
  const side = opts.side === 'B' ? 'B' : 'A';
  const teamMode = isTeamMode();

  const values = {};
  for (const slot of tpl.slots) {
    if (dual) {
      const slotOn = slotSide(slot.key);
      // 双人模板：只动目标那一侧；无侧别的槽位（标题/颜色）每次都更新
      if (slotOn && slotOn !== side) continue;
    }
    const v = mapEntityToSlot(e, slot, { teamMode });
    if (v !== undefined) values[slot.key] = v;
  }

  // 显式设置「当前玩家」—— 只有选手类实体才设置（A-REQ-004）
  if (e.kind === 'player') {
    entities.setCurrent(e.id);
  }

  let result;
  if (s.activeTemplate === tpl.id && s.visible) {
    // 已显示同模板 → 走热改，不重播动画
    const r = updateMany(values, { target });
    result = { ok: true, ...r, filled: values, player: e };
  } else {
    // 分侧填充时允许另一侧暂时为空（否则第一次点 A 会被 B 的必填校验打回）
    const r = show({
      template: tpl.id,
      values: { ...s.slotValues, ...values },
      target,
      actor: opts.actor,
      skipRequired: dual,
    });
    result = r.ok
      ? { ok: true, state: r.state, filled: values, player: e }
      : r;
  }
  if (result.ok && dual) {
    result.side = side;
    result.nextSide = side === 'A' ? 'B' : 'A';
    // 记入跨模板阵容：切换模板 / 比分条都会用到（本次已写进目标实例，不再重复下发）
    setLineupSide(side, e.id, { syncPreview: false });
    log.audit('overlay', 'fillSide', { target, template: tpl.id, side, entity: e.name });
  }
  return result;
}

/**
 * ★ 双人（或多实体）一键填充。
 *
 * 单实体的 `fillFromEntity()` 无法区分左右：对 talentTwin / versusCard 这类模板，
 * 它会把 aName 和 bName 都填成**同一个人** —— 这正是「双人名牌填进去两个一样的人物」的根因。
 * 这里按槽位名的侧别前缀把实体分派到 A / B 两侧：
 *   aXxx / leftXxx → 第 1 个实体
 *   bXxx / rightXxx → 第 2 个实体
 * 没有侧别前缀的槽位（副标题、轮次标签等）统一用第 1 个实体。
 *
 * @param {string[]} entityIds 按顺序传入，最多用到前两个
 * @param {{template?:string, target?:string, actor?:string}} opts
 */
export function fillFromEntities(entityIds, opts = {}) {
  const ids = (Array.isArray(entityIds) ? entityIds : [entityIds]).filter(Boolean);
  if (!ids.length) return { ok: false, nack: { code: 'no_entity', msg: '没有选择任何实体' } };

  const ents = ids.map((id) => entities.get(id));
  const missing = ids.filter((id, i) => !ents[i]);
  if (missing.length) return { ok: false, nack: { code: 'unknown_entity', msg: `实体不存在：${missing.join(', ')}` } };
  if (ids.length === 1) {
    // 只选了一个人却投给双人模板 → 明确拒绝，而不是默默复制成两份
    const tplNow = templates.get(opts.template || getTarget(opts.target || 'main').activeTemplate);
    if (isDualTemplate(tplNow)) {
      return {
        ok: false,
        nack: { code: 'need_two_entities', msg: `模板「${tplNow.name}」是双人模板，请选择两名不同的实体` },
      };
    }
  }

  const target = opts.target || getConfig().render.defaultTarget || 'main';
  const s = getTarget(target);
  const tplId = opts.template || s.activeTemplate;
  const tpl = tplId ? templates.get(tplId) : null;
  if (!tpl) return { ok: false, nack: { code: 'unknown_template', msg: '未指定模板且当前没有活动模板' } };

  const teamMode = isTeamMode();
  const values = {};
  for (const slot of tpl.slots) {
    // 'A' → 第 1 个实体；'B' → 第 2 个；无侧别 → 第 1 个
    const idx = slotSide(slot.key) === 'B' ? 1 : 0;
    const e = ents[Math.min(idx, ents.length - 1)];
    if (!e) continue;
    const v = mapEntityToSlot(e, slot, { teamMode });
    if (v !== undefined) values[slot.key] = v;
  }

  // currentPlayer 只认选手（A-REQ-004：显式设置，不自动推断）
  if (ents[0]?.kind === 'player') entities.setCurrent(ents[0].id);

  const dual = isDualTemplate(tpl);
  if (dual) {
    setLineupSide('A', ents[0]?.id, { syncPreview: false });
    if (ents[1]) setLineupSide('B', ents[1].id, { syncPreview: false });
  }

  if (s.activeTemplate === tpl.id && s.visible) {
    const r = updateMany(values, { target });
    log.audit('overlay', 'fillFromEntities(hot)', { target, template: tpl.id, entities: ents.map((e) => e.name) });
    return { ok: true, ...r, filled: values, entities: ents.map((e) => e.name) };
  }
  const r = show({ template: tpl.id, values: { ...s.slotValues, ...values }, target, actor: opts.actor });
  log.audit('overlay', 'fillFromEntities', { target, template: tpl.id, entities: ents.map((e) => e.name) });
  return r.ok
    ? { ok: true, state: r.state, filled: values, entities: ents.map((e) => e.name) }
    : r;
}

/**
 * 判断槽位是不是「队伍相关」的。
 *   teamName / teamAvatar / leftTeam / rightTeam / leftTeamAvatar / rightTeamAvatar
 */
function isTeamSlot(key) {
  const k = key.toLowerCase();
  return k === 'teamname' || k === 'teamavatar'
    || k === 'leftteam' || k === 'rightteam'
    || k === 'leftteamavatar' || k === 'rightteamavatar';
}

function mapEntityToSlot(e, slot, opts = {}) {
  const key = slot.key.toLowerCase();
  const fallback = slot.default;
  const teamMode = opts.teamMode !== false;

  /**
   * ★ 队伍槽位。
   * 团队赛模式填队伍名 / 队伍 Logo；单人赛模式一律填**空字符串**，
   * 模板 CSS 会把整块队伍区域隐藏（`:not(:has(...))`），不留空位。
   */
  if (isTeamSlot(key)) {
    if (!teamMode) return '';                 // 单人赛：明确清空
    const team = entities.resolveTeam(e);
    if (!team) return '';
    if (slot.type === 'image' || key.endsWith('avatar')) return team.image || '';
    return team.name || '';
  }

  if (slot.type === 'image') {
    if (!e.image) return fallback;
    // 媒体库资源统一走原图 URL（渲染端会 preload）
    return e.image;
  }
  if (slot.type === 'number') {
    if (key.includes('columns')) return undefined;
    return typeof fallback === 'number' ? fallback : undefined;
  }
  if (slot.type === 'select') return fallback ?? slot.options?.[0];

  // text
  if (key === 'leftname' || key === 'aname') return e.name;
  if (key === 'rightname' || key === 'bname') return e.name;
  if (key === 'name') return e.name;
  // 副标题不再混入队伍名（队伍有自己的槽位，否则会重复显示两遍）
  if (key === 'subtitle') return [e.handle, e.role].filter(Boolean).join(' / ') || fallback;
  if (key === 'role') return e.role || fallback;
  if (key === 'title') return e.name || fallback;
  if (key === 'roundlabel' || key === 'tier') return e.tier || fallback;
  if (key === 'speed' || key === 'mode') return fallback;
  return undefined;
}

/** 当前是否团队赛模式 */
function isTeamMode() {
  return (getConfig().competition?.mode || 'team') === 'team';
}

// ─────────────────────────────────────────────────────────────
// 槽位校验与归一
// ─────────────────────────────────────────────────────────────

function sanitizeValue(def, value) {
  // ★ 多值槽位优先处理 —— 必须放在各类型分支之前。
  //   否则 text 类型的多值槽位（致谢的 lines）会掉进 `String(value)`，
  //   整个数组被压成 "[object Object],..."，滚动致谢就彻底乱了。
  if (def.multi) return normalizeMulti(def, value);

  if (value === null || value === undefined) return def.default ?? (def.type === 'number' ? 0 : '');
  if (def.type === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : (def.default ?? 0);
  }
  if (def.type === 'color') {
    const s = String(value);
    return /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s) ? s : (def.default || '#FFFFFF');
  }
  if (def.type === 'text') {
    let s = String(value);
    if (def.maxLength && s.length > def.maxLength) s = s.slice(0, def.maxLength);
    return s;
  }
  if (def.type === 'image') {
    return String(value || '');
  }
  return value;
}

/**
 * 多值槽位归一化。返回「行对象」数组，字段别名按用途补齐：
 *   · 图片类：src / image / url 三个别名都给（模板作者写哪个都能渲染）
 *   · 文字类：text / item 互补（字符串项直接当文字）
 *
 * @param {object} def 槽位定义
 * @param {unknown} value 任意形态的输入
 */
function normalizeMulti(def, value) {
  const arr = Array.isArray(value) ? value : (value ? [value] : []);
  return arr.map((v) => {
    if (def.type === 'image') return normalizeImageItem(v);

    // 文字类的多值槽位（致谢条目：{ group, text } 或纯字符串）
    if (typeof v === 'string') return { text: v, group: '', item: v };
    if (v && typeof v === 'object') {
      const text = v.text ?? v.name ?? '';
      return {
        ...v,
        text: String(text),
        group: String(v.group ?? ''),
        item: String(text),
      };
    }
    return { text: String(v ?? ''), group: '', item: String(v ?? '') };
  });
}

/**
 * 归一化多值图片槽位里的单条数据。
 *
 * ★ 必须同时提供 src / image / url 三个别名：
 * 模板作者写 `{{image}}`、`{{src}}`、`{{url}}` 的都有，
 * 只给其中一个是「模板里明明填了图却显示空白」的常见来源。
 */
function normalizeImageItem(v) {
  const base = typeof v === 'string'
    ? { src: v, name: '' }
    : (v && typeof v === 'object'
      ? {
        src: v.src || v.url || v.image || v.thumbnail || '',
        name: v.name || v.text || '',
        tier: v.tier || '',
        group: v.group || '',
        alt: v.alt || v.name || '',
      }
      : { src: '', name: '' });

  const s = base.src;
  return { ...base, image: s, url: s, item: base.name || s };
}

function sanitizeValues(tpl, values) {
  const out = {};
  for (const [k, v] of Object.entries(values || {})) {
    const def = tpl.slots.find((s) => s.key === k);
    if (!def) { out[k] = v; continue; }
    out[k] = sanitizeValue(def, v);
  }
  // 补齐默认值
  for (const def of tpl.slots) {
    if (out[def.key] === undefined && def.default !== undefined) out[def.key] = def.default;
  }
  return out;
}

function validateRequired(tpl, values) {
  const errs = {};
  for (const slot of tpl.slots) {
    if (!slot.required) continue;
    const v = values[slot.key];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      errs[slot.key] = '必填槽位不能为空';
    }
  }
  return errs;
}

// ─────────────────────────────────────────────────────────────
// 队列 A-REQ-508
// ─────────────────────────────────────────────────────────────

export function queueAdd(item) {
  const tpl = templates.get(item.template);
  if (!tpl) return { ok: false, nack: { code: 'unknown_template', msg: `模板不存在：${item.template}` } };
  const entry = {
    id: `q${Date.now()}${Math.floor(Math.random() * 1000)}`,
    template: item.template,
    values: item.values || {},
    durationMs: item.durationMs ?? 6000,
    label: item.label || tpl.name,
  };
  queue.push(entry);
  set('overlay.queue', queue);
  log.info('overlay', `队列新增：${entry.label}`, { queueLen: queue.length });
  return { ok: true, item: entry, queue };
}

export function queueSet(items) {
  queue = (items || []).map((it, i) => ({ id: it.id || `q${Date.now()}${i}`, ...it }));
  set('overlay.queue', queue);
  return { ok: true, queue };
}

export function queueClear() {
  stopQueue();
  queue = [];
  set('overlay.queue', queue);
  return { ok: true };
}

export function queueRemove(id) {
  const i = queue.findIndex((x) => x.id === id);
  if (i === -1) return { ok: false, nack: { code: 'not_found', msg: '队列项不存在' } };
  queue.splice(i, 1);
  set('overlay.queue', queue);
  return { ok: true, queue };
}

export function queueReorder(ids) {
  const map = new Map(queue.map((q) => [q.id, q]));
  queue = ids.map((id) => map.get(id)).filter(Boolean);
  set('overlay.queue', queue);
  return { ok: true, queue };
}

export function queueStart(opts = {}) {
  if (queueTimer) return { ok: true, already: true };
  queuePaused = false;
  nextInQueue(opts.target || null);
  return { ok: true, target: opts.target || null };
}

export function queuePause() {
  queuePaused = true;
  clearTimeout(queueTimer);
  queueTimer = null;
  set('overlay.queuePlaying', false);
  return { ok: true };
}

export function queueResume(opts = {}) {
  if (!queuePaused) return { ok: false, nack: { code: 'not_paused', msg: '队列未处于暂停状态' } };
  queuePaused = false;
  nextInQueue(opts.target || null);
  return { ok: true };
}

function stopQueue() {
  clearTimeout(queueTimer);
  queueTimer = null;
  set('overlay.queuePlaying', false);
}

function nextInQueue(target = null) {
  stopQueue();
  if (queuePaused) return;
  const item = queue.shift();
  set('overlay.queue', queue);
  if (!item) {
    log.info('overlay', '队列播放完毕');
    return;
  }
  // 队列跟随「编辑目标」：预览模式下排队播放只影响预览，不会上屏
  const tgt = target || item.target || getConfig().render.defaultTarget || 'main';
  set('overlay.queuePlaying', true);
  show({ template: item.template, values: item.values, actor: 'queue', target: tgt });
  queueTimer = setTimeout(() => {
    hide({ target: tgt });
    queueTimer = setTimeout(() => nextInQueue(tgt), 500);
    queueTimer.unref?.();
  }, item.durationMs);
  queueTimer.unref?.();
}

// ─────────────────────────────────────────────────────────────
// 致谢专项 A-REQ-520 ~ 526
// ─────────────────────────────────────────────────────────────

/** A-REQ-523：时长预估（内容高度 / 速度） */
export function estimateCreditsDuration({ lines = [], speed = 40, viewportHeight = 1080, lineHeight = 76 }) {
  const n = lines.length;
  const contentHeight = n * lineHeight + 160;   // 标题 + 内边距的粗估
  const totalPx = contentHeight + viewportHeight;
  const seconds = totalPx / Math.max(1, speed);
  return { contentHeight, totalPx, seconds: +seconds.toFixed(1), speed };
}

/** 标签批量导入（A-REQ-520） */
export function creditsFromTags(tags = [], { kind = 'sponsor' } = {}) {
  const list = entities.list({ kind });
  const picked = tags.length === 0 ? list : list.filter((e) => tags.some((t) => (e.tags || []).includes(t)));
  return picked.map((e) => ({ image: e.image || '', name: e.name, tier: e.tier || '' }));
}

/** 滚动控制（A-REQ-526：暂停 / 继续 / 跳到某组） */
export function creditsControl(action, opts = {}) {
  const target = opts.target || 'credits';
  send({ t: 'overlay:credits', target, action, ...opts }, target);
  log.info('overlay', `致谢滚动控制：${action}`, opts);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// 下发
// ─────────────────────────────────────────────────────────────

function send(msg, target, renderersOnly = true) {
  const s = getTarget(target);
  s.sentAt = Date.now();
  if (renderersOnly) hub.toRenderers(msg, target);
  else hub.broadcast(msg);
}

/** 渲染端上报 overlay:rendered（A-REQ-604） */
export function markRendered(target, template, at) {
  const s = getTarget(target);
  s.renderedAt = at || Date.now();
  set('overlay.renderedAt', s.renderedAt);
  set('overlay.lastRenderedTemplate', template);
  // 顺带把「已发未渲染」的超时告警做掉：>1500ms 说明渲染端有问题
  if (s.sentAt && s.renderedAt - s.sentAt > 1500) {
    log.warn('overlay', `渲染延迟过大：${s.renderedAt - s.sentAt}ms`, { target, template });
  }
  return s.renderedAt - s.sentAt;
}

/** 渲染端接入 / 断开 */
export function markRendererConnected(target, info) {
  const s = getTarget(target || 'main');
  set('overlay.clients', {
    ...(getState().overlay.clients || {}),
    [target || 'main']: { ...info, at: Date.now() },
  });
  // A-REQ-604 / AC-A16：渲染端重连后全量同步当前状态
  if (s.activeTemplate) {
    const tpl = templates.fullList().find((x) => x.id === s.activeTemplate);
    hub.toRenderers({
      t: 'overlay:show', target: s.target, template: s.activeTemplate, templateDef: tpl,
      values: s.slotValues, anim: { in: 'none', out: 'none', durationMs: 0 }, mode: s.mode, rebuild: true,
    }, s.target);
  }
  if (s.mode !== 'live') hub.toRenderers({ t: 'overlay:mode', target: s.target, mode: s.mode, label: s.modeLabel }, s.target);
  if (!s.visible && s.activeTemplate) hub.toRenderers({ t: 'overlay:hide', target: s.target, anim: { in: 'none', out: 'none', durationMs: 0 } }, s.target);
  return { ok: true };
}

export function markRendererDisconnected(target) {
  const cur = { ...(getState().overlay.clients || {}) };
  delete cur[target || 'main'];
  set('overlay.clients', cur);
}

export function snapshot() { return allTargets(); }
