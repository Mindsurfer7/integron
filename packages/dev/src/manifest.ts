/**
 * D2 local roadmap import contract. Manifest input is always untrusted:
 * its text cannot set accepted phases, start work, or authorize a GitHub action.
 */
import { DEVELOPMENT_PROJECTS } from './registry.ts';
import { DevPlannerError, type DevScope } from './planner.ts';

export interface ManifestDependency { projectSlug: string; code: string }
export interface ManifestTask {
  key: string;
  title: string;
  description: string;
  priority: number;
  scopes: DevScope[];
  coordinationKeys: string[];
}
export interface ManifestPhase {
  projectSlug: string;
  code: string;
  workstream: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn: ManifestDependency[];
  tasks: ManifestTask[];
}
export interface DevRoadmapManifest { version: 1; phases: ManifestPhase[] }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DevPlannerError('INVALID_MANIFEST');
  }
  return value as Record<string, unknown>;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new DevPlannerError('INVALID_MANIFEST');
  return value;
}
function named(value: unknown, max = 200): string {
  if (typeof value !== 'string' || value.trim() !== value ||
      !value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new DevPlannerError('INVALID_MANIFEST');
  }
  return value;
}
function slug(value: unknown): string {
  const s = named(value, 80);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(s)) throw new DevPlannerError('INVALID_MANIFEST');
  return s;
}
function unique(values: string[]): void {
  if (new Set(values).size !== values.length) throw new DevPlannerError('DUPLICATE_MANIFEST_KEY');
}
function repoPath(value: unknown): string {
  const path = named(value, 300);
  if (path.startsWith('/') || path.includes('\\') || path.startsWith('./') ||
      path.endsWith('/') || path.includes('//') ||
      path.split('/').some(segment => segment === '..' || segment === '.' || !segment)) {
    throw new DevPlannerError('INVALID_SCOPE_PATH');
  }
  if (path === '*' || path === '**') return path;
  // The only allowed glob form is "directory/**"; speculative globs are unsafe.
  const allowed = /^[a-zA-Z0-9_./@+-]+(?:\/\*\*)?$/;
  if (!allowed.test(path)) throw new DevPlannerError('INVALID_SCOPE_PATH');
  return path;
}

export function parseRoadmapManifest(input: unknown): DevRoadmapManifest {
  const data = object(input);
  if (data.version !== 1) throw new DevPlannerError('INVALID_MANIFEST_VERSION');
  const phases: ManifestPhase[] = [];
  const known = new Map(DEVELOPMENT_PROJECTS.map(p => [p.slug, new Set(p.repos.map(r => r.fullName))]));
  for (const item of list(data.phases, 150)) {
    const phase = object(item);
    const projectSlug = slug(phase.projectSlug);
    const allowed = known.get(projectSlug);
    if (!allowed) throw new DevPlannerError('UNKNOWN_PROJECT');
    const code = named(phase.code, 80);
    const workstream = named(phase.workstream, 80);
    const acceptanceCriteria = list(phase.acceptanceCriteria, 30)
      .map(x => named(x, 350));
    if (!acceptanceCriteria.length) throw new DevPlannerError('ACCEPTANCE_CRITERIA_REQUIRED');
    unique(acceptanceCriteria);
    const dependsOn = list(phase.dependsOn ?? [], 80).map(item => {
      const edge = object(item);
      const project = slug(edge.projectSlug);
      if (!known.has(project)) throw new DevPlannerError('UNKNOWN_PROJECT');
      return { projectSlug: project, code: named(edge.code, 80) };
    });
    unique(dependsOn.map(dep => dep.projectSlug + '/' + dep.code));
    const tasks = list(phase.tasks ?? [], 150).map(item => {
      const task = object(item);
      const key = named(task.key, 80);
      const title = named(task.title, 200);
      const priority = task.priority === undefined ? 100 : task.priority;
      if (!Number.isInteger(priority) || (priority as number) < 0 ||
          (priority as number) > 10_000) throw new DevPlannerError('INVALID_PRIORITY');
      const scopes: DevScope[] = list(task.scopes, 30).map(item => {
        const scope = object(item);
        const repo = named(scope.repo, 200);
        if (!allowed.has(repo)) throw new DevPlannerError('REPOSITORY_OUT_OF_PROJECT');
        const paths = list(scope.paths, 60).map(repoPath);
        if (!paths.length) throw new DevPlannerError('EMPTY_TASK_SCOPE');
        unique(paths);
        return { repo, paths };
      });
      if (!scopes.length) throw new DevPlannerError('EMPTY_TASK_SCOPE');
      unique(scopes.map(x => x.repo));
      const coordinationKeys = list(task.coordinationKeys ?? [], 30)
        .map(x => {
          const value = named(x, 150);
          if (!/^[a-zA-Z0-9_./:-]+$/.test(value)) {
            throw new DevPlannerError('INVALID_COORDINATION_KEY');
          }
          return value;
        });
      unique(coordinationKeys);
      return {
        key, title, description: task.description === undefined ? '' : named(task.description, 1000),
        priority: priority as number, scopes, coordinationKeys
      };
    });
    unique(tasks.map(task => task.key));
    phases.push({
      projectSlug, code, workstream, title: named(phase.title, 200),
      description: phase.description === undefined ? '' : named(phase.description, 1000),
      acceptanceCriteria, dependsOn, tasks
    });
  }
  if (!phases.length) throw new DevPlannerError('EMPTY_MANIFEST');
  unique(phases.map(phase => phase.projectSlug + '/' + phase.code));
  return { version: 1, phases };
}
