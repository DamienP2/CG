import { Braces, CircuitBoard, ClipboardList, Clock, CloudDownload, Gauge, HeartPulse, KeyRound, Lock, Monitor, Network, Newspaper, RotateCcw, SlidersHorizontal, Users as UsersIcon } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { t } from '../i18n';
import { needsLook, useHealthStore } from '../perf/health';
import { navigate, systemPath, type SystemSection } from '../router';
import { can, useApp } from '../store';
import { EmbeddedNav, NavItem, NavSection, PageHead } from './SidePage';

const Performance = lazy(() => import('../perf/Performance').then((m) => ({ default: m.Performance })));
const Health = lazy(() => import('../perf/Health').then((m) => ({ default: m.Health })));
const AsRun = lazy(() => import('./AsRun').then((m) => ({ default: m.AsRun })));
const Users = lazy(() => import('./Users').then((m) => ({ default: m.Users })));
const StationsPage = lazy(() => import('../settings/Stations').then((m) => ({ default: m.StationsPage })));
const ApiPage = lazy(() => import('./ApiPage').then((m) => ({ default: m.ApiPage })));
const Hardware = lazy(() => import('../hardware/Hardware').then((m) => ({ default: m.Hardware })));
const MosPage = lazy(() => import('../mos/MosPage').then((m) => ({ default: m.MosPage })));
const ServerSettings = lazy(() => import('../settings/Settings').then((m) => ({ default: m.ServerSettings })));

type Item = { id: SystemSection; icon: React.ReactNode; label: string; admin: boolean };

/** The System page's list: what to watch, who gets in, the machine, what talks to it, the server. */
function groups(): { title: string; items: Item[] }[] {
  return [
    {
      title: t('Supervision'),
      items: [
        { id: 'performance', icon: <Gauge size={15} />, label: t('Performance'), admin: true },
        { id: 'health', icon: <HeartPulse size={15} />, label: t('Health'), admin: true },
        { id: 'asrun', icon: <ClipboardList size={15} />, label: t('As-run log'), admin: false },
      ],
    },
    {
      title: t('Access'),
      items: [
        { id: 'users', icon: <UsersIcon size={15} />, label: t('Users'), admin: true },
        { id: 'stations', icon: <Monitor size={15} />, label: t('Production stations'), admin: true },
        { id: 'keys', icon: <KeyRound size={15} />, label: t('API keys'), admin: true },
        { id: 'security', icon: <Lock size={15} />, label: t('Security'), admin: true },
      ],
    },
    {
      title: t('Machine'),
      items: [
        { id: 'hardware', icon: <CircuitBoard size={15} />, label: t('Video hardware'), admin: true },
        { id: 'network', icon: <Network size={15} />, label: t('Networks'), admin: true },
        { id: 'time', icon: <Clock size={15} />, label: t('Time and sync'), admin: true },
      ],
    },
    {
      title: t('Integrations'),
      items: [
        { id: 'mos', icon: <Newspaper size={15} />, label: 'MOS', admin: true },
        { id: 'api', icon: <Braces size={15} />, label: t('API and Bitfocus'), admin: false },
      ],
    },
    {
      title: t('Server'),
      items: [
        { id: 'general', icon: <SlidersHorizontal size={15} />, label: t('General'), admin: true },
        { id: 'updates', icon: <CloudDownload size={15} />, label: t('Updates'), admin: true },
        { id: 'maintenance', icon: <RotateCcw size={15} />, label: t('Maintenance'), admin: true },
      ],
    },
  ];
}

function Section({ id }: { id: SystemSection }) {
  switch (id) {
    case 'performance':
      return <Performance />;
    case 'health':
      return <Health />;
    case 'asrun':
      return <AsRun />;
    case 'users':
      return <Users />;
    case 'stations':
      return (
        <div className="library-inner wide">
          <PageHead title={t('Production stations')} />
          <StationsPage />
        </div>
      );
    case 'keys':
      return <ApiPage part="keys" />;
    case 'api':
      return <ApiPage part="docs" />;
    case 'hardware':
      return <Hardware />;
    case 'mos':
      return <MosPage />;
    default:
      return <ServerSettings section={id} />;
  }
}

/** Administration and supervision, one page: the sections on the left, the open one on the right. */
export function SystemPage({ section }: { section: SystemSection | '' }) {
  const user = useApp((s) => s.auth?.user);
  const admin = can.admin(user);
  const health = useHealthStore((x) => x.health);
  const shown = groups()
    .map((g) => ({ ...g, items: g.items.filter((i) => admin || !i.admin) }))
    .filter((g) => g.items.length);
  const all = shown.flatMap((g) => g.items);
  const current = all.find((i) => i.id === section) ?? all[0];
  return (
    <div className="projects-page sys-page">
      <aside className="lib-nav">
        {shown.map((g) => (
          <div key={g.title} className="sys-group">
            <NavSection>{g.title}</NavSection>
            {g.items.map((i) => (
              <NavItem key={i.id} on={i.id === current.id} icon={i.icon} label={i.label} status={i.id === 'health' && needsLook(health) ? 'warn' : undefined} onClick={() => navigate(systemPath(i.id))} />
            ))}
          </div>
        ))}
      </aside>
      <main className="library">
        {/* The sections show their pages as tabs and their filters in the page: the list keeps the sections only. */}
        <EmbeddedNav.Provider value={null}>
          <Suspense fallback={<div className="loading">{t('Loading…')}</div>}>
            <Section key={current.id} id={current.id} />
          </Suspense>
        </EmbeddedNav.Provider>
      </main>
    </div>
  );
}
