/* 纯文本资料填写：提取 DOM、保护已有内容并执行经校验的方案。
 * 资料只以文本保存，模型给出的每项内容都必须能在文本中逐字核验；
 * 写入失败时返回字段级原因码，供有界修复轮构造增量反馈。 */
async function FILL_FUNCTION(userText, opts) {
  userText = typeof userText === 'string' ? userText : '';
  opts = opts || {};
  const action = opts.action || 'scan';
  if (!['scan', 'apply', 'cleanup'].includes(action)) throw new Error('不支持的填写操作');
  const ALLOW_OVERWRITE = opts.allowOverwrite === true;
  const FILL_NONE = !!(opts && opts.fillNoneWhenEmpty);
  // 仅用于禁止自动处理验证码/条款；字段归属和选项判断全部交给模型。
  const CAPTCHA_RE = /验证码|captcha|verify|vercode|checkcode|图形码|短信码|校验码|动态码/i;
  const AGREEMENT_RE = /同意|授权|条款|协议|确认填写|声明|承诺|已阅读/i;
  const ABSENCE_WORD_RE = /^(?:无|暂无|没有|无相关|不适用|不涉及|否)$/;
  const TEXTUAL_TYPES = ['text', 'search', 'tel', 'url', 'email'];
  const DATE_TYPES = ['date', 'month', 'time', 'datetime-local', 'week'];

  function norm(s) {
    return String(s ?? '').replace(/\s+/g, ' ').replace(/[*：:]/g, '').trim();
  }

  function visible(el) {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (r.width <= 0 || r.height <= 0 || s.visibility === 'hidden' || s.display === 'none') return false;
    return true;
  }

  function labelText(el) {
    if (!el) return '';
    const copy = el.cloneNode(true);
    copy.querySelectorAll('input,select,textarea,button,[contenteditable]').forEach(control => control.remove());
    return norm(copy.textContent);
  }

  /* 文本探测（v2.6 重写，精准定位每个表单字段）：
   * 优先提取关联/包裹标签、框架容器标签、dt/dd 和邻接短文本；
   * aria-label、提示文字、技术属性作为独立来源匹配，不拼接成一长串。
   * 标签文本不包含内部表单控件的值或下拉选项。
   * 支持现代前端框架（Element UI / Ant Design / vant / layui / Arco / NutUI / TDesign 等） */
  function probeText(el) {
    let txt = '';
    // 0. label[for=id] 关联（最标准的 HTML 模式，大部分原生表单使用）
    if (el.id) {
      const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lab) txt = labelText(lab);
    }
    // 1. aria-labelledby 属性（无障碍标签，现代前端框架常用）
    if (!txt) {
      const lb = el.getAttribute('aria-labelledby');
      if (lb) {
        const refs = lb.split(/\s+/).map(id => document.getElementById(id)).filter(Boolean);
        if (refs.length) txt = norm(refs.map(labelText).join(' '));
      }
    }
    // 4. 被 <label> 直接包裹
    if (!txt) {
      const lab = el.closest('label');
      if (lab) txt = labelText(lab);
    }
    // 5. 常见表单容器内的 label 元素（Element UI / Ant Design / vant / layui / Arco / NutUI / TDesign 等）
    if (!txt) {
      const item = el.closest('.el-form-item,.form-item,.form-group,.ant-form-item,.van-field,.field,.layui-form-item,.weui-cell,.arco-form-item,.nut-form-item,.td-form-item');
      if (item) {
        const l2 = item.querySelector('.el-form-item__label,.ant-form-item-label label,label,.label,.form-label,.arco-form-item-label,.nut-form-item-label,.td-form-item__label');
        if (l2) txt = labelText(l2);
      }
    }
    // 6. dt/dd 定义列表布局（部分政府/国企表单使用）
    if (!txt) {
      const dd = el.closest('dd');
      if (dd) {
        const dt = dd.previousElementSibling;
        if (dt && /^dt$/i.test(dt.tagName || '')) txt = labelText(dt);
      }
    }
    // 7. 紧邻的前一个兄弟元素（表格 td 布局：label 在左格）
    if (!txt) {
      let prev = el.previousElementSibling;
      // 同级无前兄弟 → 查父元素的前兄弟（表格 td 布局核心逻辑）
      if (!prev || /^(input|select|textarea|button|a|img)$/i.test(prev.tagName || '')) {
        prev = el.parentElement && el.parentElement.previousElementSibling;
      }
      if (prev && !/^(input|select|textarea|button|a|img)$/i.test(prev.tagName || '')) {
        const t3 = labelText(prev);
        if (t3 && t3.length <= 24) txt = t3;
      }
    }
    // 8. 兜底：向上爬取短文本（整行多列长文本放弃，防止错配）
    if (!txt) {
      let p = el.parentElement, guard = 0;
      while (p && guard++ < 4) {
        const t4 = labelText(p);
        if (t4) {
          if (t4.length <= 40) txt = t4;
          break;
        }
        p = p.parentElement;
      }
    }
    const section = el.closest('fieldset,section,[role="group"],.resume-section');
    const heading = section && section.querySelector('legend,h1,h2,h3,h4,[role="heading"]');
    const sources = [
      { text: txt },
      { text: el.getAttribute('aria-label') },
      { text: el.type === 'radio' && section?.tagName === 'FIELDSET' ? heading?.textContent : '' },
      { text: el.getAttribute('data-label') || el.getAttribute('data-lable') },
      { text: el.getAttribute('title') },
      { text: el.placeholder },
      ...['data-field', 'data-name', 'data-prop', 'data-key', 'name', 'id'].map(key => ({ text: el.getAttribute(key), technical: true })),
    ].filter(s => norm(s.text));
    return { label: norm(txt || sources[0]?.text || ''), section: labelText(heading).slice(0, 120), sources };
  }

  function nativeSetter(el) {
    if (el.tagName === 'TEXTAREA') return Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    return Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  }

  function emitChanges(el) {
    for (const type of ['input', 'change', 'blur']) el.dispatchEvent(new Event(type, { bubbles: true }));
  }

  /* 仅转换画像中明确提供的日期/时间，不用 1 日补齐缺失的日。 */
  function formatTemporal(type, value) {
    const text = String(value).trim();
    if (type === 'time') {
      const m = text.replace(/时/g, ':').replace(/分$/, '').replace(/分/g, ':').replace(/秒$/, '').match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
      if (!m || +m[1] > 23 || +m[2] > 59 || m[3] && +m[3] > 59) return null;
      return [m[1], m[2], ...(m[3] ? [m[3]] : [])].map(v => v.padStart(2, '0')).join(':');
    }
    if (type === 'week') {
      const m = text.match(/^(\d{4})-W(\d{2})$/);
      if (!m || +m[1] < 1 || +m[2] < 1 || +m[2] > 53) return null;
      const year = new Date(0);
      year.setUTCFullYear(+m[1], 0, 1);
      const day = year.getUTCDay();
      const leap = +m[1] % 4 === 0 && (+m[1] % 100 !== 0 || +m[1] % 400 === 0);
      if (+m[2] === 53 && day !== 4 && !(day === 3 && leap)) return null;
      return text;
    }
    const normalized = text.replace(/月$/, '').replace(/[年./]/g, '-').replace(/月/g, '-').replace(/日/g, '').trim();
    if (type === 'datetime-local') {
      const m = normalized.match(/^(\d{4}-\d{1,2}-\d{1,2})[T\s]+(.+)$/);
      if (!m) return null;
      const date = formatTemporal('date', m[1]);
      const time = formatTemporal('time', m[2]);
      return date && time ? `${date}T${time}` : null;
    }
    const m = normalized.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/);
    if (!m || +m[1] < 1 || +m[2] < 1 || +m[2] > 12) return null;
    if (m[3]) {
      const date = new Date(0);
      date.setUTCFullYear(+m[1], +m[2] - 1, +m[3]);
      if (date.getUTCFullYear() !== +m[1] || date.getUTCMonth() !== +m[2] - 1 || date.getUTCDate() !== +m[3]) return null;
    }
    const month = `${m[1]}-${m[2].padStart(2, '0')}`;
    if (type === 'month') return month;
    return m[3] ? `${month}-${m[3].padStart(2, '0')}` : null;
  }

  function constraintDetail(el) {
    const validity = el.validity || {};
    const list = [];
    if (validity.patternMismatch) list.push(el.pattern ? `不符合格式要求（pattern=${el.pattern}）` : '不符合格式要求');
    if (validity.rangeUnderflow) list.push(`小于允许的最小值 ${el.min}`);
    if (validity.rangeOverflow) list.push(`大于允许的最大值 ${el.max}`);
    if (validity.stepMismatch) list.push(`不符合步长 ${el.step}`);
    if (validity.typeMismatch) list.push(`不是有效的 ${el.type} 格式`);
    if (validity.tooLong) list.push(`超过长度上限 ${el.maxLength}`);
    if (validity.badInput) list.push('浏览器无法识别该输入');
    return list.join('；') || String(el.validationMessage || '不符合输入框校验要求').slice(0, 80);
  }

  /* 三种写入手法按序尝试：原生 setter → setRangeText → 聚焦后 insertText。
   * 框架接管 value 时前一种会失效，后一种模拟真实输入路径；每种成功后都补发事件。 */
  function setNativeValue(el, value) {
    const setter = nativeSetter(el);
    if (!setter) return false;
    try { setter.call(el, value); } catch (_) { return false; }
    return el.value === value;
  }

  function selectable(el) {
    return el.tagName === 'TEXTAREA' || TEXTUAL_TYPES.includes((el.type || '').toLowerCase());
  }

  function setRangeTextValue(el, value) {
    if (!selectable(el) || String(el.value) === value) return false;
    try { el.setRangeText(value, 0, el.value.length, 'end'); } catch (_) { return false; }
    emitChanges(el);
    return el.value === value;
  }

  function insertTextValue(el, value) {
    if (!selectable(el) || String(el.value) === value) return false;
    try {
      el.focus({ preventScroll: true });
      if (typeof el.setSelectionRange === 'function') el.setSelectionRange(0, el.value.length);
      const inserted = typeof document.execCommand === 'function' && document.execCommand('insertText', false, value);
      emitChanges(el);
      return !!inserted && el.value === value;
    } catch (_) { return false; }
  }

  function writeTextValue(el, value) {
    if (setNativeValue(el, value)) { emitChanges(el); return el.value === value; }
    return setRangeTextValue(el, value) || insertTextValue(el, value);
  }

  function readBack(el) {
    return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? String(el.value) : null;
  }

  /* 单字段写入；失败时返回原因码与可读细节，供修复轮使用。 */
  function writeText(el, rawValue) {
    const type = (el.type || '').toLowerCase();
    let value = String(rawValue);
    if (DATE_TYPES.includes(type)) {
      const formatted = formatTemporal(type, value);
      if (formatted === null) return { code: 'date_format', detail: `资料中的「${value.slice(0, 30)}」不符合该日期字段要求的格式` };
      value = formatted;
    }
    if (el.maxLength >= 0 && value.length > el.maxLength) return { code: 'too_long', detail: `输入上限 ${el.maxLength} 字，资料内容 ${value.length} 字` };
    const before = el.value;
    if (!writeTextValue(el, value)) return { code: 'unsettable', detail: '页面控件不接受自动写入' };
    if (el.validity && !el.validity.valid) {
      const detail = constraintDetail(el);
      setNativeValue(el, before);
      return { code: 'constraint', detail };
    }
    return { ok: true, value };
  }

  /* 资料文本是唯一事实来源：只接受能逐字核验的内容。 */
  function transformSource(value, transform) {
    if (!transform || transform === 'original') return value;
    if (typeof value !== 'string') return undefined;
    const dates = value.match(/(?<!\d)\d{4}(?:年\d{1,2}月(?:\d{1,2}日)?|([./-])\d{1,2}(?:\1\d{1,2}(?!\d))?)?(?!\d)/g);
    if (!dates?.length) return undefined;
    if (transform === 'year') return dates[0].slice(0, 4);
    if (transform === 'startDate') return dates[0];
    if (transform === 'endDate') return dates.length > 1 ? dates[dates.length - 1] : undefined;
    return undefined;
  }

  /* 模型返回的 JSON 来源或原文摘录；不执行模型代码。
   * 保存真实节点引用和指纹，防止 API 等待期间 DOM 重排造成错填。 */
  const sessions = globalThis.__jhFillSessions || (globalThis.__jhFillSessions = new Map());
  for (const [token, session] of sessions) {
    if (Date.now() - session.createdAt > 10 * 60 * 1000) sessions.delete(token);
  }

  function radioGroup(el) {
    const group = el.name ? el.getRootNode().querySelectorAll('input[type="radio"]') : [el];
    return Array.from(group).filter(r => r.type === 'radio' && r.name === el.name && r.form === el.form);
  }

  function describeField(el, probe) {
    const type = (el.type || '').toLowerCase();
    const choices = type === 'radio' ? radioGroup(el).filter(r => visible(r) && !r.matches(':disabled'))
      : el.tagName === 'SELECT' ? Array.from(el.options).filter(o => !o.disabled && !o.parentElement?.disabled && !isPlaceholderOption(o)) : [];
    return {
      label: probe.label.slice(0, 120), section: probe.section,
      controlType: el.tagName === 'INPUT' ? type : el.tagName.toLowerCase(),
      hints: probe.sources.map(s => norm(s.text).slice(0, 120)).slice(0, 12),
      required: !!el.required, maxLength: el.maxLength >= 0 ? el.maxLength : null,
      min: el.min || '', max: el.max || '', step: el.step || '', pattern: el.pattern || '',
      options: choices.map((choice, index) => ({
        optionId: `option-${index}`,
        text: (type === 'radio' ? labelText(choice.closest('label') || (choice.id ? document.querySelector(`label[for="${CSS.escape(choice.id)}"]`) : null)) : norm(choice.text)).slice(0, 120),
        value: String(choice.value).slice(0, 160),
      })),
    };
  }

  function baseline(el) {
    if (el.type === 'radio') return JSON.stringify(radioGroup(el).map(r => r.checked));
    return el.tagName === 'SELECT' ? JSON.stringify([el.selectedIndex, el.value]) : el.value;
  }

  function isPlaceholderOption(option) {
    return /^(?:[-—\s]*(?:请选择|请选|选择|please\s+select|select\b|choose\b|pick\b)|[-—\s]*$)/i.test(norm(option.text));
  }

  function hasExistingValue(el) {
    if (el.validity?.badInput) return true; // 浏览器仍在编辑的部分数字/日期不能当作空白覆盖。
    if (el.type === 'radio') return radioGroup(el).some(r => r.checked);
    if (el.tagName === 'SELECT') {
      return Array.from(el.selectedOptions).some(o => !isPlaceholderOption(o));
    }
    return String(el.value ?? '').trim() !== '';
  }

  const contextScopes = new WeakMap();
  function contextScope(el) {
    if (action !== 'apply' && contextScopes.has(el)) return contextScopes.get(el);
    // 取最近的多字段行/卡片/分区，避免把另一条家庭成员或经历的值混入。
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      const controls = Array.from(parent.querySelectorAll('input,select,textarea'));
      const logical = new Set(controls.filter(c => visible(c) && !['hidden', 'button', 'submit', 'reset', 'image'].includes(c.type))
        .map(c => c.type === 'radio' && c.name ? radioGroup(c)[0] : c));
      if (logical.size >= 2) {
        if (action !== 'apply') contextScopes.set(el, parent);
        return parent;
      }
      if (parent === document.body) break;
    }
    if (action !== 'apply') contextScopes.set(el, null);
    return null;
  }

  function readExistingContext(el) {
    const type = (el.type || '').toLowerCase();
    if (!visible(el) || !hasExistingValue(el) || el.validity?.badInput || el.multiple
        || ['hidden', 'password', 'file', 'checkbox', 'range', 'color', 'button', 'submit', 'reset', 'image'].includes(type)) return null;
    const probe = probeText(el);
    const evidence = probe.sources.map(s => s.text).join(' ');
    if (CAPTCHA_RE.test(evidence) || AGREEMENT_RE.test(evidence)
        || /密码|口令|密钥|api.?key|token|secret/i.test(evidence) || el.autocomplete === 'one-time-code') return null;
    let value;
    if (el.tagName === 'SELECT') value = Array.from(el.selectedOptions).filter(o => !isPlaceholderOption(o)).map(o => norm(o.text)).join('、');
    else if (type === 'radio') {
      const selected = radioGroup(el).find(r => r.checked);
      if (selected !== el) return null;
      value = labelText(selected.closest('label') || (selected.id ? document.querySelector(`label[for="${CSS.escape(selected.id)}"]`) : null)) || selected.value;
      // 单选选项标签是“母亲”；分组标题才是“关系”。
      probe.label = probe.section || el.name || probe.label;
    } else value = String(el.value).trim();
    if (!value) return null;
    return { label: probe.label.slice(0, 120), section: probe.section, controlType: el.tagName === 'INPUT' ? type : el.tagName.toLowerCase(), value: value.slice(0, 240) };
  }

  // 已有子项时不自动修改已识别的地区父项，避免网站联动清空子项。
  function hasProtectedDependent(el) {
    if (ALLOW_OVERWRITE || el.tagName !== 'SELECT') return false;
    const text = probeText(el).sources.map(s => norm(s.text)).join(' ');
    const province = /省份|所在省|province|\b省\b/i.test(text);
    const city = !province && /城市|所在市|\bcity\b/i.test(text);
    const country = /国家|country/i.test(text);
    if (!province && !city && !country) return false;
    const scope = el.form || el.closest('fieldset,section') || document;
    return Array.from(scope.querySelectorAll('input,select,textarea')).some(child => {
      if (child === el || !visible(child) || !hasExistingValue(child)) return false;
      const hints = probeText(child).sources.map(s => norm(s.text)).join(' ');
      if (country && /省份|所在省|province/i.test(hints)) return true;
      if ((country || province) && /城市|所在市|\bcity\b/i.test(hints)) return true;
      return /区县|县区|行政区|district|county/i.test(hints);
    });
  }

  /* 快照比对：字段、选项、上下文任何一个变化都拒绝写入，避免错填到新内容上。 */
  function checkStale(el, record, session) {
    if (!el.isConnected) return '字段已被页面移除';
    if (!visible(el)) return '字段变为不可见';
    if (el.matches(':disabled') || el.readOnly) return '字段变为禁用或只读';
    if (record.signature !== JSON.stringify(describeField(el, probeText(el)))) return '字段标签或选项已变化';
    if (record.baseline !== baseline(el)) return '字段内容已变化';
    for (const context of record.contextRecords) {
      if (!context.el.isConnected || context.scope !== contextScope(context.el)) return '同区域其他字段已变化';
      const selfWritten = session.written.has(context.el) && session.written.get(context.el) === baseline(context.el);
      if (!selfWritten && context.signature !== JSON.stringify(readExistingContext(context.el))) return '同区域已填内容已变化';
    }
    return null;
  }

  function summarize(outcomes) {
    const result = { filled: 0, filledNone: 0, skipped: 0, stale: 0, preserved: 0, linkedProtected: 0, outcomes, filledFieldIds: [], preservedFieldIds: [] };
    for (const outcome of outcomes) {
      if (outcome.status === 'filled') {
        result.filled++;
        if (outcome.fillNone) result.filledNone++;
        result.filledFieldIds.push(outcome.fieldId);
      } else if (outcome.status === 'preserved') {
        result.preserved++; result.skipped++; result.preservedFieldIds.push(outcome.fieldId);
      } else {
        result.skipped++;
        if (outcome.code === 'stale') result.stale++;
        if (outcome.code === 'linked') result.linkedProtected++;
      }
    }
    return result;
  }

  if (action === 'cleanup') {
    sessions.delete(opts.snapshotToken);
    return { cleaned: true };
  }

  if (action === 'apply') {
    const session = sessions.get(opts.snapshotToken);
    const assignments = Array.isArray(opts.assignments) ? opts.assignments : [];
    const outcomes = [];
    if (!session || session.url !== location.href) {
      for (const assignment of assignments) outcomes.push({ fieldId: assignment?.fieldId, label: '', status: 'skipped', code: 'stale', detail: '页面已跳转或重新加载' });
      return summarize(outcomes);
    }
    const compact = value => String(value).replace(/\s+/g, '');
    const written = [];
    for (const assignment of assignments) {
      const record = session.entries.get(assignment?.fieldId);
      const label = record?.description?.label || '';
      const push = outcome => { const record = { fieldId: assignment?.fieldId, label, ...outcome }; outcomes.push(record); return record; };
      const attempts = session.attempts.get(assignment?.fieldId) || 0;
      if (!record || attempts >= 3) { push({ status: 'skipped', code: 'record', detail: '字段已失效或重复提交' }); continue; }
      session.attempts.set(assignment.fieldId, attempts + 1);
      const el = record.el;
      if (!ALLOW_OVERWRITE && el.isConnected && hasExistingValue(el)) { push({ status: 'preserved', code: 'preserved', detail: '页面已有内容，已保留' }); continue; }
      const staleReason = checkStale(el, record, session);
      if (staleReason) { push({ status: 'skipped', code: 'stale', detail: staleReason }); continue; }
      if (hasProtectedDependent(el)) { push({ status: 'skipped', code: 'linked', detail: '地区联动字段，需手动选择' }); continue; }
      if (typeof assignment.value !== 'string' || !assignment.value.trim()) { push({ status: 'skipped', code: 'no_value', detail: '模型未给出内容' }); continue; }
      const value = assignment.value.trim();
      if (assignment.fillNone === true) {
        if (!FILL_NONE || !ABSENCE_WORD_RE.test(value)) { push({ status: 'skipped', code: 'bad_fillnone', detail: '未经允许不能填「无」' }); continue; }
      } else {
        const quote = assignment.evidenceQuote;
        if (typeof quote !== 'string' || !quote || !userText.includes(quote) || !compact(quote).includes(compact(value))) {
          push({ status: 'skipped', code: 'evidence_mismatch', detail: '内容与资料原文对不上', value: value.slice(0, 200) });
          continue;
        }
      }
      const transformed = assignment.fillNone === true ? value : transformSource(value, assignment.transform);
      if (transformed === undefined) { push({ status: 'skipped', code: 'date_format', detail: '无法从资料文本中取出该字段需要的日期', value: value.slice(0, 200) }); continue; }
      const finalValue = String(transformed);
      const filled = { status: 'filled', code: 'ok', fillNone: assignment.fillNone === true, value: finalValue };
      if (assignment.optionId != null) {
        const index = record.description.options.findIndex(option => option.optionId === assignment.optionId);
        const option = index >= 0 ? record.choices[index] : null;
        if (!option || !option.isConnected || option.disabled) { push({ status: 'skipped', code: 'bad_option', detail: '该选项已不存在或不可选', value: finalValue }); continue; }
        let selected = false;
        if (el.tagName === 'SELECT' && el.contains(option)) {
          const selectedIndex = option.index;
          el.selectedIndex = selectedIndex;
          emitChanges(el);
          selected = el.selectedIndex === selectedIndex;
        } else if (el.type === 'radio') {
          if (!option.checked) option.click();
          if (!option.checked) { option.checked = true; emitChanges(option); }
          selected = option.checked;
        }
        if (!selected) { push({ status: 'skipped', code: 'bad_option', detail: '无法选中该选项', value: finalValue }); continue; }
        session.written.set(el, baseline(el));
        push(filled);
        continue;
      }
      if (el.tagName === 'SELECT' || el.type === 'radio') { push({ status: 'skipped', code: 'no_option', detail: '下拉或单选没有给出选项', value: finalValue }); continue; }
      const write = writeText(el, finalValue);
      if (!write.ok) { push({ status: 'skipped', code: write.code, detail: write.detail, value: finalValue.slice(0, 200) }); continue; }
      session.written.set(el, baseline(el));
      const outcome = push({ status: 'filled', code: 'ok', fillNone: assignment.fillNone === true, value: write.value });
      written.push({ el, value: write.value, outcome });
    }
    // 延迟复检：只认 input/change/blur 的组件常在此刻还原值，还原的当场重写一次。
    if (written.length) {
      await new Promise(resolve => setTimeout(resolve, 150));
      for (const item of written) {
        if (readBack(item.el) === item.value) continue;
        const retry = writeText(item.el, item.value);
        let recovered = !!retry.ok;
        if (recovered) {
          await new Promise(resolve => setTimeout(resolve, 80));
          recovered = readBack(item.el) === retry.value;
        }
        if (recovered) continue;
        item.outcome.status = 'skipped';
        item.outcome.code = 'reverted';
        item.outcome.detail = '填写后被页面脚本还原，该控件不支持自动填写';
      }
    }
    if (opts.finish) sessions.delete(opts.snapshotToken);
    return summarize(outcomes);
  }

  const collectModel = action === 'scan';
  const snapshotToken = collectModel ? Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('') : null;
  const session = collectModel ? { createdAt: Date.now(), url: location.href, entries: new Map(), attempts: new Map(), written: new Map() } : null;
  if (session) {
    if (sessions.size >= 5) sessions.delete(sessions.keys().next().value);
    sessions.set(snapshotToken, session);
  }
  const modelFields = [];
  const skippedFields = [];
  const els = Array.from(document.querySelectorAll('input,select,textarea'));
  // 一次性读取点击时已有的值，本次新写入的内容不能作为后续判断依据。
  const contextRecords = collectModel ? els.flatMap((el, index) => {
    const description = readExistingContext(el);
    const scope = description && contextScope(el);
    return scope ? [{ el, index, scope, description, signature: JSON.stringify(description) }] : [];
  }) : [];
  function relatedContext(el, index) {
    const scope = contextScope(el);
    const group = el.type === 'radio' ? radioGroup(el) : [el];
    return contextRecords.filter(c => c.scope === scope && !group.includes(c.el))
      .sort((a, b) => Math.abs(a.index - index) - Math.abs(b.index - index)).slice(0, 8);
  }
  function queueModel(el, index, probe) {
    if (!session) return;
    const description = describeField(el, probe);
    const fieldId = `field-${index}`;
    const nearby = relatedContext(el, index);
    const choices = el.type === 'radio' ? radioGroup(el).filter(r => visible(r) && !r.matches(':disabled'))
      : el.tagName === 'SELECT' ? Array.from(el.options).filter(o => !o.disabled && !o.parentElement?.disabled && !isPlaceholderOption(o)) : [];
    session.entries.set(fieldId, { el, choices, description, signature: JSON.stringify(description), baseline: baseline(el), contextRecords: nearby });
    modelFields.push({ fieldId, ...description, existingContext: nearby.map(c => c.description) });
  }

  let filled = 0, skipped = 0, captcha = 0, file = 0, unsupported = 0, agreement = 0;
  let preserved = 0, linkedProtected = 0;
  const seen = new Set();
  const noteSkipped = (label, code) => { if (skippedFields.length < 24) skippedFields.push({ label: String(label || '未命名字段').slice(0, 60), code }); };

  for (const [index, el] of els.entries()) {
    const type = (el.type || '').toLowerCase();
    // 文件上传直接跳过
    if (type === 'file') { file++; noteSkipped(probeText(el).label, 'file'); continue; }
    if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
    if (!visible(el) || el.matches(':disabled')) continue;
    if (seen.has(el)) continue;
    seen.add(el);

    const probe = probeText(el);
    const evidence = probe.sources.map(s => s.text).join(' ');
    if (CAPTCHA_RE.test(evidence)) { captcha++; noteSkipped(probe.label, 'captcha'); continue; }
    if (AGREEMENT_RE.test(evidence)) { agreement++; noteSkipped(probe.label, 'agreement'); continue; }
    if (el.readOnly || ['password', 'checkbox', 'range', 'color'].includes(type) || el.multiple) {
      unsupported++; skipped++; noteSkipped(probe.label, 'unsupported'); continue;
    }
    if (!ALLOW_OVERWRITE && hasExistingValue(el)) {
      if (type === 'radio') radioGroup(el).forEach(r => seen.add(r));
      preserved++;
      continue;
    }
    if (hasProtectedDependent(el)) {
      linkedProtected++;
      noteSkipped(probe.label, 'linked');
      continue;
    }
    if (type === 'radio') radioGroup(el).forEach(r => seen.add(r));
    queueModel(el, index, probe);
  }

  return { filled, skipped, captcha, file, unsupported, agreement, preserved, linkedProtected,
    modelFields, skippedFields, snapshotToken };

}

if (typeof module !== 'undefined' && module.exports) module.exports = { FILL_FUNCTION };
if (typeof window !== 'undefined') window.FILL_FUNCTION = FILL_FUNCTION;
