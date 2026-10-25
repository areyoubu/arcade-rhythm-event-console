# 公网远端入口（remote/）

赛事里真正需要公网的部分只有：

- 现场签到 `/join` + `POST /api/lottery/join`
- 手机扫码选曲 `/pick` + `/api/music*`、`/api/match/public`、`POST /api/match/pick`
- 签到页用到的 `/shared/style.css`

控制台、OBS 浏览器源、比分、设置、日志、WebSocket **一律不开放到公网**。

有两种部署拓扑：

| 拓扑 | 适用 | 入口 |
|---|---|---|
| **A. 分离网络（推荐）** | 公网机器和本体不在同一网络；本体没有公网 IP | `edge.mjs` + `agent.mjs` |
| **B. 同网络直连** | 公网远端能直接访问主控制台（同机 / 同内网） | `index.mjs` |

---

## A. 分离网络：公网 Edge + 内网 Agent（推荐）

```
公网手机
   │ HTTPS
   ▼
┌──────────────────────────────┐
│ 公网机器（有公网 IP）          │
│ edge.mjs  :8790              │  ← 白名单 / 限流 / body 上限 / 安全头
└──────────────┬───────────────┘
               │ WSS 长连接（由内网主动发起）
               │ Bearer token 认证
               ▼
┌──────────────────────────────┐
│ 内网机器（主控制台一侧）       │
│ agent.mjs                    │  ← 再次校验白名单、限流、超时
│   │ http://127.0.0.1:3000    │
│   ▼                          │
│ 主控制台（无公网 IP）          │
└──────────────────────────────┘
```

要点：**内网 Agent 主动出站连接公网 Edge**。所以：

- 内网路由器**不需要**给主控制台或 Agent 开任何入站端口；
- 公网 Edge 无法直接访问主控制台；
- 公网只能看到 Edge 的端口；主控制台继续只服务现场局域网。

### A0. 图形配置台 + 一键启动（推荐）

两端各有一个**只监听 `127.0.0.1`** 的本地配置台，双击对应脚本即可打开：

| 机器 | 双击 | 配置台地址 | 自动启动 |
|---|---|---|---|
| 公网机器 | `remote/start-edge-gui.bat` | `http://127.0.0.1:8788/` | Edge |
| 内网机器 | `remote/start-agent-gui.bat` | `http://127.0.0.1:8789/` | 主控 + Agent |

在资源管理器里直接双击即可；如果在 cmd 里运行，用 `.\start-edge-gui.bat`（有些环境禁用了
当前目录直接执行）。脚本内容全部是 ASCII，避免 cmd 把 UTF-8 中文当成命令解析。

配置台可以：

- 可视化编辑 `edge.config.json` / `agent.config.json`，每个字段都有说明和校验；
- 点「生成」创建 32 字节随机密钥（base64url，43 位），并自动复制；
- 启动 / 停止 / 重启 Edge、Agent、主控，实时查看日志；
- 公网端直接显示「Agent 已连接 / 等待 Agent」，不用再手敲 `curl /healthz`；
- 页面内嵌接入步骤和完整的密钥规则。

命令行等价：

```bash
node remote/setup.mjs --role=edge  --auto-start   # 公网机器
node remote/setup.mjs --role=agent --auto-start   # 内网机器
# --port 18788 换配置台端口；--no-open 不打开浏览器
```

配置文件是唯一真源：`start-edge.bat` / `start-agent.bat` 不再用环境变量覆盖配置；
内网端启动主控时，由 `remote/start-main.mjs` 从 `agent.config.json` 读取 `remoteToken`
并注入 `LP_REMOTE_TOKEN`，不需要在两处手写同一个密钥。

**配置台自身的安全**：只绑定 `127.0.0.1`；校验 `Host` 防 DNS rebinding；所有写操作
需要页面内嵌的一次性令牌（跨站页面拿不到，也没有 CORS）；关闭窗口 / Ctrl+C 会停止
由它启动的服务。正式活动需要长期常驻时，仍建议用下方 B6 的 systemd / Windows 服务方式。

> 同一个服务不要同时用配置台和 `start-edge.bat` / `start-agent.bat` 启动，
> 否则会出现两个 Agent 互相顶替（Agent 已对「被顶替」做了 15 秒退避，避免无限抖动）。
> 配置台启动前会探测已运行的 Edge / 主控，不会重复 spawn。

