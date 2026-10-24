/**
 * 游戏音频预览解码 worker。
 *
 * 主线程只负责定位 AWB / ACB 与缓存管理；这里在独立线程里解码 HCA，
 * 避免几秒的 CPU 解码卡住直播控制与 WebSocket 推送。
 *
 * 解码结果：16-bit PCM WAV，已按预览区间裁剪。
 *
 * 说明：音频容器为 CRI AFS2 (AWB)，音频编码为 HCA。这里只读取
 * 已由主线程校验过、位于用户配置的游戏目录内的文件，不访问其他路径。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import {
  decodeHca, parseHca, encodeToWav, isHca,
} from '@tootallnate/hca';
import { parseAfs2, findHcaEntry } from './afs2.js';
import { sliceHca } from './hca-slice.js';

// CHUNITHM 各版本的 HCA 密钥（日服 / 国际服 / 国服）
const HCA_KEYS = [
  32931609366120192n,
  33426922444908636n,
  30194896045700459n,
];

function looksLikeAudio(pcm) {
  // 错误密钥通常解出全静音（sync magic 不匹配时解码器输出 0），
  // 这里抽样检查峰值，避免把静音当成成功结果缓存下来。
  const step = Math.max(1, Math.floor(pcm.length / 4096));
  let peak = 0;
  for (let i = 0; i < pcm.length; i += step) {
    const v = Math.abs(pcm[i]);
    if (v > peak) peak = v;
    if (peak > 1e-4) return true;
  }
  return peak > 1e-4;
}

function decodeWithKeys(bytes, subKey) {
  const header = parseHca(bytes);
  const attempts = [];
  if (!header.ciphType) attempts.push(undefined);
  for (const key of HCA_KEYS) {
    if (subKey) attempts.push({ key, awbKey: subKey });
    attempts.push({ key, awbKey: 0 });
  }
  // 某些无加密 / 静态表的文件也能直接解
  attempts.push(undefined);

  let lastErr = null;
  for (const options of attempts) {
    try {
      const decoded = decodeHca(bytes, options);
      if (decoded.pcm.length && looksLikeAudio(decoded.pcm)) return decoded;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('HCA 解码结果为空或全静音（密钥可能不匹配）');
}

async function main() {
  const {
    awbPath, outPath, tmpPath, startMs, durationMs,
  } = workerData || {};
  if (!awbPath || !outPath) throw new Error('缺少音频任务参数');

  const awb = await fsp.readFile(awbPath);
  const archive = parseAfs2(awb);
  const entry = findHcaEntry(awb, archive);
  if (!entry) throw new Error('AWB 中没有找到 HCA 音频');
  const hca = awb.subarray(entry.pos, entry.pos + entry.length);
  if (!isHca(hca)) throw new Error('AWB 条目不是 HCA 音频');

  const sliced = sliceHca(hca, Number(startMs) || 0, Number(durationMs) || 20000);
  const decoded = decodeWithKeys(sliced.bytes, archive.subKey);

  const channels = decoded.channelCount;
  const offset = Math.max(0, sliced.startSample - sliced.baseSample);
  const end = Math.min(decoded.samplesPerChannel, sliced.endSample - sliced.baseSample);
  const count = Math.max(0, end - offset);
  if (!count) throw new Error('预览区间没有可输出的采样');

  const pcm = decoded.pcm.subarray(offset * channels, (offset + count) * channels);
  const wav = encodeToWav(channels, decoded.samplingRate, pcm, { bitDepth: 16 });
  await fsp.writeFile(tmpPath, wav);
  await fsp.rename(tmpPath, outPath);

  parentPort.postMessage({
    ok: true,
    path: outPath,
    bytes: wav.byteLength,
    channels,
    sampleRate: decoded.samplingRate,
    samples: count,
    startMs: Number(startMs) || 0,
    durationMs: Math.round((count / decoded.samplingRate) * 1000),
  });
}

main().catch((e) => {
  parentPort.postMessage({ ok: false, error: e?.message || String(e) });
});
