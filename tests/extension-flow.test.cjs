const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const root = path.resolve(__dirname, '..');
let browser;
before(async () => { browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'chrome', headless: true }); });
after(async () => { if (browser) await browser.close(); });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// 真正执行后台、客户端、弹窗和 DOM 引擎；只替换 chrome API 与外部 DeepSeek 网络。
async function setup({ configured = true, delayed = false, failing = false, previousJob = null, modelReply = null } = {}) {
  const pages = [];
  const form = await browser.newPage();
  pages.push(form);
  await form.setContent('<p><label>姓名<input id="name"></label></p><p><label>常用联络号码<input id="contact"></label></p>');
  const local = { profile: { name: '张三', phone: '13800138000' }, fillNoneWhenEmpty: true };
  if (configured) local.deepseek = { apiKey: 'test-key-not-a-real-credential', model: 'deepseek-flash' };
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
    storage: { local: storage(local), session: storage(session) },
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
      const { fields } = payload;
      return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ assignments: modelReply ? modelReply(payload) : fields.map(field => ({
        fieldId: field.fieldId, sourcePath: field.label === '姓名' ? 'name' : 'phone', optionId: null, transform: 'original',
      })) }) } }] }) };
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
    for (let count = 0; count < 250; count++) {
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
    await page.exposeFunction('__localSet', data => chrome.storage.local.set(data));
    await page.setContent(fs.readFileSync(path.join(root, 'editor.html'), 'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link[^>]*>/g, ''));
    await page.evaluate(() => {
      window.chrome = { storage: { local: { get: (keys, callback) => window.__localGet(keys).then(callback), set: (data, callback) => window.__localSet(data).then(() => callback?.()) } } };
    });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'editor.js'), 'utf8') });
    await page.evaluate(() => document.dispatchEvent(new Event('DOMContentLoaded')));
    await page.waitForFunction(() => document.querySelector('[data-key="name"]').value === '张三');
    return page;
  }
  async function floatClick(selector) {
    const rect = await form.evaluate(selector => {
      const r = window.__floatShadow.querySelector(selector).getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }, selector);
    await form.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  }
  return { form, local, session, requests, injections, windows, send, openPopup, openEditor, done, waitingModel, release, mountFloating, floatClick,
    close: async () => { release?.(); if (session.fillJob?.status === 'running') await done(); for (const page of pages) if (!page.isClosed()) await page.close(); },
  };
}

test('两个真实按钮分别触发混合路径和纯模型路径，填写数量正确', async () => {
  const app = await setup();
  try {
    const popup = await app.openPopup();
    assert.equal(await popup.getByRole('button', { name: '一键填写本页（模式1:规则+模型）', exact: true }).count(), 1);
    assert.equal(await popup.getByRole('button', { name: '一键填写本页（模式2:模型）', exact: true }).count(), 1);
    await popup.locator('#btn-fill-hybrid').click();
    const first = await app.done();
    assert.equal(first.result.ruleFilled, 1);
    assert.equal(first.result.modelFilled, 1);
    assert.equal(await app.form.locator('#contact').inputValue(), '13800138000');
    const hybridFields = JSON.parse(app.requests[0].messages[1].content).fields;
    assert.deepEqual(hybridFields.map(f => f.label), ['常用联络号码']);
    await popup.waitForFunction(() => !document.getElementById('btn-fill-model').disabled);
    await app.form.locator('#name').fill('');
    await app.form.locator('#contact').fill('');
    await popup.locator('#btn-fill-model').click();
    const second = await app.done(first.id);
    assert.equal(second.result.ruleFilled, 0);
    assert.equal(second.result.modelFilled, 2);
    assert.equal(JSON.parse(app.requests[1].messages[1].content).fields.length, 2);
    assert.deepEqual(app.injections.map(i => i.action), ['hybrid', 'apply', 'cleanup', 'scan', 'apply', 'cleanup']);
    await popup.waitForFunction(() => document.getElementById('fill-result').textContent.includes('DeepSeek 2'));
    assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= 360), true);
    fs.mkdirSync(path.join(root, '.test-artifacts'), { recursive: true });
    await popup.locator('.wrap').screenshot({ path: path.join(root, '.test-artifacts/popup.png') });
  } finally { await app.close(); }
});