#### 密钥规则（务必按这个来）

1. **两把密钥分工不同**：
   - 隧道密钥 = Edge 的 `agentToken` = Agent 的 `token`，只负责 Edge ↔ Agent 的准入；
   - IP 密钥 = Agent 的 `remoteToken` = 主控的 `LP_REMOTE_TOKEN`，只负责把真实访客 IP 转给主控。
   不要混用，也不要两把填同一个值。
2. 隧道密钥在**两台机器上逐字符一致**；IP 密钥在 **Agent 与主控上逐字符一致**。
3. 长度至少 24 位，推荐 32 字节随机（43 位）。配置台的「生成」使用
   `crypto.randomBytes(32).toString('base64url')`。
4. 字符只用 `A-Z a-z 0-9 - _`。不要用空格、引号、`% ! ^ & | < >`，这些会让 `.bat`
   或环境变量截断 / 展开。
5. 轮换顺序：先在 Edge 改 `agentToken` 并重启 Edge；再把同一新值填到 Agent 的 `token`
   并重启 Agent。改 `remoteToken` 时，主控和 Agent 都要重启。轮换期间公网会短暂断线。
6. 泄露后立即轮换；不要写进 URL、二维码、截图、聊天记录或版本库。
7. 公网只开放 Edge 的端口（默认 8790），**不要**映射主控的 3000 / 3001。
8. 没有域名和证书时只能走 `ws://`，隧道密钥在公网链路上是明文；拿到域名后套
   Caddy / nginx / Cloudflare，改用 `wss://`。

### A1. 公网机器（有公网 IP）

**方式一：图形配置台（推荐）**

1. 把 `remote/` 整个目录复制到公网机器；
2. 双击 `start-edge-gui.bat`，浏览器会自动打开 `http://127.0.0.1:8788/`；
3. 端口保持 8790，在「Agent 隧道密钥」点「生成」；
4. 点「保存并启动」，日志出现「等待内网 Agent…」即正常；
5. 把刚生成的密钥整串复制，填到内网 Agent 配置台的「Edge 隧道密钥」。

首次运行脚本会自动检查并安装 `ws` 依赖（只复制 `remote/` 时需要）。

**方式二：命令行**

```bash
# 从项目里复制 remote/ 到公网机器（只需要 remote/ 这个目录）
cd remote
npm install            # 只装 ws
cp edge.config.example.json edge.config.json
# 编辑 edge.config.json：agentToken / TLS / 端口
node edge.mjs
```

或者直接在完整项目里运行：

```bash
cp remote/edge.config.example.json remote/edge.config.json
npm run edge
```

Edge 默认监听 `0.0.0.0:8790`，等待内网 Agent 通过 `/tunnel` 接入。
首次可以先用 HTTP 测试，正式开放前建议配置 TLS（见 A7）。

### A2. 内网机器（本体一侧）

**方式一：图形配置台（推荐）**

1. 双击 `start-agent-gui.bat`，浏览器打开 `http://127.0.0.1:8789/`；
2. 填写 Edge 地址（有域名用 `wss://域名/tunnel`，纯 IP 暂无证书用 `ws://IP:8790/tunnel`）；
3. 把公网 Edge 生成的隧道密钥粘贴到「Edge 隧道密钥」；
4. 在「真实客户端 IP 密钥」点「生成」，保存配置；
5. 之后启动主控与 Agent 都由配置台管理（「保存并启动」会先起主控，再重启 Agent）。

如果走命令行，主控和 Agent 分两个进程：

```bash
# 在项目根目录 —— 主控：remoteToken 从 agent.config.json 读取并注入 LP_REMOTE_TOKEN
start-main.bat                  # 或 node remote/start-main.mjs

# 另开一个窗口 —— Agent（在项目根目录或 remote/ 下运行均可）
node remote/agent.mjs           # 读取 remote/agent.config.json
```

Agent 只主动出站连接 Edge，内网不需要开放端口。
代理链路会把 `X-Remote-Token` / `X-Remote-Client-IP` / `X-Forwarded-For` 带给主服务；
`server/client-ip.js` 只信任 token 匹配或本机 loopback 的转发，因此主控的签到 / 选曲限流
会按**真实公网客户端 IP** 计数，而不是把所有人当成 Agent 的一个内网 IP。

