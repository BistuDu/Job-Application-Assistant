const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const DEFAULT_TEXT = '我叫张三，联系号码是13800138000。';
let browser;
before(async () => { browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'chrome', headless: true }); });
after(async () => { if (browser) await browser.close(); });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const fillItem = (fieldId, value, quote, extra = {}) => ({ fieldId, value, evidenceQuote: quote, optionId: null, transform: 'original', fillNone: false, note: null, ...extra });
// 真正执行后台、客户端、弹窗、编辑器、悬浮球和 DOM 引擎；只替换 chrome API 与外部 DeepSeek 网络。
async function setup({ configured = true, delayed = false, failing = false, previousJob = null, modelReply = null, local = null } = {}) {
  const pages = [];
  const form = await browser.newPage();
  pages.push(form);
  await form.setContent('<p><label>姓名<input id="name"></label></p><p><label>常用联络号码<input id="contact"></label></p>');
  const store = local || { userText: DEFAULT_TEXT, fillNoneWhenEmpty: true };
  if (configured) store.deepseek = { apiKey: 'test-key-not-a-real-credential', model: 'deepseek-flash' };
  const session = previousJob ? { fillJob: previousJob } : {};
  const requests = [], injections = [], windows = [];
  let listener;
  let release;
  const gate = delayed ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
  function storage(object) {
    return {
      get: async keys => Object.fromEntries((typeof keys === 'string' ? [keys] : keys).map(key => [key, structuredClone(object[key])])),
      set: async data => { Object.assign(object, structuredClone(data)); },
      remove: async key => { delete object[key]; },
      setAccessLevel: async () => {},
    };
  }
  const chrome = {
    storage: { local: storage(store), session: storage(session) },
    tabs: {
      get: async id => ({ id, windowId: 1, url: 'https://jobs.example/apply' }),
      query: async () => [{ id: 7, url: 'https://jobs.example/apply' }],
      sendMessage: async (_id, message) => form.evaluate(message => new Promise((resolve, reject) => {
        if (!window.__floatOnMessage) { reject(new Error('No receiver')); return; }
        window.__floatOnMessage(message, { id: 'test' }, resolve);
      }), message),
    },
    windows: { create: async config => { windows.push(config); return { id: 10 }; } },
    runtime: { id: 'test', getURL: file => `chrome-extension://test/${file}`, getPlatformInfo: async () => ({}), onInstalled: { addListener: () => {} }, onMessage: { addListener: fn => { listener = fn; } } },
    scripting: { executeScript: async ({ target, func, args }) => {
      injections.push({ target, action: args[1].action });
      if (target.documentIds) assert.deepEqual(Array.from(target.documentIds), ['document-1']);
      const result = await form.evaluate(({ source, args }) => (0, eval)(`(${source})`)(...args), { source: func.toString(), args });
      return [{ result, documentId: 'document-1', frameId: 0 }];
    } },
  };
  const context = vm.createContext({ chrome, crypto: webcrypto, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, console,
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      await gate;
      if (failing) return { ok: false, status: 401 };
      const payload = JSON.parse(body.messages[1].content);
      const { fields, text } = payload;
      const reply = modelReply ? modelReply(payload, text) : { assignments: fields.map(field => fillItem(field.fieldId, field.label === '姓名' ? '张三' : '13800138000', field.label === '姓名' ? '我叫张三' : '联系号码是13800138000。')) };
      return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(reply) } }] }) };
    },
  });
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context));
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);

  const send = (message, sender = { id: 'test', url: 'chrome-extension://test/popup.html' }) => new Promise(resolve => {
    if (listener(message, sender, resolve) === false) resolve({ ok: false, error: 'Unauthorized' });
  });
  async function openPopup(targetTabId = null) {
    const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
    pages.push(page);
    await page.exposeFunction('__extensionMessage', send);
    await page.exposeFunction('__localGet', keys => chrome.storage.local.get(keys));
    await page.exposeFunction('__localSet', data => chrome.storage.local.set(data));
    const html = fs.readFileSync(path.join(root, 'popup.html'), 'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link[^>]*>/g, '');
    if (targetTabId) {
      await page.route('https://extension-ui.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
      await page.goto(`https://extension-ui.test/popup.html?targetTabId=${targetTabId}`);
    } else await page.setContent(html);
    await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'popup.css'), 'utf8') });
    await page.evaluate(() => {
      window.chrome = {
        runtime: { sendMessage: message => window.__extensionMessage(message), getURL: file => `chrome-extension://test/${file}` },
        tabs: { query: (_query, callback) => callback([{ id: 7, url: 'https://jobs.example/apply' }]), create: () => {} },
        storage: { local: { get: (keys, callback) => window.__localGet(keys).then(callback), set: (data, callback) => window.__localSet(data).then(() => callback?.()) }, onChanged: { addListener: () => {} } },
      };
    });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'popup.js'), 'utf8') });
    await page.waitForFunction(() => ['Key 已保存', '未配置'].includes(document.getElementById('deepseek-status').textContent));
    return page;
  }
  async function done(previousId = null) {
    for (let count = 0; count < 300; count++) {
      if (session.fillJob && session.fillJob.id !== previousId && session.fillJob.status !== 'running') return session.fillJob;
      await wait(20);
    }
    throw new Error('任务未按时完成');
  }
  async function waitingModel() {
    for (let count = 0; count < 250; count++) { if (requests.length) return; await wait(20); }
    throw new Error('未调用模型');
  }
  async function mountFloating() {
    await form.exposeFunction('__floatSend', message => send(message, { id: 'test', tab: { id: 7 }, frameId: 0, url: 'https://jobs.example/apply' }));
    await form.evaluate(() => {
      const attach = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (options) {
        const root = attach.call(this, options);
        if (this.tagName === 'JH-APPLICATION-HELPER') window.__floatShadow = root;
        return root;
      };
      window.chrome = { runtime: { id: 'test', sendMessage: message => window.__floatSend(message), onMessage: { addListener: fn => { window.__floatOnMessage = fn; } } } };
    });
    await form.addScriptTag({ content: fs.readFileSync(path.join(root, 'floating.js'), 'utf8') });
    await form.waitForFunction(() => document.querySelector('jh-application-helper')?.isConnected);
  }
  async function openEditor() {
    const page = await browser.newPage();
    pages.push(page);
    await page.exposeFunction('__localGet', keys => chrome.storage.local.get(keys));
    await page.exposeFunction('__extensionMessage', send);
    await page.setContent(fs.readFileSync(path.join(root, 'editor.html'), 'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link[^>]*>/g, ''));
    await page.evaluate(() => {
      window.chrome = { runtime: { sendMessage: message => window.__extensionMessage(message) }, storage: { local: { get: (keys, callback) => window.__localGet(keys).then(callback) }, onChanged: { addListener: () => {} } } };
    });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'editor.js'), 'utf8') });
    await page.evaluate(() => document.dispatchEvent(new Event('DOMContentLoaded')));
    await page.waitForFunction(() => document.getElementById('profile-text').value.length > 0);
    return page;
  }
  async function floatClick(selector) {
    const rect = await form.evaluate(selector => {
      const r = window.__floatShadow.querySelector(selector).getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }, selector);
    await form.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  }
  return { form, local: store, session, requests, injections, windows, send, openPopup, openEditor, done, waitingModel, release, mountFloating, floatClick,
    close: async () => { release?.(); if (session.fillJob?.status === 'running') await done(); for (const page of pages) if (!page.isClosed()) await page.close(); },
  };
}


