import { type RepositoryTarget } from './github.ts';

/** Opt-in repository allowlist. Do not discover or write arbitrary repositories. */
export const DEVELOPMENT_PROJECTS = [
  { slug: 'qonbaq', name: 'Qonbaq', repos: [
    { fullName: 'Qonbex/qonbaq', integrationBranch: 'dev' },
    { fullName: 'Qonbex/qonbaq-mobile', integrationBranch: 'dev' }
  ] },
  { slug: 'flowboard', name: 'Flowboard', repos: [
    { fullName: 'Qonbex/qonbaq-flowboard', integrationBranch: 'dev' }
  ] },
  { slug: 'mindsurfing', name: 'Mindsurfing', repos: [
    { fullName: 'MindsurfingClub/mindsurfing', integrationBranch: 'dev' }
  ] }
] as const;

export function repositoryTargets(): RepositoryTarget[] {
  return DEVELOPMENT_PROJECTS.flatMap(project =>
    project.repos.map(repo => ({ project: project.slug, ...repo }))
  );
}