test('关闭弹窗后后台继续填写，重新打开能看到结果；并发点击被拒绝', async () => {
  const app = await setup({ delayed: true });
  try {
    const popup = await app.openPopup();
    await popup.locator('#btn-fill-hybrid').click();
    await app.waitingModel();
    assert.equal(await app.form.locator('#name').inputValue(), '张三');
    const duplicate = await app.send({ type: 'START_FILL', mode: 'model', tabId: 7 });
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.error, /正在进行/);
    await popup.close();
    app.release();
    assert.equal((await app.done()).result.filled, 2);
    const reopened = await app.openPopup();
    await reopened.waitForFunction(() => document.getElementById('fill-result').textContent.includes('已填 2 项'));
  } finally { await app.close(); }
});

test('真实设置界面保存和删除Key，读取设置不泄露Key', async () => {
  const app = await setup({ configured: false });
  try {
    const popup = await app.openPopup();
    assert.equal(await popup.locator('#deepseek-settings').evaluate(el => el.open), true);
    await popup.locator('#deepseek-key').fill('test-key-not-a-real-credential');
    await popup.locator('#deepseek-form').getByRole('button', { name: '保存配置' }).click();
    await popup.waitForFunction(() => document.getElementById('deepseek-status').textContent === 'Key 已保存');
    assert.equal(await popup.locator('#deepseek-key').inputValue(), '');
    const config = await app.send({ type: 'GET_DEEPSEEK_SETTINGS' });
    assert.equal(JSON.stringify(config).includes('test-key-not-a-real-credential'), false);
    assert.equal(app.local.deepseek.apiKey, 'test-key-not-a-real-credential');
    await popup.locator('#btn-clear-deepseek').click();
    await popup.waitForFunction(() => document.getElementById('deepseek-status').textContent === '未配置');
    assert.equal(app.local.deepseek, undefined);
    assert.equal(app.requests.length, 0);
  } finally { await app.close(); }
});

test('后台拒绝网页/内容脚本请求；工作器重启会报告中断状态', async () => {
  const app = await setup({ previousJob: { id: 'old', mode: 'hybrid', status: 'running', result: { filled: 1 } } });
  try {
    assert.equal((await app.send({ type: 'GET_DEEPSEEK_SETTINGS' }, { id: 'test', tab: { id: 7 }, url: 'https://jobs.example' })).ok, false);
    const { job } = await app.send({ type: 'GET_FILL_JOB' });
    assert.equal(job.status, 'error');
    assert.match(job.phase, /中断/);
    assert.equal(job.result.filled, 1);
  } finally { await app.close(); }
});

test('DeepSeek鉴权失败后弹窗展示规则部分结果', async () => {
  const app = await setup({ failing: true });
  try {
    const popup = await app.openPopup();
    await popup.locator('#btn-fill-hybrid').click();
    const job = await app.done();
    assert.equal(job.status, 'error');
    assert.equal(job.result.filled, 1);
    assert.equal(await app.form.locator('#name').inputValue(), '张三');
    assert.equal(await app.form.locator('#contact').inputValue(), '');
    await popup.waitForFunction(() => document.getElementById('fill-result').textContent.includes('Key 无效'));
    assert.equal(await popup.locator('#fill-result').evaluate(el => el.classList.contains('err')), true);
  } finally { await app.close(); }
});

test('主页保存完全自定义资料，保留已有基本信息和经历', async () => {
  const app = await setup();
  try {
    app.local.profile.experiences = [{ org: '已有公司', role: '实习生' }];
    const popup = await app.openPopup();
    await popup.locator('#btn-add-profile').click();
    assert.equal(await popup.locator('[data-profile-key]').count(), 0);
    assert.equal(await popup.locator('#fill-hint,#family-target').count(), 0);
    await popup.locator('[data-extra-label]').fill('驾驶证');
    await popup.locator('[data-extra-value]').fill('C1');
    await popup.locator('#btn-save-profile').click();
    await popup.waitForFunction(() => document.getElementById('profile-save-result').textContent.includes('已保存'));
    assert.equal(app.local.profile.city, undefined);
    assert.deepEqual(app.local.profile.extraInfo, [{ label: '驾驶证', value: 'C1' }]);
    assert.deepEqual(app.local.profile.experiences, [{ org: '已有公司', role: '实习生' }]);
    assert.equal(app.local.profile.phone, '13800138000');
    assert.equal(app.requests.length, 0);
    fs.mkdirSync(path.join(root, '.test-artifacts'), { recursive: true });
    await popup.locator('.wrap').screenshot({ path: path.join(root, '.test-artifacts/home-profile.png') });
  } finally { await app.close(); }
});

