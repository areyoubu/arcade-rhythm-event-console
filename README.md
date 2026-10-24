# 街机音游赛事控制软件

**Arcade Rhythm Game Event Control Console** · 直播 / 比赛计分 / 现场互动一体化控制台

针对街机音游（中二节奏 / CHUNITHM）赛事直播设计，**目前内置中二节奏全套 19 套叠加模板**
（姓名条、对阵卡、双人名牌、比分条、致谢 · 多种风格），并支持 OBS 浏览器源、vMix 回放、
比赛计分、扫码选曲、现场签到与抽奖。按 `docs/需求.md`（SRS v1.0，2594 行）实现。

**OBS 做节目总切换，vMix 做视频回放机，浏览器做图形叠加、比赛计分与现场互动。**
模块 A–F（叠加 / 回放 / 提示 / 比分条 / 抽奖 / 比赛计分）解耦——任一模块崩溃或停止，不影响其余模块。

界面靠 OBS 的视觉语言：偏冷的中深灰面板、1px 分隔线、3–4px 小圆角，
OBS 蓝只用于主操作 / 选中 / 焦点，其余颜色只表示状态（在线 / 告警 / 危险 / 上屏）；
无渐变、无发光、无 emoji 图标。叠加模板走「转播图形」质感
（实心色板 + 细强调线，默认强调色为中性银），远看干净、不抢画面。

---

## 快速开始（新用户先看这里）

### 1. 环境要求

- **Node.js ≥ 20.11**（Windows / Linux / macOS 均可）
- Windows 用户可直接双击仓库根目录的 `.bat` 脚本；其它系统用下面的 `npm` 命令
- 可选：OBS Studio + obs-websocket v5；vMix Pro / 4K / Max（只有回放功能需要）

### 2. 安装

双击 **`install.bat`**，或者在终端执行：

```bash
npm install
```

首次启动会自动从 `config/config.example.json` 生成 `config/config.json`，
所以仓库里**没有任何现场地址、密钥或个人信息**。

### 3. 启动（只用局域网 / 单机）

双击 **`start-main.bat`**（等价于 `npm start`），然后打开：

<http://127.0.0.1:3000>

**默认后台登录密码：`Admin`**

> ⚠️ 第一次进入后，请立刻在**内网**打开 <http://127.0.0.1:3000/admin-setup>
> 修改密码。这个页面只接受内网访问，公网打不开。

### 4. 脚本一览

| 脚本 | 作用 | 什么时候用 |
|---|---|---|
| `install.bat` | 安装依赖，生成初始配置 | 第一次使用 / 更新依赖 |
| `start-main.bat` | 启动主控制台（:3000 / :3001） | 单机或局域网直播 |
| `start-public-edge.bat` | 启动公网端 Edge 图形配置台（127.0.0.1:8788） | 有公网 IP 的机器 |
| `start-internal-agent.bat` | 启动内网端 Agent 图形配置台（127.0.0.1:8789），同时管理主控 | 没有公网 IP 的本体机器 |
| `start-demo.bat` | 起 mock OBS + mock vMix，再起主控 | 没有 OBS / vMix 时试跑 |

常用 npm 命令：

| 命令 | 作用 |
|---|---|
| `npm start` | 启动主控制台 |
| `npm run dev` | 开发模式（文件变化自动重启） |
| `npm run mock` | 只启动 mock OBS / vMix（另开终端 `npm start`） |
| `npm test` | 单元 / DOM / 页面完整性测试 |
| `npm run selftest` | 端到端自检（隔离配置 + mock，走完回放宏） |
| `npm run music:import` | 从 `data/source/ChunithmMusicData.xlsx` 重新生成曲目库 |
| `npm run music:cn` | 用本地 `chunithm_songs.json` 更新国服标记与 WE 特殊谱面 |
| `npm run admin:password` | 交互式修改后台登录密码（也可用 /admin-setup） |
| `npm run edge` / `npm run agent` | 直接启动 Edge / Agent（读 JSON 配置，不开图形界面） |
| `npm run remote` | 旧版同网络直连远端入口 |

### 5. 部署方式：正常开谁和谁

| 场景 | 公网机器 | 内网机器（本体） | 公网访客入口 |
|---|---|---|---|
| **只在内网用** | — | `start-main.bat` | 局域网 IP:3000 |
| **手机公网签到 / 选曲**（推荐） | `start-public-edge.bat` | `start-internal-agent.bat` | Edge 端口（默认 8790） |
| **没有 OBS / vMix 试跑** | — | `start-demo.bat` | 本机 3000 |
| 同网络直连（旧模式） | `npm run remote` | `npm start` | 远端端口（默认 8787） |

分离网络模式里：

1. 公网机器双击 `start-public-edge.bat`，在 `127.0.0.1:8788` 生成隧道密钥、保存并启动 Edge；
2. 内网机器双击 `start-internal-agent.bat`，在 `127.0.0.1:8789` 填入同一把隧道密钥，
   填好 `remoteToken`，保存并启动主控 + Agent；
3. 公网只开放 Edge 端口；主控 3000 / 3001 **不要**映射出去。

### 6. 第一次配置

打开 <http://127.0.0.1:3000/settings>：

1. **功能开关**：默认全关。用 OBS 就开 OBS，用 vMix 回放就开 vMix + 回放，用转场就开回放转场；
2. **OBS WebSocket**：填 host / port / password，点「测试连接」；
3. **vMix HTTP API**：填 host / port，点「测试连接」；
4. **比赛计分 / 抽奖签到**：内网使用时公网地址留空；使用 Edge 时填公网 Edge 地址；
5. **后台密码**：到 `/admin-setup` 修改（默认 `Admin`）；
6. **安全默认值**：OBS 输出（`/render/*`、`/assets/*`、`/media/*`）默认**只允许内网访问**，
   需要外网看输出时再到 `/admin-setup` 打开开关。

### 7. 没有 OBS / vMix 也能跑通

```bash
npm run mock         # 一个终端：mock vMix(:8088) + mock OBS(:4455)
npm start            # 另一个终端：起真实服务
```

或者直接双击 `start-demo.bat`。随后到「设置 → 功能开关」打开 OBS / vMix / 回放 / 转场，
mock 环境提供完整的回放链路（录制 / 裁切 / 上屏 / 回程）、转场事件与提示系统。

---

### 需要公网？用独立远端入口

**不要把主控制台的 `:3000` 直接映射到公网**。签到和扫码选曲需要公网时，用 `remote/`。

#### 分离网络（公网机器 + 无公网的本体，推荐）

公网机器跑 **Edge**，本体一侧跑 **Agent**。Agent 主动出站连接 Edge，
所以本体所在网络**不需要任何入站端口**，两台机器可以在完全不同的网络。

最省事的方式：两端各双击一个脚本，打开**只监听 127.0.0.1** 的图形配置台：

| 机器 | 双击 | 配置台 | 自动启动 |
|---|---|---|---|
| 公网机器 | `remote/start-edge-gui.bat` | `http://127.0.0.1:8788/` | Edge |
| 内网机器 | `remote/start-agent-gui.bat` | `http://127.0.0.1:8789/` | 主控 + Agent |

配置台里可以生成密钥、改端口 / 限流 / TLS、启动停止服务、看实时日志；
密钥规则和接入步骤也直接写在页面里。

也可以继续用命令行：

```bash
# 公网机器（有公网 IP）
cp remote/edge.config.example.json remote/edge.config.json
# 编辑 agentToken / TLS
npm run edge

# 内网机器（主控制台一侧）
cp remote/agent.config.example.json remote/agent.config.json
# 编辑 edgeUrl / token / localUpstream / remoteToken
npm run agent
```

#### 同网络 / 同机直连

如果远端能直接访问主控制台，也可以只用直连模式：

```bash
cp remote/config.example.json remote/config.json
npm run remote
```

两种模式都只开放签到 / 选曲所需的 8 个路径，控制接口、OBS 源、设置、WebSocket
一律不经过公网；自带限流、body / 响应上限、并发与连接上限、安全响应头、健康检查。
Edge ↔ Agent 之间有 token 认证和 WSS；Agent 会把真实公网客户端 IP 转给主服务
（主服务设置 `LP_REMOTE_TOKEN`，Agent 设置相同的 `remoteToken`）。

主控设置里把「公网签到地址 / 公网选曲地址」填成公网 Edge 的地址。
完整部署、TLS、Caddy / nginx、systemd、抗攻击说明：**[remote/README.md](remote/README.md)**。

---

## 界面一览

