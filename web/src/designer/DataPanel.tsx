import { Plus, Trash2 } from 'lucide-react';
import { BindingEditor } from '../data/BindingEditor';
import type { Field, FieldKind, Template } from '../engine/types';
import { TextInput } from '../ui/fields';
import { useDesigner } from './designerStore';
import { DataCanvasButton } from './DataCanvas';

/*
 * Left panel, under the templates: the template's variables (the fields the
 * operator fills in, or that a data source feeds). What a layer shows is in
 * the right panel (General); the Data canvas wires sources, variables and layers.
 */

export function DataPanel() {
  const template = useDesigner((s) => s.template);
  if (!template) return null;
  return (
    <div className="data-panel">
      <div className="dp-body">
        <Variables template={template} />
      </div>
    </div>
  );
}

/** The template's variables: what the operator fills in, or a data source feeds. */
function Variables({ template }: { template: Template }) {
  const { update, previewData, set } = useDesigner();
  const editField = (i: number, fn: (f: Field) => void) => update((t) => fn(t.fields[i]));
  return (
    <div className="dp-section">
      <div className="dp-title">
        <span>Variables · {template.fields.length}</span>
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
