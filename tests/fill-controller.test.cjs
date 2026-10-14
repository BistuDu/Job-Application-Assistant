const assert = require('node:assert/strict');
const { test } = require('node:test');
const client = require('../deepseek-client.js');
const { runFillJob } = require('../fill-controller.js');
const settings = { apiKey: 'test-key-not-real', model: client.DEFAULT_MODEL };
const userText = '我叫张三，手机号是13900000002。没有获得过竞赛奖项。';
const fields = [
  { fieldId: 'f-1', label: '姓名', controlType: 'text', options: [] },
  { fieldId: 'f-2', label: '手机号', controlType: 'text', options: [] },
];
const scan = { snapshotToken: 'snapshot', modelFields: fields };
const outcome = (fieldId, status, code, extra = {}) => ({ fieldId, label: '', status, code, ...extra });
const fillItem = (fieldId, value, evidenceQuote) => ({ fieldId, value, evidenceQuote, optionId: null, transform: 'original', fillNone: false });

test('扫描、模型、应用、清理单一路径，资料以文本传递', async () => {
  const calls = [], texts = [];
  const result = await runFillJob({ userText, settings, client,
    execute: async (text, options) => {
      calls.push(options.action); texts.push(text);
      if (options.action === 'scan') return scan;
      if (options.action === 'apply') return { outcomes: options.assignments.map(item => outcome(item.fieldId, 'filled', 'ok')) };
      return {};
    },
    requestModel: async ({ text }) => {
      calls.push('request');
      assert.equal(text, userText);
      return { assignments: [fillItem('f-1', '张三', '我叫张三'), fillItem('f-2', '13900000002', userText)], rejected: [] };
    },
  });
  assert.deepEqual(calls, ['scan', 'request', 'apply', 'cleanup']);
  assert.equal(texts[0], userText);
  assert.equal(result.filled, 2);
  assert.equal(result.modelFilled, 2);
  assert.equal(result.unresolved, 0);
});

test('没有 Key 或资料为空时不扫描也不写网页', async () => {
  let called = false;
  const noKey = await runFillJob({ userText, settings: { apiKey: '' }, client, execute: async () => { called = true; }, requestModel: async () => ({ assignments: [], rejected: [] }) });
  assert.equal(called, false); assert.match(noKey.error, /API Key/);
  const noText = await runFillJob({ userText: '   ', settings, client, execute: async () => { called = true; }, requestModel: async () => ({ assignments: [], rejected: [] }) });
  assert.equal(called, false); assert.match(noText.error, /资料/);
});

test('所有字段已有内容时不请求模型', async () => {
  let requests = 0;
  const result = await runFillJob({ userText, settings, client,
    execute: async (_text, options) => options.action === 'scan' ? { ...scan, modelFields: [], preserved: 2, skippedFields: [] } : {},
    requestModel: async () => { requests++; return { assignments: [], rejected: [] }; },
  });
  assert.equal(result.preserved, 2);
  assert.equal(requests, 0);
});

test('扫描阶段跳过的字段按名称进入需手动处理清单', async () => {
  const result = await runFillJob({ userText, settings, client,
    execute: async (_text, options) => options.action === 'scan'
      ? { snapshotToken: 's', modelFields: [], file: 1, captcha: 1, skippedFields: [{ label: '简历附件', code: 'file' }, { label: '图形验证码', code: 'captcha' }] }
      : {},
    requestModel: async () => ({ assignments: [], rejected: [] }),
  });
  assert.deepEqual(result.manual, [{ label: '简历附件', reason: '上传文件' }, { label: '图形验证码', reason: '验证码' }]);
  assert.equal(result.file, 1);
  assert.equal(result.captcha, 1);
});

test('致命错误保留已填结果，其余批次不再执行并清理快照', async () => {
  const many = Array.from({ length: 21 }, (_, index) => ({ fieldId: `f-${index}`, label: `字段${index}`, controlType: 'text', options: [] }));
  const actions = [];
  let batch = 0;
  const result = await runFillJob({ userText, settings, client,
    execute: async (_text, options) => {
      actions.push(options.action);
      if (options.action === 'scan') return { snapshotToken: 's', modelFields: many };
      if (options.action === 'apply') return { outcomes: options.assignments.map(item => outcome(item.fieldId, 'filled', 'ok')) };
      return {};
    },
    requestModel: async ({ fields: chunk }) => {
      assert.ok(chunk.length <= 20);
      if (++batch === 2) { const error = new Error('DeepSeek 请求超时，已填写的内容保留，可稍后重试'); error.fatal = true; throw error; }
      return { assignments: chunk.map(item => fillItem(item.fieldId, '张三', '我叫张三')), rejected: [] };
    },
  });
  assert.equal(result.filled, 20);
  assert.equal(result.error, 'DeepSeek 请求超时，已填写的内容保留，可稍后重试');
  assert.equal(actions.at(-1), 'cleanup');
});

