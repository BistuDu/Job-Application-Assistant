const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { chromium } = require('playwright');
const { FILL_FUNCTION } = require('../fill-engine.js');

let browser;
before(async () => {
  // 独立临时浏览器，不读取用户的浏览器资料或访问外部网站。
  browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'chrome', headless: true });
});
after(async () => { if (browser) await browser.close(); });

async function fixture(html, run) {
  const page = await browser.newPage();
  try {
    await page.setContent(`<!doctype html><html><body>${html}</body></html>`);
    // 与 executeScript 一样，以函数源码独立执行，验证没有闭包依赖。
    await page.addScriptTag({ content: `window.runFill = ${FILL_FUNCTION.toString()};` });
    const fill = (profile, opts = {}) => page.evaluate(({ profile, opts }) => window.runFill(profile, opts), { profile, opts });
    await run(page, fill);
  } finally {
    await page.close();
  }
}


test('扫描只描述字段，通用姓名/电话也不会提前填入', async () => {
  await fixture('<label>姓名<input id="name"></label><label>电话<input id="phone"></label>', async (page, fill) => {
    const scan = await fill({ name: '张三', phone: '13800138000' });
    assert.equal(scan.filled, 0); assert.equal(scan.modelFields.length, 2);
    assert.equal(await page.locator('#name').inputValue(), '');
    const result = await fill({ name: '张三', phone: '13800138000' }, { action: 'apply', snapshotToken: scan.snapshotToken, assignments: scan.modelFields.map((f, i) => ({ fieldId: f.fieldId, sourcePath: i ? 'phone' : 'name' })) });
    assert.equal(result.filled, 2);
  });
});

test('模型按 JSON 嵌套来源或有证据的文本提取值填写', async () => {
  await fixture('<label>母亲姓名<input id="name"></label><label>母亲电话<input id="phone"></label>', async (page, fill) => {
    const p = { family: [{ name: '李五' }], supplementText: '母亲电话更新为13900000002。' };
    const scan = await fill(p);
    const result = await fill(p, { action: 'apply', snapshotToken: scan.snapshotToken, assignments: [
      { fieldId: scan.modelFields[0].fieldId, sourcePath: 'family.0.name' },
      { fieldId: scan.modelFields[1].fieldId, sourcePath: null, value: '13900000002', evidenceQuote: p.supplementText },
    ] });
    assert.equal(result.filled, 2); assert.equal(await page.locator('#name').inputValue(), '李五'); assert.equal(await page.locator('#phone').inputValue(), '13900000002');
  });
});

test('文本摘录缺证据或内容不存在时本地也拒绝写入', async () => {
  await fixture('<label>电话<input></label>', async (page, fill) => {
    const p = { supplementText: '电话是13900000002。' }; const scan = await fill(p);
    const r = await fill(p, { action: 'apply', snapshotToken: scan.snapshotToken, assignments: [{ fieldId: scan.modelFields[0].fieldId, value: '13900000009', evidenceQuote: p.supplementText }] });
    assert.equal(r.invalid, 1); assert.equal(await page.locator('input').inputValue(), '');
  });
});

test('下拉与单选只按模型给出的真实 optionId 执行，不本地匹配别名', async () => {
  await fixture('<label>学历<select id="degree"><option>请选择</option><option value="b">大学本科</option><option value="m" disabled>硕士</option></select></label><fieldset><legend>性别</legend><label><input type="radio" name="sex" value="m">男</label><label><input type="radio" name="sex" value="f">女</label></fieldset>', async (page, fill) => {
    const p = { degree: '本科', gender: '女' }; const scan = await fill(p);
    assert.equal(scan.modelFields.length, 2); assert.equal(scan.modelFields[0].options.length, 1);
    const r = await fill(p, { action: 'apply', snapshotToken: scan.snapshotToken, assignments: [
      { fieldId: scan.modelFields[0].fieldId, sourcePath: 'degree', optionId: 'option-0' },
      { fieldId: scan.modelFields[1].fieldId, sourcePath: 'gender', optionId: 'option-1' },
    ] });
    assert.equal(r.filled, 2); assert.equal(await page.locator('#degree').inputValue(), 'b'); assert.equal(await page.locator('input[value=f]').isChecked(), true);
  });
});

test('没有 optionId 时不按资料值自行选择下拉框', async () => {
  await fixture('<label>学历<select><option value="">请选择</option><option value="b">本科</option></select></label>', async (page, fill) => {
    const p = { degree: '本科' }; const scan = await fill(p);
    const r = await fill(p, { action: 'apply', snapshotToken: scan.snapshotToken, assignments: [{ fieldId: scan.modelFields[0].fieldId, sourcePath: 'degree' }] });
    assert.equal(r.filled, 0); assert.equal(await page.locator('select').inputValue(), '');
  });
});

