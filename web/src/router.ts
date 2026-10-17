/** Minimal history router. */
export type ProjectPage = 'designer' | 'operator' | 'data' | 'media' | 'settings';

export type Route =
  | { page: 'projects' }
  | { page: 'users' }
  | { page: 'media' }
  | { page: 'settings' }
  | { page: 'apiDocs' }
  | {
      page: 'project';
      projectId: string;
      sub: ProjectPage;
      channelId: string | null;
    }
  // Pre-0.10 links, resolved to the project pages.
  | { page: 'legacyDesigner'; projectId: string | null }
  | { page: 'legacyOperator'; channelId: string | null }
  | { page: 'mosPlugin' }
  | { page: 'output'; channelId: string | null; rendition: string | null };

const SUBS: ProjectPage[] = ['designer', 'operator', 'data', 'media', 'settings'];

export function parseRoute(path = location.pathname): Route {
  const [first, second, third, fourth] = path.split('/').filter(Boolean).map(decodeURIComponent);
  switch (first) {
    case 'project':
      if (!second) return { page: 'projects' };
      return {
        page: 'project',
        projectId: second,
        sub: SUBS.includes(third as ProjectPage) ? (third as ProjectPage) : 'designer',
        channelId: fourth ?? null,
      };
    case 'designer':
      return { page: 'legacyDesigner', projectId: second ?? null };
    case 'operator':
      return { page: 'legacyOperator', channelId: second ?? null };
    case 'settings':
      return { page: 'settings' };
    case 'users':
      return { page: 'users' };
    case 'media':
      return { page: 'media' };
    case 'mos':
      return second === 'plugin' ? { page: 'mosPlugin' } : { page: 'projects' };
    case 'api-docs':
      return { page: 'apiDocs' };
    case 'output':
      return {
        page: 'output',
        channelId: second ?? null,
        rendition: third ?? null,
      };
    default:
      return { page: 'projects' };
  }
}

/** URL of a project page (`channelId`: the operated channel). */
export function projectPath(projectId: string, sub: ProjectPage = 'designer', channelId?: string | null) {
  return `/project/${encodeURIComponent(projectId)}/${sub}${channelId ? `/${encodeURIComponent(channelId)}` : ''}`;
}

/** Browser tab of a project: opening it again focuses the same tab. */
export const projectTab = (projectId: string) => `pulse-project-${projectId}`;

export function navigate(path: string, replace = false) {
  if (path === location.pathname) return;
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  dispatchEvent(new PopStateEvent('popstate'));
}
