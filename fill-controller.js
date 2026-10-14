/* 单一模型填写路径 + 有界修复轮；浏览器 API 由后台注入。
 * 第一轮：扫描 → 模型 → 写入。第二轮（最多一次）：只把可修复的失败字段连同失败原因重问，禁止无差别重试。 */
(function (root) {
  // 携带增量信息才有意义的重试：格式、选项、文本依据、结构类问题。
  const RETRYABLE = new Set(['no_value', 'evidence_mismatch', 'bad_option', 'no_option', 'date_format', 'too_long', 'constraint', 'bad_transform', 'model_error', 'invalid', 'request_failed']);
  const MAX_ROUNDS = 2;
  const MANUAL_TEXT = { file: '上传文件', captcha: '验证码', agreement: '条款/授权勾选', unsupported: '复选框或只读控件', linked: '地区联动选择' };
  const REASON_TEXT = {
    no_value: '资料中没有找到对应内容',
    evidence_mismatch: '模型给出的内容与资料原文对不上',
    bad_option: '没有匹配的选项',
    no_option: '没有找到对应的选项',
    date_format: '日期格式不符合该字段要求',
    too_long: '资料内容超过输入长度限制',
    constraint: '不符合输入框的格式要求',
    bad_fillnone: '资料没有说明该项不存在，未填「无」',
    bad_transform: '日期转换不适用该字段',
    unsettable: '该控件不接受自动填写',
    reverted: '填写后被页面还原',
    stale: '页面内容已变化，需重新填写',
    linked: '地区联动字段，需手动选择',
    record: '字段已失效',
    model_error: '模型返回的内容无法使用',
    request_failed: '模型回答不完整',
    error: '填写时页面报错',
  };

  function chunks(list, size) {
    const out = [];
    for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size));
    return out;
  }

  function buildFeedback(field, issue) {
    const feedback = {
      fieldId: field.fieldId,
      label: field.label || '',
      code: issue?.code || 'no_value',
      reason: issue?.detail || REASON_TEXT[issue?.code] || '上一轮未填写成功',
      previousValue: issue?.value ? String(issue.value).slice(0, 200) : null,
      constraints: {
        controlType: field.controlType || 'text',
        required: !!field.required,
        maxLength: field.maxLength ?? null,
        min: field.min || '', max: field.max || '', step: field.step || '', pattern: field.pattern || '',
      },
    };
    if (field.controlType === 'select' || field.controlType === 'radio') feedback.options = (field.options || []).slice(0, 300);
    return feedback;
  }

  async function runFillJob({ userText, settings, fillNoneWhenEmpty, allowOverwrite = false, execute, requestModel, onProgress = async () => {}, client = root.DeepSeekClient }) {
    const result = { filled: 0, modelFilled: 0, filledNone: 0, unresolved: 0, retried: 0, repaired: 0, stale: 0, captcha: 0, file: 0, agreement: 0, unsupported: 0, preserved: 0, linkedProtected: 0, contextFields: 0, issues: [], notes: [], manual: [], pendingLabels: [] };
    let snapshotToken;
    let scan;
    try {
      client.validateSettings(settings);
      const text = client.prepareText(userText);
      if (!text) throw new Error('用户资料为空，请先保存资料文本');
      await onProgress('正在提取网页字段与已有信息…', result);
      scan = await execute(text, { action: 'scan', fillNoneWhenEmpty, allowOverwrite });
      snapshotToken = scan.snapshotToken;
      for (const key of ['captcha', 'file', 'agreement', 'unsupported', 'preserved', 'linkedProtected']) result[key] = scan[key] || 0;
      result.manual = (scan.skippedFields || []).map(item => ({ label: item.label, reason: MANUAL_TEXT[item.code] || '需手动处理' })).slice(0, 12);
      const fields = scan.modelFields || [];
      const fieldById = new Map(fields.map(field => [field.fieldId, field]));
      result.contextFields = fields.filter(field => field.existingContext?.length).length;
      result.unresolved = fields.length;
      result.pendingLabels = fields.slice(0, 8).map(field => field.label || '未命名字段');
      if (!fields.length) return result;
      if (fields.length > 300) throw new Error('当前页面超过 300 个待识别字段，请分步展开表单后填写');
      client.validateSettings(settings);

      const unresolved = new Set(fields.map(field => field.fieldId));
      const issues = new Map();
      const noteList = new Set();
      const recordRejections = (rejected, batch) => {
        const known = new Set(batch.map(field => field.fieldId));
        for (const item of rejected || []) {
          if (known.has(item.fieldId) && !issues.has(item.fieldId)) issues.set(item.fieldId, { code: item.code || 'invalid', detail: item.detail || REASON_TEXT.invalid, value: item.value });
          if (item.note) noteList.add(item.note);
        }
      };
      const applyBatch = async assignments => {
        const applied = await execute(text, { action: 'apply', snapshotToken, assignments, fillNoneWhenEmpty, allowOverwrite });
        for (const outcome of applied.outcomes || []) {
          if (outcome.status === 'filled') {
            unresolved.delete(outcome.fieldId);
            issues.delete(outcome.fieldId);
            result.modelFilled++;
            result.filled = result.modelFilled;
            if (outcome.fillNone) result.filledNone++;
          } else if (outcome.status === 'preserved') {
            result.preserved++;
            unresolved.delete(outcome.fieldId);
          } else {
            if (outcome.code === 'stale') result.stale++;
            if (outcome.code === 'linked') result.linkedProtected++;
            issues.set(outcome.fieldId, { code: outcome.code || 'invalid', detail: outcome.detail || REASON_TEXT.invalid, value: outcome.value });
          }
        }
        return applied;
      };

      for (let round = 1; round <= MAX_ROUNDS; round++) {
        if (round > 1) {
          for (const fieldId of unresolved) if (!issues.has(fieldId)) issues.set(fieldId, { code: 'no_value', detail: '模型未返回该字段' });
        }
        const targets = round === 1 ? fields
          : fields.filter(field => unresolved.has(field.fieldId) && RETRYABLE.has(issues.get(field.fieldId)?.code));
        if (!targets.length) break;
        const batches = chunks(targets, client.BATCH_SIZE);
        if (round > 1) {
          result.retried = targets.length;
          await onProgress(`正在按失败原因修正 ${targets.length} 个字段…`, result);
        }
        for (const [index, batch] of batches.entries()) {
          if (round === 1) await onProgress(`DeepSeek 正在判断字段（${index + 1}/${batches.length}）…`, result);
          let reply;
          try {
            reply = await requestModel({ fields: batch, text, settings, fillNoneWhenEmpty, feedback: round > 1 ? batch.map(field => buildFeedback(field, issues.get(field.fieldId))) : null });
          } catch (error) {
            // 内容类问题只影响本批；鉴权、网络、超时等问题仍然终止任务。
            if (error?.fatal !== false) throw error;
            for (const field of batch) issues.set(field.fieldId, { code: 'request_failed', detail: error.message || REASON_TEXT.request_failed });
            continue;
          }
          recordRejections(reply.rejected, batch);
          await onProgress('正在填写模型识别的字段…', result);
          const before = result.modelFilled;
          await applyBatch(reply.assignments || []);
          if (round > 1) result.repaired += result.modelFilled - before;
        }
      }

      result.unresolved = unresolved.size;
      result.issues = [...unresolved].slice(0, 12).map(fieldId => {
        const issue = issues.get(fieldId);
        const reason = REASON_TEXT[issue?.code] || REASON_TEXT.invalid;
        const detail = issue?.detail && issue.detail.length <= 40 ? `（${issue.detail}）` : '';
        return { label: fieldById.get(fieldId)?.label || '未命名字段', code: issue?.code || 'unknown', reason: reason + detail };
      });
      result.pendingLabels = result.issues.slice(0, 8).map(item => item.label);
      result.notes = [...noteList].slice(0, 5);
      return result;
    } catch (error) {
      // API 失败、页面变化时保留已完成的模型填写，并展示部分结果。
      return { ...result, error: error.message || '填写失败' };
    } finally {
      if (snapshotToken) {
        try { await execute({}, { action: 'cleanup', snapshotToken }); } catch (_) { /* 页面已导航时快照随文档销毁 */ }
      }
    }
  }
  root.FillController = { runFillJob, RETRYABLE };
  if (typeof module !== 'undefined' && module.exports) module.exports = { runFillJob, RETRYABLE };
})(globalThis);
