import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DemoTaskStore, DemoError } from '../packages/core/src/demo.ts';
import { SqliteDemoTaskRepository } from '../packages/storage/src/sqlite.ts';

const tempDb = () => {
  const directory = mkdtempSync(join(tmpdir(), 'integron-p0-'));
  return { path: join(directory, 'nested', 'tasks.sqlite'), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
};

test('SQLite retains question and mock evidence over restart', () => {
  const file = tempDb();
  try {
    const first = new SqliteDemoTaskRepository(file.path);
    const original = new DemoTaskStore(first).create('Узнай наличие и цены');
    first.close();

    const second = new SqliteDemoTaskRepository(file.path);
    const store = new DemoTaskStore(second);
    assert.deepEqual(store.get(original.id), original);
    assert.equal(store.list().length, 1);
    assert.ok(store.get(original.id).results.every(r => r.evidenceKind === 'mock'));
    assert.equal(statSync(file.path).mode & 0o777, 0o600);
    const done = store.answer(original.id, original.question.id, 'fastest');
    assert.equal(done.recommendation?.organizationId, 'mock-beta');
    second.close();

    const third = new SqliteDemoTaskRepository(file.path);
    assert.equal(new DemoTaskStore(third).get(original.id).state, 'completed');
    third.close();
  } finally { file.cleanup(); }
});

test('SQLite cancellation and stale answers persist across restarts', () => {
  const file = tempDb();
  try {
    const first = new SqliteDemoTaskRepository(file.path);
    const store = new DemoTaskStore(first);
    const task = store.create('Проверка отмены');
    store.stop(task.id);
    first.close();
    const second = new SqliteDemoTaskRepository(file.path);
    const after = new DemoTaskStore(second);
    assert.throws(() => after.answer(task.id, task.question.id, 'cheapest'), (err) => err instanceof DemoError && err.code === 'QUESTION_CLOSED');
    assert.equal(after.stop(task.id).events.filter(e => e.type === 'task.cancelled').length, 1);
    second.close();
  } finally { file.cleanup(); }
});

test('SQLite prevents wrong question and duplicate owner answers atomically', () => {
  const file = tempDb();
  try {
    const repo = new SqliteDemoTaskRepository(file.path);
    const store = new DemoTaskStore(repo);
    const a = store.create('Первая задача');
    const b = store.create('Вторая задача');
    assert.throws(() => store.answer(a.id, b.question.id, 'fastest'), /другому вопросу/);
    assert.equal(store.get(a.id).state, 'waiting_owner');
    store.answer(b.id, b.question.id, 'cheapest');
    assert.throws(() => store.answer(b.id, b.question.id, 'fastest'), /уже закрыт/);
    assert.equal(store.get(b.id).events.filter(e => e.type === 'owner.answered.mock').length, 1);
    repo.close();
  } finally { file.cleanup(); }
});

test('SQLite applies the task quota in a transaction', () => {
  const file = tempDb();
  try {
    const repo = new SqliteDemoTaskRepository(file.path);
    const store = new DemoTaskStore(repo);
    for (let i = 0; i < 100; i++) store.create('Запрос ' + i);
    assert.throws(() => store.create('Лишний запрос'), (err) => err instanceof DemoError && err.code === 'DEMO_LIMIT');
    assert.equal(store.list().length, 100);
    repo.close();
  } finally { file.cleanup(); }
});

test('SQLite safely rejects unknown newer schema versions', () => {
  const file = tempDb();
  try {
    const first = new SqliteDemoTaskRepository(file.path);
    first.close();
    const db = new DatabaseSync(file.path);
    db.exec('PRAGMA user_version = 999');
    db.close();
    assert.throws(() => new SqliteDemoTaskRepository(file.path), /newer than/);
  } finally { file.cleanup(); }
});
