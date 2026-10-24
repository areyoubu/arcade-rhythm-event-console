/**
 * 配置的「唯一真源」——默认值 + 字段 schema。
 *
 * 设计要点：
 *  1. DEFAULT_CONFIG 是唯一真源，config/config.json 只是它的物化视图（首次启动生成）。
 *  2. FIELD_SCHEMA 同时承担三件事：
 *       a) 服务端校验（返回**字段路径级**错误，见 SRS A-REQ-215 / B-REQ-305）
 *       b) 驱动 /settings 页面**通用表单渲染**（不需要为每个字段手写 HTML）
 *       c) 标注 restart 字段 —— 修改后需要重连 OBS / vMix / 重启轮询
 *  3. 字段一旦在此登记，设置页自动出现；新增配置项无需改动前端。
 *
 * 对应需求：G-REQ-101（地址完全配置化）、G-REQ-102（单双机只改配置）、
 *           SRS §4.10 / §5.15 / §6.12。
 */

/** @typedef {'string'|'password'|'number'|'port'|'ms'|'boolean'|'select'|'textarea'|'json'|'url'|'color'|'list'} FieldType */

// ─────────────────────────────────────────────────────────────
// 默认配置（照抄 SRS §4.10 / §5.15 / §6.12，并补充 server 节；监看链路已改为 OBS 输出，无 monitor 节）
// ─────────────────────────────────────────────────────────────
export const DEFAULT_CONFIG = {
  version: 3,

  server: {
    host: '0.0.0.0',
    overlayPort: 3000,   // SRS §2.1：:3000 (overlay)
    controlPort: 3001,   // SRS §2.1：:3001 (control)
    identity: '',        // 本机标识，写入日志便于双机排查
    adminPasswordHash: '', // 后台登录密码的 scrypt 散列（scrypt:salt:hash），明文永不落盘
    allowPublicOutputs: false, // 是否允许外网访问 OBS 输出（默认禁止，仅内网可访问）
  },

  /**
   * 功能开关 —— **默认全部关闭**。
   *
   * 关闭时不仅隐藏页面入口，服务端也**不会去连接对应设备**：
   * 没有 vMix / OBS 的部署不会每几秒刷一条连接失败日志，也不会误发任何指令。
   * 在设置页勾选后立即生效（无需重启）：打开连接 / 启动轮询，取消则断开并停止轮询。
   *
   *   replay       回放控制器（/replay）与回放轮询 —— 依赖 vmix
   *   vmix         vMix HTTP API 连接、心跳与全部调用
   *   obs          OBS WebSocket 连接与全部请求
   *   transitions  OBS 转场控制（/transitions）与场景覆盖重读 —— 依赖 obs
   */
  features: {
    replay: false,
    vmix: false,
    obs: false,
    transitions: false,
  },

  obs: { host: '127.0.0.1', port: 4455, password: '' },
  vmix: { host: '127.0.0.1', port: 8088 },

  scenes: { live: 'LIVE', replay: 'REPLAY', clean: 'CLEAN' },

  sources: {
    replayNdi: 'vMix 回放',
    gameAudio: '游戏采集',
  },

  /**
   * 比赛模式。
   *
   *   team —— 团队赛：叠加时显示「队伍 + 选手名」（含队伍 Logo）
   *   solo —— 单人赛：只显示选手名，队伍相关槽位留空并被模板 CSS 隐藏
   *
   * 两种模式共用同一套模板，切换开关即可，不需要换模板。
   */
  competition: {
    mode: 'team',
  },

  /**
   * 比赛计分 / 选曲。
   *
   *   pickBaseUrl       手机扫码选曲页的局域网地址（留空 = 用操作员当前访问地址 / 自动探测局域网 IP）
   *   publicPickBaseUrl 公网地址（隧道），填了优先用它
   *   defaultDifficulty 随机选曲时优先使用的难度
   */
  match: {
    pickBaseUrl: '',
    publicPickBaseUrl: '',
    defaultDifficulty: 'master',
  },

  clip: {
    defaultLookbackMs: 12000,
    minLookbackMs: 1000,
    maxLookbackMs: 45000,            // ⚠️ 须 ≤ 回放会话缓冲容量（R10）
    stepMs: 500,
    presets: [5000, 8000, 12000, 20000, 30000, 45000],
    defaultOutPointMode: 'follow-now', // follow-now | manual | fixed-length
    fixedLengthMs: 8000,
    fineTuneFrames: 10,
    frameRate: 60,
    warnThreshold: 0.8,
    markVariant: 'ReplayMarkInOut',  // ⚠️ 依 R8 结果调整
  },

  replay: {
    channel: 'A',
    eventList: 1,
    speed: 1.0,
    holdFirstFrame: true,

    markDelayMs: 200,
    transitionTimeoutMs: 2500,
    pollIntervalMs: 150,
    stableSamples: 3,

    slowMotionMute: false,
    slowMotionThreshold: 0.95,

    reportProgress: true,
    progressIntervalMs: 500,
    endingThresholdMs: 3000,
    preflightCacheMs: 3000,

    hwHeartbeatMs: 2000,
    vmixTimeoutMs: 4000,
    faultTimeoutMs: 4000,
  },

  transitions: {
    replayEnter: { transitionName: 'REPLAY-IN', durationMs: 600 },
    replayExit:  { transitionName: 'Cut',       durationMs: 0   },
    sceneOverrides: {
      LIVE:   { transitionName: 'Cut', transitionDuration: 0 },
      REPLAY: { transitionName: 'REPLAY-IN', transitionDuration: 600 },
    },
    pollOverrideIntervalMs: 60000,
  },

  logging: { level: 'info', retainDays: 30 },

  render: {
    defaultTarget: 'main',
    canvas: { width: 1920, height: 1080 },
    autoReconnectMs: 1000,
    autoReconnectMaxMs: 10000,
    keepLastFrameOnDisconnect: true,
    preloadImages: true,
  },

  templates: {
    builtinDir: './templates/builtin',
    customDir: './templates/custom',
    hotReload: true,
    validateOnLoad: true,
  },

  media: {
    dir: './media',
    maxFileSizeMB: 5,
    allowedTypes: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
    generateThumbnails: true,
    thumbnailWidth: 320,
    derivatives: [
      { name: '1x', width: 480 },
      { name: '2x', width: 960 },
    ],
    scanOnBoot: true,
    watchDir: true,
  },

  entities: { file: './data/entities.json', autoBackup: true },

  animations: {
    defaultIn: 'fadeUp',
    defaultOut: 'fadeDown',
    defaultDurationMs: 400,
  },

  credits: { defaultSpeedPxPerSec: 40, defaultMode: 'loop' },

  // ── 模块 C ──
  cue: {
    // 观众页（floor）已取消 —— 现场大屏直接用 HDMI 输出。频道列表仍可扩展（C-REQ-001）。
    channels: ['director', 'cast'],
    maxVisible: { P0: 1, P1: 1, P2: 2, P3: 5 },
    defaultTtlMs: { P0: null, P1: 8000, P2: 6000, P3: null },
    sound: { enabled: true, volume: 0.7, blockIfLocked: false },
    ack: { required: ['P0'], repeatMs: 5000, maxRepeats: 6 },
    history: { retainHours: 4 },
    templates: {},   // 空 = 使用附录 E 内置话术模板库
  },

  countdown: {
    leadPresetsMs: [60000, 30000, 15000, 10000, 5000, 3000],
    defaultLeadMs: 15000,
    escalation: [
      { atMs: 15000, priority: 'P3', sound: 'none' },
      { atMs: 10000, priority: 'P2', sound: 'none' },
      { atMs: 5000,  priority: 'P1', sound: 'beep' },
      { atMs: 3000,  priority: 'P0', sound: 'triple' },
    ],
    tickAdaptive: true,
    autoExecuteDefault: false,
    allowAutoExecute: false,
  },

  orchestration: { enable: true, preflightOnStart: true, dryRun: false },

  /**
   * 抽奖 / 现场签到。
   *
   *   joinBaseUrl     二维码默认指向的地址（留空 = 用操作员打开控制台的地址）
   *   publicJoinUrl   公网/隧道地址（填了就优先用它，适合 Cloudflare Tunnel / ngrok）
   *   spinMs          抽奖动画时长
   *   relayUrl        可选：轮询第三方中继（在线表单 → 云函数 → 这里），无需公网入站
   *   relayToken      中继请求的 Bearer token（可选）
   *   relayPollMs     轮询间隔
   */
  lottery: {
    joinBaseUrl: '',
    publicJoinUrl: '',
    spinMs: 2800,
    relayUrl: '',
    relayToken: '',
    relayPollMs: 15000,
  },

  /**
   * 监看：不使用媒体服务器。
   *
   * 早先的实现走 MediaMTX（OBS WHIP 推流 → 浏览器 WHEP 拉流）。
   * 现场确定改为：把导播端 / 解说端页面作为 **OBS 浏览器源**，再用
   * OBS 的 **NDI 输出**或 **HDMI** 送到监视器 —— 因此整套 WHIP/WHEP 配置与
   * 服务端截图轮询都已移除，浏览器端不再内嵌任何监看画面。
   */

  integration: {
    replayEndingThresholdMs: 3000,
    autoCueOnAirStart: true,
    autoCueOnAirEnding: true,
    autoCueOnAirEnded: true,
    autoCueOnError: true,
  },

  obsEvents: {
    subscribe: [
      'SceneTransitionStarted', 'SceneTransitionEnded',
      'CurrentProgramSceneChanged', 'InputMuteStateChanged',
    ],
    /**
     * 转场大提醒规则（C-REQ-582 / 584）。
     * 只对**外部**触发的转场弹（我方宏驱动的转场由意图对账过滤掉，C-REQ-583）。
     * durationMs 与 requiresAck 都可按场景单独配置。
     */
    transitionAlerts: [
      { scene: 'REPLAY', title: '进入回放', priority: 'P1', sound: 'beep', durationMs: 8000, requiresAck: false },
      { scene: 'LIVE',   title: '已回直播', priority: 'P2', sound: 'none', durationMs: 6000, requiresAck: false },
    ],
  },
};

