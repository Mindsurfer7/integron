const form = document.querySelector('#task-form');
const list = document.querySelector('#tasks');
const detail = document.querySelector('#detail');
const error = document.querySelector('#error');
const results = document.querySelector('#results');
const question = document.querySelector('#question');
const events = document.querySelector('#events');
const status = document.querySelector('#task-status');
const stopButton = document.querySelector('#stop');
let activeTaskId = null;

const element = (tag, content, className) => {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content; // no untrusted innerHTML
  if (className) node.className = className;
  return node;
};
async function request(path, method = 'GET', data) {
  const response = await fetch(path, {
    method,
    headers: data ? { 'Content-Type': 'application/json' } : {},
    body: data ? JSON.stringify(data) : undefined
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || 'Ошибка запроса');
  return payload;
}
async function refresh() {
  const { tasks } = await request('/api/tasks');
  list.replaceChildren();
  if (!tasks.length) list.append(element('p', 'Запусти первое демонстрационное поручение.'));
  for (const task of tasks.slice().reverse()) {
    const button = element('button', `${task.goal} · ${task.state}`);
    button.type = 'button';
    button.addEventListener('click', () => { activeTaskId = task.id; refresh().catch(showError); });
    list.append(button);
  }
  const active = tasks.find((task) => task.id === activeTaskId);
  detail.hidden = !active;
  if (!active) return;
  status.textContent = `Состояние: ${active.state} · задача ${active.id} · только demo`;
  results.replaceChildren();
  for (const item of active.results) {
    const tile = element('div', undefined, 'tile');
    tile.append(element('strong', item.organization));
    tile.append(element('div', `${item.priceThb} THB · ${item.turnaroundHours} ч.`));
    tile.append(element('small', `${item.channel} · ${item.evidence} (симуляция)`));
    results.append(tile);
  }
  question.replaceChildren();
  if (active.state === 'waiting_owner') {
    question.append(element('h3', 'Уточнение для владельца (веб-демо)'));
    question.append(element('p', active.question.text));
    for (const choice of active.question.options) {
      const button = element('button', choice.label, 'primary');
      button.addEventListener('click', async () => {
        try {
          error.textContent = '';
          await request(`/api/tasks/${active.id}/answer`, 'POST', { questionId: active.question.id, choice: choice.id });
          await refresh();
        } catch (err) { showError(err); }
      });
      question.append(button);
    }
  } else if (active.recommendation) {
    question.append(element('h3', `Выбран вариант: ${active.recommendation.organization}`));
    question.append(element('p', 'Это рекомендация по вымышленным данным, не реальное предложение.'));
  } else {
    question.append(element('p', `Результат: ${active.state === 'cancelled' ? 'остановлено' : 'выбор отложен'}.`));
  }
  events.replaceChildren();
  for (const entry of active.events) events.append(element('li', `${entry.type}: ${entry.message}`));
  stopButton.disabled = active.state !== 'waiting_owner';
}
function showError(err) { error.textContent = err instanceof Error ? err.message : String(err); }
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    error.textContent = '';
    const goal = document.querySelector('#goal').value;
    const { task } = await request('/api/tasks', 'POST', { goal });
    activeTaskId = task.id;
    await refresh();
  } catch (err) { showError(err); }
});
stopButton.addEventListener('click', async () => {
  try { await request(`/api/tasks/${activeTaskId}/stop`, 'POST'); await refresh(); }
  catch (err) { showError(err); }
});
refresh().catch(showError);


