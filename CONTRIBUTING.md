# 参与贡献

感谢你愿意改进「街机音游赛事控制软件」。这是一个零构建的 Node.js ESM 项目，
前端是原生 JS + HTML，服务端是 Express + ws。

## 开发环境

- Node.js ≥ 20.11（CI 会跑 20 / 22）
- Windows / Linux / macOS 均可
- 可选：OBS Studio + obs-websocket v5；vMix（只有回放功能需要）

```bash
npm install
npm start        # http://127.0.0.1:3000
npm test         # 单元 / DOM / 页面完整性测试
npm run selftest # 端到端自检（隔离配置 + mock）
```

没有 OBS / vMix 时用 `npm run mock` 起 mock 环境，再另开终端 `npm start`。

## 提交前

1. 跑通 `npm test` 与 `npm run selftest`；
2. 新增功能请附带测试（`test/` 下，使用 `node:test`）；
3. 页面改动请确认 `test/pages.test.js` 通过（语法、共享库成员、API 路径）；
4. 不要提交以下内容（已在 `.gitignore` 中）：
   - `config/config.json`、`remote/*.config.json`；
   - `logs/`、`media/` 下的运行时文件；
   - `data/` 下的实体 / 签到 / 比赛 / 曲目索引；
   - 任何真实 token、密码、公网 IP。

## 代码风格

- ESM，零构建；不要引入打包器；
- 服务端错误统一返回 `{ ok:false, nack:{ code, msg } }` 或字段级 `errors`；
- 页面只用 `public/shared` 里已有的组件，不要复制粘贴同类逻辑；
- 安全相关改动必须写清楚威胁模型，并补回归测试。

## 许可证

提交 PR 即表示你同意以根目录 [LICENSE](LICENSE)（MIT）授权你的贡献。
注意：曲目数据与 CHUNITHM 相关名称不在此授权范围内，详见 [NOTICE.md](NOTICE.md)。
