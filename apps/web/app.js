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