### A3. 主控制台设置

在「设置」里把：

- **抽奖与签到 → 公网签到地址**：`https://你的公网域名`
- **比赛计分与选曲 → 公网选曲地址**：同一个地址

二维码会自动指向 `.../join` / `.../pick`，实际由 Edge 承接，再经隧道到 Agent。

### A4. 验证

```bash
# 公网机器 / 本机
curl -i http://127.0.0.1:8790/healthz
# 期望：agentConnected: true

curl -i http://127.0.0.1:8790/join
curl -i http://127.0.0.1:8790/api/match/public

# 控制接口必须 404
curl -i http://127.0.0.1:8790/api/match/state
curl -i http://127.0.0.1:8790/outputs
```

`/healthz` 返回 `503` 表示 Agent 未接入；此时公网页面会返回 503，首页 `/` 仍会显示
「本体暂未连接」。

### A5. Edge / Agent 配置

**Edge**（`edge.config.json` / `EDGE_*`）：

| 项 | 默认 | 说明 |
|---|---|---|
| `agentToken` / `EDGE_AGENT_TOKEN` | 必填 | 与 Agent 共享的随机长字符串（建议 32 字节以上） |
| `host` / `EDGE_HOST` | `0.0.0.0` | 公网监听地址 |
| `port` / `EDGE_PORT` | `8790` | 公网端口 |
| `tlsCert` / `tlsKey` | 空 | 内置 HTTPS；也可放在 Caddy/nginx 后 |
| `trustProxy` | `false` | 只有前面有可信反代/Cloudflare 时才开 |
| `rateGeneral` | `240` | 每 IP 每分钟总请求；0 = 关闭 |
| `rateJoin` | `10` | `/api/lottery/join` 每 IP 每分钟 |
| `ratePick` | `30` | `/api/match/pick` 每 IP 每分钟 |
| `maxBodyBytes` | `32768` | 公网请求 body 上限 |
| `maxResponseBytes` | `2097152` | 本体响应经隧道回传的上限 |
| `timeoutMs` | `15000` | 公网请求等待本体响应的上限 |
| `maxInflight` | `64` | 同时等待本体的请求数上限 |
| `maxConnections` | `512` | Node 最大并发连接 |
| `blockIps` | `[]` | 封禁 IP 列表 |
| `heartbeatMs` | `20000` | Agent 心跳 |

**Agent**（`agent.config.json` / `AGENT_*`）：

| 项 | 默认 | 说明 |
|---|---|---|
| `edgeUrl` / `AGENT_EDGE_URL` | 必填 | `wss://公网域名/tunnel` |
| `token` / `AGENT_TOKEN` | 必填 | 与 Edge 的 `agentToken` 一致 |
| `localUpstream` / `AGENT_LOCAL_UPSTREAM` | `http://127.0.0.1:3000` | 主控制台 |
| `remoteToken` / `AGENT_REMOTE_TOKEN` | 空 | 与主服务 `LP_REMOTE_TOKEN` 一致 |
| `tlsInsecure` | `false` | **只用于本地调试**，公网必须 0 |
| `timeoutMs` | `12000` | 本地请求超时 |
| `maxBodyBytes` | `32768` | 本地请求 body 上限 |
| `maxResponseBytes` | `2097152` | 本地响应上限 |
| `concurrency` | `16` | Agent 同时处理的本体请求数（建议 ≤ Edge `maxInflight`） |
| `reconnectMinMs` / `reconnectMaxMs` | `1000` / `30000` | 断线重连退避 |

### A6. 安全 / 抗攻击

公网 Edge 是唯一暴露面，做了这些限制：

- **路径白名单**：只允许 `/join`、`/pick`、`/shared/style.css`、`/shared/font.css`、
  `/fonts/*`、`/covers/*`、`/api/music`、`/api/music/meta`、`/api/match/public`、
  `POST /api/match/pick`、`POST /api/lottery/join`；
  其他一概 404 / 405；没有开放代理，也没有 `/api` 前缀放行；
  `/fonts/*` / `/covers/*` 只对 GET / HEAD 放行，且只用于选曲页的字体与曲绘；
