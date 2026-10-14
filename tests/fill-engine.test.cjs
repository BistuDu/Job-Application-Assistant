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
    const fill = (userText, opts = {}) => page.evaluate(({ userText, opts }) => window.runFill(userText, opts), { userText, opts });
    await run(page, fill);
  } finally {
    await page.close();
  }
}

const write = (fill, userText, scan, assignments, opts = {}) => fill(userText, { action: 'apply', snapshotToken: scan.snapshotToken, assignments, ...opts });
const codes = result => result.outcomes.map(outcome => outcome.code);
const item = (fieldId, value, evidenceQuote, extra = {}) => ({ fieldId, value, evidenceQuote, optionId: null, transform: 'original', fillNone: false, ...extra });

test('扫描只描述字段，写入的内容必须能在资料原文中核验', async () => {
  await fixture('<label>姓名<input id="name"></label><label>手机号<input id="phone"></label>', async (page, fill) => {
    const text = '我叫张三，手机号是13900000002。';
    const scan = await fill(text);
    assert.equal(scan.filled, 0);
    assert.equal(scan.modelFields.length, 2);
    assert.equal(await page.locator('#name').inputValue(), '');
    const result = await write(fill, text, scan, [item(scan.modelFields[0].fieldId, '张三', '我叫张三'), item(scan.modelFields[1].fieldId, '13900000002', text)]);
    assert.equal(result.filled, 2);
    assert.deepEqual(result.filledFieldIds, scan.modelFields.map(field => field.fieldId));
    assert.equal(await page.locator('#name').inputValue(), '张三');
    assert.equal(await page.locator('#phone').inputValue(), '13900000002');
  });
});

test('原文对不上的内容不写入，并给出可反馈的原因码', async () => {
  await fixture('<label>手机号<input id="phone"></label>', async (page, fill) => {
    const text = '手机号是13900000002。';
    const scan = await fill(text);
    const result = await write(fill, text, scan, [item(scan.modelFields[0].fieldId, '13700000000', text)]);
    assert.equal(result.filled, 0);
    assert.equal(result.outcomes[0].code, 'evidence_mismatch');
    assert.equal(result.outcomes[0].label, '手机号');
    assert.equal(result.outcomes[0].value, '13700000000');
    assert.equal(await page.locator('#phone').inputValue(), '');
  });
});

test('下拉只按真实 optionId 选择，无效或禁用选项记为 bad_option', async () => {
  await fixture('<label>学历<select id="degree"><option value="">请选择</option><option value="b">本科</option><option value="m" disabled>硕士</option></select></label>', async (page, fill) => {
    const text = '我是本科学历。硕士没有读。';
    const scan = await fill(text);
    assert.equal(scan.modelFields[0].options.length, 1);
    const fieldId = scan.modelFields[0].fieldId;
    const bad = await write(fill, text, scan, [{ fieldId, value: '本科', evidenceQuote: text, optionId: 'option-9' }]);
    assert.equal(bad.outcomes[0].code, 'bad_option');
    assert.equal(await page.locator('#degree').inputValue(), '');
    const ok = await write(fill, text, scan, [{ fieldId, value: '本科', evidenceQuote: text, optionId: 'option-0' }]);
    assert.equal(ok.filled, 1);
    assert.equal(await page.locator('#degree').inputValue(), 'b');
  });
});

test('单选组按 optionId 点击真实选项', async () => {
  await fixture('<fieldset><legend>性别</legend><label><input type="radio" name="sex" value="m">男</label><label><input type="radio" name="sex" value="f">女</label></fieldset>', async (page, fill) => {
    const text = '性别女。';
    const scan = await fill(text);
    const result = await write(fill, text, scan, [{ fieldId: scan.modelFields[0].fieldId, value: '女', evidenceQuote: text, optionId: 'option-1' }]);
    assert.equal(result.filled, 1);
    assert.equal(await page.locator('input[value=f]').isChecked(), true);
  });
});

