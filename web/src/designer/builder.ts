// The Builder: a widget being made, open as its own page (/project/<id>/builder/<widget>), drawn by
// the Designer as a template (its elements are the template's layers, its variables its fields, the
// rest of its definition in `builder`). Leaving it saves the widget and gives the templates of the
// project using it their new elements (in their drafts); other projects' follow when they open.
import { regenerate, placeWidget } from '../engine/built';
import { designTemplates } from '../engine/drafts';
import { zoneArea } from '../engine/zones';
import { newId } from '../engine/evaluate';
import { actionsLogic, isControlWhen } from '../engine/widgetLogic';
import { MARKER_MODEL, type Field, type Template, type WidgetDef, type WidgetDraft } from '../engine/types';
import { navigate, projectPath } from '../router';
import { useApp } from '../store';
import { canon, draftOf, findDef, HOST_PROJECT, hostProject, neverPublished, projectOf, publishDef, saveDef, saveDraft, workingCopy, type WidgetHome } from '../widgetLibrary';
import { useDesigner } from './designerStore';
import { committedAnims, drawnLayers } from './builderAnims';

/** Ids of the Builder's templates. */
export const BUILDER_ID = 'widget:';

/** The fields standing for the widget's variables (its texts show their start values). */
export const varFields = (vars: WidgetDef['vars']): Field[] => vars.map((v) => ({ key: v.name, label: v.name, kind: v.kind === 'number' ? 'number' : 'text', default: v.initial }));

/** The widget as a template the Designer edits (its draft, if any). */
export function builderTemplate(stored: WidgetDef): Template {
  const { layers, logic, draft: _draft, ...rest } = structuredClone(workingCopy(stored));
  const def = { ...rest, layers } as WidgetDef;
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
  // Its frame: the size the Builder gives it (the stage of its Graphisme). Its elements without
  // keyframes: its animations hold them (the one on the timeline as the layers have it).
  const anims = committedAnims(t);
  return { ...t.builder, ...(anims.length ? { anims } : {}), name: t.name, layers: drawnLayers(t.layers), logic: t.logic, width: Math.max(1, Math.round(t.builder.width)), height: Math.max(1, Math.round(t.builder.height)) };
}

/** The frame around the widget's elements (« Fit to the content »). */
export function contentFrame(t: Template): { width: number; height: number } {
  const tops = t.layers.filter((l) => !l.parent);
  const right = Math.max(0, ...tops.map((l) => Number(l.props.x ?? 0) + Number(l.props.width ?? 0)));
  const bottom = Math.max(0, ...tops.map((l) => Number(l.props.y ?? 0) + Number(l.props.height ?? 0)));
  return { width: Math.round(right) || t.builder?.width || 600, height: Math.round(bottom) || t.builder?.height || 120 };
}

/**
 * The widget has changes its templates have not received: its draft (`draft`, else the one kept)
 * differs from what is published, both read as the Builder reads them (its frame, its Logic).
 */
export function unpublished(def: WidgetDef, draft: WidgetDraft | undefined = def.draft): boolean {
  if (!(def.rev ?? 0)) return true;
  if (!draft) return false;
  const published = defOf(builderTemplate({ ...def, draft: undefined }));
  return !!published && canon(draft) !== canon(draftOf(published));
}

/** Keeps the Builder's work as the widget's draft (its templates do not change until « Publish »). */
export async function saveBuilt(t: Template): Promise<boolean> {
  const def = defOf(t);
  const stored = def && findDef(def.id);
  if (!def || !stored) return false;
  return saveDraft(stored, draftOf(def));
}

/** Publishes what the Builder has made: the version goes up, the open project's templates get it at once. */
export async function publishBuilt(t: Template): Promise<WidgetDef | null> {
  const def = defOf(t);
  const stored = def && findDef(def.id);
  if (!def || !stored) return null;
  const next = await publishDef({ ...stored, draft: draftOf(def) });
  if (next && projectOf(next.id) === useApp.getState().projectId) await refreshTemplates(next);
  return next;
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
      if (def && !neverPublished(def) && (f.widget!.rev ?? 0) !== (def.rev ?? 0)) layers = regenerate(layers, f.id, def);
    }
    if (layers !== tpl.layers) await app.saveTemplate({ ...tpl, layers });
  }
}

/** Leaves the Builder where it is: its draft kept (the templates get it at « Publish »), the Designer on its templates. */
export async function leaveBuilder() {
  const base = useDesigner.getState().base;
  useDesigner.setState({ builder: null });
  if (base?.builder) await saveBuilt(base);
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
  const [fp, tpl] = from?.split(':') ?? [];
  const p = useApp.getState().project;
  const back = pid && pid !== HOST_PROJECT && fp === pid && tpl && p ? designTemplates(p).find((x) => x.id === tpl) : undefined;
  useDesigner.getState().load(back ?? null);
  // Back to the template it was opened from, else to the Widget Builder's gallery.
  navigate(back && pid ? projectPath(pid, 'designer') : '/widgets');
}

/** A new widget, opened in the Builder: empty (its size), or a copy of `from`. It is published only at « Publish ». */
export async function newWidget(where: WidgetHome, opts: { name: string; width?: number; height?: number; from?: WidgetDef; category?: WidgetDef['category'] }) {
  const base: WidgetDef = opts.from
    ? { ...structuredClone(workingCopy(opts.from)), draft: undefined }
    : { id: '', name: '', icon: 'puzzle', width: opts.width ?? 600, height: opts.height ?? 120, layers: [], vars: [], options: [], controls: [] };
  const content = { ...draftOf(base), name: opts.name, ...(opts.category ? { category: opts.category } : {}) };
  // Nothing published yet: its templates-to-be wait for « Publish the version ».
  const def: WidgetDef = { id: newId(), name: opts.name, icon: content.icon, width: content.width, height: content.height, layers: [], vars: [], options: [], controls: [], rev: 0, draft: content, ...(opts.category ? { category: opts.category } : {}) };
  if (!(await saveDef(def, where))) return null;
  if (where === 'shared') await openSharedBuilder(def.id);
  else await openBuilderPage(def.id, where === 'project' ? {} : { project: where.project });
  return def;
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
