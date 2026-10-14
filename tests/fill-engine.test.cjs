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

test('根据实际控件类型填写性别下拉框和学历文本框', async () => {
  await fixture('<p><label>性别<select id="gender"><option value="">请选择</option><option>男</option><option>女</option></select></label></p><p><label>学历<input id="degree"></label></p>', async (page, fill) => {
    const r = await fill({ gender: '女', degree: '本科' });
    assert.equal(r.filled, 2);
    assert.equal(await page.locator('#gender').inputValue(), '女');
    assert.equal(await page.locator('#degree').inputValue(), '本科');
  });
});

test('明确标签优先于冲突的 name/id 技术属性', async () => {
  await fixture('<label for="email">手机号</label><input id="email" name="email">', async (page, fill) => {
    const r = await fill({ phone: '13800138000', email: 'someone@example.com' });
    assert.equal(r.filled, 1);
    assert.equal(await page.locator('#email').inputValue(), '13800138000');
  });
});

test('标签中的括号说明不抢占姓名字段', async () => {
  await fixture('<label>姓名（与身份证一致）<input></label>', async (page, fill) => {
    const r = await fill({ name: '张三', idcard: '123456789' }, { allowOverwrite: true });
    assert.equal(r.filled, 1);
    assert.equal(await page.locator('input').inputValue(), '张三');
  });
});

test('下拉选项不会被当成标签造成误配', async () => {
  await fixture('<label>其他类别<select id="custom"><option value="">请选择</option><option>手机号</option><option>姓名</option></select></label>', async (_page, fill) => {
    const r = await fill({ name: '姓名', phone: '手机号' });
    assert.equal(r.filled, 0);
    assert.equal(r.unmatched, 1);
    assert.equal(r.pendingFields[0].label, '其他类别');
  });
});

test('不相关的多个字段含义即使匹配长度不同也留待确认', async () => {
  await fixture('<label>身份证号码及姓名<input value="原有内容"></label>', async (page, fill) => {
    const r = await fill({ name: '张三', idcard: '123456789' }, { allowOverwrite: true });
    assert.equal(r.ambiguous, 1);
    assert.equal(await page.locator('input').inputValue(), '原有内容');
  });
});

test('具体规则优先，避免户口类型和紧急联系人关系被泛规则抢占', async () => {
  await fixture('<p><label>户口类型<input id="hukou"></label></p><p><label>紧急联系人关系<input id="relation"></label></p>', async (page, fill) => {
    const r = await fill({ hukouType: '非农业', hukouLocation: '杭州市', emergencyContact: '李四', emergencyRelation: '母女' });
    assert.equal(r.filled, 2);
    assert.equal(await page.locator('#hukou').inputValue(), '非农业');
    assert.equal(await page.locator('#relation').inputValue(), '母女');
  });
});

test('独立技术属性能识别 name、age、qq，不受拼接空格影响', async () => {
  await fixture('<input id="name"><input id="age"><input id="qq">', async (page, fill) => {
    const r = await fill({ name: '张三', age: '22', qq: '123456' });
    assert.equal(r.filled, 3);
    assert.equal(await page.locator('#name').inputValue(), '张三');
  });
});

test('规则歧义不按顺序或画像是否有值决定，返回待识别描述', async () => {
  await fixture('<label>姓名电话<input id="mixed" value="原有内容"></label>', async (page, fill) => {
    const r = await fill({ name: '张三' }, { allowOverwrite: true });
    assert.equal(r.filled, 0);
    assert.equal(r.ambiguous, 1);
    assert.deepEqual(r.pendingFields[0].candidates.sort(), ['name', 'phone']);
    assert.equal(await page.locator('#mixed').inputValue(), '原有内容');
  });
});

test('家庭分区里的姓名不使用本人姓名', async () => {
  await fixture('<section><h2>家庭信息</h2><label>姓名<input id="family-name"></label></section>', async (page, fill) => {
    const r = await fill({ name: '张三' });
    assert.equal(r.ambiguous, 1);
    assert.equal(await page.locator('input').inputValue(), '');
    assert.equal(r.pendingFields[0].section, '家庭信息');
  });
});