test('主页只有一个填写按钮，文本资料直接走模型路径', async () => {
  const app = await setup();
  try {
    const popup = await app.openPopup();
    assert.equal(await popup.getByRole('button', { name: '一键填写本页', exact: true }).count(), 1);
    assert.equal(await popup.locator('.fill-actions button').count(), 1);
    await popup.locator('#btn-fill-model').click();
    const job = await app.done();
    assert.equal(job.result.filled, 2);
    assert.equal(job.result.repaired, 0);
    assert.equal(await app.form.locator('#name').inputValue(), '张三');
    assert.deepEqual(app.injections.map(i => i.action), ['scan', 'apply', 'cleanup']);
    await popup.waitForFunction(() => !document.getElementById('btn-fill-model').disabled);
    fs.mkdirSync(path.join(root, '.test-artifacts'), { recursive: true });
    await popup.locator('.wrap').screenshot({ path: path.join(root, '.test-artifacts/model-popup.png') });
  } finally { await app.close(); }
});

test('快速补充对话框保存的就是完整资料文本', async () => {
  const app = await setup();
  try {
    const popup = await app.openPopup(); await popup.locator('#btn-add-profile').click();
    assert.equal(await popup.locator('#supplement-text').inputValue(), DEFAULT_TEXT);
    const text = '我叫张三，联系号码是13800138000。\n母亲叫李五，电话为13900000002。';
    await popup.locator('#supplement-text').fill(text); await popup.locator('#btn-save-profile').click();
    await popup.waitForFunction(() => document.getElementById('profile-save-result').textContent.includes('已保存'));
    assert.equal(app.local.userText, text);
    assert.equal(app.local.profile, undefined);
    await popup.waitForFunction(() => document.getElementById('profile-status').textContent.includes('已保存'));
    await popup.locator('.wrap').screenshot({ path: path.join(root, '.test-artifacts/text-profile.png') });
  } finally { await app.close(); }
});

