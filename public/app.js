const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const activeStatuses = new Set(['planning', 'implementing', 'diagnosing', 'fixing']);
const attentionStatuses = new Set(['blocked', 'needs_human', 'review']);
const statuses = {
  planning_queue: ['等待规划', ''], planning: ['正在规划', 'blue'],
  ready: ['等待实施', ''], implementing: ['正在实施', 'blue'],
  blocked: ['等待诊断', 'amber'], diagnosing: ['正在诊断', 'purple'],
  needs_human: ['需要人工', 'red'], codex_fix_queue: ['等待接手', 'purple'],
  fixing: ['Codex 修复中', 'purple'], review: ['等待验收', 'amber'],
  done: ['已完成', 'teal'], paused: ['已暂停', '']
};
const actorNames = { codex: 'Codex', workbuddy: 'WorkBuddy', human: '人工', system: '系统' };
const eventNames = {
  created: '创建任务', task_created: '创建任务', claimed: '领取任务', task_claimed: '领取任务',
  plan_submitted: '提交计划', result_submitted: '提交成果', blocked: '报告阻塞',
  report_blocked: '报告阻塞', approved: '验收完成', pause_requested: '请求暂停',
  paused: '确认暂停', resumed: '恢复任务', retried: '重新安排', takeover: '交由 Codex 接手',
  revised: '修订计划', comment: '补充说明', recovered: '恢复检查',
  stale: '连接超时', restart: '服务重启', timed_out: '连接超时'
};
const titles = {
  tasks: ['任务工作台', '让计划与实施，有序衔接。', 'Codex 负责规划与诊断，WorkBuddy 负责实施，你掌握关键决定。'],
  projects: ['项目目录', '每个项目，都有清晰的协作边界。', '登记本机项目目录，让任务、计划和交接记录归属到同一个项目。'],
  integration: ['应用接入', '连接你的协作应用。', '通过本地 MCP 桥接，让应用主动领取任务、报告阻塞并提交成果。']
};
let state = { projects: [], tasks: [], events: [], agents: [], meta: {} };
let online = false;
let hasState = false;
let loading = false;
let view = 'tasks';
let filter = 'all';
let selectedTask = null;
let pendingAction = null;
let integration = null;
let toastTimer;
let lastSnapshot = '';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
function button(text, className, onClick) {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}
function textValue(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
function time(value, compact = false) {
  if (!value) return '尚无记录';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', compact
    ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
    : { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }
  ).format(parsed);
}
function projectOf(task) {
  return state.projects.find(project => project.id === task.projectId);
}
function taskById(id) {
  return state.tasks.find(task => task.id === id);
}
function badge(status) {
  const [label, color] = statuses[status] || [status || '未知', ''];
  return element('span', 'status-badge ' + color, label);
}
function toast(message, error = false) {
  clearTimeout(toastTimer);
  const target = $('#toast');
  target.textContent = message;
  target.className = 'toast visible' + (error ? ' error' : '');
  toastTimer = setTimeout(() => target.classList.remove('visible'), error ? 6500 : 3500);
}
async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    cache: 'no-store',
    headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-hub-ui': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  });
  let result;
  try { result = await response.json(); }
  catch { throw new Error('本地服务返回了无法识别的响应，请检查服务是否正常运行。'); }
  if (!response.ok) throw new Error(result.error || '操作失败，请稍后重试。');
  return result;
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板');
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;opacity:0;left:0;top:0';
    const modal = $$('dialog[open]').at(-1);
    (modal || document.body).append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    if (copied) toast('已复制到剪贴板');
    else toast('浏览器未允许复制，请手动选择文本复制。', true);
  }
}
function setOnline(success, error) {
  online = success;
  const service = $('#service-state');
  service.replaceChildren(element('i', 'status-dot ' + (success ? 'green' : 'red')), document.createTextNode(success ? '服务已连接' : '服务未连接'));
  const banner = $('#offline-banner');
  banner.classList.toggle('hidden', success);
  if (!success) banner.textContent = '无法连接本地服务。请保持启动窗口运行。' + (hasState ? '下方保留最后一次读取的数据，暂不能提交操作。' : '') + (error ? ' ' + error : '');
  $('#primary-action').disabled = !success;
  $$('.detail-side .button[data-mutation]').forEach(node => { node.disabled = !success; });
}
async function refresh(force = false) {
  if (loading) return;
  loading = true;
  try {
    const next = await api('/api/state');
    if (!Array.isArray(next.projects) || !Array.isArray(next.tasks)) throw new Error('状态数据格式不正确。');
    state = { ...state, ...next };
    hasState = true;
    const snapshot = JSON.stringify(state);
    setOnline(true);
    if (snapshot !== lastSnapshot || force) {
      lastSnapshot = snapshot;
      renderAll();
    }
  } catch (error) {
    setOnline(false, error.message);
    renderAgents();
  } finally { loading = false; }
}
function renderAll() {
  $('#version').textContent = 'v' + (state.meta?.version || '0.1.0');
  renderProjectSelects();
  renderMetrics();
  renderTasks();
  renderAgents();
  renderActivity();
  renderProjects();
  if (selectedTask && $('#detail-dialog').open) renderDetail(selectedTask, true);
}
function renderProjectSelects() {
  const signature = JSON.stringify(state.projects.map(project => [project.id, project.name]));
  for (const target of [$('#project-filter'), $('#task-project')]) {
    if (target.dataset.signature === signature) continue;
    const old = target.value;
    target.replaceChildren();
    if (target.id === 'project-filter') {
      const option = element('option', '', '所有项目'); option.value = ''; target.append(option);
    } else if (!state.projects.length) {
      const option = element('option', '', '请先添加项目目录'); option.value = ''; target.append(option);
    }
    for (const project of state.projects) {
      const option = element('option', '', project.name); option.value = project.id; target.append(option);
    }
    if ([...target.options].some(option => option.value === old)) target.value = old;
    target.dataset.signature = signature;
  }
}
function renderMetrics() {
  const total = state.tasks.length;
  const running = state.tasks.filter(task => activeStatuses.has(task.status)).length;
  const attention = state.tasks.filter(task => attentionStatuses.has(task.status)).length;
  const done = state.tasks.filter(task => task.status === 'done').length;
  $('#metrics').replaceChildren(...[
    ['全部任务', total, '▦'], ['正在执行', running, '↗'], ['需要关注', attention, '◇'], ['验收完成', done, '✓']
  ].map(([name, count, icon]) => {
    const card = element('article', 'metric');
    const info = element('div');
    info.append(element('div', 'metric-name', name));
    const value = element('div', 'metric-value', count); value.append(element('small', '', '项')); info.append(value);
    card.append(info, element('div', 'metric-icon', icon)); return card;
  }));
}
function emptyState(title, description, actionText, action) {
  const target = element('div', 'empty-state');
  const art = element('div', 'empty-art'); art.setAttribute('aria-hidden', 'true'); art.append(element('span', '', '+'));
  target.append(art, element('h3', '', title), element('p', '', description));
  if (actionText) target.append(button(actionText, 'button secondary small', action));
  return target;
}
function renderTasks() {
  const projectId = $('#project-filter').value;
  const query = $('#task-search').value.trim().toLocaleLowerCase();
  const tasks = state.tasks.filter(task => {
    if (projectId && task.projectId !== projectId) return false;
    if (filter === 'active' && !activeStatuses.has(task.status)) return false;
    if (filter === 'attention' && !attentionStatuses.has(task.status)) return false;
    if (filter === 'done' && task.status !== 'done') return false;
    return !query || [task.title, task.description, projectOf(task)?.name, task.id].some(value => textValue(value).toLocaleLowerCase().includes(query));
  }).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  $('#task-count').textContent = tasks.length + ' 项任务';
  const container = $('#task-list');
  if (!tasks.length) {
    const hasFilters = !!query || !!projectId || filter !== 'all';
    container.replaceChildren(hasFilters
      ? emptyState('没有符合条件的任务', '调整筛选条件，查看其他项目或任务状态。', '清除筛选', () => { $('#project-filter').value = ''; $('#task-search').value = ''; setFilter('all'); })
      : emptyState('从第一项协作任务开始', '明确目标与验收标准，让 Codex 出计划、WorkBuddy 实施，每次交接都有记录。', state.projects.length ? '＋ 创建第一项任务' : '＋ 添加项目目录', () => state.projects.length ? openTaskForm() : openProjectForm()));
    return;
  }
  const head = element('div', 'task-table-head');
  head.append(element('span', '', '任务 / 项目'), element('span', '', '当前状态'), element('span', 'task-owner', '当前执行者'), element('span'));
  container.replaceChildren(head, ...tasks.map(task => {
    const row = button('', 'task-row', () => openDetail(task.id));
    row.setAttribute('aria-label', task.title + '，' + (statuses[task.status]?.[0] || task.status));
    const info = element('div'); info.append(element('span', 'task-title', task.title));
    const meta = element('div', 'task-meta');
    meta.append(element('span', 'project-name', projectOf(task)?.name || '未知项目'), element('span', 'task-age', time(task.updatedAt, true)));
    info.append(meta);
    row.append(info, badge(task.status), element('span', 'task-owner', actorNames[task.owner] || '等待领取'), element('span', 'task-arrow', '›'));
    return row;
  }));
}
function renderAgents() {
  $('#agent-list').replaceChildren(...['codex', 'workbuddy'].map(id => {
    const agent = state.agents.find(item => item.id === id);
    const connected = online && !!agent?.connected;
    const card = element('div', 'agent-card');
    const info = element('div', 'agent-info');
    info.append(element('strong', '', actorNames[id]), element('small', '', id === 'codex' ? '规划 · 诊断 · 疑难修复' : '实施 · 检查 · 交付'));
    const status = element('div', 'agent-status' + (connected ? ' online' : ''));
    status.append(element('i', 'status-dot' + (connected ? ' green' : '')), document.createTextNode(connected ? '近期有活动' : (agent?.lastSeen ? '近期无活动' : '尚未接入')));
    status.title = agent?.lastSeen ? '最近 MCP 活动：' + time(agent.lastSeen) : '尚未收到 MCP 活动';
    card.append(element('div', 'agent-avatar ' + id, id === 'codex' ? 'C' : 'W'), info, status);
    return card;
  }));
}
function renderActivity() {
  const events = [...state.events].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 4);
  $('#activity-list').replaceChildren(...(events.length ? events.map(event => {
    const item = element('div', 'activity-item');
    item.append(element('strong', '', actorNames[event.actor] || event.actor || '系统'), element('p', '', event.message || eventNames[event.type] || event.type), element('time', '', time(event.createdAt, true)));
    return item;
  }) : [element('p', 'activity-empty', '还没有协作记录。创建任务后，计划与交接动态会在这里显示。')]));
}
function renderProjects() {
  const target = $('#project-list');
  if (!state.projects.length) {
    target.replaceChildren(emptyState('先连接一个本机项目', '填写已有项目的名称与绝对路径，随后就能为它创建协作任务。', '＋ 添加项目目录', openProjectForm));
    return;
  }
  target.replaceChildren(...state.projects.map(project => {
    const card = element('article', 'panel project-card');
    const header = element('div', 'project-card-header'); header.append(element('div', 'project-icon', '▤'), element('h3', '', project.name));
    const tasks = state.tasks.filter(task => task.projectId === project.id);
    const footer = element('div', 'project-card-footer');
    footer.append(element('span', '', tasks.length + ' 项任务 · ' + tasks.filter(task => task.status === 'done').length + ' 项完成'), button('查看任务 →', 'text-button', () => { $('#project-filter').value = project.id; setFilter('all'); navigate('tasks'); }));
    card.append(header, element('div', 'path', project.path), footer);
    target.append(card);
  }));
}
function setFilter(next) {
  filter = next;
  $$('#status-filters button').forEach(node => {
    const selected = node.dataset.filter === next;
    node.classList.toggle('selected', selected);
    node.setAttribute('aria-pressed', String(selected));
  });
  renderTasks();
}
function navigate(next) {
  if (!titles[next]) next = 'tasks';
  view = next;
  const [label, title, subtitle] = titles[view];
  $('#breadcrumb').textContent = label;
  $('#page-title').textContent = title;
  $('#page-subtitle').textContent = subtitle;
  for (const name of Object.keys(titles)) $('#' + name + '-view').classList.toggle('hidden', name !== view);
  $$('.nav-item').forEach(node => { node.classList.toggle('active', node.dataset.view === view); if (node.dataset.view === view) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); });
  const action = $('#primary-action');
  action.classList.toggle('hidden', view === 'integration');
  action.textContent = view === 'projects' ? '＋ 添加项目' : '＋ 创建任务';
  if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
  if (view === 'integration') renderIntegration();
}
function prepareForm(id) {
  const dialog = $('#' + id);
  const form = $('form', dialog);
  form.reset();
  $('.form-error', form).textContent = '';
  $('button[type=submit]', form).disabled = false;
  return dialog;
}
function openProjectForm() {
  if (!online) { toast('请先连接本地服务。', true); return; }
  prepareForm('project-dialog').showModal();
}
function openTaskForm() {
  if (!online) { toast('请先连接本地服务。', true); return; }
  if (!state.projects.length) { toast('请先添加一个项目目录'); openProjectForm(); return; }
  const dialog = prepareForm('task-dialog');
  renderProjectSelects();
  const selected = $('#project-filter').value;
  if (selected) $('#task-project').value = selected;
  dialog.showModal();
}
function contentSection(title, value, empty, className = '') {
  const section = element('section', 'detail-section ' + className);
  section.append(element('h3', '', title));
  const text = textValue(value);
  section.append(element('div', text ? 'text-content' : 'muted-content', text || empty));
  return section;
}
function openDetail(id) {
  selectedTask = id;
  renderDetail(id);
  if (!$('#detail-dialog').open) $('#detail-dialog').showModal();
}
function renderDetail(id, preserve = false) {
  const task = taskById(id);
  if (!task) { $('#detail-dialog').close(); selectedTask = null; return; }
  const dialog = $('#detail-dialog');
  const scrollTop = dialog.scrollTop;
  const root = $('#detail-content');
  const header = element('header', 'detail-header');
  const topline = element('div', 'detail-topline');
  topline.append(element('span', 'detail-id', task.id), button('×', 'icon-button', () => dialog.close()));
  topline.lastElementChild.setAttribute('aria-label', '关闭任务详情');
  const heading = element('h2', 'detail-title', task.title); heading.id = 'detail-title';
  const subline = element('div', 'detail-subline');
  subline.append(badge(task.status), element('span', '', projectOf(task)?.name || '未知项目'), element('span', '', '计划版本 ' + (task.revision ?? 0)), element('span', '', '阻塞 ' + (task.blockedCount ?? 0) + ' / ' + (task.maxRetries ?? 2)));
  header.append(topline, heading, subline);
  if (task.pauseRequested) header.append(element('div', 'pause-banner', '已请求暂停，等待执行端确认停止。默认 90 秒内未确认会转为人工处理并保留占用；请勿让其他应用同时修改项目。'));
  if (task.status === 'needs_human' && task.owner) header.append(element('div', 'pause-banner', '需要人工检查外部执行状态。系统未强制终止应用，也未自动释放执行权。'));
  const body = element('div', 'detail-body');
  const main = element('div', 'detail-main');
  main.append(
    contentSection('任务目标与范围', task.description, '尚未填写需求'),
    contentSection('验收标准', task.acceptance, '尚未填写验收标准'),
    contentSection('执行计划', task.plan, '等待 Codex 领取任务并提交计划。', 'plan-section'),
    contentSection('本轮结果 / 阻塞说明', task.summary, '尚未提交执行结果。'),
    contentSection('检查证据', task.evidence, '尚未提交证据。执行端报告完成后，仍需人工验收。', 'evidence-section')
  );
  const side = element('aside', 'detail-side');
  side.append(element('h3', '', '任务操作'));
  const copy = button('复制交接包', 'button secondary', async () => {
    try { const packet = await api('/api/tasks/' + encodeURIComponent(id) + '/packet'); await copyText(packet.text); }
    catch (error) { toast(error.message, true); }
  });
  side.append(copy);
  const addAction = (label, action, className = 'secondary') => {
    const node = button(label, 'button ' + className, () => openAction(id, action));
    node.dataset.mutation = 'true'; node.disabled = !online;
    side.append(node);
  };
  if (task.status === 'review') addAction('验收通过', 'approve', 'primary');
  if (task.status === 'paused') addAction('恢复任务', 'resume', 'primary');
  if (task.status === 'needs_human') addAction('确认已停止，重新安排', 'retry');
  if (['needs_human', 'blocked', 'review'].includes(task.status)) addAction('交给 Codex 接手', 'takeover');
  if (['review', 'ready', 'blocked'].includes(task.status) && !task.owner) addAction('修订执行计划', 'revise');
  if (!['done', 'paused', 'needs_human'].includes(task.status) && !task.pauseRequested) addAction(activeStatuses.has(task.status) ? '请求执行端暂停' : '暂停任务', 'request_pause');
  addAction('添加说明', 'comment');
  side.append(element('p', 'side-note', '操作只影响系统内的任务流转。执行应用需主动调用 MCP 工具；系统不会点击或唤醒桌面聊天。'));
  const facts = element('dl');
  for (const [label, value] of [
    ['当前执行者', actorNames[task.owner] || '尚未领取'],
    ['项目目录', projectOf(task)?.path || '未知目录'],
    ['最近任务心跳', task.heartbeatAt ? time(task.heartbeatAt, true) : '尚无记录'],
    ['创建时间', time(task.createdAt, true)],
    ['更新时间', time(task.updatedAt, true)]
  ]) { const pair = element('div'); pair.append(element('dt', '', label), element('dd', '', value)); facts.append(pair); }
  side.append(facts); body.append(main, side);
  const timeline = element('section', 'detail-timeline');
  timeline.append(element('h3', '', '交接与操作记录'));
  const events = state.events.filter(event => event.taskId === id).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (!events.length) timeline.append(element('p', 'muted-content', '尚无记录'));
  for (const event of events) {
    const item = element('div', 'detail-event');
    const head = element('div', 'event-heading');
    head.append(element('span', '', (actorNames[event.actor] || event.actor || '系统') + ' · ' + (eventNames[event.type] || event.type || '记录')), element('time', '', time(event.createdAt, true)));
    item.append(head, element('p', '', event.message || '')); timeline.append(item);
  }
  root.replaceChildren(header, body, timeline);
  if (preserve) dialog.scrollTop = scrollTop;
}
function openAction(taskId, action) {
  const task = taskById(taskId);
  if (!task) return;
  if (!online) { toast('请先连接本地服务。', true); return; }
  const configs = {
    approve: ['验收通过', '请记录你实际执行的检查及结果。该操作会将任务标记为已完成。', '人工验收说明', '确认验收通过'],
    revise: ['修订执行计划', '修改后的计划将交回 WorkBuddy 等待领取，原有记录仍保留。', '新的完整执行计划', '保存修订计划'],
    comment: ['添加任务说明', '补充背景、约束或决策，供下一次交接参考。', '说明内容', '保存说明'],
    retry: ['重新安排任务', '请先检查并停止外部应用对该任务的执行和文件修改，再重新释放任务供应用领取。', '', '确认重新安排'],
    takeover: ['交给 Codex 接手', '请先确认原执行端已经停止。任务随后进入 Codex 接手队列，仍需 Codex 主动领取。', '', '确认交由 Codex 接手'],
    request_pause: ['暂停任务', activeStatuses.has(task.status) ? '系统会向当前执行端标记暂停请求。只有执行端确认停止后才释放执行权；默认 90 秒内未确认会转为人工处理并保留占用，不会强行结束应用进程。' : '任务暂停后将暂时不能被领取，现有计划和记录会保留。', '', activeStatuses.has(task.status) ? '发送暂停请求' : '确认暂停'],
    resume: ['恢复任务', '任务将回到对应的待领取队列，由接入的应用主动继续处理。', '', '确认恢复']
  };
  const config = configs[action];
  if (!config) return;
  pendingAction = { taskId, action };
  const dialog = prepareForm('action-dialog');
  $('#action-title').textContent = config[0];
  $('#action-description').textContent = config[1];
  $('#action-label-text').textContent = config[2];
  $('#action-submit').textContent = config[3];
  const needText = ['approve', 'revise', 'comment'].includes(action);
  $('#action-text-label').classList.toggle('hidden', !needText);
  $('#action-text').required = needText;
  $('#action-text').value = action === 'revise' ? textValue(task.plan) : '';
  const needsStop = ['retry', 'takeover'].includes(action);
  $('#stopped-label').classList.toggle('hidden', !needsStop);
  $('#stopped-check').required = needsStop;
  dialog.showModal();
}
async function submitForm(form, operation, done) {
  const submit = $('button[type=submit]', form);
  const errorTarget = $('.form-error', form);
  if (!online) { errorTarget.textContent = '本地服务未连接，请稍后重试。'; return; }
  submit.disabled = true; errorTarget.textContent = '';
  try { const result = await operation(); done(result); await refresh(true); }
  catch (error) { errorTarget.textContent = error.message; }
  finally { submit.disabled = false; }
}
async function renderIntegration() {
  const container = $('#integration-content');
  if (!integration) {
    container.replaceChildren(element('p', 'section-note', '正在读取本地接入配置…'));
    try { integration = await api('/api/integration'); }
    catch (error) {
      const panel = element('div', 'panel integration-steps');
      panel.append(element('p', 'section-note', error.message), button('重新读取', 'button secondary', renderIntegration));
      container.replaceChildren(panel); return;
    }
  }
  const intro = element('div', 'integration-intro');
  const introText = element('div');
  introText.append(element('h2', '', '一次配置，让交接回到同一个工作台'), element('p', '', '将本地 MCP 服务添加到应用中，再在应用聊天里明确要求它领取任务。无需另配模型 API。配置只提供接入参考，系统不会改写现有应用配置或聊天记录。'));
  intro.append(element('div', 'intro-mark', '⇄'), introText);
  const grid = element('div', 'integration-grid');
  for (const id of ['codex', 'workbuddy']) {
    const card = element('section', 'panel integration-card');
    const heading = element('div', 'card-title');
    const config = integration.configs?.[id] || {};
    const quoteShell = value => "'" + String(value).replaceAll("'", "''") + "'";
    const serverConfig = Object.values(config.mcpServers || {})[0];
    const codexCommand = serverConfig?.command
      ? ['codex mcp add cross-app-codex',
          ...Object.entries(serverConfig.env || {}).map(([key, value]) => '--env ' + quoteShell(key + '=' + value)),
          '--', quoteShell(serverConfig.command),
          ...(Array.isArray(serverConfig.args) ? serverConfig.args.map(quoteShell) : [])].join(' ')
      : '未收到完整的 MCP 服务配置，请刷新页面或检查本地服务。';
    const configText = id === 'codex' ? codexCommand : JSON.stringify(config, null, 2);
    heading.append(element('h2', '', actorNames[id]), button(id === 'codex' ? '复制命令' : '复制配置', 'button secondary small', () => copyText(configText)));
    card.append(heading, element('p', '', id === 'codex'
      ? '用于领取规划、诊断与接手任务。Codex CLI 使用 TOML 配置，不能将通用 mcpServers JSON 直接粘贴进 config.toml。可在 PowerShell 中手动执行下方命令添加服务；本系统不会自动执行该命令。'
      : '用于领取实施任务、上报阻塞并提交检查证据。请在当前 WorkBuddy 版本支持的自定义 MCP 入口添加下方 JSON 配置，保留已有配置。'), element('pre', 'code-block', configText));
    grid.append(card);
  }
  const steps = element('section', 'panel integration-steps');
  steps.append(element('h2', '', '接入与使用步骤'));
  const list = element('ol');
  for (const step of [
    '保持本地服务运行，在两个应用中分别添加对应的 MCP 服务。',
    '在本系统登记项目目录，创建任务并填写需求与验收标准。',
    '让 Codex 调用 list_tasks、claim_task，完成规划后调用 submit_plan。',
    '让 WorkBuddy 调用 list_tasks、claim_task 实施，遇到阻塞调用 report_blocked，完成后调用 submit_result。',
    '需要修订时交回 Codex；达到阻塞上限后，由你决定重试或接手。交付结果最终由你验收。'
  ]) list.append(element('li', '', step));
  steps.append(list);
  if (integration.instructions) steps.append(element('p', 'section-note', textValue(integration.instructions)));
  const limits = element('div', 'limitation-list');
  limits.append(element('strong', '', '当前能力边界'));
  const limitationList = element('ul');
  const limitations = Array.isArray(integration.limitations) ? integration.limitations : [];
  for (const limitation of [...limitations, 'MCP 连接成功不等于模型已经领取任务；需在对应应用中发起调用。', '协调锁只约束通过本系统领取的任务，不能阻止应用绕开系统直接修改文件。']) limitationList.append(element('li', '', textValue(limitation)));
  limits.append(limitationList); steps.append(limits);
  container.replaceChildren(intro, grid, steps);
}
$$('.nav-item').forEach(node => node.addEventListener('click', () => navigate(node.dataset.view)));
$('#primary-action').addEventListener('click', () => view === 'projects' ? openProjectForm() : openTaskForm());
$('#setup-button').addEventListener('click', () => navigate('integration'));
$('#refresh-button').addEventListener('click', () => refresh(true));
$('#project-filter').addEventListener('change', renderTasks);
$('#task-search').addEventListener('input', renderTasks);
$$('#status-filters button').forEach(node => node.addEventListener('click', () => setFilter(node.dataset.filter)));
$$('[data-close]').forEach(node => node.addEventListener('click', () => $('#' + node.dataset.close).close()));
$('#detail-dialog').addEventListener('close', () => { selectedTask = null; });
$('#project-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = new FormData(form);
  submitForm(form, () => api('/api/projects', { name: fields.get('name').trim(), path: fields.get('path').trim() }), () => {
    $('#project-dialog').close(); toast('项目目录已添加');
  });
});
$('#task-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = new FormData(form);
  submitForm(form, () => api('/api/tasks', {
    projectId: fields.get('projectId'), title: fields.get('title').trim(),
    description: fields.get('description').trim(), acceptance: fields.get('acceptance').trim(),
    maxRetries: Number(fields.get('maxRetries'))
  }), () => {
    $('#task-dialog').close(); setFilter('all'); $('#task-search').value = ''; $('#project-filter').value = fields.get('projectId'); navigate('tasks'); toast('任务已创建，等待 Codex 主动领取');
  });
});
$('#action-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!pendingAction) return;
  const { taskId, action } = pendingAction;
  const payload = { action };
  const value = $('#action-text').value.trim();
  if (action === 'approve') payload.evidence = value;
  if (action === 'revise') payload.plan = value;
  if (action === 'comment') payload.message = value;
  if (['retry', 'takeover'].includes(action)) payload.stopped = $('#stopped-check').checked;
  submitForm(event.currentTarget, () => api('/api/tasks/' + encodeURIComponent(taskId) + '/action', payload), () => {
    $('#action-dialog').close(); pendingAction = null;
    toast(action === 'request_pause' ? '暂停操作已提交，请查看任务状态' : '操作已保存');
  });
});
window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
navigate(location.hash.slice(1) || 'tasks');
renderAll();
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 4000);