// ─────────────────────────────────────────────────────────────
// 分组（设置页的卡片顺序 / 标题）
// ─────────────────────────────────────────────────────────────
export const CONFIG_GROUPS = [
  { id: 'features',  label: '功能开关',        icon: '🧰', desc: '按需启用。默认全部关闭 —— 关闭时服务端不会连接对应设备，也不会反复报连接失败。勾选后立即生效，无需重启。' },
  { id: 'server',    label: '服务',            icon: '🖧',  desc: '中转服务的监听端口与日志。单机部署无需修改。' },
  { id: 'obs',       label: 'OBS WebSocket',   icon: '🎬', desc: 'OBS 的 WebSocket 服务（工具 → WebSocket 服务器设置）。双机模式下填 OBS 机 IP。需先开启「功能开关 → OBS 控制」。' },
  { id: 'vmix',      label: 'vMix HTTP API',   icon: '⏪', desc: 'vMix 的 Web API 端口（设置 → Web Controller，默认 8088）。⚠️ vMix API 无鉴权，切勿暴露到公网。需先开启「功能开关 → vMix 控制」。' },
  { id: 'competition', label: '比赛模式',      icon: '🏆', desc: '团队赛 / 单人赛切换。团队赛的叠加会显示「队伍 + 选手名」，单人赛只显示选手名。' },
  { id: 'match',     label: '比赛计分与选曲',  icon: '🎼', desc: '扫码选曲的局域网 / 公网地址，以及随机选曲默认使用的难度。' },
  { id: 'scenes',    label: '场景与源',        icon: '🎞', desc: 'OBS 场景名与源名，必须与 OBS 中完全一致。' },
  { id: 'clip',      label: '裁切参数',        icon: '✂️', desc: '回溯量 XX、预设、微调步长与缓冲容量约束。' },
  { id: 'replay',    label: '回放与时序',      icon: '⏱', desc: '打点补偿、轮询与超时参数。需先开启「功能开关 → 回放功能」。' },
  { id: 'transitions', label: '转场',          icon: '🔀', desc: 'OBS 转场名称与场景覆盖。stinger 的 Transition Point 无法通过 API 修改，须在 OBS 内手动设置。' },
  { id: 'cue',       label: '提示',            icon: '💬', desc: '提示优先级、可见数量、声音与回执策略。' },
  { id: 'countdown', label: '倒计时与编排',    icon: '⏳', desc: '提前量预设、渐进升级梯度、自动执行开关（高危）。' },
  { id: 'lottery',   label: '抽奖与签到',      icon: '🎁', desc: '现场扫码签到地址、抽奖动画时长，以及可选的第三方中继（在线表单 → 内网抽奖池）。' },
  { id: 'render',    label: '叠加渲染',        icon: '🖼', desc: 'OBS 浏览器源的分辨率、重连行为与动画默认值。' },
  { id: 'media',     label: '媒体库',          icon: '🗂', desc: '上传限制、缩略图与多分辨率派生。' },
  { id: 'data',      label: '数据文件',        icon: '💾', desc: '实体库与模板目录的位置。相对路径以项目根目录为基准。' },
  { id: 'integration', label: '模块协同',      icon: '🔗', desc: '模块 B 的事件如何自动转成模块 C 的提示，以及 OBS 事件的订阅范围。' },
  { id: 'logging',   label: '日志',            icon: '📜', desc: '结构化 JSONL 日志的级别与保留期。' },
];

