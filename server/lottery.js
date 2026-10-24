/**
 * 模块 E —— 抽奖 / 现场签到。
 *
 * 抽奖池由三部分组成（可勾选）：
 *   · 实体库里的选手 / 解说·导播·主持 / 赞助商 / 队伍（按类型与标签过滤）
 *   · 现场扫码签到的人（/join）
 *   · 第三方中继拉取的人（在线表单 → 云函数 → 本服务定时拉取，无需公网入站）
 *
 * 抽奖流程：draw() 先选出结果并进入 spinning，spinMs 后才 reveal；
 * 动画期间不把结果下发给渲染端，避免提前剧透。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { getConfig, ROOT } from './config.js';
import { resolvePublicUrl } from './public-url.js';
import { set } from './state.js';
import * as entities from './entities.js';
import * as hub from './ws-hub.js';
import * as log from './logger.js';

const FILE = () => process.env.LP_LOTTERY_FILE || path.join(ROOT, 'data', 'lottery.json');
const HIST_LIMIT = 100;
const GUEST_LIMIT = 5000;
const VALID_KINDS = ['player', 'talent', 'sponsor', 'team'];

const EMPTY_PRIZE = {
  name: '',
  image: '',
  note: '',
  /** 上传来源：{ ip, at, hash }，手工填 URL 时为空 */
  meta: { ip: '', at: 0, hash: '' },
};

const DEFAULT_SETTINGS = {
  kinds: ['player', 'talent'],
  tags: [],
  includeGuests: true,
  removeWinners: true,
  /** 本轮奖品：奖品大屏 / 抽奖大屏都会显示 */
  prize: { ...EMPTY_PRIZE, meta: { ...EMPTY_PRIZE.meta } },
};

const st = {
  settings: { ...DEFAULT_SETTINGS },
  guests: [],
  winners: [],
  history: [],
  phase: 'idle',
  winner: null,
  spin: null,
  pendingWinner: null,
  revision: 0,
  timer: null,
};

let relayTimer = null;
let relayLastWarn = 0;

// ─────────────────────────────────────────────────────────────
// 持久化
// ─────────────────────────────────────────────────────────────

export function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    if (raw.settings && typeof raw.settings === 'object') {
      const s = raw.settings;
      if (Array.isArray(s.kinds)) st.settings.kinds = s.kinds.filter((k) => VALID_KINDS.includes(k));
      if (Array.isArray(s.tags)) st.settings.tags = s.tags.map(String).slice(0, 30);
      if (typeof s.includeGuests === 'boolean') st.settings.includeGuests = s.includeGuests;
      if (typeof s.removeWinners === 'boolean') st.settings.removeWinners = s.removeWinners;
      if (s.prize && typeof s.prize === 'object') st.settings.prize = cleanPrize(s.prize);
    }
    if (Array.isArray(raw.guests)) st.guests = raw.guests.filter(validGuest).slice(-GUEST_LIMIT);
    // 兼容旧数据：没有签到序号的按存储顺序补齐，避免新加的人从 #1 开始和旧记录撞号
    let maxTicket = 0;
    for (const g of st.guests) {
      const t = Number(g.ticket);
      if (Number.isFinite(t) && t > maxTicket) maxTicket = t;
    }
    for (const g of st.guests) {
      const t = Number(g.ticket);
      if (!Number.isFinite(t) || t <= 0) g.ticket = ++maxTicket;
    }
    if (Array.isArray(raw.winners)) st.winners = raw.winners.filter((w) => w && w.name).slice(-200);
    if (Array.isArray(raw.history)) st.history = raw.history.filter((h) => h && h.name).slice(0, HIST_LIMIT);
  } catch { /* 首次启动没有文件 */ }
  st.phase = 'idle';
  st.winner = null;
  st.spin = null;
  broadcast();
  return snapshot();
}

function validGuest(g) {
  return g && typeof g === 'object' && typeof g.name === 'string' && g.name.trim();
}

function save() {
  try {
    const dir = path.dirname(FILE());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(FILE(), `${JSON.stringify({
      settings: st.settings,
      guests: st.guests,
      winners: st.winners,
      history: st.history,
    }, null, 2)}\n`, 'utf8');
  } catch (e) {
    log.warn('lottery', '抽奖数据写盘失败（不影响本次抽奖）', { err: e.message });
  }
}

