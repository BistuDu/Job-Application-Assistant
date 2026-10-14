const assert = require('node:assert/strict');
const { test } = require('node:test');
const client = require('../deepseek-client.js');
const settings = { apiKey: 'test-key-not-a-real-credential', model: client.DEFAULT_MODEL };
const field = { fieldId: 'f-1', label: '电话', controlType: 'text', options: [] };
const profile = { phone: '13800138000', family: [{ relation: '母亲', name: '李五' }], supplementText: '母亲的电话是13900000002，驾驶证类别是C1。' };
const sources = client.buildSources(profile);
const assignment = { fieldId: field.fieldId, sourcePath: 'phone', value: null, evidenceQuote: null, optionId: null, transform: 'original', fillNone: false };
const extracted = { ...assignment, sourcePath: null, value: '13900000002', evidenceQuote: profile.supplementText };
const response = (data, finishReason = 'stop') => ({ ok: true, json: async () => ({ choices: [{ finish_reason: finishReason, message: { content: typeof data === 'string' ? data : JSON.stringify(data) } }] }) });
const validate = (assignments, fields = [field], src = sources, options = {}) => client.validateAssignments({ assignments }, fields, src, options);

test('JSON 来源与自由文本分别提供，未知自定义 JSON 字段仍可用于模型', () => {
  assert.ok(sources.sourcePaths.includes('family.0.name'));
  assert.equal(sources.supplementText, profile.supplementText);
  assert.equal(sources.sourcePaths.includes('supplementText'), false);
  assert.deepEqual(client.buildSources({ arbitraryField: '真实资料' }).sourcePaths, ['arbitraryField']);
});

test('过滤画像中的密钥和危险对象属性', () => {
  const p = JSON.parse('{"name":"张三","apiKey":"private-key","family":[{"name":"李五","constructor":"bad","password":"private"}],"__proto__":"bad"}');
  const result = client.buildSources(p);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.deepEqual(result.sourcePaths, ['name', 'family', 'family.0.name']);
});

test('旧额外资料保留；保存新文本后不重复使用旧内容，清空不复活旧值', () => {
  const p = { extraInfo: [{ label: '驾驶证', value: 'C1' }] };
  assert.ok(client.buildSources(p).sourcePaths.includes('extraInfo.0.value'));
  assert.equal(client.buildSources(p).sourcePaths.includes('extraInfo.0.label'), false);
  for (const supplementText of ['', '驾驶证变更为C2']) {
    const result = client.buildSources({ ...p, supplementText });
    assert.equal(result.sourcePaths.includes('extraInfo.0.value'), false);
    assert.equal(result.supplementText, supplementText);
  }
});

test('补充文本超长或格式不正确时拒绝', () => {
  assert.throws(() => client.buildSources({ supplementText: 'a'.repeat(30001) }), /30000/);
  assert.throws(() => client.buildSources({ supplementText: {} }), /30000/);
});

test('可从实际原文摘录电话、证书和日期，保留证据', () => {
  assert.deepEqual(validate([extracted]), [extracted]);
  const p = client.buildSources({ supplementText: '实习日期为2025.06-2025.09。' });
  const item = { ...extracted, value: '2025.06-2025.09', evidenceQuote: p.supplementText, transform: 'startDate' };
  assert.deepEqual(validate([item], [field], p), [item]);
});

test('拒绝凭空捏造的值、伪造的证据以及只有证据没有内容的方案', () => {
  for (const item of [
    { ...extracted, value: '13900000009' }, { ...extracted, evidenceQuote: '父亲的电话是13900000002。' },
    { ...extracted, evidenceQuote: null }, { ...extracted, value: null }, { ...extracted, value: 123 },
  ]) assert.throws(() => validate([item]));
});

test('不能同时用 JSON 来源和模型生成值', () => {
  assert.throws(() => validate([{ ...extracted, sourcePath: 'phone' }]), /同时/);
});

test('未知来源、未知字段和重复字段被拒绝', () => {
  for (const items of [[{ ...assignment, sourcePath: '__proto__.name' }], [{ ...assignment, sourcePath: 'missing' }], [{ ...assignment, fieldId: 'missing' }], [assignment, assignment]]) assert.throws(() => validate(items));
});

