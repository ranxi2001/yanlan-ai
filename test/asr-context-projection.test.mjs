import test from 'node:test';
import assert from 'node:assert/strict';
import { projectAsrContext } from '../src/asr-context-projection.js';

function input(text, context) {
  const window = { id: 1, core_start: 30, core_end: 60, audio_start: 30, audio_end: 60 };
  return { core: { text, window }, contextual: { text: context, window: { ...window, audio_start: 28, audio_end: 62 } } };
}
const head='今天我们讨论一下',tail='具体方案下周确认';
test('context can repair interior without publishing adjacent speech', () => {
  const r=projectAsrContext(input(head+'服物器配置'+tail,'前面的话'+head+'服务器配置'+tail+'后面的话'));
  assert.equal(r.text,head+'服务器配置'+tail); assert.equal(r.status,'projected');
  assert.equal(r.patch.before,'服物器配置');assert.equal(r.patch.after,'服务器配置');
});
test('missing and repeated anchors retain original text', () => {
  for (const context of [head+'配置错误结尾',head+head+'配置'+tail]) {
    const i=input(head+'配置'+tail,context);const r=projectAsrContext(i);
    assert.equal(r.text,i.core.text);assert.equal(r.status,'fallback');
  }
});
test('real repeated speech inside owned text is retained', () => {
  const text=head+'对对对还是这个这个配置'+tail;
  assert.equal(projectAsrContext(input(text,'前文'+text+'后文')).text,text);
});
test('large omissions are refused and source timing cannot be changed', () => {
  const i=input(head+'我们需要保留所有重要部署信息'+tail,head+'部署'+tail);
  assert.equal(projectAsrContext(i).reason,'excessive_change');
  i.contextual.window.core_start=29;assert.throws(()=>projectAsrContext(i),/ownership/);
});
test('unicode patch offsets replay exactly; failed requests cannot replace text', () => {
  const i=input('😀'+head+'服物器配置'+tail,'别的😀'+head+'服务器配置'+tail);
  const r=projectAsrContext(i);assert.equal(i.core.text.slice(r.patch.start_offset,r.patch.end_offset),r.patch.before);
  i.contextual.status='failed';assert.equal(projectAsrContext(i).text,i.core.text);
});
