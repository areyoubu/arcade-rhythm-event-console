/**
 * 曲目库双定数：日服（游戏）/ 国服（API）分别存储，切换只改生效值。
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as music from '../server/music.js';

const TMP = path.join(os.tmpdir(), `lp-music-levels-${process.pid}.json`);
process.env.LP_MUSIC_FILE = TMP;

function writeRaw(raw) {
  fs.writeFileSync(TMP, JSON.stringify(raw));
  return music.load();
}

before(() => {});
after(() => {
  try { fs.unlinkSync(TMP); } catch { /* ignore */ }
  try { fs.unlinkSync(`${TMP}.bak`); } catch { /* ignore */ }
});

beforeEach(() => {
  writeRaw({
    levelSource: 'jp',
    source: 'test',
    songs: [
      {
        id: 1, name: 'Dual', artist: 'A', genre: 'ORIGINAL', cn: true,
        cover: '', difficulties: { basic: 4, master: 13.7 },
      },
      {
        id: 2, name: 'CN ready', artist: 'B', genre: 'ORIGINAL', cn: true,
        cover: '',
        levels: { jp: { master: 14.0 }, cn: { master: 13.9 } },
        difficulties: { master: 14.0 },
      },
    ],
  });
});

test('★★ 旧数据加载：difficulties 自动成为日服定数', () => {
  const v = music.getView(1);
  assert.equal(v.levelSource, 'jp');
  assert.equal(v.levels.jp.master, 13.7);
  assert.deepEqual(v.levels.cn, {});
});

test('★★ 切换国服定数：有国服用国服，没有则回退日服', () => {
  const r = music.setLevelSource('cn', 'test');
  assert.equal(r.ok, true);
  assert.equal(music.meta().levelSource, 'cn');
  assert.equal(music.get(1).difficulties.master, 13.7, '没有国服数据时回退日服');
  assert.equal(music.get(2).difficulties.master, 13.9, '有国服数据时使用国服');
  const v = music.getView(2);
  assert.equal(v.levels.jp.master, 14.0, '切换不丢日服数据');
  assert.equal(v.levels.cn.master, 13.9);

  music.setLevelSource('jp', 'test');
  assert.equal(music.get(2).difficulties.master, 14.0);
});

test('★ 编辑曲目只改当前来源的定数', () => {
  music.setLevelSource('cn', 'test');
  const r = music.updateSong(2, { difficulties: { master: 14.2 } }, 'test');
  assert.equal(r.ok, true);
  const v = music.getView(2);
  assert.equal(v.levels.cn.master, 14.2);
  assert.equal(v.levels.jp.master, 14.0, '日服定数保持不变');
  assert.equal(v.difficulties.master, 14.2, '当前来源生效');
});

test('★ 文件里持久化 levelSource / levels 两套数据', () => {
  music.setLevelSource('cn', 'test');
  const raw = JSON.parse(fs.readFileSync(TMP, 'utf8'));
  assert.equal(raw.levelSource, 'cn');
  const s = raw.songs.find((x) => x.id === 2);
  assert.equal(s.levels.jp.master, 14.0);
  assert.equal(s.levels.cn.master, 13.9);
});