test('日期支持点号和中文年月日，年月控件支持中文年月', async () => {
  await fixture('<p><label>出生日期<input id="birth" type="date"></label></p><p><label>毕业日期<input id="grad" type="date"></label></p><p><label>入学时间<input id="start" type="month"></label></p>', async (page, fill) => {
    const r = await fill({ birth: '2000.2.29', gradTime: '2027年6月15日', schoolStart: '2023年9月' });
    assert.equal(r.filled, 3);
    assert.equal(await page.locator('#birth').inputValue(), '2000-02-29');
    assert.equal(await page.locator('#grad').inputValue(), '2027-06-15');
    assert.equal(await page.locator('#start').inputValue(), '2023-09');
  });
});

test('缺少日或无效日期不编造，不清空已有日期', async () => {
  await fixture('<p><label>出生日期<input id="birth" type="date" value="2000-01-01"></label></p><p><label>毕业日期<input id="grad" type="date"></label></p>', async (page, fill) => {
    const r = await fill({ birth: '2001-02-29', gradTime: '2027.06' }, { allowOverwrite: true });
    assert.equal(r.filled, 0);
    assert.equal(r.invalid, 2);
    assert.equal(await page.locator('#birth').inputValue(), '2000-01-01');
    assert.equal(await page.locator('#grad').inputValue(), '');
  });
});

test('时间与日期时间按原生格式写入', async () => {
  await fixture('<p><label>到岗时间<input id="time" type="time"></label></p><p><label>出生日期<input id="datetime" type="datetime-local"></label></p>', async (page, fill) => {
    const r = await fill({ availableTime: '9时5分', birth: '2000/2/29 9:05' });
    assert.equal(r.filled, 2);
    assert.equal(await page.locator('#time').inputValue(), '09:05');
    assert.equal(await page.locator('#datetime').inputValue(), '2000-02-29T09:05');
  });
});

test('周控件校验真实的 ISO 第 53 周', async () => {
  await fixture('<label>入学时间<input type="week"></label>', async (page, fill) => {
    assert.equal((await fill({ schoolStart: '2020-W53' })).filled, 1);
    assert.equal((await fill({ schoolStart: '2021-W53' }, { allowOverwrite: true })).invalid, 1);
    assert.equal(await page.locator('input').inputValue(), '2020-W53');
  });
});

test('数值、邮箱和长度约束校验失败时保留原值', async () => {
  await fixture('<p><label>年龄<input id="age" type="number" min="18" value="22"></label></p><p><label>邮箱<input id="email" type="email" value="old@example.com"></label></p><p><label>姓名<input id="name" maxlength="2" value="李四"></label></p>', async (page, fill) => {
    const r = await fill({ age: '16', email: 'not-an-email', name: '三个字' }, { allowOverwrite: true });
    assert.equal(r.invalid, 3);
    assert.equal(await page.locator('#age').inputValue(), '22');
    assert.equal(await page.locator('#email').inputValue(), 'old@example.com');
    assert.equal(await page.locator('#name').inputValue(), '李四');
  });
});

test('下拉框不把空占位项或“接受”匹配成“不接受”', async () => {
  await fixture('<p><label>接受出差<select id="travel"><option value=""></option><option>接受</option></select></label></p><p><label>学历<select id="degree"><option value=""></option><option>本科</option></select></label></p>', async (page, fill) => {
    const r = await fill({ acceptTravel: '不接受', degree: '完全未知' });
    assert.equal(r.filled, 0);
    assert.equal(r.invalid, 2);
    assert.equal(await page.locator('#travel').inputValue(), '');
  });
});

test('下拉别名双向识别，并跳过禁用选项', async () => {
  await fixture('<label>学历<select><option value="">请选择</option><option disabled>硕士研究生</option><option>硕士</option></select></label>', async (page, fill) => {
    const r = await fill({ degree: '硕士研究生' });
    assert.equal(r.filled, 1);
    assert.equal(await page.locator('select').inputValue(), '硕士');
  });
});