// The durable orchestrator API is intentionally available only with PostgreSQL.
const workflowPanel = document.querySelector('#workflow-panel');
const workflowList = document.querySelector('#workflow-list');
const workflowDetail = document.querySelector('#workflow-detail');
let activeWorkflowId = null;
let workflowTimer = null;
async function refreshWorkflows() {
  const response = await fetch('/api/workflows');
  if (response.status === 404) return;
  if (!response.ok) throw new Error('Не удалось загрузить очередь поручений');
  const { workflows } = await response.json();
  workflowPanel.hidden = false;
  workflowList.replaceChildren();
  if (!workflows.length) workflowList.append(element('p', 'Очередь пуста.'));
  for (const run of workflows) {
    const button = element('button', run.goal + ' · ' + run.state + ' / ' + run.step);
    button.type = 'button';
    button.addEventListener('click', () => { activeWorkflowId = run.id; refreshWorkflows().catch(showError); });
    workflowList.append(button);
  }
  workflowDetail.replaceChildren();
  const active = workflows.find(item => item.id === activeWorkflowId);
  if (!active) return;
  workflowDetail.append(element('h3', 'Поручение #' + active.id.slice(0, 8)));
  workflowDetail.append(element('p', 'Состояние: ' + active.state + ', шаг: ' + active.step));
  if (active.plan) workflowDetail.append(element('p', 'Канал: ' + (active.transport === 'mock' ? 'mock' : active.transport === 'telegram_test' ? 'Telegram Bot test' : 'Telegram USER TDLib test') + ' · внешняя отправка: ' + (active.transport === 'mock' ? 'нет' : 'только allowlist')));
  if (active.plan?.research?.fields) {
    workflowDetail.append(element('p', 'План исследования: ' + active.plan.research.fields.join(', ')));
  }
  if (active.delivery) {
    workflowDetail.append(element('p', 'Доставка: ' + active.delivery.state +
      (active.delivery.state === 'unknown' ? ' · результат неизвестен, автоматической повторной отправки нет' : '')));
  }
  if (active.messages?.length) {
    const transcript = element('div');
    transcript.append(element('h3', 'Переписка (реальные Telegram-сообщения)'));
    for (const m of active.messages) {
      transcript.append(element('p', (m.direction === 'in' ? 'Получено: ' : 'Отправлено: ') + m.body));
    }
    workflowDetail.append(transcript);
  }
  if (active.facts?.length) {
    const facts = element('div');
    facts.append(element('h3', 'Факты и источники'));
    for (const f of active.facts) {
      const original = active.messages?.find(m => m.id === f.messageId);
      if (!original || original.body.slice(f.startOffset, f.endOffset) !== f.quote) continue;
      facts.append(element('p', f.field + ': ' + f.value + ' · непроверенное утверждение собеседника'));
      facts.append(element('small', 'Цитата: «' + f.quote + '» · сообщение ' + original.providerMessageId));
    }
    workflowDetail.append(facts);
  }
  if (active.demoTaskId) {
    const details = element('button', 'Открыть результаты и вопрос');
    details.addEventListener('click', async () => { activeTaskId = active.demoTaskId; await refresh(); });
    workflowDetail.append(details);
  }
  if (!['completed', 'cancelled', 'failed'].includes(active.state)) {
    const pause = element('button', active.state === 'paused' ? 'Продолжить поручение' : 'Пауза');
    pause.addEventListener('click', async () => {
      try {
        await request('/api/workflows/' + active.id +
          (active.state === 'paused' ? '/resume' : '/pause'), 'POST');
        await refreshWorkflows();
      } catch (err) { showError(err); }
    });
    workflowDetail.append(pause);
    const cancel = element('button', 'Остановить поручение');
    cancel.addEventListener('click', async () => {
      try { await request('/api/workflows/' + active.id + '/stop', 'POST'); await refreshWorkflows(); }
      catch (err) { showError(err); }
    });
    workflowDetail.append(cancel);
  }
  const audit = element('ul');
  for (const e of active.events) {
    audit.append(element('li', new Date(e.createdAt).toLocaleString() + ' · ' + e.kind));
  }
  workflowDetail.append(audit);
}
document.querySelector('#workflow-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    error.textContent = '';
    const goal = document.querySelector('#workflow-goal').value;
    const transport = document.querySelector('#workflow-transport').value;
    const targetChatId = transport !== 'mock' ? document.querySelector('#workflow-chat').value.trim() : undefined;
    const { workflow } = await request('/api/workflows', 'POST', { goal, transport, targetChatId });
    activeWorkflowId = workflow.id;
    await refreshWorkflows();
  } catch (err) { showError(err); }
});
refreshWorkflows().then(() => {
  if (!workflowPanel.hidden) workflowTimer = setInterval(() => {
    refreshWorkflows().catch(showError);
    refresh().catch(showError);
  }, 3000);
}).catch(showError);

const workflowTransport = document.querySelector('#workflow-transport');
workflowTransport.addEventListener('change', () => {
  document.querySelector('#workflow-target').hidden = workflowTransport.value === 'mock';
});
