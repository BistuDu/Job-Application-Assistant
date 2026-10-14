const assert = require('node:assert/strict');
const { test } = require('node:test');
const client = require('../deepseek-client.js');
const { runFillJob } = require('../fill-controller.js');
const profile = { name: '张三', supplementText: '母亲叫李五。' };
const settings = { apiKey: 'test-key-not-real', model: client.DEFAULT_MODEL };
const field = { fieldId: 'f-1', label: '姓名', controlType: 'text', options: [] };
const scan = { snapshotToken: 'snapshot', modelFields: [field] };

test('只有扫描、模型请求、应用、清理一条路径，并携带原始补充文本', async () => {
  const calls = [];
  const result = await runFillJob({ profile, settings, client,
    execute: async (_profile, options) => {
      calls.push(options.action);
      if (options.action === 'scan') return scan;
      if (options.action === 'apply') return { filled: 1, filledFieldIds: [field.fieldId] };
      return {};
    }, requestModel: async ({ sources }) => { calls.push('request'); assert.equal(sources.supplementText, profile.supplementText); return []; },
  });
  assert.deepEqual(calls, ['scan', 'request', 'apply', 'cleanup']);
  assert.equal(result.filled, 1);
  assert.equal(result.unresolved, 0);
});

test('没有Key时不扫描也不写网页', async () => {
  let calls = 0;
  const result = await runFillJob({ profile, settings: {}, client, execute: async () => { calls++; }, requestModel: async () => {} });
  assert.match(result.error, /API Key/);
  assert.equal(calls, 0);
});

test('所有字段已有内容时不请求模型', async () => {
  let requests = 0;
  const result = await runFillJob({ profile, settings, client, execute: async () => ({ ...scan, modelFields: [], preserved: 2 }), requestModel: async () => { requests++; } });
  assert.equal(result.preserved, 2); assert.equal(requests, 0);
});

test('失败会清理快照，多批次失败保留已填结果', async () => {
  const fields = Array.from({ length: 21 }, (_, i) => ({ ...field, fieldId: `f-${i}` }));
  let batch = 0; const actions = [];
  const result = await runFillJob({ profile, settings, client,
    execute: async (_p, opts) => {
      actions.push(opts.action);
      if (opts.action === 'scan') return { ...scan, modelFields: fields };
      if (opts.action === 'apply') return { filled: 20, filledFieldIds: fields.slice(0, 20).map(f => f.fieldId) };
      return {};
    }, requestModel: async ({ fields: chunk }) => { assert.ok(chunk.length <= 20); if (++batch === 2) throw new Error('第二批失败'); return []; },
  });
  assert.equal(result.filled, 20); assert.equal(result.unresolved, 1); assert.equal(result.error, '第二批失败'); assert.equal(actions.at(-1), 'cleanup');
});

test('模型等待时用户补全的内容计为保留，并传递填无偏好', async () => {
  const result = await runFillJob({ profile, settings, client, fillNoneWhenEmpty: false,
    execute: async (_p, opts) => {
      if (opts.action === 'scan') return { ...scan, modelFields: [{ ...field, existingContext: [{ label: '关系', value: '母亲' }] }] };
      if (opts.action === 'apply') return { preserved: 1, preservedFieldIds: [field.fieldId] };
      return {};
    }, requestModel: async request => { assert.equal(request.fillNoneWhenEmpty, false); return []; },
  });
  assert.equal(result.preserved, 1); assert.equal(result.contextFields, 1); assert.equal(result.unresolved, 0);
});
