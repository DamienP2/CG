import { Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { promptDialog } from '../ui/dialogs';
import { PlatformBadge } from './PlatformBadge';
import { Hashtags } from './Hashtags';
import { Moderation } from './Moderation';
import { RulesPage } from './Rules';
import { save, useDesk, useSocial, type Desk } from './socialStore';

/*
 * Project › Social: what the project does with the messages of the shared
 * connections it follows. Moderation (incoming, approved, on air), its
 * rules, and the hashtags it counts.
 */

type Sub = 'moderation' | 'rules' | 'hashtags';
const LAST_SUB = 'strata.socialTab';

function recall(): Sub {
  try {
    const v = localStorage.getItem(LAST_SUB);
    if (v === 'rules' || v === 'hashtags') return v;
  } catch {
    /* private mode */
  }
  return 'moderation';
}

export function Social({ projectId }: { projectId: string }) {
  const desk = useDesk(projectId);
  const [sub, setSub] = useState<Sub>(recall);
  const pick = (s: Sub) => {
    setSub(s);
    try {
      localStorage.setItem(LAST_SUB, s);
    } catch {
      /* private mode */
    }
  };
  const addTag = async () => {
    if (!desk) return;
    const tag = await promptDialog({ title: t('New hashtag'), placeholder: '#JT20H', confirm: t('Add') });
    if (!tag?.trim()) return;
    void save(projectId, 'hashtags', [...desk.hashtags.map((h) => ({ tag: h.tag, running: h.running })), { tag, running: true }]);
  };
  return (
    <div className="mod-page">
      <div className="mod-subtabs">
        <div className="tabs">
          <button className={sub === 'moderation' ? 'on' : ''} onClick={() => pick('moderation')}>
            {t('Moderation')}
          </button>
          <button className={sub === 'rules' ? 'on' : ''} onClick={() => pick('rules')}>
            {t('Rules')}
          </button>
          <button className={sub === 'hashtags' ? 'on' : ''} onClick={() => pick('hashtags')}>
            {t('Hashtags')}
          </button>
        </div>
        <span className="spacer" />
        {desk && sub === 'moderation' && <Followed projectId={projectId} desk={desk} />}
        {desk && sub === 'hashtags' && (
          <button className="btn" onClick={addTag}>
            <Plus size={14} /> {t('Hashtag')}
          </button>
        )}
      </div>
      {!desk ? (
        <div className="loading">{t('Loading…')}</div>
      ) : sub === 'moderation' ? (
        <Moderation projectId={projectId} desk={desk} />
      ) : sub === 'rules' ? (
        <RulesPage projectId={projectId} desk={desk} />
      ) : (
        <Hashtags projectId={projectId} desk={desk} />
      )}
    </div>
  );
}

/** The shared connections the project follows, and the others to add. */
function Followed({ projectId, desk }: { projectId: string; desk: Desk }) {
  const connections = useSocial((s) => s.connections);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    addEventListener('mousedown', close);
    return () => removeEventListener('mousedown', close);
  }, [open]);
  const follow = (ids: string[]) => void save(projectId, 'follow', { sources: ids });
  const others = connections.filter((c) => !desk.sources.includes(c.id));
  return (
    <div className="mod-follow" ref={ref}>
      {desk.sources.map((id) => {
        const c = connections.find((x) => x.id === id);
        return (
          <span key={id} className={`mod-conn ${c && !c.connected ? 'off' : ''}`} title={c && !c.connected ? t('Not connected') : undefined}>
            {c && <PlatformBadge platform={c.platform} size={15} />}
            {c?.name ?? id}
            <button
              className="mod-conn-x"
              title={t('Stop following')}
              onClick={() => follow(desk.sources.filter((x) => x !== id))}
            >
              <X size={11} />
            </button>
          </span>
        );
      })}
      <button className="mod-conn add" onClick={() => setOpen(!open)}>
        <Plus size={12} /> {t('Shared source')}
      </button>
      {open && (
        <div className="mod-menu">
          {others.map((c) => (
            <button
              key={c.id}
              onClick={() => {
                setOpen(false);
                follow([...desk.sources, c.id]);
              }}
            >
              <PlatformBadge platform={c.platform} size={16} /> {c.name}
            </button>
          ))}
          {!others.length && <div className="mod-menu-empty">{t('No other shared connection')}</div>}
        </div>
      )}
    </div>
  );
}