test('已有值、有效零、无、日期和单选组均保护，只有占位项可补', async () => {
  await fixture('<label>姓名<input value="已填"></label><label>年龄<input type="number" value="0"></label><label>描述<textarea>无</textarea></label><label>日期<input type="date" value="2000-01-01"></label><label>选项<select><option value="0">有效零</option></select></label><label>空选择<select id="empty"><option value="0">请选择</option><option value="1">选项</option></select></label><label><input type="radio" name="x" checked>是</label><label><input type="radio" name="x">否</label>', async (_page, fill) => {
    const scan = await fill({}); assert.equal(scan.preserved, 6); assert.equal(scan.modelFields.length, 1);
    assert.equal(scan.modelFields[0].options[0].value, '1');
  });
});

test('密码、验证码、上传、条款、只读、隐藏和禁用项不填', async () => {
  await fixture('<label>验证码<input></label><label>密码<input type="password"></label><input type="file"><label>同意条款<input type="checkbox"></label><label>只读信息<input readonly></label><input type="hidden"><fieldset disabled><input></fieldset>', async (_page, fill) => {
    const scan = await fill({}); assert.equal(scan.modelFields.length, 0); assert.equal(scan.captcha, 1); assert.equal(scan.file, 1); assert.equal(scan.agreement, 1);
  });
});

test('家庭卡片的已有上下文互不混用，敏感值不发送', async () => {
  await fixture('<fieldset><legend>家庭信息</legend><label>关系<select><option selected>母亲</option></select></label><label>电话<input id="mother"></label><label>密码<input type="password" value="private-password"></label></fieldset><fieldset><legend>家庭信息</legend><label>关系<input value="父亲" readonly></label><label>电话<input id="father"></label></fieldset>', async (_page, fill) => {
    const scan = await fill({}); assert.equal(scan.modelFields.length, 2);
    assert.deepEqual(scan.modelFields[0].existingContext.map(c => c.value), ['母亲']);
    assert.deepEqual(scan.modelFields[1].existingContext.map(c => c.value), ['父亲']);
    assert.equal(JSON.stringify(scan).includes('private-password'), false);
  });
});

test('等待时用户补全、替换节点或关系变化都不会应用旧结果', async () => {
  for (const change of ['fill', 'replace', 'relation']) await fixture('<fieldset><label>关系<select id="relation"><option value="m">母亲</option><option value="f">父亲</option></select></label><label>电话<input id="phone"></label></fieldset>', async (page, fill) => {
    const p = { phone: '13900000002' }; const scan = await fill(p);
    if (change === 'fill') await page.locator('#phone').fill('用户补充');
    if (change === 'replace') await page.locator('#phone').evaluate(el => el.replaceWith(el.cloneNode()));
    if (change === 'relation') await page.locator('#relation').selectOption('f');
    const r = await fill(p, { action: 'apply', snapshotToken: scan.snapshotToken, assignments: [{ fieldId: scan.modelFields[0].fieldId, sourcePath: 'phone' }] });
    assert.equal(r.filled, 0);
    assert.equal(change === 'fill' ? r.preserved : r.stale, 1);
    assert.equal(await page.locator('#phone').inputValue(), change === 'fill' ? '用户补充' : '');
  });
});

test('DOM重排仍使用原节点，页面导航或选项变化使快照失效', async () => {
  await fixture('<p id="a"><label>姓名<input id="name"></label></p><p id="b"><label>电话<input id="phone"></label></p>', async (page, fill) => {
    const p = { name: '张三', phone: '13800138000' }; const scan = await fill(p);
    await page.locator('#a').evaluate(el => el.parentElement.appendChild(el));
    const r = await fill(p, { action: 'apply', snapshotToken: scan.snapshotToken, assignments: scan.modelFields.map((f, i) => ({ fieldId: f.fieldId, sourcePath: i ? 'phone' : 'name' })) });
    assert.equal(r.filled, 2); assert.equal(await page.locator('#name').inputValue(), '张三');
  });
  await fixture('<label>学历<select><option>请选择</option><option value="b">本科</option></select></label>', async (page, fill) => {
    const p = { degree: '本科' }; const scan = await fill(p);
    await page.locator('option[value=b]').evaluate(el => el.textContent = '博士');
    const r = await fill(p, { action: 'apply', snapshotToken: scan.snapshotToken, assignments: [{ fieldId: scan.modelFields[0].fieldId, sourcePath: 'degree', optionId: 'option-0' }] });
    assert.equal(r.stale, 1);
  });
});

test('显式覆盖仍保护等待期间新输入，本任务自身更新的上下文不会误拦截', async () => {
  await fixture('<label>姓名<input id="name" value="旧名"></label><label>电话<input id="phone" value="旧号"></label>', async (page, fill) => {
    const p = { name: '张三', phone: '13800138000' }; const scan = await fill(p, { allowOverwrite: true });
    const r = await fill(p, { action: 'apply', allowOverwrite: true, snapshotToken: scan.snapshotToken, assignments: scan.modelFields.map((f, i) => ({ fieldId: f.fieldId, sourcePath: i ? 'phone' : 'name' })) });
    assert.equal(r.filled, 2); assert.equal(await page.locator('#phone').inputValue(), '13800138000');
    const scan2 = await fill(p, { allowOverwrite: true }); await page.locator('#name').fill('等待时新名');
    assert.equal((await fill(p, { action: 'apply', allowOverwrite: true, snapshotToken: scan2.snapshotToken, assignments: [{ fieldId: scan2.modelFields[0].fieldId, sourcePath: 'name' }] })).stale, 1);
  });
});

