/**
 * vMix XML 解析测试 —— 对应 B-REQ-801 / 802 / 807、§5.10。
 * 样本直接取自 SRS §5.10 的官方 XML 结构。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, parseReplay, parseHeader, parseInputs, parseState, findAll, first } from '../server/vmix/xml.js';

/** SRS §5.10 给出的官方结构（原文照抄） */
const SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<vmix>
  <version>26.0.0.45</version>
  <edition>Pro</edition>
  <preset>Default</preset>
  <inputs>
    <input key="aaa" number="1" type="Capture" title="游戏采集" state="Running" position="0" duration="0" />
    <input key="bbb" number="2" type="Replay" title="Replay - A" state="Paused" position="62740" duration="106920">
      <replay live="False" recording="False" channelMode="B"
              events="1" eventsA="1" eventsB="1"
              cameraA="1" cameraB="1"
              speed="1" speedA="1" speedB="1">
        <timecode>2020-04-26T10:50:22.720</timecode>
        <timecodeA>2020-04-26T10:50:51.740</timecodeA>
        <timecodeB>2020-04-26T10:50:22.720</timecodeB>
      </replay>
    </input>
    <input number="3" type="ReplayPreview" title="Replay Preview" />
  </inputs>
</vmix>`;

test('基础解析：节点、属性、文本', () => {
  const tree = parseXml(SAMPLE);
  assert.ok(tree);
  assert.equal(findAll(tree, 'input').length, 3);
  assert.equal(first(tree, 'version').text, '26.0.0.45');
  const replayInput = findAll(tree, 'input').find((n) => n.attrs.type === 'Replay');
  assert.equal(replayInput.attrs.number, '2');
  assert.equal(replayInput.attrs.title, 'Replay - A');
});

test('★ parseReplay 提取全部回放字段', () => {
  const r = parseReplay(SAMPLE);
  assert.ok(r, '应能找到 type="Replay" 的输入');
  assert.equal(r.inputNumber, 2);
  assert.equal(r.title, 'Replay - A');
  assert.equal(r.state, 'Paused');
  assert.equal(r.position, 62740);
  assert.equal(r.duration, 106920);
  assert.equal(r.live, false, '★ B-REQ-802：live=False 即「正在回放」');
  assert.equal(r.recording, false);
  assert.equal(r.channelMode, 'B');
  assert.equal(r.events, 1);
  assert.equal(r.eventsA, 1);
  assert.equal(r.eventsB, 1);
  assert.equal(r.speed, 1);
  assert.equal(r.timecode, '2020-04-26T10:50:22.720');
  assert.equal(r.timecodeA, '2020-04-26T10:50:51.740');
  assert.equal(r.timecodeB, '2020-04-26T10:50:22.720');
  assert.equal(r.remainingMs, 106920 - 62740);
});

test('★ B-REQ-802：live=True 表示未在回放', () => {
  const xml = SAMPLE.replace('live="False"', 'live="True"');
  assert.equal(parseReplay(xml).live, true);
});

test('vMix 的 True/False 大小写与 true/false 都要能识别', () => {
  const lower = SAMPLE.replace('live="False"', 'live="false"').replace('recording="False"', 'recording="TRUE"');
  const r = parseReplay(lower);
  assert.equal(r.live, false);
  assert.equal(r.recording, true);
});

test('没有 Replay 输入时返回 null，而不是抛异常', () => {
  assert.equal(parseReplay('<vmix><inputs></inputs></vmix>'), null);
  assert.equal(parseReplay(''), null);
  assert.equal(parseReplay(null), null);
});

test('★ 畸形 XML 不得抛异常（现场宁可少解析也不要崩）', () => {
  assert.doesNotThrow(() => parseXml('<vmix><inputs><input type="Replay" '));
  assert.doesNotThrow(() => parseXml('<<<>>>'));
  assert.doesNotThrow(() => parseXml('not xml at all'));
  assert.equal(parseXml('not xml at all').name, '#root');
});

test('注释 / 声明 / CDATA / 自闭合都能处理', () => {
  const tree = parseXml(`<?xml version="1.0"?>
    <!-- 这是一段注释 -->
    <root>
      <a x="1"/>
      <b><![CDATA[<not-a-tag>]]></b>
      <c>带 &amp; 转义的文本</c>
    </root>`);
  assert.equal(findAll(tree, 'a').length, 1);
  assert.equal(first(tree, 'b').text, '<not-a-tag>');
  assert.equal(first(tree, 'c').text, '带 & 转义的文本');
});

test('中文与 emoji 文本安全（S-REQ-110）', () => {
  const tree = parseXml('<r><t>选手A 🎮 中二节奏</t></r>');
  assert.equal(first(tree, 't').text, '选手A 🎮 中二节奏');
});

test('parseHeader 读出版本与版次（用于提示「回放需 Pro/4K/Max」）', () => {
  const h = parseHeader(SAMPLE);
  assert.equal(h.version, '26.0.0.45');
  assert.equal(h.edition, 'Pro');
});

test('parseInputs 返回全部输入并保留关键属性', () => {
  const inputs = parseInputs(SAMPLE);
  assert.equal(inputs.length, 3);
  assert.deepEqual(inputs.map((i) => i.type), ['Capture', 'Replay', 'ReplayPreview']);
  assert.equal(inputs[0].title, '游戏采集');
  assert.equal(inputs[1].muted, false);
});

test('parseState 一站式返回三段信息', () => {
  const s = parseState(SAMPLE);
  assert.equal(s.header.edition, 'Pro');
  assert.equal(s.inputs.length, 3);
  assert.equal(s.replay.inputNumber, 2);
  // inputs 不应泄漏 raw 节点（否则无法序列化）
  assert.equal(s.inputs[0].raw, undefined);
});

test('无效数字回退为 0，不产生 NaN', () => {
  const xml = SAMPLE.replace('position="62740"', 'position="abc"');
  const r = parseReplay(xml);
  assert.equal(r.position, 0);
  assert.equal(Number.isNaN(r.position), false);
});

test('内联事件节点被解析为 eventList', () => {
  const xml = `<vmix><inputs>
    <input number="2" type="Replay" title="R" state="Paused" position="0" duration="5000">
      <replay live="False" recording="True" channelMode="A" events="2" eventsA="2" eventsB="0">
        <event id="1" name="选手A" duration="3000" selected="True" start="0" end="3000" />
        <event id="2" name="选手B" duration="2000" />
      </replay>
    </input>
  </inputs></vmix>`;
  const r = parseReplay(xml);
  assert.equal(r.eventList.length, 2);
  assert.equal(r.eventList[0].text, '选手A');
  assert.equal(r.eventList[0].selected, true);
  assert.equal(r.eventList[0].duration, 3000);
  assert.equal(r.eventList[1].text, '选手B');
});
