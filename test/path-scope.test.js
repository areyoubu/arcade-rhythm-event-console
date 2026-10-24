/**
 * 文件访问范围 —— 媒体 / 模板 / 实体路径只能落在项目目录内。
 *
 * 背景：设置页无鉴权，`/api/config` 能改 media.dir / templates.* / entities.file。
 * 若这些路径不限制在项目目录内，就能借本进程读写/删除任意文件（甚至把实体库
 * 写成 JSON 覆盖到别处）。这里钉住 `withinRoot` 的边界行为。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { withinRoot, ROOT } from '../server/config.js';

test('★ withinRoot：项目目录内的相对 / 绝对路径放行', () => {
  assert.equal(withinRoot('./media'), path.join(ROOT, 'media'));
  assert.equal(withinRoot('media'), path.join(ROOT, 'media'));
  assert.equal(withinRoot('data/entities.json'), path.join(ROOT, 'data', 'entities.json'));
  assert.equal(withinRoot(ROOT), ROOT);
  assert.equal(withinRoot(path.join(ROOT, 'templates', 'custom')), path.join(ROOT, 'templates', 'custom'));
});

test('★★ withinRoot：越界路径一律返回 null', () => {
  for (const bad of [
    '../etc', '../../Windows', '../media', '..\\..\\Windows',
    path.join(ROOT, '..', 'etc'),
  ]) {
    assert.equal(withinRoot(bad), null, `${bad} 应越界`);
  }
  // 绝对路径指向项目之外
  assert.equal(withinRoot('C:\\Windows\\System32'), null);
  assert.equal(withinRoot('/etc/passwd'), null);
  assert.equal(withinRoot('D:\\sensitive'), null);
});

test('★ 空路径返回 null（调用方回退默认值）', () => {
  assert.equal(withinRoot(''), null);
  assert.equal(withinRoot(null), null);
  assert.equal(withinRoot(undefined), null);
});

test('★★ 路径穿越段（..）即使能折叠回根目录内也拒绝', () => {
  assert.equal(withinRoot('./media/../2/nul'), null);
  assert.equal(withinRoot('./media/../media'), null);
  assert.equal(withinRoot('a/../b'), null);
});

test('★★ Windows 保留设备名（nul / con / aux / prn / com / lpt）拒绝', () => {
  for (const bad of ['nul', 'con', 'aux', 'prn', 'com1', 'lpt1', './data/nul', 'x\\con\\y']) {
    assert.equal(withinRoot(bad), null, `${bad} 应被拒绝`);
  }
});
