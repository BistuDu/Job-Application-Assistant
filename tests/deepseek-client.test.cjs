const assert = require('node:assert/strict');
const { test } = require('node:test');
const client = require('../deepseek-client.js');

const settings = { apiKey: 'test-key-not-a-real-credential', model: client.DEFAULT_MODEL };
const field = { fieldId: 'field-1', label: '联络号码', controlType: 'text', options: [] };
const sources = client.buildSources({ phone: '13800138000', family: [{ name: '李四' }], secret: 'not-in-prompt' }, ['phone', 'family']);
const assignment = { fieldId: field.fieldId, sourcePath: 'phone', optionId: null, transform: 'original' };
const response = (data, finishReason = 'stop') => ({ ok: true, json: async () => ({ choices: [{ finish_reason: finishReason, message: { content: typeof data === 'string' ? data : JSON.stringify(data) } }] }) });

test('画像来源包含数组与嵌套路径，排除不在字段定义中的内容', () => {
  assert.deepEqual(sources.sourcePaths, ['phone', 'family', 'family.0.name']);
  assert.equal(JSON.stringify(sources).includes('not-in-prompt'), false);
  const dangerous = JSON.parse('{"family":[{"name":"李四","constructor":"ignore","__proto__":"ignore"}]}');
  assert.deepEqual(client.buildSources(dangerous, ['family']).sourcePaths, ['family', 'family.0.name']);
});

test('缺少 Key 时不发起请求', async () => {
  let called = false;
  await assert.rejects(client.requestAssignments({ fields: [field], sources, settings: {}, fetchImpl: async () => { called = true; } }), /API Key/);
  assert.equal(called, false);
});

test('请求使用官方地址、JSON模式，Key只放认证头', async () => {
  let request;
  const result = await client.requestAssignments({ fields: [field], sources, settings, fetchImpl: async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return response({ assignments: [assignment] });
  } });
  assert.deepEqual(result, [assignment]);
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(request.options.headers.Authorization, `Bearer ${settings.apiKey}`);
  assert.equal(request.options.body.includes(settings.apiKey), false);
  assert.equal(request.body.thinking.type, 'disabled');
  assert.equal(request.body.response_format.type, 'json_object');
  assert.equal(request.body.messages[0].content.includes('JSON'), true);
  assert.equal(request.options.redirect, 'error');
});

test('鉴权失败不读取或展示可能反射密钥的服务端错误文本', async () => {
  await assert.rejects(client.requestAssignments({ fields: [field], sources, settings, fetchImpl: async () => ({ ok: false, status: 401, json: async () => { throw new Error('不应读取错误正文'); } }) }), /Key 无效/);
});

test('余额不足、限流和服务错误有明确反馈', async () => {
  for (const [status, message] of [[402, /余额不足/], [429, /频繁/], [503, /HTTP 503/]]) {
    await assert.rejects(client.requestAssignments({ fields: [field], sources, settings, fetchImpl: async () => ({ ok: false, status }) }), message);
  }
});

test('超时会中止请求，不自动重试计费', async () => {
  let calls = 0;
  await assert.rejects(client.requestAssignments({ fields: [field], sources, settings, timeoutMs: 10, fetchImpl: async (_url, { signal }) => {
    calls++;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  } }), /超时/);
  assert.equal(calls, 1);
});

test('截断、空回答、非法JSON一律不填写', async () => {
  for (const mock of [response({ assignments: [assignment] }, 'length'), response(''), response('not-json')]) {
    await assert.rejects(client.requestAssignments({ fields: [field], sources, settings, fetchImpl: async () => mock }));
  }
});

test('未知画像来源、未知字段和重复字段被拒绝', () => {
  for (const assignments of [
    [{ ...assignment, sourcePath: '__proto__.secret' }],
    [{ ...assignment, fieldId: 'not-on-page' }],
    [assignment, assignment],
    [{ ...assignment, sourcePath: 'missing' }],
  ]) assert.throws(() => client.validateAssignments({ assignments }, [field], sources.sourcePaths));
});

test('模型不能为普通文本选择选项，不能省略下拉选项或随意造选项', () => {
  const select = { ...field, controlType: 'select', options: [{ optionId: 'option-0', text: '选项' }] };
  assert.throws(() => client.validateAssignments({ assignments: [{ ...assignment, optionId: 'option-0' }] }, [field], sources.sourcePaths));
  assert.throws(() => client.validateAssignments({ assignments: [assignment] }, [select], sources.sourcePaths));
  assert.throws(() => client.validateAssignments({ assignments: [{ ...assignment, optionId: 'option-7' }] }, [select], sources.sourcePaths));
  assert.throws(() => client.validateAssignments({ assignments: [{ ...assignment, sourcePath: null, optionId: 'option-0' }] }, [select], sources.sourcePaths));
});

test('模型额外返回的 value/script 被丢弃，省略的字段明确跳过', () => {
  assert.deepEqual(client.validateAssignments({ assignments: [{ ...assignment, value: '伪造号码', script: 'bad-code' }] }, [field], sources.sourcePaths), [assignment]);
  assert.deepEqual(client.validateAssignments({ assignments: [] }, [field], sources.sourcePaths), [{ ...assignment, sourcePath: null }]);
});

