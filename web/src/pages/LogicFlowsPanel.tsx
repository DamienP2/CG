import { BookMarked, Pencil, Trash2 } from 'lucide-react';
import { useEffect } from 'react';
import type { LogicFlow, Template } from '../engine/types';
import { useLogicFlows } from '../logicFlows';
import { useApp } from '../store';
import { confirmDialog, promptDialog } from '../ui/dialogs';
import { locale, t, tn } from '../i18n';
import { chainOf } from '../designer/logicLibrary';

/** The same empty list each time (a new one would render without end). */
const NONE: never[] = [];

/* Library › Logic: the flows saved from the Logic canvas, the project's own and the shared ones. */

const NO_TEMPLATE = { id: '', name: '', layers: [], fields: [], datasets: [], markers: [] } as unknown as Template;

function FlowCard({ f, canEdit, onRename, onDelete }: { f: LogicFlow; canEdit: boolean; onRename: () => void; onDelete: () => void }) {
  const layers = f.clip.layers?.length ?? 0;
  return (
    <div className="lf-card">
      <div className="lf-chain lx">
        {chainOf(f.clip, NO_TEMPLATE).map((c, i) => (
          <span key={i} className={`fam-${c.fam}`}>
            {c.label}
          </span>
        ))}
      </div>
      <div className="lf-meta">
        <strong>{f.name}</strong>
        <span className="muted small">
          {tn(f.clip.nodes.length, '{n} node', '{n} nodes')} · {layers ? tn(layers, 'needs {n} layer', 'needs {n} layers') : t('needs no layer')}
        </span>
        <span className="muted small">
          {[f.author, f.created ? new Date(f.created).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' }) : ''].filter(Boolean).join(' · ')}
        </span>
      </div>
      {canEdit && (
        <div className="lf-actions">
          <button className="icon-btn" title={t('Rename')} onClick={onRename}>
            <Pencil size={13} />
          </button>
          <button className="icon-btn danger" title={t('Delete')} onClick={onDelete}>
            <Trash2 size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

export function LogicFlowsPanel({ projectId, canEdit }: { projectId?: string; canEdit: boolean }) {
  const shared = useLogicFlows((s) => s.shared);
  const loaded = useLogicFlows((s) => s.loaded);
  const own = useApp((s) => (projectId ? s.full[projectId]?.logicFlows : undefined)) ?? NONE;
  useEffect(() => {
    if (!loaded) void useLogicFlows.getState().load();
  }, [loaded]);
  const save = (list: LogicFlow[], scope: 'project' | 'shared') => (scope === 'shared' ? useLogicFlows.getState().saveShared(list) : projectId ? useLogicFlows.getState().saveProject(projectId, list) : Promise.resolve(false));
  const rename = async (f: LogicFlow, list: LogicFlow[], scope: 'project' | 'shared') => {
    const name = await promptDialog({ title: t('Rename'), value: f.name });
    if (name) void save(list.map((x) => (x.id === f.id ? { ...x, name } : x)), scope);
  };
  const remove = async (f: LogicFlow, list: LogicFlow[], scope: 'project' | 'shared') => {
    if (await confirmDialog({ title: t('Delete “{name}”?', { name: f.name }), confirm: t('Delete'), danger: true })) void save(list.filter((x) => x.id !== f.id), scope);
  };
  const group = (title: string, list: LogicFlow[], scope: 'project' | 'shared') => (
    <section className="lf-group">
      <h3>{title}</h3>
      {list.length ? (
        <div className="lf-grid">
          {list.map((f) => (
            <FlowCard key={f.id} f={f} canEdit={canEdit} onRename={() => void rename(f, list, scope)} onDelete={() => void remove(f, list, scope)} />
          ))}
        </div>
      ) : (
        <div className="lf-empty muted">
          <BookMarked size={16} /> {t('No flow')}
        </div>
      )}
    </section>
  );
  return (
    <div className="lf-panel">
      {projectId && group(t('This project'), own, 'project')}
      {group(t('Every project'), shared, 'shared')}
    </div>
  );
}