test('资料编辑器只保存文本并统计字数', async () => {
  const app = await setup();
  try {
    const editor = await app.openEditor();
    assert.equal(await editor.locator('#profile-text').inputValue(), DEFAULT_TEXT);
    assert.equal(await editor.locator('#char-count').textContent(), `${DEFAULT_TEXT.length} / 30000 字`);
    const text = '我叫张三，联系号码是13800138000。驾驶证类别为C1。';
    await editor.locator('#profile-text').fill(text);
    await editor.locator('#btn-save').click();
    await editor.waitForFunction(() => document.getElementById('save-toast').textContent === '资料已保存');
    assert.equal(app.local.userText, text);
    await editor.locator('#profile-text').fill('');
    await editor.locator('#btn-example').click();
    assert.ok((await editor.locator('#profile-text').inputValue()).includes('姓名'));
  } finally { await app.close(); }
});

test('旧 JSON 画像在首次启动时改写为文本，不丢失已有内容', async () => {
  const app = await setup({ local: { profile: { name: '张三', city: '杭州', family: [{ relation: '母亲', name: '李五' }], supplementText: '母亲电话为13900000002。', extraInfo: [{ label: '驾驶证', value: 'C1' }] } } });
  try {
    await app.send({ type: 'GET_FILL_JOB' });
    assert.equal(app.local.profile, undefined);
    assert.match(app.local.userText, /母亲电话为13900000002。/);
    assert.match(app.local.userText, /驾驶证：C1/);
    assert.match(app.local.userText, /"name": "张三"/);
    assert.match(app.local.userText, /"relation": "母亲"/);
  } finally { await app.close(); }
});

test('按失败原因自动修正：第一轮选项错误，第二轮带原因重问后填上', async () => {
  const text = '我叫张三，联系号码是13800138000。';
  const app = await setup({ modelReply: (payload, current) => {
    if (!payload.feedback) return { assignments: [fillItem(payload.fields[0].fieldId, '13900000000', current), fillItem(payload.fields[1].fieldId, '13800138000', current)] };
    assert.equal(payload.feedback.length, 1);
    assert.equal(payload.feedback[0].code, 'evidence_mismatch');
    assert.equal(payload.feedback[0].previousValue, '13900000000');
    return { assignments: [fillItem(payload.feedback[0].fieldId, '张三', '我叫张三')] };
  } });
  try {
    await app.form.setContent('<p><label>姓名<input id="name"></label></p><p><label>常用联络号码<input id="contact"></label></p>');
    const popup = await app.openPopup(); await popup.locator('#btn-fill-model').click();
    const job = await app.done();
    assert.equal(app.requests.length, 2);
    assert.equal(job.result.repaired, 1);
    assert.equal(job.result.filled, 2);
    assert.equal(job.result.unresolved, 0);
    assert.equal(await app.form.locator('#name').inputValue(), '张三');
    assert.ok(JSON.parse(app.requests[1].messages[1].content).feedback);
  } finally { await app.close(); }
});