test('已有值、有效零、无、日期和单选组均保护，只有占位项可补', async () => {
  await fixture('<label>姓名<input value="已填"></label><label>年龄<input type="number" value="0"></label><label>描述<textarea>无</textarea></label><label>日期<input type="date" value="2000-01-01"></label><label>选项<select><option value="0">有效零</option></select></label><label>空选择<select id="empty"><option value="0">请选择</option><option value="1">选项</option></select></label><label><input type="radio" name="x" checked>是</label><label><input type="radio" name="x">否</label>', async (_page, fill) => {
    const scan = await fill('我叫张三。');
    assert.equal(scan.preserved, 6);
    assert.equal(scan.modelFields.length, 1);
    assert.equal(scan.modelFields[0].options[0].value, '1');
  });
});

test('验证码、上传、条款、只读、隐藏和禁用项不填，并按名称列入需手动处理', async () => {
  await fixture('<label>图形验证码<input></label><label>密码<input type="password"></label><label>简历附件<input type="file"></label><label>同意条款<input type="checkbox"></label><label>系统编号<input readonly value="A1"></label><input type="hidden"><fieldset disabled><input></fieldset>', async (_page, fill) => {
    const scan = await fill('我叫张三。');
    assert.equal(scan.modelFields.length, 0);
    assert.equal(scan.captcha, 1);
    assert.equal(scan.file, 1);
    assert.equal(scan.agreement, 1);
    assert.equal(scan.unsupported, 2);
    const skipped = Object.fromEntries(scan.skippedFields.map(item => [item.code, item.label]));
    assert.equal(skipped.captcha, '图形验证码');
    assert.equal(skipped.file, '简历附件');
    assert.equal(skipped.agreement, '同意条款');
    assert.equal(skipped.unsupported, '系统编号');
  });
});

test('超长、日期格式不符和格式校验失败分别给出原因码，且不留下脏值', async () => {
  await fixture('<label>简介<input id="bio" maxlength="5"></label><label>入职日期<input id="date" type="date"></label><label>邮编<input id="zip" pattern="\\d{6}"></label>', async (page, fill) => {
    const text = '简介是前端开发工程师，入职日期2023.9-2024.6，现居北京，邮编不详。';
    const scan = await fill(text);
    const ids = scan.modelFields.map(field => field.fieldId);
    const result = await write(fill, text, scan, [
      item(ids[0], '前端开发工程师', text),
      item(ids[1], '2023.9-2024.6', text),
      item(ids[2], '北京', text),
    ]);
    assert.deepEqual(codes(result), ['too_long', 'date_format', 'constraint']);
    assert.equal(result.filled, 0);
    assert.match(result.outcomes[0].detail, /输入上限 5 字/);
    assert.match(result.outcomes[2].detail, /pattern/);
    assert.equal(await page.locator('#bio').inputValue(), '');
    assert.equal(await page.locator('#date').inputValue(), '');
    assert.equal(await page.locator('#zip').inputValue(), '');
  });
});

test('起止日期按 transform 从同一段原文取出，不补造缺失的日', async () => {
  await fixture('<label>开始<input type="month" id="start"></label><label>结束<input type="month" id="end"></label><label>日期<input type="date" id="exact"></label>', async (page, fill) => {
    const text = '实习时间2025.06-2025.09。';
    const scan = await fill(text);
    const ids = scan.modelFields.map(field => field.fieldId);
    const result = await write(fill, text, scan, [
      item(ids[0], '2025.06-2025.09', text, { transform: 'startDate' }),
      item(ids[1], '2025.06-2025.09', text, { transform: 'endDate' }),
      item(ids[2], '2025.06-2025.09', text, { transform: 'startDate' }),
    ]);
    assert.deepEqual(codes(result), ['ok', 'ok', 'date_format']);
    assert.equal(await page.locator('#start').inputValue(), '2025-06');
    assert.equal(await page.locator('#end').inputValue(), '2025-09');
    assert.equal(await page.locator('#exact').inputValue(), '');
  });
});

test('只有资料明确说明没有、且用户开启开关时才填「无」', async () => {
  await fixture('<label>获奖经历<input id="awards"></label>', async (page, fill) => {
    const text = '没有获得过竞赛奖项。';
    const scan = await fill(text, { fillNoneWhenEmpty: true });
    const none = { fieldId: scan.modelFields[0].fieldId, value: '无', evidenceQuote: text, optionId: null, transform: 'original', fillNone: true };
    const blocked = await write(fill, text, scan, [none], { fillNoneWhenEmpty: false });
    assert.equal(blocked.outcomes[0].code, 'bad_fillnone');
    assert.equal(await page.locator('#awards').inputValue(), '');
    const result = await write(fill, text, scan, [none], { fillNoneWhenEmpty: true });
    assert.equal(result.filled, 1);
    assert.equal(result.filledNone, 1);
    assert.equal(await page.locator('#awards').inputValue(), '无');
  });
});