test('额外信息不完整或重复时提示错误，不写入半成品', async () => {
  const app = await setup();
  try {
    const before = structuredClone(app.local.profile);
    const missing = await app.send({ type: 'SAVE_QUICK_PROFILE', extraInfo: [{ label: '驾驶证', value: '' }] });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /补全/);
    assert.deepEqual(app.local.profile, before);
    const duplicate = await app.send({ type: 'SAVE_QUICK_PROFILE', extraInfo: [{ label: '驾驶证', value: 'C1' }, { label: '驾驶证', value: 'C2' }] });
    assert.equal(duplicate.ok, false);
    assert.deepEqual(app.local.profile, before);
  } finally { await app.close(); }
});

test('完整编辑器再次保存时保留主页新增的额外信息', async () => {
  const app = await setup();
  try {
    app.local.profile.extraInfo = [{ label: '驾驶证', value: 'C1' }];
    const editor = await app.openEditor();
    await editor.locator('[data-key="city"]').fill('上海');
    await editor.locator('#btn-save').click();
    await editor.waitForFunction(() => document.getElementById('save-toast').textContent === '画像已保存');
    assert.equal(app.local.profile.city, '上海');
    assert.deepEqual(app.local.profile.extraInfo, [{ label: '驾驶证', value: 'C1' }]);
  } finally { await app.close(); }
});

test('重复点击保留手动补充的内容，不再请求模型；覆盖开关是显式操作', async () => {
  const app = await setup();
  try {
    await app.form.locator('#name').fill('用户补充姓名');
    await app.form.locator('#contact').fill('用户补充电话');
    const popup = await app.openPopup();
    assert.equal(await popup.locator('#opt-protect-existing').isChecked(), true);
    await popup.locator('#btn-fill-model').click();
    const first = await app.done();
    assert.equal(first.result.filled, 0);
    assert.equal(first.result.preserved, 2);
    assert.equal(app.requests.length, 0);
    assert.equal(await app.form.locator('#contact').inputValue(), '用户补充电话');
    await popup.waitForFunction(() => !document.getElementById('btn-fill-hybrid').disabled);
    await popup.locator('#opt-protect-existing').uncheck();
    await popup.locator('#btn-fill-hybrid').click();
    const overwritten = await app.done(first.id);
    assert.equal(overwritten.result.filled, 2);
    assert.equal(await app.form.locator('#name').inputValue(), '张三');
    await popup.close();
    const reopened = await app.openPopup();
    assert.equal(await reopened.locator('#opt-protect-existing').isChecked(), true);
  } finally { await app.close(); }
});

test('固定主页使用原网申标签页，不误填扩展窗口本身', async () => {
  const app = await setup();
  try {
    const popup = await app.openPopup(7);
    await popup.locator('#btn-fill-hybrid').click();
    const job = await app.done();
    assert.equal(job.tabId, 7);
    assert.equal(job.result.filled, 2);
    await popup.locator('#btn-open-home').click();
    for (let i = 0; i < 100 && !app.windows.length; i++) await wait(10);
    assert.equal(app.windows[0].url, 'chrome-extension://test/popup.html?targetTabId=7');
    assert.equal(app.windows[0].type, 'popup');
  } finally { await app.close(); }
});