// ─────────────────────────────────────────────────────────────
// 抽奖池
// ─────────────────────────────────────────────────────────────

function normKey(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function teamNameOf(e) {
  const t = entities.resolveTeam(e);
  return t?.name || '';
}

function entityCandidates() {
  const kinds = new Set(st.settings.kinds || []);
  const tags = (st.settings.tags || []).map((x) => String(x).toLowerCase()).filter(Boolean);
  return entities.list()
    .filter((e) => kinds.has(e.kind))
    .filter((e) => {
      if (!tags.length) return true;
      const et = (e.tags || []).map((x) => String(x).toLowerCase());
      return tags.some((t) => et.includes(t));
    })
    .map((e) => ({
      id: `entity:${e.id}`,
      key: `entity:${e.id}`,
      entityId: e.id,
      name: e.name,
      kind: e.kind,
      source: 'entity',
      team: teamNameOf(e),
      image: e.image || '',
      tags: e.tags || [],
    }));
}

function guestCandidates() {
  if (!st.settings.includeGuests) return [];
  return st.guests.map((g) => ({
    id: g.id,
    key: g.key,
    name: g.name,
    kind: 'guest',
    source: 'guest',
    team: g.team || '',
    image: g.image || '',
    tags: [],
  }));
}

/** 当前可抽池子：类型/标签过滤 + 签到 + 中奖者排除 */
export function buildPool() {
  const all = [...entityCandidates(), ...guestCandidates()];
  const exclude = st.settings.removeWinners ? new Set(st.winners.map((w) => w.key)) : new Set();
  const seen = new Set();
  const out = [];
  for (const c of all) {
    if (!c.key || exclude.has(c.key) || seen.has(c.key)) continue;
    seen.add(c.key);
    out.push(c);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 快照 / 广播
// ─────────────────────────────────────────────────────────────

export function snapshot() {
  const pool = buildPool();
  return {
    phase: st.phase,
    spin: st.phase === 'spinning' && st.spin
      ? { startedAt: st.spin.startedAt, endsAt: st.spin.endsAt, sample: st.spin.sample }
      : null,
    // 动画期间不下发结果，避免提前剧透
    winner: st.phase === 'revealed' ? st.winner : null,
    poolSize: pool.length,
    pool: pool.slice(0, 500),
    poolTruncated: pool.length > 500,
    settings: {
      ...st.settings,
      prize: {
        ...st.settings.prize,
        meta: { ...(st.settings.prize?.meta || EMPTY_PRIZE.meta) },
      },
    },
    guests: st.guests.map(({ key, ...g }) => g),
    winners: st.winners.slice(-100),
    history: st.history.slice(0, 50),
    revision: st.revision,
  };
}

function rendererState(s) {
  return {
    phase: s.phase,
    spin: s.spin,
    winner: s.winner,
    prize: { ...(s.settings?.prize || EMPTY_PRIZE) },
    poolSize: s.poolSize,
    revision: s.revision,
  };
}

export function broadcast() {
  st.revision++;
  const s = snapshot();
  s.revision = st.revision;
  set('lottery.state', s);
  hub.toRenderers({ t: 'lottery:state', state: rendererState(s) }, 'lottery');
}

// ─────────────────────────────────────────────────────────────
// 抽奖
// ─────────────────────────────────────────────────────────────

function sampleNames(pool, n) {
  if (!pool.length) return [];
  const names = [];
  const take = Math.min(n, pool.length * 2);
  for (let i = 0; i < take; i++) names.push(pool[randomInt(pool.length)].name);
  return names;
}

export function draw(actor = 'operator') {
  if (st.phase === 'spinning') {
    return { ok: false, nack: { code: 'busy', msg: '正在抽奖中，请等揭晓' } };
  }
  const pool = buildPool();
  if (!pool.length) {
    return { ok: false, nack: { code: 'empty_pool', msg: '抽奖池是空的：先勾选类型/标签，或让人扫码签到' } };
  }
  const pick = pool[randomInt(pool.length)];
  const spinMs = Math.min(15000, Math.max(500, Number(getConfig().lottery?.spinMs) || 2800));

  st.pendingWinner = pick;
  st.winner = null;
  st.phase = 'spinning';
  st.spin = { startedAt: Date.now(), endsAt: Date.now() + spinMs, sample: sampleNames(pool, 48) };
  broadcast();
  log.audit('lottery', 'draw', { pool: pool.length, actor, spinMs });

  clearTimeout(st.timer);
  st.timer = setTimeout(() => reveal(pick), spinMs);
  st.timer.unref?.();
  return { ok: true, state: snapshot() };
}

function reveal(pick) {
  st.timer = null;
  if (!pick) { st.phase = 'idle'; st.spin = null; broadcast(); return; }

  const winner = {
    ...pick,
    at: Date.now(),
    index: st.winners.length + 1,
  };
  st.winners.push(winner);
  if (st.winners.length > 200) st.winners = st.winners.slice(-200);
  st.history.unshift({
    at: winner.at, index: winner.index, name: winner.name, team: winner.team || '',
    kind: winner.kind, source: winner.source,
  });
  if (st.history.length > HIST_LIMIT) st.history.length = HIST_LIMIT;

  st.winner = winner;
  st.phase = 'revealed';
  st.spin = null;
  st.pendingWinner = null;
  save();
  broadcast();
  log.info('lottery', `抽中：${winner.name}`, { index: winner.index, source: winner.source });
}

/** scope: 'round' 只清当前画面；'all' 连中奖记录一起清 */
export function reset(scope = 'round', actor = 'operator') {
  clearTimeout(st.timer);
  st.timer = null;
  st.phase = 'idle';
  st.winner = null;
  st.spin = null;
  st.pendingWinner = null;
  if (scope === 'all') {
    st.winners = [];
    st.history = [];
    addAudit('reset-all', actor);
    log.audit('lottery', 'reset-all', { actor });
    save();
  } else {
    log.audit('lottery', 'reset-round', { actor });
  }
  broadcast();
  return { ok: true, state: snapshot() };
}

function addAudit(action, actor) {
  log.audit('lottery', action, { actor });
}

export function setSettings(patch = {}, actor = 'operator') {
  if (Array.isArray(patch.kinds)) {
    st.settings.kinds = patch.kinds.map(String).filter((k) => VALID_KINDS.includes(k));
  }
  if (Array.isArray(patch.tags)) {
    st.settings.tags = patch.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 30);
  }
  if (typeof patch.includeGuests === 'boolean') st.settings.includeGuests = patch.includeGuests;
  if (typeof patch.removeWinners === 'boolean') st.settings.removeWinners = patch.removeWinners;
  if (patch.prize !== undefined) st.settings.prize = cleanPrize(patch.prize);
  log.audit('lottery', 'settings', { ...st.settings, actor });
  save();
  broadcast();
  return { ok: true, state: snapshot() };
}

// ─────────────────────────────────────────────────────────────
// 签到池
// ─────────────────────────────────────────────────────────────

function cleanText(v, max = 40) {
  return String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
}

/**
 * 奖品图片地址只允许三类：站内媒体库 / assets、data:image、http(s)。
 * 空字符串表示没有图片；其他协议（javascript: / file: 等）直接丢弃。
 */
function safeImage(v) {
  const s = String(v ?? '').trim().slice(0, 800);
  if (!s) return '';
  if (/^\/(media|assets)\//.test(s)) return s;
  if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(s)) return s;
  if (/^https?:\/\//i.test(s)) return s;
  return '';
}

function cleanImageMeta(m) {
  if (!m || typeof m !== 'object') return { ...EMPTY_PRIZE.meta };
  return {
    ip: typeof m.ip === 'string' ? cleanText(m.ip, 64) : '',
    at: Number.isFinite(Number(m.at)) ? Math.max(0, Math.round(Number(m.at))) : 0,
    hash: typeof m.hash === 'string' ? cleanText(m.hash, 80) : '',
  };
}

function cleanPrize(p) {
  if (!p || typeof p !== 'object') return { ...EMPTY_PRIZE, meta: { ...EMPTY_PRIZE.meta } };
  return {
    name: cleanText(p.name, 80),
    image: safeImage(p.image),
    note: cleanText(p.note, 160),
    meta: cleanImageMeta(p.meta),
  };
}

/** 媒体库删除前的引用检查：本轮奖品的图片不能被悄悄删掉。 */
export function referencingImage(url) {
  const s = String(url || '').trim();
  if (!s) return [];
  const p = st.settings?.prize;
  if (p?.image && String(p.image).includes(s)) {
    return [{ name: p.name || '本轮奖品' }];
  }
  return [];
}

function nextTicket() {
  let max = 0;
  for (const g of st.guests) max = Math.max(max, Number(g.ticket) || 0);
  return max + 1;
}

/**
 * 加入签到池。返回 ticket（在签到池里的稳定序号）。
 * 同名 + 同昵称视为重复，避免同一人反复扫码。
 */
export function addGuest(input = {}, { source = 'join', silent = false } = {}) {
  const name = cleanText(input.name, 40);
  const handle = cleanText(input.handle, 40);
  const team = cleanText(input.team, 40);
  if (!name) return { ok: false, nack: { code: 'empty_name', msg: '请填写姓名' } };
  if (st.guests.length >= GUEST_LIMIT) {
    return { ok: false, nack: { code: 'pool_full', msg: `签到池已满（${GUEST_LIMIT} 人）` } };
  }

  const key = `guest:${normKey(name)}|${normKey(handle)}`;
  if (st.guests.some((g) => g.key === key || (normKey(g.name) === normKey(name) && normKey(g.handle || '') === normKey(handle)))) {
    return { ok: false, nack: { code: 'duplicate', msg: '这个名字已经在抽奖池里了' } };
  }

  const guest = {
    id: `guest-${randomUUID().slice(0, 8)}`,
    key,
    name,
    handle,
    team,
    source,
    ticket: nextTicket(),
    at: Date.now(),
    externalId: input.externalId ? String(input.externalId).slice(0, 80) : null,
  };
  st.guests.push(guest);
  if (!silent) {
    save();
    broadcast();
    log.info('lottery', `签到加入：${name}`, { source, total: st.guests.length });
  }
  return { ok: true, guest, ticket: guest.ticket, count: st.guests.length };
}

/** 编辑已有签到（姓名 / 昵称 / 队伍）；结果会同步到中奖记录里的同名条目 */
export function updateGuest(id, patch = {}, actor = 'operator') {
  const idx = st.guests.findIndex((g) => g.id === id);
  if (idx < 0) return { ok: false, nack: { code: 'not_found', msg: '签到记录不存在' } };
  const g = st.guests[idx];
  const name = patch.name !== undefined ? cleanText(patch.name, 40) : g.name;
  const handle = patch.handle !== undefined ? cleanText(patch.handle, 40) : (g.handle || '');
  const team = patch.team !== undefined ? cleanText(patch.team, 40) : (g.team || '');
  if (!name) return { ok: false, nack: { code: 'empty_name', msg: '姓名不能为空' } };

  const key = `guest:${normKey(name)}|${normKey(handle)}`;
  const dup = st.guests.some((x, i) => i !== idx
    && (x.key === key || (normKey(x.name) === normKey(name) && normKey(x.handle || '') === normKey(handle))));
  if (dup) return { ok: false, nack: { code: 'duplicate', msg: '已有同名 + 同昵称的签到记录' } };

  const before = { name: g.name, handle: g.handle || '', team: g.team || '' };
  Object.assign(g, { name, handle, team, key });
  // 已中奖的人改名后，抽奖池的「中奖后移出」排除项也要跟着更新
  for (const w of st.winners) {
    if (w.id === id) Object.assign(w, { name, handle, team, key });
  }
  log.audit('lottery', 'guest-update', { id, from: before, to: { name, handle, team }, actor });
  save();
  broadcast();
  return { ok: true, state: snapshot() };
}

export function removeGuest(id, actor = 'operator') {
  const idx = st.guests.findIndex((g) => g.id === id);
  if (idx < 0) return { ok: false, nack: { code: 'not_found', msg: '签到记录不存在' } };
  const [g] = st.guests.splice(idx, 1);
  log.audit('lottery', 'remove-guest', { name: g.name, ticket: g.ticket || null, actor });
  save();
  broadcast();
  return { ok: true, state: snapshot() };
}

export function clearGuests(actor = 'operator') {
  st.guests = [];
  log.audit('lottery', 'clear-guests', { actor });
  save();
  broadcast();
  return { ok: true, state: snapshot() };
}

// ─────────────────────────────────────────────────────────────
// 导入（在线表格 CSV / 粘贴）
// ─────────────────────────────────────────────────────────────

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',' || ch === '\t') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * 导入在线表格导出的 CSV / 粘贴的行。
 * 列顺序：姓名, 队伍(可选), 昵称(可选)。首行若含「姓名/name」视为表头跳过。
 */
export function importText(text, actor = 'operator') {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { ok: false, nack: { code: 'empty', msg: '没有可导入的内容' } };

  let added = 0;
  let skipped = 0;
  const errors = [];
  const start = /姓名|名字|name/i.test(lines[0]) ? 1 : 0;

  for (let i = start; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const name = cols[0];
    if (!name) { skipped++; continue; }
    const r = addGuest({ name, team: cols[1] || '', handle: cols[2] || '' }, { source: 'import', silent: true });
    if (r.ok) added++; else skipped++;
  }
  if (added) {
    save();
    broadcast();
    log.audit('lottery', 'import', { added, skipped, actor });
  }
  return { ok: true, added, skipped, total: st.guests.length, errors };
}

// ─────────────────────────────────────────────────────────────
// 第三方中继（在线表单 → 云函数 → 内网轮询）
// ─────────────────────────────────────────────────────────────

export function startRelay() {
  stopRelay();
  const url = String(getConfig().lottery?.relayUrl || '').trim();
  if (!url) return;
  const tick = async () => {
    try { await relayOnce(); } catch (e) {
      const now = Date.now();
      if (now - relayLastWarn > 5 * 60_000) {
        relayLastWarn = now;
        log.warn('lottery', '第三方中继拉取失败', { err: e.message, url });
      }
    }
    const ms = Math.max(3000, Number(getConfig().lottery?.relayPollMs) || 15000);
    relayTimer = setTimeout(tick, ms);
    relayTimer.unref?.();
  };
  tick();
}

export function stopRelay() {
  if (relayTimer) clearTimeout(relayTimer);
  relayTimer = null;
}

async function relayOnce() {
  const cfg = getConfig().lottery || {};
  const url = String(cfg.relayUrl || '').trim();
  if (!url) return;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);
  let data;
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(cfg.relayToken ? { authorization: `Bearer ${cfg.relayToken}` } : {}),
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } finally { clearTimeout(t); }

  const entries = Array.isArray(data) ? data : (data.entries || data.items || data.data || []);
  if (!Array.isArray(entries) || !entries.length) return;

  let added = 0;
  for (const raw of entries) {
    const e = typeof raw === 'string' ? { name: raw } : raw || {};
    if (!e.name) continue;
    // 用外部 id 去重（如果中继端提供）
    if (e.id && st.guests.some((g) => g.externalId === String(e.id))) continue;
    const r = addGuest({
      name: e.name, handle: e.handle || e.nickname || '', team: e.team || '',
      externalId: e.id,
    }, { source: 'relay', silent: true });
    if (r.ok) added++;
  }
  if (added) {
    save();
    broadcast();
    log.info('lottery', `中继新增签到 ${added} 人`, { total: st.guests.length });
  }
}

// ─────────────────────────────────────────────────────────────
// 启动
// ─────────────────────────────────────────────────────────────

export function shutdown() {
  clearTimeout(st.timer);
  stopRelay();
}

/** 页面二维码用的签到地址（由路由传入当前 origin） */
export function joinUrlFor(origin = '') {
  const cfg = getConfig();
  return resolvePublicUrl({
    origin,
    publicUrl: cfg.lottery?.publicJoinUrl,
    baseUrl: cfg.lottery?.joinBaseUrl,
    path: '/join',
    port: cfg.server?.overlayPort || 3000,
    label: '签到',
    configHint: '公网签到地址 / 局域网签到地址',
  });
}