test('内容类错误只影响本批：修正轮带失败原因重问并计入修正数', async () => {
  const requests = [], applied = [];
  const result = await runFillJob({ userText, settings, client,
    execute: async (_text, options) => {
      if (options.action === 'scan') return scan;
      if (options.action === 'apply') {
        applied.push(options.assignments.map(item => item.fieldId));
        return { outcomes: options.assignments.map(item => outcome(item.fieldId, 'filled', 'ok')) };
      }
      return {};
    },
    requestModel: async request => {
      requests.push(request);
      if (!request.feedback) return { assignments: [], rejected: [
        { fieldId: 'f-1', label: '姓名', code: 'evidence_mismatch', detail: '内容不能从资料原文逐字核验', note: '' },
        { fieldId: 'f-2', label: '手机号', code: 'no_value', detail: '模型认为资料中没有对应内容', note: '缺少紧急联系人电话' },
      ] };
      return { assignments: [fillItem('f-1', '张三', '我叫张三')], rejected: [] };
    },
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].fields.length, 2);
  assert.deepEqual(requests[1].feedback.map(item => item.fieldId), ['f-1', 'f-2']);
  assert.match(requests[1].feedback[0].reason, /逐字/);
  assert.equal(requests[1].feedback[0].constraints.controlType, 'text');
  assert.deepEqual(applied, [[], ['f-1']]);
  assert.equal(result.repaired, 1);
  assert.equal(result.unresolved, 1);
  assert.deepEqual(result.notes, ['缺少紧急联系人电话']);
  assert.equal(result.issues[0].label, '手机号');
  assert.match(result.issues[0].reason, /资料中没有找到对应内容/);
});

test('只重试可修复的失败：控件类与页面变化不重试', async () => {
  let requests = 0;
  const result = await runFillJob({ userText, settings, client,
    execute: async (_text, options) => {
      if (options.action === 'scan') return scan;
      if (options.action === 'apply') return { outcomes: [
        outcome('f-1', 'skipped', 'unsettable', { detail: '页面控件不接受自动写入' }),
        outcome('f-2', 'skipped', 'stale', { detail: '字段内容已变化' }),
      ] };
      return {};
    },
    requestModel: async () => { requests++; return { assignments: [], rejected: [] }; },
  });
  assert.equal(requests, 1);
  assert.equal(result.retried, 0);
  assert.equal(result.unresolved, 2);
  assert.deepEqual(result.issues.map(item => item.code), ['unsettable', 'stale']);
  assert.deepEqual(result.pendingLabels, ['姓名', '手机号']);
});

test('修正轮最多一次：同类原因再次失败即停止', async () => {
  let requests = 0;
  const result = await runFillJob({ userText, settings, client,
    execute: async (_text, options) => {
      if (options.action === 'scan') return { snapshotToken: 'snapshot', modelFields: [fields[0]] };
      if (options.action === 'apply') return { outcomes: [outcome('f-1', 'skipped', 'bad_option', { detail: '没有匹配的选项' })] };
      return {};
    },
    requestModel: async () => { requests++; return { assignments: [], rejected: [] }; },
  });
  assert.equal(requests, 2);
  assert.equal(result.retried, 1);
  assert.equal(result.repaired, 0);
  assert.equal(result.unresolved, 1);
});

test('超过 300 个待识别字段时停止并提示分步展开', async () => {
  const many = Array.from({ length: 301 }, (_, index) => ({ fieldId: `f-${index}`, label: `字段${index}`, controlType: 'text', options: [] }));
  let requests = 0;
  const result = await runFillJob({ userText, settings, client,
    execute: async (_text, options) => options.action === 'scan' ? { snapshotToken: 's', modelFields: many } : {},
    requestModel: async () => { requests++; return { assignments: [], rejected: [] }; },
  });
  assert.equal(requests, 0);
  assert.match(result.error, /300/);
});
