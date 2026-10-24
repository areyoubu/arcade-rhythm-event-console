/**
 * 模块 E —— 抽奖 / 现场签到。
 *
 * 守住：池子按类型/标签过滤、签到去重、抽奖动画期间不剧透、
 * 中奖后移出池子、CSV 导入、二维码地址解析。
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as lottery from '../server/lottery.js';
import * as entities from '../server/entities.js';
import * as templates from '../server/templates.js';
import { getConfig } from '../server/config.js';

const REAL_ENTITIES = getConfig().entities.file;
const TMP_ENTITIES = path.join('data', '_test-lottery-entities.json');
const TMP_LOTTERY = path.join(os.tmpdir(), `lp-lottery-test-${process.pid}.json`);
process.env.LP_LOTTERY_FILE = TMP_LOTTERY;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(() => {
  getConfig().entities.file = TMP_ENTITIES;
  try { fs.writeFileSync(TMP_ENTITIES, '[]\n'); } catch { /* ignore */ }
  entities.load();
  templates.load();
  getConfig().lottery = { ...(getConfig().lottery || {}), spinMs: 500 };
  lottery.load();

  const team = entities.create({ kind: 'team', name: '抽奖队' }).entity;
  entities.create({ kind: 'player', name: '抽奖甲', teamId: team.id, tags: ['vip'] });
  entities.create({ kind: 'player', name: '抽奖乙', teamId: team.id });
  entities.create({ kind: 'talent', name: '抽奖解说', role: '解说' });
  entities.create({ kind: 'sponsor', name: '抽奖赞助商' });
});

after(() => {
  lottery.shutdown();
  try { fs.unlinkSync(TMP_ENTITIES); } catch { /* ignore */ }
  try { fs.unlinkSync(`${TMP_ENTITIES}.bak`); } catch { /* ignore */ }
  try { fs.unlinkSync(TMP_LOTTERY); } catch { /* ignore */ }
  getConfig().entities.file = REAL_ENTITIES;
  entities.load();
  templates.load();
});

beforeEach(() => {
  lottery.reset('all', 'test');
  lottery.clearGuests('test');
  lottery.setSettings({ kinds: ['player', 'talent'], tags: [], includeGuests: true, removeWinners: true }, 'test');
});

test('★ 奖品设置：名称 / 图片 / 备注持久化，危险图片协议被丢弃', () => {
  const r = lottery.setSettings({
    prize: {
      name: '机械键盘', image: '/media/abc.png', note: '87 键 · 白色',
      meta: { ip: '203.0.113.7', at: 1790000000000, hash: 'abc123' },
    },
  }, 'test');
  assert.equal(r.state.settings.prize.name, '机械键盘');
  assert.equal(r.state.settings.prize.image, '/media/abc.png');
  assert.equal(lottery.snapshot().settings.prize.note, '87 键 · 白色');
  assert.equal(lottery.snapshot().settings.prize.meta.ip, '203.0.113.7', '必须记录上传 IP');
  assert.equal(lottery.snapshot().settings.prize.meta.at, 1790000000000, '必须记录上传时间');
  assert.equal(lottery.referencingImage('/media/abc.png').length, 1, '媒体删除检查必须能看到奖品图片');
  assert.equal(lottery.referencingImage('/media/other.png').length, 0);

  const bad = lottery.setSettings({
    prize: { name: 'X', image: 'javascript:alert(1)', note: '' },
  }, 'test');
  assert.equal(bad.state.settings.prize.image, '', '非 http(s) / 站内 / data:image 的地址必须丢弃');

  const badMeta = lottery.setSettings({
    prize: { name: 'Y', image: '/media/abc.png', note: '', meta: { ip: { x: 1 }, at: 'nope', hash: [] } },
  }, 'test');
  assert.deepEqual(badMeta.state.settings.prize.meta, { ip: '', at: 0, hash: '' });

  lottery.setSettings({ prize: { name: '', image: '', note: '' } }, 'test');
});

test('★ 抽奖池按类型过滤（默认选手 + 解说，不含赞助商）', () => {
  const pool = lottery.buildPool();
  const names = pool.map((c) => c.name);
  assert.ok(names.includes('抽奖甲'));
  assert.ok(names.includes('抽奖乙'));
  assert.ok(names.includes('抽奖解说'));
  assert.ok(!names.includes('抽奖赞助商'), '没勾选赞助商时不应进入池子');
});

test('★ 标签过滤只留下带该标签的人', () => {
  lottery.setSettings({ kinds: ['player'], tags: ['vip'] }, 'test');
  const names = lottery.buildPool().map((c) => c.name);
  assert.deepEqual(names, ['抽奖甲']);
});

test('★ 扫码签到进入池子；同名重复提交被拒绝', () => {
  const a = lottery.addGuest({ name: '现场小王' });
  assert.equal(a.ok, true);
  assert.equal(a.ticket, 1);

  const dup = lottery.addGuest({ name: '现场小王' });
  assert.equal(dup.ok, false);
  assert.equal(dup.nack.code, 'duplicate');

  const pool = lottery.buildPool();
  assert.ok(pool.some((c) => c.name === '现场小王'));
});