test('日期转换不能用于电话等非日期来源', () => {
  assert.throws(() => client.validateAssignments({ assignments: [{ ...assignment, transform: 'year' }] }, [field], sources.sourcePaths));
});

test('启用填无时仅为允许的空缺键提供来源，关闭时不补键', () => {
  const allowed = client.buildSources({ name: '张三' }, ['name', 'english'], ['english', 'unknown']);
  assert.deepEqual(allowed.sourcePaths, ['name', 'english']);
  assert.deepEqual(allowed.emptyAsNoneKeys, ['english']);
  assert.equal(allowed.profile.english, '');
  assert.equal(client.buildSources({ name: '张三' }, ['name', 'english']).sourcePaths.includes('english'), false);
});

test('额外信息保留名称用于理解，但只允许填写内容来源', () => {
  const result = client.buildSources({ extraInfo: [{ label: '驾驶证', value: 'C1' }] }, ['extraInfo']);
  assert.equal(result.profile.extraInfo[0].label, '驾驶证');
  assert.equal(result.sourcePaths.includes('extraInfo.0.label'), false);
  assert.equal(result.sourcePaths.includes('extraInfo.0.value'), true);
});

const familySources = client.buildSources({ name: '本人', family: [
  { relation: '父亲', name: '父亲姓名', phone: '13900000001' },
  { relation: '母亲', name: '母亲姓名', phone: '13900000002' },
] }, ['name', 'family']);

test('参考已选关系约束每个字段，父亲与母亲分区可以同批判断', async () => {
  const fields = ['父亲', '母亲'].map((role, i) => ({ ...field, fieldId: `f-${i}`, label: '电话', section: '家庭信息',
    existingContext: [{ label: '关系', controlType: 'select', value: role, section: '家庭信息' }],
  }));
  let prompt;
  await client.requestAssignments({ fields, sources: familySources, settings, fetchImpl: async (_url, options) => {
    prompt = JSON.parse(JSON.parse(options.body).messages[1].content);
    return response({ assignments: fields.map((f, i) => ({ ...assignment, fieldId: f.fieldId, sourcePath: `family.${i}.phone` })) });
  } });
  assert.ok(prompt.fields[0].allowedSourcePaths.every(path => path.startsWith('family.0.')));
  assert.ok(prompt.fields[1].allowedSourcePaths.every(path => path.startsWith('family.1.')));
  assert.equal(prompt.fields[1].existingContext[0].value, '母亲');
  await assert.rejects(client.requestAssignments({ fields: [fields[1]], sources: familySources, settings,
    fetchImpl: async () => response({ assignments: [{ ...assignment, fieldId: fields[1].fieldId, sourcePath: 'family.0.phone' }] }),
  }), /页面已填信息不一致/);
});

test('姓名和实习单位已有值用于定位真实记录，缺失或冲突不回退第一条', () => {
  const name = { ...field, section: '家庭信息', existingContext: [{ label: '姓名', section: '家庭信息', value: '母亲姓名' }] };
  assert.ok(client.allowedContextSources(name, familySources).every(path => path.startsWith('family.1.')));
  const missing = { ...name, existingContext: [{ label: '关系', value: '配偶' }] };
  assert.deepEqual(client.allowedContextSources(missing, familySources), []);
  const conflict = { ...name, existingContext: [...name.existingContext, { label: '关系', value: '父亲' }] };
  assert.deepEqual(client.allowedContextSources(conflict, familySources), []);
  const sources = client.buildSources({ experiences: [{ org: '公司甲', role: '研发' }, { org: '公司乙', role: '产品' }] }, ['experiences']);
  const work = { section: '实习经历', existingContext: [{ label: '实习单位', value: '公司乙' }] };
  assert.deepEqual(client.allowedContextSources(work, sources), ['experiences.1.org', 'experiences.1.role']);
});

test('自定义资料可按页面已填关系和姓名判断，不要求固定家庭结构', () => {
  const sources = client.buildSources({ extraInfo: [
    { label: '父亲姓名', value: '张四' }, { label: '父亲电话', value: '13900000001' },
    { label: '母亲姓名', value: '李五' }, { label: '母亲电话', value: '13900000002' },
    { label: '其他说明', value: '不能混入' },
  ] }, ['extraInfo']);
  const field = { section: '家庭信息', existingContext: [{ label: '关系', value: '母亲' }] };
  assert.deepEqual(client.allowedContextSources(field, sources), ['extraInfo.2.value', 'extraInfo.3.value']);
  assert.deepEqual(client.allowedContextSources({ ...field, existingContext: [{ label: '姓名', section: '家庭信息', value: '李五' }] }, sources), ['extraInfo.2.value', 'extraInfo.3.value']);
  assert.deepEqual(client.allowedContextSources({ ...field, existingContext: [...field.existingContext, { label: '姓名', section: '家庭信息', value: '张四' }] }, sources), []);
});

test('经历上下文允许模型理解自定义名称，仍只能引用真实内容', () => {
  const sources = client.buildSources({ extraInfo: [{ label: '第二段实习的工作职责', value: '真实职责' }] }, ['extraInfo']);
  assert.deepEqual(client.allowedContextSources({ section: '实习经历', existingContext: [{ label: '公司', value: '公司乙' }] }, sources), ['extraInfo.0.value']);
});
