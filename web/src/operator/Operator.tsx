import { ArrowDown, ArrowUp, ChevronsRight, CircleStop, Copy, Play, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Scene } from '../engine/Scene';
import { defaultData, holdFrame, newId, parseHex, toHex } from '../engine/evaluate';
import type { Field, PlayoutItem, RundownItem } from '../engine/types';
import { uploadAsset, useApp } from '../store';
import { Monitor } from '../ui/Monitor';
import { Program } from '../output/Program';

function FieldInput({ field, value, onChange }: { field: Field; value: string; onChange: (v: string) => void }) {
  const toast = useApp((s) => s.toast);
  switch (field.kind) {
    case 'multiline':
      return <textarea rows={3} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />;
    case 'number':
      return (
        <div className="stepper">
          <button className="btn small" onClick={() => onChange(String((parseFloat(value) || 0) - 1))}>
            −
          </button>
          <input value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <button className="btn small" onClick={() => onChange(String((parseFloat(value) || 0) + 1))}>
            +
          </button>
        </div>
      );
    case 'color':
      return (
        <div className="row">
          <input type="color" value={toHex(parseHex(value) ?? [1, 1, 1, 1])} onChange={(e) => onChange(e.target.value)} />
          <input value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </div>
      );
    case 'image':
      return (
        <div className="row">
          <input value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.stopPropagation()} placeholder="/assets/…" />
          <label className="btn small">
            Upload
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) uploadAsset(f).then(onChange, (err) => toast(String(err), 'error'));
              }}
            />
          </label>
        </div>
      );
    default:
      return <input value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />;
  }
}

function phaseLabel(p: PlayoutItem) {
  return p.phase === 'holding' ? 'ON AIR' : p.phase === 'out' ? 'OUT' : 'PLAYING';
}

