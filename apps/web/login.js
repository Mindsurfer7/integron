const form = document.querySelector('#login');
const input = document.querySelector('#token');
const error = document.querySelector('#error');
form.addEventListener('submit', async event => {
  event.preventDefault();
  error.textContent = '';
  try {
    const response = await fetch('/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify({ token: input.value })
    });
    input.value = '';
    if (!response.ok) {
      error.textContent = response.status === 429
        ? 'Слишком много попыток. Повторите позднее.' : 'Неверный ключ доступа';
      return;
    }
    window.location.replace('/');
  } catch {
    input.value = '';
    error.textContent = 'Не удалось выполнить вход';
  }
});
