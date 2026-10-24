#!/usr/bin/env node
/**
 * 启动主控，并把 remote/agent.config.json 里的 remoteToken
 * 作为 LP_REMOTE_TOKEN 注入主控进程。
 *
 * 这样密钥只保存在一个地方（Agent 配置台），不会出现
 * 「改了配置台、start-main.bat 里还是旧 token」的问题。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REMOTE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(REMOTE_DIR, '..');
const configFile = process.env.AGENT_CONFIG
  ? path.resolve(process.cwd(), process.env.AGENT_CONFIG)
  : path.join(REMOTE_DIR, 'agent.config.json');

let remoteToken = '';
try {
  const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  remoteToken = String(cfg.remoteToken || '').trim();
} catch (e) {
  console.warn(`[main] 读取 ${configFile} 失败：${e.message}`);
}

if (!remoteToken) {
  console.warn('[main] remoteToken 为空：公网访客会被当成 127.0.0.1，限流会误伤。');
  console.warn('[main] 请在「内网端配置台」的「真实客户端 IP 密钥」里填写，并保存后重启。');
}

const env = { ...process.env, LP_REMOTE_TOKEN: remoteToken };
const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  cwd: ROOT,
  env,
  stdio: 'inherit',
  windowsHide: false,
});

child.on('error', (e) => {
  console.error(`[main] 启动失败：${e.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  process.exit(typeof code === 'number' ? code : (signal ? 1 : 0));
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { child.kill(sig); } catch { /* ignore */ }
  });
}
