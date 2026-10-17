import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { GithubReadonlyClient, type HttpFetch } from '../packages/dev/src/github.ts';
import { repositoryTargets } from '../packages/dev/src/registry.ts';
import { DevGithubStore } from '../packages/dev/src/store.ts';

test('D1 registry, snapshot, stale handling and webhook dedupe persist across instances', {
  skip: !process.env.DATABASE_URL
}, async () => {
  const db = new PrismaClient();
  const target = repositoryTargets()[0];
  let available = true;
  const mock: HttpFetch = async (url) => {
    if (!available) return new Response('{}', { status: 503 });
    const path = new URL(url).pathname;
    let value: unknown = {};
    if (path === '/repos/' + target.fullName) value = { default_branch: 'main' };
    else if (path.endsWith('/branches/dev')) value = {
      commit: { sha: '0123456789012345678901234567890123456789' }
    };
    else if (path.endsWith('/pulls')) value = [];
    else return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(value));
  };
  try {
    const store = new DevGithubStore(db, new GithubReadonlyClient('not-a-real-token', mock));
    await store.seed();
    await store.seed();
    assert.equal(await db.devProject.count({ where: { slug: 'flowboard' } }), 1);
    const first = await store.syncOne(target);
    assert.equal(first.ok, true);
    const record = await db.devRepository.findUniqueOrThrow({ where: { fullName: target.fullName },
      include: { snapshot: true } });
    assert.ok(record.snapshot);
    assert.equal(record.snapshot?.stale, false);
    const previous = JSON.stringify(record.snapshot?.payload);
    available = false;
    const failed = await store.syncOne(target);
    assert.equal(failed.ok, false);
    const stale = await db.devGithubSnapshot.findUniqueOrThrow({ where: { repositoryId: record.id } });
    assert.equal(stale.stale, true);
    assert.equal(stale.errorCode, 'GH_HTTP_503');
    assert.equal(JSON.stringify(stale.payload), previous);
    available = true;
    assert.equal((await store.syncOne(target)).ok, true);
    const restored = await db.devGithubSnapshot.findUniqueOrThrow({ where: { repositoryId: record.id } });
    assert.equal(restored.stale, false);
    assert.equal(restored.errorCode, null);

    const event = {
      repository: target.fullName, deliveryId: randomUUID(),
      type: 'push', payloadSha256: 'b'.repeat(64)
    };
    assert.equal(await store.recordWebhook(event), true);
    const reopened = new DevGithubStore(new PrismaClient(), new GithubReadonlyClient('placeholder', mock));
    try {
      assert.equal(await reopened.recordWebhook(event), false);
      await assert.rejects(() => reopened.recordWebhook({ ...event, payloadSha256: 'c'.repeat(64) }),
        /WEBHOOK_DELIVERY_COLLISION/);
    } finally {
      // Client created in reopened is managed separately below in this test revision.
    }
  } finally {
    await db.devGithubDelivery.deleteMany({ where: { repository: { fullName: target.fullName } } });
    await db.devGithubSnapshot.deleteMany({ where: { repository: { fullName: target.fullName } } });
    await db.$disconnect();
  }
});
