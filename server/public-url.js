/**
 * 公共入口地址解析 + 二维码生成（抽奖签到 / 扫码选曲共用）。
 *
 * 地址优先级（与页面上写的说明一致）：
 *   1. 配置里的公网地址（隧道 / 反代）
 *   2. 配置里的局域网地址
 *   3. 操作员当前访问地址（非 localhost）
 *   4. 自动探测的局域网 IPv4
 *   5. 相对路径（手机肯定打不开，但至少页面不会崩）
 *
 * 之前 lottery / match 两套 route 各抄了一份，行为开始出现细微差别；
 * 这里收成唯一实现，二维码参数也统一。
 */
import os from 'node:os';
import QRCode from 'qrcode';

export function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '';
}

/** 把 path 拼到 base 上；base 已经以该 path 结尾时不重复拼 */
export function withPath(base, path = '/') {
  const s = String(base || '').trim().replace(/\/+$/, '');
  if (!s) return path;
  const p = `/${String(path || '/').replace(/^\/+/, '')}`;
  return s.endsWith(p) ? s : `${s}${p}`;
}

function isLoopback(origin) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(String(origin || ''));
}

/**
 * @param {object} opts
 * @param {string} [opts.origin]      操作员当前访问地址（req origin）
 * @param {string} [opts.publicUrl]   配置的公网地址
 * @param {string} [opts.baseUrl]     配置的局域网地址
 * @param {string} [opts.path]        公共页路径（/join、/pick）
 * @param {number} [opts.port]        自动探测 LAN 时使用的端口
 * @param {string} [opts.label]       提示文案里的入口名称（签到 / 选曲）
 * @param {string} [opts.configHint]  提示文案里的设置项名称
 * @returns {{url:string, source:string, warning?:string}}
 */
export function resolvePublicUrl({
  origin = '',
  publicUrl = '',
  baseUrl = '',
  path = '/',
  port = 3000,
  label = '公共页',
  configHint = '公网 / 局域网地址',
} = {}) {
  const pub = String(publicUrl || '').trim();
  if (pub) return { url: withPath(pub, path), source: 'public' };

  const base = String(baseUrl || '').trim();
  if (base) return { url: withPath(base, path), source: 'config' };

  const o = String(origin || '').trim();
  if (o && !isLoopback(o)) return { url: withPath(o, path), source: 'origin' };

  const ip = lanIp();
  if (ip) {
    return {
      url: `http://${ip}:${port}${path}`,
      source: 'lan',
      warning: '当前页面是用本机地址打开的；二维码已自动改用局域网 IP。手机需连同一个 Wi-Fi。',
    };
  }

  return {
    url: o ? withPath(o, path) : path,
    source: 'loopback',
    warning: `手机无法访问 localhost，请用局域网 IP 打开控制台，或在设置里填写「${configHint}」以生成${label}二维码。`,
  };
}

/** 统一二维码参数：白底、深色码、M 级纠错 */
export async function qrPng(url, size = 512) {
  const px = Math.min(1024, Math.max(128, Number(size) || 512));
  return QRCode.toBuffer(url, {
    type: 'png',
    width: px,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#101114', light: '#ffffff' },
  });
}
