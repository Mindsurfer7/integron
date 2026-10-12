import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { DemoError } from '../packages/core/src/demo.ts';
import { PrismaDemoTaskService } from '../packages/storage/src/prisma.ts';

test('PostgreSQL stores mock tasks and disallows duplicate owner answers', {
  skip: !process.env.DATABASE_URL
}, async () => {
  const prisma = new PrismaClient();
  try {
    await prisma.$connect();
    await prisma.demoTask.deleteMany({});
    const service = new PrismaDemoTaskService(prisma);
    const a = await service.create('Узнай стоимость доставки');
    const b = await service.create('Узнай доступность услуги');
    assert.equal(a.results.length, 3);
    assert.equal((await service.list()).length, 2);
    await assert.rejects(
      () => service.answer(a.id, b.question.id, 'cheapest'),
      (err: unknown) => err instanceof DemoError && err.code === 'WRONG_QUESTION'
    );
    const answered = await service.answer(a.id, a.question.id, 'fastest');
    assert.equal(answered.state, 'completed');
    await assert.rejects(
      () => service.answer(a.id, a.question.id, 'cheapest'),
      (err: unknown) => err instanceof DemoError && err.code === 'QUESTION_CLOSED'
    );
    const stopped = await service.stop(b.id);
    assert.equal(stopped.state, 'cancelled');
    assert.equal((await service.get(a.id)).state, 'completed');
    const otherClient = new PrismaClient();
    try {
      const reopened = new PrismaDemoTaskService(otherClient);
      // Persistence is in Postgres, not in the service instance.
      assert.equal((await reopened.get(a.id)).state, 'completed');
      await assert.rejects(
        () => reopened.answer(b.id, b.question.id, 'cheapest'),
        (err: unknown) => err instanceof DemoError && err.code === 'QUESTION_CLOSED'
      );
    } finally { await otherClient.$disconnect(); }
  } finally {
    await prisma.demoTask.deleteMany({});
    await prisma.$disconnect();
  }
});
