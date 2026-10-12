import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DemoError, type DemoTask, type DemoTaskRepository } from '../../core/src/demo.ts';

const SCHEMA_VERSION = 1;
/** Durable, single-process P0 store. Never sends real messages or makes calls. */
export class SqliteDemoTaskRepository implements DemoTaskRepository {
  private readonly db: DatabaseSync;
  constructor(file: string) {
    if (!file || file === ':memory:') throw new Error('Provide a persistent SQLite database path');
    const path = resolve(file);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
      const current = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
      if (current.user_version > SCHEMA_VERSION) throw new Error('SQLite database schema newer than this Integron version');
      if (current.user_version === 0) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          this.db.exec('CREATE TABLE IF NOT EXISTS demo_tasks (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL)');
          this.db.exec('PRAGMA user_version = 1');
          this.db.exec('COMMIT');
        } catch (error) {
          this.db.exec('ROLLBACK');
          throw error;
        }
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  list(): DemoTask[] {
    return (this.db.prepare('SELECT payload FROM demo_tasks ORDER BY rowid ASC').all() as { payload: string }[])
      .map(row => JSON.parse(row.payload) as DemoTask);
  }
  find(id: string): DemoTask | undefined {
    const row = this.db.prepare('SELECT payload FROM demo_tasks WHERE id = ?').get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as DemoTask : undefined;
  }
  insert(task: DemoTask, maximum: number): void {
    this.transact(() => {
      const row = this.db.prepare('SELECT COUNT(*) AS count FROM demo_tasks').get() as { count: number };
      if (row.count >= maximum) throw new DemoError(429, 'DEMO_LIMIT', 'Лимит: 100 демонстрационных задач');
      this.db.prepare('INSERT INTO demo_tasks (id, payload, created_at) VALUES (?, ?, ?)')
        .run(task.id, JSON.stringify(task), task.createdAt);
    });
  }
  mutate(id: string, operation: (task: DemoTask) => void): DemoTask {
    return this.transact(() => {
      const task = this.find(id);
      if (!task) throw new DemoError(404, 'TASK_NOT_FOUND', 'Задача не найдена');
      operation(task);
      this.db.prepare('UPDATE demo_tasks SET payload = ? WHERE id = ?').run(JSON.stringify(task), id);
      return structuredClone(task);
    });
  }
  close(): void { this.db.close(); }
  private transact<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