test('悬浮球固定在视口右下角，滚动和点击网页不关闭面板，样式隔离', async () => {
  const app = await setup();
  try {
    await app.form.setViewportSize({ width: 1050, height: 760 });
    await app.form.addStyleTag({ content: 'body{min-height:2500px;background:#f3f4f8}button{background:black!important}' });
    await app.mountFloating();
    assert.equal(await app.form.evaluate(() => document.querySelector('jh-application-helper').shadowRoot), null);
    const before = await app.form.evaluate(() => {
      const r = window.__floatShadow.querySelector('.ball').getBoundingClientRect();
      return { x: r.x, y: r.y };
    });
    await app.form.evaluate(() => window.scrollTo(0, 1400));
    const after = await app.form.evaluate(() => {
      const r = window.__floatShadow.querySelector('.ball').getBoundingClientRect();
      return { x: r.x, y: r.y };
    });
    assert.deepEqual(after, before);
    assert.equal(await app.form.evaluate(() => getComputedStyle(window.__floatShadow.querySelector('.ball')).backgroundColor), 'rgb(115, 66, 226)');
    await app.floatClick('.ball');
    await app.form.mouse.click(100, 100);
    assert.equal(await app.form.evaluate(() => window.__floatShadow.querySelector('.panel').hidden), false);
    await app.form.addScriptTag({ content: fs.readFileSync(path.join(root, 'floating.js'), 'utf8') });
    assert.equal(await app.form.locator('jh-application-helper').count(), 1);
    await app.form.evaluate(() => window.scrollTo(0, 0));
    fs.mkdirSync(path.join(root, '.test-artifacts'), { recursive: true });
    await app.form.screenshot({ path: path.join(root, '.test-artifacts/floating.png') });
  } finally { await app.close(); }
});

test('悬浮模式只填本页空白项，模型等待期间的手动补充会保留', async () => {
  const app = await setup({ delayed: true });
  try {
    await app.mountFloating();
    await app.floatClick('.ball');
    await app.floatClick('.hybrid');
    await app.waitingModel();
    await app.form.locator('#contact').fill('用户在等待期间补充');
    app.release();
    const first = await app.done();
    assert.equal(first.result.ruleFilled, 1);
    assert.equal(first.result.modelFilled, 0);
    assert.equal(first.result.preserved, 1);
    assert.equal(first.result.unresolved, 0);
    assert.equal(await app.form.locator('#contact').inputValue(), '用户在等待期间补充');
    await app.form.waitForFunction(() => !window.__floatShadow.querySelector('.model').disabled);
    await app.floatClick('.model');
    const second = await app.done(first.id);
    assert.equal(second.result.preserved, 2);
    assert.equal(app.requests.length, 1);
    await app.floatClick('.home');
    for (let i = 0; i < 100 && !app.windows.length; i++) await wait(10);
    assert.equal(app.windows[0].url.endsWith('?targetTabId=7'), true);
  } finally { await app.close(); }
});

test('主页开关能隐藏并重新显示悬浮球', async () => {
  const app = await setup();
  try {
    await app.mountFloating();
    const popup = await app.openPopup();
    await popup.locator('#opt-floating').uncheck();
    await app.form.waitForFunction(() => !document.querySelector('jh-application-helper'));
    assert.equal(app.local.floatingEnabled, false);
    await popup.locator('#opt-floating').check();
    await app.form.waitForFunction(() => document.querySelector('jh-application-helper')?.isConnected);
    assert.equal(app.local.floatingEnabled, true);
  } finally { await app.close(); }
});

test('悬浮消息不返回画像值或Key，也不能指定其他标签页或关闭保护', async () => {
  const app = await setup();
  try {
    const sender = { id: 'test', tab: { id: 7 }, frameId: 0, url: 'https://jobs.example/apply' };
    const state = await app.send({ type: 'FLOATING_GET_STATUS' }, sender);
    assert.equal(state.profileReady, true);
    assert.equal(JSON.stringify(state).includes('13800138000'), false);
    assert.equal(JSON.stringify(state).includes('test-key-not-a-real-credential'), false);
    assert.equal((await app.send({ type: 'SAVE_QUICK_PROFILE', fields: { name: '恶意修改' } }, sender)).ok, false);
    assert.equal((await app.send({ type: 'FLOATING_GET_STATUS' }, { ...sender, frameId: 1 })).ok, false);
    await app.form.locator('#name').fill('手动姓名');
    await app.send({ type: 'FLOATING_START_FILL', mode: 'hybrid', tabId: 999, allowOverwrite: true }, sender);
    const job = await app.done();
    assert.equal(job.tabId, 7);
    assert.equal(job.result.preserved, 1);
    assert.equal(await app.form.locator('#name').inputValue(), '手动姓名');
  } finally { await app.close(); }
});

