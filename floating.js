/* 固定网页悬浮入口。画像编辑与密钥配置在可信扩展窗口进行。 */
(function () {
  if (window.top !== window || globalThis.__jhFloatingMounted) return;
  globalThis.__jhFloatingMounted = true;
  document.querySelector('jh-application-helper')?.remove();
  const host = document.createElement('jh-application-helper');
  for (const [key, value] of Object.entries({ all: 'initial', position: 'fixed', right: '20px', bottom: '24px', zIndex: '2147483647', display: 'block' })) {
    host.style.setProperty(key.replace(/[A-Z]/g, c => '-' + c.toLowerCase()), value, 'important');
  }
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    * { box-sizing: border-box; }
    .ball { width:56px;height:56px;border:0;border-radius:50%;background:#7342e2;color:#fff;font-size:25px;cursor:pointer;box-shadow:0 5px 24px #7342e266; }
    .ball:focus-visible,button:focus-visible { outline:3px solid #bfadf8;outline-offset:3px; }
    .panel { position:absolute;right:0;bottom:72px;width:330px;max-width:calc(100vw - 40px);max-height:calc(100vh - 120px);overflow:auto;padding:16px;background:#f8f7fc;color:#192837;border:1px solid #ddd5ef;border-radius:16px;box-shadow:0 12px 44px #19283733;font:13px/1.6 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif; }
    .panel[hidden] { display:none; }
    header { display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;font-size:15px;font-weight:700; }
    button { font:inherit;cursor:pointer; }
    .close { border:0;background:transparent;color:#64748b;font-size:22px;padding:0 5px; }
    .fill { display:block;width:100%;border:0;border-radius:10px;padding:11px 8px;margin:8px 0;background:#7342e2;color:white;font-weight:600; }
    .fill span { display:block;font-size:11px;opacity:.94; }
    button:disabled { opacity:.55;cursor:not-allowed; }
    .home { width:100%;margin-top:8px;padding:8px;border:1px solid #d6c6f6;border-radius:8px;background:white;color:#6434d4; }
    .note,.profile { font-size:11px;color:#64748b;margin:6px 0; }
    .status { white-space:pre-line;overflow-wrap:anywhere;background:#f1ebfd;border-radius:8px;padding:9px;font-size:12px; }
    .status:empty { display:none; }.status.err { color:#b91c1c;background:#fef2f2; }
  `;
  shadow.appendChild(style);
  const panel = document.createElement('section');
  panel.className = 'panel'; panel.hidden = true; panel.setAttribute('aria-label', '网申助手填写面板');
  panel.innerHTML = `<header><span>📋 网申助手</span><button class="close" aria-label="收起面板">×</button></header>
    <p class="profile"></p>
    <button class="fill hybrid" aria-label="一键填写本页（模式1:规则+模型）">⚡ 一键填写本页<span>模式1:规则+模型</span></button>
    <button class="fill model" aria-label="一键填写本页（模式2:模型）">⚡ 一键填写本页<span>模式2:模型</span></button>
    <p class="note">默认保护已有信息，仅补空白项。</p><p class="note">模型参考同区域已填内容；字段描述、已有内容和所需画像会发送至 DeepSeek。</p>
    <div class="status" role="status" aria-live="polite"></div>
    <button class="home">新增信息 / 打开固定主页</button>`;
  shadow.appendChild(panel);
  const ball = document.createElement('button');
  ball.className = 'ball'; ball.textContent = '⚡'; ball.setAttribute('aria-label', '打开网申助手'); ball.setAttribute('aria-expanded', 'false');
  shadow.appendChild(ball);
  let timer = null;
  let busy = false;
  let starting = false;

  async function send(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || '扩展已更新，请刷新页面后重试');
    return response;
  }
  function show(text, error = false) {
    const status = panel.querySelector('.status');
    status.textContent = text; status.classList.toggle('err', error);
  }
  function disable(value) {
    busy = value;
    panel.querySelectorAll('.fill').forEach(control => { control.disabled = value; });
  }
  function setVisible(enabled) {
    host.style.setProperty('display', enabled ? 'block' : 'none', 'important');
    if (enabled && !host.isConnected) document.documentElement.appendChild(host);
    if (!enabled) { close(); host.remove(); }
  }
  function close() {
    panel.hidden = true; ball.setAttribute('aria-expanded', 'false');
    if (timer) { clearInterval(timer); timer = null; }
  }
  async function refresh() {
    try {
      const state = await send({ type: 'FLOATING_GET_STATUS' });
      setVisible(state.enabled);
      panel.querySelector('.profile').textContent = state.profileReady ? `画像已保存（${state.fieldCount} 项）${state.configured ? '' : ' · DeepSeek 未配置'}` : '请打开主页，先保存用户信息。';
      if (starting) return;
      disable(state.busy);
      if (state.job) {
        const job = state.job, r = job.result || {};
        const lines = [job.status === 'running' ? job.phase : job.status === 'error' ? r.error || job.phase : '填写完成', `已填 ${r.filled || 0} 项（规则 ${r.ruleFilled || 0} · DeepSeek ${r.modelFilled || 0}）`];
        if (r.contextFields) lines.push(`结合页面已填信息判断 ${r.contextFields} 个空白字段`);
        if (r.preserved) lines.push(`已保留已有信息 ${r.preserved} 项`);
        if (r.unresolved) lines.push(`待处理 ${r.unresolved} 项`);
        if (r.linkedProtected) lines.push(`联动字段需手动 ${r.linkedProtected} 项`);
        if (r.captcha || r.file || r.agreement || r.unsupported) lines.push('验证码、上传、条款及不支持的控件请手动处理。');
        show(lines.join('\n'), job.status === 'error');
      } else if (state.busy) show('其他页面正在填写，请稍候。');
      else show(state.configured ? '' : 'DeepSeek 尚未配置，可打开主页保存 API Key。');
    } catch (error) { disable(false); show(error.message, true); }
  }
  async function start(mode) {
    if (busy || starting) return;
    starting = true; disable(true); show('正在启动填写…');
    try { await send({ type: 'FLOATING_START_FILL', mode }); }
    catch (error) { show(error.message, true); disable(false); return; }
    finally { starting = false; }
    await refresh();
  }
  ball.addEventListener('click', async () => {
    if (!panel.hidden) { close(); return; }
    panel.hidden = false; ball.setAttribute('aria-expanded', 'true');
    await refresh();
    if (!panel.hidden && !timer) timer = setInterval(refresh, 1000);
  });
  panel.querySelector('.close').addEventListener('click', close);
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') { close(); ball.focus(); } });
  panel.querySelector('.hybrid').addEventListener('click', () => start('hybrid'));
  panel.querySelector('.model').addEventListener('click', () => start('model'));
  panel.querySelector('.home').addEventListener('click', async () => {
    try { await send({ type: 'FLOATING_OPEN_HOME' }); } catch (error) { show(error.message, true); }
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id === chrome.runtime.id && message?.type === 'FLOATING_VISIBILITY') {
      setVisible(message.enabled === true); respond({ applied: true });
    }
  });
  void refresh();
})();
