/* 职聘通·网申助手 — 填表引擎
 * 自包含、无 chrome 依赖：既可由 popup 通过 chrome.scripting.executeScript 注入页面执行，
 * 也可在 Node + jsdom 环境做单元测试。
 * 注入到页面时，函数体内的 document / window / Event / HTMLInputElement 均指页面上下文。
 *
 * v2.6 变更（画像细节化 + 精准定位优化）：
 * 1. 新增 20+ 条字段规则：国籍/证件类型/出生地/血型/独生子女/班级/学号/学制/学习形式/
 *    院校所在地/学校层次/专业类别/录取批次/第一学历/QQ/博客/LinkedIn/GitHub/家庭电话/
 *    期望行业/期望职能/接受出差/接受外派/科研经历/竞赛经历
 * 2. probeText 新增 title 属性检测、data-label 属性检测、dt/dd 定义列表布局检测
 * 3. setSelect 别名映射大幅扩展：学制/学习形式/学校层次/专业类别/录取批次/国籍/证件/是否类
 * 4. hometown 正则去除 出生地 避免与 birthplace 交叉匹配
 * 5. probeText 短文本兜底阈值优化，减少误配
 * 6. formatArray 新增竞赛经历格式化（name/level/award/time）
 * 7. school 正则 exclude 新增 学校层次/学校类型/学校所在地 避免交叉匹配
 * 8. major 正则 exclude 新增 专业类别/专业方向/专业门类/专业大类 避免交叉匹配
 */
