// The Builder: a widget being made, open in the Designer as a template (its elements are the
// template's layers, its variables its fields, the rest of its definition in `builder`). Leaving it
// saves the widget and gives the templates using it their new elements (in their drafts).
import { regenerate, placeWidget } from '../engine/built';
import { designTemplates } from '../engine/drafts';
import { zoneArea } from '../engine/zones';
import { newId } from '../engine/evaluate';
import { MARKER_MODEL, type Field, type Template, type WidgetDef } from '../engine/types';
import { t } from '../i18n';
import { useApp } from '../store';
import { PREBUILT } from '../widgets/prebuilt';
import { useDesigner } from './designerStore';

/** Ids of the Builder's templates. */
export const BUILDER_ID = 'widget:';

/** The fields standing for the widget's variables (its texts show their start values). */
export const varFields = (vars: WidgetDef['vars']): Field[] => vars.map((v) => ({ key: v.name, label: v.name, kind: v.kind === 'number' ? 'number' : 'text', default: v.initial }));

/** The widget as a template the Designer edits. */
export function builderTemplate(def: WidgetDef): Template {
  const { layers, ...rest } = structuredClone(def);
  return {
    id: BUILDER_ID + def.id,
    name: def.name,
    duration: 50,
    markers: [{ id: 'builder-air', frame: 25, name: 'On air', kind: 'out' }],
    fields: varFields(def.vars),
    layers,
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
  return { ...t.builder, name: t.name, layers: t.layers, width: Math.round(right) || t.builder.width, height: Math.round(bottom) || t.builder.height };
}

/** Opens the Builder on the project's widget `defId` (back: the template open now). */
export function openBuilder(defId: string) {
  const def = useApp.getState().project?.widgets?.find((d) => d.id === defId);
  if (!def) return;
  const st = useDesigner.getState();
  const back = st.template && !st.template.builder ? st.template.id : (st.builder?.back ?? null);
  useDesigner.setState({ builder: { defId, back } });
  st.load(builderTemplate(def));
}

/** The templates using the widget get its new elements (in their drafts, on air at Publish). */
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

/** Leaves the Builder: the widget saved, its templates refreshed, back to the template it came from. */
export async function closeBuilder() {
  const st = useDesigner.getState();
  const def = defOf(st.base);
  const back = st.builder?.back ?? null;
  useDesigner.setState({ builder: null });
  if (def) {
    await useApp.getState().saveWidget(def);
    await refreshTemplates(def);
  }
  const p = useApp.getState().project;
  const tpl = back && p ? designTemplates(p).find((x) => x.id === back) : undefined;
  useDesigner.getState().load(tpl ?? null);
}

/** A new empty widget in the project, opened in the Builder. */
export async function newWidget() {
  const def: WidgetDef = { id: newId(), name: t('Widget {n}', { n: (useApp.getState().project?.widgets?.length ?? 0) + 1 }), icon: 'puzzle', width: 600, height: 120, layers: [], vars: [], options: [], controls: [] };
  if (await useApp.getState().saveWidget(def)) openBuilder(def.id);
}

/**
 * Adds the widget `id` to the open template: one of the project's, or a pre-built one (copied into
 * the project first). Its folder is selected.
 */
export async function addWidget(id: string, size: { width: number; height: number }) {
  const app = useApp.getState();
  let def = app.project?.widgets?.find((d) => d.id === id);
  if (!def) {
    const made = PREBUILT.find((p) => p.id === id)?.make();
    if (!made) return;
    // A copy of its own: the project's widget, edited there.
    def = { ...made, id: `${made.id}-${newId().slice(0, 6)}` };
    if (!(await app.saveWidget(def))) return;
  }
  const st = useDesigner.getState();
  if (!st.template || st.template.builder) return;
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
