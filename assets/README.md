# assets/

直播间背景与布局模板素材。运行时不直接暴露目录，由 `server/index.js` 显式映射为 `/assets/*`。

| 文件 | 用途 | 访问地址 |
|---|---|---|
| `直播间背景-动态.mp4` | 总比分画面 / 整屏场景的动态背景（12s 无缝循环） | `/assets/liveroom-background.mp4` |
| `直播间背景.png` | 静态背景 / 视频失败时的兜底 | `/assets/liveroom-background.png` |
| `直播间背景.svg` | 静态背景的可编辑源文件 | `/assets/liveroom-background.svg` |
| `直播间模板.png` | OBS 布局叠加：四个窗口透明，其余深色框 | — |
| `直播间模板-预览.png` | 带区域名称与尺寸标注的预览图 | — |
| `直播间模板.svg` | 预览图的可编辑源文件 | — |
| `transition-generic.webm` | 通用透明转场（VP9 + alpha，1920×1080 / 60fps / 1.3s）。OBS 用 Stinger 转场直接选本地文件，转场点约 **0.65s** | — |
| `transition-generic-preview.png` | 转场中间帧叠在直播间背景上的预览图 | — |

重新生成：

```bash
node tools/_liveroom.mjs            # 布局模板
node tools/_liveroom-background.mjs # 静态背景
node tools/_liveroom-animated.mjs   # 动态背景（需要 ffmpeg + sharp）
```

修改后刷新 OBS 浏览器源；动态背景建议保留 `?static=1` 作为低 GPU 兜底。
