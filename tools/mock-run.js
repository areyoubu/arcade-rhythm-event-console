/**
 * 一键起 mock 环境：mock vMix（HTTP :8088）+ mock OBS（WS :4455）。
 *
 *   npm run mock
 *
 * 起来之后在**另一个**终端跑 `npm start`，整个系统就能在没有 OBS / vMix 的机器上完整跑通：
 *   · 回放面板可以裁切、上屏、回程（状态机与 151 函数表全部可用）
 *   · 转场控制可用，SceneTransitionEnded 会按真实语义（cut point）派发
 *   · 截图监看可用（返回 1×1 的 JPEG，足以验证二进制通道）
 *
 * 环境变量：
 *   MOCK_VMIX_PORT=8088         mock vMix 端口（改这里就要同步改设置页的 vmix.port）
 *   MOCK_OBS_PORT=4455          mock OBS 端口（同理改 obs.port）
 *   MOCK_OBS_PASSWORD=xxx       启用鉴权，用来验证密码错误路径
 *   MOCK_OBS_NO_EVENTS=1        关闭转场事件派发 —— 用来验证「超时兜底」路径（AC-10）
 *   MOCK_OBS_TRANSITION_MS=300  模拟的转场时长
 */
import { startMockVmix } from './mock-vmix.js';
import { startMockObs } from './mock-obs.js';

const vmixPort = Number(process.env.MOCK_VMIX_PORT || 8088);
const obsPort = Number(process.env.MOCK_OBS_PORT || 4455);

console.log('════════════════════════════════════════════════════════');
console.log(' 街机音游赛事控制软件 —— Mock 环境');
console.log('════════════════════════════════════════════════════════');

const started = [];

try {
  const v = await startMockVmix({ port: vmixPort });
  started.push(v);
  console.log(`✅ mock vMix   http://127.0.0.1:${vmixPort}/api/`);
  console.log(`   调用日志     http://127.0.0.1:${vmixPort}/__mock/calls`);
  console.log(`   重置状态     http://127.0.0.1:${vmixPort}/__mock/reset`);
} catch (e) {
  console.error(`❌ mock vMix 启动失败（端口 ${vmixPort}）：${e.message}`);
  console.error('   → 端口被占用，或本机真的在跑 vMix。可设 MOCK_VMIX_PORT=8098 换个端口。');
}

try {
  const o = await startMockObs({ port: obsPort });
  started.push(o);
  console.log(`✅ mock OBS    ws://127.0.0.1:${obsPort}`);
  console.log(`   场景         CLEAN / LIVE / REPLAY / 待机 / 采访`);
  console.log(`   转场         Cut / Fade / REPLAY-IN（stinger）`);
} catch (e) {
  console.error(`❌ mock OBS 启动失败（端口 ${obsPort}）：${e.message}`);
  console.error('   → 端口被占用，或本机真的在跑 OBS。可设 MOCK_OBS_PORT=4466 换个端口。');
}

if (!started.length) {
  console.error('\n没有任何 mock 启动成功，退出。');
  process.exit(1);
}

console.log('\n下一步：在另一个终端执行 `npm start`，然后打开 http://127.0.0.1:3000');
console.log('提示：mock vMix 里「开始录制」后回放面板才会解锁（状态机要求 recording=true）。');
console.log('按 Ctrl+C 退出。\n');

function shutdown() {
  console.log('\n正在关闭 mock 环境…');
  Promise.all(started.map((s) => s.close?.())).finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
