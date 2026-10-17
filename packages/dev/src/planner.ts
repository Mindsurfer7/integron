/**
 * D2 deterministic development planner. Pure computation, no GitHub writes,
 * automatic agents, merge authority or external side effects.
 *
 * "Ready" means locally schedulable against registered evidence and scopes;
 * it does NOT authorize dispatch or assert CI/acceptance is green.
 */
export type PhaseState = 'planned' | 'active' | 'accepted' | 'cancelled';
export type TaskState =
  | 'planned' | 'running' | 'paused' | 'pr_open' | 'ci_pending'
  | 'review' | 'verified' | 'completed' | 'failed' | 'cancelled';

export interface DevScope {
  repo: string;
  paths: string[];
}

export interface PhaseNode {
  id: string;
  projectSlug: string;
  code: string;
  state: PhaseState;
  acceptanceCriteria: string[];
  acceptedAt: string | null;
  acceptanceEvidence: { repo: string; sha: string; verifiedAt: string }[];
}
export interface DependencyEdge {
  phaseId: string;
  requiresPhaseId: string;
}
export interface TaskNode {
  id: string;
  phaseId: string;
  key: string;
  title: string;
  priority: number;
  state: TaskState;
  scopes: DevScope[];
  coordinationKeys: string[];
  openBlockers: string[];
}
export interface RepositoryObservation {
  fullName: string;
  enabled: boolean;
  stale: boolean;
  observedAt: string | null;
  integrationSha: string | null;
}
export type BlockerCode =
  | 'dependency_unverified' | 'phase_unavailable' | 'phase_already_accepted'
  | 'manual_blocker' | 'scope_missing' | 'repository_unobserved'
  | 'repository_stale' | 'repository_missing_branch'
  | 'active_conflict' | 'selected_conflict' | 'repository_capacity';

export interface TaskDecision {
  taskId: string;
  projectSlug: string;
  phaseCode: string;
  taskKey: string;
  state: 'ready' | 'blocked' | 'active' | 'terminal';
  reasons: { code: BlockerCode; ref?: string }[];
}
export interface DevPlan {
  orderedPhaseIds: string[];
  decisions: TaskDecision[];
  readyTaskIds: string[];
  observedAt: string;
}
export interface PlannerInput {
  phases: PhaseNode[];
  dependencies: DependencyEdge[];
  tasks: TaskNode[];
  repositories: RepositoryObservation[];
  now?: Date;
  maxSnapshotAgeMs?: number;
  maxActivePerRepo?: number;
}
export class DevPlannerError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = 'DevPlannerError';
  }
}
const ACTIVE = new Set<TaskState>([
  'running', 'paused', 'pr_open', 'ci_pending', 'review', 'verified'
]);
const TERMINAL = new Set<TaskState>(['completed', 'failed', 'cancelled']);
const HEX_SHA = /^[a-f0-9]{40}$/i;
const DEFAULT_MAX_AGE = 30 * 60_000;

