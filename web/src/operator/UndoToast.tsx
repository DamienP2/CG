import { useEffect, useRef, useState } from 'react';
import { History, Undo2, X } from 'lucide-react';
import { api, useApp } from '../store';
import { locale, t, tc, tn } from '../i18n';
import { Avatar } from './Presence';

/*
 * Undo on air: ⌘Z / Ctrl+Z undoes my last action; in the top bar, the last
 * actions of the channel, to undo back to one.
 */

export interface UndoStep {
  /** Server time (ms). */
  at: number;
  actor: { kind: string; id: string; name: string };
  action: string;
  label: string;
  /** Graphics on air before it (Clear all). */
  count?: number;
}

const url = (channelId: string) => `/api/channels/${encodeURIComponent(channelId)}/undo`;
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const SHORTCUT = isMac ? '⌘Z' : 'Ctrl+Z';
const actions = new EventTarget();
/** Undo asked (the Operator's shortcut). */
export const requestUndo = () => actions.dispatchEvent(new Event('undo'));

/** The action's broadcast name (TAKE, OUT…). */
export function ActionBadge({ action }: { action: string }) {
  let label: string;
  switch (action) {
    case 'take':
      label = 'TAKE';
      break;
    case 'out':
      label = 'OUT';
      break;
    case 'continue':
      label = 'CONTINUE';
      break;
    case 'update':
      label = 'UPDATE';
      break;
    case 'clear':
      label = tc('undo', 'Clear all');
      break;
    case 'row':
      label = tc('undo', 'Row');
      break;
    case 'widget':
      label = tc('undo', 'Widget');
      break;
    case 'trigger':
      label = tc('undo', 'Trigger');
      break;
    default:
      label = action;
  }
  return <span className={`opl-act ${action}`}>{label}</span>;
}

/** Undoes the last action of the channel; false when nothing was undone (already told). */
async function undoLast(channelId: string): Promise<boolean> {
  try {
    await api('POST', url(channelId));
    return true;
  } catch (e) {
    const msg = (e as Error).message;
    useApp.getState().toast(/nothing to undo/i.test(msg) ? t('Nothing to undo') : msg, 'error');
    return false;
  }
}

/** What the step was about: the graphic, or how many graphics Clear all took out. */
const stepName = (s: UndoStep) => (s.action === 'clear' ? (s.count ? tn(s.count, '{n} graphic', '{n} graphics') : '') : s.label || s.action);

/** ⌘Z / Ctrl+Z undoes the last action on the channel (the top bar keeps the history). */
export function UndoShortcut({ channelId, operate }: { channelId: string | null; operate: boolean }) {
  const undo = async () => {
    if (!channelId || !operate) return;
    const list = await api<UndoStep[]>('GET', url(channelId)).catch(() => [] as UndoStep[]);
    if (!list.length) return useApp.getState().toast(t('Nothing to undo'), 'error');
    await undoLast(channelId);
  };
  const undoRef = useRef(undo);
  undoRef.current = undo;

  useEffect(() => {
    const onUndo = () => void undoRef.current();
    actions.addEventListener('undo', onUndo);
    return () => actions.removeEventListener('undo', onUndo);
  }, []);
  return null;
}

/** The last actions of the channel (top bar): a click undoes back to one. */
export function UndoHistory({ channelId, operate }: { channelId: string; operate: boolean }) {
  const me = useApp((s) => s.auth?.user?.id);
  const [open, setOpen] = useState(false);
  // The channel's news only while the list shows (it is in the transport bar).
  const live = useApp((s) => (open ? s.live[channelId] : undefined));
  const [list, setList] = useState<UndoStep[] | null>(null);
  // Undo back to this entry (several: confirmed first).
  const [upTo, setUpTo] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = () =>
    api<UndoStep[]>('GET', url(channelId))
      .then(setList)
      .catch(() => setList([]));
  useEffect(() => {
    if (open) void load();
  }, [open, live, channelId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return setUpTo(null);
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', esc);
    return () => (window.removeEventListener('pointerdown', close), window.removeEventListener('keydown', esc));
  }, [open]);

  const undoTo = async (i: number) => {
    setBusy(true);
    for (let n = 0; n <= i; n++) if (!(await undoLast(channelId))) break;
    setBusy(false);
    setUpTo(null);
    void load();
  };
  const time = (at: number) => new Date(at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <div className="history-menu" ref={ref}>
      <button className={`top-tool ${open ? 'on' : ''}`} title={t('Last actions on air')} onClick={() => setOpen(!open)}>
        <History size={15} />
      </button>
      {open && (
        <div className="history-pop opl-hist">
          <header>
            <strong>{t('Last actions on air')}</strong>
            <span className="muted small">{SHORTCUT}</span>
          </header>
          {list === null && <p className="opl-hist-empty">{t('Loading…')}</p>}
          {list?.length === 0 && <p className="opl-hist-empty">{t('Nothing to undo')}</p>}
          {!!list?.length && (
            <ol className="opl-hist-list">
              {list.map((s, i) => (
                <li key={`${s.at}-${i}`} className={upTo !== null && i <= upTo ? 'span' : ''}>
                  <button disabled={!operate || busy} title={t('Undo back to here')} onClick={() => (i === 0 ? void undoTo(0) : setUpTo(upTo === i ? null : i))}>
                    <span className="opl-hist-time">{time(s.at)}</span>
                    <ActionBadge action={s.action} />
                    <span className="opl-hist-name">{stepName(s)}</span>
                    {s.actor.kind === 'user' ? (
                      <span className="opl-hist-who">
                        <Avatar id={s.actor.id} name={s.actor.name} small />
                        {s.actor.id === me ? t('you') : s.actor.name}
                      </span>
                    ) : (
                      <span className="opl-hist-who">{s.actor.name}</span>
                    )}
                  </button>
                </li>
              ))}
            </ol>
          )}
          {upTo !== null && (
            <footer className="opl-hist-confirm">
              <button className="opl-undo" disabled={busy} onClick={() => void undoTo(upTo)}>
                <Undo2 size={13} /> {tn(upTo + 1, 'Undo {n} action', 'Undo {n} actions')}
              </button>
              <button className="opl-toast-x" title={t('Cancel')} onClick={() => setUpTo(null)}>
                <X size={13} />
              </button>
            </footer>
          )}
        </div>
      )}
    </div>
  );
}
