import { Database, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { BindingEditor } from '../data/BindingEditor';
import type { Field, FieldKind, Layer, Template } from '../engine/types';
import { isTimed } from '../engine/widgets';
import { TextInput } from '../ui/fields';
import { findLayer, LABELS, useDesigner } from './designerStore';
import { AssetPicker, FieldChips, WidgetSettings, type Attrs } from './Inspector';
import { ICONS } from './LayersPanel';
import { DataCanvasButton } from './DataCanvas';
import { WidgetRunButtons } from './WidgetRun';

/*
 * Left panel, under the templates: what a layer shows (its text, its widget
 * settings, its picture) and the data: the template's variables (the fields
 * the operator fills in, or that a data source feeds). The right panel keeps
 * the layer's properties; the Data canvas wires sources, variables and layers.
 */

export function DataPanel() {
  const { template, selected } = useDesigner();
  const layer = template && selected.length === 1 ? findLayer(template, selected[0]) : undefined;
  const [tab, setTab] = useState<'widget' | 'variables'>('widget');
  if (!template) return null;
  const active = layer ? tab : 'variables';
  return (
    <div className="data-panel">
      <div className="dp-tabs" role="tablist">
        <button role="tab" aria-selected={active === 'widget'} className={active === 'widget' ? 'on' : ''} disabled={!layer} onClick={() => setTab('widget')} title={layer ? undefined : 'Select a layer'}>
          {layer ? (() => {
            const Icon = ICONS[layer.type];
            return <Icon size={13} />;
          })() : <SlidersHorizontal size={13} />}
          <span>{layer ? layer.name : 'Widget'}</span>
        </button>
        <button role="tab" aria-selected={active === 'variables'} className={active === 'variables' ? 'on' : ''} onClick={() => setTab('variables')}>
          <Database size={13} /> Variables <span className="count">{template.fields.length}</span>
        </button>
      </div>
      <div className="dp-body">{active === 'widget' && layer ? <WidgetData layer={layer} template={template} /> : <Variables template={template} />}</div>
    </div>
  );
}

/** The selected layer's content (its properties are in the right panel, with their { } buttons). */
function WidgetData({ layer, template }: { layer: Layer; template: Template }) {
  const { update } = useDesigner();
  const edit = (fn: (l: Layer) => void, key?: string) => update((t) => fn(findLayer(t, layer.id)!), key);
  const set = (key: string, v: unknown, coalesce?: boolean) => edit((l) => void ((l as unknown as Attrs)[key] = v), coalesce ? `${key}-${layer.id}` : undefined);
  return (
    <>
      <div className="dp-section">
        <div className="dp-title">{LABELS[layer.type]}</div>
        {layer.type === 'text' && (
          <>
            <TextInput multiline value={layer.text} onChange={(v) => set('text', v, true)} />
            <FieldChips template={template} onInsert={(tok) => set('text', layer.text + tok)} />
            <p className="hint">Insert a variable with {'{{key}}'}: the operator (or a data source) fills it.</p>
          </>
        )}
        {layer.type === 'image' && <AssetPicker value={layer.src} onChange={(v) => edit((l) => void (l.type === 'image' && (l.src = v)))} />}
        <WidgetSettings layer={layer} template={template} set={set} />
        {isTimed(layer) && (
          <div className="dp-run">
            <span className="prop-label">Try it</span>
            <WidgetRunButtons layer={layer} />
          </div>
        )}
        {isTimed(layer) && (
          <label className="check" title="The operator starts it with ▶ in the zone card (or API action widget)">
            <input type="checkbox" checked={!!layer.manualStart} onChange={(e) => edit((l) => void (l.manualStart = e.target.checked || undefined))} />
            Start manually (the operator presses ▶)
          </label>
        )}
        {layer.type === 'group' && <p className="hint">A group holds layers; its properties apply to all of them.</p>}
      </div>

    </>
  );
}

/** The template's variables: what the operator fills in, or a data source feeds. */
function Variables({ template }: { template: Template }) {
  const { update, previewData, set } = useDesigner();
  const editField = (i: number, fn: (f: Field) => void) => update((t) => fn(t.fields[i]));
  return (
    <div className="dp-section">
      <div className="dp-title">
        <span>Variables of “{template.name}”</span>
        <DataCanvasButton className="btn small dp-canvas" />
        <button
          className="icon-btn ghost"
          title="Add a variable"
          onClick={() =>
            update((t) => {
              let n = t.fields.length + 1;
              while (t.fields.some((f) => f.key === `field${n}`)) n++;
              t.fields.push({ key: `field${n}`, label: `Field ${n}`, kind: 'text', default: '' });
            })
          }
        >
          <Plus size={14} />
        </button>
      </div>
      {template.fields.length === 0 && <p className="hint">Variables are what the operator fills in (a name, a score…), or what a data source feeds. Use them in texts with {'{{key}}'} or to set a property.</p>}
      {template.fields.map((f, i) => (
        <div key={i} className="field-card">
          <div className="row">
            <TextInput value={f.label} commitOnBlur placeholder="Label" onChange={(v) => editField(i, (x) => void (x.label = v))} />
            <TextInput value={f.key} commitOnBlur placeholder="key" onChange={(v) => editField(i, (x) => void (x.key = v.replace(/[^A-Za-z0-9_]/g, '')))} />
          </div>
          <div className="row">
            <select value={f.kind} onChange={(e) => editField(i, (x) => void (x.kind = e.target.value as FieldKind))}>
              {['text', 'multiline', 'number', 'color', 'image'].map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
            <TextInput value={f.default} commitOnBlur placeholder="Default value" onChange={(v) => editField(i, (x) => void (x.default = v))} />
            <button className="icon-btn ghost" title="Delete the variable" onClick={() => update((t) => void t.fields.splice(i, 1))}>
              <Trash2 size={13} />
            </button>
          </div>
          {!f.binding && (
            <div className="row">
              <span className="prop-label">Preview</span>
              <TextInput value={previewData[f.key] ?? ''} onChange={(v) => set({ previewData: { ...previewData, [f.key]: v } })} />
            </div>
          )}
          <BindingEditor
            field={f}
            template={template}
            data={previewData}
            onChange={(b) => editField(i, (x) => void (b ? (x.binding = b) : delete x.binding))}
            onAddField={(nf) => update((t) => void (t.fields.some((x) => x.key === nf.key) || t.fields.push(nf)))}
          />
        </div>
      ))}
    </div>
  );
}