test('单选组只计数一次，male 不会命中 female，出差单选也支持', async () => {
  await fixture('<fieldset><legend>性别</legend><label><input type="radio" name="gender" value="female">Female</label><label><input type="radio" name="gender" value="male">Male</label></fieldset><fieldset><legend>接受出差</legend><label><input type="radio" name="travel" value="yes">是</label><label><input type="radio" name="travel" value="no">否</label></fieldset>', async (page, fill) => {
    const r = await fill({ gender: '男', acceptTravel: '不接受' });
    assert.equal(r.filled, 2);
    assert.equal(await page.locator('[value="male"]').isChecked(), true);
    assert.equal(await page.locator('[value="female"]').isChecked(), false);
    assert.equal(await page.locator('[value="no"]').isChecked(), true);
  });
});

test('不同表单的同名单选组保持独立', async () => {
  await fixture('<form><fieldset><legend>性别</legend><label><input type="radio" name="gender" value="male">男</label></fieldset></form><form><fieldset><legend>性别</legend><label><input type="radio" name="gender" value="male">男</label></fieldset></form>', async (page, fill) => {
    const r = await fill({ gender: '男' });
    assert.equal(r.filled, 2);
    assert.equal(await page.locator('input:checked').count(), 2);
  });
});

test('验证码、上传、条款与只读控件不被自动填写', async () => {
  await fixture('<p><label>验证码<input id="captcha"></label></p><input type="file"><p><label><input id="agree" type="checkbox">同意协议</label></p><p><label>出生日期<input id="readonly" readonly></label></p>', async (page, fill) => {
    const r = await fill({ birth: '2000-01-01' });
    assert.equal(r.filled, 0);
    assert.equal(r.captcha, 1);
    assert.equal(r.file, 1);
    assert.equal(r.agreement, 1);
    assert.equal(r.unsupported, 1);
    assert.equal(await page.locator('#agree').isChecked(), false);
  });
});

test('填“无”仅在写入成功后计数，开关关闭时不填', async () => {
  await fixture('<p><label>项目经历<textarea id="projects"></textarea></label></p><p><label>英语水平<input type="number" id="english"></label></p>', async (page, fill) => {
    const off = await fill({}, { fillNoneWhenEmpty: false });
    assert.equal(off.missingData, 2);
    const r = await fill({}, { fillNoneWhenEmpty: true });
    assert.equal(r.filled, 1);
    assert.equal(r.filledNone, 1);
    assert.equal(r.invalid, 1);
    assert.equal(await page.locator('#projects').inputValue(), '无');
  });
});

test('文本与下拉框发出输入、修改和失焦事件', async () => {
  await fixture('<p><label>姓名<input id="name"></label></p><p><label>性别<select id="gender"><option value="">请选择</option><option>男</option><option>女</option></select></label></p>', async (page, fill) => {
    await page.evaluate(() => {
      window.events = [];
      for (const type of ['input', 'change', 'blur']) document.addEventListener(type, e => window.events.push(`${e.target.id}:${type}`));
    });
    await fill({ name: '张三', gender: '女' });
    assert.deepEqual(await page.evaluate(() => window.events), ['name:input', 'name:change', 'name:blur', 'gender:input', 'gender:change', 'gender:blur']);
  });
});

test('再次执行会读取新增加的 DOM 控件', async () => {
  await fixture('<p><label>姓名<input id="name"></label></p>', async (page, fill) => {
    assert.equal((await fill({ name: '张三', phone: '13800138000' })).filled, 1);
    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<p><label>手机号<input id="phone"></label></p>'));
    const second = await fill({ name: '张三', phone: '13800138000' });
    assert.equal(second.filled, 1);
    assert.equal(second.preserved, 1);
    assert.equal(await page.locator('#phone').inputValue(), '13800138000');
  });
});

test('待识别描述不返回画像或输入框当前值，且限制数量', async () => {
  await fixture(Array.from({ length: 85 }, (_, i) => `<p><label>未知字段${i}<input value="private-current-value"></label></p>`).join(''), async (_page, fill) => {
    const r = await fill({ phone: 'private-profile-value' }, { allowOverwrite: true });
    assert.equal(r.unmatched, 85);
    assert.equal(r.pendingFields.length, 80);
    assert.equal(JSON.stringify(r).includes('private-current-value'), false);
    assert.equal(JSON.stringify(r).includes('private-profile-value'), false);
  });
});