test('模型只能选择页面真实选项，不能缺省选项或凭空选择', () => {
  const select = { ...field, controlType: 'select', options: [{ optionId: 'option-0', text: '可选' }] };
  assert.throws(() => validate([assignment], [select]));
  assert.throws(() => validate([{ ...assignment, optionId: 'option-99' }], [select]));
  assert.throws(() => validate([{ ...assignment, optionId: 'option-0' }]));
  assert.throws(() => validate([{ ...assignment, sourcePath: null, optionId: 'option-0' }], [select]));
  assert.equal(validate([{ ...extracted, optionId: 'option-0' }], [select])[0].value, extracted.value);
});

test('填无需要用户许可和已有空 JSON 来源，不把文字遗漏当没有', () => {
  const src = client.buildSources({ projects: [], name: '张三' });
  const none = { ...assignment, sourcePath: 'projects', fillNone: true };
  assert.throws(() => validate([none], [field], src));
  assert.equal(validate([none], [field], src, { fillNoneWhenEmpty: true })[0].fillNone, true);
  assert.throws(() => validate([{ ...none, sourcePath: null }], [field], src, { fillNoneWhenEmpty: true }));
  assert.throws(() => validate([{ ...none, sourcePath: 'name' }], [field], src, { fillNoneWhenEmpty: true }));
});

test('电话等长数字不能用日期转换；省略字段明确跳过且不执行额外代码', () => {
  assert.throws(() => validate([{ ...assignment, transform: 'year' }]), /非日期/);
  assert.deepEqual(validate([{ ...assignment, selector: '#fake', script: 'bad' }]), [assignment]);
  assert.equal(validate([])[0].sourcePath, null);
  assert.equal(validate([])[0].value, null);
});

test('请求包含 JSON、补充文本、已有页面上下文，Key只放认证头', async () => {
  let prompt, body;
  const result = await client.requestAssignments({ fields: [{ ...field, existingContext: [{ label: '关系', value: '母亲' }] }], sources, settings, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(options.headers.Authorization, `Bearer ${settings.apiKey}`);
    assert.equal(options.body.includes(settings.apiKey), false);
    assert.equal(options.redirect, 'error');
    body = JSON.parse(options.body); prompt = JSON.parse(body.messages[1].content);
    return response({ assignments: [extracted] });
  } });
  assert.deepEqual(result, [extracted]);
  assert.equal(prompt.profile.phone, profile.phone);
  assert.equal(prompt.supplementText, profile.supplementText);
  assert.equal(prompt.fields[0].existingContext[0].value, '母亲');
  assert.equal(body.response_format.type, 'json_object');
  assert.equal(body.thinking.type, 'disabled');
});

test('Key缺失时不请求；鉴权失败不显示服务端可能包含密钥的正文', async () => {
  let called = false;
  await assert.rejects(client.requestAssignments({ fields: [field], sources, settings: {}, fetchImpl: async () => { called = true; } }), /API Key/);
  assert.equal(called, false);
  await assert.rejects(client.requestAssignments({ fields: [field], sources, settings, fetchImpl: async () => ({ ok: false, status: 401, json: async () => { throw new Error('不应读取'); } }) }), /Key 无效/);
});

test('余额不足、限流、超时和不完整回答会停止，不重试计费', async () => {
  for (const [status, expected] of [[402, /余额不足/], [429, /频繁/], [503, /HTTP 503/]]) await assert.rejects(client.requestAssignments({ fields: [field], sources, settings, fetchImpl: async () => ({ ok: false, status }) }), expected);
  for (const data of [response(''), response('invalid-json'), response({ assignments: [assignment] }, 'length')]) await assert.rejects(client.requestAssignments({ fields: [field], sources, settings, fetchImpl: async () => data }));
  let calls = 0;
  await assert.rejects(client.requestAssignments({ fields: [field], sources, settings, timeoutMs: 10, fetchImpl: async (_url, { signal }) => {
    calls++; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  } }), /超时/);
  assert.equal(calls, 1);
});

test('空文本和空 JSON 不算有效资料，清空后忽略旧键值补充但保留原 JSON', () => {
  assert.equal(client.hasData({ name: '', family: [], supplementText: '   ' }), false);
  assert.equal(client.hasData({ extraInfo: [{ label: '驾驶证', value: 'C1' }], supplementText: '' }), false);
  assert.equal(client.hasData({ name: '张三', supplementText: '' }), true);
  assert.equal(client.hasData({ supplementText: '我叫张三' }), true);
  assert.throws(() => client.buildSources(['不应是数组']), /JSON 对象/);
});
