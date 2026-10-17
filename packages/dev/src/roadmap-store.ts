/**
 * D2 transactional roadmap store. It never starts agents, merges code or marks
 * a phase accepted. Only a trusted future D3 authorization flow may do that.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  buildDevelopmentPlan, topologicalOrder, DevPlannerError,
  type PhaseNode, type TaskNode, type RepositoryObservation, type DevPlan,
  type PhaseState, type TaskState, type DevScope
} from './planner.ts';
import { parseRoadmapManifest } from './manifest.ts';
import { DEVELOPMENT_PROJECTS } from './registry.ts';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const strings = (x: unknown): string[] => Array.isArray(x) ?
  x.filter((v): v is string => typeof v === 'string') : [];
const str = (x: unknown) => typeof x === 'string' ? x : '';
function scopes(value: unknown): DevScope[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(x => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return [];
    const obj = x as Record<string, unknown>;
    const repo = str(obj.repo), paths = strings(obj.paths);
    return repo && paths.length ? [{ repo, paths }] : [];
  });
}
function evidence(value: unknown): PhaseNode['acceptanceEvidence'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(x => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return [];
    const e = x as Record<string, unknown>;
    return [{ repo: str(e.repo), sha: str(e.sha), verifiedAt: str(e.verifiedAt) }];
  });
}

export class DevRoadmapStore {
  private readonly db: PrismaClient;
  constructor(db: PrismaClient) { this.db = db; }

  /** Atomic additive import. Phase acceptance and task run-state are immutable here. */
  async importManifest(raw: unknown): Promise<{ phases: number; tasks: number; dependencies: number }> {
    const manifest = parseRoadmapManifest(raw);
    return this.db.$transaction(async tx => {
      // Fixed SQL, no user input. Serialize graph edits across instances.
      await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(2026101802)::text');
      for (const project of DEVELOPMENT_PROJECTS) {
        await tx.devProject.upsert({
          where: { slug: project.slug },
          create: { slug: project.slug, name: project.name },
          update: { name: project.name }
        });
        for (const repo of project.repos) {
          await tx.devRepository.upsert({
            where: { fullName: repo.fullName },
            create: { projectSlug: project.slug, fullName: repo.fullName,
              integrationBranch: repo.integrationBranch },
            update: {}
          });
        }
      }
      let taskCount = 0;
      for (const phase of manifest.phases) {
        const key = { projectSlug: phase.projectSlug, code: phase.code };
        const previous = await tx.devPhase.findUnique({ where: { projectSlug_code: key } });
        if (previous && previous.state !== 'planned' &&
            (!same(previous.acceptanceCriteria, phase.acceptanceCriteria) ||
             previous.workstream !== phase.workstream)) {
          throw new DevPlannerError('PHASE_LOCKED');
        }
        const record = await tx.devPhase.upsert({
          where: { projectSlug_code: key },
          create: {
            ...key, workstream: phase.workstream, title: phase.title,
            description: phase.description,
            acceptanceCriteria: phase.acceptanceCriteria as Prisma.InputJsonValue
          },
          update: previous?.state === 'planned' ? {
            workstream: phase.workstream, title: phase.title, description: phase.description,
            acceptanceCriteria: phase.acceptanceCriteria as Prisma.InputJsonValue
          } : {}
        });
        for (const task of phase.tasks) {
          const where = { phaseId_key: { phaseId: record.id, key: task.key } };
          const prevTask = await tx.devTask.findUnique({ where });
          if (prevTask && prevTask.state !== 'planned' &&
              (!same(prevTask.scopes, task.scopes) ||
               !same(prevTask.coordinationKeys, task.coordinationKeys) ||
               prevTask.priority !== task.priority || prevTask.title !== task.title ||
               prevTask.description !== task.description)) {
            throw new DevPlannerError('TASK_LOCKED');
          }
          await tx.devTask.upsert({
            where,
            create: {
              phaseId: record.id, key: task.key, title: task.title,
              description: task.description, priority: task.priority,
              scopes: task.scopes as unknown as Prisma.InputJsonValue,
              coordinationKeys: task.coordinationKeys as Prisma.InputJsonValue
            },
            update: prevTask?.state === 'planned' ? {
              title: task.title, description: task.description, priority: task.priority,
              scopes: task.scopes as unknown as Prisma.InputJsonValue,
              coordinationKeys: task.coordinationKeys as Prisma.InputJsonValue
            } : {}
          });
          taskCount++;
        }
      }

      for (const phase of manifest.phases) {
        const current = await tx.devPhase.findUniqueOrThrow({
          where: { projectSlug_code: { projectSlug: phase.projectSlug, code: phase.code } },
          include: { prerequisites: true }
        });
        const next: string[] = [];
        for (const dep of phase.dependsOn) {
          const required = await tx.devPhase.findUnique({
            where: { projectSlug_code: { projectSlug: dep.projectSlug, code: dep.code } }
          });
          if (!required) throw new DevPlannerError('UNKNOWN_DEPENDENCY');
          next.push(required.id);
        }
        const previous = current.prerequisites.map(edge => edge.requiresPhaseId).sort();
        next.sort();
        if (!same(previous, next)) {
          if (current.state !== 'planned') throw new DevPlannerError('PHASE_LOCKED');
          await tx.devDependency.deleteMany({ where: { phaseId: current.id } });
          for (const requiresPhaseId of next) {
            await tx.devDependency.create({ data: { phaseId: current.id, requiresPhaseId } });
          }
        }
      }
      // Check full persisted DAG before transaction commits, including cross-project edges.
      const [phases, edges] = await Promise.all([
        tx.devPhase.findMany(), tx.devDependency.findMany()
      ]);
      topologicalOrder(phases.map(phase => ({
        id: phase.id, projectSlug: phase.projectSlug, code: phase.code,
        state: phase.state as PhaseState,
        acceptanceCriteria: [], acceptedAt: null, acceptanceEvidence: []
      })), edges);
      return {
        phases: manifest.phases.length, tasks: taskCount,
        dependencies: manifest.phases.reduce((count, phase) => count + phase.dependsOn.length, 0)
      };
    }, { timeout: 30_000 });
  }

  /** Internal D2 blocker operations, not exposed via HTTP/MCP. */
  async addBlocker(taskId: string, kind: string, detail: string): Promise<string> {
    if (!/^[0-9a-f-]{36}$/i.test(taskId) || !/^[a-z_]{2,50}$/.test(kind) ||
        !detail.trim() || detail.length > 500) {
      throw new DevPlannerError('INVALID_BLOCKER');
    }
    if (!await this.db.devTask.findUnique({ where: { id: taskId } })) {
      throw new DevPlannerError('UNKNOWN_TASK');
    }
    const blocker = await this.db.devBlocker.create({ data: { taskId, kind, detail } });
    return blocker.id;
  }

  async resolveBlocker(blockerId: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(blockerId)) throw new DevPlannerError('INVALID_BLOCKER');
    const updated = await this.db.devBlocker.updateMany({
      where: { id: blockerId, state: 'open' },
      data: { state: 'resolved', resolvedAt: new Date() }
    });
    return updated.count === 1;
  }

  /** Planning only: no task claiming, side effects or state mutation. */
  async plan(options?: {
    now?: Date; maxSnapshotAgeMs?: number; maxActivePerRepo?: number;
  }): Promise<DevPlan> {
    // Consistent snapshot: a concurrent manifest transaction cannot make
    // phase rows and edges look as if they came from different graph versions.
    const [phaseRows, dependencyRows, repoRows] = await this.db.$transaction(
      async tx => Promise.all([
        tx.devPhase.findMany({
          include: { tasks: { include: { blockers: { where: { state: 'open' } } } } }
        }),
        tx.devDependency.findMany(),
        tx.devRepository.findMany({ include: { snapshot: true } })
      ]),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
    );
    const phases: PhaseNode[] = phaseRows.map(phase => ({
      id: phase.id, projectSlug: phase.projectSlug, code: phase.code,
      state: phase.state as PhaseState,
      acceptanceCriteria: strings(phase.acceptanceCriteria),
      acceptedAt: phase.acceptedAt?.toISOString() ?? null,
      acceptanceEvidence: evidence(phase.acceptanceEvidence)
    }));
    const tasks: TaskNode[] = phaseRows.flatMap(phase => phase.tasks.map(task => ({
      id: task.id, phaseId: phase.id, key: task.key, title: task.title,
      priority: task.priority, state: task.state as TaskState,
      scopes: scopes(task.scopes), coordinationKeys: strings(task.coordinationKeys),
      openBlockers: task.blockers.map(blocker => blocker.id)
    })));
    const repositories: RepositoryObservation[] = repoRows.map(repo => {
      const payload = repo.snapshot?.payload;
      const obj = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown> : {};
      return {
        fullName: repo.fullName, enabled: repo.enabled,
        stale: repo.snapshot?.stale ?? true,
        observedAt: repo.snapshot?.observedAt.toISOString() ?? null,
        integrationSha: str(obj.integrationSha) || null
      };
    });
    return buildDevelopmentPlan({
      phases, tasks, repositories,
      dependencies: dependencyRows.map(edge => ({
        phaseId: edge.phaseId, requiresPhaseId: edge.requiresPhaseId
      })),
      ...options
    });
  }
}