export function Operator() {
  const { project, channel, command, saveRundown } = useApp();
  const [cued, setCued] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);

  const rundown = project?.rundown ?? [];
  const item = rundown.find((r) => r.id === cued) ?? null;
  const template = item && project?.templates.find((t) => t.id === item.templateId);

  useEffect(() => {
    if (!cued && rundown.length) setCued(rundown[0].id);
  }, [cued, rundown]);

  // Draft data follows the cued item.
  useEffect(() => {
    if (item && template) setDraft({ ...defaultData(template), ...item.data });
  }, [cued, template?.id]);

  const onAirByItem = useMemo(() => {
    const m = new Map<string, PlayoutItem>();
    for (const p of Object.values(channel.layers)) if (p.rundownId) m.set(p.rundownId, p);
    return m;
  }, [channel]);

  const dirty = item ? JSON.stringify({ ...defaultData(template!), ...item.data }) !== JSON.stringify(draft) : false;

  const persistDraft = () => {
    if (!item || !dirty) return;
    saveRundown(rundown.map((r) => (r.id === item.id ? { ...r, data: draft } : r)));
  };

  const take = () => {
    if (!item) return;
    persistDraft();
    command({ action: 'take', layer: item.layer, templateId: item.templateId, data: draft, rundownId: item.id });
    // Cue the next item, like a playlist.
    const idx = rundown.findIndex((r) => r.id === item.id);
    if (idx >= 0 && idx < rundown.length - 1) setCued(rundown[idx + 1].id);
  };
  const cont = () => item && command({ action: 'continue', layer: item.layer });
  const out = () => item && command({ action: 'takeOut', layer: item.layer });
  const updateLive = () => {
    if (!item) return;
    persistDraft();
    command({ action: 'update', layer: item.layer, data: draft });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      const idx = rundown.findIndex((r) => r.id === cued);
      if (e.key === 'F1' || e.key === 'Enter') (e.preventDefault(), take());
      else if (e.key === 'F2' || e.key === ' ') (e.preventDefault(), cont());
      else if (e.key === 'F3') (e.preventDefault(), out());
      else if (e.key === 'F12') (e.preventDefault(), command({ action: 'clear' }));
      else if (e.key === 'ArrowDown' && idx < rundown.length - 1) setCued(rundown[idx + 1].id);
      else if (e.key === 'ArrowUp' && idx > 0) setCued(rundown[idx - 1].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!project) return <div className="loading">Connecting…</div>;

  const addItem = (templateId: string) => {
    const t = project.templates.find((x) => x.id === templateId)!;
    const used = new Set(rundown.map((r) => r.layer));
    const it: RundownItem = { id: newId(), name: t.name, templateId, layer: rundown.find((r) => r.templateId === templateId)?.layer ?? (Math.max(0, ...used) + 10), data: defaultData(t) };
    saveRundown([...rundown, it]);
    setCued(it.id);
    setAdding(false);
  };
  const move = (id: string, d: -1 | 1) => {
    const i = rundown.findIndex((r) => r.id === id);
    const j = i + d;
    if (j < 0 || j >= rundown.length) return;
    const next = [...rundown];
    [next[i], next[j]] = [next[j], next[i]];
    saveRundown(next);
  };

  const live = item ? channel.layers[String(item.layer)] : undefined;
  const liveIsThis = live?.rundownId === item?.id;

  return (
    <div className="operator">
      <aside className="panel left rundown">
        <header className="panel-header">
          <span>Rundown</span>
          <button className="icon-btn ghost" title="Add an item" onClick={() => setAdding(!adding)}>
            <Plus size={15} />
          </button>
        </header>
        {adding && (
          <div className="add-menu">
            {project.templates.map((t) => (
              <button key={t.id} onClick={() => addItem(t.id)}>
                {t.name}
              </button>
            ))}
          </div>
        )}
        <div className="rundown-list">
          {rundown.map((r, i) => {
            const t = project.templates.find((x) => x.id === r.templateId);
            const air = onAirByItem.get(r.id);
            return (
              <div key={r.id} className={`rundown-item ${cued === r.id ? 'cued' : ''} ${air ? 'on-air' : ''}`} onClick={() => setCued(r.id)}>
                <span className="idx">{i + 1}</span>
                <div className="ri-main">
                  <span className="ri-name">{r.name}</span>
                  <span className="ri-meta">
                    {t?.name ?? 'missing template'} · L{r.layer}
                  </span>
                </div>
                {air && <span className="tally">{phaseLabel(air)}</span>}
                <div className="item-actions">
                  <button className="icon-btn ghost" onClick={(e) => (e.stopPropagation(), move(r.id, -1))}>
                    <ArrowUp size={12} />
                  </button>
                  <button className="icon-btn ghost" onClick={(e) => (e.stopPropagation(), move(r.id, 1))}>
                    <ArrowDown size={12} />
                  </button>
                  <button
                    className="icon-btn ghost"
                    title="Duplicate"
                    onClick={(e) => {
                      e.stopPropagation();
                      const copy = { ...structuredClone(r), id: newId(), name: `${r.name} copy` };
                      const next = [...rundown];
                      next.splice(i + 1, 0, copy);
                      saveRundown(next);
                    }}
                  >
                    <Copy size={12} />
                  </button>
                  <button
                    className="icon-btn ghost"
                    title="Remove"
                    onClick={(e) => {
                      e.stopPropagation();
                      saveRundown(rundown.filter((x) => x.id !== r.id));
                      if (cued === r.id) setCued(null);
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            );
          })}
          {rundown.length === 0 && <div className="empty">Empty rundown. Add items from your templates.</div>}
        </div>
      </aside>

      <main className="op-center">
        <div className="monitors">
          <Monitor width={project.width} height={project.height} label="Preview" tally="pvw" extra={template && <span className="muted">{template.name}</span>}>
            {template && <Scene template={template} frame={holdFrame(template)} data={draft} />}
          </Monitor>
          <Monitor width={project.width} height={project.height} label="Program" tally="pgm" extra={<a className="muted link" href="/output" target="_blank" rel="noreferrer">Open HTML5 output ↗</a>}>
            <Program project={project} channel={channel} />
          </Monitor>
        </div>

        <div className="transport-bar">
          <button className="big-btn take" disabled={!item} onClick={take} title="F1 / Enter">
            <Play size={20} /> TAKE
          </button>
          <button className="big-btn continue" disabled={!item || !live} onClick={cont} title="F2 / Space">
            <ChevronsRight size={20} /> CONTINUE
          </button>
          <button className="big-btn out" disabled={!item || !live} onClick={out} title="F3">
            <CircleStop size={20} /> OUT
          </button>
          <div className="spacer" />
          <button className="big-btn update" disabled={!item || !liveIsThis} onClick={updateLive} title="Push edited data to the graphic on air">
            <RefreshCw size={18} /> UPDATE
          </button>
          <button className="big-btn clear" onClick={() => command({ action: 'clear' })} title="F12 — clear everything">
            <X size={18} /> CLEAR ALL
          </button>
        </div>

        <div className="on-air-strip">
          {Object.entries(channel.layers).length === 0 && <span className="muted">Nothing on air</span>}
          {Object.entries(channel.layers)
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([layer, p]) => {
              const t = project.templates.find((x) => x.id === p.templateId);
              return (
                <div key={layer} className={`air-chip ${p.phase}`}>
                  <span className="air-layer">L{layer}</span>
                  <span>{t?.name}</span>
                  <span className="air-phase">{phaseLabel(p)}</span>
                  <progress max={t?.duration ?? 1} value={p.frame} />
                  <button className="icon-btn ghost" title="Continue" onClick={() => command({ action: 'continue', layer: Number(layer) })}>
                    <ChevronsRight size={13} />
                  </button>
                  <button className="icon-btn ghost" title="Take out" onClick={() => command({ action: 'takeOut', layer: Number(layer) })}>
                    <CircleStop size={13} />
                  </button>
                </div>
              );
            })}
        </div>
      </main>

      <aside className="panel right data-panel">
        <header className="panel-header">
          <span>Data</span>
          {dirty && <span className="badge warn">edited</span>}
        </header>
        {item && template ? (
          <div className="data-form">
            <label className="form-row">
              <span>Item name</span>
              <input value={item.name} onChange={(e) => saveRundown(rundown.map((r) => (r.id === item.id ? { ...r, name: e.target.value } : r)))} onKeyDown={(e) => e.stopPropagation()} />
            </label>
            <label className="form-row">
              <span>Playout layer</span>
              <input type="number" value={item.layer} onChange={(e) => saveRundown(rundown.map((r) => (r.id === item.id ? { ...r, layer: Math.max(0, +e.target.value | 0) } : r)))} onKeyDown={(e) => e.stopPropagation()} />
            </label>
            <hr />
            {template.fields.length === 0 && <p className="hint">This template has no data fields.</p>}
            {template.fields.map((f) => (
              <label key={f.key} className="form-row">
                <span>{f.label}</span>
                <FieldInput field={f} value={draft[f.key] ?? ''} onChange={(v) => setDraft({ ...draft, [f.key]: v })} />
              </label>
            ))}
            <div className="row">
              <button className="btn" disabled={!dirty} onClick={persistDraft}>
                Save to rundown
              </button>
              <button className="btn" disabled={!dirty} onClick={() => setDraft({ ...defaultData(template), ...item.data })}>
                Revert
              </button>
            </div>
            <p className="hint">
              Shortcuts: <kbd>F1</kbd>/<kbd>Enter</kbd> take · <kbd>F2</kbd>/<kbd>Space</kbd> continue · <kbd>F3</kbd> out · <kbd>F12</kbd> clear · <kbd>↑</kbd>/<kbd>↓</kbd> cue
            </p>
          </div>
        ) : (
          <div className="empty">Select a rundown item.</div>
        )}
      </aside>
    </div>
  );
}

