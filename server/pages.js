/**
 * 页面路由清单 —— 服务端唯一的「哪些 URL 对应哪个 HTML」登记处。
 *
 * 控制页 / OBS 渲染源 / 手机公共页都在这里；新增页面时只要：
 *   1. 放好 public 下的 HTML；
 *   2. 在这里加一行；
 *   3. 在 public/shared/ui.js 的 CATALOG 里登记导航 / 输出元数据。
 *
 * 前端目录（CATALOG）负责「展示与分组」，这里负责「服务端能否打开」；
 * 两边分开是因为前端是纯静态脚本，服务端不能直接 import 浏览器的 IIFE。
 */
export const PAGES = [
  // ── 控制台 ──
  { path: '/overlay', file: 'overlay.html' },
  { path: '/players', file: 'players.html' },       // 兼容旧入口（meta refresh → /people）
  { path: '/talent', file: 'talent.html' },         // 兼容旧入口
  { path: '/people', file: 'people.html' },
  { path: '/credits', file: 'credits.html' },
  { path: '/media', file: 'media.html' },
  { path: '/templates', file: 'templates.html' },
  { path: '/replay', file: 'replay.html' },
  { path: '/transitions', file: 'transitions.html' },
  { path: '/director', file: 'director.html' },
  { path: '/commentary', file: 'commentary.html' },
  { path: '/cast', file: 'cast.html' },
  { path: '/cues', file: 'cues.html' },
  { path: '/logs', file: 'logs.html' },
  { path: '/settings', file: 'settings.html' },
  { path: '/scoreboard', file: 'scoreboard.html' },
  { path: '/match', file: 'match.html' },
  { path: '/random', file: 'random.html' },
  { path: '/pickshow', file: 'pickshow.html' },
  { path: '/standby', file: 'standby.html' },
  { path: '/music', file: 'music.html' },
  { path: '/outputs', file: 'outputs.html' },
  { path: '/lottery', file: 'lottery.html' },
  { path: '/guests', file: 'guests.html' },
  // ── 手机公共页 ──
  { path: '/pick', file: 'pick.html' },
  { path: '/join', file: 'join.html' },
  // ── OBS 浏览器源 ──
  { path: '/render/main', file: 'render/main.html' },
  { path: '/render/credits', file: 'render/credits.html' },
  { path: '/render/castcam', file: 'render/castcam.html' },
  { path: '/render/score', file: 'render/score.html' },
  { path: '/render/match', file: 'render/match.html' },
  { path: '/render/pick', file: 'render/pick.html' },
  { path: '/render/random', file: 'render/random.html' },
  { path: '/render/pickshow', file: 'render/pickshow.html' },
  { path: '/render/lottery', file: 'render/lottery.html' },
  { path: '/render/prize', file: 'render/prize.html' },
  { path: '/render/standby', file: 'render/standby.html' },
];