/** Check the entire graph, not only edges present in one imported manifest. */
export function topologicalOrder(phases: PhaseNode[], edges: DependencyEdge[]): string[] {
  const byId = new Map(phases.map(phase => [phase.id, phase]));
  if (byId.size !== phases.length) throw new DevPlannerError('DUPLICATE_PHASE');
  const prereqs = new Map(phases.map(phase => [phase.id, new Set<string>()]));
  for (const edge of edges) {
    const required = prereqs.get(edge.phaseId);
    if (!required || !byId.has(edge.requiresPhaseId)) {
      throw new DevPlannerError('UNKNOWN_DEPENDENCY');
    }
    if (edge.phaseId === edge.requiresPhaseId) throw new DevPlannerError('CYCLIC_DEPENDENCY');
    if (required.has(edge.requiresPhaseId)) throw new DevPlannerError('DUPLICATE_DEPENDENCY');
    required.add(edge.requiresPhaseId);
  }
  const visited = new Set<string>(), visiting = new Set<string>(), ordered: string[] = [];
  function visit(id: string): void {
    if (visiting.has(id)) throw new DevPlannerError('CYCLIC_DEPENDENCY');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const prerequisite of [...(prereqs.get(id) ?? [])].sort()) visit(prerequisite);
    visiting.delete(id);
    visited.add(id);
    ordered.push(id);
  }
  for (const phase of [...phases].sort((a, b) => a.id.localeCompare(b.id))) visit(phase.id);
  return ordered;
}
export function acceptedWithEvidence(phase: PhaseNode): boolean {
  return phase.state === 'accepted' &&
    Boolean(phase.acceptedAt && !Number.isNaN(Date.parse(phase.acceptedAt))) &&
    phase.acceptanceCriteria.length > 0 &&
    phase.acceptanceEvidence.length > 0 &&
    phase.acceptanceEvidence.every(evidence =>
      evidence.repo.length > 0 && HEX_SHA.test(evidence.sha) &&
      evidence.verifiedAt.length > 0 &&
      !Number.isNaN(Date.parse(evidence.verifiedAt))
    );
}

function exclusiveDatabaseScope(path: string): boolean {
  const normalized = path.toLowerCase();
  return normalized === 'prisma/schema.prisma' ||
    normalized.startsWith('prisma/migrations/') ||
    normalized === 'prisma/migrations' ||
    normalized.startsWith('db/migrations/') ||
    normalized === 'db/migrations';
}

/** Intentionally conservative prefix/glob overlap: uncertain scope == conflict. */
export function pathsOverlap(first: string, second: string): boolean {
  if (exclusiveDatabaseScope(first) && exclusiveDatabaseScope(second)) return true;
  if (first === '**' || second === '**' || first === '*' || second === '*') return true;
  const prefix = (path: string) => path.endsWith('/**') ? path.slice(0, -3) : path;
  const a = prefix(first), b = prefix(second);
  if (!a || !b) return true;
  if (a === b) return true;
  if (first.endsWith('/**') && b.startsWith(a + '/')) return true;
  if (second.endsWith('/**') && a.startsWith(b + '/')) return true;
  // Treat a directory path conservatively as owning descendants.
  if (b.startsWith(a + '/') || a.startsWith(b + '/')) return true;
  // Unsupported wildcards fail closed rather than claiming independence.
  if (a.includes('*') || b.includes('*') || a.includes('?') || b.includes('?')) return true;
  return false;
}
export function tasksConflict(a: TaskNode, b: TaskNode): boolean {
  if (a.id === b.id) return false;
  if (a.coordinationKeys.some(key => b.coordinationKeys.includes(key))) return true;
  return a.scopes.some(left => b.scopes.some(right =>
    left.repo === right.repo &&
    left.paths.some(x => right.paths.some(y => pathsOverlap(x, y)))
  ));
}