test('等待模型期间用户补全、替换节点或关系变化都不会应用旧结果', async () => {
  for (const change of ['fill', 'replace', 'relation']) await fixture('<fieldset><label>关系<select id="relation"><option value="m">母亲</option><option value="f">父亲</option></select></label><label>电话<input id="phone"></label></fieldset>', async (page, fill) => {
    const text = '母亲电话是13900000002。';
    const scan = await fill(text);
    if (change === 'fill') await page.locator('#phone').fill('用户补充');
    if (change === 'replace') await page.locator('#phone').evaluate(el => el.replaceWith(el.cloneNode()));
    if (change === 'relation') await page.locator('#relation').selectOption('f');
    const result = await write(fill, text, scan, [item(scan.modelFields[0].fieldId, '13900000002', text)]);
    assert.equal(result.filled, 0);
    assert.equal(change === 'fill' ? result.preserved : result.stale, 1);
    assert.equal(await page.locator('#phone').inputValue(), change === 'fill' ? '用户补充' : '');
  });
});

test('标签或选项变化使快照失效，节点移动仍可写入', async () => {
  await fixture('<p id="a"><label>姓名<input id="name"></label></p><p id="b"><label>手机号<input id="phone"></label></p>', async (page, fill) => {
    const text = '我叫张三，手机号是13800138000。';
    const scan = await fill(text);
    await page.locator('#a').evaluate(el => el.parentElement.appendChild(el));
    const result = await write(fill, text, scan, [item(scan.modelFields[0].fieldId, '张三', '我叫张三'), item(scan.modelFields[1].fieldId, '13800138000', text)]);
    assert.equal(result.filled, 2);
    assert.equal(await page.locator('#name').inputValue(), '张三');
  });
  await fixture('<label>学历<select id="degree"><option>请选择</option><option value="b">本科</option></select></label>', async (page, fill) => {
    const text = '我是本科学历。';
    const scan = await fill(text);
    await page.locator('option[value=b]').evaluate(el => { el.textContent = '博士'; });
    const result = await write(fill, text, scan, [{ fieldId: scan.modelFields[0].fieldId, value: '本科', evidenceQuote: text, optionId: 'option-0' }]);
    assert.equal(result.stale, 1);
    assert.equal(result.outcomes[0].code, 'stale');
  });
});

test('显式覆盖仍保护等待期间新输入，本任务自身更新的上下文不会误拦截', async () => {
  await fixture('<label>姓名<input id="name" value="旧名"></label><label>手机号<input id="phone" value="旧号"></label>', async (page, fill) => {
    const text = '我叫张三，手机号是13800138000。';
    const scan = await fill(text, { allowOverwrite: true });
    const result = await write(fill, text, scan, [item(scan.modelFields[0].fieldId, '张三', '我叫张三'), item(scan.modelFields[1].fieldId, '13800138000', text)], { allowOverwrite: true });
    assert.equal(result.filled, 2);
    assert.equal(await page.locator('#phone').inputValue(), '13800138000');
    const second = await fill(text, { allowOverwrite: true });
    await page.locator('#name').fill('等待时新名');
    const blocked = await write(fill, text, second, [item(second.modelFields[0].fieldId, '张三', '我叫张三')], { allowOverwrite: true });
    assert.equal(blocked.stale, 1);
    assert.equal(await page.locator('#name').inputValue(), '等待时新名');
  });
});

test('实际写入补发 input/change/blur 事件，清理后不能复用旧快照', async () => {
  await fixture('<label>姓名<input id="name"></label>', async (page, fill) => {
    await page.evaluate(() => { window.events = []; for (const type of ['input', 'change', 'blur']) document.querySelector('input').addEventListener(type, () => events.push(type)); });
    const text = '我叫张三。';
    const scan = await fill(text);
    const result = await write(fill, text, scan, [item(scan.modelFields[0].fieldId, '张三', '我叫张三')]);
    assert.equal(result.filled, 1);
    assert.deepEqual(await page.evaluate(() => events), ['input', 'change', 'blur']);
    await fill({}, { action: 'cleanup', snapshotToken: scan.snapshotToken });
    assert.equal((await write(fill, text, scan, [item(scan.modelFields[0].fieldId, '张三', '我叫张三')])).stale, 1);
  });
});