| 路由 | 用途 |
|---|---|
| `/` | **系统总览**：当前赛事、功能地图（按工作流分组）、链路状态、**开播检查清单**（附录 C） |
| `/settings` | ★ **全部接口地址与运行参数配置** |
| `/overlay` | 叠加主控制台（**预览与直播输出分离** / 模板按图形族+风格分组 / 实体填充（网格内滚动）/ 模板区独立滚动 / 槽位热改 / 队列） |
| `/people` | **人物与角色**（队伍 / 选手 / 解说·导播 / 赞助商；选手按队伍分组，含双人一键投递） |
| `/credits` | 感谢列表编辑（拖拽排序 / 标签导入 / 时长预估） |
| `/media` | 媒体库（拖拽上传 / 内容校验 / 来源 IP 与时间 / 引用检查 / 目录直投自动索引） |
| `/templates` | 模板管理（槽位编辑 / schema 校验 / 热重载预览） |
| `/replay` | **完整回放控制器**（13 个功能区 / 151 个 vMix 函数）— 需开启「回放功能」 |
| `/transitions` | OBS 转场面板（含防穿帮说明）— 需开启「回放转场」 |
| `/director` | 导播页（编排 + 回执看板 + 转场大提醒；可作 OBS 浏览器源） |
| `/cast` | **解说端叠加**（透明背景的 OBS 浏览器源，只画提示与倒计时） |
| `/match` | **比赛计分**（1–4 首自适应 / 总分制·小局制 / 曲目与难度 / Ban / 扫码选曲 / 历史） |
| `/music` | ★ **曲目库管理**（曲目增改删 · 难度定数 · 国服标记 · 上传 xlsx 全量更新） |
| `/scoreboard` | **比分条控制台**（+1 / −1 暂存 → 确认 · 选手与叠加同步 · 操作日志） |
| `/outputs` | ★ **输出与场景**（所有 OBS 浏览器源 / 公共扫码入口 / 连接状态 / 背景素材，统一复制地址） |
| `/lottery` | **抽奖控制台**（抽奖池筛选 / 大屏动画 / 中奖记录 / 签到二维码） |
| `/guests` | ★ **签到管理**（名单搜索 / 添加 / 编辑 / 删除 / 导入 CSV / 导出 / 二维码） |
| `/join` | **现场签到页**（手机扫码填写姓名加入抽奖池） |
| `/pick` | **手机扫码选曲页**（公开 · P1/P2 · 搜索曲目与难度 · 提交给导播确认） |
| `/cues` `/logs` | 话术模板 / 日志与提示历史 |
| `/render/score` | **OBS 浏览器源**（比分条 + 两块选手牌，同一个源） |
| `/render/match` | **OBS 浏览器源 / 独立整屏场景**（总比分画面：选手 / 队伍 / 每首曲目与胜负 · 复用直播间动态背景） |
| `/render/pick` | **OBS 浏览器源**（选曲二维码大屏 + 刚提交的选曲） |
| `/render/lottery` | **OBS 浏览器源**（抽奖大屏：滚动名字 / 中奖卡 / 彩带） |
| `/render/prize` | **OBS 浏览器源 / 独立整屏场景**（本轮奖品图片 + 大号名称 · 任意比例自适应 · 复用直播间动态背景） |
| `/render/main` | **OBS 浏览器源**（浮窗-主） |
| `/render/credits` | **OBS 浏览器源**（浮窗-致谢） |

---

## 系统地图与工作流

整个系统按**工作流**分成五组，顶栏、首页「功能地图」和「输出与场景」共用同一份目录
（`public/shared/ui.js` 的 `CATALOG`）：

| 分组 | 页面 | 说明 |
|---|---|---|
| **直播图形** | 叠加 / 模板 / 媒体 / 人物 / 致谢 | 叠加模板、素材、人物资料与致谢；对应 `render/main`、`render/credits` 两路透明源 |
| **比赛** | 比赛计分 / 曲目库 / 比分条 | 曲目计分、选曲、Ban、曲目库维护；比分条与选手牌；对应总比分 / 比分条 / 选曲二维码三路源 |
| **互动** | 抽奖 / 签到管理 / 扫码选曲 | 抽奖大屏、奖品大屏、签到名单（增删改 / 导入导出）、手机选曲 |
| **播控** | 导播 / 解说页 / 话术 / 回放 / 转场 | 提示与倒计时、解说端叠加、回放与 OBS 转场（后两者受功能开关控制） |
| **系统** | 输出与场景 / 日志 / 设置 | OBS 地址汇总、日志检索、全部配置 |

推荐的赛时顺序：

1. **赛前**：人物 → 媒体 → 模板 → 致谢；在设置里确认 OBS / vMix / 比赛 / 抽奖参数。
2. **开场**：`/outputs` 核对每一路 OBS 源是否「已连接」；把主叠加、比分条、总比分、选曲二维码按场景加好。
3. **比赛**：`/match` 选 P1/P2、选曲、录分数；需要选手选曲时打开 `/render/pick` 二维码。
4. **上屏**：比分条跟随本局时自动显示总分 / 胜局；局间/结算用 `/render/match` 整屏总比分。
5. **互动**：`/lottery` 抽奖，`/join` 现场签到；`/guests` 管理签到名单（添加 / 编辑 / 删除 / 导入导出）；
   在抽奖页设置本轮奖品后，用 `/render/prize` 作为奖品整屏场景（图片 + 大号名称 + 动态背景）。
6. **播控**：`/director` 编排，`/cast` 作为解说端透明源，`/replay` + `/transitions` 按需启用。

所有控制页共用一条 WebSocket 连接：`ui.mount()` 会自动连接；需要受众身份的字幕/导播页随后
`start({ audience })`，客户端会补发一次 `client:hello`，不会出现「页面看着正常但收不到定向消息」。

### 统一实现（避免同类逻辑各写一份）

| 能力 | 唯一实现 |
|---|---|
| 公共入口地址 / 二维码（签到、选曲） | `server/public-url.js` |
| 路由 `{ok,nack}` 响应 | `server/routes/http.js` |
| 公共接口限流 | `server/rate-limit.js` |
| 公共接口真实客户端 IP | `server/client-ip.js` |
| 公网入口（只开放签到 / 选曲） | `remote/`（Edge + Agent / 直连，独立进程） |
| 服务端页面清单（控制页 / 手机页 / OBS 源） | `server/pages.js` |
| 前端功能目录 + 顶栏 + 首页 + 输出页 | `public/shared/ui.js` 的 `CATALOG` |
| 选手选择弹窗 | `ui.playerPicker()` |
| WS 连接 / 身份补发 / watch 初值 | `public/shared/ws.js` + `ui.mount()` |

---

## ★ 设置界面

`/settings` 是本次新增的核心界面。所有配置项由**服务端 schema 驱动渲染**——
新增一个配置项只需要在 `server/config-schema.js` 里登记一行，设置页自动出现对应控件，
不需要改任何前端代码。

分区：

| 分区 | 内容 |
|---|---|
| **功能开关** ★ | 回放功能 / vMix 控制 / OBS 控制 / 回放转场 —— **默认全关**，见下节 |
| 服务 | 监听地址、Overlay / Control 端口、本机标识 |
| **OBS WebSocket** | host / port / password + **测试连接**（独立握手，不干扰活动连接） |
| **vMix HTTP API** | host / port + **测试连接**（含回放输入探测） |
| 场景与源 | `LIVE` / `REPLAY` / `CLEAN` 场景名，回放 NDI 与游戏音频源名 |
| 裁切参数 | 回溯量 XX 的默认值 / 上下限 / 步进 / 预设、出点模式、帧率、预警阈值 |
| 回放与时序 | 打点补偿 `markDelayMs`、转场超时兜底、轮询间隔… |
| 转场 | 进出回放转场与时长、场景覆盖表 + 一键写回 OBS |
| 提示 / 倒计时 / 编排 | 优先级配额、TTL、声音、回执策略、升级梯度、自动执行开关 |
| 渲染 / 媒体库 / 日志 | 画布尺寸、图片预加载、上传限制、缩略图、日志级别与保留期 |

### ★ 功能开关（默认全部关闭）

回放、vMix 控制、OBS 控制、回放转场都是**可启用功能，默认不启用**。
在 `/settings` 顶部的「功能开关」里勾选并保存即可，**无需重启**。

| 开关 | 开启后 | 依赖 |
|---|---|---|
| 回放功能 | `/replay` 页面、回放裁切/上屏/回程与回放轮询 | vMix 控制 |
| vMix 控制 | 连接 vMix HTTP API（心跳 + 全部调用） | — |
| OBS 控制 | 连接 OBS WebSocket（场景 / 源 / 转场） | — |
| 回放转场 | `/transitions` 页面、转场切换与场景覆盖重读 | OBS 控制 |

关闭状态下的实际行为（**不只是隐藏按钮**）：

- 服务端**不会连接对应设备、也不会轮询** —— 没有 vMix / OBS 的部署不会每 2 秒刷一条连接失败日志
- `/api/replay/*`、`/api/transitions/*` 返回 `403 feature_disabled`
- WS 命令 `replay.*` / `transitions.*` / `orchestration.*` 回 `nack feature_disabled`
- 顶部导航隐藏对应入口；首页卡片标灰并标注「未启用」；页面顶部有开启指引
- 首页链路状态与开播检查清单把这些项显示为「未启用」而不是「未连接」

行为要点：

- **字段路径级校验**：非法值会在**对应输入框下方**标红并给出原因（如 `clip.maxLookbackMs: 不能大于 600000`），
  而不是笼统的「配置错误」。
