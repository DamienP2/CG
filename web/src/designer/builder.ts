// The Builder: a widget being made, open as its own page (/project/<id>/builder/<widget>), drawn by
// the Designer as a template (its elements are the template's layers, its variables its fields, the
// rest of its definition in `builder`). Leaving it saves the widget and gives the templates of the
// project using it their new elements (in their drafts); other projects' follow when they open.
import { regenerate, placeWidget } from '../engine/built';
import { designTemplates } from '../engine/drafts';
import { zoneArea } from '../engine/zones';
import { newId } from '../engine/evaluate';
import { actionsLogic, isControlWhen } from '../engine/widgetLogic';
import { MARKER_MODEL, type Field, type Template, type WidgetDef } from '../engine/types';
import { t } from '../i18n';
import { navigate, projectPath } from '../router';
import { useApp } from '../store';
import { findDef, HOST_PROJECT, hostProject, saveDef, useWidgets } from '../widgetLibrary';
import { useDesigner } from './designerStore';

/** Ids of the Builder's templates. */
export const BUILDER_ID = 'widget:';

/** The fields standing for the widget's variables (its texts show their start values). */
export const varFields = (vars: WidgetDef['vars']): Field[] => vars.map((v) => ({ key: v.name, label: v.name, kind: v.kind === 'number' ? 'number' : 'text', default: v.initial }));

/** The widget as a template the Designer edits. */
export function builderTemplate(def: WidgetDef): Template {
  const { layers, logic, ...rest } = structuredClone(def);
  return {
    id: BUILDER_ID + def.id,
    name: def.name,
    duration: 50,
    markers: [{ id: 'builder-air', frame: 25, name: 'On air', kind: 'out' }],
    fields: varFields(def.vars),
    layers,
    // Its Logic: the Logic canvas of the Builder (older widgets: their controls' actions).
    logic: logic ?? actionsLogic(def),
    zone: '',
    revision: 0,
    markerModel: MARKER_MODEL,
    builder: rest,
  } as Template;
}

/** The widget a Builder template stands for. */
export function defOf(t: Template | null | undefined): WidgetDef | null {
  if (!t?.builder) return null;
  // Its frame: around its elements (the folder of the widget in a template).
  const tops = t.layers.filter((l) => !l.parent);
  const right = Math.max(0, ...tops.map((l) => Number(l.props.x ?? 0) + Number(l.props.width ?? 0)));
  const bottom = Math.max(0, ...tops.map((l) => Number(l.props.y ?? 0) + Number(l.props.height ?? 0)));
  return { ...t.builder, name: t.name, layers: t.layers, logic: t.logic, width: Math.round(right) || t.builder.width, height: Math.round(bottom) || t.builder.height };
}

/** Saves the widget a Builder template stands for, where it is kept (its version up). */
export async function saveBuilt(t: Template): Promise<boolean> {
  const def = defOf(t);
  if (!def) return false;
  // Its version from the library (the Builder's copy keeps the one it opened with).
  return saveDef({ ...def, rev: findDef(def.id)?.rev ?? def.rev });
}

/** Where the Builder goes back to: a template of the Designer, else the Library. */
const fromKey = 'strata.builder.from';

/** The Builder was opened from a template of the open project (its back button goes there). */
export function openedFromTemplate(): boolean {
  try {
    const [p, tpl] = (sessionStorage.getItem(fromKey) ?? '').split(':');
    return !!tpl && p === useApp.getState().projectId;
  } catch {
    return false;
  }
}

/** Opens the Builder page of the widget `defId` (from the template open in the Designer, if any). */
export async function openBuilderPage(defId: string, opts: { project?: string; fromTemplate?: string } = {}) {
  const pid = opts.project ?? useApp.getState().projectId ?? (await hostProject());
  try {
    if (opts.fromTemplate) sessionStorage.setItem(fromKey, `${pid}:${opts.fromTemplate}`);
    else sessionStorage.removeItem(fromKey);
  } catch {
    /* without storage: back to the Library */
  }
  navigate(`/project/${encodeURIComponent(pid)}/builder/${encodeURIComponent(defId)}`);
}

/** Opens the Builder page from the main Library (shared widgets: the hidden host project). */
export async function openSharedBuilder(defId: string) {
  await openBuilderPage(defId, { project: await hostProject() });
}

/** Loads the widget `defId` in the Designer (the Builder page). False: no such widget. */
export function loadBuilder(defId: string): boolean {
  const def = findDef(defId);
  if (!def) return false;
  useDesigner.setState({ builder: { defId, back: null } });
  useDesigner.getState().load(builderTemplate(def));
  return true;
}