// ─────────────────────────────────────────────────────────────
// 字段 schema —— 设置页据此自动渲染，服务端据此校验
// ─────────────────────────────────────────────────────────────
/** @type {Array<{path:string,label:string,type:FieldType,group:string,help?:string,min?:number,max?:number,step?:number,options?:string[],restart?:boolean,sensitive?:boolean,advanced?:boolean,placeholder?:string,unit?:string}>} */
export const FIELD_SCHEMA = [
  // ── 功能开关 ★ 默认全关 ──
  { path: 'features.replay', label: '回放功能', type: 'boolean', group: 'features',
    help: '开启 /replay 页面、回放裁切/上屏/回程与回放轮询。依赖「vMix 控制」，未开 vMix 时回放也不会工作。' },
  { path: 'features.vmix', label: 'vMix 控制', type: 'boolean', group: 'features',
    help: '开启 vMix HTTP API 的连接、心跳与全部调用。关闭时本机不会访问 vMix，回放相关功能一并停用。' },
  { path: 'features.obs', label: 'OBS 控制', type: 'boolean', group: 'features',
    help: '开启 OBS WebSocket 连接与场景/源/转场等全部请求。关闭时本机不会连接 OBS。' },
  { path: 'features.transitions', label: '回放转场', type: 'boolean', group: 'features',
    help: '开启 /transitions 页面、转场切换与场景覆盖重读。依赖「OBS 控制」。' },

  // ── 服务 ──
  { path: 'server.host',        label: '监听地址',   type: 'string', group: 'server', help: '0.0.0.0 = 允许局域网访问（解说端平板需要）。' },
  { path: 'server.overlayPort', label: 'Overlay 端口', type: 'port', group: 'server', help: '模块 A 中转服务端口，默认 3000。修改后需重启服务。', restart: true },
  { path: 'server.controlPort', label: 'Control 端口', type: 'port', group: 'server', help: '控制台端口，默认 3001。修改后需重启服务。', restart: true },
  { path: 'server.identity',    label: '本机标识',   type: 'string', group: 'server', placeholder: '如 obs-machine / vmix-machine', help: '写入日志，双机部署时便于区分来源。' },
  { path: 'server.adminPasswordHash', label: '登录密码散列', type: 'password', group: 'server', sensitive: true, placeholder: '留空 = 不鉴权', help: '后台登录密码的 scrypt 散列（scrypt:salt:hash）。不要在界面直接填密码明文；用 tools/set-admin-password.mjs 生成，或留空并用 LP_ADMIN_TOKEN 环境变量。' },
  { path: 'server.allowPublicOutputs', label: '允许外网访问 OBS 输出', type: 'boolean', group: 'server', help: '默认关闭：OBS 渲染源 / 背景素材 / 媒体库只允许内网访问。公网需要看输出时才打开；建议在「后台密码设置」页操作。' },

  // ── OBS ──
  { path: 'obs.host',     label: 'OBS 主机地址', type: 'string', group: 'obs', placeholder: '127.0.0.1', help: '双机模式下填 OBS 所在机器的 IP，例如 192.168.10.11。', restart: true },
  { path: 'obs.port',     label: 'OBS 端口',     type: 'port',   group: 'obs', help: 'obs-websocket 默认 4455。', restart: true },
  { path: 'obs.password', label: 'OBS 密码',     type: 'password', group: 'obs', sensitive: true, restart: true, help: '在 OBS → 工具 → WebSocket 服务器设置 中查看。留空表示未启用鉴权。' },

  // ── vMix ──
  { path: 'vmix.host', label: 'vMix 主机地址', type: 'string', group: 'vmix', placeholder: '127.0.0.1', help: '双机模式下填 vMix 所在机器的 IP，例如 192.168.10.12。', restart: true },
  { path: 'vmix.port', label: 'vMix API 端口', type: 'port',   group: 'vmix', help: 'vMix → 设置 → Web Controller，默认 8088。', restart: true },

  // ── 监看链路 ★ ──

  // ── 比赛模式 ──
  { path: 'competition.mode', label: '比赛模式', type: 'select', group: 'competition', options: ['team', 'solo'],
    help: 'team = 团队赛：叠加显示「队伍名 + 选手名」（有队伍 Logo 时一并显示）；solo = 单人赛：只显示选手名，队伍槽位自动清空并隐藏。' },

  // ── 比赛计分与选曲 ──
  { path: 'match.publicPickBaseUrl', label: '公网选曲地址', type: 'string', group: 'match',
    placeholder: 'https://xxxx.trycloudflare.com',
    help: '可选。填了就用它生成扫码选曲二维码（适合把本机 /pick 通过隧道暴露到公网）。留空则用局域网地址或操作员当前访问地址。' },
  { path: 'match.pickBaseUrl', label: '局域网选曲地址', type: 'string', group: 'match',
    placeholder: 'http://192.168.1.10:3000',
    help: '可选。内网手机访问本机的地址（不要填 localhost / 127.0.0.1，手机访问不到）。留空则用操作员打开控制台的地址。' },
  { path: 'match.defaultDifficulty', label: '随机选曲默认难度', type: 'select', group: 'match',
    options: ['basic', 'advanced', 'expert', 'master', 'ultima'],
    help: '随机选曲时优先使用该难度；该谱面不存在时自动退到可用难度。' },

  // ── 场景与源 ──
  { path: 'scenes.live',   label: 'LIVE 场景名',   type: 'string', group: 'scenes', help: '直播场景 = CLEAN + 浮窗。' },
  { path: 'scenes.replay', label: 'REPLAY 场景名', type: 'string', group: 'scenes', help: '回放场景 = vMix 回传 NDI + REPLAY 标识 + 浮窗。' },
  { path: 'scenes.clean',  label: 'CLEAN 场景名',  type: 'string', group: 'scenes', help: '唯一送往 vMix 的场景，NDI Dedicated Output 滤镜挂在这里。' },
  { path: 'sources.replayNdi', label: 'vMix 回放源名', type: 'string', group: 'scenes', help: 'OBS 中指向 vMix Output 2 的 NDI 源名称。' },
  { path: 'sources.gameAudio', label: '游戏音频源名', type: 'string', group: 'scenes', help: '慢放静音（slowMotionMute）时操作的对象。' },

  // ── 裁切 ──
  { path: 'clip.defaultLookbackMs', label: '默认回溯量 XX', type: 'ms', group: 'clip', min: 1000, max: 600000, step: 500, help: '裁切起点相对「所见时刻」往回的秒数。' },
  { path: 'clip.minLookbackMs',     label: '回溯量下限', type: 'ms', group: 'clip', min: 100, max: 60000, step: 100 },
  { path: 'clip.maxLookbackMs',     label: '回溯量上限', type: 'ms', group: 'clip', min: 1000, max: 600000, step: 500, help: '⚠️ 须 ≤ vMix 回放会话的缓冲容量（R10），超出会导致入点被静默截断。' },
  { path: 'clip.stepMs',            label: '滑杆步进', type: 'ms', group: 'clip', min: 100, max: 5000, step: 100, advanced: true },
  { path: 'clip.presets',           label: '预设按钮（ms）', type: 'list-number', group: 'clip', advanced: true, help: '逗号分隔，默认对应 5/8/12/20/30/45 秒。' },
  { path: 'clip.defaultOutPointMode', label: '默认出点模式', type: 'select', group: 'clip', options: ['follow-now', 'manual', 'fixed-length'] },
  { path: 'clip.fixedLengthMs',     label: '固定长度', type: 'ms', group: 'clip', min: 500, max: 300000, step: 500 },
  { path: 'clip.fineTuneFrames',    label: '微调步长（帧）', type: 'number', group: 'clip', min: 1, max: 600, step: 1, help: '⚠️ 注意单位是**帧**不是秒（陷阱 #19）。' },
  { path: 'clip.frameRate',         label: '帧率', type: 'number', group: 'clip', min: 1, max: 240, step: 1, help: '用于帧↔秒换算显示，须与 OBS 画布 / vMix 回放会话一致。' },
  { path: 'clip.warnThreshold',     label: '预警阈值', type: 'number', group: 'clip', min: 0.1, max: 1, step: 0.05, help: 'XX 超过 maxLookbackMs 的比例时黄色预警（默认 0.8）。' },
  { path: 'clip.markVariant',       label: '打点主路径变体', type: 'select', group: 'clip', options: ['ReplayMarkInOut', 'ReplayMarkInOutLive', 'ReplayMarkInOutRecorded'], help: '⚠️ 待实测回填（R8）。三者的实际差异决定主路径选择。' },

  // ── 回放与时序 ──
  { path: 'replay.channel',            label: '默认通道', type: 'select', group: 'replay', options: ['A', 'B'] },
  { path: 'replay.eventList',          label: '事件库', type: 'number', group: 'replay', min: 1, max: 20, step: 1 },
  { path: 'replay.speed',              label: '回放速度', type: 'number', group: 'replay', min: 0.1, max: 1, step: 0.05, help: '音游场景建议保持 1.0 —— 慢放会与本地音乐失步且降调难听。' },
  { path: 'replay.holdFirstFrame',     label: '首帧定格', type: 'boolean', group: 'replay', help: '上屏后立即 ReplayPause 定格首帧，转场期间无运动，掩盖延迟抖动。强烈建议开启。' },
  { path: 'replay.markDelayMs',        label: '打点补偿 markDelayMs', type: 'ms', group: 'replay', min: 0, max: 2000, step: 10, help: '★ 不加补偿，刚刚发生的精彩瞬间会被切在事件之外。按「操作员看到的画面」比真实时间晚多少来填；不确定时先用默认 200ms。' },
  { path: 'replay.transitionTimeoutMs', label: '转场超时兜底', type: 'ms', group: 'replay', min: 200, max: 20000, step: 100, help: 'cutPoint 事件未达时的兜底时长（B-REQ-1101 双保险）。' },
  { path: 'replay.pollIntervalMs',     label: 'XML 轮询间隔', type: 'ms', group: 'replay', min: 50, max: 2000, step: 10, advanced: true, help: 'vMix 无出站 webhook，轮询是唯一可行方案。' },
  { path: 'replay.stableSamples',      label: '稳定性采样数', type: 'number', group: 'replay', min: 1, max: 20, step: 1, advanced: true, help: '连续 N 次读到同一值才认账，避免瞬时态误判。' },
  { path: 'replay.slowMotionMute',     label: '慢放自动静音', type: 'boolean', group: 'replay', help: 'speed < 阈值 时自动静音游戏音轨，恢复后解除。默认关闭。' },
  { path: 'replay.slowMotionThreshold', label: '慢放静音阈值', type: 'number', group: 'replay', min: 0.1, max: 1, step: 0.05, advanced: true },
  { path: 'replay.progressIntervalMs', label: 'progress 上报间隔', type: 'ms', group: 'replay', min: 50, max: 2000, step: 50, advanced: true },
  { path: 'replay.endingThresholdMs',  label: 'air:ending 阈值', type: 'ms', group: 'replay', min: 200, max: 30000, step: 100, advanced: true, help: '剩余低于此值时发 air:ending，**每次回放仅触发一次**。' },
  { path: 'replay.preflightCacheMs',   label: '预检缓存有效期', type: 'ms', group: 'replay', min: 0, max: 30000, step: 500, advanced: true },
  { path: 'replay.hwHeartbeatMs',      label: 'vMix 心跳间隔', type: 'ms', group: 'replay', min: 500, max: 30000, step: 500, advanced: true },
  { path: 'replay.vmixTimeoutMs',      label: 'vMix 请求超时', type: 'ms', group: 'replay', min: 500, max: 30000, step: 500, advanced: true },
  { path: 'replay.faultTimeoutMs',     label: '瞬态超时', type: 'ms', group: 'replay', min: 1000, max: 30000, step: 500, advanced: true, help: 'MARKING / RETURNING 等瞬态最长存活时间，超时强制转 FAULT。' },

  // ── 转场 ──
  { path: 'transitions.replayEnter.transitionName', label: '进入回放转场', type: 'string', group: 'transitions', help: '建议为 stinger，须在 OBS 中把 Transition Point 设在不透明区正中。' },
  { path: 'transitions.replayEnter.durationMs',     label: '进入回放时长', type: 'ms', group: 'transitions', min: 0, max: 20000, step: 50 },
  { path: 'transitions.replayExit.transitionName',  label: '退出回放转场', type: 'string', group: 'transitions', help: '回直播建议用 Cut —— LIVE 是本地内容即时可用，硬切无穿帮。' },
  { path: 'transitions.replayExit.durationMs',      label: '退出回放时长', type: 'ms', group: 'transitions', min: 0, max: 20000, step: 50 },
  { path: 'transitions.sceneOverrides',             label: '场景转场覆盖', type: 'json', group: 'transitions', help: '⚠️ 变更无法通过事件感知，须按需重读（B-REQ-3001）。' },
  { path: 'transitions.pollOverrideIntervalMs',     label: '覆盖重读间隔', type: 'ms', group: 'transitions', min: 5000, max: 600000, step: 1000, advanced: true },

  // ── 提示 ──
  { path: 'cue.channels',            label: '受众频道', type: 'list', group: 'cue', help: '逗号分隔，可扩展（C-REQ-001）。默认 director / cast（现场页已取消，现场大屏走 HDMI）。' },
  { path: 'cue.maxVisible',          label: '各级可见数量', type: 'json', group: 'cue', help: '如 {"P0":1,"P1":1,"P2":2,"P3":5}。' },
  { path: 'cue.defaultTtlMs',        label: '各级默认 TTL', type: 'json', group: 'cue', help: 'null = 须显式清除。' },
  { path: 'cue.sound.enabled',       label: '声音提示', type: 'boolean', group: 'cue' },
  { path: 'cue.sound.volume',        label: '音量', type: 'number', group: 'cue', min: 0, max: 1, step: 0.05 },
  { path: 'cue.ack.repeatMs',        label: '未回执重复间隔', type: 'ms', group: 'cue', min: 1000, max: 60000, step: 500 },
  { path: 'cue.ack.maxRepeats',      label: '未回执重复上限', type: 'number', group: 'cue', min: 0, max: 30, step: 1, help: '超过后停止声音并升级为导播页告警。' },
  { path: 'cue.history.retainHours', label: '提示历史保留', type: 'number', group: 'cue', min: 1, max: 72, step: 1 },
  { path: 'cue.templates',           label: '自定义话术模板', type: 'json', group: 'cue', help: '如 {"T20":{"name":"局间提示","template":"第 {n} 局开始","audience":["cast"],"priority":"P2","sound":"beep"}}。内置的 T1–T14 用同 id 即可覆盖（C-REQ-1102）。也可在 /cues 页用表格编辑。' },

  // ── 倒计时与编排 ──
  { path: 'countdown.leadPresetsMs',   label: '提前量预设', type: 'list-number', group: 'countdown', help: '逗号分隔（毫秒）。默认 60/30/15/10/5/3 秒。' },
  { path: 'countdown.defaultLeadMs',   label: '默认提前量', type: 'ms', group: 'countdown', min: 1000, max: 600000, step: 1000 },
  { path: 'countdown.escalation',      label: '渐进升级梯度', type: 'json', group: 'countdown', help: '如 [{"atMs":15000,"priority":"P3","sound":"none"}, ...]。' },
  { path: 'countdown.tickAdaptive',    label: '自适应 tick', type: 'boolean', group: 'countdown', help: '剩余 >60s 走 1s 粒度，≤10s 走 100ms 粒度。关闭则全程 100ms（不推荐）。' },
  { path: 'countdown.autoExecuteDefault', label: '编排默认自动执行', type: 'boolean', group: 'countdown', help: '⚠️ 高危：开启后倒计时归零将直接调用模块 B。' },
  { path: 'countdown.allowAutoExecute',   label: '允许自动执行', type: 'boolean', group: 'countdown', help: '⚠️ 总开关。关闭时导播页的「到点自动执行」复选框不可用。' },
  { path: 'orchestration.enable',      label: '启用编排', type: 'boolean', group: 'countdown' },
  { path: 'orchestration.dryRun',      label: '预演模式', type: 'boolean', group: 'countdown', help: '走完全流程但不调用模块 B 的任何写接口，用于彩排与验证时序。' },

  // ── 抽奖与签到 ──
  { path: 'lottery.publicJoinUrl', label: '公网签到地址', type: 'string', group: 'lottery',
    placeholder: 'https://xxxx.trycloudflare.com',
    help: '可选。填了就用它生成二维码（Cloudflare Tunnel / ngrok 等把本机 /join 暴露到公网）。留空则用「局域网签到地址」或操作员当前访问地址。' },
  { path: 'lottery.joinBaseUrl', label: '局域网签到地址', type: 'string', group: 'lottery',
    placeholder: 'http://192.168.1.10:3000',
    help: '可选。内网手机访问本机的地址（不要填 localhost / 127.0.0.1，手机访问不到）。留空则用操作员打开控制台的地址。' },
  { path: 'lottery.spinMs', label: '抽奖动画时长', type: 'ms', group: 'lottery', min: 500, max: 15000, step: 100,
    help: '名字滚动到揭晓的时间。默认 2800ms。' },
  { path: 'lottery.relayUrl', label: '第三方中继 URL', type: 'string', group: 'lottery', advanced: true,
    placeholder: 'https://your-worker.workers.dev/entries',
    help: '可选。服务端定时拉取新签到（JSON），适合「在线表单 → 云函数 → 内网」这种无公网入站的方案。详见 README。' },
  { path: 'lottery.relayToken', label: '中继 Token', type: 'password', group: 'lottery', sensitive: true, advanced: true,
    help: '发往中继 URL 的 Authorization: Bearer 令牌（可选）。' },
  { path: 'lottery.relayPollMs', label: '中继轮询间隔', type: 'ms', group: 'lottery', min: 3000, max: 300000, step: 1000, advanced: true },

  // ── 渲染 ──
  { path: 'render.canvas.width',   label: '画布宽度', type: 'number', group: 'render', min: 320, max: 7680, step: 1, help: '⚠️ OBS 画布 / NDI 输出 / vMix 回放会话三者格式必须完全一致（含 59.94 vs 60）。' },
  { path: 'render.canvas.height',  label: '画布高度', type: 'number', group: 'render', min: 240, max: 4320, step: 1 },
  { path: 'render.preloadImages',  label: '图片预加载', type: 'boolean', group: 'render', help: '加载完成前不显示，避免半张图。' },
  { path: 'render.keepLastFrameOnDisconnect', label: '断线保持画面', type: 'boolean', group: 'render', help: '★ 必须开启：WS 断开时清空画面会让观众看到空屏。' },
  { path: 'render.autoReconnectMs',    label: '重连起始间隔', type: 'ms', group: 'render', min: 200, max: 10000, step: 100, advanced: true },
  { path: 'render.autoReconnectMaxMs', label: '重连间隔上限', type: 'ms', group: 'render', min: 1000, max: 60000, step: 500, advanced: true },

  // ── 媒体库 ──
  { path: 'media.maxFileSizeMB',    label: '单文件上限', type: 'number', group: 'media', min: 1, max: 200, step: 1, unit: 'MB' },
  { path: 'media.allowedTypes',     label: '允许的格式', type: 'list', group: 'media', help: '只允许静态位图（PNG / JPG / WebP / GIF）。SVG 可携带脚本已禁用；音频 / 视频 / 可执行文件一律不收，此设置无法放宽到图片以外。' },
  { path: 'media.generateThumbnails', label: '生成缩略图', type: 'boolean', group: 'media' },
  { path: 'media.thumbnailWidth',   label: '缩略图宽度', type: 'number', group: 'media', min: 64, max: 1024, step: 16 },
  { path: 'media.derivatives',      label: '多分辨率派生', type: 'json', group: 'media', help: '如 [{"name":"1x","width":480},{"name":"2x","width":960}]。' },
  { path: 'media.scanOnBoot',       label: '启动时扫描目录', type: 'boolean', group: 'media' },
  { path: 'media.watchDir',         label: '监视目录变化', type: 'boolean', group: 'media', help: '赛前直接往 media/ 丢图即可自动索引。' },

  // ── 渲染：动画与致谢默认值（§4.10） ──
  { path: 'render.defaultTarget', label: '默认渲染实例', type: 'select', group: 'render', options: ['main', 'credits'], advanced: true },
  { path: 'animations.defaultIn',        label: '默认入场动画', type: 'select', group: 'render', advanced: true, options: ['none', 'fadeIn', 'fadeUp', 'fadeDown', 'slideLeft', 'slideRight', 'slideUp', 'slideDown', 'scaleIn', 'wipeRight', 'blurIn'] },
  { path: 'animations.defaultOut',       label: '默认出场动画', type: 'select', group: 'render', advanced: true, options: ['none', 'fadeIn', 'fadeOut', 'fadeUp', 'fadeDown', 'slideLeft', 'slideRight', 'slideUp', 'slideDown', 'scaleIn', 'wipeRight', 'blurIn'] },
  { path: 'animations.defaultDurationMs', label: '默认动画时长', type: 'ms', group: 'render', advanced: true, min: 0, max: 5000, step: 50 },
  { path: 'credits.defaultSpeedPxPerSec', label: '致谢默认滚动速度', type: 'number', group: 'render', advanced: true, min: 5, max: 400, step: 5, unit: 'px/s' },
  { path: 'credits.defaultMode',          label: '致谢默认模式', type: 'select', group: 'render', advanced: true, options: ['loop', 'once'] },

  // ── 数据文件位置 ──
  { path: 'entities.file',        label: '实体库文件', type: 'string', group: 'data', help: '可读可 diff 的 JSON。选手 / 解说 / 赞助商都存这里。', restart: true },
  { path: 'entities.autoBackup',  label: '保存前自动备份', type: 'boolean', group: 'data', help: '每次写盘前把上一份复制为 .bak。' },
  { path: 'templates.builtinDir', label: '内置模板目录', type: 'string', group: 'data', restart: true },
  { path: 'templates.customDir',  label: '自定义模板目录', type: 'string', group: 'data', help: '同名模板会覆盖内置版本（A-REQ-210）。', restart: true },
  { path: 'templates.hotReload',  label: '模板热重载', type: 'boolean', group: 'data', help: '★ 文件变更后只推送受影响的模板定义，不整页刷新、不黑屏（A-REQ-213）。' },
  { path: 'templates.validateOnLoad', label: '加载时校验 schema', type: 'boolean', group: 'data', help: '非法模板拒绝加载并指明字段路径，控制端回滚到上一可用版本。' },
  { path: 'media.dir',            label: '媒体目录', type: 'string', group: 'data', help: '可以直接往这个目录丢图，服务端会自动索引（A-REQ-412）。', restart: true },

  // ── 模块协同 ──
  { path: 'integration.autoCueOnAirStart',  label: '上屏时自动投递「回放中」', type: 'boolean', group: 'integration', help: 'C-REQ-592：air:start → 常驻提示给 cast + director。' },
  { path: 'integration.autoCueOnAirEnding', label: '结束前自动投递「准备接话」', type: 'boolean', group: 'integration', help: 'C-REQ-593：air:ending → P1 提示给 cast。' },
  { path: 'integration.autoCueOnAirEnded',  label: '结束时自动投递「可回直播」', type: 'boolean', group: 'integration', help: 'C-REQ-594：air:ended → P2 提示给 director。' },
  { path: 'integration.autoCueOnError',     label: '出错时自动投递 P0 告警', type: 'boolean', group: 'integration', help: 'C-REQ-596。', advanced: true },
  { path: 'obsEvents.subscribe',            label: '订阅的 OBS 事件', type: 'list', group: 'integration', help: '至少应包含 SceneTransitionStarted / SceneTransitionEnded / CurrentProgramSceneChanged / InputMuteStateChanged（C-REQ-587）。' },
  { path: 'obsEvents.transitionAlerts',     label: '转场大提醒规则', type: 'json', group: 'integration', help: '如 [{"scene":"REPLAY","title":"进入回放","priority":"P1","sound":"beep","durationMs":8000,"requiresAck":false}]。只对**外部**触发的转场弹提醒（C-REQ-583 意图对账）。requiresAck=true 时不会自动过期，须确认后才消失。' },

  // ── 日志 ──
  { path: 'logging.level',      label: '日志级别', type: 'select', group: 'logging', options: ['debug', 'info', 'warn', 'error'] },
  { path: 'logging.retainDays', label: '保留天数', type: 'number', group: 'logging', min: 1, max: 365, step: 1 },
];