- **保存即生效**：改 OBS / vMix 地址会自动重连；
  改端口会提示需重启服务。
- **敏感字段掩码**：密码与令牌读出来是 `••••`，不改动则原值保留，且**不写日志**。
- **深链接**：`/settings#replay`、`/settings#cue` 这类锚点会定位到对应分区并做高亮脉冲。
- 导入 / 导出 / 恢复默认，Ctrl+S 快捷保存，离开页面前提醒未保存。

---

## 队伍、比赛模式与「队伍 + 选手名」

### 数据模型

| 实体 | 字段 |
|---|---|
| 队伍 `kind:'team'` | `name`（必填）、`image`（Logo，**可不设**）、`tags` |
| 选手 `kind:'player'` | `name`、`image`、`handle`、`side`、**`teamId`**（指向队伍实体）、`team`（旧的自由文本，兼容） |

- 队伍没设 Logo 时，界面用名称首字做占位，叠加画面只显示队名 —— **不会出现破图或空白方块**。
- 删除队伍会自动把成员的 `teamId` 清空，并返回被解绑的人数（`clearedMembers`），不会留下指向不存在队伍的幽灵引用。
- 老数据（只有自由文本 `team` 字段的选手）仍然能被解析出队伍名，只是没有 Logo。

### 比赛模式

`设置 → 比赛模式`（也可在 `/overlay` 顶栏直接切）：`team` 团队赛 / `solo` 单人赛。

| 模式 | 叠加表现 |
|---|---|
| **团队赛** `team` | 姓名条显示「队伍名 + 选手名」，有队伍 Logo 时一并显示 |
| **单人赛** `solo` | 队伍槽位被写成空字符串，模板 CSS 把整块队伍区域 **`display:none`** —— 不占高度、不留空位，只显示选手名 |

两种模式共用同一套模板，切换开关即可，不需要换模板。选手中途换队、队伍改 Logo 都会在下次填充时生效。

### 支持的模板

姓名条四套与对阵卡三套都带队伍槽位：

| 模板 | 队伍槽位 |
|---|---|
| `lowerThird` / `Neon` / `Minimal` / `Bold` | `teamName`、`teamAvatar` |
| `versusCard` / `Neon` / `Split` | `leftTeam`、`leftTeamAvatar`、`rightTeam`、`rightTeamAvatar` |

---

## 预览与直播输出分离

这是为了避免「试排版时不小心播出去」。

`/overlay` 顶栏有 **编辑目标** 下拉：

| 编辑目标 | 行为 |
|---|---|
| **预览**（默认） | 所有显示/隐藏/改值/队列**只作用于预览渲染端**（`/render/main?target=preview`），直播输出完全不动 |
| **直播输出** | 操作立即上屏；选中时会显示红色警示条 |

- 预览窗里的 iframe 在预览模式下显示 `preview` 目标，在输出模式下显示真实输出。
- 确认无误后按 **「⬆ 输出到直播」**：把预览的模板、槽位值、模式**一次性**推到 `main`（预览为空时则清空输出，所见即所得）。
- **「⟲ 从直播同步」**：把正在播的内容复制回预览，接着改。
- 两个目标各自维护独立的「已发 / 已渲染」状态，互不干扰。

### 直播输出的常驻控件

顶栏的「直播输出」区**始终可用，与编辑目标无关**：

```
直播输出  ● 输出中：姓名条   [⏹ 隐藏输出] [🗑 清空输出] [⟲ 从直播同步] [⬆ 输出到直播]
```

- 状态徽标实时显示直播上正在播什么（`● 输出中：姓名条` / `已隐藏：姓名条` / `输出：无内容`）。
- **「⏹ 隐藏输出」** 直接对 `main` 执行隐藏 —— 从预览推到直播后，如果解说已经在念下一段、需要立刻撤掉画面，
  不用先切到「直播输出」再点，**留在预览模式就能撤**。
- 隐藏只是不可见，模板与槽位值都保留；再点一次「⬆ 输出到直播」即可原样恢复。
- **「🗑 清空输出」** 才真正清掉模板与值。

> 实现上不需要第二个渲染进程：`/render/main?target=preview` 就是一个独立声明的渲染端，服务端按 target 精确投递。

---

## 导播端 / 解说端：走 OBS 输出，不用媒体服务器

现场确定**不使用 MediaMTX / WHIP / WHEP 等任何媒体服务器**。做法是把控制台页面本身
作为 **OBS 浏览器源** 加进场景，再用 OBS 的 **NDI 输出** 或 **HDMI** 送到监视器。

```
/director 、/cast 页面 ──OBS 浏览器源──► OBS 场景 ──NDI / HDMI──► 导播/解说的监视器
```

### 配置步骤

1. 在导播机 / 解说机浏览器里打开 `http://<主机>:3000/director?obs=1` 确认排版正常。
2. OBS 里新增「浏览器」源，URL 填：
   - 导播端：`http://<主机>:3000/director?obs=1`
   - 解说端：`http://<主机>:3000/cast?obs=1`
3. 源属性建议：1920×1080、自定义帧率 60、
   **`shutdown=false`**、**`restart_when_active=false`**（与浮窗源一致）。
4. 具体 URL：
   - 导播端：`/director?obs=1`（完整界面）
   - 解说端：`/cast`（**背景完全透明**，只画提示文字与倒计时，直接盖在画面上）
     - `?preview=1` 显示棋盘格底衬，便于看清透明区域
     - `?ack=1` 显示「收到」按钮（在普通浏览器里用；OBS 浏览器源点不了）
4. 需要送到别的屏幕时，对这个场景挂 **NDI 输出**滤镜，或用 HDMI 直接输出。

`?obs=1` 会：隐藏顶部导航条、隐藏帮助与日志卡、把字号整体放大一档（3 米外可读）。
去掉该参数就是普通网页模式，同一份页面两用。

### 为什么不再内嵌监看画面

浏览器不支持 NDI 协议；要在一个网页里显示实时画面，历史上只有两条路：
接媒体服务器（WHIP/WHEP、HLS），或服务端定时截图（延迟 1–3s）。
现场既然已经用 OBS 输出到监视器，再在网页里放一路画面就是重复投入，
所以**整套监看链路被移除**：没有 `monitor.*` 配置、没有 `/api/monitor/*`、
没有 `whep.js`、没有截图轮询。

导播页现在只显示**链路状态**：vMix / OBS / 浮窗渲染端数量 / 解说端已接入数量 / 声音解锁数量 / 回放相位。

> 如果将来又想加回网页内监看，SRS 附录 F 的 RC1–RC7 已经把三种方案的取舍列清楚了。

---

## 比分条 / 选手牌（模块 D）

比赛画面上的**常驻**比分组件：顶部比分条 + 左右两块选手牌。
它们在 **同一个浏览器源**（`/render/score`）里，OBS 里只多开这一路，而不是三路。

- **加一 / 减一只暂存**：点 `+` / `−` 后显示「35 → 36（待确认）」，
  按 **确认比分** 才真正改分并写入操作日志与审计日志；**取消**丢弃暂存。
  这样直播中误触不会直接改到画面上。
- **选手选择**：比分条两侧都有带搜索的选择弹窗（选手几十个也能翻），选中即同步到叠加预览。
- **清空选手**：每侧可单独清空，也可一键清空两侧；**1P / 2P 选手条始终保留**，没人时显示「待选」，不会空一块。
- **选手与叠加同步**：比分条的 P1（左 / A 侧）与 P2（右 / B 侧）就是叠加页的 A / B 阵容。
  - 在比分条选选手 → 写回 `overlay.lineup`，叠加页的**预览**实例同步变化（不直接动直播输出）；
  - 在叠加页给双人模板填人 → 比分条对应侧立刻显示同一个人；
  - **切换模板不清空人物**（双人 → 双人沿用阵容）；切到**单人模板**时不沿用（照常清空）。
- **两路独立显隐**：比分条、选手牌可以分别开关，整体也能一键隐藏。
- **持久化**：比分写在 `data/scoreboard.json`，赛中重启进程不会丢分。

OBS 添加方式：浏览器源 → `http://<主机>:3000/render/score`，
1920×1080、`shutdown=false`、`restart_when_active=false`，背景透明。

**独立窗口输出**：控制页右上角「打开输出窗口」会打开 `/render/score?window=1`
（普通浏览器窗口没有透明通道，会自动铺深色底并按窗口等比缩放，适合拖到副屏 / HDMI 输出）。
OBS 里请用不带参数的 `/render/score`，保持透明叠加。

### 分件输出（自己编排）

控制页「OBS 输出源（独立分件）」可以拆成三路，宽高自己填，位置在 OBS 里自己摆：

| 源 | URL | 默认尺寸 |
|---|---|---|
| 比分条 | `/render/score?part=bar&w=1180&h=104` | 1180×104（1×） |
| P1 选手牌 | `/render/score?part=left&w=470&h=116` | 470×116 |
| P2 选手牌 | `/render/score?part=right&w=470&h=116` | 470×116 |
| 合并（单路） | `/render/score` | 1920×1080 |

