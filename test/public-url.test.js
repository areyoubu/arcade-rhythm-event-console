/**
 * 公共入口地址解析 —— 抽奖签到 / 扫码选曲共用。
 * 守住优先级：公网 > 局域网配置 > 当前访问地址；路径不重复拼接。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePublicUrl, withPath } from '../server/public-url.js';

test('★ withPath 不重复拼 /join /pick', () => {
  assert.equal(withPath('http://192.168.1.10:3000', '/join'), 'http://192.168.1.10:3000/join');
  assert.equal(withPath('http://192.168.1.10:3000/', '/join'), 'http://192.168.1.10:3000/join');
  assert.equal(withPath('http://192.168.1.10:3000/join', '/join'), 'http://192.168.1.10:3000/join');
  assert.equal(withPath('https://demo.trycloudflare.com', '/pick'), 'https://demo.trycloudflare.com/pick');
});

test('★★ 地址优先级：公网 > 局域网配置 > 当前 origin', () => {
  const base = { origin: 'http://192.168.1.50:3000', path: '/pick' };
  assert.equal(resolvePublicUrl({ ...base }).url, 'http://192.168.1.50:3000/pick');
  assert.equal(resolvePublicUrl({ ...base, baseUrl: 'http://192.168.1.60:3000' }).url, 'http://192.168.1.60:3000/pick');
  assert.equal(resolvePublicUrl({
    ...base,
    baseUrl: 'http://192.168.1.60:3000',
    publicUrl: 'https://demo.trycloudflare.com',
  }).url, 'https://demo.trycloudflare.com/pick');
  assert.equal(resolvePublicUrl({
    ...base,
    publicUrl: 'https://demo.trycloudflare.com',
  }).source, 'public');
});

test('★ 路径可以同时用于签到与选曲（每个入口只改 path）', () => {
  const common = { publicUrl: 'https://demo.trycloudflare.com' };
  assert.equal(resolvePublicUrl({ ...common, path: '/join' }).url, 'https://demo.trycloudflare.com/join');
  assert.equal(resolvePublicUrl({ ...common, path: '/pick' }).url, 'https://demo.trycloudflare.com/pick');
});
