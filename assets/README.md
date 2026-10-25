# assets/

整屏场景的背景、转场、布局模板与看板娘素材。

**目录已按用途分类**；`server/index.js` 里显式映射为 `/assets/*`，对外 URL 保持不变
（现场 OBS 里可能已经填好这些地址，改 URL 会让浏览器源一起失效）。

```
assets/
├── backgrounds/
│   ├── dark/          深色整屏背景（总比分 / 随机选曲 / 选曲展示 / 奖品大屏）
│   │   ├── 直播间背景-动态.mp4
│   │   ├── 直播间背景.png
│   │   └── 直播间背景.svg
│   └── light/         明亮背景
│       ├── light-bg.mp4      明亮风格 · 整屏场景动态背景（12s 循环）
│       ├── light-bg.png      同上静帧（?static=1 / 解码失败兜底）
│       ├── standby-bg.mp4    直播待机画面的动态背景（12s 循环）
│       └── standby-bg.png    同上静帧
├── transitions/
│   ├── transition-generic.webm        通用透明转场（VP9 + alpha，1.3s，转场点约 0.65s）
│   ├── transition-generic-preview.png 中间帧预览
│   ├── transition-light.webm          明亮风格转场（VP9 + alpha，1.3s，转场点 0.65s）
│   └── transition-light-preview.png   扫入中途的预览帧
├── layouts/            OBS 布局叠加模板
│   ├── 直播间模板.png            深色框（原版）
│   ├── 直播间模板-预览.png       带区域标注的预览
│   ├── 直播间模板.svg            预览的可编辑源文件
│   ├── 直播间模板-明亮.png       明亮风格：浅色框
│   └── 直播间模板-明亮-降亮.png  明亮风格低亮度版（比赛场景用）
└── mascot/
    └── standby-mascot.png  待机画面看板娘（灰底已抠除，透明 PNG）
```

| 文件 | 用途 | 访问地址 |
|---|---|---|
| `backgrounds/dark/直播间背景-动态.mp4` | 深色场景动态背景（12s 无缝循环） | `/assets/liveroom-background.mp4` |
| `backgrounds/dark/直播间背景.png` | 静态背景 / 视频失败兜底 | `/assets/liveroom-background.png` |
| `backgrounds/dark/直播间背景.svg` | 静态背景的可编辑源文件 | `/assets/liveroom-background.svg` |
| `backgrounds/light/light-bg.mp4` | 明亮风格场景动态背景 | `/assets/light-background.mp4` |
| `backgrounds/light/light-bg.png` | 同上静帧 | `/assets/light-background.png` |
| `backgrounds/light/light-bg-dim.mp4` | 压暗版（亮度 ×0.72）：垫在机台 / 摄像头画面后面，不会盖过游戏 | `/assets/light-background-dim.mp4` |
| `backgrounds/light/light-bg-dim.png` | 同上静帧 | `/assets/light-background-dim.png` |
| `backgrounds/light/standby-bg.mp4` | 直播待机画面背景 | `/assets/standby-bg.mp4` |
| `backgrounds/light/standby-bg.png` | 待机画面静帧 | `/assets/standby-bg.png` |
| `mascot/standby-mascot.png` | 待机画面看板娘 | `/assets/standby-mascot.png` |
| `transitions/*.webm` | OBS Stinger 转场直接用本地文件，转场点 0.65s | — |
| `layouts/直播间模板.png` | OBS 布局叠加：四个窗口透明，其余深色框 | — |
| `layouts/直播间模板-明亮.png` | 同上，明亮风格（浅色框） | — |
| `layouts/直播间模板-明亮-降亮.png` | 同上，但整体压成灰蓝 —— 机台画面本身很亮时用这一版，白框会抢注意力 | — |

## 重新生成

```bash
node tools/_liveroom.mjs                 # 布局模板
node tools/_liveroom-background.mjs      # 深色静态背景
node tools/_liveroom-animated.mjs        # 深色动态背景（需要 ffmpeg + sharp）
node tools/make-light-bg.mjs             # 明亮场景动态背景
node tools/make-standby-bg.mjs           # 待机画面动态背景
node tools/make-transition-light.mjs     # 明亮转场（VP9 + alpha）
node tools/make-mascot-cutout.mjs <原图> # 看板娘抠图（纯灰底 → 透明 PNG）
```

修改后刷新 OBS 浏览器源；动态背景建议保留 `?static=1` 作为低 GPU 兜底。
