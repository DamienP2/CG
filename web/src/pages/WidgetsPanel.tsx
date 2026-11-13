// Library › Widgets: the widgets built with the Builder. On the main page the shared ones; in a
// project its own too (« Du projet »), which can be shared with every project.
import { useEffect, useMemo, useState } from 'react';
import { Copy, Pencil, Puzzle, Share2, Trash2 } from 'lucide-react';
import { placeWidget } from '../engine/built';
import { defaultData, newId } from '../engine/evaluate';
import { LiveTime } from '../engine/LiveTime';
import { Scene, Viewport } from '../engine/Scene';
import { MARKER_MODEL, type Template, type WidgetDef } from '../engine/types';
import { t, tn } from '../i18n';
import { api, useApp } from '../store';
import { Segmented } from '../ui/fields';
import { confirmDialog } from '../ui/dialogs';
import { Empty } from '../ui/Empty';
import { openBuilderPage, openSharedBuilder } from '../designer/builder';
import { saveDef, shareWidget, useWidgets } from '../widgetLibrary';

const NONE: WidgetDef[] = [];

/** The widgets of the Library: shared, and the project's own (in a project). */
export function useWidgetLists(projectId?: string) {
  const loaded = useWidgets((s) => s.loaded);
  useEffect(() => {
    if (!loaded) void useWidgets.getState().load();
  }, [loaded]);
  const shared = useWidgets((s) => s.shared);
  const own = useApp((s) => (projectId ? (s.full[projectId]?.widgets ?? NONE) : NONE));
  return { shared, own, loaded };
}

/** A widget drawn as placed in a template (its start values, its default options). */
function Thumb({ def }: { def: WidgetDef }) {
  const tpl = useMemo(() => {
    const layers = placeWidget(def, 'thumb', 0, 0);
    return { id: `thumb:${def.id}`, name: def.name, duration: 1, markers: [], fields: [], layers, zone: '', revision: 0, markerModel: MARKER_MODEL } as unknown as Template;
  }, [def]);
  const data = useMemo(() => defaultData(tpl), [tpl]);
  const w = Math.max(1, def.width);
  const h = Math.max(1, def.height);
  // Inside a 16:9 card, with a margin.
  const scale = Math.min((264 * 0.9) / w, (148 * 0.8) / h);
  return (
    <span className="wlib-thumb">
      {def.layers.length ? (
        <Viewport width={w} height={h} scale={scale}>
          <LiveTime ageSecs={0} ticking={false} settled>
            <Scene template={tpl} frame={0} data={data} />
          </LiveTime>
        </Viewport>
      ) : (
        <Puzzle size={28} />
      )}
    </span>
  );
}

export function WidgetsPanel({ projectId, canEdit, canEditShared }: { projectId?: string; canEdit: boolean; canEditShared: boolean }) {
  const { shared, own, loaded } = useWidgetLists(projectId);
  const uses = useWidgets((s) => s.uses);
  const project = useApp((s) => (projectId ? s.full[projectId] : undefined));
  const [tab, setTab] = useState<'shared' | 'project'>(projectId && own.length ? 'project' : 'shared');
  if (!loaded) return <div className="loading">{t('Loading…')}</div>;
  const mine = !!projectId && tab === 'project';
  const list = [...(mine ? own : shared)].sort((a, b) => a.name.localeCompare(b.name));
  // Templates of the project using a widget.
  const inProject = (id: string) => (project ? [...project.templates, ...(project.drafts ?? [])].filter((x) => x.layers.some((l) => l.widget?.def === id)).map((x) => x.id) : []);
  const usedBy = (d: WidgetDef) => (mine ? new Set(inProject(d.id)).size : (uses[d.id] ?? 0));
  const meta = (d: WidgetDef) => {
    const n = usedBy(d);
    return mine ? (n ? tn(n, '{n} template', '{n} templates') : t('Unused')) : n ? tn(n, '{n} project', '{n} projects') : t('Unused');
  };
  const editable = mine ? canEdit : canEditShared;
  const edit = (d: WidgetDef) => (projectId ? openBuilderPage(d.id, { project: projectId }) : openSharedBuilder(d.id));
  const duplicate = async (d: WidgetDef) => {
    const copy: WidgetDef = { ...structuredClone(d), id: newId(), name: t('{name} (copy)', { name: d.name }), rev: 0 };
    await saveDef(copy, mine ? 'project' : 'shared');
  };
  const remove = async (d: WidgetDef) => {
    if (!(await confirmDialog({ title: t('Delete “{name}”?', { name: d.name }), confirm: t('Delete'), danger: true }))) return;
    if (mine) {
      try {
        await api('DELETE', `/api/projects/${encodeURIComponent(projectId!)}/widgets/${encodeURIComponent(d.id)}`);
      } catch (e) {
        useApp.getState().toast((e as Error).message, 'error');
      }
    } else await useWidgets.getState().removeShared(d.id);
  };
  return (
    <>
      {projectId && (
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'shared', label: `${t('Shared')} · ${shared.length}` },
            { value: 'project', label: `${t('Of the project')} · ${own.length}` },
          ]}
        />
      )}
      {list.length ? (
        <div className="tlib-grid wlib-grid">
          {list.map((d) => (
            <div key={d.id} className="tlib-card wlib-card">
              <Thumb def={d} />
              <span className="tlib-meta">
                <b title={d.name}>{d.name}</b>
                <span>{meta(d)}</span>
              </span>
              {editable && (
                <span className="wlib-act">
                  <button className="icon-btn ghost" title={t('Edit')} onClick={() => void edit(d)}>
                    <Pencil size={13} />
                  </button>
                  <button className="icon-btn ghost" title={t('Duplicate')} onClick={() => void duplicate(d)}>
                    <Copy size={13} />
                  </button>
                  {mine && canEditShared && (
                    <button className="icon-btn ghost" title={t('Share with every project')} onClick={() => void shareWidget(d.id)}>
                      <Share2 size={13} />
                    </button>
                  )}
                  <button className="icon-btn ghost" title={usedBy(d) ? t('Used: it cannot be deleted') : t('Delete')} disabled={usedBy(d) > 0} onClick={() => void remove(d)}>
                    <Trash2 size={13} />
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="lib-void">
          <Empty icon={Puzzle} text={t('No widget')} />
        </div>
      )}
    </>
  );
}
