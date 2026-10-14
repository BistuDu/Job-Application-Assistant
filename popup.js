/* 职聘通·网申助手 — 纯模型填写，后台执行 DeepSeek 请求。 */

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const statusEl = $('profile-status');
const modelBtn = $('btn-fill-model');
const editBtn = $('btn-edit');
const resultEl = $('fill-result');
const noneChk = $('opt-fill-none');
const protectChk = $('opt-protect-existing');
const floatingChk = $('opt-floating');

/* ---------- 工具 ---------- */
function fmtTime(ts) {
  if (!ts) return '从未';
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function showResult(msg, kind) {
  resultEl.hidden = false;
  resultEl.className = 'result' + (kind ? ' ' + kind : '');
  resultEl.textContent = msg;
}
function getActiveTab() {
  const targetTabId = Number(new URLSearchParams(location.search).get('targetTabId'));
  if (Number.isInteger(targetTabId) && targetTabId > 0) return send({ type: 'GET_TARGET_TAB', tabId: targetTabId }).then(response => response.tab).catch(() => null);
  return new Promise((res) => chrome.tabs.query({ active: true, currentWindow: true }, (t) => res(t && t[0])));
}
function textLength(userText) {
  return typeof userText === 'string' ? userText.trim().length : 0;
}

/* ---------- 资料存取（只保存文本） ---------- */
function loadUserData() {
  return new Promise((res) => chrome.storage.local.get(['userText', 'syncedAt'], res));
}
async function renderStatus() {
  const { userText, syncedAt } = await loadUserData();
  const length = textLength(userText);
  if (length > 0) {
    statusEl.innerHTML = `当前资料：<span class="ready">✓ 已保存</span>
      <span class="field-count">(${length} 字)</span>
      <br><span style="font-size:11px;color:var(--muted)">更新于 ${fmtTime(syncedAt)}</span>`;
  } else {
    statusEl.innerHTML = `<span style="color:var(--warn)">资料未填写</span><br>
      <span style="font-size:11px">点「✏️ 编辑资料」用文字描述你的真实信息</span>`;
  }
}

/* ---------- 打开编辑器 ---------- */
async function openEditor() {
  const tab = await getActiveTab();
  chrome.tabs.create({ url: chrome.runtime.getURL('editor.html'), ...(tab?.windowId != null ? { windowId: tab.windowId } : {}) });
}

/* ---------- 主页直接补充信息 ---------- */
let extraDirty = false;

async function loadQuickProfile(force = false) {
  if (!force && extraDirty) return;
  const { userText } = await loadUserData();
  $('supplement-text').value = typeof userText === 'string' ? userText : '';
  extraDirty = false;
}

async function saveQuickProfile(event) {
  event.preventDefault();
  const result = $('profile-save-result');
  const text = $('supplement-text').value;
  if (!extraDirty) { result.textContent = '没有新的修改。'; return; }
  $('btn-save-profile').disabled = true;
  $('quick-profile-form').querySelectorAll('input,textarea,button').forEach(el => { el.disabled = true; });
  try {
    await send({ type: 'SAVE_USER_TEXT', text });
    await renderStatus(); await loadQuickProfile(true);
    result.className = 'settings-result'; result.textContent = '用户资料已保存，后续填写会使用最新信息。';
  } catch (error) { result.className = 'settings-result err'; result.textContent = error.message; }
  finally { $('quick-profile-form').querySelectorAll('input,textarea,button').forEach(el => { el.disabled = false; }); }
}

/* ---------- 后台任务与配置 ---------- */
let pollTimer = null;
let busy = false;

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || '扩展后台未响应，请重新加载扩展');
  return response;
}

function setBusy(value) {
  busy = value;
  for (const el of [modelBtn, noneChk, protectChk, $('btn-save-deepseek'), $('btn-clear-deepseek')]) el.disabled = value;
}

function renderJob(job) {
  if (!job) return;
  const running = job.status === 'running';
  setBusy(running);
  const r = job.result || {};
  const parts = ['DeepSeek 智能填写'];
  if (r.contextFields) parts.push(`结合页面已填信息判断 ${r.contextFields} 个空白字段`);
  if (running) parts.push(job.phase);
  parts.push(`已填 ${r.filled || 0} 项（DeepSeek ${r.modelFilled || 0}）`);
  if (r.filledNone) parts.push(`其中填「无」 ${r.filledNone} 项`);
  if (r.preserved) parts.push(`已保留已有信息 ${r.preserved} 项`);
  if (r.repaired) parts.push(`按失败原因自动修正 ${r.repaired} 项`);
  else if (r.retried) parts.push(`已重试 ${r.retried} 项仍未填上`);
  if (r.unresolved) parts.push(`待处理 ${r.unresolved} 项`);
  if (r.issues?.length) parts.push(...r.issues.slice(0, 8).map(item => `· ${item.label}：${item.reason}`));
  if (r.notes?.length) parts.push(`需你补充：${r.notes.join('；')}`);
  if (r.stale) parts.push(`页面或输入已变化 ${r.stale}（请重新填写）`);
  const manualCount = (r.captcha || 0) + (r.file || 0) + (r.agreement || 0) + (r.unsupported || 0) + (r.linkedProtected || 0);
  if (manualCount) parts.push(`需手动处理 ${manualCount} 项`);
  if (r.manual?.length) parts.push(...r.manual.slice(0, 5).map(item => `· ${item.label}：${item.reason}`));
  if (!running && job.status === 'error') parts.push(r.error || job.phase);
  showResult(parts.join('\n'), job.status === 'error' ? 'err' : !running && ((!r.filled && !r.preserved) || r.unresolved || r.linkedProtected) ? 'warn' : '');
}

