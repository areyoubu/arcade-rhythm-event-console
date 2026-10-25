/**
 * 国服 API 同步：只生成待确认补丁，确认后才写库。
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../server/config.js';
import * as music from '../server/music.js';
import * as cn from '../server/cn-music.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-cn-music-'));
const MUSIC_FILE = path.join(TMP, 'music.json');
const OLD_CN_CFG = { ...(getConfig().cnMusic || {}) };
const REAL_FETCH = globalThis.fetch;

const API = {
  songs: [
    {
      id: 1, title: 'Available', version: 24000, release_date: '2020-01-01',
      difficulties: [
        { difficulty: 0, level: '4', level_value: 4.0, release_date: '2020-01-01' },
        { difficulty: 3, level: '13+', level_value: 13.9, release_date: '2020-01-01' },
      ],
    },
    {
      id: 2, title: 'Future', version: 24500, release_date: '2999-01-01',
      difficulties: [{ difficulty: 3, level: '14', level_value: 14.0, release_date: '2999-01-01' }],
    },
    {
      id: 3, title: 'Unknown date', version: 24000, release_date: null,
      difficulties: [{ difficulty: 3, level: '13', level_value: 13.0 }],
    },
    { id: 99, title: 'API only', release_date: '2020-01-01', difficulties: [] },
  ],
};

function writeLibrary() {
  fs.writeFileSync(MUSIC_FILE, JSON.stringify({
    levelSource: 'jp',
    source: 'test',
    songs: [
      {
        id: 1, name: 'Available', artist: '', genre: 'ORIGINAL', cn: false,
        cover: '', levels: { jp: { master: 13.7 }, cn: {} }, difficulties: { master: 13.7 },
      },
      {
        id: 2, name: 'Future', artist: '', genre: 'ORIGINAL', cn: true,
        cover: '', levels: { jp: { master: 14.0 }, cn: { master: 14.0 } }, difficulties: { master: 14.0 },
      },
      {
        id: 3, name: 'Unknown date', artist: '', genre: 'ORIGINAL', cn: true,
        cover: '', levels: { jp: { master: 13.0 }, cn: { master: 13.0 } }, difficulties: { master: 13.0 },
      },
    ],
  }));
}

before(async () => {
  process.env.LP_MUSIC_FILE = MUSIC_FILE;
  getConfig().cnMusic = { ...OLD_CN_CFG, autoSync: false, version: 24000, apiBase: 'https://maimai.lxns.net' };
  await music.load();
});

after(() => {
  getConfig().cnMusic = OLD_CN_CFG;
  globalThis.fetch = REAL_FETCH;
  cn.discardPending('test');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(async () => {
  globalThis.fetch = REAL_FETCH;
  cn.discardPending('test');
  writeLibrary();
  await music.load();
});

test('★★ 差异计算：国服新增/移除、定数变化、未知日期不误删、API-only 统计', () => {
  const today = '2026-10-26';
  const patch = cn.buildPatch(API.songs, { today, version: 24000, localSongs: music.getRawSongs() });
  const byId = new Map(patch.entries.map((e) => [e.id, e]));
  assert.equal(byId.get(1).cn.to, true);
  assert.equal(byId.get(1).levels.master.to, 13.9);
  assert.equal(byId.get(2).cn.to, false, '未来配信应标记不可用');
  assert.equal(byId.has(3), false, 'release_date 未知时保留本地国服标记，不产生变化');
  assert.equal(patch.summary.apiOnly, 1);
  assert.equal(patch.summary.cnAdded, 1);
  assert.equal(patch.summary.cnRemoved, 1);
  assert.equal(patch.summary.levelChanged, 2, '歌曲 1 定数变化 + 歌曲 2 未来配信清空国服定数');
});

test('★★ 同步只生成待确认；确认后才写入国服定数', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify(API), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  const r = await cn.syncNow({ actor: 'test', source: 'manual' });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.ok(cn.pendingView()?.id);
  assert.deepEqual(music.getView(1).levels.cn, {}, '确认前不能改库');

  const out = cn.confirmPending('test');
  assert.equal(out.ok, true);
  const v = music.getView(1);
  assert.equal(v.cn, true);
  assert.equal(v.levels.cn.master, 13.9);
  assert.equal(v.levels.jp.master, 13.7, '日服定数不受影响');
  assert.equal(cn.pendingView(), null);
});

test('★ 放弃待确认补丁不修改曲目库', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify(API), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  await cn.syncNow({ actor: 'test' });
  assert.ok(cn.pendingView()?.id);
  const out = cn.discardPending('test');
  assert.equal(out.ok, true);
  assert.deepEqual(music.getView(1).levels.cn, {});
  assert.equal(cn.pendingView(), null);
});