- 分件页面只画一个元件，**画布 = 设计尺寸 × 缩放**，与合并输出里同一元件的像素大小完全一致
- 合并输出里可以直接拖动元件改位置，也可以填 X / Y；缩放同时决定分件源的输出尺寸
- 控制页「布局与 OBS 输出源」按「设计尺寸 × 缩放」实时显示每路的输出宽高；「恢复默认布局」可复位
- 设计尺寸：比分条 1180×104，选手牌 470×116；比分条队名 30px、比分 52px
- 宽高在控制页里改，页面会记住（localStorage）；点「复制地址」直接粘到 OBS
- 预览始终显示合并画面（按实际排版），三路分件只用于 OBS 输出
- 分件模式下元件仍然尊重「比分条 / 选手牌 / 整体显示」三个开关

合并 vs 分件：合并只开一路，OBS 里最省资源；分件可以自由摆放，但每路是一个浏览器源。
两种都只维持一条 WS 连接（每页一条），渲染端仍然没有模板引擎与动画循环。

### 性能取舍

三块内容如果各开一个浏览器源，就是三份 CEF 进程、三份内存、三个 WS 连接；
合成 `/render/score` 一路时只需要一份。两种模式共用同一套轻量渲染端：

- 每个页面只有一条 WS 连接，服务端按 `score:state` 定向推送（不广播给无关页面）；
- 渲染端不引模板引擎、不建 Shadow DOM、不跑动画循环，DOM 结构写死；
- 每次更新只改发生变化的 `textContent` / `img.src`，图片加载完成前不显示；
- 分件模式只画一个元件，比整画布合成更省重绘；
- 断线保持最后一帧，绝不会在比赛画面上闪出错误文案。

---

## 比赛计分 / 选曲（模块 F）

### 一场比赛怎么记

`/match` 是比赛控制台。一场比赛（本局）固定有 **4 个曲目输入位**，实际打 1–4 首都行：

- **总分制**：每首曲目双方分数相加，总分高者获胜；
- **小局制**：每首曲目单独比高低，赢下的曲目多者获胜（平分的曲目不算任何一方）。
- 只录了一方分数时，这一行会出现在总比分画面（标「待录入」），但**不参与胜负聚合**；
- 某一行既没选曲、也没有任何分数时视为空行，**总比分画面不渲染它**，面板高度自动收缩；
- 曲目行可以标记「当前」，总比分画面用金色侧条 + `NOW` 提示当前曲目；
- 比赛名称可随时改；「结束本局并保存」会结算胜负并写入 `data/match.json` 的历史，之后本局锁定；
  「开启新一轮」清空曲目开始下一场（当前局还有内容时会先确认，并作为「未完成」存档）。

### 与比分条联动

比分条（`/render/score`）可以在两种来源之间切换：

| 来源 | 显示 | 手动 ±1 |
|---|---|---|
| `manual` | 原来的手动比分 | 可用（暂存 → 确认） |
| `match` | 本局的**总分**（总分制）或**胜局**（小局制），中间标签是本局名称 | 停用，改到 `/match` 录曲目分数 |

`/match` 开新局时会自动把比分条切到 `match`；也可以在比分条控制页或比赛页切回手动。
比赛结束后，比分条和总比分画面会标出胜方（`WIN`），并且**冻结当时的选手 / 队色**，
之后再改阵容不会改掉已经播出的结果。

### 总比分画面（独立整屏场景）

`/render/match`，1920×1080 **不透明整屏场景**，复用 `assets/` 下的
`直播间背景-动态.mp4` 作为动态背景（`直播间背景.png` 作为封面 / 视频失败时的兜底）。

- 画面顶部是场景标题栏，中间是两位选手（头像、姓名、队伍、队标、聚合分），
  下方是曲目表（曲名 / 曲师 / 难度与定数 / 双方分数 / 单曲胜负），底部是状态条；
- 空行不渲染，选手 + 曲目区在剩余高度里垂直居中，1–4 首时自动收缩；
- 比赛结束后显示胜者，选手 / 队色使用结束瞬间的快照；
- `/render/match?static=1` 强制只使用静态背景（视频解码有问题或想省 GPU 时用）。

OBS 里把它当作**独立场景**或整屏浏览器源：`http://<主机>:3000/render/match`，
1920×1080、`shutdown=false`、`restart_when_active=false`。它现在**不是透明叠加**，
不要和 `/render/score` 同时叠在同一个区域（比分条仍是独立的紧凑叠加）。

背景素材由服务端显式暴露为：

```
/assets/liveroom-background.mp4
/assets/liveroom-background.png
/assets/liveroom-background.svg
```

### 曲目库

曲目库保存在 `data/music.json`，支持**本地导入**与界面维护：

- 在 `/music` 上传 `.xlsx` 全量替换或手动添加 / 编辑 / 删除单曲；
- 用本地 `chunithm_songs.json` 更新国服标记与 WE 特殊谱面
  （把文件放在项目根目录；该文件已被 `.gitignore` 忽略，不随仓库分发）：

```bash
npm run music:cn
# → 文件里存在的曲目标记为国服，不存在标为日服
# → difficulty=5 的 WE 条目挂到 origin_id 对应的曲目
```

- **WORLD'S END 是特殊谱面**：默认不进入随机池；手机选曲页 / 比赛页勾选
  「包含 WE 特殊谱面」后才显示、才参与随机选曲。
- **封面**：把 `<曲目ID>.webp / .jpg / .png` 放进 `data/covers/`，或在 `/music`
  里编辑封面地址。该目录被 `.gitignore` 忽略，封面不随仓库分发。

管理接口是控制端 API，不在公网入口白名单里；手机选曲页仍然只读。

控制页的「选曲筛选」支持分类、难度、等级范围、仅国服、WE。选曲弹窗里可以搜索、
按难度直接点选、Ban / 取消 Ban、随机选一首。Ban 只作用于本局，不能 ban 已在曲目表里的歌。

### 扫码选曲

`/render/pick` 是二维码大屏（透明 OBS 浏览器源），`/pick` 是手机页面：

1. 选手扫码，选择自己是 P1 还是 P2；
2. 搜索曲名 / 曲师，点一个难度，提交；
3. 提交只进入 `/match` 的「扫码选曲请求」队列，**不会直接改画面**；
4. 导播点 `→1` … `→4` 指定放到哪一行（或「忽略」）。

手机页限流 30 次 / 分钟 / IP；同一侧同一曲目重复提交只保留一条。
二维码地址优先用「设置 → 比赛计分与选曲」里的公网地址，其次局域网地址，
最后用操作员当前访问地址 / 自动探测局域网 IP。

---

## 抽奖 / 现场签到（模块 E）

### 界面与输出

- `/lottery`：抽奖控制台。左边抽奖台（大屏预览、开始抽奖、重置）、**本轮奖品**（名称 / 图片 /
  备注，可上传到媒体库或直接打开奖品大屏），右边现场签到二维码、
  **签到名单（可直接搜索 / 编辑 / 删除 / 添加）** 与中奖记录，下方是抽奖池。
- `/guests`：**完整签到管理**。搜索 / 按来源筛选 / 分页；手动添加、编辑姓名/昵称/队伍、删除、清空；
  导入在线表格 CSV；导出签到名单 CSV；显示签到二维码与序号；已中奖的人会标出来。
  编辑与删除弹窗与抽奖页共用 `ui.guestEditor` / `ui.deleteGuest`，行为完全一致。
- `/render/lottery`：透明的 OBS 浏览器源。待机全透明；抽奖中滚动名字；揭晓时显示中奖卡与彩带。
- `/render/prize`：**奖品整屏场景**（不透明）。复用直播间动态背景，本轮奖品的图片完整显示
  （`object-fit: contain`，任意比例不裁切），背后用同图模糊铺满屏幕；奖品名称大号居中。
  抽奖中 / 揭晓后状态条与中奖者会同步更新。`?static=1` 用静态背景，`?window=1` 独立窗口。
- `/join`：手机扫码打开的签到页（不需要导航、不需要登录）。

抽奖池可以按类型勾选：**选手 / 解说·导播·主持 / 赞助商 / 队伍**，再按标签过滤；可以包含「现场签到」的人，也可以设置「中奖后移出池子」。
中奖者在动画开始时就已选出，但**动画期间不下发结果**，到点才揭晓；中奖记录与签到名单保存在 `data/lottery.json`。

### 图片上传安全

- **媒体库只收静态位图**：`POST /api/media/upload` 只接受 **PNG / JPEG / GIF / WebP**。
  mp3 / wav / mp4 / exe / sh / txt / zip 等一律 400「只接受图片」；**SVG 一律拒绝**
  （SVG 可携带 `<script>` / 事件属性 / 外链，属可执行内容，同源下能做 XSS / 越权）。
  这条由代码硬性保证，`config.media.allowedTypes` **无法放宽**（防止改配置重新放开）。
- **单张上传**：媒体库上传接口 `files:1`，一次多传直接 400「一次只能上传一张图片」；
  旧的批量上传入口已移除。