/** The templates of the open project using the widget get its new elements (in their drafts, on air at Publish). */
export async function refreshTemplates(def: WidgetDef) {
  const app = useApp.getState();
  const p = app.project;
  if (!p) return;
  for (const tpl of designTemplates(p)) {
    const folders = tpl.layers.filter((l) => l.widget?.def === def.id);
    if (!folders.length) continue;
    let layers = tpl.layers;
    for (const f of folders) layers = regenerate(layers, f.id, def);
    await app.saveTemplate({ ...tpl, layers });
  }
}

/**
 * Templates of the open project made from an older version of their widgets (changed in another
 * project, or shared): made again in their drafts. Once per opening of a project.
 */
export async function refreshStale() {
  const app = useApp.getState();
  const p = app.project;
  if (!p || p.id === HOST_PROJECT) return;
  for (const tpl of designTemplates(p)) {
    let layers = tpl.layers;
    for (const f of tpl.layers.filter((l) => l.widget)) {
      const def = findDef(f.widget!.def);
      if (def && (f.widget!.rev ?? 0) !== (def.rev ?? 0)) layers = regenerate(layers, f.id, def);
    }
    if (layers !== tpl.layers) await app.saveTemplate({ ...tpl, layers });
  }
}

/** Leaves the Builder where it is: the widget saved, the project's templates refreshed, the Designer on its templates. */
export async function leaveBuilder() {
  const base = useDesigner.getState().base;
  useDesigner.setState({ builder: null });
  if (base?.builder) {
    await saveBuilt(base);
    const def = findDef(base.builder.id);
    if (def) await refreshTemplates(def);
  }
  useDesigner.getState().load(null);
}

/** Leaves the Builder (its back button): back where it was opened from. */
export async function closeBuilder() {
  await leaveBuilder();
  const pid = useApp.getState().projectId;
  let from: string | null = null;
  try {
    from = sessionStorage.getItem(fromKey);
    sessionStorage.removeItem(fromKey);
  } catch {
    /* without storage */
  }
  if (!pid || pid === HOST_PROJECT) {
    useDesigner.getState().load(null);
    return navigate('/media#widgets');
  }
  const [fp, tpl] = from?.split(':') ?? [];
  const p = useApp.getState().project;
  const back = fp === pid && tpl && p ? designTemplates(p).find((x) => x.id === tpl) : undefined;
  useDesigner.getState().load(back ?? null);
  navigate(back ? projectPath(pid, 'designer') : `${projectPath(pid, 'media')}#widgets`);
}

/** A new empty widget, opened in the Builder: the project's own, else shared (from the main Library). */
export async function newWidget(where: 'project' | 'shared') {
  const n = where === 'shared' ? useWidgets.getState().shared.length : (useApp.getState().project?.widgets?.length ?? 0);
  const def: WidgetDef = { id: newId(), name: t('Widget {n}', { n: n + 1 }), icon: 'puzzle', width: 600, height: 120, layers: [], vars: [], options: [], controls: [], rev: 0 };
  if (!(await saveDef(def, where))) return;
  if (where === 'shared') await openSharedBuilder(def.id);
  else await openBuilderPage(def.id);
}

/** Adds the widget `id` (the project's or a shared one) to the open template, in its zone. Its folder is selected. */
export async function addWidget(id: string, size: { width: number; height: number }) {
  const app = useApp.getState();
  const def = findDef(id);
  const st = useDesigner.getState();
  if (!def || !st.template || st.template.builder) return;
  const folder = newId();
  // In the middle of the template's zone (else of the picture), inside the picture.
  const zone = app.project?.zones.find((z) => z.id === st.template!.zone);
  const a = zone ? zoneArea(zone, st.format, size.height > size.width) : { x: 0, y: 0, width: 1, height: 1 };
  const x = Math.round(a.x * size.width + (a.width * size.width - def.width) / 2);
  const y = Math.round(a.y * size.height + (a.height * size.height - def.height) / 2);
  const layers = placeWidget(def, folder, Math.max(0, Math.min(size.width - def.width, x)), Math.max(0, Math.min(size.height - def.height, y)));
  st.update((tpl) => void tpl.layers.push(...layers));
  st.select([folder]);
}

/** Opens the Builder's Logic with the flow of the button `control` (its « When » made if it has none). */
export function openControlLogic(control: string) {
  const st = useDesigner.getState();
  if (!st.template?.builder) return;
  if (!(st.template.logic?.nodes ?? []).some((n) => isControlWhen(n, control)))
    st.update((x) => {
      const logic = (x.logic ??= { nodes: [], edges: [] });
      const y = logic.nodes.length ? Math.max(...logic.nodes.map((n) => n.y)) + 200 : 0;
      logic.nodes.push({ id: newId(), x: 0, y, type: 'when', on: 'control', name: control });
    });
  window.dispatchEvent(new Event('strata:open-triggers'));
}