// ─────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────

/** 深合并（b 覆盖 a；数组整体替换而非拼接） */
export function deepMerge(a, b) {
  if (Array.isArray(b)) return b.slice();
  if (b === null || typeof b !== 'object') return b === undefined ? a : b;
  const out = Array.isArray(a) ? a.slice() : { ...(a && typeof a === 'object' ? a : {}) };
  for (const k of Object.keys(b)) out[k] = deepMerge(out[k], b[k]);
  return out;
}

/** 按点分路径取值 */
export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** 按点分路径写值（自动创建中间对象） */
export function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
  return obj;
}

/** 按点分路径删除键 */
export function deletePath(obj, path) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    cur = cur?.[keys[i]];
    if (!cur) return obj;
  }
  delete cur[keys[keys.length - 1]];
  return obj;
}

/**
 * **自由结构**路径 —— 这些节点的键由用户自定义，必须整份拷贝，
 * 绝不能按默认值的形状递归裁剪。两个来源：
 *
 *   ① schema 里声明为 `json` 的字段；
 *   ② DEFAULT_CONFIG 里值为**空对象 `{}`** 的节点 —— 空对象表达的语义是
 *      「这里是个自由容器」，而不是「这里一个键都没有」。
 *
 * 踩过的坑：`cue.templates` 的默认值是 `{}`，按形状递归会得到 0 个键，
 * 于是用户新增的话术模板 T20 在保存时被静默丢弃（内存与磁盘都变回 `{}`）。
 * `transitions.sceneOverrides` 有默认键，但用户新增的场景同样会被丢掉。
 */
