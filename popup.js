/* 职聘通·网申助手 — 两种填写模式，后台执行 DeepSeek 请求。 */

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const statusEl = $('profile-status');
const hybridBtn = $('btn-fill-hybrid');
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
function countFields(p) {
  if (!p) return 0;
  let n = 0;
  for (const k of Object.keys(p)) {
    const v = p[k];
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) { n += k === "extraInfo" ? v.length : v.length ? 1 : 0; }
    else n++;
  }
  return n;
}

/* ---------- 画像存取 ---------- */
function loadProfile() {
  return new Promise((res) => chrome.storage.local.get(['profile', 'syncedAt'], (d) => res(d)));
}
async function renderStatus() {
  const { profile, syncedAt } = await loadProfile();
  if (profile && countFields(profile) > 0) {
    const cnt = countFields(profile);
    statusEl.innerHTML = `当前画像：<span class="name"></span>
      <span class="ready">✓ 就绪</span>
      <span class="field-count">(${cnt}字段)</span>
      <br><span style="font-size:11px;color:var(--muted)">更新于 ${fmtTime(syncedAt)}</span>`;
    statusEl.querySelector('.name').textContent = profile.name || '自定义资料';
  } else {
    statusEl.innerHTML = `<span style="color:var(--warn)">画像未填写</span><br>
      <span style="font-size:11px">点「➕ 新增信息」保存自定义资料</span>`;
  }
}

/* ---------- 打开编辑器 ---------- */
async function openEditor() {
  const tab = await getActiveTab();
  chrome.tabs.create({ url: chrome.runtime.getURL('editor.html'), ...(tab?.windowId != null ? { windowId: tab.windowId } : {}) });
}

/* ---------- 主页直接补充信息 ---------- */
let extraDirty = false;

function addExtraRow(item = {}) {
  const row = document.createElement('div');
  row.className = 'extra-info-row';
  const nameLabel = document.createElement('label');
  nameLabel.textContent = '信息名称';
  const name = document.createElement('input');
  name.dataset.extraLabel = '';
  name.placeholder = '填写你需要保存的信息名称';
  name.maxLength = 120;
  name.value = item.label || '';
  nameLabel.appendChild(name);
  const valueLabel = document.createElement('label');
  valueLabel.textContent = '信息内容';
  const value = document.createElement('textarea');
  value.dataset.extraValue = '';
  value.rows = 2;
  value.maxLength = 10000;
  value.placeholder = '填写真实内容';
  value.value = item.value || '';
  valueLabel.appendChild(value);
  const remove = document.createElement('button');
  remove.type = 'button'; remove.className = 'btn ghost sm'; remove.textContent = '删除此条';
  remove.addEventListener('click', () => { row.remove(); extraDirty = true; });
  row.addEventListener('input', () => { extraDirty = true; });
  row.append(nameLabel, valueLabel, remove);
  $('extra-info-rows').appendChild(row);
  return name;
}

async function loadQuickProfile(force = false) {
  const { profile = {} } = await loadProfile();
  if (!force && extraDirty) return;
  $('extra-info-rows').replaceChildren();
  (Array.isArray(profile.extraInfo) ? profile.extraInfo : []).forEach(addExtraRow);
  if (!$('extra-info-rows').children.length) addExtraRow();
  extraDirty = false;
}

async function saveQuickProfile(event) {
  event.preventDefault();
  const result = $('profile-save-result');
  const extraInfo = Array.from(document.querySelectorAll('.extra-info-row')).map(row => ({ label: row.querySelector('[data-extra-label]').value, value: row.querySelector('[data-extra-value]').value }));
  if (!extraDirty) { result.textContent = '没有新的修改。'; return; }
  $('btn-save-profile').disabled = true;
  $('quick-profile-form').querySelectorAll('input,textarea,button').forEach(el => { el.disabled = true; });
  try {
    await send({ type: 'SAVE_QUICK_PROFILE', extraInfo });
    await renderStatus(); await loadQuickProfile(true);
    result.className = 'settings-result'; result.textContent = '用户信息已保存，后续填写会使用最新信息。';
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
  for (const el of [hybridBtn, modelBtn, noneChk, protectChk, $('btn-save-deepseek'), $('btn-clear-deepseek')]) el.disabled = value;
}

function renderJob(job) {
  if (!job) return;
  const running = job.status === 'running';
  setBusy(running);
  const r = job.result || {};
  const parts = [`${job.mode === 'hybrid' ? '模式1：规则+模型' : '模式2：模型'}`];
  if (r.contextFields) parts.push(`结合页面已填信息判断 ${r.contextFields} 个空白字段`);
  if (running) parts.push(job.phase);
  parts.push(`已填 ${r.filled || 0} 项（规则 ${r.ruleFilled || 0} · DeepSeek ${r.modelFilled || 0}）`);
  if (r.filledNone) parts.push(`其中填「无」 ${r.filledNone}`);
  if (r.preserved) parts.push(`已保留已有信息 ${r.preserved} 项`);
  if (r.linkedProtected) parts.push(`联动字段需手动 ${r.linkedProtected}（保护已有子项）`);
  if (r.unresolved) parts.push(`待处理 ${r.unresolved}`);
  if (r.stale) parts.push(`页面或输入已变化 ${r.stale}（请重新填写）`);
  if (r.captcha) parts.push(`验证码 ${r.captcha}（需手动）`);
  if (r.file) parts.push(`上传 ${r.file}（需手动）`);
  if (r.agreement) parts.push(`同意条款 ${r.agreement}（需手动）`);
  if (r.unsupported) parts.push(`控件需手动 ${r.unsupported}`);
  if (!running && job.status === 'error') parts.push(r.error || job.phase);
  if (!running && r.pendingLabels?.length) parts.push(`待处理字段：${r.pendingLabels.join('、')}`);
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
    result.textContent = '配置已保存，可以使用两种填写模式。';
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

async function fillCurrentPage(mode) {
  if (busy) return;
  setBusy(true);
  showResult('正在启动填写…');
  try {
    const { profile } = await loadProfile();
    if (!profile || countFields(profile) === 0) {
      setBusy(false);
      showResult('画像未填写，无法填写。请先点「➕ 新增信息」。', 'warn');
      return;
    }
    const tab = await getActiveTab();
    if (!tab || !/^https?:/.test(tab.url || '')) {
      setBusy(false);
      showResult('请先打开一个企业投递页面', 'warn');
      return;
    }
    await send({ type: 'START_FILL', mode, tabId: tab.id, fillNoneWhenEmpty: noneChk.checked, allowOverwrite: !protectChk.checked });
    await refreshJob();
  } catch (e) {
    setBusy(false);
    showResult('填写失败：' + (e.message || e), 'err');
    if (/API Key/.test(e.message || '')) $('deepseek-settings').open = true;
  }
}

/* ---------- 初始化 ---------- */
(async function init() {
  await renderStatus();
  hybridBtn.addEventListener('click', () => fillCurrentPage('hybrid'));
  modelBtn.addEventListener('click', () => fillCurrentPage('model'));
  editBtn.addEventListener('click', openEditor);
  $('btn-add-profile').addEventListener('click', () => { $('quick-profile').open = true; document.querySelector('[data-extra-label]')?.focus(); });
  $('quick-profile-form').addEventListener('submit', saveQuickProfile);
  $('btn-add-extra').addEventListener('click', () => { extraDirty = true; addExtraRow().focus(); });
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

  // 画像变更时刷新状态
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.profile) {
      renderStatus();
      if (!extraDirty) loadQuickProfile();
    }
  });
})();