test('日期只转换实际格式，不补缺失日，验证数值长度和邮箱约束', async () => {
  await fixture('<label>日期<input id="date" type="date"></label><label>月份<input id="month" type="month"></label><label>年龄<input id="age" type="number" max="20"></label>', async (page, fill) => {
    const p = { birth: '2000年3月', age: '30' }; const scan = await fill(p);
    const r = await fill(p, { action: 'apply', snapshotToken: scan.snapshotToken, assignments: scan.modelFields.map((f, i) => ({ fieldId: f.fieldId, sourcePath: i === 2 ? 'age' : 'birth' })) });
    assert.equal(r.filled, 1); assert.equal(await page.locator('#date').inputValue(), ''); assert.equal(await page.locator('#month').inputValue(), '2000-03'); assert.equal(await page.locator('#age').inputValue(), '');
  });
});

test('文本中的实习日期可取起止日期，空 JSON 经授权可填无', async () => {
  await fixture('<label>开始<input type="month" id="start"></label><label>结束<input type="month" id="end"></label><label>项目<textarea id="projects"></textarea></label>', async (page, fill) => {
    const p = { supplementText: '实习时间2025.06-2025.09。', projects: [] }; const scan = await fill(p);
    const r = await fill(p, { action: 'apply', snapshotToken: scan.snapshotToken, fillNoneWhenEmpty: true, assignments: [
      ...scan.modelFields.slice(0, 2).map((f, i) => ({ fieldId: f.fieldId, value: '2025.06-2025.09', evidenceQuote: p.supplementText, transform: i ? 'endDate' : 'startDate' })),
      { fieldId: scan.modelFields[2].fieldId, sourcePath: 'projects', fillNone: true },
    ] });
    assert.equal(r.filled, 3); assert.equal(r.filledNone, 1); assert.equal(await page.locator('#start').inputValue(), '2025-06'); assert.equal(await page.locator('#end').inputValue(), '2025-09'); assert.equal(await page.locator('#projects').inputValue(), '无');
  });
});

test('地区子项已有内容时跳过父项，不触发页面清空联动', async () => {
  await fixture('<label>省份<select><option>请选择</option><option>浙江</option></select></label><label>城市<input value="杭州"></label>', async (_page, fill) => {
    const scan = await fill({}); assert.equal(scan.linkedProtected, 1); assert.equal(scan.preserved, 1); assert.equal(scan.modelFields.length, 0);
  });
});

test('实际写入发出事件，清理后不能重复使用旧快照', async () => {
  await fixture('<label>姓名<input id="name"></label>', async (page, fill) => {
    await page.evaluate(() => { window.events = []; for (const type of ['input','change','blur']) document.querySelector('input').addEventListener(type, () => events.push(type)); });
    const p = { name: '张三' }; const scan = await fill(p);
    await fill(p, { action: 'apply', snapshotToken: scan.snapshotToken, assignments: [{ fieldId: scan.modelFields[0].fieldId, sourcePath: 'name' }] });
    assert.deepEqual(await page.evaluate(() => events), ['input','change','blur']);
    await fill({}, { action: 'cleanup', snapshotToken: scan.snapshotToken });
    assert.equal((await fill(p, { action: 'apply', snapshotToken: scan.snapshotToken, assignments: [{ fieldId: scan.modelFields[0].fieldId, sourcePath: 'name' }] })).stale, 1);
  });
});

test('相同编码的下拉选项按模型 optionId 定位真实选项，包括无与占位项共用空编码', async () => {
  await fixture('<label>等级<select id="level"><option value="">请选择</option><option value="same">等级甲</option><option value="same">等级乙</option></select></label><label>证书<select id="cert"><option value="">请选择</option><option value="">无</option></select></label>', async (page, fill) => {
    const p = { level: '等级乙', certs: [] }; const scan = await fill(p);
    const r = await fill(p, { action:'apply', snapshotToken:scan.snapshotToken, fillNoneWhenEmpty:true, assignments:[
      {fieldId:scan.modelFields[0].fieldId,sourcePath:'level',optionId:'option-1'},
      {fieldId:scan.modelFields[1].fieldId,sourcePath:'certs',fillNone:true,optionId:'option-0'},
    ]});
    assert.equal(r.filled,2);
    assert.equal(await page.locator('#level').evaluate(el => el.selectedOptions[0].text),'等级乙');
    assert.equal(await page.locator('#cert').evaluate(el => el.selectedOptions[0].text),'无');
  });
});