- **每 IP 限流**：总请求 + 签到提交 + 选曲提交分别计数；超限 429；
- **并发上限**：`maxInflight` 限制同时等待本体的请求；`server.maxConnections` 限制连接数；
- **body / 响应上限**：默认 32KB / 2MB；超限 413 / 502；
- **超时**：请求等待本体 15s；headers 10s；keep-alive 5s；慢速连接自动超时；
- **URI 长度** 2048；header 数量 100；
- **Agent 认证**：`/tunnel` 必须带正确 Bearer token，timing-safe 比较；认证失败按 IP 限速；
  只允许一个 Agent，重连会替换旧连接；
- **WebSocket 限制**：公网不能建立其他 WS；`/tunnel` 之外的 upgrade 直接 404；
- **安全响应头**：CSP、nosniff、X-Frame-Options、Referrer-Policy、Permissions-Policy；
  HTTPS 下加 HSTS；
- **不转发 Cookie / Authorization**，也不把本体的 `Set-Cookie` 返回公网；
- **Agent 纵深防御**：再次校验白名单；只转发 method/path/body；本地请求有超时、
  body / 响应上限、并发上限；不把公网的任意 header 透传给主控制台；
- **封禁 IP**：`blockIps`；生产环境可在前面再加 Cloudflare / Caddy / nginx 的 IP 规则。

⚠️ **抗 DDoS 的边界**：应用层限流能挡住刷接口、慢速连接、超大 body 等，
但挡不住大流量带宽攻击。公网机器应：

- 尽量放在 Cloudflare 等有 DDoS 清洗的服务后面（Edge 设置 `trustProxy: true`）；
- 或用云厂商的安全组 / 防火墙 / 流量清洗；
- 只开放 Edge 端口，不开放主控制台 3000 / 3001；
- token 定期轮换；关注 Edge 日志里的 401 / 429 / 503。

### A7. TLS

- 内置：`tlsCert` / `tlsKey`，Edge 直接 HTTPS；Agent 用 `wss://`；
- 或者 Caddy/nginx 终止 TLS，反代到 `127.0.0.1:8790`，Edge 设
  `host: "127.0.0.1"`、`trustProxy: true`；
- Agent 必须使用 `wss://`，并保持 `tlsInsecure: false`。只有本地调试才允许关闭证书校验。

---

## B. 同网络直连模式（remote/index.mjs）

如果公网远端和主控制台在**同一个内网**（或同一台机器），可以直接让远端访问主控制台：

```
手机（公网）
   │  HTTPS / HTTP
   ▼
remote/index.mjs（:8787）        ← 只跑白名单、限流、安全头、body 上限
   │  内网 HTTP
   ▼
主控制台（127.0.0.1:3000）       ← 继续只给局域网 / 本机
```

这样主控制台可以继续绑定 `0.0.0.0` 给现场局域网使用，但**路由器只转发 remote 的端口**，
不需要把 3000 / 3001 暴露到公网。

---

### B1. 最快跑起来（同机 / 同内网）

```bash
# 1) 复制配置
cp remote/config.example.json remote/config.json
#    编辑 upstream / token / port；TLS 可以稍后再配

# 2) 启动主控制台（照旧）
npm start

# 3) 启动公网远端
npm run remote
# 或
node remote/index.mjs
```

默认监听 `0.0.0.0:8787`，上游 `http://127.0.0.1:3000`。

浏览器打开：

- `http://127.0.0.1:8787/`：公共入口首页
- `http://127.0.0.1:8787/healthz`：健康检查（同时检查上游是否可达）
- `http://127.0.0.1:8787/join`、`/pick`：两个公共页

Windows 也可以直接双击 `remote/start-remote.bat`（先编辑里面的 upstream / token / 端口）。

### 主控制台要改的两处

1. **设置 → 抽奖与签到 → 公网签到地址**  
   填远端对外地址，例如 `https://event.example.com`（不要带 `/join`，会自动拼接）。
2. **设置 → 比赛计分与选曲 → 公网选曲地址**  
   填同一个地址。二维码会分别指向 `https://event.example.com/join` 和 `/pick`。

> 这两项只影响二维码生成；公共页本身走远端，不需要主控制台知道公网地址。

### 建议给主服务设置同一个 token

```bash
# 主控制台进程
LP_REMOTE_TOKEN=<与 remote config 的 token 相同> npm start
```

