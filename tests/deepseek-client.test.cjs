const assert = require('node:assert/strict');
const { test } = require('node:test');
const client = require('../deepseek-client.js');
const settings = { apiKey: 'test-key-not-a-real-credential', model: client.DEFAULT_MODEL };
const field = { fieldId: 'f-1', label: '电话', controlType: 'text', options: [] };
const select = { fieldId: 'f-2', label: '学历', controlType: 'select', options: [{ optionId: 'option-0', text: '本科', value: '1' }, { optionId: 'option-1', text: '硕士', value: '2' }] };
const text = '我叫张三，手机号是13900000002。母亲的电话是13800138000，驾驶证类别是C1。没有获得过竞赛奖项。';
const quote = '手机号是13900000002。';
const assignment = { fieldId: 'f-1', value: '13900000002', evidenceQuote: quote, optionId: null, transform: 'original', fillNone: false, note: null };
const raw = (content, finishReason = 'stop') => ({ ok: true, json: async () => ({ choices: [{ finish_reason: finishReason, message: { content } }] }) });
const response = (data, finishReason = 'stop') => raw(JSON.stringify(data), finishReason);
const validate = (assignments, fields = [field], source = text, options = {}) => client.validateAssignments({ assignments }, fields, source, options);
const request = (extra = {}) => client.requestAssignments({ fields: [field], text, settings, ...extra });

test('资料只接受文本：非文本和超长都会被拒绝', () => {
  assert.equal(client.prepareText('  我叫张三  '), '我叫张三');
  assert.equal(client.hasData('   '), false);
  assert.equal(client.hasData('我叫张三'), true);
  assert.equal(client.hasData({ name: '张三' }), false);
  assert.throws(() => client.prepareText({ name: '张三' }), /文本/);
  assert.throws(() => client.prepareText('a'.repeat(client.MAX_TEXT_LENGTH + 1)), /30000/);
});

test('内容必须能在资料原文中逐字核验', () => {
  assert.equal(validate([assignment]).assignments.length, 1);
  assert.equal(validate([{ ...assignment, value: '13700000000' }]).rejected[0].code, 'evidence_mismatch');
  assert.equal(validate([{ ...assignment, evidenceQuote: '手机号是13900000002，' }]).rejected[0].code, 'evidence_mismatch');
  assert.equal(validate([{ ...assignment, evidenceQuote: null }]).rejected[0].code, 'evidence_mismatch');
});

test('不合法的条目逐条拒绝，不影响同批其他字段', () => {
  const result = validate([
    { ...assignment, fieldId: 'missing' },
    { ...assignment, optionId: 'option-9' },
    assignment,
    assignment,
  ], [field, select]);
  assert.equal(result.assignments.length, 1);
  assert.deepEqual(result.rejected.map(item => item.code), ['model_error', 'bad_option', 'model_error']);
});

test('下拉与单选只能选择字段真实提供的选项', () => {
  const source = '本科毕业于某某大学。';
  const item = { fieldId: 'f-2', value: '本科', evidenceQuote: '本科毕业于某某大学。', optionId: 'option-0', transform: 'original', fillNone: false };
  assert.equal(validate([item], [select], source).assignments.length, 1);
  assert.equal(validate([{ ...item, optionId: null }], [select], source).rejected[0].code, 'no_option');
  assert.equal(validate([{ ...item, optionId: 'option-7' }], [select], source).rejected[0].code, 'bad_option');
  assert.equal(validate([{ ...item, fieldId: 'f-1', optionId: 'option-0' }], [field, select], source).rejected[0].code, 'bad_option');
});

test('填「无」需要开关、明确的空缺说法和原文依据', () => {
  const none = { fieldId: 'f-1', value: '无', evidenceQuote: '没有获得过竞赛奖项。', optionId: null, transform: 'original', fillNone: true };
  assert.equal(validate([none], [field], text, { fillNoneWhenEmpty: true }).assignments.length, 1);
  assert.equal(validate([none], [field], text).rejected[0].code, 'bad_fillnone');
  assert.equal(validate([{ ...none, value: '张三' }], [field], text, { fillNoneWhenEmpty: true }).rejected[0].code, 'bad_fillnone');
  assert.equal(validate([{ ...none, evidenceQuote: '我叫张三，手机号是13900000002。' }], [field], text, { fillNoneWhenEmpty: true }).rejected[0].code, 'bad_fillnone');
  assert.equal(validate([{ ...none, evidenceQuote: '资料里没有这句话' }], [field], text, { fillNoneWhenEmpty: true }).rejected[0].code, 'bad_fillnone');
});

