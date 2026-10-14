const assert = require('node:assert/strict');
const { test } = require('node:test');
const client = require('../deepseek-client.js');
const { runFillJob } = require('../fill-controller.js');
const profile = { name: '张三', phone: '13800138000' };
const settings = { apiKey: 'test-key-not-real', model: client.DEFAULT_MODEL };
const field = { fieldId: 'field-1', label: '联络号码', controlType: 'text', options: [] };
const scan = { filled: 1, snapshotToken: 'snapshot', modelFields: [field], sourceKeys: ['name', 'phone'] };

test('模式1先执行规则，再请求模型，最后应用与清理', async () => {
  const calls = [];
  const result = await runFillJob({ mode: 'hybrid', profile, settings, client,
    execute: async (_profile, options) => {
      calls.push(options.action);
      if (options.action === 'hybrid') return scan;
      if (options.action === 'apply') return { filled: 1, filledFieldIds: [field.fieldId] };
      return {};
    },
    requestModel: async () => { calls.push('model-request'); return []; },
  });
  assert.deepEqual(calls, ['hybrid', 'model-request', 'apply', 'cleanup']);
  assert.equal(result.ruleFilled, 1);
  assert.equal(result.modelFilled, 1);
  assert.equal(result.filled, 2);
  assert.equal(result.unresolved, 0);
});

test('模式2只扫描再请求模型，不执行规则填写', async () => {
  const calls = [];
  const result = await runFillJob({ mode: 'model', profile, settings, client,
    execute: async (_profile, options) => {
      calls.push(options.action);
      if (options.action === 'scan') return { ...scan, filled: 0 };
      if (options.action === 'apply') return { filled: 1, filledFieldIds: [field.fieldId] };
      return {};
    }, requestModel: async () => { calls.push('model-request'); return []; },
  });
  assert.deepEqual(calls, ['scan', 'model-request', 'apply', 'cleanup']);
  assert.equal(result.ruleFilled, 0);
  assert.equal(result.modelFilled, 1);
});

test('规则填完所有字段时模式1无需调用模型', async () => {
  let requests = 0;
  const result = await runFillJob({ mode: 'hybrid', profile, settings: {}, client,
    execute: async () => ({ ...scan, modelFields: [] }), requestModel: async () => { requests++; },
  });
  assert.equal(result.filled, 1);
  assert.equal(requests, 0);
  assert.equal(result.error, undefined);
});

test('模型失败保留模式1已填结果，并清理快照', async () => {
  const calls = [];
  const result = await runFillJob({ mode: 'hybrid', profile, settings, client,
    execute: async (_profile, options) => { calls.push(options.action); return options.action === 'hybrid' ? scan : {}; },
    requestModel: async () => { throw new Error('API 请求失败'); },
  });
  assert.equal(result.ruleFilled, 1);
  assert.equal(result.filled, 1);
  assert.equal(result.unresolved, 1);
  assert.equal(result.error, 'API 请求失败');
  assert.deepEqual(calls, ['hybrid', 'cleanup']);
});

test('模式2没有Key时不扫描、不改变网页', async () => {
  let executes = 0;
  const result = await runFillJob({ mode: 'model', profile, settings: {}, client, execute: async () => { executes++; }, requestModel: async () => {} });
  assert.match(result.error, /API Key/);
  assert.equal(executes, 0);
});

test('多个批次失败时保留先前成功批次和剩余字段统计', async () => {
  const fields = Array.from({ length: 21 }, (_, i) => ({ ...field, fieldId: `field-${i}` }));
  let batch = 0;
  const result = await runFillJob({ mode: 'model', profile, settings, client,
    execute: async (_profile, options) => {
      if (options.action === 'scan') return { ...scan, filled: 0, modelFields: fields };
      if (options.action === 'apply') return { filled: 20, filledFieldIds: fields.slice(0, 20).map(f => f.fieldId) };
      return {};
    }, requestModel: async ({ fields: chunk }) => {
      assert.ok(chunk.length <= 20);
      if (++batch === 2) throw new Error('第二批失败');
      return [];
    },
  });
  assert.equal(result.filled, 20);
  assert.equal(result.unresolved, 1);
  assert.equal(result.error, '第二批失败');
});

test('等待期间用户补全的字段计入保留，不再计为待处理', async () => {
  const result = await runFillJob({ mode: 'model', profile, settings, client,
    execute: async (_profile, options) => {
      assert.equal(options.action === 'cleanup' || options.allowOverwrite === false, true);
      if (options.action === 'scan') return { ...scan, filled: 0 };
      if (options.action === 'apply') return { filled: 0, preserved: 1, preservedFieldIds: [field.fieldId] };
      return {};
    }, requestModel: async () => [],
  });
  assert.equal(result.preserved, 1);
  assert.equal(result.unresolved, 0);
  assert.equal(result.filled, 0);
});

