/** Minimal history router. */
export type Route =
  | { page: 'projects' }
  | { page: 'designer'; projectId: string | null }
  | { page: 'operator'; channelId: string | null }
  | { page: 'settings' }
  | { page: 'users' }
  | { page: 'apiDocs' }
  | { page: 'mosPlugin' }
  | { page: 'output'; channelId: string | null; rendition: string | null };

export function parseRoute(path = location.pathname): Route {
  const [first, second, third] = path.split('/').filter(Boolean).map(decodeURIComponent);
  switch (first) {
    case 'designer':
      return { page: 'designer', projectId: second ?? null };
    case 'operator':
      return { page: 'operator', channelId: second ?? null };
    case 'settings':
      return { page: 'settings' };
    case 'users':
      return { page: 'users' };
    case 'mos':
      return second === 'plugin' ? { page: 'mosPlugin' } : { page: 'projects' };
    case 'api-docs':
      return { page: 'apiDocs' };
    case 'output':
      return { page: 'output', channelId: second ?? null, rendition: third ?? null };
    default:
      return { page: 'projects' };
  }
}

export function navigate(path: string, replace = false) {
  if (path === location.pathname) return;
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  dispatchEvent(new PopStateEvent('popstate'));
}
