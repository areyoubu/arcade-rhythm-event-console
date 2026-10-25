/**
 * 从游戏目录导入曲目信息 / 日服定数 / 曲绘，并保留国服数据。
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../server/config.js';
import * as music from '../server/music.js';
import * as gameMusic from '../server/game-music.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-game-music-'));
const GAME = path.join(TMP, 'game');
const MUSIC_FILE = path.join(TMP, 'music.json');
const COVERS = path.join(TMP, 'covers');
const OLD_GAME_AUDIO = { ...(getConfig().gameAudio || {}) };

function ddsSolidRed() {
  const b = Buffer.alloc(128 + 8);
  b.writeUInt32LE(0x20534444, 0);
  b.writeUInt32LE(124, 4);
  b.writeUInt32LE(0x00081007, 8);
  b.writeUInt32LE(4, 12);
  b.writeUInt32LE(4, 16);
  b.writeUInt32LE(8, 20);
  b.writeUInt32LE(32, 76);
  b.writeUInt32LE(4, 80);
  b.write('DXT1', 84, 'ascii');
  b.writeUInt16LE(0xf800, 128);
  b.writeUInt16LE(0x001f, 130);
  return b;
}

function musicXml({ id, title, master = 13.7, we = false, star = 3 }) {
  const levels = we
    ? `<MusicFumenData><type><id>5</id></type><enable>true</enable><level>0</level><levelDecimal>0</levelDecimal></MusicFumenData>`
    : `<MusicFumenData><type><id>0</id></type><enable>true</enable><level>4</level><levelDecimal>0</levelDecimal></MusicFumenData>
       <MusicFumenData><type><id>3</id></type><enable>true</enable><level>${Math.floor(master)}</level><levelDecimal>${Math.round((master % 1) * 100)}</levelDecimal></MusicFumenData>`;
  return `<MusicData>
    <name><id>${id}</id><str>${title}</str></name>
    <artistName><str>Game Artist</str></artistName>
    <genreNames><list><StringID><id>5</id><str>ORIGINAL</str></StringID></list></genreNames>
    <jaketFile><path>jacket.dds</path></jaketFile>
    <cueFileName><str>music${String(id).padStart(4, '0')}</str></cueFileName>
    <releaseDate>2025-04-01</releaseDate>
    <releaseTagName><str>CHUNITHM X-VERSE</str></releaseTagName>
    <exType>${we ? 2 : 0}</exType>
    <disableFlag>false</disableFlag>
    <starDifType>${we ? star : 0}</starDifType>
    <worldsEndTagName><id>${we ? 1 : -1}</id><str>${we ? '狂' : 'Invalid'}</str></worldsEndTagName>
    <fumens>${levels}</fumens>
  </MusicData>`;
}

before(async () => {
  process.env.LP_MUSIC_FILE = MUSIC_FILE;
  process.env.LP_COVERS_DIR = COVERS;
  const normalDir = path.join(GAME, 'data', 'A000', 'music', 'music0123');
  const weDir = path.join(GAME, 'data', 'A000', 'music', 'music8000');
  fs.mkdirSync(normalDir, { recursive: true });
  fs.mkdirSync(weDir, { recursive: true });
  fs.writeFileSync(path.join(normalDir, 'Music.xml'), musicXml({ id: 123, title: 'Game Song' }));
  fs.writeFileSync(path.join(normalDir, 'jacket.dds'), ddsSolidRed());
  fs.writeFileSync(path.join(weDir, 'Music.xml'), musicXml({ id: 8000, title: 'WE Song', we: true, star: 4 }));
  fs.mkdirSync(COVERS, { recursive: true });

  fs.writeFileSync(MUSIC_FILE, JSON.stringify({
    levelSource: 'jp',
    source: 'test',
    songs: [
      {
        id: 123, name: 'Old Name', artist: 'Old', genre: 'ORIGINAL', cn: true,
        cnReleaseDate: '2023-01-01', cover: '/covers/old.webp',
        levels: { jp: { master: 13.0 }, cn: { master: 13.5 } },
        difficulties: { master: 13.0 },
        we: null,
      },
      {
        id: 555, name: 'Base Song', artist: 'Old', genre: 'ORIGINAL', cn: true,
        cover: '', levels: { jp: { master: 13.0 }, cn: {} }, difficulties: { master: 13.0 },
        we: { kanji: '旧', star: 2, jpKanji: '旧', jpStar: 2, chartId: 8000, originId: 555 },
      },
    ],
  }));

  getConfig().gameAudio = { ...OLD_GAME_AUDIO, enabled: true, gameDir: GAME };
  await music.load();
});

after(() => {
  getConfig().gameAudio = OLD_GAME_AUDIO;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('★★ 游戏导入：曲名 / 日服定数 / 封面更新，国服数据保留', async () => {
  const out = await gameMusic.importGameMusic({ actor: 'test' });
  assert.equal(out.ok, true);
  assert.ok(out.summary.covers >= 1);

  const v = music.getView(123);
  assert.equal(v.name, 'Game Song');
  assert.equal(v.artist, 'Game Artist');
  assert.equal(v.levels.jp.basic, 4);
  assert.equal(v.levels.jp.master, 13.7);
  assert.equal(v.levels.cn.master, 13.5, '国服定数不能被游戏导入覆盖');
  assert.equal(v.cn, true);
  assert.equal(v.cnReleaseDate, '2023-01-01');
  assert.match(v.cover, /^\/covers\/123\.(webp|png)\?v=/);
  assert.ok(fs.existsSync(path.join(COVERS, v.cover.split('?')[0].replace('/covers/', ''))));
  assert.equal(v.difficulties.master, 13.7, '当前日服来源生效');
});

test('★★ WE：游戏星数 / 汉字更新到原曲，不新增重复曲目', async () => {
  await gameMusic.importGameMusic({ actor: 'test' });
  const base = music.getView(555);
  assert.equal(base.we.jpKanji, '狂');
  assert.equal(base.we.jpStar, 4);
  assert.equal(base.we.chartId, 8000);
  assert.equal(music.get(8000), null, 'WE 谱面不应单独成为一首曲目');
});