test('待识别标签不会包含 textarea 的初始内容', async () => {
  await fixture('<label>未知内容<textarea>private-initial-value</textarea></label>', async (_page, fill) => {
    const r = await fill({}, { allowOverwrite: true });
    assert.equal(r.pendingFields[0].label, '未知内容');
    assert.equal(JSON.stringify(r).includes('private-initial-value'), false);
  });
});

test('禁用 fieldset 中的控件不被填写', async () => {
  await fixture('<fieldset disabled><label>姓名<input value="原有内容"></label></fieldset>', async (page, fill) => {
    const r = await fill({ name: '张三' });
    assert.equal(r.filled, 0);
    assert.equal(await page.locator('input').inputValue(), '原有内容');
  });
});

test('模式1只收集规则未填的字段，模式2扫描不会预先填写', async () => {
  await fixture('<p><label>姓名<input id="name"></label></p><p><label>常用联络号码<input id="contact"></label></p>', async (page, fill) => {
    const p = { name: '张三', phone: '13800138000' };
    const scan = await fill(p, { action: 'scan' });
    assert.equal(scan.modelFields.length, 2);
    assert.equal(scan.filled, 0);
    assert.equal(await page.locator('#name').inputValue(), '');
    const hybrid = await fill(p, { action: 'hybrid' });
    assert.equal(hybrid.filled, 1);
    assert.equal(hybrid.modelFields.length, 1);
    assert.equal(hybrid.modelFields[0].label, '常用联络号码');
    assert.equal(await page.locator('#name').inputValue(), '张三');
  });
});

test('模型填写取本地来源，不使用模型自行生成的值', async () => {
  await fixture('<label>联络号码<input></label>', async (page, fill) => {
    const p = { phone: '13800138000' };
    const scan = await fill(p, { action: 'scan' });
    const r = await fill(p, { action: 'apply', snapshotToken: scan.snapshotToken, assignments: [{ fieldId: scan.modelFields[0].fieldId, sourcePath: 'phone', value: '伪造号码' }] });
    assert.equal(r.filled, 1);
    assert.equal(await page.locator('input').inputValue(), p.phone);
  });
});

test('模型可引用家庭成员与工作经历中的具体字段', async () => {
  await fixture('<section><h2>家庭信息</h2><label>姓名<input id="family"></label></section><section><h2>工作经历</h2><label>单位<input id="company"></label></section>', async (page, fill) => {
    const p = { name: '张三', family: [{ name: '李四' }], experiences: [{ org: '示例公司' }] };
    const scan = await fill(p, { action: 'scan' });
    const r = await fill(p, { action: 'apply', snapshotToken: scan.snapshotToken, assignments: [
      { fieldId: scan.modelFields[0].fieldId, sourcePath: 'family.0.name' },
      { fieldId: scan.modelFields[1].fieldId, sourcePath: 'experiences.0.org' },
    ] });
    assert.equal(r.filled, 2);
    assert.equal(await page.locator('#family').inputValue(), '李四');
    assert.equal(await page.locator('#company').inputValue(), '示例公司');
  });
});

test('模型选择页面现有选项，支持未知标签的下拉与单选', async () => {
  await fixture('<p><label>教育程度<select id="edu"><option value="">请选择</option><option value="b">学士</option></select></label></p><fieldset><legend>候选人类别</legend><label><input type="radio" name="kind" value="f">女性</label><label><input type="radio" name="kind" value="m">男性</label></fieldset>', async (page, fill) => {
    const p = { degree: '本科', gender: '男' };
    const scan = await fill(p, { action: 'scan' });
    const r = await fill(p, { action: 'apply', snapshotToken: scan.snapshotToken, assignments: [
      { fieldId: scan.modelFields[0].fieldId, sourcePath: 'degree', optionId: 'option-0' },
      { fieldId: scan.modelFields[1].fieldId, sourcePath: 'gender', optionId: 'option-1' },
    ] });
    assert.equal(r.filled, 2);
    assert.equal(await page.locator('#edu').inputValue(), 'b');
    assert.equal(await page.locator('[value="m"]').isChecked(), true);
  });
});