const JSON_LEAF_PATHS = (() => {
  const set = new Set(FIELD_SCHEMA.filter((f) => f.type === 'json').map((f) => f.path));
  const collect = (node, prefix) => {
    for (const [k, v] of Object.entries(node || {})) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        if (Object.keys(v).length === 0) set.add(path);   // 空对象 = 自由容器
        else collect(v, path);
      }
    }
  };
  collect(DEFAULT_CONFIG, '');
  return set;
})();

/**
 * 按 DEFAULT_CONFIG 的**形状**裁剪配置 —— 丢弃未知的脏字段，但保留所有结构性节点。
 *
 * 两类节点整份拷贝而非递归：
 *   ① schema 里声明为 `json` 的自由结构（键由用户自定义）
 *   ② 数组（内容由各自的校验规则把关）
 *
 * ⚠️ 早两版分别踩过：先是只保留 FIELD_SCHEMA 登记过的字段，把 `version` /
 * `templates` / `entities` / `animations` / `credits` / `integration` / `obsEvents`
 * 这些整节删掉；改成按形状裁剪后，又把自由结构的自定义键吃掉。
 *
 * @param {object} cfg 待裁剪的配置
 * @param {object} [shape] 形状模板，默认 DEFAULT_CONFIG
 */
export function extractKnownFields(cfg, shape = DEFAULT_CONFIG) {
  const out = {};
  walk(cfg, shape, out, '');
  return out;

  function walk(src, shp, dst, prefix) {
    if (shp === null || typeof shp !== 'object' || Array.isArray(shp)) return;

    for (const k of Object.keys(shp)) {
      const sv = src?.[k];
      if (sv === undefined) continue;
      const path = prefix ? `${prefix}.${k}` : k;
      const expected = shp[k];

      // ① 自由结构（json 字段）：整份深拷贝，保留用户的任意键
      if (JSON_LEAF_PATHS.has(path)) {
        dst[k] = sv === null || typeof sv !== 'object' ? sv : structuredClone(sv);
        continue;
      }

      if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
        if (sv !== null && typeof sv === 'object' && !Array.isArray(sv)) {
          dst[k] = {};
          walk(sv, expected, dst[k], path);
        }
      } else {
        // ② 数组与原始值：整体接收
        dst[k] = Array.isArray(sv) ? structuredClone(sv) : sv;
      }
    }
  }
}