- 奖品图片入口 `POST /api/lottery/prize/image` 同样**只接受一个文件**，只允许
  **PNG / JPEG / GIF / WebP**。
- **不信任扩展名和 Content-Type**：按 magic bytes + 文件结构（PNG IEND / JPEG EOI / GIF trailer /
  WebP RIFF 长度）+ sharp 真实解码三重校验。扩展名与实际格式不一致、HTML / EXE / 截断文件都会被拒绝。
- 单文件上限：媒体库 20MB、奖品图片 10MB；图片像素总量上限 4000 万，防止解压炸弹。
- 上传成功后媒体库记录 `uploaderIp`、`uploadedAt`、`source`；奖品设置里也会保存
  `{ ip, at, hash }`，抽奖页和媒体详情都能看到「上传时间 / IP」。
- 奖品图片在媒体库中属于被引用资源，删除前会被引用检查拦住。

### 网络操作日志（单独文件）

所有网络操作都记进 **`logs/network-YYYYMMDD.jsonl`**，与普通控制台日志 `console-*.jsonl` 分开：

- **HTTP 请求**：每个请求记录 IP / 方法 / 路径 / 状态码 / 耗时 / User-Agent / body 大小；
- **WebSocket**：连接与断开（IP / 受众 / target / 时长）；
- **上传**：媒体库 / 奖品图片 / 曲目 xlsx，记录文件名、大小、成功与否、来源 IP；
- 限流 429、封禁 403 也随 HTTP 状态码一起落盘。

敏感字段（token / password / authorization 等）自动掩码。日志页可通过 `GET /api/logs/network`
读取最近的内存缓冲与文件清单。

### 服务进程不执行任何 OS 命令

主控制台**不会**执行任何 shell / 子进程命令，也不会替你在系统里打开软件：

- 设置页原来的「打开目录」按钮（曾用 `explorer` / `xdg-open` 调系统命令）已移除，
  改为「复制路径」，由你自己在资源管理器里粘贴打开；
- 服务端 `server/` 目录内不引入 `child_process`（有单元测试锁死这条不变量）；
- 路径类配置字段（`media.dir` / `templates.builtinDir` / `templates.customDir` / `entities.file`）
  拒绝 shell 元字符与控制字符，防止被拼进命令注入。

### 文件访问范围只限于项目目录

- 媒体目录、模板目录、实体库文件的路径由**配置**决定，所以这些路径现在被**强制解析到项目目录内**
  （`withinRoot`，越界 / 含 `..` 段 / Windows 保留设备名一律返回 null 并回退默认值）；
  不能借改配置把媒体 / 模板 / 实体目录指到程序之外去读写、删除任意文件。
- 模板 `id` 会拼进 `path.join`，删除时已校验格式，拒绝 `../` 路径穿越（防止删任意 `.json`）。
- 媒体文件按内容 hash 命名，删除按 hash 查索引，不存在用户可控文件名。
- **目录直投扫描也做内容校验**：丢进 `media/` 的「`.png` 扩展名、实为 SVG/HTML 等」假图片会被
  识别并清掉，不会进媒体库。
- 测试 / 隔离用受信环境变量 `LP_ENTITIES_FILE` 等指向临时目录，这些是启动进程自己设置的，
  不属于「可被远端改配置」的面。

### 后台登录密码（控制接口鉴权）

- 后台密码**只存 scrypt 散列**（`server.adminPasswordHash`，格式 `scrypt:salt:hash`），明文永不落盘，
  配置泄露也拿不到密码。用 `node tools/set-admin-password.mjs` 设置 / 重置。
- 密码非空时，`/api/*` 的**所有读写**（公开路径与渲染源只读接口除外）都要求
  `Authorization: Bearer <密码>`，否则 401；**WebSocket 控制命令同样受保护**，
  前端会在 `client:hello` 里带上密码，未带密码的 `cmd` 一律 nack `unauthorized`。
- 也支持 `LP_ADMIN_TOKEN=<明文令牌>` 环境变量（用于脚本 / 自动化，优先于密码散列）。
- 密码为空 = 保持原来的局域网信任模式（什么都不拦）。
- **防爆破**：同一 IP 10 分钟内登录失败 5 次 → 锁定 15 分钟（HTTP 429 + `Retry-After`）；
  继续失败翻倍，最长锁 24 小时；登录成功 / 改密成功清零。
- 现场签到 / 扫码选曲等公开路径、OBS 渲染源需要的只读接口（`/api/render/bootstrap`、
  `/api/match/pickUrl`、`/api/health`）无需密码，手机和浏览器源照常工作。
- 前端第一次遇到 401 会弹出密码输入框（掩码），输入一次后存进 `localStorage`，之后自动带上。
- 监听非回环地址且未设置密码时，启动日志会明确告警。

### 后台密码设置页 `/admin-setup`（仅内网）

- 独立页面，**只接受内网 / 本机请求**（回环、RFC1918、链路本地、IPv6 ULA），
  公网访问直接 403；判定只看 socket 地址，**不信任 `X-Forwarded-For`**。
- 可初始化密码或修改密码：修改已设密码时必须提供当前密码；新密码至少 8 位，
  只以 scrypt 散列写入配置。重复输错同样受上面的防爆破锁定。
- 支持 `GET /api/admin/status`（是否已设密码 / 外网开关 / 被锁定 IP / 风险操作）、
  `POST /api/admin/password`（改密）、`POST /api/admin/public-access`（外网输出开关）、
  `POST /api/admin/unblock`（解除某个 IP 的登录锁定），全部只对内网开放。
- 忘记密码时，在服务器上运行 `node tools/set-admin-password.mjs` 重置。
- ⚠️ 如果服务放在反向代理后面，所有请求都会显示为 `127.0.0.1`，这个页面会失去「仅内网」保护；
  此时请改用 `LP_ADMIN_TOKEN`，并限制代理来源。

#### 外网访问 OBS 输出（默认禁止）

- OBS 渲染源 `/render/*`、背景素材 `/assets/*`、媒体库 `/media/*`、
  渲染端启动数据 `/api/render/bootstrap`、`/api/match/pickUrl` 都**不需要登录密码**，
  默认**只允许内网访问**；公网请求直接 403，并写入 `external-blocked` 风险日志。
- 页面上的「允许外网访问 OBS 输出」开关可临时放开（需要当前密码），写入
  `server.allowPublicOutputs`；内网其他机器始终可以正常访问。
- 现场签到 `/join`、扫码选曲 `/pick` 及其公开 API **不受此开关影响**，公网照常可用。
- 「安全状态」面板展示：被拉黑 / 锁定的 IP（失败次数、锁定时长、来源时间，可手动解除）
  与最近风险操作（登录失败、锁定、外网访问输出被拦、WS 未授权命令、上传失败、HTTP 4xx 等），每 5 秒刷新。

> 所以即使 `:3000` 被误暴露：**无法运行系统命令 / 打开无关软件，无法越权读写项目目录之外的文件，
> 也无法在不知道后台密码的情况下改配置、上传文件或通过 WebSocket 控制直播**；
> OBS 输出默认也不对公网开放。最稳的做法仍是别把 `:3000` 暴露到公网，
> 需要公网只走 `remote/` 的公网入口（见上文）。

### 现场扫码签到

- 控制台会显示二维码，手机连现场 Wi-Fi 扫码，填姓名（可选昵称/队伍）即可加入。
- 同一姓名 + 昵称重复提交会被忽略；每个 IP 每分钟最多提交 10 次。
- 如果控制台是用 `localhost` 打开的，二维码会自动改用本机局域网 IP；也可以在「设置 → 抽奖与签到」里填死「局域网签到地址」。
- 二维码由服务端本地生成（`/api/lottery/qr`），不依赖任何在线服务。

### 让不在内网的朋友加入：三种中继方式

**① 独立的公网远端入口（推荐）**

不要把主控制台的 `:3000` 直接暴露到公网 —— 它包含大量无鉴权的控制接口。
本项目提供一个**单独运行的远端进程** `remote/`，只转发：

```
/join  /pick  /shared/style.css
/api/music  /api/music/meta  /api/match/public
/api/match/pick  /api/lottery/join
```

其余路径（控制台、OBS 源、比分、设置、WebSocket）一律 404 / 405。
它自带限流、body 上限、并发 / 连接上限、安全响应头和健康检查。

按两台机器所在的网络选一种：

```bash
# A. 分离网络（公网机器 + 无公网的本体）
#    公网机器：
cp remote/edge.config.example.json remote/edge.config.json   # 编辑 agentToken / TLS
npm run edge
#    内网机器（主控制台一侧）：
cp remote/agent.config.example.json remote/agent.config.json # 编辑 edgeUrl / token / localUpstream
npm run agent          # Agent 主动出站，内网不需要任何入站端口

# B. 同网络直连（远端能直接访问主控制台，默认 :8787 → 上游 :3000）
cp remote/config.example.json remote/config.json   # 编辑 upstream / token / TLS
npm run remote
```

然后在主控「设置」里把**公网签到地址 / 公网选曲地址**填成公网 Edge（或直连远端）的地址
（例如 `https://event.example.com`），二维码会自动指向 `.../join` / `.../pick`。

