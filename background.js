importScripts('fill-engine.js', 'deepseek-client.js', 'fill-controller.js');

let activeJob = null;
const ready = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const { fillJob } = await chrome.storage.session.get('fillJob');
  if (fillJob?.status === 'running') {
    await chrome.storage.session.set({ fillJob: { ...fillJob, status: 'error', phase: '上次填写已中断，已填写内容保留，请重新点击填写', endedAt: Date.now() } });
  }
})();

async function persistJob(job) {
  await chrome.storage.session.set({ fillJob: job });
}

async function startJob(message) {
  if (activeJob) throw new Error('已有填写任务正在进行，请等待完成');
  const tab = await chrome.tabs.get(message.tabId);
  if (!tab || !/^https?:/.test(tab.url || '')) throw new Error('请先打开企业投递页面');
  if (!['hybrid', 'model'].includes(message.mode)) throw new Error('未知填写模式');
  const { profile, deepseek } = await chrome.storage.local.get(['profile', 'deepseek']);
  if (!profile || !Object.values(profile).some(v => Array.isArray(v) ? v.length : v !== '' && v != null)) throw new Error('请先完善并保存简历画像');
  if (activeJob) throw new Error('已有填写任务正在进行，请等待完成');
  const job = { id: crypto.randomUUID(), mode: message.mode, tabId: tab.id, status: 'running', phase: '正在准备填写…', startedAt: Date.now(), result: null };
  activeJob = job;
  try { await persistJob(job); } catch (error) { activeJob = null; throw error; }
  let documentId;
  // 让后台在等待网络期间保持活动；进度保存在 session，弹窗关闭后可重新查看。
  const keepAlive = setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, 20000);
  void (async () => {
    try {
      const result = await FillController.runFillJob({
        mode: message.mode, profile, settings: deepseek, fillNoneWhenEmpty: !!message.fillNoneWhenEmpty, allowOverwrite: message.allowOverwrite === true,
        execute: async (data, options) => {
          const responses = await chrome.scripting.executeScript({
            target: documentId ? { tabId: tab.id, documentIds: [documentId] } : { tabId: tab.id, frameIds: [0] },
            func: FILL_FUNCTION, args: [data, options],
          });
          const response = responses[0];
          if (!response?.result) throw new Error('无法读取当前页面的填写结果');
          if (options.action !== 'cleanup' && !response.documentId) throw new Error('当前浏览器不支持文档定位，请更新 Chrome/Edge');
          documentId = response.documentId || documentId;
          return response.result;
        },
        requestModel: DeepSeekClient.requestAssignments,
        onProgress: async (phase, result) => { job.phase = phase; job.result = { ...result }; await persistJob(job); },
      });
      job.result = result;
      job.status = result.error ? 'error' : 'done';
      job.phase = result.error || '填写完成';
    } catch (_) {
      job.status = 'error';
      job.phase = '填写中断，已填写的内容保留；请检查页面后重试';
    } finally {
      job.endedAt = Date.now();
      clearInterval(keepAlive);
      try { await persistJob(job); } finally { activeJob = null; }
    }
  })();
  return { jobId: job.id };
}

async function openHome(tabId) {
  const query = Number.isInteger(tabId) && tabId > 0 ? `?targetTabId=${tabId}` : '';
  await chrome.windows.create({ url: chrome.runtime.getURL('popup.html' + query), type: 'popup', width: 400, height: 760 });
  return { opened: true };
}

async function syncFloating(enabled) {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(tabs.filter(tab => !/^https:\/\/api\.deepseek\.com\//.test(tab.url || '')).map(async tab => {
    try { await chrome.tabs.sendMessage(tab.id, { type: 'FLOATING_VISIBILITY', enabled }, { frameId: 0 }); }
    catch (_) {
      if (enabled) {
        try { await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['floating.js'] }); } catch (_) { /* 浏览器受限页面不显示 */ }
      }
    }
  }));
}

