#!/usr/bin/env node
/**
 * 设置 / 重置后台登录密码。
 *
 * 密码**只存 scrypt 散列**（scrypt:salt:hash），明文不落盘。
 * 用法：
 *   node tools/set-admin-password.mjs              # 交互输入（不回显）
 *   node tools/set-admin-password.mjs --pw 密码    # 直接给定（会留在 shell 历史里，慎用）
 *   node tools/set-admin-password.mjs --clear      # 清空（关闭鉴权）
 *
 * 改完后重启主控生效。也可不落盘、只用环境变量：
 *   LP_ADMIN_TOKEN=<明文令牌> node server/index.js   # 明文令牌优先于密码散列
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../server/admin-auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = process.env.LP_CONFIG
  ? path.resolve(process.env.LP_CONFIG)
  : path.join(ROOT, 'config', 'config.json');

function writeConfig(hash) {
  if (!fs.existsSync(CONFIG)) throw new Error(`找不到配置文件：${CONFIG}`);
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  cfg.server = cfg.server || {};
  if (hash) cfg.server.adminPasswordHash = hash;
  else delete cfg.server.adminPasswordHash;
  delete cfg.server.adminToken; // 旧字段已废弃
  fs.writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  return cfg;
}

function promptPassword() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise((res) => rl.question(q, res));
    (async () => {
      try {
        const p1 = await ask('后台登录密码（输入不回显）：');
        const p2 = await ask('再输一次确认：');
        if (p1 !== p2) { console.error('两次输入不一致，已取消。'); resolve(null); }
        else if (!p1) { console.error('密码不能为空。'); resolve(null); }
        else resolve(p1);
      } finally { rl.close(); }
    })();
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--clear')) {
    writeConfig('');
    console.log('已清空后台密码（关闭鉴权）。重启主控生效。');
    return;
  }
  const pwIdx = args.indexOf('--pw');
  const pw = pwIdx >= 0 ? args[pwIdx + 1] : null;
  if (pwIdx >= 0 && !pw) { console.error('--pw 后面需要跟密码'); process.exit(1); }

  const password = pw !== null ? pw : await promptPassword();
  if (!password) process.exit(1);

  const hash = hashPassword(password);
  writeConfig(hash);
  console.log(`已写入 ${path.relative(ROOT, CONFIG)}`);
  console.log('密码已用 scrypt 散列保存（明文不落盘）。重启主控后生效。');
}

main().catch((e) => { console.error(`失败：${e.message}`); process.exit(1); });
