/* 纯模型填写：提取 DOM、保护已有内容并执行经校验的方案。 */
function FILL_FUNCTION(profile, opts) {
  profile = profile && typeof profile === 'object' && !Array.isArray(profile) ? profile : {};
  opts = opts || {};
  const action = opts.action || 'scan';
  if (!['scan', 'apply', 'cleanup'].includes(action)) throw new Error('不支持的填写操作');
  const ALLOW_OVERWRITE = opts.allowOverwrite === true;
  const FILL_NONE = !!(opts && opts.fillNoneWhenEmpty);
  // 仅用于禁止自动处理验证码/条款；字段归属和选项判断全部交给模型。
  const CAPTCHA_RE = /验证码|captcha|verify|vercode|checkcode|图形码|短信码|校验码|动态码/i;
  const AGREEMENT_RE = /同意|授权|条款|协议|确认填写|声明|承诺|已阅读/i;

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

  function setVal(el, val) {
    const type = (el.type || '').toLowerCase();
    let value = String(val);
    if (['date', 'month', 'time', 'datetime-local', 'week'].includes(type)) {
      value = formatTemporal(type, value);
      if (value === null) return false;
    }
    if (el.maxLength >= 0 && value.length > el.maxLength) return false;
    const setter = nativeSetter(el);
    const before = el.value;
    if (setter) setter.call(el, value); else el.value = value;
    if (el.value !== value || el.validity && !el.validity.valid) {
      if (setter) setter.call(el, before); else el.value = before;
      return false;
    }
    emitChanges(el);
    return el.value === value;
  }

  function radioGroup(el) {
    const group = el.name ? el.getRootNode().querySelectorAll('input[type="radio"]') : [el];
    return Array.from(group).filter(r => r.type === 'radio' && r.name === el.name && r.form === el.form);
  }

  /* 对象数组 → 可读文本（适用于 experiences/campus/awards/projects/papers/volunteer/family/research/competitions） */
  function formatArray(val) {
    if (!Array.isArray(val) || !val.length) return String(val || '');
    if (typeof val[0] !== 'object' || !val[0]) return val.join('、');

    return val.map(e => {
      // 经历/志愿类（org/role/time/desc + 可选 salary/reason/referee）
      if (e.org) {
        let parts = [e.org, e.role].filter(Boolean).join(' ');
        if (e.time) parts += `（${e.time}）`;
        if (e.desc) parts += `：${e.desc}`;
        if (e.salary) parts += `，薪资：${e.salary}`;
        if (e.reason) parts += `，离职原因：${e.reason}`;
        if (e.referee) {
          parts += `，证明人：${e.referee}`;
          if (e.refereePhone) parts += `（${e.refereePhone}）`;
        }
        return parts;
      }
      // 家庭成员类（relation/name/age/politics/company/position/phone）
      if (e.relation) {
        let parts = [e.relation, e.name, e.company, e.position].filter(Boolean).join(' ');
        if (e.age) parts += `（${e.age}岁）`;
        if (e.politics) parts += `，政治面貌：${e.politics}`;
        if (e.phone) parts += `，电话：${e.phone}`;
        return parts;
      }
      // 竞赛类（name/level/award/time）— award 字段存在时区分于获奖
      if (e.name && e.award !== undefined) {
        return [e.name, e.level, e.award, e.time].filter(v => v !== null && v !== undefined && v !== '').join(' ');
      }
      // 论文类（title/journal/year）
      if (e.title) {
        return [e.title, e.journal, e.year].filter(Boolean).join('，');
      }
      // 项目/科研类（name/role/time/desc）— 有 role 或 desc 区分于获奖
      if (e.project || (e.name && (e.role || e.desc))) {
        return [(e.project || e.name), e.role].filter(Boolean).join(' ')
          + (e.time ? `（${e.time}）` : '')
          + (e.desc ? `：${e.desc}` : '');
      }
      // 获奖类（name/level/time）— 无 role/desc 的纯获奖
      if (e.name || e.award) {
        const parts = [];
        if (e.name) parts.push(e.name);
        if (e.award) parts.push(e.award);
        if (e.level) parts.push(e.level);
        if (e.time) parts.push(e.time);
        return parts.join(' ');
      }
      // 兜底：拼接所有非空值
      return Object.values(e).filter(v => v !== null && v !== undefined && v !== '').join(' ');
    }).join('\n');
  }

  /* 模型返回 JSON 来源或有原文依据的文本与选项；不执行模型代码。
   * 保存真实节点引用和指纹，防止 API 等待期间 DOM 重排造成错填。 */
  const sessions = globalThis.__jhFillSessions || (globalThis.__jhFillSessions = new Map());
  for (const [token, session] of sessions) {
    if (Date.now() - session.createdAt > 10 * 60 * 1000) sessions.delete(token);
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

  function resolveSource(path) {
    if (typeof path !== 'string' || !/^[a-zA-Z][a-zA-Z0-9]*(?:\.(?:[a-zA-Z][a-zA-Z0-9]*|0|[1-9]\d*))*$/.test(path)) return undefined;
    const parts = path.split('.');
    if (parts.some(part => ['__proto__', 'constructor', 'prototype', 'supplementText'].includes(part))) return undefined;
    let value = profile;
    for (const part of parts) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
      value = value[part];
    }
    return value;
  }

  function transformSource(value, path, transform) {
    if (!transform || transform === 'original') return value;
    if (typeof value !== 'string') return undefined;
    const dates = value.match(/(?<!\d)\d{4}(?:年\d{1,2}月(?:\d{1,2}日)?|([./-])\d{1,2}(?:\1\d{1,2}(?!\d))?)?(?!\d)/g);
    if (!dates?.length) return undefined;
    if (transform === 'year') return dates[0].slice(0, 4);
    if (transform === 'startDate') return dates[0];
    if (transform === 'endDate') return dates.length > 1 ? dates[dates.length - 1] : undefined;
    return undefined;
  }

  if (action === 'cleanup') {
    sessions.delete(opts.snapshotToken);
    return { cleaned: true };
  }

  if (action === 'apply') {
    const session = sessions.get(opts.snapshotToken);
    const result = { filled: 0, filledNone: 0, skipped: 0, stale: 0, invalid: 0, missingData: 0, preserved: 0, linkedProtected: 0, filledFieldIds: [], preservedFieldIds: [] };
    const assignments = Array.isArray(opts.assignments) ? opts.assignments : [];
    if (!session || session.url !== location.href) return { ...result, stale: assignments.length, skipped: assignments.length };
    for (const assignment of assignments) {
      const record = session.entries.get(assignment?.fieldId);
      if (!record || session.used.has(assignment.fieldId)) { result.invalid++; result.skipped++; continue; }
      session.used.add(assignment.fieldId);
      const el = record.el;
      const probe = probeText(el);
      if (!ALLOW_OVERWRITE && el.isConnected && hasExistingValue(el)) {
        result.preserved++; result.skipped++; result.preservedFieldIds.push(assignment.fieldId); continue;
      }
      if (!el.isConnected || !visible(el) || el.matches(':disabled') || el.readOnly
          || record.contextRecords.some(c => !c.el.isConnected || c.scope !== contextScope(c.el)
            || !(session.written.has(c.el) && session.written.get(c.el) === baseline(c.el)) && c.signature !== JSON.stringify(readExistingContext(c.el)))
          || record.signature !== JSON.stringify(describeField(el, probe)) || record.baseline !== baseline(el)) {
        result.stale++; result.skipped++; continue;
      }
      if (hasProtectedDependent(el)) { result.linkedProtected++; result.skipped++; continue; }
      let value = assignment.sourcePath ? resolveSource(assignment.sourcePath) : undefined;
      if (assignment.sourcePath == null && typeof assignment.value === 'string') {
        const text = typeof profile.supplementText === 'string' ? profile.supplementText : '';
        const quote = assignment.evidenceQuote;
        const compact = text => text.replace(/\s+/g, '');
        if (typeof quote !== 'string' || !quote || !text.includes(quote) || !compact(quote).includes(compact(assignment.value))) {
          result.invalid++; result.skipped++; continue;
        }
        value = assignment.value;
      }
      value = transformSource(value, assignment.sourcePath || '', assignment.transform);
      const empty = value == null || Array.isArray(value) && !value.length || String(value).trim() === '';
      const useNone = value !== undefined && empty && FILL_NONE && assignment.fillNone === true && assignment.sourcePath != null;
      if (Array.isArray(value)) value = formatArray(value);
      if (!useNone && (empty || typeof value === 'object')) { result.missingData++; result.skipped++; continue; }
      value = useNone ? '无' : String(value);
      try {
        let success = false;
        if (assignment.optionId != null) {
          const index = record.description.options.findIndex(o => o.optionId === assignment.optionId);
          const option = record.choices[index];
          if (option && !option.disabled) {
            if (el.tagName === 'SELECT') { el.value = option.value; emitChanges(el); success = el.value === option.value; }
            else if (el.type === 'radio') { if (!option.checked) option.click(); success = option.checked; }
          }
        } else if (el.tagName !== 'SELECT' && el.type !== 'radio') success = setVal(el, value);
        if (success) {
          session.written.set(el, baseline(el)); // 允许本任务明确覆盖的值；后续用户改动仍会使上下文失效。
          result.filled++;
          if (useNone) result.filledNone++;
          result.filledFieldIds.push(assignment.fieldId);
        } else { result.invalid++; result.skipped++; }
      } catch (_) { result.invalid++; result.skipped++; }
    }
    if (opts.finish) sessions.delete(opts.snapshotToken);
    return result;
  }

  const collectModel = action === 'scan';
  const snapshotToken = collectModel ? Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('') : null;
  const session = collectModel ? { createdAt: Date.now(), url: location.href, entries: new Map(), used: new Set(), written: new Map() } : null;
  if (session) {
    if (sessions.size >= 5) sessions.delete(sessions.keys().next().value);
    sessions.set(snapshotToken, session);
  }
  const modelFields = [];
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

  for (const [index, el] of els.entries()) {
    const type = (el.type || '').toLowerCase();
    // 文件上传直接跳过
    if (type === 'file') { file++; continue; }
    if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
    if (!visible(el) || el.matches(':disabled')) continue;
    if (seen.has(el)) continue;
    seen.add(el);

    const probe = probeText(el);
    const evidence = probe.sources.map(s => s.text).join(' ');
    if (CAPTCHA_RE.test(evidence)) { captcha++; continue; }
    if (AGREEMENT_RE.test(evidence)) { agreement++; continue; }
    if (el.readOnly || ['password', 'checkbox', 'range', 'color'].includes(type) || el.multiple) {
      unsupported++; skipped++; continue;
    }
    if (!ALLOW_OVERWRITE && hasExistingValue(el)) {
      if (type === 'radio') radioGroup(el).forEach(r => seen.add(r));
      preserved++;
      continue;
    }
    if (hasProtectedDependent(el)) {
      linkedProtected++;
      continue;
    }
    if (type === 'radio') radioGroup(el).forEach(r => seen.add(r));
    queueModel(el, index, probe);
  }

  return { filled, skipped, captcha, file, unsupported, agreement, preserved, linkedProtected,
    modelFields, snapshotToken };

}

if (typeof module !== 'undefined' && module.exports) module.exports = { FILL_FUNCTION };
if (typeof window !== 'undefined') window.FILL_FUNCTION = FILL_FUNCTION;
