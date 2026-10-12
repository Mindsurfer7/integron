import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DemoError, DemoTaskStore } from '../packages/core/src/demo.ts';

const newStore = () => new DemoTaskStore();
test('creates a fully isolated fake conversation with evidence', () => {
  const task = newStore().create('Проверь наличие и цены');
  assert.equal(task.mode, 'demo');
  assert.equal(task.state, 'waiting_owner');
  assert.equal(task.results.length, 3);
  assert.ok(task.results.every(r => r.evidenceKind === 'mock' && r.evidence.startsWith('fixture:')));
  assert.equal(task.events.filter(e => e.type === 'message.sent.mock').length, 3);
  assert.equal(task.events.filter(e => e.type === 'message.received.mock').length, 3);
});
test('correlated owner answer resumes only its own task', () => {
  const store = newStore();
  const a = store.create('Задача первая');
  const b = store.create('Задача вторая');
  assert.throws(() => store.answer(a.id, b.question.id, 'fastest'), (error) => error instanceof DemoError && error.code === 'WRONG_QUESTION');
  const done = store.answer(b.id, b.question.id, 'fastest');
  assert.equal(done.state, 'completed');
  assert.equal(done.recommendation?.organizationId, 'mock-beta');
  assert.equal(store.get(a.id).state, 'waiting_owner');
});
test('cheapest selection and deferred selection are distinct', () => {
  const store = newStore();
  const cheap = store.create('Выбери самое дешёвое');
  const defer = store.create('Отложи выбор организации');
  assert.equal(store.answer(cheap.id, cheap.question.id, 'cheapest').recommendation?.organizationId, 'mock-alpha');
  assert.equal(store.answer(defer.id, defer.question.id, 'defer').recommendation, undefined);
});
test('stopping a task cancels question and prevents stale answers', () => {
  const store = newStore();
  const task = store.create('Проверка остановки');
  assert.equal(store.stop(task.id).state, 'cancelled');
  assert.equal(store.stop(task.id).events.filter(e => e.type === 'task.cancelled').length, 1);
  assert.throws(() => store.answer(task.id, task.question.id, 'cheapest'), /Вопрос уже закрыт/);
});
test('does not allow repeat action or invalid owner options', () => {
  const store = newStore();
  const task = store.create('Проверка ответов');
  assert.throws(() => store.answer(task.id, task.question.id, 'pay_now'), /Недопустимый/);
  store.answer(task.id, task.question.id, 'cheapest');
  assert.throws(() => store.answer(task.id, task.question.id, 'fastest'), /Вопрос уже закрыт/);
});
test('validates goals, rejects missing IDs and does not return mutable state', () => {
  const store = newStore();
  assert.throws(() => store.create('  '), /от 3 до 500/);
  assert.throws(() => store.create('x'.repeat(501)), /от 3 до 500/);
  assert.throws(() => store.get('missing'), /не найдена/);
  const task = store.create('Нужна информация');
  task.results[0].priceThb = -1;
  assert.equal(store.get(task.id).results[0].priceThb, 950);
});
