/**
 * 安全边界 —— 服务进程不得执行任何与节目无关的 OS 命令。
 *
 * 背景：早期「打开目录」功能用 `child_process.exec('explorer "..."')`，
 * 一旦 :3000 被暴露（设置页无鉴权），配合 `/api/config` 改 `media.dir` 即可
 * 拼出 `explorer "x" & calc & "..."` 这类命令注入，等于远程任意命令执行。
 *
 * 这里钉住两条不变量：
 *   1. server/ 里不允许再出现 child_process（服务进程零命令执行）；
 *   2. 路径类配置字段拒绝 shell 元字符 / 控制字符。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig, DEFAULT_CONFIG } from '../server/config-schema.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('★★ 服务进程零 OS 命令执行：server/ 不得引入 child_process', () => {
  const offenders = [];
  for (const f of walk(path.join(ROOT, 'server'))) {
    const src = fs.readFileSync(f, 'utf8');
    if (/child_process/.test(src)) offenders.push(f);
  }
  assert.deepEqual(offenders, [],
    'server/ 里还有 child_process —— 任何「打开目录 / 运行命令」都是远程提权面');
});

test('★ 路径类配置字段拒绝 shell 元字符与控制字符', () => {
  const base = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  for (const [p, bad] of [
    ['media.dir', 'C:\\x" & calc & "'],
    ['media.dir', 'C:\\x&del C:\\y'],
    ['templates.customDir', './tpl; shutdown'],
    ['entities.file', 'a`b`c'],
    ['media.dir', 'C:\\x\u0000\u0007y'],
  ]) {
    const cfg = JSON.parse(JSON.stringify(base));
    const seg = p.split('.');
    seg.reduce((o, k, i) => { if (i === seg.length - 1) o[k] = bad; else o[k] = o[k] || {}; return o[k]; }, cfg);
    const errs = validateConfig(cfg);
    assert.ok(errs[p], `${p} 注入值「${JSON.stringify(bad)}」未被拒绝`);
  }

  // 正常路径（含空格、盘符、相对路径）不能被误伤
  for (const good of ['./media', 'D:\\Program Files\\media', '../media', 'C:\\Users\\ybr\\media']) {
    const cfg = JSON.parse(JSON.stringify(base));
    cfg.media = { ...cfg.media, dir: good };
    const errs = validateConfig(cfg);
    assert.ok(!errs['media.dir'], `合法路径「${good}」被误判：${errs['media.dir']}`);
  }
});

test('★ 「打开目录」接口已移除（不再有 /paths/open）', () => {
  const sys = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'sys.js'), 'utf8');
  assert.ok(!/paths\/open/.test(sys), 'sys.js 仍注册 /paths/open');
  assert.ok(!/child_process/.test(sys), 'sys.js 仍引入 child_process');
});