test('日期转换只用于真实日期文本', () => {
  const source = '实习时间2025.06-2025.09。';
  const item = { fieldId: 'f-1', value: '2025.06-2025.09', evidenceQuote: '实习时间2025.06-2025.09。', optionId: null, transform: 'startDate' };
  assert.equal(validate([item], [field], source).assignments[0].transform, 'startDate');
  assert.equal(validate([{ ...item, transform: 'original' }], [field], source).assignments[0].value, '2025.06-2025.09');
  assert.equal(validate([{ ...item, transform: 'unknown' }], [field], source).rejected[0].code, 'bad_transform');
  assert.equal(validate([{ ...assignment, transform: 'year' }]).rejected[0].code, 'bad_transform');
});

test('无法确定的字段返回空值并说明缺什么资料', () => {
  const result = validate([{ fieldId: 'f-1', value: null, evidenceQuote: null, optionId: null, transform: 'original', fillNone: false, note: '缺少紧急联系人电话' }]);
  assert.equal(result.assignments.length, 0);
  assert.equal(result.rejected[0].code, 'no_value');
  assert.equal(result.rejected[0].note, '缺少紧急联系人电话');
  assert.equal(result.rejected[0].label, '电话');
});

test('整体结构不可用时抛出的错误标记为可修正', () => {
  assert.throws(() => validate('不是对象'), error => error.fatal === false && /格式/.test(error.message));
});

test('请求只发送资料文本与字段，Key 只放在认证头', async () => {
  let captured;
  const result = await request({ fetchImpl: async (url, init) => { assert.equal(url, 'https://api.deepseek.com/chat/completions'); captured = init; return response({ assignments: [assignment] }); } });
  const body = JSON.parse(captured.body);
  const payload = JSON.parse(body.messages[1].content);
  assert.equal(payload.text, text);
  assert.equal(payload.fields[0].label, '电话');
  assert.equal(payload.sourcePaths, undefined);
  assert.equal(payload.profile, undefined);
  assert.equal(captured.body.includes('test-key-not-a-real-credential'), false);
  assert.equal(captured.headers.Authorization, 'Bearer test-key-not-a-real-credential');
  assert.equal(captured.redirect, 'error');
  assert.equal(body.response_format.type, 'json_object');
  assert.equal(body.temperature, 0);
  assert.equal(body.thinking.type, 'disabled');
  assert.match(body.messages[0].content, /逐字复制/);
  assert.equal(result.assignments.length, 1);
});

test('修正轮把失败原因、字段约束和真实选项一并交给模型', async () => {
  let body, system;
  const feedback = [{ fieldId: 'f-2', label: '学历', code: 'bad_option', reason: '模型选择了不存在的表单选项', previousValue: '硕士', constraints: { controlType: 'select' }, options: select.options }];
  await client.requestAssignments({ fields: [select], text, settings, fillNoneWhenEmpty: true, feedback, fetchImpl: async (_url, init) => { const outer = JSON.parse(init.body); body = JSON.parse(outer.messages[1].content); system = outer.messages[0].content; return response({ assignments: [] }); } });
  assert.equal(body.feedback[0].code, 'bad_option');
  assert.equal(body.feedback[0].previousValue, '硕士');
  assert.equal(body.feedback[0].options[0].optionId, 'option-0');
  assert.equal(body.fillNoneWhenEmpty, true);
  assert.match(system, /修正轮/);
  assert.match(system, /禁止截断/);
});

test('鉴权、余额、限流和网络问题直接终止，内容问题留给修正轮', async () => {
  for (const [status, pattern] of [[401, /API Key 无效/], [402, /余额不足/], [429, /过于频繁/], [503, /HTTP 503/]]) {
    await assert.rejects(request({ fetchImpl: async () => ({ ok: false, status }) }), error => error.fatal === true && pattern.test(error.message));
  }
  await assert.rejects(request({ fetchImpl: async () => raw('不是 JSON') }), error => error.fatal === false && /JSON/.test(error.message));
  await assert.rejects(request({ fetchImpl: async () => raw('{"assignments":[]}', 'length') }), error => error.fatal === false && /未完整结束/.test(error.message));
  await assert.rejects(request({ fetchImpl: async () => raw('') }), error => error.fatal === false && /空内容/.test(error.message));
  await assert.rejects(request({ fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'secret-body' }) }), error => !error.message.includes('secret-body'));
});

test('Key 缺失、超时或字段数量异常时不产生额外请求', async () => {
  let called = false;
  await assert.rejects(client.requestAssignments({ fields: [field], text, settings: { apiKey: '   ' }, fetchImpl: async () => { called = true; } }), /API Key/);
  await assert.rejects(request({ fields: [], fetchImpl: async () => { called = true; } }), /字段数量/);
  await assert.rejects(request({ fields: Array.from({ length: client.BATCH_SIZE + 1 }, () => field), fetchImpl: async () => { called = true; } }), /字段数量/);
  let calls = 0;
  await assert.rejects(request({ timeoutMs: 10, fetchImpl: async (_url, { signal }) => { calls++; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))); } }), error => error.fatal === true && /超时/.test(error.message));
  assert.equal(calls, 1);
  assert.equal(called, false);
});