/** 供测试与排障：列出被视为自由结构的路径 */
export function jsonLeafPaths() { return [...JSON_LEAF_PATHS]; }

/**
 * 校验配置，返回 { path: message }。空对象 = 通过。
 * 需求：A-REQ-215 / B-REQ-305 —— 非法时必须指明**字段路径**。
 */
/**
 * 文件系统路径类字段。这些值最终会进入 fs 操作或日志，
 * 必须排除控制字符与 shell 元字符，避免被塞进命令或越界访问。
 */
const PATH_FIELDS = new Set([
  'entities.file',
  'templates.builtinDir',
  'templates.customDir',
  'media.dir',
]);

export function validateConfig(cfg) {
  const errors = {};

  for (const f of FIELD_SCHEMA) {
    const v = getPath(cfg, f.path);

    if (v === undefined) continue; // 缺失走默认值，不算错

    switch (f.type) {
      case 'string':
      case 'textarea':
      case 'url':
        if (typeof v !== 'string') errors[f.path] = '必须是字符串';
        break;

      case 'password':
        if (typeof v !== 'string') errors[f.path] = '必须是字符串';
        break;

      case 'number':
      case 'ms':
      case 'port': {
        const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
        if (typeof n !== 'number' || !Number.isFinite(n)) { errors[f.path] = '必须是数字'; break; }
        if (f.type === 'port' && (!Number.isInteger(n) || n < 1 || n > 65535)) { errors[f.path] = '端口必须是 1-65535 的整数'; break; }
        if (f.min !== undefined && n < f.min) { errors[f.path] = `不能小于 ${f.min}`; break; }
        if (f.max !== undefined && n > f.max) { errors[f.path] = `不能大于 ${f.max}`; break; }
        if (f.type === 'ms' && n < 0) { errors[f.path] = '时长不能为负'; break; }
        break;
      }

      case 'boolean':
        if (typeof v !== 'boolean') errors[f.path] = '必须是 true / false';
        break;

      case 'select':
        if (!f.options?.includes(v)) errors[f.path] = `必须是 ${(f.options || []).join(' / ')} 之一`;
        break;

      case 'color':
        if (typeof v !== 'string' || !/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) errors[f.path] = '必须是十六进制颜色，如 #d9d9d9';
        break;

      case 'list':
        if (typeof v === 'string') break;                      // 允许 "a,b,c" 形式，落盘前会归一化
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) errors[f.path] = '必须是字符串数组';
        break;

      case 'list-number':
        if (typeof v === 'string') {
          if (v.trim() && v.split(',').some((x) => x.trim() === '' || !Number.isFinite(Number(x.trim())))) {
            errors[f.path] = '必须是逗号分隔的数字';
          }
          break;
        }
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'number' || !Number.isFinite(x))) errors[f.path] = '必须是数字数组';
        break;

      case 'json':
        if (typeof v === 'string') {
          if (v.trim() === '') break;
          try { JSON.parse(v); } catch (e) { errors[f.path] = `JSON 解析失败：${e.message}`; }
          break;
        }
        if (v !== null && typeof v !== 'object') errors[f.path] = '必须是对象或数组';
        break;

      default:
        break;
    }

    // URL 类字段：允许留空（表示未配置），非空时须是 http(s)://
    if ((f.type === 'url' || f.path.endsWith('.url')) && typeof v === 'string' && v.trim() !== '') {
      if (!/^https?:\/\/.+/i.test(v.trim())) errors[f.path] = '必须是 http:// 或 https:// 开头的完整地址';
    }

    // 路径字段：禁止控制字符与 shell 元字符（防命令注入 / 路径越界）
    if (PATH_FIELDS.has(f.path) && typeof v === 'string') {
      if (/[\u0000-\u001f\u007f]/.test(v)) errors[f.path] = '路径不能包含控制字符';
      else if (/[`$&|;<>"']/.test(v)) errors[f.path] = '路径不能包含 ` $ & | ; < > " \' 等字符';
    }
  }

  // ── 跨字段一致性 ──
  const min = getPath(cfg, 'clip.minLookbackMs');
  const max = getPath(cfg, 'clip.maxLookbackMs');
  const def = getPath(cfg, 'clip.defaultLookbackMs');
  if (typeof min === 'number' && typeof max === 'number' && min > max) {
    errors['clip.minLookbackMs'] = '下限不能大于上限（clip.maxLookbackMs）';
  }
  if (typeof def === 'number' && typeof max === 'number' && def > max) {
    errors['clip.defaultLookbackMs'] = '默认回溯量不能超过 clip.maxLookbackMs';
  }

  const ol = getPath(cfg, 'server.overlayPort');
  const cl = getPath(cfg, 'server.controlPort');
  if (typeof ol === 'number' && typeof cl === 'number' && ol === cl) {
    errors['server.controlPort'] = 'Control 端口不能与 Overlay 端口相同';
  }


  return errors;
}

