/**
 * 配置 schema 测试 —— 对应 A-REQ-215 / B-REQ-305 / G-REQ-101 / G-REQ-102。
 * 核心断言：**非法配置必须返回字段路径级的错误**，而不是一句「配置错误」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG, FIELD_SCHEMA, CONFIG_GROUPS,
  validateConfig, normalizeConfig, deepMerge, getPath, setPath, extractKnownFields,
} from '../server/config-schema.js';

test('默认配置必须覆盖 SRS 的三处配置节', () => {
  // §5.15
  assert.ok(DEFAULT_CONFIG.obs && DEFAULT_CONFIG.vmix, '缺少 obs / vmix 节');
  assert.ok(DEFAULT_CONFIG.clip && DEFAULT_CONFIG.replay, '缺少 clip / replay 节');
  assert.ok(DEFAULT_CONFIG.transitions && DEFAULT_CONFIG.logging);
  // §4.10
  assert.ok(DEFAULT_CONFIG.render && DEFAULT_CONFIG.templates && DEFAULT_CONFIG.media);
  assert.ok(DEFAULT_CONFIG.entities && DEFAULT_CONFIG.animations && DEFAULT_CONFIG.credits);
  // §6.12
  assert.ok(DEFAULT_CONFIG.cue && DEFAULT_CONFIG.countdown);
  assert.ok(DEFAULT_CONFIG.orchestration && DEFAULT_CONFIG.integration && DEFAULT_CONFIG.obsEvents);
});

test('★ 双机部署只允许改配置 —— 关键地址都必须在 schema 中可配（G-REQ-101 / 102）', () => {
  const mustBeConfigurable = [
    'obs.host', 'obs.port', 'obs.password',
    'vmix.host', 'vmix.port',
    'scenes.live', 'scenes.replay', 'scenes.clean',
    'sources.replayNdi', 'sources.gameAudio',
  ];
  for (const p of mustBeConfigurable) {
    assert.ok(FIELD_SCHEMA.some((f) => f.path === p), `${p} 未在 schema 中登记，无法通过设置页配置`);
    assert.notEqual(getPath(DEFAULT_CONFIG, p), undefined, `${p} 缺少默认值`);
  }
});

test('★ 不再有 monitor 配置节（改用 OBS 浏览器源 + NDI/HDMI，不含媒体服务器）', () => {
  assert.equal(DEFAULT_CONFIG.monitor, undefined, 'monitor 配置节应已移除 —— 现场不再使用 MediaMTX');
  assert.ok(!FIELD_SCHEMA.some((f) => f.path.startsWith('monitor.')), '设置页不应再出现 monitor 字段');
});

test('★★ 回放 / vMix / OBS / 转场默认全部不启用（可在设置页开启）', () => {
  assert.deepEqual(DEFAULT_CONFIG.features, {
    replay: false, vmix: false, obs: false, transitions: false,
  });
  for (const key of ['replay', 'vmix', 'obs', 'transitions']) {
    const f = FIELD_SCHEMA.find((x) => x.path === `features.${key}`);
    assert.ok(f, `features.${key} 必须登记进设置页，否则无法开启`);
    assert.equal(f.type, 'boolean');
    assert.equal(f.group, 'features');
  }
  assert.ok(CONFIG_GROUPS.some((g) => g.id === 'features'), '设置页需要有「功能开关」分区');
});

test('来自 SRS 的默认值必须逐项对上', () => {
  assert.equal(DEFAULT_CONFIG.version, 3);
  assert.equal(DEFAULT_CONFIG.obs.port, 4455);
  assert.equal(DEFAULT_CONFIG.vmix.port, 8088);
  assert.equal(DEFAULT_CONFIG.scenes.live, 'LIVE');
  assert.equal(DEFAULT_CONFIG.scenes.replay, 'REPLAY');
  assert.equal(DEFAULT_CONFIG.scenes.clean, 'CLEAN');
  assert.equal(DEFAULT_CONFIG.sources.replayNdi, 'vMix 回放');
  assert.equal(DEFAULT_CONFIG.sources.gameAudio, '游戏采集');
  assert.equal(DEFAULT_CONFIG.clip.defaultLookbackMs, 12000);
  assert.equal(DEFAULT_CONFIG.clip.minLookbackMs, 1000);
  assert.equal(DEFAULT_CONFIG.clip.maxLookbackMs, 45000);
  assert.equal(DEFAULT_CONFIG.clip.stepMs, 500);
  assert.deepEqual(DEFAULT_CONFIG.clip.presets, [5000, 8000, 12000, 20000, 30000, 45000]);
  assert.equal(DEFAULT_CONFIG.clip.fineTuneFrames, 10);
  assert.equal(DEFAULT_CONFIG.clip.frameRate, 60);
  assert.equal(DEFAULT_CONFIG.clip.warnThreshold, 0.8);
  assert.equal(DEFAULT_CONFIG.clip.markVariant, 'ReplayMarkInOut');
  assert.equal(DEFAULT_CONFIG.replay.speed, 1.0);
  assert.equal(DEFAULT_CONFIG.replay.holdFirstFrame, true);
  assert.equal(DEFAULT_CONFIG.replay.markDelayMs, 200);
  assert.equal(DEFAULT_CONFIG.replay.transitionTimeoutMs, 2500);
  assert.equal(DEFAULT_CONFIG.replay.pollIntervalMs, 150);
  assert.equal(DEFAULT_CONFIG.replay.stableSamples, 3);
  assert.equal(DEFAULT_CONFIG.replay.endingThresholdMs, 3000);
  assert.equal(DEFAULT_CONFIG.replay.preflightCacheMs, 3000);
  assert.equal(DEFAULT_CONFIG.replay.faultTimeoutMs, 4000);
  assert.deepEqual(DEFAULT_CONFIG.cue.channels, ['director', 'cast'], '现场页已取消，默认受众只剩导播与解说');
  assert.equal(DEFAULT_CONFIG.countdown.defaultLeadMs, 15000);
  assert.equal(DEFAULT_CONFIG.countdown.autoExecuteDefault, false, '★ autoExecute 默认必须为 false（C-REQ-530）');
  assert.equal(DEFAULT_CONFIG.countdown.allowAutoExecute, false, '★ 自动执行总开关默认必须关闭（C-REQ-531）');
  assert.equal(DEFAULT_CONFIG.orchestration.dryRun, false);
  assert.equal(DEFAULT_CONFIG.cue.sound.volume, 0.7);
  assert.equal(DEFAULT_CONFIG.cue.ack.repeatMs, 5000);
  assert.equal(DEFAULT_CONFIG.cue.ack.maxRepeats, 6);
  assert.equal(DEFAULT_CONFIG.cue.history.retainHours, 4);
  assert.equal(DEFAULT_CONFIG.logging.retainDays, 30);
  assert.equal(DEFAULT_CONFIG.render.canvas.width, 1920);
  assert.equal(DEFAULT_CONFIG.render.canvas.height, 1080);
  assert.equal(DEFAULT_CONFIG.media.maxFileSizeMB, 5);
});

test('★ 非法端口必须返回字段路径级错误（A-REQ-215）', () => {
  const cfg = deepMerge(structuredClone(DEFAULT_CONFIG), { obs: { port: 99999 } });
  const errs = validateConfig(cfg);
  assert.ok(errs['obs.port'], '应报 obs.port 而不是笼统的错误');
  assert.match(errs['obs.port'], /1-65535/);
});

test('★ 跨字段一致性：回溯量上下限与默认值', () => {
  let cfg = deepMerge(structuredClone(DEFAULT_CONFIG), { clip: { minLookbackMs: 60000, maxLookbackMs: 30000 } });
  let errs = validateConfig(cfg);
  assert.ok(errs['clip.minLookbackMs'], '下限大于上限必须报错并指出 min 字段');

  cfg = deepMerge(structuredClone(DEFAULT_CONFIG), { clip: { defaultLookbackMs: 90000 } });
  errs = validateConfig(cfg);
  assert.ok(errs['clip.defaultLookbackMs'], '默认值超过上限必须报错');
});

test('★ 两个端口不得相同', () => {
  const cfg = deepMerge(structuredClone(DEFAULT_CONFIG), { server: { overlayPort: 3000, controlPort: 3000 } });
  const errs = validateConfig(cfg);
  assert.ok(errs['server.controlPort']);
});

test('★ 类型错误必须被拒绝，并指明字段', () => {
  const cfg = deepMerge(structuredClone(DEFAULT_CONFIG), { server: { host: 123 } });
  const errs = validateConfig(cfg);
  assert.ok(errs['server.host'], '类型错误必须拒绝，并指明字段');
});

test('★ select 字段只接受枚举值', () => {
  const cfg = deepMerge(structuredClone(DEFAULT_CONFIG), { clip: { markVariant: 'ReplayMarkOut' } });
  const errs = validateConfig(cfg);
  assert.ok(errs['clip.markVariant']);
  assert.match(errs['clip.markVariant'], /ReplayMarkInOut/);
});

test('JSON 字段：字符串形式非法时须报解析失败并给出字段路径', () => {
  const cfg = deepMerge(structuredClone(DEFAULT_CONFIG), { countdown: { escalation: '{不是 JSON' } });
  const errs = validateConfig(cfg);
  assert.ok(errs['countdown.escalation']);
  assert.match(errs['countdown.escalation'], /JSON/);
});

test('★ normalizeConfig 把设置页的字符串形式归一化', () => {
  const cfg = normalizeConfig(deepMerge(structuredClone(DEFAULT_CONFIG), {
    cue: { channels: 'director, cast , floor' },
    clip: { presets: '5000, 8000, 12000' },
    obs: { port: '4455' },
    countdown: { escalation: '[{"atMs":5000,"priority":"P1","sound":"beep"}]' },
  }));
  assert.deepEqual(cfg.cue.channels, ['director', 'cast', 'floor']);
  assert.deepEqual(cfg.clip.presets, [5000, 8000, 12000]);
  assert.equal(cfg.obs.port, 4455);
  assert.equal(typeof cfg.obs.port, 'number');
  assert.deepEqual(cfg.countdown.escalation, [{ atMs: 5000, priority: 'P1', sound: 'beep' }]);
});

test('extractKnownFields 丢弃真正的脏字段', () => {
  const clean = extractKnownFields({ obs: { host: 'x', bogus: 1 }, nope: { a: 1 }, __proto__hack: 1 });
  assert.equal(clean.obs.host, 'x');
  assert.equal(clean.obs.bogus, undefined, '未在 DEFAULT_CONFIG 里出现的字段应被丢弃');
  assert.equal(clean.nope, undefined);
});

test('★ extractKnownFields 必须保留所有结构性节点（防止保存配置时整节丢失）', () => {
  // 回归：早期实现只保留 FIELD_SCHEMA 登记过的字段，导致每次保存都会把
  // version / templates / entities / animations / credits / integration / obsEvents
  // 这些「有默认值但没登记进设置页」的整节悄悄删掉。
  const pruned = extractKnownFields(deepMerge(structuredClone(DEFAULT_CONFIG), {
    replay: { markDelayMs: 321 },
  }));
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    assert.notEqual(pruned[key], undefined, `保存后顶层节「${key}」丢失了`);
  }
  assert.equal(pruned.version, 3, 'version 必须保留');
  assert.equal(pruned.replay.markDelayMs, 321, '用户改动的值必须保留');
  assert.equal(pruned.animations.defaultIn, 'fadeUp', '未登记的整节必须按默认值保留');
  assert.deepEqual(pruned.obsEvents.subscribe, DEFAULT_CONFIG.obsEvents.subscribe);
  assert.equal(pruned.entities.file, './data/entities.json');
});

test('★★ 自由结构（json 字段）里的自定义键必须完整保留', () => {
  // 回归：cue.templates 的默认值是 {}，按默认形状递归裁剪会得到 0 个键，
  // 用户新增的话术模板在保存时被静默丢弃（内存与磁盘都变回 {}）。
  const withCue = deepMerge(structuredClone(DEFAULT_CONFIG), {
    cue: { templates: { T20: { name: '自定义话术', template: '第 {n} 局开始', audience: ['cast'], priority: 'P2' } } },
  });
  const pruned = extractKnownFields(withCue);
  assert.ok(pruned.cue.templates.T20, 'cue.templates 里用户新增的键被吃掉了');
  assert.equal(pruned.cue.templates.T20.name, '自定义话术');
  assert.deepEqual(pruned.cue.templates.T20.audience, ['cast']);

  // 同理：场景转场覆盖里新增一个场景
  const withScene = deepMerge(structuredClone(DEFAULT_CONFIG), {
    transitions: { sceneOverrides: { 待机: { transitionName: 'Fade', transitionDuration: 500 } } },
  });
  const pruned2 = extractKnownFields(withScene);
  assert.ok(pruned2.transitions.sceneOverrides['待机'], 'sceneOverrides 里新增的场景被吃掉了');
  assert.equal(pruned2.transitions.sceneOverrides['待机'].transitionName, 'Fade');
  // 原有键也要在
  assert.ok(pruned2.transitions.sceneOverrides.LIVE);
});

test('★ 自由结构是深拷贝 —— 改动结果不得反向影响源对象', () => {
  const src = deepMerge(structuredClone(DEFAULT_CONFIG), { cue: { templates: { T1x: { name: 'A' } } } });
  const out = extractKnownFields(src);
  out.cue.templates.T1x.name = '被改了';
  assert.equal(src.cue.templates.T1x.name, 'A', '裁剪结果必须与源对象解耦');
});

test('★ 每个配置节的每个顶层键都必须在 schema 里可配，或至少被形状裁剪保留', () => {
  // 这条守的是「设置页能改到的东西 = 配置文件里写下来的东西」这个不变量
  const registered = new Set(FIELD_SCHEMA.map((f) => f.path.split('.')[0]));
  const preserved = new Set(Object.keys(DEFAULT_CONFIG));
  for (const section of Object.keys(DEFAULT_CONFIG)) {
    assert.ok(preserved.has(section), `配置节 ${section} 不在 DEFAULT_CONFIG 中`);
  }
  // 提醒：新增配置节时，若忘了登记进 FIELD_SCHEMA，设置页就看不见它
  const unregistered = [...preserved].filter((s) => !registered.has(s) && s !== 'version');
  assert.deepEqual(unregistered, [], `这些配置节没有在设置页登记，用户无法配置：${unregistered.join(', ')}`);
});

test('设置页分组都有对应字段，且字段的 group 都存在', () => {
  const ids = new Set(CONFIG_GROUPS.map((g) => g.id));
  for (const f of FIELD_SCHEMA) {
    assert.ok(ids.has(f.group), `字段 ${f.path} 的 group「${f.group}」没有对应的分区定义`);
    assert.ok(f.label, `字段 ${f.path} 缺少中文标签`);
  }
});

test('敏感字段（密码 / 令牌）必须被标记', () => {
  const sensitive = FIELD_SCHEMA.filter((f) => f.sensitive).map((f) => f.path);
  assert.ok(sensitive.includes('obs.password'));
});

test('getPath / setPath 基本行为', () => {
  const o = {};
  setPath(o, 'a.b.c', 1);
  assert.equal(getPath(o, 'a.b.c'), 1);
  assert.equal(getPath(o, 'a.b.x'), undefined);
  assert.equal(getPath(o, 'x.y.z'), undefined);
});
