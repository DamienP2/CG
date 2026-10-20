import { Check, Lock, RotateCcw, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { draftOf, publishState } from '../engine/drafts';
import type { ChannelState, Project } from '../engine/types';
import { api, clientId, lockEvents, useApp, type EditLock } from '../store';
import { useDesigner } from './designerStore';
import { confirmDialog } from '../ui/dialogs';

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

/**
 * Veil over the designer while another designer holds the template: their
 * changes show live underneath; it cannot be dismissed, only taken over. The
 * top menus and the template list stay usable.
 */
export function LockOverlay({ holder, template, onTakeOver }: { holder: EditLock; template: string; onTakeOver: () => void }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="lock-overlay">
      <div className="lock-card" role="alertdialog" aria-labelledby="lock-title">
        <span className="lock-icon">
          <Lock size={20} />
        </span>
        <h2 id="lock-title">
          {holder.userName} is editing {template ? `“${template}”` : 'this template'}
        </h2>
        {confirm ? (
          <>
            <p>{holder.userName} switches to read only and is told that you took over. A change they made in the last second may be lost.</p>
            <div className="row end">
              <button className="btn" onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button className="btn warn" onClick={onTakeOver}>
                Take over
              </button>
            </div>
          </>
        ) : (
          <>
            <p>You see their changes live. Take over to edit it yourself, or open another template.</p>
            <div className="row end">
              <button className="btn warn" onClick={() => setConfirm(true)}>
                Take over…
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Templates of `ids` on air now in a channel of the project: "name · channel". */
async function onAir(project: Project, ids: string[]): Promise<string[]> {
  const channels = useApp.getState().channels.filter((c) => c.projectId === project.id);
  const name = (id: string) => project.templates.find((t) => t.id === id)?.name ?? id;
  const out: string[] = [];
  await Promise.all(
    channels.map(async (c) => {
      try {
        const st = await api<ChannelState>('GET', `/api/channels/${encodeURIComponent(c.id)}/state`);
        for (const p of Object.values(st.layers ?? {})) if (ids.includes(p.templateId)) out.push(`${name(p.templateId)} · ${c.name}`);
      } catch {
        /* channel not visible to this user */
      }
    }),
  );
  return out;
}

/** Asks before publishing: it is immediate, and graphics on air change at once. */
async function confirmPublish(project: Project, ids: string[]): Promise<boolean> {
  const live = await onAir(project, ids);
  const names = ids.map((id) => project.drafts?.find((t) => t.id === id)?.name ?? project.templates.find((t) => t.id === id)?.name ?? id);
  return confirmDialog({
    title: ids.length > 1 ? `Publish ${ids.length} templates?` : `Publish “${names[0]}”?`,
    message: (
      <div className="publish-confirm">
        <p>The Operator uses the new version immediately.</p>
        {ids.length > 1 && (
          <ul className="publish-list">
            {names.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
        {live.length ? (
          <div className="publish-onair">
            <b>On air now: {live.length > 1 ? 'they change' : 'it changes'} on screen at once</b>
            <ul>
              {live.map((n) => (
                <li key={n}>
                  <span className="live-dot" /> {n}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="muted">{ids.length > 1 ? 'None of them is on air.' : 'It is not on air.'}</p>
        )}
      </div>
    ),
    confirm: 'Publish',
    danger: live.length > 0,
  });
}

/** Publishes one template (its latest edits first when it is open), after confirmation. */
export async function publishTemplate(project: Project, id: string) {
  const { saveTemplate, toast } = useApp.getState();
  const st = useDesigner.getState();
  if (!(await confirmPublish(project, [id]))) return;
  try {
    // Not saved: the Operator must not get an older version.
    if (st.base?.id === id && !(await saveTemplate(st.base))) return;
    const r = await api<{ revision: number }>('POST', `/api/projects/${encodeURIComponent(project.id)}/templates/${encodeURIComponent(id)}/publish`);
    const name = project.drafts?.find((t) => t.id === id)?.name ?? project.templates.find((t) => t.id === id)?.name ?? id;
    toast(`“${name}” v${r.revision} is live in the Operator`, 'info');
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

/** Publish of one template, in its properties: a discreet status line with its button. */
export function TemplatePublish({ project, id, readOnly }: { project: Project; id: string; readOnly: boolean }) {
  const [busy, setBusy] = useState(false);
  const { published, draft } = publishState(project, id);
  if (published && !draft)
    return (
      <span className="publish-state" title="The Operator uses this template as it is here">
        <Check size={12} /> In the Operator · v{published.revision || 1}
      </span>
    );
  return (
    <div className="publish publish-line">
      <span className="publish-draft">{published ? 'Changes not in the Operator' : 'New · not in the Operator'}</span>
      <button
        className="btn small publish-btn"
        disabled={busy || readOnly}
        title={published ? `The Operator uses v${published.revision || 1}` : 'The Operator does not see it yet'}
        onClick={async () => {
          setBusy(true);
          await publishTemplate(project, id);
          setBusy(false);
        }}
      >
        <Upload size={12} /> {busy ? 'Publishing…' : 'Publish'}
      </button>
    </div>
  );
}

/** The project's Publish: every template with changes goes live in the Operator at once. */
export function ProjectPublish({ project, readOnly }: { project: Project; readOnly: boolean }) {
  const { saveTemplate, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const changed = project.drafts ?? [];
  const isNew = (id: string) => !project.templates.some((t) => t.id === id);
  if (!changed.length)
    return (
      <span className="publish-state" title="The Operator uses the templates as they are here">
        <Check size={12} /> All in the Operator
      </span>
    );
  const publish = async () => {
    if (!(await confirmPublish(project, changed.map((t) => t.id)))) return;
    setBusy(true);
    try {
      const st = useDesigner.getState();
      if (st.base && !(await saveTemplate(st.base))) return;
      const r = await api<{ name: string; revision: number }[]>('POST', `/api/projects/${encodeURIComponent(project.id)}/publish`);
      toast(`${r.length} template${r.length > 1 ? 's' : ''} live in the Operator`, 'info');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="publish publish-line">
      <span className="publish-draft">
        {changed.length} change{changed.length > 1 ? 's' : ''} not in the Operator
      </span>
      <button className="btn small publish-btn" disabled={busy || readOnly} title={`Not yet in the Operator: ${changed.map((t) => `${t.name}${isNew(t.id) ? ' (new)' : ''}`).join(', ')}`} onClick={publish}>
        <Upload size={12} /> {busy ? 'Publishing…' : 'Publish all'}
      </button>
    </div>
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
      if (!(await saveTemplate(useDesigner.getState().base!))) return;
      const r = await api<{ revision: number }>('POST', `${url}/publish`);
      toast(`“${base.name}” v${r.revision} is live in the Operator`, 'info');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const discard = async () => {
    if (!published || !(await confirmDialog({ title: 'Discard the unpublished changes?', message: `“${base.name}” goes back to v${published.revision ?? 1}, the version the Operator uses.`, confirm: 'Discard', danger: true }))) return;
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