/**
 * 归一化：把设置页传来的字符串形式（如 "1,2,3"）转成落盘形式。
 * 只在通过 validateConfig 之后调用。
 */
export function normalizeConfig(cfg) {
  for (const f of FIELD_SCHEMA) {
    const v = getPath(cfg, f.path);
    if (v === undefined) continue;

    /**
     * 字符串一律去掉首尾空白。
     *
     * 这条不是洁癖：设置页里手输 `0.0.0.0 `（尾随一个空格）会让
     * `server.listen()` 抛 ENOTFOUND: getaddrinfo ENOTFOUND '0.0.0.0 '，
     * 整个服务直接起不来 —— 而界面上完全看不出问题。
     * 密码/令牌**不**做 trim（首尾空格可能是密码的一部分）。
     */
    if ((f.type === 'string' || f.type === 'url' || f.type === 'textarea') && typeof v === 'string') {
      setPath(cfg, f.path, v.trim());
    }

    if (f.type === 'list' && typeof v === 'string') {
      setPath(cfg, f.path, v.split(',').map((s) => s.trim()).filter(Boolean));
    } else if (f.type === 'list-number' && typeof v === 'string') {
      setPath(cfg, f.path, v.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)));
    } else if (f.type === 'json' && typeof v === 'string') {
      setPath(cfg, f.path, v.trim() === '' ? {} : JSON.parse(v));
    } else if ((f.type === 'number' || f.type === 'ms' || f.type === 'port') && typeof v === 'string' && v.trim() !== '') {
      setPath(cfg, f.path, Number(v));
    }
  }
  return cfg;
}

/** schema 中标记为需重连的字段路径 */
export const RESTART_PATHS = FIELD_SCHEMA.filter((f) => f.restart).map((f) => f.path);
/** 敏感字段路径（不写日志、读出时掩码） */
export const SENSITIVE_PATHS = FIELD_SCHEMA.filter((f) => f.sensitive).map((f) => f.path);