function FILL_FUNCTION(profile, opts) {
  profile = profile && typeof profile === 'object' && !Array.isArray(profile) ? profile : {};
  opts = opts || {};
  const action = opts.action || 'rules';
  const ALLOW_OVERWRITE = opts.allowOverwrite === true;
  const FILL_NONE = !!(opts && opts.fillNoneWhenEmpty);
  const RULES = [
    // ========== 验证码（最优先跳过） ==========
    { key: 'captcha', re: /验证码|captcha|verify|vercode|checkcode|图形码|短信码|校验码|动态码/i, type: 'captcha' },

    // ========== 基本信息 ==========
    { key: 'name',        re: /姓名|真实姓名|fullname|realname|^name$|username/i, exclude: /紧急|联系人|父亲|母亲|家长|推荐人|导师|配偶|监护人|亲属/i, type: 'text' },
    { key: 'gender',      re: /性别|gender|sex/i, type: 'radio' },
    { key: 'nationality', re: /国籍|nationality/i, type: 'text' },
    { key: 'idType',      re: /证件类型|证件种类|身份证件类型|id_?type/i, type: 'select' },
    { key: 'birth',       re: /出生年月|出生日期|出生|生日|birth|birthday/i, exclude: /出生地|出生城市|籍贯/i, type: 'text' },
    { key: 'birthplace', re: /出生地|出生城市|birthplace/i, exclude: /出生日期|出生年月|出生时间/i, type: 'text' },
    { key: 'age',         re: /年龄|^age$/i, type: 'text' },
    { key: 'nation',      re: /民族|nation|ethnic/i, type: 'text' },
    { key: 'politics',    re: /政治面貌|political/i, type: 'select' },
    { key: 'idcard',      re: /身份证|idcard|id_card|identity/i, type: 'text' },
    { key: 'marital',     re: /婚姻|婚否|marital/i, type: 'select' },
    { key: 'onlyChild',   re: /独生子女|是否.*独生|独生/i, type: 'select' },
    { key: 'height',      re: /身高|height/i, type: 'text' },
    { key: 'bloodType',   re: /血型|blood.?(type|group)|abo/i, type: 'select' },
    { key: 'health',      re: /健康|health/i, type: 'select' },

    // ========== 户口类（具体在前，避免被 hometown 吞掉） ==========
    { key: 'hukouLocation', re: /户口所在地|户籍所在地|户口地址|户籍地址|户籍所在|户口所在|户口/i, type: 'text' },
    { key: 'hukouType',     re: /户口性质|户口类型|户别/i, type: 'select' },
    { key: 'hometown',      re: /籍贯|生源地|native|domicile/i, exclude: /户口|出生地|出生城市/i, type: 'text' },

    // ========== 教育背景 ==========
    { key: 'school',         re: /毕业院校|就读院校|院校名称|学校名称|学校|院校|大学|school|university|college|academy/i, exclude: /高中|中学|小学|中专|技校|学校地址|学校代码|学校性质|学校邮编|学校电话|school.?email|学校所在地|院校所在地|学校层次|学校类型|院校层次|院校类型|院校性质|学校级别/i, type: 'text' },
    { key: 'department',     re: /院系|学院|所在学院|二级学院|所属院系|department|faculty/i, exclude: /学院名称.*学校|学校.*学院名称|独立学院/i, type: 'text' },
    { key: 'major',          re: /专业|major|specialty/i, exclude: /第二专业|辅修|双学位|专业类别|专业方向|专业门类|专业大类|学科门类/i, type: 'text' },
    { key: 'majorCategory',  re: /专业类别|学科门类|专业门类|专业大类/i, exclude: /专业名称|专业方向/i, type: 'select' },
    { key: 'secondMajor',    re: /第二专业|辅修|双学位|第二学位/i, type: 'text' },
    { key: 'class',          re: /班级|行政班/i, exclude: /类别|分类/i, type: 'text' },
    { key: 'studentId',      re: /学号|学籍号|student.?(id|no)/i, type: 'text' },
    { key: 'degree',         re: /学历|学位|degree|education/i, exclude: /院校|学校|入学|第一学历|第一学位|学历类型/i, type: 'select' },
    { key: 'isFirstDegree',  re: /第一学历|是否.*第一学历|第一学位/i, type: 'select' },
    { key: 'schoolLevel',    re: /学校层次|院校层次|学校类型|院校类型|学校性质|院校性质|学校级别/i, exclude: /学校名称|院校名称|学校地址|学校邮编|学校所在地|学校电话/i, type: 'select' },
    { key: 'schoolLocation', re: /院校所在地|学校所在地|院校地点|学校地点|学校所在/i, exclude: /学校名称|院校名称|学校地址/i, type: 'text' },
    { key: 'eduDuration',    re: /学制|修业年限/i, exclude: /全日制|非全日制|学习形式/i, type: 'select' },
    { key: 'eduMode',        re: /学习形式|就读方式|就读类型|学习方式/i, exclude: /培养方式|培养类型|学制/i, type: 'select' },
    { key: 'admissionBatch', re: /录取批次|高考批次|招生批次/i, type: 'select' },
    { key: 'schoolStart',    re: /入学时间|入学|就读时间|在校开始|开始时间/i, type: 'text' },
    { key: 'gradTime',       re: /毕业时间|毕业日期|预计毕业|毕业年月/i, type: 'text' },
    { key: 'gradYear',       re: /毕业(?!时间|日期|院校|学校)(年份|年度|届)?|graduat/i, type: 'text' },
    { key: 'rank',           re: /排名|绩点|gpa|学业成绩/i, type: 'text' },
    { key: 'tutor',          re: /导师|指导教师/i, type: 'text' },
    { key: 'thesis',         re: /论文题目|毕业论文|学位论文|论文标题/i, type: 'text' },
    { key: 'eduType',        re: /培养方式|培养类型|统招|非定向|定向|委培/i, type: 'select' },

    // ========== 联系方式 ==========
    { key: 'phone',            re: /手机|电话|联系方式|mobile|phone|tel/i, exclude: /紧急|家庭|座机|固话|办公|宅电|监护人|亲属/i, type: 'text' },
    { key: 'homePhone',        re: /家庭电话|住宅电话|座机|固话|家庭固话|home.?(phone|tel)/i, type: 'text' },
    { key: 'email',            re: /邮箱|邮件|email|e-mail|mail/i, exclude: /紧急|学校/i, type: 'text' },
    { key: 'wechat',           re: /微信|wechat|weixin/i, type: 'text' },
    { key: 'qq',               re: /qq号|qq号码|腾讯qq|^qq$/i, type: 'text' },
    { key: 'blog',             re: /博客|个人主页|个人网站|主页地址|blog|homepage|个人空间/i, exclude: /学校|公司/i, type: 'text' },
    { key: 'linkedin',         re: /linkedin|领英/i, type: 'text' },
    { key: 'github',           re: /github|git仓库/i, type: 'text' },
    { key: 'province',         re: /省份|province|^省$/i, type: 'select' },
    { key: 'city',             re: /现居|现居地|所在地|居住地|常居|\bcity\b/i, exclude: /期望|意向|工作城市|工作地点/i, type: 'text' },
    { key: 'address',          re: /通讯地址|联系地址|通信地址|住址|现住址|常驻地址|地址|address/i, exclude: /户口|户籍|家庭|公司|学校|宿舍/i, type: 'text' },
    { key: 'postcode',         re: /邮编|邮政编码|zip|postcode/i, type: 'text' },
    { key: 'emergencyContact', re: /紧急联系人|紧急.*姓名|联系人姓名/i, type: 'text' },
    { key: 'emergencyPhone',   re: /紧急.*电话|紧急.*联系方式|紧急联系/i, type: 'text' },
    { key: 'emergencyRelation',re: /紧急.*关系|联系人关系|与.*关系/i, type: 'text' },

    // ========== 求职意向 ==========
    { key: 'target',         re: /求职意向|期望职位|意向岗位|应聘岗位|应聘职位|目标岗位|target|intend/i, type: 'text' },
    { key: 'preferCity',     re: /期望城市|意向城市|工作城市|期望工作地|期望地点|意向地点|期望工作城市|工作地点|工作地/i, type: 'text' },
    { key: 'preferIndustry', re: /期望行业|意向行业|目标行业|行业意向|prefer.?industry/i, type: 'text' },
    { key: 'preferFunction', re: /期望职能|意向职能|目标职能|职能意向|prefer.?function/i, exclude: /期望职位|意向岗位|应聘岗位/i, type: 'text' },
    { key: 'jobType',        re: /求职类型|应聘类型|工作性质|工作类型|全职.*实习/i, type: 'select' },
    { key: 'expSalary',      re: /期望(月)?薪|薪资要求|期望薪酬|月薪要求|salary/i, type: 'text' },
    { key: 'expAnnual',      re: /期望年薪|年薪要求|年薪/i, type: 'text' },
    { key: 'acceptAdjust',   re: /调剂|服从(分配|安排)|接受调配|服从调剂/i, type: 'select' },
    { key: 'acceptTravel',   re: /接受出差|是否出差|出差.*接受|能否出差|能否.*出差/i, type: 'select' },
    { key: 'acceptRelocate', re: /接受外派|能否外派|外派.*接受|接受调岗|能否调岗|接受.*异地|服从.*调配/i, type: 'select' },
    { key: 'availableTime',  re: /到岗时间|入职时间|可到岗|最快到岗|可入职|能到岗/i, type: 'text' },
    { key: 'internDuration', re: /实习时长|实习期|实习期限/i, type: 'text' },
    { key: 'internDays',     re: /每周.*天|实习天数|每周实习/i, type: 'text' },
    { key: 'channel',        re: /获知渠道|信息来源|了解.*渠道|招聘.*渠道|source/i, type: 'select' },

    // ========== 语言能力（fillNone: 无证书时填「无」） ==========
    { key: 'english',       re: /英语(水平|等级|能力|成绩)?|cet|ielts|toefl|四六级/i, exclude: /其他外语|第二外语|小语种/i, type: 'text', fillNone: true },
    { key: 'otherLang',     re: /其他外语|第二外语|小语种|其他语言/i, type: 'text', fillNone: true },
    { key: 'computerLevel', re: /计算机(水平|等级|能力|证书)|电脑水平/i, type: 'text', fillNone: true },
    { key: 'mandarin',      re: /普通话|mandarin/i, type: 'text', fillNone: true },

    // ========== 经历（fillNone: 没有相关经历时填「无」） ==========
    { key: 'experiences',  re: /实习经历|工作经历|实践经历|社会实践|实习经验|工作经验|工作.*经历|实习.*描述|experience/i, exclude: /校园|学生|志愿|项目|社区|科研|竞赛/i, type: 'textarea', fillNone: true },
    { key: 'research',      re: /科研经历|科研.*经验|研究经历|科研项目/i, exclude: /实习|工作|项目经历|项目经验/i, type: 'textarea', fillNone: true },
    { key: 'competitions',  re: /竞赛经历|比赛经历|参赛经历|竞赛.*经验/i, exclude: /获奖|奖项|荣誉/i, type: 'textarea', fillNone: true },
    { key: 'campus',       re: /校园经历|学生工作|社团经历|校园活动|学生干部|在校经历|学生.*经历/i, type: 'textarea', fillNone: true },
    { key: 'awards',      re: /获奖|奖项|荣誉|获奖经历|prize|award/i, type: 'textarea', fillNone: true },
    { key: 'projects',    re: /项目经历|项目经验|项目描述|project/i, exclude: /科研/i, type: 'textarea', fillNone: true },
    { key: 'papers',      re: /论文|著作|发表|publication/i, exclude: /题目|毕业论文|学位论文/i, type: 'textarea', fillNone: true },
    { key: 'volunteer',   re: /志愿|义工|公益|社区服务|社会实践服务/i, type: 'textarea', fillNone: true },

    // ========== 其他（fillNone: 无内容时填「无」） ==========
    { key: 'certs',     re: /证书|资格证|职业资格|certificate|license|资格/i, type: 'text', fillNone: true },
    { key: 'skills',    re: /技能|特长|专长|skills|skill/i, exclude: /兴趣|爱好/i, type: 'text', fillNone: true },
    { key: 'strengths', re: /擅长|优势|优势领域|核心竞争力|个人优势/i, type: 'text', fillNone: true },
    { key: 'selfIntro', re: /自我介绍|自我评价|个人简介|个人陈述|个人简历|简历正文|自我描述|introduction|summary/i, type: 'textarea', fillNone: true },
    { key: 'family',    re: /家庭信息|家庭情况|家庭成员|父母情况|家庭关系/i, type: 'textarea', fillNone: true },
    { key: 'hobbies',   re: /兴趣|爱好|hobby|hobbies/i, type: 'text', fillNone: true },

    // ========== 勾选类 ==========
    { key: 'agree', re: /同意|授权|条款|协议|确认填写|声明|承诺|已阅读/i, type: 'checkbox' },
  ];

  /* 标签优先于技术属性；同一来源中比较具体程度，保留有歧义的候选。
   * 分数只用于规则排序，不是统计置信度，也不依赖画像是否有值。 */
  function matchRule(probe) {
    const evidence = probe.sources.map(s => s.text).join(' ');
    if (RULES[0].re.test(evidence)) return { rule: RULES[0] };
    for (const source of probe.sources) {
      const text = norm(source.text);
      const custom = (Array.isArray(profile.extraInfo) ? profile.extraInfo : []).map((item, index) => ({ item, index }))
        .filter(({ item }) => typeof item?.label === 'string' && norm(item.label) === text);
      if (custom.length && /家庭|父亲|母亲|配偶|亲属|监护人/.test(probe.section) && /^(姓名|年龄|电话|手机号|政治面貌)$/.test(text)) return { ambiguous: true, candidates: custom.map(c => `extraInfo.${c.index}.value`) };
      if (custom.length === 1) return { rule: { key: `extraInfo.${custom[0].index}.value`, type: 'text' } };
      if (custom.length > 1) return { ambiguous: true, candidates: custom.map(c => `extraInfo.${c.index}.value`) };
      const candidates = RULES.filter(r => r.type !== 'captcha').flatMap(rule => {
        if (rule.exclude && rule.exclude.test(text)) return [];
        const semanticText = source.technical ? text : norm(text.replace(/[（(][^）)]*[）)]/g, ''));
        const match = semanticText.match(rule.re);
        const exactKey = source.technical && text.toLowerCase() === rule.key.toLowerCase();
        if (!match && !exactKey) return [];
        const matched = match ? norm(match[0]) : '';
        const score = exactKey ? 1000 : matched.length + (matched === semanticText ? 100 : 0);
        return [{ rule, score, matched }];
      }).sort((a, b) => b.score - a.score);
      if (!candidates.length) continue;
      const best = candidates.filter(c => c.score === candidates[0].score);
      const independent = candidates.some(c => c !== best[0] && !best[0].matched.includes(c.matched));
      if (best.length > 1 || candidates[0].score < 100 && independent
          || /^(开始时间|结束时间|起始时间|姓名|年龄|政治面貌|电话|手机号码)$/.test(text)
          && /家庭|父亲|母亲|配偶|亲属|监护人/.test(probe.section)) {
        return { rule: null, candidates: candidates.map(c => c.rule.key), ambiguous: true };
      }
      if (/^(开始时间|结束时间|起始时间)$/.test(text)) {
        return { rule: null, candidates: best.map(c => c.rule.key), ambiguous: true };
      }
      return { rule: best[0].rule };
    }
    return { rule: null, candidates: [] };
  }

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

  function setSelect(el, val, noneFallback) {
    const opts = Array.from(el.options || []).filter(o => !o.disabled && !o.parentElement?.disabled && !isPlaceholderOption(o));
    const normalize = value => norm(value).toLowerCase();
    const unique = options => options.length === 1 ? options[0] : null;
    // 空选项和“接受/不接受”等包含关系不再参与模糊匹配。
    const exact = opts.filter(o => normalize(o.text) === normalize(val));
    const exactValues = opts.filter(o => normalize(o.value) === normalize(val));
    let m = unique(exact.length ? exact : exactValues);
    if (exact.length > 1 || !exact.length && exactValues.length > 1) return false;
    // v2.6 增强：学历/政治面貌/民族/学制/学习形式/学校层次/专业类别/录取批次等常见别名映射
    if (!m) {
      const ALIAS = {
        // 学历
        '本科': ['大学本科', '学士', '本科学历', '本科及以上', '大学本科及以上'],
        '硕士': ['硕士研究生', '硕士研究生及以上', '研究生', '硕士学历', '硕士学位'],
        '博士': ['博士研究生', '博士研究生及以上', '博士学历', '博士学位'],
        '大专': ['专科', '高职', '专科学历', '高职高专'],
        // 政治面貌
        '中共党员': ['党员', '共产党员', '正式党员', '中共正式党员'],
        '中共预备党员': ['预备党员', '中共预备'],
        '共青团员': ['团员', '共青团团员'],
        // 民族
        '汉族': ['汉', '汉族'],
        // 婚姻
        '未婚': ['单身', '未婚未育'],
        '已婚': ['已婚已育', '已婚已孕', '已婚有子女'],
        // 培养方式
        '统招': ['全日制', '全日制统招', '全国统招'],
        // 户口
        '农业': ['农村', '农业户口', '农村户口'],
        '非农业': ['城镇', '城市', '非农业户口', '城镇户口'],
        '居民户口': ['居民', '居民家庭户'],
        // 学制
        '四年': ['4年', '四年制', '4年制'],
        '三年': ['3年', '三年制', '3年制'],
        '两年': ['2年', '两年制', '2年制'],
        '五年': ['5年', '五年制', '5年制'],
        // 学习形式
        '全日制': ['全日制统招', '脱产', '在校', 'full-time'],
        '非全日制': ['非脱产', '在职', '业余', '函授', '夜大', '网络教育', '远程教育', 'part-time', '成人'],
        // 学校层次
        '985': ['985工程', '985院校', '985高校', '985大学'],
        '211': ['211工程', '211院校', '211高校', '211大学'],
        '双一流': ['双一流大学', '双一流高校', '一流大学', '一流学科', '双一流建设高校'],
        '普通本科': ['一般本科', '普通高等院校', '公办本科'],
        '独立学院': ['独立院校', '民独'],
        '民办': ['民办高校', '民办大学', '民办院校', '私立'],
        '高职高专': ['职业技术学院', '高等职业'],
        // 专业类别（学科门类）
        '工学': ['工科', '工学门类', '工科类'],
        '理学': ['理科', '理学门类', '理科类'],
        '文学': ['文科', '文学门类', '文科类'],
        '管理学': ['管理', '管理学门类', '管理类'],
        '经济学': ['经济', '经济学门类', '经济类'],
        '法学': ['法律', '法学门类', '法律类'],
        '教育学': ['教育', '教育学门类', '教育类'],
        '艺术学': ['艺术', '艺术学门类', '艺术类'],
        '医学': ['医科', '医学门类', '医科类'],
        '农学': ['农业科学', '农学门类', '农科类'],
        '军事学': ['军事', '军事学门类', '军事类'],
        '哲学': ['哲', '哲学门类', '哲学类'],
        '历史学': ['历史', '历史学门类', '历史类'],
        // 录取批次
        '一本': ['本科一批', '重点本科', '第一批次', '一本线', '第一批次本科'],
        '二本': ['本科二批', '普通本科', '第二批次', '二本线'],
        '三本': ['本科三批', '第三批次', '三本线'],
        '提前批': ['提前批次', '本科提前批', '提前录取'],
        '专科批': ['专科批次', '高职高专批', '专科提前批'],
        // 国籍/证件
        '中国': ['中华人民共和国', '中国大陆', '中国国籍'],
        '身份证': ['居民身份证', '中华人民共和国居民身份证', '二代身份证'],
        '护照': ['中国护照', '因私护照'],
        // 是否类
        '是': ['true', 'yes', 'Y', '同意', '愿意', '可以'],
        '否': ['false', 'no', 'N', '不同意', '不愿意', '不可以'],
        '接受': ['同意', '愿意', '可以', '是'],
        '不接受': ['拒绝', '不同意', '不愿意', '不可以', '否'],
      };
      const aliases = new Set(Object.entries(ALIAS).flatMap(([key, values]) =>
        [key, ...values].some(v => normalize(v) === normalize(val)) ? [key, ...values].map(normalize) : []));
      m = unique(opts.filter(o => aliases.has(normalize(o.text)) || aliases.has(normalize(o.value))));
    }
    // 匹配失败且允许兜底：尝试选页面的「无/暂无/不涉及」类选项
    if (!m && noneFallback) {
      m = unique(opts.filter(o => /^(无|暂无|没有|不涉及|未参加|无相关|以上都不是|否)$/.test(o.text.trim())));
    }
    if (m) { el.value = m.value; emitChanges(el); return el.value === m.value; }
    return false;
  }

  function radioGroup(el) {
    const group = el.name ? el.getRootNode().querySelectorAll('input[type="radio"]') : [el];
    return Array.from(group).filter(r => r.type === 'radio' && r.name === el.name && r.form === el.form);
  }

  function setRadio(el, val) {
    const aliases = {
      '男': ['男', 'male', 'm', '先生'], '女': ['女', 'female', 'f', '女士'],
      '是': ['是', 'yes', 'true', 'y'], '否': ['否', 'no', 'false', 'n'],
      '接受': ['接受', '同意', '愿意', '是', 'yes', 'true'],
      '不接受': ['不接受', '不同意', '不愿意', '否', 'no', 'false'],
    };
    const values = (aliases[val] || [val]).map(v => norm(v).toLowerCase());
    const targets = radioGroup(el).filter(r => {
      if (r.disabled || !visible(r)) return false;
      const lab = r.closest('label') || (r.id ? document.querySelector('label[for="' + CSS.escape(r.id) + '"]') : null);
      let t = '';
      if (lab) {
        t = labelText(lab);
      }
      if (!t) {
        const parent = r.parentElement;
        if (parent) t = labelText(parent);
      }
      return values.includes(norm(t).toLowerCase()) || values.includes(norm(r.value).toLowerCase());
    });
    if (targets.length === 1) {
      const target = targets[0];
      if (!target.checked) target.click();
      return target.checked;
    }
    return false;
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

  /* 模型只返回画像来源与选项，实际文本从本地画像取出；不执行模型代码。
   * 保存真实节点引用和指纹，防止 API 等待期间 DOM 重排造成错填。 */
  const sourceKeys = [...RULES.filter(r => !['captcha', 'checkbox'].includes(r.type)).map(r => r.key), 'extraInfo'];
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
    if (RULES[0].re.test(evidence) || RULES.find(r => r.key === 'agree').re.test(evidence)
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
    if (!sourceKeys.includes(parts[0])) return undefined;
    let value = profile;
    for (const part of parts) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
      value = value[part];
    }
    return value;
  }

  function transformSource(value, path, transform) {
    if (!transform || transform === 'original') return value;
    if (!/^(birth|schoolStart|gradTime|gradYear|availableTime)$|\.time$/.test(path) || typeof value !== 'string') return undefined;
    const dates = value.match(/\d{4}(?:年\d{1,2}月(?:\d{1,2}日)?|([./-])\d{1,2}(?:\1\d{1,2}(?!\d))?)?(?!\d)/g);
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
      let value = resolveSource(assignment.sourcePath);
      value = transformSource(value, assignment.sourcePath || '', assignment.transform);
      if (Array.isArray(value)) value = formatArray(value);
      const empty = value === undefined || value === null || String(value).trim() === '';
      const rule = RULES.find(r => r.key === assignment.sourcePath);
      const useNone = empty && FILL_NONE && rule?.fillNone && el.type !== 'radio';
      if (!useNone && (empty || typeof value === 'object')) { result.missingData++; result.skipped++; continue; }
      value = useNone ? '无' : String(value);
      try {
        let success = false;
        if (assignment.optionId != null) {
          const index = record.description.options.findIndex(o => o.optionId === assignment.optionId);
          const option = record.choices[index];
          if (option && !option.disabled && (!useNone || /^(无|暂无|没有|不涉及|未参加|无相关|以上都不是|否)$/.test(record.description.options[index].text))) {
            if (el.tagName === 'SELECT') { el.value = option.value; emitChanges(el); success = el.value === option.value; }
            else if (el.type === 'radio') { if (!option.checked) option.click(); success = option.checked; }
          }
        } else if (el.tagName === 'SELECT') success = setSelect(el, value, useNone);
        else if (el.type === 'radio') success = setRadio(el, value);
        else success = setVal(el, value);
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

  const collectModel = action === 'hybrid' || action === 'scan';
  const snapshotToken = collectModel ? Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('') : null;
  const session = collectModel ? { createdAt: Date.now(), url: location.href, entries: new Map(), used: new Set(), written: new Map() } : null;
  if (session) {
    if (sessions.size >= 5) sessions.delete(sessions.keys().next().value);
    sessions.set(snapshotToken, session);
  }
  const modelFields = [];
  const els = Array.from(document.querySelectorAll('input,select,textarea'));
  // 一次性读取点击时已有的值，规则本次新写入的内容不能作为后续判断依据。
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
  function queueModel(el, index, probe, reason, candidates) {
    if (!session) return;
    const description = describeField(el, probe);
    const fieldId = `field-${index}`;
    const nearby = relatedContext(el, index);
    const choices = el.type === 'radio' ? radioGroup(el).filter(r => visible(r) && !r.matches(':disabled'))
      : el.tagName === 'SELECT' ? Array.from(el.options).filter(o => !o.disabled && !o.parentElement?.disabled && !isPlaceholderOption(o)) : [];
    session.entries.set(fieldId, { el, choices, description, signature: JSON.stringify(description), baseline: baseline(el), contextRecords: nearby });
    modelFields.push({ fieldId, ...description, reason, candidates: candidates || [], existingContext: nearby.map(c => c.description) });
  }

  let filled = 0, skipped = 0, unmatched = 0, captcha = 0, file = 0, filledNone = 0;
  let ambiguous = 0, missingData = 0, invalid = 0, unsupported = 0, agreement = 0;
  let preserved = 0, linkedProtected = 0;
  const unmatchedLabels = [];
  const pendingFields = [];
  const seen = new Set();

  function deferField(el, index, probe, reason, candidates) {
    queueModel(el, index, probe, reason, candidates);
    if (unmatchedLabels.length < 8) unmatchedLabels.push(probe.label.slice(0, 40) || '未命名字段');
    // 为字段映射提供描述，不包含画像或控件的当前输入值。
    // fieldId 仅在本次 DOM 快照内有效，后续执行需要重新验证控件。
    if (pendingFields.length < 80) pendingFields.push({
      fieldId: `field-${index}`, label: probe.label.slice(0, 120), section: probe.section,
      controlType: el.tagName === 'INPUT' ? el.type : el.tagName.toLowerCase(),
      options: el.tagName === 'SELECT' ? Array.from(el.options).filter(o => !o.disabled && !o.parentElement?.disabled && o.value !== '').slice(0, 40).map(o => norm(o.text).slice(0, 120)) : [],
      reason, candidates: candidates || [],
    });
  }

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
    if (RULES[0].re.test(evidence)) { captcha++; continue; }
    if (RULES.find(r => r.key === 'agree').re.test(evidence)) { agreement++; continue; }
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
      if (unmatchedLabels.length < 8) unmatchedLabels.push(probe.label || '地区联动字段');
      continue;
    }
    if (action === 'scan') {
      if (type === 'radio') radioGroup(el).forEach(r => seen.add(r));
      queueModel(el, index, probe, 'model_only', []);
      continue;
    }
    if (collectModel && relatedContext(el, index).length) {
      if (type === 'radio') radioGroup(el).forEach(r => seen.add(r));
      deferField(el, index, probe, 'existing_context', []);
      continue; // 已填的关系/姓名/单位可能改变空白字段归属，让模型先参考上下文。
    }
    // 先完成整组识别，再处理单选框，避免每个选项被重复计数。
    let match = matchRule(probe);
    if (type === 'radio') {
      const group = radioGroup(el);
      group.forEach(r => seen.add(r));
      const matches = group.filter(r => visible(r) && !r.disabled).map(r => matchRule(probeText(r)));
      const rules = [...new Map(matches.filter(m => m.rule).map(m => [m.rule.key, m.rule])).values()];
      if (rules.some(r => r.type === 'captcha')) match = { rule: RULES[0] };
      else if (rules.length > 1 || matches.some(m => m.ambiguous)) match = { ambiguous: true, candidates: rules.map(r => r.key) };
      else if (rules.length === 1) match = { rule: rules[0] };
    }
    const rule = match.rule;
    if (!rule) {
      if (match.ambiguous) ambiguous++; else unmatched++;
      deferField(el, index, probe, match.ambiguous ? 'ambiguous' : 'unmatched', match.candidates);
      continue;
    }
    if (rule.type === 'captcha') { captcha++; continue; }
    if (rule.type === 'checkbox') {
      agreement++; continue; // 与使用说明一致，条款由用户手动确认。
    }

    let val = resolveSource(rule.key);
    if (Array.isArray(val)) {
      val = formatArray(val);
    }
    const isEmpty = val === undefined || val === null || String(val).trim() === '' || val === '请填写手机号';
    let useNone = false;

    if (isEmpty) {
      if (FILL_NONE && rule.fillNone) {
        if (type === 'radio') { missingData++; skipped++; continue; }
        val = '无';
        useNone = true;
      } else {
        missingData++; skipped++;
        queueModel(el, index, probe, 'missing_data', [rule.key]);
        continue;
      }
    }
    val = String(val);

    try {
      let success;
      // 字段规则判断含义，控件的实际类型决定写入方式。
      if (type === 'radio') {
        success = setRadio(el, val);
      } else if (el.tagName === 'SELECT') {
        success = setSelect(el, val, useNone);
      } else {
        success = setVal(el, val);
      }
      if (success) {
        filled++;
        if (useNone) filledNone++;
      } else {
        invalid++; skipped++;
        queueModel(el, index, probe, 'format_or_option', [rule.key]);
      }
    } catch (_) { invalid++; skipped++; queueModel(el, index, probe, 'format_or_option', [rule.key]); }
  }

  return { filled, skipped, unmatched, captcha, file, filledNone, unmatchedLabels,
    ambiguous, missingData, invalid, unsupported, agreement, preserved, linkedProtected, pendingFields,
    modelFields, snapshotToken, sourceKeys, noneKeys: RULES.filter(r => r.fillNone).map(r => r.key) };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { FILL_FUNCTION, RULES: null };
if (typeof window !== 'undefined') window.FILL_FUNCTION = FILL_FUNCTION;
