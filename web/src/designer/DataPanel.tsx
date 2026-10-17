import { Database, Plus, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { BindingEditor } from '../data/BindingEditor';
import { col, holdFrame, num, propValue, toHex } from '../engine/evaluate';
import type { Field, FieldKind, Layer, Prop, Template } from '../engine/types';
import { isTimed } from '../engine/widgets';
import { TextInput } from '../ui/fields';
import { findLayer, LABELS, useDesigner } from './designerStore';
import { AssetPicker, FieldChips, fieldKey, PROP_LABELS, WidgetSettings, type Attrs } from './Inspector';
import { ICONS } from './LayersPanel';

/*
 * Left panel, under the templates: what a layer shows (its text, its widget
 * settings, its picture) and the data: the template's variables (the fields
 * the operator fills in, or that a data source feeds) and the properties
 * bound to them. The right panel keeps the layer's properties.
 */

/** Properties that can follow a variable. */
const BINDABLE: Prop[] = ['x', 'y', 'width', 'height', 'scaleX', 'scaleY', 'rotation', 'opacity', 'fill', 'stroke', 'strokeWidth', 'cornerRadius', 'fontSize', 'letterSpacing', 'cropLeft', 'cropRight', 'cropTop', 'cropBottom'];
const isColor = (p: Prop) => p === 'fill' || p === 'stroke';

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

/** The selected layer's content and its properties bound to variables. */
function WidgetData({ layer, template }: { layer: Layer; template: Template }) {
  const { update } = useDesigner();
  const edit = (fn: (l: Layer) => void, key?: string) => update((t) => fn(findLayer(t, layer.id)!), key);
  const set = (key: string, v: unknown, coalesce?: boolean) => edit((l) => void ((l as unknown as Attrs)[key] = v), coalesce ? `${key}-${layer.id}` : undefined);
  const bound = (Object.entries(layer.bindings) as [Prop, string][]).filter(([, k]) => k);
  const [adding, setAdding] = useState<Prop | ''>('');

  const expose = (prop: Prop, existing?: string) => {
    update((t) => {
      const l = findLayer(t, layer.id)!;
      if (existing) {
        l.bindings[prop] = existing;
        return;
      }
      const key = fieldKey(`${l.name} ${PROP_LABELS[prop]}`, new Set(t.fields.map((f) => f.key)));
      // Default: what is seen on air.
      const v = propValue(l, prop, holdFrame(t));
      const def = isColor(prop) ? toHex(col(v), col(v)[3] < 1) : String(+num(v).toFixed(3));
      t.fields.push({ key, label: `${l.name} · ${PROP_LABELS[prop]}`, kind: isColor(prop) ? 'color' : 'number', default: def });
      l.bindings[prop] = key;
    });
    setAdding('');
  };
  const unbind = (prop: Prop) =>
    update((t) => {
      const l = findLayer(t, layer.id)!;
      const key = l.bindings[prop];
      delete l.bindings[prop];
      // A field made for this binding and used nowhere else goes too.
      const used = t.layers.some((x) => Object.values(x.bindings).includes(key!)) || t.layers.some((x) => x.type === 'text' && x.text.includes(`{{${key}}}`));
      if (!used) t.fields = t.fields.filter((f) => f.key !== key);
    });
  const candidates = (prop: Prop) => template.fields.filter((f) => (isColor(prop) ? f.kind === 'color' : f.kind === 'number' || f.kind === 'text'));

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
          <label className="check" title="The operator starts it with ▶ in the zone card (or API action widget)">
            <input type="checkbox" checked={!!layer.manualStart} onChange={(e) => edit((l) => void (l.manualStart = e.target.checked || undefined))} />
            Start manually (the operator presses ▶)
          </label>
        )}
        {layer.type === 'group' && <p className="hint">A group holds layers; its properties apply to all of them.</p>}
      </div>

      <div className="dp-section">
        <div className="dp-title">Properties set by variables</div>
        {bound.length === 0 && <p className="hint">None: the operator cannot change this layer's properties. Expose one to make it a variable (a colour, a position, a size…).</p>}
        {bound.map(([prop, key]) => {
          const f = template.fields.find((x) => x.key === key);
          return (
            <div key={prop} className="dp-binding">
              <span className="dp-prop">{PROP_LABELS[prop] ?? prop}</span>
              <span className="dp-arrow">←</span>
              <select value={key} onChange={(e) => expose(prop, e.target.value)} title="The variable that sets it">
                {!f && <option value={key}>{key}</option>}
                {candidates(prop).map((x) => (
                  <option key={x.key} value={x.key}>
                    {x.label}
                  </option>
                ))}
              </select>
              <button className="icon-btn ghost" title="Stop following the variable" onClick={() => unbind(prop)}>
                <X size={13} />
              </button>
            </div>
          );
        })}
        <div className="dp-add">
          <select value={adding} onChange={(e) => setAdding(e.target.value as Prop | '')}>
            <option value="">Expose a property…</option>
            {BINDABLE.filter((p) => !layer.bindings[p]).map((p) => (
              <option key={p} value={p}>
                {PROP_LABELS[p] ?? p}
              </option>
            ))}
          </select>
          {adding && (
            <>
              <button className="btn small primary" onClick={() => expose(adding)}>
                <Plus size={13} /> New variable
              </button>
              {candidates(adding).length > 0 && (
                <select value="" onChange={(e) => e.target.value && expose(adding, e.target.value)}>
                  <option value="">or use…</option>
                  {candidates(adding).map((x) => (
                    <option key={x.key} value={x.key}>
                      {x.label}
                    </option>
                  ))}
                </select>
              )}
            </>
          )}
        </div>
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
