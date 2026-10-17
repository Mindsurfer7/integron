/** Load a single transaction snapshot for D2 readiness at D5b reservation time. */
import { Prisma } from '@prisma/client';
import {
  buildDevelopmentPlan, type PhaseNode, type TaskNode, type RepositoryObservation,
  type PhaseState, type TaskState, type DevPlan, type DevScope
} from './planner.ts';

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const str = (v: unknown) => typeof v === 'string' ? v : '';
const strings = (v: unknown): string[] => Array.isArray(v) ?
  v.filter((x): x is string => typeof x === 'string') : [];
const scopes = (v: unknown): DevScope[] => Array.isArray(v) ? v.map(obj)
  .map(o => ({ repo: str(o.repo), paths: strings(o.paths) })) : [];

export async function planInExecutionTransaction(tx: Prisma.TransactionClient, now: Date): Promise<DevPlan> {
  const [phaseRows, dependencies, repositoryRows] = await Promise.all([
    tx.devPhase.findMany({
      include: { tasks: { include: { blockers: { where: { state: 'open' } } } } }
    }),
    tx.devDependency.findMany(),
    tx.devRepository.findMany({ include: { snapshot: true } })
  ]);
  const phases: PhaseNode[] = phaseRows.map(p => ({
    id: p.id, projectSlug: p.projectSlug, code: p.code,
    state: p.state as PhaseState, acceptanceCriteria: strings(p.acceptanceCriteria),
    acceptedAt: p.acceptedAt?.toISOString() ?? null,
    acceptanceEvidence: Array.isArray(p.acceptanceEvidence) ?
      p.acceptanceEvidence.map(obj).map(e => ({
        repo: str(e.repo), sha: str(e.sha), verifiedAt: str(e.verifiedAt)
      })) : []
  }));
  const tasks: TaskNode[] = phaseRows.flatMap(p => p.tasks.map(t => ({
    id: t.id, phaseId: p.id, key: t.key, title: t.title,
    priority: t.priority, state: t.state as TaskState,
    scopes: scopes(t.scopes), coordinationKeys: strings(t.coordinationKeys),
    openBlockers: t.blockers.map(b => b.id)
  })));
  const repositories: RepositoryObservation[] = repositoryRows.map(r => ({
    fullName: r.fullName, enabled: r.enabled, stale: r.snapshot?.stale ?? true,
    observedAt: r.snapshot?.observedAt.toISOString() ?? null,
    integrationSha: str(obj(r.snapshot?.payload).integrationSha) || null
  }));
  return buildDevelopmentPlan({
    phases, tasks, repositories, now,
    dependencies: dependencies.map(d => ({
      phaseId: d.phaseId, requiresPhaseId: d.requiresPhaseId
    }))
  });
}
