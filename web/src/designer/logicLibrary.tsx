import { BookMarked, Search, Sparkles, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { LogicClip, Template } from '../engine/types';
import { Dropdown } from '../ui/Dropdown';
import { Segmented } from '../ui/fields';
import { t } from '../i18n';
import { kindOf } from './logicNodes';
import { PRESET_TAGS, PRESETS, type Preset } from './logicPresets';

/*
 * The Logic canvas and the Library: ready-made flows (presets), saving a flow (this project or
 * every project), and inserting one, its layers and fields matched to the template's.
 */

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** The node kinds a clip chains, in order, for its card. */
export function chainOf(clip: LogicClip, template: Template): { fam: string; label: string }[] {
  const seen = new Set<string>();
  const out: { fam: string; label: string }[] = [];
  const order = [...clip.nodes].sort((a, b) => a.x - b.x || a.y - b.y);
  for (const n of order) {
    const k = n.type === 'layer' ? { fam: 'layer', label: t(clip.layers.find((l) => l.id === n.layer)?.name ?? 'Layer') } : kindOf(n, template);
    const key = `${k.fam}|${k.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ fam: k.fam, label: k.label });
  }
  return out.slice(0, 6);
}

function Chain({ clip, template }: { clip: LogicClip; template: Template }) {
  return (
    <div className="lx-chain">
      {chainOf(clip, template).map((c, i) => (
        <span key={i} className={`fam-${c.fam}`}>
          {c.label}
        </span>
      ))}
    </div>
  );
}

export function PresetsModal({ template, onPick, onClose }: { template: Template; onPick: (p: Preset) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const shown = PRESETS.filter((p) => (!tag || p.tag === tag) && (!q.trim() || fold(`${t(p.name)} ${t(p.tag)}`).includes(fold(q.trim()))));
  return (
    <div className="modal-back" onPointerDown={onClose}>
      <div className="modal lx-presets" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => (e.stopPropagation(), e.key === 'Escape' && onClose())}>
        <header>
          <span className="dialog-icon">
            <Sparkles size={16} />
          </span>
          <h2>{t('Presets')}</h2>
          <label className="lx-search grow">
            <Search size={13} />
            <input autoFocus value={q} placeholder={t('Search')} onChange={(e) => setQ(e.target.value)} />
          </label>
          <button type="button" className="icon-btn ghost" title={t('Close')} onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="lx-tags">
          <button className={!tag ? 'on' : ''} onClick={() => setTag(null)}>
            {t('All')} · {PRESETS.length}
          </button>
          {PRESET_TAGS.map((g) => (
            <button key={g} className={tag === g ? 'on' : ''} onClick={() => setTag(tag === g ? null : g)}>
              {t(g)}
            </button>
          ))}
        </div>
        <div className="lx-pgrid">
          {shown.map((p) => (
            <button key={p.key} className="lx-pcard" onClick={() => onPick(p)}>
              <h4>
                <b>{String(PRESETS.indexOf(p) + 1).padStart(2, '0')}</b>
                {t(p.name)}
              </h4>
              <Chain clip={p.clip} template={template} />
              <div className="lx-pfoot">
                <span>{t(p.tag)}</span>
                <em>{t('Insert')}</em>
              </div>
            </button>
          ))}
          {!shown.length && <div className="lx-none">{t('No preset')}</div>}
        </div>
      </div>
    </div>
  );
}

export type Scope = 'project' | 'shared';

export function SaveFlowModal({ name, canShare, onSave, onClose }: { name: string; canShare: boolean; onSave: (name: string, scope: Scope) => void; onClose: () => void }) {
  const [n, setN] = useState(name);
  const [scope, setScope] = useState<Scope>('project');
  return (
    <div className="modal-back" onPointerDown={onClose}>
      <form
        className="modal dialog"
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => (e.stopPropagation(), e.key === 'Escape' && onClose())}
        onSubmit={(e) => {
          e.preventDefault();
          if (n.trim()) onSave(n.trim(), scope);
        }}
      >
        <header>
          <span className="dialog-icon">
            <BookMarked size={16} />
          </span>
          <h2>{t('Save in the library')}</h2>
          <button type="button" className="icon-btn ghost" title={t('Close')} onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <label className="set-field">
          <span className="set-label">{t('Name')}</span>
          <input autoFocus value={n} onChange={(e) => setN(e.target.value)} />
        </label>
        <label className="set-field">
          <span className="set-label">{t('Kept for')}</span>
          <Segmented
            value={scope}
            onChange={setScope}
            options={[
              { value: 'project', label: t('This project') },
              ...(canShare ? [{ value: 'shared' as const, label: t('Every project') }] : []),
            ]}
          />
        </label>
        <footer>
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={!n.trim()}>
            {t('Save')}
          </button>
        </footer>
      </form>
    </div>
  );
}

/** What a clip needs that the template may have under other names: its layers and fields. */
export interface Needs {
  layers: { id: string; name: string; type: string }[];
  fields: string[];
}

export function needsOf(clip: LogicClip, template: Template): Needs {
  const used = new Set(clip.nodes.flatMap((n) => (n.type === 'layer' || n.type === 'widget' ? [n.layer] : [])));
  return {
    layers: clip.layers.filter((l) => used.has(l.id) && !template.layers.some((x) => x.id === l.id)),
    fields: (clip.fields ?? []).filter((k) => !template.fields.some((f) => f.key === k)),
  };
}

/** The template's layer likeliest to be the clip's: same name, then same type, then a text for a text… */
export function guessLayer(want: { name: string; type: string }, template: Template): string {
  const name = fold(t(want.name));
  const like = (n: string) => fold(n) === name || fold(n).includes(name) || name.includes(fold(n));
  const typed = want.type === 'group' ? template.layers : template.layers.filter((l) => l.type === want.type);
  // Same name and type, then same type, then same name.
  const hit = typed.find((l) => fold(l.name) === name) ?? typed.find((l) => like(l.name)) ?? typed[0] ?? template.layers.find((l) => like(l.name)) ?? template.layers[0];
  return hit?.id ?? '';
}

/** Matching a clip's layers and fields to the template's before it goes in. */
export function InsertModal({ name, needs, template, onInsert, onClose }: { name: string; needs: Needs; template: Template; onInsert: (layers: Record<string, string>, fields: Record<string, string>) => void; onClose: () => void }) {
  const [layers, setLayers] = useState<Record<string, string>>(() => Object.fromEntries(needs.layers.map((l) => [l.id, guessLayer(l, template)])));
  const [fields, setFields] = useState<Record<string, string>>(() => Object.fromEntries(needs.fields.map((k) => [k, template.fields.find((f) => fold(f.key).includes(fold(k)) || fold(k).includes(fold(f.key)))?.key ?? template.fields[0]?.key ?? ''])));
  const layerOpts = useMemo(() => template.layers.map((l) => ({ value: l.id, label: l.name, note: l.type })), [template.layers]);
  const fieldOpts = useMemo(() => template.fields.map((f) => ({ value: f.key, label: f.label || f.key })), [template.fields]);
  return (
    <div className="modal-back" onPointerDown={onClose}>
      <form
        className="modal dialog lx-insert"
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => (e.stopPropagation(), e.key === 'Escape' && onClose())}
        onSubmit={(e) => {
          e.preventDefault();
          onInsert(layers, fields);
        }}
      >
        <header>
          <span className="dialog-icon">
            <Sparkles size={16} />
          </span>
          <h2>{t('Insert “{name}”', { name })}</h2>
          <button type="button" className="icon-btn ghost" title={t('Close')} onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="lx-map">
          {needs.layers.map((l) => (
            <div key={l.id} className="lx-maprow">
              <span className="fam-layer">
                <i />
                {t(l.name)}
              </span>
              <span>→</span>
              <Dropdown value={layers[l.id] ?? ''} placeholder={t('Choose a layer')} options={layerOpts} onChange={(v) => setLayers({ ...layers, [l.id]: v })} />
            </div>
          ))}
          {needs.fields.map((k) => (
            <div key={k} className="lx-maprow">
              <span className="fam-input">
                <i />
                {k}
              </span>
              <span>→</span>
              <Dropdown value={fields[k] ?? ''} placeholder={t('Choose a field')} options={fieldOpts} onChange={(v) => setFields({ ...fields, [k]: v })} />
            </div>
          ))}
        </div>
        <footer>
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" className="btn primary">
            {t('Insert')}
          </button>
        </footer>
      </form>
    </div>
  );
}
