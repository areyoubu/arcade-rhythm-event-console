/**
 * 网络操作日志 —— 单独写进 logs/network-YYYYMMDD.jsonl，与普通控制台日志分开。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureLogging, netlog, networkRecent, listNetworkFiles } from '../server/logger.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-netlog-'));

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('★ 网络日志写进独立文件，且内存缓冲可查', async () => {
  configureLogging({ dir: TMP, level: 'info', retain: 30 });

  const rec = netlog({
    kind: 'http', ip: '203.0.113.9', method: 'POST', path: '/api/media/upload',
    status: 400, durationMs: 12.5, ua: 'test-agent', bodyBytes: 100,
  });
  assert.equal(rec.kind, 'http');
  assert.equal(rec.ip, '203.0.113.9');

  // createWriteStream 打开文件是异步的，等一拍再查磁盘
  await new Promise((r) => setTimeout(r, 60));

  const files = listNetworkFiles();
  assert.equal(files.length, 1, `应有一个 network 日志文件：${files.join(',')}`);
  assert.match(files[0], /^network-\d{8}\.jsonl$/);

  const content = fs.readFileSync(path.join(TMP, files[0]), 'utf8');
  assert.match(content, /\/api\/media\/upload/);
  assert.match(content, /203\.0\.113\.9/);
  assert.match(content, /"kind":"http"/);

  // 内存环形缓冲（同步，可靠）
  const recent = networkRecent(10);
  assert.equal(recent[0].path, '/api/media/upload');
});

test('★ 敏感字段（token / password / authorization）被掩码', () => {
  netlog({ kind: 'http', ip: '1.2.3.4', authorization: 'Bearer secret', token: 'abc', password: 'pw' });
  const rec = networkRecent(1)[0];
  assert.equal(rec.authorization, '••••');
  assert.equal(rec.token, '••••');
  assert.equal(rec.password, '••••');
});

test('★ 风险日志过滤：鉴权失败 / 外网拦截 / HTTP 4xx，普通 200 不混入', async () => {
  const { networkRiskRecent } = await import('../server/logger.js');
  netlog({ kind: 'http', ip: '203.0.113.1', method: 'GET', path: '/api/ok', status: 200 });
  netlog({ kind: 'http', ip: '203.0.113.2', method: 'POST', path: '/api/config', status: 401 });
  netlog({ kind: 'auth-lock', ip: '203.0.113.3', strikes: 1 });
  netlog({ kind: 'external-blocked', ip: '203.0.113.4', path: '/render/score' });

  const risks = networkRiskRecent(50);
  assert.ok(risks.some((r) => r.ip === '203.0.113.2'), 'HTTP 401 应进风险列表');
  assert.ok(risks.some((r) => r.kind === 'auth-lock'));
  assert.ok(risks.some((r) => r.kind === 'external-blocked'));
  assert.ok(!risks.some((r) => r.path === '/api/ok'), '普通 200 不应进风险列表');
});
