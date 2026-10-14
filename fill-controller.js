/* 可独立测试的两条填写路径；浏览器 API 由后台注入。 */
(function (root) {
  async function runFillJob({ mode, profile, settings, fillNoneWhenEmpty, allowOverwrite = false, execute, requestModel, onProgress = async () => {}, client = root.DeepSeekClient }) {
    if (!['hybrid', 'model'].includes(mode)) throw new Error('未知填写模式');
    const result = { filled: 0, ruleFilled: 0, modelFilled: 0, filledNone: 0, unresolved: 0, stale: 0, captcha: 0, file: 0, agreement: 0, unsupported: 0, preserved: 0, linkedProtected: 0, pendingLabels: [] };
    let snapshotToken;
    let scan;
    const filledIds = new Set();
    try {
      if (mode === 'model') client.validateSettings(settings);
      await onProgress(mode === 'hybrid' ? '正在用规则及页面已有信息识别字段…' : '正在提取网页字段与已有信息…', result);
      scan = await execute(profile, { action: mode === 'hybrid' ? 'hybrid' : 'scan', fillNoneWhenEmpty, allowOverwrite });
      snapshotToken = scan.snapshotToken;
      result.ruleFilled = scan.filled || 0;
      result.filled = result.ruleFilled;
      result.filledNone = scan.filledNone || 0;
      for (const key of ['captcha', 'file', 'agreement', 'unsupported', 'preserved', 'linkedProtected']) result[key] = scan[key] || 0;
      const fields = scan.modelFields || [];
      result.contextFields = fields.filter(f => f.existingContext?.length).length;
      result.unresolved = fields.length;
      result.pendingLabels = fields.slice(0, 8).map(f => f.label || '未命名字段');
      if (!fields.length) return result;
      if (fields.length > 300) throw new Error('当前页面超过 300 个待识别字段，请分步展开表单后填写');
      client.validateSettings(settings);
      const sources = client.buildSources(profile, scan.sourceKeys, fillNoneWhenEmpty ? scan.noneKeys || [] : []);
      const batches = Math.ceil(fields.length / client.BATCH_SIZE);
      for (let offset = 0; offset < fields.length; offset += client.BATCH_SIZE) {
        const batch = fields.slice(offset, offset + client.BATCH_SIZE);
        await onProgress(`DeepSeek 正在判断字段（${Math.floor(offset / client.BATCH_SIZE) + 1}/${batches}）…`, result);
        const assignments = await requestModel({ fields: batch, sources, settings });
        await onProgress('正在填写模型识别的字段…', result);
        const applied = await execute(profile, { action: 'apply', snapshotToken, assignments, fillNoneWhenEmpty, allowOverwrite });
        result.modelFilled += applied.filled || 0;
        result.filled = result.ruleFilled + result.modelFilled;
        result.filledNone += applied.filledNone || 0;
        result.stale += applied.stale || 0;
        result.preserved += applied.preserved || 0;
        result.linkedProtected += applied.linkedProtected || 0;
        for (const id of applied.filledFieldIds || []) filledIds.add(id);
        for (const id of applied.preservedFieldIds || []) filledIds.add(id);
        result.unresolved = fields.length - filledIds.size;
        result.pendingLabels = fields.filter(f => !filledIds.has(f.fieldId)).slice(0, 8).map(f => f.label || '未命名字段');
      }
      return result;
    } catch (error) {
      // API 失败、页面变化时保留已完成的规则/模型填写，并展示部分结果。
      return { ...result, error: error.message || '填写失败' };
    } finally {
      if (snapshotToken) {
        try { await execute({}, { action: 'cleanup', snapshotToken }); } catch (_) { /* 页面已导航时快照随文档销毁 */ }
      }
    }
  }
  root.FillController = { runFillJob };
  if (typeof module !== 'undefined' && module.exports) module.exports = { runFillJob };
})(globalThis);