test('等待模型期间DOM重排不会按过期索引错填', async () => {
  await fixture('<p id="one"><label>联络号码<input id="contact"></label></p><p id="two"><label>个人称谓<input id="person"></label></p>', async (page, fill) => {
    const p = { phone: '13800138000', name: '张三' };
    const scan = await fill(p, { action: 'scan' });
    await page.evaluate(() => document.body.prepend(document.getElementById('two')));
    const r = await fill(p, { action: 'apply', snapshotToken: scan.snapshotToken, assignments: [{ fieldId: scan.modelFields[0].fieldId, sourcePath: 'phone' }] });
    assert.equal(r.filled, 1);
    assert.equal(await page.locator('#contact').inputValue(), p.phone);
    assert.equal(await page.locator('#person').inputValue(), '');
  });
});

test('等待模型期间控件被替换或用户输入改变时跳过', async () => {
  await fixture('<p><label>联络号码<input id="contact"></label></p><p><label>个人称谓<input id="person"></label></p>', async (page, fill) => {
    const p = { phone: '13800138000', name: '张三' };
    const scan = await fill(p, { action: 'scan' });
    await page.evaluate(() => { document.getElementById('contact').outerHTML = '<input id="contact">'; document.getElementById('person').value = '用户手填'; });
    const r = await fill(p, { action: 'apply', snapshotToken: scan.snapshotToken, assignments: [
      { fieldId: scan.modelFields[0].fieldId, sourcePath: 'phone' },
      { fieldId: scan.modelFields[1].fieldId, sourcePath: 'name' },
    ] });
    assert.equal(r.stale, 1);
    assert.equal(r.preserved, 1);
    assert.equal(r.filled, 0);
    assert.equal(await page.locator('#person').inputValue(), '用户手填');
  });
});

test('选项或页面URL变化时不应用旧模型结果', async () => {
  await fixture('<label>教育程度<select><option value="">请选择</option><option id="actual-option">学士</option></select></label>', async (page, fill) => {
    const p = { degree: '本科' };
    const scan = await fill(p, { action: 'scan' });
    await page.evaluate(() => document.querySelector('#actual-option').textContent = '其他');
    const options = { action: 'apply', snapshotToken: scan.snapshotToken, assignments: [{ fieldId: scan.modelFields[0].fieldId, sourcePath: 'degree', optionId: 'option-0' }] };
    assert.equal((await fill(p, options)).stale, 1);
    const scan2 = await fill(p, { action: 'scan' });
    await page.evaluate(() => { location.hash = 'another-step'; });
    assert.equal((await fill(p, { ...options, snapshotToken: scan2.snapshotToken })).stale, 1);
  });
});

test('模型日期范围转换使用真实来源，不补造缺失日期', async () => {
  await fixture('<p><label>任职起始<input id="start" type="month"></label></p><p><label>任职结束<input id="end" type="month"></label></p>', async (page, fill) => {
    const p = { experiences: [{ time: '2025.06-2025.09' }] };
    const scan = await fill(p, { action: 'scan' });
    const r = await fill(p, { action: 'apply', snapshotToken: scan.snapshotToken, assignments: [
      { fieldId: scan.modelFields[0].fieldId, sourcePath: 'experiences.0.time', transform: 'startDate' },
      { fieldId: scan.modelFields[1].fieldId, sourcePath: 'experiences.0.time', transform: 'endDate' },
    ] });
    assert.equal(r.filled, 2);
    assert.equal(await page.locator('#start').inputValue(), '2025-06');
    assert.equal(await page.locator('#end').inputValue(), '2025-09');
  });
});

test('模型也不能处理验证码、条款、密码或上传', async () => {
  await fixture('<p><label>验证码<input></label></p><p><label>密码<input type="password"></label></p><input type="file"><label><input type="checkbox">同意协议</label>', async (_page, fill) => {
    const scan = await fill({ name: '张三' }, { action: 'scan' });
    assert.equal(scan.modelFields.length, 0);
    assert.equal(scan.captcha, 1);
    assert.equal(scan.agreement, 1);
    assert.equal(scan.unsupported, 1);
  });
});