- 有公网 IP：路由器只把远端端口转发出去，主服务端口保持内网；
- 没有公网 IP：用 Cloudflare Tunnel / ngrok / frp 把**远端端口**映射出去（不要映射 3000）；
- 建议给主服务设置 `LP_REMOTE_TOKEN`（与远端 / Agent 的 `remoteToken` 一致），这样限流会看到真实客户端 IP。

完整架构、部署、TLS、Caddy / nginx、systemd、抗攻击说明见 **[remote/README.md](remote/README.md)**。

**② 在线表格导出 CSV → 粘贴导入（最稳）**

腾讯文档 / 金山文档 / 问卷星 / Google Forms 收到报名后导出 CSV，
在抽奖控制台点「导入在线表格」，把内容粘进去即可。列顺序：`姓名,队伍,昵称`，首行含「姓名」会自动当表头跳过。
不需要公网入站，也不依赖任何第三方接口。

**③ 第三方中继轮询（可自动化，推荐给远程报名）**

在线表单的 webhook → 云函数（Cloudflare Worker / 腾讯云函数 / Vercel）或飞书多维表格自动化 → 保存成 JSON；
本服务定时**主动拉取**这个 JSON，不需要公网入站。

在「设置 → 抽奖与签到」填写：

- 中继 URL：`https://your-worker.workers.dev/entries`
- 中继 Token（可选）：会以 `Authorization: Bearer <token>` 发出
- 轮询间隔：默认 15 秒（最小 3 秒）

中继端点返回以下任一格式即可：

```json
{ "entries": [
  { "id": "row-123", "name": "张三", "handle": "小张", "team": "红队" }
] }
```

也接受纯数组，或字符串数组（只有姓名）。`id` 用于去重；没有 `id` 时按「姓名 + 昵称」去重。

一个最小的 Cloudflare Worker 示例（KV 绑定 `LOTTERY`）：

```js
export default {
  async fetch(req, env) {
    if (req.method === 'POST') {                 // 在线表单 webhook 推过来
      const body = await req.json();
      const list = (await env.LOTTERY.get('entries', 'json')) || [];
      list.push({ id: body.id || crypto.randomUUID(), name: body.name, handle: body.handle, team: body.team });
      await env.LOTTERY.put('entries', JSON.stringify(list));
      return new Response('ok');
    }
    const list = (await env.LOTTERY.get('entries', 'json')) || [];  // 本服务来拉取
    return Response.json({ entries: list });
  },
};
```

飞书多维表格 / Google Forms + Apps Script 都可以在「新增一行」时 POST 到这样的 Worker；表单本身不需要支持内网地址。

> 建议：现场内网手机用 ①或直接扫码；远程/外场报名用 ②或 ③。三者可以同时用，重复的人会被去重。

## OBS 侧配置（必须严格遵循，否则回放链路不成立）

### 场景结构

```
源面板
  ├─ 游戏采集              （窗口/采集卡）
  ├─ 选手摄像头
  ├─ 浮窗-主               ← 浏览器源 /render/main     ★ 全局共享实例
  ├─ vMix 回放             ← NDI Source，指向 vMix Output 2
  ├─ REPLAY 标识
  ├─ 浮窗-致谢             ← 浏览器源 /render/credits
  └─ 比分条                ← 浏览器源 /render/score（比分 + 两块选手牌）

场景
  ├─ CLEAN   ← 唯一送往 vMix 的场景
  │    ├─ 游戏采集
  │    ├─ 选手摄像头
  │    └─ 【滤镜】NDI Dedicated Output   ★ 挂在场景上，不是「工具 → NDI 输出设置」
  ├─ LIVE    ← 场景源 CLEAN + 浮窗-主
  └─ REPLAY  ← vMix 回放 + 浮窗-主（与 LIVE 共用同一个源实例）+ REPLAY 标识
```

### 浏览器源属性（`浮窗-主` / `浮窗-致谢` / `比分条`）

```
宽度 × 高度：1920 × 1080
自定义帧率：  60（或与画布一致）
✅ shutdown              = false     ← 必须
✅ restart_when_active   = false     ← 必须
```

设错的后果：源隐藏时 CEF 进程会退出，再显示时重连丢状态（表现为浮窗空白或内容错乱）。

### 几个最容易踩的坑

| 坑 | 后果 |
|---|---|
| 送 vMix 的 NDI 用了 OBS **主输出**而不是 Dedicated Output 滤镜 | 无限镜像循环 |
| 浮窗放进了 CLEAN 场景 | 回放画面被烧录浮窗，且出现两层浮窗 |
| LIVE 场景用了 vMix 回传画面 | 直播音画永久偏移 L |
| OBS 画布 / NDI 输出 / vMix 回放会话**格式不一致**（含 59.94 vs 60） | 回放整体不可用 |
| stinger 的 Transition Point 想通过 API 改 | 改不了 ✅，必须在 OBS 内手动设在不透明区正中 |
| 制作机上装了 VPN / Tailscale | NDI 发现失效 ✅（官方明确警告） |

### 开播检查清单

首页与 `/api/checklist` 提供 24 项检查。附录 C 原本标注「无法程序检测」的项目里，
**下面这些其实可以通过 obs-websocket 只读查出来**，本实现已自动核验：

| 检查 | 手段 |
|---|---|
| 浏览器源 `shutdown=false` / `restart_when_active=false` | `GetInputSettings` 读真实设置值 |
| 浏览器源分辨率与画布一致 | 同上 |
| CLEAN 场景上挂了 **NDI Dedicated Output 滤镜** | `GetSourceFilterList` + `GetSourceFilterKindList` |
| 浮窗**没有**混进 CLEAN 场景 | `GetSceneItemList(CLEAN)` |
| vMix 回传 NDI 源的音频已关闭 | `GetInputMute` + `GetInputAudioTracks` |

确实查不到的（NDI 会话格式、vMix Output 2 配置、stinger Transition Point、
网络配置文件、是否装了 VPN 等）仍然明确标注 **「须人工确认」**，不假装能检测。

---

## 架构

```
┌──────────────────── 共享壳层 ────────────────────┐
│ 连接池 · 共享状态源 · 配置服务 · 日志服务 · WS 广播中枢 │
│ 同一个 Web 应用，多页面路由                          │
└──┬────────────────┬────────────────┬─────────────┘
   │                │                │
┌──▼─────────┐ ┌────▼───────┐ ┌──────▼─────────┐
│  模块 A    │ │   模块 B   │ │    模块 C      │
│ 图形叠加   │◄┤ vMix 回放  ├►│ 提示 / 编排    │
└────────────┘ └────────────┘ └────────────────┘
```

### 目录