const familyProfile = { name: '本人张三', phone: '13800138000', family: [
  { relation: '父亲', name: '父亲张四', phone: '13900000001' },
  { relation: '母亲', name: '母亲李五', phone: '13900000002' },
] };
test('无需提示，模式1依据同页父母关系分别补姓名电话并保持已选关系', async () => {
  const app = await setup({ modelReply: payload => payload.fields.map(field => ({ fieldId: field.fieldId,
    sourcePath: field.allowedSourcePaths.find(path => path.endsWith(field.label === '姓名' ? '.name' : '.phone')) || null,
    optionId: null, transform: 'original' })) });
  app.local.profile = familyProfile;
  try {
    await app.form.setContent('<fieldset><legend>家庭信息</legend><label>关系<select id="father-rel"><option selected value="father-code">父亲</option></select></label><label>姓名<input id="father-name"></label><label>电话<input id="father-phone"></label></fieldset><fieldset><legend>家庭信息</legend><label>关系<select id="mother-rel"><option selected value="mother-code">母亲</option></select></label><label>姓名<input id="mother-name"></label><label>电话<input id="mother-phone"></label></fieldset>');
    const popup = await app.openPopup();
    await popup.locator('#btn-fill-hybrid').click();
    const job = await app.done();
    assert.equal(job.result.contextFields, 4);
    assert.equal(job.result.ruleFilled, 0);
    assert.equal(job.result.modelFilled, 4);
    assert.equal(job.result.preserved, 2);
    assert.equal(await app.form.locator('#father-name').inputValue(), '父亲张四');
    assert.equal(await app.form.locator('#mother-name').inputValue(), '母亲李五');
    assert.equal(await app.form.locator('#father-phone').inputValue(), '13900000001');
    assert.equal(await app.form.locator('#mother-phone').inputValue(), '13900000002');
    assert.equal(await app.form.locator('#mother-rel').inputValue(), 'mother-code');
    const payload = JSON.parse(app.requests[0].messages[1].content);
    assert.equal(Object.hasOwn(payload, 'userGuidance'), false);
    assert.ok(payload.fields.every(field => field.existingContext.length === 1));
    assert.equal(JSON.stringify(app.session).includes('mother-code'), false);
    await popup.waitForFunction(() => document.getElementById('fill-result').textContent.includes('结合页面已填信息'));
    await popup.locator('.wrap').screenshot({ path: path.join(root, '.test-artifacts/existing-context.png') });
  } finally { await app.close(); }
});

test('等待模型时网页已填母亲关系改成父亲，旧结果不写入', async () => {
  const app = await setup({ delayed: true, modelReply: payload => payload.fields.map(field => ({ fieldId: field.fieldId,
    sourcePath: 'family.1.phone', optionId: null, transform: 'original' })) });
  app.local.profile = familyProfile;
  try {
    await app.form.setContent('<fieldset><label>关系<select id="relation"><option selected value="m">母亲</option><option value="f">父亲</option></select></label><label>电话<input id="phone"></label></fieldset>');
    const popup = await app.openPopup();
    await popup.locator('#btn-fill-model').click();
    await app.waitingModel();
    await app.form.locator('#relation').selectOption('f');
    app.release();
    const job = await app.done();
    assert.equal(job.result.modelFilled, 0);
    assert.equal(job.result.stale, 1);
    assert.equal(await app.form.locator('#phone').inputValue(), '');
  } finally { await app.close(); }
});