原因：公网远端的请求到达主服务时，源地址是远端进程。主服务的签到 / 选曲限流默认按
`req.ip` 计数；如果所有请求都来自远端，所有人会共用同一个限流额度。

设置了 `LP_REMOTE_TOKEN` 后，远端会在转发时带上 `X-Remote-Token` 与真实客户端 IP，
主服务只信任**token 匹配**的请求，按真实 IP 限流；局域网里的普通请求不能靠伪造
`X-Forwarded-For` 绕过。

- 远端和主控在**同一台机器**上时，主服务也会把 loopback 的 `X-Forwarded-For` 当作可信；
  不设 token 通常也能拿到真实 IP。
- 远端在**另一台内网机器**上时，强烈建议设置 token。
- token 只放在远端配置和主服务环境变量里，不要写进前端。

---

### B2. 配置

优先级：`remote/config.json` < `REMOTE_*` 环境变量。

| 配置 / 环境变量 | 默认 | 说明 |
|---|---|---|
| `host` / `REMOTE_HOST` | `0.0.0.0` | 监听地址；放在 Caddy/nginx 后面时建议 `127.0.0.1` |
| `port` / `REMOTE_PORT` | `8787` | 公网监听端口 |
| `upstream` / `REMOTE_UPSTREAM` | `http://127.0.0.1:3000` | 主控制台地址 |
| `token` / `REMOTE_TOKEN` | 空 | 与主服务 `LP_REMOTE_TOKEN` 一致的共享密钥 |
| `tlsCert` / `REMOTE_TLS_CERT` | 空 | 内置 HTTPS 证书路径（PEM） |
| `tlsKey` / `REMOTE_TLS_KEY` | 空 | 内置 HTTPS 私钥路径 |
| `trustProxy` / `REMOTE_TRUST_PROXY` | `false` | 前面有可信反代时才开；开了才读 `X-Forwarded-For` |
| `rateGeneral` / `REMOTE_RATE_GENERAL` | `180` | 每 IP 每分钟总请求上限；0 = 关闭 |
| `rateJoin` / `REMOTE_RATE_JOIN` | `10` | `/api/lottery/join` 每 IP 每分钟上限 |
| `ratePick` / `REMOTE_RATE_PICK` | `30` | `/api/match/pick` 每 IP 每分钟上限 |
| `rateWindowMs` / `REMOTE_RATE_WINDOW_MS` | `60000` | 限流窗口 |
| `maxBodyBytes` / `REMOTE_MAX_BODY` | `32768` | POST body 上限 |
| `timeoutMs` / `REMOTE_TIMEOUT_MS` | `15000` | 上游超时 |
| `quiet` / `REMOTE_QUIET` | `false` | 关闭访问日志 |

配置文件路径默认是 `remote/config.json`；也可以用 `REMOTE_CONFIG=/path/remote.json` 指定。

启动自检：

```bash
node remote/index.mjs --help
```

---

### B3. TLS / 公网 IP / 路由器

### 方案 A：内置 TLS

把证书和私钥路径填到 `tlsCert` / `tlsKey`，端口可以直接用 `443`（需要相应权限）：

```json
{
  "host": "0.0.0.0",
  "port": 443,
  "upstream": "http://127.0.0.1:3000",
  "token": "...",
  "tlsCert": "C:/certs/fullchain.pem",
  "tlsKey": "C:/certs/privkey.pem"
}
```

然后主控设置里的公网地址填 `https://你的域名`。

### 方案 B：Caddy（最省事，推荐）

远端监听本机 `127.0.0.1:8787`，Caddy 负责证书与 443：

```caddyfile
event.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

此时远端配置：

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "trustProxy": true
}
```

Caddy 会写 `X-Forwarded-For` / `X-Forwarded-Proto`；`trustProxy: true` 后远端按真实公网 IP 限流。
**只有在前面确实有自己控制的反代时才开 `trustProxy`。**

### 方案 C：nginx