async function refreshJob() {
  const { job } = await send({ type: 'GET_FILL_JOB' });
  renderJob(job);
  if (job?.status === 'running') {
    if (!pollTimer) pollTimer = setInterval(() => { refreshJob().catch(() => {}); }, 1000);
  } else if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function loadSettings() {
  const config = await send({ type: 'GET_DEEPSEEK_SETTINGS' });
  $('deepseek-status').textContent = config.configured ? 'Key 已保存' : '未配置';
  $('deepseek-model').value = config.model;
  $('deepseek-key').value = '';
  $('deepseek-key').placeholder = config.configured ? '已保存；留空保留原 Key' : '输入你的 DeepSeek API Key';
  if (!config.configured) $('deepseek-settings').open = true;
}

async function saveSettings(event) {
  event.preventDefault();
  const result = $('settings-result');
  try {
    await send({ type: 'SAVE_DEEPSEEK_SETTINGS', apiKey: $('deepseek-key').value, model: $('deepseek-model').value });
    await loadSettings();
    result.className = 'settings-result';
    result.textContent = '配置已保存，可以使用纯模型填写。';
  } catch (error) { result.className = 'settings-result err'; result.textContent = error.message; }
}

async function clearSettings() {
  try {
    await send({ type: 'CLEAR_DEEPSEEK_KEY' });
    await loadSettings();
    $('settings-result').className = 'settings-result';
    $('settings-result').textContent = 'Key 已删除。';
  } catch (error) { showResult(error.message, 'err'); }
}

async function fillCurrentPage() {
  if (busy) return;
  setBusy(true);
  showResult('正在启动填写…');
  try {
    const { userText } = await loadUserData();
    if (textLength(userText) === 0) {
      setBusy(false);
      showResult('资料未填写，无法填写。请先在「✏️ 编辑资料」中用文字描述你的信息。', 'warn');
      return;
    }
    const tab = await getActiveTab();
    if (!tab || !/^https?:/.test(tab.url || '')) {
      setBusy(false);
      showResult('请先打开一个企业投递页面', 'warn');
      return;
    }
    await send({ type: 'START_FILL', tabId: tab.id, fillNoneWhenEmpty: noneChk.checked, allowOverwrite: !protectChk.checked });
    await refreshJob();
  } catch (e) {
    setBusy(false);
    showResult('填写失败：' + (e.message || e), 'err');
    if (/API Key/.test(e.message || e)) $('deepseek-settings').open = true;
  }
}

/* ---------- 初始化 ---------- */
(async function init() {
  await renderStatus();
  modelBtn.addEventListener('click', fillCurrentPage);
  editBtn.addEventListener('click', openEditor);
  $('btn-add-profile').addEventListener('click', () => { $('quick-profile').open = true; $('supplement-text').focus(); });
  $('quick-profile-form').addEventListener('submit', saveQuickProfile);
  $('supplement-text').addEventListener('input', () => { extraDirty = true; });
  $('btn-open-home').addEventListener('click', async () => {
    try { const tab = await getActiveTab(); await send({ type: 'OPEN_HOME', tabId: tab?.id }); } catch (error) { showResult(error.message, 'err'); }
  });
  floatingChk.addEventListener('change', async () => {
    try { await send({ type: 'SET_FLOATING_ENABLED', enabled: floatingChk.checked }); }
    catch (error) { floatingChk.checked = !floatingChk.checked; showResult(error.message, 'err'); }
  });
  $('deepseek-form').addEventListener('submit', saveSettings);
  $('btn-clear-deepseek').addEventListener('click', clearSettings);
  try {
    await loadQuickProfile(); await loadSettings(); await refreshJob();
    floatingChk.checked = (await send({ type: 'GET_FLOATING_SETTINGS' })).enabled;
  } catch (error) { showResult(error.message, 'err'); }

  // 「空缺项自动填无」开关：读取/持久化偏好（默认开）
  try {
    const pref = await new Promise((res) => chrome.storage.local.get(['fillNoneWhenEmpty'], res));
    noneChk.checked = pref.fillNoneWhenEmpty !== false;
  } catch (_) { /* 保持默认勾选 */ }
  noneChk.addEventListener('change', () => {
    chrome.storage.local.set({ fillNoneWhenEmpty: noneChk.checked });
  });

  // 资料变更时刷新状态
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.userText) {
      renderStatus();
      if (!extraDirty) loadQuickProfile();
    }
  });
})();