test('快照清理后不能再次应用模型结果', async () => {
  await fixture('<label>联络号码<input></label>', async (page, fill) => {
    const p = { phone: '13800138000' };
    const scan = await fill(p, { action: 'scan' });
    await fill({}, { action: 'cleanup', snapshotToken: scan.snapshotToken });
    const r = await fill(p, { action: 'apply', snapshotToken: scan.snapshotToken, assignments: [{ fieldId: scan.modelFields[0].fieldId, sourcePath: 'phone' }] });
    assert.equal(r.stale, 1);
    assert.equal(await page.locator('input').inputValue(), '');
  });
});

test('纯模型模式的填无开关支持画像为空或null，且仅用于允许字段', async () => {
  await fixture('<label>外语描述<textarea></textarea></label>', async (page, fill) => {
    const scan = await fill({}, { action: 'scan' });
    const r = await fill({ english: null }, { action: 'apply', snapshotToken: scan.snapshotToken, fillNoneWhenEmpty: true, assignments: [{ fieldId: scan.modelFields[0].fieldId, sourcePath: 'english' }] });
    assert.equal(r.filledNone, 1);
    assert.equal(await page.locator('textarea').inputValue(), '无');
    await page.locator('textarea').fill('');
    const scan2 = await fill({}, { action: 'scan' });
    const off = await fill({ english: null }, { action: 'apply', snapshotToken: scan2.snapshotToken, fillNoneWhenEmpty: false, assignments: [{ fieldId: scan2.modelFields[0].fieldId, sourcePath: 'english' }] });
    assert.equal(off.filled, 0);
  });
});

test('再次填写只补空白项，不覆盖用户补充的电话和项目经历', async () => {
  await fixture('<p><label>姓名<input id="name"></label></p><p><label>手机号<input id="phone"></label></p><p><label>项目经历<textarea id="projects"></textarea></label></p><p><label>毕业院校<input id="school"></label></p>', async (page, fill) => {
    await fill({ name: '张三' });
    await page.locator('#phone').fill('13900139000');
    await page.locator('#projects').fill('用户亲自补充的项目说明');
    const profile = { name: '画像姓名', phone: '13800138000', projects: [], school: '示例大学' };
    const result = await fill(profile, { action: 'hybrid', fillNoneWhenEmpty: true });
    assert.equal(result.filled, 0);
    assert.equal(result.preserved, 3);
    assert.equal(result.modelFields.length, 1);
    assert.equal(result.modelFields[0].reason, 'existing_context');
    const applied = await fill(profile, { action: 'apply', snapshotToken: result.snapshotToken, assignments: [{ fieldId: result.modelFields[0].fieldId, sourcePath: 'school' }] });
    assert.equal(applied.filled, 1);
    assert.equal(await page.locator('#name').inputValue(), '张三');
    assert.equal(await page.locator('#phone').inputValue(), '13900139000');
    assert.equal(await page.locator('#projects').inputValue(), '用户亲自补充的项目说明');
    assert.equal(await page.locator('#school').inputValue(), '示例大学');
  });
});

test('数字0、有效选项0、日期、部分邮箱、无和单选组均视为已有信息', async () => {
  await fixture('<p><label>年龄<input id="age" type="number" value="0"></label></p><p><label>城市<select id="city"><option value="0">杭州</option><option>北京</option></select></label></p><p><label>出生日期<input id="birth" type="date" value="2000-01-01"></label></p><p><label>邮箱<input id="email" value="未填完整"></label></p><p><label>项目经历<textarea id="projects">无</textarea></label></p><fieldset><legend>性别</legend><label><input type="radio" name="gender" value="female" checked>女</label><label><input type="radio" name="gender" value="male">男</label></fieldset>', async (page, fill) => {
    const p = { age: '22', city: '北京', birth: '2001-01-01', email: 'new@example.com', projects: [{ name: '项目' }], gender: '男' };
    const result = await fill(p, { action: 'scan' });
    assert.equal(result.preserved, 6);
    assert.equal(result.modelFields.length, 0);
    assert.equal(await page.locator('#age').inputValue(), '0');
    assert.equal(await page.locator('#city').inputValue(), '0');
    assert.equal(await page.locator('[value="female"]').isChecked(), true);
  });
});

