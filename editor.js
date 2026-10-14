/* 职聘通·网申助手 — 我的资料（纯文本编辑）v3.1
 * 资料只以文本保存：一段自然语言描述，模型填写时逐字核验引用。 */
const STORAGE_KEY = 'userText';
const MAX_LENGTH = 30000;
const EXAMPLE = `姓名：张某某
性别：男
出生日期：2000-05-06
手机号码：13800000000
电子邮箱：zhang@example.com
现居住地：北京市海淀区
政治面貌：共青团员

教育背景：
2022.9-2026.6 某某大学 计算机科学与技术 本科，学号 20220001，班级 1 班

实习经历：
2024.7-2024.9 某某科技有限公司 前端开发实习生，负责后台管理系统的页面开发与接口联调，离职原因：实习结束

校园经历：
2023.9-2024.6 校学生会宣传部 干事，负责活动海报与公众号推文

家庭成员：
母亲 李某某，电话 13900000000，政治面貌：群众
父亲 张某某，电话 13700000000

求职意向：
期望职位：前端开发工程师；期望城市：北京

其他：
没有获得过竞赛奖项
外语水平：英语 CET-6 560 分`;

function $(sel) { return document.querySelector(sel); }
function showToast(msg, kind) {
  const el = $('#save-toast');
  el.className = 'toast' + (kind && kind !== 'ok' ? ' ' + kind : '');
  el.textContent = msg;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 2500);
}

let isDirty = false;

function updateCount() {
  $('#char-count').textContent = `${$('#profile-text').value.length} / ${MAX_LENGTH} 字`;
}

function updateSaveStatus(dirty) {
  const el = $('#save-status');
  el.textContent = dirty ? '● 未保存' : `✓ 已保存 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  el.className = 'save-status ' + (dirty ? 'unsaved' : 'saved');
}

async function load() {
  const { userText } = await chrome.storage.local.get([STORAGE_KEY]);
  $('#profile-text').value = typeof userText === 'string' ? userText : '';
  updateCount();
  updateSaveStatus(false);
}

async function save() {
  const area = $('#profile-text');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'SAVE_USER_TEXT', text: area.value });
    if (!result?.ok) throw new Error(result?.error || '保存失败，请重新加载扩展');
  } catch (error) { showToast(error.message, 'err'); return; }
  area.value = area.value.trim();
  isDirty = false;
  updateSaveStatus(false);
  updateCount();
  showToast('资料已保存', 'ok');
}

/* ========== 示例与清空 ========== */
function loadExample() {
  const area = $('#profile-text');
  if (area.value.trim() && !confirm('将用示例替换当前内容（保存后生效），继续？')) return;
  area.value = EXAMPLE;
  isDirty = true;
  updateSaveStatus(true);
  updateCount();
  showToast('已载入示例，改成你自己的信息后保存', 'ok');
}

function reset() {
  if (!confirm('确定清空我的资料？保存后生效，此操作不可撤销。')) return;
  $('#profile-text').value = '';
  isDirty = true;
  updateSaveStatus(true);
  updateCount();
  showToast('已清空（点击保存生效）', 'warn');
}

/* ========== 初始化 ========== */
document.addEventListener('DOMContentLoaded', async () => {
  await load();
  $('#btn-save').addEventListener('click', save);
  $('#btn-save-2').addEventListener('click', save);
  $('#btn-example').addEventListener('click', loadExample);
  $('#btn-reset').addEventListener('click', reset);
  $('#profile-text').addEventListener('input', () => {
    isDirty = true;
    updateSaveStatus(true);
    updateCount();
  });
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      save();
    }
  });
  window.addEventListener('beforeunload', event => {
    if (isDirty) { event.preventDefault(); event.returnValue = ''; }
  });
  // 其他窗口保存了新内容时提示刷新，避免覆盖。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEY] && !isDirty) load();
  });
});
