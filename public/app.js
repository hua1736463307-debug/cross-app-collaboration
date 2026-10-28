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
  stale: '连接超时', restart: '服务重启', timed_out: '连接超时',
  scheduler_enabled: '开启调度', scheduler_disabled: '停止派发',
  automation_enabled: '允许自动协作', automation_disabled: '关闭自动协作',
  dispatch_reserved: '预约执行', dispatch_started: '启动执行', dispatch_finished: '执行会话结束',
  dispatch_uncertain: '执行待核对', dispatch_resolved: '人工确认已停止',
  scheduler_toggle: '调度开关', automation_toggle: '任务自动协作设置'
};
const titles = {
  tasks: ['任务工作台', '让计划与实施，有序衔接。', 'Codex 负责规划与诊断，WorkBuddy 负责实施，你掌握关键决定。'],
  projects: ['项目目录', '每个项目，都有清晰的协作边界。', '登记本机项目目录，让任务、计划和交接记录归属到同一个项目。'],
  integration: ['应用接入', '连接你的协作应用。', '通过本地 MCP 桥接，让应用主动领取任务、报告阻塞并提交成果。'],
  scheduler: ['自动协作', '交接之后，让下一步自动开始。', '为指定任务启动独立执行会话，遇到不确定状态停下来，成果由你验收。']
};
let state = { projects: [], tasks: [], events: [], agents: [], meta: {} };
let online = false;
let hasState = false;
let loading = false;
let view = 'tasks';
let filter = 'all';
let selectedTask = null;
let pendingAction = null;
let pendingSchedulerAction = null;
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
function automaticActorName(actor) {
  return state.scheduler?.adapters?.[actor]?.label || (actor === 'workbuddy' ? '自动实施端' : actorNames[actor] || '未知执行端');
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
  $$('button[data-mutation]').forEach(node => { node.disabled = !success || node.dataset.unavailable === 'true'; });
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
  renderScheduler();
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
    if (task.autoEnabled) meta.append(element('span', 'auto-label', '自动协作'));
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
    return card;
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
  action.classList.toggle('hidden', ['integration', 'scheduler'].includes(view));
  action.textContent = view === 'projects' ? '＋ 添加项目' : '＋ 创建任务';
  if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
  if (view === 'integration') renderIntegration();
  if (view === 'scheduler') renderScheduler();
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
  const automation = element('section', 'task-automation');
  const taskRuns = (state.scheduler?.runs || []).filter(run => run.taskId === id);
  const canEnable = !task.owner && ['planning_queue', 'ready', 'blocked', 'codex_fix_queue'].includes(task.status)
    && !taskRuns.some(run => ['launching', 'running', 'uncertain'].includes(run.state));
  automation.append(element('h3', '', '自动协作'), element('span', 'status-badge ' + (task.autoEnabled ? 'teal' : ''), task.autoEnabled ? '此任务已授权' : '此任务未授权'));
  const modelButton = button('设置此任务模型', 'button secondary', () => openModelSettings(task));
  modelButton.disabled = !online; automation.append(modelButton);
  if (task.autoEnabled || !['done', 'review'].includes(task.status)) {
    const toggle = button(task.autoEnabled ? '关闭此任务自动协作' : '允许此任务自动协作', 'button secondary', () => openSchedulerAction({ type: 'task', taskId: id, enabled: !task.autoEnabled }));
    toggle.dataset.mutation = 'true';
    toggle.dataset.unavailable = String(!state.scheduler || (!task.autoEnabled && !canEnable));
    toggle.disabled = !online || toggle.dataset.unavailable === 'true';
    if (!task.autoEnabled && !canEnable) toggle.title = '请先处理当前执行或人工状态，将任务恢复到可领取队列。';
    automation.append(toggle);
  }
  automation.append(element('p', 'side-note', task.autoEnabled
    ? (state.scheduler?.enabled ? '全局调度已开启。可领取阶段会自动启动独立执行会话，结果仍需人工验收。' : '全局调度已停止，新执行会话暂不派发。')
    : (canEnable ? '仅此任务明确授权后才会被自动派发；已有任务默认关闭。' : '请先处理当前执行或人工状态，将任务恢复到可领取队列，再允许自动协作。')));
  const uncertain = taskRuns.filter(run => run.state === 'uncertain');
  if (uncertain.length) automation.append(button('查看待核对的执行记录', 'button secondary', () => { dialog.close(); navigate('scheduler'); }));
  side.append(automation, element('p', 'side-note', '自动实施端：' + automaticActorName('workbuddy') + '。它使用独立 CLI 登录与执行会话，WorkBuddy 桌面仍可通过手动 MCP 协作。停止派发不会强行终止进程；要停止当前工作，请请求任务暂停并检查执行端。'));
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
    takeover: ['交给 Codex 接手', '请先确认原执行端已经停止。任务随后进入 Codex 接手队列；已授权且全局调度开启时，会自动安排执行会话。', '', '确认交由 Codex 接手'],
    request_pause: ['暂停任务', activeStatuses.has(task.status) ? '系统会向当前执行端标记暂停请求。只有执行端确认停止后才释放执行权；默认 90 秒内未确认会转为人工处理并保留占用，不会强行结束应用进程。' : '任务暂停后将暂时不能被领取，现有计划和记录会保留。', '', activeStatuses.has(task.status) ? '发送暂停请求' : '确认暂停'],
    resume: ['恢复任务', '任务将回到对应的待领取队列。已授权且全局调度开启时，会自动安排下一轮执行。', '', '确认恢复']
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
function openModelSettings(task = null) {
  if (!online) { toast('请先连接本地服务。', true); return; }
  const dialog = element('dialog', 'form-dialog');
  const form = element('form');
  const heading = element('div', 'dialog-heading');
  heading.append(element('h2', '', task ? '任务模型设置' : '默认模型设置'), button('×', 'icon-button', () => dialog.close()));
  form.append(heading, element('p', 'dialog-description', task ? '留空表示跟随自动协作默认设置。修改只影响后续派发。' : '留空表示跟随对应客户端默认设置。修改只影响后续派发，不改变正在运行的会话。'));
  const values = task ? task.modelSettings || {} : state.scheduler?.modelSettings || {};
  const controls = {};
  for (const [key, label] of [['planning', 'Codex 规划'], ['implementation', 'CodeBuddy 实施'], ['diagnosis', 'Codex 诊断与接手']]) {
    const section = element('section'); section.append(element('h3', '', label));
    const modelLabel = element('label', '', '模型 ID');
    const model = element('input'); model.type = 'text'; model.maxLength = 100; model.placeholder = task ? '留空：跟随默认设置' : '留空：跟随客户端默认'; model.value = values[key]?.model || '';
    modelLabel.append(model);
    const effortLabel = element('label', '', '推理强度');
    const effort = element('select');
    for (const [value, name] of [['', task ? '跟随默认设置' : '跟随客户端默认'], ...((key === 'implementation' ? ['minimal','low','medium','high','xhigh','max'] : ['none','minimal','low','medium','high','xhigh','max','ultra']).map(x => [x, x]))]) {
      const option = element('option', '', name); option.value = value; effort.append(option);
    }
    effort.value = values[key]?.effort || '';
    effortLabel.append(effort); section.append(modelLabel, effortLabel); form.append(section); controls[key] = { model, effort };
  }
  form.append(element('p', 'field-note', '模型需填写客户端支持的准确 ID；账号权限和强度兼容性以实际执行结果为准，不会自动降级。'));
  const error = element('p', 'form-error'); error.setAttribute('role', 'alert');
  const footer = element('div', 'dialog-footer');
  const save = element('button', 'button primary', '保存设置'); save.type = 'submit';
  footer.append(button('取消', 'button secondary', () => dialog.close()), save); form.append(error, footer);
  form.addEventListener('submit', async event => {
    event.preventDefault(); save.disabled = true; error.textContent = '';
    const payload = Object.fromEntries(Object.entries(controls).map(([key, value]) => [key, { model: value.model.value.trim(), effort: value.effort.value }]));
    try { await api(task ? '/api/tasks/' + encodeURIComponent(task.id) + '/model-settings' : '/api/scheduler/model-settings', payload); dialog.close(); await refresh(true); toast('模型设置已保存，新派发生效'); }
    catch (e) { error.textContent = e.message; } finally { save.disabled = false; }
  });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.append(form); document.body.append(dialog); dialog.showModal();
}
function renderScheduler() {
  const container = $('#scheduler-content');
  const scheduler = state.scheduler;
  if (!scheduler) {
    container.replaceChildren(element('p', 'section-note', hasState ? '当前服务尚未提供自动协作能力，请更新并重新启动本地服务。' : '正在读取调度状态…'));
    return;
  }
  const overview = element('section', 'panel scheduler-overview');
  const heading = element('div', 'scheduler-heading');
  const summary = element('div');
  summary.append(element('h2', '', '无人值守调度'), element('p', '', scheduler.enabled ? '正在为已授权任务安排下一轮执行。' : '新执行会话暂停派发，手动协作仍可使用。'));
  const toggle = button(scheduler.enabled ? '停止派发新会话' : '开启自动调度', 'button ' + (scheduler.enabled ? 'secondary' : 'primary'), () => openSchedulerAction({ type: 'global', enabled: !scheduler.enabled }));
  toggle.dataset.mutation = 'true'; toggle.disabled = !online;
  heading.append(summary, toggle);
  const counts = element('div', 'scheduler-counts');
  const runs = Array.isArray(scheduler.runs) ? scheduler.runs : [];
  const permitted = state.tasks.filter(task => task.autoEnabled && !['review', 'done'].includes(task.status)).length;
  counts.append(element('span', 'status-badge ' + (scheduler.enabled ? 'teal' : ''), scheduler.enabled ? '调度已开启' : '调度已关闭'), element('span', '', permitted + ' 项未完成任务已授权'), element('span', '', runs.filter(run => ['launching', 'running'].includes(run.state)).length + ' 个执行会话进行中'), element('span', '', runs.filter(run => run.state === 'uncertain').length + ' 项待人工核对'));
  overview.append(heading, counts, element('p', 'scheduler-boundary', '开启后，系统为明确授权的任务启动独立 CLI 执行会话，自动衔接规划、实施与阻塞诊断。不会控制已有桌面聊天，也不会自动批准验收。关闭调度只停止新派发；当前工作需通过任务暂停并确认停止。'));
  const modelSettingsButton = button('设置默认模型与推理强度', 'button secondary', () => openModelSettings());
  modelSettingsButton.disabled = !online; overview.append(modelSettingsButton);
  const adapters = element('div', 'integration-grid scheduler-adapters');
  for (const actor of ['codex', 'workbuddy']) {
    const adapter = scheduler.adapters?.[actor];
    const card = element('section', 'panel integration-card');
    const title = element('div', 'card-title');
    title.append(element('h2', '', automaticActorName(actor)), element('span', 'status-badge ' + (adapter?.available ? 'teal' : 'amber'), adapter?.available ? '启动入口可用' : '启动入口不可用'));
    card.append(title, element('p', '', actor === 'codex' ? '规划与诊断' : '自动实施端 · 需要独立 CLI 登录，不使用 WorkBuddy 桌面登录状态'), element('p', '', adapter?.reason || (adapter?.available ? '入口已检测到。登录、审批或运行错误以实际执行记录为准。' : '尚未检测到可用入口，请检查本机客户端安装。')));
    adapters.append(card);
  }
  const guide = element('section', 'panel scheduler-guide');
  guide.append(element('h2', '', '开始一项自动协作'), element('p', '', '先完成自动实施端的独立登录，再创建任务并写清可修改范围与验收标准。在任务详情中点击“允许此任务自动协作”，再开启全局调度。WorkBuddy 桌面的手动 MCP 接入仍然保留。旧任务不会因升级而自动开始；请保持本地服务与电脑运行，审批和异常可能需要你处理。'), button('前往任务工作台 →', 'text-button', () => navigate('tasks')));
  const history = element('section', 'panel scheduler-history');
  const historyHeading = element('div', 'panel-heading');
  historyHeading.append(element('h2', '', '执行记录'), element('span', 'count-label', '显示最近 ' + Math.min(runs.length, 30) + ' 条'));
  history.append(historyHeading);
  if (!runs.length) history.append(element('p', 'scheduler-empty', '尚无自动执行记录。授权任务并开启调度后，这里会显示启动、交接与异常情况。'));
  const labels = { launching: ['正在启动', 'blue'], running: ['执行中', 'blue'], finished: ['会话已结束', 'teal'], uncertain: ['需要核对', 'red'], resolved: ['已确认停止', ''], handed_off: ['已交接，等待退出', 'amber'] };
  for (const run of [...runs].sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)).slice(0, 30)) {
    const row = element('article', 'scheduler-run');
    const top = element('div', 'scheduler-run-heading');
    const task = taskById(run.taskId);
    const title = task ? button(task.title, 'text-button scheduler-task-link', () => openDetail(task.id)) : element('strong', '', '任务 ' + run.taskId);
    const [label, color] = labels[run.state] || [run.state || '未知状态', ''];
    top.append(title, element('span', 'status-badge ' + color, label));
    const details = element('div', 'scheduler-run-meta');
    const executionLabel = run.adapterLabel || ((run.actor === 'workbuddy' ? '实施端' : '规划与诊断端') + ' · 当前启动器：' + automaticActorName(run.actor));
    details.append(element('span', '', executionLabel), element('span', '', '开始 ' + time(run.startedAt, true)), element('span', '', run.pid ? '进程 ' + run.pid : '尚无进程编号'), element('span', '', run.handedOff ? '已收到任务交接' : '尚未确认任务交接'));
    details.append(element('span', '', '请求模型：' + (run.requestedModel?.model || '客户端默认') + ' / 强度：' + (run.requestedModel?.effort || '客户端默认')),
      element('span', '', '客户端报告模型：' + (run.reportedModel || '未确认') + ' / 强度：' + (run.reportedEffort || '未确认')));
    if (run.finishedAt) details.append(element('span', '', '结束 ' + time(run.finishedAt, true)));
    row.append(top, details);
    if (run.error) row.append(element('p', 'scheduler-run-error', textValue(run.error)));
    if (run.state === 'uncertain') {
      const resolve = button('核对并确认已停止', 'button secondary small', () => openSchedulerAction({ type: 'resolve', runId: run.id, taskId: run.taskId }));
      resolve.dataset.mutation = 'true'; resolve.disabled = !online;
      row.append(element('p', 'scheduler-run-note', '系统已阻止重复派发。确认该会话及相关子任务均已停止后，才能释放预约；随后在任务详情决定重新安排。'), resolve);
    }
    history.append(row);
  }
  container.replaceChildren(overview, adapters, guide, history);
}
function openSchedulerAction(action) {
  if (!online) { toast('请先连接本地服务。', true); return; }
  const task = action.taskId ? taskById(action.taskId) : null;
  if (action.type === 'task' && !task) return;
  pendingSchedulerAction = action;
  const dialog = prepareForm('scheduler-dialog');
  let title, description, submit, confirmation = '';
  if (action.type === 'resolve') {
    title = '确认执行已停止'; submit = '确认停止并释放预约';
    description = '请核对应用中的执行会话、进程及相关子任务，确保它们不再写入项目。释放预约不会终止进程，也不会自动重试任务。任务：' + (task?.title || action.taskId);
    confirmation = '我已确认该执行会话及相关子任务全部停止，不再修改项目文件。';
  } else if (action.type === 'task') {
    title = action.enabled ? '允许此任务自动协作' : '关闭此任务自动协作';
    submit = action.enabled ? '授权此任务' : '关闭自动协作';
    description = action.enabled
      ? '任务：' + task.title + '\n项目目录：' + (projectOf(task)?.path || '未知目录') + '\n自动实施端：' + automaticActorName('workbuddy') + '\n全局调度开启后，系统可启动独立 CLI 会话完成规划、实施与诊断。自动实施端需要单独登录，WorkBuddy 桌面仍可手动 MCP 协作。授权将允许当前项目内的文件读写和本任务交接工具；其他权限仍由客户端检查。请确认需求中已写清允许修改的范围与停止条件；成果仍需人工验收。'
      : '此任务不再派发新执行会话。已经领取的活跃任务会请求暂停，但进程不会被强行结束；请继续检查执行端是否确认停止。';
    if (action.enabled) confirmation = '我允许应用在上述项目目录和本任务约定范围内自动协作。';
  } else {
    title = action.enabled ? '开启自动调度' : '停止派发新会话';
    submit = action.enabled ? '开启调度' : '停止新派发';
    description = action.enabled
      ? '系统只安排单独授权的任务。自动实施端为' + automaticActorName('workbuddy') + '，需要单独登录。每一阶段使用独立 CLI 会话及其审批规则，模型服务可能产生用量；不会使用 WorkBuddy 桌面的原对话或登录状态。遇到结果不确定时会停止并转人工核对，实施结果保留待验收。'
      : '停止启动新的执行会话，保留已授权任务和全部记录。正在运行的会话会继续，若需要停止当前工作，请在任务详情请求暂停并核对执行端。';
  }
  $('#scheduler-action-title').textContent = title;
  $('#scheduler-action-description').textContent = description;
  $('#scheduler-action-submit').textContent = submit;
  $('#scheduler-confirm-label').classList.toggle('hidden', !confirmation);
  $('#scheduler-confirm-text').textContent = confirmation;
  $('#scheduler-confirm-check').required = !!confirmation;
  dialog.showModal();
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
  introText.append(element('h2', '', '一次配置，让交接回到同一个工作台'), element('p', '', '手动协作时，将本地 MCP 服务添加到应用中，再在聊天里要求它领取任务。自动协作使用独立 CLI 执行会话，请在“自动协作”页检查启动入口并授权指定任务。无需另配模型 API，系统不会改写现有聊天记录。'));
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
$('#scheduler-form').addEventListener('submit', event => {
  event.preventDefault();
  const action = pendingSchedulerAction;
  if (!action) return;
  if ($('#scheduler-confirm-check').required && !$('#scheduler-confirm-check').checked) return;
  const path = action.type === 'task' ? '/api/tasks/' + encodeURIComponent(action.taskId) + '/automation'
    : action.type === 'resolve' ? '/api/scheduler/runs/' + encodeURIComponent(action.runId) + '/resolve' : '/api/scheduler';
  const payload = action.type === 'resolve' ? { stopped: true } : { enabled: action.enabled };
  submitForm(event.currentTarget, () => api(path, payload), () => {
    $('#scheduler-dialog').close(); pendingSchedulerAction = null;
    toast(action.type === 'resolve' ? '已确认停止；请在任务详情决定是否重新安排' : '自动协作设置已保存');
  });
});
window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
navigate(location.hash.slice(1) || 'tasks');
renderAll();
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 4000);
