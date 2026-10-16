import { BookOpen, Clapperboard, FolderOpen, LogOut, PenTool, Radio, Settings as SettingsIcon, Tv, Users as UsersIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Designer } from './designer/Designer';
import { Operator } from './operator/Operator';
import { Output } from './output/Output';
import { ApiDocs } from './pages/ApiDocs';
import { Login } from './pages/Login';
import { Projects } from './pages/Projects';
import { Users } from './pages/Users';
import { navigate, parseRoute, type Route } from './router';
import { Settings } from './settings/Settings';
import { can, useApp } from './store';

const LAST_PROJECT = 'pulse.lastProject';
const LAST_CHANNEL = 'pulse.lastChannel';
const remember = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
};
const recall = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};

function useRoute(): Route {
  const [route, setRoute] = useState(parseRoute);
  useEffect(() => {
    const onPop = () => setRoute(parseRoute());
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);
  return route;
}

export function App() {
  const route = useRoute();
  if (route.page === 'output') return <Output channelId={route.channelId ?? 'main'} rendition={route.rendition} />;
  return <Studio route={route} />;
}

function Studio({ route }: { route: Exclude<Route, { page: 'output' }> }) {
  const { auth, init, connect, connected, projects, channels, project, openProject, live, toasts, logout } = useApp();
  const user = auth?.user;

  useEffect(() => void init(), [init]);
  useEffect(() => {
    if (user) connect();
  }, [user, connect]);

  // Resolve routes without an id, and keep the active project in sync.
  const operatedChannel = route.page === 'operator' ? (channels.find((c) => c.id === route.channelId) ?? null) : null;
  useEffect(() => {
    if (!user) return;
    if ((route.page === 'settings' || route.page === 'users') && !can.admin(user)) return navigate('/projects', true);
    if (route.page === 'designer') {
      if (!can.design(user)) return navigate('/projects', true);
      if (!route.projectId) {
        if (!projects.length) return;
        const last = recall(LAST_PROJECT);
        return navigate(`/designer/${encodeURIComponent(projects.find((p) => p.id === last)?.id ?? projects[0].id)}`, true);
      }
      remember(LAST_PROJECT, route.projectId);
      if (useApp.getState().projectId !== route.projectId) openProject(route.projectId);
    }
    if (route.page === 'operator') {
      if (!channels.length) return;
      if (!operatedChannel) {
        const last = recall(LAST_CHANNEL);
        return navigate(`/operator/${encodeURIComponent(channels.find((c) => c.id === last)?.id ?? channels[0].id)}`, true);
      }
      remember(LAST_CHANNEL, operatedChannel.id);
      useApp.getState().selectChannel(operatedChannel.id);
      if (useApp.getState().projectId !== operatedChannel.projectId) openProject(operatedChannel.projectId);
    }
  }, [route, user, projects, channels, operatedChannel?.id, operatedChannel?.projectId, openProject]);

  if (!auth) return <div className="loading">Connecting…</div>;
  if (!user) return <Login />;

  const onAir = operatedChannel ? Object.keys(live[operatedChannel.id]?.state.layers ?? {}).length : Object.values(live).reduce((n, l) => n + Object.keys(l.state.layers).length, 0);
  const lastProject = route.page === 'designer' ? route.projectId : recall(LAST_PROJECT);
  const tab = (page: Route['page'], path: string, icon: React.ReactNode, label: string) => (
    <button className={route.page === page ? 'on' : ''} onClick={() => navigate(path)}>
      {icon} {label}
    </button>
  );

  return (
    <div className="app">
      <nav className="topbar">
        <div className="brand">
          <Clapperboard size={18} />
          <span>Pulse</span>
          <em>CG</em>
        </div>
        <div className="tabs">
          {tab('projects', '/projects', <FolderOpen size={14} />, 'Projects')}
          {can.design(user) && tab('designer', lastProject ? `/designer/${encodeURIComponent(lastProject)}` : '/designer', <PenTool size={14} />, 'Designer')}
          {tab('operator', '/operator', <Radio size={14} />, 'Operator')}
          {can.admin(user) && tab('users', '/users', <UsersIcon size={14} />, 'Users')}
          {can.admin(user) && tab('settings', '/settings', <SettingsIcon size={14} />, 'Settings')}
        </div>
        <div className="spacer" />
        {route.page === 'designer' && project && (
          <span className="project-info">
            {project.name} · {project.width}×{project.height} · {+(project.frameRate.num / project.frameRate.den).toFixed(2)} fps
          </span>
        )}
        <span className={`air-indicator ${onAir ? 'live' : ''}`} title={operatedChannel ? operatedChannel.name : 'All channels'}>
          <Tv size={13} /> {onAir ? `${onAir} on air` : 'Off air'}
        </span>
        <span className={`conn ${connected ? 'ok' : 'ko'}`} title={connected ? 'Connected to engine' : 'Reconnecting…'} />
        <div className="user-menu" title={`${user.username} · ${user.role}`}>
          <span className="avatar">{(user.displayName || user.username).slice(0, 1).toUpperCase()}</span>
          <span className="user-name">{user.displayName || user.username}</span>
          <a className="icon-btn ghost" title="API documentation" href="/api-docs" onClick={(e) => (e.preventDefault(), navigate('/api-docs'))}>
            <BookOpen size={14} />
          </a>
          <button className="icon-btn ghost" title="Sign out" onClick={logout}>
            <LogOut size={14} />
          </button>
        </div>
      </nav>
      <div className="content">
        {route.page === 'projects' && <Projects />}
        {route.page === 'designer' && (project && project.id === route.projectId ? <Designer key={project.id} /> : <div className="loading">{projects.length ? 'Opening the project…' : 'No project yet: create one in Projects.'}</div>)}
        {route.page === 'operator' && (operatedChannel ? <Operator key={operatedChannel.id} channelId={operatedChannel.id} /> : <div className="loading">{connected && !channels.length ? 'No channel you can access.' : 'Connecting…'}</div>)}
        {route.page === 'settings' && <Settings />}
        {route.page === 'users' && <Users />}
        {route.page === 'apiDocs' && <ApiDocs />}
      </div>
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