```nginx
server {
    listen 443 ssl http2;
    server_name event.example.com;

    ssl_certificate     /etc/letsencrypt/live/event.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/event.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

远端同样设置 `host: 127.0.0.1`、`trustProxy: true`。

### 路由器端口转发

有公网 IP 时：

- 只转发 **remote 的端口**（例如 8787，或 443）到运行 remote 的内网机器；
- 不要转发主控制台的 3000 / 3001；
- 防火墙只放行 remote 端口。

没有公网 IP 时，用 Cloudflare Tunnel / ngrok / frp 把 **remote 端口**映射出去；
不要映射 3000。

---

### B4. 安全边界

这个进程刻意做得很窄：

- **路径白名单**：只允许上面列出的页面 / API，其他路径 404 / 405；
- **无 WebSocket**：`upgrade` 请求直接 404，不会转发到主服务；
- **不转发 Cookie / Authorization**，也不把上游的 `Set-Cookie` 返回给公网；
- **只允许必要的方法**：页面/公开状态 GET、HEAD；选曲/签到 POST；
- **body 上限**：默认 32KB，超限 413；
- **每 IP 限流**：总请求 + 两个提交接口分别计数；
- **安全响应头**：CSP、nosniff、X-Frame-Options、Referrer-Policy、Permissions-Policy，
  HTTPS 下加 HSTS；
- **上游错误**只返回“服务暂不可用”，不把内网地址/堆栈带回公网；
- **不代理控制接口**：即使有人猜到 `/api/match/state`，也只会拿到 404。

公网入口本身**没有登录**——签到和选曲本来就是给现场/远程用户填的。
选曲提交不会直接改画面：它会进入 `/match` 的待确认队列，由导播点「应用」。
如果活动结束后不再需要公网，直接停掉 remote 进程 / 关闭端口转发即可。

---

### B5. 验证

本机：

```bash
curl -i http://127.0.0.1:8787/healthz
curl -i http://127.0.0.1:8787/join
curl -i http://127.0.0.1:8787/api/match/public

# 应该 404（控制接口不开放）
curl -i http://127.0.0.1:8787/api/match/state
curl -i http://127.0.0.1:8787/outputs

# 提交选曲
curl -i -X POST http://127.0.0.1:8787/api/match/pick \
  -H 'content-type: application/json' \
  -d '{"side":"left","musicId":3,"difficulty":"master"}'
```

公网：

1. 手机用流量打开 `https://你的域名/`；
2. 进 `/join` 提交一次签到；
3. 进 `/pick` 搜索、选难度、提交；
4. 主控 `/lottery` 能看到签到，`/match` 能看到选曲请求；
5. 在主控 QR 地址设置正确后，二维码应指向公网域名。

自动化测试：

```bash
node --test test/remote-policy.test.js test/remote-server.test.js test/client-ip.test.js
```

---

### B6. 常驻运行

### systemd（Linux）

```ini
[Unit]
Description=Arcade live remote public entry
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/arcade-live
ExecStart=/usr/bin/node remote/index.mjs
Environment=REMOTE_CONFIG=/opt/arcade-live/remote/config.json
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

主控制台的服务同样要设置：

```ini
Environment=LP_REMOTE_TOKEN=<与 remote token 相同>
```

### Windows

- 手动：双击 `remote/start-remote.bat`；
- 常驻：用 NSSM / 任务计划程序把 `node remote\index.mjs` 注册为服务，
  工作目录设为项目根目录，并在系统环境变量里设置 `LP_REMOTE_TOKEN`。

---

## 常见问题（两种拓扑通用）

**手机能打开主控局域网地址，但打不开公网域名**

- 检查路由器是否只转发了 remote 端口；
- 检查 Windows 防火墙是否放行 remote 端口；
- 检查 DNS / 证书 / 反代是否指向 remote，而不是 3000。

**二维码仍指向 192.168.x.x**

- 主控「设置」里的公网签到地址 / 公网选曲地址没填，或填成了局域网地址；
- 填远端对外地址后重新打开二维码弹窗。

**所有公网用户很快被限流**

- 远端和主控不在同一台机器，且没有设置 `LP_REMOTE_TOKEN`；
- 或者远端在前面有反代，但 `trustProxy` 没开，所有人被当成同一个反代 IP。

**页面没样式 / 曲绘不显示 / 404**

- 只代理了 `/join` / `/pick`，签到页 / 选曲页需要的 `/shared/style.css`、
  `/shared/font.css`、`/fonts/*`、`/covers/*` 已在白名单；
- 如果自定义了签到页 / 选曲页并引用了别的静态资源，需要同步往 `remote/policy.mjs` 加白名单。

**想临时关掉公网入口**

停掉 remote 进程即可，主控制台和局域网不受影响。