test('非空编码的请选择仍算空白，不进入模型的可选选项', async () => {
  await fixture('<label>学历<select><option value="0">--请选择--</option><option value="1">本科</option></select></label>', async (page, fill) => {
    const scan = await fill({ degree: '本科' }, { action: 'scan' });
    assert.equal(scan.modelFields.length, 1);
    assert.deepEqual(scan.modelFields[0].options.map(o => o.text), ['本科']);
    const result = await fill({ degree: '本科' });
    assert.equal(result.filled, 1);
    assert.equal(await page.locator('select').inputValue(), '1');
  });
});

test('有意义的空编码选项“无”仍保留，不当作未填写', async () => {
  await fixture('<label>英语水平<select><option value="">无</option><option>CET-6</option></select></label>', async (page, fill) => {
    const result = await fill({ english: 'CET-6' }, { action: 'hybrid' });
    assert.equal(result.preserved, 1);
    assert.equal(result.modelFields.length, 0);
    assert.equal(await page.locator('select').inputValue(), '');
  });
});

test('显式允许覆盖可更新已有值，但仍保留等待模型期间的新修改', async () => {
  await fixture('<label>姓名<input value="原姓名"></label>', async (page, fill) => {
    const result = await fill({ name: '新姓名' }, { allowOverwrite: true });
    assert.equal(result.filled, 1);
    const scan = await fill({ name: '新姓名' }, { action: 'scan', allowOverwrite: true });
    await page.locator('input').fill('用户后来修改');
    const applied = await fill({ name: '模型姓名' }, { action: 'apply', allowOverwrite: true, snapshotToken: scan.snapshotToken, assignments: [{ fieldId: scan.modelFields[0].fieldId, sourcePath: 'name' }] });
    assert.equal(applied.stale, 1);
    assert.equal(await page.locator('input').inputValue(), '用户后来修改');
  });
});

test('浏览器尚未完成的数字输入不被当作空白覆盖', async () => {
  await fixture('<label>年龄<input type="number"></label>', async (page, fill) => {
    await page.locator('input').pressSequentially('-');
    assert.equal(await page.locator('input').evaluate(el => el.validity.badInput), true);
    const result = await fill({ age: '22' });
    assert.equal(result.preserved, 1);
    assert.equal(result.filled, 0);
  });
});

test('地区子项已有内容时不填父项，不触发网站清空联动', async () => {
  await fixture('<form><label>省份<select id="province"><option value="">请选择</option><option>浙江</option></select></label><label>城市<input id="city" value="用户填写的杭州"></label></form>', async (page, fill) => {
    await page.evaluate(() => document.getElementById('province').addEventListener('change', () => { document.getElementById('city').value = ''; }));
    const result = await fill({ province: '浙江', city: '杭州' }, { action: 'hybrid' });
    assert.equal(result.linkedProtected, 1);
    assert.equal(result.preserved, 1);
    assert.equal(result.filled, 0);
    assert.equal(result.modelFields.length, 0);
    assert.equal(await page.locator('#city').inputValue(), '用户填写的杭州');
  });
});

test('等待模型时用户填了城市，也会拦截省份的旧结果', async () => {
  await fixture('<form><label>省份<select id="province"><option value="">请选择</option><option>浙江</option></select></label><label>城市<input id="city"></label></form>', async (page, fill) => {
    const p = { province: '浙江', city: '杭州' };
    const scan = await fill(p, { action: 'scan' });
    await page.locator('#city').fill('手动填入的城市');
    const result = await fill(p, { action: 'apply', snapshotToken: scan.snapshotToken, assignments: [{ fieldId: scan.modelFields[0].fieldId, sourcePath: 'province', optionId: 'option-0' }] });
    assert.equal(result.linkedProtected, 1);
    assert.equal(await page.locator('#province').inputValue(), '');
    assert.equal(await page.locator('#city').inputValue(), '手动填入的城市');
  });
});

test('主页新增的额外信息可以通过精确规则或模型来源填写', async () => {
  await fixture('<p><label>驾驶证<input id="license"></label></p><p><label>驾驶资格<input id="other"></label></p>', async (page, fill) => {
    const p = { extraInfo: [{ label: '驾驶证', value: 'C1' }] };
    const rules = await fill(p);
    assert.equal(await page.locator('#license').inputValue(), 'C1');
    assert.equal(rules.filled, 1);
    const scan = await fill(p, { action: 'scan' });
    assert.equal(scan.modelFields.length, 1);
    const result = await fill(p, { action: 'apply', snapshotToken: scan.snapshotToken, assignments: [{ fieldId: scan.modelFields[0].fieldId, sourcePath: 'extraInfo.0.value' }] });
    assert.equal(result.filled, 1);
    assert.equal(await page.locator('#other').inputValue(), 'C1');
  });
});