```
assets/               直播间背景 / 模板素材（PNG / SVG / MP4）
config/               运行时配置 + 公网密钥说明
data/                 运行数据（entities / lottery / match / scoreboard / music）
data/source/          曲目库导入源 ChunithmMusicData.xlsx
docs/                 需求.md（SRS）
logs/                 JSONL 结构化日志（按天滚动；console-*.jsonl 控制台 + network-*.jsonl 网络）
media/                媒体库（原图 / 缩略图 / 1x / 2x）
templates/            内置 + 自定义叠加模板
server/
  index.js            装配入口（单进程监听 :3000 + :3001）
  config.js           配置读写 + schema 校验 + 变更副作用
  config-schema.js    ★ 唯一真源：默认值 + 字段 schema（同时驱动设置页）
  logger.js           JSONL 结构化日志 + 网络操作独立日志 + 检索 + 保留期
  state.js            共享状态源（hello / patch 的数据源）
  ws-hub.js           WS 广播中枢（协议 / 受众过滤 / cmd ack-nack / 二进制帧）
  obs.js              自实现 obs-websocket v5 客户端（含自实现重连退避）
  transitions.js      OBS 转场控制 + 场景覆盖低频重读
  vmix/client.js      vMix HTTP 调用 + 心跳 + callOnChannel 强制选通道
  vmix/functions.js   ★ 151 个回放函数全表（含单位 / 目标 / 危险标记）
  vmix/xml.js         自写宽容 XML 解析器
  replay/engine.js    ★ 状态机 + 宏序列 + 状态回读 + 意图对账 + 只读预检
  cue/engine.js       提示引擎（优先级仲裁 / TTL / 回执 / 历史）
  cue/countdown.js    单调时钟倒计时（自适应 tick / 渐进升级 / hold·extend·cancel）
  cue/orchestration.js 编排 + B/OBS 事件联动 + 转场大提醒意图对账
  overlay.js / media.js / templates.js / entities.js
  image-validate.js  ★ 图片内容校验（magic / 结构 / sharp 解码；拒绝伪装与脚本）
  admin-auth.js      ★ 后台密码鉴权（scrypt / 防爆破 / WS token / 锁定列表）
  public-access.js   ★ OBS 输出的外网访问开关（默认仅内网）
  routes/admin.js    后台密码 / 外网开关 / 安全状态接口（仅内网）
  score.js            ★ 比分条 / 选手牌（暂存→确认 / 与叠加阵容同步 / 持久化）
  match.js            ★ 比赛计分（总分 / 小局 / 空行自适应 / ban / 扫码选曲 / 历史）
  music.js            曲目库（搜索 / 随机 / 难度色；数据来自 data/music.json）
  public-url.js       ★ 公共入口地址解析 + 二维码（签到 / 选曲共用）
  client-ip.js        ★ 公共接口真实 IP（远端 token / loopback XFF）
  rate-limit.js       ★ 公共接口限流（签到 / 选曲共用）
  pages.js            ★ 页面路由清单（控制页 / 手机页 / OBS 源统一登记）
  routes/http.js      ★ 路由统一响应格式
  routes/             HTTP API（含 routes/score.js、routes/match.js、routes/music.js）
public/
  shared/ui.js        ★ 全前端共用：目录 CATALOG / 顶栏 / 首页 / 输出页 / 选手选择器
  shared/             其余全前端共用（ws / format / audio / style）
  outputs.html        ★ 输出与场景：全部 OBS 源 / 公共扫码入口 / 连接状态
  guests.html         ★ 签到管理：名单增删改 / 导入导出 / 二维码
  music.html          ★ 曲目库管理：增删改 / 上传 xlsx / 搜索筛选
  admin-setup.html    ★ 后台密码设置（仅内网；初始化 / 修改登录密码）
  render/             ★ OBS 浏览器源（浮窗渲染引擎 + 比分条 + 总比分画面 + 奖品大屏 + 选曲二维码）
  pick.html           手机扫码选曲页（公开、限流）
templates/builtin/    19 套，按「图形族 × 风格」组织：
                      姓名条 转播/霓虹/磨砂/街机/白底/粗排/极简
                      对阵卡 转播/霓虹/对抗色/斜切/极简
                      双人名牌 转播/霓虹/连体
                      比分条 · 滚动致谢 · 网格致谢 · 角标
tools/                mock-vmix / mock-obs / mock-run / selftest
remote/               ★ 公网入口：edge.mjs（公网机）+ agent.mjs（内网机）
                      setup.mjs / setup.html 两端图形配置台
                      一键启动：start-edge-gui.bat / start-agent-gui.bat
                      start-main.mjs 带 LP_REMOTE_TOKEN 启动主控
                      index.mjs 直连模式；只开放签到 / 选曲
test/                 node:test 单元测试
```

### WS 协议

连接后客户端先发 `client:hello` 声明受众 / 角色，服务端立即回 `hello`（全量状态）。
之后状态变更走 `patch` 增量；命令走 `{t:'cmd', id, op, args}` 并等 `ack`/`nack`（5s 超时）。

模块 B 的事件通过 `{t:'replay:event', event:'air:start', data:{...}}` 下发，
与通用命名空间隔开。

---

## 关键实现说明

### 帧与秒的单位（陷阱 #19）

这是最容易出**数量级**错误的地方，所以集中固化：

- `ReplayMarkInOut{Value}` 的 Value 单位是**秒**。
- `ReplayMoveSelectedIn/OutPoint{Value}` 与 `ReplayJumpFrames{Value}` 的单位是**帧**。
- 前端一律通过 `fmt.framesToMs()` / `fmt.framesLabel()` 换算，`/replay` 页的每个微调按钮
  都显示「+10 帧（+167ms @60fps）」。
- `ReplayJumpFrames` 的单位存疑（R14：官方描述与直觉相反），标记为 `frame-ambig` 并在 UI 上明确警告。

### None 参数函数（陷阱 #18）

`ReplayMarkIn` / `ReplayMarkOut` / `ReplayMarkCancel` / `ReplayMarkInLive` /
`ReplayMarkInRecorded` / `ReplayMarkInRecordedNow` 官方参数为 `None`，作用于**当前选中通道**。
不先选通道就会砍掉**另一个通道**的事件。

本系统在三个层面固化这条约束：

1. `vmix/functions.js` 把它们标记为 `needsChannel: true`；
2. `vmix/client.js` 的裸调闸门直接抛 `needs_channel` 错误；
3. `vmix/client.js` 的 `callOnChannel()` 是唯一合法出口，内部先发 `ReplaySelectChannel{A|B}`；
4. `test/functions.test.js` 断言这 6 个函数正好是这 6 个。

`ReplayStop` **不是有效函数**（已核验），代码里显式拦截并提示改用 `ReplayStopEvents`。

### 三个延迟不能混用（G-REQ-106）

| 延迟 | 符号 | 量级 | 用途 |
|---|---|---|---|
| 回路延迟 | **L** | 130–300ms | 打点补偿（`markDelayMs`） |
| 监看延迟 | **D** | 200–3000ms | 已不由本系统测量（画面走 OBS 监视器） |
| 转场遮罩窗口 | **W** | 200–600ms | stinger 不透明区宽度 |

打点补偿 `markDelayMs` 现在直接在「设置 → 回放与时序」里填写（不再有校准页）。

### 防穿帮（§5.14）

> 只允许一个「可见转场」，且它必须有一段**完全不透明的中段**，中段宽度 > 回路延迟 L。

vMix 侧所有切换一律硬切（Cut）；OBS 侧是唯一的可见转场，程序同时发出 vMix 回放命令
和 OBS 切场景指令，把实际的场景切换藏在遮罩盖满屏幕的那一刻。

转场完成判定采用**事件 + 超时兜底双保险**（任一先到即继续），并在日志里记录实际走的是哪条路径。

---

## 已验证 / 未验证

`npm run selftest` 覆盖 148 项断言，其中几条是专门针对「现场会静默翻车」的：

- ✔ 全程未出现 `ReplayStop`
- ✔ 所有 `None` 参数函数之前都先 `ReplaySelectChannel`
- ✔ 回程**未调用** `ReplayLive`，且用 `ReplayPause` 停在最后一帧
- ✔ 宏执行中三次并发点击只有一次被接受（busy 锁）
- ✔ 持久 `CUED` 静置 8.5s 仍不被 4s 瞬态超时误判（陷阱 #22）
- ✔ 裁切过程**未向 OBS 发任何请求**（裁切 ≠ 上屏）
- ✔ 帧级微调传的是帧不是秒
- ✔ 播放头位移后会提醒回位，`ReplayJumpToNow` 能清除标记
- ✔ 非法配置被拒绝且返回字段路径
- ✔ 媒体服务器相关接口已移除（`/api/monitor/link` → 404），设置页不再有 `monitor.*` 字段
- ✔ `recording=false` 时编排被拒绝且**不启动**倒计时
- ✔ 28 个页面路由全部返回 200；比分 / 选曲 / 抽奖渲染端背景透明，总比分与奖品大屏是整屏场景且复用直播间动态背景；渲染端不含任何错误文案
- ✔ 自动核验浏览器源 `shutdown`、NDI 滤镜、浮窗未混入 CLEAN、NDI 音频已关
- ✔ **我方操作零误报**为「检测到外部操作」，且全程不进入 FAULT
- ✔ 固定长度的裁切真的被截成 L 秒（vMix 回报的 duration 会核对）
- ✔ 延长尾部可重复调用（开放出点模式的前提）
- ✔ 双人一键投递不会把两个人填成同一个人（`filled.aName !== filled.bName`）
- ✔ 只选一个人投双人模板时明确拒绝（`need_two_entities`）
- ✔ 双人模板「点一下填 A 位、再点一下填 B 位」：第一次点击只动 A 侧，B 侧保持空
- ✔ **预览上的任何操作都不影响直播输出**，commit 才推过去
- ✔ 留在预览模式也能直接隐藏直播输出，且预览保持可见
- ✔ 团队赛填充带上队伍名与 Logo；**单人赛会把队伍槽位清空**，不残留上一队
- ✔ 删除队伍会解绑成员并返回 `clearedMembers`，不留幽灵引用

单元测试另外守住的不变量（共 317 项）：

- ✔ 保存配置不会丢掉任何配置节（回归：曾把 `version` / `templates` / `entities` 等整节删掉）
- ✔ 撤销恢复的是**上一个**值（回归：曾因先改状态后快照而等于没撤销）
- ✔ 一条 patch 只广播一次（回归：两个端口各注册了一份监听器，消息翻倍）
- ✔ `hello` 之后不再回放历史 patch（否则旧增量会盖掉新快照）
- ✔ 每个内置模板声明的槽位都在 HTML 里有绑定（否则「填了值画面不变」）
- ✔ 三种裁切模式（即时 / 开放出点 / 固定长度）语义正确
- ✔ 多值槽位在插值**之前**抽取行原型（回归：曾导致网格致谢整片空白）
- ✔ 多值槽位**与槽位类型无关**都走行渲染（回归：`text+multi` 的致谢条目曾一条都渲染不出）
- ✔ 滚动致谢用 rAF 驱动而非 CSS animation（回归：曾「滚一下弹回去」）
- ✔ `text` 类型的多值槽位（致谢条目）不会被 `String()` 压成 `[object Object]`
- ✔ 配置里的字符串会去掉首尾空白（回归：`0.0.0.0 ` 尾随空格曾让服务完全起不来）
- ✔ **输入弹窗点「确定」能拿到值**（回归：`close()` 同步触发 `onClose` 抢先 `resolve(null)`，
     导致「试发 / 快速提示」点了完全没反应；用 jsdom 真实点击钉住）
