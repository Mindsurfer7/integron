import { Prisma, type PrismaClient } from '@prisma/client';
import { GithubObserverError, type GithubSnapshot, type RepositoryTarget, type GithubReadonlyClient } from './github.ts';
import { DEVELOPMENT_PROJECTS, repositoryTargets } from './registry.ts';
import { type GithubEvent } from './webhooks.ts';

export class DevGithubStore {
  constructor(private readonly db: PrismaClient, private readonly client: GithubReadonlyClient) {}

  /** Seeding is constrained to a reviewed allowlist and is idempotent. */
  async seed(): Promise<void> {
    for (const project of DEVELOPMENT_PROJECTS) {
      await this.db.devProject.upsert({
        where: { slug: project.slug },
        create: { slug: project.slug, name: project.name },
        update: { name: project.name }
      });
      for (const repo of project.repos) {
        await this.db.devRepository.upsert({
          where: { fullName: repo.fullName },
          create: {
            projectSlug: project.slug, fullName: repo.fullName,
            integrationBranch: repo.integrationBranch
          },
          update: { projectSlug: project.slug, integrationBranch: repo.integrationBranch }
        });
      }
    }
  }

  /** Never discard last known evidence when GitHub is temporarily unreachable. */
  async syncOne(target: RepositoryTarget): Promise<
    { repo: string; ok: true; snapshot: GithubSnapshot } |
    { repo: string; ok: false; errorCode: string }
  > {
    if (!repositoryTargets().some(known =>
      known.project === target.project && known.fullName === target.fullName &&
      known.integrationBranch === target.integrationBranch)) {
      throw new GithubObserverError('TARGET_NOT_ALLOWED');
    }
    const registered = await this.db.devRepository.findUnique({
      where: { fullName: target.fullName }
    });
    if (!registered || !registered.enabled) throw new GithubObserverError('REPO_NOT_REGISTERED');
    try {
      const snapshot = await this.client.snapshot(target);
      await this.db.devGithubSnapshot.upsert({
        where: { repositoryId: registered.id },
        create: {
          repositoryId: registered.id, payload: snapshot as unknown as Prisma.InputJsonValue,
          observedAt: new Date(snapshot.observedAt), stale: false
        },
        update: {
          payload: snapshot as unknown as Prisma.InputJsonValue,
          observedAt: new Date(snapshot.observedAt), stale: false, errorCode: null
        }
      });
      return { repo: target.fullName, ok: true, snapshot };
    } catch (err) {
      const code = err instanceof GithubObserverError ? err.code : 'GH_REQUEST_FAILED';
      // Do not log provider response bodies, request headers, tokens or sensitive data.
      await this.db.devGithubSnapshot.updateMany({
        where: { repositoryId: registered.id },
        data: { stale: true, errorCode: code }
      });
      return { repo: target.fullName, ok: false, errorCode: code };
    }
  }

  async syncAll() {
    const results = [];
    for (const target of repositoryTargets()) results.push(await this.syncOne(target));
    return results;
  }

  /** Delivery ID and payload digest are immutable. Duplicate delivery is no-op. */
  async recordWebhook(event: GithubEvent): Promise<boolean> {
    if (!repositoryTargets().some(repo => repo.fullName === event.repository)) {
      throw new Error('WEBHOOK_REPOSITORY_NOT_ALLOWED');
    }
    const repo = await this.db.devRepository.findUnique({ where: { fullName: event.repository } });
    if (!repo || !repo.enabled) throw new Error('WEBHOOK_REPOSITORY_NOT_ALLOWED');
    try {
      await this.db.devGithubDelivery.create({
        data: {
          repositoryId: repo.id, deliveryId: event.deliveryId,
          eventType: event.type, payloadSha256: event.payloadSha256
        }
      });
      return true;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
      const existing = await this.db.devGithubDelivery.findUnique({
        where: { deliveryId: event.deliveryId }
      });
      if (!existing || existing.repositoryId !== repo.id ||
          existing.eventType !== event.type || existing.payloadSha256 !== event.payloadSha256) {
        throw new Error('WEBHOOK_DELIVERY_COLLISION');
      }
      return false;
    }
  }

  async listStatus() {
    return this.db.devProject.findMany({
      orderBy: { slug: 'asc' },
      include: {
        repositories: {
          orderBy: { fullName: 'asc' },
          include: { snapshot: true }
        }
      }
    });
  }
}
