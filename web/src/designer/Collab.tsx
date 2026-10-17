import { Check, Lock, RotateCcw, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { draftOf, publishState } from '../engine/drafts';
import type { Project } from '../engine/types';
import { api, clientId, lockEvents, useApp, type EditLock } from '../store';
import { useDesigner } from './designerStore';

/*
 * One designer at a time per template (edit lock, renewed while the template
 * is open), and drafts that reach the operator only when published.
 */

const RENEW_MS = 15_000;

type LockState = { status: 'pending' } | { status: 'mine' } | { status: 'held'; holder: EditLock };

const lockUrl = (p: string, t: string) => `/api/projects/${encodeURIComponent(p)}/templates/${encodeURIComponent(t)}/lock`;

function release(projectId: string, templateId: string) {
  // keepalive: also sent while the tab closes.
  void fetch(lockUrl(projectId, templateId), { method: 'DELETE', credentials: 'same-origin', keepalive: true, headers: { 'X-Pulse-Client': clientId } }).catch(() => {});
}

/** Takes the open template's edit lock, keeps it, and follows take overs. */
export function useEditLock(project: Project | null, templateId: string | undefined) {
  const [state, setState] = useState<LockState>({ status: 'pending' });
  const toast = useApp((s) => s.toast);
  const pid = project?.id;
  const live = useRef(state);
  live.current = state;

  const acquire = async (force = false) => {
    if (!pid || !templateId) return;
    try {
      const r = await api<{ granted: boolean; lock: EditLock }>('POST', lockUrl(pid, templateId), { force });
      setState(r.granted ? { status: 'mine' } : { status: 'held', holder: r.lock });
    } catch {
      // Offline or no rights: let the save errors speak.
      setState({ status: 'mine' });
    }
  };

  useEffect(() => {
    if (!pid || !templateId) return;
    setState({ status: 'pending' });
    void acquire();
    const renew = setInterval(() => void acquire(), RENEW_MS);
    const onLock = (e: Event) => {
      const ev = (e as CustomEvent).detail as { projectId: string; templateId: string; lock: EditLock | null; takenFrom: string | null };
      if (ev.projectId !== pid || ev.templateId !== templateId) return;
      if (ev.lock && ev.lock.client !== clientId) {
        if (ev.takenFrom === clientId) toast(`${ev.lock.userName} took over this template — it is read only for you now`, 'info');
        setState({ status: 'held', holder: ev.lock });
      } else if (!ev.lock && live.current.status === 'held') {
        // Released: take it.
        void acquire();
      }
    };
    lockEvents.addEventListener('lock', onLock);
    const onUnload = () => release(pid, templateId);
    window.addEventListener('pagehide', onUnload);
    return () => {
      clearInterval(renew);
      lockEvents.removeEventListener('lock', onLock);
      window.removeEventListener('pagehide', onUnload);
      release(pid, templateId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, templateId]);

  // Read only while someone else edits; follow their saves.
  const readOnly = state.status === 'held';
  useEffect(() => {
    useDesigner.setState({ readOnly });
  }, [readOnly]);
  const draft = project && templateId ? draftOf(project, templateId) : undefined;
  useEffect(() => {
    if (readOnly && draft) useDesigner.getState().replace(draft);
  }, [readOnly, draft]);

  return { state, takeOver: () => acquire(true) };
}

/** Banner over the stage while another designer holds the template. */
export function LockBanner({ holder, onTakeOver }: { holder: EditLock; onTakeOver: () => void }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <div className="lock-banner">
        <Lock size={14} />
        <span>
          <b>{holder.userName}</b> is editing this template — read only
        </span>
        <button className="btn small warn" onClick={() => setConfirm(true)}>
          Take over
        </button>
      </div>
      {confirm && (
        <div className="modal-back" onPointerDown={() => setConfirm(false)}>
          <div className="modal take-over" onPointerDown={(e) => e.stopPropagation()}>
            <h2>Take over this template?</h2>
            <p>
              {holder.userName} is editing it. They switch to read only and are told that you took over; a change they made in the last second may be lost.
            </p>
            <div className="row end">
              <button className="btn" onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button
                className="btn warn"
                onClick={() => {
                  setConfirm(false);
                  onTakeOver();
                }}
              >
                Take over
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Draft / published state of the open template, and the Publish button. */
export function PublishButton({ project, readOnly }: { project: Project; readOnly: boolean }) {
  const base = useDesigner((s) => s.base);
  const { saveTemplate, toast } = useApp();
  const [busy, setBusy] = useState(false);
  if (!base) return null;
  const { published, draft } = publishState(project, base.id);
  const changed = draft || !published;
  const url = `/api/projects/${encodeURIComponent(project.id)}/templates/${encodeURIComponent(base.id)}`;
  const publish = async () => {
    setBusy(true);
    try {
      // The latest edits first (autosave may still be pending).
      await saveTemplate(useDesigner.getState().base!);
      const r = await api<{ revision: number }>('POST', `${url}/publish`);
      toast(`“${base.name}” v${r.revision} is live in the Operator`, 'info');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const discard = async () => {
    if (!published || !confirm(`Discard the unpublished changes of “${base.name}” and go back to v${published.revision ?? 1}?`)) return;
    await api('DELETE', `${url}/draft`).catch((e) => toast((e as Error).message, 'error'));
    useDesigner.getState().load(published);
  };
  if (!changed)
    return (
      <span className="publish-state" title="The Operator uses this version">
        <Check size={13} /> Live in Operator{published?.revision ? ` · v${published.revision}` : ''}
      </span>
    );
  return (
    <div className="publish">
      {published && draft && !readOnly && (
        <button className="icon-btn ghost" title={`Discard unpublished changes (back to v${published.revision || 1})`} onClick={discard}>
          <RotateCcw size={13} />
        </button>
      )}
      <button className="btn small primary" disabled={busy || readOnly} title={published ? `The Operator uses v${published.revision || 1} until you publish` : 'New template: the Operator does not see it until you publish'} onClick={publish}>
        <Upload size={13} /> {published ? 'Publish to Operator' : 'Publish (new)'}
      </button>
    </div>
  );
}