test('同一快照对同一字段最多尝试三次', async () => {
  await fixture('<label>姓名<input id="name"></label>', async (page, fill) => {
    const text = '我叫张三。';
    const scan = await fill(text);
    const fieldId = scan.modelFields[0].fieldId;
    const bad = item(fieldId, '李四', '我叫张三。');
    for (let count = 0; count < 3; count++) assert.equal((await write(fill, text, scan, [bad])).outcomes[0].code, 'evidence_mismatch');
    assert.equal((await write(fill, text, scan, [bad])).outcomes[0].code, 'record');
    assert.equal(await page.locator('#name').inputValue(), '');
  });
});

test('写入后被页面脚本还原的字段会被识别出来，不谎报成功', async () => {
  await fixture('<label>姓名<input id="name"></label>', async (page, fill) => {
    await page.evaluate(() => {
      const el = document.querySelector('#name');
      el.addEventListener('input', () => setTimeout(() => { el.value = ''; }, 20));
    });
    const text = '我叫张三。';
    const scan = await fill(text);
    const result = await write(fill, text, scan, [item(scan.modelFields[0].fieldId, '张三', '我叫张三')]);
    assert.equal(result.filled, 0);
    assert.equal(result.outcomes[0].code, 'reverted');
    assert.match(result.outcomes[0].detail, /还原/);
    assert.equal(await page.locator('#name').inputValue(), '');
  });
});

test('相同编码的下拉选项按 optionId 定位真实选项，包括无与占位项共用空编码', async () => {
  await fixture('<label>等级<select id="level"><option value="">请选择</option><option value="same">等级甲</option><option value="same">等级乙</option></select></label><label>证书<select id="cert"><option value="">请选择</option><option value="">无</option></select></label>', async (page, fill) => {
    const text = '我的等级是等级乙。没有考取证书。';
    const scan = await fill(text);
    const result = await write(fill, text, scan, [
      { fieldId: scan.modelFields[0].fieldId, value: '等级乙', evidenceQuote: '我的等级是等级乙。', optionId: 'option-1' },
      { fieldId: scan.modelFields[1].fieldId, value: '无', evidenceQuote: '没有考取证书。', optionId: 'option-0', fillNone: true },
    ], { fillNoneWhenEmpty: true });
    assert.equal(result.filled, 2);
    assert.equal(result.filledNone, 1);
    assert.equal(await page.locator('#level').evaluate(el => el.selectedOptions[0].text), '等级乙');
    assert.equal(await page.locator('#cert').evaluate(el => el.selectedOptions[0].text), '无');
  });
});

test('家庭卡片的已有上下文互不混用，敏感值不发送', async () => {
  await fixture('<fieldset><legend>家庭信息</legend><label>关系<select><option selected>母亲</option></select></label><label>电话<input id="mother"></label><label>密码<input type="password" value="private-password"></label></fieldset><fieldset><legend>家庭信息</legend><label>关系<input value="父亲" readonly></label><label>电话<input id="father"></label></fieldset>', async (_page, fill) => {
    const scan = await fill('母亲电话是13900000002，父亲电话是13800138000。');
    assert.equal(scan.modelFields.length, 2);
    assert.deepEqual(scan.modelFields[0].existingContext.map(context => context.value), ['母亲']);
    assert.deepEqual(scan.modelFields[1].existingContext.map(context => context.value), ['父亲']);
    assert.equal(JSON.stringify(scan).includes('private-password'), false);
  });
});

test('地区子项已有内容时跳过父项，不触发页面清空联动', async () => {
  await fixture('<label>省份<select><option>请选择</option><option>浙江</option></select></label><label>城市<input value="杭州"></label>', async (_page, fill) => {
    const scan = await fill('现居浙江杭州。');
    assert.equal(scan.linkedProtected, 1);
    assert.equal(scan.preserved, 1);
    assert.equal(scan.modelFields.length, 0);
    assert.equal(scan.skippedFields[0].code, 'linked');
  });
});