test('一个字段的问题不再作废其他字段：其余字段照常填写并列出原因', async () => {
  const app = await setup({ modelReply: payload => ({ assignments: [
    fillItem(payload.fields[0].fieldId, '99999999999', '没有这段原文'),
    ...(payload.fields[1] ? [fillItem(payload.fields[1].fieldId, '13800138000', '联系号码是13800138000。')] : []),
  ] }) });
  try {
    const popup = await app.openPopup(); await popup.locator('#btn-fill-model').click();
    const job = await app.done();
    assert.equal(job.status, 'done');
    assert.equal(job.result.filled, 1);
    assert.equal(job.result.unresolved, 1);
    assert.equal(job.result.issues.length, 1);
    assert.equal(job.result.issues[0].label, '姓名');
    assert.equal(await app.form.locator('#name').inputValue(), '');
    await popup.waitForFunction(() => document.getElementById('fill-result').textContent.includes('待处理 1 项'));
    assert.match(await popup.locator('#fill-result').textContent(), /姓名：/);
  } finally { await app.close(); }
});

test('模型说明缺少什么资料时提示用户补充', async () => {
  const app = await setup({ modelReply: payload => ({ assignments: [
    { fieldId: payload.fields[0].fieldId, value: null, evidenceQuote: null, optionId: null, transform: 'original', fillNone: false, note: '缺少紧急联系人电话' },
    { fieldId: payload.fields[1].fieldId, value: null, evidenceQuote: null, optionId: null, transform: 'original', fillNone: false, note: '' },
  ] }) });
  try {
    const popup = await app.openPopup(); await popup.locator('#btn-fill-model').click();
    const job = await app.done();
    assert.deepEqual(job.result.notes, ['缺少紧急联系人电话']);
    assert.equal(job.result.unresolved, 2);
    await popup.waitForFunction(() => document.getElementById('fill-result').textContent.includes('需你补充'));
  } finally { await app.close(); }
});

test('扫描阶段跳过的字段按名称列出，便于手动处理', async () => {
  const app = await setup({ modelReply: () => ({ assignments: [], rejected: [] }) });
  try {
    await app.form.setContent('<p><label>姓名<input id="name"></label></p><p><label>简历附件<input id="file" type="file"></label></p><p><label>图形验证码<input id="code"></label></p>');
    const popup = await app.openPopup(); await popup.locator('#btn-fill-model').click();
    const job = await app.done();
    assert.equal(job.result.file, 1);
    assert.equal(job.result.captcha, 1);
    const labels = job.result.manual.map(item => item.label);
    assert.ok(labels.includes('简历附件'));
    assert.ok(labels.includes('图形验证码'));
    await popup.waitForFunction(() => document.getElementById('fill-result').textContent.includes('需手动处理'));
  } finally { await app.close(); }
});

test('等待模型时用户输入会保留，关闭弹窗任务继续，可重新查看结果', async () => {
  const app = await setup({ delayed: true });
  try {
    const popup = await app.openPopup(); await popup.locator('#btn-fill-model').click(); await app.waitingModel();
    assert.equal(await app.form.locator('#name').inputValue(), '');
    await app.form.locator('#contact').fill('用户新增号码');
    const duplicate = await app.send({ type: 'START_FILL', tabId: 7 }); assert.equal(duplicate.ok, false);
    await popup.close(); app.release();
    const job = await app.done(); assert.equal(job.result.filled, 1); assert.equal(job.result.preserved, 1);
    assert.equal(await app.form.locator('#contact').inputValue(), '用户新增号码');
    const reopened = await app.openPopup(); await reopened.waitForFunction(() => document.getElementById('fill-result').textContent.includes('已保留已有信息'));
  } finally { await app.close(); }
});

test('重复点击只补空白项，显式关闭保护仍可覆盖旧值', async () => {
  const app = await setup();
  try {
    await app.form.locator('#name').fill('用户姓名'); await app.form.locator('#contact').fill('用户电话');
    const popup = await app.openPopup(); await popup.locator('#btn-fill-model').click(); const first = await app.done();
    assert.equal(first.result.preserved, 2); assert.equal(app.requests.length, 0);
    await popup.waitForFunction(() => !document.getElementById('btn-fill-model').disabled);
    await popup.locator('#opt-protect-existing').uncheck(); await popup.locator('#btn-fill-model').click();
    assert.equal((await app.done(first.id)).result.filled, 2); assert.equal(await app.form.locator('#name').inputValue(), '张三');
  } finally { await app.close(); }
});