chrome.runtime.onInstalled.addListener(() => {
  void ready.then(async () => {
    const { floatingEnabled } = await chrome.storage.local.get('floatingEnabled');
    await syncFloating(floatingEnabled !== false);
  }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const trusted = sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));
  const floating = sender.id === chrome.runtime.id && Number.isInteger(sender.tab?.id) && sender.frameId === 0 && /^https?:/.test(sender.url || '');
  const floatingTypes = ['FLOATING_GET_STATUS', 'FLOATING_START_FILL', 'FLOATING_OPEN_HOME'];
  if (!trusted && !(floating && floatingTypes.includes(message?.type))) return false;
  (async () => {
    await ready;
    if (floating) {
      if (message.type === 'FLOATING_OPEN_HOME') return openHome(sender.tab.id);
      if (message.type === 'FLOATING_START_FILL') {
        const { fillNoneWhenEmpty } = await chrome.storage.local.get('fillNoneWhenEmpty');
        return startJob({ mode: message.mode, tabId: sender.tab.id, fillNoneWhenEmpty: fillNoneWhenEmpty !== false, allowOverwrite: false });
      }
      const { profile, deepseek, floatingEnabled } = await chrome.storage.local.get(['profile', 'deepseek', 'floatingEnabled']);
      const { fillJob } = await chrome.storage.session.get('fillJob');
      const fieldCount = Object.entries(profile || {}).reduce((n, [key, value]) => n + (Array.isArray(value) ? key === 'extraInfo' ? value.length : value.length ? 1 : 0 : value !== '' && value != null ? 1 : 0), 0);
      // 悬浮入口不拿到画像值或密钥，仅拿准备状态和本页任务统计。
      return { enabled: floatingEnabled !== false, profileReady: fieldCount > 0, fieldCount, configured: !!deepseek?.apiKey, busy: !!activeJob, job: fillJob?.tabId === sender.tab.id ? fillJob : null };
    }
    if (message.type === 'OPEN_HOME') return openHome(message.tabId);
    if (message.type === 'GET_TARGET_TAB') {
      if (!Number.isInteger(message.tabId) || message.tabId <= 0) throw new Error('来源页面无效');
      const tab = await chrome.tabs.get(message.tabId);
      if (!/^https?:/.test(tab.url || '')) throw new Error('来源网申页面已关闭或导航，请重新打开');
      return { tab };
    }
    if (message.type === 'SAVE_QUICK_PROFILE') {
      const { profile } = await chrome.storage.local.get('profile');
      const updated = { ...(profile || {}) };
      if (message.extraInfo !== undefined) {
        if (!Array.isArray(message.extraInfo) || message.extraInfo.length > 30) throw new Error('最多添加 30 条自定义信息');
        const labels = new Set();
        updated.extraInfo = message.extraInfo.flatMap(item => {
          if (typeof item?.label !== 'string' || typeof item?.value !== 'string') throw new Error('自定义信息格式不正确');
          const label = item.label.trim(), value = item.value.trim();
          if (!label && !value) return [];
          if (!label || !value) throw new Error('请补全自定义信息的名称和内容');
          if (label.length > 120 || value.length > 10000) throw new Error('自定义信息名称或内容过长');
          const normalized = label.toLowerCase();
          if (labels.has(normalized)) throw new Error('自定义信息名称不能重复');
          labels.add(normalized);
          return [{ label, value }];
        });
      }
      await chrome.storage.local.set({ profile: updated, syncedAt: Date.now() });
      return { saved: true };
    }
    if (message.type === 'GET_FLOATING_SETTINGS') {
      const { floatingEnabled } = await chrome.storage.local.get('floatingEnabled');
      return { enabled: floatingEnabled !== false };
    }
    if (message.type === 'SET_FLOATING_ENABLED') {
      await chrome.storage.local.set({ floatingEnabled: message.enabled === true });
      await syncFloating(message.enabled === true);
      return { enabled: message.enabled === true };
    }
    if (message.type === 'START_FILL') return startJob(message);
    if (message.type === 'GET_FILL_JOB') {
      const { fillJob } = await chrome.storage.session.get('fillJob');
      return { job: fillJob || null };
    }
    if (message.type === 'GET_DEEPSEEK_SETTINGS') {
      const { deepseek } = await chrome.storage.local.get('deepseek');
      return { configured: !!deepseek?.apiKey, model: deepseek?.model || DeepSeekClient.DEFAULT_MODEL };
    }
    if (message.type === 'SAVE_DEEPSEEK_SETTINGS') {
      const { deepseek } = await chrome.storage.local.get('deepseek');
      const apiKey = typeof message.apiKey === 'string' ? message.apiKey.trim() : '';
      const settings = DeepSeekClient.validateSettings({ apiKey: apiKey || deepseek?.apiKey, model: message.model });
      await chrome.storage.local.set({ deepseek: settings });
      return { configured: true, model: settings.model };
    }
    if (message.type === 'CLEAR_DEEPSEEK_KEY') {
      await chrome.storage.local.remove('deepseek');
      return { configured: false, model: DeepSeekClient.DEFAULT_MODEL };
    }
    throw new Error('不支持的操作');
  })().then(data => sendResponse({ ok: true, ...data }), error => sendResponse({ ok: false, error: error.message || '操作失败' }));
  return true;
});
