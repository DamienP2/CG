// Templates in the library: shared by every project, or kept with one. Saved from the Designer,
// added to a project as an independent copy (in a group scaled to the project's width when the
// formats differ).
import { BookmarkPlus, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { newId } from '../engine/evaluate';
import type { Layer, Project, Template } from '../engine/types';
import { api, useApp, useChanged } from '../store';
import { Segmented } from '../ui/fields';
import { confirmDialog } from '../ui/dialogs';
import { t } from '../i18n';

export interface LibTemplate {
  id: string;
  name: string;
  /** The project it is kept with ("" = shared). */
  project: string;
  /** The project it came from. */
  from: string;
  author: string;
  authorName: string;
  created: number;
  width: number;
  height: number;
  layers: number;
}

/** The library's templates: the shared ones, and those kept with `projectId`. */
export function useTemplateLibrary(projectId?: string | null) {
  const [list, setList] = useState<LibTemplate[] | null>(null);
  const load = () =>
    api<LibTemplate[]>('GET', `/api/template-library${projectId ? `?project=${encodeURIComponent(projectId)}` : ''}`)
      .then(setList)
      .catch(() => setList([]));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);
  useChanged('template-library', () => void load());
  return list;
}

const thumb = (id: string) => `/api/template-library/${encodeURIComponent(id)}/thumbnail.png`;

/** A library template made into a template of `project` (new id, its name free, in `zone`, at the project's size). */
export async function fromLibrary(project: Project, id: string, zone: string): Promise<Template> {
  const e = await api<{ name: string; width: number; height: number; template: Template }>('GET', `/api/template-library/${encodeURIComponent(id)}`);
  const tpl: Template = { ...structuredClone(e.template), id: newId(), zone, revision: 0 } as Template;
  const taken = new Set(project.templates.map((x) => x.name));
  let name = e.name;
  for (let n = 2; taken.has(name); n++) name = `${e.name} ${n}`;
  tpl.name = name;
  // Another format: everything in a group scaled to the project's width, centred.
  if (e.width !== project.width || e.height !== project.height) {
    const k = project.width / Math.max(1, e.width);
    const group = {
      id: newId(),
      name: t('Scaled'),
      type: 'group',
      clip: false,
      parent: null,
      visible: true,
      locked: false,
      tracks: {},
      bindings: {},
      props: { x: 0, y: Math.round((project.height - e.height * k) / 2), width: e.width, height: e.height, scaleX: k, scaleY: k, anchorX: 0, anchorY: 0 },
    } as unknown as Layer;
    tpl.layers = [group, ...tpl.layers.map((l) => (l.parent ? l : { ...l, parent: group.id }))];
  }
  return tpl;
}

/** The cards of the library's templates; `onPick` adds one, `canRemove` shows its bin. */
export function LibraryGrid({ list, onPick, canRemove }: { list: LibTemplate[]; onPick?: (e: LibTemplate) => void; canRemove?: (e: LibTemplate) => boolean }) {
  const toast = useApp((s) => s.toast);
  const remove = async (e: LibTemplate) => {
    if (!(await confirmDialog({ title: t('Remove “{name}” from the library?', { name: e.name }), message: t('The projects that use it keep their copy.'), confirm: t('Remove'), danger: true }))) return;
    await api('DELETE', `/api/template-library/${encodeURIComponent(e.id)}`).catch((err) => toast((err as Error).message, 'error'));
  };
  return (
    <div className="tlib-grid">
      {list.map((e) => (
        <div key={e.id} className={`tlib-card ${onPick ? 'tlib-pick' : ''}`} role={onPick ? 'button' : undefined} tabIndex={onPick ? 0 : undefined} onClick={() => onPick?.(e)} onKeyDown={(k) => k.key === 'Enter' && onPick?.(e)}>
          <span className="tlib-thumb" style={{ aspectRatio: `${e.width} / ${e.height}` }}>
            <img src={thumb(e.id)} alt="" loading="lazy" />
          </span>
          <span className="tlib-meta">
            <b title={e.name}>{e.name}</b>
            <span>
              {e.width}×{e.height}
              {e.from ? ` · ${e.from}` : ''}
            </span>
          </span>
          {canRemove?.(e) && (
            <button
              className="icon-btn ghost tlib-del"
              title={t('Remove from the library')}
              onClick={(ev) => {
                ev.stopPropagation();
                void remove(e);
              }}
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** Saves a template of the project in the library. */
export function SaveToLibrary({ project, template, onClose }: { project: Project; template: Template; onClose: () => void }) {
  const toast = useApp((s) => s.toast);
  const [name, setName] = useState(template.name);
  const [where, setWhere] = useState<'shared' | 'project'>('shared');
  const [busy, setBusy] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ copied: number }>('POST', '/api/template-library', { project: project.id, template: template.id, name, shared: where === 'shared' });
      toast(r.copied ? t('Saved in the library ({n} media copied to the shared library)', { n: r.copied }) : t('Saved in the library'), 'info');
      onClose();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return createPortal(
    <div className="modal-back" onPointerDown={onClose}>
      <form className="modal tlib-save" onSubmit={save} onPointerDown={(e) => e.stopPropagation()}>
        <header>
          <h2>{t('Save “{name}” in the library', { name: template.name })}</h2>
          <button type="button" className="icon-btn ghost" title={t('Close')} onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <label className="set-field">
          <span className="set-label">{t('Name')}</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} />
        </label>
        <div className="set-field">
          <span className="set-label">{t('Into')}</span>
          <Segmented
            value={where}
            onChange={setWhere}
            options={[
              { value: 'shared', label: t('Shared library') },
              { value: 'project', label: t('This project') },
            ]}
          />
        </div>
        <footer>
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button className="btn primary" disabled={busy || !name.trim()}>
            <BookmarkPlus size={14} /> {t('Save')}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