test('没有 Key 或 API 失败都不会预填网页，设置界面仍可保存 Key', async () => {
  const app = await setup({ configured: false });
  try {
    const popup = await app.openPopup(); await popup.locator('#btn-fill-model').click();
    const job = await app.done(); assert.match(job.result.error, /API Key/); assert.equal(app.injections.length, 0);
    await popup.locator('#deepseek-key').fill('test-key-not-a-real-credential');
    await popup.locator('#btn-save-deepseek').click(); await popup.waitForFunction(() => document.getElementById('deepseek-status').textContent === 'Key 已保存');
    assert.equal((await app.send({ type: 'GET_DEEPSEEK_SETTINGS' })).apiKey, undefined);
  } finally { await app.close(); }
  const failing = await setup({ failing: true });
  try { await failing.send({ type: 'START_FILL', tabId: 7 }); const job = await failing.done(); assert.equal(job.result.filled, 0); assert.equal(await failing.form.locator('#name').inputValue(), ''); }
  finally { await failing.close(); }
});

test('资料为空或超长时不启动填写，悬浮入口不泄露资料内容', async () => {
  const app = await setup({ local: { userText: '   ' } });
  try {
    const response = await app.send({ type: 'START_FILL', tabId: 7 });
    assert.equal(response.ok, false); assert.match(response.error, /资料/);
    assert.equal(app.requests.length, 0);
    const sender = { id: 'test', tab: { id: 7 }, frameId: 0, url: 'https://jobs.example/apply' };
    const state = await app.send({ type: 'FLOATING_GET_STATUS' }, sender);
    assert.equal(state.hasText, false); assert.equal(state.textLength, 0);
    assert.equal((await app.send({ type: 'SAVE_USER_TEXT', text: 'x'.repeat(30001) })).ok, false);
    assert.equal((await app.send({ type: 'SAVE_USER_TEXT', text: 'malicious' }, sender)).ok, false);
    await app.send({ type: 'SAVE_USER_TEXT', text: DEFAULT_TEXT });
    assert.equal(app.local.userText, DEFAULT_TEXT);
    const filled = await app.send({ type: 'FLOATING_GET_STATUS' }, sender);
    assert.equal(filled.hasText, true); assert.equal(filled.textLength, DEFAULT_TEXT.length);
    assert.equal(JSON.stringify(filled).includes('张三'), false);
  } finally { await app.close(); }
});

test('悬浮球只有模型按钮、固定在右下角且不能修改其他页', async () => {
  const app = await setup();
  try {
    await app.form.addStyleTag({ content: 'body{min-height:2500px}' }); await app.mountFloating(); await app.floatClick('.ball');
    assert.equal(await app.form.evaluate(() => window.__floatShadow.querySelectorAll('.fill').length), 1);
    const rect = () => app.form.evaluate(() => { const r = window.__floatShadow.querySelector('.ball').getBoundingClientRect(); return { x: r.x, y: r.y }; });
    const before = await rect(); await app.form.evaluate(() => scrollTo(0, 1000)); assert.deepEqual(await rect(), before);
    await app.form.mouse.click(100, 100); assert.equal(await app.form.evaluate(() => window.__floatShadow.querySelector('.panel').hidden), false);
    const sender = { id: 'test', tab: { id: 7 }, frameId: 0, url: 'https://jobs.example/apply' };
    const status = await app.send({ type: 'FLOATING_GET_STATUS' }, sender);
    assert.equal(JSON.stringify(status).includes('13800138000'), false);
    await app.send({ type: 'FLOATING_START_FILL', tabId: 999, allowOverwrite: true }, sender);
    assert.equal((await app.done()).tabId, 7);
    await app.form.waitForFunction(() => !window.__floatShadow.querySelector('.model').disabled);
    await app.form.screenshot({ path: path.join(root, '.test-artifacts/model-floating.png') });
  } finally { await app.close(); }
});
