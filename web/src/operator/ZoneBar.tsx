import { useEffect, useMemo, useRef } from 'react';
import { Lock } from 'lucide-react';
import { api, serverEvents, useApp, type ZoneLock } from '../store';
import type { Project } from '../engine/types';
import { t } from '../i18n';
import { Avatar } from './Presence';

/*
 * Zones of a channel held by operators: each one drives its zones, the others
 * see them locked until they take them (one click, the holder is told).
 */

const NONE: ZoneLock[] = [];
const url = (channelId: string) => `/api/channels/${encodeURIComponent(channelId)}`;

/** The zones held on the channel; tells me when someone takes one of mine. */
export function useZoneLocks(channelId: string | null, project: Project | null) {
  const locks = useApp((s) => (channelId ? (s.zoneLocks[channelId] ?? NONE) : NONE));
  const me = useApp((s) => s.auth?.user?.id);
  const connected = useApp((s) => s.connected);
  // The locks as last seen here: which of mine were taken.
  const seen = useRef<ZoneLock[]>(locks);
  const zones = useRef(project?.zones ?? []);
  zones.current = project?.zones ?? [];

  useEffect(() => {
    if (!channelId || !connected) return;
    api<ZoneLock[]>('GET', `${url(channelId)}/locks`)
      .then((l) => {
        seen.current = l;
        useApp.setState({ zoneLocks: { ...useApp.getState().zoneLocks, [channelId]: l } });
      })
      .catch(() => {});
  }, [channelId, connected]);

  useEffect(() => {
    if (!channelId || !me) return;
    const on = (e: Event) => {
      const ev = (e as CustomEvent<{ channelId: string; locks: ZoneLock[]; takenFrom: string | null }>).detail;
      if (ev.channelId !== channelId) return;
      const before = seen.current;
      seen.current = ev.locks;
      if (ev.takenFrom !== me) return;
      for (const l of ev.locks) {
        if (l.userId === me || !before.some((b) => b.zone === l.zone && b.userId === me)) continue;
        const zone = zones.current.find((z) => z.id === l.zone)?.name ?? l.zone;
        useApp.getState().toast(t('{name} took the zone {zone}', { name: l.userName, zone }), 'info');
      }
    };
    serverEvents.addEventListener('zoneLocks', on);
    return () => serverEvents.removeEventListener('zoneLocks', on);
  }, [channelId, me]);

  return useMemo(() => {
    const byZone = new Map(locks.map((l) => [l.zone, l]));
    return {
      locks,
      /** The lock of a zone someone else holds. */
      other: (zone?: string | null) => {
        const l = zone ? byZone.get(zone) : undefined;
        return l && l.userId !== me ? l : undefined;
      },
    };
  }, [locks, me]);
}

/** One chip per zone of the project: mine, held by someone (🔒 name), or free. A click takes it, or frees mine. */
export function ZoneBar({ project, channelId, locks, operate }: { project: Project; channelId: string; locks: ZoneLock[]; operate: boolean }) {
  const me = useApp((s) => s.auth?.user?.id);
  const toast = useApp((s) => s.toast);
  const zones = [...project.zones].sort((a, b) => b.layer - a.layer);
  if (!zones.length) return null;
  const set = (zone: string, take: boolean) =>
    api(take ? 'PUT' : 'DELETE', `${url(channelId)}/zones/${encodeURIComponent(zone)}/lock`).catch((e) => toast((e as Error).message, 'error'));
  return (
    <div className="opl-zonebar">
      {zones.map((z) => {
        const l = locks.find((x) => x.zone === z.id);
        const mine = l?.userId === me;
        if (mine)
          return (
            <button key={z.id} className="opl-zone mine" disabled={!operate} title={t('Free the zone {zone}', { zone: z.name })} onClick={() => set(z.id, false)}>
              <i className="opx-dot" style={{ background: z.color }} />
              {z.name} · <b>{t('you')}</b>
            </button>
          );
        if (l)
          return (
            <button key={z.id} className="opl-zone other" disabled={!operate} title={t('Take the zone {zone} from {name}', { zone: z.name, name: l.userName })} onClick={() => set(z.id, true)}>
              <i className="opx-dot" style={{ background: z.color }} />
              {z.name} · <Lock size={11} /> {l.userName}
            </button>
          );
        return (
          <button key={z.id} className="opl-zone" disabled={!operate} title={t('Take the zone {zone}', { zone: z.name })} onClick={() => set(z.id, true)}>
            <i className="opx-dot" style={{ background: z.color }} />
            {z.name} · <span className="opl-free">{t('free')}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Who holds the zone of a graphic (in its row). */
export function LockedBy({ lock }: { lock: ZoneLock }) {
  return (
    <span className="opl-lockby" title={t('{name} holds this zone', { name: lock.userName })}>
      <Avatar id={lock.userId} name={lock.userName} small />
      {lock.userName}
    </span>
  );
}
