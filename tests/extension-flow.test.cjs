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
    await page.exposeFunction('__extensionMessage', send);
    await page.setContent(fs.readFileSync(path.join(root, 'editor.html'), 'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link[^>]*>/g, ''));
    await page.evaluate(() => {
      window.chrome = { runtime: { sendMessage: message => window.__extensionMessage(message) }, storage: { local: { get: (keys, callback) => window.__localGet(keys).then(callback), set: (data, callback) => window.__localSet(data).then(() => callback?.()) } } };
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


test('主页只有一个填写按钮，已有JSON资料直接走模型路径', async () => {
  const app = await setup();
  try {
    const popup = await app.openPopup();
    assert.equal(await popup.getByRole('button', { name: '一键填写本页', exact: true }).count(), 1);
    assert.equal(await popup.locator('.fill-actions button').count(), 1);
    await popup.locator('#btn-fill-model').click();
    const job = await app.done();
    assert.equal(job.result.filled, 2);
    assert.equal(await app.form.locator('#name').inputValue(), '张三');
    assert.deepEqual(app.injections.map(i => i.action), ['scan', 'apply', 'cleanup']);
    await popup.waitForFunction(() => !document.getElementById('btn-fill-model').disabled);
    fs.mkdirSync(path.join(root, '.test-artifacts'), { recursive: true });
    await popup.locator('.wrap').screenshot({ path: path.join(root, '.test-artifacts/model-popup.png') });
  } finally { await app.close(); }
});

test('新增自由文本保存且不损失 JSON 资料，旧键值信息可作为文本编辑', async () => {
  const app = await setup();
  app.local.profile.experiences = [{ org: '原公司', role: '实习生' }];
  app.local.profile.extraInfo = [{ label: '驾驶证', value: 'C1' }];
  try {
    const popup = await app.openPopup(); await popup.locator('#btn-add-profile').click();
    assert.equal(await popup.locator('#supplement-text').inputValue(), '驾驶证：C1');
    const text = '母亲叫李五，电话为13900000002。\n我的驾驶证现在为C2。';
    await popup.locator('#supplement-text').fill(text); await popup.locator('#btn-save-profile').click();
    await popup.waitForFunction(() => document.getElementById('profile-save-result').textContent.includes('已保存'));
    assert.equal(app.local.profile.supplementText, text);
    assert.equal(app.local.profile.name, '张三');
    assert.deepEqual(app.local.profile.experiences, [{ org: '原公司', role: '实习生' }]);
    assert.deepEqual(app.local.profile.extraInfo, [{ label: '驾驶证', value: 'C1' }]);
    await popup.locator('.wrap').screenshot({ path: path.join(root, '.test-artifacts/text-supplement.png') });
  } finally { await app.close(); }
});

test('完整编辑继续使用 JSON 保存并保留补充文本，导出包含两者', async () => {
  const app = await setup(); app.local.profile.supplementText = '母亲叫李五。';
  try {
    const editor = await app.openEditor();
    await editor.locator('[data-key="city"]').fill('杭州'); await editor.locator('#btn-save').click();
    await editor.waitForFunction(() => document.getElementById('save-toast').textContent === '画像已保存');
    assert.equal(app.local.profile.city, '杭州'); assert.equal(app.local.profile.supplementText, '母亲叫李五。');
    await editor.locator('#btn-export-json').click();
    await editor.locator('#dlg-export').waitFor({ state: 'visible' });
    const exported = JSON.parse(await editor.locator('#export-area').inputValue());
    assert.equal(exported.supplementText, app.local.profile.supplementText); assert.equal(exported.name, '张三');
  } finally { await app.close(); }
});

test('模型同时读取 JSON 与补充文本，按页面母亲关系取姓名和原文电话', async () => {
  const text = '母亲的电话已更新为13900000002。';
  const app = await setup({ modelReply: payload => payload.fields.map(f => f.label === '姓名' ? {
    fieldId: f.fieldId, sourcePath: 'family.1.name', optionId: null,
  } : { fieldId: f.fieldId, sourcePath: null, value: '13900000002', evidenceQuote: text, optionId: null }) });
  app.local.profile = { family: [{ relation: '父亲', name: '张四' }, { relation: '母亲', name: '李五' }], supplementText: text };
  try {
    await app.form.setContent('<fieldset><legend>家庭信息</legend><label>关系<select><option selected>母亲</option></select></label><label>姓名<input id="name"></label><label>电话<input id="phone"></label></fieldset>');
    const popup = await app.openPopup(); await popup.locator('#btn-fill-model').click();
    const job = await app.done(); assert.equal(job.result.filled, 2); assert.equal(job.result.preserved, 1);
    assert.equal(await app.form.locator('#name').inputValue(), '李五'); assert.equal(await app.form.locator('#phone').inputValue(), '13900000002');
    const payload = JSON.parse(app.requests[0].messages[1].content);
    assert.equal(payload.supplementText, text); assert.equal(payload.fields[0].existingContext[0].value, '母亲');
    assert.equal(JSON.stringify(app.session).includes(text), false);
  } finally { await app.close(); }
});

test('纯文本资料也能填写，无需先建立 JSON 固定字段', async () => {
  const text = '我叫张三，联系号码是13800138000。';
  const app = await setup({ modelReply: payload => payload.fields.map(f => ({ fieldId: f.fieldId, value: f.label === '姓名' ? '张三' : '13800138000', evidenceQuote: text, optionId: null })) });
  app.local.profile = { supplementText: text };
  try {
    const popup = await app.openPopup(); await popup.locator('#btn-fill-model').click();
    const job = await app.done(); assert.equal(job.result.filled, 2); assert.equal(await app.form.locator('#name').inputValue(), '张三');
  } finally { await app.close(); }
});

test('模型生成的号码没有原文依据时不写入任何字段', async () => {
  const app = await setup({ modelReply: payload => payload.fields.map(f => ({ fieldId: f.fieldId, value: '99999999999', evidenceQuote: '没有这段原文', optionId: null })) });
  app.local.profile.supplementText = '真实号码是13800138000。';
  try {
    const popup = await app.openPopup(); await popup.locator('#btn-fill-model').click();
    const job = await app.done(); assert.equal(job.status, 'error'); assert.equal(job.result.filled, 0); assert.match(job.result.error, /依据/);
    assert.equal(await app.form.locator('#name').inputValue(), '');
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

test('没有Key和API失败都不会预填网页，设置界面仍可保存Key', async () => {
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

test('清空补充文本不复活旧额外信息，超长文本不覆盖已有资料', async () => {
  const app = await setup(); app.local.profile.extraInfo = [{ label: '驾驶证', value: 'C1' }];
  try {
    const before = structuredClone(app.local.profile);
    assert.equal((await app.send({ type: 'SAVE_SUPPLEMENT_TEXT', text: 'x'.repeat(30001) })).ok, false);
    assert.deepEqual(app.local.profile, before);
    const popup = await app.openPopup(); await popup.locator('#btn-add-profile').click();
    await popup.locator('#supplement-text').fill(''); await popup.locator('#btn-save-profile').click();
    await popup.waitForFunction(() => document.getElementById('profile-save-result').textContent.includes('已保存'));
    assert.equal(app.local.profile.supplementText, '');
    await popup.locator('#btn-fill-model').click(); await app.done();
    assert.equal(JSON.parse(app.requests[0].messages[1].content).sourcePaths.includes('extraInfo.0.value'), false);
  } finally { await app.close(); }
});

test('悬浮球只有模型按钮、固定在右下角且消息不能泄露资料或修改其他页', async () => {
  const app = await setup();
  try {
    await app.form.addStyleTag({ content: 'body{min-height:2500px}' }); await app.mountFloating(); await app.floatClick('.ball');
    assert.equal(await app.form.evaluate(() => window.__floatShadow.querySelectorAll('.fill').length), 1);
    const rect = () => app.form.evaluate(() => { const r=window.__floatShadow.querySelector('.ball').getBoundingClientRect(); return { x:r.x,y:r.y }; });
    const before = await rect(); await app.form.evaluate(() => scrollTo(0,1000)); assert.deepEqual(await rect(), before);
    await app.form.mouse.click(100,100); assert.equal(await app.form.evaluate(() => window.__floatShadow.querySelector('.panel').hidden), false);
    const sender = { id:'test', tab:{id:7}, frameId:0, url:'https://jobs.example/apply' };
    const status = await app.send({type:'FLOATING_GET_STATUS'}, sender);
    assert.equal(JSON.stringify(status).includes('13800138000'), false);
    assert.equal((await app.send({type:'SAVE_SUPPLEMENT_TEXT',text:'malicious'},sender)).ok,false);
    await app.send({type:'FLOATING_START_FILL',tabId:999,allowOverwrite:true},sender);
    assert.equal((await app.done()).tabId,7);
    await app.form.waitForFunction(() => !window.__floatShadow.querySelector('.model').disabled);
    await app.form.screenshot({path:path.join(root,'.test-artifacts/model-floating.png')});
  } finally { await app.close(); }
});

test('仅有旧补充且新文本已清空时，不会启动模型或显示就绪', async () => {
  const app = await setup();
  app.local.profile = { extraInfo: [{ label: '驾驶证', value: 'C1' }], supplementText: '' };
  try {
    const response = await app.send({ type: 'START_FILL', tabId: 7 });
    assert.equal(response.ok, false); assert.match(response.error, /保存/);
    assert.equal(app.requests.length, 0);
    const state = await app.send({ type: 'FLOATING_GET_STATUS' }, { id:'test', tab:{id:7}, frameId:0, url:'https://jobs.example/apply' });
    assert.equal(state.profileReady, false); assert.equal(state.fieldCount, 0);
  } finally { await app.close(); }
});

test('完整编辑先打开、主页后来新增文本，保存和导出仍保留最新补充', async () => {
  const app = await setup();
  try {
    const editor = await app.openEditor();
    await app.send({ type:'SAVE_SUPPLEMENT_TEXT', text:'后来新增的母亲电话是13900000002。' });
    await editor.locator('[data-key="city"]').fill('杭州'); await editor.locator('#btn-save').click();
    await editor.waitForFunction(() => document.getElementById('save-toast').textContent === '画像已保存');
    assert.equal(app.local.profile.supplementText, '后来新增的母亲电话是13900000002。');
    await app.send({ type:'SAVE_SUPPLEMENT_TEXT', text:'导出前更新为新文本。' });
    await editor.locator('#btn-export-json').click(); await editor.locator('#dlg-export').waitFor({state:'visible'});
    assert.equal(JSON.parse(await editor.locator('#export-area').inputValue()).supplementText, '导出前更新为新文本。');
  } finally { await app.close(); }
});

test('并发保存 JSON 和文本通过后台合并，显式 JSON 替换仍可恢复备份', async () => {
  const app = await setup();
  try {
    await Promise.all([
      app.send({ type:'SAVE_SUPPLEMENT_TEXT', text:'新的补充文本' }),
      app.send({ type:'SAVE_JSON_PROFILE', profile:{ name:'张三', city:'杭州' } }),
    ]);
    assert.equal(app.local.profile.city, '杭州'); assert.equal(app.local.profile.supplementText, '新的补充文本');
    await app.send({ type:'SAVE_JSON_PROFILE', replaceProfile:true, profile:{ name:'备份姓名', supplementText:'备份文本' } });
    assert.deepEqual(app.local.profile, { name:'备份姓名', supplementText:'备份文本' });
  } finally { await app.close(); }
});