export function buildDevelopmentPlan(input: PlannerInput): DevPlan {
  const now = input.now ?? new Date();
  const maxAge = input.maxSnapshotAgeMs ?? DEFAULT_MAX_AGE;
  const capacity = input.maxActivePerRepo ?? 2;
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(maxAge) || maxAge <= 0 ||
      !Number.isInteger(capacity) || capacity < 1) {
    throw new DevPlannerError('INVALID_PLANNER_OPTIONS');
  }
  const orderedPhaseIds = topologicalOrder(input.phases, input.dependencies);
  const phases = new Map(input.phases.map(phase => [phase.id, phase]));
  const repos = new Map(input.repositories.map(repo => [repo.fullName, repo]));
  const tasks = [...input.tasks];
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) {
    throw new DevPlannerError('DUPLICATE_TASK');
  }
  if (new Set(input.repositories.map(repo => repo.fullName)).size !== repos.size) {
    throw new DevPlannerError('DUPLICATE_REPOSITORY');
  }
  for (const task of tasks) {
    if (!phases.has(task.phaseId)) throw new DevPlannerError('UNKNOWN_TASK_PHASE');
  }

  const directDeps = new Map(input.phases.map(phase => [phase.id, [] as string[]]));
  for (const edge of input.dependencies) directDeps.get(edge.phaseId)!.push(edge.requiresPhaseId);
  const active = tasks.filter(task => ACTIVE.has(task.state));
  const used = new Map<string, number>();
  function taskRepos(task: TaskNode): string[] {
    return [...new Set(task.scopes.map(scope => scope.repo))];
  }
  for (const task of active) {
    for (const repo of taskRepos(task)) used.set(repo, (used.get(repo) ?? 0) + 1);
  }
  const selected: TaskNode[] = [];
  const decisions: TaskDecision[] = [];
  for (const task of tasks.sort((a, b) => a.priority - b.priority ||
    a.phaseId.localeCompare(b.phaseId) || a.key.localeCompare(b.key) ||
    a.id.localeCompare(b.id))) {
    const phase = phases.get(task.phaseId)!;
    const decision: TaskDecision = {
      taskId: task.id, projectSlug: phase.projectSlug, phaseCode: phase.code,
      taskKey: task.key,
      state: 'blocked', reasons: []
    };
    if (ACTIVE.has(task.state)) {
      decision.state = 'active';
      decisions.push(decision);
      continue;
    }
    if (TERMINAL.has(task.state)) {
      decision.state = 'terminal';
      decisions.push(decision);
      continue;
    }
    if (task.state !== 'planned') throw new DevPlannerError('UNKNOWN_TASK_STATE');
    if (phase.state === 'accepted') {
      decision.reasons.push({ code: 'phase_already_accepted' });
    } else if (phase.state !== 'planned' && phase.state !== 'active') {
      decision.reasons.push({ code: 'phase_unavailable' });
    }
    for (const requiredId of [...(directDeps.get(task.phaseId) ?? [])].sort()) {
      if (!acceptedWithEvidence(phases.get(requiredId)!)) {
        decision.reasons.push({ code: 'dependency_unverified', ref: requiredId });
      }
    }
    for (const blocker of [...task.openBlockers].sort()) {
      decision.reasons.push({ code: 'manual_blocker', ref: blocker });
    }
    if (!task.scopes.length || task.scopes.some(scope => !scope.paths.length)) {
      decision.reasons.push({ code: 'scope_missing' });
    }
    for (const name of taskRepos(task)) {
      const observed = repos.get(name);
      if (!observed || !observed.enabled || !observed.observedAt) {
        decision.reasons.push({ code: 'repository_unobserved', ref: name });
      } else {
        const observedTime = Date.parse(observed.observedAt);
        if (observed.stale || !Number.isFinite(observedTime) ||
            observedTime > now.getTime() + 60_000 ||
            now.getTime() - observedTime > maxAge) {
          decision.reasons.push({ code: 'repository_stale', ref: name });
        }
        if (!observed.integrationSha || !HEX_SHA.test(observed.integrationSha)) {
          decision.reasons.push({ code: 'repository_missing_branch', ref: name });
        }
      }
      if ((used.get(name) ?? 0) >= capacity) {
        decision.reasons.push({ code: 'repository_capacity', ref: name });
      }
    }
    for (const other of active) {
      if (tasksConflict(task, other)) {
        decision.reasons.push({ code: 'active_conflict', ref: other.id });
      }
    }
    for (const other of selected) {
      if (tasksConflict(task, other)) {
        decision.reasons.push({ code: 'selected_conflict', ref: other.id });
      }
    }
    if (decision.reasons.length === 0) {
      decision.state = 'ready';
      selected.push(task);
      for (const repo of taskRepos(task)) used.set(repo, (used.get(repo) ?? 0) + 1);
    }
    decisions.push(decision);
  }
  return { orderedPhaseIds, decisions,
    readyTaskIds: selected.map(task => task.id), observedAt: now.toISOString() };
}
