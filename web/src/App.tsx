import { BookOpen, Database, FolderOpen, Images, MonitorPlay, LogOut, PenTool, Radio, Settings as SettingsIcon, Tv, Users as UsersIcon } from 'lucide-react';
import { Logo } from './ui/Logo';
import { DialogHost } from './ui/dialogs';
import { useEffect, useState } from 'react';
import { Designer } from './designer/Designer';
import { Operator } from './operator/Operator';
import { Output } from './output/Output';
import { ApiDocs } from './pages/ApiDocs';
import { Login } from './pages/Login';
import { MosPlugin } from './mos/Plugin';
import { Projects } from './pages/Projects';
import { MediaLibrary } from './pages/Media';
import { Outputs } from './outputs/Outputs';
import { Users } from './pages/Users';
import { DataPage } from './data/DataPage';
import { navigate, parseRoute, projectPath, type ProjectPage, type Route } from './router';
import { ProjectSettings } from './pages/ProjectPages';
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
  if (route.page === 'mosPlugin') return <MosPlugin />;
  if (route.page === 'output') return <Output channelId={route.channelId ?? 'main'} rendition={route.rendition} />;
  return <Studio route={route} />;
}

function Studio({ route }: { route: Exclude<Route, { page: 'output' | 'mosPlugin' }> }) {
  const { auth, init, connect, projects, channels, toasts } = useApp();
  const user = auth?.user;

  useEffect(() => void init(), [init]);
  useEffect(() => {
    if (user) connect();
  }, [user, connect]);

  // Pre-0.10 links (/designer/…, /operator/…) and pages a role cannot see.
  useEffect(() => {
    if (!user) return;
    if ((route.page === 'settings' || route.page === 'users' || route.page === 'outputs') && !can.admin(user)) return navigate('/projects', true);
    if (route.page === 'legacyDesigner') {
      const id = route.projectId ?? recall(LAST_PROJECT) ?? projects[0]?.id;
      if (id) navigate(projectPath(id, 'designer'), true);
      else if (projects.length || useApp.getState().connected) navigate('/projects', true);
    }
    if (route.page === 'legacyOperator') {
      if (!channels.length) return;
      const ch = channels.find((c) => c.id === route.channelId);
      navigate(ch?.projectId ? projectPath(ch.projectId, 'operator', ch.id) : '/projects', true);
    }
  }, [route, user, projects, channels]);

  if (!auth) return <div className="loading">Connecting…</div>;
  if (!user) return <Login />;

  return (
    <div className="app">
      {route.page === 'project' ? <ProjectShell route={route} /> : route.page === 'legacyDesigner' || route.page === 'legacyOperator' ? <div className="loading">Opening…</div> : <Home route={route} />}
      <DialogHost />
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

function Brand() {
  return (
    <div className="brand">
      <Logo size={22} />
      <span>Pulse</span>
      <em>CG</em>
    </div>
  );
}

function UserMenu() {
  const { auth, connected, logout } = useApp();
  const user = auth!.user!;
  return (
    <>
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
    </>
  );
}

/** Projects, users and server settings. A project opens in its own browser tab. */
function Home({ route }: { route: Extract<Route, { page: 'projects' | 'media' | 'outputs' | 'users' | 'settings' | 'apiDocs' }> }) {
  const user = useApp((s) => s.auth?.user);
  useEffect(() => {
    document.title = 'Pulse CG';
  }, []);
  const tab = (page: Route['page'], path: string, icon: React.ReactNode, label: string) => (
    <button className={route.page === page ? 'on' : ''} onClick={() => navigate(path)}>
      {icon} {label}
    </button>
  );
  return (
    <>
      <nav className="topbar">
        <Brand />
        <div className="tabs">
          {tab('projects', '/projects', <FolderOpen size={14} />, 'Projects')}
          {tab('media', '/media', <Images size={14} />, 'Assets')}
          {can.admin(user) && tab('outputs', '/outputs', <MonitorPlay size={14} />, 'Outputs')}
          {can.admin(user) && tab('users', '/users', <UsersIcon size={14} />, 'Users')}
          {can.admin(user) && tab('settings', '/settings', <SettingsIcon size={14} />, 'Settings')}
        </div>
        <div className="spacer" />
        <UserMenu />
      </nav>
      <div className="content">
        {route.page === 'projects' && <Projects />}
        {route.page === 'media' && <MediaLibrary />}
        {route.page === 'outputs' && <Outputs />}
        {route.page === 'settings' && <Settings />}
        {route.page === 'users' && <Users />}
        {route.page === 'apiDocs' && <ApiDocs />}
      </div>
    </>
  );
}

/** The pages of one project: designer, operator, data and project settings. */
function ProjectShell({ route }: { route: Extract<Route, { page: 'project' }> }) {
  const { auth, connected, projects, channels, project, openProject, live } = useApp();
  const user = auth!.user!;
  const { projectId, sub } = route;
  const summary = projects.find((p) => p.id === projectId);
  const known = !!summary || !connected || !projects.length;

  useEffect(() => {
    remember(LAST_PROJECT, projectId);
    if (useApp.getState().projectId !== projectId) openProject(projectId);
  }, [projectId, openProject]);
  useEffect(() => {
    document.title = summary ? `${summary.name} · Pulse CG` : 'Pulse CG';
  }, [summary?.name]);

  // Pages a role cannot see.
  const allowed = (s: ProjectPage) => (s === 'operator' || s === 'media' ? can.operate(user) : can.design(user));
  useEffect(() => {
    if (!allowed(sub)) navigate(projectPath(projectId, can.design(user) ? 'designer' : 'operator'), true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub, projectId, user]);

  // Operator: the channel playing this project (the last one used first).
  const own = channels.filter((c) => c.projectId === projectId);
  const operated = sub === 'operator' ? (channels.find((c) => c.id === route.channelId) ?? null) : null;
  useEffect(() => {
    if (sub !== 'operator' || route.channelId || !own.length) return;
    const last = recall(LAST_CHANNEL);
    navigate(projectPath(projectId, 'operator', (own.find((c) => c.id === last) ?? own[0]).id), true);
  }, [sub, route.channelId, own.length, projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!operated) return;
    remember(LAST_CHANNEL, operated.id);
    useApp.getState().selectChannel(operated.id);
  }, [operated?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const onAir = operated ? Object.keys(live[operated.id]?.state.layers ?? {}).length : 0;
  const tab = (s: ProjectPage, icon: React.ReactNode, label: string) =>
    allowed(s) && (
      <button className={sub === s ? 'on' : ''} onClick={() => navigate(projectPath(projectId, s, s === 'operator' ? operated?.id : null))}>
        {icon} {label}
      </button>
    );
  const ready = project && project.id === projectId;

  let page: React.ReactNode;
  if (!known) page = <div className="loading">This project does not exist or you cannot access it.</div>;
  else if (!ready) page = <div className="loading">Opening the project…</div>;
  else if (sub === 'designer') page = <Designer key={project.id} />;
  else if (sub === 'data') page = <DataPage />;
  else if (sub === 'media') page = <MediaLibrary key={projectId} projectId={projectId} />;
  else if (sub === 'settings') page = <ProjectSettings project={summary ?? { ...project, description: project.description ?? '' }} />;
  else {
    // Without an output of this project, the operator still prepares and previews.
    const own = operated && operated.projectId === projectId ? operated.id : null;
    page = <Operator key={own ?? 'none'} channelId={own} />;
  }

  return (
    <>
      <nav className="topbar">
        <Brand />
        <span className="project-title" title={summary?.description || undefined}>
          {summary?.name ?? project?.name ?? '…'}
        </span>
        <div className="tabs">
          {tab('designer', <PenTool size={14} />, 'Designer')}
          {tab('operator', <Radio size={14} />, 'Operator')}
          {tab('data', <Database size={14} />, 'Connectors')}
          {tab('media', <Images size={14} />, 'Assets')}
          {tab('settings', <SettingsIcon size={14} />, 'Settings')}
        </div>
        <div className="spacer" />
        {/* Filled by the page (the Designer's undo, redo and history). */}
        <div id="topbar-slot" className="topbar-slot" />
        {sub === 'designer' && project && (
          <span className="project-info">
            {project.width}×{project.height} · {+(project.frameRate.num / project.frameRate.den).toFixed(2)} fps
          </span>
        )}
        {sub === 'operator' && operated && operated.projectId === projectId && (
          <span className={`air-indicator ${onAir ? 'live' : ''}`} title={operated.name}>
            <Tv size={13} /> {onAir ? `${onAir} on air` : 'Off air'}
          </span>
        )}
        <UserMenu />
      </nav>
      <div className="content">{page}</div>
    </>
  );
}