test('★ 不勾选「包含现场签到」时，签到的人不进池子', () => {
  lottery.addGuest({ name: '现场小李' });
  lottery.setSettings({ includeGuests: false }, 'test');
  assert.ok(!lottery.buildPool().some((c) => c.name === '现场小李'));
});

test('★★ 签到管理：ticket 稳定、编辑 / 重复拒绝 / 删除', () => {
  const a = lottery.addGuest({ name: '甲', handle: 'a', team: '红队' });
  const b = lottery.addGuest({ name: '乙', handle: 'b', team: '蓝队' });
  assert.equal(a.ticket, 1);
  assert.equal(b.ticket, 2);

  const up = lottery.updateGuest(a.guest.id, { name: '甲改', handle: 'a2', team: '绿队' }, 'test');
  assert.equal(up.ok, true);
  const g = up.state.guests.find((x) => x.id === a.guest.id);
  assert.equal(g.name, '甲改');
  assert.equal(g.team, '绿队');
  assert.equal(g.ticket, 1, '编辑不应改变签到序号');

  const dup = lottery.updateGuest(b.guest.id, { name: '甲改', handle: 'a2' }, 'test');
  assert.equal(dup.ok, false);
  assert.equal(dup.nack.code, 'duplicate');

  const del = lottery.removeGuest(a.guest.id, 'test');
  assert.equal(del.ok, true);
  assert.equal(del.state.guests.length, 1);

  const c = lottery.addGuest({ name: '丙' });
  assert.equal(c.ticket, 3, '删除后不重复使用旧序号');
});

test('★ 已中奖的签到改名：中奖记录与池子排除项一起更新', async () => {
  lottery.setSettings({ kinds: [], tags: [], includeGuests: true, removeWinners: false }, 'test');
  lottery.addGuest({ name: '中奖甲' });
  const r = lottery.draw('test');
  assert.equal(r.ok, true);
  await sleep(700);
  const w = lottery.snapshot().winner;
  assert.ok(w);
  const up = lottery.updateGuest(w.id, { name: '中奖甲改' }, 'test');
  assert.equal(up.ok, true);
  assert.equal(up.state.winners.find((x) => x.id === w.id)?.name, '中奖甲改');
});

test('★★ 抽奖：动画期间不剧透，到点才揭晓；中奖后移出池子', async () => {
  lottery.setSettings({ kinds: ['player', 'talent'], includeGuests: false, removeWinners: true }, 'test');
  const before = lottery.buildPool().length;

  const r = lottery.draw('test');
  assert.equal(r.ok, true);
  assert.equal(r.state.phase, 'spinning');
  assert.equal(r.state.winner, null, '动画期间不能把结果下发');
  assert.ok(r.state.spin?.sample?.length > 0);

  await sleep(700);
  const s = lottery.snapshot();
  assert.equal(s.phase, 'revealed');
  assert.ok(s.winner?.name, '揭晓后应有中奖者');
  assert.equal(s.winners.length, 1);
  assert.equal(s.poolSize, before - 1, '中奖后应从池子移出');
  assert.equal(s.pool.some((c) => c.key === s.winner.key), false);
});

test('★ 允许重复中奖时池子不缩小', async () => {
  lottery.setSettings({ removeWinners: false, includeGuests: false }, 'test');
  const size = lottery.buildPool().length;
  lottery.draw('test');
  await sleep(700);
  assert.equal(lottery.snapshot().poolSize, size);
});

test('★ 清空中奖记录会重置 winners 与历史', async () => {
  lottery.setSettings({ includeGuests: false }, 'test');
  lottery.draw('test');
  await sleep(700);
  assert.equal(lottery.snapshot().winners.length, 1);
  lottery.reset('all', 'test');
  const s = lottery.snapshot();
  assert.equal(s.winners.length, 0);
  assert.equal(s.history.length, 0);
});

test('★ CSV 导入：首行表头跳过，重复项跳过', () => {
  lottery.clearGuests('test');
  lottery.addGuest({ name: '重复者' });
  const r = lottery.importText('姓名,队伍,昵称\n张三,红队,小张\n李四,蓝队,\n重复者,,\n', 'test');
  assert.equal(r.ok, true);
  assert.equal(r.added, 2);
  assert.equal(r.skipped, 1);
  assert.equal(lottery.snapshot().guests.length, 3);
});

test('★ 签到地址解析：公网 > 局域网 > 当前 origin', () => {
  const cfg = getConfig();
  const old = { ...(cfg.lottery || {}) };
  try {
    cfg.lottery = { ...old, publicJoinUrl: '', joinBaseUrl: '' };
    assert.equal(lottery.joinUrlFor('http://192.168.1.50:3000').url, 'http://192.168.1.50:3000/join');
    cfg.lottery.joinBaseUrl = 'http://192.168.1.60:3000/';
    assert.equal(lottery.joinUrlFor('http://192.168.1.50:3000').url, 'http://192.168.1.60:3000/join');
    cfg.lottery.publicJoinUrl = 'https://demo.trycloudflare.com';
    assert.equal(lottery.joinUrlFor('http://192.168.1.50:3000').url, 'https://demo.trycloudflare.com/join');
  } finally {
    cfg.lottery = old;
  }
});