- ✔ 回放 / vMix / OBS / 转场四个功能开关**默认全关**，且都登记在设置页
- ✔ 分离网络隧道（真实 WS 端到端）：Agent 出站接入后公共页 / 接口可达，
     控制接口仍 404，上游 `set-cookie` 被剥离，body 上限 413，签到超限 429，
     Agent 掉线返回 503 并可自动重连，错误 token 无法接入
- ✔ 两端图形配置台：只接受本机 Host、读写接口都必须带临时令牌、配置校验与落盘、
     密钥按 32 字节 base64url 生成、能真实启动 / 停止 Agent、已运行的主控不会被重复启动
- ✔ 签到人员编辑 / 删除共用组件：新增走 POST 并补拉 state、编辑走 PUT、删除必须二次确认
     且取消不发请求；抽奖页与 /guests 使用同一套弹窗
- ✔ 曲目库管理：手动增改删会重算分类 / 国服 / 封面计数；xlsx 导入先备份旧库，坏文件不会破坏现有数据
- ✔ 曲目封面：cover 字段校验、xlsx 重导入保留封面、/covers 受外网输出开关保护
- ✔ 奖品设置：名称 / 图片 / 备注持久化，`javascript:` 等非图片协议被丢弃；
     奖品大屏是整屏场景，图片 contain 完整显示并复用动态背景
- ✔ 抽奖页点「编辑奖品」必须打开弹窗（回归：漏解构 `modal`，点击后毫无反应）
- ✔ 图片上传校验：真实 PNG 通过；HTML / EXE / 截断 PNG / 伪装扩展名被拒绝；
     SVG 一律拒绝（可执行内容），上传记录来源 IP 与时间，奖品设置持久化 `meta`
- ✔ 服务进程零 OS 命令执行：`server/` 内不得出现 `child_process`，「打开目录」接口已移除；
     路径类配置字段（media.dir / templates.* / entities.file）拒绝 shell 元字符与控制字符
- ✔ 媒体库只收图片、单张：mp3 / wav / exe / txt / zip 即使 `allowedTypes` 允许也被拒绝，
     伪装成 .png 的非图片被内容校验拦截；上传接口不再支持批量（`files:1`）
- ✔ 文件访问范围：媒体 / 模板 / 实体路径强制落在项目目录内（`withinRoot` 拒绝越界、
     `..` 段与 Windows 保留设备名），模板删除 id 拒绝 `../` 路径穿越，
     实体库支持 `LP_ENTITIES_FILE` 受信隔离
- ✔ 网络操作日志：HTTP / WebSocket / 上传分别记进独立的 `logs/network-*.jsonl`，
     敏感字段掩码，内存缓冲可查
- ✔ 后台登录密码：scrypt 散列存储（明文不落盘）、正确/错误密码判定正确，
     未授权读写 401、大小写路径不能绕过，WebSocket 控制命令同样校验；
     目录直投扫描会清掉「扩展名是图片、内容非图片」的假文件
- ✔ 防爆破：同一 IP 连续失败 5 次锁定（429 + Retry-After），锁定期内正确密码也拒绝，
     其他 IP 不受影响；登录成功清零
- ✔ 后台密码设置页：只接受内网 socket 地址（伪造 XFF 无效），改密必须验证当前密码，
     新密码只写散列
- ✔ 外网输出开关：默认禁止公网访问 `/render` `/assets` `/media` 等无鉴权输出（403 + 风险日志），
     内网与公共签到/选曲不受影响；开关需要当前密码并持久化
- ✔ 安全面板数据：被锁定 IP 列表与风险操作（鉴权失败/锁定/外网拦截/WS 未授权/上传失败/HTTP 4xx）

**未验证（需要真实硬件与现场实测）**：附录 F 的 R1–R15 与 RC1–RC8 全部是待实测项，
`/` 首页的开播检查清单会把能自动核验的部分逐条列出。其中最关键的几条仍需现场实测：

- **R1** 通道处于回放态时 `recording` 是否仍为 `True` —— 决定回程能否一直用 `ReplayPause`
- **R7** 实测回路延迟 L —— 决定 `markDelayMs` 的默认值
- **R10** 回放会话的实际缓冲容量 —— 决定 `clip.maxLookbackMs` 的上限
- **R14** `ReplayJumpFrames` 的单位究竟是帧还是秒
- ~~RC1 / RC5 / RC6~~ 已不适用（不再使用媒体服务器）

---

## 已知取舍与未完成项

1. **SRS 正文与附录 A 的一处不一致**：B-REQ-2003 写「→ 输出」类函数共 6 个，
   但附录 A.6 实际只标注了 **5 个** ★ 上屏函数。本实现以附录 A 的函数表为准，
   并在 `server/vmix/functions.js` 里注明。
2. **vMix HTTP 参数命名**：按 SRS B-REQ-1001 的描述使用具名参数
   （`?Function=X&Value=Y&Channel=A`）。个别 vMix 版本可能只认 `Value`，
   首次联调时请用 `/replay` 的开发模式面板直调一次确认。
3. **`sharp` 是可选依赖**：缺失时缩略图与多分辨率派生会降级为「使用原图」，
   设置页与媒体库会明确标出降级状态（降级不静默）。
4. **未做真实浏览器目检**。全部验证是协议级 + 语法级 + DOM stub 级的：
   页面能 200、脚本无语法错误、API / WS 交互正确，但**版面在真实浏览器里的观感
   没有经过肉眼确认**。首次上线前请把每个页面打开看一遍。
5. **导播端 / 解说端不再内嵌监看画面**（按现场决定改用 OBS 浏览器源 + NDI/HDMI）。
   SRS 里 C-REQ-570 ~ 577 的监看窗口相关条目随之不再实现。
6. **出点模式的 `manual` 与 `follow-now` 在建片段那一刻行为相同**。
   按 §5.6.1，开放出点的差异在于之后由操作员反复调「延长尾部」去锚定，
   所以创建动作确实是一样的 —— 这一点在 UI 与代码注释里都写明了，没有假装不同。
   `manual` / `fixed-length` 的真实语义还依赖 R8 / R11 的实测结果。
7. **播放控制区的 5 个「→ 输出」按钮走函数直调、绕过状态机**。
   它们不更新 `intent.expectedLive`，因此连续使用后可能出现一次「检测到外部操作」
   （这是**正确**的 —— 确实是外部于状态机的操作）。正式流程请用「裁切并上屏」。
8. **`/director` 的版面与 §6.13 的 ASCII 图有出入**：快速提示与回执看板在右栏纵向
   堆叠，而不是二行并排。
9. **机位区（46 个函数）默认折叠**，但函数封装完整保留，便于将来扩展多机位。
10. **解说端不再是独立大屏 UI**，而是透明叠加层（按现场要求）。它没有状态栏、
    没有 ack 按钮（除非加 `?ack=1`），只画提示与倒计时。

---

## 依赖

| 包 | 用途 |
|---|---|
| `express` | HTTP 服务 |
| `ws` | WebSocket（服务端 + 自实现的 OBS 客户端） |
| `multer` | 媒体上传 |
| `sharp`（可选） | 缩略图与多分辨率派生 |

前端**零构建**：全部是原生 ES Module，OBS 浏览器源直接加载静态文件。
现场改一行 CSS 或 JS，刷新浏览器源即可生效，不需要 build。

---

## 许可证

本项目代码与原创素材采用 **MIT License**，详见 [LICENSE](LICENSE)。

Copyright (c) 2026 YEE.

## 免责声明 / 第三方声明

本项目是**非官方**赛事工具，与 SEGA、CHUNITHM（中二节奏）官方无隶属、授权或背书关系。

- 「CHUNITHM」「中二节奏」及相关名称、角色、商标归 SEGA 及各自权利人所有；
- `data/source/ChunithmMusicData.xlsx` 与生成的曲目元数据**不属于 MIT 授权范围**，
  仅为了赛事选曲 / 计分的便利随仓库提供；
- 第三方依赖的许可证见 [NOTICE.md](NOTICE.md)。

如果你是不希望数据被再分发的权利人，请通过 Issue 联系维护者移除。

## 参与贡献

欢迎提交 Issue / PR，请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

- `npm test` / `npm run selftest` 必须通过；
- 不要提交真实 token、密码、公网 IP、日志或现场数据；
- CI 会在 Node 20 / 22 上跑单元测试与端到端自检（见 `.github/workflows/ci.yml`）。

## 安全

部署前请阅读 [SECURITY.md](SECURITY.md)，尤其是：

- 首次启动后立刻修改默认密码 `Admin`；
- 不要把主控 `:3000` / `:3001` 暴露到公网；
- OBS 输出默认只允许内网访问，需要外网时在 `/admin-setup` 手动打开。
