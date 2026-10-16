import { Clapperboard, PenTool, Radio, Settings as SettingsIcon, Tv } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Designer } from './designer/Designer';
import { Operator } from './operator/Operator';
import { Output } from './output/Output';
import { Settings } from './settings/Settings';
import { useApp } from './store';

type Route = 'designer' | 'operator' | 'settings' | 'output';

function currentRoute(): Route {
  const p = location.pathname.replace(/\/+$/, '');
  if (p.endsWith('/output')) return 'output';
  if (p.endsWith('/operator')) return 'operator';
  if (p.endsWith('/settings')) return 'settings';
  return 'designer';
}

export function App() {
  const [route, setRoute] = useState<Route>(currentRoute);
  const { connect, connected, project, channel, toasts } = useApp();

  useEffect(() => {
    connect();
    const onPop = () => setRoute(currentRoute());
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, [connect]);

  if (route === 'output') return <Output />;

  const go = (r: Route) => {
    history.pushState(null, '', `/${r}`);
    setRoute(r);
  };
  const onAir = Object.keys(channel.layers).length;

  return (
    <div className="app">
      <nav className="topbar">
        <div className="brand">
          <Clapperboard size={18} />
          <span>Pulse</span>
          <em>CG</em>
        </div>
        <div className="tabs">
          <button className={route === 'designer' ? 'on' : ''} onClick={() => go('designer')}>
            <PenTool size={14} /> Designer
          </button>
          <button className={route === 'operator' ? 'on' : ''} onClick={() => go('operator')}>
            <Radio size={14} /> Operator
          </button>
          <button className={route === 'settings' ? 'on' : ''} onClick={() => go('settings')}>
            <SettingsIcon size={14} /> Settings
          </button>
        </div>
        <div className="spacer" />
        {project && (
          <span className="project-info">
            {project.name} · {project.width}×{project.height} · {+(project.frameRate.num / project.frameRate.den).toFixed(2)} fps
          </span>
        )}
        <span className={`air-indicator ${onAir ? 'live' : ''}`}>
          <Tv size={13} /> {onAir ? `${onAir} on air` : 'Off air'}
        </span>
        <span className={`conn ${connected ? 'ok' : 'ko'}`} title={connected ? 'Connected to engine' : 'Reconnecting…'} />
      </nav>
      <div className="content">{route === 'designer' ? <Designer /> : route === 'operator' ? <Operator /> : <Settings />}</div>
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