test('模式1读取点击前已填关系和姓名，让相邻空白字段交给模型', async () => {
  await fixture('<fieldset><legend>家庭信息</legend><label>关系<select id="relation"><option value="m" selected>母亲</option></select></label><label>姓名<input id="name" value="李五" readonly></label><label>电话<input id="phone"></label></fieldset>', async (page, fill) => {
    const scan = await fill({ phone: '本人电话' }, { action: 'hybrid' });
    assert.equal(scan.filled, 0);
    assert.equal(scan.modelFields.length, 1);
    assert.equal(scan.modelFields[0].reason, 'existing_context');
    assert.deepEqual(scan.modelFields[0].existingContext.map(c => c.value).sort(), ['李五', '母亲']);
    assert.equal(await page.locator('#phone').inputValue(), '');
  });
});

test('重复家庭卡片上下文隔离，读取下拉显示文本、已选单选和只读值', async () => {
  await fixture('<section><h2>家庭</h2><fieldset><legend>关系</legend><label><input type="radio" name="rel" value="f">父亲</label><label><input type="radio" name="rel" value="m" checked>母亲</label></fieldset><label>电话<input id="mother"></label></section><section><h2>家庭</h2><label>关系<select disabled><option selected value="f">父亲</option></select></label><label>电话<input id="father"></label></section>', async (_page, fill) => {
    const scan = await fill({}, { action: 'scan' });
    assert.equal(scan.modelFields.length, 2);
    assert.deepEqual(scan.modelFields[0].existingContext.map(c => c.value), ['母亲']);
    assert.equal(scan.modelFields[0].existingContext[0].label, '关系');
    assert.deepEqual(scan.modelFields[1].existingContext.map(c => c.value), ['父亲']);
  });
});

test('模型等待期间已填关系变化、删除或内容清空时跳过旧推断', async () => {
  for (const mutation of ['change', 'remove', 'clear']) {
    await fixture('<fieldset><label>关系<select id="relation"><option value="m" selected>母亲</option><option value="f">父亲</option><option value="">请选择</option></select></label><label>电话<input id="phone"></label></fieldset>', async (page, fill) => {
      const profile = { family: [{ relation: '母亲', phone: '13900000002' }] };
      const scan = await fill(profile, { action: 'scan' });
      if (mutation === 'remove') await page.locator('#relation').evaluate(el => el.remove());
      else await page.locator('#relation').selectOption(mutation === 'clear' ? '' : 'f');
      const applied = await fill(profile, { action: 'apply', snapshotToken: scan.snapshotToken, assignments: [{ fieldId: scan.modelFields[0].fieldId, sourcePath: 'family.0.phone' }] });
      assert.equal(applied.stale, 1);
      assert.equal(await page.locator('#phone').inputValue(), '');
    });
  }
});

test('上下文排除密码、验证码、隐藏值、密钥、条款和占位选项，限制长度数量', async () => {
  const fields = Array.from({ length: 12 }, (_, i) => `<label>已填信息${i}<input value="${'a'.repeat(400)}"></label>`).join('');
  await fixture(`<form><label>密码<input type="password" value="private-password"></label><label>验证码<input value="private-captcha"></label><input type="hidden" value="private-hidden"><label>API Key<input value="private-key"></label><label>关系<select><option selected>请选择</option></select></label><label>同意条款<input type="checkbox" checked></label>${fields}<label>未知空白<input id="target"></label></form>`, async (_page, fill) => {
    const scan = await fill({}, { action: 'scan' });
    const context = scan.modelFields.find(f => f.label === '未知空白').existingContext;
    assert.equal(context.length, 8);
    assert.ok(context.every(c => c.value.length <= 240));
    const payload = JSON.stringify(scan.modelFields);
    for (const secret of ['private-password', 'private-captcha', 'private-hidden', 'private-key']) assert.equal(payload.includes(secret), false);
  });
});
