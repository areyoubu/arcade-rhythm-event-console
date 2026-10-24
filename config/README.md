# config/

- `config.example.json` —— 仓库自带的默认配置，**不含任何现场数据**。
- `config.json` —— 首次启动时自动从 `config.example.json` 生成（也可以手动复制）。
  该文件已被 `.gitignore` 忽略，**不要提交**，里面会有你的设备地址、公网地址和密码散列。

默认后台登录密码：`Admin`

首次进入控制台后，请立即在内网打开 <http://127.0.0.1:3000/admin-setup> 修改密码。
也可以用命令行重置：

```bash
node tools/set-admin-password.mjs
```