test('自定义资料支持新增、修改、删除和重新打开，不改动原有基本资料', async () => {
  const app = await setup();
  try {
    const popup = await app.openPopup();
    await popup.locator('#btn-add-profile').click();
    await popup.locator('[data-extra-label]').fill('用户任意信息名称');
    await popup.locator('[data-extra-value]').fill('用户真实内容');
    await popup.locator('#btn-add-extra').click();
    await popup.locator('[data-extra-label]').nth(1).fill('另一项自定义资料');
    await popup.locator('[data-extra-value]').nth(1).fill('另一项真实内容');
    await popup.locator('#btn-save-profile').click();
    await popup.waitForFunction(() => document.getElementById('profile-save-result').textContent.includes('已保存'));
    assert.equal(app.local.profile.extraInfo.length, 2);
    await popup.close();
    const reopened = await app.openPopup();
    await reopened.locator('#btn-add-profile').click();
    assert.equal(await reopened.locator('[data-extra-label]').count(), 2);
    assert.equal(await reopened.locator('[data-extra-label]').nth(1).inputValue(), '另一项自定义资料');
    await reopened.locator('.extra-info-row').first().getByRole('button', { name: '删除此条' }).click();
    await reopened.locator('[data-extra-value]').fill('已修改的真实内容');
    await reopened.locator('#btn-save-profile').click();
    await reopened.waitForFunction(() => document.getElementById('profile-save-result').textContent.includes('已保存'));
    assert.deepEqual(app.local.profile.extraInfo, [{ label: '另一项自定义资料', value: '已修改的真实内容' }]);
    assert.equal(app.local.profile.name, '张三');
    assert.equal(app.local.profile.phone, '13800138000');
    await app.send({ type: 'SAVE_QUICK_PROFILE', fields: { name: '不应改动' }, extraInfo: app.local.profile.extraInfo });
    assert.equal(app.local.profile.name, '张三');
  } finally { await app.close(); }
});

test('只保存用户自定义父母资料，悬浮纯模型自动依据网页关系填母亲', async () => {
  const app = await setup({ modelReply: payload => payload.fields.map(field => ({ fieldId: field.fieldId,
    sourcePath: field.allowedSourcePaths.find(path => payload.profile.extraInfo[Number(path.split('.')[1])]?.label === (field.label === '姓名' ? '母亲姓名' : '母亲电话')) || null,
    optionId: null, transform: 'original' })) });
  app.local.profile = {};
  try {
    const popup = await app.openPopup();
    await popup.locator('#btn-add-profile').click();
    const data = [ ['父亲姓名', '张四'], ['父亲电话', '13900000001'], ['母亲姓名', '李五'], ['母亲电话', '13900000002'] ];
    for (let i = 0; i < data.length; i++) {
      if (i) await popup.locator('#btn-add-extra').click();
      await popup.locator('[data-extra-label]').nth(i).fill(data[i][0]);
      await popup.locator('[data-extra-value]').nth(i).fill(data[i][1]);
    }
    await popup.locator('#btn-save-profile').click();
    await popup.waitForFunction(() => document.getElementById('profile-save-result').textContent.includes('已保存'));
    assert.deepEqual(Object.keys(app.local.profile), ['extraInfo']);
    assert.ok((await popup.locator('#profile-status').textContent()).includes('4字段'));
    await app.form.setContent('<fieldset><legend>家庭信息</legend><label>关系<select id="relation"><option selected value="m">母亲</option></select></label><label>姓名<input id="name"></label><label>电话<input id="phone"></label></fieldset>');
    await app.mountFloating();
    await app.floatClick('.ball');
    assert.equal(await app.form.evaluate(() => window.__floatShadow.querySelectorAll('textarea,select').length), 0);
    await app.floatClick('.model');
    const job = await app.done();
    assert.equal(job.result.modelFilled, 2);
    assert.equal(job.result.preserved, 1);
    assert.equal(await app.form.locator('#name').inputValue(), '李五');
    assert.equal(await app.form.locator('#phone').inputValue(), '13900000002');
    assert.equal(await app.form.locator('#relation').inputValue(), 'm');
    const payload = JSON.parse(app.requests[0].messages[1].content);
    assert.equal(Object.hasOwn(payload, 'userGuidance'), false);
    assert.ok(payload.fields.every(field => field.allowedSourcePaths.every(path => ['extraInfo.2.value', 'extraInfo.3.value'].includes(path))));
    await app.form.waitForFunction(() => !window.__floatShadow.querySelector('.model').disabled);
    await app.form.screenshot({ path: path.join(root, '.test-artifacts/automatic-floating.png') });
  } finally { await app.close(); }
});
